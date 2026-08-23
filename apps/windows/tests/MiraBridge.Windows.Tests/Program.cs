using System.Text;
using System.Text.Json;
using System.IO;
using MiraBridge.Windows;
using MiraBridge.Windows.Core;

namespace MiraBridge.Windows.Tests;

internal static class Program
{
    private const string PublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKYmyTVY9UGb2JUsf5zmY8x2qNCyQWRon9y1zLxyLxiq";
    private static int _passed;

    [STAThread]
    public static async Task<int> Main()
    {
        await Run("pairing TTL and fingerprint", PairingContractAsync);
        await Run("pairing replay protection", PairingReplayAsync);
        await Run("SSH managed block preservation", SshManagedBlockAsync);
        await Run("authorized_keys ownership", AuthorizedKeysAsync);
        await Run("diagnostic redaction", RedactionAsync);
        await Run("update recovery verified path", UpdateRecoveryVerifiedAsync);
        await Run("update recovery rollback path", UpdateRecoveryRollbackAsync);
        await Run("ViewModel readiness", ViewModelAsync);
        Console.WriteLine($"PASS {_passed}/8 Windows client checks");
        return 0;
    }

    private static Task PairingContractAsync()
    {
        DateTimeOffset now = DateTimeOffset.Parse("2026-08-23T00:00:00Z");
        string code = RequestCode(now, now.AddMinutes(30));
        PairingRequest parsed = PairingCodec.DecodeRequest(code, now.AddMinutes(1));
        Equal("windows-main", parsed.NodeId);
        Throws<InvalidDataException>(() => PairingCodec.DecodeRequest(code, now.AddMinutes(31)));
        string tampered = code[..^1] + (code[^1] == 'A' ? 'B' : 'A');
        Throws<InvalidDataException>(() => PairingCodec.DecodeRequest(tampered, now));
        return Task.CompletedTask;
    }

    private static async Task PairingReplayAsync()
    {
        string directory = Directory.CreateTempSubdirectory("mirabridge-pairing-store-").FullName;
        var store = new PairingStore(Path.Combine(directory, "records.json"), Path.Combine(directory, "nonces.json"));
        DateTimeOffset now = DateTimeOffset.UtcNow;
        PairingRequest request = PairingCodec.DecodeRequest(RequestCode(now, now.AddMinutes(30)), now);
        await store.AddAsync(request, now);
        await ThrowsAsync<InvalidDataException>(() => store.AddAsync(request, now));
    }

    private static Task SshManagedBlockAsync()
    {
        string existing = "Port 22\r\nAllowUsers Administrator ExistingUser\r\n# custom\r\n";
        string result = ManagedSshConfiguration.Apply(existing, freshInstall: false);
        True(result.Contains("# custom", StringComparison.Ordinal));
        True(result.Contains("Match User Administrator", StringComparison.Ordinal));
        Equal(1, result.Split(ManagedSshConfiguration.BeginMarker).Length - 1);
        Equal(1, ManagedSshConfiguration.Apply(result, freshInstall: false).Split(ManagedSshConfiguration.BeginMarker).Length - 1);
        Throws<InvalidDataException>(() => ManagedSshConfiguration.Apply("AllowUsers SomeoneElse\r\n", freshInstall: false));
        return Task.CompletedTask;
    }

    private static async Task AuthorizedKeysAsync()
    {
        string directory = Directory.CreateTempSubdirectory("mirabridge-keys-").FullName;
        string path = Path.Combine(directory, "administrators_authorized_keys");
        await File.WriteAllTextAsync(path, "ssh-ed25519 AAAAexisting existing-user\r\n");
        DateTimeOffset now = DateTimeOffset.UtcNow;
        PairingRequest request = PairingCodec.DecodeRequest(RequestCode(now, now.AddMinutes(30)), now);
        True(await AuthorizedKeysManager.AddAsync(request, path));
        True(!await AuthorizedKeysManager.AddAsync(request, path));
        string text = await File.ReadAllTextAsync(path);
        True(text.Contains("AAAAexisting", StringComparison.Ordinal));
        Equal(1, await AuthorizedKeysManager.RemoveAsync(request.PublicKeyFingerprint, path));
        True((await File.ReadAllTextAsync(path)).Contains("AAAAexisting", StringComparison.Ordinal));
        await AuthorizedKeysManager.AddAsync(request, path);
        Equal(1, await AuthorizedKeysManager.RemoveAllOwnedAsync(path));
        Equal("ssh-ed25519 AAAAexisting existing-user", (await File.ReadAllTextAsync(path)).Trim());
    }

    private static Task RedactionAsync()
    {
        string keyHeader = "-----BEGIN OPENSSH " + "PRIVATE KEY-----";
        string keyFooter = "-----END OPENSSH " + "PRIVATE KEY-----";
        string redacted = DiagnosticRedactor.Redact($"C:\\Users\\Alice\\secret.txt\nAPI_TOKEN=value\nAuthorization Bearer abc\n{keyHeader}x{keyFooter}");
        True(!redacted.Contains("Alice", StringComparison.Ordinal));
        True(!redacted.Contains("Bearer abc", StringComparison.Ordinal));
        True(!redacted.Contains("PRIVATE KEY-----x", StringComparison.Ordinal));
        return Task.CompletedTask;
    }

    private static async Task ViewModelAsync()
    {
        var viewModel = new MainViewModel(new FakeOperations());
        await viewModel.InitializeAsync();
        Equal("Ready", viewModel.Status);
        True(viewModel.Details.Contains("x64", StringComparison.Ordinal));
        True(viewModel.IsReady);
        True(viewModel.SshReady && viewModel.WorkerReady && viewModel.BrowserReady && viewModel.TerminalReady);
        Equal("x64", viewModel.Architecture);
        Equal(1, viewModel.ActiveJobs);
        Equal(1, viewModel.AllowedRoots.Count);
        True(viewModel.StorageSummary.Contains("GB", StringComparison.Ordinal));
        True(viewModel.NotBusy);
        Equal("~/.local/bin/mirabridge pair create", viewModel.PairCreateCommandText);
        viewModel.PairRequestCode = "request";
        viewModel.PairCommand.Execute(null);
        for (int attempt = 0; attempt < 100 && viewModel.Busy; attempt++) await Task.Delay(10);
        Equal("~/.local/bin/mirabridge pair accept response", viewModel.PairAcceptCommandText);
        True(viewModel.CopyPairAcceptCommand.CanExecute(null));
    }

    private static async Task UpdateRecoveryVerifiedAsync()
    {
        string root = Directory.CreateTempSubdirectory("mirabridge-update-recovery-").FullName;
        string packages = Directory.CreateDirectory(Path.Combine(root, "app", "packages")).FullName;
        string data = Directory.CreateDirectory(Path.Combine(root, "data")).FullName;
        await File.WriteAllTextAsync(Path.Combine(packages, "MiraBridge.Windows-2.0.0-rc.1-full.nupkg"), "known-good-package");
        var store = new UpdateRecoveryStore(Path.Combine(root, "app"), data);
        UpdateRecoveryReceipt receipt = await store.PrepareAsync("2.0.0-rc.1", "2.0.0-rc.5");
        True(File.Exists(receipt.PreviousPackage));
        UpdateStartupAction action = await store.ProcessStartupAsync(
            "2.0.0-rc.5",
            _ => Task.FromResult<(bool, string?)>((true, null)),
            (_, _) => throw new Exception("Rollback must not launch after a healthy update."));
        Equal(UpdateStartupAction.Continue, action);
        True(!File.Exists(Path.Combine(data, "update-recovery.json")));
    }

    private static async Task UpdateRecoveryRollbackAsync()
    {
        string root = Directory.CreateTempSubdirectory("mirabridge-update-rollback-").FullName;
        string packages = Directory.CreateDirectory(Path.Combine(root, "app", "packages")).FullName;
        string data = Directory.CreateDirectory(Path.Combine(root, "data")).FullName;
        await File.WriteAllTextAsync(Path.Combine(packages, "MiraBridge.Windows-2.0.0-rc.1-full.nupkg"), "known-good-package");
        var store = new UpdateRecoveryStore(Path.Combine(root, "app"), data);
        _ = await store.PrepareAsync("2.0.0-rc.1", "2.0.0-rc.5");
        bool launched = false;
        UpdateStartupAction action = await store.ProcessStartupAsync(
            "2.0.0-rc.5",
            _ => Task.FromResult<(bool, string?)>((false, "injected doctor failure")),
            (receipt, _) =>
            {
                launched = File.Exists(receipt.PreviousPackage);
                return Task.CompletedTask;
            });
        Equal(UpdateStartupAction.ExitForRollback, action);
        True(launched);
        Equal("rollback_started", (await store.ReadAsync())?.State);
        Equal(UpdateStartupAction.Continue, await store.ProcessStartupAsync(
            "2.0.0-rc.1",
            _ => Task.FromResult<(bool, string?)>((true, null)),
            (_, _) => throw new Exception("Rollback must not recurse.")));
        True(!File.Exists(Path.Combine(data, "update-recovery.json")));
    }

    private static string RequestCode(DateTimeOffset created, DateTimeOffset expires)
    {
        var request = new PairingRequest("request", 1, created, expires, "1pRvuX6uLgTvJx4oFyxskU_X6gK5bNbC", "windows-main", PublicKey, PairingCodec.FingerprintPublicKey(PublicKey), new PairingMac("Test Mac", "arm64", "2.0.0-rc.5"));
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(request, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        return PairingCodec.Prefix + Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static async Task Run(string name, Func<Task> test)
    {
        await test();
        _passed++;
        Console.WriteLine($"PASS {name}");
    }

    private static void Equal<T>(T expected, T actual)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"Expected {expected}, got {actual}.");
    }

    private static void True(bool value)
    {
        if (!value) throw new Exception("Expected true.");
    }

    private static void Throws<T>(Action action) where T : Exception
    {
        try { action(); }
        catch (T) { return; }
        throw new Exception($"Expected {typeof(T).Name}.");
    }

    private static async Task ThrowsAsync<T>(Func<Task> action) where T : Exception
    {
        try { await action(); }
        catch (T) { return; }
        throw new Exception($"Expected {typeof(T).Name}.");
    }

    private sealed class FakeOperations : IWindowsOperations
    {
        public Task<WindowsStatus> GetStatusAsync(CancellationToken cancellationToken = default) => Task.FromResult(new WindowsStatus(
            true,
            "Ready",
            "x64",
            SshReady: true,
            WorkerReady: true,
            BrowserReady: true,
            TerminalReady: true,
            Architecture: "x64",
            Addresses: "192.168.1.2",
            HostFingerprint: "SHA256:test",
            ActiveJobs: 1,
            StorageUsedBytes: 1024 * 1024 * 1024,
            StorageQuotaBytes: 10L * 1024 * 1024 * 1024,
            AllowedRoots: [@"D:\MiraBridgeRoot"],
            DesktopAccess: "read-write",
            RecycleBinEnabled: true,
            WebSnapshotEnabled: true));
        public Task<string> RepairAsync(string root, CancellationToken cancellationToken = default) => Task.FromResult("ok");
        public Task<string> PairAsync(string requestCode, CancellationToken cancellationToken = default) => Task.FromResult("response");
        public Task<IReadOnlyList<PairingRecord>> ListPairingsAsync(CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<PairingRecord>>([]);
        public Task<string> RevokePairingAsync(string fingerprint, CancellationToken cancellationToken = default) => Task.FromResult("ok");
        public Task<string> AddRootAsync(string root, CancellationToken cancellationToken = default) => Task.FromResult("ok");
        public Task<string> RemoveRootAsync(string root, CancellationToken cancellationToken = default) => Task.FromResult("ok");
        public Task<string> SetCapabilitiesAsync(string desktop, bool recycleBin, bool webSnapshot, CancellationToken cancellationToken = default) => Task.FromResult("ok");
        public Task<string> CheckForUpdatesAsync(bool userInitiated, CancellationToken cancellationToken = default) => Task.FromResult("up to date");
        public Task<string> ExportDiagnosticsAsync(CancellationToken cancellationToken = default) => Task.FromResult("ok");
        public Task<string> InstallOptionalToolAsync(string tool, CancellationToken cancellationToken = default) => Task.FromResult("ok");
        public Task<string> UninstallAsync(bool purgeData, CancellationToken cancellationToken = default) => Task.FromResult("ok");
        public void OpenHelp(string language) { }
        public void OpenIssue() { }
    }
}
