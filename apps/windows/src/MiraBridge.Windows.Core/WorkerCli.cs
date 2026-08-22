using System.Text.Json;

namespace MiraBridge.Windows.Core;

public sealed class WorkerCli
{
    private readonly string _hostExecutable;

    public WorkerCli(string? hostExecutable = null) => _hostExecutable = hostExecutable ?? AppPaths.HostExecutable;

    public async Task<JsonDocument> RunJsonAsync(IEnumerable<string> arguments, CancellationToken cancellationToken = default)
    {
        var values = new List<string> { "worker" };
        values.AddRange(arguments);
        ProcessResult result = await ProcessRunner.RunAsync(_hostExecutable, values, TimeSpan.FromMinutes(2), cancellationToken);
        result.EnsureSuccess("MiraBridge Worker CLI");
        try { return JsonDocument.Parse(result.Stdout); }
        catch (JsonException error) { throw new InvalidDataException("Worker CLI returned invalid JSON.", error); }
    }

    public Task<JsonDocument> DoctorAsync(CancellationToken cancellationToken = default) => RunJsonAsync(["doctor"], cancellationToken);
    public Task<JsonDocument> ConfigShowAsync(CancellationToken cancellationToken = default) => RunJsonAsync(["config", "show"], cancellationToken);
    public Task<JsonDocument> JobsListAsync(CancellationToken cancellationToken = default) => RunJsonAsync(["jobs", "list"], cancellationToken);
    public Task<JsonDocument> ConfigInitAsync(string root, CancellationToken cancellationToken = default) => RunJsonAsync(["config", "init", root], cancellationToken);
    public Task<JsonDocument> AddRootAsync(string root, CancellationToken cancellationToken = default) => RunJsonAsync(["config", "add-root", root], cancellationToken);
    public Task<JsonDocument> RemoveRootAsync(string root, CancellationToken cancellationToken = default) => RunJsonAsync(["config", "remove-root", root], cancellationToken);
    public Task<JsonDocument> SetCapabilityAsync(string name, string value, CancellationToken cancellationToken = default) => RunJsonAsync(["config", "set-capability", name, value], cancellationToken);
    public Task<JsonDocument> BeginMaintenanceAsync(string owner, string reason, int leaseMs, CancellationToken cancellationToken = default) => RunJsonAsync(["maintenance", "begin", owner, reason, leaseMs.ToString(System.Globalization.CultureInfo.InvariantCulture)], cancellationToken);
    public Task<JsonDocument> EndMaintenanceAsync(string owner, CancellationToken cancellationToken = default) => RunJsonAsync(["maintenance", "end", owner], cancellationToken);
    public Task<JsonDocument> MaintenanceStatusAsync(CancellationToken cancellationToken = default) => RunJsonAsync(["maintenance", "status"], cancellationToken);
}
