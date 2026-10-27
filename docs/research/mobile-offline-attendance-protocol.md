# Offline attendance protocol and integration design

Status: proposed implementation design under ADR-0088 and M05 of the mobile review.
Offline attendance remains disabled. This document does not claim implementation, migration
allocation, field acceptance or rollout approval.

The owner requested security/reliability before attendance integrity, offline attendance and the
remaining employee/approver flows. Android and iPhone are the current targets; Huawei NEXT is
deferred. No physical test devices are available. Preserve the approved offline-off default and
the proposed 24-hour window / 72-hour cap as design limits, not live company configuration.

## Verified integration constraints

- `core/attendance-clock.ts` stamps online captures with a new server instant, applies the
  two-minute sample rule and passes that instant to the canonical attendance writers.
  Replaying an old online command cannot create a historical offline punch.
- `db/schema.ts` defines clock methods as web/import/admin. Captures retain server-recorded time;
  punch/day readers currently consume that instant for precise ordering and live-clock display.
- `core/attendance.ts` owns day recomputation, duplicate/correction constraints and payroll-derived
  figures. It deliberately permits out-first and otherwise unbalanced punch lists. Offline code
  must not invent a stricter in/out state machine or calculate payable time.
- The base submission journal owns one online clock command and its encrypted photo per employment.
  The installed-account signed-clock journal owns the unresolved proof lease across employments.
  These bounded owners do not currently provide a multi-claim offline queue.
- `mobile/lib/clock-elapsed.ts` derives interval bounds without exporting raw uptime, wall/uptime
  pairs, boot identifiers or runtime identifiers. iOS process restart makes continuity unknown.
  These client reports are unverified evidence, not an authenticated clock.
- Existing correction workflows and audit events own human amendments and previous figures.
  Retained evidence must remain linked when an amendment voids or replaces a punch.
- Company profile trust comes from keys installed in the binary. Never accept a verification key
  embedded in an otherwise untrusted context as its own trust anchor.

## Decision and alternatives

Extend one installed-account proof-order owner for both online and offline commands. Do not add
a competing offline Apple-assertion queue: accepting a newer online assertion first could invalidate
older legitimate queued assertions. A pending offline stream prevents an unrelated online assertion
until its earlier claims have stable server dispositions. Other work profiles expose only a pending
count/reference summary; they cannot adopt or display another profile's private capture.

Each offline claim has a different purpose and versioned wire contract from an online command.
It carries a preissued permit, immutable claim UUID, scoped employment/key/context identity,
sequence and previous claim digest, action, reported fix/source facts, claimed wall instant, elapsed
interval evidence and exact photo digest. Persist intent and attachment ownership before signing,
then persist the exact proof before upload/provider work. Retry never captures a replacement photo,
changes the command, generates a new permit or silently switches to unsigned transport.

Keep the existing online server-time behavior. An accepted offline claim needs a distinct
`mobile_offline` provenance and effective instant; its upload receipt keeps the actual server arrival.
Do not overload `serverRecordedAt` with a derived earlier instant. Readers, exports, correction
history and current-status ordering must use an explicit effective-instant accessor with the
existing server instant as the legacy/online fallback. Pay calculations continue through the
canonical day/punch owners.

Alternatives rejected:

| Alternative | Reason |
|---|---|
| Retry online clock hours later | Wrong sample/arrival semantics; no historical claim adjudication |
| Separate offline signature queue | Competing assertion-counter owner and loss after newer online proof |
| Trust cached client policy or false mock flags | Snapshots and client reports do not authorize attendance |
| Mark every received claim clocked-in | Receipt/review and authoritative punch are different facts |
| Write a second payroll/day aggregate | Duplicates the existing canonical calculation owner |

The first portable claim byte contract is `lib/mobile-offline-clock.ts`. It binds the complete scope,
server-context digest, exact permit/nonce, context-local sequence/previous digest, original command,
photo digest, claimed wall instant, reported elapsed interval and source/app facts. Its current
32-slot context limit is a protocol resource bound, not an attendance policy or authorization.
Unknown/expired time can be represented for a later named review/refusal; the parser does not
apply the company's acceptance window. Local verification markers and raw native clock/boot/runtime
snapshots are deliberately absent from the wire shape. Context issuance, trusted issuer registry,
permit consumption, proof ordering, persistence and adjudication remain mandatory implementation
steps; this parser exposes no route or offline business effect.

## Context, trust and local storage

Issue context only after fresh own-employment authorization and reconciled device-key ownership.
Bind origin, server installation, tenant, company, actor, employment, app installation and device
key. Include the effective policy revision, bounded site/uncertainty/photo/device requirements,
expected attendance baseline, issued/expiry instants, nonce and bounded permit inventory.

Use purpose-separated server signatures and a trusted context-signing key registry. Establish
that registry online through the verified company origin and authenticated installation/key scope;
cache it separately from signed contexts in device-bound protected storage. A payload-supplied key
cannot approve itself. The exact registry/key-rotation contract must be implemented and tested before
issuing contexts; receipt encryption keys must not double as signing keys. Historical verification
and exact terminal receipt lookup must survive ordinary signing-key rotation.

Encrypt only the minimal context, claim queue, proofs and owned photo bytes. Extend the existing
installation-wide quota and device-only key lifecycle. Do not persist salary, team, balance or inbox
caches as a side effect. Keep raw native snapshots app-local; upload only the approved elapsed bounds
and continuity outcome. Unknown/restarted continuity is a review reason, never reconstructed from
device wall time. Mathematical bounds alone do not prove that a client honestly measured duration.

An offline-off capture remains an attempt claim and must never mint a punch. Supported offline
capture says saved/awaiting upload; it must not change server clocked-in status or claim payroll
acceptance. Local cache simulation and synthetic SDK tests do not establish airplane-mode behavior.

For the native anchor handshake, retain the original request-start and response-received snapshots
under the same immutable request nonce across retries. The server mint instant lies within that
exchange only after issuance/nonce binding is verified. Event elapsed lower bound comes from
response-to-event; upper bound comes from original-request-to-event. Response-only subtraction
would falsely remove network/server uncertainty. The local `elapsedFromServerExchange` helper
reports these bounds without authenticating the server instant or granting attendance authority.

## Server admission and adjudication

1. Bound the manifest, individual artifacts and total request before expensive work. Authenticate
   afresh. Resolve every claimed employment under the original actor/tenant; refuse adoption.
2. Decode strictly, verify context signature/issuer/scope/permit and canonical command/photo hashes.
   Recover exact committed claim receipts first under the same subject; a reused UUID with a
   different digest is a conflict, not replay success.
3. Verify native signatures and current upload-time Android evidence. Play Integrity at upload
   describes that upload environment; it cannot retroactively authenticate an offline location.
   Provider outage preserves retryability and does not become successful verification.
4. Process a contiguous claim prefix in proof/counter order, with deterministic key then subject/day
   locking consistent with existing integrity writers. Do not consume a later counter while an earlier
   claim is missing. A partial-batch retry observes earlier receipts without re-consuming them.
5. Recheck current own scope, key revocation, company rollout/policy, permit use and relevant
   correction/payroll locks inside the acceptance transaction and again at the commit boundary.
   Derive and retain claimed, fix, effective bounds and received instants separately.
6. Persist one stable received/accepted/needs-review/refused outcome per claim. Only accepted claims
   invoke the canonical attendance writer in that same transaction. A review/refusal must not create
   a payable attendance fact. A committed refusal still has an auditable receipt and cannot later
   be silently reinterpreted under another configuration.
7. Human resolution uses current scoped correction permissions, expected revision and a reason.
   Reuse correction/day owners; retain the original claim and audit lineage. Payroll-locked or already
   corrected history goes through its existing authorized resolution path. No model supplies decisions.

A chain detects changed/reordered interior records; it cannot prove an unsynced tail never existed.
Order and duplicate rules must match the existing canonical behavior, including out-first days.
Different devices and concurrent web/import activity are reconciled against actual current facts,
not an assumed cached shift state. Policy/site changes require a named configured disposition;
the snapshot alone never grants an exception.

## Proposed persistence and delivery boundary

Coordinate one additive migration before allocating a number. Expected logical entities are
offline context/anchor, per-key permit/stream consumption and immutable per-claim disposition,
with explicit links to accepted capture/punch and any canonical correction resolution. Keep tenant,
actor, employment, device key and request uniqueness enforceable under RLS; do not trust submitted
owner fields. Add offline provenance and distinct effective/arrival timestamp representation where
the existing capture/punch readers need it. Preserve online bytes and behavior.

Choose final table/column names after the transaction/key-order review. A separate resolution table
is justified only if existing correction linkage cannot own that relationship. Do not add a second
history of canonical day figures. Migration allocation must preserve the coordinator's other
reservations and the existing held Android custody draft; reservation does not authorize apply.

Provide versioned context/claim-batch/receipt and HR-resolution APIs. Do not insert new meanings or
closed enum outcomes into installed v1 clients. Current native history/status, web timesheets,
exports and correction views must label offline origin and show effective versus received time.
Minimum-version/upgrade behavior is part of delivery, not an excuse to show an old client a
mislabelled server-arrival instant. Keep all new issuance/acceptance rollout paths off by default.

## Acceptance before enabling offline attendance

- Airplane mode across a shift, sleep, force quit/update/reboot, wall-time/timezone changes, missing
  keys, expired context/permit, photo loss, quota exhaustion and privacy/logout transitions.
- Exact and reordered/partial/duplicate batches, missing predecessor, concurrent devices, newer
  online proofs, reused UUID/different payload, altered coordinates/source/time/photo and counter races.
- Wrong app/package/environment/origin/installation/actor/employment/key; revoked/replaced keys and
  removed grants; vendor outage and unknown source capabilities.
- Policy/site/schedule changes, out-first/unbalanced days, cross-midnight shifts, corrected and
  payroll-locked history. Received/review/refused states create no payable punch.
- Server-authored effective/arrival provenance in all relevant readers/reports; authorized human
  resolution with reason, expected revision and retained original evidence.
- Frozen hosted tests, negative guard probes, native compiler/production bundle checks and the
  required full release gate. Physical iPhone/Android signed builds must exercise real vendor,
  airplane-mode, continuity and OS-location behavior before rollout. Those witnesses are currently
  unavailable; they must not be replaced with synthetic success.
