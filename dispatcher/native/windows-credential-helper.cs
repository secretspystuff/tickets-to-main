using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class WindowsCredentialHelper
{
    private const int Generic = 1;
    private const int LocalMachine = 2;
    private const int NotFound = 1168;
    private const int InvalidData = 13;
    private const int MaxBlob = 2560;
    private const string Owner = "Tickets to Main Dispatcher v1";
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 16 };
    private static readonly Regex Target = new Regex(@"\ATicketsToMain/dispatcher/v1/[a-f0-9]{64}/(?:board-key|device-code)\z", RegexOptions.CultureInvariant);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWrite(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredFree")]
    private static extern void CredFree(IntPtr credential);

    private static Dictionary<string, object> Object(object value)
    {
        var result = value as Dictionary<string, object>;
        if (result == null) throw new InvalidOperationException();
        return result;
    }
    private static void Exact(Dictionary<string, object> value, params string[] keys)
    {
        if (value.Count != keys.Length) throw new InvalidOperationException();
        foreach (var key in keys) if (!value.ContainsKey(key)) throw new InvalidOperationException();
    }
    private static string Text(Dictionary<string, object> value, string key)
    {
        object found;
        if (!value.TryGetValue(key, out found) || !(found is string)) throw new InvalidOperationException();
        return (string)found;
    }
    private static void Number(Dictionary<string, object> value, string key, int expected)
    {
        object found;
        if (!value.TryGetValue(key, out found) || !(found is int) || (int)found != expected) throw new InvalidOperationException();
    }
    private static string OwnedTarget(Dictionary<string, object> value)
    {
        var target = Text(value, "target");
        if (!Target.IsMatch(target)) throw new InvalidOperationException();
        return target;
    }
    private static Dictionary<string, object> Status(string status)
    {
        return new Dictionary<string, object> { { "status", status } };
    }
    private static Dictionary<string, object> Error(int code)
    {
        return new Dictionary<string, object> { { "status", "error" }, { "code", code } };
    }

    private static Dictionary<string, object> Read(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, Generic, 0, out pointer))
        {
            int code = Marshal.GetLastWin32Error();
            return code == NotFound ? Status("not-found") : Error(code);
        }
        try
        {
            var value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            if (value.Type != Generic || value.Persist != LocalMachine || value.Flags != 0 || value.TargetName != target
                || value.UserName != Owner || value.CredentialBlobSize == 0 || value.CredentialBlobSize > MaxBlob
                || value.CredentialBlob == IntPtr.Zero || value.AttributeCount != 0) return Error(InvalidData);
            var blob = new byte[value.CredentialBlobSize];
            try
            {
                Marshal.Copy(value.CredentialBlob, blob, 0, blob.Length);
                Utf8.GetString(blob);
                var credential = new Dictionary<string, object> {
                    { "target", target }, { "type", Generic }, { "persist", LocalMachine }, { "flags", 0 },
                    { "username", Owner }, { "blob", Convert.ToBase64String(blob) }
                };
                return new Dictionary<string, object> { { "status", "found" }, { "credential", credential } };
            }
            finally { Array.Clear(blob, 0, blob.Length); }
        }
        finally { CredFree(pointer); }
    }

    private static Dictionary<string, object> Write(Dictionary<string, object> request)
    {
        Exact(request, "operation", "flags", "credential");
        Number(request, "flags", 0);
        var supplied = Object(request["credential"]);
        Exact(supplied, "target", "flags", "type", "persist", "username", "blob");
        string target = OwnedTarget(supplied);
        Number(supplied, "flags", 0);
        Number(supplied, "type", Generic);
        Number(supplied, "persist", LocalMachine);
        if (Text(supplied, "username") != Owner) return Error(InvalidData);
        string encoded = Text(supplied, "blob");
        if (encoded.Length > ((MaxBlob + 2) / 3) * 4) return Error(InvalidData);
        byte[] blob = Convert.FromBase64String(encoded);
        IntPtr memory = IntPtr.Zero;
        try
        {
            if (blob.Length == 0 || blob.Length > MaxBlob || Convert.ToBase64String(blob) != encoded) return Error(InvalidData);
            Utf8.GetString(blob);
            var before = Read(target);
            if ((string)before["status"] == "error") return before;
            memory = Marshal.AllocHGlobal(blob.Length);
            Marshal.Copy(blob, 0, memory, blob.Length);
            var value = new Credential {
                Flags = 0, Type = Generic, TargetName = target, CredentialBlobSize = (uint)blob.Length,
                CredentialBlob = memory, Persist = LocalMachine, UserName = Owner
            };
            if (!CredWrite(ref value, 0)) return Error(Marshal.GetLastWin32Error());
            return Status("written");
        }
        finally
        {
            if (memory != IntPtr.Zero)
            {
                Array.Clear(blob, 0, blob.Length);
                Marshal.Copy(blob, 0, memory, blob.Length);
                Marshal.FreeHGlobal(memory);
            }
            Array.Clear(blob, 0, blob.Length);
        }
    }

    private static Dictionary<string, object> Run(Dictionary<string, object> request)
    {
        string operation = Text(request, "operation");
        if (operation == "write") return Write(request);
        Exact(request, "operation", "target", "type", "flags");
        Number(request, "type", Generic);
        Number(request, "flags", 0);
        string target = OwnedTarget(request);
        if (operation == "read") return Read(target);
        if (operation != "delete") return Error(InvalidData);
        var before = Read(target);
        if ((string)before["status"] != "found") return before;
        if (!CredDelete(target, Generic, 0))
        {
            int code = Marshal.GetLastWin32Error();
            return code == NotFound ? Status("not-found") : Error(code);
        }
        return Status("deleted");
    }

    public static int Main(string[] args)
    {
        Dictionary<string, object> result;
        try
        {
            if (args.Length != 0) throw new InvalidOperationException();
            var input = new StringBuilder();
            int character;
            while ((character = Console.In.Read()) != -1)
            {
                if (input.Length >= 16384) throw new InvalidOperationException();
                input.Append((char)character);
            }
            result = Run(Object(Json.DeserializeObject(input.ToString())));
        }
        catch { result = Error(InvalidData); }
        try { Console.Out.Write(Json.Serialize(result)); return 0; }
        catch { return 1; }
    }
}
