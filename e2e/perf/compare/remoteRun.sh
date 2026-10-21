#!/usr/bin/env bash
# Usage: remoteRun.sh <pid-file> <command...>
set -m
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
