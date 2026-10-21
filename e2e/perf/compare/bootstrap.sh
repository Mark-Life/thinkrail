#!/usr/bin/env bash
# Usage: bootstrap.sh <origin-url> <tool-sha> "<sha...>" "<browser...>"
set -eu
origin=$1
tool=$2
shas=$3
browsers=$4
cache=${THINKRAIL_PERF_CACHE:-$HOME/.cache/thinkrail-perf}
repo=$cache/repo.git
host=$(hostname)
lock=$cache/locks/bootstrap

command -v bun >/dev/null 2>&1 || PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
	echo "perf:compare[$(hostname)]: bun not on PATH for non-interactive ssh (looked in ~/.bun/bin too)" >&2
	exit 6
fi

mkdir -p "$cache/locks"
waited=0
until mkdir "$lock" 2>/dev/null; do
	owner=$(cat "$lock/pid" 2>/dev/null || true)
	if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
		rm -rf "$lock"
		continue
	fi
	if [ -z "$owner" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
		rm -rf "$lock"
		continue
	fi
	if [ "$waited" -eq 0 ]; then echo "perf:compare[$host]: waiting for another bootstrap" >&2; fi
	waited=$((waited + 1))
	if [ "$waited" -gt 3600 ]; then
		echo "perf:compare[$host]: timed out waiting for $lock" >&2
		exit 5
	fi
	sleep 1
done
trap 'rm -rf "$lock"' EXIT
echo "$$" >"$lock/pid"

if [ -d "$cache/runs" ]; then
	find "$cache/runs" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} +
fi

if [ ! -f "$repo/HEAD" ]; then
	echo "perf:compare[$host]: cloning $origin into $repo" >&2
	git clone --bare --quiet "$origin" "$repo"
fi
git -C "$repo" fetch --quiet "$origin" '+refs/heads/*:refs/remotes/origin/*'
for sha in $tool $shas; do
	if ! git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null; then
		echo "perf:compare[$host]: $sha not found in $origin after fetch; push it" >&2
		exit 3
	fi
done

dir=$cache/tool/$tool
if [ ! -e "$dir/.git" ]; then
	rm -rf "$dir" "$dir.tmp"
	git -C "$repo" worktree prune
	git -C "$repo" worktree add --detach --quiet "$dir.tmp" "$tool"
	git -C "$repo" worktree move "$dir.tmp" "$dir"
fi
cd "$dir"
if [ ! -f node_modules/.perf-tool-installed ]; then
	echo "perf:compare[$host]: bun install in $dir" >&2
	HUSKY=0 bun install --frozen-lockfile >&2
	touch node_modules/.perf-tool-installed
fi

for browser in $browsers; do
	missing=$(bun x playwright install --dry-run "$browser" 2>/dev/null |
		awk '/Install location:/ { print $3 }' |
		while read -r path; do [ -d "$path" ] || echo "$path"; done)
	if [ -n "$missing" ]; then
		echo "perf:compare[$host]: installing Playwright $browser into the user cache" >&2
		if ! bun x playwright install "$browser" >&2; then
			echo "perf:compare[$host]: Playwright $browser is missing and install failed; run 'bun x playwright install $browser' in $dir (system deps need 'install-deps')" >&2
			exit 4
		fi
	fi
done

echo "$dir"
echo "$cache"
