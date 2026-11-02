---
id: submodule-server-persistence
type: submodule-design
status: active
title: persistence — JSON app state
parent: module-server
depends-on: [module-contracts]
---

## Responsibility

Durable host state—projects, workspaces, cross-frontend app config, terminal catalogs, session completion receipts, installation identity, and server-only acquisition state—as JSON under the data dir, plus the one way a feature watches a user-filled data folder (`locales`, `themes`, `fonts`). Current workbench frame and workspace placement are frontend-local and have no host persistence.

## Boundary

- **Owns:** `dataDir()` (`THINKRAIL_DATA_DIR` for dev/e2e isolation, else `~/.thinkrail`, always resolved to an absolute path — a relative override would otherwise land managed worktrees in two places: `mkdirSync` resolves it against the host's cwd, `git -C <project>` against the project); project/workspace/config load-save operations and fieldwise validation over `DEFAULT_CONFIG` while preserving unknown top-level extension fields; versioned atomic `session-lifecycle.json` (latest observed settled completion + explicit-cancel run id), `session-receipts.json` (first-install baseline complete + session→handled completion id) and `turns.json` (per-workspace agent-run change sets, owned by `turns`); server-only `installation.json` (`{ id, appInstalled?: true }`) and campaign-only `attribution.json`; the structural load/save of `environment.json` (`loadHostEnvironment` / `saveHostEnvironment`, atomic, mode `0600`, semantics owned by [[submodule-server-environment]]). The non-rotating install UUID never crosses the wire.
- **Data folders:** `listDataFolder` (sorted, dot-files skipped, filtered by the owner), `fileStatSignature`, and
  `watchDataFolder`, the once-a-second folder-signature poll [[submodule-server-locales]] explains: it creates
  the folder once at start (reporting a failure to the owner), nudges once per changed listing, and never
  re-creates the folder. The owners keep their parsing and their own file rules.
- **Public surface (barrel):** `dataDir`, the data-folder helpers above, project/workspace/config and terminal-catalog load-save operations, session receipt load-save operations, `ensureInstallation()` returning only `{ id }`, narrow install/browser claim operations, and strict acquisition read/save. Initial ID creation publishes a complete sibling temp via atomic no-overwrite hard link and rereads a concurrent winner; malformed existing records are preserved. An exclusive install-claim marker elects one packaged host across processes. The complete installation JSON is atomically replaced; caught replacement failures remove the marker and temp for retry, while a crash after claiming may consume the event without emission. Legacy installed records remain claimed.
- **Browser attempt:** `attribution.json` exclusively creates its first `{ browserClaimAttempted: true }` marker with `wx`. Redeem atomically replaces it with strict first/last touch fields (bounded UTM values, referrer class, timestamp, and policy version); failed network or replacement work leaves the attempt terminal. Retention is 30 days after `last_touch`: expired or invalid records become terminal. The persisted schema rejects claim/verifier/challenge/URL, journey/bridge IDs, IP, and user agent. Other state has no cross-process lock.
- **Allowed deps:** `contracts` (`Project`, `Workspace`, `AppConfig`, `HostEnvironment`, `LayoutPreset`, `DEFAULT_CONFIG`,
  `isTerminalWindowsShell`, the wire schemas of the files that hold wire shapes); `pi-schema`; `@thinkrail/shared/codedError`;
  Node `fs`/`os`/`path`/`crypto`.
- **Forbidden:** importing feature siblings or `host`; deriving session state; storing transcript content, cached running/input state, or local activation; combining lifecycle metadata with read receipts; persisting a current frame/view, selection/focus, or frontend-surface identity; reading alternate config keys; importing `log`; or reading, rewriting, or deleting old host layout snapshots.

Project and workspace loads return `Project.path` / `Workspace.worktreePath` in the host's resolved spelling
(architecture Decision 22). A record stored in another spelling — git's `C:/…`, an unresolved segment, a
file an older host wrote — heals on read and is persisted by the next save of that file; a load never rewrites
the file, and a value that is not absolute on this host stays as stored. Saves do not normalize: the producers resolve
at their own doors, so an object a create call returns never differs from what it stored.

Session metadata writes are complete-copy temp-file replacements. Lifecycle persists only facts a transcript
cannot prove—`agent_settled` outcome and explicit Stop—keyed to the active run/completion ids; stale records
never apply to a newer turn. Loads report each file as loaded, missing, or set aside. Unless both files
load, the owner runs one pre-serving baseline of existing completion ids so history does not light up;
unresolved input is never baselined. An unreadable file (I/O, parse, or schema failure) never blocks host
startup: it is renamed to `<file>.corrupt-<epoch-ms>` for diagnosis (best effort) and treated as missing, so
the re-baseline marks existing completions read. Trading possibly-unseen attention for a bootable host is
deliberate: a v0.2.0-nightly.16 host refused to start on a bad `session-receipts.json` until the user deleted
it. Write failures stay conservative: they may resurface or retain attention but never record unseen work as
read.

## Reading a state file

Each file is parsed once, at the load. A file that holds a wire shape reuses the contracts schema; the others have a private
schema in this directory. The rest of the host trusts the type. A file any released version wrote must keep loading whole, so a
new required wire field on `Project`, `Workspace` or a model needs a default at the load.

`stateFile.ts` owns the failure rules for `projects`, `workspaces`, `terminals`, `config`, `environment`, and, through the barrel (`readStateFile`, `parseEntryRecord`, `assertOverwriteAllowed`, and `isConfigOverwriteRefused` for `settings`), the `todos` sidecars and `feedback.json`:

- **One bad entry costs one entry.** `parseEntries` and, for a keyed map, `parseEntryRecord` keep what passes and drops the rest. A record that passes also passes
  the web's reply check, so a bad entry never refuses the whole `project.list`.
- **Nothing is lost silently.** Before a drop or a whole-file failure can reach a save, the raw bytes go to
  `<file>.corrupt-<content hash>`, mode `0600` because `environment.json` holds secrets. The hash makes this once per content
  across loads and restarts; the problem is reported only when the copy is made, with entry indexes and schema paths, never values.
  Each file keeps its newest 10 copies. An entry that holds `1e999` drops like any other: JSON has no such number, and it would reach the wire as `null`.
- **What cannot be read or copied cannot be replaced.** An I/O failure other than `ENOENT`, or a failed copy, loads empty and
  a later save of that file throws `STATE_FILE_UNREADABLE`, until a read succeeds. The file stays in place. `settings` reads again before each save, so a config that recovered saves on top of the stored values. This keeps a transient
  `EMFILE` from replacing projects with an empty list.
- **Reporting goes through an observer.** `observeStateFileProblems` carries a `CodedError`, because `log` depends on this module.
  `host` wires it to `logger("persistence")` at boot, so the report reaches PostHog as a code only.

Session metadata and `attribution.json` keep their own rules above: rename aside, and the terminal marker. A model with its
`{provider, id}` but a partial catalog snapshot gets defaults for the rest, so a kept entry passes the reply check.

Analytics config preserves a saved boolean preference and a valid `analyticsConsentConfirmed` boolean
independently; absent/malformed values default false. A preference-only write never implies completion.
Settings owns initial preference priming and preference-plus-confirmation writes.

Config validation normalizes the closed theme mode plus complete opaque system pair, the closed
composer-growth preference, the closed Windows terminal-shell preference (invalid/absent →
`DEFAULT_CONFIG.terminalWindowsShell`), chat/file line widths plus their pane-bound switches, and the
JetBrains quota boolean + whole `1–3600` second cadence over their defaults; it accepts only the current bounded
`customLayoutPresets` catalog as synchronized layout data. Current/default preset ids, group limits, and
chat message order are not config fields; retired config shapes are stripped rather than upgraded or
preserved as extensions, except a stored preset's `changes` tool, which [[submodule-server-settings]] merges into `files`. Historical `layouts/` files remain untouched and inert.
