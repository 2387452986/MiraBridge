using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;
using MiraBridge.Windows.Core;
using Velopack;
using Velopack.Sources;

namespace MiraBridge.Windows;

public sealed class WindowsOperations : IWindowsOperations
{
    private const string UpdateMaintenanceOwner = "windows-app-update";
    private const string UninstallMaintenanceOwner = "windows-app-uninstall";
    private readonly WorkerCli _worker = new();
    private readonly UpdateCheckPolicy _updatePolicy = new();
    private readonly UpdateRecoveryStore _updateRecovery = new();

    public async Task<WindowsStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        string[] addresses = WindowsHostInfo.AddressCandidates();
        var details = new Dictionary<string, object?>
        {
            ["version"] = "2.0.0-rc.3",
            ["os"] = RuntimeInformation.OSDescription,
            ["architecture"] = WindowsHostInfo.Architecture,
            ["addresses"] = addresses
        };
        bool sshReady = false;
        string hostFingerprint = "Unavailable";
        try
        {
            ProcessResult ssh = await ProcessRunner.RunAsync("sc.exe", ["query", "sshd"], TimeSpan.FromSeconds(15), cancellationToken);
            sshReady = ssh.ExitCode == 0 && ssh.Stdout.Contains("RUNNING", StringComparison.OrdinalIgnoreCase);
            details["ssh"] = sshReady ? "running" : "not running";
            hostFingerprint = await WindowsHostInfo.HostFingerprintAsync(cancellationToken);
            details["host_fingerprint"] = hostFingerprint;
        }
        catch (Exception error) { details["ssh_error"] = error.Message; }
        bool workerReady = false;
        bool browserReady = false;
        bool terminalReady = false;
        string architecture = WindowsHostInfo.Architecture;
        int activeJobs = 0;
        long storageUsedBytes = 0;
        long storageQuotaBytes = 0;
        IReadOnlyList<string> allowedRoots = [];
        string desktopAccess = "disabled";
        bool recycleBinEnabled = false;
        bool webSnapshotEnabled = false;
        try
        {
            using JsonDocument worker = await _worker.DoctorAsync(cancellationToken);
            details["worker"] = worker.RootElement.Clone();
            workerReady = worker.RootElement.TryGetProperty("runtime_ready", out JsonElement runtimeReady) && runtimeReady.GetBoolean();
            if (worker.RootElement.TryGetProperty("architecture", out JsonElement architectureElement)
                && architectureElement.TryGetProperty("architecture", out JsonElement nativeArchitecture))
                architecture = nativeArchitecture.GetString() ?? architecture;
            terminalReady = worker.RootElement.TryGetProperty("conpty", out JsonElement conpty)
                && conpty.TryGetProperty("available", out JsonElement terminalAvailable)
                && terminalAvailable.GetBoolean();
            browserReady = worker.RootElement.TryGetProperty("edge", out JsonElement edge)
                && edge.TryGetProperty("executable", out JsonElement edgeExecutable)
                && edgeExecutable.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(edgeExecutable.GetString());
            if (worker.RootElement.TryGetProperty("storage", out JsonElement storage))
            {
                if (storage.TryGetProperty("used_bytes", out JsonElement usedBytes)) storageUsedBytes = usedBytes.GetInt64();
                if (storage.TryGetProperty("quota_bytes", out JsonElement quotaBytes)) storageQuotaBytes = quotaBytes.GetInt64();
            }
            using JsonDocument jobs = await _worker.JobsListAsync(cancellationToken);
            details["jobs"] = jobs.RootElement.Clone();
            if (jobs.RootElement.ValueKind == JsonValueKind.Array)
            {
                activeJobs = jobs.RootElement.EnumerateArray().Count(job =>
                    job.TryGetProperty("executor_status", out JsonElement status)
                    && status.GetString() is "queued" or "starting" or "running");
            }
            using JsonDocument config = await _worker.ConfigShowAsync(cancellationToken);
            details["config"] = config.RootElement.Clone();
            if (config.RootElement.TryGetProperty("result", out JsonElement result))
            {
                if (result.TryGetProperty("allowed_roots", out JsonElement roots) && roots.ValueKind == JsonValueKind.Array)
                    allowedRoots = roots.EnumerateArray().Select(root => root.GetString()).OfType<string>().ToArray();
                if (result.TryGetProperty("desktop_access", out JsonElement desktop)) desktopAccess = desktop.GetString() ?? desktopAccess;
                if (result.TryGetProperty("recycle_bin_enabled", out JsonElement recycle)) recycleBinEnabled = recycle.GetBoolean();
                if (result.TryGetProperty("web_snapshot_enabled", out JsonElement webSnapshot)) webSnapshotEnabled = webSnapshot.GetBoolean();
            }
        }
        catch (Exception error) { details["worker_error"] = error.Message; }
        bool recoveryReady = true;
        try
        {
            UpdateRecoveryReceipt? recovery = await _updateRecovery.ReadAsync(cancellationToken);
            if (recovery is not null)
            {
                details["update_recovery"] = new { recovery.State, recovery.PreviousVersion, recovery.TargetVersion, recovery.LastError };
                recoveryReady = recovery.State is "prepared" or "rollback_started";
            }
        }
        catch (Exception error)
        {
            details["update_recovery_error"] = DiagnosticRedactor.Redact(error.Message);
            recoveryReady = false;
        }
        bool ready = sshReady && workerReady && recoveryReady;
        string json = JsonSerializer.Serialize(details, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true });
        return new WindowsStatus(
            ready,
            ready ? "Ready" : "Needs Attention",
            DiagnosticRedactor.Redact(json),
            sshReady,
            workerReady,
            browserReady,
            terminalReady,
            architecture,
            addresses.Length == 0 ? "Unavailable" : string.Join("  ·  ", addresses),
            hostFingerprint,
            activeJobs,
            storageUsedBytes,
            storageQuotaBytes,
            allowedRoots,
            desktopAccess,
            recycleBinEnabled,
            webSnapshotEnabled);
    }

    public async Task<string> RepairAsync(string root, CancellationToken cancellationToken = default)
    {
        JsonDocument result = await RunElevatedAsync(["repair", "--root", Path.GetFullPath(root)], cancellationToken);
        RegisterStartup();
        if (!result.RootElement.GetProperty("ok").GetBoolean()) return ResultError(result);
        await _worker.EndMaintenanceAsync(UpdateMaintenanceOwner, cancellationToken);
        await _worker.EndMaintenanceAsync(UninstallMaintenanceOwner, cancellationToken);
        return "MiraBridge repair and verification completed.";
    }

    public async Task<string> PairAsync(string requestCode, CancellationToken cancellationToken = default)
    {
        string requestPath = Path.Combine(Path.GetTempPath(), $"mirabridge-pair-{Guid.NewGuid():N}.txt");
        try
        {
            await File.WriteAllTextAsync(requestPath, requestCode, cancellationToken);
            using JsonDocument result = await RunElevatedAsync(["pair-add", "--request-file", requestPath], cancellationToken);
            if (!result.RootElement.GetProperty("ok").GetBoolean()) throw new InvalidOperationException(ResultError(result));
            return result.RootElement.GetProperty("response_code").GetString() ?? throw new InvalidDataException("Pairing helper returned no response code.");
        }
        finally { File.Delete(requestPath); }
    }

    public Task<IReadOnlyList<PairingRecord>> ListPairingsAsync(CancellationToken cancellationToken = default)
        => new PairingStore().ListAsync(cancellationToken);

    public async Task<string> RevokePairingAsync(string fingerprint, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fingerprint);
        using JsonDocument result = await RunElevatedAsync(["pair-revoke", "--fingerprint", fingerprint.Trim()], cancellationToken);
        return result.RootElement.GetProperty("ok").GetBoolean() ? "Paired Mac access revoked." : ResultError(result);
    }

    public async Task<string> AddRootAsync(string root, CancellationToken cancellationToken = default)
    {
        using JsonDocument result = await _worker.AddRootAsync(Path.GetFullPath(root), cancellationToken);
        return result.RootElement.GetProperty("ok").GetBoolean() ? "Allowed root added and validated." : ResultError(result);
    }

    public async Task<string> RemoveRootAsync(string root, CancellationToken cancellationToken = default)
    {
        using JsonDocument result = await _worker.RemoveRootAsync(Path.GetFullPath(root), cancellationToken);
        return result.RootElement.GetProperty("ok").GetBoolean() ? "Allowed root removed." : ResultError(result);
    }

    public async Task<string> SetCapabilitiesAsync(string desktop, bool recycleBin, bool webSnapshot, CancellationToken cancellationToken = default)
    {
        using JsonDocument desktopResult = await _worker.SetCapabilityAsync("desktop", desktop, cancellationToken);
        using JsonDocument recycleResult = await _worker.SetCapabilityAsync("recycle-bin", recycleBin ? "true" : "false", cancellationToken);
        using JsonDocument webResult = await _worker.SetCapabilityAsync("web-snapshot", webSnapshot ? "true" : "false", cancellationToken);
        return desktopResult.RootElement.GetProperty("ok").GetBoolean()
            && recycleResult.RootElement.GetProperty("ok").GetBoolean()
            && webResult.RootElement.GetProperty("ok").GetBoolean()
            ? "Capabilities saved by the Worker configuration owner."
            : "One or more capability updates failed.";
    }

    public async Task<string> CheckForUpdatesAsync(bool userInitiated, CancellationToken cancellationToken = default)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        if (!userInitiated && !await _updatePolicy.CanCheckAsync(now, cancellationToken)) return "Automatic update check already ran within 24 hours.";
        await _updatePolicy.RecordAsync(now, cancellationToken);
        var source = new GithubSource("https://github.com/2387452986/MiraBridge", null, true);
        var manager = new UpdateManager(source);
        UpdateInfo? update = await manager.CheckForUpdatesAsync();
        if (update is null) return "MiraBridge is up to date.";
        if (!userInitiated) return $"MiraBridge update {update.TargetFullRelease.Version} is available. Open Maintenance to review and install it.";
        await BeginMaintenanceAsync(UpdateMaintenanceOwner, "update", 4 * 60 * 60 * 1000, cancellationToken);
        UpdateRecoveryReceipt? recovery = null;
        try
        {
            await BackupWorkerStateAsync(cancellationToken);
            recovery = await _updateRecovery.PrepareAsync("2.0.0-rc.3", update.TargetFullRelease.Version.ToString(), cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            await manager.DownloadUpdatesAsync(update);
            manager.ApplyUpdatesAndRestart(update);
        }
        catch
        {
            if (recovery is not null) await _updateRecovery.CancelPreparedAsync(recovery, cancellationToken);
            await _worker.EndMaintenanceAsync(UpdateMaintenanceOwner, CancellationToken.None);
            throw;
        }
        return "Update downloaded; MiraBridge will restart to apply it.";
    }

    public async Task<string> ExportDiagnosticsAsync(CancellationToken cancellationToken = default)
    {
        WindowsStatus status = await GetStatusAsync(cancellationToken);
        IReadOnlyList<PairingRecord> pairings = await new PairingStore().ListAsync(cancellationToken);
        var preview = new
        {
            generated_at = DateTimeOffset.UtcNow,
            product = "MiraBridge for Windows",
            version = "2.0.0-rc.3",
            status = status.Summary,
            architecture = WindowsHostInfo.Architecture,
            paired_mac_count = pairings.Count,
            details = status.Details,
            excluded = new[] { "command bodies", "file contents", "usernames", "user paths", "tokens", "environment variables", "SSH private data" }
        };
        string directory = Path.Combine(AppPaths.LocalDataRoot, "diagnostics");
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, $"diagnostic-{DateTimeOffset.UtcNow:yyyyMMddTHHmmssZ}.json");
        string json = DiagnosticRedactor.Redact(JsonSerializer.Serialize(preview, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
        await AtomicFile.WriteTextAsync(path, json + Environment.NewLine, backup: false, cancellationToken);
        Process.Start(new ProcessStartInfo { FileName = "explorer.exe", ArgumentList = { "/select,", path }, UseShellExecute = false });
        return $"Redacted diagnostic preview created: {path}";
    }

    public async Task<string> InstallOptionalToolAsync(string tool, CancellationToken cancellationToken = default)
    {
        string id = tool switch
        {
            "git" => "Git.Git",
            "powershell" => "Microsoft.PowerShell",
            "python" => "Python.Python.3.13",
            "node" => "OpenJS.NodeJS.LTS",
            "dotnet" => "Microsoft.DotNet.SDK.10",
            "ffmpeg" => "Gyan.FFmpeg",
            _ => throw new ArgumentOutOfRangeException(nameof(tool), "Unknown optional tool.")
        };
        ProcessResult result;
        try
        {
            result = await ProcessRunner.RunAsync("winget.exe", ["install", "--id", id, "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements"], TimeSpan.FromMinutes(30), cancellationToken);
        }
        catch (Exception error)
        {
            throw new InvalidOperationException($"WinGet could not install {id}. Open local Help for the verified official-download fallback. {error.Message}", error);
        }
        result.EnsureSuccess($"Optional tool {id} installation");
        return $"{id} installed. MiraBridge did not install or change any GPU driver.";
    }

    public async Task<string> UninstallAsync(bool purgeData, CancellationToken cancellationToken = default)
    {
        await BeginMaintenanceAsync(UninstallMaintenanceOwner, "uninstall", 30 * 60 * 1000, cancellationToken);
        try
        {
            using JsonDocument result = await RunElevatedAsync(["uninstall-system", "--purge-data", purgeData.ToString().ToLowerInvariant()], cancellationToken);
            if (!result.RootElement.GetProperty("ok").GetBoolean()) throw new InvalidOperationException(ResultError(result));
            if (!File.Exists(AppPaths.UpdateExecutable)) throw new FileNotFoundException("Velopack Update.exe is missing. Reinstall MiraBridge or uninstall it from Windows Settings.", AppPaths.UpdateExecutable);
            var updater = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = AppPaths.UpdateExecutable,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };
            updater.StartInfo.ArgumentList.Add("uninstall");
            updater.StartInfo.ArgumentList.Add("--silent");
            if (!updater.Start()) throw new InvalidOperationException("Could not start the MiraBridge uninstaller.");
            return purgeData ? "Full uninstall started; Worker data was removed." : "Uninstall started; Worker data was preserved.";
        }
        catch
        {
            await _worker.EndMaintenanceAsync(UninstallMaintenanceOwner, CancellationToken.None);
            throw;
        }
    }

    public void OpenHelp(string language)
    {
        string file = language.StartsWith("en", StringComparison.OrdinalIgnoreCase) ? "HELP.en-US.html" : "HELP.zh-CN.html";
        string path = Path.Combine(AppContext.BaseDirectory, "Help", file);
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }

    public void OpenIssue()
        => Process.Start(new ProcessStartInfo("https://github.com/2387452986/MiraBridge/issues/new") { UseShellExecute = true });

    private static async Task<JsonDocument> RunElevatedAsync(string[] arguments, CancellationToken cancellationToken)
    {
        if (!File.Exists(AppPaths.ElevatedExecutable)) throw new FileNotFoundException("MiraBridge elevated helper is missing. Reinstall the app.", AppPaths.ElevatedExecutable);
        string resultPath = Path.Combine(Path.GetTempPath(), $"mirabridge-elevated-{Guid.NewGuid():N}.json");
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = AppPaths.ElevatedExecutable,
                    Verb = "runas",
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                }
            };
            foreach (string argument in arguments) process.StartInfo.ArgumentList.Add(argument);
            process.StartInfo.ArgumentList.Add("--result");
            process.StartInfo.ArgumentList.Add(resultPath);
            if (!process.Start()) throw new InvalidOperationException("Could not start MiraBridge system helper.");
            await process.WaitForExitAsync(cancellationToken);
            if (!File.Exists(resultPath)) throw new InvalidOperationException("MiraBridge system helper returned no result; UAC may have been cancelled.");
            JsonDocument result = JsonDocument.Parse(await File.ReadAllTextAsync(resultPath, cancellationToken));
            if (process.ExitCode != 0) throw new InvalidOperationException(ResultError(result));
            return result;
        }
        finally { File.Delete(resultPath); }
    }

    private async Task BeginMaintenanceAsync(string owner, string reason, int leaseMs, CancellationToken cancellationToken)
    {
        using JsonDocument result = await _worker.BeginMaintenanceAsync(owner, reason, leaseMs, cancellationToken);
        if (result.RootElement.TryGetProperty("ok", out JsonElement ok) && ok.GetBoolean()) return;
        string detail = result.RootElement.TryGetProperty("reason", out JsonElement deniedReason) ? deniedReason.GetString() ?? "unknown" : "unknown";
        int activeJobs = result.RootElement.TryGetProperty("active_jobs", out JsonElement active) ? active.GetInt32() : 0;
        throw new InvalidOperationException(activeJobs > 0
            ? $"MiraBridge has {activeJobs} active Job(s). {reason} is deferred until they finish or are explicitly cancelled."
            : $"MiraBridge maintenance is already in progress ({detail}).");
    }

    private static async Task BackupWorkerStateAsync(CancellationToken cancellationToken)
    {
        ProcessResult result = await ProcessRunner.RunAsync(AppPaths.HostExecutable, ["backup"], TimeSpan.FromMinutes(5), cancellationToken);
        result.EnsureSuccess("MiraBridge pre-update state backup");
    }

    private static void RegisterStartup()
    {
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
        string executable = File.Exists(AppPaths.StableAppExecutable) ? AppPaths.StableAppExecutable : Environment.ProcessPath ?? AppPaths.StableAppExecutable;
        key.SetValue("MiraBridge", $"\"{executable}\" --tray", RegistryValueKind.String);
    }

    private static string ResultError(JsonDocument result)
        => result.RootElement.TryGetProperty("error", out JsonElement error) ? error.GetString() ?? "Unknown MiraBridge system helper error." : "Unknown MiraBridge system helper error.";
}
