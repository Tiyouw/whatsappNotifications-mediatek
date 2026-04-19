$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Host "ERROR: Please run PowerShell as Administrator (required to install/start Windows services)." -ForegroundColor Red
  exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$serviceName = "wa-reminder-bot"
$displayName = "WA Reminder Bot"

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
  Write-Host "Install it with: winget install --id NSSM.NSSM -e --scope user --silent --accept-package-agreements --accept-source-agreements"
  exit 1
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$appDirectory = $root
$appParameters = "index.js"

$logsDir = Join-Path $root "logs"
$stdoutLog = Join-Path $logsDir "out.log"
$stderrLog = Join-Path $logsDir "err.log"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $existing) {
  & $nssm install $serviceName $nodePath | Out-Null
}

& $nssm set $serviceName DisplayName $displayName | Out-Null
& $nssm set $serviceName AppDirectory $appDirectory | Out-Null
& $nssm set $serviceName Application $nodePath | Out-Null
& $nssm set $serviceName AppParameters $appParameters | Out-Null

# Logs
& $nssm set $serviceName AppStdout $stdoutLog | Out-Null
& $nssm set $serviceName AppStderr $stderrLog | Out-Null

# Rotate logs (10MB, daily)
& $nssm set $serviceName AppRotateFiles 1 | Out-Null
& $nssm set $serviceName AppRotateOnline 1 | Out-Null
& $nssm set $serviceName AppRotateBytes 10485760 | Out-Null
& $nssm set $serviceName AppRotateSeconds 86400 | Out-Null

# Restart node process if it exits unexpectedly
& $nssm set $serviceName AppExit Default Restart | Out-Null

# Auto-start on boot
& $nssm set $serviceName Start SERVICE_AUTO_START | Out-Null

# Service metadata + recovery (Windows-level)
sc.exe description $serviceName "WhatsApp reminder bot (Baileys). Runs node index.js from $appDirectory" | Out-Null
sc.exe failure $serviceName reset= 0 actions= restart/5000/restart/5000/restart/5000 | Out-Null
sc.exe failureflag $serviceName 1 | Out-Null

# Start (or restart) service
try { & $nssm stop $serviceName | Out-Null } catch {}
& $nssm start $serviceName | Out-Null

Start-Sleep -Seconds 1
Get-Service -Name $serviceName | Format-Table -AutoSize Status,Name,DisplayName
Write-Host "Logs:" -ForegroundColor Cyan
Write-Host "  $stdoutLog"
Write-Host "  $stderrLog"
