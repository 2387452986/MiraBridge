namespace MiraBridge.Windows.Core;

public static class AppPaths
{
    public static string InstallRoot => AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    public static string RuntimeRoot => Path.Combine(InstallRoot, "runtime");
    public static string NodeExecutable => Path.Combine(RuntimeRoot, "node", "node.exe");
    public static string WorkerEntry => Path.Combine(RuntimeRoot, "worker", "index.cjs");
    public static string HostExecutable => Path.Combine(InstallRoot, "MiraBridge.Host.exe");
    public static string ElevatedExecutable => Path.Combine(InstallRoot, "MiraBridge.Elevated.exe");
    public static string VelopackRoot => string.Equals(Path.GetFileName(InstallRoot), "current", StringComparison.OrdinalIgnoreCase)
        ? Directory.GetParent(InstallRoot)?.FullName ?? InstallRoot
        : InstallRoot;
    public static string StableAppExecutable => Path.Combine(VelopackRoot, "MiraBridge.Windows.exe");
    public static string UpdateExecutable => Path.Combine(VelopackRoot, "Update.exe");
    public static string LocalDataRoot => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MiraBridge");
    public static string WorkerConfig => Path.Combine(LocalDataRoot, "worker.toml");
    public static string PairingRecords => Path.Combine(LocalDataRoot, "paired-macs.json");
    public static string PairingNonces => Path.Combine(LocalDataRoot, "pairing-nonces.json");
    public static string UpdateRecoveryReceipt => Path.Combine(LocalDataRoot, "update-recovery.json");
    public static string UpdateBackupRoot => Path.Combine(LocalDataRoot, "update-backups");
    public static string DefaultAllowedRoot => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "MiraBridge");
    public static string SshDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ssh");
    public static string SshConfig => Path.Combine(SshDirectory, "sshd_config");
    public static string AdministratorsAuthorizedKeys => Path.Combine(SshDirectory, "administrators_authorized_keys");
    public static string SshHostPublicKey => Path.Combine(SshDirectory, "ssh_host_ed25519_key.pub");
}
