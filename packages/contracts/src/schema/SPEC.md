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
- **Allowed deps:** `@earendil-works/pi-schema`; `import type` from `@earendil-works/pi-ai` for pi-owned types.
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
- **A pi shape in params has real values.** `ImageContent` lists its fields, annotated `Schema<pi's type>`, so a
  field pi adds or a field the schema drops fails `tsc` here. `StopReason` lists its values the same way.
- **A pi shape with no schema is results only.** `piOwned<T>()` carries pi's type with a bare object check, as in
  `Message` inside `TranscriptMessage`. Params never use it: dispatch would not check them.
- **A recursive shape keeps its hand type.** Builders cannot express `FileNode`, so it stays an interface beside a
  raw JSON Schema annotated `Schema<FileNode>`. `$id` makes its `$ref: "#"` point at the node, not at the schema
  that embeds it.
- **An exclusive union keeps its hand type.** Builders cannot express the `?: never` branches of
  `TemplateReadLocation`, so it stays a type beside a raw JSON Schema annotated `Schema<TemplateReadLocation>`:
  `not: { required: [...] }` refuses both ids, and `template.get` adds its fields with `allOf`.
- **A readonly wire array stays readonly.** `readonlyArr` keeps the `readonly` of the queue types, which hold
  pi's own arrays.
- **No tests that restate a schema.** Test what a boundary does with a refusal, not what `str()` accepts.
