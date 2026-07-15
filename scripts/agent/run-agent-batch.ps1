[CmdletBinding()]
param(
  [int]$BatchSize = 5,
  [int]$SleepMs = 600,
  [string]$Phase,
  [string]$NodePath,
  [string]$LogDir,
  # Night crawl window bounds (LOCAL time) — keep in sync with the trigger registered by
  # register-agent-task.ps1 (-Nightly). Used only to compute the orchestrator's
  # clean-stop deadline; runs started OUTSIDE the window get no deadline.
  # Window = 17:00–24:00 local (shortened 2026-07-15 to cut token spend): the DeepSeek-billed step
  # (verify.mjs) still runs in DeepSeek OFF-PEAK hours (peak = 01–04 & 06–10 UTC) in BOTH CET and
  # CEST, AND entirely outside the owner's working hours 06:00–17:00. (17:00–24:00 local → 15:00–
  # 22:00 UTC in summer / 16:00–23:00 UTC in winter, both clear of the peak bands.)
  # NightEndHour=0 means the window ends at midnight and does NOT wrap into the next day.
  [int]$NightStartHour = 17,
  [int]$NightEndHour = 0,
  [int]$DeadlineMarginMinutes = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Resolve-NodeExe {
  param(
    [string]$RequestedNodePath,
    [string]$RepoRoot
  )

  if ($RequestedNodePath) {
    $resolved = Resolve-Path $RequestedNodePath -ErrorAction Stop
    return $resolved.Path
  }

  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Path
  }

  $fallback = Join-Path $RepoRoot '.tools\node-v22.22.1-win-x64\node.exe'
  if (Test-Path $fallback) {
    return (Resolve-Path $fallback).Path
  }

  throw 'Could not resolve node.exe. Pass -NodePath explicitly.'
}

function New-MutexName {
  param([string]$RepoRoot)

  $md5 = [System.Security.Cryptography.MD5]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($RepoRoot.ToLowerInvariant())
    $hash = [System.BitConverter]::ToString($md5.ComputeHash($bytes)).Replace('-', '')
    return "Local\DriveCodexAgentBatch_$hash"
  } finally {
    $md5.Dispose()
  }
}

function Write-LogLine {
  param(
    [string]$Path,
    [string]$Message
  )

  Add-Content -Path $Path -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
}

# Load KEY=VALUE secrets from .env.local into the process environment so child
# node runs (registry sync, import, verify) get them. Never logs values.
# Existing environment variables win, so a user/system env override is honored.
function Import-DotEnv {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return 0 }
  $count = 0
  foreach ($line in (Get-Content $Path -ErrorAction SilentlyContinue)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $eq = $trimmed.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $trimmed.Substring(0, $eq).Trim()
    $val = $trimmed.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if (-not $key) { continue }
    if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($key, 'Process'))) {
      Set-Item -Path ("Env:{0}" -f $key) -Value $val
      $count++
    }
  }
  return $count
}

# Read the first line of a state file, returning $null on any problem (missing,
# empty, or a TOCTOU delete/rewrite by a concurrent orchestrator). Never throws,
# so $ErrorActionPreference='Stop' cannot abort the run on a transient read.
function Read-FirstLineSafe {
  param([string]$Path)
  try {
    if (-not (Test-Path $Path)) { return $null }
    $line = Get-Content $Path -TotalCount 1 -ErrorAction Stop
    if ($line) { return $line.Trim() }
    return $null
  } catch {
    return $null
  }
}

$repoRoot = Resolve-RepoRoot
$agentDir = (Resolve-Path $PSScriptRoot).Path
$nodeExe = Resolve-NodeExe -RequestedNodePath $NodePath -RepoRoot $repoRoot
$logRoot = if ($LogDir) { $LogDir } else { Join-Path $agentDir 'logs' }
$null = New-Item -ItemType Directory -Path $logRoot -Force
$logPath = Join-Path $logRoot ("agent-batch-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

$mutexName = New-MutexName -RepoRoot $repoRoot
$mutex = [System.Threading.Mutex]::new($false, $mutexName)
$lockTaken = $false

try {
  try {
    $lockTaken = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $lockTaken = $true
  }

  if (-not $lockTaken) {
    Write-LogLine -Path $logPath -Message "Skip: another batch run is already active."
    exit 0
  }

  Set-Location $repoRoot

  # Load local secrets (Supabase service key / DB password / DeepSeek key) so
  # the agent operates Supabase autonomously. Git-ignored; values never logged.
  $loaded = Import-DotEnv -Path (Join-Path $agentDir '.env.local')
  if ($loaded -gt 0) { Write-LogLine -Path $logPath -Message ("Loaded {0} secret(s) from .env.local." -f $loaded) }

  # ── Step 0: usage-limit pause gate + stall alarm ──
  # The orchestrator writes pause-until.txt when an AI usage limit is hit
  # (subscription limits reset on their own) and last-success.txt after every
  # clean full run. While paused, scheduled runs are ~free no-ops. The Desktop
  # marker is dropped when the last clean run was >24h ago AND it is >6h past
  # any promised reset, or unconditionally after >9 days (renewing hourly
  # pauses must not suppress the alarm forever); it is removed once runs
  # succeed again.
  $pauseFile = Join-Path $agentDir 'pause-until.txt'
  $lastSuccessFile = Join-Path $agentDir 'last-success.txt'
  $firstRunFile = Join-Path $agentDir 'first-run.txt'
  # Empty when the profile/known folder is unavailable (e.g. S4U logon) —
  # the alarm is then disabled, but it must never abort the main job
  $desktopDir = [Environment]::GetFolderPath('Desktop')
  $stallMarker = $null
  if ($desktopDir) {
    $stallMarker = Join-Path $desktopDir 'DRIVECODEX-CRAWLER-STOJI-PRECTI-ME.txt'
  }

  $pauseUntil = $null
  $pauseRaw = Read-FirstLineSafe -Path $pauseFile
  if ($pauseRaw) {
    $parsedPause = [datetimeoffset]::MinValue
    if ([datetimeoffset]::TryParse($pauseRaw, [ref]$parsedPause)) {
      $pauseUntil = $parsedPause
    }
  }

  # Stall anchor: last clean run, or first time this wrapper ever ran (so a
  # deployment that has NEVER succeeded still raises the alarm eventually).
  # Treat an unreadable/empty first-run.txt the same as missing — rewrite it —
  # so a 0-byte file (e.g. an interrupted earlier write) can't permanently
  # disable the never-succeeded alarm.
  $anchorRaw = Read-FirstLineSafe -Path $lastSuccessFile
  if (-not $anchorRaw) {
    $anchorRaw = Read-FirstLineSafe -Path $firstRunFile
    if (-not $anchorRaw) {
      $anchorRaw = [datetimeoffset]::UtcNow.ToString('o')
      try { Set-Content -Path $firstRunFile -Value $anchorRaw -Encoding utf8 } catch { }
    }
  }

  if ($stallMarker -and $anchorRaw) {
    $anchorTime = [datetimeoffset]::MinValue
    if ([datetimeoffset]::TryParse($anchorRaw, [ref]$anchorTime)) {
      $hoursSinceSuccess = ([datetimeoffset]::UtcNow - $anchorTime.ToUniversalTime()).TotalHours
      $pastPauseGrace = $true
      if ($pauseUntil) {
        $pastPauseGrace = [datetimeoffset]::UtcNow -gt $pauseUntil.ToUniversalTime().AddHours(6)
      }
      # Hard ceiling: a single legitimate pause is clamped to 8 days in the
      # orchestrator, so >9 days without success is a stall even if fresh
      # pause files keep appearing (e.g. drained DeepSeek balance every hour).
      if ((($hoursSinceSuccess -gt 24) -and $pastPauseGrace) -or ($hoursSinceSuccess -gt 216)) {
        if (-not (Test-Path $stallMarker)) {
          $markerText = @"
DriveCodex crawler se zastavil a nepodarilo se mu obnovit provoz.

Posledni uspesny beh: $anchorRaw
Zkontrolovano: $((Get-Date).ToString('yyyy-MM-dd HH:mm'))

Co s tim:
  1. Otevrete Claude Code v projektu C:\GB
  2. Napiste: "zkontroluj crawler"

Tento soubor zmizi sam, jakmile crawler zase pobezi.
(Vytvoril: scripts\agent\run-agent-batch.ps1)
"@
          try {
            Set-Content -Path $stallMarker -Value $markerText -Encoding utf8
            Write-LogLine -Path $logPath -Message ("ALARM: stalled since {0}; desktop marker created." -f $anchorRaw)
          } catch {
            Write-LogLine -Path $logPath -Message ("WARN: could not write desktop marker ({0})." -f $_.Exception.Message)
          }
        }
      } elseif ($hoursSinceSuccess -le 24) {
        if (Test-Path $stallMarker) {
          Remove-Item $stallMarker -Force -ErrorAction SilentlyContinue
          Write-LogLine -Path $logPath -Message "Recovered: desktop stall marker removed."
        }
      }
    }
  }

  if ($pauseUntil -and ([datetimeoffset]::UtcNow -lt $pauseUntil.ToUniversalTime())) {
    Write-LogLine -Path $logPath -Message ("Skip: paused until {0} (AI usage limit)." -f $pauseUntil.ToString('u'))
    exit 0
  }

  # ── Step 0b: night-window deadline ──
  # Task Scheduler's StopAtDurationEnd kills only THIS wrapper at the window end
  # (06:00); the node orchestrator survived it and kept crawling unsupervised
  # (e.g. run 1477 finished 06:46, overlapping the 06:20 coach on the same
  # agent.db). Give the orchestrator an explicit deadline (window end minus a
  # margin) via AGENT_DEADLINE_EPOCH_MS so it stops cleanly by itself, and do
  # not even start a new run inside the margin.
  $nowLocal = Get-Date
  $windowEnd = $null
  if ($nowLocal.Hour -ge $NightStartHour) { $windowEnd = $nowLocal.Date.AddDays(1).AddHours($NightEndHour) }
  elseif ($nowLocal.Hour -lt $NightEndHour) { $windowEnd = $nowLocal.Date.AddHours($NightEndHour) }
  if ($windowEnd) {
    $deadline = $windowEnd.AddMinutes(-$DeadlineMarginMinutes)
    if ($nowLocal -ge $deadline) {
      Write-LogLine -Path $logPath -Message ("Skip: inside the end-of-window margin ({0} - {1}); not starting a new run." -f $deadline.ToString('HH:mm'), $windowEnd.ToString('HH:mm'))
      exit 0
    }
    $env:AGENT_DEADLINE_EPOCH_MS = [string]([datetimeoffset]$deadline).ToUnixTimeMilliseconds()
    Write-LogLine -Path $logPath -Message ("Run deadline: {0} (window ends {1})." -f $deadline.ToString('HH:mm'), $windowEnd.ToString('HH:mm'))
  }

  # ── Step 1: refresh the cross-source "already-extracted" index from the DB (NON-FATAL) ──
  # Keeps crawled-index.json current so the orchestrator skips anything already extracted
  # (by this agent, the legacy forum-seed scripts, or NHTSA) since the last batch.
  # A failure here must NOT abort the crawl: log a warning and proceed on the existing snapshot.
  $indexBuilder = Join-Path $agentDir 'build-crawled-index.mjs'
  Write-LogLine -Path $logPath -Message "Refreshing crawled-index from DB..."
  $idxOut = [System.IO.Path]::GetTempFileName()
  $idxErr = [System.IO.Path]::GetTempFileName()
  try {
    $idxProc = Start-Process `
      -FilePath $nodeExe `
      -ArgumentList @($indexBuilder) `
      -WorkingDirectory $repoRoot `
      -NoNewWindow `
      -Wait `
      -PassThru `
      -RedirectStandardOutput $idxOut `
      -RedirectStandardError $idxErr

    foreach ($idxStream in @($idxOut, $idxErr)) {
      if (-not (Test-Path $idxStream)) { continue }
      $idxContent = Get-Content $idxStream -Raw
      if ([string]::IsNullOrWhiteSpace($idxContent)) { continue }
      Add-Content -Path $logPath -Value $idxContent.TrimEnd("`r", "`n")
    }

    if ([int]$idxProc.ExitCode -ne 0) {
      Write-LogLine -Path $logPath -Message ("WARN: index refresh exit_code={0}; proceeding with existing snapshot." -f $idxProc.ExitCode)
    }
  } catch {
    Write-LogLine -Path $logPath -Message ("WARN: index refresh failed ({0}); proceeding with existing snapshot." -f $_.Exception.Message)
  } finally {
    Remove-Item $idxOut, $idxErr -ErrorAction SilentlyContinue
  }

  $orchestrator = Join-Path $agentDir 'orchestrator.mjs'
  $args = @(
    '--experimental-sqlite',
    $orchestrator,
    '--batch-size',
    [string]$BatchSize,
    '--sleep-ms',
    [string]$SleepMs
  )

  if ($Phase) {
    $args += @('--phase', $Phase)
  }

  Write-LogLine -Path $logPath -Message ("START node={0} args={1}" -f $nodeExe, ($args -join ' '))

  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()

  try {
    $process = Start-Process `
      -FilePath $nodeExe `
      -ArgumentList $args `
      -WorkingDirectory $repoRoot `
      -NoNewWindow `
      -Wait `
      -PassThru `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath

    foreach ($streamPath in @($stdoutPath, $stderrPath)) {
      if (-not (Test-Path $streamPath)) { continue }
      $content = Get-Content $streamPath -Raw
      if ([string]::IsNullOrWhiteSpace($content)) { continue }
      Add-Content -Path $logPath -Value $content.TrimEnd("`r", "`n")
      Write-Output $content.TrimEnd("`r", "`n")
    }

    $exitCode = [int]$process.ExitCode
  }
  finally {
    Remove-Item $stdoutPath, $stderrPath -ErrorAction SilentlyContinue
  }

  # Po quota/auth stopu (exit 75/76) je předplatné vyčerpané — nepálit další dva
  # Claude-heavy sweepy proti mrtvé kvótě. A po deadlinu okna je nespouštět taky
  # (běžely by za 06:00 do ranní coach dávky).
  $skipPostSteps = ($exitCode -eq 75) -or ($exitCode -eq 76)
  if (-not $skipPostSteps -and $env:AGENT_DEADLINE_EPOCH_MS) {
    if ([datetimeoffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$env:AGENT_DEADLINE_EPOCH_MS) { $skipPostSteps = $true }
  }
  if ($skipPostSteps) {
    Write-LogLine -Path $logPath -Message "Skipping post-crawl sweeps (quota/auth stop or window deadline)."
  }

  # ── Step 2: zatřídění nově schválených případů do číselníku závad (NON-FATAL) ──
  # Doplní canonical_fault_id u approved případů, které ho nemají (push-case
  # klasifikuje jen "na měkko" a importy se skip_translation ji přeskakují).
  # Tím se panel "Známé závady tohoto vozu" drží aktuální. Resumovatelné
  # (--classify bere jen NULL případy), --max ohraničí délku jednoho běhu.
  # Selhání NESMÍ ovlivnit výsledek crawl běhu — jen se zaloguje.
  $faultTaxonomy = Join-Path $agentDir 'fault-taxonomy.mjs'
  if ((-not $skipPostSteps) -and (Test-Path $faultTaxonomy)) {
    Write-LogLine -Path $logPath -Message "Classifying newly approved cases into fault taxonomy..."
    $clsOut = [System.IO.Path]::GetTempFileName()
    $clsErr = [System.IO.Path]::GetTempFileName()
    try {
      $clsProc = Start-Process `
        -FilePath $nodeExe `
        -ArgumentList @($faultTaxonomy, '--classify', '--max', '1000') `
        -WorkingDirectory $repoRoot `
        -NoNewWindow `
        -Wait `
        -PassThru `
        -RedirectStandardOutput $clsOut `
        -RedirectStandardError $clsErr

      foreach ($clsStream in @($clsOut, $clsErr)) {
        if (-not (Test-Path $clsStream)) { continue }
        $clsContent = Get-Content $clsStream -Raw
        if ([string]::IsNullOrWhiteSpace($clsContent)) { continue }
        Add-Content -Path $logPath -Value $clsContent.TrimEnd("`r", "`n")
      }
      Write-LogLine -Path $logPath -Message ("Fault classification sweep exit_code={0}." -f [int]$clsProc.ExitCode)
    } catch {
      Write-LogLine -Path $logPath -Message ("WARN: fault classification sweep failed ({0}); ignoring." -f $_.Exception.Message)
    } finally {
      Remove-Item $clsOut, $clsErr -ErrorAction SilentlyContinue
    }
  }

  # ── Step 3: doplnění lokalizovaných textů oprav (NON-FATAL) ──
  # Přeloží resolution do CZ/DE u approved případů, kde resolution_lang IS NULL
  # (migrace 022). Záměrně přes Claude (router task `translate`), ne DeepSeek —
  # využívá předplatné jako fault-classify sweep. Tím se panel „Známé závady"
  # zobrazuje v jazyce aplikace. Resumovatelné, --max ohraničí délku běhu.
  # Selhání NESMÍ ovlivnit výsledek crawl běhu — jen se zaloguje.
  $resI18n = Join-Path $agentDir 'backfill-resolution-i18n.mjs'
  if ((-not $skipPostSteps) -and (Test-Path $resI18n)) {
    Write-LogLine -Path $logPath -Message "Backfilling localized resolution texts (cs/de)..."
    $i18nOut = [System.IO.Path]::GetTempFileName()
    $i18nErr = [System.IO.Path]::GetTempFileName()
    try {
      $i18nProc = Start-Process `
        -FilePath $nodeExe `
        -ArgumentList @($resI18n, '--batch', '15', '--max', '500') `
        -WorkingDirectory $repoRoot `
        -NoNewWindow `
        -Wait `
        -PassThru `
        -RedirectStandardOutput $i18nOut `
        -RedirectStandardError $i18nErr

      foreach ($i18nStream in @($i18nOut, $i18nErr)) {
        if (-not (Test-Path $i18nStream)) { continue }
        $i18nContent = Get-Content $i18nStream -Raw
        if ([string]::IsNullOrWhiteSpace($i18nContent)) { continue }
        Add-Content -Path $logPath -Value $i18nContent.TrimEnd("`r", "`n")
      }
      Write-LogLine -Path $logPath -Message ("Resolution i18n backfill exit_code={0}." -f [int]$i18nProc.ExitCode)
    } catch {
      Write-LogLine -Path $logPath -Message ("WARN: resolution i18n backfill failed ({0}); ignoring." -f $_.Exception.Message)
    } finally {
      Remove-Item $i18nOut, $i18nErr -ErrorAction SilentlyContinue
    }
  }

  # Note: the recall watchdog + daily coach run once per morning from a SEPARATE
  # task (DriveCodexDailyCoach → run-coach-batch.ps1), NOT from this 5-min batch,
  # because this batch only fires inside the 21:00–06:00 crawl window and would run
  # them at the window start against an empty daytime lookback. See run-coach-batch.ps1.

  Write-LogLine -Path $logPath -Message ("END exit_code={0}" -f $exitCode)
  exit $exitCode
}
finally {
  if ($lockTaken) {
    try { $mutex.ReleaseMutex() } catch { }
  }
  $mutex.Dispose()
}
