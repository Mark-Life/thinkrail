---
id: submodule-web-editing
type: submodule-design
status: active
title: editing — file buffers and the save pipeline
parent: module-web
depends-on: [module-contracts, module-resource-renderers]
tags: [ui, public-surface-checked]
---

## Responsibility

Own the client side of file editing: one buffer per open file, kept outside any editor; the save
pipeline over `fs.writeFile`; disk reconcile; and drafts that survive a reload or a quit. Editors
attach to a buffer through the renderer-neutral `ResourceEditSession` ([[module-resource-renderers]]).
The host owns the bytes on disk, their BOM, line endings and mode ([[submodule-server-fs]]).

## Boundary

- **Public surface:** `useFileBuffer`, `useFileBufferText`, `canEditFile`, `isFileDirty`, `saveFile`,
  `saveFocusedFile`, `discardFile`, `FileBufferHandle`.
- **Allowed deps:** `store` (tabs, connection generation, the buffer summary slice), `transport`
  (`getTransport`, `supportsFileWrite`), `lib` (`tupleKey`, `fileName`), `contracts` (`toEditorText`,
  `FILE_WRITE_MAX_BYTES`, wire types), `@thinkrail/resource-renderers` (edit-session types only),
  `@thinkrail/locales` (the restore toast), `diff` (`diffArrays`), React.
- **Forbidden:** UI components (banners and the close dialog belong to `panels`), Monaco or any
  editor import, and buffer text in Zustand.

## Model

- **One buffer per (workspace, path).** The key is `tupleKey("file-buffer", workspaceId, path)`, the
  same identity as the file tab, so one tab owns one buffer. A buffer holds `text` (LF editor text),
  `base {text, hash}` (the last disk state it adopted; `hash: null` means the file is absent), one
  write in flight, and at most one issue (`conflict`, `readonly`, `error`). The pure transitions live in
  `buffer.ts`; the registry (`registry.ts`) owns side effects.
- **Status is derived, by precedence:** `stale` (conflict) › `deleted` (`base.hash` null) › `readonly`
  › `error` › `saving` › `dirty` › `clean`. Dirty means `text !== base.text` and is reported apart from
  the status, so a deleted or stale buffer can still be clean or dirty. Only the summary
  (`{status, dirty, error}`) reaches the store (`fileBuffersByWorkspace`), never the text.
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
  hash as the new base and keeps the text dirty, so the next save overwrites. Live merge is not here yet.
- **No read lands across a save.** A read carries a token from before it started. A read that started
  before, or arrived during, a write is dropped, and one fresh read runs after the write answers.
  Otherwise the echo of an older save would look like an external change.
- **Deleted on disk.** A failed read probes the parent folder with `fs.readDir`. When the name is gone
  (or the folder is), `base.hash` becomes `null`: status `deleted`, text kept. A rename is a delete; the
  watcher has no rename events.
- **Reconnect.** Frames missed while offline are never replayed, so on each new connection generation
  every buffer re-reads once.
- **Deltas, never a reset.** A text change that did not come from the attached editor is sent to it as
  `TextChange[]` from a line diff (`textChanges`, jsdiff `diffArrays` with an edit-length cap and a
  prefix/suffix fallback), so cursors, scroll and review decorations stay.

## Save pipeline

One pipeline, one trigger today: `save()`. Autosave adds a timer that calls the same `save()`.

1. Nothing to do while a write is in flight, while a conflict is open, or when the buffer is clean and
   on disk. A deleted buffer always saves; it re-creates the file with `expect.hash: null`, as sent.
2. Content over `FILE_WRITE_MAX_BYTES` (UTF-8) is refused before sending (issue `tooLarge`); the host
   closes the socket on an oversized frame.
3. `fs.writeFile {workspaceId, path, content: text, expect: {hash: base.hash}}`.
4. `written`: `base` becomes the sent text and the new hash; edits typed meanwhile stay dirty.
   `stale`: the current disk version becomes a conflict, unless it equals the buffer text (adopt) or is
   no longer editable text (issue `notEditable`). `missing`: status `deleted`; nothing is re-created
   until the user saves again. `readonly`: issue `readonly`, shown with its reason; the next save retries.
   A thrown error: issue `failed`.

`saveFocusedFile` saves the buffer of the focused editor (`[data-file-buffer]` on the pane), else the
active file tab's buffer. Gated on `supportsFileWrite` (v91).

## Drafts

IndexedDB database `thinkrail-drafts`, one record per (host, workspace, path) holding the text and the
base hash it was typed against. The host is `getTransport().httpBase()`. A record is written about
300 ms after a change and on `pagehide`, and deleted once the buffer is clean. When a buffer is created,
a draft with the same base hash restores as a dirty buffer; a draft typed against another hash restores
as a conflict, so Reload / Keep mine decides. Typing before the lookup answers wins over the draft. No
IndexedDB (private mode, tests) means no drafts. The webview's storage survives a desktop quit, so quit
never asks the page.

## Get right

- **Only a user edit makes a buffer dirty.** Disk adoption, reload and draft restore are not user edits.
- **One write in flight.** A replayed save after a host restart is safe: the host answers `written`
  with no write when the bytes already match.
- **The store slice is status only.** Views read text from the buffer (`useFileBufferText`).
- **Cost.** `FilePane` is eager, so this module and jsdiff's `diffArrays` ship in the entry chunk:
  1,602 to 1,619 kB (503 to 509 kB gzip).
