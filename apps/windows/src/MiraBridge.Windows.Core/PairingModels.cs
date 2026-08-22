using System.Text.Json.Serialization;

namespace MiraBridge.Windows.Core;

public sealed record PairingMac(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("architecture")] string Architecture,
    [property: JsonPropertyName("mirabridge_version")] string MiraBridgeVersion);

public sealed record PairingRequest(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("format_version")] int FormatVersion,
    [property: JsonPropertyName("created_at")] DateTimeOffset CreatedAt,
    [property: JsonPropertyName("expires_at")] DateTimeOffset ExpiresAt,
    [property: JsonPropertyName("nonce")] string Nonce,
    [property: JsonPropertyName("node_id")] string NodeId,
    [property: JsonPropertyName("public_key")] string PublicKey,
    [property: JsonPropertyName("public_key_fingerprint")] string PublicKeyFingerprint,
    [property: JsonPropertyName("mac")] PairingMac Mac);

public sealed record PairingWindows(
    [property: JsonPropertyName("hostname")] string Hostname,
    [property: JsonPropertyName("architecture")] string Architecture,
    [property: JsonPropertyName("user")] string User,
    [property: JsonPropertyName("mirabridge_version")] string MiraBridgeVersion);

public sealed record PairingSsh(
    [property: JsonPropertyName("addresses")] string[] Addresses,
    [property: JsonPropertyName("port")] int Port,
    [property: JsonPropertyName("host_fingerprint")] string HostFingerprint,
    [property: JsonPropertyName("host_key_algorithm")] string HostKeyAlgorithm);

public sealed record PairingResponse(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("format_version")] int FormatVersion,
    [property: JsonPropertyName("created_at")] DateTimeOffset CreatedAt,
    [property: JsonPropertyName("expires_at")] DateTimeOffset ExpiresAt,
    [property: JsonPropertyName("nonce")] string Nonce,
    [property: JsonPropertyName("request_nonce")] string RequestNonce,
    [property: JsonPropertyName("node_id")] string NodeId,
    [property: JsonPropertyName("public_key_fingerprint")] string PublicKeyFingerprint,
    [property: JsonPropertyName("windows")] PairingWindows Windows,
    [property: JsonPropertyName("ssh")] PairingSsh Ssh,
    [property: JsonPropertyName("worker_command")] string WorkerCommand,
    [property: JsonPropertyName("management_command")] string ManagementCommand,
    [property: JsonPropertyName("default_root")] string DefaultRoot,
    [property: JsonPropertyName("capabilities")] string[] Capabilities);

public sealed record PairingRecord(
    string NodeId,
    string MacName,
    string PublicKeyFingerprint,
    DateTimeOffset PairedAt);
