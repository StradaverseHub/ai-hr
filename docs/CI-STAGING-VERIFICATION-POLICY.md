# CI staging verification policy

Policy identifier: `aihr-staging-ci/v5`. This controller revision requires a fresh reviewed whole validation witness before operator use; draft code and focused diagnostics do not establish that witness. This policy implements the owner's authorization to use a complete validated CI gate for Board 3 staging instead of repeating the full gate on the Mac. It does not enable automatic deployment or main/live deployment.

## Evidence authority

The operator must use a clean, reviewed controller at the exact commit that ran the witness, and an unchanged clean candidate. The authenticated GitHub API must identify repository `StradaverseHub/ai-hr` (ID 1333414856), workflow `alpha-staging-ci` (ID 395777276), the exact controller commit and a first-attempt completed successful run less than 24 hours old. Manual dispatch from main or alpha is accepted; a push witness must be on alpha with candidate and controller equal. PR, fork, rerun, incomplete and diagnostic-only results cannot authorize release.

Required jobs are derived from the independently reconstructed candidate manifest: resolution, plan, controller tests, migrations, compiler, Linux production build, every Node/DOM batch, all three actual browser engines, evidence verification and deployment hold. The optional diagnostics job must be skipped. Required artifacts are the plan, final receipt, canonical production-build-v1 packet and exactly one report per derived unit. The downloaded manifest cannot define its own reduced acceptance set. Every downloaded ZIP is hashed against its authenticated API digest before bounded extraction. JSON artifacts retain their64MiB bound; only production-build-v1 uses the exact five-member binary extractor and280MiB ZIP bound. Its Node20.20.2/Linux x64 build provenance, successful System Testing record, package/lock hashes and archive bytes must bind the unchanged candidate. This target build runtime is separate from the Node22 test-plan runtime. See [canonical build protocol](CI-CANONICAL-BUILD-PROTOCOL.md) and [normal application compiler cache](NORMAL-NEXT-APPLICATION-CACHE.md). The optional whole-project and application compiler graph packets have distinct fixed namespaces and cannot replace mandatory evidence. Missing, duplicate, expired, foreign or additional evidence refuses.

The operator independently reconstructs the candidate's complete tracked inventory and actual DB classifier partition. Candidate, controller, migration baseline, policy, Linux x64/Node 22 runtime, manifest fingerprint, every test file and assertion total must reconcile. No skipped, failed, zero-test or absent unit becomes PASS. Artifact arrival order does not affect the receipt. Earlier failed attempts remain failed and are never relabelled.

## Batch identity and scheduling

The actual candidate classifier partitions the complete tracked Node/DOM inventory. Sorted DB files form batches of at most 64; sorted no-DB files form batches of at most 256. Each batch identity includes a hash of its exact file list; a file-list change invalidates that identity. Every batch runs on a separate disposable standard runner, with an owned PostgreSQL container for DB work. The execution contract fixes two test workers and a 2 GiB PostgreSQL memory cap, retaining server-default JIT on. The measured 1 GiB OOM is not repaired by batching alone; query-local product tuning must pass under the on setting. Each successful DB batch must include actual Docker/cgroup budget, peak memory, zero OOM kills, live PostgreSQL 16 and JIT-on/available evidence. Owned telemetry and a bounded server log tail are preserved before cleanup, including on failure. Browser coverage remains the complete browser inventory in Chromium, Firefox and WebKit.

A dispatch concurrency choice of 4, 8, 16 or 20 (default 20) limits simultaneous Node/DOM jobs; it cannot change the manifest, membership, required artifacts or coverage. The default is an interim scheduling choice, not a measured optimal value. No paid runner is selected. At the original pilot scale of 981 DB and 963 no-DB files this derives 16 DB and four no-DB jobs, but neither count is an acceptance constant. This revision does not add cross-run or partial release reuse.

## Operator route

From the frozen candidate directory, using its installed toolchain:

```sh
node --import tsx /ABSOLUTE/CONTROLLER/.github/ci/operator-release.mjs verify /ABSOLUTE/CANDIDATE RUN_ID
```

This reads the actual staging deploy state and downloads and validates CI evidence. It writes private evidence under the controller's ignored scratchpad only. `deploy` in place of `verify` is reserved for the coordinating release owner after review. GitHub receives no operator SSH credentials.

The adapter binds the existing staging target, requires a healthy unstale baseline and checks that alpha still identifies that baseline or the exact candidate. Immediately before transfer it revalidates the run, job and artifact identities, both clean source commits and the live baseline. It consumes the frozen candidate's official System Testing manifest, existing pending announcement, canonical rsync filters, immutable build record transfer, detached deployment launch and reconnecting binary log follower. Failed, wrong-source or stale terminal builds refuse. The CI adapter now uses a separate strict marker check and one private SSH config/alias for SSH and canonical rsync. The legacy generic helper keeps its bootstrap fallback; this source revision still needs complete operator validation before adoption. Evidence stays `tier: ci`; no local full-gate receipt is created.

A successful remote build is not completed arrival. The coordinating release owner still restarts the service, checks active health, proves source arrival with the canonical zero-difference dry run, verifies the full migration ledger and hashes, advances alpha and the deployed baseline variable, and updates board states only after those facts are established. Release learning and its outside-source mirror must be retained; any mirror warning needs a retry.

## Change control

The final controller is frozen before the fresh whole pilot. A repair to verification or orchestration requires a new reviewed controller and whole validation witness; successful phases from older runs are not substituted. Changes to the policy's acceptance guarantees require an explicit version change. Candidate application source remains unchanged by CI setup or the operator adapter. Automatic staging and main deployment switches remain false throughout this pilot.

## Assessment of database chunking

The historical `CHUNKS=8` and `CHUNKS=16` commands are execution choices, not PostgreSQL requirements or proof of complete coverage. The header of `scripts/gate-chunked.sh` records their original motivation: a full local suite generated 10.7 GB of WAL and overflowed a 5 GB, then 8 GB, Mac RAM disk. The script defaults to three chunks while the local instruction file recommends eight. Its round-robin partition depends on the chosen count, so changing that count between slices can duplicate and omit files. The legacy full-tier branch in `scripts/improve/release-gate.ts` accepts PASS plus the exact commit; it does not independently reconstruct chunk coverage. The stricter CI verifier must not inherit that limitation.

Separate these three quantities when evaluating changes:

- **Coverage:** the complete independently reconstructed test inventory and every required assertion.
- **Batch size:** how much work one disposable database receives before reset, selected using measured WAL, memory, runtime and isolation needs. The current 64-file guard is an existing operational bound, not a database limit.
- **Concurrency:** how many isolated runner/database jobs execute together. This can change without changing required coverage.

More chunks alone cannot fix every resource failure. In diagnostic run [40183692729](https://github.com/StradaverseHub/ai-hr/actions/runs/40183692729), the original isolated organization test exhausted its PostgreSQL container's 1 GiB cap: cgroup `oom_kill=1`, peak equal to the cap, Docker `OOMKilled=true`, and a backend terminated by signal 9. A test timeout preceded that kill; memory exhaustion therefore does not establish the cause of every earlier timeout or lock conflict. Controlled comparisons against the released baseline and a 2 GiB cap retain the original test assertions and timeouts. These diagnostic runs cannot authorize release.

Recommended next design: stable batch identities derived from a trusted complete plan, with scheduling concurrency configured separately. Use measured durations to balance work, and investigate individual expensive queries, repeated fixture cleanup and database reset costs. Validate a complete, disjoint inventory at release time rather than treating a fixed count of eight or sixteen as the guarantee. Reusing successful batches after a repair additionally requires explicit invalidation and provenance rules and a versioned, validated release policy; the v2 policy above still requires a fresh whole witness.

The existing `test/global-setup.ts` already migrates a template and clones worker databases. Do not propose that existing mechanism as a new optimization. Further harness work must measure reset/seed/query cost and demonstrate preserved isolation before changing fixture cleanup or replacing resets.

## Supplemental compiler graph namespace — policy v3

The exact mandatory job/test artifact manifest remains unchanged. One optional `whole-compiler-state-v1` artifact is permitted only with the same authenticated run/controller provenance, finite size, digest and fixed JSON namespace. It contains compiler graph data with `releaseAuthorized:false`; it cannot replace a test unit, full gate, build or deployment evidence. The actual compiler still executes on every candidate and misses/refusals compile cold. Failed-only source assessment never obtains coverage or waives fresh prerequisites from this artifact. Unknown or duplicate supplemental artifacts remain refused. The new policy needs a fresh complete representative run; earlier v2 witnesses are not relabelled. See [normal compiler cache](NORMAL-COMPILER-CACHE.md).
