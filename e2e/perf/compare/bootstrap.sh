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

if [ ! -f "$repo/HEAD" ]; then
	mkdir -p "$cache"
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
	git -C "$repo" worktree prune
	git -C "$repo" worktree add --detach --quiet "$dir" "$tool"
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
