using System.Text.RegularExpressions;

namespace MiraBridge.Windows.Core;

public static partial class DiagnosticRedactor
{
    public static string Redact(string value)
    {
        string result = UserPathRegex().Replace(value, @"C:\Users\[REDACTED]");
        result = SecretRegex().Replace(result, "$1=[REDACTED]");
        result = AuthorizationRegex().Replace(result, "$1 [REDACTED]");
        result = PrivateKeyRegex().Replace(result, "[REDACTED PRIVATE KEY]");
        return result;
    }

    [GeneratedRegex(@"(?i)C:\\Users\\[^\\\r\n]+")]
    private static partial Regex UserPathRegex();

    [GeneratedRegex(@"(?im)^([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)|COOKIE)\s*=\s*.*$")]
    private static partial Regex SecretRegex();

    [GeneratedRegex(@"(?im)^(Authorization)\s+.*$")]
    private static partial Regex AuthorizationRegex();

    [GeneratedRegex(@"(?s)-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----.*?-----END (?:OPENSSH |RSA |EC )?PRIVATE KEY-----")]
    private static partial Regex PrivateKeyRegex();
}
