namespace MiraBridge.Windows.Core;

public sealed class UpdateCheckPolicy
{
    public static readonly TimeSpan MinimumInterval = TimeSpan.FromDays(1);
    private readonly string _statePath;

    public UpdateCheckPolicy(string? statePath = null) => _statePath = statePath ?? Path.Combine(AppPaths.LocalDataRoot, "last-update-check.txt");

    public async Task<bool> CanCheckAsync(DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_statePath)) return true;
        string value = await File.ReadAllTextAsync(_statePath, cancellationToken);
        return !DateTimeOffset.TryParse(value, out DateTimeOffset previous) || now - previous >= MinimumInterval;
    }

    public Task RecordAsync(DateTimeOffset now, CancellationToken cancellationToken = default)
        => AtomicFile.WriteTextAsync(_statePath, now.ToString("O") + Environment.NewLine, backup: false, cancellationToken);
}
