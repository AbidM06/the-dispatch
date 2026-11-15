# WORK ORDERS — the evidence-gate programme

> Written by the overseer model (Claude, Fable) for the builder model (Claude Opus 5.5).
> One work order = one branch = one draft pull request. Codex cross-reviews as usual
> (AGENTS.md). The overseer checks each result before the next order starts.
> Decisions behind this file: D-33 to D-39 in `docs/DECISIONS.md`.

## Why this programme exists

The owner's rule (D-33): **an opinion is shown only if it is backed by evidence.** Today the
code enforces that for numbers, not for opinions. An audit on 2026-11-15 found:

- The quality gate fails a report only for unsupported **facts**
  (`server/research/claimLedger.js`, `unsupportedMaterialClaims`). Opinions, inferences and
  forecasts skip checking, and nothing links an opinion to the facts it rests on.
- After a revision, failed claims are relabelled `PARTIALLY_VERIFIED` in code without being
  re-checked (`server/research/orchestrator.js`, the loop under "Reconcile ledger").
- Prompts force counts ("exactly 7 risks", "exactly 4-6 trades") and some report templates
  arrive with opinions already filled in (FX pairs with directions).
- News is explained from headlines only, by one unchecked call (the Morning Bulletin).
- Report opinions and red-team warnings are never scored. Only idea cards are.

## The target shape (applies from WO-03 onward)

Three kinds of statement, each with its own gate:

| Kind | Example | Passes when |
|---|---|---|
| **Fact** | "US 10Y is 4.31%" | A code check matches it to a fetched, dated, non-stale figure |
| **Explanation** | "Higher oil feeds headline CPI" | Every sentence cites supplied inputs by id, and a narrow check (reviewer sees only the sentence and its evidence) answers "supports" |
| **Opinion** | "Short EUR/USD into the ECB" | It cites evidence, carries a "proved wrong if" condition that code can score against a Markets instrument by a date, and is logged to the record |

Rules that follow:

- **Cite or drop.** A statement with no evidence ids is removed by code and counted on
  screen ("3 opinions removed: no evidence"). It is never shown.
- **No quotas.** Zero opinions is a valid result.
- **Sentiment is evidence only when measured and sourced** (prediction-market odds,
  positioning, surveys). It is labelled as sentiment and is never the only support.
- **Return the unit, not the batch.** A failed statement goes back alone; code merges the fix;
  only that statement is re-checked. Passed text cannot change.
- **Code before models.** Anything describable without "judge, decide, assess, summarise" is
  code. A model's own confidence is never a gate input.
- **Every passing opinion is logged automatically** — append-only, never hand-picked (D-16).

## How to work an order (builder)

1. Read `AGENTS.md`, `docs/HANDOFF.md`, `docs/DECISIONS.md`, then the order.
2. **Write the failing test first.** Each order lists acceptance tests; they must fail on the
   starting code and pass on yours.
3. Stay inside "Scope". Anything else you notice goes in the PR description under
   "Noticed, not changed".
4. No new paid call, schedule or page-load fetch (D-07). Every Claude call goes through
   `claudeTransport` (D-10). No invented data anywhere (D-02).
5. Finish: `npm test` green, HANDOFF updated, draft PR opened, `@codex review` requested.
6. Explain the change in the PR description in plain English for a beginner.

---

## WO-01 — Integrity fixes · status: PR open (Opus 5.5, `claude/integrity-fixes`)

**Goal:** remove four places where the system asserts something it has not checked, or is
pushed to produce an opinion. No new features, no extra AI cost.

### 1. Three tests fail on `main` today (do this first, as its own commit)

`npm test` on 2026-11-15 gives 600 passed, 3 failed, with no code change since they last
passed on 2026-10-22. Likely cause: fixtures with fixed dates measured against the real
clock. Confirm the cause before fixing.

- `tests/journalTracking.test.js` — "the newest (possibly still-trading) bar is never scored"
  (expects `{ status: "open", markDate: "2026-09-02" }`).
- `tests/curveMacro.test.js` — "GET /macro lists the catalogue … /curve serves the curve"
  (expects 200, gets 502).
- `tests/economicCalendar.test.js` — "events, source and what FRED does not list"
  (expects `economicMissing` to equal `["FOMC decision"]`, gets one extra entry).

Make the tests independent of the real date (pin the clock to match the fixtures, or build
fixtures relative to now). Do not weaken an assertion or skip a test. If a failure is a real
bug in server code, fix the code and say so.

### 2. A revision must not upgrade a claim it did not re-check

In `server/research/orchestrator.js`, after `leadAnalyst.revise`, claims that hard-failed as
`UNSUPPORTED` are set to `PARTIALLY_VERIFIED`. Nothing verified them.

Required behaviour:

- Add a claim status `REVISED_UNCHECKED` (`server/research/claimLedger.js`). After a
  revision, a claim that failed as `UNSUPPORTED` gets this status, with the round in `notes`.
  Confidence stays capped as now. It is never set to `VERIFIED` or `PARTIALLY_VERIFIED` by
  the revision loop.
- `REVISED_UNCHECKED` does not re-trigger the `UNSUPPORTED_MATERIAL_CLAIM` hard fail
  (otherwise no revision could ever clear), but a report holding any such claim can never be a
  clean `APPROVED`: the final status is at most `APPROVED_WITH_CAVEATS`, and
  `institutionalQA` carries a plain line such as "2 claims were rewritten after failing the
  check and were not re-checked".
- The client shows the status readably ("REVISED, NOT RE-CHECKED") in the claim ledger and
  shows that line in the QA strip. `claimSummary` counts it separately.
- A real re-check of revised text is WO-04. Do not add calls here.

Acceptance tests: a pipeline run with one HIGH `FACT` claim audited `UNSUPPORTED`, then a
revision, ends with that claim `REVISED_UNCHECKED`, the status not `APPROVED`, and the line
present. No claim's status improves inside the revision loop.

### 3. Report templates must not arrive with opinions or example figures filled in

`AGENTS.md` already says placeholders are type descriptors, never worked examples — the
equity template was fixed after reports kept returning its example "46%". The other types
were not. In `server/providers/anthropic.js`, `fetchResearchReport`:

- **fx**: `pairViews` lists four named pairs with directions (EUR/USD SHORT, USD/JPY LONG,
  AUD/NZD LONG, EUR/NOK SHORT) and fixed horizons. Replace with descriptors; ask for 2–4
  pair views, only for pairs the evidence supports. `keyTakeaways` slots that pre-write a
  stance ("Long X vs Y screens well...", "We stay bearish/bullish beyond...") and the
  `stance` examples ("Hawkish hold") become descriptors too.
- **rates**: pair targets with example levels ("e.g. 145", "e.g. 1.05-1.09").
- **commodities**: example prices, dates, sources and scenario probabilities
  ("$112.40/bbl", "Apr 4, 2026", "20% / 55% / 25%", "CME / Bloomberg").
- **macro**: example anchors and magnitudes ("Oil at $80/bbl, Strait disruption 5 days",
  "Strait closed 5 weeks", "31bp FCI tightening", the `topTrade` example).
- **equity**: the default focus still says "Include specific AMD implications" and the search
  line names "AMD estimates" — a leftover from the owner's old holdings. Remove both.
- Sweep the remaining types (thematic, sector) for the same pattern.

Keep every JSON key and shape exactly as it is: the client renderers depend on them. Only
placeholder text and counts change. Naming which central banks to cover is fine; pre-writing
their stance is not.

Acceptance tests (use `fetchResearchReport(..., { specOnly: true })`, as
`tests/research.test.js` already does for equity): for all seven types the prompt contains no
pre-filled direction next to a named instrument, no `e.g.` followed by a digit, and no "AMD".

### 4. Events / Risk: "up to", not "exactly"

`fetchAllAnalysis` in `server/providers/anthropic.js` demands "exactly 5" events, "exactly 7"
risks and "exactly 3" econ items; `server/schemas/index.js` enforces `risks` with
`.length(7)`. A fixed count forces the model to pad with weak items.

- Prompt: "up to N, ranked; include an item only if a source you found this session supports
  it; fewer is correct; an empty list is acceptable".
- Schema: allow 0..N. Client: the Events and Risk panels render any count, and an empty
  list shows a plain "nothing met the evidence bar" message, not a blank or a crash.
- Check every reader of these arrays (routes `events.js`, `risk.js`, `aiRefreshJob.js`, the
  no-AI narrative, the client) for an assumption of fixed length.

Acceptance tests: a response with 3 risks and 0 events validates and is served; the old
"exactly" wording is gone from the prompt.

### Scope

In: the four items above, their tests, HANDOFF, and one line per item in the PR description.

Out: the Morning Bulletin (WO-03 replaces it — do not edit its prompt), the bank and
named-strategist personas in report prompts (owner has not decided), any new status beyond
`REVISED_UNCHECKED`, anything in WO-02 to WO-05.

---

## WO-02 — Remove the UMUSHROOM view · status: queued (D-37)

Delete the Journal tab's UMUSHROOM view and switch, `server/umushroom/`,
`server/routes/umushroom.js`, its mount in `server/index.js`, `tests/umushroom.test.js`,
`UMUSHROOM_RAW_BASE` in `.env.example`, and its sections in `AGENTS.md`. Mark D-23 and D-25
"Superseded by D-37". The idea-card Journal becomes the only Journal view. The owner archives
the `dispatch-umushroom` repo on GitHub themselves. `tests/publicRepoGuard.test.js` stays.

## WO-03 — News card, replacing the Morning Bulletin · status: spec to be written (D-35)

First full build of the target shape. One card per story, on demand: what happened (source,
time) → what moved (Markets snapshot, code) → why it matters (explanation lane) → what to
watch (FRED calendar, code) → optional opinion (opinion lane). One paid web search per card
is allowed (D-38). The Morning Bulletin is removed once the card works. The overseer writes
the full spec and shows it to the owner before launch.

## WO-04 — Research reports on the same gate · status: queued

Every opinion in a report carries evidence ids; cite-or-drop in code; single-statement
correction with code merge and a real re-check (replaces `REVISED_UNCHECKED`); the chair's
15 scores become commentary, not the gate.

## WO-05 — Scoring, lessons ledger, the record · status: queued

Score report opinions and red-team warnings the way idea cards are scored (D-18); build the
lessons ledger already designed in D-14; one organised, append-only record view in the
Journal tab, built for a live demo (D-36).
