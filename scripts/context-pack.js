#!/usr/bin/env node
/**
 * scripts/context-pack.js — `npm run context-pack`
 *
 * Writes context-pack.md: everything a chat-only AI model (one that cannot see
 * this repo) needs to pick up the work — the shared brief, the handoff, the
 * decision log, the file tree and recent commits — in one file to upload.
 *
 * Never includes .env, data/ or any secret: it reads only the files listed
 * below plus `git` metadata.
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT  = path.join(ROOT, "context-pack.md");

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
  catch { return `_(${rel} not found)_`; }
}

function git(args) {
  try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim(); }
  catch { return "_(git unavailable)_"; }
}

const tree = git(["ls-files"])
  .split("\n")
  .filter(f => !f.startsWith("docs/review-pack/"))
  .join("\n");

const sections = [
  `# The Dispatch — context pack\n\nGenerated ${new Date().toISOString()} on branch \`${git(["rev-parse", "--abbrev-ref", "HEAD"])}\` at \`${git(["rev-parse", "--short", "HEAD"])}\`.\n\n` +
  "Instructions for the model reading this: read AGENTS.md (below) first, then HANDOFF and DECISIONS. " +
  "Summarise where the work stands and propose next steps to the owner **before** writing any code. " +
  "You cannot see the repository itself — ask the owner to paste any file you need.",
  "---\n\n" + read("AGENTS.md"),
  "---\n\n" + read("docs/HANDOFF.md"),
  "---\n\n" + read("docs/DECISIONS.md"),
  "---\n\n## Recent commits\n\n```\n" + git(["log", "--oneline", "-30"]) + "\n```",
  "---\n\n## Files in the repository\n\n```\n" + tree + "\n```",
];

fs.writeFileSync(OUT, sections.join("\n\n") + "\n");
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`Wrote ${path.relative(process.cwd(), OUT) || OUT} (${kb} KB) — upload it to the chat-only model.`);
