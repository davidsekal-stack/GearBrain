[CmdletBinding()]
param(
  [string]$TaskName = 'DriveCodexDailyCoach',
  [string]$At = '04:00',          # after the 17:00–02:00 crawl window closes, before work hours (06:00)
  [string]$NodePath,
  [string]$LogDir,
  [switch]$RunNow
)

# Registers the once-daily post-night runner (recall watchdog + daily coach).
# Separate from DriveCodexAgentBatch (the 5-min crawl batch) because the coach must
# run AFTER the nightly crawl window (17:00–02:00) closes. Runs at 04:00 — after the
# crawl, before working hours (06:00). NOTE: the coach steps self-gate to a morning
# window (default 06:00 start); .env.local lowers TRIAGE_HOUR/PRECISION_AUDIT_HOUR/
# RECALL_AUDIT_HOUR/ALERT_AGENT_HOUR/RECAL_GUARDED_HOUR/COACH_HOUR to 4 so they run at 04:00.
# StartWhenAvailable so a machine asleep at 04:00 catches up on next wake.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Quote-TaskArg { param([string]$Value) return '"' + $Value.Replace('"', '\"') + '"' }

$runnerScript = (Resolve-Path (Join-Path $PSScriptRoot 'run-coach-batch.ps1')).Path
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Path
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$argParts = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Quote-TaskArg $runnerScript))
if ($NodePath) { $argParts += @('-NodePath', (Quote-TaskArg (Resolve-Path $NodePath -ErrorAction Stop).Path)) }
if ($LogDir)   { $argParts += @('-LogDir',  (Quote-TaskArg ([System.IO.Path]::GetFullPath($LogDir)))) }

$action = New-ScheduledTaskAction -Execute $powershellExe -Argument ($argParts -join ' ') -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At

# ExecutionTimeLimit 4h: the chain (watchdog → coach → auditor → alert → triage →
# recalibration) takes ~2h on a busy morning. The original 1h limit made the
# scheduler KILL it mid-chain every day (LastTaskResult 267014) — guarded
# recalibration silently never ran and triage finished as an orphaned process.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 10)

$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'DriveCodex daily coach + recall watchdog (post-night evaluation)' `
  -Force | Out-Null

if ($RunNow) { Start-ScheduledTask -TaskName $TaskName }

$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  TaskName = $TaskName
  User = $currentUser
  At = $At
  NextRunTime = $info.NextRunTime
  LastRunTime = $info.LastRunTime
  LastTaskResult = $info.LastTaskResult
}
