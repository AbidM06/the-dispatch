# HANDOFF — where the work stands

> Living document. **Every agent updates this before stopping** (see AGENTS.md → Working
> protocol). Newest entry at the top of the log. Keep "In progress" accurate — it is how
> two models avoid editing the same thing.

**Last updated:** 2026-09-28 · **by:** Claude (Claude Code, cloud session) · **branch:** `claude/zen-gates-3v2jhm`

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
- **No fabricated data anywhere** — research, Sales/Macro, events/risk and the calendar
  return "unavailable" rather than invented content (see DECISIONS.md D-02).
- Tests: `npm test` → 304 passing (10 suites).

## 2. In progress

| Task | Agent | Branch | Status |
|---|---|---|---|
| Multi-agent handoff set-up (AGENTS.md, HANDOFF, DECISIONS, CI, PR template, context pack) | Claude | `claude/zen-gates-3v2jhm` | PR open — awaiting owner review / cross-review |

## 3. Next up (agreed with the owner, not started)

In the owner's order of interest. **Propose and confirm before building each one.**

1. **Journal tab** — design agreed:
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
- Update the Mac after a merge:
  `git fetch origin && git checkout -B main origin/main && launchctl kickstart -k gui/$(id -u)/com.thedispatch.server`

## 6. Switching models (e.g. when a usage limit is reached)

- **Agent with repo access (Codex, Claude Code):** "Read AGENTS.md and docs/HANDOFF.md,
  then tell me where we are and what you propose next. Don't change anything yet."
- **Chat-only model:** run `npm run context-pack` on the Mac and upload `context-pack.md`
  with the same instruction.

---

## Session log (newest first)

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
