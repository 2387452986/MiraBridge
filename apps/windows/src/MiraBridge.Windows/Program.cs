using System.Diagnostics;
using System.IO;
using System.Text.Json;
using MiraBridge.Windows.Core;
using Velopack;

namespace MiraBridge.Windows;

internal static class Program
{
    private const string ProductVersion = "2.0.0-rc.2";
    private const string UpdateMaintenanceOwner = "windows-app-update";
    private const string UninstallMaintenanceOwner = "windows-app-uninstall";
    private const string InstanceMutexName = @"Local\MiraBridge.Windows.Instance";
    private const string ActivationSignalName = @"Local\MiraBridge.Windows.Activate";

    [STAThread]
    public static void Main(string[] args)
    {
        bool startInTray = args.Contains("--tray", StringComparer.Ordinal);
        VelopackApp.Build().Run();

        using var instanceMutex = new Mutex(true, InstanceMutexName, out bool isPrimaryInstance);
        if (!isPrimaryInstance)
        {
            if (!startInTray) SignalPrimaryInstance();
            return;
        }
        using var activationSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ActivationSignalName);

        var recovery = new UpdateRecoveryStore();
        try
        {
            UpdateStartupAction action = recovery.ProcessStartupAsync(ProductVersion, VerifyHealthAsync, LaunchRollbackAsync).GetAwaiter().GetResult();
            if (action == UpdateStartupAction.ExitForRollback) return;
            ReleaseMaintenanceWhenHealthyAsync().GetAwaiter().GetResult();
        }
        catch (Exception error)
        {
            Directory.CreateDirectory(AppPaths.LocalDataRoot);
            string path = Path.Combine(AppPaths.LocalDataRoot, "update-recovery-startup-error.txt");
            File.WriteAllText(path, DiagnosticRedactor.Redact($"{DateTimeOffset.UtcNow:O}\n{error}\n"));
            System.Windows.MessageBox.Show(
                $"MiraBridge update recovery needs attention. The redacted error is stored at:\n{path}",
                "MiraBridge update recovery",
                System.Windows.MessageBoxButton.OK,
                System.Windows.MessageBoxImage.Error);
        }
        var application = new App(startInTray);
        application.InitializeComponent();
        using var activationStop = new CancellationTokenSource();
        var activationThread = new Thread(() => WaitForActivation(application, activationSignal, activationStop.Token))
        {
            IsBackground = true,
            Name = "MiraBridge activation listener"
        };
        activationThread.Start();
        application.Exit += (_, _) =>
        {
            activationStop.Cancel();
            activationSignal.Set();
        };
        application.Run();
        activationStop.Cancel();
        activationSignal.Set();
        if (activationThread.IsAlive) activationThread.Join(TimeSpan.FromSeconds(1));
    }

    private static void SignalPrimaryInstance()
    {
        for (int attempt = 0; attempt < 20; attempt++)
        {
            if (EventWaitHandle.TryOpenExisting(ActivationSignalName, out EventWaitHandle? activationSignal))
            {
                using (activationSignal) activationSignal.Set();
                return;
            }
            Thread.Sleep(50);
        }
    }

    private static void WaitForActivation(App application, EventWaitHandle activationSignal, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            activationSignal.WaitOne();
            if (cancellationToken.IsCancellationRequested) return;
            for (int attempt = 0; attempt < 100 && !cancellationToken.IsCancellationRequested; attempt++)
            {
                bool activated = false;
                try
                {
                    application.Dispatcher.Invoke(() =>
                    {
                        if (application.MainWindow is not MainWindow window) return;
                        window.ShowFromTray();
                        activated = true;
                    });
                }
                catch (InvalidOperationException) when (application.Dispatcher.HasShutdownStarted)
                {
                    return;
                }
                if (activated) break;
                Thread.Sleep(50);
            }
        }
    }

    private static async Task ReleaseMaintenanceWhenHealthyAsync()
    {
        var (ok, _) = await VerifyHealthAsync(CancellationToken.None);
        if (!ok) return;
        var worker = new WorkerCli();
        await worker.EndMaintenanceAsync(UpdateMaintenanceOwner);
        await worker.EndMaintenanceAsync(UninstallMaintenanceOwner);
    }

    private static async Task<(bool Ok, string? Error)> VerifyHealthAsync(CancellationToken cancellationToken)
    {
        try
        {
            using JsonDocument doctor = await new WorkerCli().DoctorAsync(cancellationToken);
            if (!doctor.RootElement.TryGetProperty("runtime_ready", out JsonElement ready) || !ready.GetBoolean())
                return (false, "Bundled Worker doctor did not report runtime_ready.");
            ProcessResult ssh = await ProcessRunner.RunAsync("sc.exe", ["query", "sshd"], TimeSpan.FromSeconds(15), cancellationToken);
            if (ssh.ExitCode != 0 || !ssh.Stdout.Contains("RUNNING", StringComparison.OrdinalIgnoreCase))
                return (false, "Windows OpenSSH service is not running after update.");
            return (true, null);
        }
        catch (Exception error)
        {
            return (false, DiagnosticRedactor.Redact(error.Message));
        }
    }

    private static async Task LaunchRollbackAsync(UpdateRecoveryReceipt receipt, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!File.Exists(AppPaths.UpdateExecutable)) throw new FileNotFoundException("Velopack Update.exe is missing; automatic rollback cannot start.", AppPaths.UpdateExecutable);
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = AppPaths.UpdateExecutable,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };
        process.StartInfo.ArgumentList.Add("apply");
        process.StartInfo.ArgumentList.Add("--package");
        process.StartInfo.ArgumentList.Add(receipt.PreviousPackage);
        process.StartInfo.ArgumentList.Add("--waitPid");
        process.StartInfo.ArgumentList.Add(Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        process.StartInfo.ArgumentList.Add("--");
        process.StartInfo.ArgumentList.Add("--tray");
        if (!process.Start()) throw new InvalidOperationException("Could not start the external MiraBridge rollback process.");
        await Task.CompletedTask;
    }
}
