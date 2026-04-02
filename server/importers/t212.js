/**
 * server/importers/t212.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Parses a Trading 212 "Freestyle" (PIE) CSV export and normalises it into
 * a portfolio snapshot that portfolio.js and scenario.js can consume instead
 * of the manually maintained seeds.
 *
 * T212 Freestyle CSV format (as of Mar 2026):
 *   "Slice","Name","Invested value","Value","Result","Owned quantity",
 *   "Dividends gained","Dividends cash","Dividends reinvested"
 *
 * All monetary values are in GBP (account currency) even for USD instruments.
 *
 * Snapshot file: /data/portfolio_snapshot.json  (gitignored)
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const SNAPSHOT_PATH = path.join(__dirname, "..", "..", "data", "portfolio_snapshot.json");

// Tickers traded in USD on T212 (the rest are assumed GBP).
// T212 converts to GBP account currency in the CSV regardless.
const USD_TICKERS = new Set(["AMD", "NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX", "IBM", "INTC", "TSM"]);

// ── CSV parser ────────────────────────────────────────────────────────────────

/**
 * Parse a single CSV line, handling quoted fields.
 * T212 wraps every field in double-quotes.
 */
function parseLine(line) {
  const result = [];
  let current  = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Safely parse a number string; returns NaN for "N/A", "-", "".
 */
function parseNum(s) {
  if (!s || s === "N/A" || s === "-") return NaN;
  return parseFloat(s.replace(/,/g, ""));
}

/**
 * parseCsv(csvText, usdgbp) → { positions, totalInvestedGBP, totalValueGBP, importedAt }
 *
 * @param {string} csvText   Raw CSV string from T212 Freestyle export.
 * @param {number} usdgbp    Current USD/GBP rate — used to back-calculate native USD prices.
 *
 * @returns {{
 *   positions: Array<{
 *     ticker:                 string,
 *     name:                   string,
 *     shares:                 number,
 *     currency:               "USD"|"GBP",
 *     costGBP_total:          number,   // total cost basis in GBP  (use directly — no × shares)
 *     snapshotValueGBP_total: number,   // T212 live value in GBP
 *     snapshotPriceNative:    number,   // back-calculated price in native ccy (USD for AMD etc.)
 *   }>,
 *   totalInvestedGBP: number,
 *   totalValueGBP:    number,
 *   importedAt:       string,           // ISO timestamp
 * }}
 */
function parseCsv(csvText, usdgbp) {
  if (!usdgbp || isNaN(usdgbp) || usdgbp <= 0) {
    throw new Error("t212.parseCsv: usdgbp must be a positive number");
  }

  const lines = csvText
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length < 2) {
    throw new Error("t212.parseCsv: CSV appears empty or has only a header row");
  }

  // Expect header: Slice, Name, Invested value, Value, Result, Owned quantity, ...
  const header = parseLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, "_"));
  const colIdx = {
    slice:    header.indexOf("slice"),
    name:     header.indexOf("name"),
    invested: header.findIndex(h => h.includes("invested")),
    value:    header.findIndex(h => h === "value"),
    qty:      header.findIndex(h => h.includes("owned")),
  };

  const missing = Object.entries(colIdx)
    .filter(([, v]) => v === -1)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`t212.parseCsv: missing expected columns: ${missing.join(", ")}. ` +
      "Export a T212 Freestyle CSV from Holdings → Export.") ;
  }

  const positions = [];
  let totalInvestedGBP = 0;
  let totalValueGBP    = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols   = parseLine(lines[i]);
    const ticker = (cols[colIdx.slice] || "").toUpperCase().trim();
    const name   = cols[colIdx.name] || ticker;

    // Skip the summary row ("Total" ticker or "-" quantity)
    if (!ticker || ticker === "TOTAL" || ticker === "FREESTYLE") continue;

    const costGBP_total          = parseNum(cols[colIdx.invested]);
    const snapshotValueGBP_total = parseNum(cols[colIdx.value]);
    const shares                 = parseNum(cols[colIdx.qty]);

    // Skip rows with invalid data
    if (isNaN(shares) || shares <= 0) continue;
    if (isNaN(costGBP_total) || costGBP_total < 0) continue;
    if (isNaN(snapshotValueGBP_total) || snapshotValueGBP_total < 0) continue;

    const currency = USD_TICKERS.has(ticker) ? "USD" : "GBP";

    // Back-calculate native price: for USD tickers, convert GBP value → USD; for GBP, divide by shares.
    const snapshotPriceNative = currency === "USD"
      ? (snapshotValueGBP_total / usdgbp) / shares
      : snapshotValueGBP_total / shares;

    positions.push({
      ticker,
      name,
      shares:                 +shares.toFixed(8),
      currency,
      costGBP_total:          +costGBP_total.toFixed(4),
      snapshotValueGBP_total: +snapshotValueGBP_total.toFixed(4),
      snapshotPriceNative:    +snapshotPriceNative.toFixed(4),
    });

    totalInvestedGBP += costGBP_total;
    totalValueGBP    += snapshotValueGBP_total;
  }

  if (positions.length === 0) {
    throw new Error("t212.parseCsv: no valid positions found in CSV. " +
      "Ensure you exported a Freestyle (PIE) CSV, not the transaction history CSV.");
  }

  return {
    positions,
    totalInvestedGBP: +totalInvestedGBP.toFixed(4),
    totalValueGBP:    +totalValueGBP.toFixed(4),
    importedAt:       new Date().toISOString(),
  };
}

// ── Snapshot persistence ──────────────────────────────────────────────────────

/**
 * Load the most recent T212 snapshot from disk.
 * Returns null if the file doesn't exist or is unreadable.
 */
function loadSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return null;
    const raw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // Basic sanity check
    if (!Array.isArray(parsed.positions) || parsed.positions.length === 0) return null;
    return parsed;
  } catch (err) {
    console.warn("[t212] Could not load portfolio snapshot:", err.message);
    return null;
  }
}

/**
 * Save a parsed snapshot to disk.
 */
function saveSnapshot(snapshot) {
  // Ensure /data dir exists
  const dir = path.dirname(SNAPSHOT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf8");
}

module.exports = { parseCsv, loadSnapshot, saveSnapshot, SNAPSHOT_PATH };
