# Engineering brief

For the software-engineer review. Written to stop a reviewer spending its budget
rediscovering constraints that were deliberate, and to point it at the files that
matter in a repository of ~27,000 lines.

All paths are relative to the repository root on `main`:

```
https://raw.githubusercontent.com/AbidM06/the-dispatch/main/<path>
```

## Reading order

Read these in order and stop when the budget runs out — they are ranked by how
much of the system they explain per line.

| # | Path | Why |
|---|---|---|
| 1 | `CLAUDE.md` | The design decisions and the reasons behind them, including the ones that look wrong until you know the constraint |
| 2 | `server/index.js` | Entry point, every route mount, the error handler |
| 3 | `server/providers/macroContext.js` | The fact layer. 222 lines, and the most important file in the repo |
| 4 | `server/routes/research.js` | The generation path, the 503 unavailable behaviour, chart injection |
| 5 | `server/providers/anthropic.js` | 1,500 lines. The AI surface: prompts, schemas, retries, the OpenAI fallback, citation parsing. The biggest single risk area |
| 6 | `server/cache.js` + `server/retry.js` | The degradation machinery everything depends on |
| 7 | `server/engine/ideaEngine.js` + `server/engine/playbooks.js` | Idea generation |
| 8 | `server/analytics/executionPolicy.js` | Circuit breakers on anything that could place an order |
| 9 | `tests/research.test.js` | The newest tests and the clearest statement of intended behaviour |
| 10 | `client/index.html` | One file, 6,400 lines. Skim the research renderer around `RpVerifiedData` and `renderResearch` |

## Stack and shape

- Node + Express, no TypeScript, CommonJS throughout.
- `client/index.html` is a single React 18 file using `React.createElement`
  directly — no JSX, no bundler, no build step. Served statically by the same
  Express process.
- State lives in an in-memory TTL cache plus JSON/JSONL files under `data/`.
  There is no database.
- Jest for tests; `global.fetch` is mocked, so no test makes a real network call.
- Zod schemas exist in `server/schemas/index.js` but are not applied to research
  reports — those are validated by hand-written per-type validators in
  `anthropic.js`. That inconsistency is real and worth a comment.

## Constraints that shaped the design

Do not recommend fixes that these rule out.

- **Free API tiers.** Alpha Vantage allows 25 calls/day, so it serves exactly
  two (AMD and USD/GBP). Polygon's snapshot endpoint is paid, so the code uses
  `/v2/aggs` and accepts a ~15-minute delay. These are not oversights.
- **No paid market data.** No intraday bars, no options, no order book, no CME
  FedWatch. The Fed policy proxy exists because the real thing has no free API.
- **Single user.** No multi-tenancy, no session management, no user table.
- **Cost.** Every AI call is metered against a budget module; daily reports were
  moved onto the Message Batches API for the 50% rate.

## Known defects — confirmed, do not spend the review finding these

This list is post-review. Items struck through were on the list handed to the
reviewers and have since been fixed; the ones that remain are still live.

1. ~~**Spend caps are inert.**~~ Fixed. `budget.js` used
   `parseInt(process.env.ANTHROPIC_DAILY_CAP, 10) ?? 5`; `parseInt(undefined, 10)`
   is `NaN`, which is neither `null` nor `undefined`, so `??` never fired and
   both caps were `NaN` — every comparison against them false. `_intEnv()` now
   parses explicitly, rejects non-numeric values with a warning, and honours a
   deliberate `0`.
2. **`web_search` has no `max_uses`.** Per-report search cost is unbounded.
   Still known and deferred.
3. ~~**Unguarded `snapshotMeta.source.toUpperCase()`**~~ Fixed in the provenance
   audit: the header badge is built from a guarded status string. There is still
   no React error boundary.
4. ~~**One failing test on a clean checkout.**~~ Fixed. It failed because the
   event-risk check read a hand-typed calendar with no year ("19 Mar"), which
   only put an event inside the horizon in spring. The calendar is now injected
   with full dates; 342 of 342 pass.
5. **No CI.** No `.github/workflows`. Adding one would go red immediately on
   defect 4.
6. **`README.md` is stale** in two places: it states 227 tests (there are 292)
   and lists five research report types (there are six — it omits equity and
   commodities).
7. ~~**`narrativeEngine.js` hardcodes market claims.**~~ Fixed in the provenance
   audit — rewritten to use only dated facts. See "Provenance audit" below.
8. **HBKS's asset class is contested inside the repo.** The Shariah filter
   catalogues it as a UK equity ETF; a playbook traded it as a duration hedge
   and quoted an unsourced beta. The playbook is held by `CONTESTED_INSTRUMENTS`
   until the fund is identified by ISIN rather than ticker.

## What the external review found that this list did not

Nine reviewer perspectives were run over the review pack and the repository.
Six findings and several ledger items were confirmed against source and fixed;
they are recorded as `tests/reviewFindings.test.js`, whose test names carry the
reviewer's own IDs so a regression test traces back to the claim it settles.

- **F01 — command injection.** `bulletin.js` interpolated AI-generated text into
  an `osascript -e` string passed to `exec`. A quote in a headline was arbitrary
  shell. Now `execFile` with an `on run argv` handler, so the text is an
  argument and never part of the script source.
- **F02 — execution controls defeated by their callers.** Policy was checked
  against a £100 placeholder before sizing; a blocked sizing became a 1-share
  order; `openPositions` and `portfolioGBP` were never passed, silently
  disabling two caps; account equity defaulted to £75,000 and £1,110. Order is
  now size → validate → check policy with real numbers → trade.
- **F03 — the macro block in the bulletin.** It rendered `[object Object]`-class
  values because it never unwrapped the Fact, reported the HY spread's *percent*
  value as basis points (a 3.2% OAS printed as 3.2bp), and carried no
  observation dates. Fixed, with dates and source attached.
- **F03b — batch reports lost their sources.** The batch adapter dropped the
  `server_tool_use` blocks, then the job passed `[]` for sources and `true` for
  `grounded` — so every batched report claimed to be grounded with nothing
  behind it. Sources now survive the adapter and `grounded` is derived.
- **F04 — disclosure was requested, not enforced.** `estimates[]` and
  `unverified[]` were prompt-side only. Now in `ACCURACY_RULES` for all six
  types and required by `REPORT_VALIDATORS`.
- **F05 — fabricated fallbacks still live in the Sales tab.** See the product
  brief; this repo had claimed the class was dead after fixing one instance.
- **F06 — an instrument traded as two different asset classes.** See defect 8.
- **T03 — regime labels mixed levels with directions.** "Bear steepener" was
  emitted from a curve *level*, and could co-occur with "Bear flattener" in the
  same string. Labels now name shape and level only.

Two defects the review did not find, discovered while fixing the ones it did:

- `rateVal()` in `macro.js` probed for a field `getAllRates()` never returns, so
  it returned hardcoded constants on every call — and those constants were sent
  to the live model described as "latest FRED data".
- `checkFreshness()` compared against cache-write time, not observation date, so
  a freshly-cached stale observation passed the 20-minute gate.

One reviewer claim was **not reproduced**: a reported test count of 257 with 4
failures. A clean checkout gave 260 of 261, and now 291 of 292, with the single
date-dependent failure above.

## Provenance audit (after the external review)

A second pass audited every displayed number for whether a reader can tell a
sourced observation (with its date) from a calculation, a model estimate, an
unavailable value or demo data. Summary of what changed:

- `server/provenance.js`: one Fact shape with `observedAt` vs `retrievedAt`, a
  `kind`, and per-source freshness judged on observation date at read time.
- Snapshot: oldest-component freshness (was newest), provenance kept through the
  combined cache and through Zod (which had been stripping unknown keys), FX
  observation time from the provider (was our clock), FRED recovers the latest
  valid value past `.` rows, intl/RSI included in the summary as unavailable.
- Seeds are `DEMO_MODE`-only. Deterministic narrative, brief, engine inputs,
  event calendar and AI prompts no longer carry hand-typed current claims.
- Research: both paths validate against per-type Zod contracts; `grounding`
  metadata; unresolved citations stay visible; `dataAsOf` is an observation span.
- Market meaning: level vs change labelling centralised in `analytics/regime.js`;
  glossary yield/coupon and bear-flattener definitions corrected; HBKS held on
  every path; Shariah screening marked unverified; backtester relabelled as a
  trigger-frequency count on demo data.
- Execution: `executionGate.prepareOrder()` shared by both callers; requires an
  executable timestamped quote (none of the free feeds qualifies), dated FX,
  broker equity and positions; policy refuses missing inputs.

Tests: `tests/dataProvenance.test.js`.

## Recently changed, and the most useful thing to review

The last body of work rebuilt the research pipeline around one problem: reports
asserted figures that were wrong, and the output gave a reader no way to tell a
measured number from an invented one.

What changed:

- `macroContext.js` became the single fact source for all six report types.
  Previously each type fetched only its own data, so an equity report could not
  see crude or the policy path and therefore could not reason about the two
  channels that drive equities hardest.
- Six hardcoded "deterministic" fallback reports were deleted. They rendered
  identically to live research while asserting events that had not happened.
  Failure now returns 503 and the client renders an unavailable panel. A test
  asserts they stay deleted. (The external review then found the same pattern
  still live in `server/routes/macro.js` — deleting one instance of a failure
  class is not deleting the class.)
- Citations from `web_search` now resolve to URLs instead of being stripped.
  `extractJSON` had been removing the closing `</cite>` unconditionally, which
  orphaned the opening tag and made every citation unresolvable — fixed behind a
  `preserveCitations` flag with a regression test.
- The equity schema gained `crossAssetContext`, `rateSensitivity`, `scenarios`,
  `risks[]`, `invalidation`, `estimates[]` and `unverified[]`.

The whole diff: <https://github.com/AbidM06/the-dispatch/pull/1/files>

**The question worth the reviewer's time:** the accuracy mechanism is almost
entirely prompt-side. The schema demands the model declare its estimates and its
unverified claims, and the prompt forbids restating the policy proxy as a
probability. Nothing verifies that it complied. A validator checks that fields
are present, not that they are honest. Is there a structural way to enforce any
of this, or is prompt-side discipline the real ceiling here?
