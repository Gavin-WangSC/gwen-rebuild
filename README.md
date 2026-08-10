# GWen

A deterministic grading pipeline for **IB Chinese A, Paper 1** essays (guided textual analysis).

Given a student's essay and the exam question, GWen produces:

- **Scores across the four IB assessment criteria** — 5 marks each, flat-weighted to 20
- **Inline annotations** on the original text: what works, what doesn't, and where
- **A Mermaid diagram** of the essay's argument structure

> **Status: rebuild in progress.** The database, pure 16-step grading pipeline, and DB-backed
> per-answer checkpoint runner are implemented and tested. Job orchestration, the operational CLI,
> provider integration, and viewer are still to be built — see [Project status](#project-status).

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
| Model      | OpenAI-compatible boundary; deployment provider is open |

One language, and no framework layer over the model client. The pipeline is a dependency-ordered
DAG and a loop — not an agent.

---

## Getting started

Requires [Bun](https://bun.sh) 1.2 or later.

```bash
bun install
```

Copy the example environment file for local database work:

```bash
cp .env.example .env
```

| Variable       | Purpose                                 |
| -------------- | --------------------------------------- |
| `DATABASE_URL` | libSQL/SQLite URL, e.g. `file:local.db` |

The example also records the inherited DashScope variables used by the current pipeline adapter
stub. They are not a settled deployment contract: provider selection is deliberately open until
the first end-to-end vertical slice.

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
- SQLite/Drizzle schema, migration, database factory, and seed conversion
- Pure 16-step grading DAG with fixed prompts, validation, retry behavior, and failure propagation
- Offline pipeline tests using an injected fake model
- DB-backed per-answer runner with durable step checkpoints and exact failure resume

**Not built yet:**

- Job orchestration, process lifecycle, and cross-essay scheduling
- A settled provider adapter and configuration contract
- The `gwen` commands listed above
- The web viewer

The command table describes the intended contract, not shipped behaviour. It's written down
because the contract was designed before the code, deliberately.

Development state, settled decisions, open decisions, and the next milestone live in
[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

---

## License

[MIT](./LICENSE)
