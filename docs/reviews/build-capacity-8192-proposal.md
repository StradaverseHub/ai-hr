# Build capacity proposal: bounded 8192 MB `next build` heap (REVIEW ONLY)

Status: **proposal, not adopted.** Branch `claude/build-capacity-proposal`, cut from released main
`50ea247177a9fe1373d3e79d9c742f0fc399ebb7`. Authority is limited to reversible preparation and review.
Merging into `main`/`alpha`, deployment, staging, production and AI-binding changes are out of scope. If
adopted, the change needs owner review because it raises a canonical build capacity limit.

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
12 GB cap. Under that cap the garbage collector runs lazily. `main` reports 8.70 GB there and still builds at
6144, so these figures do not give the minimum heap a tree needs, and they cannot predict whether 8192 fits.
Teras adds only about 1.2% more types, 1.2% more instantiations and 89 more files than `main`, which suggests it
sits just above the 6144 line. Only a real build run settles the question (section 5).

## The patch

Commit `8576fb1fb5a2784924312b15981d81370835ca40`:

- `.github/ci/build-heap.mjs` (new): bounded admission and telemetry.
  - `admit` enforces four conditions:
    - `GITHUB_ACTIONS=true` and `CI=true`;
    - `RUNNER_ENVIRONMENT=github-hosted` (the env form of `runner.environment`);
    - `RUNNER_OS=Linux`;
    - `/proc/meminfo` MemTotal between 15 and 17 GiB (the standard public 16 GB ubuntu-24.04 class).

    It accepts exactly `AIHR_CI_BUILD_HEAP_MB=8192` and emits `node_options=--max-old-space-size=8192`, the
    profile `hosted-linux-16g-8192` and `memtotal_kib` as step outputs.
  - Refusals: any value above 8192 fails with the message "exceeds the 8192 MB ceiling; raising it needs owner
    review". Every other value (6144, 7000 and so on) is refused as unreviewed. A self-hosted runner, a non-Linux
    runner or another memory class also fails the step, which then fails the job.
  - `measure DIR -- cmd` re-checks the admitted environment. It then runs the command under `/usr/bin/time -v -o`,
    samples `MemAvailable` every 2 s, and writes `build-memory.json` with the peak RSS, the minimum MemAvailable,
    the heap and the verdict. It also writes the step summary.
  - Budget: a warning above 10 GiB peak RSS. Above 12 GiB the step fails, even when the build succeeded.
  - `assertBuildHeapEnvironment` is shared with consumers. It accepts only the exact default 6144 with no
    profile, or the exact admitted 8192 profile.
- `.github/workflows/alpha-focused-checks.yml` `linux-build`:
  - new `Admit bounded next build heap` step;
  - the build step is now `build-heap.mjs measure "$RUNNER_TEMP/next-build-memory" -- pnpm build`, with the
    step-level `NODE_OPTIONS` taken from the admission output;
  - a `next-build-memory` artifact is uploaded with `always()` after admission;
  - the resolve job's "Focused controller regression checks" now also run `build-heap.test.mjs`,
    `next-application-cache.test.mjs` and `next-build-cache-policy.test.mjs`.
- `.github/workflows/alpha-staging.yml` `build`:
  - new `Admit bounded next build heap` step;
  - only the `Canonical System Testing production build and byte bundle` step gets the step-level
    `NODE_OPTIONS` override and the admission env;
  - the job-level `NODE_OPTIONS: --max-old-space-size=6144` stays for every other step (setup, cache binding,
    uploads).
- `.github/ci/next-application-cache-protocol.mjs`:
  - `assertManagedNextInvocation` still requires `AIHR_CI_CAPACITY_PROFILE=bounded-canonical-build`, and now
    delegates the heap check to `assertBuildHeapEnvironment`;
  - `build-heap.mjs` is added to `NEXT_APPLICATION_CODE`, the publisher code identity.
- `.github/ci/next-build-cache-policy.mjs`: `validateNextContext` accepts `nodeOptions` of exactly 6144 or 8192.
  A graph is reused only when its whole context, heap included, is deep-equal (`validateNextState`), so a 6144
  graph is never reused under 8192 and the reverse is also refused.
- `.github/ci/next-application-cache.mjs`:
  - records `report.memory`: heap, profile, minimum MemAvailable, and the canonical build's peak RSS parsed from
    the GNU time output it already wrote (`/usr/bin/time -v` was already the wrapper);
  - warns above 10 GiB and fails above 12 GiB;
  - fails if the telemetry is missing;
  - the peak RSS is also recorded when the build fails, in the `next-application-build-failure` diagnostics.

What does not change (verified by `build-heap.test.mjs` and the diff):

- no `skipLibCheck`, no `typescript.ignoreBuildErrors`, and no change to `tsconfig*.json`, `next.config.ts` or
  the checked files;
- no typecheck or security step is skipped;
- the canonical log check still requires `Finished TypeScript in` and refuses
  `Skipping validation of types|error TS`.

Rollback: `git revert 8576fb1fb5a2784924312b15981d81370835ca40` (one commit) restores 6144 in both build steps,
the 6144-only protocol and policy, and removes the helper. A revert commit is enough because the helper adds no
state, migration, cache namespace or artifact name that any other path depends on.

## 1. Every `next build` entry point

| Entry point (file:line on the patched branch) | Runner | Heap before | Heap after |
|---|---|---|---|
| `.github/workflows/alpha-focused-checks.yml:200,204`: `linux-build` (`run_build=true`), plain `pnpm build`, Node 20 | GitHub-hosted ubuntu-24.04 | 6144 (former line 197) | **8192, admitted** |
| `.github/workflows/alpha-staging.yml:404,407`: `build` job → `.github/ci/next-application-cache.mjs` → `build-production.mjs --ci` → `scripts/improve/system-testing-build-cli.ts:46` `spawnSync('pnpm',['build'])` (inherits env). Triggers: dispatch, push to alpha, ready PR into alpha | GitHub-hosted ubuntu-24.04 | 6144 (job env line 357, enforced by protocol line 18 on main) | **8192 on that one step only, admitted**; job env stays 6144 |
| `.github/workflows/alpha-staging-diagnostics.yml:377`: transport-producer diagnostic build (pinned to `codex/test-suite-efficiency-review-20261025`) | GitHub-hosted | 6144 | 6144 (unchanged) |
| `.github/workflows/alpha-staging-diagnostics.yml:697,711`: `next-build-cache` diagnostic (`next-build-cache.mjs`) | GitHub-hosted | 6144 | 6144 (unchanged) |
| `.github/ci/orchestrator-browser.mjs:133`: `ai-orchestrator-walkthrough.yml:72`, production renderer build, `pnpm build` | GitHub-hosted ubuntu-24.04 | 6144 | 6144 (unchanged, see risk R5) |
| `deploy/deploy.sh:377`: staging/demo server build through `system-testing-build-cli.ts build` | Operator server (VMware guest, about 3.9 GB RAM plus about 12 GB swap) | 6144 | 6144 (unchanged; not GitHub-hosted) |
| `deploy/deploy.sh:384`: server `pnpm build` when no Testing record is selected | Operator server | 6144 | 6144 (unchanged) |
| `deploy/deploy.sh:370-372`: `AIHR_SELECTED_CI_BUILD_INSTALL`, installs the CI-built packet | Operator server | no build | no build |
| `deploy/deploy-customer.sh:18`: `exec deploy.sh --customer`, same build lines as above | Customer server | 6144 | 6144 (unchanged) |
| `deploy/DEPLOY.md:61`: documented manual small-box build | Manual | 2048 | 2048 (documentation, unchanged) |

Other heap settings checked and left unchanged:

- `.github/ci/typecheck.sh:69`: whole-repository `tsc` at **12288** with a 4 GB swapfile. This is not
  `next build`; it is unchanged and outside the 8192 mechanism.
- `scripts/improve/release.ts:80` `tscEnv`: operator `npx tsc --noEmit` at 6144 (pinned by
  `test/r417-release-gate.test.ts:93-97`).
- Native typecheck (4096) and Metro export (6144).
- Diagnostic compiler probes at 12288.

Installers:

- **Staging** installs either the CI-built packet (no build on the server) or builds on the staging server
  through `deploy/deploy.sh:377/384` at **6144**. This patch does not touch that path. A server-side build of
  the Teras tree at 6144 is therefore expected to hit the same V8 limit (see R4).
- **Production** does not build. Production packages capture `.next` and `node_modules` from the accepted
  staging build (`docs/PRODUCTION-PACKAGES.md`, step 3).
- **Customer installs** that run `deploy-customer.sh` build on the server at 6144.

## 2. Policy tests that pin 6144 or reject 8192

| File:line (main) | What it pins | Change |
|---|---|---|
| `.github/ci/next-application-cache-protocol.mjs:18` | `NODE_OPTIONS === '--max-old-space-size=6144'` | Delegates to `assertBuildHeapEnvironment`: exact 6144 (no profile), or exact 8192 with profile `hosted-linux-16g-8192`, `RUNNER_OS=Linux` and an admitted MemTotal of 15–17 GiB |
| `.github/ci/next-build-cache-policy.mjs:43` | context `nodeOptions === 6144` | Accepts exactly 6144 or 8192; reuse still needs the same heap |
| `.github/ci/next-application-cache.test.mjs:18` | rejects `NODE_OPTIONS=8192` | Unchanged: an unadmitted 8192 is still rejected. Adds: admitted 8192 is accepted; 12288, 8193, missing profile, 64 GiB MemTotal, macOS, self-hosted, a legacy capacity profile, and 6144 carrying a profile are all rejected |
| `.github/ci/next-application-cache.test.mjs:63` | a 6144 packet refuses an 8192 current context | Unchanged (still refused). Adds: an 8192 packet is accepted under an 8192 context and refused under 6144; 12288 and 8193 packets are refused |
| `.github/ci/next-build-cache-policy.test.mjs:37` | a 6144 envelope refuses an 8192 context | Unchanged (still refused). Adds: an 8192 context is valid by itself; 12288, 8193, 4096, empty and missing are refused |
| `.github/ci/next-application-test-fixtures.mjs:7` | fixture context 6144 | Unchanged; tests derive the 8192 variants from it |
| `.github/ci/build-heap.test.mjs` (new) | ceiling 8192, default 6144, budget 10/12 GiB, admission and refusals, and the workflow wiring (8192 only in `linux-build` and the canonical step; diagnostics, typecheck and native jobs have no 8192; no `skipLibCheck` or `ignoreBuildErrors`) | New |
| `test/r417-release-gate.test.ts:93-97` | operator `tscEnv` adds 6144 and respects an operator-set 8192 | Unchanged (operator tsc, not `next build`) |
| `.github/ci/build-production.test.mjs:67` (`BUILD_CAPACITY_PROFILE`) | byte-capacity profile v3 | Unchanged (archive and zip bytes, not heap) |
| `.github/ci/runner-capacity.test.mjs` (`bounded-canonical-build`) | disk floor for the canonical build | Unchanged (disk, not heap) |
| `.github/ci/diagnostics/compiler-compatible.test.mjs:9,31` | diagnostic compiler at 12288 | Unchanged |

Other hits for `6144`, `8192` and `max-old-space-size` in the repository are payload and byte limits, SQL
`chr(8192)`, or other services' own heaps. None of them is a `next build` heap.

## 3. Controller, recipe, cache keys, digests and qualifications

- **Trusted CI controller: changed.** `alpha-staging.yml`, `next-application-cache*.mjs` and
  `next-build-cache-policy.mjs` are controller code. The release verifier (`release-policy.mjs:21-22`,
  `release-ci.mjs`) accepts only runs whose controller is the head of `main` or `alpha`, with the same SHA as the
  operator's clean controller checkout. Runs from this branch can therefore never be release evidence.
- **Operator route: code unchanged.** `operator-release.mjs`, `release.ts` and `deploy.sh` are untouched. After
  adoption, the operator's controller checkout becomes the new `main` SHA, so evidence must come from runs of
  that controller.
- **Canonical build recipe: changed in heap only.** The steps, commands, `prlimit`, `time -v`, typegen,
  `build-production.mjs --ci`, bundle and packet are the same. Only the canonical step's `NODE_OPTIONS` changes.
- **Capacity profile names.** The disk profile `bounded-canonical-build` and the byte profile
  `BUILD_CAPACITY_PROFILE` v3 are unchanged. A new heap profile name, `hosted-linux-16g-8192`, is added.
- **Build-cache keys.**
  - The Turbopack `actions/cache` key (`aihr-next-compiler-v2-…`, hashed from the lockfile, configs and CSS) is
    unchanged.
  - The application compiler graph context includes `nodeOptions`, so it changes. Every existing
    `next-application-state-v1` graph and the pinned bootstrap seed (`NEXT_APPLICATION_SEED`, run 40251838329,
    6144) become unusable under 8192.
  - Adding `build-heap.mjs` to `NEXT_APPLICATION_CODE` also makes graphs published by pre-patch controllers fail
    `verifyNextPublisherTree`.
  - Effect: the first post-adoption canonical builds run cold (graceful fallback; the build always runs anyway),
    until a run under the new controller publishes a new 8192 graph.
- **Artifact digests and source manifests.** `build-provenance.json` and `BUILD_CAPACITY_PROFILE` are unchanged.
  The producer report (`comparison.json` and the `producer.json` member) gains a `memory` object, so the bytes of
  new packets differ. Heap size does not change the compiled bytes.
- **What is invalidated.**
  - No existing PASS. Earlier green canonical builds remain valid for their exact source and controller pair.
  - Teras qualifications at 6144 (41367575598 and earlier) are failures and stay failures. They are not
    relabelled.
  - Any qualification still in progress under the old controller has to finish and keep its record as it is.

## 4. Rerunning exact-source qualification under the new profile

Only after owner approval and adoption into the release controller:

1. Freeze the candidate: the Teras head, or the hotspot repair `11930f14`/`7e68eb4f` if the owner prefers it,
   rebased or merged onto the new controller so that `AIHR_CI_HEAD` and the controller are the exact intended
   pair.
2. Dispatch the normal `alpha-staging.yml` gate from the adopted `main`/`alpha` controller with
   `candidate_ref`/`expected_sha` (the authenticated CI operator route, not the focused workflow). Let every
   planned chunk finish.
3. Valid evidence:
   - The whole-repository typecheck PASS (12288, unaffected by this change) stays valid only for the same
     candidate SHA and controller. A new controller SHA means a new run by policy; it is not carried over.
   - Unit and DB test units do not depend on the build heap. Retaining them still has to go through the
     repair/resume evidence policy (`resume-source.mjs`, `repair-recovery.mjs`), because the controller differs.
   - Focused passes never authorize release.
4. The `build` job must show:
   - a successful canonical build;
   - `report.memory.verdict` of `within` or `warn`;
   - peak RSS and minimum MemAvailable recorded;
   - the packet published.

   A `fail` verdict or an OOM is recorded as a failure and must not be retried into a PASS.

## 5. Memory evidence

Proof runs use `alpha-focused-checks.yml` with `run_build=true` and `selected_tests=["test/module-gate.test.ts"]`.
The workflow is taken from the `--ref` branch, so the patched workflow runs.

| Candidate | SHA (`AIHR_CI_HEAD`) | Run | `linux-build` | Peak RSS | Min MemAvailable |
|---|---|---|---|---|---|
| `claude/build-capacity-proposal` (main + patch) | `8576fb1fb5a2784924312b15981d81370835ca40` | 41369736880 | **success** (Compiled 2.2 min, `Finished TypeScript in 3.3min`, exit 0) | 8,934,616 KiB (8.52 GiB) | 6,081,732 KiB (5.80 GiB) |
| `claude/build-capacity-proof-teras` (throwaway merge of the patch into `39c1301a`) | `496134a19a84cebb76586fdd9fa39028711c0e87` | 41369739915 | **success** (Compiled 2.2 min, `Finished TypeScript in 3.4min`, exit 0) | 9,013,112 KiB (8.60 GiB) | 5,748,976 KiB (5.48 GiB) |

Details shared by both runs:

- `AIHR_CI_HEAD` in the logs equals the SHA in the table.
- Admission recorded `github-hosted`, `Linux`, MemTotal 16,367,524 KiB (15.61 GiB) and `--max-old-space-size=8192`.
- The RSS verdict was `within` (below the 10 GiB warning budget) on both.
- Telemetry is in the `next-build-memory` artifact of each run (`build-memory.json`, `time-v.txt`).
- In both runs the resolve job's "Focused controller regression checks" passed 202 of 202, including
  `build-heap.test.mjs`, `next-application-cache.test.mjs` and `next-build-cache-policy.test.mjs`.
- `selected-tests` (`test/module-gate.test.ts`) passed.

These runs are development checks on non-release branches. They do not qualify or authorize release.

How to read this evidence:

- **Fit:** the Teras tree, which OOMs at 6144, built successfully at 8192 on a standard 16 GB hosted runner.
- **Peak RSS is not a measure of need.** `main`, which builds at 6144, also peaked at 8.52 GiB under 8192.
  V8 grows toward whatever cap it is given before collecting garbage harder. The Teras peak (8.60 GiB) is only
  about 77 MB above `main`'s, so the real margin below the 8192 cap is unknown. It is not "8 GiB minus about
  6 GiB".
- **System headroom:** the lowest observed `MemAvailable` was 5.48 GiB. Kernel-kill risk at this tree size is
  low, but the margin against the V8 cap itself is unmeasured (see R2).
- **Path not exercised:** the proof used the focused `linux-build` path (Node 20, plain `pnpm build`). The
  canonical `alpha-staging.yml` build path (Node 22.23.3, `next-application-cache.mjs` and
  `build-production.mjs`, with the new memory report) was **not** run here. It cannot be run as release
  evidence from a non-`main`/`alpha` controller. It must be proved under section 4 after any adoption.

## 6. Risks and alternatives

Risks:

- **R1. Out-of-memory kill headroom on 16 GB.** A V8 heap of 8 GiB is not the process's whole footprint: young
  generation (16–64 MB), code space, Turbopack and SWC native memory, and buffers all come on top. In addition:
  - `next build` runs Turbopack workers and the type check, so concurrent processes add up;
  - GNU time's `Maximum resident set size` is the **largest single process**, not the sum;
  - the runner agent and OS take about 1–1.5 GB;
  - the hosted image has 4 GB of swap (on the typecheck path `typecheck.sh` adds its own swapfile; the build
    jobs do not).

  If the total exceeds RAM plus swap, the kernel kills a process. That turns a clean V8 "heap limit" error into
  a SIGKILL with poorer diagnostics. Mitigations: the minimum `MemAvailable` is sampled to show system-wide
  pressure; there is a 12 GiB fail budget; 8192 is a hard ceiling that only owner review can raise. Residual
  risk: a SIGKILL can cut the telemetry short, but the exit code and signal are still recorded.
- **R2. Growth.** Raising the heap buys headroom, not a fix. With type volume growing by about 1% per feature
  merge, the next limit arrives in an unknown number of rounds. Nothing above 8192 fits a 16 GB runner safely,
  and the owner forbids larger paid runners.
- **R3. Cold cache.** The application compiler graph is cold until an 8192 publisher runs on the new controller.
  Expect slower first canonical builds. The canonical step has a 720 s timeout and the job 45 min; verify both
  on the cold proof.
- **R4. Server builds stay at 6144.** `deploy.sh` builds on the staging and customer servers at 6144 on a box
  with about 3.9 GB RAM. If the Teras tree needs more than 6144, a server-side build fails. The CI-packet install
  path (`AIHR_SELECTED_CI_BUILD_INSTALL`) avoids building on the server. Raising the server heap is a separate
  operator decision: the cap must fit RAM plus free swap.
- **R5. `orchestrator-browser.mjs:133` stays at 6144.** That walkthrough builds the harness candidate on a
  hosted runner. It will OOM on the Teras tree. This was left out deliberately, to keep the change to the two
  gate build steps. If wanted, adding it is a one-line follow-up through the same admission.
- **R6. Masking type-volume regressions.** A larger heap hides type growth. The RSS telemetry and its warning
  threshold make the growth visible; the budget should be reviewed alongside the type and instantiation counts.

Alternatives (the durable fixes):

- **TypeScript project references and composite builds.** Split `packs/*`, `core/` and `lib/` into referenced
  projects so that each compile holds one subset of the graph. This is the most effective way to cut peak
  memory. It needs a careful restructuring with ADR-level review: path aliases, Next's single `tsconfigPath`,
  and the import and drift allowlists that may only shrink.
- **Reduce type volume at the hotspots.**
  - Zod-inferred packet unions (`z.infer` over large discriminated unions). Use explicit interface types plus
    `satisfies` checks instead of re-inferring.
  - Drizzle query-builder generics. Annotate return types of shared query helpers to stop deep instantiation.
  - Wide conditional and mapped types in assistant and action packets.

  `--generateTrace` from the diagnostic runs identifies the files. `claude/teras-type-hotspots` (11930f14)
  tried this without reducing instantiations: 18,535,906 before and after.
- **Isolate the type check from the bundler.** Run the `tsconfig.build.json` check as its own step at the
  existing 12288 typecheck heap, then build without Next's own type step. Which flag or config the installed
  Next 16.3.8 offers for that is unverified here; check `node_modules/next/dist/docs/` first. Both claims,
  "types checked" and "bundle built", stay, but this changes the canonical recipe's "the build type-checks"
  contract (`Finished TypeScript in` is asserted). It needs owner review, and it is not a bypass only if the
  separate check is mandatory and bound to the same source.
- **Do nothing for Teras.** Ship Teras only after the type volume is reduced below the 6144 line. This is the
  safest, but its timeline is unknown.

Recommendation (confidence: medium):

- Both proofs fit with system headroom: Teras peak RSS 8.60 GiB, minimum MemAvailable 5.48 GiB.
- The bounded 8192 is therefore a viable **time-boxed** capacity bridge for Teras, subject to owner review of
  the raised ceiling.
- The margin against the 8192 cap itself is unmeasured, and type volume keeps growing. Pair adoption with a
  type-volume or project-reference work item, and treat a `warn` verdict as the trigger to stop relying on
  heap.
- The canonical `alpha-staging` path still needs its own proof after adoption.
- Server builds in `deploy.sh` stay at 6144 (R4), so Teras on staging should use the CI-packet install path.
