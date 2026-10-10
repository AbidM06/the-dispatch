/**
 * tests/publicRepoGuard.test.js
 * The Dispatch repo is PUBLIC (D-22). Personal data — holdings, share counts, cost basis,
 * real-money holdings, API keys — must live only in gitignored data/ files or the owner's
 * private repo. This test fails if tracked files contain credentials or literal holdings.
 *
 * Held tickers themselves are not secret (the owner chose a public paper portfolio, D-22);
 * the guard is about credentials and real-money holdings data.
 */
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SELF = path.join("tests", "publicRepoGuard.test.js");
const SKIP = new Set(["package-lock.json", SELF]);

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { return null; }
}
function read(f) {
  try {
    const t = fs.readFileSync(path.join(ROOT, f), "utf8");
    return t.includes("\u0000") ? null : t;
  } catch { return null; }
}

// Names of every credential variable the app is configured with (.env.example), plus the admin key.
function secretNames() {
  const names = new Set(["DISPATCH_ADMIN_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FRED_API_KEY",
    "FINNHUB_API_KEY", "EIA_API_KEY", "POLYGON_API_KEY", "ALPHA_VANTAGE_API_KEY"]);
  const ex = read(".env.example") || "";
  for (const m of ex.matchAll(/^#?\s*([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=/gm)) names.add(m[1]);
  return [...names];
}
const PLACEHOLDER = /(your|example|placeholder|changeme|dummy|fake|test|xxx|<|\.\.\.|process\.env|\$\{|sample)/i;

const SHAPE_RULES = [
  ["Anthropic/OpenAI-style key", /sk-(ant-)?[A-Za-z0-9_-]{24,}/],
  ["GitHub token",              /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["AWS access key",            /\bAKIA[0-9A-Z]{16}\b/],
  ["private key block",         /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
// Holdings, in JS or JSON (quoted or unquoted keys), integer or fractional values.
const HOLDINGS_RULES = [
  ["literal share count",  /["']?\b(shares|quantity|units)["']?\s*:\s*\d/i],
  ["literal cost basis",   /["']?\bcost(USD|GBP|Basis|_?total)?["']?\s*:\s*\d/i],
  ["literal avg price paid", /["']?\b(avgPrice|averageCost|avg_cost)["']?\s*:\s*\d/i],
];

describe("public repo guard (D-22)", () => {
  const files = trackedFiles();
  const maybe = files ? test : test.skip;

  maybe("no tracked file contains credentials", () => {
    const names = secretNames();
    const assign = new RegExp(`\\b(${names.join("|")})\\b["']?\\s*[:=]\\s*["']?([A-Za-z0-9_\\-\\.]{16,})`, "g");
    const hits = [];
    for (const f of files) {
      if (SKIP.has(f)) continue;
      const text = read(f);
      if (text == null) continue;
      for (const [label, re] of SHAPE_RULES) if (re.test(text)) hits.push(`${f}: ${label}`);
      for (const m of text.matchAll(assign)) {
        if (!PLACEHOLDER.test(m[2])) hits.push(`${f}: value assigned to ${m[1]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  maybe("no tracked file contains literal holdings data", () => {
    const hits = [];
    for (const f of files) {
      if (SKIP.has(f) || f.startsWith("tests/")) continue;
      const text = read(f);
      if (text == null) continue;
      for (const [label, re] of HOLDINGS_RULES) if (re.test(text)) hits.push(`${f}: ${label}`);
    }
    expect(hits).toEqual([]);
  });

  maybe("personal data paths stay gitignored", () => {
    const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    for (const p of [".env", ".env.*", "data/portfolio_snapshot.json", "data/journal.jsonl"]) {
      expect(ignore).toContain(p);
    }
  });
});
