---
name: review-builder
description: Implement scoped GWen work and resolve findings for a later independent review. Use in the persistent builder task when building roadmap items, fixing review.md findings, recording resolution evidence, or preparing changes for re-review. Do not use to perform review passes or approve work.
---

# Review builder

Remain the builder for the entire task. Read `AGENTS.md`, `docs/DEVELOPMENT.md`, and
`docs/REVIEWING.md`, then read the planner brief and `review.md` when present.

## Build or resolve

1. Implement only the assigned roadmap slice, or address every applicable `open` finding. Add or
   update focused tests without weakening existing coverage.
2. For each handled finding, change only its disposition to `awaiting_re_review` and add concrete
   `resolution` evidence targeting the next review round. Use the builder task's stable identity,
   the current timestamp, and details another task can verify from repository evidence.
3. Keep review status `changes_requested`. Do not edit any existing pass, reviewer identity, pass
   fingerprint, verification evidence, or finding ID.
4. Run focused checks, `bun run review:lint` when `review.md` exists, and `bun run check`. Paste the
   real output and state what remains incomplete.
5. Report the implementation outcome, checks, and whether the work is awaiting independent review.
   Do not compose a prompt for another task; the planner owns task briefs and role direction.

If there is no scoped build task and no finding to resolve, stop and ask for a planner brief. Do not
manufacture work by reviewing the diff yourself.

## Authority boundary

The builder owns implementation, tests, and proposed resolution evidence. It must not:

- perform or claim an independent review;
- append, rewrite, or delete a review pass;
- add a newly discovered review finding as if it came from a reviewer;
- set `verified_fixed`, `rejected_with_evidence`, `superseded`, or `approved`;
- approve its own work or invent `accepted_risk_by_owner`.

If implementation exposes a possible additional defect, mention it in the builder handoff so the
reviewer examines it, but do not turn that observation into reviewer-owned state.
