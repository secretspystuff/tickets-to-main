using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

public static class FilesystemPrivacy {
    static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
    static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
    static readonly SecurityIdentifier Administrators = new SecurityIdentifier("S-1-5-32-544");
    static bool Allowed(SecurityIdentifier sid) { return sid == User || sid == SystemSid || sid == Administrators; }
    static FileSystemSecurity Security(string path, bool directory) {
        return directory ? (FileSystemSecurity)Directory.GetAccessControl(path, AccessControlSections.Access | AccessControlSections.Owner)
            : File.GetAccessControl(path, AccessControlSections.Access | AccessControlSections.Owner);
    }
    static bool Private(FileSystemSecurity security) {
        var raw = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
        if (!Allowed(raw.Owner) || (raw.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 || raw.DiscretionaryAcl == null) return false;
        bool userGrant = false;
        foreach (GenericAce ace in raw.DiscretionaryAcl) {
            var common = ace as CommonAce;
            if (common == null || common.IsCallback) return false;
            if (common.AceQualifier == AceQualifier.AccessDenied) continue;
            if (common.AceQualifier != AceQualifier.AccessAllowed || !Allowed(common.SecurityIdentifier)) return false;
            if (common.SecurityIdentifier == User && common.AccessMask != 0 && (common.AceFlags & AceFlags.InheritOnly) == 0) userGrant = true;
        }
        return userGrant;
    }
    static void Protect(string path, bool directory) {
        var old = Security(path, directory);
        var owner = (SecurityIdentifier)old.GetOwner(typeof(SecurityIdentifier));
        if (!Allowed(owner)) throw new UnauthorizedAccessException();
        FileSystemSecurity secured = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
        secured.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { User, SystemSid, Administrators }) {
            secured.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
                PropagationFlags.None, AccessControlType.Allow));
        }
        if (directory) Directory.SetAccessControl(path, (DirectorySecurity)secured);
        else File.SetAccessControl(path, (FileSecurity)secured);
    }
    static int Operation(string[] args) {
        try {
            if (args.Length != 2 || !Path.IsPathRooted(args[1])) return 2;
            string path = args[1];
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) return 2;
            bool directory = (attributes & FileAttributes.Directory) != 0;
            if (args[0] == "protect") Protect(path, directory);
            else if (args[0] != "check" && args[0] != "snapshot") return 2;
            var security = Security(path, directory);
            if (args[0] == "snapshot") { Console.Write(Convert.ToBase64String(security.GetSecurityDescriptorBinaryForm())); return 0; }
            return Private(security) ? 0 : 2;
        } catch { return 2; }
    }
    public static int Main(string[] args) {
        if (args.Length != 1 || args[0] != "serve") return Operation(args);
        string line;
        while ((line = Console.ReadLine()) != null) {
            var writer = new StringWriter();
            var output = Console.Out;
            int result = 2;
            try {
                var parts = line.Split('\t');
                if (parts.Length == 2 && line.Length <= 16384) {
                    Console.SetOut(writer);
                    result = Operation(new[] { parts[0], System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(parts[1])) });
                }
            } catch { result = 2; }
            finally { Console.SetOut(output); }
            Console.WriteLine(result.ToString() + "\t" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(writer.ToString())));
            Console.Out.Flush();
        }
        return 0;
    }
}
