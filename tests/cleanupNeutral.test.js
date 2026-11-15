/**
 * WO-02 acceptance tests (D-37, D-40).
 *  1. The UMUSHROOM view is gone: no route, no server code, no client code, no env var.
 *  2. Equity reports no longer ask for an AMD section.
 *  3. No prompt presents the app as a named bank, strategist or publication series.
 */
const fs = require("fs");
const path = require("path");
const request = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const TYPES = ["macro", "fx", "rates", "thematic", "equity", "commodities", "sector"];

// Real firm / person names a prompt must never claim to be (case-insensitive).
const FORBIDDEN = /bofa|bank of america|goldman|morgan stanley|jpmorgan|\bjpm\b|struyven|currie|bulge-bracket|bulge bracket/i;
// Publication series and house-style wording that present a report as a firm's product.
const FORBIDDEN_SERIES = /thematic lens|us equity views|global economics comment|\b(?:GS|MS|BofA|JPM)[- ]style|\b(?:MS|GS|BofA) language/i;
// Real data-series names that legitimately contain a firm name.
const ALLOWED_SERIES = [/ICE BofA US High Yield (?:OAS|Option-Adjusted Spread)/gi];
const stripAllowed = (s) => ALLOWED_SERIES.reduce((acc, re) => acc.replace(re, ""), s);

describe("WO-02 item 1 — UMUSHROOM view removed (D-37)", () => {
  test("GET /api/umushroom is a 404", async () => {
    jest.resetModules();
    const app = require("../server/index");
    const res = await request(app).get("/api/umushroom");
    expect(res.status).toBe(404);
  });

  test("no UMUSHROOM server code, client code, test or env var remains", () => {
    expect(fs.existsSync(path.join(ROOT, "server/umushroom"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "server/routes/umushroom.js"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "tests/umushroom.test.js"))).toBe(false);
    for (const f of ["server/index.js", "client/index.html", ".env.example", "AGENTS.md"]) {
      expect({ file: f, mentions: /umushroom/i.test(read(f)) }).toEqual({ file: f, mentions: false });
    }
  });
});

describe("WO-02 item 2 — no AMD section in equity reports (D-40)", () => {
  test("the equity prompt does not mention AMD in any case", async () => {
    jest.resetModules();
    const { buildResearchSpec } = require("../server/providers/anthropic");
    const spec = await buildResearchSpec("", "", "equity");
    expect(spec.reportType).toBe("equity");
    expect(`${spec.system}\n${spec.prompt}`).not.toMatch(/amd/i);
  });

  test("the client no longer renders an amdImplications box", () => {
    expect(read("client/index.html")).not.toMatch(/amdImplications/);
  });
});

describe("WO-02 item 3 — prompts name a job, never a firm (D-40)", () => {
  test.each(TYPES)("%s report prompt names no firm, person or series", async (type) => {
    jest.resetModules();
    const { buildResearchSpec } = require("../server/providers/anthropic");
    const spec = await buildResearchSpec("", "", type);
    const text = stripAllowed(`${spec.system}\n${spec.prompt}`);
    expect(text).not.toMatch(FORBIDDEN);
    expect(text).not.toMatch(FORBIDDEN_SERIES);
  });

  // Macro view, client impact and pitch prompts have no specOnly path, so check the
  // prompt-building file itself (prompts and the comments beside them).
  test("anthropic.js (macro view, clients, pitch, all reports) names no firm, person or series", () => {
    const src = stripAllowed(read("server/providers/anthropic.js"));
    const hits = src.split("\n").filter((l) => FORBIDDEN.test(l) || FORBIDDEN_SERIES.test(l));
    expect(hits).toEqual([]);
  });

  test("the allow-list keeps real data-series names", () => {
    expect(stripAllowed("ICE BofA US High Yield OAS")).toBe("");
  });
});
