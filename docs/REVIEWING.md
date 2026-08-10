# Persistent-task code review

GWen uses three separate, user-visible Codex tasks. One task keeps one role for its lifetime:

| Task     | Skill                   | Owns                                               | Must not do                              |
| -------- | ----------------------- | -------------------------------------------------- | ---------------------------------------- |
| Planner  | `$roadmap-planner`      | Roadmap, scope, and role-specific task briefs      | Implement or make review decisions       |
| Builder  | `$review-builder`       | Code, tests, and proposed finding resolutions      | Append review passes or approve its work |
| Reviewer | `$independent-reviewer` | Complete-diff findings, verification, and approval | Modify implementation or tests           |

The user switches between these tasks. There is no controller agent, automatic role switching, or
internal builder-reviewer loop. A task that started as builder never becomes the reviewer for the
same work.

`review.md` is the local mailbox between the persistent builder and reviewer tasks. It stays
ignored because it describes the current worktree rather than the product. This tracked document,
the three project skills, and the checker let a newly opened task recover the process without chat
memory.

## Manual loop

1. The planner gives the builder a bounded brief beginning with `Use $review-builder`.
2. The builder implements the brief. When resolving existing findings, it marks them only
   `awaiting_re_review` and records resolution evidence for the next round.
3. The user switches to the reviewer task and invokes `$independent-reviewer`.
4. The reviewer inspects the complete staged, unstaged, and untracked non-ignored diff. It verifies
   proposed resolutions and searches for previously unreported concrete defects in the current
   change before appending one review pass.
5. If findings remain, the user returns to the builder task. If the exact diff is approved, the user
   returns to the planner for the next roadmap decision.

The roles communicate through repository evidence and `review.md`, not private chat context. A
reviewer is never limited to the builder's list of fixes. A builder cannot close its own findings.
Only the planner writes task briefs: builder and reviewer report status without generating prompts
for the user to copy between tasks.

Review is exhaustive within the current change, not a source of product ideation. Findings must be
evidence-backed violations, regressions, correctness problems, or operational risks against the
assigned task and settled requirements. New features, roadmap additions, optional enhancements,
alternative architectures, speculative refactors, style preferences, and unrelated pre-existing
issues belong outside the review ledger. An unsettled product decision returns to the planner or
owner without the reviewer inventing an answer.

## Finding standard and review output

A finding is admitted only when it is material, discrete, actionable, introduced or exposed by the
current change, likely to be fixed by the author, independent of unstated intent, and supported by
repository evidence. Prefer no finding over speculative feedback. Deduplicate candidates that share
the same changed location and remedy before assigning IDs.

Apply the root and scoped project instructions governing each changed file. When an instruction
materially supports a finding, cite its smallest useful line range; do not manufacture findings
solely because a rule exists or omit ordinary correctness bugs that need no special rule.

The reviewer responds in concise normal Markdown. Line-specific findings also use one
`::code-comment{...}` directive with the shortest useful changed-line range so they appear inline in
Codex's review UI. The structured state remains only inside `review.md`; it is never returned as the
visible review response. If there are no actionable issues, say so directly and emit no inline
directives.

## Commands

- `bun run review:fingerprint` prints the branch, HEAD, and hash of all staged, unstaged, and
  untracked non-ignored changes.
- `bun run review:lint` checks structure and append-only history. Open findings and a stale latest
  pass are allowed between builder and reviewer.
- `bun run review:check` additionally requires the latest independent pass to cover the exact
  current diff, approve it, and leave every finding terminal.

Run `review:lint` after either role updates the mailbox. The reviewer runs `review:check` before
approval; the builder should expect it to fail after changing code because that invalidates the old
fingerprint.

The project Codex hook runs `review:check` before `git commit` whenever `review.md` exists. That is
the operation an approved uncommitted-scope fingerprint can prove: the commit consumes the reviewed
working diff and changes `HEAD`, so the same mailbox cannot validate a later push. The hook therefore
does not gate `git push`; CI and branch protection validate the committed tree and remain the hard
outer gate. A new working-tree change needs a new complete-diff review before its next commit. The
checker proves administrative closure and diff freshness, not that a fix is semantically correct.

## Finding lifecycle

The reviewer creates a monotonic `GWEN-R###` ID with disposition `open`. The builder may move it to
`awaiting_re_review` and add resolution evidence. Only the reviewer may verify, reject, supersede,
reopen, or close it in a new pass.

Terminal dispositions are `verified_fixed`, `rejected_with_evidence`,
`accepted_risk_by_owner`, and `superseded`. `open` and `awaiting_re_review` block handoff. Accepted
risk requires explicit owner approval; no agent or script may manufacture it.

## Embedded state

Keep the JSON block at the end of `review.md`. Finding explanations stay in Markdown; the JSON is
only deterministic state. Review passes are append-only so later tasks can distinguish what was
reviewed, what changed, and which pass found a new issue.

```html
<!-- review-state
{
  "schemaVersion": 2,
  "scope": "uncommitted",
  "branch": "codex/example",
  "head": "40-character Git commit hash",
  "status": "changes_requested",
  "passes": [
    {
      "round": 1,
      "reviewer": "persistent-reviewer-task-id",
      "reviewedAt": "2026-08-08T08:00:00.000Z",
      "diffHash": "sha256:64-character diff hash",
      "outcome": "changes_requested",
      "addedFindings": ["GWEN-R001"],
      "closedFindings": [],
      "reopenedFindings": [],
      "summary": "Complete diff reviewed; one issue found."
    }
  ],
  "findings": [
    {
      "id": "GWEN-R001",
      "priority": "P1",
      "disposition": "open",
      "openedInRound": 1
    }
  ]
}
-->
```

Resolution and verification evidence carries the round it targets. A builder working after round 1
records resolution evidence for round 2; the round-2 reviewer either closes or reopens it and may
add new findings in the same complete-diff pass.
