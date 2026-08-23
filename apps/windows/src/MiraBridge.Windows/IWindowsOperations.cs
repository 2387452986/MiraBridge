using MiraBridge.Windows.Core;

namespace MiraBridge.Windows;

public sealed record WindowsStatus(
    bool Ready,
    string Summary,
    string Details,
    bool SshReady = false,
    bool WorkerReady = false,
    bool BrowserReady = false,
    bool TerminalReady = false,
    string Architecture = "Unknown",
    string Addresses = "—",
    string HostFingerprint = "—",
    int ActiveJobs = 0,
    long StorageUsedBytes = 0,
    long StorageQuotaBytes = 0,
    IReadOnlyList<string>? AllowedRoots = null,
    string DesktopAccess = "disabled",
    bool RecycleBinEnabled = false,
    bool WebSnapshotEnabled = false);

public interface IWindowsOperations
{
    Task<WindowsStatus> GetStatusAsync(CancellationToken cancellationToken = default);
    Task<string> RepairAsync(string root, CancellationToken cancellationToken = default);
    Task<string> PairAsync(string requestCode, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<PairingRecord>> ListPairingsAsync(CancellationToken cancellationToken = default);
    Task<string> RevokePairingAsync(string fingerprint, CancellationToken cancellationToken = default);
    Task<string> AddRootAsync(string root, CancellationToken cancellationToken = default);
    Task<string> RemoveRootAsync(string root, CancellationToken cancellationToken = default);
    Task<string> SetCapabilitiesAsync(string desktop, bool recycleBin, bool webSnapshot, CancellationToken cancellationToken = default);
    Task<string> CheckForUpdatesAsync(bool userInitiated, CancellationToken cancellationToken = default);
    Task<string> ExportDiagnosticsAsync(CancellationToken cancellationToken = default);
    Task<string> InstallOptionalToolAsync(string tool, CancellationToken cancellationToken = default);
    Task<string> UninstallAsync(bool purgeData, CancellationToken cancellationToken = default);
    void OpenHelp(string language);
    void OpenIssue();
}
