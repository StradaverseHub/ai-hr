# CI staging verification policy

## Owner recovery decision — 30 October 2026

The owner reaffirmed failed-area-only recovery in the Board chat: after the complete frozen run finishes, rerun failed areas and repair-invalidated checks, retaining valid successful evidence. Do not dispatch a new whole gate as the default response to one failure. This decision supersedes the older blanket fresh-whole-run language below for recovery after that completed gate. A broader run must be justified by actual invalidation or a new owner instruction.

Preserve original failing runs and raw errors. Every retained/replacement result must bind authenticated producing jobs/artifacts, exact candidate/controller/baseline, runtime and complete non-overlapping coverage. A failed run stays failed; replacement evidence must retain its own identity. A focused pass alone is not a release receipt.

**Implementation:** `focused-recovery.mjs` and `focused-recovery-policy.mjs` implement the separately versioned `aihr-focused-recovery/v1` operator route. Existing full-run admission remains strict. Recovery v1 accepts an unchanged canonical candidate/controller only, after a completed first-attempt failed full run whose build, compiler, migrations, controller, browsers and all unaffected test jobs passed. It currently supports failed no-DB units; unsupported failures refuse. It discards the failed process as evidence of success and requires successful authenticated focused runs covering every file and original assertion in each failed unit, with exact runtime/classifier identities. No overlap, omitted file, dropped assertion, skipped test, foreign run or failed process is accepted.

The adapter independently reconstructs the original complete plan, authenticates complete GitHub job/artifact inventories and archive digests, and retains the original failing reports. Every focused result keeps its own producing run/job/artifact identities. The clean operator verification controller is recorded separately from the original build/test controller and must have successful controller-only regression validation containing recovery refusal tests. The distinct recovery certificate binds all retained/replacement provenance, complete counts and original failures. It does not rewrite the failed workflow or issue a fabricated original gate receipt.

The existing installation grant remains bound to the original successful build artifact and source, with its witness fingerprint bound to the recovery certificate. Original-run metadata stays failed. Immediately before source transfer and detached launch, the adapter reauthenticates all run/job/artifact metadata and bytes, reconstructs coverage again and checks unchanged candidate/verifier/alpha/baseline. Target/profile, immutable migrations, exact compiled build, source checksum, health and guarded cleanup checks are unchanged.

From the clean verifier checkout, retaining the unchanged candidate in its own checkout:

```sh
export AIHR_RECOVERY_CONTROLLER_RUN_ID=ACTUAL_CONTROLLER_ONLY_RUN_ID
node --import tsx .github/ci/operator-release.mjs verify-recovery \
  /ABSOLUTE/FROZEN/CANDIDATE ORIGINAL_FULL_RUN_ID '[FOCUSED_RUN_IDS]'
```

Use `deploy-recovery` with the same identities only under staging deployment authority. Run only failed/invalidated areas; a focused pass alone or the old scheduling-only assessors still grants no deployment authority. This is an explicit recovery policy version, not an undocumented relaxation of normal single-run admission.

Current case: repair candidate/controller `c4fad43c1d67d69125a3f37e7549a5a8a7053362`, baseline `348b720e7a82c5e5573fc09196d06dfce50c787c`, original full run `40990989039`. The currently observed failure is the `nodb-f0f364cf77d50dce` unit's unhandled autosave callback from `test/onehr-ui.dom.test.tsx`; final complete failed-area selection must use the terminal job inventory, not this interim observation. No second whole gate was dispatched.


Latest prepared implementation: **aihr-staging-ci/v12**. The actual v11 existing-index setup pilot passed correctness but took113.376s after a genuine404miss; that unsuccessful performance approach is retained as evidence and replaced. V12 moves both complete audited PDF consumer files into one no-DB unit with the full external toolchain/native proof. Every other test still runs; source-scope changes and missing/foreign unit setup proof refuse. Integrated source includes the handed-back Operator application baseline. A fresh complete representative witness is required for this new topology/setup and integrated candidate; no old pass is relabelled. See [current measured evidence and remaining work](RELEASE-PERFORMANCE.md). This supersedes older implementation-status notes below without rewriting their original evidence.

Policy identifier: `aihr-staging-ci/v17`. This controller revision requires a fresh reviewed whole validation witness before operator use; draft code and focused diagnostics do not establish that witness. Version6 introduced the reviewed build-once installer contract; version7 retains it and binds duration-balanced DB grouping; version8 retains complete membership and adds duration-first within-job ordering. This policy implements the owner's authorization to use a complete validated CI gate for Board 3 staging instead of repeating the full gate on the Mac. It does not enable automatic deployment or main/live deployment.

## Prepared fixture recovery extension — qualification pending

The separately versioned `aihr-cross-source-recovery/v3` extends the existing cross-source
recovery adapter with one closed fixture-only delta: existing regular files
`test/ai-retention-extended-custody.test.ts` and `test/assistant-own-leave-store.test.ts`.
Only modifications within that set are eligible; additions, removals, renames, mode changes,
mixed product changes and every other tracked byte change refuse. The existing product-repair
branch remains separate. A reviewed fixture patch is required; path admission does not prove
that assertions retain their meaning.

Immutable Git impact reconstruction remains unchanged and determines all affected units.
Every affected original DB unit runs in full in a fresh authenticated database; original case
inventories, runtime/resource bounds, fresh whole compiler and canonical source-bound build,
complete API/artifact/history verification and independent verifier review remain mandatory.
An optional `repair_impact_base` input runs that existing reconstruction on a standard hosted
runner in explicit runner-diagnostic mode. Its artifact is selection information only and
cannot replace any passing test, build, recovery certificate or release witness.

The original cc170 full run and failed consumer remain failed. This extension and its exact
controller require hosted refusal controls and independently verified actual repair evidence
before operator use; source implementation alone supplies no release authority.

## Evidence authority

The operator must use a clean, reviewed controller at the exact commit that ran the witness, and an unchanged clean candidate. The authenticated GitHub API must identify repository `StradaverseHub/ai-hr` (ID 1333414856), workflow `alpha-staging-ci` (ID 395777276), the exact controller commit and a first-attempt completed successful run less than 24 hours old. Manual dispatch from main or alpha is accepted; a push witness must be on alpha with candidate and controller equal. PR, fork, rerun, incomplete and diagnostic-only results cannot authorize release.

Required jobs are derived from the independently reconstructed candidate manifest: resolution, plan, controller tests, migrations, compiler, Linux production build, every Node/DOM batch, all three actual browser engines, evidence verification and deployment hold. The optional diagnostics job must be skipped. Required artifacts are the plan, final receipt, canonical production-build-v1 packet and exactly one report per derived unit. The downloaded manifest cannot define its own reduced acceptance set. Every downloaded ZIP is hashed against its authenticated API digest before bounded extraction. JSON artifacts retain their64MiB bound; only production-build-v1 uses the exact five-member format2 binary extractor and unchanged280MiB ZIP bound, with a272MiB compressed archive cap and actual five-member serialized aggregate at most280MiB. The manifest, provenance, inspected packet and installation grant build all carry the exact closed capacityProfile `{profileVersion:3,archiveMaxBytes:285212672,zipMaxBytes:293601280}`. Actual outer ZIP bytes are independently authenticated and bounded; the member aggregate never substitutes for the outer measurement. Its Node20.20.2/Linux x64 build provenance, successful System Testing record, package/lock hashes and archive bytes must bind the unchanged candidate. This target build runtime is separate from the Node22 test-plan runtime. See [canonical build protocol](CI-CANONICAL-BUILD-PROTOCOL.md) and [normal application compiler cache](NORMAL-NEXT-APPLICATION-CACHE.md). The optional whole-project and application compiler graph packets have distinct fixed namespaces and cannot replace mandatory evidence. Missing, duplicate, expired, foreign or additional evidence refuses.

The operator independently reconstructs the candidate's complete tracked inventory and actual DB classifier partition. Candidate, controller, migration baseline, policy, Linux x64/Node 22 runtime, manifest fingerprint, every test file and assertion total must reconcile. No skipped, failed, zero-test or absent unit becomes PASS. Artifact arrival order does not affect the receipt. Earlier failed attempts remain failed and are never relabelled.

## Batch identity and scheduling

The actual candidate classifier partitions the complete tracked Node/DOM inventory. DB files form deterministic duration-balanced batches of at most64, retaining exactly ceil(DB-file-count/64) jobs; sorted no-DB files retain contiguous batches of at most256. Longest recorded file intervals are assigned first to the least-loaded non-full group, with stable path/index tie breaks. All members are sorted before content hashing. The tracked advisory dataset and algorithm identity are bound in plan.execution.scheduling and the manifest fingerprint; unknown files get a positive default and remain mandatory. Historical failure-run timing never supplies PASS or permits omission. Version7 changes grouping only and cannot reuse an old-policy full witness. Each batch identity includes a hash of its exact file list; a file-list change invalidates that identity. Every batch runs on a separate disposable standard runner, with an owned PostgreSQL container for DB work. The current v15 execution contract fixes two test workers, PostgreSQL profileVersion 2, a configured Docker/cgroup memory cap of 2113929216 bytes (2016 MiB), and a separate, unchanged hard observed memory.peak budget of 2147483648 bytes (2 GiB), with JIT explicitly on. Docker HostConfig.Memory and MemorySwap must both equal the configured cap; cgroup memory.max must equal that cap and memory.swap.max must be zero. Schema 2 evidence binds both declared byte values and the profile version to the actual readings; mixed, missing, legacy or mismatched identities refuse. Raw peaks are never rounded or clamped. Both oom and oom_kill must be zero. The measured 1 GiB OOM is not repaired by batching alone; query-local product tuning must pass under the on setting. Each successful DB batch must include actual Docker/cgroup budget, peak memory, zero OOM kills, live PostgreSQL 16 and JIT-on/available evidence. Owned telemetry and a bounded server log tail are preserved before cleanup, including on failure. Browser coverage remains the complete browser inventory in Chromium, Firefox and WebKit.

A dispatch concurrency choice of 4, 8, 16 or 20 (default 20) limits simultaneous Node/DOM jobs; it cannot change the manifest, membership, required artifacts or coverage. The default is an interim scheduling choice, not a measured optimal value. No paid runner is selected. At the original pilot scale of 981 DB and 963 no-DB files this derives 16 DB and four no-DB jobs, but neither count is an acceptance constant. This revision does not add cross-run or partial release reuse.

Manual controller_only diagnostics require diagnostics_only=true and identical frozen candidate/controller. They execute dependency-free controller checks and reconstruct the entire tracked classifier manifest, without application dependencies/tests, compilers, databases or deployment. Their differently named diagnostic artifact and skipped required jobs cannot supply a release witness. Source grouping/runtime integration remains subject to a fresh complete normal validation.

[Controller-only40273794715](https://github.com/StradaverseHub/ai-hr/actions/runs/40273794715), exact0cf72a1528fd8ede07f1d24a95958d7a7b8488c9, passed294 controller controls and reconstructed all1,957 tracked Node/DOM files without application dependencies. Independent API/archive review confirmed exactly16 DB units,4 no-DB units and3 browser engines, unchanged complete membership, the dataset digest and manifest fingerprint. This validates controller/source topology and the absence of application execution in this diagnostic; actual balanced matrix runtime and a complete current-policy release witness remain unproved.

Version8 sets duration-first ordering only for normal DB units. The installed Vitest base sequencer still owns sharding. Its project group, project name, isolation and prior-failure priorities remain ahead of duration; unknown files stay required with a positive advisory default. Local default behavior stays unchanged unless explicitly opted in. This execution change and new mandatory sequencing controls require a fresh complete current-policy witness; version7 source/model validation is retained at its actual origin, not relabelled as version8 runtime proof.

Version8 controller-only40278854626 passed301 controls and independently matched all1,958 tracked Node/DOM files at1bef9069a. The real installed-Vitest integration40280567574 passed both parent checks plus both unchanged cases in each private child phase at28dc3c84c, including exact queue/start order, effective worker count, complete membership, inherited sharding and cleanup. Neither diagnostic executes application/database coverage or supplies a full witness. Subsequent merge7f47701bb includes the published Mobile alpha; focused combined reset verification40281355998 passed22/22 with real blocked-lock recovery and owned cleanup. Whole compiler/full release validation remain pending, and older evidence retains its actual origin. See [measured scope and preserved failures](RELEASE-PERFORMANCE.md#real-sequencing-integration-and-released-alpha-reconciliation--26-october-myt).

Integrated long-file source73b99f1fc has controller-only40285906774 proof of all1,965tracked Node/DOM files (993DB/972no-DB),16/4units,three engines and316pure controls. Actual focused91-case write and32-case financial split results retain their earlier exacte9b/7b origins and do not supply a full witness. Complete compiler and whole current-policy validation are pending; the new compiler was not dispatched after actual included allowance fell to2minutes. Main/staging enable flags were checked false by the successful deployment-hold job. See [current evidence and allowance](RELEASE-PERFORMANCE.md#integrated-source-verified-compiler-held-at-included-allowance--26-october-myt).

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


### v15 PostgreSQL headroom and evidence identity

The lower physical cap reserves 32 MiB below the unchanged observed peak budget because the kernel can transiently exceed memory.max. This is a resource-profile change, not permission to exceed the 2 GiB observed budget. Original v14 failures remain FAIL: full run 41091902997 at 4c recorded peak 2147504128; full run 41102243259 at b090 recorded peak 2147495936. Passing assertions or zero OOM counters do not waive these peaks. New v15 execution still refuses any raw peak above 2147483648, any OOM/kill, dead/unhealthy PostgreSQL, wrong PostgreSQL major, or unavailable/off JIT.

The full/focused plan uses `{profileVersion:2,configuredCapBytes:2113929216,peakBudgetBytes:2147483648,jit:'on'}`. Both byte fields participate in the existing execution fingerprint. All ordinary workflows explicitly select this profile and both declared values; combining it with the historical integer-GiB selector refuses before Docker access. Capture reads actual Docker Memory/MemorySwap and cgroup memory.max/memory.swap.max/memory.peak/memory.events before cleanup, preserving raw reclaim/max events and bounded logs.

Historical diagnostic 1 GiB/2 GiB routes remain named `legacy-1g`/`legacy-2g`, with explicit matching integer-GiB and JIT selectors. Their schema 1/profileVersion 1 evidence also records and validates actual memory and swap configuration. They cannot replace schema 2/profileVersion 2 release witnesses. Old unversioned v14 evidence is not adopted as new-profile proof. All 57 actual DB units require fresh hosted execution under v15; preserve original cases, files and duration ordering. Compiler/build, all three browser engines, ordinary migrations and controller checks remain required by the final actual classifier and authenticated source/controller identity. No duplicate whole preview or new recovery framework is introduced. Passing static or pure fixture checks alone does not authorize release; actual hosted qualification and ordinary staging acceptance remain mandatory.


### Historical v16 build-byte capacity identity (superseded by v17 below)

The historical v16 source contract admitted only format2 build manifest/provenance/packet/grant with exact capacity profile `{profileVersion:2,archiveMaxBytes:276824064,zipMaxBytes:293601280}`. It raises only the compressed archive cap from256MiB to264MiB. Outer ZIP280MiB, individual unpacked file256MiB, external package32MiB, manifest16MiB, total unpacked2GiB,40000 entries and all path/digest/ownership/cleanup limits remain unchanged. The actual five serialized packet members must fit the unchanged280MiB aggregate at producer finalization, packet inspection and extractor header/stream validation. Independently, API metadata, downloaded ZIP stream, immutable readback and extraction must enforce the actual outer280MiB limit. No assumption about compressibility or wrapper overhead grants acceptance.

Diagnostic41107852301 atd474 failed when maximum-compression gzip9 produced272659334 bytes against the original268435456 cap; its skipped consumer remains unverified. The finite new cap is276824064, leaving4164730 bytes above that observed archive, without promising future builds fit. Original failures and policy identities are retained; no old witness becomes v16 PASS. That v16 source required hosted pure controls, an actual complete large-payload producer/fresh-VM native/rendered consumer and the ordinary full v16 qualification before release admission; it did not establish those observations.

The v15 PostgreSQL profile2 is unchanged in v16, including configured2113929216 versus strict raw peak2147483648, actual Docker/cgroup swap/memory measurements, zero OOM, healthyPG16/JITon and two workers. All57 actual DB units require their ordinary fresh proof. System Testing prepared and successful-observation records retain their independent format1; this is no blanket format rewrite.

The old installed baseline records remain byte-for-byte opaque. The normal path binds baseline status/profile/ledger/BUILD_ID and owned retained-directory inodes; it does not decode an old baseline manifest/grant with the new controller. Every new admission/unpack requires format2. No legacy reader, fallback, context adapter or bootstrap bypass is introduced. Retained-directory/build-ID and cleanup authority checks remain mandatory; baseline preservation grants no new deletion or installation authority.


### v17 build-byte suballocation identity

The current source contract uses only format2 manifest/provenance/packet/grant with exact build capacity profile `{profileVersion:3,archiveMaxBytes:285212672,zipMaxBytes:293601280}`. It reallocates only the finite compressed archive sublimit from264MiB to272MiB inside the unchanged280MiB outer ZIP and five-member aggregate envelope. Manifest16MiB, individual unpacked file256MiB, external package32MiB, total unpacked2GiB,40000 entries and all path, digest, alias, ABI, ownership and cleanup checks remain unchanged. PostgreSQL's separate resource profileVersion2 is unchanged. There is no payload omission, map stripping, new runner class or spending change.

The sourceM `b8134d487cce89cb974f87956e1d1a24f6d42fbc` build-only diagnostic41144224936, using diagnostic controllerC5 `9bc12d7005d09e702715bec737c6147528f44246`, observed a282168278-byte maximum-compression archive and correctly refused the v16 cap. The profile3 sublimit leaves3044394 bytes above that observed archive. Neither that difference nor the retained source-only proposal proves a new build fits: all five actual serialized members and the independently measured actual outer ZIP must still each satisfy the unchanged280MiB aggregate/ZIP checks. Oversized metadata or wrapper bytes refuse; no compressibility assumption is an allowance.

Entire profile2, format1, mixed profile/cap combinations and malformed bounds are not current candidates. Existing installed baseline records remain opaque immutable recovery evidence; no legacy decoder or current acceptance fallback is added. Original failed runs remain failed on their original source/controller. V17 requires independently reviewed controls, an actual complete producer, an independently authenticated fresh-VM native/static consumer and the actual full-policy witness before release admission. That transport consumer does not prove authenticated application journeys or database health; real staging migration/health and changed authenticated rendered journeys remain separate required acceptance evidence. No prior diagnostic or profile2 witness is relabelled v17 PASS.
