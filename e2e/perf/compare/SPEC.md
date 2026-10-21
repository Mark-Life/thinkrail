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
- **Suites.** A `Suite` declares its artifacts, whether it drives a browser, a `Schedule`, its variants,
  and `sample()`. The core never imports a suite by name: adding one is a file plus a line in
  `suites.ts`. A sample receives a `SuiteContext` with its own `sampleDir`; `hermeticEnv(stateDir)`
  gives it fresh `HOME`, data, pi, and XDG dirs, `PI_OFFLINE=1`, analytics off, and `CI=1`.
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
- **Output.** `<out>/compare.json` (`CompareResult`) and `<out>/compare.md`; `--json-only` skips the
  markdown. Rows with verdict `same` collapse into `<details>`; ▮ marks 5/10/20/50% tiers.
  `report <compare.json>` re-renders markdown. Per-sample files live under `<out>/samples/`.
- **Hermeticity check.** The `~/.thinkrail` mtime is compared before and after; a change is a warning,
  not an abort, because a running ThinkRail on the same machine also writes there.

## Boundary

- **Public surface (barrel):** `runCompare`, `renderReport`, `SUITES`, `type Artifact`,
  `type CompareOptions`, `type CompareResult`, `type Measurement`, `type MetricSummary`,
  `type SampleResult`, `type Schedule`, `type Side`, `type Sha`, `type Suite`, `type SuiteContext`
- **Entrypoint:** `cli.ts` backs `perf:compare`; commands `run` (implicit), `prepare`, `report`, `clean`.
- **Allowed:** `../renderProfiler`, `../scenarios`, `../../processRunner`, `../../fixtures/*`,
  node/bun built-ins, `@playwright/test`.
- **Forbidden:** importing app `src`, writing outside the cache root, `--out`, and per-sample temp
  state, and reading or writing `~/.thinkrail`.
- Unit tests (`*.test.ts`) run under root `bun run test`; `playwright.config.ts` ignores them. The
  module typechecks with `bunx tsc --noEmit -p e2e/perf/compare` (root `typecheck` does not cover
  `e2e/`).

## Not yet built

Renders, startup and waterfall suites; remote hosts (`--host` accepts `local` only); the
`THINKRAIL_PERF_APP_ROOT` and `THINKRAIL_PERF_BROWSER` switches in `playwright.perf.config.ts`.
