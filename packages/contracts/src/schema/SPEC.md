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
`WS_CHANNEL_SCHEMAS` does the same for push channels: `WsChannelMap` derives from it, and `WsChannelPayload<C>` reads
that map.

## Boundary

- **Public surface (`index.ts`):** `export *` of every namespace and entity file: the entity schemas with their
  types, the `*_METHODS` and `*_CHANNELS` records, `WS_METHOD_SCHEMAS`, `WsSchemaMethodMap`, `WS_CHANNEL_SCHEMAS`,
  `WsSchemaChannelMap`, `WsEnvelope`, `WsResponse`, `WsErrorCode`, `AnyHostWelcome`. From `wire.ts` only `Ack`: `wireObj`,
  `partialWireObj`, `readonlyArr`, `NoParams` and `NoPayload` stay inside this directory. Schema values stay
  public because [[submodule-server-host]] and [[submodule-web-transport]] compile them, so they ship in web JS.
- **Allowed deps:** `@earendil-works/pi-schema`; `import type` from `@earendil-works/pi-ai` for pi-owned types.
- **Forbidden:** importing the rest of `contracts`, so a schema never depends on a hand-written type; compiling
  a schema here, because each side owns the check at its own edge ([[submodule-server-host]] for requests).

## Rules

- **Wire objects are open.** `wireObj` allows unknown fields, so a UI and a host of different versions keep
  working together. `obj()` without `open` is closed, so it is not used for wire shapes.
- **A `Partial` wire type uses `partialWireObj`.** `AppConfigUpdate` takes the fields of `AppConfig`, so a setting is
  declared once. The update stays open here; `updateConfig` owns the closed key set.
- **One file per method namespace.** A namespace file exports its entity schemas, a `*_METHODS` record and, if it owns
  a push channel, a `*_CHANNELS` record; `methods.ts` and `channels.ts` merge the records. An entity several namespaces share gets its own file.
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
- **`pi.event` checks only its tag.** `pi` exports no event schemas, so its schema has `sessionId` and `event.type`, and
  `WsChannelMap` in `wsProtocol.ts` overrides the entry with `SessionEventPayload`. The interface `extends` the derived
  map, so the override must stay assignable to the schema's type.
- **A recursive shape keeps its hand type.** A derived type cannot refer to itself, so `FileNode` and
  `LayoutPresetCenterNode` stay hand types. Their schemas are builder results that `tsc` checks against the hand type;
  only the `{ $ref: "#" }` each one nests is a raw JSON Schema annotated `Schema<...>`. `$id` makes that `$ref` point at
  the node, not at the schema that embeds it.
- **A preset center in params is only an object.** A recursive `$ref` walks the input with no depth limit, so
  `settings.update` types `center` as `Record<string, unknown>`. `validateLayoutPreset` checks shape and depth by hand first,
  then the bounded preset against `LayoutPreset`. `AppConfig` results keep the recursive schema.
- **No schema claims more than it checks.** A `Schema<T>` annotation sits on a builder result that `tsc` checks against `T`,
  or on a raw JSON Schema for what builders cannot express (a recursive `$ref`, `TemplateReadLocation`), which states
  every field of `T`. `NoParams` and `NoPayload` are any object, because the handler reads nothing from them. The one
  exception is the `pi.event` push check in contracts' `wireChecks.ts`, typed `SessionEventPayload` over a tag-only
  schema, as the `pi.event` rule above states.
- **An enum is one tuple.** Each `oneOf` value list is an exported `as const` tuple, such as `THEME_MODES` or
  `WS_ERROR_CODES`. A guard or a list outside this directory reads that tuple, so there is no second copy to keep in step.
- **An exclusive union keeps its hand type.** Builders cannot express the `?: never` branches of
  `TemplateReadLocation`, so it stays a type beside a raw JSON Schema annotated `Schema<TemplateReadLocation>`:
  `not: { required: [...] }` refuses both ids, and `template.get` adds its fields with `allOf`.
- **A readonly wire array stays readonly.** `readonlyArr` keeps the `readonly` of the queue types, which hold
  pi's own arrays.
- **Result and channel schemas are proven by tests.** The host's test harnesses check real replies and pushes against
  them ([[submodule-server-host]]), so a mismatch is a schema bug or a host bug, not a tolerated drift. A wrong schema
  reaches users: [[submodule-web-transport]] refuses what fails it.
- **`server.welcome` has a floor.** The client checks `AnyHostWelcome`, not `ServerWelcome`: it is the only frame that names
  the host's version, and refusing it would leave the app with no projects. Older hosts omit later fields and send older
  shapes, so each entry is typed `Record<string, unknown>`. The client parses each project, `hostPlatform`, `hostUpdate` and
  `speech` against its schema, and the config field by field against `PartialAppConfig`, and drops and reports what fails. `ServerWelcome`
  must stay assignable to it. The test harness still checks `ServerWelcome`.
- **A reply is a union on `ok`.** A failure always carries `error`. Its `errorCode` is any string: a newer host may send a
  code this client has no name for. `WS_ERROR_CODES` lists the names, and the client reads a code outside it as no code.
  `INVALID_REPLY` is never sent: the client mints it.
- **No tests that restate a schema.** Test what a boundary does with a refusal, not what `str()` accepts.
