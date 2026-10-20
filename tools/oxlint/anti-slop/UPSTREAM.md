# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) `src/` at commit
`13909c9e07590f5a85d93c62712259fe14a883f7`. MIT, see `LICENSE`. `vendor/eslint-stylistic/` keeps
its own `UPSTREAM.md` and `LICENSE`.

## Local changes

- Not copied: `*.test.ts` (they need `tsx` and Oxlint's RuleTester) and `effect/` (the repo does not
  use Effect).
- No source edits.

## Updating

Clone the new upstream commit, diff its `src/` against this directory, port the changes, and update
the commit above. Keep `@oxlint/plugins` pinned to the same exact version as `oxlint`.
