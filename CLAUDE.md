# Working in ai-hr

This is the canonical repository instruction file. Read only the task-specific references below; historical notes and previous chat memory are leads to verify, not current implementation facts.

## Start every session

1. Confirm the checkout exists, then run `pwd`, `git rev-parse --show-toplevel`, `git branch --show-current`, `git status --short` and `git worktree list`. Use the verified checkout explicitly in every shell command. A directory named mainwt does not prove its branch.
2. Read [repository policy](docs/REPOSITORY-AND-ENVIRONMENTS.md). Fetch the intended remote refs, then run `git rev-list --left-right --count HEAD...origin/main` and the equivalent for `origin/alpha`. If fetch fails, report that freshness is unknown. Choose the task's integration base explicitly. Preserve WIP; refresh a clean, behind-only checkout by fast-forward, or create an owned worktree from the verified base. Investigate divergence before editing.
3. Read current code, tests, configuration and the relevant owner decision. Query the target installation for runtime claims. Record the candidate SHA and environment with evidence. Merged, tested, installed and accepted are separate states.

## Engineering constraints

- Model actors, permissions, ownership, states and failure paths before building. Keep one owner per business fact. Distinguish verified facts, assumptions and unknowns; challenge weak premises with evidence and a concrete alternative.
- USER, PERSON, EMPLOYEE, EMPLOYMENT, ROLE, PERMISSION and SCOPE are distinct. Preserve tenant/company isolation, effective dates, audit history and existing internal IDs. Define permissions for every new screen and service.
- Models propose; deterministic authorized services adjudicate. Human decisions govern sensitive employment/pay/access outcomes. LLMs never calculate money or become HR truth. Test leakage, injection, unauthorized actions and failure behavior. See ADR-0084 and task-specific later decisions.
- Kernel consumers use `packs/<pack>/service`; country behavior resolves through the pack registry. Import/drift allowlists only shrink. Follow `GLOSSARY.md` for shared domain terms.
- Authentication direction is embedded HR login, MFA and recovery: [ADR-0117](docs/adr/0117-embedded-hr-authentication.md), [installation guide](deploy/internal-auth/README.md). WorkOS and Keycloak remain compatibility adapters in source. Inspect provider selection and deployment configuration; their presence does not prove activation. Preserve identities and grants; never auto-link accounts by email.
- Read `package.json`, the lockfile and current configuration for versions/commands. For Next.js work, consult the installed `node_modules/next/dist/docs/`. Give build worktrees real dependencies: external node_modules symlinks can fail Turbopack resolution. Keep private environments private.

## Verification and shared resources

Run builder checks, application tests, whole-repository type checks and release verification on standard GitHub-hosted Actions runners. The owner confirmed on 30 October 2026 that this removes the Mac verification bottleneck; local resource slots are a temporary fallback only while the Actions controller is broken. Use `alpha-focused-checks.yml` for development and the authenticated CI operator route for releases; focused passes alone do not authorize release. See [Actions execution policy](docs/REPOSITORY-AND-ENVIRONMENTS.md#public-repository-actions-capacity).

Use focused behavior checks during development. Before release, follow the impact classifier in `scripts/gate.sh`, [ADR-0114](docs/adr/0114-impact-aware-release-and-learning.md), and [CI policy](docs/CI-STAGING-VERIFICATION-POLICY.md). Type checks, tests, production builds, migration rehearsals and rendered journeys establish different claims.

Let all planned full-gate chunks finish against the frozen candidate, including after a failure. Preserve original failures; repair afterward and rerun failed/affected parts under the validated evidence policy. Retain unaffected valid evidence. Never manufacture PASS receipts or relabel evidence onto another commit.

For the temporary local fallback, [resource admission](docs/LOCAL-RESOURCE-LOCKS.md) owns locking. Call `bash scripts/gate.sh` directly: it requests both memory slots and the database atomically. Partial outer locks refuse; do not nest single-slot wrappers around gates. During a shared full gate, other workers only read/edit/commit: no tests, compiler, builds, seed or dev server. Coordinate database rebuilds; namespaces do not isolate a cluster rebuild. Preserve foreign/uncertain leases and processes.

Verify observable outcomes with real authorized fixtures, failure paths and rendered screens/logs. HTTP 200, an i18n key in an RSC payload or a source grep alone does not prove a working screen. Assert nonempty source slices, ordered query results and independent expected values. Derive dates through the repository's HR date owner. Diagnose unchanged-code failures rather than assuming either a regression or an environment fault.

## Database changes

Append migrations and journal entries; applied SQL bytes are immutable. Coordinate allocation using [migration allocation](docs/MIGRATION-ALLOCATION.md). Check timestamp watermarks and ordered applied hashes: a lower timestamp can be silently skipped. New tables need grants as well as RLS. Review every writer before constraints; NOT VALID still affects subsequent writes. Shadow migration and populated-baseline rehearsal cover different risks. Verify any required data script separately; deployment does not imply it ran.

Local database settings are disposable and machine-specific. Inspect the rebuild script and active configuration before use. Never apply local RAM-disk/fsync settings to an installation or run the demo seed as a documentation refresh.

## Collaboration, feedback and release

Preserve others' changes and shared Git history; use owned branches/checkpoints rather than repo-global stash or destructive resets. Give delegated workers separate worktrees, file ownership, database namespaces, ports and evidence directories. Freeze and inspect every contributing branch and uncommitted diff before integration.

For feedback work, read the actual item, attachments and approved plan through `scripts/improve/README.md`. Use the feedback-plan skill for plain-language plans, one proposed course and rendered screen mockups. A plan pushed to a deployed item can reset its status; verify the target/status and command result. Explicit user authorization governs external replies.

For release planning, staging acceptance, production package publication or live installation, read the [production release handoff](docs/PRODUCTION-RELEASE-HANDOFF.md) first. Release policy lives in [repository policy](docs/REPOSITORY-AND-ENVIRONMENTS.md), [deployment](deploy/DEPLOY.md), [operator access](deploy/OPERATOR-ACCESS.md) and [production packages](docs/PRODUCTION-PACKAGES.md). Verify the actual target before invoking tooling. Staging acceptance precedes a separately requested production deployment. Branch alignment and package publication grant no additional deployment authority. Keep secrets and release assets in their designated private stores.

Document durable decisions in ADRs. Use commits, release records and the board for task status; do not append another round transcript. Keep historical source behind explicit task-specific links, out of automatic context. Follow [documentation maintenance](docs/KNOWLEDGE-BASE-MAINTENANCE.md) for bundled guides and translation review.

<!-- BEGIN:nextjs-agent-rules -->
Read the relevant installed `node_modules/next/dist/docs/` before framework changes; APIs may differ from training data. This generated block may be refreshed by Next.js.
<!-- END:nextjs-agent-rules -->
