# CI/CD redesign: primary-source findings

Research date: 19 November 2026. Scope: architecture research, not commissioning evidence or release authorization. Official documentation was checked online during this task. Recommendations below are our synthesis; they are not claims that Matt Pocock, Lauren Tan, or any named engineer uses this exact design.

## Local policy and evidence boundary

Read the canonical `CLAUDE.md` and `docs/REPOSITORY-AND-ENVIRONMENTS.md` in the verified checkout `/Users/zenlam/Projects/ai-hr/.worktrees/cicd-redesign-20261119`, branch `codex/cicd-redesign-20261119`. Its initial status was clean and cached comparisons were `0 0` against both integration refs. This research agent's fetch was denied when writing Git's `FETCH_HEAD`; those cached comparisons alone do not establish remote freshness. The coordinating agent owns the verified integration base.

Current local policy requires hosted verification, preserving valid frozen-candidate results on recovery, staging acceptance, and a subsequent explicit production request. This note proposes changes for review; it does not supersede that policy, enable automatic CD, or authorize deployments. Private packages and release manifests stay in the designated private distribution store.

## What can replace a full-suite barrier on every release?

**Proposed direction:** establish continuous confidence before promotion, then make promotion verify authenticated evidence and the exact artifact rather than rerunning all work. Combine mandatory fast invariants, dependency-aware checks on the combined merge candidate, audited reuse for unchanged inputs, periodic complete qualification, and controlled rollout with independent acceptance. No source establishes that these controls already make ai-hr safe; qualification must measure that claim.

Meta's first-party account demonstrates selective testing calibrated against historical outcomes and a separate validation set, with continued adaptation as the codebase changes. Its reported thresholds and results are specific to Meta's infrastructure and dataset. They do not establish our acceptable miss rate or justify replacing our gate with a path list. [Meta: predictive test selection](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/).

**Proposed qualification sequence:**

1. Run the proposed selector in shadow mode alongside existing complete runs on frozen candidates. Persist selected and omitted tests, dependency reasons, input hashes, failures, duration, and selector version.
2. Measure omitted failing tests and, separately, changes for which every regression signal was omitted. Include migrations, dynamic imports, permissions, shared fixtures, generated code, configuration, and worker contracts. Historical replay helps but does not replace prospective observations.
3. Start conservative: unknown ownership/dependencies, selector errors, controller changes, lockfile/toolchain changes, schema/auth/tenant-boundary changes, and incomplete evidence require the broad qualification profile. Keep explicit always-run business invariants.
4. Agree measurable admission criteria with the owner before relaxing the barrier. Establish automatic reversion to the broad profile on an unexplained selection miss, invalid evidence, or graph drift. Complete scheduled runs detect blind spots; they do not retroactively protect an already deployed candidate.
5. Pilot an ordinary migration-free change class first. Record actual runner cost and end-to-end lead time; no unmeasured speed claim and no paid runner assumption.

This is a proposed engineering acceptance method, not an official GitHub feature. A full suite can remain a periodic system audit and a high-risk-change requirement without remaining the synchronous barrier for every qualified low-risk artifact.

## Integration: qualify the combined candidate

GitHub merge queue tests a temporary candidate containing the latest base and changes ahead in the queue. Required Actions checks must also listen to `merge_group`; a PR-head pass alone does not test that combination. Merge limits regulate merges after successful group checks and do not combine `merge_group` builds. Availability includes public organization repositories; confirm live repository settings before adopting it. [GitHub: managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

An entire required workflow skipped by path/branch/message filtering leaves its check pending. A conditionally skipped job has different check semantics. Use an always-triggered policy witness that checks the expected job matrix and refuses missing, canceled, failed, or unexplained omitted evidence; avoid accidental success through skipped dependencies. [GitHub: troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

**ai-hr application:** use one integration owner and reviewed synchronization to keep `main` and `alpha` aligned at the accepted commit. A merge queue does not itself atomically update two branches or authorize production. Record queue candidate SHA/tree and resulting integration SHA/tree explicitly; never relabel evidence across identities. If reuse depends on equal source trees, define and verify that relationship in the evidence policy.

## Promotion: immutable artifact plus authenticated claims

The current `actions/upload-artifact` README uses v7 examples and describes the immutable artifact model introduced in v4. Name lookup alone is therefore an inadequate identity contract: retain artifact ID, digest, run ID/attempt, and source. Retention/deletion still require durable private release storage. Verify runner compatibility and pin a reviewed action commit during implementation. [First-party action repository](https://github.com/actions/upload-artifact).

GitHub's current attestation guide uses `actions/attest@v4`, with `id-token: write`, `contents: read`, and `attestations: write`. It supports file `subject-path` or image `subject-name` plus SHA-256 `subject-digest`, and verification through `gh attestation verify`. Private/internal repository attestation availability requires Enterprise Cloud; public-repository support differs. Verify actual account capability before choosing the private packaging implementation. [GitHub: build provenance attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

**ai-hr application:** build once for a defined target configuration; promote identical bytes. Bind test witnesses, migration ledger expectations, SBOM, toolchain/controller versions, candidate/tree identity, and acceptance records to the artifact digest. Verify signer repository/workflow/ref and expected inputs at promotion. Provenance proves origin and integrity, not that tests were sufficient or business behavior is correct. If environment variables are compiled into browser assets, define a compatible configuration strategy before promising the same build across environments. Do not put private package contents or sensitive manifests in public artifacts.

## Deployment protection and serialization

GitHub environment protection and concurrency are separate: every writer must opt into the same concurrency group. Protection rules gate job execution and secret access; they are useful enforcement points, not a replacement for target-host ownership and authenticated acceptance. Custom deployment protection rules require a deployment object, so `deployment: false` is incompatible with those rules. [GitHub: controlling deployments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments).

**Current API detail:** concurrency now documents `queue: max` for up to 100 pending runs; the default `single` replaces an existing pending run. `queue: max` cannot combine with `cancel-in-progress: true`. Waiting order is based on when runs enter concurrency, so dispatch order is not guaranteed. Do not rely on older advice that GitHub supports only one pending run. [GitHub: workflow concurrency syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).

**ai-hr application:** retain the shared target-host queue/lease across install, migration, service switch, acceptance, and capture. GitHub serialization complements it because human/legacy clients may bypass Actions. Never cancel an in-progress database/deployment mutation merely because a newer commit arrives. Separate staging and production environments; approval of an exact production artifact follows explicit owner authorization and staging acceptance.

## Caching and evidence reuse are different contracts

Turborepo assumes deterministic tasks. Its cache fingerprint includes declared task/global inputs; file outputs must also be declared for restoration. Input omissions can make a cache hit unsound. The principle applies without adopting Turborepo. [Turborepo: caching](https://turborepo.dev/docs/crafting-your-repository/caching).

GitHub dependency-cache restoration can use partial matches, and cache contents are not signed or verified. Current documentation supports `cache-mode: read|write|write-only|none`, with read-only defaults for certain low-trust triggers. Cache poisoning remains a boundary to design explicitly; a cache hit is not a test witness. [GitHub: dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

**ai-hr application:** package-download caches may reduce installation time while verification still executes. Reusing a successful check requires a separate trusted receipt and complete inputs: source dependency closure, fixtures/schema baseline, compiler/runtime/database versions, lockfile, test command/configuration, relevant environment, and controller policy. Do not reuse database/integration outcomes over mutable external state without a proven fixture identity. Cache or evidence lookup failure falls back to execution. Evidence reuse must preserve the original run and commit rather than manufacturing a new PASS.

## Database and worker compatibility determine rollback safety

GitLab's first-party multi-version guidance treats expand/contract as compatibility across nodes running different versions. Its migration guide illustrates new-column/copy/deploy/final-copy sequencing and explicitly says data migration design has no universal recipe. [GitLab: multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/), [avoiding downtime in migrations](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/).

Amazon identifies persistent/protocol changes as a frequent source of unsafe rollback and explains why old and new readers/writers must interoperate. Deployment reversibility must be designed before switching traffic. [Amazon Builders' Library: rollback safety](https://aws.amazon.com/builders-library/ensuring-rollback-safety-during-deployments/).

**ai-hr application:** expand first using the restricted migration owner; rehearse against a populated baseline and old/new app versions. Backfill in bounded resumable batches, verify reconciliation, switch readers/writers, and contract only after the rollback window and every old consumer/job have retired. Preserve applied migration bytes. Restoring the old application does not undo new writes or safely reverse a destructive migration.

For queue-backed workers, graceful drain does not mean exactly-once effects. BullMQ's first-party documentation says `worker.close()` waits for active TypeScript jobs without a built-in timeout; interrupted work may be recovered as stalled. This is a relevant mechanism example, not a finding that ai-hr uses BullMQ. [BullMQ: graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown).

Amazon's idempotency guidance uses caller-provided request identifiers, atomic recording with mutations, parameter-mismatch handling, and explicit late-request retention semantics. Payload equality alone cannot infer whether two requests express the same intent. [Amazon Builders' Library: idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

**ai-hr application:** a web traffic switch must also govern scheduler, consumer, and outbound-effect ownership. Green workers start without effect authority, prove compatible payload/schema handling, then acquire an auditable fenced ownership epoch; blue workers stop acquisition and drain under a bounded policy. Lease loss must prevent stale owners committing effects. Use business-operation idempotency keys, durable effect/outbox records, and downstream deduplication where available. Payroll/payment, employment transitions, mail, and provider calls need independent effect controls; turning off HTTP traffic or rolling back code cannot retract them. Validate crash-after-effect/before-ack, duplicate delivery, delayed old jobs, ownership races, and rollback after green writes. These are proposed contracts requiring implementation evidence.

## Decision limits

This research supports moving toward continuously qualified candidates and artifact promotion. It does not establish current ai-hr coverage, dependency-graph completeness, repository protection settings, attestation entitlement, worker fencing, target capacity, or zero-downtime readiness. Those require repository/runtime inspection and measured commissioning. Before changing release authority, review an ADR and qualify the selector, evidence verifier, migration compatibility, and business-effect controls against the actual installation.
