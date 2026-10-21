#!/usr/bin/env bash
# Usage: remoteRun.sh <pid-file> <command...>
set -m
command -v bun >/dev/null 2>&1 || PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
	echo "perf:compare[$(hostname)]: bun not on PATH for non-interactive ssh (looked in ~/.bun/bin too)" >&2
	exit 6
fi
pidfile=$1
shift
mkdir -p "$(dirname "$pidfile")"
"$@" </dev/null &
job=$!
echo "$job" >"$pidfile"
(
	cat >/dev/null
	kill -TERM -- "-$job" 2>/dev/null
) &
watch=$!
wait "$job"
status=$?
kill -- "-$watch" 2>/dev/null
exit "$status"
