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
- **Allowed deps:** `@earendil-works/pi-schema`; `@earendil-works/pi-ai/providers/model-schema`; the leaf entries
  `pi-todos/wire`, `pi-background-commands/wire`, `pi-delegation/wire`, `pi-subagents/wire`, `pi-spec-graph/wire`
  and `@thinkrail/pi-ask-user-question/core`; `import type` from
  the `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` roots; `import type` from `type-tie`.
- **Forbidden:** any import of `@earendil-works/pi-coding-agent`, even type-only; any other entry of a pi package
  (`check:boundaries` refuses both); importing the rest of `contracts`, so a schema never depends on a hand-written type; compiling
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
- **One source per shape.** A shape something else defines is never written again here. Who owns it decides how:
  - **An in-repo pi package** (`pi-todos`, `pi-background-commands`, `pi-delegation`, `pi-subagents`) exports a
    `pi-schema` `wire` leaf: `as const` lists, enum schemas and `*_FIELDS` records. Its own types are `Static` of
    them. This directory value-imports the leaf and only extends it: a branded id, a host field, the `"adopted"`
    origin (`oneOf([...TODO_ORIGINS, "adopted"])`), a projection or a method's params, by spreading or destructuring
    the owner's record. `TodoStatus`, `TodoArtifactKind`, `TodoGroupStatus`, `BackgroundCommandStatus`,
    `CompletionDelivery`, `BACKGROUND_COMMAND_TERMINAL_STATUSES` and the two completion custom types are the owner's,
    re-exported. A pi package never imports `@thinkrail/*`, so the edge points one way.
  - **pi-ai** ships schemas on its `providers/model-schema` subpath, which loads only `pi-schema`:
    `ThinkingLevel` is `ModelThinkingLevelSchema` and `ModelInputModality` is `ModelInputModalitySchema`. Where
    `pi-schema` cannot pick fields at run time, a hand projection is `Same`-tied to a `Pick` of pi's type
    (`ModelListPrice`, `WireModelPiFields`). `ModelListPrice` stays the `{input, output}` projection rather than
    pi-ai's full `ModelCostSchema`: hosts since the picker-metadata protocol send only those two prices, and the
    web checks every reply, so requiring `cacheRead` / `cacheWrite` would refuse `model.list` from those hosts. A shape pi-ai ships only as a type (`ImageContent`, `TextContent`,
    `CustomMessageContent`) is declared here and `Same`-tied. `PiStopReason` is `pi-delegation/wire`'s
    `StopReason`, the one list of pi-ai's stop reasons, tied there.
  - **pi-coding-agent** is server-only, so browser code never sees its types, not even type-only (`AGENTS.md`).
    This is the one exception to "the type is pi's own": each shape it owns is declared here once and tied both
    ways in the server program (`piWireTies.ts`, `agent/mcp`, [[submodule-server-agent]]): the
    `Wire*` messages, pi's session events in `PiEvent`, `CompactionEndResult`, `SessionStats`, `ContextUsage`,
    `SlashCommand*`, `SessionEntryType`, the ext-UI params, `PiPackage*`, `ProviderWarning`, the MCP enums and
    `McpToolDetails`.
    A type pi does not export at its root is reached through an exported API, such as
    `ReturnType<PackageManager["listConfiguredPackages"]>[number]["scope"]`. The MCP server-config field schemas live
    in `mcp.ts`. A type no exported API names, such as `McpToolDetails`, is type-imported by a relative path into
    the server's `node_modules` (`pi-compatibility.md`).
  - **A host-owned shape** is a schema here. The desktop's native shapes are in `native.ts`; the desktop compiles
    them. A shape with a second representation, such as `theme.schema.json`, is generated from its schema or
    compared to it by a test.

  - **`NON_EXECUTABLE_STOP_REASONS`** is owned by the published `pi-ask-user-question`, which needs it for its
    restart repair and imports nothing from the repository. `transcript.ts` re-exports it from that package's
    `core` leaf as the host's rule for every tool.

  `Same` (from `type-tie`, re-exported here) fails `tsc` when either side adds, drops or changes a field or a union
  member. A `Schema<T>` annotation checks one way only and misses a field the dependency adds, so it is never a tie.
  Every tie sits in a file a `bun run typecheck` program includes.
- **pi's messages and events are the two trust points.** pi ships their types and no schemas. `TranscriptMessage` checks
  its envelope and `role` against `TRANSCRIPT_MESSAGE_ROLES`. `SessionEventPayload`, the `pi.event` payload, checks
  `sessionId` and `event.type` against `PI_EVENT_TYPES`. Each list is tied to its union with `Same`. The body is pi's own
  type, as the host got it from pi, so the host never refuses a pi-shaped reply or event. A tool event's `any` fields
  cross as `unknown`. A deep tie in the server program fails when pi carries an `AgentMessage` under a new event key.
  The host rebuilds four events (`PiProjectedEventType`); the rest pass as pi typed them (`PiForwardedEvent`).
- **A recursive shape uses `recursive`.** pi-schema has no recursive builder, so `recursive($id, build)` hands
  `build` a `$ref` to the result and names the result by `$id`. The `$ref` states the node type, and the caller
  ties `Static` of the result to that type with `Same`, so the claim is exact both ways; at run time the `$ref`
  checks the nested node against the same schema. `LayoutPresetCenterNode` is the one recursive shape.
- **A preset center in params is only an object.** A recursive `$ref` walks the input with no depth limit, so
  `settings.update` types `center` as `Record<string, unknown>`. `validateLayoutPreset` checks shape and depth by hand first,
  then the bounded preset against `LayoutPreset`. `AppConfig` results keep the recursive schema.
- **No schema claims more than it checks.** A schema is a builder result, or a builder result with more JSON
  Schema rules added to its `allOf` (`narrowed`), which accepts less and claims nothing more. `NoParams` and
  `NoPayload` are any object, because the handler reads nothing from them. Among the schemas and the code that
  parses wire, file and bridge data with them, the only unchecked claims are the brand in `ids.ts`, the two trust
  points above and the server's `webUiContext` `custom` member, which pi's generic signature forces
  ([[submodule-server-agent]]). The desktop bridges and the server runtime module carry functions, whose
  signatures no run-time check sees, so their readers claim none: they call each function and check every value it
  returns or pushes ([[module-web]], [[module-desktop]]). This rule covers schemas and parsers, not every cast
  elsewhere in the code base.
- **An enum read outside its schema is one tuple.** A `oneOf` value list that code outside this directory also
  needs, such as `THEME_MODES` or `WS_ERROR_CODES`, is an exported `as const` tuple, and that code reads the tuple,
  so there is no second copy to keep in step. A list only its schema uses stays inline in `oneOf([...])`; anything
  else reads it through the schema's `Static` type.
- **An exclusive union is a narrowed object.** `TemplateReadLocation` is `narrowed(obj, { not })`: the builder object
  types it, and `not: { required: [...] }`, added to its `allOf`, refuses both ids. `template.get` narrows its
  params the same way.
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
  value comes out of a parser that compiles beside its schema. `randomUuid` is built on `getRandomValues` because
  `crypto.randomUUID` is missing on a plain-HTTP client; the host's generators in `@thinkrail/shared/newIds` parse it
  and throw a `CodedError` if the parse ever fails. pi owns session ids, so they have no generator. Tests make ids with the `test*` makers of `@thinkrail/contracts/test-ids`, and a refusal test
  sends the raw string. `check:boundaries` refuses that entry outside test sources, and a relative import of `ids.ts`
  from another module. `DelegationRunDetails.childSessionId` stays a `string`: the schema is `pi-delegation`'s own
  `DELEGATION_RUN_FIELDS`, which knows no brand.
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
- **`@ts-expect-error` only in a negative type test**, one that proves bad code fails to compile, as `type-tie`'s
  `index.test.ts` does for `Same`.
- **No tests that restate a schema.** Test what a boundary does with a refusal, not what `str()` accepts.
