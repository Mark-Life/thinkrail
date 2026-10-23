---
id: submodule-server-provenance
type: submodule-design
status: active
title: provenance — who wrote each file version
parent: module-server
depends-on: [module-contracts]
references: [submodule-server-fs, submodule-server-agent, submodule-server-host]
tags: [public-surface-checked]
---

## Responsibility

Remember who wrote each version of a worktree file, what each agent session last read, and when each
shell command ran. The host reports a file's last writer on `fs.readFile`. The agent's `fileGuard`
uses the same data to tell an agent that someone changed a file under it.

## Boundary

- **Owns:** `createProvenance(options?)`, a bounded in-memory store, and `fileProvenance`, the host's
  one instance. Entries are keyed by the file's realpath, or its lexical path while it is absent: the
  identity pi's mutation queue uses. Nothing persists, so a host restart forgets everything.
  - **Write ledger.** Per path, a ring of `WriteEntry {seq, at, path, hash, author, line?}`.
    `recordWrite({path, author, before, after, line?})` takes the bytes before and after the write; `line`
    is the first changed line, given or derived. A recorded author is exact: `user{clientKey}` (an editor
    save, a review revert or undo) or `agent{sessionId, via:"tool", toolName}` (a pi `edit`/`write`).
  - **Read baselines.** Per session and path, `{hash, seq, at}` from the agent's last read or its own
    write. `recordRead({sessionId, path, bytes})` also caches the text by (path, hash), shared across
    sessions, so a later hint can diff the baseline against the disk. `forgetSession` drops one session.
  - **Bash windows.** `openBashWindow` / `closeBashWindow` per tool call. Closing returns the user writes
    that landed during the call.
  - **`staleRead({sessionId, path, current})`** answers `null` when the session's baseline matches the
    disk. Otherwise it returns the other writers since the baseline, whether an untracked write happened,
    the bash window whose time covers the file's mtime, and the baseline text when it is cached. With no
    baseline it returns only other writers from the last 10 minutes, and never a diff.
  - **`lastWrite({path, hash, mtimeMs, clientKey})`** answers the wire's `FileLastWrite`. The order is: a
    ledger entry for (path, hash); else an mtime inside a bash window → `agent` via `script`, inferred;
    else a path with ledger history → `external`, inferred; else nothing. A `user` author goes on the wire
    as `thisClient` relative to the asking client, never as the clientKey, because the clientKey is a
    reconnect identity another client could take over.
  - `readSnapshot(abs)`: bytes plus mtime, `null` when absent, not a file, or over 8 MiB.
    `recordingQueue(queue, author)` wraps a per-file mutation queue, so a write it runs is recorded as
    that author by reading the file before and after.
  - **Notes**, the agent-facing text: `staleEditHint`, `staleWriteBlock`, `bashNote`. A hint is a
    one-line pointer (who, how long ago, which line) plus a diff from the baseline text to the disk,
    capped at 40 lines.
- **Public surface (barrel):** `createProvenance`, `fileProvenance`, `Provenance`, `WriteAuthor`,
  `WriteEntry`, `StaleRead`, `BashWindow`, `FileSnapshot`, `readSnapshot`, `recordingQueue`,
  `staleEditHint`, `staleWriteBlock`, `bashNote`.
- **Allowed deps:** `fs` (`hashBytes`, `classifyBytes`, `decodeText`); `contracts` (`FileLastWrite`, and
  at runtime `toEditorText`); `diff` (external, the line diff); Node `fs`/`path`.
- **Forbidden:** `host`, `agent`, and any pi import. pi knowledge (tool names, error text, path rules)
  stays in `agent`'s `fileGuard`.

## Get right

- **Exact versus inferred.** Only the host's own saves and reverts and pi's `edit`/`write` are recorded.
  A shell command's writes and every outside writer are inferred at read time from the mtime and never
  stored, so a terminal formatter running during an agent's bash call is blamed on that agent. The wire
  marks those authors `inferred`.
- **Attribution race.** An agent write is recorded by re-reading the file after pi's tool returns,
  inside the same mutation queue. A bash or outside write that lands between pi's write and the re-read
  is labeled agent. The read baseline has the same race: a write between pi's read and the re-read makes
  the baseline newer than what the agent saw, and that collision goes unflagged.
- **A net diff, not per-write hunks.** Autosave writes about once a second, so joining every write's
  hunks would show typing noise with shifting line numbers. The hint diffs the cached baseline text
  against the current text. When that text was evicted or is over 512 KiB, the hint is a pointer only.
- **Order is `seq`, not time.** Two writes in the same millisecond still order correctly against a
  baseline.
- **Bounds.** Per path 32 writes, 4096 paths; per session 1024 baselines, 256 sessions; a 32 MiB text
  cache; 256 bash windows. Eviction is least-recently-used and only loses a hint, never a write.

## Later

- Windows for background commands, so their writes infer as script too.
- Turn receipts that leave out user-authored writes.
- Session titles in notes, in place of "another agent".
