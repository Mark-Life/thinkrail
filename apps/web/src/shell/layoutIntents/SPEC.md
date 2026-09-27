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

- **Owns:** the synchronous store-subscriber drain; consume-once handling; destination and navigation arbitration; open/select/close/tool/terminal/auxiliary-toggle dispatch; attention/focus calculation; and issuing exactly one local transition per intent.
- **Public surface (`index.ts`):** the workspace intent-processing hook, the drain factory it subscribes (so the drain is testable against the store without React), and narrow callback types.
- **External deps:** store intent, attention, and navigation APIs; transport error normalization for domain requests only; React.
- **Forbidden:** current-layout WS calls; local persistence ownership; session or terminal catalogs/lifetime; panel rendering; server/shared/pi imports; or mutable topology logic outside the pure `layout` sibling.

Intents are drained by a store subscriber, not a render effect. The `set()` that enqueues one runs the drain synchronously against live store state, and the resulting document, attention and consumption are handed to the workbench as one `LayoutIntentTransition`, which `layoutState` installs in a single store transaction before React schedules its render — so the click's own commit already shows the placement, nothing re-renders the workbench between enqueue and placement, and there is no captured state to guard against going stale. The drain is re-entrant: a `set()` issued while an intent is being handled marks the queue dirty and the loop runs again after the current transition, which is also how a follow-up intent (a terminal created for a freshly shown bottom) is picked up. An intent whose workspace view or attention is not installed yet simply waits for the store update that installs it. A transition that throws still consumes its intent before the error propagates, so one bad placement cannot re-throw on every later store update and block the workspace's queue. A `place-terminal` intent is handled while the tab is still reservation-pending, so the host reserve round-trip never sits between the click and the strip; the reservation request keys on the pending catalog tab, never on the intent, which is gone before any effect could observe it. Deferred chat/history work retains its request-time navigation stamp so a late completion cannot steal focus. A global terminal placement resolves to the workspace's last surviving bottom focus and selects an existing compatible slot; creating a new frame slot is an explicit frame command, never a hidden consequence of domain reconciliation. A contextual group id still wins.

Bottom show/toggle uses the same consume-once transition as left/right, including eligible singleton restoration before offering terminal creation and non-bottom focus recovery on hide. Singleton-tool actions mutate the one frame; resource opens/moves among existing groups mutate only the named workspace view.
