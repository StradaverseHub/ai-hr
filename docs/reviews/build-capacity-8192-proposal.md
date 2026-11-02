# Bounded hosted build heap contract

This records the existing upstream implementation, not a new capacity approval or release receipt. Reconciliation preserves its limits; no paid runner or spending-limit increase is authorized.

The default heap remains 6144 MB. Only the Next build step may request exactly 8192 MB, admitted by `.github/ci/build-heap.mjs` on a standard GitHub-hosted Linux runner with measured MemTotal between 15 and 17 GiB. Partial admissions, other heap values, self-hosted runners and other runner classes fail closed. The cache protocol binds the admitted heap; it cannot reuse a differently sized build context.

GNU time records the largest individual waited process RSS, not concurrent aggregate RSS. The build warns above 10 GiB and fails above 12 GiB even if compilation succeeds. MemAvailable samples are supplementary observations. Neither metric alone proves absence of transient aggregate memory pressure.

Raising the ceiling, admitting another heap value or runner class, or relaxing the RSS budget requires an explicit owner decision. Record that decision and rerun affected admission, cache and actual build checks before adoption. This document grants none of those changes. Roll back the bounded build-step selectors and admission together to restore 6144 MB; do not retain a mismatched cache profile.

Verification owners: `build-heap.test.mjs`, `next-build-cache-policy.test.mjs`, `next-application-cache.test.mjs`, canonical build telemetry and the authenticated build protocol. Focused tests establish admission behavior; an actual canonical build establishes candidate-specific build and packet measurements. No deployment follows from either.
