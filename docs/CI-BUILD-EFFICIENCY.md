# CI build efficiency and deployment boundaries

Prepared on 25 October 2026 in the isolated optimization review branch. No cache was created, cloud build dispatched, staging deployment changed or main/live deployment enabled by this work. Linux cold/warm measurements remain pending.

## Verified setup

The candidate and installed framework are Next.js 16.3.8. Its installed documentation and configuration default enable Turbopack build filesystem caching at `.next/cache/turbopack`; a fresh CI runner must explicitly restore that directory to benefit. See [Next build caching](https://nextjs.org/docs/app/guides/ci-build-caching) and [Turbopack filesystem caching](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache).

The repository cache API observation returned three entries totaling 662,708,199 bytes. All three were pnpm dependency caches in separate branch scopes; none was a Next compiler cache. This is a dated observation, not a permanent cache inventory. No storage limit, billing setting or existing cache was changed.

The build job currently verifies a Linux production build. The standard local `scripts/improve/release.ts` path checks complete TypeScript locally before invoking the remote deployment build. The CI operator path instead validates the complete CI witness, including its compiler job, and invokes the canonical remote build through the frozen source's official helpers. These are distinct environments and claims. Removing a build or copying output between them requires validated replacement evidence; a successful generic CI build does not establish staging build identity or arrival.

## Prepared optional compiler cache

Only the `build` job in the review version of `.github/workflows/alpha-staging.yml` changes:

- Cache only `source/.next/cache/turbopack`, leaving complete output, server/static assets, runtime data, environment files and dependency installations outside this cache.
- Pin restore/save actions to inspected official v4 commit `0057852bfaa89a56745cba8c7296529d2fc39830`.
- Bind the cache namespace to Ubuntu 24, actual Node version/platform/architecture, dependency and build/config/template-environment hashes. Include the resolved candidate SHA in the primary key; a compatible prefix can supply earlier compiler work.
- Always execute canonical `pnpm build` with its existing production type checks and heap setting. A hit never supplies PASS or bypasses a build, test, migration, source/build identity or deployment check.
- Keep cache operations optional and individually limited to one minute. A service failure or miss falls back to building; it cannot turn a failed build green. The elapsed goal includes any cache overhead.
- Save only after a successful build and a local size check. Skip upload for missing/symlinked directories or an allocated compiler-cache size exceeding 1 GiB. This per-entry guard does not reserve space or authorize paid storage.

Existing job names, coverage, checkout identities, triggers, permissions, verification artifacts, all actual test/compiler environments and deployment holds remain unchanged. The cache is an optimization input, never a release witness. Respect GitHub's [cache scope and access rules](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching); do not broaden low-trust cache write access or put secrets into caches.

## Verification completed

YAML and shell syntax passed. Structural comparison confirmed that only the build job changed, the production build remains unconditional, and only optional cache operations tolerate errors. A tiny private filesystem probe checked missing, small, oversized and symlinked cache directories; only the small regular directory qualified for upload. These probes did not run Next, application tests, a database or any GitHub job.

Before adoption, measure the next independently authorized Linux candidate with equivalent source/configuration and runtime: cold build versus restored compiler cache, build/type-check results, compiled metadata, restore/save overhead, cache size and total job time. Record misses honestly. A larger compiler cache that exceeds the bound intentionally provides no saved cache. No speedup, runner-minute saving or ten-minute release result is claimed yet.

## Why generic CI output cannot simply replace the staging build

The source has an explicit build-identity boundary:

1. `scripts/improve/release.ts` prepares a System Testing build record for the frozen source and a new build-record UUID before source transfer.
2. The remote `receive` command validates that record against installed source.
3. `runTestingProductionBuild` in `scripts/improve/system-testing-build-cli.ts` derives the official build environment from the validated record, invokes canonical `pnpm build`, requires a fresh Next build ID and publishes the successful observation only after completion.
4. `scripts/improve/system-testing-next-config.ts` verifies the selected owned record before exposing its five compile values. An ordinary CI build without the official selector gets explicit empty substitutions.

Consequently, the current generic CI build is not the official staging build. Artifact promotion would need a reviewed build-once path that establishes the correct staging compile context before compilation, authenticates candidate/controller/run/artifact bytes and platform/runtime/dependencies, preserves this record/observation boundary, and proves the installed build and running service match. It must also retain audit preflights, migrations, catalog work, restart, health and source/build arrival. Merely restoring `.next` or bypassing the canonical build would lose these claims.

Artifact promotion is not implemented by the cache change. Keep that work separate from Board 3's frozen release and validate it under a versioned release policy before changing deployment authority.
