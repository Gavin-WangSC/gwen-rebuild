#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
payload=$(jq -c '.tool_input // {}' <<<"$input" 2>/dev/null || printf '{}')
tool_name=$(jq -r '.tool_name // .tool // ""' <<<"$input" 2>/dev/null || printf '')

# This is the only irreplaceable local data near the repo. Reads are allowed;
# writes are not. ApplyPatch/Write/Edit-style tools expose the target somewhere
# in tool_input, so inspect the complete payload instead of assuming one field.
if [[ "$payload" == *gwen-app/data* ]]; then
	lower_tool=$(printf '%s' "$tool_name" | tr '[:upper:]' '[:lower:]')
	if [[ "$lower_tool" =~ (apply_patch|write|edit|delete|remove|move|rename) ]]; then
		echo "Blocked: a mutating tool targeted gwen-app/data/." >&2
		echo "That directory contains untracked student work without a backup." >&2
		exit 2
	fi
fi

command=$(jq -r '.tool_input.command // .tool_input.cmd // ""' <<<"$input" 2>/dev/null || printf '')
if [[ "$command" == *gwen-app/data* ]]; then
	destructive='(^|[[:space:];&|(])(rm|rmdir|mv|dd|shred|unlink|truncate)([[:space:]]|$)'
	redirect='>>?[[:space:]]*[^[:space:];&|]*gwen-app/data'
	sed_command='(^|[[:space:];&|(])sed([[:space:]]|$)'

	if [[ "$command" =~ $destructive ]]; then
		reason="a destructive command"
	elif [[ "$command" =~ $redirect ]]; then
		reason="a redirection into the student corpus"
	elif [[ "$command" =~ $sed_command ]] && [[ "$command" == *-i* ]]; then
		reason="an in-place sed"
	else
		reason=""
	fi

	if [[ -n "$reason" ]]; then
		echo "Blocked: $reason touching gwen-app/data/." >&2
		echo "That directory contains untracked student work without a backup." >&2
		exit 2
	fi
fi

exit 0
