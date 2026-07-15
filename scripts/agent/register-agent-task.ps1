[CmdletBinding()]
param(
  [string]$TaskName = 'DriveCodexAgentBatch',
  [int]$IntervalMinutes = 5,
  [int]$BatchSize = 5,
  [int]$SleepMs = 600,
  [string]$Phase,
  [string]$NodePath,
  [string]$LogDir,
  [switch]$RunNow,
  # Night-only mode: run only inside a nightly window so the crawler never
  # competes with the owner's daytime Claude subscription usage. When set, the
  # task fires daily at -NightlyStart and repeats every -IntervalMinutes for
  # -NightlyWindowHours, instead of running 24/7.
  # Default window 17:00–24:00 local (shortened 2026-07-15 to cut token spend): keeps the
  # DeepSeek-billed verify step in DeepSeek OFF-PEAK hours (peak = 01–04 & 06–10 UTC) year-round
  # AND outside working hours 06–17.
  # Keep -NightlyStart/-NightlyWindowHours in sync with run-agent-batch.ps1 NightStart/EndHour.
  [switch]$Nightly,
  [string]$NightlyStart = '17:00',
  [int]$NightlyWindowHours = 7
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Quote-TaskArg {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runnerScript = (Resolve-Path (Join-Path $PSScriptRoot 'run-agent-batch.ps1')).Path
$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Path
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$argParts = @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  (Quote-TaskArg $runnerScript),
  '-BatchSize',
  [string]$BatchSize,
  '-SleepMs',
  [string]$SleepMs
)

if ($Phase) {
  $argParts += @('-Phase', (Quote-TaskArg $Phase))
}

if ($NodePath) {
  $resolvedNode = (Resolve-Path $NodePath -ErrorAction Stop).Path
  $argParts += @('-NodePath', (Quote-TaskArg $resolvedNode))
}

if ($LogDir) {
  $resolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)
  $argParts += @('-LogDir', (Quote-TaskArg $resolvedLogDir))
}

$action = New-ScheduledTaskAction `
  -Execute $powershellExe `
  -Argument ($argParts -join ' ') `
  -WorkingDirectory $repoRoot

$repeat = New-TimeSpan -Minutes $IntervalMinutes

if ($Nightly) {
  # Daily trigger at NightlyStart, repeating every IntervalMinutes for the
  # window duration. Daily triggers don't take -RepetitionInterval directly, so
  # borrow the Repetition object from a -Once trigger (documented pattern).
  $windowDuration = New-TimeSpan -Hours $NightlyWindowHours
  $nightlyTrigger = New-ScheduledTaskTrigger -Daily -At $NightlyStart
  $repTemplate = New-ScheduledTaskTrigger `
    -Once `
    -At $NightlyStart `
    -RepetitionInterval $repeat `
    -RepetitionDuration $windowDuration
  $nightlyTrigger.Repetition = $repTemplate.Repetition
  $triggers = @($nightlyTrigger)
} else {
  # 24/7: start in a minute, repeat indefinitely; also kick off at logon.
  $startAt = (Get-Date).AddMinutes(1)
  $repeatDuration = New-TimeSpan -Days 3650
  $onceTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At $startAt `
    -RepetitionInterval $repeat `
    -RepetitionDuration $repeatDuration
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $triggers = @($onceTrigger, $logonTrigger)
}

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Principal $principal `
  -Description 'DriveCodex autonomous crawl agent batch runner' `
  -Force | Out-Null

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
}

$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  TaskName = $TaskName
  User = $currentUser
  Mode = if ($Nightly) { "nightly ($NightlyStart, ${NightlyWindowHours}h window)" } else { '24/7' }
  NextRunTime = $info.NextRunTime
  LastRunTime = $info.LastRunTime
  LastTaskResult = $info.LastTaskResult
  IntervalMinutes = $IntervalMinutes
  BatchSize = $BatchSize
  SleepMs = $SleepMs
  Phase = $Phase
}
