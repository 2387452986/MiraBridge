using System.Text.RegularExpressions;

namespace MiraBridge.Windows.Core;

public static partial class ManagedSshConfiguration
{
    public const string BeginMarker = "# BEGIN MIRABRIDGE 2.0";
    public const string EndMarker = "# END MIRABRIDGE 2.0";

    public static string Apply(string existing, bool freshInstall, string user = "Administrator")
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(user);
        int begin = existing.IndexOf(BeginMarker, StringComparison.Ordinal);
        int end = existing.IndexOf(EndMarker, StringComparison.Ordinal);
        if ((begin >= 0) != (end >= 0) || (begin >= 0 && end < begin)) throw new InvalidDataException("Existing MiraBridge SSH managed block is incomplete; repair it manually before continuing.");
        string withoutManaged = existing;
        if (begin >= 0)
        {
            int after = end + EndMarker.Length;
            while (after < existing.Length && (existing[after] == '\r' || existing[after] == '\n')) after++;
            withoutManaged = existing.Remove(begin, after - begin).TrimEnd();
        }
        EnsureNoAccessConflict(withoutManaged, user);
        string block = freshInstall
            ? $"{BeginMarker}\r\nPubkeyAuthentication yes\r\nPasswordAuthentication no\r\nKbdInteractiveAuthentication no\r\nAuthenticationMethods publickey\r\nAuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys\r\n{EndMarker}"
            : $"{BeginMarker}\r\nMatch User {user}\r\n    PubkeyAuthentication yes\r\n    PasswordAuthentication no\r\n    KbdInteractiveAuthentication no\r\n    AuthenticationMethods publickey\r\n    AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys\r\n{EndMarker}";
        return withoutManaged.Length == 0 ? block + "\r\n" : withoutManaged + "\r\n\r\n" + block + "\r\n";
    }

    private static void EnsureNoAccessConflict(string config, string user)
    {
        foreach (string raw in config.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            Match deny = DenyUsersRegex().Match(line);
            if (deny.Success && deny.Groups[1].Value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Contains(user, StringComparer.OrdinalIgnoreCase))
                throw new InvalidDataException($"Existing sshd_config denies {user}; MiraBridge will not override it.");
            Match allow = AllowUsersRegex().Match(line);
            if (allow.Success && !allow.Groups[1].Value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Contains(user, StringComparer.OrdinalIgnoreCase))
                throw new InvalidDataException($"Existing sshd_config AllowUsers does not include {user}; update it explicitly before pairing.");
        }
    }

    [GeneratedRegex("^DenyUsers\\s+(.+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DenyUsersRegex();

    [GeneratedRegex("^AllowUsers\\s+(.+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex AllowUsersRegex();
}
