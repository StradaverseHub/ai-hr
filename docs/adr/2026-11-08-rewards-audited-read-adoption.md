# Rewards audited reads: installed receipt and projection boundary

**Status:** Proposed adoption design; not installed or enabled.
**Date:** 2026-11-08.
**Deciders:** Architecture integration owner, with independent correctness and
security review before migration allocation or application implementation.

## Context and retained evidence

The exact design base is `315467b94d49011ba367a54c46a4eaa2e90b8a8a`.
Root verified native42422798419:16 passed/0 failed/0 pending; artifact13594585682,
ZIP SHA256 `7afab9ea7434a11be6fca9f8101284154d35917c066eed1665710196479cdbff`.
The original3 ownership models and323 legacy assertions remain evidence at their
original00779 source/runs42415491165/42415491484. No result is transferred to a
future installed migration, different owner, process profile or app integration.

`rewardLibraries` and `rewardPatInputs` still use `setupTenant`: exclusive Access
admission, canonical query/validation, then `setupEvent` before COMMIT/return.
`app.domain_event_chain_tg()` calls0863 `_domain_event_next`, which takes History
serialization even when chain policy is unarmed. That is an intentional durable
read audit, so ordinary RR/RO cannot replace it. Libraries, PAT and Plans invoke
these facades; PAT import preview also invokes PAT reads. Separate exports and
financial/confirmation commands have separate audit contracts and remain intact.

The qualified prototype retains the canonical real-Tx query owners, RLS/native
permissions, money, IDs, ordering and history. It proves durable-before-return
receipts and exact-once later canonical projection under genuine Access/History
writers, concurrent projection and SIGKILL. It is deliberately UNINSTALLED,
armed-chain-only, loopback-only, and has its own isolated three-slot family.
It supplies neither production pool reservation nor an installed process/secret/
startup boundary, unarmed compatibility, complete native-owner rehearsal or
rendered/load acceptance. These are mandatory adoption work, not inferred passes.

## Decision

Adopt the existing two canonical read facades through one installed audited-read
purpose. Keep their public DTOs and invocation cardinality; every successful call,
including an empty result, commits one immutable native receipt before its Promise
resolves. A dedicated least-privilege processor projects each receipt once through
the unchanged canonical event/chain owners. No browser acknowledgment, HTTP200,
request arrival or cache hit manufactures a successful read audit.

The trusted service owns the delivery boundary: await confirmed COMMIT before
releasing any DTO. A direct authorized SQL client can read and then ROLLBACK; the
database cannot prove network delivery or prevent that client retaining bytes.
Deferred commit completeness is not a claim of protection against an untrusted
credential holder. Uncertain commit returns no successful protected response and
is not automatically replayed as a new disclosure. Separate user invocations
remain separate receipts, as current repeated reads create separate events.

| Boundary | Installed responsibility |
| --- | --- |
| Canonical data | Existing `setup-query-owner.ts` plus a closed native port, actual Tx only; same validation, version/revision/usage/locked facts, PAT partitions, names and numeric representation. |
| Human read | One fresh RR/RW transaction; immutable captured context/filters; actual active login, current principal, Rewards activation and existing NULL-company view/manage checks before data. No generic agent/statutory/exempt carrier. |
| Receipt | Native UUIDs/tenant/user/observation/event identity and closed operation/filter tuple; no caller actor/payload/SQL broker or financial digest. Finalize and deferred native gate enforce the exact receipt+pending intent in the same transaction. |
| Projection | Actual separate LOGIN, fixed native APIs only; canonical event type/actor/filter metadata, observation time, append time and unique receipt/event link; no HR/money/config writes. |
| Coverage | One audit fact per receipt whether pending or projected; native counts/oldest lag/failures/processor state, current audit authority, and explicit chain-vs-disclosure completeness. |

Revocation committed before the fresh admitted snapshot refuses. An overlapping
read may finish from that snapshot; a receipt is never a later command permit.
This is the reviewed snapshot ordering contract, replacing tenant-wide read/write
serialization. Existing command/approval/CAS scopes and locking remain unchanged.

## Native ownership and effective privilege closure

Do not copy a postgres/superuser fixture installation into production. Before a
number is allocated, inspect the actual native function/table/schema owners,
complete bodies/ABIs/ACLs/RLS/FORCE flags, memberships, default privileges, triggers
(including internal bindings), rules and indexes. New owned functions must be
created by the actual canonical NOSUPERUSER/NOBYPASSRLS migration owner; original
`ai_hr_reward_setup_reader` functions keep their distinct owner and native guards.
Function-only/table-only owner drift and unknown bodies refuse atomically.

Preprovision two fixed NOSUPERUSER/NOBYPASSRLS/NOINHERIT/NOCREATE*/NOREPLICATION
LOGINs with separately rotated credentials. An explicitly protected provisioning
owner may create those roles; do not give CREATEROLE, app membership or owner
credentials to either service. Migration guard verifies their actual OIDs/flags,
no memberships/settings, no effective business writes, no sequence authority,
no app-schema USAGE and no unexpected reachable SECURITY DEFINER capability.
Reader SELECT remains only the two library sources under unchanged RLS plus its
fixed receipt helpers; PAT data stays behind the existing protected query owner.
Projector has no financial SELECT or arbitrary event-insert authority.

Two exact existing helper EXEC grants are required by library RLS despite absent
app-schema USAGE: `app.reward_setup_allowed(uuid,text)` and
`app.current_tenant_id()`. The former has the separate setup-reader owner.
Inventory the actual migration principal's grant authority first. If it lacks
that capability, prepare a narrowly guarded provisioning action executed by the
actual owner/admin; never add blanket app membership, transfer the helper owner,
loosen RLS or assume schema ownership grants function ownership. The complete
installed-role closure must be tested under the actual non-super owner.

## Arming compatibility: a blocking prerequisite

The prototype's existing-chained-event requirement cannot serve an unarmed
installation. Production supports both policies without arming a tenant merely
because receipt mode was enabled.0863 remains the only event/hash append owner;
never bypass its trigger or insert deliberately unchained rows when policy is on.

Extract one canonical audit-policy snapshot boundary from the current
`db/client.ts`/`chainArmingDecision` owners, preserving the actual resolved setting,
legacy env fallback and existing-history refusal to disarm. Bind runtime fallback
to the protected installed configuration; no reader-supplied GUC/boolean may choose
it. The new native admission must derive/validate this canonical policy evidence,
not trust arbitrary SessionContext settings or duplicate an unversioned default.
Native owner/helper/config prerequisites and the entire old decision truth table
must be proved before enabling unarmed reads. Do not casually change every module's
transaction behavior to make this purpose work; factoring must preserve their
existing outputs and baseline native guards exactly.

Record observation policy/version separately from canonical append policy.
Projection resolves the canonical current policy and must retain an authenticated
armed-at-observation floor, so a delayed first armed receipt cannot become an
unchained hole after a settings flip. An unarmed receipt does not force arming;
if legitimate policy arms before append, the unchanged trigger may chain it then.
Existing chained history is always monotonic. Model absent/false/true/malformed
settings, env fallback, first arming, concurrent flip and initially empty history
with real native before/after chain verification. Unknown/mismatched policy
versions refuse and retain pending evidence. This policy bridge is NOT already
proved by the armed-only16 cases; it requires a separate reviewed implementation.

## Pending work, exact-once projection and fairness

Use an indexed native pending-intent relation, inserted with the immutable receipt
and removed only with the committed canonical link. A growing anti-join over all
historic receipts is not the production polling path. No tenant/user/content FK,
shared tenant counter or History/Access lock belongs in receipt COMMIT; a newly
created receipt's own fixed identity is sufficient. Native finalization proves
receipt plus pending intent; all raw writes are unavailable to runtime LOGINs.

Claim a bounded homogeneous tenant batch (at most the existing25 receipts) per RC
transaction with SKIP LOCKED, then use the existing post-lock fresh link recheck.
One tenant per transaction avoids acquiring multiple tenants' History locks in
opposite order. Event insertion, canonical trigger, exact native tuple/hash check,
projection link and pending removal COMMIT atomically. Late lower-ID commits stay
in pending discovery; no ID/time watermark can skip them. Preserve the controlled
old-cursor/other-commit-before-lock race regression, even with the new pending row.
A native receipt-to-pending consistency witness and guarded reconciliation may
recreate missing work only from a real committed unprojected receipt, never from
old events or a caller payload.

Native job/run identity and counters derive from actual committed links. SIGTERM
stops admission and drains the actual transaction; SIGKILL leaves pending or a
committed link, never an invented successful counter. A lost commit response is
uncertain: reconnect only through native exact run/backend-start recovery and
rediscover real pending/link truth, not an automatic general retry. Separate
transactions/tenant fairness keep one held chain or poisoned tenant from undoing
other tenants' completed batches. Unsupported receipt/profile versions halt their
work with visible pending failure; no deletion, skipped-success disposition or
unbounded retry. The initial processor remains bounded by20s SQL/300ms locks and
a reviewed fixed run/batch budget; final production values need measured proof.

## Real capacity, process and credential boundaries

Extend the actual application budget family, not an independent full pool:
`webWorkers * (ordinaryPool + receiptPool) + projectorConnections + otherReservedBackground <= totalConnections`.
The per-web declared pool maximum remains its TOTAL, split between ordinary and
receipt lanes; the shared abortable admission is acquired before physical checkout.
The projector reserves its own fleet share once. Native worker role limits and
startup must enforce the same protected configuration, including2/4/8-worker
comparisons. Missing/inconsistent reservation refuses startup. Choose actual lane
sizes only after production resources/other workers and measured demand are known;
prototype1+2 is not a production sizing recommendation or extra connection budget.

Use a built immutable projector entrypoint and dedicated unprivileged OS account.
Its protected exact profile binds source/entrypoint/dependencies, native API version,
DB endpoint/identity, fixed LOGIN and credential source. It receives ONLY projector
credentials, no general DATABASE/MIGRATION URL, provider tokens or web secret file.
The web purpose receives only its reader credential through its own validated
server secret closure. Do not reuse the owner-credential notification sweep or
`node --import tsx` prototype child as the production installer. A new closed
worker credential/profile must be reviewed independently; do not weaken existing
web systemd credential-array refusals. Startup verifies actual LOGIN/object/profile
and its reserved lane before reporting ready. Shutdown and abandoned-run recovery
must be proved against the built process with real native commit facts.

## Audit coverage, retention, rollout and fallback

Central audit readers/counts/exports need a receipt-aware projection: pending and
linked representations are one logical fact; link/event joins cannot double count.
Retain actor/observed-at versus appended-at explicitly. Existing chain.valid only
covers chained rows, so it cannot be advertised as complete disclosure coverage
while pending receipts or processor errors exist. Expose bounded native status and
alert on pending age/count, repeated failure, stopped processor and consistency
mismatch. Protected pending capacity thresholds require measured storage/WAL/lag
headroom before enablement; exceeding a bound refuses before protected success,
not after returning unaudited data. A failed background processor cannot silently
discard facts or make healthy-looking complete status.

Initial retention matches the current immutable audit lifetime: no receipt/link
TTL or pruning job. Transient admissions are removed transactionally as today.
Capacity/reconciliation/backup must include receipts, links and pending work.
Any later archive/prune policy requires separate authority and complete linkage
proof; never delete pending rows. No historical event is backfilled with invented
receipt IDs or rehashed. Existing immediate events remain legacy facts.

Install/qualify native schema, roles, coverage and protected processor first with
receipt reads disabled. Enable only via an owner-controlled versioned capability
record after clean commissioning and budget reservation. Old binary/new schema
continues existing immediate audit. New binary/old schema uses an explicit known
legacy deployment mode; missing/corrupt objects or arbitrary42501 are not a reason
to catch-and-fallback. An enabled profile failure refuses protected success and is
visible operationally. Rollback disables new receipt admission but keeps projection
and coverage for every already committed receipt. Avoid dual event+receipt writes
that create two views or keep the old History wait in the new read.

After native/installed-process proof, change only the two facades to the installed
purpose; keep query owners/DTOs/call counts. Plans' full PAT/library audit remains,
including its currently broader data retrieval. Metadata-only Plans queries would
be a separate domain contract. PAT import preview remains a required integration
case. Exports and all commands keep their existing semantics until a separately
closed purpose is designed and qualified; do not claim all Rewards paths are
nonblocking while those or other read owners remain unaudited.

## Alternatives and consequences

| Option | Assessment |
| --- | --- |
| Immediate chain event before return | Existing durable behavior; inherently waits for the chain head and Access owner. Keep as explicit compatibility mode, not the new speed guarantee. |
| RR/RO plus unawaited audit, dropped event or later client receipt | Rejected: changes success/durability and loses facts after cancellation/crash. |
| Durable native receipt plus bounded canonical projection | Chosen: removes synchronous chain contention from the two reads, retains deterministic native authority and durable intent; costs storage, operational coverage and precise observation/append semantics. |
| New remote broker/audit service | Deferred: adds distributed acknowledgment/recovery infrastructure without evidence that this PG transactional boundary is insufficient. |

The change is a new internal audit execution boundary, not a financial engine or
permission redesign. Fast correctness gates, actual installed process qualification,
nonempty rendered journeys and load proof remain necessary. It does not promise
successful pages during storage/audit failure or claim universal nonblocking
commands. Production remains held; no migration is allocated by this ADR.
