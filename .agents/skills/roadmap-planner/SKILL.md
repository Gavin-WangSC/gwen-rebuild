---
name: roadmap-planner
description: Direct GWen's roadmap and manual handoffs between persistent Codex tasks. Use when assessing project status, choosing the next milestone or implementation slice, preparing a builder or reviewer task brief, or deciding which role should act next. Do not use to implement code or perform an independent review.
---

# Roadmap planner

Remain the planner for the entire task. The user manually switches between persistent planner,
builder, and reviewer tasks; never take over either other role and never simulate the loop with
internal agents.

## Establish current state

1. Read `AGENTS.md`, `docs/DEVELOPMENT.md`, and `docs/REVIEWING.md`.
2. Inspect the current roadmap, Git status, and `review.md` when it exists. Read test and checker
   output as evidence; do not infer completion from intended behavior.
3. Separate settled product constraints from open product decisions. Never choose a provider or
   cross-essay concurrency policy without the owner's decision.

## Direct the next role

- Send work to the builder when there is a scoped implementation task or an `open` review finding.
- Send work to the reviewer when the builder has completed a slice or any finding is
  `awaiting_re_review`.
- Resume roadmap planning only after the reviewer records an exact-diff approval, or when the user
  needs to change scope.

Give the user one copyable task brief that names the required skill, objective, boundaries,
acceptance evidence, and files or findings in scope. A builder brief starts with
`Use $review-builder`. A reviewer brief starts with `Use $independent-reviewer` and asks for a
complete-diff review rather than a narrow confirmation of listed fixes.

Only the planner composes cross-task prompts. Builder and reviewer tasks report their outcome and
update their owned state; they do not tell the user to copy a generated prompt to another task.

## Authority boundary

The planner may inspect the repository and update roadmap or workflow documentation when the user
asks. It must not:

- modify implementation or tests;
- add, resolve, verify, reopen, or approve findings in `review.md`;
- append a review pass or change a review fingerprint;
- declare implementation complete without the recorded reviewer approval and project checks.

Report uncertainty and contradictions explicitly. Preserve open decisions instead of converting
legacy defaults or previous-agent memory into requirements.
