---
id: submodule-perf-compare
type: submodule-design
status: active
title: perf:compare — A/B performance comparison of two commits
parent: module-browser-e2e
tags: [testing, performance, public-surface-checked]
---

## Responsibility

`bun run perf:compare <base> <head>` measures two commits on each selected host (local by default) and reports the difference.
It is an opt-in measurement tool, never a gate: no CI wiring, no budgets, no history store. The checkout
running the command (the tool) drives a per-SHA app build of each side, so the measuring harness is
identical for both sides and only the app under test differs.

## Model

- **Cache.** `~/.cache/thinkrail-perf/` (`THINKRAIL_PERF_CACHE` overrides). `repo.git` is a bare repo
  whose `objects/info/alternates` points at the tool's git common dir: no object copy, no fetch, and no
  worktree registers in the shared repo (parallel agents and ThinkRail's own worktree list never see
  cache worktrees). `wt/<sha>` is a detached worktree of that bare repo. A ref the tool repo cannot
  resolve fails with "SHA not found; fetch it".
- **Prepare.** Under an atomic `locks/<sha>` directory (staged with its `pid` file, then renamed into
  place; a dead or unreadable owner pid is reclaimed), a missing
  worktree is added at `wt/<sha>.tmp` and moved into place only after `git worktree add` succeeds, so an
  interrupted checkout is never reused. The SHA then gets `bun install --frozen-lockfile` with `HUSKY=0`, then each selected `Artifact` builds inside the
  worktree. `wt/<sha>/.perf-built.json` records the lockfile hash, Bun version and per-artifact inputs (the `cwd` and `bun run` argv that the
  build runs, so the cache key cannot drift from the command);
  matching entries skip work, `--rebuild` ignores them. An entry is removed before its install or build
  starts and written back only on success, so a failed build is never reused. A failed artifact build does
  not stop the run: suites that declare that artifact are reported incompatible with the build error, and
  the other suites run. Builds get an allowlisted environment (`PATH`,
  `HOME`, `TMPDIR`, `LANG`, `TERM`, `USER`, `SHELL`), never the caller's `THINKRAIL_*`/`XDG_*`.
- **Use marks.** A prepared SHA gets `locks/<sha>.users/<pid>` before its prepare lock is released;
  `runCompare` removes it when sampling ends, and dead pids are pruned. `--rebuild` and `clean <ref>`
  (both under the prepare lock) and `clean --all` refuse while another live pid uses the SHA, so nothing
  rewrites or removes a tree that a running compare samples.
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
  staging); `--version` also stages, so the cold serve gets its own state dir. `desktop` (macOS) times spawn of the dev launcher to `THINKRAIL_DESKTOP_READY_FILE`, written
  on webview `dom-ready`, hidden window, fresh user data. Schedule is `auto` (`--min-runs`, `--max-minutes`).
  While a startup child (or a pid from the ready file) is alive, SIGINT/SIGTERM handlers SIGKILL its
  process group and exit with the signal code, because a detached group never sees the terminal's
  Ctrl-C and no `runE2eProcess` handler is installed between spawns.
- **Schedule.** `once` takes one sample per side. `rounds` and `auto` first run one discarded warmup per
  side and variant; rounds then alternate ABBA (odd rounds base first). `auto` stops after `minRuns`
  once every timed metric of the still-sampling variants is settled, re-checking every `batch` rounds, or at `maxMinutes`. A timed
  metric is settled when its verdict is not `unsure` or its CI half-width is at most 2%; without the
  width rule an unchanged metric at `--threshold 0` stays `unsure` and every run would hit the cap. `os.loadavg()`
  is recorded per round; load above one per core is a report warning.
- **Compatibility.** A variant whose first sample on a side fails (the warmup, or round 1 of a `once`
  suite) is excluded from both sides and reported with its reason; when every variant fails, the
  suite is reported with all variants incompatible and the other suites still run; only an interrupt or
  `ENOSPC` aborts the run. Each attempt starts from an empty `sampleDir`. A later failure is treated as transient (a slow host, a timeout): the sample is retried
  once, then the round is skipped with a report warning and collected samples are kept; after 3 failed
  rounds the variant stops sampling and keeps its data. `ENOSPC` aborts the run with a disk-full message. The
  `PROTOCOL_VERSION` of each side is recorded and a difference is a warning, because it changes in most
  feature PRs; `--strict-protocol` turns it into an abort when a browser suite is selected.
- **Statistics.** Exact metrics (sizes, counts) compare medians; any change beyond `--threshold` is
  `better`/`worse`. Timed metrics report a 95% CI of the relative difference of means: ratio
  `R = mean(head)/mean(base)`, delta-method variance `R²·(s_h²/(n_h·m_h²) + s_b²/(n_b·m_b²))`,
  Welch–Satterthwaite df over those two terms, Student t (df 1–30 table, floored; 1.96 beyond). The CI
  wholly beyond `±threshold` gives `better`/`worse`; wholly inside gives `same`; otherwise `unsure`.
  At `--threshold 0` (default) `same` needs an exactly zero CI, so an unchanged timed row reads `unsure`
  with a narrow CI; pass a threshold to fold such rows. Two all-zero sides are `same`. When exactly one
  side's mean is zero the ratio is undefined: the CI column names the zero side and the verdict comes
  from the Welch difference CI. Offset metrics (signed gaps such as "A minus B", where a ratio is
  meaningless) report the difference of means with a Welch 95% CI in the metric's unit; the CI wholly
  below or above zero gives `better`/`worse`, the threshold does not apply.
- **Remote hosts.** `--host` (repeatable: `local` or any ssh alias, `[A-Za-z0-9][A-Za-z0-9._@-]*`) runs
  the compare on each host in parallel. Hosts whose alias or `ssh -G` hostname matches the local
  hostname run once, locally, and that result is written under each such alias, so one machine never
  runs two timed compares at once. Before any
  ssh, the tool tree must be clean and `git branch -r --contains` must find base, head and the tool
  SHA on `origin`, else it fails fast. Over `ssh -T -o BatchMode=yes`, `bootstrap.sh` holds a
  `<cache>/locks/bootstrap` mkdir lock (dead pid, or no pid after a minute, reclaimed) for its whole run, prunes `<cache>/runs/`
  entries older than 7 days, keeps a remote cache `repo.git` (`git clone --bare` of origin, then `fetch`), checks out the tool SHA as a detached
  worktree at `<cache>/tool/<toolSha>` (staged at `.tmp`, then moved), runs `bun install` (`HUSKY=0`), and checks the Playwright
  browsers the selected suites need, installing them into the user cache if missing (never system
  deps). Both scripts need `bun` on the non-interactive ssh `PATH` (a stock Debian
  `~/.bashrc` returns before the installer's `PATH` line); they also try `~/.bun/bin`, else exit with
  `bun not on PATH for non-interactive ssh`. The host then runs `perf:compare <baseSha> <headSha> --host local --json-only` with the same
  measurement flags into `<cache>/runs/<id>/` under `remoteRun.sh`: the compare runs in its own process
  group (`set -m`, pgid in `compare.pid`) and a watcher kills that group when ssh's stdin closes, which
  happens when the local ssh dies, since `-T` gives no pty and so no SIGHUP. After a non-interrupt
  failure the tool also sends `kill -TERM -<pgid>` over a new ssh. Its `compare.json` is read back (one retry; on failure the error names the remote path, which is kept),
  the remote run dir is removed, refs are restored
  to the local names, and `<out>/<host>/compare.{json,md}` plus a combined `<out>/compare.md` are
  written. A failed host does not stop the others; the run then exits 1. Remote runs never touch an
  existing clone on the host.
- **Output.** `<out>/compare.json` (`CompareResult`) and `<out>/compare.md`; `--json-only` skips the
  markdown. Base/Head cells show medians for exact rows and means for timed and offset rows, matching
  the statistic behind Δ. Rows with verdict `same` collapse into `<details>`; ▮ marks 5/10/20/50% tiers.
  `report <compare.json>` re-renders markdown. A local compare where no suite produced a metric exits 1. Per-sample files live under `<out>/samples/`.
- **Hermeticity check.** Every entry under `~/.thinkrail` is stamped (path to mtime and size) before and
  after; any added, removed or rewritten entry is a warning naming up to 3 paths, not an abort, because a running ThinkRail on the same machine also writes there.
- **Renders suite.** One variant per scenario (`--scenario`, default `DEFAULT_SCENARIOS`, validated
  against the tool's `SCENARIO_NAMES`); `rounds` schedule, 5 by default. Each sample is one fresh
  Playwright run of the tool's `render.perf.ts` (`THINKRAIL_PERF_RUNS=1`) under `hermeticEnv`, with
  `THINKRAIL_PERF_APP_ROOT` pointing `playwright.perf.config.ts` at the SHA worktree's `dev.ts` and
  `dist-profile`. Always Chromium: `startMainThreadProbe` needs CDP, so `--browser` does not apply.
  A missing `<scenario>-1.json` makes the scenario incompatible with the first Playwright error as
  the reason; the full log stays in the sample dir. All metrics are `timed`. Per-component rows track
  the scenario's `KEY_COMPONENTS` (from `../scenarios`) plus the union of the top 15 by self ms across
  both warmups, frozen for the measured rounds, so every sample reports the same ids (absent
  components count as zero). Browser suites run on e2e lane 15
  (`THINKRAIL_E2E_LANE`) by default, so their port block and e2e data dir never collide with
  `bun run e2e` in the same tool checkout at 15 lanes or fewer; 16 lanes include lane 15. `THINKRAIL_E2E_LANE`, `THINKRAIL_E2E_PORT_BASE`
  and `PLAYWRIGHT_BROWSERS_PATH` pass through so two compares from one tool checkout can use separate
  lanes. Browsers are looked up in the platform's default Playwright cache (`~/.cache/ms-playwright`
  on Linux); set `PLAYWRIGHT_BROWSERS_PATH` when they live elsewhere. `--cpu` throttles renders only.
- **Waterfall suite.** Opt-in (`--suite waterfall`), one variant `restore`, `rounds` schedule, 7 by
  default. Each sample is one fresh Playwright run (fresh host) of `waterfall.perf.ts` with
  `THINKRAIL_PERF_WATERFALL_OUT`; without it the spec skips, so `perf:render` ignores it. The spec seeds a
  24-turn chat with the tool's `seedWorkspaceSession`, opens it, then reloads with routing on (Playwright
  routing disables the HTTP cache, so the reload fetches every chunk) and records passively: Playwright
  WebSocket frame events and `requestfinished`, all on one Node clock from the reload. Order rows:
  `session.getMessages` sent minus the reply to the last `workspace.watchReady` for the same workspace
  sent before it (offset, plus a 1/0 "waits" flag summarized as a timed row, so its mean is the wait rate across
  rounds and its verdict comes from a CI, not one median), and the `ChatView-*.js` chunk finish minus the
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
- **Entrypoint:** `cli.ts` backs `perf:compare` (flags parsed in `args.ts`); commands `run` (implicit), `prepare`, `report`, `clean`.
  `bootstrap.sh` (remote setup) and `remoteRun.sh` (remote compare wrapper) are scripts `remote.ts`
  sends over ssh.
- **Allowed:** `../renderProfiler`, `../scenarios`, `../chatReplay`, `../stats`, type-only
  `../render.perf`, `../../processRunner`,
  `../../fixtures/*`,
  `@thinkrail/artifact-tests` (`locateDesktopLauncher`), node/bun built-ins, `@playwright/test`, the
  `ssh` and `git` binaries.
- **Forbidden:** importing app `src`; writing outside the cache root, `--out`, and per-sample temp
  state; writing `~/.thinkrail` or reading file contents there (the stat walk of the hermeticity check
  is the only access).
- Unit tests (`*.test.ts`) run under root `bun run test`; `playwright.config.ts` ignores them. The
  module typechecks with `bunx tsc --noEmit -p e2e/perf/compare` (root `typecheck` does not cover
  `e2e/`).
