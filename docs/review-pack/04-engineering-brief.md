# Engineering brief

For the software-engineer review. Written to stop a reviewer spending its budget
rediscovering constraints that were deliberate, and to point it at the files that
matter in a repository of ~27,000 lines.

All paths are relative to the branch `claude/relaxed-brown-8q5ynd`:

```
https://raw.githubusercontent.com/AbidM06/the-dispatch/claude/relaxed-brown-8q5ynd/<path>
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

1. **Spend caps are inert.** `server/providers/budget.js:36-37`:
   ```js
   parseInt(process.env.ANTHROPIC_DAILY_CAP, 10) ?? 5
   ```
   `parseInt(undefined, 10)` returns `NaN`, and `NaN` is neither `null` nor
   `undefined`, so `??` never fires. Both caps are `NaN` when the env vars are
   unset and every comparison against them is false. The daily and monthly spend
   limits are therefore unenforced by default. Known, unfixed, deliberate
   deferral — it was offered as a fix and not taken up.
2. **`web_search` has no `max_uses`.** Per-report search cost is unbounded. Also
   known and deferred.
3. **`client/index.html:6369`** calls `snapshotMeta.source.toUpperCase()` with no
   guard. Any snapshot payload missing `source` white-screens the entire app —
   there is no error boundary. This was found by rendering the app against a
   fixture that omitted the field.
4. **One failing test on a clean checkout.** `tests/phase1.test.js`, "event
   within horizon returns WARN on event risk check" — a date-dependent
   assertion. 260 of 261 pass. It fails on `main` too.
5. **No CI.** No `.github/workflows`. Adding one would go red immediately on
   defect 4.
6. **`README.md` is stale** in two places: it states 227 tests (there are 261)
   and lists five research report types (there are six — it omits equity and
   commodities).

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
  asserts they stay deleted.
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
