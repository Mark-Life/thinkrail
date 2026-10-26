---
id: submodule-web-editing
type: submodule-design
status: active
title: editing — file buffers and the save pipeline
parent: module-web
depends-on: [module-contracts, module-locales, module-resource-renderers]
tags: [ui, public-surface-checked]
---

## Responsibility

Own the client side of file editing: one buffer per open file, kept outside any editor; the save
pipeline over `fs.writeFile` and the autosave that drives it; disk reconcile through a live 3-way merge; the user's own undo history;
and drafts that survive a reload. Editors
attach to a buffer through the renderer-neutral `ResourceEditSession` ([[module-resource-renderers]]).
The host owns the bytes on disk, their BOM, line endings and mode ([[submodule-server-fs]]).

## Boundary

- **Public surface:** `useFileBuffer`, `useFileBufferText`, `canEditFile`, `saveFile`,
  `saveFocusedFile`, `discardFile`.
- **Allowed deps:** `store` (tabs and their content writes, the active tab and workspace tick
  selectors, `activeWorkspaceId` / `activeTabByWorkspace` and `fileSaveMode` as flush and mode signals, connection status and generation, removed workspace ids, the buffer summary slice, `toast`),
  `transport`
  (`getTransport`, `supportsFileWrite`, `wsErrorCode`, `reportClientError`, `clientErrorReport`), `lib` (`tupleKey`, `fileName`, `randomId`),
  `contracts` (`toEditorText`,
  `FILE_WRITE_MAX_BYTES`, `LFS_POINTER_MIME`, wire types), `@thinkrail/resource-renderers` (edit-session types only),
  `@thinkrail/locales` (the restore toast), `diff` (`diffArrays`), `@codemirror/state` and
  `@codemirror/commands` (a headless `EditorState` with `historyField`, never a view), React.
- **Forbidden:** UI components (banners and the close dialog belong to `panels`), Monaco,
  `@codemirror/view` or any other editor view, and buffer text in Zustand.

## Model

- **One buffer per (workspace, path).** The key is `tupleKey("file-buffer", workspaceId, path)`, the
  same identity as the file tab, so one tab owns one buffer. A buffer holds `doc`, a headless CodeMirror
  `EditorState` (`history.ts`) with its undo history and the open merge conflicts; its LF editor text is
  derived from `doc` (`bufferText`, one string per doc text, cached by `docText`),
  `base {text, hash}` (the last disk state it adopted; `hash: null` means the file is absent), one
  write in flight, and at most one issue (`conflict`, `readonly`, `error`). The pure transitions live in
  `buffer.ts`; the registry (`registry.ts`) owns side effects.
- **Status is derived, by precedence:** `stale` (a disk version that could not merge) › `readonly` ›
  `error` › `deleted` (`base.hash` null) › `conflict` (open same-line conflicts) › `saving` › `dirty` ›
  `clean`, so a disk that turned binary shows over the conflict lens. `offline` never does: no save is
  sent while a conflict is open. A failed save of a deleted file shows its reason,
  not `deleted` again. Dirty means `text !== base.text` and is reported apart from
  the status, so a deleted or stale buffer can still be clean or dirty. Only the summary
  (`{status, dirty, error, conflicts, merges, pending}`) reaches the store (`fileBuffersByWorkspace`), never the text.
  `pending` means an autosave timer is armed.
  `merges` counts disk changes merged into the buffer with no conflict; while the buffer is dirty the
  banner's polite live region announces each one, since the merged lines land with no other notice. The tab
  indicator comes from one store selector, `selectFileSaveIndicator`: in manual mode a dot for `dirty`
  that pulses while `saving`; in auto mode a pulsing ring while a dirty buffer is `pending` ("Saving
  soon") or `saving` ("Saving"), and the dot only for a dirty buffer autosave will not write (paused). Both paint `CanvasText` in forced
  colors. The tab indicator, the banner and the close guard all read from that summary.
- **Disk text is adopted only through `toEditorText`,** and only when `meta.text` is true and the mime
  is not an LFS pointer. The client sends LF text and never handles a BOM; the host restores the form.
- **Lifetime.** The registry, the buffer core, the merge, jsdiff and CodeMirror form one lazy chunk
  (`import("./registry")` in `files.ts`); `keys.ts` and `drafts.ts` stay eager. `useFileBuffer` reads
  the loaded registry and the buffer through `useSyncExternalStore`. Once the file is editable, a layout
  effect starts the load, then creates the buffer when the registry exists, so the editor mounts
  read-only until then and binds before paint; nothing is created during render. A failed chunk load is
  reported once as a client error, however many callers wait on it, and forgotten, so the next editable file tries again. Removing a workspace
  deletes its drafts even before the chunk loads. The buffer then lives as long as its
  file tab: it survives tab switches and unmounts, so a background tab keeps its dot and its text. When the tab leaves the store the buffer is dropped (its draft stays) once any armed or running save settles, and
  **Don't save** drops it with its draft.

## Disk to buffer

- **Reconcile rules.** Same hash as `base`: nothing happens (this also hides the echo of our own save).
  Clean buffer: adopt the disk text. Dirty buffer with the same text as disk: adopt silently. Otherwise
  the disk version merges into the buffer (`merge3(base, text, disk)`) and becomes the new `base`, so
  the next save is a CAS write against it. Lines only the disk changed land in place; a line both sides
  changed becomes an open conflict and pauses saving. A merge that the diff budget cannot cover, and a
  buffer that already shows a `conflict` issue, fall back to the banner: a `conflict` issue holds the disk
  version for the banner: **Reload** adopts it as an undoable user step, **Keep mine** takes its hash as
  the new base and keeps the text dirty, so the next save overwrites. A deleted buffer whose file comes
  back with the base text adopts it as the base and keeps its edits, with no conflict. A disk text equal
  to a write whose answer never came (`unconfirmed`) is this page's own save: it becomes the base, with
  no conflict. Any editable read clears `notEditable` and `offline`, also on the same hash.
- **Merge rules (`merge3.ts`).** Pure and line-based, on jsdiff `diffArrays` from `base` to each side,
  with the same 2,000-edit / 50 ms budget as `textChanges` (one pair of constants); past it the result is `tooLarge` (the
  banner). jsdiff can write a one-line replace next to an equal line (a blank line, a `}`) as an insert
  plus a delete of the equal line further on; each side's insert and such a delete join into one
  replace before the hunks meet, so both sides editing that line conflict. Hunks conflict only when they share a base line, or when an insert lands strictly inside the
  other side's changed lines. Edits on adjacent lines, and an insert at the edge of the other side's
  edit, merge. The same change on both sides lands once. Two different inserts at the same point merge
  with mine first. When one insert starts or ends with the whole other one, the longer one lands; any
  other pair that shares a line conflicts. A conflict keeps mine in the text and records the disk lines (`theirs`) next to it.
  Inputs are LF editor text; a missing final newline is merged as if present, then follows the side
  that changed it. A conflict at the end of the text holds the disk tail exactly: its final newline
  follows the disk, an empty one after a dropped newline starts its `theirs` with one, and one whose
  disk side deleted a last line without a newline starts at the line break before it, so Theirs drops
  that break too (the lens still starts on the conflict's own line). Each conflict also keeps its
  `base` lines, saved with drafts. The merge also returns the disk side as `TextChange[]` against mine, which enter
  the doc as they are (no second diff), and the merged range of every block the disk side changed.
- **Open conflicts** live in a CodeMirror `StateField` and move with every edit. Typing at the end of
  a conflict on a last line without a newline extends it; any other edit at its edges stays outside. **Mine** keeps the
  text, **Theirs** replaces it with the disk lines, **Both** keeps mine then the disk lines; each is a
  user transaction, so Cmd/Ctrl+Z reopens the conflict (`invertedEffects`); a choice sets no selection,
  the cursor maps through it. A later disk change merges
  against the new base. An open conflict in a block the disk changed again closes: the new merge either
  opens a fresh conflict there or found nothing to pick. One the disk left alone stays open. Reload,
  Keep mine, a deletion and a disk that caught up with the buffer close them all; a clean adoption
  closes those on the lines it changed. Resolved conflicts stay in the field, mapped like open ones, and
  close the same way: undo reopens a resolved conflict only while no later disk change, Reload or Keep
  mine reached its lines, since its Theirs would overwrite the newer disk. The field keeps the last 120
  resolved conflicts, the most the history can reach unless one step closed several; a conflict closed
  by a remote step is not kept, since nothing can reopen it. An edit (or undo) that makes
  a conflict's text equal its `theirs` closes it in the same transaction, so undoing that edit reopens
  it. An undo or redo that brings a conflict's text back to its `base` takes `theirs` there, as a
  3-way merge would, in a remote step composed into the same change set; a redo after that lands the
  user's edit on the disk text with no conflict. An empty conflict (mine deleted the lines) grows over
  an undo or redo only when that inserts exactly its `base` lines at its point. A conflict that starts
  at a line break (the deleted last line) keeps typing at that line's end outside.
- **IME.** While the editor composes, disk reads and a stale save answer wait; the end of the
  composition re-reads once (and retries that save). A merge never lands inside a composition.
- **No read lands across a save.** Every read, by the registry or a file tab, takes a per-buffer
  sequence number when it starts. A read that started before a write answered, or arrived during it,
  is dropped, and one fresh read runs after the write answers. Otherwise the echo of an older save would
  look like an external change.
- **Newest read wins.** Reads can answer out of order. A result (text or `FILE_NOT_FOUND`) whose read
  started before the last one that landed is dropped, so older disk text never replaces newer text and
  never reopens a resolved conflict.
- **Deleted on disk.** A read that fails with `FILE_NOT_FOUND` sets `base.hash` to `null`: status
  `deleted`, text kept. Any other failure (timeout, host error) leaves the buffer as it was. One that
  arrives during a save waits for the fresh read after it. A rename is a delete; the watcher has no
  rename events.
- **Reconnect.** Frames missed while offline are never replayed, so on each new connection generation
  every buffer re-reads once.
- **The tab follows the buffer's own reads.** A read the registry makes itself (reconnect, after a save,
  a superseded token) also updates every file tab on that path through `updateFileTabContent`, stamped
  with the workspace tick taken before the read, so `tab.content` and `tab.meta` never lag the buffer. A
  tab that already holds a newer tick keeps it.
- **One step per commit.** Every commit moves `doc` by one transaction (or a composed pair), so
  `docChanges` always finds the hop; a commit that moves it further throws instead of diffing.
- **Deltas, never a reset.** Every text change that did not come from the attached editor (a merge, a
  disk adoption, undo, a conflict choice) is one CodeMirror transaction; the editor gets that
  transaction's change set as `TextChange[]`. Remote text enters the doc as a line diff (`textChanges`,
  jsdiff `diffArrays` capped at 2,000 edits and 50 ms),
  so cursors and scroll stay; a merge uses its own changes instead. Past a cap, texts with the same line count change line by line in place
  (a formatter or an agent rewrite); others fall back to one prefix/suffix-trimmed change. A disk
  change is diffed once, with or without an editor: the history needs exact changes to keep the
  user's undo steps in place. Each doc state remembers only the change set from the state before it,
  so a buffer never holds a chain of past states. A change never starts or ends inside a UTF-16 surrogate pair: Monaco
  widens such a range to the whole pair, and its model would drift from the buffer.

## Undo

The buffer, not the editor, owns undo: CodeMirror's history (`historyField`) on `doc`. Typing, deletes, paste and
IME compositions enter it with their CodeMirror user events, so typing groups as in CodeMirror (500 ms).
Merges and disk adoptions are `addToHistory: false` and `remote` transactions, so Cmd/Ctrl+Z undoes
only the user's own steps and the history maps them over every merge. Reload and a conflict choice
are user steps. The editor reports its selection outside the history, so undo restores the cursor; the
undo or redo change set reaches every attached view with that selection. A buffer whose history holds
only merges has nothing to undo. An undo or redo step that would change neither the text nor the open
conflicts (a resolve whose conflict a later disk change replaced) is skipped, and one left on top after a
visible step is taken with it, so every Cmd/Ctrl+Z shows a change. A cursor move updates the selection in `doc` without publishing.

- **Undo of Reload.** Undoing a Reload brings back text typed on the disk version before it. The doc
  remembers that version (`typedOn`, text unknown for a draft typed elsewhere) through the history, so
  redo forgets it again. While it is set, a save sends `expect` with its hash, the host answers `stale`,
  and the newer disk merges 3-way from that version: disk lines stay, a same-line clash becomes a
  conflict, and an unknown base reopens the banner. Drafts store its hash. Any new base clears it,
  except the answer to a save sent before an undo or redo changed it: that save keeps it, so the next
  save still merges.

## Save pipeline

`save()` is the single entry point of the pipeline.

1. Nothing to do while a banner conflict or a same-line conflict is open, or when the buffer is clean
   and on disk. A save asked for
   while a write is in flight runs once after it, and every caller waits for that second run. While the
   host is not connected the save fails at once with issue `offline` and sends nothing. A deleted buffer
   always saves; it re-creates the file with `expect.hash: null`, as sent.
2. Content over `FILE_WRITE_MAX_BYTES` (UTF-8) is refused before sending (issue `tooLarge`); the host
   closes the socket on an oversized frame.
3. `fs.writeFile {workspaceId, path, content: text, expect: {hash: base.hash}}` (`typedOn`'s hash after an
   undo of Reload).
4. `written`: `base` becomes the sent text and the new hash; edits typed meanwhile stay dirty.
   `stale`: when the current disk version is no longer editable text the buffer gets issue
   `notEditable` and nothing merges. When it equals the buffer text it is adopted. Otherwise it merges
   into the latest text (typing during the write included) as above, and a merge with no open conflict
   saves once more at once; a second `stale` answer merges again and stops there. A read dropped during
   the write still runs once after it, retry or not. `missing`: status `deleted`; nothing is re-created
   until the user saves again. `readonly`: issue `readonly`, shown with its reason; the next explicit save retries.
   A thrown error: `NOT_EDITABLE` gives issue `notEditable`, `FILE_TOO_LARGE` gives `tooLarge`, any
   other error `failed`; a retry cannot fix the first two. The write may still have landed, so its text
   stays `unconfirmed`; a later `stale` answer that holds exactly that text adopts it as the base and
   sends the newer text once more.

`saveFocusedFile` saves the buffer of the focused editor (`[data-file-buffer]` on the pane), else the
active file tab's buffer (`selectActiveEditorTab`). The registry sends no write when the host's protocol
is known and below `supportsFileWrite` (v91); before the first welcome the version is unknown and the
save goes ahead, but the `offline` check stops it until a connection exists.

## Autosave

`AppConfig.fileSaveMode` (host setting, default `"auto"`) picks the mode. `"manual"` is the save pipeline
alone: nothing writes until Cmd/Ctrl+S or the close guard's Save. In `"auto"` the registry's scheduler
(`autosave.ts`, one debounce timer per buffer) calls the same `save()`; it never writes by itself.

- **Only a user step arms the timer:** an editor edit, undo, redo, a conflict choice, Keep mine, and a
  draft restored with no issue (the user's own unsaved text). A merge, a disk adoption and Reload never
  do, so two dirty windows cannot bounce writes. Each arm restarts the 1,000 ms delay. A step arms only
  when autosave may write the file (`canAutosave`): not for a deleted file, a `readonly` refusal or an
  open conflict of either kind, so `pending` always means a write will follow.
- **When the timer fires** it checks `canAutosave` again, since a merge may have opened a conflict
  meanwhile. Only Cmd/Ctrl+S or the guard re-creates a deleted file or retries a `readonly` one. While
  the editor composes it re-arms instead, so a half-composed IME text is never written.
- **Flush** fires every armed timer at once. Triggers: focus leaving a `[data-file-buffer]` pane, the pane
  unmounting, a change of `activeTabByWorkspace` or `activeWorkspaceId` (hidden panes stay mounted, so a
  tab switch is not an unmount), `visibilitychange` to hidden, and `pagehide`. A flush with nothing armed
  does nothing, and a save of bytes already on disk is a host no-op, so extra flushes cost nothing.
- **Paused** is a dirty buffer autosave will not write: status `stale`, `conflict`, `deleted`,
  `readonly` or `error`, or a dirty buffer with no armed timer and no save running (a second `stale`
  answer). A thrown save error pauses that file until the next user step; nothing retries on its own,
  since every failed request goes to PostHog. Resolving the last conflict is a user step, so it resumes.
  A save that throws while the host is disconnected (a request that timed out during a long outage)
  fails `offline`, not `failed`. On reconnect a buffer whose save failed `offline` re-arms once its read
  clears the issue.
- **Cmd/Ctrl+S** cancels the timer and saves at once, in both modes.
- **Mode switch.** To manual: every timer is cancelled. To auto: every dirty buffer with no issue, no open
  conflict and a file on disk arms.
- **A tab leaving the store** flushes its timer. With a save running or queued (in either mode) it is
  dropped only after every such save settles, and only if no tab reopened it meanwhile. A tab reopened
  and closed again while the first save runs flushes its new edit too; the buffer waits for that save.
- **The own-save echo does nothing:** the `fsChanged` for our write re-reads the same hash (see Disk to
  buffer), and a merge never arms the timer.

## Drafts

IndexedDB database `thinkrail-drafts`, one record per `[host, workspaceId, path]` key holding the text,
the base hash it was typed against, its open conflicts (`{from, to, theirs, base?}`), and its owner page. The host is `getTransport().httpBase()`. A record
is written about 300 ms after a change, and at once on `pagehide` and when the page becomes hidden
(`visibilitychange`); it is deleted once the buffer is clean. When a
buffer is created, a draft with the same base hash restores as a dirty buffer with its open
conflicts, so a reload never turns a paused save into a plain overwrite (a conflict outside the text
is dropped). Any change to the open conflicts rewrites the draft. A draft typed against another hash
restores as a conflict, so Reload / Keep mine decides. Until that choice the conflict keeps
the hash the draft was typed on (`typedOn`), and every draft write stores it, so a second reload shows the
conflict again instead of a plain dirty buffer that would overwrite the newer disk. Removing a workspace
deletes all of its drafts (a key range), since a new workspace never reuses the id. A draft whose text equals the
buffer is deleted, never restored later. Typing before the lookup answers wins over the draft. No
IndexedDB (private mode, tests) means no drafts.

- **Owner page.** Each page load takes a random id and holds the Web Lock
  `thinkrail-draft-owner:<id>` while open. A draft owned by another open page (a second tab) is not
  restored, and a page deletes only records it wrote, so two windows never take over each other's
  edits. A restored draft is rewritten under the new owner at once. Two pages editing one file share the
  record: the last writer wins. Without Web Locks (an insecure origin) every other owner counts as gone.
- **Desktop drafts.** The desktop window origin carries the host's per-launch loopback port, and
  IndexedDB is per origin. So on desktop the store is the shell's editing bridge
  (`__THINKRAIL_NATIVE_EDITING__`), keyed by `(workspaceId, path)` without the host: drafts survive a
  quit, crash or update restart. A bridge failure reads as no draft.
- **Desktop quit guard.** The registry pushes one flag to the same bridge: does any file hold edits that
  will not save on their own (`hasUnsavedEdits`, today any dirty buffer). Quit asks first while it is set.
- **Quit flush.** Before a quit, a window close or an update restart stops the host, the desktop awaits
  the bridge's `onQuitFlush` callback, which writes every pending draft at once, so the last keystrokes
  before Cmd+Q are not lost to the 300 ms delay.

## Get right

- **Only a user edit, a restored draft or a merge into a dirty buffer makes a buffer dirty.** Adopting
  disk text and Reload never do.
- **`save()` is the only write trigger.** Autosave, Cmd/Ctrl+S and the close guard all call it.
- **One write in flight.** A save asked for meanwhile queues once behind it. A replayed save after a host restart is safe: the host answers `written`
  with no write when the bytes already match.
- **The store slice is status only.** Views read text from the buffer (`useFileBufferText`). An unchanged
  summary is a no-op in the store, so typing wakes no store subscriber.
- **Cost.** The lazy `registry` chunk is 86 kB (29 kB gzip): `@codemirror/state`, the history from
  `@codemirror/commands` and jsdiff. It uses `historyField`, not `history()`: `history()` adds an
  `EditorView` input handler that pulls in `@codemirror/view` (the chunk was 238 kB). The entry chunk
  went from 1,655 to 1,648 kB (524 to 521 kB gzip) because jsdiff left it.
