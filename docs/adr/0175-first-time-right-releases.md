# ADR-0175 — First-time-right releases with bounded recovery and single binding

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Status:** Accepted by the owner on 4 November 2026, directly in session ("Okay go ahead"), in response to the [release speed review](../reviews/release-speed-review-2026-11-04.md). Phase 0 is adopted now. Every controller change in Phase 1 takes effect only after its validation witness (§Validation). For AI approval the owner took the review's recommended **Option A** (approve every digest, with an automatic delta). Option B (two digests) is **not** adopted and needs its own decision.
- **Number:** provisional. ADR-0174 is claimed by the tenant-isolation hardening branch (PR #218); reconcile at integration.
- **Date:** 2026-11-04
- **Relates to:** [ADR-0114](0114-impact-aware-release-and-learning.md), [ADR-0169](0169-assistant-context-harness-and-disclosure-repivot.md) §5.1, [CI recovery policy](../CI-STAGING-VERIFICATION-POLICY.md), [staging queue](../STAGING-RELEASE-QUEUE.md), [migration allocation](../MIGRATION-ALLOCATION.md).

## Context

Two measured staging releases (2 and 4 November 2026) ran 9 full gates with 0 first-time passes. 13 of the 16 gate failures could have been detected before a full gate, or recovered without one. The full gate itself takes about 20 minutes. Releases took 4–5 hours because of repeated gate→fix→rebind loops, and because releases queued behind other releases with the same loops. The owner's 30 October rule (rerun only failed areas) lacks tool support for browser failures and small repairs. Evidence and timelines: [release speed review](../reviews/release-speed-review-2026-11-04.md).

## Decision

1. **Selection.** Builders and integrators choose focused tests with the repository's deterministic impact selector (`scripts/gate-impact.ts`), through `scripts/release/select-focused.ts`. Its mandatory guard and tenant-invariant set, plus the release-proven additions in that wrapper, is part of every focused selection. Hand-picked unions are not release preparation.
2. **Preflight.** Before a binding packet is drafted, the candidate passes `scripts/release/preflight.mjs`. It checks:
   - that the AI manifest generator and scope are byte-identical to the next controller (origin/main);
   - the provider and module-agent closure delta against main;
   - that new migration `when` and `idx` values are above main and the recorded staging watermark.

   The guard selection from 1 then runs once on Actions.
3. **Single binding.** Scope freezes when the packet draft starts. The packet carries an automatic approval delta (closure files changed since main's bound digest, classified). The owner directly approves the exact digest, as before. Under Phase 1, a reviewed rehearsal mode may run the full gate before approval. Rehearsal results can never authorize installation.
4. **Bounded recovery.** After a complete frozen gate, recovery reruns only failed or invalidated units, through reviewed, versioned routes (Phase 1):
   - a single-shot rerun of a failed browser engine unit that lies outside the candidate's impact set;
   - cross-source recovery for small repairs, test-only deltas and binding-only deltas.

   A second failure closes recovery. Original failures are always kept. No run is relabelled, `gh run rerun` is never used and no unit is retried until green. Under the existing v1 route, recovery focused runs may be dispatched in parallel on distinct CI refs at the same SHA. Diagnosis may start when the first job fails; repairs are still dispatched only after every planned job has finished.
5. **Flakes and time-dependent tests.** Unreliable tests are registered in [the flaky test register](../FLAKY-TESTS.md) with evidence, an owner and a due date.
   - They are never skipped or made non-blocking.
   - Registration only permits the single-shot recovery in 4.
   - An overdue entry blocks releases that touch its area.
   - Tests pin the clock through the repository's HR date owner rather than capturing the date at module load.
6. **Migrations.** Unapplied migrations are numbered at landing with `scripts/release/migrations-renumber.mjs`. Applied SQL and journal prefixes remain immutable. In Phase 2, allocation moves to a reservation held by the staging queue, with an owner and an expiry.
7. **Cadence.** Prefer small releases of green slices. A slice that is bound and green is released rather than held for later scope. Speculative integration on a queued predecessor is allowed; its evidence never transfers.

## Unchanged

- Tenant and company isolation tests and RLS.
- The owner's direct approval of every AI data-flow digest.
- Exact-source, exact-controller, first-attempt evidence.
- The complete full gate before staging.
- The shared queue and lease.
- Human staging acceptance.
- Separate production authority.

The scripts in Phase 0 are advisory tooling. They issue no receipt, witness, grant or approval, and CI admission is unchanged.

## Phases

- **Phase 0 (adopted now; no release-control change):** decisions 1, 2 and 5; the parallel recovery dispatch and early diagnosis in 4; the renumber script in 6; the scope freeze and cadence in 7.
- **Phase 1 (reviewed controller changes):**
  - browser recovery v3 (single shot);
  - cross-source recovery v3 (new files, test-only and binding-only deltas);
  - an unbound rehearsal mode;
  - focused-check fan-out beyond 64 files in one run;
  - a migration-watermark admission check against main;
  - higher `test_parallelism` choices;
  - a narrowed provider closure (AI-sent strings only, and the egress-reachable lockfile subset), through a reviewed generator.
- **Phase 2 (owner decisions):** the two-digest binding (Option B), the queue-held migration lease, and staging windows.

## Validation

Each Phase 1 controller change follows [CI policy § Change control](../CI-STAGING-VERIFICATION-POLICY.md#change-control):
1. a frozen owned controller;
2. refusal fixtures for every new path;
3. a hosted controller-only diagnostic;
4. a read-only exercise on real retained failures that returns a non-installable diagnostic;
5. an independent review;
6. a fresh complete whole witness under a new policy version.

## Measure

Record for each release:
- time from ready candidate to installed;
- the number of full gates;
- whether the first gate passed;
- recoveries used;
- approval rounds;
- queue wait.

Target: one full gate, at most one recovery, and under 90 minutes from ready candidate to installed. The owner's goal (unchanged) is under 10 minutes for automated verification plus deployment.
