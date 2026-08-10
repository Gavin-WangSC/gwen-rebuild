# GWen development state

This is the tracked source of truth for what has been built, what is settled, what remains open,
and what comes next. `AGENTS.md` contains compact guardrails; this document carries the project
state. Local `SETUP.md`, `REBUILD.md`, and `.claude/` files are historical research, not durable
authority.

## Where the rebuild is

| Phase                      | State       | Evidence                                                                        |
| -------------------------- | ----------- | ------------------------------------------------------------------------------- |
| Toolchain and CI           | Complete    | `bun run check`, GitHub Actions, protected `main`                               |
| Database foundation        | Complete    | Schema, migration, factory, seed conversion; merged in PR #3                    |
| Pure grading pipeline      | Complete    | Ported prompts, schemas, 16-step DAG, retry/failure behavior; merged in PR #4   |
| Context recovery for Codex | Complete    | Tracked guidance and safety setup; merged in PR #5                              |
| Runnable product slice     | In progress | Per-answer checkpoint runner built; orchestration, CLI, provider, viewer remain |

The pipeline is a deterministic procedure around stochastic model outputs. “Same process” means
the same step DAG, dependencies, prompts, temperatures, and conversation shape; it does not mean
that independent steps must be forced into a total serial order or that model text is bitwise
repeatable.

## Built now

- `src/lib/server/db/`: framework-free database factory plus Drizzle schema and migrations.
- `src/lib/pipeline/`: validated essay input, fixed prompts, executable 16-step dependency graph,
  in-essay wave scheduling, injected model boundary, retries, score extraction, typed results, and
  exact hydration from durable successful-step checkpoints.
- `src/lib/runner/`: provider-neutral `runAnswer()` persistence around one answer, including
  step lifecycle rows, cumulative attempts, failure resume, final projection, and score audit.
- A CLI stub that only validates database setup. The README command table is an intended contract,
  not currently available behavior.
- A placeholder SvelteKit page. There is no results viewer yet.
- Offline pipeline, migration, and runner tests. The exact current count comes from
  `bun run check`.

The pipeline remains persistence-free. It emits awaitable lifecycle events; the per-answer runner
persists them and restores only validated successes. The future job runner still owns cross-essay
scheduling, job counts/status, and process lifecycle. The CLI owns arguments, environment lookup,
stdout/stderr, and exit codes. Routes read the database and never execute grading.

The checkpoint contract is deliberately single-owner: two processes must not call `runAnswer()`
for the same job and answer concurrently. The future job runner supplies that ownership boundary.
An incomplete step has at-least-once semantics; a durable success is never called again.

## Settled product rules

- IB Chinese A Paper 1 only; four criteria, each 0–5, flat-weighted to 20.
- `null` means not yet scored. `0` is a valid mark and must never be used as a failure sentinel.
- An ingested essay has exactly five paragraphs or is rejected.
- The grading method is a port: preserve all 16 steps, dependencies, conversation shape, criteria,
  and Chinese prompt wording. Plumbing can improve; marking cannot silently change.
- SvelteKit is the read-only viewer. The CLI is the primary operational interface.
- No live status UI, SSE, WebSockets, progress files, upload wizard, embedded agent, or extra LLM
  framework.
- Configuration enters reusable modules as arguments. Only leaf adapters read environment or
  framework-specific configuration.

## Explicitly open decisions

These are not contradictions to “resolve” from old prose. They need evidence from a small vertical
slice and an owner decision.

1. **Provider and endpoint profile.** Aliyun/DashScope, Volcengine, OpenRouter, or another compatible
   provider has not been selected. `src/lib/pipeline/llm.ts` contains the inherited Qwen/DashScope
   baseline, not a final deployment choice. Preserve the one-method `LlmClient` boundary.
2. **Structured-output strategy.** Confirm what the selected provider reliably supports before
   changing the existing validated text/JSON parsing.
3. **Cross-essay concurrency.** In-essay dependency scheduling is implemented and settled.
   Concurrency across essays—pool size, rate limiting, backoff coordination, and configurability—is
   not settled.
4. **Provider Batch API.** A provider's offline Batch API and ordinary concurrent requests are
   different execution models. Do not conflate either with the pipeline's in-essay DAG scheduler.

Record a decision here when evidence settles it; do not leave the answer only in chat context.

## Next milestone: one end-to-end vertical slice

Build the smallest path that proves the architecture:

1. Extend the provider-neutral per-answer runner into job orchestration and define provider
   configuration boundaries without choosing through accidental constants.
2. Ingest and persist one valid five-paragraph essay.
3. Execute the existing pipeline through one selected experimental provider adapter.
4. Use the implemented checkpoint contract to persist and resume real provider runs safely.
5. Expose the minimum CLI commands needed to start the run and inspect its result.

Acceptance is one or two real essays completing end to end. To exercise batch mechanics, reuse a
valid fixture around 20 times with a fake model; this tests scheduling and persistence only. It
does not establish marking quality, provider consistency, or statistical correlation.

Do not begin with dozens of distinct essays or a quality-evaluation framework. Those become useful
only after the product path works and the provider/endpoint profile is chosen.

## Verification and documentation discipline

- `bun run check` is the definition of done. Paste its real output when handing off work.
- CI and branch protection are the non-bypassable outer gate; local instructions and hooks are
  assistance, not proof.
- Use a branch and PR for `main`; do not push directly.
- When code changes the state above, update this file in the same change.
- Create `docs/OPERATING.md` when operational CLI behavior exists. Keep build guidance here and
  runtime instructions there.
- Never write to `../GWen/gwen-app/data/`; it contains untracked student work without a backup.
