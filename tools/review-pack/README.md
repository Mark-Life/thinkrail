# review-pack

Prints a review guide for one branch of a stacked PR series. Personal tool, not part of the app.

```sh
bun tools/review-pack/review-pack.ts <PR#|branch> [--base ref] [--repo owner/name] [--md]
```

A PR number resolves through `gh pr view` on `Mark-Life/thinkrail` unless `--repo` is set. The PR's
head and base branches become the diff range. A branch name diffs against `main`, or against
`--base`. Local refs win over `origin/*`, so fetch first. `--md` prints markdown instead of terminal
text.

The output has six sections:

- Commits in the range, with file count and churn.
- Churn by role: production, tests, specs+docs, generated, config.
- Reading order: specs first, then files to read closely, to skim, and to trust.
- Public surface changes: changed exports, barrels, locale keys, CSS tokens and `PROTOCOL_VERSION`.
- New and removed test names.
- Union and state types whose members changed.

Known weak spots of the heuristics:

- Parsing uses regex, not the TypeScript AST. Multi-line or unusual declarations can be missed.
- Roles come from the path only. Every `.md` counts as a spec and every `.tsx` file as "skim".
- A renamed test counts as new. Test names built at runtime are not found.
- Renames are off (`--no-renames`), so a moved file shows as a delete plus an add.
- Union member parsing counts brackets and can miscount on generics or strings that hold `|`.
- A stale local branch gives a stale pack.
