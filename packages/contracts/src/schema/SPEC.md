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
- **Allowed deps:** `@earendil-works/pi-schema`; `import type` from `@earendil-works/pi-ai` for pi-owned types.
- **Forbidden:** importing the rest of `contracts`, so a schema never depends on a hand-written type; compiling
  a schema here, except `JsonObject` in `checks.ts` and the id parsers: an id reaches code from a URL, a file name or
  a pi event, with no method schema to check it. Each side owns the check at its own edge ([[submodule-server-host]] for requests).

## Rules

- **Wire objects are open.** `wireObj` allows unknown fields, so a UI and a host of different versions keep
  working together. `obj()` without `open` is closed, so it is not used for wire shapes, except `FontFamilyRef`:
  each branch holds one key, and a ref with both keys would read as two fonts.
- **A `Partial` wire type uses `partialWireObj`.** `AppConfigUpdate` and `PartialAppConfig` take the fields of `AppConfig`,
  so a setting is declared once. The update stays open here; `updateConfig` owns the closed key set. `PartialAppConfig`
  is what a reader of a stored or older config checks field by field.
- **One file per method namespace.** A namespace file exports its entity schemas, a `*_METHODS` record and, if it owns
  a push channel, a `*_CHANNELS` record; `methods.ts` and `channels.ts` merge the records. An entity several namespaces share gets its own file.
- **Schemas check shape and fixed bounds.** A setting's range (`LineWidth`, `CodeFontSize`, `SettleIdleDays`, ...), a
  font family name's pattern and a fallback list's size live in the schema, with the constant that names them. A rule
  that needs host state, crosses fields, or gives the user a specific message, such as the URL rules of `project.clone`
  or a canonical locale tag, stays with its handler. A handler does not check the shape again.
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
- **Ids are branded and checked.** `ProjectId`, `WorkspaceId`, `StoredSessionId` and `SessionId` in `ids.ts` are strings
  with a brand. A wire field uses the one for its entity, so a call site cannot swap them. `brandedString` is the one
  place that claims a brand: it types each id schema with the brand that schema proves, and nothing else in contracts
  asserts an id type. Every id value comes out of a parser, so a branded value has passed its check. `newProjectId` and
  `newWorkspaceId` parse `randomUuid`, which builds on `getRandomValues` because `crypto.randomUUID` is missing on a
  plain-HTTP client. A session id has no generator, because pi owns it. Each parser compiles in `ids.ts`, beside its schema.
  Tests make ids with `testProjectId`, `testWorkspaceId`, `testSessionId` and `testStoredSessionId` from `@thinkrail/contracts/test-ids`; each runs the parser for
  its brand and throws on a refusal. A test of a refusal sends the raw string, since dispatch takes `unknown` params.
  `check:boundaries` refuses that entry outside test sources, and refuses a relative import of `ids.ts` from another module.
  `DelegationRunDetails.childSessionId` stays a `string`: it mirrors the `pi-delegation` type, and a test pins the two.
- **An id has two checks: one for a request, one for a read.** A value a caller supplies must be able to reach a file path and
  name a real entity, so it is strict. A value read back from disk must never disappear from a list, so it is lenient. `ids.test.ts`
  walks the wire and fails on a request field with a stored schema, or a reply or push with a strict one.

  | Id | Request field, route, `parseX` | Reply, push, stored file, `parseStoredX` | Type |
  |---|---|---|---|
  | project | UUID, any version, lowercase | non-empty | `ProjectId` for both |
  | workspace | UUID, any version, lowercase | path-safe | `WorkspaceId` for both |
  | session | path-safe | any string | `SessionId`, a subtype of `StoredSessionId` |

  A brand carries what code relies on, and code relies only on path safety. Both workspace checks are path-safe and no
  project id reaches a path, so each has one brand. A session id has two: `SessionId` is path-safe, `StoredSessionId` is
  any string, and only `SessionId` fits a function that builds a path. A stored id becomes a `SessionId` through
  `parseSessionId` where code acts on it, and a refusal there skips the action, so the session still lists. The owning
  module's SPEC names its path builders and the places it acts on a stored id.

  Path-safe is pi's `--session-id` grammar with a limit of 200 characters. Every release writes `randomUUID()` for a project
  or workspace, so a non-UUID there is a hand edit or a test seed. A reply may still carry one: it stays listed, and a request
  that names it gets `INVALID_PARAMS`, so the app cannot rename or remove it. The way out is to edit the stored file. A
  workspace read is still path-safe because a workspace id names a directory that removal deletes recursively
  ([[submodule-server-agent]]), so `../..` in `workspaces.json` must drop, not load. Session ids stay any string on a read because pi owns that parse and only checks for
  a string: a session from the pi CLI or an older pi file still lists. The way out is to delete its file. A session id pi
  names for a live session goes through `requireSessionId`, which fails with `PI_SESSION_ID_INVALID`.
  `WsRequestFrame.sessionId` is a plain string, not an id: only the replay fingerprint reads it, and a frame that fails its
  schema gets no reply. The checks are not v4 and v7 regexes: those describe today's generators, and a gate on them would
  refuse a real id when a generator changes.
- **A reply is a union on `ok`.** A failure always carries `error`. Its `errorCode` is any string: a newer host may send a
  code this client has no name for. `WS_ERROR_CODES` lists the names, and the client reads a code outside it as no code.
  `INVALID_REPLY` is never sent: the client mints it.
- **One object check here; reply and push checks outside.** `checks.ts` exports `JsonObject`, for a reader that checks fields
  one by one. Result and channel schemas compile in contracts' `wireChecks.ts`, whose `parseWsResult` and `parseWsPush` the
  web transport, e2e fixtures and artifact probes share: it reads `WsResult` and `WsChannelPayload`, which this directory may not import.
- **`@ts-expect-error` only in a negative type test**, one that proves bad code fails to compile, as `typeTie.test.ts`
  does for `Same`.
- **No tests that restate a schema.** Test what a boundary does with a refusal, not what `str()` accepts.
