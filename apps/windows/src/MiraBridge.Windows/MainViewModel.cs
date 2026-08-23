using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Input;
using MiraBridge.Windows.Core;

namespace MiraBridge.Windows;

public sealed class MainViewModel : INotifyPropertyChanged
{
    private readonly IWindowsOperations _operations;
    private string _status = "Checking...";
    private string _details = string.Empty;
    private string _pairRequestCode = string.Empty;
    private string _pairResponseCode = string.Empty;
    private string _pairedMacs = "No paired Macs.";
    private string _revokeFingerprint = string.Empty;
    private string _defaultRoot = AppPaths.DefaultAllowedRoot;
    private string _desktopAccess = "read-write";
    private bool _recycleBin = true;
    private bool _webSnapshot = true;
    private string _message = string.Empty;
    private bool _diagnosticsReady;
    private bool _busy;
    private bool _isReady;
    private bool _sshReady;
    private bool _workerReady;
    private bool _browserReady;
    private bool _terminalReady;
    private string _architecture = "—";
    private string _addresses = "—";
    private string _hostFingerprint = "—";
    private int _activeJobs;
    private string _storageSummary = "—";
    private IReadOnlyList<string> _allowedRoots = [];
    private IReadOnlyList<PairingRecord> _pairings = [];
    private PairingRecord? _selectedPairing;

    public MainViewModel(IWindowsOperations operations)
    {
        _operations = operations;
        RefreshCommand = Command(RefreshAsync);
        RepairCommand = Command(RepairAsync);
        PairCommand = Command(PairAsync, () => !string.IsNullOrWhiteSpace(PairRequestCode));
        PasteRequestCommand = Command(PasteRequestAsync);
        RevokePairingCommand = Command(RevokePairingAsync, () => !string.IsNullOrWhiteSpace(RevokeFingerprint));
        CopyResponseCommand = Command(CopyResponseAsync, () => !string.IsNullOrWhiteSpace(PairResponseCode));
        CopyFingerprintCommand = Command(CopyFingerprintAsync, () => !string.IsNullOrWhiteSpace(HostFingerprint) && HostFingerprint != "—");
        AddRootCommand = Command(AddRootAsync, () => !string.IsNullOrWhiteSpace(DefaultRoot));
        RemoveRootCommand = Command(RemoveRootAsync, () => !string.IsNullOrWhiteSpace(DefaultRoot));
        SaveCapabilitiesCommand = Command(SaveCapabilitiesAsync);
        CheckUpdateCommand = Command(CheckUpdateAsync);
        DiagnosticsCommand = Command(DiagnosticsAsync);
        OpenIssueCommand = Command(() => { _operations.OpenIssue(); return Task.CompletedTask; }, () => _diagnosticsReady);
        UninstallPreserveCommand = Command(() => UninstallAsync(purgeData: false));
        UninstallAllCommand = Command(() => UninstallAsync(purgeData: true));
        HelpCommand = Command(() => { _operations.OpenHelp(Language); return Task.CompletedTask; });
        InstallGitCommand = Command(() => InstallToolAsync("git"));
        InstallPowerShellCommand = Command(() => InstallToolAsync("powershell"));
        InstallPythonCommand = Command(() => InstallToolAsync("python"));
        InstallNodeCommand = Command(() => InstallToolAsync("node"));
        InstallDotNetCommand = Command(() => InstallToolAsync("dotnet"));
        InstallFfmpegCommand = Command(() => InstallToolAsync("ffmpeg"));
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    public ICommand RefreshCommand { get; }
    public ICommand RepairCommand { get; }
    public ICommand PairCommand { get; }
    public ICommand PasteRequestCommand { get; }
    public ICommand RevokePairingCommand { get; }
    public ICommand CopyResponseCommand { get; }
    public ICommand CopyFingerprintCommand { get; }
    public ICommand AddRootCommand { get; }
    public ICommand RemoveRootCommand { get; }
    public ICommand SaveCapabilitiesCommand { get; }
    public ICommand CheckUpdateCommand { get; }
    public ICommand DiagnosticsCommand { get; }
    public ICommand OpenIssueCommand { get; }
    public ICommand UninstallPreserveCommand { get; }
    public ICommand UninstallAllCommand { get; }
    public ICommand HelpCommand { get; }
    public ICommand InstallGitCommand { get; }
    public ICommand InstallPowerShellCommand { get; }
    public ICommand InstallPythonCommand { get; }
    public ICommand InstallNodeCommand { get; }
    public ICommand InstallDotNetCommand { get; }
    public ICommand InstallFfmpegCommand { get; }

    public string Status { get => _status; private set => Set(ref _status, value); }
    public string Details { get => _details; private set => Set(ref _details, value); }
    public string PairRequestCode { get => _pairRequestCode; set { Set(ref _pairRequestCode, value); RefreshCommands(); } }
    public string PairResponseCode { get => _pairResponseCode; private set { Set(ref _pairResponseCode, value); OnPropertyChanged(nameof(HasPairResponse)); RefreshCommands(); } }
    public bool HasPairResponse => !string.IsNullOrWhiteSpace(PairResponseCode);
    public string PairedMacs { get => _pairedMacs; private set => Set(ref _pairedMacs, value); }
    public string RevokeFingerprint { get => _revokeFingerprint; set { Set(ref _revokeFingerprint, value); RefreshCommands(); } }
    public string DefaultRoot { get => _defaultRoot; set { Set(ref _defaultRoot, value); RefreshCommands(); } }
    public string DesktopAccess { get => _desktopAccess; set => Set(ref _desktopAccess, value); }
    public bool RecycleBin { get => _recycleBin; set => Set(ref _recycleBin, value); }
    public bool WebSnapshot { get => _webSnapshot; set => Set(ref _webSnapshot, value); }
    public string Message { get => _message; private set { Set(ref _message, value); OnPropertyChanged(nameof(HasMessage)); } }
    public bool HasMessage => !string.IsNullOrWhiteSpace(Message);
    public bool Busy { get => _busy; private set { Set(ref _busy, value); OnPropertyChanged(nameof(NotBusy)); RefreshCommands(); } }
    public bool NotBusy => !Busy;
    public bool IsReady { get => _isReady; private set => Set(ref _isReady, value); }
    public bool SshReady { get => _sshReady; private set => Set(ref _sshReady, value); }
    public bool WorkerReady { get => _workerReady; private set => Set(ref _workerReady, value); }
    public bool BrowserReady { get => _browserReady; private set => Set(ref _browserReady, value); }
    public bool TerminalReady { get => _terminalReady; private set => Set(ref _terminalReady, value); }
    public string Architecture { get => _architecture; private set => Set(ref _architecture, value); }
    public string Addresses { get => _addresses; private set => Set(ref _addresses, value); }
    public string HostFingerprint { get => _hostFingerprint; private set { Set(ref _hostFingerprint, value); RefreshCommands(); } }
    public int ActiveJobs { get => _activeJobs; private set => Set(ref _activeJobs, value); }
    public string StorageSummary { get => _storageSummary; private set => Set(ref _storageSummary, value); }
    public IReadOnlyList<string> AllowedRoots { get => _allowedRoots; private set { Set(ref _allowedRoots, value); OnPropertyChanged(nameof(HasAllowedRoots)); } }
    public bool HasAllowedRoots => AllowedRoots.Count > 0;
    public IReadOnlyList<PairingRecord> Pairings { get => _pairings; private set { Set(ref _pairings, value); OnPropertyChanged(nameof(HasPairings)); OnPropertyChanged(nameof(PairedMacCount)); } }
    public bool HasPairings => Pairings.Count > 0;
    public int PairedMacCount => Pairings.Count;
    public PairingRecord? SelectedPairing
    {
        get => _selectedPairing;
        set
        {
            Set(ref _selectedPairing, value);
            RevokeFingerprint = value?.PublicKeyFingerprint ?? string.Empty;
        }
    }
    public string Language { get; set; } = "zh-CN";

    public async Task InitializeAsync()
    {
        await RunAsync(async () =>
        {
            await RefreshAsync();
            string update = await _operations.CheckForUpdatesAsync(userInitiated: false);
            if (update.Contains("available", StringComparison.OrdinalIgnoreCase)) Message = update;
        });
    }

    private AsyncCommand Command(Func<Task> operation, Func<bool>? canExecute = null)
        => new(async () => await RunAsync(operation), () => !Busy && (canExecute?.Invoke() ?? true));

    private async Task RunAsync(Func<Task> operation)
    {
        Busy = true;
        Message = string.Empty;
        try { await operation(); }
        catch (Exception error) { Message = error.Message; }
        finally { Busy = false; }
    }

    private async Task RefreshAsync()
    {
        WindowsStatus status = await _operations.GetStatusAsync();
        Status = status.Summary;
        Details = status.Details;
        IsReady = status.Ready;
        SshReady = status.SshReady;
        WorkerReady = status.WorkerReady;
        BrowserReady = status.BrowserReady;
        TerminalReady = status.TerminalReady;
        Architecture = status.Architecture;
        Addresses = status.Addresses;
        HostFingerprint = status.HostFingerprint;
        ActiveJobs = status.ActiveJobs;
        StorageSummary = status.StorageQuotaBytes > 0
            ? $"{FormatBytes(status.StorageUsedBytes)} / {FormatBytes(status.StorageQuotaBytes)}"
            : "Unavailable";
        AllowedRoots = status.AllowedRoots ?? [];
        DesktopAccess = status.DesktopAccess;
        RecycleBin = status.RecycleBinEnabled;
        WebSnapshot = status.WebSnapshotEnabled;
        IReadOnlyList<PairingRecord> pairings = await _operations.ListPairingsAsync();
        Pairings = pairings.OrderBy(value => value.MacName, StringComparer.OrdinalIgnoreCase).ToArray();
        PairedMacs = pairings.Count == 0
            ? "No paired Macs."
            : string.Join(Environment.NewLine, pairings.OrderBy(value => value.MacName, StringComparer.OrdinalIgnoreCase).Select(value => $"{value.MacName} · {value.NodeId} · {value.PublicKeyFingerprint} · {value.PairedAt:u}"));
    }

    private async Task RepairAsync()
    {
        Message = await _operations.RepairAsync(DefaultRoot);
        await RefreshAsync();
    }

    private async Task PairAsync()
    {
        PairResponseCode = await _operations.PairAsync(PairRequestCode.Trim());
        Message = "Pairing response is ready. Copy it back to the Mac.";
        await RefreshAsync();
    }

    private Task PasteRequestAsync()
    {
        if (System.Windows.Clipboard.ContainsText()) PairRequestCode = System.Windows.Clipboard.GetText().Trim();
        return Task.CompletedTask;
    }

    private async Task RevokePairingAsync()
    {
        Message = await _operations.RevokePairingAsync(RevokeFingerprint);
        RevokeFingerprint = string.Empty;
        await RefreshAsync();
    }

    private Task CopyResponseAsync()
    {
        System.Windows.Clipboard.SetText(PairResponseCode);
        Message = "Pairing response copied.";
        return Task.CompletedTask;
    }

    private Task CopyFingerprintAsync()
    {
        System.Windows.Clipboard.SetText(HostFingerprint);
        Message = "Host fingerprint copied.";
        return Task.CompletedTask;
    }

    private async Task AddRootAsync()
    {
        Message = await _operations.AddRootAsync(DefaultRoot);
        await RefreshAsync();
    }

    private async Task RemoveRootAsync()
    {
        Message = await _operations.RemoveRootAsync(DefaultRoot);
        await RefreshAsync();
    }

    private async Task SaveCapabilitiesAsync()
    {
        Message = await _operations.SetCapabilitiesAsync(DesktopAccess, RecycleBin, WebSnapshot);
        await RefreshAsync();
    }
    private async Task CheckUpdateAsync() => Message = await _operations.CheckForUpdatesAsync(userInitiated: true);
    private async Task DiagnosticsAsync()
    {
        Message = await _operations.ExportDiagnosticsAsync();
        _diagnosticsReady = true;
        RefreshCommands();
    }
    private async Task InstallToolAsync(string tool) => Message = await _operations.InstallOptionalToolAsync(tool);

    private async Task UninstallAsync(bool purgeData)
    {
        string warning = purgeData
            ? "This removes the app, MiraBridge configuration, Job history, logs and audit data. Continue?"
            : "This removes the app and its owned SSH/firewall configuration but preserves Worker data. Continue?";
        if (System.Windows.MessageBox.Show(warning, "Uninstall MiraBridge", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        Message = await _operations.UninstallAsync(purgeData);
        System.Windows.Application.Current.Shutdown();
    }

    private void RefreshCommands()
    {
        foreach (ICommand command in new[] { PairCommand, RevokePairingCommand, CopyResponseCommand, CopyFingerprintCommand, AddRootCommand, RemoveRootCommand, OpenIssueCommand }) (command as AsyncCommand)?.Refresh();
    }

    private static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        double value = Math.Max(0, bytes);
        int unit = 0;
        while (value >= 1024 && unit < units.Length - 1) { value /= 1024; unit++; }
        return $"{value:0.#} {units[unit]}";
    }

    private void Set<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        OnPropertyChanged(propertyName);
    }

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}
