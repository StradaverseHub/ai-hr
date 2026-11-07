# ADR 0180 AI centre function controls and stop all

Date: 7 November 2026

Status: Owner authorised implementation. Release qualification and the exact provider-source binding remain separate.

## Decision

Administration > Workers is the inventory and control entry point. Extend the existing feature, worker, action and mandate registries rather than creating competing switches. Keep one authoritative owner for each existing switch. Add child restrictions for individual reads, guidance topics, import types and module reads where only a parent control existed.

The inventory derives its keys from the gateway features, agent actions, worker registry, semantic reads, Assistant tool catalogue, context tools, import kinds and module jobs. Standalone drafting, analytics and Performance generation services have explicit operation children, including those sharing a gateway feature. Cache-only viewing remains available. Recurring-job enablement uses the existing mandate job-type owner. Payroll learning retains its per-company settings. Required HR validation, native manual workflows, audit, erasure and retention stay available. Scheduler rows describe shared infrastructure: disabling one worker does not stop the whole scheduler or required retention.

A child setting grants no native authority. Effective permission remains the intersection of current authentication, module and company scope, existing feature/worker/action controls, child restriction, allowances and stop-all. Group administrators manage tenant controls; company administrators retain the existing company loop pauses. This change does not introduce company-specific child-read overrides or raise any automation ceiling.

The migration registers the currently available read keys while preserving their prior behaviour under parent controls. Unknown future keys fail closed. Future functions must register explicitly, default off, and add a coverage test. Current function-key coverage is checked against the actual migrated database.

## Stop semantics

Reuse `teras_mandate_control`; its existing version is the activity generation. Native effects and stop writes join the same tenant `ai-control` transaction lock. Where access configuration is also needed, take its lock first. A stop waits for effects whose authorisation already holds that lock. After its commit no newly authorised AI effect may pass. Do not hold a database transaction across provider or SMTP traffic.

Request data and session scope are captured before the asynchronous control read; issued harness permits retain their server identity. Standalone module planning participates in the same activity boundary as a chat turn. Server-issued asynchronous activity context carries the original tenant and generation across native owners. Nested work cannot replace it. Admission, provider dispatch checks, returned results, native action writes, loop writes, learning and AI-originated domain events recheck the generation. Stop followed by resume invalidates the older work. Canonical module reads enforce their child settings even when invoked by a governed plan outside chat. Topic-family and individual topic restrictions both apply. Individual function restrictions also follow an activity through native effect transactions.

A provider request whose dispatch was authorised before stop may already have left the process. It cannot universally be recalled. Pending model-run accounting is shown as unsettled requests; stopped results cannot authorise a new effect and usage settlement still runs. Provider connection tests also honour stop-all and their own child switch, while retaining metadata-only accounting outside workload quotas.

Optional AI notification events receive immutable companion generation metadata in the same transaction. Database-generated payroll cut-off notices receive the same metadata through a narrow trigger; each native reminder batch retains and checks its original generation. Their exact audited payload and attribution policy remain unchanged. The stamping port only accepts an AI event inserted in the current transaction; old events cannot be restamped after resume. Unsent email stays pending while stopped; a database trigger independently refuses its privileged delivery start. After resume, old-generation AI reminders are ineligible and are not replayed. Unprojected stale in-app reminders are suppressed; their source events and underlying HR work remain available for review. Required manual notifications, undo and withdrawal notices continue. Delivery already authorised before stop may finish and must retain its actual or uncertain outcome.

Resume uses optimistic generation matching so a stale page cannot undo a newer stop. It restores no permissions and changes no individual switch. Work is re-evaluated from current facts on the next eligible run; it is not a replay of old authority.

## Failure handling and verification

A missing control helper, failed state read or failed database check cannot allow AI execution. The UI shows unavailable state rather than running and never offers resume from an unknown snapshot. Application and SQL control ports recheck current group authority. Tenant predicates and native row-level security remain in force.

Required checks include fresh and in-flight stop, stop/resume, concurrent stop versus effect, stale resume, unknown functions, role/tenant isolation, one child off with unrelated children available, native effect rollback, private delivery start, provider-result discard and accounting, existing loops/mandates, rendered controls and whole-repository type checking. Run application checks on standard GitHub-hosted runners. Qualification is against the frozen candidate; preserve original failures and rerun affected areas only.

The covered provider-source bytes change because controls are in the execution closure. Keep the previous literal approvals unchanged until the repository owner reviews the final binding packet. Generating a fingerprint is not approval. No new outgoing field, provider contract, employment decision, monetary calculation or native permission is introduced by this decision.

## Operational follow-up

The remaining lean-HR work follows the agreed plan: consolidate exception handling and reminders, measure active human handling time and service quality, then evaluate a pilot spanning two payroll cycles. Configurable automation alone does not establish a staffing target. Production installation requires a separate explicit request under repository release policy.
