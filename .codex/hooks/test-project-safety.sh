#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

pass=0
fail=0
repo_root=$(cd ../.. && pwd)
review_path="$repo_root/review.md"
review_backup_dir=$(mktemp -d "${TMPDIR:-/tmp}/gwen-safety-review.XXXXXX")
review_had_original=0

if [[ -f "$review_path" ]]; then
	cp -p "$review_path" "$review_backup_dir/review.md"
	review_had_original=1
fi

restore_review_mailbox() {
	if [[ "$review_had_original" -eq 1 ]]; then
		cp -p "$review_backup_dir/review.md" "$review_path"
	else
		rm -f "$review_path"
	fi
	rm -rf "$review_backup_dir"
}
trap restore_review_mailbox EXIT
corpus='../GWen/gwen-app/data'

check() {
	local expected=$1 payload=$2 label=$3 actual
	printf '%s' "$payload" | ./guard-project-safety.sh >/dev/null 2>&1
	actual=$?
	if [[ "$actual" == "$expected" ]]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		printf 'FAIL expected %s, got %s: %s\n' "$expected" "$actual" "$label"
	fi
}

tool_case() {
	check "$1" "$(jq -nc --arg t "$2" --arg p "$3" \
		'{tool_name: $t, tool_input: {file_path: $p}}')" "$4"
}

command_case() {
	check "$1" "$(jq -nc --arg c "$2" \
		'{tool_name: "exec_command", tool_input: {cmd: $c}}')" "$3"
}

non_command_text_case() {
	check "$1" "$(jq -nc --arg t "$2" --arg c "$3" \
		'{tool_name: $t, tool_input: {cmd: $c}}')" "$4"
}

install_unresolved_review_fixture() {
	local snapshot branch head diff_hash state
	snapshot=$(cd "$repo_root" && bun run review:fingerprint 2>/dev/null)
	branch=$(jq -r '.branch' <<<"$snapshot")
	head=$(jq -r '.head' <<<"$snapshot")
	diff_hash=$(jq -r '.diffHash' <<<"$snapshot")
	state=$(jq -n \
		--arg branch "$branch" \
		--arg head "$head" \
		--arg diffHash "$diff_hash" \
		'{
			schemaVersion: 2,
			scope: "uncommitted",
			branch: $branch,
			head: $head,
			status: "changes_requested",
			passes: [{
				round: 1,
				reviewer: "safety-hook-fixture",
				reviewedAt: "2026-08-08T00:00:00.000Z",
				diffHash: $diffHash,
				outcome: "changes_requested",
				addedFindings: ["GWEN-R999"],
				closedFindings: [],
				reopenedFindings: [],
				summary: "Isolated unresolved fixture for the safety hook."
			}],
			findings: [{
				id: "GWEN-R999",
				priority: "P2",
				disposition: "open",
				openedInRound: 1
			}]
		}')
	printf '# Safety-hook fixture\n\n## GWEN-R999\n\nUnresolved test finding.\n\n<!-- review-state\n%s\n-->\n' \
		"$state" >"$review_path"
}

tool_case 2 apply_patch "$corpus/answers/1.json" "patching the corpus"
tool_case 2 Write "$corpus/students.json" "writing the corpus"
tool_case 0 view_image "$corpus/scan.png" "reading the corpus"
tool_case 0 apply_patch "docs/DEVELOPMENT.md" "patching this repo"

command_case 2 "rm -rf $corpus/answers" "removing corpus files"
command_case 2 "jq . input.json > $corpus/output.json" "redirecting into corpus"
command_case 2 "sed -i '' 's/a/b/' $corpus/students.json" "editing corpus in place"
command_case 0 "jq . $corpus/answers/1.json" "reading a corpus file"
command_case 0 "rm -rf /tmp/gwen-scratch" "removing unrelated scratch data"
install_unresolved_review_fixture
command_case 2 "git commit -m runner" "committing with unresolved review findings"
command_case 0 "git push origin HEAD" "leaving push enforcement to branch protection"
non_command_text_case 0 apply_patch "document git commit behavior" "patch text naming a commit"
non_command_text_case 0 Write "document git push behavior" "write text naming a push"

printf '%s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
