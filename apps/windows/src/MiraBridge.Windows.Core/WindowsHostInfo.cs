using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace MiraBridge.Windows.Core;

public static class WindowsHostInfo
{
    public static string Architecture => RuntimeInformation.OSArchitecture switch
    {
        System.Runtime.InteropServices.Architecture.X64 => "x64",
        System.Runtime.InteropServices.Architecture.Arm64 => "arm64",
        System.Runtime.InteropServices.Architecture.X86 => throw new PlatformNotSupportedException("32-bit x86 Windows is not supported. Install 64-bit Windows on x64 or ARM64 hardware."),
        _ => throw new PlatformNotSupportedException($"Unsupported Windows architecture: {RuntimeInformation.OSArchitecture}")
    };

    public static string[] AddressCandidates()
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(adapter => adapter.OperationalStatus == OperationalStatus.Up && adapter.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses)
            .Select(value => value.Address)
            .Where(address => address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(address) && !address.ToString().StartsWith("169.254.", StringComparison.Ordinal))
            .Select(address => address.ToString())
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
    }

    public static async Task<string> HostFingerprintAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(AppPaths.SshHostPublicKey)) throw new FileNotFoundException("OpenSSH Ed25519 host public key was not found.", AppPaths.SshHostPublicKey);
        string key = await File.ReadAllTextAsync(AppPaths.SshHostPublicKey, cancellationToken);
        string[] fields = key.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length < 2) throw new InvalidDataException("OpenSSH host public key is invalid.");
        return PairingCodec.FingerprintPublicKey($"{fields[0]} {fields[1]}");
    }
}
