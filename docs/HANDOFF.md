# HANDOFF — where the work stands

> Living document. **Every agent updates this before stopping** (see AGENTS.md → Working
> protocol). Newest entry at the top of the log. Keep "In progress" accurate — it is how
> two models avoid editing the same thing.

**Last updated:** 2026-09-28 · **by:** Claude (Claude Code, cloud session) · **branch:** `claude/journal-tracking`

---

## 1. Current state (on `main`)

The Dispatch is a personal, **view-only** market dashboard used for **sales & trading
interview prep and learning markets** — not for personal trading any more. Node/Express
server on port 3001 + single-file React client (`client/index.html`). Runs on the owner's
Mac as a launchd service (`com.thedispatch.server`, auto-starts at login).

Working and merged (PR #4, 2026-09-28):
- **Markets tab** — FX, rates & credit, equities, commodities, crypto, macro, prediction
  markets (Polymarket). Free sources only; every value carries source, timestamp and link.
  Auto-refresh weekdays **07:45** and **14:45** London + manual Refresh.
- **Research tab** — five-agent pipeline (lead analyst → claim extraction → FRED fact check
  in code → data auditor + red team + cross-asset PM in parallel → IC chair → quality gate).
  Seven report types. **Generated only when the owner presses Generate**, after a cost
  estimate + confirm. Each report shows a cost receipt. Interrogation chat per report.
- **Trade idea cards** — on demand from News and Research (one AI call, no web search,
  cites only supplied inputs).
- **Cost controls** — every Claude call priced from real usage into `data/ai_spend.json`.
  Caps: monthly **$20, warn-only** (banner + confirm warning); daily **hard stop**.
  No AI runs on a schedule (research batch, bulletin, events/risk refresh are opt-in flags).
- **No-fabrication policy (D-02)** — research, Sales/Macro, events/risk and the News
  calendar return "unavailable" rather than invented content. **Coverage is not yet
  complete:** the Brief still serves seed data (see §4) — the policy is the rule, the
  audit tracks where the code does not meet it yet.
- **Journal stage 1** merged (PR #6, 2026-09-28): every idea logged immutably, JOURNAL tab, pitch-first drill.
- Tests on `main` after PR #6: `npm test` → 373 passing. PR #7 (Sonnet 5.5 setting) adds 4.

## 2. In progress

| Task | Agent | Branch | Status |
|---|---|---|---|
| Research uses current prices: refresh before each report, newest source wins, STALE flags (D-20) | Claude | `claude/fresh-report-data` | PR open |
| Data-accuracy audit: PR #3 leftovers + Brief seed fallbacks (§4) | Codex | read-only on `main` 14780c6 | **Read-only audit complete** ([report on PR #5](https://github.com/AbidM06/the-dispatch/pull/5#issuecomment-5876158200)). Runtime fixes **proposed, not implemented**: (1) Brief integrity on `codex/brief-data-integrity`, (2) FRED + bulletin observation handling, (3) freshness/provenance + research dates. Claude cross-reviews. |
| Journal stage 2: outcome tracking & scoring (D-18) | Claude | `claude/journal-tracking` | Merged (PR #8, 2026-09-28) |
| Sonnet only, no silent Haiku (D-19) + default Sonnet 5.5 (D-17) | Claude | `claude/sonnet-only` | Merged (PR #10, 2026-09-30) |

## 3. Next up (agreed with the owner, not started)

In the owner's order of interest. **Propose and confirm before building each one.**

1. **Journal tab** — design agreed; build in three reviewed stages (D-16):
   stage 1 logging/browsing/pitch toggle → stage 2 outcome tracking & scoring →
   stage 3 reflections & lessons ledger.
   - Every generated idea is logged **as written, never edited**, with the entry price's
     source, timestamp and link.
   - Each idea declares a horizon: **tactical ≤2 weeks, swing 1–3 months, strategic 3–12 months**.
     Tracked on daily closes; closes when target or stop is hit or the horizon expires.
   - Scored in **R multiples** (1R = loss if the stop is hit) and **vs just holding the S&P**
     over the same period. "Was the thesis right?" is scored separately from "did it make money?".
   - A **reflection note** when an idea closes: idea as written → outcome → verdict
     (good/bad thesis × good/bad outcome) → what went right → what went wrong (tagged:
     thesis / timing / instrument / levels / surprise event / bad data) → lesson → concrete rule change.
   - A **lessons ledger** fed into every new idea prompt; a **monthly review** promotes a
     lesson to a permanent rule only when the pattern repeats (avoid over-reacting to luck).
   - **Pitch toggle**: "my pitch first" (owner writes theirs, then sees the AI's) or "AI only".
   - Ideas listed newest first. The red-team log (`GET /api/research/redteam-log`) is scored here too.
2. **Idea card format** — agreed: a one-line 60-second **pitch headline**, then a **desk
   trade card in time order**: what happened (source, time) → what's priced in vs our view →
   thesis (2 lines) → expression (instrument, long/short, why this instrument) → entry /
   target / stop / risk-reward → dated catalysts → risks → what proves it wrong → review dates.
   Instruments: **ETFs and FX pairs**. Shorts allowed (no Shariah gating any more).
3. **Prediction-market charts for Fed decisions, CPI and PCE** — Kalshi has these series;
   exact market IDs still need verifying (the cloud sandbox could not reach Kalshi).
4. **Real economic calendar** — FRED's free release-dates API covers CPI, jobs, PCE, GDP
   (Finnhub's calendar needs a paid plan, so the calendar currently shows "unavailable").
5. Suggested, **not yet approved**: cross-asset "what moved and why" strip; data surprise
   tracker (consensus vs actual + first-hour reaction); moves in standard deviations;
   3-line morning note.

## 4. Open items / known issues

- **Data-integrity audit findings** (Codex, 2026-09-28, on `main` 14780c6 —
  [full report](https://github.com/AbidM06/the-dispatch/pull/5#issuecomment-5876158200)).
  Confirmed with mocked checks; no fixes implemented yet:
  1. **P1 Brief** (`server/routes/brief.js`) manufactures missing values: March-2026
     `RATES_SEED` on an empty cache; per-series seed back-fill inside a partial cache while
     reporting `source: "cache"`, `stale: false`; "what changed" against fixed `PREV_RATES`;
     hand-typed calendars with the current year guessed; fixed catalysts and instrument
     claims in prose. Loaded on every page open.
  2. **P2 FRED** (`server/providers/fred.js`) requests `limit=1`, so a newest "." (no data)
     row loses a series that has a valid previous value.
  3. **P1 Bulletin** (`server/routes/bulletin.js`) calls `toFixed` on FRED observation
     objects, so a normal response silently drops the whole grounding block; HY OAS
     3.17 (%) becomes "3bps" instead of 317bps; no observation dates.
  4. **P2 Schemas** (`server/schemas/index.js`) strip metadata such as `basis` from
     events on validate.
  5. **P2 Markets freshness** is labelled at fetch time and never aged on read; the
     compatibility cache drops `stale`/`staleSince` and resets cache age, which the Brief
     then reads as fresh.
  6. **P2 Research `dataAsOf`** uses generation/retrieval time, not the observation dates of
     the inputs (`routes/research.js`, `research/orchestrator.js`).
  Superseded: the old sync-vs-batch validation split no longer applies (the batch job now
  runs the same pipeline); consolidating the per-type validators is a low-priority follow-up.
- **PR #3** (`claude/relaxed-brown-8q5ynd`, older review branch) — do **not** merge (built on
  the old code). Its four important fixes are in `main`. Smaller items **not yet checked
  against current code**: FRED `limit=1` losing a series on a "." holiday row; Zod schemas
  stripping provenance fields (`.passthrough()`); bulletin macro lines dated by observation
  and HY OAS percent→bp; snapshot freshness should report the OLDEST component; research
  sync path should use the same validators as batch. Owner to close #3 once satisfied.
- Yahoo Finance (Markets primary source) is unofficial and can 403 — each instrument has
  fallbacks.
- Cost estimates start as an assumption (~$0.70/report) until real receipts exist.
- The cloud sandbox cannot reach Kalshi, Polymarket or the React CDNs; UI checks there load
  the libraries from npm instead.

## 5. Owner & environment notes

- The owner wants to be **questioned before anything is built** (what exactly, and why),
  and wants **plain-English explanations** — learning JS/Node/shell from the basics.
- Mac path `~/Desktop/the_dispatch`; restart the server with
  `launchctl kickstart -k gui/$(id -u)/com.thedispatch.server` (it reads `.env` only at start).
- `.env` holds real keys — never print values; show names only (`cut -d= -f1 .env`).
- Update the Mac after a merge — safely (never force-move `main`; local commits must survive):
  ```
  cd ~/Desktop/the_dispatch
  git status --short                 # must print NOTHING — if it lists files, stop and ask
  git switch main
  git pull --ff-only origin main     # only moves forward; if it says "diverged", stop and ask
  launchctl kickstart -k gui/$(id -u)/com.thedispatch.server   # restart only after the pull succeeded
  ```
  `--ff-only` refuses to rewrite or merge anything: if your `main` has commits GitHub
  doesn't, it stops with an error instead of discarding them. (Reviewed by Codex on PR #5.)

## 6. Switching models (e.g. when a usage limit is reached)

- **Agent with repo access (Codex, Claude Code):** "Read AGENTS.md and docs/HANDOFF.md,
  then tell me where we are and what you propose next. Don't change anything yet."
- **Chat-only model:** run `npm run context-pack` on the Mac and upload `context-pack.md`
  with the same instruction.

---

## Session log (newest first)

### 2026-09-28 — Claude (Journal stage 2)
- Owner answered the stage-2 questions (D-18). Built `server/journal/tracker.js`: daily-bar
  tracking after each Markets refresh, limit-order entry in the zone, target/stop/expiry,
  uncertain days, R, S&P comparison, fill rate; final results appended as `outcome` events.
  The idea prompt now returns `horizonDays`. Journal tab shows status, R, vs-S&P and a stats strip.
- Codex reviewed PR #8 over 8 rounds; every finding fixed. Main ones: never score a still-trading
  bar (but keep an aged final bar); retry outcome writes and benchmarks; the Journal outcome wins
  over the derived file; "unavailable" when history can't cover the period; one refresh entry
  point (`jobs/refreshMarkets.js`) and one tracking lookup (`tracker.trackingFor`). 413 tests.
- Owner ended the day after PR #8 ("last fix, then merge").
- Next: owner's Sonnet A/B receipts (D-17); stage 3 (reflections + lessons ledger) — propose first.

### 2026-09-28 — Claude (Journal stage 1)
- Built stage 1 on `claude/journal-logging`: every generated idea is written to an
  append-only `data/journal.jsonl` with a fingerprint, reference-price status and horizon
  bucket; watch / pitch / manual price are separate events; no edit or delete routes;
  JOURNAL tab; "my pitch first" seals new idea cards. Checked in a browser.
- Fixed Codex's four review findings on PR #6: pre-Journal cards are backfilled at server
  start and logged before any dismissal; monthly series are not marked stale by age (only
  the Markets stale flag counts); horizons read every number–unit pair ("2 weeks to
  3 months" → swing); sealed ideas stay sealed in the Journal. 346 tests.
- Next (stage 2, propose first): outcome tracking on daily closes with D-16's
  close-based rule, R multiples and vs-S&P comparison.
- Addressed Codex's two review findings on PR #5 (safe `--ff-only` update; honest
  no-fabrication coverage) and replied on GitHub.

### 2026-09-28 — Owner, Codex, Claude (first joint planning)
- Codex connected; proposed cross-reviewing #5 first, then the data-accuracy audit, then
  the Journal, then calendar/prediction markets. Codex spotted that the brief still
  describes seed fallbacks and that `brief.js` still serves seed data (confirmed by Claude).
- Owner approved the split (Codex: audit; Claude: Journal) and the Journal defaults (D-16).

### 2026-09-28 — Claude
- Merged Cowork's local-only work (Markets, idea cards, five-agent research) with `main`,
  keeping `main`'s no-fabrication rule and cross-asset fact layer (PR #4).
- Added cost transparency: USD pricing of every call, persistent ledger, receipts,
  estimate-and-confirm before refresh, USD caps (the old cap counted calls and was
  silently off).
- Made every AI job manual; monthly cap $20 warn-only.
- Ported four still-relevant findings from PR #3: bulletin shell-injection fix; removed
  invented Sales/Macro fallbacks (and the broken `rateVal()` that fed the live model
  hardcoded rates); removed presupposed events ("Iran war" etc.) from prompts and the
  no-AI narrative; removed the hand-typed calendar.
- Found the "crash" the owner saw was `install-autostart.sh` stopping the dev server
  on purpose, not a bug.
- Set up this handoff system (this PR).
