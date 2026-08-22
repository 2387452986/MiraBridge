using System.Diagnostics;
using System.Text;

namespace MiraBridge.Windows.Core;

public sealed record ProcessResult(int ExitCode, string Stdout, string Stderr)
{
    public void EnsureSuccess(string operation)
    {
        if (ExitCode != 0) throw new InvalidOperationException($"{operation} failed with exit code {ExitCode}: {Stderr.Trim()}");
    }
}

public static class ProcessRunner
{
    public static async Task<ProcessResult> RunAsync(string fileName, IEnumerable<string> arguments, TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false)
            }
        };
        foreach (string argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        if (!process.Start()) throw new InvalidOperationException($"Could not start {fileName}.");
        Task<string> stdout = process.StandardOutput.ReadToEndAsync(cancellationToken);
        Task<string> stderr = process.StandardError.ReadToEndAsync(cancellationToken);
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        try { await process.WaitForExitAsync(timeoutSource.Token); }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            throw new TimeoutException($"{fileName} did not finish within {timeout}.");
        }
        return new ProcessResult(process.ExitCode, await stdout, await stderr);
    }
}
