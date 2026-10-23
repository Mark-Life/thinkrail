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
pipeline over `fs.writeFile`; disk reconcile; and drafts that survive a reload. Editors
attach to a buffer through the renderer-neutral `ResourceEditSession` ([[module-resource-renderers]]).
The host owns the bytes on disk, their BOM, line endings and mode ([[submodule-server-fs]]).

## Boundary

- **Public surface:** `useFileBuffer`, `useFileBufferText`, `canEditFile`, `saveFile`,
  `saveFocusedFile`, `discardFile`.
- **Allowed deps:** `store` (tabs and their content writes, the active tab and workspace tick
  selectors, connection status and generation, removed workspace ids, the buffer summary slice, `toast`),
  `transport`
  (`getTransport`, `supportsFileWrite`, `wsErrorCode`), `lib` (`tupleKey`, `fileName`, `randomId`),
  `contracts` (`toEditorText`,
  `FILE_WRITE_MAX_BYTES`, `LFS_POINTER_MIME`, wire types), `@thinkrail/resource-renderers` (edit-session types only),
  `@thinkrail/locales` (the restore toast), `diff` (`diffArrays`), React.
- **Forbidden:** UI components (banners and the close dialog belong to `panels`), Monaco or any
  editor import, and buffer text in Zustand.

## Model

- **One buffer per (workspace, path).** The key is `tupleKey("file-buffer", workspaceId, path)`, the
  same identity as the file tab, so one tab owns one buffer. A buffer holds `text` (LF editor text),
  `base {text, hash}` (the last disk state it adopted; `hash: null` means the file is absent), one
  write in flight, and at most one issue (`conflict`, `readonly`, `error`). The pure transitions live in
  `buffer.ts`; the registry (`registry.ts`) owns side effects.
- **Status is derived, by precedence:** `stale` (conflict) › `readonly` › `error` › `deleted`
  (`base.hash` null) › `saving` › `dirty` › `clean`. A failed save of a deleted file shows its reason,
  not `deleted` again. Dirty means `text !== base.text` and is reported apart from
  the status, so a deleted or stale buffer can still be clean or dirty. Only the summary
  (`{status, dirty, error}`) reaches the store (`fileBuffersByWorkspace`), never the text. The tab dot
  shows `dirty`, pulses while `saving`, and paints `CanvasText` in forced colors. The tab dot, the banner and the
  close guard all read dirtiness from that summary.
- **Disk text is adopted only through `toEditorText`,** and only when `meta.text` is true and the mime
  is not an LFS pointer. The client sends LF text and never handles a BOM; the host restores the form.
- **Lifetime.** `useFileBuffer` reads the registry through `useSyncExternalStore` and creates the buffer
  in a layout effect once the file is editable, so the editor mounts read-only for one synchronous
  commit and binds before paint; nothing is created during render. The buffer then lives as long as its
  file tab: it survives tab switches and unmounts, so a background tab keeps its dot and its text. When the tab leaves the store the buffer is dropped (its draft stays), and
  **Don't save** drops it with its draft.

## Disk to buffer

- **Reconcile rules.** Same hash as `base`: nothing happens (this also hides the echo of our own save).
  Clean buffer: adopt the disk text. Dirty buffer with the same text as disk: adopt silently. Otherwise a
  `conflict` issue holds the disk version for the banner: **Reload** adopts it, **Keep mine** takes its
  hash as the new base and keeps the text dirty, so the next save overwrites. A deleted buffer whose file
  comes back with the base text adopts it as the base and keeps its edits, with no conflict. A disk text
  equal to a write whose answer never came (`unconfirmed`) is this page's own save: it becomes the base,
  with no conflict. Any editable read clears `notEditable` and `offline`, also on the same hash.
- **No read lands across a save.** A read carries a token from before it started. A read that started
  before, or arrived during, a write is dropped, and one fresh read runs after the write answers.
  Otherwise the echo of an older save would look like an external change.
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
- **Deltas, never a reset.** A text change that did not come from the attached editor is sent to it as
  `TextChange[]` from a line diff (`textChanges`, jsdiff `diffArrays` capped at 2,000 edits and 50 ms),
  so cursors and scroll stay. Past a cap, texts with the same line count change line by line in place
  (a formatter or an agent rewrite); others fall back to one prefix/suffix-trimmed change. No editor
  attached, no diff. A change never starts or ends inside a UTF-16 surrogate pair: Monaco widens such a
  range to the whole pair, and its model would drift from the buffer.

## Save pipeline

`save()` is the single entry point of the pipeline.

1. Nothing to do while a conflict is open, or when the buffer is clean and on disk. A save asked for
   while a write is in flight runs once after it, and every caller waits for that second run. While the
   host is not connected the save fails at once with issue `offline` and sends nothing. A deleted buffer
   always saves; it re-creates the file with `expect.hash: null`, as sent.
2. Content over `FILE_WRITE_MAX_BYTES` (UTF-8) is refused before sending (issue `tooLarge`); the host
   closes the socket on an oversized frame.
3. `fs.writeFile {workspaceId, path, content: text, expect: {hash: base.hash}}`.
4. `written`: `base` becomes the sent text and the new hash; edits typed meanwhile stay dirty.
   `stale`: the current disk version becomes a conflict, unless it equals the buffer text (adopt) or is
   no longer editable text (issue `notEditable`). `missing`: status `deleted`; nothing is re-created
   until the user saves again. `readonly`: issue `readonly`, shown with its reason; the next save retries.
   A thrown error: `NOT_EDITABLE` gives issue `notEditable`, `FILE_TOO_LARGE` gives `tooLarge`, any
   other error `failed`; a retry cannot fix the first two. The write may still have landed, so its text
   stays `unconfirmed`; a later `stale` answer that holds exactly that text adopts it as the base and
   sends the newer text once more.

`saveFocusedFile` saves the buffer of the focused editor (`[data-file-buffer]` on the pane), else the
active file tab's buffer (`selectActiveEditorTab`). The registry sends no write when the host's protocol
is known and below `supportsFileWrite` (v91); before the first welcome the version is unknown and the
save goes ahead, but the `offline` check stops it until a connection exists.

## Drafts

IndexedDB database `thinkrail-drafts`, one record per `[host, workspaceId, path]` key holding the text,
the base hash it was typed against, and its owner page. The host is `getTransport().httpBase()`. A record
is written about 300 ms after a change, and at once on `pagehide` and when the page becomes hidden
(`visibilitychange`); it is deleted once the buffer is clean. When a
buffer is created, a draft with the same base hash restores as a dirty buffer; a draft typed against
another hash restores as a conflict, so Reload / Keep mine decides. Until that choice the conflict keeps
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
- **Desktop quit loses drafts.** The desktop window origin carries the host's per-launch loopback port,
  and IndexedDB is per origin, so drafts survive a reload but not a quit, crash or update restart. Quit
  does not ask about dirty buffers.

## Get right

- **Only a user edit or a restored draft makes a buffer dirty.** Disk adoption and Reload never do.
- **One write in flight.** A save asked for meanwhile queues once behind it. A replayed save after a host restart is safe: the host answers `written`
  with no write when the bytes already match.
- **The store slice is status only.** Views read text from the buffer (`useFileBufferText`). An unchanged
  summary is a no-op in the store, so typing wakes no store subscriber.
- **Cost.** `FilePane` is eager, so this module and jsdiff's `diffArrays` ship in the entry chunk:
  1,602 to 1,619 kB (503 to 509 kB gzip).
