using System.Security.Principal;
using System.Text.Json;
using MiraBridge.Windows.Core;

namespace MiraBridge.Elevated;

internal static class Program
{
    private const string FirewallRule = "MiraBridge OpenSSH (LocalSubnet)";

    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("MiraBridge for Windows requires Windows 10 22H2 or Windows 11.");
            using var identity = WindowsIdentity.GetCurrent();
            if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw new UnauthorizedAccessException("MiraBridge system repair requires administrator approval.");
            _ = WindowsHostInfo.Architecture;
            if (args.Length == 0) return Usage();
            return args[0] switch
            {
                "install" or "repair" => await InstallAsync(Required(args, "--root"), Required(args, "--result")),
                "pair-add" => await PairAddAsync(Required(args, "--request-file"), Required(args, "--result")),
                "pair-revoke" => await PairRevokeAsync(Required(args, "--fingerprint"), Required(args, "--result")),
                "uninstall-system" => await UninstallSystemAsync(bool.TryParse(Value(args, "--purge-data"), out bool purge) && purge, Required(args, "--result")),
                _ => Usage()
            };
        }
        catch (Exception error)
        {
            string? result = Value(args, "--result");
            if (result is not null) await WriteResultAsync(result, new { ok = false, error = error.Message });
            await Console.Error.WriteLineAsync(error.Message);
            return 1;
        }
    }

    private static async Task<int> InstallAsync(string root, string resultPath)
    {
        string canonicalRoot = Path.GetFullPath(Environment.ExpandEnvironmentVariables(root));
        Directory.CreateDirectory(canonicalRoot);
        string? existingSshd = await TryResolveExecutableAsync("sshd.exe");
        bool hadSsh = existingSshd is not null;
        if (!hadSsh)
        {
            ProcessResult capability = await ProcessRunner.RunAsync("dism.exe", ["/Online", "/Add-Capability", "/CapabilityName:OpenSSH.Server~~~~0.0.1.0", "/NoRestart"], TimeSpan.FromMinutes(15));
            if (capability.ExitCode is not 0 and not 3010) capability.EnsureSuccess("OpenSSH Optional Capability installation");
        }
        string sshd = await ResolveExecutableAsync("sshd.exe");
        string sshKeygen = await ResolveExecutableAsync("ssh-keygen.exe");
        Directory.CreateDirectory(AppPaths.SshDirectory);
        (await ProcessRunner.RunAsync(sshKeygen, ["-A"], TimeSpan.FromMinutes(1))).EnsureSuccess("OpenSSH host key creation");
        string existing = File.Exists(AppPaths.SshConfig) ? await File.ReadAllTextAsync(AppPaths.SshConfig) : string.Empty;
        string next = ManagedSshConfiguration.Apply(existing, freshInstall: !hadSsh);
        string validation = AppPaths.SshConfig + ".mirabridge.validate";
        await File.WriteAllTextAsync(validation, next);
        try { (await ProcessRunner.RunAsync(sshd, ["-t", "-f", validation], TimeSpan.FromSeconds(30))).EnsureSuccess("OpenSSH configuration validation"); }
        finally { File.Delete(validation); }
        await AtomicFile.WriteTextAsync(AppPaths.SshConfig, next, backup: File.Exists(AppPaths.SshConfig));
        if (!File.Exists(AppPaths.AdministratorsAuthorizedKeys)) await AtomicFile.WriteTextAsync(AppPaths.AdministratorsAuthorizedKeys, string.Empty, backup: false);
        await ApplyAuthorizedKeysAclAsync();
        (await ProcessRunner.RunAsync("sc.exe", ["config", "sshd", "start=", "auto"], TimeSpan.FromSeconds(30))).EnsureSuccess("OpenSSH startup configuration");
        await ConfigureFirewallAsync();
        ProcessResult service = await ProcessRunner.RunAsync("sc.exe", ["start", "sshd"], TimeSpan.FromSeconds(30));
        if (service.ExitCode != 0 && !(service.Stdout + service.Stderr).Contains("1056", StringComparison.Ordinal)) service.EnsureSuccess("OpenSSH service start");
        var worker = new WorkerCli();
        using JsonDocument config = await worker.ConfigInitAsync(canonicalRoot);
        using JsonDocument doctor = await worker.DoctorAsync();
        RegisterStartup();
        await WriteResultAsync(resultPath, new
        {
            ok = true,
            architecture = WindowsHostInfo.Architecture,
            root = canonicalRoot,
            ssh_fingerprint = await WindowsHostInfo.HostFingerprintAsync(),
            addresses = WindowsHostInfo.AddressCandidates(),
            worker = doctor.RootElement.Clone(),
            config = config.RootElement.Clone()
        });
        return 0;
    }

    private static async Task<int> PairAddAsync(string requestPath, string resultPath)
    {
        string code = await File.ReadAllTextAsync(requestPath);
        PairingRequest request = PairingCodec.DecodeRequest(code.Trim(), DateTimeOffset.UtcNow);
        var store = new PairingStore();
        bool added = await AuthorizedKeysManager.AddAsync(request);
        try
        {
            await ApplyAuthorizedKeysAclAsync();
            await store.AddAsync(request, DateTimeOffset.UtcNow);
        }
        catch
        {
            if (added) await AuthorizedKeysManager.RemoveAsync(request.PublicKeyFingerprint);
            throw;
        }
        string[] addresses = WindowsHostInfo.AddressCandidates();
        if (addresses.Length == 0) throw new InvalidOperationException("No active LAN IPv4 address is available for pairing.");
        var worker = new WorkerCli();
        using JsonDocument configDocument = await worker.ConfigShowAsync();
        JsonElement config = configDocument.RootElement.GetProperty("result");
        string defaultRoot = config.GetProperty("allowed_roots").EnumerateArray().Select(value => value.GetString()).FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
            ?? throw new InvalidDataException("Worker configuration has no allowed root.");
        var capabilities = new List<string> { "process", "filesystem", "long_jobs", "interactive_terminal", "file_transfer" };
        if (config.GetProperty("desktop_access").GetString() != "disabled") capabilities.Add("desktop");
        if (config.GetProperty("recycle_bin_enabled").GetBoolean()) capabilities.Add("recycle_bin");
        if (config.GetProperty("web_snapshot_enabled").GetBoolean()) capabilities.Add("web_snapshot");
        string quotedHost = "\"" + AppPaths.HostExecutable + "\" worker";
        DateTimeOffset created = DateTimeOffset.UtcNow;
        var response = new PairingResponse(
            "response", 1, created, created.Add(PairingCodec.TimeToLive), PairingCodec.NewNonce(), request.Nonce,
            request.NodeId, request.PublicKeyFingerprint,
            new PairingWindows(Environment.MachineName, WindowsHostInfo.Architecture, Environment.UserName, "2.0.0-rc.5"),
            new PairingSsh(addresses, 22, await WindowsHostInfo.HostFingerprintAsync(), "ssh-ed25519"),
            quotedHost + " serve --stdio", quotedHost, defaultRoot,
            capabilities.ToArray());
        string responseCode = PairingCodec.EncodeResponse(response);
        await WriteResultAsync(resultPath, new { ok = true, response_code = responseCode, expires_at = response.ExpiresAt, fingerprint = response.Ssh.HostFingerprint });
        return 0;
    }

    private static async Task<int> PairRevokeAsync(string fingerprint, string resultPath)
    {
        int removed = await AuthorizedKeysManager.RemoveAsync(fingerprint);
        await new PairingStore().RemoveAsync(fingerprint);
        if (removed > 0) await ApplyAuthorizedKeysAclAsync();
        await WriteResultAsync(resultPath, new { ok = true, removed });
        return removed > 0 ? 0 : 2;
    }

    private static async Task<int> UninstallSystemAsync(bool purgeData, string resultPath)
    {
        if (File.Exists(AppPaths.SshConfig))
        {
            string existing = await File.ReadAllTextAsync(AppPaths.SshConfig);
            int begin = existing.IndexOf(ManagedSshConfiguration.BeginMarker, StringComparison.Ordinal);
            int end = existing.IndexOf(ManagedSshConfiguration.EndMarker, StringComparison.Ordinal);
            if (begin >= 0 && end >= begin)
            {
                int after = end + ManagedSshConfiguration.EndMarker.Length;
                while (after < existing.Length && (existing[after] == '\r' || existing[after] == '\n')) after++;
                await AtomicFile.WriteTextAsync(AppPaths.SshConfig, existing.Remove(begin, after - begin), backup: true);
            }
        }
        _ = await ProcessRunner.RunAsync("netsh.exe", ["advfirewall", "firewall", "delete", "rule", $"name={FirewallRule}"], TimeSpan.FromSeconds(30));
        int removedKeys = await AuthorizedKeysManager.RemoveAllOwnedAsync();
        if (removedKeys > 0) await ApplyAuthorizedKeysAclAsync();
        await new PairingStore().ClearRecordsAsync();
        using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true))
            key.DeleteValue("MiraBridge", throwOnMissingValue: false);
        if (purgeData)
        {
            await EnsureNoActiveJobsAsync();
            if (Directory.Exists(AppPaths.LocalDataRoot)) Directory.Delete(AppPaths.LocalDataRoot, recursive: true);
        }
        await WriteResultAsync(resultPath, new { ok = true, data_preserved = !purgeData, openssh_preserved = true, removed_authorized_keys = removedKeys });
        return 0;
    }

    private static void RegisterStartup()
    {
        if (!File.Exists(AppPaths.StableAppExecutable)) return;
        using Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
        key.SetValue("MiraBridge", $"\"{AppPaths.StableAppExecutable}\" --tray", Microsoft.Win32.RegistryValueKind.String);
    }

    private static async Task EnsureNoActiveJobsAsync()
    {
        var worker = new WorkerCli();
        using JsonDocument jobs = await worker.JobsListAsync();
        if (jobs.RootElement.ValueKind != JsonValueKind.Array) throw new InvalidDataException("Worker jobs list returned an unexpected shape.");
        string[] active = ["queued", "starting", "running"];
        if (jobs.RootElement.EnumerateArray().Any(job => job.TryGetProperty("executor_status", out JsonElement status) && active.Contains(status.GetString(), StringComparer.Ordinal)))
            throw new InvalidOperationException("A MiraBridge Job is active. Uninstall is deferred until all Jobs finish or are explicitly cancelled.");
    }

    private static async Task ConfigureFirewallAsync()
    {
        _ = await ProcessRunner.RunAsync("netsh.exe", ["advfirewall", "firewall", "delete", "rule", $"name={FirewallRule}"], TimeSpan.FromSeconds(30));
        (await ProcessRunner.RunAsync("netsh.exe", ["advfirewall", "firewall", "add", "rule", $"name={FirewallRule}", "dir=in", "action=allow", "protocol=TCP", "localport=22", "remoteip=LocalSubnet", "profile=private,domain"], TimeSpan.FromSeconds(30))).EnsureSuccess("MiraBridge LocalSubnet firewall rule");
    }

    private static async Task ApplyAuthorizedKeysAclAsync()
    {
        (await ProcessRunner.RunAsync("icacls.exe", [AppPaths.AdministratorsAuthorizedKeys, "/inheritance:r", "/grant:r", "*S-1-5-32-544:F", "/grant:r", "*S-1-5-18:F"], TimeSpan.FromSeconds(30))).EnsureSuccess("administrators_authorized_keys ACL");
    }

    private static async Task<string> ResolveExecutableAsync(string name)
        => await TryResolveExecutableAsync(name) ?? throw new FileNotFoundException($"Windows OpenSSH executable was not found: {name}");

    private static async Task<string?> TryResolveExecutableAsync(string name)
    {
        string system = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "OpenSSH", name);
        if (File.Exists(system)) return system;
        try
        {
            ProcessResult where = await ProcessRunner.RunAsync("where.exe", [name], TimeSpan.FromSeconds(10));
            if (where.ExitCode != 0) return null;
            return where.Stdout.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).Select(value => value.Trim()).FirstOrDefault(File.Exists);
        }
        catch { return null; }
    }

    private static string Required(string[] args, string name) => Value(args, name) ?? throw new ArgumentException($"{name} is required.");

    private static string? Value(string[] args, string name)
    {
        int index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static async Task WriteResultAsync(string path, object result)
        => await AtomicFile.WriteTextAsync(path, JsonSerializer.Serialize(result, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }) + Environment.NewLine, backup: false);

    private static int Usage()
    {
        Console.Error.WriteLine("Usage: MiraBridge.Elevated install|repair --root PATH --result FILE | pair-add --request-file FILE --result FILE | pair-revoke --fingerprint SHA256:... --result FILE | uninstall-system [--purge-data true|false] --result FILE");
        return 64;
    }
}
