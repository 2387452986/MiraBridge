[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Setup,
    [Parameter(Mandatory = $true)][string]$Receipt,
    [switch]$AllowInstalledAppReplacement
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if (-not $AllowInstalledAppReplacement) {
    throw "This acceptance script replaces the installed MiraBridge app. Pass -AllowInstalledAppReplacement explicitly."
}

$Setup = [IO.Path]::GetFullPath($Setup)
$Receipt = [IO.Path]::GetFullPath($Receipt)
$PackageRootName = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq "Arm64") { "MiraBridge.Windows.ARM64" } else { "MiraBridge.Windows" }
$AppRoot = Join-Path $env:LOCALAPPDATA $PackageRootName
$Current = Join-Path $AppRoot "current"
$App = Join-Path $AppRoot "MiraBridge.Windows.exe"
$CurrentApp = Join-Path $Current "MiraBridge.Windows.exe"
$HostExe = Join-Path $Current "MiraBridge.Host.exe"
$Updater = Join-Path $AppRoot "Update.exe"
$DataRoot = Join-Path $env:LOCALAPPDATA "MiraBridge"
$Started = Get-Date
$Result = [ordered]@{
    ok = $false
    started_at = $Started.ToUniversalTime().ToString("O")
    setup = $Setup
    setup_bytes = 0
    setup_sha256 = $null
    uninstall_exit = $null
    install_exit = $null
    worker_version = $null
    runtime_ready = $false
    app_processes = 0
    duplicate_launches = 0
    immediate_window_activated = $false
    window_activated = $false
    new_crashes = 0
    data_preserved = $false
    error = $null
}

function Invoke-Process {
    param([string]$File, [string[]]$Arguments)
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -Wait
    return $process.ExitCode
}

function Get-CurrentAppProcesses {
    return @(Get-Process -Name "MiraBridge.Windows" -ErrorAction SilentlyContinue | Where-Object {
        try { [IO.Path]::GetFullPath($_.Path) -eq [IO.Path]::GetFullPath($CurrentApp) } catch { $false }
    })
}

try {
    if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) { throw "Setup does not exist: $Setup" }
    $SetupFile = Get-Item -LiteralPath $Setup
    $Result.setup_bytes = $SetupFile.Length
    $Result.setup_sha256 = (Get-FileHash -LiteralPath $Setup -Algorithm SHA256).Hash.ToLowerInvariant()

    if (Test-Path -LiteralPath $HostExe) {
        $JobsText = (& $HostExe worker jobs list | Out-String)
        if ($LASTEXITCODE -ne 0) { throw "Could not inspect active MiraBridge Jobs before app replacement." }
        $Jobs = $JobsText | ConvertFrom-Json
        $Active = @($Jobs | Where-Object executor_status -In @("queued", "starting", "running"))
        if ($Active.Count -gt 0) { throw "MiraBridge has $($Active.Count) active Job(s); installed-app replacement is deferred." }
    }

    Get-Process -Name "MiraBridge.Windows" -ErrorAction SilentlyContinue | Stop-Process -Force
    if (Test-Path -LiteralPath $Updater) {
        $Result.uninstall_exit = Invoke-Process $Updater @("uninstall", "--silent")
        if ($Result.uninstall_exit -ne 0) { throw "Velopack uninstall failed with exit code $($Result.uninstall_exit)." }
    } else {
        $Result.uninstall_exit = 0
    }
    Start-Sleep -Seconds 3

    $Result.install_exit = Invoke-Process $Setup @("--silent")
    if ($Result.install_exit -ne 0) { throw "Setup failed with exit code $($Result.install_exit)." }
    Start-Sleep -Seconds 3
    if (-not (Test-Path -LiteralPath $App) -or -not (Test-Path -LiteralPath $HostExe)) {
        throw "Installed MiraBridge app or stable Host is missing."
    }

    $Result.worker_version = (& $HostExe worker --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $Result.worker_version -ne "mirabridge-worker 2.0.0-rc.3") {
        throw "Installed stable Host returned an unexpected Worker version: $($Result.worker_version)"
    }
    $Doctor = (& $HostExe worker doctor | Out-String) | ConvertFrom-Json
    $Result.runtime_ready = [bool]$Doctor.runtime_ready
    if (-not $Result.runtime_ready) { throw "Installed Worker doctor did not report runtime_ready." }
    $Result.data_preserved = Test-Path -LiteralPath $DataRoot
    if (-not $Result.data_preserved) { throw "Durable Worker data root was not preserved." }

    Start-Process -FilePath $App -ArgumentList @("--tray") | Out-Null
    for ($Launch = 1; $Launch -le 5; $Launch++) {
        $Duplicate = Start-Process -FilePath $App -PassThru
        if (-not $Duplicate.WaitForExit(5000)) {
            Stop-Process -Id $Duplicate.Id -Force -ErrorAction SilentlyContinue
            throw "Installed MiraBridge duplicate launch $Launch did not exit within 5 seconds."
        }
        if ($Duplicate.ExitCode -ne 0) { throw "Installed MiraBridge duplicate launch $Launch exited with code $($Duplicate.ExitCode)." }
        $Result.duplicate_launches = $Launch
        if ($Launch -eq 1) {
            Start-Sleep -Seconds 8
            $ImmediateProcesses = Get-CurrentAppProcesses
            if ($ImmediateProcesses.Count -eq 1) {
                $ImmediateProcesses[0].Refresh()
                $Result.immediate_window_activated = $ImmediateProcesses[0].MainWindowHandle -ne 0
            }
            if (-not $Result.immediate_window_activated) { throw "The immediate duplicate launch did not activate the starting tray window." }
        }
    }
    $SettleDeadline = (Get-Date).AddSeconds(10)
    do {
        $AppProcesses = Get-CurrentAppProcesses
        if ($AppProcesses.Count -eq 1) { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $SettleDeadline)
    $Result.app_processes = $AppProcesses.Count
    if ($AppProcesses.Count -eq 1) {
        for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
            $AppProcesses[0].Refresh()
            if ($AppProcesses[0].MainWindowHandle -ne 0) { $Result.window_activated = $true; break }
            Start-Sleep -Milliseconds 250
        }
    }
    $Result.new_crashes = @(Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $Started } -ErrorAction SilentlyContinue | Where-Object {
        ($_.ProviderName -eq ".NET Runtime" -or $_.ProviderName -eq "Application Error") -and $_.Message -match "MiraBridge.Windows.exe"
    }).Count
    if ($Result.app_processes -ne 1 -or -not $Result.window_activated -or $Result.new_crashes -ne 0) {
        throw "Installed GUI lifecycle failed: processes=$($Result.app_processes), activated=$($Result.window_activated), crash_events=$($Result.new_crashes)."
    }
    $Result.ok = $true
}
catch {
    $Result.error = $_.Exception.Message
    throw
}
finally {
    $Result.finished_at = (Get-Date).ToUniversalTime().ToString("O")
    $Parent = Split-Path -Parent $Receipt
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
    [IO.File]::WriteAllText($Receipt, ($Result | ConvertTo-Json -Depth 5) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
