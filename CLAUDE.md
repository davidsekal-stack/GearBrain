# DriveCodex — Claude Code Instructions

## Project Overview
AI-powered automotive diagnostic web app. React SPA + Supabase backend + Deno edge functions.

## Working With the Owner
- The project owner is **non-technical** and cannot review code or pull requests — never rely on them to review a diff or catch issues.
- **You own verification:** run lint + build (and tests where relevant) and confirm behavior yourself, since no one else will.
- Explain changes in **plain, non-technical language** (what it does, what to expect) — not code detail.
- Confirm anything irreversible or user-facing (especially live deploys / merges to `main`, which auto-publish via Vercel) with the owner in plain terms before doing it.

## Autonomous Crawl Agent (NO human in the loop)
The owner will **not** monitor anything — no case-by-case review, no Desktop icons, no logs, no reports. The crawl agent (`scripts/agent/`) must therefore be fully self-running:
- **Decide everything itself.** No case is ever left "for the human". When a case cannot be verified (missing thread, unreadable model output, thread too long to fully cover), the safe default is **reject** (it never enters the DB; everything is reversible). Approvals still get the independent double-check.
- **Self-correct, don't just alarm.** Auditors act (reversibly quarantine bad cases / reopen wrongly-rejected ones), not merely warn.
- **Freeze the judgment rulebook.** Never auto-rewrite the quality bar / judge prompts without ground truth — that is the one thing that could silently drift. Only safe, reversible tunings (e.g. forum priority) stay automatic.
- **Everything reversible** (backups + revert), so any systemic error can be undone in bulk.

### The operator inbox — the ONLY owner-facing channel
`scripts/agent/operator-inbox.md` is the single place the agent surfaces the rare, recurring problems that genuinely need the owner's decision (maintained automatically; see `operator-inbox.mjs`).
- **At the START of every session, Read `scripts/agent/operator-inbox.md`.** If it lists open issues, LEAD your first reply with them in plain Czech: the problem, your proposed fix, and a yes/no ask. If it's empty, briefly confirm everything is running.
- The owner does not open this file or watch icons — **you** relay it in chat. This is how "tell me only when you need a decision" works.

## Before Every Push
Pre-push hook runs automatically (ESLint + Vite build). Do NOT skip with `--no-verify`.

## Documentation Updates
After completing any significant feature, refactoring, or architectural change:
1. Update `README.md` — keep project structure, setup instructions, and feature list current
2. Update `HANDOVER.md` — architecture decisions, data flow, deployment notes, known issues
3. Keep both files concise and accurate. Remove stale information.

## Code Style
- **Inline styles** — the project uses inline `style={{}}` objects everywhere. Follow this pattern.
- **Theme** — use `t.bg`, `t.text`, `t.accent` etc. from theme.js. Never hardcode colors.
- **i18n** — all user-visible strings go through `tr()`. Add keys to cs.js, en.js, de.js.
- **No CSS files** — no Tailwind, no styled-components, no .css imports.

## Architecture
- `web/src/App.jsx` — view routing, theme, sidebar. NOT a god component — delegates to hooks.
- `web/src/hooks/` — business logic (case CRUD, diagnosis workflow, auth).
- `web/src/lib/` — pure functions (AI prompts, RAG scoring, validation, storage adapters).
- `web/src/constants/` — vehicle catalogs, OBD codes, symptoms.
- `supabase/functions/` — Deno edge functions (AI proxy, push-case, search-cases, review-cases).
- `supabase/migrations/` — sequential SQL migrations (numbered 002–020).
- `scripts/agent/` — autonomous crawl agent that builds the RAG DB (Claude-first pipeline: discover → calibrate → crawl → classify → extract → validate → verify → import). Has its own [README](scripts/agent/README.md); local state in `agent.db` (SQLite), secrets in git-ignored `.env.local`.

## Key Conventions
- Status strings: `"rozpracovaný"` (in-progress), `"uzavřený"` (closed)
- Message types: `"input"`, `"diagnosis"`, `"reply"` (conversational follow-up answer — hybrid mode in `run-diagnosis.js`)
- RAG scoring weights live ONLY in the edge function `supabase/functions/search-cases/index.ts` (`web/src/lib/rag.js` holds just helpers like `extractSignals`). The HIGH/MID/LOW strength thresholds in `web/src/lib/ai-prompts.js` (F1 ratio 0.72/0.58, score-fallback 8/5) must stay consistent with the gate `MATCH_RATIO_MIN` (0.5) in that edge function.
- Edge function URL: `https://nmvjthfezyjcwuzphiuu.supabase.co/functions/v1/<name>`
- Admin check: `ADMIN_USER_IDS` env var in Supabase (email or UUID)

## Testing
```bash
npm test              # unit + i18n + validation + catalog + crawl-agent tests
npm run test:unit     # just unit tests
npm run test:agent    # crawl-agent tests only (LLM router, pause/resume, parsers, discovery, state)
npm run test:integration  # Supabase integration (needs TEST_USER_EMAIL + TEST_USER_PASSWORD)
```

## Deployment
- Push to `main` → Vercel auto-deploy (frontend)
- Edge functions: `npx supabase functions deploy <name> --no-verify-jwt --project-ref nmvjthfezyjcwuzphiuu`
- DB migrations: `npx supabase db push --linked`
