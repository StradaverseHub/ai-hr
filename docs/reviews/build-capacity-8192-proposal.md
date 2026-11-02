# Build capacity proposal: bounded 8192 MB `next build` heap (REVIEW ONLY)

Status: **proposal, not adopted.** Branch `claude/build-capacity-proposal`, cut from released main
`50ea247177a9fe1373d3e79d9c742f0fc399ebb7`. Authority is limited to reversible preparation and review.
Merging into `main`/`alpha`, deployment, staging, production and AI-binding changes are out of scope. If
adopted, the change needs owner review because it raises a canonical build capacity limit.

Code commits (both required; see section 4 for rollback):

- `8576fb1fb5a2784924312b15981d81370835ca40`: bounded admission, focused and canonical build steps, telemetry.
- `c8c6208f072a8d935da89082e6c5252afc1fe1b5`: browser orchestrator under the same profile, exact-source policy
  tests, controller test wiring, canonical step-summary telemetry.

## Problem (facts)

`pnpm build` (`next build`, which type-checks `tsconfig.build.json` because `next.config.ts:13` selects it when
`NODE_ENV=production`) runs out of memory at the canonical `--max-old-space-size=6144` on the Teras candidate
tree. `main`'s real `next build` passes at 6144.

Diagnostic `tsc -p tsconfig.build.json --noEmit --extendedDiagnostics --generateTrace` with a 12 GB heap. These
are measurements only, taken from the throwaway branch `claude/teras-build-diag`:

| Tree | Run | Memory used | Types | Instantiations | Files |
|---|---|---|---|---|---|
| main 50ea2471 | 41361153816 | 8,695,149K | 3,619,855 | 18,321,594 | 6150 |
| pre-merge Teras f3d70afb | 41361157406 | 7,561,964K | 3,657,245 | 18,516,690 | n/r |
| Teras merged 39c1301a | 41363196005 | 8,828,692K | 3,662,533 | 18,535,906 | 6239 |
| hotspot repair 11930f14 / 7e68eb4f | 41364497203 | 8,835,774K | 3,662,413 | 18,535,906 | n/r |

Qualify run 41367575598 (hotspot repair): typecheck PASS; `linux-build` OOM at about 6.0 GB under 6144.

How to read these numbers (analysis): TypeScript's "Memory used" is the heap in use at the end of a run with a
12 GB cap. Under that cap the garbage collector runs lazily, so these figures do not give the minimum heap a tree
needs. Only real build runs settle fit (section 7).

## 1. Canonical release path (Node 22 recipe and the artifact the operator installs)

Finding (facts, verified in source): the release artifact is produced by exactly one build, the `build` job of
`alpha-staging.yml`, and nothing downstream rebuilds it.

| Step | Entry point (file:line on this branch) | What happens |
|---|---|---|
| 1. Recipe | `.github/workflows/alpha-staging.yml:342-372` `build` job, `runs-on: ubuntu-24.04`, `setup-alpha` with `node: '22.23.3'`, `capacity_profile: bounded-canonical-build`; job env `NODE_OPTIONS: --max-old-space-size=6144` (line 357) | GitHub-hosted runner, Node 22.23.3, closed database URLs |
| 2. Heap admission (new) | `alpha-staging.yml:402-405` `build-heap.mjs admit` with `AIHR_CI_BUILD_HEAP_MB: '8192'` | Refuses anything except exactly 8192 on a hosted 16 GB Linux runner |
| 3. Canonical build | `alpha-staging.yml:406-412` → `.github/ci/next-application-cache.mjs:129` `command('canonical-build', … build-production.mjs --ci …)` → `.github/ci/build-production.mjs:177` (`--ci` purpose) → `build-production.mjs:123,131` `system-testing-build-cli.ts` `runTestingProductionBuild` → `scripts/improve/system-testing-build-cli.ts:46` `spawnSync('pnpm',['build'])` (inherits the step env) | Real `next build`, under `/usr/bin/time -v` and `prlimit`; `next-application-cache.mjs:138-139` refuses the build unless the log has `Compiled successfully in` and `Finished TypeScript in` and has no `Skipping validation of types` or `error TS` |
| 4. Artifact | `alpha-staging.yml:413-420` uploads `production-build-v1` (`build-artifact.mjs:7`): `system-testing.json`, `successful-build.json`, `build-provenance.json` and the byte bundle (`build-production.mjs:151-172`) | The release artifact |
| 5. Release verification | `.github/ci/operator-release.mjs:48` → `release-ci.mjs:29` `verifyCi` → `release-policy.mjs:21-22` (run must be `alpha-staging.yml`, head branch `main` or `alpha`, `head_sha` equal to the operator's clean controller) and `release-policy.mjs:40-50` (exact artifact inventory) → `release-ci.mjs:21` `inspectCiBuildPacket` | Operator's trusted controller checkout on the Mac |
| 6. Staging install | `.github/ci/staging-ci-promotion.mjs:29,40` `transferAndLaunchCiBuild` → `deploy/deploy.sh --ci-build=UUID --testing-build-record=UUID` → `deploy.sh:141-143` (pinned `/opt/node22`) → `deploy.sh:370-372` `staging-build-install.mjs stage` and `deploy.sh:483-486` `activate` | **No build on the server**; the CI bytes are installed |
| 7. Production package | `docs/PRODUCTION-PACKAGES.md` steps 2-3: capture `.next` and `node_modules` from the accepted staging build | **No rebuild** |

`build-production.mjs:40-44` also has a `release` purpose restricted to `alpha-staging.yml@refs/heads/(main|alpha)`;
no workflow or script invokes it (`git grep build-production.mjs` shows only `--ci` from `next-application-cache.mjs`).
The server-side builds in `deploy.sh:377,384` (6144) are the non-CI install path, not the release recipe.

What the patch changes on this path:

- **Trusted controller: changed.** `alpha-staging.yml`, `next-application-cache*.mjs`, `next-build-cache-policy.mjs`
  and the new `build-heap.mjs` are controller code. Runs from this branch can never be release evidence
  (`release-policy.mjs:22`). After adoption the operator's controller becomes the new `main` SHA.
- **Recipe identity: changed in heap only.** Same job, runner, Node 22.23.3, commands, `prlimit`, `time -v`, typegen,
  `build-production.mjs --ci`, bundle and packet. Only the canonical step's `NODE_OPTIONS` changes (6144 → admitted
  8192), plus the memory line in the log and step summary.
- **Cache keys.** The Turbopack `actions/cache` key (`aihr-next-compiler-v2-…`, `alpha-staging.yml:373-397`) is
  unchanged. The application compiler-graph context includes `nodeOptions` (`next-build-cache.mjs:31`), so 6144
  graphs and the pinned seed (`NEXT_APPLICATION_SEED`, 6144) are not reused under 8192; `build-heap.mjs` is in
  `NEXT_APPLICATION_CODE`, so pre-patch publishers fail `verifyNextPublisherTree`. Effect: cold canonical builds
  until a post-adoption publisher runs (the build always runs anyway).
- **Artifact digest.** The `production-build-v1` packet format is unchanged (`build-provenance.json` format 2,
  `BUILD_CAPACITY_PROFILE` v3); the heap is not recorded in it. Packet bytes differ from build to build anyway
  (random build record UUID, timestamps, runner boot hash), so no existing digest is comparable or carried over.
  The optional `next-application-state-v1` graph's `producer.json` gains a `memory` object.
- **Artifact inventory: unchanged on purpose.** `release-policy.mjs:42-45` refuses any artifact name outside the
  required set plus the two graph namespaces. The canonical path therefore records telemetry in the job log, the
  step summary and the optional graph's `producer.json`, not in a new artifact (the focused and orchestrator paths,
  which are not release evidence, upload it).

Did it run in CI without deploying? **Yes.** `alpha-staging.yml` has a `build_only` dispatch ("Canonical byte build
only; never emits a gate PASS"). `assertCiCandidateBuildInvocation` (`build-production.mjs:47-56`) accepts a
dispatch from any same-repository branch, the workflow holds no server credentials, and `deployment-hold`
(`alpha-staging.yml:603-616`) asserts `STAGING_DEPLOY_ENABLED=false` and `PRODUCTION_DEPLOY_ENABLED=false`. Run
41381652213 (section 7) exercised steps 1-4 with the patched controller on the Teras merge. Steps 5-7 cannot run
before adoption, by design: the verifier refuses non-`main`/`alpha` controllers.

## 2. Every `next build` entry point

| Entry point (file:line) | Runner | Before | After |
|---|---|---|---|
| `alpha-focused-checks.yml:197-217` `linux-build` (`run_build=true`), `pnpm build` under `build-heap.mjs measure`, Node 20 | GitHub-hosted ubuntu-24.04 | 6144 | **8192, admitted** |
| `alpha-staging.yml:402-412` canonical build (section 1), Node 22.23.3 | GitHub-hosted ubuntu-24.04 | 6144 | **8192 on that one step, admitted**; job env stays 6144 |
| `ai-orchestrator-walkthrough.yml:74-83` → `orchestrator-browser.mjs:27-31,146-147` production renderer build, Node 20 | GitHub-hosted ubuntu-24.04 | 6144 | **8192 for the `next build` child only, admitted, under `build-heap.mjs measure`** |
| `alpha-staging-diagnostics.yml:377`, `:697` diagnostic builds (pinned diagnostic branches) | GitHub-hosted | 6144 | 6144 (unchanged; not release, not the qualification recipe) |
| `deploy/deploy.sh:377`, `:384` server builds (no `--ci-build`) | Operator/customer server | 6144 | 6144 (unchanged; the hard-coded trailing flag overrides any inherited value) |
| `deploy/deploy-customer.sh:18` → `deploy.sh --customer` | Customer server | 6144 | 6144 (unchanged) |
| `deploy/DEPLOY.md:61` documented manual small-box build | Manual | 2048 | 2048 (documentation) |

Other heap settings, unchanged: `.github/ci/typecheck.sh:69` whole-repository `tsc` at 12288 (not `next build`);
`scripts/improve/release.ts:80` operator `tsc` at 6144; native typecheck 4096; Metro export 6144; diagnostic
compiler probes 12288.

## 3. The bounded profile (identical everywhere it applies)

`hosted-linux-16g-8192`, defined once in `.github/ci/build-heap.mjs`:

- **Runner class.** `admit` and every consumer assert `GITHUB_ACTIONS=true`, `CI=true`,
  `RUNNER_ENVIRONMENT=github-hosted`, `RUNNER_OS=Linux`, and `/proc/meminfo` MemTotal 15-17 GiB (observed
  16,367,524 KiB on every run). Self-hosted, macOS, Windows, larger or smaller machines fail the step.
- **Hard ceiling 8192.** `assertRequestedHeapMb`: above 8192 fails with "exceeds the 8192 MB ceiling; raising it
  needs owner review"; any other value (6144, 7168, padded, decimal) is refused as unreviewed.
- **Consumers.** `assertBuildHeapEnvironment` (canonical protocol and `measure`) accepts only exact 6144 with no
  profile, or exact 8192 with the profile and an admitted MemTotal on the admitted runner class.
  `admittedBuildNodeOptions` (orchestrator child) returns exactly 6144 without admission, exactly 8192 with it, and
  fails closed on a partial or mixed admission. `validateNextContext` accepts only those two strings; a graph is
  reused only under an identical heap.
- **Where it applies.** Exactly three admitting workflows, each with one admission requesting `'8192'` in one
  `ubuntu-24.04` job (pinned by `build-heap.test.mjs`). No workflow may contain any heap value above 8192 or the
  string `self-hosted`.
- **Telemetry and budget.** Peak RSS is GNU time `Maximum resident set size` (largest single descendant process,
  not the sum); minimum `MemAvailable` is sampled. Budget: warn above 10 GiB, fail above 12 GiB even when the build
  succeeded; missing telemetry fails. Focused and orchestrator paths write `build-memory.json` and `time-v.txt`
  (artifacts `next-build-memory` and `orchestrator-production-renderer-development-evidence`); the canonical path
  writes the log line, the step summary and `producer.json.memory` (section 1 explains why no artifact).
- **Refusing elsewhere.** Any other runner fails `admit`; an unadmitted 8192 fails the canonical protocol; server
  builds keep a hard-coded 6144.

## 4. Rollback (exact)

Verified in a scratch worktree: reverting both code commits on `c8c6208f` leaves `.github`, `deploy` and `scripts`
byte-identical to main `50ea2471` (`git diff --stat 50ea2471 -- . ':!docs'` empty).

- If adopted as a squash (recommended, so adoption is one commit): `git revert --no-edit <squash-sha>`.
- If adopted as these commits, one rollback commit:
  `git revert --no-commit c8c6208f072a8d935da89082e6c5252afc1fe1b5 8576fb1fb5a2784924312b15981d81370835ca40 && git commit -m "Revert bounded 8192 next build heap; restore 6144"`.

The helper adds no state, migration, cache namespace or artifact name that another path depends on. After a
rollback, 8192 graphs published meanwhile are refused by the restored 6144-only policy (cold build, not a failure).

## 5. Exact-source policy tests

| Test | Accepts | Rejects |
|---|---|---|
| `build-heap.test.mjs` | admitted 8192 on hosted 16 GB Linux; default 6144 | 8193, 12288, 16384, 999999, 6144/7000/4096 as requests, padded/decimal; self-hosted, macOS, Windows, non-Actions; MemTotal 7, 15-ε, 17+ε, 32, 64 GiB; stacked flags; profile on 6144; partial admission; ceiling/default/budget constants changed |
| `build-heap.test.mjs` workflow inventory | exactly `ai-orchestrator-walkthrough.yml`, `alpha-focused-checks.yml`, `alpha-staging.yml` admit, each once, `'8192'`, in one `ubuntu-24.04` job without `container:`/`services:` | any other admitting workflow; any heap above 8192 in any workflow; `self-hosted`; 8192 in typecheck, native, selected-tests or diagnostics; `skipLibCheck`/`ignoreBuildErrors`; orchestrator source with a literal heap |
| `next-application-cache.test.mjs` (invocation) | default 6144; admitted 8192 | unadmitted 8192; 12288, 8193, 7168, 16384, `8192 ` , `08192`, stacked flags, `6144 … 8192`; other profile names; missing/8 GiB/64 GiB/padded MemTotal; missing or other runner/OS/Actions; legacy capacity profile |
| `next-application-cache.test.mjs` (graph reuse) with fixtures `applicationStateFixture({}, {nodeOptions})` (`next-application-test-fixtures.mjs`) | 6144 graph under 6144; 8192 graph under 8192 | 6144 graph under 8192 and the reverse; 12288, 8193, 16384, 7168, 4096, padded, stacked, empty, missing |
| `next-build-cache-policy.test.mjs` | 6144 or 8192 context | 12288, 8193, 16384, 7168, 4096, whitespace, `08192`, stacked, underscore spelling, empty, missing, numeric; cross-heap reuse |
| `orchestrator-browser.test.mjs` | 6144 without admission; 8192 with admission; closed DB URLs | self-hosted, macOS, other profile, 64 GiB, missing MemTotal, partial admission; inherited 16384 never reaches the build child |

Mutation check (local, scratch copy): setting the walkthrough request to 8193, the ceiling to 12288, the canonical
job to `[self-hosted, linux]`, a literal 8192 in the orchestrator, or adding 12288 to the cache policy each made
the suite fail.

Where they run on Actions: `alpha-focused-checks.yml:87-88` "Focused controller regression checks" (now including
`orchestrator-browser.test.mjs`), `alpha-staging.yml:87-88` "CI integrity regression checks" (now including
`build-heap.test.mjs`, `next-build-cache-policy.test.mjs`, `orchestrator-browser.test.mjs`), and
`ai-orchestrator-walkthrough.yml:40`. Results: section 7.

Not changed: `test/r417-release-gate.test.ts:93-97` (operator `tsc`), `build-production.test.mjs`
`BUILD_CAPACITY_PROFILE` (bytes), `runner-capacity.test.mjs` (disk), `diagnostics/compiler-compatible.test.mjs`
(12288 compiler).

## 6. Requalification plan (only after owner approval and adoption)

1. Adopt as one squash commit into the release controller (`main`, then aligned `alpha`) under owner review.
2. Freeze the candidate: the Teras head (or the hotspot repair, if the owner prefers it) merged onto the adopted
   controller, so that `AIHR_CI_HEAD` and the controller are the intended pair.
3. Dispatch the full `alpha-staging.yml` gate from the adopted controller with `candidate_ref`/`expected_sha` (the
   authenticated CI operator route, not `build_only`, not focused). Let every planned chunk finish.
4. The `build` job must show `Compiled successfully` and `Finished TypeScript`, a `within` or `warn` memory verdict,
   peak RSS and minimum `MemAvailable` in the log and summary, and a published `production-build-v1`. `fail` or OOM
   is a failure and is not retried into a PASS.
5. Then the normal operator route: `operator-release.mjs` verification, staging install of the CI packet,
   acceptance, and only then package capture.

Evidence validity:

- **Invalidated for release:** nothing that was a PASS becomes a FAIL, but no existing evidence carries over to the
  new controller. Typecheck, unit, DB and browser units are heap-independent, yet the controller SHA differs, so
  retention needs the repair/resume evidence policy (`resume-source.mjs`, `repair-recovery.mjs`) or a fresh run.
- **Failures stay failures:** Teras qualifications at 6144 (41367575598 and earlier) are not relabelled.
- **Digests:** packet digests are per build and are never carried over; the 6144 graph seed and graphs are
  unusable under 8192 (cold build expected; run 41381652213 took 7 min 6 s cold, inside the 720 s step limit).
- **The proof runs below are development evidence only.** They are not release evidence and do not qualify.

## 7. Evidence

All runs: standard GitHub-hosted ubuntu-24.04, admission `github-hosted`/`Linux`, MemTotal 16,367,524 KiB
(15.61 GiB), `--max-old-space-size=8192`, profile `hosted-linux-16g-8192`, `AIHR_CI_HEAD` equal to the SHA shown.

| Run | Path | Controller | Candidate (`AIHR_CI_HEAD`) | Build | Peak RSS | Min MemAvailable |
|---|---|---|---|---|---|---|
| 41369736880 | focused `linux-build` | 8576fb1f | main + patch 8576fb1f | success | 8,934,616 KiB (8.52 GiB) | 6,081,732 KiB |
| 41369739915 | focused `linux-build` | 496134a1 | Teras merge 496134a1 | success | 9,013,112 KiB (8.60 GiB) | 5,748,976 KiB |
| 41380900334 | focused `linux-build` | c8c6208f | main + patch c8c6208f | success (Compiled 2.2 min, TypeScript 3.3 min) | 8,812,752 KiB (8.40 GiB) | 5,835,644 KiB |
| 41380903331 | focused `linux-build` | ffd33f2b | Teras merge ffd33f2b | success (Compiled 98 s, TypeScript 2.3 min) | 9,092,288 KiB (8.67 GiB) | 5,990,220 KiB |
| **41381652213** | **canonical `alpha-staging.yml` `build_only`, Node 22.23.3** | c8c6208f | **Teras merge ffd33f2b** | **success**; cold (graph lookups failed: `gh` timeouts, seed refused); canonical-build 7 min 6 s; `production-build-v1` 274,435,193 bytes `sha256:9c53214c…57719cc`; `deployment-hold` success | 9,115,456 KiB (8.69 GiB) | 5,386,920 KiB |
| 41381655480 | `ai-orchestrator-walkthrough.yml` | c8c6208f | main + patch c8c6208f | `production-build` phase **success** (286 s); job **failure** later at `migrate-fictional-database` (exit 1, 4 s) | 8,822,540 KiB (8.41 GiB) | 6,200,880 KiB |
| 41382858043 | `ai-orchestrator-walkthrough.yml` control, unpatched workflow | main 50ea2471 | main 50ea2471 | `production-build` phase success at 6144 (477 s); job **failure** at `migrate-fictional-database` (exit 1, 6 s), same last notice (migration 0749) | n/a (6144, no telemetry on main) | n/a |

All verdicts `within` (below the 10 GiB warning). Controller tests: focused resolve 233/233 on both 41380900334 and
41380903331 (202 before this round); canonical resolve "CI integrity regression checks" 692/692 plus the Python and
staging suites in 41381652213; `selected-tests` (`test/module-gate.test.ts`) passed on both focused runs.

Orchestrator failure (analysis): the build finished and exited 0 before PostgreSQL started; the migration process
uses the normal database environment, not the build heap. `drizzle-kit migrate` printed no error text, only
notices through migration 0749. Control run 41382858043 on unpatched main (6144, no heap code) fails at the same phase with the same last notice, so the migration failure is pre-existing on main and independent of this patch. It is not relabelled: the walkthrough job is a failure, and only its `production-build` phase is evidence here. Diagnosing the 0749-or-later migration on a fresh fictional database is a separate item (the error text is suppressed by `drizzle-kit`; rerun `scripts/migrate-with-focused-prerequisites.ts` with verbose output on a disposable database).

How to read this evidence:

- **Fit:** the Teras tree, which OOMs at 6144, built successfully at 8192 on standard 16 GB hosted runners in both
  the focused recipe and the canonical Node 22 release recipe.
- **Peak RSS is not a measure of need.** `main`, which builds at 6144, also peaked around 8.4-8.5 GiB under 8192:
  V8 grows toward its cap before collecting harder. The Teras margin below the 8192 cap is unmeasured.
- **System headroom:** lowest `MemAvailable` observed 5.39 GiB (canonical, Teras). Kernel-kill risk at this size is
  low; V8-cap margin is unknown (R2).
- **Canonical artifact:** the `production-build-v1` packet from 41381652213 is from a non-`main` controller and can
  never be installed or used as release evidence (`release-policy.mjs:22`); it expires after one day.

## 8. Risks and alternatives

- **R1. Out-of-memory kill headroom.** V8 8 GiB is not the whole footprint (young generation, code space, Turbopack
  and SWC native memory, workers); the runner OS takes about 1-1.5 GB; build jobs add no swap. Mitigations: sampled
  `MemAvailable`, 12 GiB fail budget, hard ceiling. Residual: a SIGKILL can truncate telemetry (exit and signal are
  still recorded).
- **R2. Growth.** A larger heap buys headroom, not a fix. Nothing above 8192 fits a 16 GB runner safely and the owner
  forbids larger paid runners. Treat a `warn` verdict as the trigger to stop relying on heap.
- **R3. Cold cache.** Confirmed: the canonical proof was cold and took 7 min 6 s against a 720 s step limit, about
  1 min 54 s of headroom on this tree. Monitor after adoption; a growing tree can reach the limit.
- **R4. Server builds stay at 6144.** `deploy.sh:377,384` builds on a server with about 3.9 GB RAM plus swap. The
  Teras tree is expected to fail there; use the CI-packet install (`--ci-build`). Raising the server heap is a
  separate operator decision.
- **R5. Orchestrator (resolved this round).** The walkthrough now uses the same profile; its build fits (8.41 GiB on
  main + patch). Its later migration failure is outside the heap change (section 7).
- **R6. Masking type-volume regressions.** Telemetry and the warning make growth visible; review the budget with
  type and instantiation counts.
- **R7. Shared graph discovery.** Graph lookup reads the latest three `next-application-state-v1` artifacts
  repository-wide (`next-application-cache.mjs:33`). The `build_only` proof published one 8192 graph (356,057 bytes,
  one-day retention). Current main-controller builds refuse it (6144 context, different publisher code) and fall
  back to a cold build if it displaces a usable graph. This is a performance effect only; no extra build-only proofs
  were run for that reason.

Alternatives (durable fixes):

- **TypeScript project references and composite builds** for `packs/*`, `core/` and `lib/`: most effective for peak
  memory; needs ADR-level review (path aliases, Next's single `tsconfigPath`, shrink-only allowlists).
- **Reduce type volume at hotspots:** explicit interfaces plus `satisfies` instead of re-inferring large Zod unions;
  annotated return types on shared Drizzle helpers; narrower conditional and mapped types in assistant packets.
  `claude/teras-type-hotspots` (11930f14) did not reduce instantiations (18,535,906 before and after).
- **Separate type check from the bundler** at the existing 12288 typecheck heap: changes the canonical "the build
  type-checks" contract (`Finished TypeScript in` is asserted); owner review required; Next 16.3.8 support unverified.
- **Do nothing for Teras** until type volume falls below the 6144 line: safest; timeline unknown.

Recommendation (confidence: medium): the bounded 8192 profile is a viable **time-boxed** capacity bridge for Teras.
It is now one profile across every hosted `next build`, the canonical Node 22 recipe built the Teras tree with
5.39 GiB system headroom, and a two-commit (or one squash) revert restores 6144 exactly. The V8-cap margin is
unmeasured and the tree keeps growing, so pair adoption with a type-volume or project-reference work item. Release
qualification still requires the section 6 rerun from the adopted controller.
