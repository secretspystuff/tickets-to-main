using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal sealed class OwnedWindowsChild : IDisposable
{
    private const uint Suspended = 0x4, Detached = 0x8, UnicodeEnvironment = 0x400, ExtendedStartup = 0x80000;
    private static readonly IntPtr HandleList = new IntPtr(0x20002), JobList = new IntPtr(0x2000D);

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        internal int Size;
        internal IntPtr Reserved, Desktop, Title;
        internal uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        internal ushort ShowWindow, ReservedSize;
        internal IntPtr ReservedData, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedInfo
    {
        internal StartupInfo Startup;
        internal IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process, Thread;
        internal uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size,
        IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref ExtendedInfo startup,
        out ProcessInformation child);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr data, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr originalJob;
    private ProcessInformation child;
    private bool activated;
    internal bool Activated { get { return activated; } }
    internal FileStream Input { get; private set; }
    internal FileStream Output { get; private set; }
    internal FileStream Error { get; private set; }

    internal OwnedWindowsChild(string executable, string[] args, string cwd, string[] environment)
    {
        IntPtr childIn = IntPtr.Zero, childOut = IntPtr.Zero, childError = IntPtr.Zero;
        IntPtr parentIn = IntPtr.Zero, parentOut = IntPtr.Zero, parentError = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, stdio = IntPtr.Zero, jobs = IntPtr.Zero, env = IntPtr.Zero;
        bool initialized = false;
        char[] envBlock = null;
        try
        {
            if (!Absolute(executable) || !Absolute(cwd)) throw Refused();
            var command = new StringBuilder(Quote(executable));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            if (command.Length >= 32767) throw Refused();
            envBlock = EnvironmentBlock(environment);
            env = Marshal.AllocHGlobal(envBlock.Length * 2);
            Marshal.Copy(envBlock, 0, env, envBlock.Length);

            originalJob = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
            if (originalJob == IntPtr.Zero) throw Refused();
            MakePipe(out childIn, out parentIn, false);
            MakePipe(out parentOut, out childOut, true);
            MakePipe(out parentError, out childError, true);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == IntPtr.Zero) throw Refused();
            attributes = Marshal.AllocHGlobal(size);
            initialized = InitializeProcThreadAttributeList(attributes, 2, 0, ref size);
            if (!initialized) throw Refused();
            stdio = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(stdio, 0, childIn);
            Marshal.WriteIntPtr(stdio, IntPtr.Size, childOut);
            Marshal.WriteIntPtr(stdio, IntPtr.Size * 2, childError);
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, originalJob);
            if (!UpdateProcThreadAttribute(attributes, 0, HandleList, stdio, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero) ||
                !UpdateProcThreadAttribute(attributes, 0, JobList, jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw Refused();
            var startup = new ExtendedInfo {
                Startup = new StartupInfo { Size = Marshal.SizeOf(typeof(ExtendedInfo)), Flags = 0x100,
                    Input = childIn, Output = childOut, Error = childError },
                Attributes = attributes,
            };
            if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                Suspended | Detached | UnicodeEnvironment | ExtendedStartup, env, cwd, ref startup, out child)) throw Refused();
            Input = Stream(ref parentIn, FileAccess.Write);
            Output = Stream(ref parentOut, FileAccess.Read);
            Error = Stream(ref parentError, FileAccess.Read);
        }
        catch
        {
            Dispose();
            throw;
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
            Marshal.FreeHGlobal(stdio);
            Marshal.FreeHGlobal(jobs);
            if (env != IntPtr.Zero)
            {
                Array.Clear(envBlock, 0, envBlock.Length);
                Marshal.Copy(envBlock, 0, env, envBlock.Length);
                Marshal.FreeHGlobal(env);
            }
            Close(childIn); Close(childOut); Close(childError);
            Close(parentIn); Close(parentOut); Close(parentError);
        }
    }

    internal bool Verify()
    {
        bool member;
        return child.Process != IntPtr.Zero && originalJob != IntPtr.Zero &&
            IsProcessInJob(child.Process, originalJob, out member) && member;
    }

    internal bool Activate()
    {
        if (activated || !Verify() || ResumeThread(child.Thread) != 1) return false;
        activated = true;
        return true;
    }

    internal int? Observe()
    {
        if (!activated || originalJob == IntPtr.Zero) return null;
        const int capacity = 256, header = 8;
        int size = header + capacity * IntPtr.Size;
        IntPtr list = Marshal.AllocHGlobal(size);
        try
        {
            int returned;
            // JobObjectBasicProcessIdList exposes whether the entire active list fit.
            if (!QueryInformationJobObject(originalJob, 3, list, size, out returned)) return null;
            int assigned = Marshal.ReadInt32(list), listed = Marshal.ReadInt32(list, 4);
            if (assigned < 0 || assigned > capacity || assigned != listed || returned < header + listed * IntPtr.Size) return null;
            return assigned;
        }
        finally { Marshal.FreeHGlobal(list); }
    }

    internal uint? WaitForExit()
    {
        uint code;
        return WaitForSingleObject(child.Process, 0xFFFFFFFF) == 0 && GetExitCodeProcess(child.Process, out code)
            ? (uint?)code : null;
    }

    public void Dispose()
    {
        if (!activated && child.Process != IntPtr.Zero &&
            (WaitForSingleObject(child.Process, 0) == 0 || TerminateProcess(child.Process, 1)))
            WaitForSingleObject(child.Process, 5000);
        if (Input != null) Input.Dispose();
        if (Output != null) Output.Dispose();
        if (Error != null) Error.Dispose();
        Close(child.Thread);
        Close(child.Process);
        Close(originalJob);
        originalJob = IntPtr.Zero;
        child = new ProcessInformation();
    }

    private static bool Absolute(string path)
    {
        return path.Length > 3 && path[1] == ':' && path[2] == '\\' &&
            ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) && path.IndexOf('\0') < 0;
    }

    private static IOException Refused() { return new IOException("Windows-owned launch unavailable."); }
    private static void Close(IntPtr handle) { if (handle != IntPtr.Zero) CloseHandle(handle); }

    private static FileStream Stream(ref IntPtr handle, FileAccess access)
    {
        var owned = new SafeFileHandle(handle, true);
        handle = IntPtr.Zero;
        try { return new FileStream(owned, access, 4096, false); }
        catch { owned.Dispose(); throw; }
    }

    private static void MakePipe(out IntPtr read, out IntPtr write, bool parentReads)
    {
        var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), InheritHandle = true };
        if (!CreatePipe(out read, out write, ref security, 0) || !SetHandleInformation(parentReads ? read : write, 1, 0))
            throw Refused();
    }

    private static char[] EnvironmentBlock(string[] values)
    {
        var entries = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string value in values)
        {
            int delimiter = value.IndexOf('=');
            if (delimiter <= 0 || value.IndexOf('\0') >= 0) throw Refused();
            entries.Add(value.Substring(0, delimiter), value);
        }
        return (entries.Count == 0 ? "\0\0" : string.Join("\0", entries.Values) + "\0\0").ToCharArray();
    }

    private static string Quote(string text)
    {
        if (text.IndexOf('\0') >= 0) throw Refused();
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in text)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') quoted.Append('\\', slashes + 1);
            quoted.Append('\\', slashes).Append(ch);
            slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }
}

internal static class WindowsOwnedLauncher
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly object ResponseLock = new object();
    private const int InputSize = 32768;

    private static void Reply(string line)
    {
        lock (ResponseLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
    }

    private static string ReadPart(string value) { return Utf8.GetString(Convert.FromBase64String(value)); }

    private static Thread Worker(Action action)
    {
        var thread = new Thread(() => action()) { IsBackground = true };
        thread.Start();
        return thread;
    }

    private static void Pump(Stream stream, string field)
    {
        var buffer = new byte[4096];
        for (int read = stream.Read(buffer, 0, buffer.Length); read > 0; read = stream.Read(buffer, 0, buffer.Length))
            Reply(field + "\t" + Convert.ToBase64String(buffer, 0, read));
    }

    private static void Serve(OwnedWindowsChild child)
    {
        var writes = new BlockingCollection<byte[]>(8);
        bool verified = false, active = false;
        int inputFailed = 0;
        Action failInput = () => {
            if (Interlocked.Exchange(ref inputFailed, 1) == 0) Reply("input-error");
        };
        Action pumpInput = () => {
            try
            {
                using (child.Input)
                    foreach (byte[] data in writes.GetConsumingEnumerable())
                        if (Volatile.Read(ref inputFailed) == 0) { child.Input.Write(data, 0, data.Length); child.Input.Flush(); }
            }
            catch (IOException)
            {
                try { failInput(); }
                catch (IOException) { /* The controller closed its transport. */ }
            }
        };
        Action reportExit = () => {
            int outputFailed = 0;
            Func<Stream, string, Thread> startPump = (stream, field) => Worker(() => {
                try { Pump(stream, field); }
                catch (Exception) { Interlocked.Exchange(ref outputFailed, 1); }
            });
            Thread output = startPump(child.Output, "stdout"), error = startPump(child.Error, "stderr");
            uint? exit = child.WaitForExit();
            output.Join();
            error.Join();
            try { Reply(exit.HasValue && outputFailed == 0 ? "closed\t" + exit.Value.ToString(CultureInfo.InvariantCulture) : "closed"); }
            catch (IOException) { /* The controller closed its transport. */ }
        };
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            string[] parts = line.Split('\t');
            switch (parts[0])
            {
                case "verify":
                    verified = !active && child.Verify();
                    Reply(verified ? "verified" : "unverified");
                    break;
                case "activate":
                    active = verified && !active && child.Activate();
                    Reply(active ? "active" : "inactive");
                    if (!active) return;
                    Worker(pumpInput);
                    Worker(reportExit);
                    break;
                case "observe":
                    int? count = active ? child.Observe() : null;
                    Reply(count.HasValue ? "group\t" + count.Value.ToString(CultureInfo.InvariantCulture) : "group");
                    break;
                case "input":
                    if (!active || writes.IsAddingCompleted || parts.Length != 2 || parts[1].Length > (InputSize + 2) / 3 * 4)
                    { if (active) failInput(); break; }
                    byte[] bytes = Convert.FromBase64String(parts[1]);
                    if (bytes.Length > InputSize || !writes.TryAdd(bytes)) failInput();
                    break;
                case "eof":
                    if (active) writes.CompleteAdding();
                    break;
                case "dispose":
                    if (active) writes.CompleteAdding();
                    else return;
                    break;
                case "close":
                    return;
                default:
                    return;
            }
        }
    }

    private static int Main()
    {
        try
        {
            string line = Console.ReadLine();
            if (line == null || line.Length > 262144) return 1;
            string[] parts = line.Split('\t');
            if (parts.Length < 4 || parts[0] != "launch") return 1;
            int argCount;
            if (!int.TryParse(parts[1], out argCount) || argCount < 0 || argCount > parts.Length - 4) return 1;
            string executable = ReadPart(parts[2]), cwd = ReadPart(parts[3]);
            var argv = new string[argCount];
            var environment = new string[parts.Length - 4 - argCount];
            for (int i = 0; i < argv.Length; ++i) argv[i] = ReadPart(parts[4 + i]);
            for (int i = 0; i < environment.Length; ++i) environment[i] = ReadPart(parts[4 + argCount + i]);
            var child = new OwnedWindowsChild(executable, argv, cwd, environment);
            try
            {
                Reply("started");
                Serve(child);
            }
            finally
            {
                // On lost control after activation, do not close handles under a live native wait.
                // Process exit drops the broker's handles without terminating the Job.
                if (!child.Activated) child.Dispose();
            }
            return 0;
        }
        catch (Exception) { return 1; }
    }
}
