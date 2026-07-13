# Autonomous Crawl Agent Notes

Reviewed: 2026-07-02 (deep pipeline review → clause-(d) tightening, night-window
deadline, queue drain, false-complete pagination fixes, one-shot legacy repair)

## What This Folder Is

This folder is a self-improving forum crawler for building high-confidence automotive fault-resolution cases.

The idea is not "scrape everything and trust the parser". The design is:

1. discover or seed a forum
2. calibrate that forum first
3. crawl only threads that look promising
4. extract structured cases
5. reject weak cases with deterministic gates
6. run an independent AI audit (different vendor than the extractor)
7. dedupe against Supabase
8. import only the survivors

So the real concept is a staged quality pipeline, not a generic scraper.

## My Mental Model

Think of the system as a small queue-based agent with SQLite memory:

- `forums` = crawl targets and their per-forum configuration
- `threads` = raw units of work discovered under each forum
- `cases` = extracted structured repair cases
- `runs` = execution history
- `agent_log` = persistent operator log

The database in this folder, [`agent.db`](/C:/GB/scripts/agent/agent.db), is the local memory that lets the agent resume after failures or quota stops.

## End-to-End Flow

The main entrypoint is [`orchestrator.mjs`](/C:/GB/scripts/agent/orchestrator.mjs).

### Phase 1: Discover

Three sources, cheapest first:

- `--forum-url <url>` inserts a forum directly (domain-deduped).
- Static candidates from [`forum-candidates.json`](/C:/GB/scripts/agent/forum-candidates.json) (one seed source, not the only one).
- **Live web discovery** ([`discover.mjs`](/C:/GB/scripts/agent/discover.mjs)): the routed
  `discover` task (Claude + `WebSearch`) finds automotive fault forums by a rotated
  brand × language matrix (EU/CZ front-loaded), triages them in the same call, dedups
  by domain against the registry + local state, and queues survivors as `discovered`.
  Calibration then does the deep accessibility/structure check — discovery doesn't
  duplicate it. Bounded: a couple of queries per run, only when the crawlable pool is
  low and discovery hasn't run in 24 h (set `AGENT_DISABLE_LIVE_DISCOVERY=1` to turn off).

The forum registry is the **online** [`crawl_forums`](/C:/GB/supabase/migrations/020_crawl_forums.sql)
Supabase table (dedup by domain + last-scraped state across machines), accessed via
[`forum-registry.mjs`](/C:/GB/scripts/agent/forum-registry.mjs). Without the migration/service
key it degrades to local-only (SQLite) and discovery still works.

### Phase 2: Calibrate

Core file: [`calibrate.mjs`](/C:/GB/scripts/agent/calibrate.mjs)

This is the key concept in the whole system.

Before crawling at scale, the agent asks:

- Is this forum worth crawling at all?
- Which subforums are actually technical / fault-related?
- What forum engine is this?
- Which selectors or parser hints are needed?

Calibration has two sub-parts:

1. Structure discovery with the routed LLM (the script fetches the root page
   itself and embeds the HTML in the prompt)
   - qualify/disqualify the forum
   - detect engine type
   - identify the best technical section URLs
   - store parser hints
2. Probe run
   - sample a few threads
   - parse them
   - classify them
   - extract cases
   - validate them
   - measure success rates

Thresholds are explicitly encoded:

- parser success >= 60%
- classifier pass >= 10%
- extractor yield >= 5%

If the probe is weak, the LLM is asked to diagnose failures and suggest better calibration JSON.

If calibration still fails after 3 attempts, the forum is marked `calibration_failed`.

### Phase 3: Crawl

Core file: [`crawl.mjs`](/C:/GB/scripts/agent/crawl.mjs)

The crawl pipeline is:

1. enumerate candidate thread URLs from section pages
2. skip threads already processed
3. fetch thread pages, including pagination
4. parse posts into a normalized thread text format
5. classify thread relevance (routed LLM, default Claude Haiku)
6. extract one or more candidate cases (routed LLM, default Claude Sonnet)
7. run deterministic validation on each case
8. collapse same-thread duplicates (routed LLM, default Claude Haiku) — see below
9. store valid cases in SQLite

**Fetch escalation (anti-bot).** Every page fetch goes through `fetchHtml`
([`fetch-utils.mjs`](/C:/GB/scripts/agent/fetch-utils.mjs)) in escalating tiers,
cheapest first, each only tried when the previous one hits a block (403/406/503)
or a WAF challenge page:

1. **plain `fetch`** — static Chrome UA; handles the vast majority of forums.
2. **got-scraping** (fingerprinted HTTP, no browser) — synthesizes a realistic
   Chrome TLS/JA3 + header fingerprint. Defeats TLS/header-fingerprint WAFs
   (e.g. VerticalScope: audizine.com 403 → 200) without paying for a browser.
   Ships with crawlee (no extra dep). **Opt-in** (default off, so the nightly run
   is unchanged until you flip it): enable with `AGENT_ENABLE_GOTSCRAPING=1`.
3. **system-Chrome `--dump-dom`** — real headless browser for JS-rendered shells.
4. **Crawlee/Playwright** — fingerprinted (optionally residential-proxied,
   `AGENT_PROXY_URL`) browser for POW/JS challenges the DOM dump can't solve.

Not IP-based blocks: a proxy does **not** help sites that 403 every IP (verified
2026-07-13 on dieselpower.cz / forum.mazdaklub.eu). **robots.txt** is ignored by
default; set `AGENT_ROBOTS_MODE=log` to record which URLs it *would* disallow, or
`=enforce` to actually skip them (can cut coverage sharply — measure with `log`
first). The robots lookup is bounded (5s timeout, one fetch per origin, via
`AGENT_PROXY_URL` if set). **`enforce` is not yet wired into caller error
handling** — a disallowed URL throws a fetch error that the orchestrator/calibrator
treat as a real failure (terminal `error` status, can trip the forum breaker), so
prefer `log` until that skip path exists.

**Same-thread dedupe** ([`dedup-thread-cases.mjs`](/C:/GB/scripts/agent/dedup-thread-cases.mjs)):
one forum thread is one discussion. When several members report the SAME fault
fixed the SAME way (e.g. three owners each fitting an aftermarket horn), the
extractor emits one case per member — but they are the same card mined repeatedly
and, sharing the thread's `source_ref`, add no corroboration. The LLM *clusters*
the duplicates and CODE keeps the *richest* (most cited posts → longest
resolution), the same model-proposes/code-decides split as the verifier.
Genuinely different repairs of the same symptom (a "won't start" fixed by a fuel
filter vs. a camshaft sensor vs. a selector rod) are KEPT — corroboration does
not apply across different repairs. Conservative: unsure → keep separate. Errors
fail open (all cases kept). The one-off [`dedup-existing-threads.mjs`](/C:/GB/scripts/agent/dedup-existing-threads.mjs)
applies the same judgement, reversibly, to cases imported before this gate existed.

Important detail: the thread is normalized into a text format like:

```text
THREAD_URL: ...
TITLE: ...
THREAD_AUTHOR: ...

POST 1 | page: 1 | author: Alice | is_thread_author: true:
...
```

That normalized format is the evidence backbone for classification, extraction, and author-consistency validation.

**Thread-age gate (the ">=1 year" policy).** Between parse and classify, `processThread`
checks the date of the newest post (`threadLastActivity`, read from the engine
`<time datetime>` ISO timestamps). If the thread's last activity is younger than
~1 year (`AGENT_MIN_THREAD_AGE_DAYS`, default 365), it is **not** judged yet — it
is set aside as `deferred` with a `revisit_after` (= last post + 1 year) instead
of being discarded. The reason: a fresh thread may not carry its fix yet, and
once we discard a thread we never look again, so judging it too early permanently
loses a resolution that lands later. When the year elapses, `reviveDueDeferredThreads`
re-queues it (status → `pending`) and the next batch re-fetches it: if a fix has
since appeared it is extracted, otherwise it is judged normally and closed for
good (a matured thread is **not** re-checked forever). An **unknown/unparseable**
date (localized listings, e.g. generic .cz/.de skins with no `<time>`) falls
through and is processed now — the safe direction is never to silently drop a
thread we cannot date. The gate lives only in the production `processThread`;
calibration probes (`fetchAndParse`/`classify`/`extract` directly) are unaffected,
so a forum is never failed for having young sample threads.

### Phase 4: Validate

Core file: [`validate.mjs`](/C:/GB/scripts/agent/validate.mjs)

This stage is intentionally non-LLM.

It rejects cases if they are missing core fields, use future-tense "will repair / will update" language, have too-short descriptions/resolutions, or claim fault/resolution posts from different authors.

This file is important because it turns the system from "LLM extraction" into "LLM extraction with deterministic guardrails".

### Phase 5: Verify

Core file: [`verify.mjs`](/C:/GB/scripts/agent/verify.mjs)

After deterministic validation, an independent AI auditor (default: DeepSeek —
deliberately a different vendor than the Claude-based extractor) re-reads the
original thread text and scores the case. It is the last automatic gate before
the human review queue (`status='pending'` in Supabase).

This is a second opinion layer, separate from the extraction path.

**Structured per-condition gate (2026-06).** The auditor no longer returns a free
`PASS`/`FAIL` line — that one-line prompt silently passed three classes of bad
case (an early review caught 8 live examples). It now returns a JSON object with
**six strict booleans**, and *code* (not the model) applies an AND-gate — any
false/missing/non-boolean key → `FAIL`:

| condition | catches |
|---|---|
| `in_scope` | non-cars (motorcycle/HGV/marine/quad) on a car+van database |
| `vehicle_matches_cited_posts` | case vehicle ≠ the vehicle in the cited fault/resolution posts (multi-vehicle thread bleed) |
| `is_genuine_fault` | config/menu questions, parts-fitment/where-to-buy, elective upgrades/retrofits/coding-activation, third-party-gadget firmware, preventive-maintenance opinion |
| `repair_performed` | "fixed itself" / "resolved on its own" — no repair action |
| `repair_confirmed` | outcome unknown/never stated, confirmation borrowed from another user's OWN car, fault returned, or root cause never found |
| `actionable` | symptoms/resolution too vague to act on |

Key design points (see the prompt in `verify.mjs`):
- The case's `case_author` + `fault_post_numbers` + `resolution_post_numbers`
  (already in the payload, previously unused) are injected so the auditor judges
  the vehicle/fault/fix from the **cited posts only** — the structural fix for
  multi-vehicle bleed.
- `is_genuine_fault` carries an inline allowlist so genuine repairs are NOT
  rejected: cleaning (incl. ultrasonic), additive/fluid cures, adjustment,
  re-flashing the car's **own** ECU, rodent-wiring re-splice, an emulator that
  **restores** a failed factory function, and worn-part replacement on classic cars.
- A conservative deterministic pre-gate (`isLikelyOutOfScopeVehicle`, exported)
  short-circuits obvious motorcycles/HGV to `FAIL` with no DeepSeek call. It keys
  on the **model string only** (never displacement/age) and the moto-code regexes
  run only for moto-capable makers, so a car like `320d` or `Golf 1.8` never trips.
- Output is parsed with the codebase's `indexOf('{')..lastIndexOf('}')` slice; a
  malformed response triggers **one** repair retry then **fails closed** to
  `verify_rejected` (a bad case is never silently imported). `temperature:0`.
- The classifier (`classify.mjs`) `has_explicit_fault` definition was tightened in
  lockstep to drop the non-fault classes one stage earlier; the verifier is the
  authoritative gate, the human review queue is the final backstop.
- **Clause-(d) tightening (2026-07-02).** The precision auditor measured 28/70
  wrongly-approved cases over 7 days, 75 % failing on "repair confirmed". Root
  cause: condition 5 accepted a confirmation from "a later reply about the same
  car", which the verifier read as *any* later "worked for me" — including other
  users reporting success on THEIR OWN car — and it never rejected outcome-never-
  stated repairs (1 rejection in 14 days). Now, uniformly across `verify.mjs`
  condition 5, `quality-bar.mjs` clause (d), and `classify.mjs`
  `has_confirmed_resolution`: the repair may be CARRIED OUT by anyone (owner
  decision of 2026-06-23 stands), but the OUTCOME CONFIRMATION must be a later
  post by the case author explicitly saying the fault is gone. Another user's
  own-car success is corroboration, not confirmation; a repair described or paid
  for with no stated outcome is not confirmed.
- **Owner-anchor propagation + post-aware windowing (2026-07-08).** A hand review of
  the whole ~238-case review queue found the intake **triage** over-flagged clause (d):
  unlike `verify.mjs` (anchored in 2026-06), `triage.mjs` / `precision-auditor.mjs` /
  `recall-watchdog.mjs` did **not** tell the model who the case OWNER is (`case_author`)
  or which posts are cited, so on multi-participant threads it conflated the thread
  STARTER with the owner and could not find the owner's confirmation. They also
  head-truncated the thread at 60 k, dropping the owner's (usually LATE) confirmation.
  Fix: a shared [`judge-context.mjs`](/C:/GB/scripts/agent/judge-context.mjs) exporting
  `caseAnchorBlock(payload)` (the CASE AUTHOR + FAULT/RESOLUTION POSTS anchor, mirroring
  verify; sourced from the local `agent.db` payload) and `windowThread()` (post-aware:
  always keeps every case-author post — incl. their LAST word — + the cited posts + the
  original complaint, fills from both ends, elides only the uninvolved middle, and is
  hardened against a forged in-band `POST n` header). Both are injected into triage,
  precision-auditor, recall-watchdog and `audit-clause-d.mjs`; the 60 k cap is raised to
  150 k (`JUDGE_FULL_CAP`, matching verify). `windowThread` GUARANTEES output ≤ cap and
  returns `coverageComplete` — triage **never auto-approves** unless the whole window was
  seen (a thread too long to verify in full goes to the human, never silently approved).
  Covered by [`tests/agent-judge-context.test.js`](/C:/GB/tests/agent-judge-context.test.js).
  Gold-set check against 238 hand-labelled verdicts (partial, 130): **95 % precision**
  (rejects correctly withheld) at **~55 % recall** (good cases now auto-cleared instead
  of all going to the human). Residual: the cheap haiku judge can still miss a
  confirmed-then-*retracted* case in a long thread — the precision-auditor (now also
  anchored) is the post-hoc net; routing the triage auto-approve judge to
  `claude:sonnet` (`AGENT_LLM_TRIAGE`) is the recommended hardening.

Validated against a 67-case live regression (the imports from the prior night):
caught **8/8** known-bad cases, **0** false-rejects on 50 confirmed-good cases,
identical verdicts across two runs (deterministic). Logic is covered by
[`tests/agent-verify.test.js`](/C:/GB/tests/agent-verify.test.js).

### Phase 6: Crosscheck

Implemented in [`orchestrator.mjs`](/C:/GB/scripts/agent/orchestrator.mjs).

Verified cases are compared against existing Supabase cases using a fail-closed REST query plus semantic-ish similarity over resolution, description, symptoms, and source URL.

If a case looks duplicated, it is not imported.

### Phase 7: Import

Also implemented in [`orchestrator.mjs`](/C:/GB/scripts/agent/orchestrator.mjs).

`import_ready` cases are pushed to the Supabase edge function `push-case`.

### Queue drain + night-window deadline (2026-07)

Verify, crosscheck, and import each **drain their whole queue** batch-by-batch
per run (previously one batch of `--batch-size` per run — verify's 20/run ≈
120/night was below the ~140/night extraction rate, so an `ai_approved` backlog
grew unboundedly and the night report showed "verified: 0" for work that
happened nights later). Termination is guaranteed: every processed case changes
status or exhausts its retry attempts.

The nightly wrapper passes `AGENT_DEADLINE_EPOCH_MS` (window end 06:00 minus a
10-min margin, see `run-agent-batch.ps1 -NightStartHour/-NightEndHour`). The
orchestrator checks it before every phase, forum, thread, and case, and stops
cleanly — previously Task Scheduler's 06:00 stop killed only the PowerShell
wrapper while the node child crawled on unsupervised past the window,
overlapping the 06:20 coach chain on the same `agent.db`. Post-crawl sweeps
(taxonomy, i18n) are skipped after a quota stop (exit 75/76) or past the
deadline. `state.mjs` additionally sets `PRAGMA busy_timeout=30000` so residual
concurrent openers wait instead of crashing on SQLITE_BUSY.

Runtime credentials are intentionally not stored in code. Crosscheck requires `SUPABASE_SERVICE_KEY` or `SUPABASE_ANON_KEY`; import requires `SUPABASE_SERVICE_KEY` or `SUPABASE_FUNCTION_KEY`. If those env vars are missing, the run fails closed instead of importing.

## Where AI Is Used

Every AI call goes through the router in [`llm.mjs`](/C:/GB/scripts/agent/llm.mjs).
Default routing (override per task via `AGENT_LLM_<TASK>=provider:model`):

| Task | Default route | Module | Why |
|---|---|---|---|
| classify | `claude:haiku` | [`classify.mjs`](/C:/GB/scripts/agent/classify.mjs) | high volume → cheapest subscription model |
| extract | `claude:sonnet` | [`extract.mjs`](/C:/GB/scripts/agent/extract.mjs) | ~18 % of threads, quality matters |
| dedupe | `claude:haiku` | [`dedup-thread-cases.mjs`](/C:/GB/scripts/agent/dedup-thread-cases.mjs) | low volume (only multi-case threads), small prompt; clusters same-thread duplicate cases |
| verify | `deepseek:deepseek-v4-flash` | [`verify.mjs`](/C:/GB/scripts/agent/verify.mjs) | tiny volume; independent second AI from a different vendor (thinking disabled) |
| calibrate | `claude:sonnet` | [`calibrate.mjs`](/C:/GB/scripts/agent/calibrate.mjs) | rare, needs good HTML reasoning |
| diary | `claude:haiku` | [`diary.mjs`](/C:/GB/scripts/agent/diary.mjs) | short free-form summaries |
| translate | `claude:haiku` | [`backfill-resolution-i18n.mjs`](/C:/GB/scripts/agent/backfill-resolution-i18n.mjs) | high-volume cs/de backfill of resolution texts |

Providers:

- `claude` — the Claude Code CLI in headless print mode
  ([`claude-cli.mjs`](/C:/GB/scripts/agent/claude-cli.mjs)). Auth = the owner's
  Claude subscription: run `claude` once in a plain terminal and log in. Billed
  against the subscription's usage windows. **Do not set `ANTHROPIC_API_KEY` in
  the scheduler account's environment** — the CLI would then bill the metered
  API instead of the subscription, and the usage-limit pause (which keys off
  subscription limit messages) would no longer apply. If the subscription login
  expires, the agent raises an `AuthError`, stops (no pause), and the stall
  alarm reaches the owner — re-run `claude` to log in.
- `deepseek` — HTTP API, needs `DEEPSEEK_API_KEY`.

The design intent:

- cheap Claude models do the first-pass semantic work in volume
- deterministic code does strict rule enforcement
- the verifier stays on a *different vendor* than the extractor on purpose —
  an independent second opinion has independent blind spots (it caught real
  extractor over-leniency in practice; keep it cross-vendor)

## Usage Limits = Pause, Not Death

Historical failure: in April 2026 the Codex CLI hit its subscription limit and
the agent stayed silently dead for 7 weeks (runs "succeeded" with exit 0 every
5 minutes). The current design treats limits as a self-healing pause:

1. A `QuotaError` (from either provider) makes the orchestrator persist
   `pause_until` + `pause_reason` into the `agent_meta` table and write
   `pause-until.txt` next to `agent.db`. Claude limit messages are parsed for
   the reset time; unknown reset → retry in 1 hour (DeepSeek balance, which
   needs a human top-up, pauses 6 h). Exit code is 75. The heartbeat is only
   refreshed by a full run (no `--phase`), so a stuck full task still alarms
   even if a phase-limited task keeps "succeeding".
2. [`run-agent-batch.ps1`](/C:/GB/scripts/agent/run-agent-batch.ps1) checks
   `pause-until.txt` first and exits in milliseconds while paused — scheduled
   runs keep firing but cost nothing.
3. The first run after the window passes resumes automatically; a clean full
   run clears the pause and refreshes the `last-success.txt` heartbeat.
4. The Desktop marker `DRIVECODEX-CRAWLER-STOJI-PRECTI-ME.txt` is written when
   the last clean run was >24 h ago **and** it is >6 h past any promised reset
   — or unconditionally after >9 days (so renewing hourly pauses can't suppress
   it forever). It is removed once runs succeed again. Fresh installs that have
   never succeeded are anchored by `first-run.txt`, so a never-working
   deployment alarms too. An expired Claude login (`AuthError`) does not pause,
   so it reaches the >24 h alarm directly.
5. The **morning coach chain has its own alarms** (2026-07-02; the scheduler
   used to kill it daily at a 1 h ExecutionTimeLimit — now 4 h — and guarded
   recalibration was silently dead for days): `run-coach-batch.ps1` writes
   `coach-running.txt` at START and removes it after END — finding one >20 h
   old means the previous chain died mid-flight → Desktop marker
   `DRIVECODEX-RANNI-KONTROLA-NEDOBEHLA-PRECTI-ME.txt`. It also cross-checks the
   crawler's `last-success.txt` heartbeat (>30 h → marker
   `DRIVECODEX-NOCNI-CRAWL-NEBEZEL-PRECTI-ME.txt`), covering the blind spot
   where the whole nightly task is disabled and its own wrapper alarm can
   therefore never fire.

## Parser Layer

Parser files live in [`parsers`](/C:/GB/scripts/agent/parsers).

Supported/specialized engines:

- [`invision.mjs`](/C:/GB/scripts/agent/parsers/invision.mjs)
- [`phpbb.mjs`](/C:/GB/scripts/agent/parsers/phpbb.mjs)
- [`xenforo.mjs`](/C:/GB/scripts/agent/parsers/xenforo.mjs)
- [`woltlab.mjs`](/C:/GB/scripts/agent/parsers/woltlab.mjs)
- generic fallback: [`generic.mjs`](/C:/GB/scripts/agent/parsers/generic.mjs)

Detection is handled by [`detect.mjs`](/C:/GB/scripts/agent/parsers/detect.mjs).

The parser contract is simple: produce normalized post objects with fields like:

- `author`
- `postId`
- `when`
- `pageNumber`
- `text`

Everything downstream assumes that shape.

**Calibrated CSS selectors are honored first.** When `calibration_json` has a
`post_selector` (the LLM finds these during calibration), `parseHtml` in
[`crawl.mjs`](/C:/GB/scripts/agent/crawl.mjs) extracts posts with
`selectPosts()` in [`common.mjs`](/C:/GB/scripts/agent/parsers/common.mjs) —
a real tokenizer-backed CSS matcher (post / content / author / date / quote
selectors), not regex. This is what makes modern JS platforms work: VerticalScope
"Fora" sites (VWVortex, ToyotaNation, SwedeSpeed, Audizine) use
`div.MessageCard.js-post` containers that the regex `xenforo` engine parser
cannot match. The engine parsers are the fallback when no selector is set.

**JS-rendered shells get a browser retry.** If a thread page returns HTTP 200
but yields zero parseable posts (an empty SPA shell), `fetchThreadPages`
re-fetches page 1 once via the headless-browser render (`forceBrowser` in
[`fetch-utils.mjs`](/C:/GB/scripts/agent/fetch-utils.mjs)) and re-parses, so
single-page-app forums aren't silently discarded as "Too few posts".

**Pagination detection (`findNextPageLink`, 2026-07-02).** Besides the classic
`a.next` / `a[rel=next]` / `li.next a` patterns it now also understands:
`<link rel="next">` in the document head (WoltLab — RenaultForum, PeugeotTalk —
publishes pagination ONLY there), the SMF `a.navPages` anchor with the »
glyph, and text-labelled next buttons (Další/Weiter/Nächste/»…) guarded by a
pagination-shaped href. Before this, those engines' sections were marked `done`
after listing page 1 and whole forums flipped to a FALSE "archive complete"
(19 forums, e.g. RenaultForum 43 sections × 1 page) — the stated primary goal,
archive mining, silently reached ~1–2 % on them. `phaseCrawl` now logs a loud
warning whenever an archive completes with barely more pages than sections, and
the one-off [`reset-archive-cursors.mjs`](/C:/GB/scripts/agent/reset-archive-cursors.mjs)
(dry-run default, reversible backup) cleared the 19 false-complete cursors so
the nightly walk re-mines them with the fixed detection. Known limitation:
BMW-Syndikat (Snitz) has numbered page links only (no "next" anchor) — the
warning will keep flagging it until a numbered-walk is built. Motor-Talk gotcha:
its bare board URL lands on the LAST page (only `rel=prev`), so its profile
sections start at `?page=1` explicitly.

## State Machine

Practical statuses I saw in code:

- forums
  - `discovered`
  - `queued`
  - `active`
  - `disqualified`
  - `calibration_failed`
  - `exhausted`
- threads
  - `pending`
  - `deferred` (fetched but too young to judge — set aside until `revisit_after`,
    ~1 year after its last post; revived to `pending` when due)
  - `discarded`
  - `extracted`
  - `error`
- cases
  - `ai_approved`
  - `verified`
  - `verify_rejected`
  - `verify_skipped`
  - `verify_error`
  - `crosscheck_dupe`
  - `import_ready`
  - `imported`
  - `import_failed`

The queue is not implemented as a separate broker. SQLite itself is the queue and checkpoint layer.

## Learning Loop

The most interesting part of the design is the feedback loop:

- calibration learns parser hints per forum
- diary entries summarize what worked on previous forums
- diary context is injected into future structure-discovery prompts
- cooldown logic prevents wasting cycles on mostly exhausted forums
- the **daily coach** (Phase 2) closes the outer loop: it watches the per-forum verified yield over several nights and automatically (reversibly) re-prioritises and re-times the crawl queue — all without ever loosening a quality gate
- **guarded auto-recalibration** (`recalibrate-guarded.mjs`) closes the structural loop: a forum that processes threads but extracts nothing for several nights is re-discovered + re-calibrated against an in-memory shim (the live row is never touched until success), and the new config is kept ONLY if it beats the old yield AND keeps real sections — otherwise it rolls back. Fully reversible.
- the **alert-agent** (`alert-agent.mjs`) closes the precision loop: when the precision auditor raises an alarm it reflects on the flagged cases (plain-Czech diagnosis + a gate-tightening recommendation, report-only) and reversibly **quarantines** the high-confidence bad cases out of the live DB — without ever editing a gate itself

So this is meant to become better over time per forum type, not just run statelessly.

## Helper Scripts

- [`reset-archive-cursors.mjs`](/C:/GB/scripts/agent/reset-archive-cursors.mjs): **one-off** recovery of forums falsely marked "archive complete" by the pagination bug (dry-run default, `--apply` writes a reversible backup, `--revert <backup>`); applied 2026-07-02 to 19 forums
- [`prune-thread-text.mjs`](/C:/GB/scripts/agent/prune-thread-text.mjs): **one-off** cleanup of dead `thread_text` on discarded threads (nothing reads it — consumers reach text via cases). Applied 2026-07-02: 33 MB cleared, `agent.db` 84.7 → 44.2 MB after VACUUM; the discard path no longer stores the text
- [`seed-known-forums.mjs`](/C:/GB/scripts/agent/seed-known-forums.mjs): marks previously handled forums as already exhausted so the agent does not duplicate old work
- [`seed-candidates.mjs`](/C:/GB/scripts/agent/seed-candidates.mjs): imports ranked forum candidates into SQLite
- [`reset-forum.mjs`](/C:/GB/scripts/agent/reset-forum.mjs): clears failed calibration state so a forum can be retried
- [`recover-discarded.mjs`](/C:/GB/scripts/agent/recover-discarded.mjs): **one-time** recovery of threads discarded BEFORE the thread-age gate shipped (genuine faults marked "no confirmed resolution" that may have a fix now). Flips the recoverable ones `discarded` → `pending` so the nightly crawl re-judges them under the age-aware pipeline; does no fetching/LLM itself. Dry-run by default (reports buckets: recoverable / too_few / terminal / other); `--apply` flips + writes a backup; `--revert <backup>` restores still-pending ids (CAS — never clobbers a re-processed one). Flags: `--limit`, `--forum`, `--include-too-few`. Run it AFTER the age-gate code is live, else the old pipeline just re-discards them
- [`patch-symptoms.mjs`](/C:/GB/scripts/agent/patch-symptoms.mjs): re-extracts symptoms for already imported cases and patches Supabase/local payloads
- [`backfill-resolution-i18n.mjs`](/C:/GB/scripts/agent/backfill-resolution-i18n.mjs): translates the English `resolution` of approved cases into Czech/German (`resolution_cs`/`resolution_de` + detected `resolution_lang`) for the "Known Faults" panel. Routed via Claude (task `translate`), resumable (queue = `resolution_lang IS NULL`); run nightly as Step 3 of `run-agent-batch.ps1`. Never modifies the canonical English `resolution`
- [`recall-watchdog.mjs`](/C:/GB/scripts/agent/recall-watchdog.mjs): daily recall audit of the verifier — a cross-vendor (Claude) re-check of a sample of recent `verify_rejected` cases to catch the verifier *over-rejecting* good cases (the one failure mode the verifier can't see in itself). Self-gates to 1×/day after `RECALL_AUDIT_HOUR` (07:00); writes `logs/recall-audit-YYYY-MM-DD.md` always, and `recall-alert.txt` only when the wrongly-rejected rate clears a threshold (≥30% of ≥3). Runs as **Step 1 of the dedicated `run-coach-batch.ps1`** morning task (alongside the daily coach + precision auditor), which mirrors the alert to a Desktop marker. Routes via the `AGENT_LLM_RECALL-AUDIT` env override (no change to `llm.mjs`). The agree/disagree judgements accumulate as labelled data for future verifier-prompt tuning
- [`daily-coach.mjs`](/C:/GB/scripts/agent/daily-coach.mjs): the self-improving loop. Runs 1×/morning from the dedicated `DriveCodexDailyCoach` task (via [`run-coach-batch.ps1`](/C:/GB/scripts/agent/run-coach-batch.ps1)) AFTER the night window. Phase 1 = observe (night report + `crawl_metrics`). **Phase 2 = auto-tier adapt** (the planner is [`coach-adapt.mjs`](/C:/GB/scripts/agent/coach-adapt.mjs), a pure module): each night it may apply at most ONE reversible change per forum — **priority_score** (verified-yield ranking) or **cooldown** (shorten/extend within the engine's 24h/168h tiers) — and emits a **shadow re-calibration proposal** for forums that process threads but extract nothing (never auto-applied — it is the one knob not column-reversible). Guardrails: min-volume, 2–3-night hysteresis, 1 change/forum/day, transient guard, 10-day anti-flap, a 50%-of-fleet circuit-breaker, and an 8/night cap. Every applied change is journaled in `coach_journal` (atomic `applyCoachChange`) and reported under "Co jsem automaticky upravil". **It never touches a verify gate, threshold, or prompt** — only crawl order/timing
- [`apply-proposal.mjs`](/C:/GB/scripts/agent/apply-proposal.mjs): undo tool for the coach's reversible changes. `--list` shows revertable changes; `--revert [--date|--forum|--case|--knob priority|cooldown|recalibrate|quarantine] [--dry-run]` rolls them back newest-first via **compare-and-swap** (restores a change only if the row still holds the value the coach wrote, so it never clobbers a newer engine/manual/human edit). Idempotent. Dispatches on `target_kind`: `forum` knobs (priority/cooldown/recalibrate) restore forum columns; `quarantine` restores a case status AND flips the live `gearbrain_cases` row back out of `rejected`. (Applying risky prompt/threshold proposals is still a Phase 4 deliverable, not built yet.)
- [`recalibrate-guarded.mjs`](/C:/GB/scripts/agent/recalibrate-guarded.mjs): **guarded auto-recalibration** (Step 5 of `run-coach-batch.ps1`). Selects ≤`RECAL_MAX_PER_NIGHT` (default 1) "stuck" forums (the coach's `planRecalProposal` signal), skipping profile forums, forums already changed today (1/forum/day), and anything re-calibrated within `RECAL_COOLDOWN_DAYS` (7). For each it snapshots the full config, probes the CURRENT config for an honest baseline, then runs `calibrateForum` against a **buffering state shim** (`makeBufferingState`) so the live forum row is never mutated until the decision; the candidate is committed (one atomic `applyCoachChange`, knob `recalibrate`) ONLY if it passes calibration thresholds, beats the baseline yield by `RECAL_MIN_YIELD_GAIN` (0.2), AND ended up with real sections — otherwise an `applied=0` attempt marker is journaled (drives the anti-flap) and nothing changes. Quota/auth aborts the step (exit 3) so the batch skips the rest and retries tomorrow
- [`alert-agent.mjs`](/C:/GB/scripts/agent/alert-agent.mjs): **cautious follow-up to the precision alarm** (Step 4 of `run-coach-batch.ps1`, only when `precision-alert.txt` exists; self-gates 1×/day). It clusters the flagged labels (`logs/precision-labels.jsonl`), reversibly **quarantines** the HIGH-confidence wrongly-accepted cases (cap `ALERT_MAX_QUARANTINE`, default 8) — live `gearbrain_cases` flipped pending/approved→`rejected` via an atomic CAS keyed by `local_id`, then the local case → `quarantined` + journaled (`applyCaseChange`, knob `quarantine`); live-first with compensation if the local write fails, so a half-action is never left un-revertable. Then it asks Claude for a plain-Czech diagnosis + a gate-tightening **recommendation** appended to the report/marker. It **NEVER edits a gate or prompt** (that stays the human Phase-4 boundary); case ids come only from the structured label log, never model prose. Quarantine runs BEFORE the model call so it survives a tight quota
- [`precision-auditor.mjs`](/C:/GB/scripts/agent/precision-auditor.mjs): the **mirror** of the recall watchdog (daily coach Phase 3). The watchdog catches the verifier *over-rejecting*; this catches it *under-rejecting* — it samples recently APPROVED cases (verified/import_ready/imported) and re-judges them with Claude against the same `QUALITY_BAR`, reporting the rate of **wrongly-ACCEPTED** cases (bad cases that slipped into the live DB — the more dangerous failure). REPORT-ONLY: writes `logs/precision-audit-YYYY-MM-DD.md`, `crawl_metrics precision_*`, and an accumulating `logs/precision-labels.jsonl` (a Claude-judged label seed for the future Phase-4 gate work). The Desktop marker `DRIVECODEX-PRECIZNI-AUDITOR-PRECTI-ME.txt` fires only on a 7-day **pooled** rate or a same-day **cluster on one quality-bar clause** (never single-day noise). Sampling is risk-stratified (newest imports + payload-heuristic riskiest + random). Runs as **Step 3 of `run-coach-batch.ps1`**; routes via `AGENT_LLM_COACH-PRECISION`
- [`quality-bar.mjs`](/C:/GB/scripts/agent/quality-bar.mjs): the single canonical `QUALITY_BAR` definition (the (a)-(e) admission criteria + genuine-repairs allowlist) shared by both daily audits (`recall-watchdog.mjs` re-exports it) so they never drift apart
- [`run-agent-batch.ps1`](/C:/GB/scripts/agent/run-agent-batch.ps1): Windows-safe one-shot batch wrapper with process mutex and daily log files (loads `.env.local` automatically). Post-crawl steps: (1) refresh crawled-index, (2) fault-taxonomy classify, (3) resolution i18n backfill, (4) verifier recall watchdog
- [`register-agent-task.ps1`](/C:/GB/scripts/agent/register-agent-task.ps1): creates or updates a Windows Task Scheduler job that runs the batch wrapper every few minutes
- [`apply-migrations.ps1`](/C:/GB/scripts/agent/apply-migrations.ps1): applies pending Supabase migrations to the linked project non-interactively (reads `SUPABASE_DB_PASSWORD` from `.env.local`); `-DryRun` to preview

## Secrets / Environment

Fill `scripts/agent/.env.local` (copy from
[`.env.local.example`](/C:/GB/scripts/agent/.env.local.example); git-ignored) **once**:

| Var | Used for | Where to get it |
|---|---|---|
| `SUPABASE_SERVICE_KEY` | online registry + case import + crosscheck | Dashboard → Settings → API → service_role |
| `SUPABASE_DB_PASSWORD` | `supabase db push` (migrations) | Dashboard → Settings → Database |
| `DEEPSEEK_API_KEY` | independent verification | DeepSeek console |
| `SUPABASE_URL` | (public) | already set in the template |

Once filled, everything is autonomous: scheduled runs (`run-agent-batch.ps1`) load
it, migrations run via `apply-migrations.ps1`, and the online registry + import
activate. Without it the agent still runs (local-only registry, no import).

Optional anti-bot / politeness knobs (all off/unset by default, documented in the
template): `AGENT_ENABLE_GOTSCRAPING`, `AGENT_PROXY_URL`, `AGENT_DISABLE_CRAWLEE`,
`AGENT_ROBOTS_MODE` — see the **Fetch escalation** note under Phase 3.

## How I Would Operate It

Useful commands (`--env-file` loads the secrets for manual runs):

```bash
node --experimental-sqlite scripts/agent/orchestrator.mjs --stats
node --experimental-sqlite --env-file=scripts/agent/.env.local scripts/agent/orchestrator.mjs --phase calibrate
node --experimental-sqlite --env-file=scripts/agent/.env.local scripts/agent/orchestrator.mjs --phase crawl
node --experimental-sqlite --env-file=scripts/agent/.env.local scripts/agent/orchestrator.mjs --phase verify
node --experimental-sqlite --env-file=scripts/agent/.env.local scripts/agent/orchestrator.mjs --continuous
node --experimental-sqlite scripts/agent/reset-forum.mjs --all-failed

# Apply pending DB migrations (e.g. 020_crawl_forums) to the linked project:
powershell -ExecutionPolicy Bypass -File scripts/agent/apply-migrations.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File scripts/agent/apply-migrations.ps1
```

If I were onboarding myself fast, I would read files in this order:

1. [`orchestrator.mjs`](/C:/GB/scripts/agent/orchestrator.mjs)
2. [`state.mjs`](/C:/GB/scripts/agent/state.mjs)
3. [`calibrate.mjs`](/C:/GB/scripts/agent/calibrate.mjs)
4. [`crawl.mjs`](/C:/GB/scripts/agent/crawl.mjs)
5. [`validate.mjs`](/C:/GB/scripts/agent/validate.mjs)
6. [`verify.mjs`](/C:/GB/scripts/agent/verify.mjs)

## Unattended Windows Operation

For long-running operation, do not keep the agent inside one forever terminal process.
Use short batch runs under Task Scheduler so every run starts cleanly and resumes from
[`agent.db`](/C:/GB/scripts/agent/agent.db).

Recommended setup:

```powershell
powershell -ExecutionPolicy Bypass -File C:\GB\scripts\agent\register-agent-task.ps1
```

That creates a task named `DriveCodexAgentBatch` for the current Windows user with:

- repeat interval: every 5 minutes
- overlap policy: `IgnoreNew`
- wrapper-level protection: named mutex in [`run-agent-batch.ps1`](/C:/GB/scripts/agent/run-agent-batch.ps1)
- log files: `C:\GB\scripts\agent\logs\agent-batch-YYYY-MM-DD.log`

Useful variants:

```powershell
powershell -ExecutionPolicy Bypass -File C:\GB\scripts\agent\register-agent-task.ps1 -IntervalMinutes 10
powershell -ExecutionPolicy Bypass -File C:\GB\scripts\agent\register-agent-task.ps1 -BatchSize 3 -RunNow
powershell -ExecutionPolicy Bypass -File C:\GB\scripts\agent\run-agent-batch.ps1 -Phase verify
```

Important operational note:

- the scheduled task is registered with `Interactive` logon for the current user, which is the safest mode for reusing the same user-level environment, the Claude CLI login, and API keys
- if the machine is logged out, the task will not keep running until that user logs back in

## What Looks Real vs What Looks Planned

Verified from code:

- SQLite-backed state and resumability are real
- staged pipeline structure is real
- LLM-routed classification/extraction hooks are real (Claude CLI by default)
- independent verification and LLM calibration hooks are real
- cooldown and forum exhaustion logic are real
- parser support for multiple forum engines is real

Still weak or unfinished:

- dedupe logic now uses broader similarity, but it can still miss duplicates when brand/source data is inconsistent
- parser extraction is regex-heavy and fragile on HTML shape changes (see the
  false-complete pagination incident above — new engines/skins need the audit
  warning watched)
- dedicated regression tests exist under [`tests`](/C:/GB/tests) for crawler utilities and state handling
- service credentials are expected from environment variables, not hardcoded defaults

## Bottom-Line Concept

My concise understanding is:

This folder implements an autonomous forum-ingestion agent whose main job is to transform messy automotive discussion threads into high-confidence structured repair cases by combining:

- parser heuristics
- LLM semantic filtering/extraction (Claude, cheap models in volume)
- deterministic validation
- independent cross-vendor AI review/adaptation
- SQLite persistence
- Supabase import

The important design choice is that it does not trust any single layer. Every stage is supposed to narrow quality before data reaches the final database.
