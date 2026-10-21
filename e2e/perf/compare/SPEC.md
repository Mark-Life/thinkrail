---
id: submodule-perf-compare
type: submodule-design
status: active
title: perf:compare — A/B performance comparison of two commits
parent: module-browser-e2e
tags: [testing, performance, public-surface-checked]
---

## Responsibility

`bun run perf:compare <base> <head>` measures two commits on each selected host (local by default) and
reports the difference. It is an opt-in measurement tool, never a gate: no CI wiring, no budgets, no
history store. The checkout running the command (the tool) drives a per-SHA app build of each side, so
the measuring harness is identical for both sides and only the app under test differs.

## Model

- **Cache.** `~/.cache/thinkrail-perf/` (`THINKRAIL_PERF_CACHE` overrides). `repo.git` is a bare repo
  whose alternates point at the tool's git common dir, so no worktree registers in the shared repo and
  parallel agents never see cache worktrees. `wt/<sha>` is a detached worktree of it.
- **Prepare.** Under a per-SHA lock, each SHA gets `bun install --frozen-lockfile`, then each selected
  `Artifact` builds in its worktree. In `.perf-built.json` the install entry keys on lockfile hash and Bun
  version; each artifact entry keys on Bun version and the artifact's `cwd` plus build argv, so the key
  cannot drift from the command. `--rebuild` ignores it. A failed install or build is never reused. A failed artifact build marks the suites that need it
  incompatible; the other suites run. Builds get an allowlisted environment, never the caller's
  `THINKRAIL_*`/`XDG_*`.
- **Use marks.** A running compare marks each SHA it samples. `--rebuild`, `clean <ref>` and
  `clean --all` refuse while another live process uses the SHA.
- **Artifacts.** `profile-web` (`build:profile`), `manifest-web` (`vite build --manifest` into its own
  gitignored `perf-manifest/dist` so `build:binary` cannot clobber it and Tailwind never scans a previous
  build's output on rebuild), `binary` (`build:binary`), `desktop` (`desktop:build`, darwin
  only). Each builds once per (SHA, key) from the union over selected suites.
- **A/A.** When base and head resolve to one SHA, it is prepared and marked once and both sides
  sample it as separate runs on the same schedule. Per-side state is keyed by side, never by SHA.
- **Suites.** A `Suite` declares its artifacts (a list, or a function of the options so opt-in variants
  build only when selected), a `Schedule`, its variants and `sample()`; an `optIn` suite runs only when
  named in `--suite`; optional `annotate()` adds suite-specific fields to the summarized metrics. The
  core never imports a suite by name: adding one is a file plus a line in
  `suites.ts`. Each sample gets its own `sampleDir`; `hermeticEnv(stateDir)` gives it fresh `HOME`,
  data, pi and XDG dirs, `PI_OFFLINE=1`, analytics off, and `CI=1`.
- **Schedule.** `once` takes one sample per side. `rounds` and `auto` first run one discarded warmup per
  side and variant, then alternate ABBA. `auto` stops after `minRuns` once every timed metric of the
  still-sampling variants is settled, or at `maxMinutes`. A timed metric is settled when its verdict is
  not `unsure` or its CI half-width is at most 2%; without the width rule an unchanged metric at
  `--threshold 0` stays `unsure` and every run hits the cap. Load above one per core is a warning.
- **Compatibility.** A variant whose first sample on a side fails is excluded from both sides with its
  reason; a suite where every variant fails is reported incompatible and the other suites run. A later
  failure is transient: retried once, then the round is skipped with a warning; after 3 failed rounds
  the variant stops and keeps its data. Only an interrupt or `ENOSPC` aborts the run. A
  `PROTOCOL_VERSION` difference is a warning, because it changes in most feature PRs.
- **Statistics.** Exact metrics (sizes, counts) compare medians; any change beyond `--threshold` is
  `better`/`worse`. Timed metrics report a 95% CI of the relative difference of means: ratio
  `R = mean(head)/mean(base)`, delta-method variance `R²·(s_h²/(n_h·m_h²) + s_b²/(n_b·m_b²))`,
  Welch–Satterthwaite df, Student t. The CI wholly beyond `±threshold` gives `better`/`worse`, wholly
  inside gives `same`, otherwise `unsure`. At `--threshold 0` an unchanged timed row reads `unsure` with
  a narrow CI; pass a threshold to fold such rows. When exactly one side's mean is zero the verdict
  comes from the Welch difference CI. A renders component `selfMs` row that is `better`/`worse` while
  that component's `renders` and `commits` rows are unchanged (`same`, or `unsure` with equal medians)
  gets `timingOnly: true`: the time moved but the render work did not. Offset metrics (signed gaps where a ratio is meaningless) report
  the difference of means with a Welch 95% CI in the metric's unit; the threshold does not apply.
- **Remote hosts.** `--host` (repeatable: `local` or an ssh alias) runs the compare on each host in
  parallel. Aliases that resolve to this machine run once, locally, so one machine never runs two timed
  compares at once. Before any ssh, the tool tree must be clean and base, head and the tool SHA must be
  on `origin`. `bootstrap.sh` keeps a remote cache clone, checks out the tool SHA, installs, and
  installs missing Playwright browsers into the user cache (never system deps). The ssh command puts
  `~/.bun/bin` on `PATH` and fails fast when `bun` is missing. The host then runs `perf:compare
  <baseSha> <headSha> --host local` with the caller's measurement flags passed through unchanged, under
  `remoteRun.sh`, which kills the compare's process group when ssh's stdin closes. `compare.json` is
  copied back, refs are restored to the local names, and `<out>/<host>/compare.{json,md}` plus a
  combined `<out>/compare.md` are written. A failed host does not stop the others; the run then exits 1.
- **Output.** `<out>/compare.json` (`CompareResult`, every metric) and `<out>/compare.md`. Base/Head
  cells show medians for exact rows and means for timed and offset rows. The markdown shows only rows
  whose verdict is not `same`, plus a count of unchanged rows per group; ▮ marks 5/10/20/50% tiers. A
  local compare where no suite produced a metric exits 1. A `timingOnly` row's verdict reads
  `worse (timing only)` with a one-line legend under the suite. When both sides are one SHA the header
  says it is an A/A run, so every `better`/`worse` row is a false positive. Per-sample files live under `<out>/samples/`.
- **Hermeticity check.** Every entry under `~/.thinkrail` is stamped (mtime and size) before and after;
  a change is a warning, not an abort, because a running ThinkRail on the same machine also writes there.
- **Bundle suite.** One sample of the `manifest-web` build. Initial JS, initial CSS and per-type totals
  report raw, gzip and brotli; per-chunk and per-CSS rows report gzip only. Content hashes are masked
  before compression so a renamed import does not change a size.
- **Startup suite.** Variants from `--startup` (default `cli,server`; `binary` and `desktop` opt in and
  add their artifact). Every spawn runs from an empty `cwd` under `hermeticEnv`, in its own process
  group. `cli` times `--version`; `server` times the source CLI to its `thinkrail →` line and to
  `/health` 200; both run with a cold and a warm transpiler cache (warm state per side). `binary` times `--version` and `/health` of the
  compiled CLI with cold and warm asset staging. `desktop` (macOS) times the dev launcher to webview
  `dom-ready`. Schedule is `auto`. Signal handlers kill a live startup group, because a detached group
  never sees the terminal's Ctrl-C.
- **Renders suite.** One variant per scenario (`--scenario`, default `DEFAULT_SCENARIOS`, validated by
  `parseScenarios`); `rounds` schedule, 5 by default. Each sample is one fresh Playwright run of
  `render.perf.ts` against the SHA's `dist-profile`. Always Chromium: the main-thread probe needs CDP,
  so `--browser` does not apply. All metrics are `timed`. Per-component rows track the scenario's
  `KEY_COMPONENTS` plus the top 15 by self ms across both warmups, frozen for the measured rounds, so
  every sample reports the same ids. `--cpu` throttles renders only.
- **Waterfall suite.** Opt-in, one variant `restore`, `rounds` schedule, 7 by default. Each sample
  seeds a 24-turn chat, opens it, then reloads with routing on (which disables the HTTP cache) and
  records WebSocket frames and finished requests on one clock. Order rows: `session.getMessages` sent
  minus the reply to the last `workspace.watchReady` for the same workspace (offset, plus a 1/0 "waits"
  flag as a timed row, so its mean is the wait rate), and the `ChatView-*.js` chunk finish minus the
  `getMessages` reply. Timing rows add composer typeable and first message painted. Layout rows count
  shifts after the composer is typeable: on Chromium the `layout-shift` sum, max, count and per-region
  scores (`SHIFT_REGIONS`); on WebKit the largest per-frame move of the composer, scroller and last row
  in scroll-compensated coordinates. `--browser` applies.
- **Lanes.** Browser suites run on e2e lane 15 (`THINKRAIL_E2E_LANE`) by default, so they do not collide
  with `bun run e2e` at 15 lanes or fewer. `THINKRAIL_E2E_LANE`, `THINKRAIL_E2E_PORT_BASE` and
  `PLAYWRIGHT_BROWSERS_PATH` pass through so two compares from one checkout can use separate lanes.

## Boundary

- **Public surface (barrel):** `runCompare`, `renderReport`, `SUITES`, `type CompareOptions`,
  `type CompareResult`
- **Entrypoint:** `cli.ts` backs `perf:compare` (flags parsed in `args.ts`); commands `run` (implicit),
  `prepare`, `clean`. `bootstrap.sh` and `remoteRun.sh` are scripts `remote.ts` sends over ssh.
- **Allowed:** `../renderProfiler`, `../scenarios`, `../chatReplay`, `../stats`, type-only
  `../render.perf`, `../../processRunner`, `../../fixtures/*`, `@thinkrail/artifact-tests`
  (`locateDesktopLauncher`), node/bun built-ins, `@playwright/test`, the `ssh` and `git` binaries.
- **Forbidden:** importing app `src`; writing outside the cache root, `--out`, and per-sample temp
  state; writing `~/.thinkrail` or reading file contents there (the stat walk of the hermeticity check
  is the only access).
- Unit tests (`*.test.ts`) run under root `bun run test`; `playwright.config.ts` ignores them. The
  module typechecks with `bunx tsc --noEmit -p e2e/perf/compare` (root `typecheck` does not cover
  `e2e/`).
