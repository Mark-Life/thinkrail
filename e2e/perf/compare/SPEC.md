---
id: submodule-perf-compare
type: submodule-design
status: active
title: perf:compare — A/B performance comparison of two commits
parent: module-browser-e2e
tags: [testing, performance, public-surface-checked]
---

## Responsibility

`bun run perf:compare <base> <head>` measures two commits on one machine and reports the difference.
It is an opt-in measurement tool, never a gate: no CI wiring, no budgets, no history store. The checkout
running the command (the tool) drives a per-SHA app build of each side, so the measuring harness is
identical for both sides and only the app under test differs.

## Model

- **Cache.** `~/.cache/thinkrail-perf/` (`THINKRAIL_PERF_CACHE` overrides). `repo.git` is a bare repo
  whose `objects/info/alternates` points at the tool's git common dir: no object copy, no fetch, and no
  worktree registers in the shared repo (parallel agents and ThinkRail's own worktree list never see
  cache worktrees). `wt/<sha>` is a detached worktree of that bare repo. A ref the tool repo cannot
  resolve fails with "SHA not found; fetch it".
- **Prepare.** Under an atomic `locks/<sha>` directory (a dead owner pid is reclaimed), the SHA gets
  `bun install --frozen-lockfile` with `HUSKY=0`, then each selected `Artifact` builds inside the
  worktree. `wt/<sha>/.perf-built.json` records the lockfile hash, Bun version and per-artifact inputs;
  matching entries skip work, `--rebuild` ignores them. Builds get an allowlisted environment (`PATH`,
  `HOME`, `TMPDIR`, `LANG`, `TERM`, `USER`, `SHELL`), never the caller's `THINKRAIL_*`/`XDG_*`.
- **Artifacts.** `profile-web` (`build:profile`, `apps/web/dist-profile`), `manifest-web`
  (`vite build --manifest`, `apps/web/dist-manifest`, a separate dir so `build:binary` cannot clobber it),
  `binary` (`build:binary`), `desktop` (`desktop:build`, darwin only). Each is built once per
  (SHA, key) from the union over selected suites.
- **Suites.** A `Suite` declares its artifacts (a list, or a function of the options so opt-in variants
  build only when selected), whether it drives a browser, a `Schedule`, its variants,
  and `sample()`; an `optIn` suite runs only when named in `--suite`. The core never imports a suite by name: adding one is a file plus a line in
  `suites.ts`. A sample receives a `SuiteContext` with its own `sampleDir`; `hermeticEnv(stateDir)`
  gives it fresh `HOME`, data, pi, and XDG dirs, `PI_OFFLINE=1`, analytics off, and `CI=1`.
- **Startup suite.** Variants from `--startup` (default `cli,server`; `binary` and `desktop` opt in and
  add their artifact). Every spawn runs from an empty `cwd` with `hermeticEnv` plus empty shell rc files
  in `HOME`, in its own process group, killed after the probe. `cli` times source `--version` to exit;
  `server` times the source CLI (`--host 127.0.0.1 --port <free> --no-open`) to the `thinkrail →` stdout
  line and to `/health` 200 (polled every 10 ms). Each runs cold (fresh
  `BUN_RUNTIME_TRANSPILER_CACHE_PATH`) and warm (per-SHA dir under `<out>/state/startup/`). `binary` times
  `--version` and `/health` of `apps/cli/dist/thinkrail` with cold and warm `XDG_CACHE_HOME` (asset
  staging). `desktop` (macOS) times spawn of the dev launcher to `THINKRAIL_DESKTOP_READY_FILE`, written
  on webview `dom-ready`, hidden window, fresh user data. Schedule is `auto` (`--min-runs`, `--max-minutes`).
- **Schedule.** `once` takes one sample per side. `rounds` and `auto` first run one discarded warmup per
  side and variant; rounds then alternate ABBA (odd rounds base first). `auto` stops after `minRuns`
  once no timed metric is `unsure`, re-checking every `batch` rounds, or at `maxMinutes`. `os.loadavg()`
  is recorded per round; load above one per core is a report warning.
- **Compatibility.** A variant whose sample fails (warmup or later) on either side is excluded from
  both sides and reported with its reason; a suite aborts only when every variant fails. The
  `PROTOCOL_VERSION` of each side is recorded and a difference is a warning, because it changes in most
  feature PRs; `--strict-protocol` turns it into an abort when a browser suite is selected.
- **Statistics.** Exact metrics (sizes, counts) compare medians; any change beyond `--threshold` is
  `better`/`worse`. Timed metrics report a 95% CI of the relative difference of means: ratio
  `R = mean(head)/mean(base)`, delta-method variance `R²·(s_h²/(n_h·m_h²) + s_b²/(n_b·m_b²))`,
  Welch–Satterthwaite df over those two terms, Student t (df 1–30 table, floored; 1.96 beyond). The CI
  wholly beyond `±threshold` gives `better`/`worse`; wholly inside gives `same`; otherwise `unsure`.
  Two all-zero sides are `same`. Offset metrics (signed gaps such as "A minus B", where a ratio is
  meaningless) report the difference of means with a Welch 95% CI in the metric's unit; the CI wholly
  below or above zero gives `better`/`worse`, the threshold does not apply.
- **Output.** `<out>/compare.json` (`CompareResult`) and `<out>/compare.md`; `--json-only` skips the
  markdown. Rows with verdict `same` collapse into `<details>`; ▮ marks 5/10/20/50% tiers.
  `report <compare.json>` re-renders markdown. Per-sample files live under `<out>/samples/`.
- **Hermeticity check.** The `~/.thinkrail` mtime is compared before and after; a change is a warning,
  not an abort, because a running ThinkRail on the same machine also writes there.
- **Renders suite.** One variant per scenario (`--scenario`, default `DEFAULT_SCENARIOS`, validated
  against the tool's `SCENARIO_NAMES`); `rounds` schedule, 5 by default. Each sample is one fresh
  Playwright run of the tool's `render.perf.ts` (`THINKRAIL_PERF_RUNS=1`) under `hermeticEnv`, with
  `THINKRAIL_PERF_APP_ROOT` pointing `playwright.perf.config.ts` at the SHA worktree's `dev.ts` and
  `dist-profile`. Always Chromium: `startMainThreadProbe` needs CDP, so `--browser` does not apply.
  A missing `<scenario>-1.json` makes the scenario incompatible with the first Playwright error as
  the reason; the full log stays in the sample dir. All metrics are `timed`. Per-component rows track
  the union of the top 15 by self ms across both warmups, frozen for the measured rounds, so every
  sample reports the same ids (absent components count as zero). `THINKRAIL_E2E_LANE`,
  `THINKRAIL_E2E_PORT_BASE` and `PLAYWRIGHT_BROWSERS_PATH` pass through so two compares from one
  tool checkout can use separate port blocks.
- **Waterfall suite.** Opt-in (`--suite waterfall`), one variant `restore`, `rounds` schedule, 7 by
  default. Each sample is one fresh Playwright run (fresh host) of `waterfall.perf.ts` with
  `THINKRAIL_PERF_WATERFALL_OUT`; without it the spec skips, so `perf:render` ignores it. The spec seeds a
  24-turn chat with the tool's `seedWorkspaceSession`, opens it, then reloads with routing on (Playwright
  routing disables the HTTP cache, so the reload fetches every chunk) and records passively: Playwright
  WebSocket frame events and `requestfinished`, all on one Node clock from the reload. Order rows:
  `session.getMessages` sent minus the reply to the last `workspace.watchReady` for the same workspace
  sent before it (offset, plus an exact 1/0 "waits" flag), and the `ChatView-*.js` chunk finish minus the
  `getMessages` reply (offset). Timing rows are those points from the reload, plus page-side composer
  typeable and first message painted. Layout rows count only shifts after the composer is typeable:
  on Chromium the `layout-shift` sum, max and count, and per-region scores (nearest `data-testid` of
  `SHIFT_REGIONS`, else `other`; a shift touching several regions splits evenly). Where `layout-shift`
  is unsupported (WebKit) the fallback is the largest per-frame move of `chat-input`, `chat-scroll`
  and the last `chat-row`, in scroll-compensated page coordinates so scrolling is not a move.
  `--browser` applies (default chromium). The watcher is warm at reload, so the order gap is small;
  its sign is what changes when a read stops waiting for readiness.

## Boundary

- **Public surface (barrel):** `runCompare`, `renderReport`, `SUITES`, `type Artifact`,
  `type CompareOptions`, `type CompareResult`, `type Measurement`, `type MetricSummary`,
  `type SampleResult`, `type Schedule`, `type Side`, `type Sha`, `type Suite`, `type SuiteContext`
- **Entrypoint:** `cli.ts` backs `perf:compare`; commands `run` (implicit), `prepare`, `report`, `clean`.
- **Allowed:** `../renderProfiler`, `../scenarios`, `../chatReplay`, `../../processRunner`,
  `../../fixtures/*`,
  `@thinkrail/artifact-tests` (`locateDesktopLauncher`), node/bun built-ins, `@playwright/test`.
- **Forbidden:** importing app `src`, writing outside the cache root, `--out`, and per-sample temp
  state, and reading or writing `~/.thinkrail`.
- Unit tests (`*.test.ts`) run under root `bun run test`; `playwright.config.ts` ignores them. The
  module typechecks with `bunx tsc --noEmit -p e2e/perf/compare` (root `typecheck` does not cover
  `e2e/`).

## Not yet built

Remote hosts (`--host` accepts `local` only).
