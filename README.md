# GWen

A deterministic grading pipeline for **IB Chinese A, Paper 1** essays (guided textual analysis).

Given a student's essay and the exam question, GWen produces:

- **Scores across the four IB assessment criteria** — 5 marks each, flat-weighted to 20
- **Inline annotations** on the original text: what works, what doesn't, and where
- **A Mermaid diagram** of the essay's argument structure

> **Status: rebuild in progress.** This repository currently contains the scaffold, toolchain, and
> CI. The grading pipeline is not implemented yet — see [Project status](#project-status).

---

## Why it exists

Marking Paper 1 essays is slow, and marking forty of them _consistently_ is harder still — the
fortieth essay should be judged the same way as the first.

GWen's answer is to make grading a fixed process rather than a conversation: every essay receives
the same steps, in the same order, with the same prompt text, against the same model. That
constraint is the product, not an implementation detail. Marks that can't be reproduced can't be
defended to a student, a parent, or a moderator.

GWen is a marking aid, not a marker. Scores are a starting point for a teacher's judgement, not a
substitute for it. This project is not affiliated with or endorsed by the IB.

## The criteria

Scoring follows the published IB Language A Paper 1 assessment criteria — four criteria, five
marks each, equally weighted:

| Criterion | Assesses                         |
| --------- | -------------------------------- |
| **A**     | Understanding and interpretation |
| **B**     | Analysis and evaluation          |
| **C**     | Focus and organization           |
| **D**     | Language                         |

Only Paper 1 is in scope. Paper 2 (the comparative essay) is a different task with different
inputs and is not implemented.

---

## How it's operated

**Primary interface: a CLI.** `gwen` is built to be driven by an AI agent harness. The agent
handles messy input — a folder of `.docx` files, one document containing forty essays, names that
don't match the roster — then starts runs and reports results.

```
gwen ingest <path> --assignment <id>     load normalized essays
gwen grade --assignment <id> --detach    run the pipeline, returns a job id
gwen status <job-id>                     per-student state, counts, failures
gwen show <answer-id>                    one essay's scores and annotations
gwen export --assignment <id>            CSV for the gradebook
```

JSON on stdout, progress on stderr, never interactive. Exit codes distinguish _couldn't start_
from _ran with failures_. Long batches detach rather than holding a command open, because forty
essays is not a two-minute job.

**Secondary interface: a small web viewer** for the three things a terminal is bad at — rendering
an annotated essay, rendering a Mermaid diagram, and scanning forty results at once. It reads the
database; it never runs the pipeline.

The agent _operates_ GWen; it does not grade. Grading is a fixed pipeline, not something an agent
improvises.

---

## Stack

| Layer      | Choice                                                  |
| ---------- | ------------------------------------------------------- |
| Runtime    | Bun                                                     |
| Language   | TypeScript, `strict`                                    |
| Storage    | SQLite via Drizzle ORM — the single source of truth     |
| Validation | Zod at every boundary                                   |
| Viewer     | SvelteKit 2 / Svelte 5 (runes)                          |
| Styling    | Tailwind 4 + daisyUI 5                                  |
| Tests      | `bun test`                                              |
| Model      | `qwen3.5-flash` via the DashScope OpenAI-compatible API |

One language, and no framework layer over the model client. The pipeline is a dependency-ordered
DAG and a loop — not an agent.

---

## Getting started

Requires [Bun](https://bun.sh) 1.2 or later.

```bash
bun install
```

Copy the example environment file and fill in your own values:

```bash
cp .env.example .env
```

| Variable            | Purpose                                     |
| ------------------- | ------------------------------------------- |
| `DATABASE_URL`      | libSQL/SQLite URL, e.g. `file:local.db`     |
| `DASHSCOPE_API_KEY` | DashScope API key, required for model calls |

Then:

```bash
bun run check     # types, tests, lint, format — the whole gauntlet
bun run dev       # viewer on localhost:5173
bun run gwen      # the CLI
```

`bun run check` is the definition of done. The same command runs in CI and gates every merge to
`main`.

---

## Project status

**Working:**

- Scaffold, toolchain, and the `check` gauntlet
- CI on every push and pull request, required to merge
- `createDb(url)` — a framework-free database factory shared by the CLI and the viewer

**Not built yet:**

- The 16-step grading pipeline, its prompts, and the scheduler
- Database schema and migrations
- The `gwen` commands listed above
- The web viewer

The command table describes the intended contract, not shipped behaviour. It's written down
because the contract was designed before the code, deliberately.

---

## License

[MIT](./LICENSE)
