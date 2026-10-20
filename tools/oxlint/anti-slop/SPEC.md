---
id: module-anti-slop-lint
type: module-design
status: active
title: anti-slop oxlint plugin (vendored)
parent: architecture
references: [module-repo-scripts, module-ci-release]
tags: [tooling, lint]
---

## Responsibility

Oxlint JS plugin `anti-slop`: rules that reject low-evidence TypeScript, such as `unknown` inputs,
ad hoc `typeof` narrowing, and unexplained type assertions. Vendored source, owned by this repo from
the copy on. `UPSTREAM.md` records the source commit and local changes.

## Boundary

- **Public surface:** `index.ts`, the default-exported plugin, registered in `.oxlintrc.json` under
  `jsPlugins` as `anti-slop`.
- **Allowed deps:** `@oxlint/plugins`, pinned to the exact `oxlint` version.
- **Forbidden:** imports from any product package; product code importing this directory.
- Excluded from oxlint and oxfmt so upstream diffs stay small.

## Rule policy

- Every generic rule is on, plus `oxc/no-accumulating-spread`. The Effect rule group is not vendored:
  the repo does not use Effect.
- `require-readable-spacing` is off: style only, like the other cosmetic rules dropped in the Biome
  migration.
- `no-conditional-empty-object-spread` is off: with `exactOptionalPropertyTypes`, a conditional spread
  is the correct way to omit an optional field.
- `no-runtime-typeof` allows `typeof` inside type guards (`allowInTypeGuards`).
- `require-safety-comment-for-type-assertion` is off for `*.test.*`, `*.spec.*`, and `e2e/**`.
- A rule with no hits is `error`. A rule with hits is `warn`, and `scripts/lint-ratchet.ts` keeps each
  (rule, file) count from rising. Promote a rule to `error` once its baseline entry is gone.
