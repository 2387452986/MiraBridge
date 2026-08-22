[CmdletBinding()]
param(
    [ValidateSet("win-x64", "win-arm64")]
    [string]$RuntimeIdentifier = "win-x64",
    [string]$Version = "2.0.0-rc.1",
    [switch]$SkipPackage
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:DOTNET_NOLOGO = "1"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Command,
        [Parameter(Mandatory = $true)][string]$Name
    )
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE." }
}
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ModuleRoot = Join-Path $RepoRoot "plugins\mira-bridge"
$WindowsRoot = Join-Path $RepoRoot "apps\windows"
$Artifacts = Join-Path $RepoRoot "artifacts\windows\$RuntimeIdentifier"
$Stage = Join-Path $Artifacts "app"
$HostOut = Join-Path $Artifacts "host"
$ElevatedOut = Join-Path $Artifacts "elevated"
$ConPtyOut = Join-Path $Artifacts "conpty-host"
$ReleaseDir = Join-Path $Artifacts "releases"
$NodeVersion = "24.19.0"
$NodeArch = if ($RuntimeIdentifier -eq "win-arm64") { "arm64" } else { "x64" }
$PackId = if ($RuntimeIdentifier -eq "win-arm64") { "MiraBridge.Windows.ARM64" } else { "MiraBridge.Windows" }
$NodeSha = if ($RuntimeIdentifier -eq "win-arm64") { "8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f" } else { "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73" }
$NodeArchive = Join-Path $Artifacts "node-v$NodeVersion-win-$NodeArch.zip"

if ([Environment]::Is64BitOperatingSystem -ne $true) { throw "32-bit x86 Windows is not supported." }
if ((node --version) -ne "v24.19.0") { throw "Build requires Node.js 24.19.0; found $(node --version)." }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw ".NET 10 SDK is required to build MiraBridge for Windows." }

New-Item -ItemType Directory -Force -Path $Artifacts | Out-Null
@($Stage, $HostOut, $ElevatedOut, $ConPtyOut, $ReleaseDir) | ForEach-Object {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $_
}
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

Push-Location $ModuleRoot
try {
    Invoke-Checked { npm ci } "npm ci"
    Invoke-Checked { npm run typecheck } "TypeScript typecheck"
    Invoke-Checked { npm test } "Vitest"
    Invoke-Checked { npm run build } "TypeScript bundle build"
    Invoke-Checked { npm run test:windows } "Windows Worker integration tests"
}
finally { Pop-Location }

Invoke-Checked { dotnet publish (Join-Path $WindowsRoot "src\MiraBridge.Windows\MiraBridge.Windows.csproj") -c Release -r $RuntimeIdentifier --self-contained true -o $Stage } "Windows app publish"
$AppExecutable = Join-Path $Stage "MiraBridge.Windows.exe"
$AppSmokeStarted = Get-Date
$AppSmoke = Start-Process -FilePath $AppExecutable -ArgumentList @("--tray") -PassThru
try {
    Start-Sleep -Seconds 8
    if ($AppSmoke.HasExited) { throw "MiraBridge for Windows startup smoke failed with exit code $($AppSmoke.ExitCode)." }
    $AppCrashes = @(Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $AppSmokeStarted } -ErrorAction SilentlyContinue | Where-Object {
        ($_.ProviderName -eq ".NET Runtime" -or $_.ProviderName -eq "Application Error") -and $_.Message -match "MiraBridge.Windows.exe"
    })
    if ($AppCrashes.Count -gt 0) { throw "MiraBridge for Windows startup smoke recorded $($AppCrashes.Count) application crash event(s)." }
}
finally {
    if (-not $AppSmoke.HasExited) {
        Stop-Process -Id $AppSmoke.Id -Force
        $AppSmoke.WaitForExit()
    }
}
Invoke-Checked { dotnet publish (Join-Path $WindowsRoot "src\MiraBridge.Host\MiraBridge.Host.csproj") -c Release -r $RuntimeIdentifier --self-contained true -o $HostOut } "stable Host publish"
Invoke-Checked { dotnet publish (Join-Path $WindowsRoot "src\MiraBridge.Elevated\MiraBridge.Elevated.csproj") -c Release -r $RuntimeIdentifier --self-contained true -o $ElevatedOut } "elevated helper publish"
Invoke-Checked { dotnet publish (Join-Path $ModuleRoot "packages\conpty-host\MiraBridge.ConPtyHost.csproj") -c Release -r $RuntimeIdentifier --self-contained true -o $ConPtyOut } "ConPTY helper publish"
Copy-Item (Join-Path $HostOut "MiraBridge.Host.exe") $Stage
Copy-Item (Join-Path $ElevatedOut "MiraBridge.Elevated.exe") $Stage

if (-not (Test-Path $NodeArchive) -or (Get-FileHash $NodeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeSha) {
    $Download = "$NodeArchive.download"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$NodeArch.zip" -OutFile $Download
    if ((Get-FileHash $Download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeSha) { throw "Bundled Node.js SHA-256 mismatch." }
    Move-Item -Force $Download $NodeArchive
}
$NodeExpand = Join-Path $Artifacts "node-expanded"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $NodeExpand
Expand-Archive $NodeArchive $NodeExpand
$NodeSource = Get-ChildItem $NodeExpand -Directory | Select-Object -First 1
$Runtime = Join-Path $Stage "runtime"
New-Item -ItemType Directory -Force -Path (Join-Path $Runtime "node"), (Join-Path $Runtime "worker\node_modules\@xterm"), (Join-Path $Runtime "worker\node_modules"), (Join-Path $Runtime "worker\conpty-host"), (Join-Path $Runtime "scripts") | Out-Null
Copy-Item (Join-Path $NodeSource.FullName "*") (Join-Path $Runtime "node") -Recurse -Force
Copy-Item (Join-Path $ModuleRoot "packages\windows-worker\dist\index.cjs") (Join-Path $Runtime "worker\index.cjs")
Copy-Item (Join-Path $ModuleRoot "node_modules\@xterm\headless") (Join-Path $Runtime "worker\node_modules\@xterm\headless") -Recurse -Force
Copy-Item (Join-Path $ModuleRoot "node_modules\playwright-core") (Join-Path $Runtime "worker\node_modules\playwright-core") -Recurse -Force
Copy-Item (Join-Path $ConPtyOut "*") (Join-Path $Runtime "worker\conpty-host") -Recurse -Force
Copy-Item (Join-Path $ModuleRoot "scripts\backup-worker-state.mjs") (Join-Path $Runtime "scripts\backup-worker-state.mjs")
Copy-Item (Join-Path $RepoRoot "LICENSE") $Stage
Copy-Item (Join-Path $RepoRoot "THIRD_PARTY_NOTICES.md") $Stage

Invoke-Checked { dotnet run --project (Join-Path $WindowsRoot "tests\MiraBridge.Windows.Tests\MiraBridge.Windows.Tests.csproj") -c Release -r $RuntimeIdentifier } "Windows client contract tests"
$PackagedWorkerVersion = (& (Join-Path $Stage "MiraBridge.Host.exe") worker --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $PackagedWorkerVersion -ne "mirabridge-worker $Version") {
    throw "Packaged Host stdio smoke failed: expected 'mirabridge-worker $Version', got '$PackagedWorkerVersion' (exit $LASTEXITCODE)."
}
Write-Output $PackagedWorkerVersion

if (-not $SkipPackage) {
    $Tools = Join-Path $Artifacts "tools"
    if (-not (Test-Path (Join-Path $Tools "vpk.exe"))) { Invoke-Checked { dotnet tool install vpk --tool-path $Tools --version 1.2.0 } "Velopack CLI installation" }
    New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
    # Keep the Velopack application root distinct from the Worker's stable
    # %LOCALAPPDATA%\MiraBridge data root. This is a data-ownership boundary.
    # GitHub Release asset names must be unique. ARM64 therefore uses a
    # RID-specific internal package id while both packages retain the same
    # user-facing title. Separate channels keep each installed app on its RID.
    Invoke-Checked { & (Join-Path $Tools "vpk.exe") pack --packId $PackId --packVersion $Version --packDir $Stage --mainExe "MiraBridge.Windows.exe" --packTitle "MiraBridge for Windows" --outputDir $ReleaseDir --icon (Join-Path $WindowsRoot "src\MiraBridge.Windows\Assets\mirabridge.ico") --runtime $RuntimeIdentifier --channel $RuntimeIdentifier --delta none } "Velopack package"
}

$ManifestPath = Join-Path $Artifacts "MiraBridge.Windows-$RuntimeIdentifier-$Version.sha256.json"
Remove-Item -Force -ErrorAction SilentlyContinue $ManifestPath
$ManifestFiles = if ($SkipPackage) { Get-ChildItem $Stage -Recurse -File } else { Get-ChildItem $ReleaseDir -File }
$ManifestJson = $ManifestFiles | Sort-Object FullName | ForEach-Object {
    [pscustomobject]@{ path = $_.FullName.Substring($RepoRoot.Length + 1); bytes = $_.Length; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
} | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($ManifestPath, $ManifestJson + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
