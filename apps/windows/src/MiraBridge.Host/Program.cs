using System.Diagnostics;
using MiraBridge.Windows.Core;

namespace MiraBridge.Host;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows())
        {
            await Console.Error.WriteLineAsync("MiraBridge.Host requires Windows.");
            return 64;
        }
        _ = WindowsHostInfo.Architecture;
        if (args.Length == 0 || (args[0] != "worker" && args[0] != "backup"))
        {
            await Console.Error.WriteLineAsync("Usage: MiraBridge.Host worker <mirabridge-worker arguments> | backup [DESTINATION]");
            return 64;
        }
        if (!File.Exists(AppPaths.NodeExecutable) || !File.Exists(AppPaths.WorkerEntry))
        {
            await Console.Error.WriteLineAsync("MiraBridge bundled Worker runtime is incomplete. Use Repair in MiraBridge for Windows.");
            return 69;
        }
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = AppPaths.NodeExecutable,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WorkingDirectory = AppPaths.InstallRoot
            }
        };
        if (args[0] == "worker")
        {
            process.StartInfo.ArgumentList.Add(AppPaths.WorkerEntry);
            foreach (string argument in args.Skip(1)) process.StartInfo.ArgumentList.Add(argument);
        }
        else
        {
            string backupScript = Path.Combine(AppPaths.RuntimeRoot, "scripts", "backup-worker-state.mjs");
            if (!File.Exists(backupScript))
            {
                await Console.Error.WriteLineAsync("MiraBridge backup script is missing. Use Repair before updating.");
                return 69;
            }
            process.StartInfo.ArgumentList.Add(backupScript);
            foreach (string argument in args.Skip(1)) process.StartInfo.ArgumentList.Add(argument);
        }
        if (!process.Start()) return 70;
        Task stdin = ForwardInputAsync(process);
        Task stdout = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        Task stderr = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        await process.WaitForExitAsync();
        await Task.WhenAll(stdout, stderr);
        _ = stdin.ContinueWith(static task => { _ = task.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
        return process.ExitCode;
    }

    private static async Task ForwardInputAsync(Process process)
    {
        try
        {
            await Console.OpenStandardInput().CopyToAsync(process.StandardInput.BaseStream);
            process.StandardInput.Close();
        }
        catch (IOException) when (process.HasExited) { }
        catch (ObjectDisposedException) when (process.HasExited) { }
    }
}
