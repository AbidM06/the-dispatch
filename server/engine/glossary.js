/**
 * server/engine/glossary.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Comprehensive trading terminology glossary — 80+ terms across 7 categories.
 *
 * Categories:
 *   basics       — fundamental trading concepts
 *   macro        — macroeconomic indicators and monetary policy
 *   technical    — technical analysis
 *   portfolio    — portfolio construction and risk
 *   execution    — order types and trade mechanics
 *   islamic      — Islamic finance and Shariah-compliant investing
 *   interview    — S&T / Asset Management interview concepts
 *
 * Each term:
 *   { term, slug, category, definition, example, islamicNote?, interviewAngle? }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const GLOSSARY = [
  // ── BASICS ────────────────────────────────────────────────────────────────
  {
    term: "Long Position",
    slug: "long",
    category: "basics",
    definition: "Buying an asset with the expectation that its price will rise. You own the asset and profit if it appreciates.",
    example: "You buy 10 shares of AMD at $190. If the price rises to $220, your profit is $300.",
    interviewAngle: "In S&T interviews: 'What's your best LONG idea right now?' — always have one ready with a clear thesis, catalyst, and stop level.",
  },
  {
    term: "Short Position",
    slug: "short",
    category: "basics",
    definition: "Borrowing an asset and selling it with the expectation of buying it back cheaper. Profit from price declines. PROHIBITED under Shariah (gharar — selling what you do not own).",
    example: "Short-seller borrows AMD at $190, sells it, buys back at $150 = $40 profit per share.",
    islamicNote: "Short-selling is prohibited (gharar). The Islamic Fiqh Academy of Mecca ruled that selling goods not in one's possession is invalid. The Dispatch engine never generates SHORT ideas.",
    interviewAngle: "S&T interviewers may ask for short ideas — frame your response around risk management rather than refusing: 'I'd express this bearish view through options or reducing long exposure.'",
  },
  {
    term: "Bid-Ask Spread",
    slug: "bid-ask-spread",
    category: "basics",
    definition: "The difference between the highest price a buyer will pay (bid) and the lowest price a seller will accept (ask). The spread is the cost of immediate liquidity.",
    example: "AMD bid: $192.50, ask: $192.55 — spread of $0.05. If you buy at ask and immediately sell at bid, you lose $0.05/share.",
    interviewAngle: "Tighter spreads = more liquid markets. LSE ETFs like SGLN have wider spreads than NASDAQ stocks — factor this into round-trip cost calculations.",
  },
  {
    term: "Market Capitalisation",
    slug: "market-cap",
    category: "basics",
    definition: "Total market value of a company's outstanding shares. Market cap = share price × shares outstanding.",
    example: "AMD: ~$310B market cap (large cap). Micro caps < $300M.",
    interviewAngle: "Know the rough market cap of any stock you discuss. Interviewers test whether you've done basic homework.",
  },
  {
    term: "Liquidity",
    slug: "liquidity",
    category: "basics",
    definition: "How easily an asset can be bought or sold without significantly affecting its price. High volume = high liquidity = tighter spreads.",
    example: "AAPL trades 50M+ shares/day — highly liquid. A small-cap might trade 5,000 shares — illiquid, large orders move the price significantly.",
    interviewAngle: "Liquidity risk is critical for sizing. In a risk-off event, even normally liquid assets can become illiquid ('liquidity dries up').",
  },
  {
    term: "Volatility",
    slug: "volatility",
    category: "basics",
    definition: "The degree of price variation over time. Typically measured as annualised standard deviation of returns. High volatility = larger price swings in both directions.",
    example: "AMD has ~50% annualised volatility vs S&P 500's ~15%. In practice: AMD can move ±5% in a single day on earnings.",
    interviewAngle: "Implied volatility (IV) from options prices reflects market expectations of future volatility. 'Vol is cheap/rich' is a key S&T concept.",
  },
  {
    term: "Beta",
    slug: "beta",
    category: "basics",
    definition: "Measures how much an asset moves relative to the market (S&P 500). Beta = 1 moves with market. Beta > 1 amplifies moves. Beta < 1 dampens moves.",
    example: "AMD beta ≈ 1.82 — if S&P 500 falls 5%, AMD typically falls ~9.1%. SGLN (gold) beta ≈ -0.08 — barely correlated with equities.",
    interviewAngle: "Portfolio beta is the weighted average of position betas. Your portfolio beta = 0.896 currently — slightly defensive.",
  },
  {
    term: "Alpha",
    slug: "alpha",
    category: "basics",
    definition: "Excess return over a benchmark after adjusting for systematic risk (beta). Alpha > 0 means the manager/strategy outperformed on a risk-adjusted basis.",
    example: "If S&P 500 returns 10% and your portfolio returns 13% with equivalent risk, you generated 3% alpha.",
    interviewAngle: "The central question in asset management: 'Is this alpha or beta?' True alpha is rare and erodes as others copy the strategy.",
  },
  {
    term: "Bull Market",
    slug: "bull-market",
    category: "basics",
    definition: "A sustained period of rising asset prices, typically defined as a 20%+ gain from a recent low. Driven by strong economic fundamentals, earnings growth, and positive sentiment.",
    example: "S&P 500 bull run 2009–2020 (11 years). Cyclically driven by QE, low rates, and tech earnings growth.",
    interviewAngle: "Bull markets die from one of four causes: recession, rising rates crushing valuations, policy error, or external shock.",
  },
  {
    term: "Bear Market",
    slug: "bear-market",
    category: "basics",
    definition: "A sustained period of falling prices — typically defined as a 20%+ decline from a recent high.",
    example: "S&P 500 bear market 2022: -25% peak to trough as the Fed rapidly hiked rates from 0% to 5%.",
    interviewAngle: "Bear markets in equities last ~1.3 years on average vs bull markets ~4 years. Drawdowns are faster and steeper than recoveries.",
  },

  // ── MACRO ─────────────────────────────────────────────────────────────────
  {
    term: "Federal Funds Rate",
    slug: "fed-funds-rate",
    category: "macro",
    definition: "The interest rate at which US banks lend reserves to each other overnight. Set by the FOMC. The base rate for all US borrowing costs.",
    example: "Current target: 4.25–4.50%. When the Fed hikes, mortgages, credit cards, and corporate borrowing all get more expensive.",
    interviewAngle: "Every asset class is priced relative to the risk-free rate. When the Fed hikes: bonds fall, growth stocks compress, dollar strengthens. When it cuts: the opposite.",
  },
  {
    term: "FOMC",
    slug: "fomc",
    category: "macro",
    definition: "Federal Open Market Committee — the Fed committee that sets monetary policy. Meets 8 times per year. Decisions on interest rates, QE/QT, and forward guidance.",
    example: "19 Mar 2026 meeting: market expects hold at 4.25–4.50%. The dot plot (individual member forecasts) often moves markets more than the rate decision itself.",
    interviewAngle: "FOMC day is the highest-impact event for rates traders. Key things to watch: statement language changes, dot plot shifts, and the press conference tone.",
  },
  {
    term: "Dot Plot",
    slug: "dot-plot",
    category: "macro",
    definition: "A chart showing each FOMC member's anonymous projection of where the Fed funds rate will be at year-end for the next 3 years. Released quarterly.",
    example: "If the median dot shifts from 3 cuts to 2 cuts for 2026, markets may reprice rates higher — bond yields rise, equities fall.",
    interviewAngle: "The dot plot is forward guidance made visual. Watch for: how many members are outliers, the long-run neutral rate dot (currently ~2.9%), and shifts from previous meeting.",
  },
  {
    term: "10-Year Treasury Yield (DGS10)",
    slug: "dgs10",
    category: "macro",
    definition: "The annualised interest rate on 10-year US government bonds. The global risk-free reference rate. Drives mortgage rates, corporate borrowing, and equity valuations.",
    example: "DGS10 at 4.21%: a £10,000 10-year Treasury bond pays ~£421/year in interest.",
    interviewAngle: "DGS10 = real yield (DFII10) + inflation expectation (T10YIE). Understanding this decomposition is fundamental to rates trading.",
  },
  {
    term: "Real Yield (DFII10)",
    slug: "real-yield",
    category: "macro",
    definition: "The 10-year Treasury yield adjusted for inflation expectations. Measured by TIPS (Treasury Inflation-Protected Securities). Real yield = nominal yield − breakeven inflation.",
    example: "DGS10 = 4.21%, T10YIE = 2.38%, so DFII10 = 1.83% — the real return above inflation.",
    interviewAngle: "Real yields are the true cost of capital. High real yields crush growth stock P/E multiples because future earnings are worth less in today's money (higher discount rate).",
  },
  {
    term: "Breakeven Inflation (T10YIE)",
    slug: "breakeven-inflation",
    category: "macro",
    definition: "The market's 10-year inflation expectation, derived from the spread between nominal and TIPS yields. Above 2.5% signals inflation concern; below 2.0% signals disinflation.",
    example: "T10YIE = 2.38%: bond markets expect average CPI of 2.38% over 10 years. If actual CPI comes in higher, TIPS holders are compensated.",
    interviewAngle: "Breakeven inflation is the bond market's CPI forecast. It's a real-time sentiment indicator for inflation — used to distinguish 'good inflation' (demand-driven) from 'bad inflation' (supply shock).",
  },
  {
    term: "Yield Curve (T10Y2Y)",
    slug: "yield-curve",
    category: "macro",
    definition: "The spread between 10-year and 2-year Treasury yields. Positive (normal) = long-term rates higher than short-term. Inverted (negative) = historically reliable recession predictor.",
    example: "T10Y2Y = 0.51% (slight positive slope). In 2022–2023 it inverted to -1.08% — the most inverted since the 1980s — preceding the growth scare.",
    interviewAngle: "The yield curve encodes market expectations for growth and monetary policy over two horizons. Flattening = market expects slowdown or Fed tightening to bite. Steepening = growth recovery or inflation return.",
  },
  {
    term: "High-Yield Spread (HY OAS)",
    slug: "hy-spread",
    category: "macro",
    definition: "The yield premium (spread) investors demand to hold sub-investment-grade (junk) bonds over equivalent-maturity Treasuries. Measured as Option-Adjusted Spread (OAS).",
    example: "HY OAS = 3.17%: junk bonds yield 3.17% more than Treasuries. Above 4.5% = credit stress. Below 2.5% = risk-on / complacency.",
    interviewAngle: "HY spreads often lead equity corrections by 4–8 weeks. A spread widening above 4% is the single best early-warning credit indicator. Watch BAMLH0A0HYM2 on FRED.",
  },
  {
    term: "Quantitative Easing (QE)",
    slug: "qe",
    category: "macro",
    definition: "When a central bank buys financial assets (typically government bonds) to inject money into the economy and lower long-term interest rates.",
    example: "Fed QE 2020–2021: balance sheet grew from $4T to $9T. Low rates and abundant liquidity drove the equity bull market and crypto rally.",
    islamicNote: "QE and the interest rate system it operates within are Riba-based. Halal equivalents: murabaha-based sukuk, equity crowdfunding, asset-backed instruments.",
    interviewAngle: "QE suppressed the risk-free rate, inflating all asset prices. QT (quantitative tightening) — the reverse — removes liquidity and raises long-end rates. Understanding the Fed's balance sheet trajectory is essential for rates strategy.",
  },
  {
    term: "Quantitative Tightening (QT)",
    slug: "qt",
    category: "macro",
    definition: "When a central bank reduces its balance sheet by letting bonds mature without reinvestment or by selling assets. Removes liquidity from the financial system.",
    example: "Fed QT since 2022: allowing ~$60B/month of Treasury and MBS bonds to roll off. Raises long-end yields by reducing demand for bonds.",
    interviewAngle: "QT is 'passive hiking' — it adds upward pressure to long-end yields even without rate hikes. A key macro headwind for duration assets.",
  },
  {
    term: "CPI (Consumer Price Index)",
    slug: "cpi",
    category: "macro",
    definition: "A weighted basket measure of consumer price inflation. The Fed's primary inflation gauge alongside PCE. Released monthly by the BLS.",
    example: "CPI 3.0% YoY: prices are 3% higher than a year ago. Core CPI (ex-food & energy) is the 'stickier' measure the Fed watches most closely.",
    interviewAngle: "CPI surprise is a major market mover. A hot print (above consensus) → rates up, equities down. A cool print → rates down, equities up. The AMd earnings comparison: AMD Q1 revenue vs estimates is the same logic — surprise direction matters.",
  },
  {
    term: "Non-Farm Payrolls (NFP)",
    slug: "nfp",
    category: "macro",
    definition: "US monthly jobs report — the number of non-agricultural jobs added or lost. Released first Friday of each month. One of the most market-moving data points.",
    example: "NFP +250k vs estimate +180k: stronger-than-expected labour market → Fed less likely to cut → yields rise.",
    interviewAngle: "Payrolls signal the health of the consumer (70% of US GDP is consumption). Strong NFP is good for equities normally but in a hiking cycle it means rates stay higher longer.",
  },
  {
    term: "Bear Steepener",
    slug: "bear-steepener",
    category: "macro",
    definition: "When the yield curve steepens because long-end rates rise faster than short-end rates. Called 'bear' because bond prices fall as yields rise.",
    example: "30Y yield rises 20bps while 2Y rises 5bps → curve steepens 15bps. This happened in 2023 when supply concerns pushed long bonds higher.",
    interviewAngle: "Bear steepeners are negative for long-duration bonds, negative for growth stocks, but mixed for banks (higher NIM). A bear FLATTENER (short end rises faster) signals aggressive hiking expectations.",
  },
  {
    term: "Stagflation",
    slug: "stagflation",
    category: "macro",
    definition: "Simultaneous high inflation AND slowing growth — the worst macro environment for central banks (rate hikes fight inflation but worsen growth).",
    example: "1970s oil shocks: CPI 13%, GDP negative. Classic asset playbook: gold, commodities, real assets outperform equities and bonds.",
    interviewAngle: "The policy dilemma: hike to fight inflation → recession. Cut to support growth → inflation accelerates. Stagflation historically benefits gold, real assets, and short-duration quality equities.",
  },

  // ── TECHNICAL ─────────────────────────────────────────────────────────────
  {
    term: "Moving Average (MA)",
    slug: "moving-average",
    category: "technical",
    definition: "The average price over a rolling window of N periods. Smooths out noise to identify trend direction. Simple MA (SMA) vs Exponential MA (EMA — weights recent prices more).",
    example: "50-day SMA of AMD: if current price is above the 50-day average, the trend is up. Crossovers (50d crossing 200d) are major technical signals.",
    interviewAngle: "MAs are lagging indicators — they confirm trends rather than predict them. In macro: The Dispatch uses 3-month vs 6-month DGS10 moving average as a rates regime signal.",
  },
  {
    term: "RSI (Relative Strength Index)",
    slug: "rsi",
    category: "technical",
    definition: "A momentum oscillator measuring the speed and magnitude of recent price changes. Scale 0–100. Above 70 = overbought; below 30 = oversold.",
    example: "AMD RSI at 72: technically overbought — momentum may be exhausting. Traders fade extremes or wait for RSI to cross back below 70 before shorting.",
    islamicNote: "RSI is a pure technical indicator — no Shariah concerns. It helps with timing of halal long trades and avoiding overpaying at momentum peaks.",
    interviewAngle: "RSI divergence is the powerful signal: price makes new high but RSI doesn't = hidden weakness. Used for timing rather than direction.",
  },
  {
    term: "Support and Resistance",
    slug: "support-resistance",
    category: "technical",
    definition: "Price levels where an asset repeatedly finds buyers (support) or sellers (resistance). These levels form because market participants have anchored expectations at those prices.",
    example: "AMD support at $175: the price bounced off this level three times. If it breaks below, $175 becomes resistance (prior support becomes resistance).",
    interviewAngle: "Support/resistance levels are self-fulfilling because everyone sees them. In S&T: 'Where's your stop?' — place it just below support so you're not stopped out by noise.",
  },
  {
    term: "Breakout",
    slug: "breakout",
    category: "technical",
    definition: "When price moves decisively above resistance or below support, often with high volume. Signals a potential new trend direction.",
    example: "AMD consolidates between $185–$200 for 3 weeks. A breakout above $200 with 2× average volume signals institutional buying — potential new leg to $220+.",
    interviewAngle: "Distinguish 'real' breakouts (volume confirmation, catalyst) from false breakouts (low volume, no news). False breakouts are fade opportunities.",
  },
  {
    term: "Momentum",
    slug: "momentum",
    category: "technical",
    definition: "The tendency for assets with strong recent performance to continue outperforming. 'Trend following' at the individual stock level. Strongest over 3–12 month horizons in academic research.",
    example: "Cross-sectional momentum: buy the top quintile of 12-month performers, short the bottom. Time-series momentum: buy an asset when it's up over the past 12 months.",
    interviewAngle: "Momentum is one of the most robust documented equity 'factors' but has brutal drawdowns during reversals (2009, 2020). Know the academic basis: Jegadeesh & Titman (1993).",
  },
  {
    term: "Mean Reversion",
    slug: "mean-reversion",
    category: "technical",
    definition: "The tendency for extreme price moves to revert toward the historical average over time. Based on the statistical concept that most processes are stationary.",
    example: "If AMD trades 2 standard deviations above its 6-month mean, a mean reversion strategy would position for a pullback to the mean.",
    interviewAngle: "Mean reversion and momentum are opposing strategies — both can be profitable in the right regime. Mean reversion works better in range-bound markets; momentum in trending markets.",
  },
  {
    term: "Volume",
    slug: "volume",
    category: "technical",
    definition: "The total number of shares traded in a given period. High volume on a price move confirms the move; low volume suggests it may be a false signal.",
    example: "AMD volume 30M on a breakout vs average 18M/day — 1.67× average. This is confirming volume suggesting institutional participation.",
    interviewAngle: "Volume precedes price is a market axiom. Institutional accumulation often shows up as above-average volume before a price move.",
  },

  // ── PORTFOLIO ─────────────────────────────────────────────────────────────
  {
    term: "Diversification",
    slug: "diversification",
    category: "portfolio",
    definition: "Spreading investments across uncorrelated assets to reduce portfolio-level volatility without proportionally reducing expected returns. The only 'free lunch' in finance.",
    example: "Holding AMD (high-beta tech) + SGLN (gold, negative equity beta) reduces portfolio drawdowns because they tend to move in opposite directions.",
    interviewAngle: "Diversification only works when correlations are low. In a crisis ('risk-off'), correlations spike toward 1.0 — everything falls together. This is correlation breakdown risk.",
  },
  {
    term: "HHI (Herfindahl-Hirschman Index)",
    slug: "hhi",
    category: "portfolio",
    definition: "Concentration measure: HHI = Σ(weightᵢ²) × 10,000. Below 1,000 = well-diversified; 1,000–2,500 = concentrated; above 2,500 = highly concentrated.",
    example: "Portfolio with equal 16.7% in 6 assets: HHI = 6 × (0.167²) × 10,000 = 1,667. Your current HHI is ~2,200 — moderately concentrated.",
    interviewAngle: "HHI comes from antitrust law (market concentration). In portfolio management: HHI above 2,500 is the threshold for 'too concentrated.' Reducing HHI = adding uncorrelated positions.",
  },
  {
    term: "Correlation",
    slug: "correlation",
    category: "portfolio",
    definition: "Statistical measure of how two assets move together. Ranges from -1 (perfect inverse) to +1 (perfect co-movement). 0 = no relationship.",
    example: "AMD and NVDA correlation: ~0.85 (move together). AMD and SGLN: ~-0.05 (essentially uncorrelated). Adding SGLN reduces portfolio volatility despite adding an asset.",
    interviewAngle: "Portfolio volatility = weighted sum of covariances, not individual volatilities. Two high-volatility assets with zero correlation produce a portfolio with lower volatility than either alone.",
  },
  {
    term: "Sharpe Ratio",
    slug: "sharpe-ratio",
    category: "portfolio",
    definition: "Risk-adjusted return: (Portfolio Return − Risk-Free Rate) ÷ Portfolio Volatility. Higher = better risk-adjusted performance. Above 1.0 is considered good; above 2.0 is excellent.",
    example: "Portfolio return 12%, risk-free 4.5%, volatility 15%: Sharpe = (12−4.5)/15 = 0.5. Mediocre. Warren Buffett's long-run Sharpe ≈ 0.76.",
    islamicNote: "The risk-free rate used in Sharpe ratio is T-bills (riba-based). Islamic alternative: use Sukuk yield or an inflation measure as the baseline.",
    interviewAngle: "Sharpe ratio is the most common risk-adjusted metric in performance reporting. Know how to calculate it instantly and understand its limitations: it penalises upside volatility equally with downside.",
  },
  {
    term: "Maximum Drawdown",
    slug: "max-drawdown",
    category: "portfolio",
    definition: "The largest peak-to-trough percentage decline in a portfolio or asset over a given period. Measures the worst-case loss an investor could have experienced.",
    example: "AMD 2022 drawdown: -65% peak to trough. If you bought at the peak ($164) and held through the bottom ($54), your max drawdown was 67%.",
    interviewAngle: "Max drawdown tells you the pain an investor would have had to endure. Drawdown recovery time matters as much as depth: a 50% drawdown requires a 100% gain to recover.",
  },
  {
    term: "Position Sizing",
    slug: "position-sizing",
    category: "portfolio",
    definition: "Determining how much capital to allocate to each trade based on risk budget, conviction, and portfolio context. The most underrated skill in trading.",
    example: "Fixed-fraction risk: risk 0.5% of £1,110 (£5.55) per trade. Entry £192, stop £175, risk/share £17, so size = £5.55/£17 = 0.33 shares ≈ £63 notional.",
    interviewAngle: "Kelly Criterion is the theoretical optimal sizing formula: f = (p × b − q) / b where p = win probability, b = reward/risk ratio. In practice, use half-Kelly (Kelly is too aggressive).",
  },
  {
    term: "R-Multiple",
    slug: "r-multiple",
    category: "portfolio",
    definition: "Trade outcome expressed as a multiple of initial risk. If risk per trade is £10 and you profit £25, outcome is +2.5R. Target a minimum 1.5R reward-to-risk on all trades.",
    example: "AMD: entry $192, stop $175, target $225. Risk = $17, reward = $33. R-multiple = 33/17 = 1.94R. Only take trades ≥1.5R.",
    interviewAngle: "Expectancy = (hit rate × avg win R) + (stop rate × avg loss R). With 40% hit rate and 2.0R average win, 60% stops and -1.0R average loss: expectancy = 0.4×2.0 + 0.6×(-1.0) = +0.2R per trade.",
  },
  {
    term: "Expectancy",
    slug: "expectancy",
    category: "portfolio",
    definition: "The average profit or loss expected per unit of risk over many trades. Expectancy = (Win Rate × Avg Win) − (Loss Rate × Avg Loss). Positive expectancy is the goal.",
    example: "40% win rate, average win 2R, average loss 1R: Expectancy = (0.4 × 2R) − (0.6 × 1R) = 0.8R − 0.6R = +0.2R per trade. Over 100 trades: expect +20R profit.",
    interviewAngle: "Most retail traders focus on win rate. Professionals focus on expectancy. A 30% win rate with 3R average wins and 1R average losses has better expectancy than a 70% win rate with 0.5R wins and 1R losses.",
  },
  {
    term: "Carry",
    slug: "carry",
    category: "portfolio",
    definition: "Income earned from holding an asset: coupon for bonds, dividends for equities, interest rate differential for FX. Positive carry = asset pays more than it costs to hold.",
    example: "HBKS sukuk ETF provides carry (income) from sukuk coupons. Positive carry means you earn while waiting for price appreciation.",
    islamicNote: "Conventional bond carry involves riba (interest). Sukuk carry is from profit-sharing or lease payments (ijara), which is Shariah-compliant as it represents real economic activity.",
    interviewAngle: "FX carry trade: borrow in low-rate currency (JPY at 0.1%), invest in high-rate currency (USD at 4.5%), pocket the 4.4% differential. Works until it doesn't — carry unwinds are violent.",
  },
  {
    term: "Duration",
    slug: "duration",
    category: "portfolio",
    definition: "A bond's price sensitivity to a 1% change in interest rates. Modified duration = % price change per 100bps rate move. A 7-year duration bond falls ~7% if rates rise 1%.",
    example: "HBKS has ~3-year duration. If rates rise 1%, HBKS falls ~3% from duration alone. The higher the duration, the more interest rate risk.",
    islamicNote: "Duration is purely a risk measurement concept — applicable to both conventional bonds and sukuk equally. Longer-duration sukuk has the same interest rate sensitivity.",
    interviewAngle: "In a rates rising environment: reduce duration (sell long bonds, buy short-term). In a rates falling environment: add duration to maximise price appreciation.",
  },

  // ── EXECUTION ─────────────────────────────────────────────────────────────
  {
    term: "Market Order",
    slug: "market-order",
    category: "execution",
    definition: "An order to buy or sell immediately at the best available price. Guarantees execution but NOT price. In illiquid markets, can result in significant slippage.",
    example: "Market buy of 100 AMD shares: executes at $192.55 (the ask). Slippage risk: low for liquid large-caps; high for illiquid small-caps.",
    interviewAngle: "S&T desks almost never use market orders for large sizes — they use algorithms (VWAP, TWAP) to minimise market impact. Retail traders pay the spread on every market order.",
  },
  {
    term: "Limit Order",
    slug: "limit-order",
    category: "execution",
    definition: "An order to buy/sell only at a specified price or better. Guarantees price but NOT execution. Useful for precise entry/exit levels.",
    example: "Limit buy AMD at $190.00: order only fills if AMD trades at $190.00 or lower. May never fill if AMD never reaches that level.",
    interviewAngle: "Limit orders add liquidity to the market (they become the bid/ask). Market orders remove liquidity. Exchanges give rebates to liquidity providers — a key concept in market microstructure.",
  },
  {
    term: "Stop-Loss Order",
    slug: "stop-loss",
    category: "execution",
    definition: "An order that automatically closes a position when the price reaches a predetermined level. Limits downside risk. Can be a stop-market (fills at market when stop is triggered) or stop-limit.",
    example: "Long AMD at $192, stop-loss at $175: if AMD falls to $175, the stop triggers and sells at market. Maximum loss is capped at $17/share.",
    islamicNote: "Stop-loss orders are Shariah-compliant — they are tools for risk management within a permitted long position, not speculation.",
    interviewAngle: "Stop placement is an art: too tight = stopped out by noise; too wide = too much risk. Professional traders: stop below a key technical level (support), not a round number where many stops cluster.",
  },
  {
    term: "Take Profit",
    slug: "take-profit",
    category: "execution",
    definition: "A pre-set level at which a position is automatically closed to lock in gains. Removes emotion from the exit decision.",
    example: "Long AMD at $192, take profit at $225. When AMD hits $225, position automatically closes for a $33/share gain.",
    interviewAngle: "Professional traders often scale out of positions: take 50% off at first target, trail stop on remainder. Prevents leaving all gains on the table while staying in a winner.",
  },
  {
    term: "Bracket Order",
    slug: "bracket-order",
    category: "execution",
    definition: "A single order combining an entry with both a take-profit and a stop-loss. All three legs are placed simultaneously as one atomic order.",
    example: "Buy 5 AMD at $192 limit, take profit at $225, stop-loss at $175. Three orders placed at once — fully automated trade management.",
    islamicNote: "Bracket orders are Shariah-compliant when used for long positions in halal stocks. They automate risk management without introducing gharar.",
    interviewAngle: "Bracket orders are standard in algorithmic trading. The Dispatch uses them via Alpaca when USE_BRACKET_ORDERS=true.",
  },
  {
    term: "Slippage",
    slug: "slippage",
    category: "execution",
    definition: "The difference between the expected execution price and the actual execution price. Caused by market impact, latency, or illiquidity.",
    example: "You intend to buy AMD at $192.50 but the market order fills at $192.65 — $0.15 slippage per share. On 100 shares: $15 slippage cost.",
    interviewAngle: "Slippage is a hidden transaction cost. For large orders, it can dwarf the explicit commission. VWAP and TWAP algorithms are designed to minimise slippage.",
  },
  {
    term: "VWAP (Volume-Weighted Average Price)",
    slug: "vwap",
    category: "execution",
    definition: "The average price weighted by volume traded throughout the day. Institutional benchmark — buying below VWAP is considered good execution.",
    example: "AMD trades 2M shares at $190 in the morning, 1M at $195 in the afternoon. VWAP = (2M×$190 + 1M×$195)/3M = $191.67.",
    interviewAngle: "Institutional traders measure execution quality against VWAP. 'Did you execute above or below VWAP?' is a key metric. VWAP algos spread orders throughout the day in proportion to expected volume.",
  },

  // ── ISLAMIC FINANCE ────────────────────────────────────────────────────────
  {
    term: "Riba",
    slug: "riba",
    category: "islamic",
    definition: "Arabic for 'increase' or 'excess' — refers to interest or usury. Any predetermined, guaranteed return on money lending. Strictly prohibited in Islam. Affects conventional banks, bonds, and margin accounts.",
    example: "A conventional bank loan at 7% interest: the bank charges more than the principal lent, regardless of economic outcome. This predetermined excess is riba.",
    interviewAngle: "Islamic finance replaces riba with profit-sharing (musharakah), cost-plus financing (murabaha), and lease-based structures (ijara). Same economic function, different legal structure.",
  },
  {
    term: "Gharar",
    slug: "gharar",
    category: "islamic",
    definition: "Excessive uncertainty or ambiguity in a financial contract that could lead to exploitation. Includes short-selling (selling what you don't own), options, and highly speculative derivatives.",
    example: "Short-selling: borrowing AMD shares and selling them — you've sold an asset you don't own, creating an uncertain obligation. This is gharar.",
    interviewAngle: "The gharar prohibition is why Islamic finance avoids most derivatives. The underlying asset must exist and be owned. Forwards and options create obligations on non-existent or unowned assets.",
  },
  {
    term: "Maysir / Qimar",
    slug: "maysir",
    category: "islamic",
    definition: "Gambling — any transaction where wealth is acquired by chance rather than productive effort. Includes betting, lotteries, and highly speculative instruments.",
    example: "Penny stock speculation with no fundamental basis = maysir. Day-trading on pure price momentum without analysis edge can have maysir characteristics.",
    interviewAngle: "The distinction between acceptable risk-taking (investment) and maysir: investment involves real economic activity and skill-based research; maysir is pure chance. Fundamental analysis is the Islamic justification for equity investing.",
  },
  {
    term: "Sukuk",
    slug: "sukuk",
    category: "islamic",
    definition: "Islamic bonds structured as ownership certificates in an underlying asset (ijara/lease) rather than debt. Holders receive rental income rather than interest. Shariah-compliant fixed income.",
    example: "HBKS: iShares MSCI UK Islamic UCITS ETF holds sukuk — the fund owns real assets leased back to issuers. The 'coupon' is rental income, not interest.",
    interviewAngle: "Sukuk global market: ~$3.5 trillion outstanding. GCC sovereign issuers (Saudi Arabia, UAE, Malaysia) are the largest. Sukuk spreads trade similarly to conventional bonds but with Islamic jurisprudence overlay.",
  },
  {
    term: "Murabaha",
    slug: "murabaha",
    category: "islamic",
    definition: "Cost-plus financing — the bank buys an asset at cost and sells it to the customer at a disclosed markup, payable in instalments. The alternative to interest-bearing loans.",
    example: "Islamic mortgage: bank buys property for £300,000, sells to customer for £390,000 payable over 25 years. The £90,000 'profit' is agreed upfront — not compound interest.",
    interviewAngle: "Murabaha is the most common Islamic finance instrument (~75% of Islamic banking). The key: price is fixed upfront, no compounding. Late payment penalties go to charity, not the bank.",
  },
  {
    term: "Musharakah",
    slug: "musharakah",
    category: "islamic",
    definition: "Islamic partnership — a joint venture where all partners share profits AND losses proportionally. The closest Islamic equivalent to equity investment.",
    example: "Two investors contribute £50,000 each to buy a property. Profits from rental income are split 50/50. If the property falls in value, losses are also shared.",
    interviewAngle: "Musharakah is the Islamic justification for buying common stock — shareholders share in both the profits and losses of the business. Preferred stock (fixed dividend) is closer to riba.",
  },
  {
    term: "Halal Screening",
    slug: "halal-screening",
    category: "islamic",
    definition: "The process of selecting Shariah-compliant investments using business activity screens (no haram sectors) and financial ratio screens (debt ≤ 33% assets, interest income ≤ 5% revenue).",
    example: "Apple passes screens: no haram revenue, debt/assets ≈ 27% (below 33% threshold), interest income < 5% of revenue. Included in DJIM and S&P 500 Shariah.",
    interviewAngle: "DJIM (Dow Jones Islamic Market), FTSE Shariah, and S&P 500 Shariah are the three main halal equity indices. Each has slightly different screening methodologies. DJIM is most widely used.",
  },
  {
    term: "DJIM (Dow Jones Islamic Market Index)",
    slug: "djim",
    category: "islamic",
    definition: "The world's first Islamic equity benchmark. Screens global equities for Shariah compliance using business activity and financial ratio criteria. Published by S&P Dow Jones Indices.",
    example: "DJIM covers 5,000+ stocks across 65 countries. 3,500+ US stocks qualify. All tickers in The Dispatch engine's SHARIAH_UNIVERSE are cross-referenced against DJIM.",
    interviewAngle: "Islamic AUM (Assets Under Management) is ~$4 trillion globally and growing at 10%/year. Understanding DJIM methodology is valuable for Islamic finance-focused roles at GCC banks or HSBC Amanah.",
  },

  // ── INTERVIEW CONCEPTS ─────────────────────────────────────────────────────
  {
    term: "Market Making",
    slug: "market-making",
    category: "interview",
    definition: "A firm or individual that continuously quotes both a bid price and an ask price for a security, profiting from the spread while providing liquidity to the market.",
    example: "Goldman Sachs as AMD market maker: quotes $192.50/$192.55. When client buys at $192.55 and another sells at $192.50, GS earns $0.05 spread × volume.",
    interviewAngle: "S&T interview question: 'Walk me through how market making works.' Key answer points: 1) earn the spread 2) manage inventory risk 3) hedge delta 4) lose when market moves against inventory before you can hedge.",
  },
  {
    term: "Flow Trading",
    slug: "flow-trading",
    category: "interview",
    definition: "Trading driven by client order flow rather than proprietary directional views. A flow trader executes client orders and risk-manages the resulting inventory.",
    example: "A pension fund wants to buy £50M of NVDA. The flow trader buys £50M from the pension, now long NVDA. They hedge the risk: sell NVDA futures or buy puts until they can unwind the position.",
    interviewAngle: "Most S&T roles are flow-oriented, not prop trading. When asked 'what does a trader do?': process client flow, risk-manage inventory, generate ideas for clients, NOT just make directional bets.",
  },
  {
    term: "Prop Trading",
    slug: "prop-trading",
    category: "interview",
    definition: "Proprietary trading — a firm trading with its own capital for its own profit, rather than on behalf of clients. Mostly moved to hedge funds post-Volcker Rule (2010).",
    example: "Citadel, Jane Street, Two Sigma: pure prop shops. Goldman Sachs equity prop desk was closed post-Volcker; their risk tolerance now comes from market-making inventory.",
    interviewAngle: "Post-Volcker Rule, banks have minimal prop trading. Hedge funds dominate directional prop bets. Be clear in interviews about the distinction: S&T = flow + client risk management; hedge funds = prop.",
  },
  {
    term: "Pitch Book / Investment Thesis",
    slug: "investment-thesis",
    category: "interview",
    definition: "A structured argument for why a particular investment will outperform. Requires: what you're buying/selling, why it's mispriced, what the catalyst is, what would invalidate the thesis, and entry/exit levels.",
    example: "AMD LONG thesis: Real yields compressing on FOMC dovish shift → P/E expansion; MI450 GPU ramp underpriced by market; Q1 guide beat likely; stop at 200-day MA.",
    interviewAngle: "Every S&T / AM interview ends with 'give me your best trade idea.' Structure: 1) What 2) Why now (catalyst) 3) What's the risk (stop/invalidation) 4) Size/conviction. Practice until it's 90 seconds and crisp.",
  },
  {
    term: "Macro Regime",
    slug: "macro-regime",
    category: "interview",
    definition: "The prevailing macroeconomic environment that determines which assets and strategies tend to perform. Classified by growth trajectory, inflation, and monetary policy stance.",
    example: "Current regime: Bear flattener + Risk-off (HY OAS rising, real yields elevated). Playbook: gold, defensive equities, reduce growth stock exposure.",
    interviewAngle: "Bridgewater's framework: 4 regimes based on Growth and Inflation (above/below expectations). Each regime has a characteristic 'all-weather' asset allocation. This is the conceptual underpinning of The Dispatch's engine.",
  },
  {
    term: "Factor Investing",
    slug: "factor-investing",
    category: "interview",
    definition: "Investing in systematic exposures to documented return premia: Value, Momentum, Quality, Size, Low Volatility. Also called 'smart beta' or 'systematic equity'.",
    example: "Buying a value ETF (low P/E stocks): you're harvesting the value premium — documented since Fama & French (1992). Each factor has academic backing and intuitive risk story.",
    interviewAngle: "Know the five Fama-French factors: Market, Size (SMB), Value (HML), Profitability (RMW), Investment (CMA). And the additional Momentum factor (Carhart). Most quant funds decompose returns into these factors.",
  },
  {
    term: "Convexity",
    slug: "convexity",
    category: "interview",
    definition: "The curvature in the price-yield relationship for bonds. Positive convexity: bond prices rise more for a rate decline than they fall for an equal rate rise. Favours holders in volatile rate environments.",
    example: "10Y bond with 8 years duration and 0.7 convexity: 1% rate drop → +8.7% price gain (not just 8%). Convexity adds to the gain.",
    interviewAngle: "MBS (mortgage-backed securities) have negative convexity — they get 'called away' when rates fall (homeowners refinance). This is why MBS requires a convexity premium. Know this for fixed income S&T roles.",
  },
  {
    term: "Greeks (Delta, Gamma, Vega, Theta)",
    slug: "greeks",
    category: "interview",
    definition: "Option sensitivity measures. Delta: price sensitivity to underlying move. Gamma: rate of change of delta. Vega: sensitivity to volatility. Theta: daily time decay.",
    example: "AMD call option delta 0.6: if AMD rises $1, the call gains ~$0.60. Delta hedging: sell 60 shares of AMD per 100 calls to be delta-neutral.",
    islamicNote: "Options are generally prohibited (gharar) in Islamic finance. Understanding the Greeks is important for education but The Dispatch engine never generates options-based ideas.",
    interviewAngle: "Derivatives S&T roles require fluent Greeks knowledge. Key interview question: 'If you're long gamma, what do you want the market to do?' Answer: move a lot, in either direction (you dynamically delta-hedge and profit from large moves).",
  },
  {
    term: "Basis Risk",
    slug: "basis-risk",
    category: "interview",
    definition: "The residual risk when a hedge does not perfectly offset the underlying exposure due to differences in maturity, geography, credit quality, or reference asset.",
    example: "You hold AMD (semiconductor) and hedge with QQQ (tech ETF). Basis risk: AMD can underperform QQQ significantly on idiosyncratic news (earnings miss). The hedge isn't perfect.",
    interviewAngle: "Basis risk is why no hedge is free. The more specific the hedge (single-stock put), the lower the basis risk but the higher the cost. The more general (index hedge), the cheaper but more basis risk. Know this tradeoff.",
  },
];

// ── Index by slug and category ─────────────────────────────────────────────────

const BY_SLUG     = Object.fromEntries(GLOSSARY.map(t => [t.slug, t]));
const BY_CATEGORY = {};
for (const term of GLOSSARY) {
  if (!BY_CATEGORY[term.category]) BY_CATEGORY[term.category] = [];
  BY_CATEGORY[term.category].push(term);
}

const CATEGORIES = ["basics", "macro", "technical", "portfolio", "execution", "islamic", "interview"];

// ── Term of the day (deterministic by date) ────────────────────────────────────

function getTermOfTheDay() {
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const idx      = dayIndex % GLOSSARY.length;
  return GLOSSARY[idx];
}

// ── Search ─────────────────────────────────────────────────────────────────────

function searchGlossary(query) {
  const q = query.toLowerCase().trim();
  return GLOSSARY.filter(t =>
    t.term.toLowerCase().includes(q) ||
    t.slug.includes(q) ||
    t.definition.toLowerCase().includes(q) ||
    t.category.toLowerCase().includes(q)
  );
}

module.exports = {
  GLOSSARY,
  BY_SLUG,
  BY_CATEGORY,
  CATEGORIES,
  getTermOfTheDay,
  searchGlossary,
};
