---
id: submodule-contracts-schema
type: submodule-design
status: active
title: schema — wire schemas and the types derived from them
parent: module-contracts
depends-on: []
tags: [wire]
---

## Responsibility

Hold each wire shape once, as a `pi-schema` schema with its type derived by `Static`, so the compile-time type
and the runtime check cannot differ. `WS_METHOD_SCHEMAS` maps a method to its params and result schemas, and
`WsMethodMap` extends the entries derived from it. Methods still written by hand in `WsMethodMap` have no
runtime form yet.

## Boundary

- **Public surface (`index.ts`):** the entity schemas with their types, `Ack`, `WS_METHOD_SCHEMAS`,
  `WsSchemaMethodMap`. `wireObj` and `NoParams` stay inside this directory.
- **Allowed deps:** `@earendil-works/pi-schema`.
- **Forbidden:** importing the rest of `contracts`, so a schema never depends on a hand-written type; compiling
  a schema here, because each side owns the check at its own edge ([[submodule-server-host]] for requests).

## Rules

- **Wire objects are open.** `wireObj` allows unknown fields, so a UI and a host of different versions keep
  working together. `obj()` without `open` is closed, so it is not used for wire shapes.
- **One file per method namespace.** A namespace file exports its entity schemas and a `*_METHODS` record;
  `methods.ts` merges the records. An entity several namespaces share gets its own file.
- **Schemas check shape only.** A rule that needs host state or gives the user a specific message, such as the
  URL rules of `project.clone`, stays with its handler. A handler does not check the shape again.
- **A wire change is a schema edit.** It shows in the diff under this directory: decide on a `PROTOCOL_VERSION`
  bump in the same change.
- **A `pi` union is listed by value.** `ThinkingLevel` and `WireModel.input` copy pi's values, with no type
  import from `pi`. A value pi adds or removes fails `tsc` in `packages/server`, where pi's values meet these types.
- **No tests that restate a schema.** Test what a boundary does with a refusal, not what `str()` accepts.
