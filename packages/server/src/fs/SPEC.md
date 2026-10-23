---
id: submodule-server-fs
type: submodule-design
status: active
title: fs — worktree file reads and editor writes
parent: module-server
depends-on: [module-contracts]
tags: [public-surface-checked]
---

## Responsibility

Read directories and files inside a workspace's worktree, path-contained, and decide **what a resource's
bytes are** — the one byte-level classification every content read in the host shares — and write editor
text back to a text file under compare-and-swap.

## Boundary

- **Owns:** `readDir`/`readFile(workspaceId, path)` — every path resolved + contained to the worktree
  root; `.git` hidden; directories sorted first. `readDir` reports worktree-relative paths with `/`
  separators on every OS — the same form git status and watch events use — so a browser can match a
  listed node to a changed path (Windows' `relative()` would otherwise yield `src\auth`). (`.thinkrail/` is **not** hidden — it is shown like any
  other dir, so future host-managed content there stays visible; its ephemeral `context/` is kept out of
  git, not out of the tree.) `readFile` answers **`{ content, meta }`**: a file is read as bytes and
  decoded only when it is text, so `content` is `""` for a byte-only resource and the client fetches
  those bytes over the host's `/files` route instead of receiving mojibake.
  **`resolveWorktreeFile(workspaceId, path)`** returns the
  contained absolute path for the host to stream a file's raw bytes over HTTP (the `/files/…` route
  serving relative images in the markdown viewer, the `/blob` route's containment check) and for the
  `changes` module's atomic writes, and as the path the host's `fs.writeFile` hands pi's per-file
  queue (pi keys it by realpath, lexical only while the file is absent). Lexical escapes, `.git`, and an existing symlink chain whose resolved
  target leaves the worktree are refused; missing leaf paths are allowed so a deleted file can be
  restored. `changes` passes `{ followLeaf: false }` so containment validates through the parent and its
  own `lstat` can reject even an escaping leaf symlink without following it. This module owns the path
  safety; its callers own the streaming and the writing. **`workspaceRelativePath(root, path)`** is the one
  conversion from a native or absolute path to the wire's worktree-relative POSIX form (architecture
  Decision 22): resolved against the root, `null` when outside (a name such as `..env` is inside), `""` for
  the root itself. `reviews` normalizes anchors through it. It keeps host
  semantics, so a backslash on POSIX stays part of a file name; callers that hold model-written paths turn
  `\` into `/` themselves.
  **Content classification** (`content.ts`, pure, no dependency): `CONTENT_SNIFF_BYTES` names the shared
  8 KiB bounded-head size; `classifyBytes(bytes)` → `{ text, mime? }` — **mime** is what the *bytes*
  prove (magic numbers for png/jpeg/gif/webp/avif/bmp/ico/pdf/zip/gzip/woff/woff2, plus `image/svg+xml` for
  text whose root element is `<svg>`, directly or behind an XML prolog — a prolog alone is not an
  image, and `application/vnd.git-lfs` for a text file of at most 1 KiB that is exactly the three-line pointer
  `git lfs` itself writes — `version`, `oid sha256:`, `size`, in that order, nothing else, so no prose
  that merely quotes a pointer can be mistaken for one — so a `.png` whose content is a pointer is
  reported as the pointer it is, not as an image that failed to decode); **text** is "no recognized binary magic number, no NUL byte in the first 8 KiB, and a strict
  UTF-8 decode" (a BOM is text; an SVG is text because `image/svg+xml` is inferred from text, never
  from a magic number). A magic number wins over decodability: an uncompressed PDF is valid ASCII, yet
  it is a document the PDF renderer owns, not source the code renderer may claim; `hashBytes(bytes)` → the sha-256 hex that **is** a
  resource's identity on the wire (`ResourceMeta.hash`, `ReviewAnchor.contentHash`, the `change.*`
  compare-and-swap); `decodeText(bytes)` → the one UTF-8 decode (BOM retained, because the BOM is part
  of the bytes the hash covers); `mimeFromPath(path)` owns the filename fallback no byte inspection can
  give (markdown/json/csv/yaml/html/xhtml/plain); `resourceMeta(bytes, path)` → the wire's **`ResourceMeta`**, adding that
  fallback and treating
  `null` bytes as absence (`hash`/`byteLength` null, `text: true` — nothing to decode, and the empty
  string it pairs with is valid text).
  **`writeTextFile({ workspaceId, path, content, expect })`** is the editor save behind `fs.writeFile`.
  It is one synchronous pass, and the caller runs it inside the per-file mutation queue it shares with
  pi. Containment is `readFile`'s: a symlink inside the worktree is written through to its real target,
  and an escaping one is refused. The pass checks, in order: size (`FILE_TOO_LARGE`); presence
  (`missing`, or an exclusive create when `expect.hash` is `null`; a dangling symlink is never created
  through, `NOT_EDITABLE`); regular file (`NOT_EDITABLE`); no-op (the bytes it would write are already
  the file → `written`, disk untouched); hash (`stale` with the current `{content, meta}`); textness
  (byte-only or LFS pointer → `NOT_EDITABLE`); writability (`readonly`). It answers the wire result plus
  `changed`, so the host stamps workspace activity only when bytes changed.
  **`replaceFile(target, bytes, mode, current)`** and **`createFile(target, bytes, mode?)`** are the byte
  writes both `writeTextFile` and `changes` use, so a save and a revert treat the same file the same way.
  `replaceFile` writes an existing file (rules under "Atomic unless…" below). `current` is the caller's
  `{ stat, bytes }` (**`CurrentFile`**) of the target from the same pass, so the file is not stat'ed or
  read twice and a failed in-place write restores the bytes the caller checked. `createFile` is an
  exclusive create: it never replaces a file that appeared since the caller's check. A given `mode` is
  set exactly (a revert restores Git's mode); without one the umask applies, as for any new file. The
  caller makes the parent folder, so a save can map that failure on its own.
- **Public surface (barrel):** `readDir`, `readFile`, `resolveWorktreeFile`, `workspaceRelativePath`, `classifyBytes`,
  `CONTENT_SNIFF_BYTES`, `mimeFromPath`, `hashBytes`, `decodeText`, `resourceMeta`, `writeTextFile`,
  `replaceFile`, `createFile`, `CurrentFile`.
- **Allowed deps:** `persistence` (workspace lookup); `contracts` (`FileNode`, `FileContent`,
  `ResourceMeta`, `FileWriteResult`, `WsParams`, and at runtime `FILE_WRITE_MAX_BYTES`);
  `@thinkrail/shared/codedError`; Node `fs`/`path`/`crypto`.
- **Forbidden:** `host`; sibling features.

## Get right

- **One classification, one hash.** Textness, media type and the sha-256 of a resource are decided here
  and nowhere else: `reviews` captures anchors with them, `git` stamps both diff sides with them, and
  `changes` guards its writes with them. Two implementations would let a comment's `contentHash` and a
  revert's `expect` hash disagree about the same bytes.
- **Extension never beats the bytes.** A `.md` file whose content is a PNG reports `image/png`; the
  filename is consulted only when the bytes say nothing, so a mislabelled resource cannot talk a
  renderer into parsing it as text.
- **The file keeps its form.** `content` is editor text (`toEditorText`), so the host does not run
  `toEditorText` again: a second pass would strip a leading U+FEFF the editor holds as text, and an
  unchanged save of a two-BOM file would rewrite it. The host only folds `\r\n`/`\r` to `\n`. The
  written bytes re-apply the disk file's BOM, and its line ending by pi `edit`'s rule: the first line break decides. That way an
  agent edit and a user save never flip a file's endings. A mixed-ending file is flattened on its first
  save, and a lone `\r` does not survive, the same as under a pi `edit`. The final newline is the
  editor's. A created file is written as sent. A U+FEFF that starts the content is a character, so the
  host writes a BOM before it, whatever the disk file had. `toEditorText` of the written file then
  equals the content, so a second save of the same buffer, or a replay, is a no-op.
- **A create maps errno like an update.** A read-only folder or volume answers `readonly`; a regular
  file or a dangling symlink where a parent folder should be is `NOT_EDITABLE`, never a raw errno. The exclusive create writes straight to the
  target, so a write that fails partway (`ENOSPC`) removes the file it created; a replay then creates
  again instead of reading `stale` against a partial file.
- **Atomic unless that changes the file's identity.** Temp+rename in the target's directory, with the
  mode and group copied. A hard-linked file, a file owned by another user, and a target whose temp
  create, `chown` to the file's group, or rename fails with `EACCES`/`EPERM`/`EBUSY`/`EXDEV` are written
  in place. A file owned by another user whose mode must change is the exception and renames: only the
  owner may `chmod`, so in place it could never succeed. Rename loses xattrs, ACLs and Finder tags; this is accepted. No fsync, the same as pi. A
  crash can leave a `.thinkrail-write-*.tmp` file; nothing sweeps it.
- **An in-place write can tear.** It truncates, writes, then sets a changed mode. When the write or the
  `chmod` throws (`ENOSPC`, `EIO`, `EPERM`), the old bytes are written back before the error is
  rethrown, and the old mode is still in place. A host crash mid-write still leaves a partial
  file; only the atomic path is crash-safe.
- **A rename never bypasses a read-only file.** `replaceFile` checks writability on the target first, so
  a save answers `readonly` and a revert or undo throws, on every platform, with nothing written.
- **No-op before CAS.** A replayed save (request-id dedupe dies with the host) and two windows saving the
  same text succeed with no write and no `fsChanged`.
