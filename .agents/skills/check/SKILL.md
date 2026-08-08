---
name: 'check'
description: "Run GWen's complete definition-of-done gate and report its real output. Use before calling implementation work complete or when the user asks to verify the repository."
metadata:
  short-description: "Run and report GWen's full check gate"
---

# Check GWen

Run the repository's single verification gate from its root:

```bash
bun run check
```

Do not replace it with a subset or infer success from individual commands. Report the real summary,
including test counts and any Svelte, lint, or formatting errors. If any stage fails, say the work is
incomplete and diagnose the failure without weakening or deleting a test.

Before handoff, also inspect `git diff --check` and `git status --short` so uncommitted files and
whitespace errors are visible. Never stage, commit, push, or open a pull request unless the user
authorizes that Git action.
