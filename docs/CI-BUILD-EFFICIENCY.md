# CI build efficiency and deployment boundaries

The isolated branch now has independently verified canonical Linux build-byte transport and Next application compiler-state reuse. Normal authenticated promotion and complete release adoption remain unfinished. The original optional Turbopack cache below has no measured cold/warm result; it is separate from the newly verified application TypeScript state.

## Current measured application compiler result — 26 October 2026 MYT

The [application-state diagnostic](NEXT-APPLICATION-COMPILER-CACHE.md) retained the real 297.573 s canonical build despite a later collector failure, repaired only the typed launcher/missing state capture, then genuinely built on a fresh runner in 191.107 s using authenticated state. Actual Next printed TypeScript 2.3min → 26.6s; all 2,709 tracked application roots remain in 4,617 graph files, and real dependency/new-root refusals plus restored-source success passed. The first failed workflow stays red. Whole warm diagnostic 340.647 s includes four extra compiler controls and is not a test gate, normal workflow or staging release. Bounded build capacity retained at least 9.13 GiB sampled build disk headroom while skipping SDK deletion. No normal build/test admission or main/live deployment was enabled. See the linked provenance and scope before reuse.

## Verified setup

The candidate and installed framework are Next.js 16.3.8. Its installed documentation and configuration default enable Turbopack build filesystem caching at `.next/cache/turbopack`; a fresh CI runner must explicitly restore that directory to benefit. See [Next build caching](https://nextjs.org/docs/app/guides/ci-build-caching) and [Turbopack filesystem caching](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache).

The repository cache API observation returned three entries totaling 662,708,199 bytes. All three were pnpm dependency caches in separate branch scopes; none was a Next compiler cache. This is a dated observation, not a permanent cache inventory. No storage limit, billing setting or existing cache was changed.

The build job currently verifies a Linux production build. The standard local `scripts/improve/release.ts` path checks complete TypeScript locally before invoking the remote deployment build. The CI operator path instead validates the complete CI witness, including its compiler job, and invokes the canonical remote build through the frozen source's official helpers. These are distinct environments and claims. Removing a build or copying output between them requires validated replacement evidence; a successful generic CI build does not establish staging build identity or arrival.

## Prepared optional compiler cache

Only the `build` job in the review version of `.github/workflows/alpha-staging.yml` changes:

- Cache only `source/.next/cache/turbopack`, leaving complete output, server/static assets, runtime data, environment files and dependency installations outside this cache.
- Pin restore/save actions to inspected official v4 commit `0057852bfaa89a56745cba8c7296529d2fc39830`.
- Bind the version-2 cache namespace to Ubuntu 24, actual Node version/platform/architecture, dependency/build/config/template-environment hashes, the exact CSS guard implementation and its current CSS-input fingerprint. The fingerprint uses the candidate’s existing `aihr_css_inputs_hash` function: CSS contents/file list under app/components plus CSS import lines in app/layout.tsx. Include the resolved candidate SHA in the primary key; compatible restore prefixes cannot cross that CSS boundary.
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

Consequently, the current generic CI build is not the official staging build. Artifact promotion would need a reviewed build-once path that establishes the correct staging compile context before compilation, authenticates candidate/controller/run/artifact bytes and platform/runtime/dependencies, preserves this record/observation boundary, and proves the installed build and running service match. It must also retain audit preflights, migrations, catalog work, restart, health and source/build arrival. Merely restoring `.next` or bypassing the canonical build would lose these claims.

Artifact promotion is not implemented by the cache change. Keep that work separate from Board 3's frozen release and validate it under a versioned release policy before changing deployment authority.
