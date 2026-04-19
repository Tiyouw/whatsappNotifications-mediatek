$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Host "ERROR: Please run PowerShell as Administrator (required to remove Windows services)." -ForegroundColor Red
  exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$serviceName = "wa-reminder-bot"
function Resolve-NssmPath([string] $projectRoot) {
  $local = Join-Path $projectRoot "tools\nssm\nssm.exe"
  if (Test-Path -LiteralPath $local) { return $local }

  $cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path -LiteralPath $wingetPackages) {
    $candidate = Get-ChildItem -LiteralPath $wingetPackages -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match "\\\\win64\\\\nssm\\.exe$" } |
      Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
  }

  return $null
}

$nssm = Resolve-NssmPath -projectRoot $root
if (-not $nssm) {
  Write-Host "ERROR: NSSM not found." -ForegroundColor Red
  exit 1
}

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Host "Service '$serviceName' is not installed."
  exit 0
}

try { & $nssm stop $serviceName | Out-Null } catch {}
& $nssm remove $serviceName confirm | Out-Null
Write-Host "Removed service '$serviceName'."
