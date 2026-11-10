---
id: module-resource-renderers
type: module-design
status: active
title: "@thinkrail/resource-renderers — file and diff renderers, registry and review surfaces"
parent: architecture
depends-on: [module-contracts, module-locales, module-ui]
references: [submodule-web-panels, submodule-web-chat]
---

## Responsibility

Everything that turns a workspace resource into a viewable, reviewable surface: the engine-neutral resource
description and renderer registry, the eleven bundled file/diff renderers (code, markdown, binary, LFS,
image, SVG, CSV, JSON, notebook, PDF, HTML) with their review composers, thread cards and region surfaces,
and the shared Monaco, Pierre and markdown-document machinery they run on. It is presentation: it owns no
content loading, review persistence, tabs or navigation — a host supplies those.

The package exists so one renderer stack serves every surface that shows a file: the web app's file and
diff panes, the file-comparison diff tab, and extension tool cards (visualize's file previews,
[[module-ext-visualize]]), so a renderer fix lands everywhere at once.

## Public surface

One barrel, `@thinkrail/resource-renderers` (`src/index.ts`):

- the registry contract — types, `registerResourceRenderer`, `resolveRenderers`, `describeResource`,
  `anchorLabel`, `isPlaceable`, `threadLabel`, `outdatedReason`, `rendererImplementationKey`, and the content
  rules every surface shares: `resourceContent(text, meta, url)` (no metadata yet is provisional text, a
  missing hash is an absent side, a binary side without a byte URL is absent), `diffResourceMeta(original,
  modified)` (a diff is described by its modified side unless that side is absent, and is text only when
  both present sides are) and `PENDING_TEXT_META` — plus `registerBundledResourceRenderers()` (idempotent).
  `diffRendererCapabilities` returns, from a path alone (before content loads), the capabilities of the
  diff renderer it would resolve to — inferring the text/binary split from the path's MIME so known image
  and PDF paths resolve to their layout-less renderers; MIME inference itself stays module-internal. A pane
  uses it to hide scope-wide layout and whitespace controls no file can use;
- the host seam — `ResourceHostProvider`, `ResourcePreferencesProvider`, `ResourceEnvironmentProvider`,
  `ResourceScopeProvider`, `useOptionalResourceHost`, `useResourceScope` and the `ResourceHost`,
  `ResourcePreferences`, `ResourceScope`, `ResourceFileReviewProps`, `ResourceReviewSendProps`,
  `ResourceMarkdown`, `ResourceCodeHost`, `ResourceCodeLanguage`, `ResourceMarkdownProps`,
  `MarkdownRehypePlugins` types;
- `canonicalWorkspacePath` — the package's copy of the app's workspace-relative path identity (`lib`'s
  `projectRelativePath`: POSIX separators, no `.` or empty segments, inner `..` resolved;
  `apps/web/src/panels/pathIdentity.test.ts` keeps the two equal); `describeResource` and `ResourcePreview`
  use it, so a `./`-prefixed tool path reads, refreshes and anchors review comments under the same path the
  host's fs events, the review store and an opened tab use;
- **`ResourcePreview`** — a self-loading file view, or with `before` (another file) a before/after diff of two
  workspace files, with the registry's toggle, the unplaced strip, review commenting and Send review, and
  caller slots (`leading`, `actions`, controlled `rendererId` / `layout`, and an opaque `viewState` it tags
  with the renderer implementation that wrote it, so a renderer switch never restores another renderer's
  state and a caller needs no reset). Its `compact` flag (carried to the lazy views as
  `ResourceEnvironment.compact`, and reset by an explicit `compact={false}`) drops the renderer toggles,
  Send review and the HTML notice with its viewport presets — the chrome a small embedded frame cannot
  afford; the views themselves are unchanged. Its `fitContent` flag offers the view (or diff)
  `onNaturalHeight(natural)`; a renderer that lays out at its own height calls it with `true`, and from
  then on (for that renderer implementation) the frame drops the caller's height and grows with the view,
  until the renderer calls it with `false`. Views that never call it keep the caller's bounded box. A
  natural frame's height is kept in page memory (`naturalHeights.ts`, 500 entries, oldest dropped) per
  workspace, path and comparison base, stamped with the renderer implementation and the content hashes. A
  later mount of the same preview holds that height while the file loads, and after that while the stamp
  matches, until the renderer answers `true`; an answer of `false` after `true` forgets it. A virtualized
  chat unmounts a card that scrolls away, and without the memory the card came back as the caller's 480 px
  loading box before it was measured again: the row changed height twice (1711, 529, 1711 px with a
  1600 px mockup), the list corrected the scroll offset for the first change only, and the transcript ended
  1182 px away from what the reader was looking at (Chromium and WebKit). Remembering only the measured
  content height inside the HTML view was not enough, because the file read is asynchronous and the
  loading box comes first. The first mount of a preview still grows from the caller's box;
- **`FramedResourcePreview`** — `ResourcePreview` in a caller-sized frame with **Open in tab** (the file, or
  the comparison for a diff) and **Full screen** (a dialog with the full chrome, sharing renderer and view
  state), every action an explicit tab stop; nothing without a host and a workspace scope. `fitContent`
  applies to the inline frame only; the full-screen dialog always fills its box. It is the one
  framed preview of visualize's file card and the questionnaire's previews ([[module-ext-visualize]],
  [[module-ext-ask-user-question]]) — lifted from visualize when the second consumer arrived;
- the pieces every surface composes a renderer from, so a file tab, a diff tab, a Changes section and
  `ResourcePreview` run one sequence:
  - `useRendererSelection(resource, intent, rendererId)` — candidates for the environment's phone class, the
    selected renderer, its implementation key (renderer id + phone class) and the placed-thread state;
  - **`usePreloadResourceView()`** — a stable `(resource) => void` that resolves the view renderer for the
    environment's phone class, loads its implementation and runs the module's optional `warm`; it needs both
    providers;
  - the lazy `RendererView` mount and **`GuardedRendererDiff`**, the one diff mount: the expensive-diff notice
    (`diff-too-large` / **Show diff anyway**, per mount, with a caller action slot) until opted in, then the
    lazy diff renderer, virtualized above `VIRTUALIZED_DIFF_LINES` of the caller's `lineCount`
    (`surfaceLineCount`);
  - **`RendererToggles`** — the renderer candidate segments, plus Split/Inline when the caller passes a diff
    `layout`, the renderer supports layout and the viewport is not phone-class (one rule, so a phone never
    shows a layout the diff refuses and a single-file view never shows diff layout);
  - `UnplacedReviewStrip`, `ReviewThreadCard`, `ReviewDraftContext`/`ReviewDraftPersistence`, and
    `createAskAgentRequest`;
- `useScrollViewState` — the one scroll view-state hook (restores a saved offset once the content is tall
  enough, gives way to user input, reports the offset on detach, and adopts a newer saved offset — one a
  sibling instance of the same slot reported on its detach, as the Changes review's Stacked handoff does —
  while its own scroller is still where it was restored to) and `viewStateScrollTop`, its validating
  reader of a reported/saved offset; renderers use them, and so does the web app's Files panel
  (`RememberedScrollArea`), so app and renderers keep one restore rule.

Renderer implementations are never exported; they stay behind each registration's dynamic
`loadView`/`loadDiff`, and the large-diff estimate, the notice and the lazy diff mount stay behind
`GuardedRendererDiff`. The barrel's eager weight is registration metadata plus those pane-side pieces, which
the app's review panes and the chat's visualize card load eagerly anyway (the visualize card added about
20 KiB to the web entry graph, measured with a production build).

## Host seam

A host wraps renderers in `ResourceHostProvider` with one static `ResourceHost` value:

- `markdown` — the component that renders markdown (`ResourceMarkdownProps`); the document preview, rendered
  diff and notebook cells pass their plugins and components through it.
- `code` — the code-highlighting host (the `languages` catalog, `languageId` canonicalization, `editorTheme`
  with Monaco rules and colors from CSS variables, and `pierreTheme`). Monaco is page-global: the first preload `warm` or
  `MonacoEditor` initializes it from its host's `code` once (`ensureMonaco`, synchronous after the Monaco
  chunk loads), and every later editor reuses that setup. `ensureMonaco` owns the one page-lifetime theme
  watch, so a swap between a preload and the first editor still re-themes, and N open editors cost one
  refresh per swap. The Pierre tokenizer loads on the first model of a registered language, never on a preload.
- `bytesUrl(workspaceId, path, oid?)` — the host byte route for images, PDFs and relative markdown assets.
- `openFile(workspaceId, path, { keep? })` and `openComparison(workspaceId, before, path)` — navigation for
  relative document links (preview) and explicit Open-in-tab actions (keep).
- `readFile(workspaceId, path)` and `subscribeFileChanges(workspaceId, onChange)` — `ResourcePreview`'s
  content and live refresh (`null` paths mean "anything may have changed": a truncated batch or a new
  connection, whose missed pushes are never replayed). A read may come back without `meta` from a host that
  predates resource metadata; the preview shows it as provisional text, exactly as the file and diff panes do.
- `FileReview` (a render-prop component: `{ workspaceId, path, kind, sessionId?, children(review) }`) and
  `ReviewSend` — the host's review surface and Send review control; the optional session routes sends. The
  seam is a component, not a hook on the host object: passing hooks around as values breaks React's rules and
  made the React Compiler bail out of the preview; a before/after nests two `FileReview`s.
- `html?: { mode(workspaceId, path), subscribe?(onChange) }` — how an HTML file is previewed: `"static"`,
  `"themed"` or `"scripted"` (`ResourceHtmlMode`, see `thinkrail/html`). The host answers because only it
  knows which paths are its own and which files the agent showed; the package never names a host path.
  `subscribe` is for an answer that can change while a view is mounted (`useHtmlMode` reads through
  `useSyncExternalStore`). Without a host or without the seam every file is static. `themed` runs no
  script from the file, so it is safe for any HTML. `scripted` runs the file's own scripts, so the host answers it only
  for a path the agent showed. The package lowers `scripted` to `themed` for a descriptor with a
  git `scope`: that side shows a revision, not the file on disk the host answered for.
Build the value once (the app does at module scope). Its functions are memo inputs: `documentComponents`
defines its link and image components per call, so a new `bytesUrl`/`openFile` identity would remount every
link and image in open previews and notebook cells. The reader's line-width preference
(`fileLineWidth` / `fileLineWidthBounded`) arrives separately through `ResourcePreferencesProvider`; only
`MonacoEditor` reads it, so a width change re-renders nothing else. The phone class arrives the same way
through `ResourceEnvironmentProvider` (the registry's `ResourceEnvironment`, `{ mobile }`); only
`ResourcePreview` reads it — panes resolve with their own viewport reading — so a viewport flip re-renders
only the previews that must re-resolve their renderer. A subtree that belongs to one workspace and chat
sets `ResourceScopeProvider` (`{ workspaceId, sessionId? }`, read with `useResourceScope`; the web chat wraps
its transcript list): `ResourcePreview` falls back to its workspace when no `workspaceId` prop is given and
routes review sends to its session. The scope is its own context rather than a host field because a host
spread per chat made every preview's reads and subscriptions restart whenever the chat's actions changed.
`ResourcePreview` depends only on the host's stable `readFile` / `subscribeFileChanges` / `bytesUrl`; its
reads are **single-flight** per file: change events during a read fold into one follow-up read sent after
it settles, like the web panels' live reads, because a stalled host otherwise collected one `fs.readFile`
per event until the transport's replay cap refused every request. It applies reads in the order it issued
them (a newer change event never discards the read in flight, so a burst of events cannot starve the first
load), keeps the loaded file when a re-read returns the same hash —
as the same state object, like a re-read that fails the same way, so React bails out instead of scheduling
a render that would interrupt an unfinished mount below it, such as a large diff's — and keeps the last
good content when a re-read fails, like a file tab, but marked stale: the failure is named above it
(`resource-preview-stale`: `Couldn't refresh <path>: <reason>`), so a moved or deleted file never silently
passes for current. The rendered markdown diff renders both
sides with `renderToStaticMarkup`, outside the React tree, so it reads the markdown component and links in its
own render and passes them to `MarkdownDocument` explicitly — a context read inside a static render would throw
(found by the Changes/rendered-diff e2e during extraction).

`ResourceRenderer.loadView(environment)` receives the same `ResourceEnvironment` (`{ mobile }`) used for
resolution, so the code renderer picks Pierre `File` on phone-class viewports and Monaco otherwise without
reading a viewport global. The loaded module (`ResourceViewModule`, exported from the root) may export
`warm(host)`; a preload calls it after every request, one task after the module resolves, so
the chunk's evaluation and the warm are separate long tasks. It must be cheap and idempotent. Monaco's
`warm` runs `ensureMonaco`; the highlighter loads when the first model opens. `usePreloadResourceView` preloads only a
renderer whose `capabilities.preload` is set, which only the code view sets: a host warming every row it
hovers would otherwise load the PDF, notebook or CSV chunk of the row's top candidate.
Once the chunk has loaded, a Monaco mount is
synchronous: no library loader or boot promise stands between the view's commit and the editor.

**One loaded implementation per key, chosen once.** `rendererMount` keeps one component map and the
in-flight load per implementation key (renderer id + phone class), shared by preloads and mounts.
`RendererView` derives that key itself from its `renderer` and `mobile` props, so a mount and a preload
cannot disagree on it. React
`lazy` suspends on its first render even when its promise already resolved, and a shown fallback holds for
at least 300 ms. So a finished load stores the module's component under its key, unless a mount already
stored a `lazy` there, and the first `RendererView` without a stored component stores a `lazy` that reuses
the in-flight load. That choice is stored once and never switched: a lazy and a direct component are
different types, and swapping them would remount a live editor. A lazy made while a load was in flight is
resolved for every later mount, so it does not suspend again. A failed preload, in the load or in `warm`,
logs a warning instead of rejecting. A failed load is forgotten so the next load retries it. A `lazy` that a
mount stored while the load was in flight stays stored and failed, so every re-render of that mount throws
to the pane's error boundary instead of making a fresh `lazy`. React retries a failed render, and an engine
that refetches failed module imports (Chromium 156+) would otherwise loop on the chunk request. The next
load, such as a hover or idle preload, replaces the failed `lazy` with the loaded component.

**Review-draft scratch is read per slot.** A pane that keeps transient authoring across remounts provides
`ReviewDraftContext` with a `ReviewDraftPersistence` (`rendererId`, `read(key)`, `subscribe`, `update(key,
change)`) that stays stable for the section's lifetime; without it every slot is local state.
`useReviewDraftState` reads one slot through `useSyncExternalStore`, so a write re-renders only that slot's
readers, not the renderer surface around them. A composer's text has its own slot next to its selection: the surface
subscribes to the selection, and only `ReviewComposer` subscribes to the text, so a keystroke re-renders the
composer alone instead of the surface and every annotation slot Pierre re-renders with it
(`e2e/perf/changesComposerIsolation.perf.ts` pins this). Text writes land only while the selection that owns
them is current; a new selection, a close or a stamp refresh retires the text; reopening the same selection
keeps it.

## Decisions

- **Markdown is injected, not imported.** The host's markdown (the app's `chat/Markdown`) draws Mermaid
  through `@thinkrail/ext-visualize/web`; importing it would create a package → extension → package cycle
  once extensions render files. The package therefore owns only the props contract; its tests render through
  a test-only react-markdown + GFM helper.
- **Host values are plain and static.** The extraction first resolved markdown and code through lazy loaders
  read with `use`, to keep chat's markdown and the language catalog out of the entry graph. Both were already in
  it — chat imports its markdown statically, and that pulls `lib/codeLanguages` — so the
  loaders deferred nothing (rolldown reported the markdown import as ineffective) while costing a suspended
  render on first mount and a loader-identity contract a host could break. Plain values removed both, and the
  web eager graph shrank by about 1.5 kB. Preferences got their own context for the same reason the values are
  static: a host value that changes re-renders every renderer that reads it.
- **Small helpers moved with their only consumer or became primitives.** `stripFrontmatter`, `threadLabel`
  and `outdatedReason` live here; `ToggleSegment` and the one loading placeholder (`SkeletonRows` /
  `LoadingRegion`) became `@thinkrail/ui/toggle-segment` and `@thinkrail/ui/skeleton` because the app uses
  them too. `describeResource` and `ResourcePreview` canonicalize paths through the package's own
  `canonicalWorkspacePath`, because the package cannot import the app's `lib`.
- **Monaco runs its vendored DOMPurify.** `monaco-editor` sanitizes hovers and rendered markdown with its own
  copy under `esm/vs/base/browser/dompurify`, so only a Monaco upgrade changes the sanitizer that runs; the
  `dompurify` it declares is never imported. The vendored copy predates several DOMPurify advisories. The
  exposure is accepted: this read-only reader has no language services, hover providers or decoration
  hover messages, so hover markdown is Monaco's own, and it calls DOMPurify with hooks and
  `RETURN_DOM_FRAGMENT`, never `IN_PLACE` or `SAFE_FOR_TEMPLATES`.
  Monaco 0.57 vendors 3.4.15. The root `overrides.dompurify` pin only keeps the declared copy on Mermaid's
  patched version (Mermaid does import it); it is not a Monaco fix. Re-check the vendored banner on every
  Monaco upgrade.

## Boundary

- **Allowed deps:** `@thinkrail/contracts` (types), `@thinkrail/locales` (the `MessageKey` type and
  `./react` for its UI strings — `useT`, `<T>`, `localeOf`), `@thinkrail/ui` primitives, React, and the renderer
  engines (`monaco-editor`, `@pierre/diffs`, `@pierre/highlights`, `pdfjs-dist`,
  `react-markdown`, `rehype-raw`, `rehype-sanitize`, `diff`, `jsondiffpatch`, `react-virtuoso`,
  `node-htmldiff`).
- **Forbidden:** the web app (store, transport, panels, chat, shell, lib, themes), extensions, the server, and
  pi packages. `scripts/check-module-boundaries.ts` enforces it; only `apps/web` consumes the package today.
- UI text follows [[architecture]] Decision 23: renderer chrome renders through `useT()`'s translator
  (`viewer.*` keys) and `check:i18n` scans `packages/resource-renderers/src` like the app. A renderer's
  `labelKey` is a catalog key, never translated text: registration happens once at module load, so the
  view-toggle, candidate pickers and unplaced strip translate it at render with their own translator.
- Styling follows the app's token rules: the Tailwind `@source`, the colour/spacing/typography guards and the
  React Compiler census all scan `packages/resource-renderers/src`.

## Registry and review-surface contract

Own the engine-neutral resource description, renderer registry, and review-surface contract used by file
and diff panes. Selection is metadata-driven: matching renderers are filtered by intent and phone support,
ranked, and followed by the required text or byte fallback. MIME matching uses the same extension-derived
fallback as resource description when host MIME metadata is absent. The resulting ordered list is both
dispatch policy and the pane's view-toggle grammar. Renderer capabilities also state whether the selected
surface supports copying its modified source, split/unified layout, and ignore-whitespace recomputation; the
pane exposes only those applicable controls. `preload` marks a view worth loading before its first mount
(only the code view sets it). `boundedDiff: "always"` marks a diff renderer that manages its
own viewport (virtualized table, paged PDF, sandboxed HTML frame) and therefore needs a bounded height;
`"large"` marks one that lays out naturally but virtualizes once bounded, so a host bounds it when the diff
is large; a host passes `virtualize` only for a diff large enough to need it. Every other diff lays out at its natural height, which is what lets the continuous Changes review stack sections
in one scroll. `HunkActions.triage` is optional: a surface that tracks kept hunks supplies the kept keys,
a setter, and a sink for the renderer's hunk content keys; a renderer without it shows no Keep control.

`ResourceContent` keeps text, retrievable bytes, and an absent diff side distinct. In particular, absence
is never represented by a byte payload without a URL. `SurfaceReview` carries authoritative anchors; a
renderer only projects selectors into geometry. `isPlaceable` answers whether at least one positioned
selector has a geometry the renderer advertises for the requested view or diff intent, while `anchorLabel`
is the shared compact reference. `ResourceDiffProps.originalResource` describes the original side when it is
a different file (a file comparison); renderers that resolve relative assets or links from the document
path — the rendered markdown diff — use it for the original side, and the visual diffs title that side with
it; absent, both sides share `resource`. A diff renderer may report the thread ids it actually placed through
`ResourceViewProps.onPlacedThreadIds` or `ResourceDiffProps.onPlacedThreadIds`; the pane treats
capability-matching ids omitted from that set as unplaced too, covering renderer-local geometry such as a
removed JSON pointer, deleted table cell, or collapsed context. A virtualized paged renderer reports against
known page-count geometry rather than transient canvas residency, so releasing an off-screen page does not
make its thread unplaced. A renderer with no anchor capability for its intent may ignore its review prop; the
pane keeps those threads in its unplaced strip instead.

`HunkActions` is the mutation boundary between a diff engine and its pane. A renderer reports only the
engine-neutral original/modified `LineSpan` pair it computed: `revert` applies that one block,
`revertFile` applies the file target, and `askAgent` returns the `AnchorDraft` plus initial composer text
that the renderer places on the modified side. `agentWorking` is presentation-only and never disables the
CAS-protected actions. The pane owns wire calls, scope and expectation hashes, undo receipts, stale-view
refresh, and error UI. An immutable scope omits `hunkActions`; renderers must then omit every mutation
control rather than emulate one.

Registration owns no content or tab state. Panes own transport URLs, review integration, selected renderer,
and opaque per-tab view state. `anchorLabel` prefers a structural locator over its mandatory text fallback:
`table-cell` is `R<row>C<column>`, `json-pointer` is the pointer itself, and unknown schemes retain
`<scheme> <ref>`; `ipynb-cell` is `cell <n>` for legacy `index:<zero-based>` refs and `cell <id>` for
stable ids, with an optional renderer-supplied id-to-ordinal map producing the local `cell <ordinal>` label.
Paged regions are `p<page> region`; unpaged regions, lines, and files keep their existing forms. Registration
carries only dispatch, geometry, viewport, and concrete diff-control capabilities; it has no unenforced
provenance or execution-policy metadata. Sandboxing belongs to each renderer implementation.

**Wide rewrites wait behind a notice.** Source diffs run on the main thread, and that cost tracks the number
of changed lines, not the file size: a 10 MB all-added file diffs in ~0.1 s while ~10k changed lines take over
20 s. Before mounting a diff renderer, `GuardedRendererDiff` estimates the changed lines (`largeDiff`: the
linear multiset difference of the two sides' lines). Above `LARGE_DIFF_CHANGED_LINES` (2000, about a second of
diffing), or when an order-sensitive check cannot finish within 50 ms / 2000 edits, it shows `diff-too-large`
with **Show diff anyway** (per mount) and the caller's actions. A one-sided diff (added or deleted file) is
never guarded: it costs no diffing. The bounded check closes the multiset estimate's blind spot for reordered
lines. The notice says "This diff is too expensive to show automatically" without a line count; the guard
answers only whether automatic rendering should wait. Every diff surface mounts through it, so the app's diff
tabs and Changes sections, comparison tabs and chat cards cannot disagree.
The first diff of a page mounts through a Suspense retry (the lazy renderer), which React renders
interruptibly and never expires: any unrelated update during it (a watcher nudge, a file re-read) discards the
unfinished mount with its `useMemo` results, and recomputing per restart kept a Show-anyway diff on a skeleton
for as long as the workspace kept changing. `PierreDiff` therefore takes its parse and change blocks from a
content-keyed module cache (`diffCache`) that a restarted render reuses, and computes change blocks only for a
surface with hunk actions, so a read-only preview diffs once. Each of its two tables (parses, change blocks;
they hold the same texts) is bounded by the text its entries retain — 4 Mi characters across both sides,
about twenty full rewrites at the notice threshold (2000 changed lines of ~100 characters) — and by 64
entries, more than one render of a Changes viewport mounts, so releasing every section at once cannot cycle
it; the newest entry always stays however large, so an opted-in giant diff survives its own restarts. The
trade-off: being module-level, it keeps up to that text (or the one larger newest diff) plus Pierre's parse
of it alive after its surfaces unmount, and surfaces that together exceed the budget within one render
recompute on every restart.


## Bundled renderers

Bundled candidates are registered once by `registerBundledResourceRenderers()`: `thinkrail/code` renders
every source diff with Pierre `FileDiff` and supports copy, layout, and whitespace controls;
`thinkrail/markdown` supplies `RenderedDiff`, and `thinkrail/binary` reports both sides' byte sizes. Rich
renderers omit those controls, except CSV, JSON, and notebook diffs support modified-source copy.
`thinkrail/lfs` claims the host's `application/vnd.git-lfs` text (a file that *is* a Git LFS pointer,
whatever its extension) above the code renderer and shows a card — "Stored in Git LFS", size, object id,
`git lfs pull` hint — in the view and one card per side in the diff, because three lines of pointer
protocol in a Monaco editor explain nothing about why a `.png` has no image; Source stays one toggle
away, and the renderer places no anchors, so a pointer's threads live in the unplaced strip.
`RenderedDiff` keeps its worker-isolated htmldiff merge,
loading/error states, and token styling (a text change keeps the previous merge on screen until the next one
arrives, so a live refresh neither flashes the loading placeholder nor remounts the document; finished
merges live in a module-level LRU (`renderedDiffMerges`) keyed by a hash and the lengths of both rendered
sides and bounded like `diffCache` — 16 entries and 4 Mi retained characters — so a remount of an unchanged
diff renders synchronously without the placeholder or a replayed reveal fade, and a cache hit becomes the
mounted document that the next text change keeps on screen), but advertises no diff anchors: both sides' threads stay in the
pane's unplaced strip, **Show in Source** selects the code renderer, and diff authoring is available only
in Source. It is selected by registry match rather than a path branch in the pane. Scopes whose modified
side is historical receive no review surface or mutation actions.

**The rendered diff focuses on its changes the way Pierre does.** The merged document is parsed once
and a prose-root block is *changed* when it is or contains `ins`, `del`, or a `[data-diff-node]`
element, **or** when its exact rendered HTML differs from the before unit it aligns with
(`changedUnits`). Alignment is positional: the before and merged unit sequences (blocks, then each
list's items) are matched one-to-one by an LCS over their attribute-stripped HTML (`shapeKey`), so an
identical twin elsewhere in the document cannot vouch for a block, swapping `open` between two
otherwise identical `<details>` flags both, and a unit with no aligned counterpart stays visible. The
second clause exists because htmldiff keys ordinary tags by tag name alone and emits the *after*
tokens for equal runs: a ticked task checkbox, `<details>` → `<details open>`, a list's `start`, or
an image's `alt` never earn a mark, so without it they would collapse as "unchanged" and the empty
notice would claim an identical preview. Such a block is kept visible in its after state (unmarked,
since the merge has nothing to highlight). Runs of unchanged
blocks collapse with git hunk semantics (`renderedDiffFocus.focusSegments`):
`FOCUS_CONTEXT_BLOCKS` (2) blocks stay visible on each side of a change, a leading or trailing run keeps
context only on the side that touches one, and a run of a single block is never hidden, because an
expander that replaces one paragraph saves nothing and costs a click. The same rule applies one level
down to the items of a changed `ul`/`ol` when at least one item changed — a markdown spec routinely
carries a thirty-bullet list with one edited bullet — while a list whose only difference is its own
attributes, and tables, quotes, and nested lists, render whole; ordered items keep their number
(`start` and an explicit `value` are read with HTML's integer-parsing rules, so the invalid values
React leaves in the DOM — `start=""`, `value=""` — fall back to `1` / the running count exactly as
the browser does; a `value` wins, the rest count on) so hiding items never renumbers the rest.
Each hidden run is one `rendered-diff-collapsed` button naming the count and, for block runs, the last
heading it hides (the section the visible content below it belongs to — the analogue of Pierre's
line-info separators).
Clicking expands the run in place, one-way; expansion is component-local and positional, so a live
refresh keeps an expansion whose run still starts at the same position and resets the rest. Nothing
offers the whole merged document at once: Source and the file preview already do. A merge in which no
block changed — front matter is stripped before rendering, and whitespace or HTML comments don't
render — shows the `rendered-diff-empty` notice pointing at Source and collapses the document to a
single expander rather than presenting an unmarked full document as a diff. Visible blocks are
re-created from the parsed elements (tag, attributes, `innerHTML`), never wrapped, so the DOM the
prose styles target is unchanged; the boolean attributes the sanitizer lets through (`details[open]`, a
standalone checkbox's `checked`/`disabled`) are mapped to `true` because React drops an empty-string
boolean.

`thinkrail/image` renders host-backed byte URLs with fit, natural-size, button/wheel zoom, intrinsic
dimensions, and byte size, always on the `.media-backdrop` transparency checkerboard (the view's image
and both diff frames; the difference blend keeps a flat canvas so the checker cannot leak into the
subtraction), because on a solid dark canvas a dark logo on a transparent PNG is indistinguishable from
an image that failed to load. A drag over the rendered intrinsic box produces one normalized `region`
selector; placed threads project that selector back to outlined rectangles and numbered markers, with
cards below the image. Its diff defaults to 2-up and also offers swipe, onion-skin, and difference-blend
modes. Two-up anchors directly to the side drawn on; overlaid modes expose the active old/new anchor space
explicitly, so base and worktree coordinates are never translated. An absent side is a labelled empty
frame. Image zoom, rendered intrinsic aspect bounds, region rectangles, swipe clipping/divider position,
and onion opacity are measured geometry and therefore the bounded exception to the no-inline-style rule:
those values alone are inline,
while every colour, border, spacing, and control skin remains a token utility.

`thinkrail/svg` contains the vector in its pane in both dimensions (≤ 960 px wide), measured in a layout
effect so a drag's first geometry is already final. It is the higher-ranked SVG candidate while Source remains available through
`thinkrail/code`. Its `sandbox=""` iframe receives a minimal `srcdoc` document whose only image is a
percent-encoded `data:image/svg+xml` URL; SVG source never enters the document's HTML stream. The frame
has no script or same-origin capability and a CSP of `default-src 'none'; img-src data:; style-src
'unsafe-inline'`, so SVG scripts and external references remain inert. The document receives only
resolved workspace/content background and foreground semantic token values and is rebuilt via
`onThemeSwap` from `@thinkrail/ui/theme`. A drag over the frame authors the same normalized `region`
selector a raster image does, measured against the intrinsic size parsed from the root's
`width`/`height`/`viewBox` (the frame is sized to that aspect, so the contained rectangle is the frame).
It never degrades to a whole-file draft: an earlier revision did (`selectors: []`, label `file`, pending
a source-span mapping), and a dragged rectangle that reached the agent as "the whole file" read as lost
coordinates. SVG element source spans are still not mapped, so the anchor is geometry, not a line range;
the fractions are of the SVG's root viewport, and the send package tells the agent to invert the
viewport-to-viewBox transform (viewBox origin plus `preserveAspectRatio`) to find the elements under
them. Its diff uses the same four visual modes and two anchor spaces as raster images; each side's
overlays project through its own object-contain rectangle, and only measured aspect bounds plus
swipe/divider/opacity overlay geometry use inline values.

`thinkrail/csv` parses CSV/TSV locally with an RFC-4180 state machine, including escaped quotes, CRLF, and
quoted fields spanning source lines. The delimiter is **inferred from the shape of the first twenty
non-empty records** (`sniffDelimiter`, BOM ignored): a candidate among `,` `;` `\t` `|` qualifies only
if it splits every sampled record into the same number of fields, at least two; comma wins whenever it
qualifies, otherwise the single widest qualifier, otherwise comma — so a header value that happens to
contain semicolons never reclassifies a comma file, while a locale export of `id;name;score` is a table
and not one column; `.tsv` is always tab. A diff samples the modified side first and falls back to the
original, so both sides parse with one delimiter. The view keeps the header fixed and virtualizes data rows with
`react-virtuoso`. A selected cell or shift-extended rectangle emits the selected rows' raw-file
`lineRange` plus `structural { scheme: "table-cell", ref: "<row>:<column>" }`, with header row zero; a
missing cell, or a coordinate whose row no longer intersects the host-reanchored line range, is omitted
from actual placement rather than guessed. The unified diff aligns complete raw-row keys with
`diffArrays`, pairs equal-length remove/add runs as changed rows, and highlights only differing cells;
unmatched rows use success/error subtle surfaces. Diff selections use modified source lines except removed
rows, which remain in the base anchor space.

`thinkrail/json` matches `*.json` and `*.jsonc` only. Its scanner is **JSONC-tolerant by design** —
`tsconfig.json`, `.vscode/*.json` and most editor settings files carry comments and trailing commas,
and a tree that refused them would send exactly those files to Source — but it is honest about it:
the document records the `dialect` it needed, and a `.json` file that only parsed as JSONC shows a
`json-dialect` notice above the tree (a `.jsonc` file does not, because there it is the point); a
file that is not even JSONC renders an explicit `json-invalid` notice pointing to Source instead of a
blank pane, in both the view and the diff. The scanner builds the parsed value and an RFC-6901
pointer-to-source-line index in one pass; duplicate object keys resolve to the last occurrence,
matching JSON value semantics. Selecting a non-root node emits
its mandatory `lineRange` plus `structural { scheme: "json-pointer", ref }`; a pointer absent after an edit,
or one now naming a node outside the host-reanchored line range, is reported unplaced. The collapsible
unified diff comes from a `jsondiffpatch` instance with move detection
and stable object hashes, tinting added/removed/changed/moved nodes and showing primitive replacements as
old → new. Removed nodes and comments stay on `review.base` with base scanner lines; all other selections
use the modified document and `review.worktree`. Invalid source renders no tree, leaving Source as the
alternate candidate.

`thinkrail/notebook` accepts nbformat-4 JSON and reuses the tolerant positional JSON scanner to bind every
rendered cell to its raw cell-object line range. Nbformat 4.5 ids are the `ipynb-cell` structural ref;
older notebooks use `index:<zero-based>`. Markdown cells use the shared Markdown parser without raw HTML.
Its notebook component map (`notebookMarkdownComponents(resource)`, built per notebook because image
resolution is relative to the notebook's own path, as in Jupyter) permits base64 PNG/JPEG/GIF/WebP/AVIF
images in the app document, routes SVG data images through the empty-sandbox `NotebookFrame`, loads
**relative** images from the host `/files` route through the same injected byte-URL composer the
markdown preview uses (a traversal above the worktree is inert text, never a request), and renders
links plus every remote image URL as inert text — a notebook's `![plot](figures/x.png)` is repository
content, a third-party URL is not. Notebook language metadata must resolve through the shared language catalog; missing
metadata defaults to Python and unknown values render as plain text. ANSI is removed from stream and error
output. MIME bundles choose image (PNG, JPEG, GIF, SVG), HTML, JSON, then plain text. SVG output stays a
data image inside the inert frame document.
HTML output uses the same sanitized empty-capability document as the HTML renderer. Cell review emits both
the raw line range and structural ref, keeps cards below the resolved cell, reports only actual placements,
and hash-stamps an open composer. Diffs align ids first and exact normalized source second. Remaining runs
are aligned in order by bounded line-token similarity; no character-level all-pairs diff is used. Changed
source uses one provider-backed unified Pierre cell diff, image output reuses visual comparison modes, text
output uses Pierre, and HTML/JSON output stays side-by-side. Original cell selectors remain in `review.base`;
neither side is translated.

`thinkrail/pdf` matches byte PDFs and lazy-loads both pdf.js and its Vite-emitted worker. Placement is not
reported until page-count metadata is known. A page-region thread is placeable exactly when its one-based
page exists, independent of whether that page currently owns a canvas. A focused page is forced into the
render window and focus is consumed only after its region card mounts. The render window is the visible
pages plus two pages on each side. Work leaving it is cancelled; canvases and bitmaps are released, and
diff object URLs are revoked. Composer identity uses document identity plus page, never zoom. The toolbar's
current page is the first visible page (the navigation target until any page reports visibility), so it
follows scrolling as well as navigation; that page and the zoom are written to tab view state when the
view unmounts, like the other scroll-restoring renderers. PDF diffs use one synchronized page sequence: each page pair
starts in 2-up and can switch among the shared swipe, onion, and difference modes, with an absent side
represented by an explicit empty page frame.

`thinkrail/html` parses source into a document before previewing it in an empty-capability `sandbox=""`
iframe. The sanitizer removes active, navigational, embedding, and form elements; strips event handlers,
`srcset`/`imagesrcset`, `autofocus` and non-`data:` resource URLs; and turns anchors into inert text-bearing
elements.
`template` is removed whole: its content is not in `children`, so the walk never reaches it, and the frame
would attach a `shadowrootmode` template as live DOM. SVG `set` and `animate` are removed only when their
`attributeName` contains `href` (they can give an inert link a target); other animations stay. `noscript`
stays: the static and themed frames run no script, so the parser and the frame read it the same way.
Styles remain. Notebook HTML output uses this same sanitizer. The scripted frame (below) does not use it.

The frame parses the serialized output again, and a second parse can read it differently. Under a
foster-parented `mglyph` a `style` is an HTML raw-text element in the first parse, so the sanitizer sees
only text, and a MathML element in the second, where that text becomes live elements (`link`, `img
srcset`, `meta` refresh, `iframe`, handlers). So `buildHtmlPreviewDocument` and `buildThemedHtmlDocument`
check the exact string the frame gets: they parse it, detach the CSP `meta` they wrote (it must be the
head's second child) and run the sanitizer over it. If that pass removes anything, the output is the
policy-only document. It is one check, not a loop of sanitize and serialize: a nested vector is clean after
one pass and live again after two, and the frame parses once. This matters most in Firefox, which does not
apply the `meta` CSP `img-src` to `srcset` and `imagesrcset` loads (a `link rel=preload imagesrcset` loads
in a plain page with the same policy), so there the sanitizer is the only barrier against those requests:
before the check a crafted mockup made real requests in Firefox 151, same-origin ones with the origin's
cookies in the themed frame. e2e runs no Firefox, so `e2e/visualize-mockups.spec.ts` pins the `mglyph`
vector by the loaded frame's DOM in Chromium and WebKit.

Author markup can shadow DOM properties by name: `<img name="head">` replaces `document.head` in WebKit, and
a control named `localName` replaces that property on its form. So `htmlDocument.ts` reads the root and head
and creates elements through `Document.prototype`, treats an element whose `localName` is not a string as a
form (removed), and removes a child through its parent. After the policy is installed it checks that the
root is `html`, the head is its child and the CSP `meta` is in the head; otherwise the output is an empty
document that holds only the charset and the CSP. Unit tests install a fake `Document` class, so they run
the same prototype reads and pin each part of that check; the browsers' own shadowing by name is covered in
a real browser by `e2e/visualize-mockups.spec.ts`. The injected CSP is exactly `default-src 'none'; img-src data: blob:;
style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src
'none'; child-src 'none'`. The diff is the shared visual frame constrained to 2-up sandboxed documents only.
It advertises no anchor geometry, so HTML threads remain in the pane-owned unplaced strip and Source is the
only authoring candidate. View and diff share a **preview width** switch in the notice bar — Desktop 1280 /
Tablet 768 / Phone 390 / Fill, default Desktop (Fill for a fitted chat card, below), persisted as `{ viewport }` view state and adopted whenever the
caller's view state changes (`useHtmlViewport`, so a chat card follows a width chosen in its full screen): the frame renders at
the design width and is CSS-scaled down to its box (never up), keeping its own vertical scroll, so a narrow
pane, a 2-up half or a chat card shows the true layout shrunk rather than an accidental mobile reflow; Fill
is the old reflow. Scaling is pure geometry on the wrapper — a static iframe keeps `sandbox=""` and nothing
measures its document; the wrapper's box is measured in a layout effect (the package's
one `useElementSize`, shared with the SVG view and the region surfaces), so the first paint is already fitted
instead of reflowing the document at the pane width for a frame. A static document has no form controls
(`button`, `input`, `select`, `textarea` are removed); spot (region) comments on HTML are not offered yet.

**Themed frame.** When the host's `html.mode(workspaceId, path)` answers `themed`, the view and each diff
side render the sanitized document, with the same CSP, in `sandbox="allow-same-origin"`, in every
surface: a chat card, its full screen, a file tab, a comparison. The themed sanitizer differs from the
static one in one rule: it keeps `button`, `input`, `select` and `textarea`, so a mockup shows its real
controls. They do nothing: no script runs, handlers and `formaction` are stripped, and `form` is still
removed with everything in it (the shadowing defence above treats any element it cannot name as a form, and
without `allow-forms` nothing could submit anyway). The check of the string the frame gets runs the themed
rule too, so a kept control is not a difference. ThinkRail answers `themed` for a path under
the agent's mockup scratch dir (`isMockupPath`: canonical only, so `mockups/../index.html` stays static),
`scripted` instead when the agent showed that mockup and the app runs in a browser, and `static` everywhere
else ([[module-web]] owns the rule).

No script from the file and none from ThinkRail runs in a static or themed frame. That is what makes
`allow-same-origin` safe: the token only lets the app page reach the frame's `contentDocument`; without
`allow-scripts` the document cannot run code to use the shared origin, whatever markup survives the
sanitizer. A script that a native webview injects into every frame is outside this guarantee, in the
static frame as well: WKWebView runs a user script added with `forMainFrameOnly: false` inside a frame
that has no `allow-scripts`, and Electrobun 2.0.5 adds its preload that way on macOS. Removing
`electrobun-*` elements in the sanitizer and a desktop probe that fails when a preview frame sends a bridge
message are open work. The macOS desktop app (WKWebView,
Electrobun 2.0.5) was run for the themed frame: theme, theme switches without a reload, `@layer`, card
heights and page zoom from 100 % to 150 % match the browser, and Electrobun's preload globals are present
inside the frame, where no script can read them. WebView2 and WebKitGTK were not run: their space-taking
scrollbars and `@layer` in the oldest WebKitGTK the app supports are open. The barrier is the
`sandbox` attribute on the app's own `iframe` element, which author HTML cannot touch, where a script
policy written inside the document could be removed by the document. **Invariant: a preview frame never
gets `allow-scripts` together with `allow-same-origin`,** and the themed frame never gets `allow-scripts`
at all; `HtmlFrame`'s `sandbox` prop admits exactly `""`, `"allow-same-origin"` and `"allow-scripts"`, one
token at most, and unit tests pin the rendered attribute of each mode. The app page's `frame-src 'none'` ([[module-web]]) stops the frame from
loading any network or same-origin URL, so it cannot reach a page that lacks this document's CSP.
`about:blank` still loads; the parent leaves that blank document alone (below).

`ThemedHtmlFrame` does two things through `contentDocument`, both from the app page:

- **Theme.** `hostTheme.ts` collects the custom-property names declared on `:root` rules of the page's
  stylesheets (recursing into `@layer`/`@media` groups, skipping cross-origin sheets) and on the root's
  inline style, then resolves each through `getComputedStyle`. It does not enumerate computed styles:
  WebKit does not list custom properties there. The result is one cascade layer,
  `@layer thinkrail-theme { :root { color-scheme; --…: value } html { … } }`: the token rule, then a base
  (workspace background, default text colour, interface family and size). `buildThemedHtmlDocument` puts it
  in a `<style data-thinkrail-theme>` right after the CSP `meta`, before all author content, so the layer
  is the first one declared and any author declaration wins, layered or not: a variable set on `html` or
  `:root` (`--accent`, `--border`…) and every element style. Unlayered zero-specificity `:where()` rules
  were rejected: they beat every author rule written inside an `@layer`. Every themed document gets the base,
  also one written without the tokens, so a mockup that sets a background and no text colour, or text
  colours and no background, can be unreadable when the app theme does not match its own colours, and its
  `rem` sizes follow the 13 px base instead of the browser's 16 px. A declaration that contains `<` is dropped, because a style
  element's text is serialized unescaped and `</style>` would end it. A relative
  `<link href="thinkrail-theme.css">` is removed like every `link`, so in the app the live tokens replace
  that file. The snapshot is an external store (`useSyncExternalStore`) refreshed on `onThemeSwap` and
  `onFontsChange`. The `srcdoc` is rebuilt only when the source changes; on a theme or font change the
  parent rewrites that style element's text, so the frame does not reload and keeps its state (an opened
  `details`, a scroll position). Colours and font sizes follow live. The bundled font faces do not load in
  the frame (`font-src data:`), so text uses the next family of the stack that the OS has.
- **Height.** A view offered `onNaturalHeight` (the chat card's `fitContent`) observes the frame's root
  element with a `ResizeObserver` created in the app page. A document's height can depend on the frame's
  height (`100vh`, `height: 100%` on `html`/`body`, a `@media (height)` query), and the frame's height
  comes from the reading, so a reading taken at the applied height can feed itself: the card grows to the
  limit or flips between two heights on every frame. `ThemedHtmlFrame` therefore never reads at the applied
  height. On each notification it sets the `iframe` element's inline height, reads the root at two fixed
  heights (`HEIGHT_PROBE`: 8192 px and 100 px more, above the 1600 px limit, so a document shorter than
  the probe has no vertical scrollbar that narrows its layout there) and once more at the height it just
  read, then removes the inline height and restores the root's scroll offset (a tall probe resets it), all
  in one task, so nothing is painted in between. The restore is an instant `scrollTo`: the `scrollTop`
  setter follows the document's `scroll-behavior`, and a `smooth` document would animate back from the top
  on every reading. `frameIndependentHeight` (`heightFollow.ts`) is the pure rule over the three readings
  (a loop over `heightProbeStep`, which the scripted frame steps through one message at a time):
  - A reading is the root's `getBoundingClientRect().height` plus `frame.clientHeight -
    root.clientHeight`, the height of a space-taking horizontal scrollbar, so a mockup wider than the card
    keeps its last rows (pinned in WebKit with styled scrollbars; Windows and Linux were not run).
  - Readings within 1 px of each other are the same height and the largest is kept. The two terms are
    rounded in different documents, so at a fractional layout scale (browser zoom on a 1x screen, a 125 %
    display) the third reading is often 1 px more with no scrollbar present; exact equality lost fitting
    for about half of plain mockups at 90 % zoom. Anything further apart means the document is sized from
    the frame (at 67 % zoom about one in ten wide mockups with a styled scrollbar still reads that way). Reading at the applied height and stopping on a repeated value was rejected: a `details`
    that opens and closes repeats a value too.
  - The root's vertical overflow is `hidden` (inline, `!important`) during the readings, and stays hidden
    while the card holds the whole document (a content height up to the 1600 px limit). WebKit styles a
    frame's scrollbars from the app page, whose `::-webkit-scrollbar` is 6 px wide and takes space; when
    the frame shrinks to a text mockup's height, WebKit adds that scrollbar if the narrower layout would
    overflow too, and keeps it, so the text wraps, the third reading is taller and the card fell back to
    480 px at about half of all widths (Safari and the macOS desktop app; Chromium draws no scrollbar
    there). A capped or frame-sized document keeps its own scrolling. Extra height was rejected: WebKit
    keeps the scrollbar until the frame is as tall as the wrapped layout.
  - The third reading also takes the root's `scrollHeight`, so absolutely positioned content that reaches
    below the in-flow content counts. Only that reading can: at a probe height `scrollHeight` is the frame
    height. A `position: fixed` layer adds to neither number, so a mockup that is only a fixed dialog still
    gets the 120 px minimum; the agent guideline asks for normal flow or a pixel `min-height` on `body`.
    The readings are taken only when the root's box changes, so absolutely positioned content that appears
    after load (a panel that a `details` or `:hover` opens) changes no box and is not measured: it is cut
    at the card's edge and scrolls inside the frame (a 380 px panel in a 120 px card, Chromium, WebKit and
    Firefox). The guideline names this case too. A capture `toggle` listener that the parent adds on the
    frame document was rejected: it fires in Chromium and Firefox and not in WebKit, and a `:hover` panel
    sends no event.
    Treating a height under the minimum as no height was rejected: a `null` reading ends following, so a
    short mockup with a `details` would stop growing.
  - A height at or above the probe height is accepted from the two probe readings alone. Such a document
    has a vertical scrollbar at both probe heights and none at its own height, so with space-taking
    scrollbars its text wraps wider in a third reading and never matches; the box clamps at 1600 px anyway.

  `followHeight` (`heightFollow.ts`) is the pure rule over the
  heights: a frame-sized reading gives the height up and ends following until the next `load`; a height
  that changes for more than 2 s with no 250 ms pause and no width change (an endless CSS animation) ends
  following at the tallest value of that run; a new `load` keeps the last height until the new document
  is measured. WebKit notifies the old root's observer after the new `load`, with the probe heights as its
  size, which reads as a frame-sized document; a notification for a root that is no longer the frame's
  root is ignored. A height that changes with longer pauses is followed for as long as it changes. The view
  fits only while it holds a height: it sizes the frame to it, clamps the *rendered* box (after
  design-width scaling) to `HTML_CONTENT_HEIGHT` (120–1600 px on screen), drops its padding and calls
  `onNaturalHeight(true)`. Without one (not measured yet, or sized from the frame) it keeps the caller's
  bounded box and calls `onNaturalHeight(false)`; the agent guideline asks for content-sized documents. A
  card offered fitting with no stored width defaults to Fill, so the mockup draws at the card's own width
  and text size instead of a 1280 px layout shrunk to about half; a width the user picks still applies. A
  document whose scaled height passes 1600 px scrolls inside the frame. Tabs, full screen, palette and
  question previews keep filling their container and measure nothing.

The parent attaches on each frame `load` and only to a document that carries the theme style. That check
decides one case: a frame that left for `about:blank`, which `frame-src 'none'` does not block and author
HTML reaches only through a sanitizer hole. The parent stays off the blank document, so the card keeps
its height (WebKit still notifies the old root's observer; that root is no longer the frame's root, so the
notification is ignored). The initial blank document (no `load` yet) and a frame Chromium
replaced with its error page (`contentDocument` is `null`) are stopped before that check. It reads the frame's root with the `Document.prototype` getter, because `<img
name="documentElement">` shadows the property there too, and then uses `Element` members only. It reads
numbers, writes one style text and restores one scroll offset; it never moves a frame node into the app
document.

Each diff side takes the mode of its own path. A diff offered `onNaturalHeight` fits when every present
side is themed or scripted: both frames take the taller measured height, `VisualDiff`'s `fitContent` drops
its viewport-bounded side boxes, and it calls `onNaturalHeight(true)` while each present side holds a
height. A diff with a static side or a frame-sized side keeps the bounded box.

**Scripted frame.** When the host answers `scripted`, the view and each diff side render
`ScriptedHtmlFrame`: `<iframe sandbox="allow-scripts" srcdoc>` with no other token. Fit, preview width and
the height clamp work as in the themed frame, and the theme is the same text: the one cascade layer
`hostTheme.ts` builds, in the prefix and in every live update, so any author declaration wins here too.
Each mode is its own component, so a mode change mounts a new
`iframe` element; a `sandbox` change on a live element would not reach the loaded document. The notice bar
says that scripts run (`viewer.html.scriptedNotice`).

*Document* (`scriptedDocument.ts`). The `srcdoc` is a fixed host prefix followed by the author source, byte
for byte. This mode neither parses nor sanitizes: a script re-creates anything a sanitizer removes, and the
sanitizer above would remove the CDN `src` and `href` values this mode exists for. The prefix is, in order:
doctype, `<html><head>`, charset `meta`, `<meta name="referrer" content="no-referrer">`, the CSP `meta`,
`<style data-thinkrail-theme>` with the current theme, the bootstrap `script`, `</head>`. A theme text that
contains `<` becomes an empty theme. All author markup is parsed after the policy and the bootstrap.
Measured in both engines: an author CSP `meta` only adds restrictions, `base` is refused by `base-uri
'none'`, a second `<html>` tag merges its attributes into the first, and the document stays in standards
mode. The policy also holds in every document a mockup can put in the frame without a URL: one it writes
over itself with `document.open()` or, in WebKit, a `javascript:` URL, and a nested `srcdoc` frame (fetch,
WebSocket, `eval` and an app-origin image stayed blocked in each). Nested `blob:` and `data:` frames do not
load.

The CSP is exactly `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' <cdn>; style-src
'unsafe-inline' <cdn>; img-src data: blob: <cdn>; font-src data: <cdn>; connect-src 'none'; worker-src
'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'`. `<cdn>` is
[[module-contracts]]' `MOCKUP_CDN_SOURCES`, today `https://cdn.jsdelivr.net/npm/ https://unpkg.com
https://cdnjs.cloudflare.com/ajax/libs/`. The CSP, the agent guideline and the tests read that one constant;
an empty list removes every external load.

*Bootstrap* (`FRAME_BOOTSTRAP` in `frameMessages.ts`). A constant string with no per-frame data. It runs
first, in strict mode. Its first statement redefines `name` on the window as a non-configurable accessor
that reads empty and ignores writes, because WebKit makes a named child frame a global of the app page
(*Known limits*). Then it copies every global it will ever use into locals before author code exists: the
parent window and its bound `postMessage`, `addEventListener`, `dispatchEvent`, `Event`, `ResizeObserver`,
`Math.ceil` and `Math.max`, the getter of the window's `innerHeight` (a plain assignment replaces that
property), the root element with its bound `getBoundingClientRect` and `scrollTo`, and the theme style
element. Then it removes its own `script` element. A mockup that declares `const parent = 1` or overwrites
window properties does not break it. It reads the root's `clientHeight`, `scrollHeight` and `scrollTop`
through the element, so a mockup that redefines those on `Element.prototype` breaks only its own card
height. It does four things, and decides nothing:

- **Theme.** On a parent message `{ type: "thinkrail:theme", css, seq? }` it sets the theme text. With a
  `seq` it keeps the number, answers `{ type: "thinkrail:ready", seq }` and sends a reading. When the text
  changed it dispatches `thinkrail:themechange` (`MOCKUP_THEME_CHANGE_EVENT`) on the window, so a canvas
  chart can redraw. It takes a message only when `event.source` is the captured parent.
- **Readings.** Once it has a number it posts `{ type: "thinkrail:height", seq, viewport, flow, extent,
  scroll }` from a `ResizeObserver` on the root and from the window's `resize` and `scroll` events, once
  per change of the last four values. `viewport` is the frame's `innerHeight`. `flow` and `extent` are the
  two numbers of a themed reading: the root's rounded-up height and its `scrollHeight`, each plus
  `innerHeight - clientHeight`, the height of a space-taking horizontal scrollbar. `scroll` is the root's
  `scrollTop`.
- **Scroll offset.** On `{ type: "thinkrail:scroll", top }` it scrolls the root there with
  `behavior: "instant"`. When the frame is still too tall for that offset it does so again on the next
  `resize`.
- **Link clicks.** A capture-phase `click` listener on the window calls `preventDefault()` when the event
  path holds an `a` or `area` with `href` or `xlink:href`; the author's own handler still runs. In a
  `srcdoc` frame `href="#x"` and `href=""` resolve against the app URL, so an ordinary link click is a
  navigation, and Chromium swaps the mockup for an error page. This is for accidents only: a link in a
  closed shadow tree or a navigation from script passes it. The hard block is the app page's
  `frame-src 'none'`.

*Parent* (`ScriptedHtmlFrame`, `frameWatch.ts`). It builds the `srcdoc` once per source. On every `load` of
the iframe it takes the next sequence number, posts the theme with it and starts the ready timer (*Dead
document*). On a theme or font change it posts the theme with no number: the frame does not reload and
script state survives. A message is read only when `event.source` is this frame's `contentWindow`, it
carries the current number and its shape is known (`acceptFrameMessage`). `ready` clears the timer. A
`height` report must hold four finite numbers that are not negative. Frame messages are untrusted input:
author code runs in the same window as the bootstrap, sees the number and can send any of them, so there
is no nonce (it would protect nothing) and nothing else is read from a message. A forged report can give
its own card a wrong height inside the 120–1600 px clamp and make its own frame up to 8292 px tall under
the card's clip. `followHeight` treats forged heights like any others: it stops following only a height
that changes for more than 2 s with no 250 ms pause (*Known limits*).

*Message limit* (`createFrameWatch`, `frameSender`). The parent counts the messages of each mockup, of any
shape, in windows of 1 s. `frameSender` decides whose a message is: it follows `event.source` and its
`parent` chain, which is readable across origins, for at most 8 windows. A sender that is the frame's
window or sits in a frame below it (a nested `srcdoc` frame) counts for that mockup. A chain that reaches
the top window without it belongs to another frame and is not counted. A message with origin `"null"`
whose sender cannot be traced counts for every mounted scripted mockup: once the sender's frame is removed
WebKit gives a null `source` and Chromium a window with a null `parent`, and no other frame in the app
runs script. A `load` does not start a new window, so a reload does not reset the count; a mockup that
only reloads in a loop closes too (about 500 loads in one second, Chromium).

Message 1001 of a window (`FRAME_WATCH.messages`) closes the mockup with the *Dead document* notice, and
the watch ignores every later message of that frame until the next `load`. The parent removes the frame
inside that message's task (`flushSync`). A state update that waits for the next render waits behind the
queued messages while the mockup posts more: at 300000 messages per timer tick Chromium then closed it
after 2.1 s and 600000 messages, and WebKit's app page did not answer for 50 s. With the frame removed at
once, one batch arrives and no more (20000 or 300000 per tick, both engines). The rest of that batch
arrives with no sender, so for 2 s after a close (`FRAME_WATCH.tailMs`) untraced messages are not counted;
they would close the mockups next to it. 299000 queued messages took 0.75 s.

Without the limit a mockup that posted 20000 messages per timer tick, from its own window or from a nested
frame, cut the app page from about 120 animation frames per 2 s to 21–28 in both engines. The limit sits
between two measured points. The bootstrap sends one report per `scroll` or `resize` event at most, about
240 per second on a 120 Hz display, so an honest mockup stays under it. 100 small messages per 16 ms, six
times the limit, did not slow the app page yet, so a mockup that floods with small messages closes before
the app slows. The limit counts messages, not bytes. *Known limits* says what the limit does not stop.

*Height* (`scriptedHeight.ts`). The frame's origin is opaque, so the parent cannot read the root as
`ThemedHtmlFrame` does, and a reading that the frame takes at the applied height feeds itself in the same
way. So the parent applies the themed frame's rules to the frame's readings. `heightProbeStep` is the one
rule over the three readings: `frameIndependentHeight` loops over it in one task (themed), and
`advanceHeightProbe` takes one reading per message (scripted). A view offered `onNaturalHeight` starts a
run of readings on a report that differs from the report that started the last run (`viewport`, `flow` or
`extent`; the report that follows a run is the same one, so a run does not start itself again). The parent
sets the `iframe` element's inline height to the first probe height and waits for a report whose
`viewport` is that height within 1 px, then does the same for the second probe height and for the height
it read. Then it sends back the scroll offset the frame reported before the run, removes the inline height
and gives the verdict to `followHeight` with the element's `clientWidth`. The reducer is unchanged, so a
frame-sized document keeps the caller's bounded box until the next `load`, a height that changes for more
than 2 s without a pause stays at its tallest value, and a `load` keeps the last height until the new
document is measured. A frame mounted while the view already holds a height (a themed frame that became
scripted) starts from that height and reports only a different verdict.

The readings are one message apart, not one task, and that is where this frame differs from the themed
one:

- Content can change between two readings, which reads like a frame-sized document. A frame-sized verdict
  counts only when one more reading at the first probe height equals the first reading. Otherwise the
  content moved, and the run starts over from that reading. Content that does not hold still for one run
  in 2 s (`HEIGHT_RUN.maxMs`: a height animated in every frame) gets no height and keeps the bounded box,
  where the themed frame keeps the tallest value. Content that changes in steps slower than a run is
  followed. `followHeight` stops it only when the steps come less than 250 ms apart for 2 s; slower steps
  are followed for as long as they come (*Known limits*).
- A run is painted. Measured for a content-sized document: 2 rendering frames at the probe heights in
  Chromium 149, at most 1 in WebKit 26.5; a frame-sized document takes one more, once per `load`. For those
  frames the document is laid out about 8192 px tall under the card's clip. A content-sized document looks
  the same there. A frame-sized layout and a `position: fixed` element anchored to the bottom are out of
  place for those frames, and the mockup's window gets `resize` events.
- The tall frame resets the scroll offset, and the frame gets it back after the run, so a scrolled mockup
  taller than the card shows its top for those frames.
- Readings start after the `load` handshake, because a report counts only with the current number. That is
  also how a reading from a replaced document is ignored: after a reload the old document's number is
  behind, and the new document sends nothing before it has its own. A mockup whose `load` waits for a slow
  CDN file keeps the bounded box, or the height `ResourcePreview` holds, until then.
- A report also follows a `scroll` or `resize` event in the frame, and it carries `extent`. So absolutely
  positioned content that appeared after load is measured at the next such event, where the themed frame
  waits for a change of the root's box.
- A frame that sends no report at the asked height within 1000 ms (a busy script, a busy app thread, a
  hidden tab, a document that dropped the bootstrap's listeners with `document.open()`) gets its own height
  back and keeps the height it had. No report follows by itself: the bootstrap reports only a change, and
  a frame that was never laid out at the probe height has the size it had before (WebKit: after one 2.5 s
  task of the app page a 900 px mockup stayed in the bounded box). So the parent asks: it posts the theme
  with the current number again, the bootstrap answers with a fresh report, and that report starts a new
  run. It asks after at most 3 unanswered runs in a row (a finished run or a `load` resets the count), and
  once more when the tab becomes visible again (`visibilitychange`) while the last run is still unanswered.

*Dead document.* The ready timer has two steps: 2000 ms after the `load`, then 250 ms more
(`FRAME_WATCH`), and `ready` clears either. When the second step fires, no live bootstrap answered the
last `load`. One step is not enough, because it also counts time in which the parent had no turn to read
the answer: after one 2.5 s task of the app page (Chromium), or the 2.3 s start of a neighbour mockup
(WebKit), the late timer ran 0–3 ms before the queued `ready` and closed a healthy mockup. The frame is
unmounted and a notice (`viewer.html.mockupStopped`) takes its place until the source changes or the view
mounts again (a card that scrolls back into the chat, full screen, Open in tab): the closed state lives in
the component, so each mount starts the mockup once more (*Known limits*). The same
notice closes a mockup that floods the parent (*Message limit*). A removed frame that held the keyboard
focus leaves it on `body`, and the next Tab then starts at the top of the page (full Chromium) or after the
card (headless shell, WebKit). So a close reads `document.activeElement` first: when it is the frame, the
notice mounts with `tabIndex={-1}` and takes the focus with `preventScroll`, and a notice for a frame that
did not hold the focus takes none. The parent asks "does
the document answer", not "did a navigation happen", because the navigation signals are wrong in both
directions (measured): `location.reload()` and, in WebKit, a fragment change fire a second `load` on a
live document; a navigation before the first `load` ends gives Chromium one `load`, on an error page;
`about:blank` violates no `frame-src`; the parent's `securitypolicyviolation` names no frame; and in WebKit
a blocked navigation leaves the mockup running, so closing it there would kill a working mockup. The
handshake catches Chromium's error page (early and late), a blanked frame, and a document replaced with
`document.open()` (that drops the bootstrap's listeners). Where the browser runs the frame in its own
process (full Chromium), it also closes a mockup whose script blocks the frame from before the answer
until the second step fires (a loop that a timer starts right after `load`: closed after 2.3 s). Where the
frame shares the app page's thread (Chromium headless shell, WebKit) no timer fires while that script
runs, so the mockup stays open and the app page waits as long (*Known limits*). It does not see a frame
that hangs before its first `load` or after it answered.

**What a scripted frame enforces, and by what.** Each line is one mechanism in the code; nothing else is
claimed.

- No access to the app's DOM, storage or cookies: the sandbox has no `allow-same-origin`, so the document
  has an opaque origin.
- No popup, no assignment to the top window's location, no modal dialog, no form submission: the sandbox
  has none of those tokens (and the CSP says `form-action 'none'`).
- The frame loads no network or app-origin URL: the app page's `frame-src 'none'` ([[module-web]]) for the
  frame itself, the frame's own `frame-src 'none'` for frames inside it. `about:blank` still loads; it is
  an empty document, and the handshake closes it (*Dead document*). This is about what a frame shows: full
  Chromium still sends a GET for a `<link rel="prerender">` and shows nothing of it (*Known limits*).
- No fetch, XHR, WebSocket, EventSource, beacon or worker, and no `eval` or `new Function`: the frame CSP
  (`connect-src 'none'`, `worker-src 'none'`, no `'unsafe-eval'`). WebAssembly therefore runs only from
  inline bytes.
- Scripts and styles load only inline or from the CDN prefixes; images only from `data:`, `blob:` or the
  CDN prefixes; fonts only from `data:` or the CDN prefixes: the frame CSP.
- Microphone, camera, screen capture, geolocation and clipboard read are denied: browser rules for a
  cross-origin frame (the iframe has no `allow` attribute).
- Scripts run only for a mockup path the agent showed, never in the desktop shell, never in the search
  palette and never for a git revision: the host's mode answer and the palette host's own `html.mode`
  ([[module-web]]), and the `scope` rule in `useHtmlMode`.

`eval` is off as the smaller default, not as a boundary: a script element built from a string runs under
`'unsafe-inline'`. Libraries that need `eval` (Vue in-DOM templates, the default Alpine build, Vega) do not
work.

**Known limits of a scripted frame.** Measured in Chromium 149 and Playwright WebKit 26.5.

- WebRTC is not blocked: a script opens a connection to any host through an `RTCPeerConnection`
  (`webrtc 'block'` in the CSP had no effect), and WebKit opens a connection for
  `<link rel="preconnect">`. A mockup can send and receive data. The CDN list limits where sub-resources
  load from; it does not stop a hostile mockup from sending its own content out, for example in a CDN URL.
- Full Chromium and Chrome send a GET for `<link rel="prerender">` (headless Chromium 149.0.7827.55 and
  Chrome 155.0.8059.85; Chromium headless shell and Playwright WebKit sent nothing, so the e2e projects do
  not see it). The link can be static markup, added by script, or in a nested `srcdoc` frame, and its URL
  can be any origin: the app host, another localhost port, any other site. The request carries the target
  site's cookies, and Chromium then loads that page's stylesheet, script and image files. The page's
  script does not run and the mockup cannot read the response, but it can put data in the URL
  (`document.baseURI` arrived in a query). The frame CSP has `default-src 'none'`, and adding
  `prefetch-src 'none'`, `navigate-to 'none'` or `child-src 'none'` to it did not stop the request. A
  guard in the bootstrap would not either: static markup starts the request when it is parsed, and a
  nested frame has no bootstrap. The host is reached by GET only, and its GET routes only read; a host
  GET route with a side effect would be open to any mockup. The host does not refuse a request with
  `Sec-Purpose: prefetch`.
- A mockup can read the app page URL (`document.baseURI`: origin, query, route ids). The referrer `meta`
  keeps it out of CDN requests only while the mockup declares no referrer policy of its own: with an
  author `<meta name="referrer" content="unsafe-url">` WebKit sent the full app URL, path and query, to
  jsDelivr and unpkg (Chromium sent none). A credential in the page URL would be readable.
- A mockup adds entries to the tab's session history with `history.pushState` and with a fragment change
  (`location.hash`), in both engines, with no user action and also from a nested `srcdoc` frame (so a
  guard in the bootstrap would not close it). Back then steps through the mockup's entries while the app
  page does not move, and Chromium drops the app's older entries at its limit of 50. The agent guideline
  forbids both calls. Not verified: whether the Back button of a real browser skips entries added with no
  user action.
- WebKit: `history.back()` and `history.go()` in the frame move the app page through its history. No
  sandbox token or CSP stops that.
- A mockup can take keyboard focus with no user action and then reads what the user types next (Chromium
  149 and Playwright WebKit 26.5; real Safari not run). `inert` on the iframe did not stop it in Chromium.
  It can also keep the focus: with a `keydown` handler that cancels Tab the app page's `activeElement`
  stayed on the iframe for six presses in both engines (a plain mockup lets Tab leave), and the parent
  sees no key pressed in the frame. The agent guideline allows `focus()` only in a handler of a user
  action and forbids cancelling Tab.
- Chromium: a mounted mockup that is scrolled out of view moves the chat transcript to itself with
  `scrollIntoView()` or `focus()` from a timer, with no user action, and does so again after the user
  scrolls away (in the app: scroll offset 993 → 226, and 226 again 1.5 s after a scroll back to the end;
  with `blur(); focus()` 993 → 89). WebKit did not move. A card the list has unmounted moves nothing. No
  block was found; the agent guideline forbids both calls.
- A busy loop freezes the app tab for its whole length wherever the browser runs the frame on the app
  page's thread. In the app under Playwright a 5 s loop gave the app page one 5.0 s gap between two timers
  and between two animation frames (Chromium headless shell and WebKit). Full Chromium ran the frame in
  its own process and showed no gap (big messages still stop the app page there: next line). The card
  mounts again with the chat, so it repeats on reload.
- A message flood still costs the app page work. The limit removes the mockup at message 1001 of a
  second, but messages already queued still arrive, one task each, and a tight `postMessage` loop stalls
  the app page until the parent gets a turn to count (a 4 s loop of 2 M messages gave the app page a 4 s
  gap between two frames, and the queue took 5 s more in Chromium and 10 s or more in WebKit). A flood
  slower than the limit is not stopped, and the limit counts messages, not bytes: in full Chromium 8
  messages of 32 MB every 50 ms (160 per second) left the app page with no answer for more than 90 s
  while the mockup stayed open (1 MB messages at that rate: the page answered in 1–7 ms). The parent
  cannot prevent that, because the browser copies the payload before a handler runs. A closed mockup runs
  again when its view mounts again (a card that scrolls back into the chat, full screen, Open in tab), so
  each mount costs one more batch, or 2.25 s for a dead document. A flood whose sender cannot be traced
  closes every mounted
  scripted mockup, also the ones that sent nothing. A tight loop does that too when its queue outlasts the
  2 s in which untraced messages are not counted: after a 1 s loop the queue arrived for 1.3 s in Chromium
  (the mockup next to it stayed open) and 2.1 s in WebKit (it closed), after a 4 s loop it closed in both.
  In full Chromium a mockup that posted in a tight loop was closed at once, but its messages kept arriving
  with no sender while another scripted mockup was mounted (about 280000 in 2 s); after the 2 s they
  closed that mockup as well, and then they stopped. For the 2 s after one mockup is closed, an untraced
  flood from a second mockup is not counted.
- WebKit makes a child frame's name a global of the app page. With the bootstrap's lock on `name` removed,
  `window.name = "X"` in a mockup made `X` on the app page the frame's cross-origin window: `Reflect.has`
  for the desktop marker turned true (`Object.hasOwn` stayed false), `typeof process` was `"object"`, and
  app code that read a property of such a global threw `SecurityError`. With the lock, none of assignment,
  `self.name`, the prototype setter, delete then assign, `window.open` and a nested frame's setter defined
  a global (Playwright WebKit; real Safari not run). The lock does not close a document that replaces the
  mockup through a `javascript:` URL (WebKit): that document has no bootstrap, answers `ready` itself and
  named its frame. The desktop gate reads an own property ([[module-web]]), which a frame name is not, so
  it stays off either way. Chromium defined no global.
- After a click inside it, a mockup can write the clipboard. It can capture wheel scrolling over the card.
- A mockup can send the bootstrap's messages itself: it can set its own card's height between 120 and
  1600 px and keep its own frame up to 8292 px tall under the card's clip.
- A mockup can change its card height without end, forged or not, and the chat rows below the card move
  each time. `followHeight` stops only changes that come less than 250 ms apart for 2 s: fed a height
  that alternates every 260 ms or 300 ms it followed for 10 min (2308 and 2000 changes), and in the app a
  timer every 400 ms still moved the card after 21 s. A mockup that reloads itself is not held to that
  pace, because every `load` starts following again: with `location.reload()` 150 ms after each `load`
  the card changed about 6 times per second, and still did after 21 s (Chromium and WebKit). No count cap
  was added: it would also stop a mockup that the user expands many times, and closing only the reload
  route leaves the timer route.
- The CDN operator sees each request. jsDelivr and unpkg serve any npm package, so the list names where
  files load from, not which code is trusted. Whether third-party CDN loads are acceptable at all is an
  open product decision.
- Trust is per path: the content on disk at render time runs, also after a later edit or a branch switch.
- The frame CSP is the only thing between a mockup script and the host WebSocket: the host does not
  refuse a socket with `Origin: null`.
- Not verified: Firefox, real Safari, headed Chrome with a user profile (whether a mockup can raise a
  notification with the app's permission: Playwright Chromium allowed it), real CDN loads, the desktop
  webviews, a hidden tab (Playwright keeps a page visible, so the `visibilitychange` request has a unit
  test only). Full Chrome differs from the headless shell that the e2e projects run: the prerender
  request, the big-message stall and the frame's own process above were seen only in full Chromium, run
  headless by hand, and no e2e case covers them.

Pierre parses the two complete text sides (`absent` → `null`) with the current ignore-whitespace value,
uses the host's `pierreTheme` (registered as `thinkrail`, CSS variables only, highlighted by `@pierre/highlights`), word-level inline changes, collapsed unchanged regions with
line-info hunk separators, and split/unified layout; phone-class viewports force unified and hide the
Split/Inline segments, so no control promises a layout the viewport refuses. The collapse threshold
(`COLLAPSED_CONTEXT_THRESHOLD`, 3 lines) is git's own default hunk context (`-U3`), so what Pierre
keeps visible around a change is what a reviewer already expects from `git diff`, and the same number
feeds `renderedDiffLineNumbers`, which decides whether a thread's end line is on screen or parked in the
unplaced strip — one constant, so the two can never disagree. The focus reveal (`usePierreFocus`)
installs a subtree `MutationObserver` plus a `ResizeObserver` only while a focus request is pending
and disconnects both the moment the card is revealed; it is not a standing listener, so Pierre
re-rendering on every annotation change costs nothing once focus has settled. A diff whose
two sides are identical (a file that left the change set after an out-of-band commit) shows an explicit
`diff-empty` notice above Pierre's surface instead of a blank pane. The lazy Pierre file/diff modules
mount `PierreProvider` only when their surface renders; it hands Pierre's `WorkerPoolContext` the module
singleton (`getOrCreateWorkerPoolSingleton`, four module workers from `@pierre/diffs/worker/worker.js`)
and **never terminates it**: the pool is created the first time any code surface renders and then lives
for the page. Pierre's own provider tears the pool down the moment its last instance unmounts, and the
virtualised review list reaches that moment on every jump or fast scroll into files that have not
loaded yet; each rebuild spawned the workers again, re-fetched the WASM, theme and grammars, dropped
every highlighted AST, and painted nothing until initialised — the stacked view's "loading forever".
Four idle workers are the price of never paying that again; the list mounts a handful of sections at a
time, so four keep up. The pool's highlight cache is keyed by the diff's `cacheKey`, which Pierre derives
only when both sides carry one; `PierreDiff` keys a one-sided (added or deleted) diff itself from its
present side's hash, so a remount — a Stacked/One-file switch, or a section scrolling back in — paints
highlighted on its first frame instead of plain text followed by a colour pop. The phone code-file implementation is Pierre `File` with the same theme and
review grammar; desktop files alone load Monaco.

**Without WebAssembly the Pierre surfaces show plain text.** `@pierre/highlights` is WebAssembly only,
and Pierre paints nothing — not even its own plain-text pass — until a main-thread highlighter loads; it
has no highlighter-free mode, and Shiki stays out of the build. `PierreProvider` therefore reports
`usePierrePlain()`: true from the first frame when `canUseWASM()` fails (the pool is then never built),
or once `preloadHighlighter` for the `thinkrail` theme rejects, which latches for the page. `PierreDiff`,
`PierreFile` and the notebook source diff then swap Pierre for `PlainCode`: uncolored runs from
`plainRuns.ts` — the whole file, or each hunk's `@@` header, context and `-`/`+` lines — inside the
same scroller. Review annotations, line selection and hunk toolbars need Pierre's rows and are absent in
this mode. Each run of one kind is one text node rather than an element per line, so a 100k-line file
stays a handful of nodes without a virtualizer, which the mirrored `PierreScroller` would have to feed.

**Pierre surfaces are virtualized.** Unvirtualized Pierre puts every line in the DOM (≈400k nodes for a
100k-line file), which WebKit — the desktop shell's engine — cannot style or lay out, hanging the app.
`pierreVirtualizer.ts` owns one `PierreVirtualizer` (a core `Virtualizer` subclass) per surface,
provided through `VirtualizerContext` so `FileDiff`/`File` build their virtualized instances, and set up
from the same ref callback as `useScrollViewState` so scroll restoration keeps working. The scroller's
first child is the content container and must give the Pierre element a non-zero height from the first
frame (`flex-1` in a `min-h-full` column): Pierre's scroll anchor treats a zero-height file as lying
above the viewport and jumps to its end once the height lands. The scroller opts out of browser scroll
anchoring (`overflow-anchor: none`, as Pierre's own `CodeView` does) because Pierre corrects scroll
itself. Annotation children stay in the light DOM but lay out only inside the render window, so the
focus reveal first asks the virtualizer to center the thread's end line (`revealLine`, through the
connected instance's `getLinePosition`) and then centers the card once it renders. `revealLine` reports
success only when the line lands in the viewport: before the worker's first answer lays the rows out, the
scroll is clamped short, and the reveal retries when the content grows instead of latching a miss. A
freshly opened diff composer gets the same treatment — Ask agent anchors it at the hunk's end line, which for a tall
hunk lies outside the window — and `ReviewComposer` defers its initial focus until its textarea has a
box, since focusing an unrendered element is a silent no-op. Restored composers keep the restored
scroll position instead.
A virtualizer windows only against a real scroller: a stacked Changes section at natural height is as
tall as its content, so its virtualizer "sees" every line and renders them all (≈72k rows for a
100k-line added file, freezing the app once it lands). The code renderer therefore declares
`boundedDiff: "large"`, and a stacked section above `VIRTUALIZED_DIFF_LINES` (1000, by the larger
text side's line count, including unchanged context) gets the same bounded `60vh` viewport as
`"always"` renderers and owns its scroller. Counting source lines keeps expansions virtualized even
when a large file has only a small edit, and covers untracked files without git's missing counts.
The same threshold gates virtualization in every host: `GuardedRendererDiff` passes `virtualize` only
above it, and below it `PierreDiff` withholds its virtualizer so the plain `FileDiff` renders every
row, as before virtualization. Virtualizing small diffs bought nothing and cost two failures. A
virtualized instance's hydrate measures its offset (forcing layout) while its container is still
empty; in the stacked list, whose end sits at maximum scroll so the last header can reach the top,
that collapsed layout clamps `scrollTop`, and Virtuoso's size correction compounds the jump until the
reviewed section leaves the render window. And `@pierre/diffs`'s virtualized in-place column
re-render can drop annotation rows that the instance still records, leaving a just-opened composer
slotted nowhere until something forces a `rerender()`. Large diffs still carry that annotation risk.

**Virtualized scrolling is tuned for chunk cost.** Pierre lays each code column out as a subgrid with
one item per row, so every render-window shift relays out the whole rendered grid, and the cost of a
shift tracks the rows inserted, not the rows kept. Split layout pays it twice whenever the new rows
carry an annotation (hunk toolbars, threads): Pierre's `ResizeManager` pairs each annotation row across
both columns with a forced `getBoundingClientRect` and then syncs the pair's
`--diffs-annotation-min-height`, forcing a second layout. With Pierre's 50-line chunks that was a
~90 ms long task per shift under the Chromium profiler and ~80–95 ms hitches in WebKit.
`usePierreVirtualizer` therefore passes `hunkLineCount: 5` and a 400 px overscroll (Pierre defaults: 50
lines, 1000 px), measured with wheel flings over a 6k-line, 150-hunk diff: inline and added-file
scrolling drop from 12–34 to 2–3 dropped frames in WebKit, and the worst split hitch roughly halves
(~45 ms). Split scrolling over dense hunk toolbars still drops frames in WebKit; without the toolbars
it is smooth, and `overflow: "wrap"` (which skips the pairing because both sides share grid rows) helps
moderate scrolling but not flings. The virtualizer's `lineHeight` metric is the real row height:
`.pierre-code-surface` sets `--diffs-line-height` from `--tr-code-row-height` (the dense code size ×
`default`, a whole pixel — 14 px by default, matching Monaco's rounding), and `codeLineHeight()` reads the
same token. A font settings change can move that row height, so `usePierreVirtualizer` re-reads it on
`onFontsChange` and `PierreVirtualizer.setMetrics` hands the new metric to every connected Pierre instance
(its public `setMetrics` resets the cached row heights) — Pierre's React components read `metrics` only
when they create an instance, and remounting the surface instead would drop an open line composer and its
unsaved text. Against
Pierre's 20 px default estimate the scroll height of a 20k-line file started ~40% too tall and shrank
while scrolling as rows were measured. Rejected after measurement: mirroring an invisible spacer onto
the opposite split column (it cut paint area but not dropped frames in either engine) and a larger
overscroll (about twice the dropped split frames at 5-line chunks, and no fewer blank frames in fast
flings).

**`PierreScroller` keeps the compositor from showing unpainted rows.** WebKit (the desktop shell)
scrolls overflow off the main thread: a scrollbar drag in a 20k-line file jumps ~2,600 px per step,
and each step showed one fully blank frame before the main thread painted the new window. No
overscroll covers that, and painting Pierre's spacer elements like rows did not help: the blank was
unrasterized space, not the spacers. The scroller therefore keeps native scrolling (scrollbar, wheel,
keys, momentum, autoscroll) but holds a sizer measured to the content height, a `sticky` viewport
clipped to the scroller's height, and the content translated by `-scrollTop` on the main thread.
Off-thread scrolling moves only the sizer, so the pinned viewport keeps showing the last painted rows
until the main thread moves the content in the same frame it renders the window — a fast drag lags,
never blanks. Pierre corrects the scroll position inside its rAF pass and `useScrollViewState`
restores it from a ResizeObserver, both after that frame's scroll event, so the scroller's own
`scrollTo` and `scrollTop` re-sync the transform synchronously; otherwise Pierre would measure rows
against a stale offset. Natural-height stacked sections run the same structure without scrolling:
the viewport's height is read back from the scroller after the sizer is set, so it never feeds the
content's own height.

- **Rendered markdown navigates.** In the preview, links + images resolve against the file's own path
  (via `markdownLinks`, passed as the `a`/`img` renderers): a **relative link** opens the target file in
  the **preview** tab through the shared **`openFileInTab`** (the same flow `FileTree` uses) — following a
  link is browsing, so the slot is reused rather than promoting the source doc the way VS Code does; an
  accepted file target is a button styled as document-link text, never an anchor with a raw relative
  `href`, because that URL is not a ThinkRail route and native navigation would escape to the Main page;
  URL pathnames are decoded once and both path-separator forms are normalized before resolution, while
  malformed encoding and traversal above the worktree root produce an inert control instead of opening the
  wrong file; the slot is the slot, whatever
  the open came from — an **in-doc `#` link**
  scrolls the preview (headings carry slug ids from the in-repo `remarkHeadingIds` transform), an
  **external** link opens a new tab, and a **relative image** rewrites to the host **`/files/…`** route
  (through `resourcePane.resourceBytesUrl`, injected into `documentComponents` so the markdown layer never
  reaches for the transport itself). A cross-file link's `#fragment` is not yet followed (opens the
  file only).
- **Document markdown renders sanitized raw HTML; chat markdown does not.** READMEs place logos and
  banners with `<p align="center"><img src width>`, float images with `<img align="right">`, fold
  sections in `<details>`, and ship theme-aware logos as `<picture><source media srcset>`; shown as
  literal tags, those documents lose exactly their most visible content. `markdownHtml.documentRehypePlugins`
  runs `rehype-raw` and then `rehype-sanitize` on GitHub's `defaultSchema` with three deltas: the alert
  element the in-repo remark transform emits (`mdalert` + `variant`) is allowed and `<source>` keeps
  `srcset`/`media`/`type`/`sizes`. GitHub's **`user-content-` clobber prefix stays on** every `id`/`name`
  (a document must not be able to mint `window.MonacoEnvironment` or shadow a global by naming an
  element after it), so in-document `#slug` links resolve through `scrollToAnchor`, which tries the
  prefixed id first and the bare slug second. Everything active or stylistic — `script`, `iframe`,
  `style`, event handlers, inline `style`, `javascript:` URLs — is dropped, and `data:` images with it
  (the schema's `src` protocols are http/https/relative). Raw `<img>`/`<source>` go through the same
  relative-URL rewrite as markdown images, so a README logo loads from the worktree; `srcset` is parsed
  with the HTML candidate grammar (`srcsetCandidates`: commas inside URLs, descriptor parentheses) and,
  because neither the sanitizer nor react-markdown protocol-checks `srcset`, every candidate is
  re-admitted only as a worktree URL or an `http(s)`/protocol-relative one — `javascript:`/`data:`
  candidates are dropped, as is a bare `src` of those kinds; `width`/`height` survive, and
  `align="left|right"` maps to a float utility rather than a presentational attribute. The source-line
  stamps for commenting are added **after** sanitizing, so the sanitizer can never strip them. The chat
  `Markdown` primitive is untouched: model output is not a document the user authored.
- **Desktop file source wraps at the synchronized file column.** `MonacoEditor` uses the reader preference
  `fileLineWidth` as `wordWrapColumn` (40–240, default 120). The independent `fileLineWidthBounded` default maps to Monaco
  `wordWrap: "bounded"`, wrapping sooner at the mounted file pane; off maps to `"wordWrapColumn"`, preserving
  the selected column with horizontal scrolling in a narrower pane. Broadcast changes update a mounted
  desktop file editor. Pierre diffs and phone files own horizontal overflow and do not consume this Monaco
  preference. Rendered Markdown and rendered Markdown diffs retain their separate ~78ch reading measure.
  The React Compiler memoizes `MonacoEditor`'s options on width, bounded, path and the resolved editor
  font, and the editor calls `updateOptions` only when that object changes. The font is the generated
  `.tr-code-editor` style resolved through `@thinkrail/ui/fonts` (family, dense code size, weight,
  ligatures — a computed read, because the token is an unresolved `calc()`), cached per `data-fonts`
  revision and re-read on `onFontsChange`; a change then waits for that face and calls
  `remeasureFonts()`. Spacing tokens stay static generated CSS (themes set only colours).
- **The desktop Monaco surface is a reader, not a language workstation.** Its file-only options keep the
  configured wrapping, generated code typography, minimap/overview-ruler removal and 6px shadowless scrollbar,
  and add read-only messaging, the path as its accessible label, an 8px top inset, three-character line-number
  gutter, full active-line paint, smooth scrolling, active bracket-pair + indentation guides, single-file
  occurrence highlighting, and ambiguous-Unicode suppression. Opaque `viewState` is restored only after its
  editor-state shape is validated and is saved on unmount, so tab switches round-trip scroll and folding.
  A review focus that arrives with the mount jumps to its line (`revealLineNow`, an immediate scroll): a
  smooth scroll started before the editor's first layout can stop short, and the handled focus is not
  retried, so the card stayed off screen. A focus on a mounted editor still scrolls smoothly.
  Monaco is imported from `editor.api` with only the reading contributions (find, folding, bracket matching,
  context menu/copy, links, hover, word highlighting, sticky scroll, go-to-line/command palette, read-only
  messaging and Unicode highlighting); keeping word highlighting preserves F7. Each contribution loads through
  its typed `monaco-editor/features/<name>/register.js` entry, because Monaco's `exports` map closes the deep
  `esm/vs/...` paths. The editor core loads `coreCommands` itself. `codicon-modifiers.css` is not exported, so
  codicon spin animations (only hover loading icons here) stay static. The TS/JS/JSON/CSS/HTML
  language-service contributions and their workers are absent, so this viewer emits no language-service
  diagnostics by construction. Each editor mount owns its model: the model id is a per-mount `useId` scope
  ahead of the path, so the same file on screen twice (a chat card and its full screen, a card and the
  file's tab) never shares a model that one unmount disposes under the other.
- **`MonacoEditor` mounts Monaco itself.** A layout effect creates the editor and its model in the commit
  that mounts the view, with no loading state, then restores the view state and attaches review commenting
  (review attaches only at mount). Its layout cleanup saves the view state before it disposes the editor
  and the model, in that order. A path change on a live editor swaps the model in place, and the language
  follows the path, because `RendererView` is keyed by implementation, not path. New text calls `setValue`
  only when it differs from the text last applied: the editor is read-only, so the last applied text is
  the model's text and reading it back (`getValue()`) would only cost a full copy. The model and options
  effects skip their first run, because the mount just created the editor with exactly those inputs. The
  editor lives in a layout effect, so a re-suspend inside the view's Suspense boundary disposes it (and any
  open review composer); nothing re-suspends there today, because each `RendererView` has its own boundary
  and its loaded component is cached.
  A review focus in the mount commit reveals its line with `ScrollType.Immediate`: a smooth reveal issued
  before the editor's first frame never lands (found by the far-off worktree comment e2e). A later focus on
  a live editor scrolls smoothly.
- **Code surfaces re-theme from generic tokens, resiliently.** `monacoSetup` owns the sole `EDITOR_THEME`:
  `createFileEditor` applies it and the theme refresh defines it. The host's `code.editorTheme` resolves the
  Pierre color table chat uses, plus the complete editor/widget/menu/input colour map, to hex; Monaco defines
  its theme from that. Token scopes are Pierre's token names. A swap redefines Monaco and
  selects `EDITOR_THEME`, with no new tokenizing. `support/editorLanguages.ts` merges the curated catalog with
  the `@pierre/diffs` extension table and a short override list (`.m` Objective-C, `.pl` Perl, file types the
  table lacks), and catalog files keep their language. `diffsFileTypes` hands every editor choice the table
  disagrees with to `replaceCustomExtensions` when the diffs worker pool starts (only ids the diffs table knows),
  so a file gets the same language in the editor and in diffs; the pool ships the map to its workers. A
  descriptor's explicit `language` (`describeResource`) bypasses that map, so it must agree too: `.mdx` is
  `mdx`, while the Markdown MIME and preview renderer still match it.
  Monaco matches file names without case, so the table keys `BUCK`, `BUILD`, `PACKAGE` and `WORKSPACE` stay out: otherwise a file named `build` opens as Python. A real Bazel or Buck file is plain in the editor and Python in diffs.
  Missing Monaco language ids are registered with their file associations, then each id gets a
  `registerTokensProviderFactory` entry. A table language Pierre has no lexer for stays plain. The normal/high-contrast base comes from manifest
  appearance/contrast metadata—never a known id—and remains inherited for specialist colours outside the
  explicit map. Reads pass through `lib.cssColorToHex`; an absent or unparseable token is
  omitted so the selected base palette wins rather than crashing the panel. Pierre diffs emit `--code-*`
  variable references; inherited `--diffs-*` properties map canvases to the workspace/content roles and
  addition/deletion paint to feedback roles, so a theme swap needs no re-highlight. `TerminalInstance`
  similarly rebuilds from the complete 16-slot ANSI variable set. Monaco and xterm consume the nullable
  editor selection-foreground override when provided.
- **Monaco tokenizes through one Pierre `LiveTokenizer` per model.** `pierreTokens.ts` is Monaco-free apart from
  types. `@pierre/highlights` compiles its WASM on import, so the factory's `create()` imports it when Monaco
  first meets a model of a registered language, never during a preload. On a 5,000-line TS file the first open's
  largest long task is 72 ms in Chromium, about the same as tokenizing with a grammar engine, and all lines are
  ready in 212 ms (Chromium) and 337 ms (WebKit). Each tokenizer holds its own WASM instance: about 0.5 MB for
  1,000 lines. Only the visible file of each editor group has a model (split groups show up to four), and a
  disposed model frees its tokenizer.
  Pierre cannot save or restore lexer state, so a tokenizer owns a whole document and tokenizes it at once.
  The Monaco line state only names that document, the line number and its revision (the model's version id).
  Every `tokenize` first resets each document whose model version moved, rather than waiting for
  `onDidChangeContent`: Monaco recolors the visible lines inside the change, before public listeners run, and a
  stale document there would leave them plain for good. The reset is not incremental: the models here change
  only through `setValue`, and the new revision makes Monaco retokenize every line. Monaco's `tokenize`
  receives no model, so a state starts with no document and picks one by line text. Two files can share
  lines: when a document no longer holds the current line, the state moves to another document of that
  language that holds it, preferring one with the same earlier lines, whose tokens so far are the same. When
  none has them — the borrowed document changed or closed mid-pass — any holder takes over, so the file
  recovers its own document by the next line instead of staying plain. Fences and inline HTML color inside Pierre's own lexers, with no per-language
  loading. Monaco asks a factory for a provider only once, so a failed load answers plain text and marks the
  language missing, and the next model of that language installs the provider with `setTokensProvider` if a
  retried load succeeds. `create()` never throws, and nothing suspends on the highlighter: a Suspense fallback
  is held for at least 300 ms. Without `WebAssembly` (WebKit Lockdown Mode) the import fails and files stay
  plain. Lines of 20,000 characters or more stay plain. A model over 20 MB or 300,000 lines builds no tokenizer:
  Monaco never colors one (limits read through `getValueLength` and `getLineCount`). `.v` opens as Verilog: Coq
  shares the extension and has no way in by file name. `.m` opens as Objective-C, not the table's Wolfram.
- **The code view preloads before the first open.** Loading the Monaco chunk and initializing Monaco only
  after the tab mounted, behind a fallback held for at least 300 ms, made the
  first open about 420 ms at 1x CPU (840 ms at 4x) against 65 ms for a warm one. With the app's idle
  preload and row-hover warm (`usePreloadResourceView`), the first open is about 120 ms at 1x (430 ms at
  4x). The package
  only offers the mechanism; the host decides when to call it. Cost: every desktop session loads the
  Monaco chunk (about 3.9 MB decoded) and a 70 ms evaluation task at
  4x CPU after boot. A click while the preload is still loading suspends as before. A preload that fails
  while the network is down costs the rest of the session: Chromium caches the failed module fetch, so
  every later import of that chunk rejects without a request, and a statically split chunk has no URL to
  cache-bust. The first open then shows the error boundary's **Reload page**, which recovers; on main the
  same outage fails only if it lasts until the first open. The host therefore holds the preload until the
  page is online. `e2e/error-boundary.spec.ts` pins the Chromium behaviour: if a browser update re-fetches a
  failed module, that test turns red and this cost is gone.
- **Monaco mounts without `@monaco-editor/react`.** The wrapper awaited `loader.init()` (a promise even
  with a bundled Monaco) and took two more React commits before `editor.create`. The owned mount creates
  the editor in the view's own commit. Click to visible text, median of 5 interleaved rounds (Chromium,
  Mac Studio): a file open 65 to 34 ms and a tab switch 49 to 30 ms at 1x CPU, 145 to 77 ms and 88 to
  70 ms at 4x. Click to highlighted is no later. Cost: create and first render now run in one task, so the
  longest task after the click grows at 4x CPU (cold open 120 to 145 ms, warm large open 0 to 55 ms). The
  `MonacoEditor` chunk shrinks by 12.1 kB (3.10 MB to 3.09 MB; 3.5 kB gzip).
