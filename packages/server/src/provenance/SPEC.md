---
id: submodule-server-provenance
type: submodule-design
status: active
title: provenance — who wrote each file version
parent: module-server
depends-on: [module-contracts, submodule-server-fs]
references: [submodule-server-agent, submodule-server-host]
tags: [public-surface-checked]
---

## Responsibility

Remember who wrote each version of a worktree file, what each agent session last read, and when each
shell command ran. The host reports a file's last writer on `fs.readFile` and on each `workspace.fsChanged` path. The agent's `fileGuard`
uses the same data to tell an agent that someone changed a file under it.

## Boundary

- **Owns:** `createProvenance(options?)`, a bounded in-memory store, and `fileProvenance`, the host's
  one instance. Entries are keyed by the file's realpath; an absent file by its nearest existing
  ancestor's realpath plus the rest, so a delete lands on the same key. Nothing persists, so a host
  restart forgets everything.
  - **Write ledger.** Per path, a ring of `WriteEntry {seq, at, key, path, hash, author, line?, provisional?}`; `hash`
    is `null` for a delete. `recordWrite({path, author, before, after, hash?, line?, toolCallId?, changedOnly?})`
    takes the bytes before and after (`null` for absent). `line` is the first changed line: given, derived
    from `before`, or, when `before` is `null`, from the cached text of the version it replaced. A
    recorded author is exact: `user{clientKey}` (an editor save, a review revert or undo) or
    `agent{sessionId, via:"tool", toolName}` (a pi `edit`/`write`). A user save also caches its text;
    only the newest per path is kept, unless it is some session's baseline. When an agent write lands
    over another author's entry made after its claim, `recordWrite` returns those writers and the
    replaced text, so `fileGuard` can tell the agent what it overwrote.
  - **Read baselines.** Per session and path, `{hash, seq, at, contested, unseen?}` from the agent's last
    read or its own write. `recordRead({sessionId, path, bytes, hash?, toolCallId?})` also caches the text by (path, hash),
    shared across sessions, so a later hint can diff the baseline against the disk. `bytes: null` records
    that the agent found the file absent.
  - **Tool claims.** `openClaim({sessionId, toolCallId, path, mutates, hash})` at pi's `tool_call`
    marks the version the tool started from; `recordRead`/`recordWrite` with that `toolCallId` settle it,
    and `endTool` drops it. See *Concurrent writers*.
  - **Bash windows.** `openBashWindow({sessionId, toolCallId, cwd})` / `closeBashWindow` per tool call.
    A window covers only files under its `cwd`. While open it collects the newest user write per file
    under that `cwd`; closing returns them, however long the call ran. `endTool` closes a window whose
    call never produced a result.
  - **`staleRead({sessionId, path, current})`** answers `null` when the session's baseline matches the
    disk and no other writer is pending against a contested baseline. Otherwise it returns `read`, the
    other writers since the baseline, whether an untracked write happened, `script` when a bash window
    under the file covers its mtime (`self` only when no other session's window covers it too), and the
    baseline text when it is cached. When the mtime says nothing (the file is gone, its mtime is older
    than the baseline as after `mv` or `cp -p`, or the baseline is `unseen`), `script` comes from every
    window under the file open since the baseline was set. With no baseline it
    returns only other writers from the last 10 minutes, and never a diff.
  - **`lastWrite({path, hash, clientKey})`** answers the wire's `FileLastWrite` and stats the file only
    when it needs the mtime. The order is: the path's newest ledger entry when its hash matches (an older
    match is a restore, so it falls through); else a bash window under the file that covers the mtime, or, when the mtime is older than
    the newest entry, any window open since that entry → `agent` via `script`, inferred; else a path with ledger history →
    `external`, inferred; else nothing. A `user` author goes on the wire as `thisClient` relative to the
    asking client, never as the clientKey, because the clientKey is a reconnect identity another client
    could take over.
  - **`changeWrite(path, late?)`** answers one `fsChanged` author (`FsChangeWrite {author, hash}`). It
    stats the file first and reads it only when an answer is still possible: the path's newest entry or
    its mtime is under 10 s old, or, for an untracked path, a bash window covers that fresh mtime. So
    a build writing 100 untracked files costs no reads, and neither does a later build after an agent
    bash call. While a mutating claim on the path is open it answers nothing (pi wrote, but the re-read
    has not recorded it yet, so the guess would be `external`). It reads the hash on disk instead and keeps it
    with `late`. When the claim closes, `late` gets that version's author: the newest entry with that hash
    written during the claim, or else the closing agent when its own `recordWrite` closed the claim and the
    hash differs from the claim's start. That second case covers a user save that the mutation queue ran
    before the agent's record, which then never appends an agent entry. A close from `endTool` or
    `forgetSession` never names the agent, and a version with no author calls `late` not at all. It also answers nothing for a version older than 10 s or
    a file it cannot read. Otherwise it is `lastWrite` with the user's client dropped, plus the hash; a
    recorded delete answers its author with `hash: null`.
  - `forgetSession` drops one session's baselines and claims and closes its windows.
  - `readSnapshot(abs)`: bytes, hash and mtime, `null` when absent, not a file, or over 8 MiB, so files
    over 8 MiB are not guarded (the wire caps a user save at 4 MiB). Ledger calls take that hash, and
    `recordWrite`/`recordRead` take an optional `hash` of their bytes, so a save or a guarded tool call
    hashes its bytes once. `editorText(bytes)`: the text a diff compares (`toEditorText`),
    `null` for byte-only content.
  - **Notes**, the agent-facing text: `staleEditHint`, `staleWriteBlock`, `overwriteNote`, `bashNote`.
    A hint is a one-line pointer (who, how long ago, which line) plus a diff from the baseline text to
    the disk. The agent is "you"; the human is "the user".
- **Public surface (barrel):** `createProvenance`, `fileProvenance`, `Provenance`, `readSnapshot`,
  `editorText`, `staleEditHint`, `staleWriteBlock`, `overwriteNote`, `bashNote`.
- **Allowed deps:** `fs` (`hashBytes`, `classifyBytes`, `decodeText`); `contracts` (`FileLastWrite`, and
  at runtime `toEditorText`); `diff` (external, the line diff); Node `fs`/`path`.
- **Forbidden:** `host`, `agent`, and any pi import. pi knowledge (tool names, error text, path rules)
  stays in `agent`'s `fileGuard`.

## Get right

- **Exact versus inferred.** Only the host's own saves, reverts and undos and pi's `edit`/`write` are
  recorded. A shell command's writes and every outside writer are inferred at read time from the mtime
  and never stored, so a terminal formatter running in the same worktree during an agent's bash call is
  blamed on that agent. On the wire those are the `agent` via `script` and `external` authors. A command the user types in ThinkRail's
  terminal goes to a raw PTY, so it is untracked too and the wire calls it `external`. An outside save
  during the call looks the same as the agent's shell, so a note names it "your own shell command, a
  terminal command or a program outside ThinkRail", and the write block does not exempt it. With no
  window, a note says "a terminal command or a program outside ThinkRail". A bash note leaves out
  terminal edits made during the call.
- **Concurrent writers.** An agent's read or write is recorded by re-reading the file after pi's tool
  returns, inside the same mutation queue. Another writer queued behind the tool runs before that
  re-read, so the re-read may hold bytes the agent never saw. The claim catches the writers ThinkRail
  knows: when another author's entry landed after the claim, or another session's `edit`/`write` claim
  on the file is still open, the baseline is *contested*: it keeps the claim's `seq`, so those writers
  stay reported even when the disk matches the re-read. A write recorded while another session's claim
  is open is *provisional*: the re-read may hold that session's bytes. When that session then records
  the same bytes, it takes the entry over; otherwise the entry stays, so the other agent is told which
  agent wrote. A contested write whose bytes equal the newest entry is not recorded, so the other
  writer keeps its bytes. A bash or outside write in that gap is still adopted unseen.
- **An edit starts from what it finds.** pi's `edit` re-reads the file and matches its old text, so an
  edit that succeeds over a change the session never read folds that change into its result unseen.
  `openClaim` for a mutating tool compares the starting version with the session's baseline the way
  `staleRead` does; when they differ, the claim keeps that baseline and the edit's record leaves it in
  place, so the writers in between stay reported. An untracked change marks the kept baseline `unseen`,
  which keeps it untracked until the next read. A `write` reaches its claim only once its check found the
  baseline current, so it keeps none.
- **Checked before it runs.** pi runs every `tool_call` hook of a parallel batch before any call runs,
  so a save can land between a `write`'s block check and its execution (a sibling hook may wait on the
  user). That write cannot be stopped; its result gets `overwriteNote` instead.
- **Failed tools.** pi throws "Operation aborted" after `writeFile` when Stop lands in that gap.
  `changedOnly` records such a write only when the disk differs from the claim's starting version.
  `fileGuard` passes it only for that error: pi throws every other `edit` error before writing, so a
  change on disk then belongs to another writer. An abort before the write that coincides with an
  outside change is still taken as the agent's.
- **A net diff, not per-write hunks.** Autosave writes about once a second, so joining every write's
  hunks would show typing noise with shifting line numbers. The hint diffs the cached baseline text
  against the current text. When that text was evicted or is over 512K characters, the hint is a
  pointer only. When the diff needs more than 200 edits or 50 ms, the hint says it is too large to
  show. The diff runs on the host event loop, so the caps keep a formatter run over a large file from
  freezing every client; `fileGuard` builds it after the mutation queue releases.
  The diff is capped at 40 lines, 240 characters per line and 6000 characters in all, so a minified
  file cannot flood the context. Its fence is longer than any backtick run in the lines.
- **Order is `seq`, not time.** Two writes in the same millisecond still order correctly against a
  baseline.
- **Bounds.** Per path 32 writes, 4096 paths; per session 1024 baselines, 256 sessions; 1024 open
  claims; a text cache of 32M characters (UTF-16 units, so up to 64 MiB of heap); 256 bash windows.
  The oldest goes first: paths by their last write, baselines by their last set, cached text by its last
  write or read, claims by when they opened, windows closed ones first and then by when they opened,
  so many short shell calls cannot evict a long one still running. Lookups do not refresh order. A dropped ring
  entry only loses a hint. An evicted path loses its history: its
  writer then reads as untracked ("a terminal command or a program outside ThinkRail") and `lastWrite` as `external` or
  nothing.

## Later

- Windows for background commands, so their writes infer as script too.
- Turn receipts that leave out user-authored writes.
- Session titles in notes, in place of "another agent".
