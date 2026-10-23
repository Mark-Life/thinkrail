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
  one instance. Entries are keyed by the file's realpath; an absent file by its nearest existing
  ancestor's realpath plus the rest, so a delete lands on the same key. Nothing persists, so a host
  restart forgets everything.
  - **Write ledger.** Per path, a ring of `WriteEntry {seq, at, key, path, hash, author, line?}`; `hash`
    is `null` for a delete. `recordWrite({path, author, before, after, line?, toolCallId?, changedOnly?})`
    takes the bytes before and after (`null` for absent). `line` is the first changed line: given, derived
    from `before`, or, when `before` is `null`, from the cached text of the version it replaced. A
    recorded author is exact: `user{clientKey}` (an editor save, a review revert or undo) or
    `agent{sessionId, via:"tool", toolName}` (a pi `edit`/`write`).
  - **Read baselines.** Per session and path, `{hash, seq, contested}` from the agent's last read or its
    own write. `recordRead({sessionId, path, bytes, toolCallId?})` also caches the text by (path, hash),
    shared across sessions, so a later hint can diff the baseline against the disk.
  - **Tool claims.** `openClaim({sessionId, toolCallId, path, mutates, bytes})` at pi's `tool_call`
    marks the version the tool started from; `recordRead`/`recordWrite` with that `toolCallId` settle it,
    and `endTool` drops it. See *Concurrent writers*.
  - **Bash windows.** `openBashWindow({sessionId, toolCallId, cwd})` / `closeBashWindow` per tool call.
    A window covers only files under its `cwd`. Closing returns the user writes under that `cwd` that
    landed during the call. `endTool` closes a window whose call never produced a result.
  - **`staleRead({sessionId, path, current})`** answers `null` when the session's baseline matches the
    disk and no other writer is pending against a contested baseline. Otherwise it returns `read`, the
    other writers since the baseline, whether an untracked write happened, `script.self` when a bash
    window under the file covers its mtime, and the baseline text when it is cached. With no baseline it
    returns only other writers from the last 10 minutes, and never a diff.
  - **`lastWrite({path, hash, clientKey})`** answers the wire's `FileLastWrite` and stats the file only
    when it needs the mtime. The order is: a ledger entry for (path, hash); else an mtime inside a bash
    window under the file → `agent` via `script`, inferred; else a path with ledger history →
    `external`, inferred; else nothing. A `user` author goes on the wire as `thisClient` relative to the
    asking client, never as the clientKey, because the clientKey is a reconnect identity another client
    could take over.
  - `forgetSession` drops one session's baselines and claims and closes its windows.
  - `readSnapshot(abs)`: bytes plus mtime, `null` when absent, not a file, or over 8 MiB.
    `editorText(bytes)`: the text a diff compares (`toEditorText`), `null` for byte-only content.
  - **Notes**, the agent-facing text: `staleEditHint`, `staleWriteBlock`, `bashNote`. A hint is a
    one-line pointer (who, how long ago, which line) plus a diff from the baseline text to the disk. The
    agent is "you"; the human is "the user".
- **Public surface (barrel):** `createProvenance`, `fileProvenance`, `Provenance`, `StaleRead`,
  `readSnapshot`, `editorText`, `staleEditHint`, `staleWriteBlock`, `bashNote`.
- **Allowed deps:** `fs` (`hashBytes`, `classifyBytes`, `decodeText`); `contracts` (`FileLastWrite`, and
  at runtime `toEditorText`); `diff` (external, the line diff); Node `fs`/`path`.
- **Forbidden:** `host`, `agent`, and any pi import. pi knowledge (tool names, error text, path rules)
  stays in `agent`'s `fileGuard`.

## Get right

- **Exact versus inferred.** Only the host's own saves, reverts and undos and pi's `edit`/`write` are
  recorded. A shell command's writes and every outside writer are inferred at read time from the mtime
  and never stored, so a terminal formatter running in the same worktree during an agent's bash call is
  blamed on that agent. The wire marks those authors `inferred`.
- **Concurrent writers.** An agent's read or write is recorded by re-reading the file after pi's tool
  returns, inside the same mutation queue. Another writer queued behind the tool runs before that
  re-read, so the re-read may hold bytes the agent never saw. The claim catches the writers ThinkRail
  knows: when another author's entry landed after the claim, or another session's `edit`/`write` claim
  on the file is still open, the baseline is *contested*: it keeps the claim's `seq`, so those writers
  stay reported even when the disk matches the re-read. A contested agent write is not recorded while
  the other claim is open, nor when its bytes equal the newest entry, so the other writer keeps its
  bytes. A bash or outside write in that gap is still adopted unseen.
- **Failed tools.** pi throws "Operation aborted" after `writeFile` when Stop lands in that gap.
  `changedOnly` records such a write only when the disk differs from the claim's starting version.
- **A net diff, not per-write hunks.** Autosave writes about once a second, so joining every write's
  hunks would show typing noise with shifting line numbers. The hint diffs the cached baseline text
  against the current text. When that text was evicted or is over 512 KiB, the hint is a pointer only.
  The diff is capped at 40 lines, 240 characters per line and 6000 characters in all, so a minified
  file cannot flood the context. Its fence is longer than any backtick run in the lines.
- **Order is `seq`, not time.** Two writes in the same millisecond still order correctly against a
  baseline.
- **Bounds.** Per path 32 writes, 4096 paths; per session 1024 baselines, 256 sessions; 512 recent writes
  for bash notes; 1024 open claims; a 32 MiB text cache; 256 bash windows. Eviction is
  least-recently-used. A dropped ring entry only loses a hint. An evicted path loses its history: its
  writer then reads as untracked ("a program outside ThinkRail") and `lastWrite` as `external` or
  nothing.

## Later

- Windows for background commands, so their writes infer as script too.
- Turn receipts that leave out user-authored writes.
- Session titles in notes, in place of "another agent".
