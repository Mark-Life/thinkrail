---
id: submodule-server-host-handlers
type: submodule-design
status: active
title: host/handlers — the typed WS method registry
parent: submodule-server-host
depends-on: [module-contracts]
tags: [host, public-surface-checked]
---

## Responsibility

Map every `WsMethodMap` method to exactly one handler and dispatch a wire request to it.

## Boundary

- **Owns:** one file per namespace group (`project`, `workspace`, `session`, `todo`, `review`, `repo`,
  `terminal`, `models`, `app`), each a `HandlersFor<prefix>` table, plus `types.ts` (`WsHandlers`,
  `HandlersFor`, `RequestContext`). The barrel spreads the tables into one `WsHandlers` value and owns
  `handleRequest`.
- **Public surface (barrel):** `handleRequest`, `requestMethodDiagnostic`, `shouldRefreshOpenReview`.
- **Allowed deps:** `contracts` (method map, wire types); `shared` (`codedError`); the feature modules and host siblings listed in
  [[submodule-server-host]].
- **Forbidden:** importing `server.ts` or `boot.ts`; being imported by feature modules.

## Get right

- **The compiler owns completeness.** `WsHandlers` maps directly over `WsMethodName`, so a missing method
  fails at the barrel and a wrong param or result type fails at the handler. Each namespace table is
  annotated `HandlersFor<…>`, so an extra key fails there too; merging alone skips that check.
- **Table prefixes stay disjoint.** Spread lets a later table silently win; disjoint `HandlersFor`
  prefixes make a cross-table duplicate an excess-property error.
- **One boundary narrowing.** `handleRequest` keeps `(method: string, params: unknown)`, guards the method
  with `Object.hasOwn`, and narrows `params` to `WsParams<M>` once at its call into `dispatch`, the
  generic typed call. Handlers never cast `params`; params are not shape-validated at runtime.
- **No destructuring in handler signatures.** Clients may omit params: read `params` in the body, after
  any side effect that must run first.
