using MiraBridge.Windows.Core;

namespace MiraBridge.Windows;

public sealed record WindowsStatus(bool Ready, string Summary, string Details);

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
