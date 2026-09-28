/**
 * tests/handoff.test.js — the multi-agent handoff files stay present and safe.
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

describe("multi-agent handoff", () => {
  test("CLAUDE.md imports the shared brief instead of duplicating it", () => {
    const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
    expect(claude).toMatch(/^@AGENTS\.md$/m);
    expect(claude.length).toBeLessThan(1000);
  });

  test("AGENTS.md carries the working protocol; HANDOFF and DECISIONS exist", () => {
    const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/Propose before you commit/);
    expect(agents).toMatch(/Cross-review/);
    expect(fs.existsSync(path.join(ROOT, "docs/HANDOFF.md"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "docs/DECISIONS.md"))).toBe(true);
  });

  test("context pack bundles the brief and never includes secrets or local data", () => {
    const out = path.join(ROOT, "context-pack.md");
    execFileSync(process.execPath, [path.join(ROOT, "scripts/context-pack.js")], { cwd: ROOT, stdio: "ignore" });
    const pack = fs.readFileSync(out, "utf8");
    expect(pack).toMatch(/Project Brief for AI Coding Agents/);
    expect(pack).toMatch(/HANDOFF — where the work stands/);
    expect(pack).not.toMatch(/sk-ant-[A-Za-z0-9]/);
    expect(pack).not.toMatch(/^\.env$/m);          // .env is gitignored, so never in the file list
    expect(pack).not.toMatch(/^data\/ai_spend\.json$/m);
  });
});
