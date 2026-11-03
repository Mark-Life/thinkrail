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
  `WsSchemaChannelMap`, `WsEnvelope`, `WsResponse`, `WsErrorCode`, `WsRequestFrame`, `WsAck`, `WsResume`, `AnyHostWelcome`, `PROTOCOL_VERSION`, the client checks of `checks.ts`, the id brands with `newProjectId`, `newWorkspaceId`, `parseProjectId`, `parseWorkspaceId`, `parseSessionId` and `randomUuid`. From `wire.ts` only `Ack`; from `ids.ts` not the `test*` id makers, which only `@thinkrail/contracts/test-ids` exports: `wireObj`,
  `partialWireObj`, `readonlyArr`, `piOwned`, `NoParams` and `NoPayload` stay inside this directory. Schema values stay
  public because [[submodule-server-host]] compiles them. The client checks read them, so they ship in web JS.
- **Allowed deps:** `@earendil-works/pi-schema`; `import type` from `@earendil-works/pi-ai` for pi-owned types.
- **Forbidden:** importing the rest of `contracts`, so a schema never depends on a hand-written type; compiling
  a schema outside `checks.ts`, except the id parsers: an id reaches code from a URL, a file name or a pi event, with no
  method schema to check it. The host owns its own params check ([[submodule-server-host]]).

## Rules

- **Wire objects are open.** `wireObj` allows unknown fields, so a UI and a host of different builds keep
  working together. `obj()` without `open` is closed, so it is not used for wire shapes.
- **A `Partial` wire type uses `partialWireObj`.** `AppConfigUpdate` takes the fields of `AppConfig`, so a setting is
  declared once. The update stays open here; `updateConfig` owns the closed key set.
- **One file per method namespace.** A namespace file exports its entity schemas, a `*_METHODS` record and, if it owns
  a push channel, a `*_CHANNELS` record; `methods.ts` and `channels.ts` merge the records. An entity several namespaces share gets its own file.
- **Schemas check shape only.** A rule that needs host state or gives the user a specific message, such as the
  URL rules of `project.clone`, stays with its handler. A handler does not check the shape again.
- **A wire change is a schema edit.** It shows in the diff under this directory and forces one decision: is it breaking?
  Raise `PROTOCOL_VERSION` only if it is. A UI and a host at different values get a blocking prompt.
  - A new enum value on a host-to-client field is breaking, unless that field is tolerant.
  - Never change a field's type in place. Add a new field.
  - A new host-to-client field stays optional until the next bump, because a client bundled in a store app can be newer
    than its host.
- **A `pi` union is listed by value.** `ThinkingLevel` and `WireModel.input` copy pi's values, with no type
  import from `pi`. A value pi adds or removes fails `tsc` in `packages/server`, where pi's values meet these types.
- **A pi shape in params has real values.** `ImageContent` lists its fields, annotated `Schema<pi's type>`, so a
  field pi adds or a field the schema drops fails `tsc` here. `StopReason` lists its values the same way.
- **A pi shape with no schema is results only.** `piOwned<T>()` carries pi's type with a bare object check, as in
  `Message` inside `TranscriptMessage`. Params never use it: dispatch would not check them.
- **`pi.event` checks only its tag.** `pi` exports no event schemas, so its schema has `sessionId` and `event.type`, and
  `WsChannelMap` in `wsProtocol.ts` overrides the entry with `SessionEventPayload`. The interface `extends` the derived
  map, so the override must stay assignable to the schema's type.
- **A recursive shape keeps its hand type.** Builders cannot express `FileNode` or `LayoutPresetCenterNode`, so each
  stays a hand type beside a raw JSON Schema annotated `Schema<...>`. `$id` makes its `$ref: "#"` point at the node,
  not at the schema that embeds it.
- **A preset center in params is a shallow object.** `AppConfigUpdate` types `center` as `LayoutPresetCenterNode` over a
  bare `{ type: "object" }`, because a recursive `$ref` walks the input with no depth limit. `validateCenter` owns its shape
  and depth. `AppConfig` results keep the recursive schema.
- **An exclusive union keeps its hand type.** Builders cannot express the `?: never` branches of
  `TemplateReadLocation`, so it stays a type beside a raw JSON Schema annotated `Schema<TemplateReadLocation>`:
  `not: { required: [...] }` refuses both ids, and `template.get` adds its fields with `allOf`.
- **A readonly wire array stays readonly.** `readonlyArr` keeps the `readonly` of the queue types, which hold
  pi's own arrays.
- **Result and channel schemas are proven by tests.** The host's test harnesses check real replies and pushes against
  them ([[submodule-server-host]]) with every object closed, so a mismatch or a field the schema does not name is a schema bug
  or a host bug, not a tolerated drift. Only `pi.event` stays open: pi owns it. `piOwned` parts
  pass by design. A wrong schema reaches users: [[submodule-web-transport]] refuses what fails it.
- **`server.welcome` has a floor.** It is the only frame that names the host's version, and refusing it would leave the app
  with no projects. So `protocolVersion` stays a number whatever else changes in the welcome. The client reads
  `HostWelcomeVersions` first and checks `AnyHostWelcome`, not `ServerWelcome`, only on a host at its own version. A version
  it cannot read counts as a host newer than the client, and so does a host at its own version that fails `AnyHostWelcome`, so
  the user still gets the prompt. `AnyHostWelcome` entries are bare
  objects, so one odd project cannot refuse the whole welcome. `ServerWelcome` must stay assignable to it. The test harness
  still checks `ServerWelcome`.
- **A stored hash guards the wire.** `wireHash.test.ts` holds a hash of `WS_METHOD_SCHEMAS`, `WS_CHANNEL_SCHEMAS`,
  `AnyHostWelcome`, `HostWelcomeVersions` and the frames in `envelope.ts` beside the `PROTOCOL_VERSION` it was taken at. Field order does not count. Any schema edit fails until
  the stored value is updated, bump or not, so the test forces the decision and not a bump. The message gives the new value.
- **Ids are branded.** `ProjectId`, `WorkspaceId` and `SessionId` in `ids.ts` are strings at run time, so the wire and the
  stored files do not change. A wire field uses the one for its entity, so a call site cannot swap them. A new id comes from
  `newProjectId` or `newWorkspaceId`; a session id has no generator, because pi owns it. A string from outside the schemas
  (a pi session, a file name, a route) goes through `parseProjectId`, `parseWorkspaceId` or `parseSessionId`, which take any
  value and answer the brand or `null` by checking the schema. Each parser compiles in `ids.ts`, not with `validatorOf`:
  `checks.ts` reads every method schema, and those import the ids. UUIDs come from `randomUuid`, built on `getRandomValues`
  because `crypto.randomUUID` is missing on a plain-HTTP client. Tests make an id from any string with `testProjectId`,
  `testWorkspaceId` or `testSessionId` from `@thinkrail/contracts/test-ids`. `check:boundaries` refuses that entry outside
  test sources, and refuses a relative import of `ids.ts` from another module. Only `ids.ts` casts to a brand.
  `DelegationRunDetails.childSessionId` stays a `string`: it mirrors the `pi-delegation` type, and a test pins the two.
- **`errorCode` is any string.** A later build may send a code this client has no name for, and `WsErrorCode` carries the
  names by type only. `INVALID_REPLY` is never sent: the client mints it.
- **Client checks are shared.** `checks.ts` exports `JsonObject`, for a reader that checks fields one by one, `validatorOf`, a
  cache of compiled schemas, and what any client needs to read the wire: `parseEnvelope`, `pushFailure`, `resultFailure`,
  `resultProblem`, `protocolMismatch` and `welcomeFailure`. Each compiles on first use, so a host that imports the barrel pays
  for none it does not call; only `JsonObject` compiles at import. They decide and report; what to do with a refusal stays with each client
  ([[submodule-web-transport]]). The web transport, e2e fixtures and artifact probes share them.
- **No tests that restate a schema.** Test what a boundary does with a refusal, not what `str()` accepts.
