using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MiraBridge.Windows.Core;

public static partial class PairingCodec
{
    public const string Prefix = "MBPAIR1.";
    public const int MaxCodeBytes = 16 * 1024;
    public static readonly TimeSpan TimeToLive = TimeSpan.FromMinutes(30);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = null,
        WriteIndented = false
    };

    public static PairingRequest DecodeRequest(string code, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(code);
        if (Encoding.UTF8.GetByteCount(code) > MaxCodeBytes) throw new InvalidDataException("Pairing code exceeds 16 KiB.");
        if (!code.StartsWith(Prefix, StringComparison.Ordinal)) throw new InvalidDataException("Pairing code prefix or version is not supported.");
        byte[] bytes;
        try { bytes = Base64UrlDecode(code[Prefix.Length..]); }
        catch (FormatException error) { throw new InvalidDataException("Pairing code is not valid base64url JSON.", error); }
        PairingRequest request;
        try { request = JsonSerializer.Deserialize<PairingRequest>(bytes, JsonOptions) ?? throw new JsonException(); }
        catch (JsonException error) { throw new InvalidDataException("Pairing request JSON is invalid.", error); }
        ValidateRequest(request, now);
        return request;
    }

    public static string EncodeResponse(PairingResponse response)
    {
        ValidateResponse(response);
        string code = Prefix + Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(response, JsonOptions));
        if (Encoding.UTF8.GetByteCount(code) > MaxCodeBytes) throw new InvalidDataException("Pairing response exceeds 16 KiB.");
        return code;
    }

    public static void ValidateRequest(PairingRequest request, DateTimeOffset now)
    {
        if (request.Kind != "request" || request.FormatVersion != 1) throw new InvalidDataException("Pairing request type or version is invalid.");
        if (!NodeIdRegex().IsMatch(request.NodeId)) throw new InvalidDataException("Pairing node ID is invalid.");
        ValidateWindow(request.CreatedAt, request.ExpiresAt, now);
        if (!NonceRegex().IsMatch(request.Nonce)) throw new InvalidDataException("Pairing nonce is invalid.");
        string fingerprint = FingerprintPublicKey(request.PublicKey);
        byte[] actual = Encoding.ASCII.GetBytes(TrimPadding(fingerprint));
        byte[] expected = Encoding.ASCII.GetBytes(TrimPadding(request.PublicKeyFingerprint));
        if (actual.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(actual, expected))
            throw new InvalidDataException("Pairing public-key fingerprint does not match its key.");
        if (request.Mac is null || string.IsNullOrWhiteSpace(request.Mac.Name) || request.Mac.Name.Length > 128)
            throw new InvalidDataException("Pairing Mac metadata is invalid.");
    }

    public static string FingerprintPublicKey(string openSshPublicKey)
    {
        string[] fields = openSshPublicKey.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length != 2 || fields[0] != "ssh-ed25519") throw new InvalidDataException("Only a comment-free ssh-ed25519 public key is accepted.");
        byte[] wire;
        try { wire = Convert.FromBase64String(fields[1]); }
        catch (FormatException error) { throw new InvalidDataException("OpenSSH public key is invalid.", error); }
        if (wire.Length < 32) throw new InvalidDataException("OpenSSH public key is too short.");
        return "SHA256:" + Convert.ToBase64String(SHA256.HashData(wire)).TrimEnd('=');
    }

    public static string NewNonce() => Base64UrlEncode(RandomNumberGenerator.GetBytes(24));

    private static void ValidateWindow(DateTimeOffset created, DateTimeOffset expires, DateTimeOffset now)
    {
        if (expires <= created || expires - created > TimeToLive) throw new InvalidDataException("Pairing validity window is invalid.");
        if (created > now.AddMinutes(5)) throw new InvalidDataException("Pairing request was created too far in the future.");
        if (expires <= now) throw new InvalidDataException("Pairing request has expired.");
    }

    private static void ValidateResponse(PairingResponse response)
    {
        if (response.Kind != "response" || response.FormatVersion != 1) throw new InvalidDataException("Pairing response type or version is invalid.");
        if (response.ExpiresAt <= response.CreatedAt || response.ExpiresAt - response.CreatedAt > TimeToLive) throw new InvalidDataException("Pairing response validity window is invalid.");
        if (!NonceRegex().IsMatch(response.Nonce) || !NonceRegex().IsMatch(response.RequestNonce)) throw new InvalidDataException("Pairing response nonce is invalid.");
        if (response.Ssh.Addresses.Length is < 1 or > 32 || response.Ssh.Port is < 1 or > 65535) throw new InvalidDataException("Pairing SSH endpoint is invalid.");
    }

    private static string Base64UrlEncode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        if (!Base64UrlRegex().IsMatch(value)) throw new FormatException();
        string padded = value.Replace('-', '+').Replace('_', '/');
        padded += (padded.Length % 4) switch { 2 => "==", 3 => "=", 0 => "", _ => throw new FormatException() };
        return Convert.FromBase64String(padded);
    }

    private static string TrimPadding(string value) => value.TrimEnd('=');

    [GeneratedRegex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$", RegexOptions.CultureInvariant)]
    private static partial Regex NodeIdRegex();

    [GeneratedRegex("^[A-Za-z0-9_-]{22,256}$", RegexOptions.CultureInvariant)]
    private static partial Regex NonceRegex();

    [GeneratedRegex("^[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex Base64UrlRegex();
}
