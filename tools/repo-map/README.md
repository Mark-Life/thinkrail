# repo-map

Shows a TypeScript codebase as a graph of modules, symbols and calls, including across the WebSocket wire, and compares two versions of it.

```
repo-map                          map the working tree of the repo holding cwd
repo-map diff [base] [head]       compare two graphs (also base..head, base...head)
repo-map pr <number> [--repo o/n] compare a GitHub PR against its merge-base
```

`diff` defaults to the merge-base of `HEAD` and `main` against the working tree.

Flags: `--port <n>` (default 4577, falls forward), `--no-open`, `--json <path>` (write JSON and exit), `--refresh` (ignore the cache), `--cwd <dir>`.

Run it from the repo root with `bun run repo-map`, or by absolute path from any directory or worktree:

```
bun /path/to/thinkrail/tools/repo-map/cli.ts diff main
```

Keys: `/` or `Cmd+K` search, `m` map, `t` trace, `f` flow, `c` changes, arrows move across trace nodes, `Enter` re-centers.

The target repo comes from cwd. Commit graphs are cached in `<git-common-dir>/repo-map`. See `SPEC.md` for how it works and what it misses.
