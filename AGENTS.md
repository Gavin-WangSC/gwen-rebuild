# Working on GWen

GWen grades IB Chinese A Paper 1 essays. This file is the short, durable map for agents working
on the code. Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) before planning work. The future
`docs/OPERATING.md` is a different document for agents operating the finished CLI.

Bun · TypeScript strict · SQLite/Drizzle · Zod · SvelteKit 2 + Svelte 5 runes · Tailwind 4

## Invariants

These are product truths, not preferences. Most are lint- or CI-enforced; all of them hold anyway.

1. Scores are 0–5 per IB criterion, flat-weighted to /20. Never change this.
2. `null` means not-yet-scored. `0` is a real mark. Not interchangeable.
3. Essays are exactly 5 paragraphs. Reject others at ingest; never pad.
4. `pipeline/` is pure — no SvelteKit, no DB, no I/O. It emits; `runner/` persists.
5. Config arrives as arguments. Only leaf files know where config lives — `createDb(url)` does not
   read `$env`; `sveltekit.ts` supplies it. SvelteKit virtual modules don't resolve under `bun run`,
   so an `$env` import in shared code breaks the CLI.
6. `routes/` never runs the pipeline. It reads the DB.
7. Svelte 5 runes only. Never `$:`, never stores.
8. Zod at every boundary — CLI args, model responses, DB edges.
9. No SSE, progress files, or live status view.
10. **Never write to `../GWen/gwen-app/data/`** — untracked real student work, no backup.
11. **The grading method is ported, not redesigned.** Criteria, the 16 steps and their order, the
    conversation shape, and every word of the Chinese prompt text carry over as-is. Plumbing may
    change (parsing, keying, scheduling, failure representation); marking may not. Ideas for
    better marking get written down, not implemented.

## Current boundary

The database schema and pure 16-step pipeline are built. The runner, real CLI commands, provider
adapter/configuration, and viewer are not. Provider choice, provider batch APIs, and cross-essay
concurrency are open decisions; do not infer them from legacy defaults in the code.

The next milestone is one provider-neutral end-to-end vertical slice. Acceptance needs one or two
real essays. A batch-mechanics test may run roughly 20 duplicates with a fake model; it is not a
grading-quality evaluation.

## Definition of done

`bun run check` passes **and you have pasted its output.**

- Never weaken or delete a test to make it pass. If a test is wrong, say so and show the diff.
- Never report work done based on what the code should do. Run it.
- If a step fails, say the task is incomplete and show the real output.

`main` requires a passing CI check and a PR — direct pushes are blocked.

## Ask, don't assume

Stop and ask about: the four criteria or their weighting · the 5-paragraph rule · Chinese prompt
wording (tuned against real marking) · adding a language, framework, or dependency · adding
streaming, a wizard, or a settings page · selecting a provider or cross-essay concurrency policy ·
scores diverging systematically from the corpus.

## Svelte MCP server

Use it for Svelte 5 / SvelteKit questions rather than recalling from memory — the public corpus is
majority Svelte 4 and runes are the most likely thing to get wrong.

- `list-sections` first, to discover what documentation exists.
- `get-documentation` for every section whose `use_cases` match the task.
- `svelte-autofixer` on any Svelte code before showing it. Keep calling until it returns clean.
- `playground-link` only if asked, and never for code already written to a file.
