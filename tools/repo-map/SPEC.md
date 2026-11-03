---
id: module-repo-map
type: module-design
status: active
title: repo-map, a local visual map and diff of a TypeScript codebase
parent: architecture
tags: [tooling, code-map]
depends-on: []
---

## Responsibility

Index a TypeScript repository into a symbol graph, compare two graphs, and serve both to a local UI. It is a developer tool: nothing in the product imports it, and it imports nothing from the product.

## Boundary

- **Owns:** the `RepoGraph` and `GraphDiff` model (`core/types.ts`), the indexer (`indexer/`), the pure diff (`core/`), ref checkout, the graph cache, the `repo-map` CLI, and the local server.
- **Public surface:** the root `repo-map` command and `/api/*` on `server.ts`. `core/types.ts` is the contract with `ui/`.
- **Allowed deps:** Bun, the TypeScript compiler API, `git` and `gh` on PATH. `core/` is pure and needs only Bun's hash. `ui/` adds `react`, `react-dom`, `shiki` and `diff`, and imports only types from outside `ui/`.
- **Forbidden:** imports from `apps/*`, `packages/*` or extensions. The target repo is read as data, so a commit being indexed need not contain this tool. The wire extractors read the shape of the code, never a product import.

The target repo comes from cwd or `--cwd`. The compiler and the UI dependencies come from this package.

## Graph

One `ts.createProgram` over every tracked `.ts`/`.tsx` file that is not `.d.ts`. One program per tsconfig is slower and splits symbols across checkers. `resolver.ts` replaces module resolution, so workspace packages (through `exports`, subpaths included) and tsconfig `paths` resolve inside the indexed root. Anything else resolving outside the root and outside `node_modules` is treated as unresolved. Without this rule a commit's graph reads head code through `node_modules/<workspace>` symlinks.

Symbols:

- `SymbolId` is `<path>#<qualified.name>`, with `~2` on a duplicate in source order.
- Local functions and anonymous callbacks roll up to the nearest symbol. A trace stays connected without containment edges.
- Function-valued entries of an object literal become `method` symbols when the literal is held by a module-level const or returned by a named function. This keeps store actions and factory methods separate.
- `(module)` holds top-level code outside any symbol. Its range is the whole file. `const` holds an exported non-function value.
- `bodyHash` covers tokens from `getChildren` (the compiler's scanner, so templates, regexes and JSX text are right). It excludes the symbol's name, `export`/`default`, nested symbols, semicolons, trailing commas, formatter parens and quote style.
- Signatures print the inferred return type only for exported symbols, because inference costs time.

Edges:

- `call` also covers a function or callable const referenced as a value, such as `then(load)` or a prop. Without this a handler passing `listProjects` to a helper looks like it does not depend on it.
- Interface member calls target the member. `implements` links class members and object-literal entries to the member so a trace can continue.
- `dynamicCalls` counts calls to a callback parameter, a local, or a member of an inline type. They resolve but have no target outside the caller, so they are not counted as in-repo edges.
- A bare import with no types counts as external, because the target is known to be outside the repo.

## Wire extractors

Discovery reads code shape, so a repo without these patterns produces nothing:

- Transport: a class or interface named `*Transport` with `request` and `subscribe`. Its first `request` parameter type gives the method names.
- Handler map: an object literal where at least half the keys are method names.
- `wire-request`: a call whose callee resolves to the transport's `request`. The method comes from the argument's literal or literal-union type. An argument that is a parameter makes the enclosing function a wrapper, and its callers are followed. Anything else counts as `wireDynamicRequests`.
- `wire-push`: `*CHANNELS.x` referenced outside the transport's package, except as `.subscribe(x)` or in a comparison, to callers of the transport's `subscribe`.
- `tool-render`: an object literal with a literal `name`, `execute` and `parameters`, to `registerToolRenderer` arguments, including for-of over an array literal, prefix registration, and `toolRenderers` maps.

Test files are excluded from all extractors, so coverage counts production code.

## Refs and cache

A commit is read with `git archive` into a temp dir under `<git-common-dir>/repo-map`, limited to code and config files, then `node_modules` of each package is linked from the current worktree, or the main worktree when absent. The temp dir is removed after indexing, and leftovers older than an hour are swept.

Graphs of clean commits are cached at `<git-common-dir>/repo-map/v<schema>-<sha>.json`, shared across worktrees. A working tree with dirty code or config is never cached. Bump `GRAPH_SCHEMA_VERSION` when indexer output changes. `commits90d` is counted back from the commit's own date, so a cached value stays deterministic.

## Diff

`diffGraphs` is pure. `modified` means the `bodyHash` differs. `moved` pairs a removal with an addition of the same hash, by name first, then across names for bodies of three lines or more. Groups are connected components over `call`, `new`, `render`, `implements`, wire edges and parent links, between changed symbols only. Blast radius walks callers up to 400 symbols, across the wire, through `implements` from member to interface, and through `type-ref` for types.

## UI

`ui/` is a React app served by `Bun.serve` from `ui/index.html`, with no router, state library or graph library. It fetches the session, graphs and diff once at startup, then builds indexes in `lib/workspace.tsx`. Source text is fetched per file and highlighted with shiki on first use.

- `lib/`: pure functions with `bun test` coverage. `layout.ts` is the layered layout (BFS layers, barycenter order, overlap resolution, curved edges). `treemap.ts` is the squarified treemap. `trace.ts`, `flow.ts`, `changes.ts`, `search.ts`, `sourceLinks.ts`, `lineDiff.ts`, `route.ts` and `graphIndex.ts` derive each view's data.
- `views/`: one file per route, plus `views/changes/` for the diff tabs. `components/`: shared parts such as `GraphCanvas` (pan and zoom), `SourcePane` and `Palette`.
- `styles/`: hand-written CSS. `tokens.css` owns every color and spacing value, for dark and light through `prefers-color-scheme`.

Rules the views keep:

- The URL hash holds all view state, so every view is a link and back and forward work. `route.ts` owns the format.
- Nothing draws the whole graph. A trace starts one level deep and cuts each fan-out to 8 with a "+N more" node, wire edges first. A group over 24 symbols shows one symbol and its neighbors.
- Change state always has a mark (`+`, `-`, `~`, `>`) as well as a color. Removed edges are also dashed.
- Flow opens as a waterfall: one indented, collapsible row per call. Bar length counts the calls inside a row, because a static index has no durations. Collapse state is local and resets when the flow changes.
- Flow hides symbols with 40 or more callers unless asked, and says how many. It folds an interface member with one implementation into the call.
- The source pane renders only visible lines, so its row height is fixed and find-in-page sees only those lines.

## Limits

- One program uses 5 to 6 GB RSS. Each side of a diff is indexed in turn, with a GC between them.
- Calls through `handlers[method]` are dynamic, so handler tests that use a generic dispatcher do not appear in blast radius.
- A channel pushed through a variable counts for the function that names the `*CHANNELS.x` constant, not for the function that sends it.
- A global augmentation of a lib or package type counts as external, so `Window` users do not depend on the file that augments it.
- Local functions rolling up means a large closure such as `createServer` is one node.
