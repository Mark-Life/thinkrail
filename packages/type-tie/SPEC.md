---
id: module-type-tie
type: module-design
status: active
title: type-tie — the exact-type tie
parent: architecture
references: [module-contracts, submodule-contracts-schema]
tags: [types]
---

## Responsibility

One type-only helper, `Same<A, B>`: it is `A`, and it compiles only while `A` and `B` are exactly the
same type. A declared shape uses it to tie itself to the type that owns the shape, so drift on either
side (a field added, removed or renamed, optional versus required, a union member added or dropped)
fails `tsc`. It flattens intersections first, so `{ a } & { b? }` equals `{ a; b? }`.

`index.test.ts` holds the negative checks: each `@ts-expect-error` proves one kind of drift fails.

## Public surface

- `Same` (type only).

## Boundary

- **Allowed deps:** none. The package has no runtime code, so any package may import it type-only,
  including the `pi-*` packages that may not import `@thinkrail/*`.
- **Forbidden:** any import. A value export would turn this into a runtime dependency.
