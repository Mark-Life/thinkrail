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

- **Public surface (`index.ts`):** what `index.ts` re-exports. `wireObj`, `partialWireObj`, `readonlyArr`, `NoParams`
  and `NoPayload` stay inside this directory, and only `@thinkrail/contracts/test-ids` exports the `test*` id makers.
  Schema values stay public because [[submodule-server-host]] and [[submodule-web-transport]] compile them, so they
  ship in web JS.
- **Allowed deps:** `@earendil-works/pi-schema`; `import type` from `@earendil-works/pi-ai` and
  `@earendil-works/pi-agent-core` for pi-owned types.
- **Forbidden:** importing the rest of `contracts`, so a schema never depends on a hand-written type; compiling
  a schema here, except `JsonObject` in `checks.ts` and the id parsers: an id reaches code from a URL, a file name or
  a pi event, with no method schema to check it. Each side owns the check at its own edge ([[submodule-server-host]] for requests).

## Rules

- **Wire objects are open.** `wireObj` allows unknown fields, so a UI and a host of different versions keep
  working together. `obj()` without `open` is closed, so it is not used for wire shapes, except `FontFamilyRef`:
  each branch holds one key, and a ref with both keys would read as two fonts.
- **A `Partial` wire type uses `partialWireObj`.** `AppConfigUpdate` and `PartialAppConfig` take the fields of `AppConfig`,
  so a setting is declared once. `AppConfigUpdate` also closes its key set through `propertyNames`, built from the
  same field table, and adds the request rules JSON Schema holds: non-blank names, a named model, and consent only
  with the preference. `PartialAppConfig` is what a reader of a stored or older config checks field by field.
- **One file per method namespace.** A namespace file exports its entity schemas, a `*_METHODS` record and, if it owns
  a push channel, a `*_CHANNELS` record; `methods.ts` and `channels.ts` merge the records. An entity several namespaces share gets its own file.
- **Schemas check shape and fixed bounds.** A setting's range (`LineWidth`, `CodeFontSize`, `SettleIdleDays`, ...), a
  font family name's pattern and a fallback list's size live in the schema, with the constant that names them. A rule
  that needs host state, or gives the user a specific message, such as the URL rules of `project.clone`
  or a canonical locale tag, stays with its handler. A handler does not check the shape again.
- **A wire change is a schema edit.** It shows in the diff under this directory: decide on a `PROTOCOL_VERSION`
  bump in the same change.
- **A dependency's shape is derived, never copied.** A type a dependency owns is imported, not declared again. A schema
  that checks a shape the dependency types but ships no schema for is tied to that type with `Same` (`typeTie.ts`), so a
  field or value either side adds, drops or changes fails `tsc`. `ThinkingLevel`, `PiStopReason`, `ImageContent`,
  `CustomMessageContent`, `ModelInputModality`, `ModelListPrice` and `WireModel`'s pi fields are tied to pi-ai here.
  pi-ai ships schemas for the model ones (`ModelThinkingLevelSchema`, `ModelInputModalitySchema`, `ModelCostSchema`),
  but only on a `providers/*` subpath, and browser code may import pi only as types from a package root; so they are
  declared and tied instead. pi-coding-agent is Node-only,
  so the shapes it owns (`WireCustomMessage`, `WireCompactionSummary`, `WireBranchSummary`, `WireBashExecution`, pi's session
  events in `PiEvent`, `CompactionEndResult`, `SessionStats`, `ContextUsage`, `SlashCommandInfo`) are declared here and
  tied in the host's `piWireTies.ts` ([[submodule-server-agent]]). Packages outside contracts tie the shapes they parse
  the same way. A `Schema<T>` annotation checks one way only and misses a field the dependency adds.
- **pi's messages and events are the two trust points.** pi ships their types and no schemas. `TranscriptMessage` checks
  `role` against `TRANSCRIPT_MESSAGE_ROLES`. `SessionEventPayload`, the `pi.event` payload, checks `sessionId` and
  `event.type` against `PI_EVENT_TYPES`. Each list is tied to its union with `Same`. The rest of the body is pi's type, as
  the host got it from pi: `TranscriptMessage` is pi-ai's `UserMessage`, `AssistantMessage` and `ToolResultMessage` plus
  the two pi-coding-agent mirrors, and `PiEvent` is pi-agent-core's `AgentEvent` plus pi-coding-agent's session events,
  with each message typed `WireAgentMessage` by `WithWireMessages`. The host rebuilds four events (`PiProjectedEventType`);
  the rest pass as pi typed them (`PiForwardedEvent`).
- **A recursive shape keeps its hand type.** A derived type cannot refer to itself, so `FileNode` and
  `LayoutPresetCenterNode` stay hand types. Their schemas are builder results that `tsc` checks against the hand type;
  only the `{ $ref: "#" }` each one nests is a raw JSON Schema annotated `Schema<...>`. `$id` makes that `$ref` point at
  the node, not at the schema that embeds it.
- **A preset center in params is only an object.** A recursive `$ref` walks the input with no depth limit, so
  `settings.update` types `center` as `Record<string, unknown>`. `validateLayoutPreset` checks shape and depth by hand first,
  then the bounded preset against `LayoutPreset`. `AppConfig` results keep the recursive schema.
- **No schema claims more than it checks.** A `Schema<T>` annotation sits on a builder result that `tsc` checks against `T`,
  or on a raw JSON Schema for what builders cannot express (a recursive `$ref`, `TemplateReadLocation`), which states
  every field of `T`. `narrowed` in `settings.ts` is the third raw one: an `allOf` of a `Schema<T>` and more rules, so
  it accepts less than `T`'s schema and claims nothing more. `NoParams` and `NoPayload` are any object, because the handler reads nothing from them. The two
  trust points above are the only exceptions.
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
- **Ids are branded and checked.** `ProjectId`, `WorkspaceId`, `StoredSessionId` and `SessionId` in `ids.ts` are
  branded strings, so a call site cannot swap them. `brandedString` is the one place that claims a brand, and every id
  value comes out of a parser that compiles beside its schema. `newProjectId` and `newWorkspaceId` parse `randomUuid`,
  built on `getRandomValues` because `crypto.randomUUID` is missing on a plain-HTTP client; pi owns session ids, so
  they have no generator. Tests make ids with the `test*` makers of `@thinkrail/contracts/test-ids`, and a refusal test
  sends the raw string. `check:boundaries` refuses that entry outside test sources, and a relative import of `ids.ts`
  from another module. `DelegationRunDetails.childSessionId` stays a `string`: it mirrors the `pi-delegation` type,
  and a test pins the two.
- **An id has a strict check for a request and a lenient one for a read.** A request value may reach a file path, so
  it is strict. A stored value must never drop from a list, so it is lenient. `ids.test.ts` fails on a request field
  with a stored schema, or a reply or push with a strict one.

  | Id | Request field, route, `parseX` | Reply, push, stored file, `parseStoredX` | Type |
  |---|---|---|---|
  | project | UUID, any version, lowercase | non-empty | `ProjectId` for both |
  | workspace | UUID, any version, lowercase | path-safe | `WorkspaceId` for both |
  | session | path-safe | any string | `SessionId`, a subtype of `StoredSessionId` |

  A brand carries only path safety, the one thing code relies on. Only `SessionId` fits a path builder; a stored session
  id becomes one through `parseSessionId` where code acts on it, and a refusal skips the action while the session still
  lists. The owning module's SPEC names its path builders and those places. Path-safe is pi's `--session-id` grammar, up
  to 200 characters. A stored project or workspace id that is not a UUID (a hand edit or a test seed) still lists, but a
  request that names it gets `INVALID_PARAMS`. A workspace read stays path-safe because removal deletes the workspace
  directory recursively ([[submodule-server-agent]]). A stored session id is any string because pi only checks for a
  string, so a session from the pi CLI still lists. A live session id from pi goes through `requireSessionId`, which
  fails with `PI_SESSION_ID_INVALID`. `WsRequestFrame.sessionId` is a plain string: only the replay fingerprint reads it.
  No check is a v4 or v7 regex, so a generator change cannot refuse a real id.
- **A reply is a union on `ok`.** A failure always carries `error`. Its `errorCode` is any string: a newer host may send a
  code this client has no name for. `WS_ERROR_CODES` lists the names, and the client reads a code outside it as no code.
  `INVALID_REPLY` is never sent: the client mints it.
- **One object check here; reply and push checks outside.** `checks.ts` exports `JsonObject`, for a reader that checks fields
  one by one. Result and channel schemas compile in contracts' `wireChecks.ts`, whose `parseWsResult` and `parseWsPush` the
  web transport, e2e fixtures and artifact probes share: it reads `WsResult` and `WsChannelPayload`, which this directory may not import.
- **`@ts-expect-error` only in a negative type test**, one that proves bad code fails to compile, as `typeTie.test.ts`
  does for `Same`.
- **No tests that restate a schema.** Test what a boundary does with a refusal, not what `str()` accepts.
