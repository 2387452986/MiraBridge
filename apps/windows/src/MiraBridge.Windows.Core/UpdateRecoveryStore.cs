using System.Security.Cryptography;
using System.Text.Json;

namespace MiraBridge.Windows.Core;

public sealed record UpdateRecoveryReceipt(
    int SchemaVersion,
    string State,
    string PreviousVersion,
    string TargetVersion,
    string PreviousPackage,
    long PreviousPackageBytes,
    string PreviousPackageSha256,
    DateTimeOffset CreatedAt,
    string? LastError);

public enum UpdateStartupAction
{
    Continue,
    ExitForRollback
}

public sealed class UpdateRecoveryStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly string _velopackRoot;
    private readonly string _dataRoot;
    private readonly string _receiptPath;
    private readonly string _backupRoot;

    public UpdateRecoveryStore(
        string? velopackRoot = null,
        string? dataRoot = null,
        string? receiptPath = null,
        string? backupRoot = null)
    {
        _velopackRoot = Path.GetFullPath(velopackRoot ?? AppPaths.VelopackRoot);
        _dataRoot = Path.GetFullPath(dataRoot ?? AppPaths.LocalDataRoot);
        _receiptPath = Path.GetFullPath(receiptPath ?? Path.Combine(_dataRoot, "update-recovery.json"));
        _backupRoot = Path.GetFullPath(backupRoot ?? Path.Combine(_dataRoot, "update-backups"));
        string dataPrefix = _dataRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!_receiptPath.StartsWith(dataPrefix, StringComparison.OrdinalIgnoreCase)
            || !_backupRoot.StartsWith(dataPrefix, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Update recovery state must remain inside the MiraBridge data root.");
    }

    public async Task<UpdateRecoveryReceipt> PrepareAsync(
        string previousVersion,
        string targetVersion,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(previousVersion);
        ArgumentException.ThrowIfNullOrWhiteSpace(targetVersion);
        string packages = Path.Combine(_velopackRoot, "packages");
        string marker = $"-{previousVersion}-";
        string source = Directory.Exists(packages)
            ? Directory.EnumerateFiles(packages, "*-full.nupkg", SearchOption.TopDirectoryOnly)
                .Where(path => Path.GetFileName(path).Contains(marker, StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault() ?? string.Empty
            : string.Empty;
        if (source.Length == 0)
            throw new FileNotFoundException($"The installed full package for {previousVersion} is unavailable; update is refused because automatic rollback cannot be guaranteed.", packages);

        string backupDirectory = Path.Combine(_backupRoot, $"{DateTimeOffset.UtcNow:yyyyMMddTHHmmssZ}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(backupDirectory);
        string destination = Path.Combine(backupDirectory, Path.GetFileName(source));
        string temporary = destination + ".partial";
        try
        {
            await using (FileStream input = new(source, FileMode.Open, FileAccess.Read, FileShare.Read))
            await using (FileStream output = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await input.CopyToAsync(output, cancellationToken);
                await output.FlushAsync(cancellationToken);
                output.Flush(flushToDisk: true);
            }
            File.Move(temporary, destination);
            FileInfo copied = new(destination);
            string sha256 = await Sha256Async(destination, cancellationToken);
            var receipt = new UpdateRecoveryReceipt(
                1, "prepared", previousVersion, targetVersion, destination,
                copied.Length, sha256, DateTimeOffset.UtcNow, null);
            await WriteAsync(receipt, cancellationToken);
            return receipt;
        }
        catch (Exception error)
        {
            try
            {
                if (File.Exists(temporary)) File.Delete(temporary);
                if (Directory.Exists(backupDirectory)) Directory.Delete(backupDirectory, recursive: true);
            }
            catch (Exception cleanupError)
            {
                throw new AggregateException("Update rollback-package staging and cleanup both failed.", error, cleanupError);
            }
            throw;
        }
    }

    public async Task<UpdateStartupAction> ProcessStartupAsync(
        string currentVersion,
        Func<CancellationToken, Task<(bool Ok, string? Error)>> healthProbe,
        Func<UpdateRecoveryReceipt, CancellationToken, Task> launchRollback,
        CancellationToken cancellationToken = default)
    {
        UpdateRecoveryReceipt? receipt = await ReadAsync(cancellationToken);
        if (receipt is null) return UpdateStartupAction.Continue;

        if (receipt.State == "prepared" && currentVersion == receipt.PreviousVersion)
        {
            await CompleteAsync(receipt, cancellationToken);
            return UpdateStartupAction.Continue;
        }

        if (receipt.State == "prepared" && currentVersion == receipt.TargetVersion)
        {
            (bool ok, string? error) = await healthProbe(cancellationToken);
            if (ok)
            {
                await CompleteAsync(receipt, cancellationToken);
                return UpdateStartupAction.Continue;
            }
            await VerifyPackageAsync(receipt, cancellationToken);
            UpdateRecoveryReceipt rollingBack = receipt with { State = "rollback_started", LastError = error ?? "Post-update health verification failed." };
            await WriteAsync(rollingBack, cancellationToken);
            await launchRollback(rollingBack, cancellationToken);
            return UpdateStartupAction.ExitForRollback;
        }

        if (receipt.State == "rollback_started" && currentVersion == receipt.PreviousVersion)
        {
            (bool ok, string? error) = await healthProbe(cancellationToken);
            if (ok)
            {
                await CompleteAsync(receipt, cancellationToken);
                return UpdateStartupAction.Continue;
            }
            await WriteAsync(receipt with { State = "rollback_failed", LastError = error ?? "The restored version failed health verification." }, cancellationToken);
            return UpdateStartupAction.Continue;
        }

        if (receipt.State != "rollback_failed")
        {
            await WriteAsync(receipt with
            {
                State = "rollback_failed",
                LastError = $"Unexpected installed version {currentVersion}; expected {receipt.TargetVersion} or {receipt.PreviousVersion}."
            }, cancellationToken);
        }
        return UpdateStartupAction.Continue;
    }

    public async Task CancelPreparedAsync(UpdateRecoveryReceipt prepared, CancellationToken cancellationToken = default)
    {
        UpdateRecoveryReceipt? current = await ReadAsync(cancellationToken);
        if (current is not null
            && current.State == "prepared"
            && current.PreviousPackageSha256 == prepared.PreviousPackageSha256)
            await CompleteAsync(current, cancellationToken);
    }

    public async Task<UpdateRecoveryReceipt?> ReadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_receiptPath)) return null;
        await using FileStream stream = new(_receiptPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        UpdateRecoveryReceipt? receipt = await JsonSerializer.DeserializeAsync<UpdateRecoveryReceipt>(stream, JsonOptions, cancellationToken);
        if (receipt is null || receipt.SchemaVersion != 1) throw new InvalidDataException("MiraBridge update recovery receipt is invalid.");
        return receipt;
    }

    private async Task VerifyPackageAsync(UpdateRecoveryReceipt receipt, CancellationToken cancellationToken)
    {
        string package = Path.GetFullPath(receipt.PreviousPackage);
        string backupPrefix = _backupRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!package.StartsWith(backupPrefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(package))
            throw new InvalidDataException("MiraBridge rollback package is missing or outside its managed backup root.");
        FileInfo file = new(package);
        if (file.Length != receipt.PreviousPackageBytes
            || !string.Equals(await Sha256Async(package, cancellationToken), receipt.PreviousPackageSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("MiraBridge rollback package integrity verification failed.");
    }

    private async Task CompleteAsync(UpdateRecoveryReceipt receipt, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string? directory = Path.GetDirectoryName(Path.GetFullPath(receipt.PreviousPackage));
        string backupPrefix = _backupRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (directory is not null && directory.StartsWith(backupPrefix, StringComparison.OrdinalIgnoreCase))
            Directory.Delete(directory, recursive: true);
        File.Delete(_receiptPath);
        File.Delete(_receiptPath + ".mirabridge.bak");
        await Task.CompletedTask;
    }

    private async Task WriteAsync(UpdateRecoveryReceipt receipt, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_dataRoot);
        await AtomicFile.WriteTextAsync(_receiptPath, JsonSerializer.Serialize(receipt, JsonOptions) + Environment.NewLine, backup: true, cancellationToken);
    }

    private static async Task<string> Sha256Async(string path, CancellationToken cancellationToken)
    {
        await using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
    }

}
