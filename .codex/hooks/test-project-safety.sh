#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

pass=0
fail=0
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

tool_case 2 apply_patch "$corpus/answers/1.json" "patching the corpus"
tool_case 2 Write "$corpus/students.json" "writing the corpus"
tool_case 0 view_image "$corpus/scan.png" "reading the corpus"
tool_case 0 apply_patch "docs/DEVELOPMENT.md" "patching this repo"

command_case 2 "rm -rf $corpus/answers" "removing corpus files"
command_case 2 "jq . input.json > $corpus/output.json" "redirecting into corpus"
command_case 2 "sed -i '' 's/a/b/' $corpus/students.json" "editing corpus in place"
command_case 0 "jq . $corpus/answers/1.json" "reading a corpus file"
command_case 0 "rm -rf /tmp/gwen-scratch" "removing unrelated scratch data"

printf '%s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
