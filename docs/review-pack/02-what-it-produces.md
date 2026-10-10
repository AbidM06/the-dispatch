# What The Dispatch actually produces

A reviewer judging the product needs to see the output, not the feature list.
This file describes the shape of what the app generates. Live examples require
API keys, so what is reproduced here is the contract — the schema the model is
required to fill — which is the honest thing to review, because it is what
determines the ceiling on the output.

## Research report — the equity note

The most developed of the six. Claude is given a block of verified FRED figures
and told not to search for anything already supplied, then must return JSON
matching this shape (abridged; full version in
`server/providers/anthropic.js`):

```
abstract[]              3 takeaways, one of which must cover the principal risk
epsOutlook              2026 / 2027: EPS growth, EPS level, revenue growth, margin bp
crossAssetContext
  energyChannel         crude level → equity impact → severity HIGH|MEDIUM|LOW
  rateChannel           10Y real yield → multiple implications → severity
  policyChannel         derived proxy direction, must be labelled a proxy
  volatilityRegime      VIX → one-sentence impact
  synthesis             tailwind or headwind, and does it move you off consensus
rateSensitivity         current vs long-run forward P/E, index impact of 100bp
                        on the 10Y real, implied downside on mean reversion
scenarios               bear / base / bull, each with probability, trigger,
                        EPS outcome, index outcome, 3-sentence narrative
risks[]                 min 4, each tagged to a channel, with quantified EPS impact
invalidation            observable conditions that would prove the thesis wrong
megaCapContribution     market-cap share, earnings share, EPS growth contribution,
                        the actual names, and what breaks if they disappoint
aiProductivityLift      EPS effect, adoption status, and capex sustainability —
                        explicitly required to distinguish hyperscaler economics
                        from pure-play model developers
sectorViews[]           stance, rationale, key risk, oil sensitivity, rate sensitivity
amdImplications         single-name read-through to the owner's main position
consensusComparison     vs bottom-up and top-down consensus, with numbers
estimates[]             every figure the model produced itself: the number, where
                        it appears, what it derives from, confidence
unverified[]            every claim it could not confirm
```

Two of these are the accuracy mechanism rather than analysis: `estimates[]` is
the model declaring which numbers are its own forecasts, and `unverified[]` is
it admitting what it could not stand up. Both render as separate tables in the
UI, below the report.

**Worth attacking in review:** whether a schema this prescriptive produces
genuine analysis or well-formatted filling-in. The counter-argument in the code
is that the previous equity schema had no risk container at all and so produced
no risk analysis — absent fields produce absent thinking. Whether the fix
overcorrected is exactly the kind of judgement an outside reviewer should make.

## Morning bulletin

Generated on a schedule. Headline, regime label, scenarios, cross-asset table,
central bank section, catalysts, and a one-minute pitch script intended to be
read aloud. Optionally cross-checked against verified live X/Twitter sentiment.

## Trade ideas

Produced by a playbook engine, not free-form. Each idea carries direction,
entry, target, stop, horizon, confidence, size percentage, an invalidation
condition, and the playbook that generated it. Short positions are rejected
outright on Shariah grounds. Ideas persist to a JSONL log with an approval
workflow before anything can execute.

## Snapshot and analytics

Live rates with a source and staleness badge on every figure, correlation
matrices, momentum scans, an MA-crossover backtest with an in-sample /
out-of-sample split, and a scenario engine that decomposes P&L impact into
equity, rates and FX components.

## The degradation behaviour, which is itself a product decision

Every figure on screen carries where it came from and whether it is stale. When
a provider fails the UI says so rather than substituting a plausible number.
When AI generation fails the research route returns 503 and the UI renders an
unavailable panel — it does not serve a cached essay that reads like today's
research. This was a deliberate reversal of earlier behaviour and is a fair
thing to challenge: a reviewer may reasonably think an unavailable panel is
worse than a clearly-labelled stale report.
