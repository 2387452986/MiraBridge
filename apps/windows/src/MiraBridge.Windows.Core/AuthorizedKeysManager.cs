namespace MiraBridge.Windows.Core;

public static class AuthorizedKeysManager
{
    private const string MarkerPrefix = "mirabridge:";

    public static async Task<bool> AddAsync(PairingRequest request, string? path = null, CancellationToken cancellationToken = default)
    {
        string destination = path ?? AppPaths.AdministratorsAuthorizedKeys;
        string fingerprint = PairingCodec.FingerprintPublicKey(request.PublicKey).TrimEnd('=');
        string marker = MarkerPrefix + fingerprint;
        string existing = File.Exists(destination) ? await File.ReadAllTextAsync(destination, cancellationToken) : string.Empty;
        if (existing.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).Any(line => line.TrimEnd().EndsWith(marker, StringComparison.Ordinal))) return false;
        string next = existing.TrimEnd('\r', '\n');
        if (next.Length > 0) next += "\r\n";
        next += request.PublicKey + " " + marker + "\r\n";
        await AtomicFile.WriteTextAsync(destination, next, backup: File.Exists(destination), cancellationToken);
        return true;
    }

    public static async Task<int> RemoveAsync(string fingerprint, string? path = null, CancellationToken cancellationToken = default)
    {
        string destination = path ?? AppPaths.AdministratorsAuthorizedKeys;
        if (!File.Exists(destination)) return 0;
        string marker = MarkerPrefix + fingerprint.TrimEnd('=');
        string existing = await File.ReadAllTextAsync(destination, cancellationToken);
        string[] lines = existing.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries);
        string[] retained = lines.Where(line => !line.TrimEnd().EndsWith(marker, StringComparison.Ordinal)).ToArray();
        int removed = lines.Length - retained.Length;
        if (removed > 0) await AtomicFile.WriteTextAsync(destination, string.Join("\r\n", retained) + "\r\n", backup: true, cancellationToken);
        return removed;
    }

    public static async Task<int> RemoveAllOwnedAsync(string? path = null, CancellationToken cancellationToken = default)
    {
        string destination = path ?? AppPaths.AdministratorsAuthorizedKeys;
        if (!File.Exists(destination)) return 0;
        string existing = await File.ReadAllTextAsync(destination, cancellationToken);
        string[] lines = existing.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries);
        string[] retained = lines.Where(line => line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).LastOrDefault() is not { } token || !token.StartsWith(MarkerPrefix, StringComparison.Ordinal)).ToArray();
        int removed = lines.Length - retained.Length;
        if (removed > 0) await AtomicFile.WriteTextAsync(destination, retained.Length == 0 ? string.Empty : string.Join("\r\n", retained) + "\r\n", backup: true, cancellationToken);
        return removed;
    }
}
