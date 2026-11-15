# WORK ORDERS — the evidence-gate programme

> Written by the overseer model (Claude, Fable) for the builder model (Claude Opus 5.5; Sonnet 5.5
> for deletion-type orders, D-42).
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

## WO-01 — Integrity fixes · status: MERGED (PR #15, 2026-11-15; 618 tests pass on `main`)

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

## Cost discipline for every order (added after WO-01)

The WO-01 session reported about $10 of usage, most of it from re-reading a very large context
on every turn. From WO-02 on:

- **Never read `client/index.html` or `server/providers/anthropic.js` whole.** Search for the
  lines you need (`grep -n`) and read only those ranges.
- Keep command output short (`npm test --silent 2>&1 | tail -8`; pipe diffs through `head`).
- Do not use subagents. Do not re-read files you have already read.
- One browser check at the end, not after every change.

---

## WO-02 — Cleanup: UMUSHROOM view, AMD box, neutral prompts · status: BUILT on `claude/admiring-ritchie-t8j3dv` (Sonnet 5.5 builder, D-42; 607 tests pass), PR open, waiting for Codex review and the owner's merge

**Goal:** remove three leftovers the owner no longer wants. Deletions and wording only; no new
feature, no new AI call, no change to any report's JSON shape other than the one key named in
item 2.

### 1. Remove the UMUSHROOM view (D-37)

Delete: the Journal tab's UMUSHROOM view and its view switch in `client/index.html`,
`server/umushroom/`, `server/routes/umushroom.js`, its mount in `server/index.js`,
`tests/umushroom.test.js`, `UMUSHROOM_RAW_BASE` in `.env.example`, and every UMUSHROOM mention
in `AGENTS.md` (env table, architecture list, the D-22 paragraph's paper-portfolio sentence).
The idea-card Journal becomes the only Journal view, with no switch. In `docs/DECISIONS.md`
mark D-23 and D-25 "Superseded by D-37" (edit only those two rows' Decision cell prefix; the
table is otherwise append-only). `tests/publicRepoGuard.test.js` stays as it is.

Acceptance: `git grep -i umushroom -- server client tests .env.example AGENTS.md` prints
nothing; `GET /api/umushroom` is a 404; the Journal tab loads with no page error.

### 2. Remove the dedicated AMD section from equity reports (D-40)

The equity template in `server/providers/anthropic.js` still asks for an `amdImplications`
object, and `client/index.html` renders it as its own box (search `amdImplications`). AMD was
one of the owner's old holdings. Remove the key from the template, the box from the client, and
any validator, schema or test that expects it. Reports already stored that carry the key must
still open without error (the box simply no longer shows).

Do NOT touch: AMD in the Markets watchlist (`server/markets/instruments.js`,
`service.js`), the glossary examples, or the Alpha Vantage / Polygon providers.

Acceptance: the equity prompt (via `{ specOnly: true }`) does not contain "amd" in any case;
a stored report fixture with `amdImplications` renders with no page error.

### 3. No prompt claims to be a named bank or a named person (D-40)

Report and macro prompts in `server/providers/anthropic.js` tell the model it works at a real
firm ("BofA Global Research", "Goldman Sachs", "Morgan Stanley", "JPMorgan / Goldman Sachs
tier"), name real strategists, name a real publication series ("World Through a Thematic
Lens", "US Equity Views", "Global Economics Comment"), and ask for a firm's house phrases
("BofA language: ..."). The app is shown live to people in the industry; it must not present
itself as any of them.

- Replace each with a neutral role that names only the job, e.g. "a senior G10 FX strategist
  writing for institutional readers". Keep the analytical instructions and every JSON key.
- Remove the house-phrase instruction and any "X-style" wording in prompts and in code
  comments next to them.
- Check `client/index.html` for labels or titles that present a report as a bank's product
  (search the firm names). A disclaimer that says the app is NOT affiliated with a firm may
  stay. Interview-prep and glossary text that discusses real banks as subject matter stays.
- Data-series names stay (e.g. "ICE BofA US High Yield OAS" is the real name of the index).

Acceptance test: for all seven report types plus the macro view/clients and pitch prompts that
expose a spec, the system and user prompt contain none of: BofA, Bank of America, Goldman,
Morgan Stanley, JPMorgan, JPM, Struyven, Currie, bulge-bracket. Where a prompt has no
`specOnly` path, a source-level test over the prompt-building file is acceptable, with the
data-series names allow-listed explicitly.

### Scope

In: the three items, their tests, `AGENTS.md`, HANDOFF (also mark WO-01 as merged there).
Out: the Morning Bulletin, the news card (WO-03), the report gate (WO-04), any reader-facing
wording beyond the labels named above.

---

## WO-03 — News card · status: APPROVED by the owner 2026-11-15 (D-43); builder Opus 5.5; launch after WO-02 is merged (D-35, D-38, D-41, D-43)

**Goal:** press a button on a headline and get a card that says what happened, what moved, why
it matters and what to watch — where every sentence shows its evidence, and anything without
evidence has been removed by code and counted. This is the first full build of the target
shape. There is no per-card cost target and no search limit (D-43): the real cost is shown on
the receipt. Overseer's rough estimate $0.15-0.30 a card, NOT measured; the daily USD cap
stays the runaway guard.

**The card explains; it does not recommend.** A trade opinion still comes only from the
existing "generate idea" button, which already cites supplied inputs, is logged to the Journal
and is scored (D-41). The Morning Bulletin is NOT touched in this order: it is removed in a
later cleanup, after the owner has seen the card work on the Mac with the real AI.

### The graph

```
inputs (code) ─► writer (Sonnet, 1 call, web search not capped) ─► gate A (code) ─► gate B (Sonnet, 1 call) ─► merge + store (code)
```

1. **Inputs — code, $0.** Build one registry of everything the writer may cite, each with an
   id, source, time and link: headlines `N#` (Finnhub, as the News tab holds them), market
   lines `M:ID` (Markets snapshot: value, change, freshness, STALE flag), calendar `C#` (stored
   FRED calendar), verified macro facts `F:key` (`macroContext`). Reuse the builders in
   `server/ideas/generator.js` — move them to a shared module both use; do not copy them.
2. **What moved — code, $0.** From the snapshot alone: per asset group, the instruments with
   the largest move since their previous close (rates and spreads in bp, others in %). Each row
   keeps its source, time and STALE flag. No model writes this section.
3. **Writer — one Sonnet call** (`callAgent`, new role `newscard`), with the web-search tool and
   **no limit on the number of searches** (D-43: the owner wants accuracy first; do not send
   `max_uses`). Build the request with `webSearchTool(model)` / `models.searchRequest` as
   research does. The receipt shows how many searches ran and what they cost. It receives the focus headline,
   the other headlines, the market lines, calendar and facts. It returns JSON only:
   - `whatHappened`: 2–3 sentences, each `{ text, basedOn: [ids] }`
   - `whyItMatters`: 2–5 sentences, each `{ text, basedOn }` — the chain from event to
     variable to asset, one link per sentence
   - `sentiment`: 0–2 sentences, each `{ text, basedOn }` — allowed ONLY when it cites a
     measured sentiment input (today: prediction-market lines); otherwise omit
   - `whatWouldChangeIt`: 1–2 sentences, each `{ text, basedOn }`
   Rules in the prompt: use figures exactly as given, never compute or recall one; no
   recommendation, direction, target or trade; a sentence with nothing to cite is left out;
   fewer sentences is correct. Web-search support arrives as the tool's cite markup — resolve
   it server-side to the sources actually returned (`parseCiteTags` / `extractSearchSources`
   do this for research) and register them as `W#` inputs. The model never writes a URL.
   **A `W#` record must carry the passage text the API itself returned for that citation**,
   not only URL, title and page age (which is all today's helpers keep — extend them, and
   confirm against the API docs which response field holds the cited source text). The
   writer's own sentence is never evidence for itself. If the response gives no passage for a
   `W#`, that source cannot support anything: a sentence whose only evidence is such a source
   is removed under "search evidence unavailable" (Codex review of PR #16).
   For the "top story" button the same call first picks the headline that best explains
   today's moves and returns `selection: { ref, reason, basedOn }`; it must not pick the
   previous card's story unless something new and material happened.
4. **Gate A — code, $0 (cite or drop).** For each sentence: every id in `basedOn` exists in
   the registry and the sentence has at least one piece of evidence (an id or a resolved
   search source); a `sentiment` sentence cites at least one sentiment-eligible input; every
   figure in the sentence appears in the TEXT of one of its cited inputs — the registry line
   for `N#` / `M:` / `C#` / `F:`, the API-returned passage for `W#` (reuse the number / date / tenor
   handling in `server/research/factCheck.js`; be conservative the same way). A sentence that
   fails is removed and recorded with its reason. A sentence citing a STALE input is kept and
   tagged STALE.
5. **Gate B — one Sonnet call (`models.sonnetModel()`, D-43; not Haiku), no search (does the evidence support the sentence?).** It
   sees ONLY each surviving model-written sentence — `whatHappened` included, so a false
   account of the story cannot pass on a citation alone — next to the text of its own cited
   evidence (registry lines and API-returned passages, never the writer's prose): not the
   card, not the other sentences. Per sentence it
   returns `{ verdict: SUPPORTS | PARTLY | NO, recommendation: true|false, reason }`. Code then
   applies it: `NO` → removed; `recommendation: true` → removed ("news cards explain only");
   `PARTLY` → shown with a "partly supported" tag and the reason. The model's own confidence is
   never asked for or used. If this call fails (after one retry on a temporary error, as
   `safeReview` does) the card is saved and shown with every such sentence tagged
   "NOT CHECKED" and a banner giving the reason — never shown as checked.
6. **What to watch — code, $0.** The next calendar events (up to 3, within 14 days) with date
   and previous reading, straight from the stored calendar.
7. **Merge and store — code.** Assemble the card from what passed. Append it to an
   append-only file `data/news_cards.jsonl` (gitignored; memory-only in tests unless a path
   env var is set), frozen with a hash like Journal entries. Store the removed sentences with
   their reasons for audit. If no `whyItMatters` sentence survives, the card says "No
   explanation met the evidence bar" and still shows the code-built sections.

No rewrite loop in this order: a failed sentence is dropped, not sent back (single-sentence
correction arrives with WO-04). No schedule, no call on page load.

### Routes (all button-driven; POST routes behind `requireWriteAuth`)

- `POST /api/news/card` `{ headlineId }` or `{ top: true }` → the stored card.
- `GET /api/news/cards` (newest first) · `GET /api/news/cards/:id`.
- AI off, budget cap hit, or the writer fails → 503 `available: false` + the plain reason;
  nothing is stored (D-02, D-19). Every call goes through `claudeTransport` inside
  `runWithContext({ receipt })`; the receipt is stored on the card.

### Client (News tab)

- An "Explain" button on each headline and an "Explain top story" button, each showing the
  usual spend chip; a list of stored cards, newest first, which open instantly (this is what
  a live demo shows).
- The card, top to bottom: headline with source, time and link → What happened → What moved
  (table) → Why it matters → Sentiment (measured), only if present → What would change it →
  What to watch → a line such as "3 sentences removed: 2 no evidence, 1 figure not in its
  evidence" (counts and reasons only; removed text is never displayed, D-33) → the cost
  receipt → the existing "generate idea" button for that headline.
- Each sentence shows its evidence as small source chips (publisher, time, link), the same
  way idea cards show "based on". STALE, "partly supported" and "NOT CHECKED" tags are visible.

### Acceptance tests (mock `callAgent` as `tests/ideas.test.js` does)

**The overseer has already written `tests/newsCard.test.js`** (D-42): it covers tests 1-10 and 12
below through the routes, and its header pins the contract — route shapes, the two `callAgent`
roles (`newscard`, `newscheck`), the gate B prompt and reply format, the card shape, the removal
reasons and the sentence tags. Build to that contract. The builder adds the tests that need the
transport or the search-response shape: both calls on the receipt (10), `W#` passages (11) and
the no-scheduler guard (13). If a test's plumbing is wrong, fix the plumbing and say so in the
PR; do not loosen an assertion.

1. A sentence with an empty `basedOn` and no search source is absent from the stored card and
   counted under "no evidence".
2. A sentence citing an id that is not in the registry is removed (the model cannot invent a
   source).
3. A sentence stating a figure that appears in none of its cited inputs is removed and counted
   under "figure not in its evidence"; the same sentence with the figure present survives.
4. A `sentiment` sentence citing only a headline is removed; one citing a prediction-market
   line survives and is labelled as sentiment.
5. Gate B `NO` → removed; `recommendation: true` → removed; `PARTLY` → kept with the tag.
6. Gate B is called with only sentences and their own evidence text (assert the prompt does
   not contain an uncited headline).
7. Gate B failing twice → the card is stored with "NOT CHECKED" on those sentences and a
   banner reason; it is never marked checked.
8. Writer failure or AI off → 503 `available: false`, nothing stored.
9. No `whyItMatters` survives → the card carries the "no explanation met the evidence bar"
   state and still has What moved and What to watch.
10. The stored card carries a receipt with both calls on it; the file is append-only (no
    route edits or deletes a card).
11. A sentence supported only by a `W#` source: with the figure present in the returned
    passage it survives; with no passage returned it is removed under "search evidence
    unavailable"; the writer's own text is never passed to either gate as evidence.
12. A `whatHappened` sentence that contradicts its cited headline gets `NO` and is removed; a
    recommendation placed in `whatHappened` is removed too.
13. No new timer, scheduler or page-load fetch (extend the existing guard in
    `tests/reviewFixes.test.js` or equivalent).

### Scope

In: the above, `AGENTS.md` section for the news card, HANDOFF, `.env.example` for any new
setting (e.g. a model override for the two roles). Out: the Morning Bulletin and its
providers, idea cards' behaviour, research reports, any FT or paywalled source, any rewrite
loop, the Journal record view (WO-05).

## WO-04 — Research reports on the same gate · status: queued

Every opinion in a report carries evidence ids; cite-or-drop in code; single-statement
correction with code merge and a real re-check (replaces `REVISED_UNCHECKED`); the chair's
15 scores become commentary, not the gate.

## WO-05 — Scoring, lessons ledger, the record · status: queued

Score report opinions and red-team warnings the way idea cards are scored (D-18); build the
lessons ledger already designed in D-14; one organised, append-only record view in the
Journal tab, built for a live demo (D-36).
