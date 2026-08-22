$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not ((node --version) -match '^v24\.')) {
    throw "MiraBridge Windows tests require Node.js 24.x."
}

npm ci
npm run typecheck
npm run build:windows
node integration-tests/windows-local.mjs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
