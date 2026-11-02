---
id: submodule-server-settings
type: submodule-design
status: active
title: settings — server-synced app config
parent: module-server
depends-on: [module-contracts]
---

## Responsibility

The server-synchronized app config: opaque fixed-theme selection, fixed/system mode and optional light/dark
pair, additional-analytics preference and first-run dialog completion marker, host-owned new-chat model and
effort defaults, terminal replay budget and Windows shell preference, chat composer growth preset, chat/file
visual line widths plus independent pane bounds, bounded custom layout-preset catalog, JetBrains quota
display/cadence, the host-wide subagent default, plan-review policy, the host-registry extensions the
user turned off, and the UI language preference (`locale`). `defaultModel` / `defaultEffort`
select the defaults every new chat receives (unset model means pi's `settings.json` default when available, else the preferred available model — pi's provider default, else the first; unset effort means medium);
`reviewModel` / `reviewEffort`
select the reviewer runtime (unset means that same new-chat default); `reviewAutoFix: false` records a `request_changes`
verdict and waits instead of auto-sending a fix. **`favoriteModels`** is the picker's starred list in display
order — a whole-list client write, checked as `WireModel` by dispatch, refused with no `provider` or `id`, and deduped by `sameModel`;
**`recentModels`** is host-owned: `noteRecentModel(model)` (called by `host` on an explicit `session.create`
model and every `session.setModel`) puts the model first, dedupes, caps at `RECENT_MODELS_LIMIT`, persists and
publishes, while a client-supplied `recentModels` in `settings.update` is dropped before validation so no
client can rewrite the host's record of what was chosen.
The module reads, normalizes, persists, caches, and broadcasts values that intentionally follow the owner
across frontends.

Current workbench frame, workspace resource placement, current/default preset selection, side/bottom group limits, selection, and focus are explicitly absent. Those are frontend-surface-local view state under [[submodule-web-shell-layout-state]]. Built-in layout presets remain web-owned.

A numeric setting's range is part of its `AppConfig` schema ([[submodule-contracts-schema]]): the line widths,
`terminalReplayKb`, `subagentMaxConcurrent`, `jbcentralQuotaRefreshSeconds`, `settleIdleDays` and the font
sizes. `settings.update` params fail the schema at dispatch, so `updateConfig` never checks a range, and the
load drops a stored value outside it. Settings keeps the rules a schema cannot hold: the locale tag, the
system theme pair, analytics consent, non-blank names and models, and the custom layout preset catalog. A
stored preset's retired `changes` tool becomes `files` at the load; `updateConfig` still refuses it.

## Boundary

- `settleIdleDays` — the Settled-shelf idle window: a whole number of days from 1 to 365, or `null` for
  never; default `7`. A hand-edited value outside that falls back to the default rather than disabling settling.
- **Owns:** cached current `AppConfig`; `getConfig()`; `updateConfig(partial)` (reject an unknown key → merge → apply the rules above → persist → publish the merged `AppConfig` and successful applied `AppConfigUpdate`); which family a font choice names, and whether it renders, is the client's; the custom layout preset catalog rules (`validateLayoutPreset` narrows through the `LayoutPreset` schema after its own depth guard, then checks ids, weights, widths and closed keys); custom-preset safety caps; `setSettingsPublisher`; and `resetConfigCache` for tests.
- **Stored presets:** `loadConfig` parses each stored preset with the `LayoutPreset` schema. `getConfig` then applies the catalog rules through `keepValidStoredPresets` and drops a preset that breaks one, after `setConfigAside` keeps a copy of `config.json`. The drop is never saved on read; the next save writes the kept catalog.
- **Public surface (barrel):** `getConfig`, `configReadFailed`, `updateConfig`, `noteRecentModel`, `setSettingsPublisher`, `SettingsPublisher`, `resetConfigCache`, plus the pure preset rules `validateLayoutPreset`, `validateCustomLayoutPresets` and `keepValidStoredPresets`.
- **Allowed deps:** `pi-schema`; `log`; `persistence` (`loadConfig`/`saveConfig`/`setConfigAside`/`isConfigOverwriteRefused`/`didLastConfigReadFail`); `contracts` (`AppConfig`, `LayoutPreset`,
  `isLocalePreference`).
- **Forbidden:** host or another feature sibling; current-layout document/snapshot types; workspace ids/resources; current frame validation; owning WS channels; or importing web preset definitions.

## Get right

- **A save never writes defaults over a file it could not read.** When the first load failed, or any later read did, `updateConfig` and `noteRecentModel` read again first: the save merges onto the real values, or throws `STATE_FILE_UNREADABLE` if the read still fails. `noteRecentModel` is best effort, because the session has its new model by then: any failure in it, read, save or publish, logs and does not fail `session.create` or `session.setModel`.
- **A failed read is told, not hidden.** `configReadFailed()` is true while the live config holds defaults because `config.json` could not be read or held no JSON object. A bad field in a good object, a missing file, and a failed read after a good load (the live values are still real) do not count. It reads again first, so a file fixed by hand takes effect at the next welcome: the stored values go out through the publisher, and that `settings.changed` is what clears a connected client's notice. No separate push exists because every publish follows a good read or a save.
- **Converge on broadcast, no client optimism.** `updateConfig` persists before replacing the live cache or publishing; a failed write changes neither runtime reads nor frontends. The publisher receives the full merged config for broadcast and the applied partial update so host consumers can distinguish an explicit field write from an unrelated merge. Every frontend, including the initiator, adopts `settings.changed`. `server.welcome` seeds the same cached value.
- `terminalWindowsShell` defaults to `"auto"`; a persisted value outside the closed shell union falls back
  at the load, while a wire mutation outside it fails the params schema before cache, persistence, or
  broadcast changes. Settings owns validation and synchronization;
  `terminal` owns executable resolution and spawning.
- `chatLineWidth` / `fileLineWidth` independently default to 120 and accept only integers from 40 through 240; their `Bounded` switches independently default to `true`. A malformed stored field falls back without discarding valid siblings; any invalid supplied field fails the params schema before cache, persistence, or broadcast changes.
- `subagentsEnabled` defaults to `true` when absent so old config preserves current behavior. Settings owns only that global default; workspace override and effective-value resolution stay outside this module.
- `onboardingDismissed` defaults to `false` when absent or malformed on disk. Only the web onboarding wizard reads it.
- `subagentMaxConcurrent` (per-chat concurrent subagents) defaults to 4 when absent or malformed on disk; a wire update outside whole 1–16 fails the params schema — never clamped. Like `subagentsEnabled`, settings owns only the global value.
- `disabledExtensions` lists host-registry extension `name`s the user switched off; absent means `[]` (every
  extension on). A blank name in a wire update rejects the whole mutation;
  duplicates are deduped, and **unknown names are kept** — the registry, not settings, decides what a name
  means, so a stale entry for a removed extension never breaks boot or a later update. A malformed stored
  list keeps its valid names. Settings owns only the list; `host` turns it into the agent's resolver and the
  live tool refresh ([[module-server]] § host-mediated policy).
- `extensionSettings` maps extension `name` → setting key → boolean; absent means `{}` (every declared
  default applies). A wire update must be an object of non-blank names to objects of non-blank keys with
  boolean values, or the whole mutation is rejected; it is **merged per key** into the stored map, so a
  Settings switch never resets an extension's other settings. Like `disabledExtensions`, undeclared names
  and keys are kept and inert — the registry's descriptors decide what a key means.
- `disabledPackages` is the same shape for installed pi packages, keyed by the package identity the
  catalog reports (`PiPackageSummary.identity`); it exists because pi has no "whole package off" setting
  and writing pi's per-resource filters would reset a user's own filters on re-enable. Validation,
  dedupe and unknown-key tolerance are identical to `disabledExtensions`.
- `locale` is `"system"` (default) or a canonical BCP-47 tag (`isLocalePreference`: `pt-BR`, not
  `pt-br`). Settings never checks that a language is available — bundled catalogs belong to the web build
  and local files to [[submodule-server-locales]] — so a tag whose file was deleted persists and returns
  with the file. A malformed stored value falls back to `"system"`; a malformed update rejects the whole
  mutation.
- JetBrains quota display defaults on and its interval defaults to 30 seconds when either stored field is absent/invalid. Wire updates reject a non-integer/out-of-range interval atomically; they never clamp a caller's value into a different persisted choice.
- Theme availability/labels/palettes, operating-system appearance, and the effective theme are not server concerns. `theme` remains the opaque fixed choice; `themeMode` defaults to `"fixed"`, and `systemThemePair` remains absent until first use. A persisted pair is retained only when both slots are strings; malformed pairs are dropped, and system mode without a retained pair normalizes to fixed without replacing a valid fixed id. A missing/invalid mode also normalizes to fixed while an independently valid dormant pair may survive. Entering system mode requires a complete valid-shaped existing-or-incoming pair; a pair mutation replaces both slots atomically. Unknown ids remain persisted for each independently shipped frontend to resolve by required appearance.
- A `settings.update` carrying `theme` without explicit `themeMode` is a legacy-compatible fixed-theme action and sets mode to `"fixed"`. Thus an old client connected to a system-configured host can never appear to change only itself: its deliberate theme choice exits system mode through the ordinary persist-before-broadcast path.
- Retired host-layout and chat-message-order fields, and the host-owned `recentModels`, are dropped from an update without error rather than persisted or broadcast, so older clients that still send them keep working. Layout instantiation and transcript order are frontend-local preferences.
- **Update keys are a closed set; stored keys are not.** `updateConfig` rejects any key outside `AppConfigUpdate` plus the retired keys, before cache, persistence, or broadcast changes. The accepted set is compile-checked against `AppConfigUpdate`, so a contract change that adds or removes a key fails the build until the set matches. Unknown keys already on disk still load and survive later valid updates, so an older host keeps a newer host's settings. A newer client must gate any new key on the host protocol version, as `THEME_SYSTEM_PROTOCOL_VERSION` gates appearance settings; an older host rejects the whole update rather than persisting an unknown key.
- **Dispatch checks the shape; `updateConfig` checks the values.** `settings.update` params match `AppConfigUpdate` before this module runs ([[submodule-contracts-schema]]), so a wrong type, a value outside a union (including an effort level) or a number outside its range gets `INVALID_PARAMS`. `updateConfig` keeps the rules a schema does not hold: the closed key set, non-blank names, a model's `provider` and `id`, consent pairing and the preset rules. A failure in either rejects the whole update before cache, persistence, or broadcast changes.
- Custom layout presets are a complete top-level catalog replacement, not a nested per-item patch. Each value is bounded, resource-free, uniquely identified, uses only the current preset schema, and contains no workspace/tab/session/terminal identity. A malformed persisted member is isolated during config validation; a wire mutation with any malformed member is rejected as a whole. No alternate config key or old preset schema is read or upgraded.
- Deleting or editing a custom preset changes only the shared definition. It cannot mutate any frontend's instantiated frame or local default selection.
- Analytics preference and first-run dialog completion are validated booleans. The dialog may persist the
  default-on preference alone; a preference-only write never infers completion. Confirmation without a
  preference is rejected, and changing a confirmed decision writes both fields. The delivery gate belongs to
  [[submodule-server-analytics]]; the dialog lifecycle belongs to [[submodule-web-panels]].
- `null` clears optional `defaultModel`/`defaultEffort` and `reviewModel`/`reviewEffort` overrides; it is a wire-only sentinel and never persists.
- Stored `favoriteModels` / `recentModels` that are not arrays fall back to `[]` on load without discarding valid siblings; a wire `favoriteModels` with any non-model member rejects the whole update.
