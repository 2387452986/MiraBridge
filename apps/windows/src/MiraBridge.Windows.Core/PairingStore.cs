using System.Text.Json;

namespace MiraBridge.Windows.Core;

public sealed class PairingStore
{
    private readonly string _recordsPath;
    private readonly string _noncesPath;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public PairingStore(string? recordsPath = null, string? noncesPath = null)
    {
        _recordsPath = recordsPath ?? AppPaths.PairingRecords;
        _noncesPath = noncesPath ?? AppPaths.PairingNonces;
    }

    public async Task<IReadOnlyList<PairingRecord>> ListAsync(CancellationToken cancellationToken = default)
        => await ReadAsync<PairingRecord>(_recordsPath, cancellationToken);

    public async Task AddAsync(PairingRequest request, DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        List<string> nonces = (await ReadAsync<string>(_noncesPath, cancellationToken)).ToList();
        if (nonces.Contains(request.Nonce, StringComparer.Ordinal)) throw new InvalidDataException("Pairing request nonce was already used.");
        nonces.Add(request.Nonce);
        if (nonces.Count > 2048) nonces.RemoveRange(0, nonces.Count - 2048);
        List<PairingRecord> records = (await ListAsync(cancellationToken)).Where(value => value.PublicKeyFingerprint != request.PublicKeyFingerprint).ToList();
        records.Add(new PairingRecord(request.NodeId, request.Mac.Name, request.PublicKeyFingerprint, now));
        await AtomicFile.WriteTextAsync(_noncesPath, JsonSerializer.Serialize(nonces, JsonOptions) + Environment.NewLine, backup: true, cancellationToken);
        await AtomicFile.WriteTextAsync(_recordsPath, JsonSerializer.Serialize(records, JsonOptions) + Environment.NewLine, backup: true, cancellationToken);
    }

    public async Task RemoveAsync(string fingerprint, CancellationToken cancellationToken = default)
    {
        List<PairingRecord> records = (await ListAsync(cancellationToken)).Where(value => value.PublicKeyFingerprint != fingerprint).ToList();
        await AtomicFile.WriteTextAsync(_recordsPath, JsonSerializer.Serialize(records, JsonOptions) + Environment.NewLine, backup: true, cancellationToken);
    }

    public Task ClearRecordsAsync(CancellationToken cancellationToken = default)
        => AtomicFile.WriteTextAsync(_recordsPath, "[]" + Environment.NewLine, backup: true, cancellationToken);

    private static async Task<IReadOnlyList<T>> ReadAsync<T>(string path, CancellationToken cancellationToken)
    {
        if (!File.Exists(path)) return [];
        await using FileStream stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<List<T>>(stream, JsonOptions, cancellationToken) ?? [];
    }
}
