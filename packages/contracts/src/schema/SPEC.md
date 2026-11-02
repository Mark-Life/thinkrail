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
and the runtime check cannot differ. `WS_METHOD_SCHEMAS` maps every method to its params and result schemas, and
`WsMethodMap` is the map derived from it, with no hand-written entry. It stays an interface: a generic
`WsParams<M>` reads the resolved entries, and a type alias would defer to `Static` and read as `unknown`.

## Boundary

- **Public surface (`index.ts`):** `export *` of every namespace and entity file: the entity schemas with their
  types, the `*_METHODS` records, `WS_METHOD_SCHEMAS`, `WsSchemaMethodMap`. From `wire.ts` only `Ack`: `wireObj`,
  `partialWireObj`, `readonlyArr` and `NoParams` stay inside this directory. Schema values stay public because
  [[submodule-server-host]] compiles them; web JS stays free of them by tree shaking.
- **Allowed deps:** `@earendil-works/pi-schema`; `import type` from `@earendil-works/pi-ai` for pi-owned types.
- **Forbidden:** importing the rest of `contracts`, so a schema never depends on a hand-written type; compiling
  a schema here, because each side owns the check at its own edge ([[submodule-server-host]] for requests).

## Rules

- **Wire objects are open.** `wireObj` allows unknown fields, so a UI and a host of different versions keep
  working together. `obj()` without `open` is closed, so it is not used for wire shapes.
- **A `Partial` wire type uses `partialWireObj`.** `AppConfigUpdate` takes the fields of `AppConfig`, so a setting is
  declared once. The update stays open here; `updateConfig` owns the closed key set.
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
- **A pi message has a real schema.** `TranscriptMessage` lists every pi role with the fields pi types, so a reply never
  carries a pi shape it did not check. `TextContent`, `ThinkingContent`, `Usage` and `UserMessage` check every field pi
  declares and are annotated with pi's type. pi types tool-call `arguments` and tool-result `details` as JSON, which a
  schema cannot state, so the assistant and tool-result messages keep their own derived types (`WireAssistantMessage`,
  `WireToolResultMessage`). pi's messages are assignable to them; the reverse is not.
- **A recursive shape keeps its hand type.** A derived type cannot refer to itself, so `FileNode` and
  `LayoutPresetCenterNode` stay hand types. Their schemas are builder results that `tsc` checks against the hand type;
  only the `{ $ref: "#" }` each one nests is a raw JSON Schema annotated `Schema<...>`. `$id` makes that `$ref` point at
  the node, not at the schema that embeds it.
- **An enum is one tuple.** Each `oneOf` value list is an exported `as const` tuple, such as `THEME_MODES` or
  `WS_ERROR_CODES`. A guard or a list outside this directory reads that tuple, so there is no second copy to keep in step.
- **An exclusive union keeps its hand type.** Builders cannot express the `?: never` branches of
  `TemplateReadLocation`, so it stays a type beside a raw JSON Schema annotated `Schema<TemplateReadLocation>`:
  `not: { required: [...] }` refuses both ids, and `template.get` adds its fields with `allOf`.
- **A readonly wire array stays readonly.** `readonlyArr` keeps the `readonly` of the queue types, which hold
  pi's own arrays.
- **No tests that restate a schema.** Test what a boundary does with a refusal, not what `str()` accepts.
