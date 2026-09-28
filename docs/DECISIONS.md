# DECISIONS — what was decided, and why

> Append-only. Each entry: date, who decided, the decision, and the reason. An agent that
> thinks a decision is wrong **raises it with the owner** — it does not quietly undo it.
> Superseded decisions stay, marked "Superseded by D-xx".

| ID | Date | Decided by | Decision | Why |
|---|---|---|---|---|
| D-01 | 2026-09 | Owner | **View-only.** No order execution, no rules-based idea engine, no Alpaca. | Execution was unreliable and inefficient; the app is now for interview prep and learning. |
| D-02 | 2026-09 | Owner + Claude | **No fabricated data.** When live data or AI is unavailable, show "unavailable" — never seeded reports, invented events, typed-in calendars or hardcoded rates. | Seed reports once asserted a Strait of Hormuz closure that never happened; an invented report is worse than none. |
| D-03 | 2026-09 | Owner | **No Shariah gating; shorts allowed.** | Personal trading has stopped; the app is for learning. |
| D-04 | 2026-09-28 | Owner | **Depth of checking over cost — but cost always visible.** Keep the five-agent pipeline; show a receipt per report. | Owner priority. |
| D-05 | 2026-09-28 | Owner | **Costs in USD.** | Anthropic bills in USD. |
| D-06 | 2026-09-28 | Owner | **Monthly AI budget $20, warn-only**; daily cap is a hard stop (runaway guard). | Owner's limit; chose a warning over a hard stop for the monthly figure. |
| D-07 | 2026-09-28 | Owner | **No AI on a schedule.** Research, bulletin and events/risk are generated only when the owner presses a button. | Reads reports only when something interests them; keeps within $20/month. |
| D-08 | 2026-09-28 | Owner | **Markets refresh 07:45 (pre-LSE) and 14:45 (post-NYSE open) London**, plus a manual button. Free data only. | Morning-note moment plus the US open; costs nothing. |
| D-09 | 2026-09-28 | Claude (evaluated) | **No prompt caching in the research pipeline.** | The reviewers run in parallel and cannot read each other's cache; it would add the write premium for well under a cent of savings. Revisit only if reviewers become sequential. |
| D-10 | 2026-09-28 | Claude | **Every Claude call goes through `server/providers/claudeTransport.js`.** | One place that prices, records, budgets and batches; a second path would be invisible on receipts. |
| D-11 | 2026-09 | Claude (from main) | **Fed policy path is a labelled proxy (2Y − fed funds), never a probability.** | No free FedWatch API; a proxy presented as odds would be fabrication. |
| D-12 | 2026-09-28 | Owner | **Multi-agent protocol:** AGENTS.md is the shared brief; HANDOFF.md is updated every session; agents propose before committing; one branch/PR per task; the other model cross-reviews before the owner merges; CI must be green. | Lets GPT/Codex models continue when Claude hits a usage limit, and vice versa. |
| D-13 | 2026-09-28 | Owner | **Idea format:** 60-second pitch headline + desk trade card in chronological order; ETFs and FX pairs. | Matches what a desk and an interviewer expect. |
| D-14 | 2026-09-28 | Owner | **Journal tab design** as recorded in HANDOFF §3.1 (horizons, R + vs-S&P scoring, reflection note, lessons ledger, monthly review, pitch toggle). | Learning loop for interview prep; separate thesis-quality from luck. |
