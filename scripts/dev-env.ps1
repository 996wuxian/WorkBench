# Workbench Tauri dev environment bootstrap (Windows).
# - Rust on D: (RUSTUP_HOME / CARGO_HOME)
# - MSVC from Visual Studio at X:\Visual-Studio\ide
# - Bypass broken system proxy for crates.io / rsproxy

$ErrorActionPreference = "Stop"

$env:RUSTUP_HOME = "D:\tools\rustup"
$env:CARGO_HOME  = "D:\tools\cargo"
$cargoBin = "D:\tools\cargo\bin"
if ($env:Path -notlike "*$cargoBin*") {
  $env:Path = "$cargoBin;$env:Path"
}

# Prefer direct / rsproxy; system ProxyEnable points at 127.0.0.1 which may break cargo.
$env:HTTP_PROXY = ""
$env:HTTPS_PROXY = ""
$env:http_proxy = ""
$env:https_proxy = ""
$env:ALL_PROXY = ""
$env:all_proxy = ""
$env:NO_PROXY = "*"
$env:no_proxy = "*"

$vcvarsCandidates = @(
  "X:\Visual-Studio\ide\VC\Auxiliary\Build\vcvarsall.bat",
  "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat",
  "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat",
  "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
)
$vcvars = $vcvarsCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vcvars) {
  Write-Error "vcvarsall.bat not found. Install VS C++ build tools."
}

$temp = [System.IO.Path]::GetTempFileName() + ".cmd"
@"
@echo off
call "$vcvars" x64 >nul
set
"@ | Set-Content -Path $temp -Encoding ASCII

cmd /c $temp | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') {
    $name = $matches[1]
    $val = $matches[2]
    if ($name -match '^[Pp]ath$') {
      $env:Path = "$cargoBin;$val"
    }
    elseif ($name -notmatch '^(HTTP|HTTPS|ALL|http|https|all)_?PROXY$') {
      Set-Item -Path "Env:$name" -Value $val -ErrorAction SilentlyContinue
    }
  }
}
Remove-Item $temp -Force -ErrorAction SilentlyContinue

# Re-assert proxy bypass after vcvars
$env:HTTP_PROXY = ""
$env:HTTPS_PROXY = ""
$env:NO_PROXY = "*"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Error "cargo not found. Expected $cargoBin\cargo.exe"
}
if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
  Write-Warning "link.exe not on PATH — MSVC env may be incomplete"
}

Write-Host "Workbench env ready:"
Write-Host "  rustc  $(& rustc --version)"
Write-Host "  cargo  $(& cargo --version)"
Write-Host "  link   $((Get-Command link.exe -ErrorAction SilentlyContinue).Source)"
Write-Host "  RUSTUP_HOME=$env:RUSTUP_HOME"
Write-Host "  CARGO_HOME=$env:CARGO_HOME"
