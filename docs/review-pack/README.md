# The Dispatch — external review pack

A brief for running a structured outside review of this project using ChatGPT,
from five roles that have nothing to do with writing code.

The repository is public, so **no uploads are needed** — ChatGPT with browsing
reads everything here directly from GitHub. What this pack provides is the part
browsing cannot: a factual description of the product, and a reading order
through 27,000 lines so the reviewer opens the files that matter instead of
sampling the README and guessing.

## Why this exists

The project is built and reviewed by one person plus one model family. That is a
narrow loop. A second model, prompted from roles that do not overlap, surfaces
what an author cannot see: whether the output would be read by a client, whether
it would survive a trading floor, whether it reads as credible to someone
hiring, whether it teaches anything, and whether the code underneath is sound.

## Where to point it

`main` is current — the research rewrite was merged in PR #1, so a reviewer
reading `main` reads the real thing. Every path in this pack is given against:

```
https://raw.githubusercontent.com/AbidM06/the-dispatch/main/<path>
```

Raw URLs work more reliably for a browsing model than the GitHub web UI, which
lazy-loads file contents.

## How to run it

Five **separate** conversations. Personas contaminate each other — a reviewer
told to be both a recruiter and an engineer writes engineering notes in a
recruiter's vocabulary and commits to neither.

For each persona in `03-persona-prompts.md`: start a fresh chat with browsing
enabled, paste the prompt, and let it fetch its own reading list. Answer its
questions if it asks — several are written to interrogate rather than monologue.

| File | What it is | Who reads it |
|---|---|---|
| `01-product-brief.md` | What the app is and does, feature by feature, with a limitations section | All five personas |
| `02-what-it-produces.md` | The shape of the output — reports, bulletin, ideas | Client, salesperson, student |
| `03-persona-prompts.md` | The five prompts, each with its reading list | — |
| `04-engineering-brief.md` | Architecture, constraints, confirmed defects, reading order | Engineer |

## If browsing fails

Rate limits and fetch failures happen. Fallbacks, in order of preference:

1. Give it the `blob` URL instead of `raw`:
   `https://github.com/AbidM06/the-dispatch/blob/main/<path>`
2. Download the repository as a zip from the GitHub UI and upload that.
3. Paste the contents of the relevant brief plus the two or three files the
   prompt names as highest priority.

Option 3 is usually enough for personas 1 to 4, which are judging the product
rather than the source.

## Ground rules to hold the reviewer to

These are inside each prompt, but they are the point of the exercise:

- **Judge what is there, not what it could be.** "Add a backtester" is not
  useful; there is one. The brief lists what exists.
- **Cite the file or feature.** A criticism that cannot be pointed at is noise.
- **Say what you would cut.** Reviewers default to additive suggestions because
  they are cheap. The harder answer is what should be removed.
- **Rank.** An unranked list of twenty observations avoids making a judgement.

## Keeping it honest

Both briefs carry a limitations section naming real defects, including unfixed
ones — the inert spend caps, the unguarded front-end crash, the failing test, the
stale README. That is deliberate. A review pack that hides the flaws produces a
review of a product that does not exist, and a reviewer that finds a hidden
defect stops trusting everything else it was told.
