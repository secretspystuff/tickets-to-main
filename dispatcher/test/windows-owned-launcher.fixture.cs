using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;

internal static class WindowsOwnedLauncherProof
{
    [DllImport("kernel32.dll")] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll")] private static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll")] private static extern uint SuspendThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll")] private static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint size,
        IntPtr read, out uint available, IntPtr remaining);
    [DllImport("kernelbase.dll")] private static extern bool CompareObjectHandles(IntPtr first, IntPtr second);

    private static object Field(object instance, string field, BindingFlags access)
    {
        return instance.GetType().GetField(field, BindingFlags.Instance | access).GetValue(instance);
    }

    private static void Check(bool result, string description)
    {
        if (!result) throw new InvalidOperationException(description);
    }

    private static void Reader(string[] args)
    {
        IntPtr unrelated = new IntPtr(long.Parse(args[1]));
        uint flags;
        if (GetHandleInformation(unrelated, out flags))
        {
            using (var reference = EventWaitHandle.OpenExisting(args[2]))
            {
                IntPtr independent = reference.SafeWaitHandle.DangerousGetHandle();
                Check(unrelated != independent && !CompareObjectHandles(unrelated, independent), "unrelated handle inherited");
            }
        }
        uint buffered;
        Check(PeekNamedPipe(GetStdHandle(-10), IntPtr.Zero, 0, IntPtr.Zero, out buffered, IntPtr.Zero) &&
            buffered == 0, "input pipe had bytes at first execution");
        Console.Out.WriteLine("ready");
        Console.Out.Flush();
        Check(Console.In.ReadToEnd() == "fabricated input", "unexpected stdin");
        Console.Error.Write("fabricated stderr");
    }

    private static void Controller(string executable, string workspace)
    {
        string eventName = "ttm-owned-handle-" + Guid.NewGuid().ToString("N");
        using (var unrelated = new EventWaitHandle(false, EventResetMode.ManualReset, eventName))
        {
            IntPtr extra = unrelated.SafeWaitHandle.DangerousGetHandle();
            Check(SetHandleInformation(extra, 1, 1), "inheritable control unavailable");
            IntPtr foreign = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
            Check(foreign != IntPtr.Zero, "foreign control unavailable");
            try
            {
                string[] argv = { "reader", extra.ToInt64().ToString(), eventName };
                string[] env = { "SystemRoot=" + Environment.GetEnvironmentVariable("SystemRoot") };
                using (var child = new OwnedWindowsChild(executable, argv, workspace, env))
                {
                    IntPtr job = (IntPtr)Field(child, "originalJob", BindingFlags.NonPublic);
                    object exact = Field(child, "child", BindingFlags.NonPublic);
                    IntPtr process = (IntPtr)Field(exact, "Process", BindingFlags.NonPublic);
                    IntPtr thread = (IntPtr)Field(exact, "Thread", BindingFlags.NonPublic);
                    bool member;
                    Check(IsProcessInJob(process, job, out member) && member && child.Verify(), "exact child outside original Job");
                    Check(IsProcessInJob(process, foreign, out member) && !member, "foreign Job accepted");
                    Check(SuspendThread(thread) == 1 && ResumeThread(thread) == 2, "initial suspension was not present");
                    Check(child.Observe() == null, "observation before activation");
                    Check(child.Activate(), "activation failed");
                    using (var stdout = new StreamReader(child.Output))
                    using (var stderr = new StreamReader(child.Error))
                    {
                        Check(stdout.ReadLine() == "ready", "reader gates failed");
                        Check(child.Observe() == 1, "original Job active list unavailable");
                        Check(IsProcessInJob(process, job, out member) && member, "membership lost at first input");
                        using (var input = new StreamWriter(child.Input)) input.Write("fabricated input");
                        Check(stderr.ReadToEnd() == "fabricated stderr", "stderr pipe failed");
                        Check(child.WaitForExit() == 0 && child.Observe() == 0, "original Job drain list unavailable");
                    }
                }
            }
            finally { CloseHandle(foreign); }
        }
        Console.WriteLine("original-job exact-child suspended input-empty stdio-only live=1 drained=0");
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 3 && args[0] == "reader") Reader(args);
            else if (args.Length == 2) Controller(args[0], args[1]);
            else return 2;
            return 0;
        }
        catch (InvalidOperationException failure) { Console.Error.WriteLine(failure.Message); return 1; }
    }
}
