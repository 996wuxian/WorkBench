# Launch Workbench: pnpm tauri dev with MSVC + D: Rust env.
$root = Split-Path -Parent $PSScriptRoot
. "$PSScriptRoot\dev-env.ps1"
Set-Location $root
if (-not (Test-Path "$root\node_modules")) {
  Write-Host "node_modules missing — run: pnpm install (confirm with user if agent)"
  exit 1
}
$env:TAURI_CLI_WATCHER_IGNORE_FILENAME = ".taurignore"
if ($env:WORKBENCH_TAURI_WATCH -eq "1") {
  pnpm dev
} else {
  pnpm tauri dev --no-watch
}
