---
id: submodule-web-shell-layout-intents
type: submodule-design
status: active
title: shell/layoutIntents — arrangement intent orchestration
parent: submodule-web-shell
tags: [layout, intents, orchestration]
---

## Responsibility

Consume arrangement-agnostic store intents for one mounted workspace and translate each into one pure local frame/workspace-view transaction plus the corresponding attention/focus transition.

## Boundary

- **Owns:** stale frame/view/attention identity guards; consume-once handling; destination and navigation arbitration; open/select/close/tool/terminal/auxiliary-toggle dispatch; attention/focus calculation; and issuing at most one atomic local transition for a result.
- **Public surface (`index.ts`):** the workspace intent-processing hook, `processLayoutIntent` (one intent's consume-and-transition step the hook runs), and narrow callback types.
- **External deps:** store intent, attention, and navigation APIs; transport error normalization for domain requests only; React.
- **Forbidden:** current-layout WS calls; local persistence ownership; session or terminal catalogs/lifetime; panel rendering; server/shared/pi imports; or mutable topology logic outside the pure `layout` sibling.

An intent is consumed only after confirming that its captured frame, workspace view, and attention are still current; nothing else defers it. A `place-terminal` intent in particular is consumed on its first pass while the tab is still reservation-pending, so the tab lands in the same task as the user's click and the host reserve round-trip never sits between the click and the strip. Deferred chat/history work retains its request-time navigation stamp so a late completion cannot steal focus. A global terminal placement resolves to the workspace's last surviving bottom focus and selects an existing compatible slot; creating a new frame slot is an explicit frame command, never a hidden consequence of domain reconciliation. A contextual group id still wins.

Bottom show/toggle uses the same consume-once transition as left/right, including eligible singleton restoration before offering terminal creation and non-bottom focus recovery on hide. Singleton-tool actions mutate the one frame; resource opens/moves among existing groups mutate only the named workspace view.
