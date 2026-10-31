# CI build efficiency and deployment boundaries

The isolated branch now has independently verified canonical Linux build-byte transport and Next application compiler-state reuse. The normal review workflow now prepares a mandatory canonical build packet under [current policy](CI-CANONICAL-BUILD-PROTOCOL.md). That source integration is not yet exercised as a complete normal gate. The [normal application compiler cache](NORMAL-NEXT-APPLICATION-CACHE.md) and bounded build capacity are now also integrated in source, with actual normal execution still pending. Normal authenticated promotion and complete release adoption remain unfinished. The original optional Turbopack cache below has no measured cold/warm result; it is separate from the newly verified application TypeScript state.

## Capacity-aware normal suite preparation — hosted setup verified, full gate pending

Normal first-attempt test, browser and controller jobs now select a bounded suite setup on the isolated review branch. The existing test admission remains **20 GiB**. Setup requires **24 GiB before dependency installation**, then checks **21 GiB after all web and native dependencies**, and again after PDF/browser tooling. The extra GiB allows a possible database image pull before the existing admission check. These thresholds are capacity requirements, not measured peak guarantees.

Measure the minimum free space across the actual checkout, runner temporary directory and the Docker daemon's reported data filesystem. Validate the exact hosted repository/workflow/job/controller scope before any Docker inspection or SDK cleanup. Delete only unused fixed Android, then Haskell, then .NET SDK directories, stopping as soon as the floor is met. Preserve the original complete dependency scope, all test cases, workers, database resources, browser engines and compiler/build requirements. Reruns retain legacy preparation; compiler/build profiles are unchanged. A failed measurement or insufficient final capacity refuses the job.

[Hosted pilot40272063969](https://github.com/StradaverseHub/ai-hr/actions/runs/40272063969) passed on exact source/controller `a629b54a0e5111203d5a4fbf87578d048519baf5`, first attempt, included standard Ubuntu24 runner. The real composite setup took **42.643 s** in capacity preparation, deleting Android in about39 s and Haskell in about2 s, then retained the6,166,843,392-byte .NET installation. Earlier separate canonical producer40238663818 spent99.027 s in unconditional preparation. That is an observed56.384 s reduction for this component on separate runners, not a guaranteed saving for every job.

Full web dependency installation6.059 s and native/mobile installation9.594 s remained present. After installation, the actual source, temporary and Docker filesystems each had27,233,206,272 bytes (**25.36 GiB**) free; the post-dependency check took0.178 s without further deletion. This proves this setup margin, not peak capacity during application tests, browser installation or database operation; the unchanged20 GiB admission and later tooling checks still enforce capacity.

The resolve job passed244 Node controls, including both new capacity/refusal groups, and46 Python controls. Only resolve, runner-diagnostics and the explicit deployment hold executed; all application/compiler/build/database/browser/verification jobs were skipped. Whole submission-to-last-job elapsed was155.461389 s and total occupied job time152 s (2.53 minutes), not authoritative billing. The authenticated resource artifact12628872110 is1,013 bytes, ZIP SHA256 `76fef5ea617a266f1f21b80e40c5cbf1c58e9318007627667838fb5e5488b2b7`, with exactly the resources JSON and preparation log. Raw API, job logs and archive are retained in ignored `scratchpad/suite-capacity-20261026/`.

The pilot used closed database URLs, a five-minute diagnostic timeout and no Mac slot. It establishes real full dependency setup through the normal composite action; it is not a normal complete gate, build, staging deployment or release baseline. Full browser/PDF/database capacity and the complete under600-second release still require actual validation. Before this dispatch the real billing UI showed2,902/3,000 included minutes used and0 USD billable; do not launch the historical full matrix against that98-minute remainder.

## Focused-job capacity adoption and peak-group measurement

The focused development workflow now uses the same measured24/21 GiB setup margins on its first attempt, with the original20 GiB test admission unchanged. Scope is restricted to its actual manual selected-tests job/company repository/controller identity and four closed database URLs before preparation; reruns retain legacy cleanup. Full web/native dependencies, all selected cases, two workers and2 GiB PostgreSQL/JIT on remain required. Its resolver now runs the capacity-refusal controls on pinned Node22.23.3 before expensive work. Actual focused execution of this extension is pending.

The next measurement uses all50 files in the actual balanced group db-df1bab045c5059d9, whose1,024.961 s summed advisory weight is largest. It retains the exact unit membership, including all88 r395 write-equivalence cases and49 other files; this focused run will remain development evidence, not a normal complete matrix or release receipt. Full git history stays present: direct source inspection found real baseline-commit reads in r400, r413 and r415 test files elsewhere in the complete inventory. Shortening every test checkout would break that coverage; transitive requirements need further assessment before a selective change.

Fresh read-only GitHub billing on26 October MYT showed2,925/3,000 included minutes used,75 remaining and0 USD billable, reset6 days away. No settings changed. Keep this measurement to one included standard runner; full-matrix cost remains a separate unresolved constraint.

## Avoiding cache-discovery starvation

Both normal graph readers now discover at most three exact-name artifacts using the [repository artifact index](https://docs.github.com/en/rest/actions/artifacts#list-artifacts-for-a-repository). The prior three-workflow-run window could contain only successful controller/resource diagnostics and miss an older graph publisher. Actual read-only API inspection found two retained whole-compiler graph artifacts while recent normal runs had no compiler publisher; no normal application graph exists yet. Finding an artifact is not accepting it: all original job/controller/code/digest/age/input gates and mandatory compilation remain. Private transport/controller verification passed at5c099aca5/run40276417297; actual cache reuse on this new source still requires its own execution.

GitHub's current [private standard Linux specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) are two CPUs/eight GB RAM for x64 and ARM; the normal two-worker choice matches those documented cores. These are documented specifications, not new actual VM hardware telemetry. Changing architecture does not grant extra included CPUs.

## Current measured application compiler result — 26 October 2026 MYT

The [application-state diagnostic](NEXT-APPLICATION-COMPILER-CACHE.md) retained the real 297.573 s canonical build despite a later collector failure, repaired only the typed launcher/missing state capture, then genuinely built on a fresh runner in 191.107 s using authenticated state. Actual Next printed TypeScript 2.3min → 26.6s; all 2,709 tracked application roots remain in 4,617 graph files, and real dependency/new-root refusals plus restored-source success passed. The first failed workflow stays red. Whole warm diagnostic 340.647 s includes four extra compiler controls and is not a test gate, normal workflow or staging release. Bounded build capacity retained at least 9.13 GiB sampled build disk headroom while skipping SDK deletion. No normal build/test admission or main/live deployment was enabled. See the linked provenance and scope before reuse.

## Verified setup

The candidate and installed framework are Next.js 16.3.8. Its installed documentation and configuration default enable Turbopack build filesystem caching at `.next/cache/turbopack`; a fresh CI runner must explicitly restore that directory to benefit. See [Next build caching](https://nextjs.org/docs/app/guides/ci-build-caching) and [Turbopack filesystem caching](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache).

The repository cache API observation returned three entries totaling 662,708,199 bytes. All three were pnpm dependency caches in separate branch scopes; none was a Next compiler cache. This is a dated observation, not a permanent cache inventory. No storage limit, billing setting or existing cache was changed.

The review build job now produces a canonical System Testing Linux build packet; earlier normal generic-build runs did not establish that identity. The standard local `scripts/improve/release.ts` path checks complete TypeScript locally before invoking the remote deployment build. The CI operator path instead validates the complete CI witness, including its compiler job, and invokes the canonical remote build through the frozen source's official helpers. These are distinct environments and claims. Removing a build or copying output between them requires validated replacement evidence; a successful generic CI build does not establish staging build identity or arrival.

## Prepared optional compiler cache

Only the `build` job in the review version of `.github/workflows/alpha-staging.yml` changes:

- Cache only `source/.next/cache/turbopack`, leaving complete output, server/static assets, runtime data, environment files and dependency installations outside this cache.
- Pin restore/save actions to inspected official v4 commit `0057852bfaa89a56745cba8c7296529d2fc39830`.
- Bind the version-2 cache namespace to Ubuntu 24, actual Node version/platform/architecture, dependency/build/config/template-environment hashes, the exact CSS guard implementation and its current CSS-input fingerprint. The fingerprint uses the candidate’s existing `aihr_css_inputs_hash` function: CSS contents/file list under app/components plus CSS import lines in app/(app)/layout.tsx. Include the resolved candidate SHA in the primary key; compatible restore prefixes cannot cross that CSS boundary.
- Always execute canonical `pnpm build` with its existing production type checks and heap setting. A hit never supplies PASS or bypasses a build, test, migration, source/build identity or deployment check.
- Keep cache operations optional and individually limited to one minute. A service failure or miss falls back to building; it cannot turn a failed build green. The elapsed goal includes any cache overhead.
- Save only after a successful build and a local size check. Skip upload for missing/symlinked directories or an allocated compiler-cache size exceeding 1 GiB. This per-entry guard does not reserve space or authorize paid storage.

The existing staging CSS guard documents a real stale Turbopack import-graph failure. Restoring only the compiler directory without binding CSS would lose that protection. The proposed CI cache therefore uses the same fingerprint in its namespace and binds the guard source itself; it does not cache a separate marker or invoke the guard’s deletion function. A missing/malformed fingerprint disables optional cache operations and the canonical build still runs. The context step is also optional and bounded to one minute.

Existing job names, coverage, checkout identities, triggers, permissions, verification artifacts, all actual test/compiler environments and deployment holds remain unchanged. The cache is an optimization input, never a release witness. Respect GitHub's [cache scope and access rules](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching); do not broaden low-trust cache write access or put secrets into caches.

## Verification completed

YAML and shell syntax passed. Structural comparison confirmed that only the build job changed, the production build remains unconditional, and only optional cache operations tolerate errors. A tiny private filesystem probe checked missing, small, oversized and symlinked cache directories; only the small regular directory qualified for upload. A second tiny fixture reproduced the old cross-CSS compatibility-prefix collision and verified that the version-2 prefix changes for CSS contents, file additions/removals/renames and layout CSS imports, while unchanged CSS and markup-only edits remain compatible. Missing, malformed and symlinked guard inputs disable cache context; the existing compiler directory remains untouched. Structural comparison changed only three optional cache steps, preserving every other job, permission and unconditional production build. These probes did not run Next, application tests, a database or any GitHub job.

Before adoption, measure the next independently authorized Linux candidate with equivalent source/configuration and runtime: cold build versus restored compiler cache, build/type-check results, compiled metadata and generated CSS/import equivalence, restore/save overhead, cache size and total job time. Record misses honestly. A larger compiler cache that exceeds the bound intentionally provides no saved cache. No speedup, runner-minute saving or ten-minute release result is claimed yet.

## Why generic CI output cannot simply replace the staging build

The source has an explicit build-identity boundary:

1. `scripts/improve/release.ts` prepares a System Testing build record for the frozen source and a new build-record UUID before source transfer.
2. The remote `receive` command validates that record against installed source.
3. `runTestingProductionBuild` in `scripts/improve/system-testing-build-cli.ts` derives the official build environment from the validated record, invokes canonical `pnpm build`, requires a fresh Next build ID and publishes the successful observation only after completion.
4. `scripts/improve/system-testing-next-config.ts` verifies the selected owned record before exposing its five compile values. An ordinary CI build without the official selector gets explicit empty substitutions.

Consequently, the historical generic CI build was not the official staging build. The new review producer preserves the canonical record/observation boundary, but has not established a deployed staging build. Artifact promotion would need a reviewed build-once path that establishes the correct staging compile context before compilation, authenticates candidate/controller/run/artifact bytes and platform/runtime/dependencies, preserves this record/observation boundary, and proves the installed build and running service match. It must also retain audit preflights, migrations, catalog work, restart, health and source/build arrival. Merely restoring `.next` or bypassing the canonical build would lose these claims.

Artifact promotion is not implemented by the cache change. Keep that work separate from Board 3's frozen release and validate it under a versioned release policy before changing deployment authority.
