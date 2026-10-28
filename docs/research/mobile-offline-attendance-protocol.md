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

### Context signature primitive

`lib/mobile-offline-context.ts` defines a bounded strict context and purpose-separated positional
bytes. The signed context binds the original request UUID and client nonce, full scope, platform
and application target, issuer identity, issuance/expiry, policy revision and snapshot, site set,
attendance baseline and ordered one-use permit inventory. The issuance request accepts only
request/nonce and existing installation/key references; callers cannot submit policy or ownership.
Site order is canonicalized; permit order is significant. The 32-claim bound is shared with claims.

`lib/mobile-api/offline-context-signature.ts` signs and verifies actual Ed25519 bytes against a
separately supplied trusted issuer registry whose identifiers are SHA-256 of raw public keys.
It rejects self-supplied envelope keys, unknown/revoked issuers, issuer validity gaps, cross-scope
inputs and modified signed fields. It loads no key files, environment credentials or DB state.
A valid result explicitly returns `authorization: not_granted`: signature validity alone decides
neither current policy nor expiry adjudication, issued-record existence, permit consumption or a
canonical attendance write. Registry provisioning/rotation, transactional issuance, native
verification and batch adjudication remain separate unfinished work. Tests generate keys in memory;
no actual deployment signing material is created or distributed by this primitive.


The iPhone/Android verifier in `mobile/lib/offline-context.ts` uses the existing pinned Noble
Ed25519 implementation in strict mode and Expo SHA-256. It verifies the same canonical server
bytes and independently supplied issuer fingerprints; it additionally requires the original
request UUID/nonce and expected app target from the current connection owner. Expected installation
and key references must agree with expected scope. Trusted inputs are parsed into separate snapshots
before asynchronous hashing, and ownership is checked before/after every hash, including failures.
It returns signature validity with `authorization: not_granted`, without fetching, persisting,
issuing or consuming permits, deciding elapsed-time trust or writing attendance. It remains an
integration prerequisite; no offline screen/queue or registry endpoint is enabled by adding it.
The host test executes the shipped adapter with actual Noble signature verification and Node
SHA-256 in place of the Expo OS hashing port; that does not prove native OS or physical-device use.


### One journal for online proofs and offline context exchange

The installed-account signed clock snapshot now has a v2 form with mutually exclusive online pending
work or an offline context exchange. Legacy v1 online snapshots normalize in memory, preserving
original command/context/proof bytes; only subsequent committed transitions write v2. The encrypted
storage domain, account scope, commit pointer and serialized queue remain the existing owner. An
older binary refuses the new strict format rather than adopting an empty alternative journal.

Offline reservation saves the original request binding, reconciled key reference and app-local
request-start clock snapshot before the context request port may run. Same-binding retries retain
that first anchor; another request/employment cannot replace it. After the response, a second local
snapshot is captured before signature verification and committed alongside the exact verified raw
context/digest. A ready context is reverified before reuse, without fetching a replacement or moving
the anchor. Online start, advance, receipt lookup and abandonment cannot bypass this owner. The
employee clock displays a distinct unfinished offline-preparation state and disables online preparation.

The existing sealed storage admits a bounded 256 KiB clock snapshot for escaped context/anchor data,
within the unchanged 64 MiB installation quota. Offline acquisition is a new allocation, never a
quota-exempt resolution merely because online pending is empty. Existing receipt-driven online
resolution remains possible at the cap. Raw snapshots/native references stay in encrypted local state;
only the strict binding goes to the context request port. No live adapter supplies these optional
ports yet. Offline claim signing/storage, close/retirement recovery, registry provisioning, batch
sync and server adjudication must be integrated before any offline entry point is enabled.

### Durable local capture and photo handoff

`captureOffline` now records a claim under the same installed-account owner. Before a new claim it
reverifies the saved server context, checks its permit inventory and existing claim hashes, and binds
the original base command, photo digest, actual reported app/source fields and elapsed evidence from
the retained exchange anchors. Its app-local event snapshot remains outside canonical transport bytes.
Unknown continuity stays unknown; claimed wall time grants no authority. No new in/out sequence rule
is introduced. The context's 32-slot resource limit and installation byte quota remain explicit bounds.

Each claim advances through `capture_requested`, `photo_retained`, and `captured`. The first commit
precedes photo retention; the second precedes release of the original base slot. Same-ID retry keeps
the original claim/event/permit, including after a lost commit or base-release acknowledgement.
A different claim cannot pass an incomplete handoff. Local capture returns `acceptance: not_granted`;
it neither creates a device proof nor sends a clock command, records attendance or clears the claim.

The native store retains bounded image bytes with separate photo AAD under the existing device-only
installation master and installed-account directory. It requires a committed matching claim and
checks exact byte length/SHA-256. A staged sealed file is moved into place without overwrite; an
existing retained file must decrypt and match. Tampering/missing data fail rather than silently
replacing history. Only after that retained checkpoint may the base command/photo be released,
allowing another offline capture without losing the earlier image. New photos and claims respect
the installation quota. Strict phase-only progress with identical existing claims may finish at the
cap, like existing receipt recovery; it cannot admit another command, context or image.

The optional local capture ports are not supplied by a live offline screen/controller yet. Proof
creation/recovery, authenticated registry provisioning, context issuance, stream consumption, batch
sync, canonical effective/arrival provenance, HR resolution and the employee flow remain unfinished.
The centrally reserved draft filename is `0647_mobile_offline_attendance`; journal index and timestamp
remain integration-bound and must not be inferred from the filename or reused source metadata.

For protocol feasibility, Apple's [App Attest explanation](https://developer.apple.com/videos/play/wwdc2021/10244/)
describes assertion generation on the device after enrollment, without an Apple server call, and a
server-validated increasing counter. Our inference is that preissued one-use challenges can support
later local signing; this still needs actual airplane-mode/device measurements. Android's
[Keystore documentation](https://developer.android.com/privacy-and-security/keystore) describes
non-exportable key operations but also warns that a compromised process may still invoke its keys.
Neither source establishes trusted GPS/capture time. Sync-time integrity cannot be presented as proof
of capture-time integrity; server verification, policy and auditable review remain necessary.

The native iPhone assertion handoff cache and its host-model CI path are described in ADR-0147.
The application proof journal must own a completed proof before releasing that cache and must keep
online/offline counter order serialized. Native cache support alone does not provide an offline
signing flow. The one-use enrollment cache is unchanged; its requested-state recovery rules must
not be relaxed to match repeatable assertion semantics.

### Ordered local proof handoff

Captured claims can advance to `signing` and `proof_ready`. The same installed-account owner
commits signing reservation before inspecting/using native proof operations. It verifies retained
claim hashes and the original server context before new proof work. A later claim cannot start
proof generation before every prior proof is durable and its native handoff is released. Local
capture may continue behind an uncertain earlier proof; signing cannot skip it. Stored state with
out-of-order proofs is refused, rather than silently opened as a new queue.

An iPhone completed-cache result recovers the original assertion without a new SDK call or a
requirement to recover a now-missing photo first. An unknown live request remains held. Only native
`retryable` or actual process-replacement permission allows explicit same-payload generation again.
Before generating new proof, retained photos must still pass their owned integrity read. A proof
is saved before native cleanup; lost proof-write/cleanup acknowledgements reuse the durable proof
or cache on retry. Cleanup may finish without refetching the issuer registry, since it transfers
local custody and grants no attendance authority. Ownership loss never publishes proof or advances
cleanup state. No claim is sent or resolved as attendance by this signing method.

The platform adapter signs exact purpose-separated offline UTF-8 bytes. Android uses the existing
Keystore SHA256withECDSA operation and no Google network call during offline signing. iPhone uses
only the new cached assertion API, never an uncached fallback. Current platform/app identity must
match the captured key; capture-time reported app versions remain unchanged after a legitimate
upgrade. The expected Apple bundle is the complete App ID after its ten-character prefix, not an
arbitrary suffix. The matching local online guard now applies the same exact-bundle check as the
existing server owner.

Signed-claim envelopes carry only the original claim plus a platform-specific bounded canonical
base64 artifact; they contain no client-supplied trust/counter/acceptance flag. Native proof bytes
are still unverified inputs until the server performs cryptographic/key/permit/current-policy
checks. The sealed clock journal now admits up to 1 MiB, needed for 32 possible 8 KiB iPhone
artifacts plus context and metadata. Other journal bounds are unchanged. Photo admission reserves
two clock-journal copies within the installation's existing allocation quota. Only identical-data
phase reservation/handoff/native-cleanup transitions may finish at the cap; adding a proof or a
claim still needs admission. These optional signing ports are not yet supplied by an employee flow.

### Server key lease and transport invariants required for sync

The same proof-order rule must hold on the server, including requests sent directly to the API.
Offline context issuance must reconcile pending online work and acquire the registered key's
stream lease. Existing online begin/complete paths must refuse conflicting work while that lease
is active. Expiry alone cannot release it: unsynced proofs may already exist. Closing/retiring a
context needs a durable scoped server result that makes old permits unusable and preserves claim
provenance; revocation and HR review remain explicit outcomes. Client-only ordering is insufficient.

In particular, do not generate a fresh iPhone transport assertion after all offline proofs and then
advance its higher counter while only part of that backlog has been consumed. That would invalidate
the remaining legitimate lower counters. Sync must validate original claim assertions in order and
atomically consume their permits/counters/outcomes. Android's fresh sync-time Play evidence must bind
the actual ordered submitted payload and must not be labeled capture-time integrity. Chunking,
attachment admission, partial receipts and audited refusals must preserve those invariants. Final
SQL and journal metadata for reserved 0647 must be coordinated before release; the reservation does
not authorize stale metadata, migration application or rollout.


### Server verification of original claim proofs

`lib/mobile-api/offline-clock-proof.ts` binds an original signed claim to independently supplied
context, registered public-key and stream snapshots. It checks the complete context scope/digest,
exact issued permit inventory, registered key/app/environment and contiguous predecessor digest.
iPhone verification reuses the existing strict App Attest primitive and returns its proposed
strictly increasing counter. Android verification uses the same bounded canonical DER checks as
online signatures but verifies the separate offline purpose/bytes; it never reinterprets an online
signature or a hash of the canonical message as the original claim. Capture build reports are
preserved, with current upload Play assessment and configured build policy owned separately.

The result is `proof_valid` with `authorization: not_granted`, never a receipt or punch. The
primitive does not authenticate its context/key/cursor arguments: the server stream transaction
must load independently verified issued records and locked current registration/stream state,
check authorization/revocation/policy and actual photos, then atomically commit counter/permit,
adjudication and any canonical attendance effect. It does not classify expired/unknown time or
mock indicators as accepted attendance, and it does not invent an in/out state machine. This
server primitive is not mounted in an offline route. The migration and live flow remain pending.

### Reserved persistence draft and online lease guard

Unjournaled `0647_mobile_offline_attendance.sql` introduces context/stream, immutable permit
inventory and immutable processed-claim outcomes. Context ownership binds tenant/actor/employment,
company, registered key and both installations; canonical context and claim artifacts use bounded
ciphertexts. The per-key unique open context is the lease. Expiry leaves it held. Explicit closure
retains a reason/request reference; an exhausted close requires the complete consumed prefix.
Review/refused outcomes carry no capture or effective attendance instant. An accepted outcome must
link the matching canonical capture and explicit effective bounds, with received time kept separate.
These are persistence constraints, not an implemented issuance/adjudication or acceptance service.

Deferred constraints require the original complete permit inventory at context creation and require
each committed processed claim to have its advanced cursor and Apple counter in the same transaction.
Composite references bind permit/ordinal and claim scope. Immutable triggers reject rewriting or
removing retained records. A key-counter trigger also prevents an unrelated online advance while
an open stream exists. A narrow security-definer function exposes only whether this actor's app/key
has a lease, including when the original employment has become unreadable; it exposes no capture.
Revoking the registered key invalidates its permits and allows other keys to proceed without
rewriting the old context or claims. Ordinary expiry never has that effect.

Online challenge admission checks the lease while holding its existing actor lock. Apple and Android
proof consumers repeat it after acquiring their registered-key lock; Android also checks before
spending a provider request. Existing exact terminal receipt recovery is retained. Before 0647 is
installed, no offline lease can exist and established online behavior remains available. Partial or
inaccessible installed storage fails closed. Future context issuance must acquire the same actor/key
locks and reconcile active online challenges before inserting any lease; this draft does not yet
provide that issuance path. Final SQL/hash/dependencies and journal allocation still require central
coordination. No migration journal entry or application is authorized by the reserved filename.

### Transactional context issuance service

`core/mobile-offline-context.ts` now owns context/permit minting and exact response recovery in one
attendance transaction. It authorizes the current own employment/company, takes the existing actor
admission lock then the registered key lock, rechecks current subject/key ownership, and refuses
unresolved offline leases or active online clock challenges. Fresh snapshots come only from a
mandatory trusted policy/site/attendance/key-eligibility port; there is no phone-supplied policy or
implicit offline enablement. A required bounded actor issuance budget is deployment configuration,
separate from HR attendance rules. Duplicate request recovery precedes new snapshot/budget work.

New contexts use database time, explicit configured window bounded by the issuer validity, random
one-use permits and actual Ed25519 signatures. AES-GCM stores the exact signed response under a
purpose/tenant/actor/context/request AAD. Recovery checks the immutable record, canonical digest,
original request/nonce/full scope, issuer/policy/time metadata and actual permit inventory. Ordinary
signer rotation and snapshot changes do not replace the original signed response or time anchor.
Expired retries return the original context; they neither refresh its expiry nor release its lease.
A closed request cannot mint another inventory. A new online challenge must be reconciled first.

A mandatory final configuration/key-eligibility port runs after tentative context, permits and audit
writes. The service then repeats own-company/key/storage, open-context and database-time checks.
Failure rolls back all records, audit and issuance budget. The service exposes no HTTP route and has
no default live policy/key loader. Trusted registry provisioning/rotation delivery, actual deployment
snapshot/eligibility assembly, offline transport/consumption/adjudication and employee/HR flows still
need integration. Issuance returns `authorization: not_granted`; it is not an attendance receipt.

### Claim consumption owner decisions (28 October 2026)

`core/mobile-offline-claim.ts` consumes one original claim in the locked attendance transaction.
The owner settled three rules on 28 October 2026. Their implementation at `182f8fa66` passed
hosted run [40561470126](https://github.com/StradaverseHub/ai-hr/actions/runs/40561470126).

1. Request-ID collision is refused. After the actor, key and stream locks, the service takes the
   subject lock the canonical clock writers take before their own request lookup. If an attendance
   capture already holds the claim's request ID for that tenant and employment (the capture's
   unique key; punches link to captures), the claim is refused with service-owned reason
   `request_conflict` and the adjudicator is not called. The refusal is an ordinary terminal
   outcome with counter, cursor and audit, and no capture or effective instant. An exact-digest
   retry returns the same receipt. The adjudicator contract cannot return `request_conflict`.
   Residual: an online capture created after this refusal commits is not refused by the online
   writer, which does not read offline claims. An accepted claim cannot duplicate a capture, because
   the capture unique key rejects the second insert.
2. An accepted punch records exactly `effectiveAt` in the online writer's encoding. The linked live
   punch's `punch_at` must equal the Asia/Kuala_Lumpur wall time of the integer-millisecond
   `effectiveAt` at PostgreSQL `time` precision (microseconds). Its `attendance_date` must be the day
   the online writer would file. Amended by a further owner decision on 28 October 2026: an offline
   overnight clock-out belongs to the shift's start day, as the online writer files it, and must still
   match `effectiveAt` exactly. The check and the online writer share one rule,
   `clockAttendanceDateTx` in `core/attendance-clock.ts`. It returns the instant's MYT day, except
   that a clock-out belongs to the start day of the newest open session when that day is the
   instant's previous MYT day and its schedule crosses midnight. The service reads that session
   (`openClockSessionDateTx`) under the subject lock before adjudication, as the writer reads it
   before writing. The overnight out's instant is therefore the start day plus one day plus
   `punch_at`. Any other date, a one-millisecond difference, an overnight out filed on the
   instant's own day, or a clock-in filed on a prior day rolls back with `configuration_unavailable`,
   the error already used for a missing linked punch. A writer that stores whole seconds can link only
   a whole-second `effectiveAt`. The overnight amendment is UNVERIFIED until a hosted run passes.
3. A group admin may read and delete only expired photo custody (`retained_until <=
   clock_timestamp()`), never retained ciphertext; the purge's `DELETE ... RETURNING` passes the
   same read policy. The actor's own read is unchanged. GRANTs, immutability and the deferred
   custody constraint are unchanged.

The owner also settled four adjudicator and HR rules on 28 October 2026. Each is DECIDED and NOT
YET IMPLEMENTED: no code, policy or test enforces it yet.

4. Effective instant (IMPLEMENTED, UNVERIFIED pending a hosted run). The effective instant is the
   device's claimed time, rounded to whole seconds and clamped into the server-proven interval. If that
   interval is wider than the company's configured limit (default 15 minutes, see below), the claim goes
   to HR review. See "Deterministic adjudicator and company settings" below.
5. Failed checks go to review (IMPLEMENTED, UNVERIFIED pending a hosted run). An ordering conflict, a
   punch outside the geofence, a reported mock or simulated location or accessory, a missing registered
   device, or processed payroll on that day sends the claim to `needs_review` for HR, not to refusal.
   This supersedes ADR-0088's refusal wording for order conflicts. Closed payroll stays under the
   existing lock owner, which the adjudicator consults before any write, and is also review.
6. HR read access (IMPLEMENTED, UNVERIFIED pending a hosted run). HR users with attendance-correction
   rights for the claim's company may read that company's offline claims and unexpired retained photos,
   and each read is audited. Group admins still only purge expired photos. A human resolution path for
   held claims was built with it. See "HR review and resolution of held claims" below.
7. No self-removal (DECIDED, NOT YET IMPLEMENTED). Employees cannot remove their own offline
   punches. They must request a correction, the same as registered-device captures.
8. HR accept is a punch correction (owner decision 28 October 2026; IMPLEMENTED, UNVERIFIED pending a
   hosted run). When HR accepts a held claim, the punch is inserted at its effective time through the
   existing attendance-correction rules, like any HR punch correction. Later punches do not block it.
   HR's decision, with its reason, overrides the original hold (geofence, photo, device). Payroll locks
   and correction permissions still apply, and the day recalculates. This replaces the earlier accept
   through the live clock rules. See "HR review and resolution of held claims" below.
9. D-A, multi-level approval (owner decision 28 October 2026; IMPLEMENTED, UNVERIFIED pending a hosted
   run). HR's accept files the correction and decides its first level. When the day's workflow has
   further levels, the claim shows "pending approval" and the punch is written only when the final
   approver approves, exactly as for any other correction. If a later approver rejects (or the
   correction is withdrawn), the claim ends there: it stays resolved, and its state reads rejected
   (or cancelled). This matches how a correction ends. A rejected or withdrawn correction is final and
   is never reopened; trying again means filing a new correction for the day. The resolution stays
   the claim's one immutable decision, so no second resolution or second correction can be attached.
   The employee's view shows pending, accepted or rejected (cancelled after a withdrawal).
10. D-B, who may accept while a photo is retained (owner decision 28 October 2026; IMPLEMENTED,
   UNVERIFIED pending a hosted run). While a claim's photo is still retained (not expired, not
   purged), only someone who can see it may accept: HR with correction rights who is not a group
   admin. A group admin may reject at any time. It may accept once the photo has expired or been
   purged, or when the claim has no photo. This is enforced in the service and in the resolution's
   bound trigger.
11. D-C, the correction owns the day (owner decision 28 October 2026; no change). An accepted claim's
   correction owns the day, as for every correction.

### Canonical offline attendance writer and provenance (28 October 2026)

`captureOfflineClockTx` in `core/attendance-clock.ts`, exported through `packs/attendance/service`, is
the only writer of an accepted offline punch. It runs in the caller's transaction (no nested
transaction), as the claim service's `adjudicate` port requires. It remains unmounted: no route, no
production adjudicator and no acceptance is enabled.

- One owner, two halves. The online `captureEmployeeClockTx` is split into a read-only plan (every
  validation and typed refusal, locks and reads only) and an apply step (capture, canonical punch,
  audit). Web, native-online and offline share both. The online instant is still read after the
  subject lock and request lookup, not at the call site, so online error order is unchanged.
- Offline differences. The instant is the claim's `effectiveAt`, a whole second no later than the
  receipt; the receipt instant `server_recorded_at` is the actual server time. The 120 s fresh-sample
  rule does not apply. Ordering uses each capture's own instant (`effective_at`, else
  `server_recorded_at`), so an offline instant earlier than an existing online clocking is refused even
  though its upload arrives later. Any capture already holding the request ID refuses the plan. The
  command digest is sha256 of `["mobile_offline", claimDigest]`, so an online replay of the same request
  ID conflicts. A company requiring a registered device refuses offline clocking: a claim carries no
  legacy device token.
- `planOfflineClockTx` returns a plan or a typed refusal (`invalid_command`, `employment_unavailable`,
  `clock_conflict`, `corrected_day`, `device_unavailable`, `photo_required`, `photo_invalid`,
  `location_invalid`, `geofence_quality`, `outside_geofence`, `effective_time_invalid`) and writes nothing.
  Other errors stay faults. If apply throws after its first write, the writer also aborts the caller's
  transaction, so a caller that catches the error still cannot commit a partial clocking.
- Minute ordering. `clockPunchOrderRefusal` in `core/attendance.ts` owns the minute-ordering refusals
  that `checkInTx`/`checkOutTx` previously inlined. The plan evaluates the same predicate where those
  writers would, so plan and apply cannot disagree.
- Provenance in 0647. `clock_method` gains `mobile_offline` (PostgreSQL cannot drop an enum value; the
  worker restore leaves it). `attendance_clock_capture.effective_at` (nullable; NULL is online) is
  checked whole-second and not after `server_recorded_at`. The punch guard keeps all 0528 checks and
  allows a capture-linked punch to be `web` or `mobile_offline`, `mobile_offline` exactly when the
  capture has `effective_at`. A `mobile_offline` punch without a capture is refused for every role. The
  claim trigger requires the claim's `effective_at` to equal its capture's, so the claim keeps a
  checked copy, not a second truth. The consumption service also requires the linked capture's
  `effective_at` to equal `effectiveAt` and the punch method to be `mobile_offline`.
- `effective_at` is deliberately not declared in `db/schema.ts` while 0647 is unjournaled. Declaring
  it would make every `select()`/`returning()` of the table name a column the live schema lacks. The
  writer and the consumption check name it explicitly (`attendanceClockCaptureEffectiveAt`).
- Readers are not yet updated. Reports, exports, correction history, current status, policy coverage
  (0590 reads `server_recorded_at`) and the clocking import's `method === 'web'` rule still treat an
  offline capture by its receipt instant or as non-web. This is required before enabling acceptance.

This writer is UNVERIFIED until a hosted run passes.

### Deterministic adjudicator and company settings (28 October 2026)

IMPLEMENTED, UNVERIFIED pending a hosted run: no vitest, TypeScript, build or database command was run.
`packs/attendance/mobile-offline-adjudicator.ts` (through `packs/attendance/service`) supplies the claim
service's `adjudicate` port: `createOfflineAdjudicator({snapshot})` returns `decide`, `accept` and
`adjudicate`. It is UNMOUNTED: no route or production wiring passes it to `createOfflineClaimService`,
and no company has offline clocking enabled. No model takes part; every check is a current owner read
in the claim's transaction, and `decide` finishes before the only write, the canonical offline writer.

- Company settings (owner decision, 28 October 2026). Draft 0647 adds two columns to
  `attendance_policy`, which has one row per company: `offline_clocking_enabled` (default false, as
  ADR-0088 requires) and `offline_max_proven_window_seconds` (default 900, CHECK 60 to 86400).
  `readOfflineClockingPolicyTx` reads them by name; no row is the default. The columns are not
  declared in `db/schema.ts` while 0647 is unjournaled. Every existing writer leaves them at their
  defaults or keeps them (the settings writer's upsert names only its own columns). There is no
  settings screen or write service for them yet.
- Decision order. A changed company is `scope_changed` (review). Offline off for the company at decision
  time is refused as `offline_disabled`. A claimed time outside the context window, or a proven interval
  wholly after it, is refused as `outside_context_window`. A missing interval is `continuity_unknown` or
  `time_unverifiable` (review). An interval that runs past the window is `outside_context_window`
  (review). One wider than the company maximum is `proven_window_too_wide` (review). One holding no whole
  second is `time_unverifiable` (review). Then come reported mock, simulated or accessory flags; policy
  or site drift against the trusted snapshot port (`policy_changed`, `site_changed`); a required
  registered device (`device_required`); employment not active on the day (`employment_inactive`, the
  clocking import's own rule, now `employedOnDate`); processed or closed payroll (`payroll_locked`); an
  unreleased overtime settlement (`overtime_settled`); and an approved correction (`corrected_day`). Last
  is the canonical read-only plan, whose typed refusals map to review reasons: ordering conflict becomes
  `attendance_changed`, outside geofence `outside_geofence`, photo `photo_required`/`photo_invalid`, and
  so on. Everything else accepts with the clamped instant.
- No SQL abort. The payroll owner's definer raises unless the employment is the caller's own and active
  today. The adjudicator first checks exactly that guard (`employment_inactive` otherwise), so a claim
  transaction never aborts on it. Payroll is read before the plan takes the attendance row lock, the
  order the correction and removal effects use.
- New review/refusal reasons in `lib/mobile-offline-receipt.ts`: `offline_disabled`,
  `proven_window_too_wide`, `employment_inactive` and `overtime_settled`.
- Still open: a production snapshot port (it must take `offlineEnabled` from
  `readOfflineClockingPolicyTx`), the settings UI and write service, the HR review screen and routes
  (the service is below), route mounting and enabling acceptance. Attendance-baseline drift is not used: the ordering plan
  checks actual current facts, and a context's own accepted claims change its baseline.
- The clocking import now counts a `mobile_offline` punch as an employee clocking: an uncoded import line
  on an offline-clocked day is listed (`uncoded_on_clocked_day`), as on a web-clocked day.

### HR review and resolution of held claims (28 October 2026)

IMPLEMENTED, UNVERIFIED pending a hosted run: no vitest, TypeScript, build or database command was run.
`packs/attendance/mobile-offline-claim-review.ts` holds the read and resolution services. It is
UNMOUNTED: no route, screen or production caller, and it is not exported through the attendance facade.

- Who reads (owner decision 6). Draft 0647 adds two SELECT policies. `mobile_offline_claim_review_read`
  admits `app.can_correct_attendance(employment_id)`. `mobile_offline_photo_review_read` admits
  `retained_until > clock_timestamp() AND NOT app.is_group_admin() AND app.can_correct_attendance(employment_id)`.
  The photo row carries its claim's employment through its composite foreign key, so no join is needed. A
  group admin has correction rights through `is_admin_for`, so the second policy names it explicitly: it
  reads the claim, but a photo only once expired, for the purge. The actor's own policies are unchanged.
  The service checks the same authority itself before reading.
- Reads. `listOfflineClaimsForReview` returns claim metadata, outcome, reason, the signed command's action
  and location, the reported source flags, photo digest and retention, and any resolution. It never
  returns photo bytes or the proof. Pages are newest first (`received_at desc, id desc`), keyed by the
  last claim id. Each returned claim appends `mobile.offline.claim.reviewed`.
  `readOfflineClaimPhotoForReview` decrypts with the existing photo AAD, checks the digest and appends
  `mobile.offline.photo.reviewed` (actor, claim, reason "review") for every read. No photo, an expired
  photo or purged custody is a typed refusal.
- Resolution table. `mobile_offline_claim_resolution` holds one immutable row per claim: decision
  `accepted` or `rejected`, a reason (1 to 500 characters), the resolver and time (stamped by the server),
  an input digest for retry, and for an accept the correction (`correction_id`), `effective_at` and
  `day_revision`. Each correction is held by at most one resolution. The row stores no state and no punch
  (D-A): `app.mobile_offline_claim_resolution_state` derives them. A reject reads `rejected`. An accept
  reads its correction's status, with `approved` read as `accepted` (so `pending`, `accepted`, `rejected`
  or `cancelled`). Its punch is the one the approved correction's applied changes added, found through
  the `attendance.punch.added` event that names the correction. The function is a definer with the same
  visibility as the resolution's read policy. `punch_id` and its unique constraint were removed. The
  day revision is the correction model's baseline (`clockFingerprint` of the filed day's punches) the
  resolver decided against. The claim row is never changed: it stays `needs_review` with no capture. The table has
  GRANT SELECT and INSERT only, forced RLS and an immutable trigger on update and delete. Reads are for the
  claim's actor or correction rights. Inserts need correction rights, the session's own user as resolver,
  and a subject that is not the resolver's own employment (as 0533 refuses deciding one's own request).
- Accept (decision 8, 28 October 2026; IMPLEMENTED, UNVERIFIED). Only a `needs_review` claim with a
  proven interval and no resolution can be resolved. The resolver picks the instant. It must be a whole
  second inside the proven interval, cut at the context's expiry, and the interval must not start before
  issuance. The rule is `offlineEffectiveInstant`, the adjudicator's own, with no width limit, because
  choosing inside a wide interval is the decision under review. The context window is read through
  `app.mobile_offline_claim_window`, a definer that returns only those four instants to correction rights.
  Context rows stay actor-only. The attendance day is the canonical clock day rule
  (`clockAttendanceDateTx`), and an employment inactive on that day is refused. The punch is then written
  by the existing correction owner, in the same transaction, as any HR punch correction:
  `requestAttendanceCorrection` (which now takes an optional caller transaction) files a clock-data
  correction whose entries are the day's live punches unchanged plus one entry at the accepted instant,
  against the baseline read under the subject lock, with the resolution's reason; then
  `decideAttendanceCorrection` approves its first level (`expectedStageIndex` 0, as the HR day screen
  does). The correction owner is unchanged: it never learns about offline claims. The live
  clock rules do not run, so later punches, geofence, photo setting and registered device do not refuse
  it. The correction rules do: clock-data editing needs `app.can_admin_employment`, the decision needs
  the existing workflow authority, closed payroll raises `AttendancePayrollClosedError` ("Reopen the
  payroll") before the correction is inserted, a stale `expectedRevision` or a changed day raises
  `ClockDataChangedError`, a pending request for the day raises `AttendanceCorrectionPendingError`, and an
  existing punch at the same time and direction is refused. The final approval applies the punch set,
  recomputes the day ("Corrected"), refreshes overtime and marks processed payroll for recalculation.
  D-A: if the day's workflow needs a further approver, the correction stays pending. The resolution is
  still recorded, its state reads `pending` with no punch, and the correction's own final decision
  writes the punch later; nothing in the offline code runs then. The previous `correction_pending`
  refusal is gone. While the correction is pending, an identical retry replays and any other
  resolution is `resolution_conflict`. The correction owner's one-pending-per-day rule also holds the
  day. After the first write any throw also aborts the transaction, so a caller that catches it cannot
  commit a partial correction. The previous `overtime_settled` and `not_acceptable` refusals are gone
  with the live-rule path; the correction owner decides those days. D-B: no photo is read or written by
  an accept, but while the photo is retained a group admin's accept refuses with
  `photo_review_required` before anything is written. The service compares the claim's
  `photo_retained_until` with the database clock; custody is purged only after expiry, so that instant
  decides. The bound trigger checks the custody row itself (`retained_until > clock_timestamp()`). A
  group admin's reject is unaffected.
- Provenance (decision 8). The punch is method `admin`, with no capture, exactly as a correction's punch.
  `attendance_clock_capture.effective_at` stays the canonical offline writer's alone. The chain is claim,
  then resolution (`effective_at`, `correction_id`, `punch_id`), then the approved correction and its
  `attendance.punch.added` event naming that correction. The resolution's BEFORE INSERT trigger (definer)
  binds an accept: a pending or approved clock-data correction of the claim's employment, whose
  submitted entries add exactly one punch (one entry with no id) at the MYT wall time of `effective_at`
  on the correction's day (or the next day, for an overnight out filed to its shift's start day). When
  that correction is already approved, the live `admin` punch with no capture that it added must exist.
  The same trigger refuses a group admin's accept while the photo custody is retained (D-B). Visible consequence: HR and the employee see the punch as an HR correction
  ("Corrected", method admin), not as an offline clocking. The correction's reason is the HR resolution
  reason, and attendance_correction's RLS (`app.can_see_employment`) lets the employee's session read that
  row; which screens list it was not checked (UNKNOWN). The approved
  correction then owns the day, as every punch correction does (r434): later clockings that day, online
  or offline, are refused or held as `corrected_day` until HR corrects again. "Offline, accepted by HR" is
  read through the resolution, not from the punch.
- Linkage removed. The permissive capture insert policy `attendance_clock_capture_offline_resolution_insert`
  and the `resolution` subject of `captureOfflineClockTx`/`planOfflineClockTx` are removed, restoring the
  canonical writer's own-employment surface and 0500's insert policy as the only capture insert path for
  the application role. The claim ordering trigger and the punch guard need no change: a correction's
  `admin` punch with no capture already passes the guard for correction authority.
- Reject records the resolution only. Every resolution appends `mobile.offline.claim.resolved` with the
  actor, reason and held-for reason. A retry with the same decision, instant and reason by the same
  resolver returns the recorded resolution, and any other input then conflicts.
- Lock order. A resolution takes the subject advisory lock, then the correction owner's own order: the
  payroll batches (by id) when filing, then on approval the same subject lock again (re-entrant), the
  correction row, its workflow, payroll and the attendance day row. This is the tail of the consumption
  order (actor admission, key, stream, subject, then payroll and attendance) with the first three locks
  left out. A resolution never asks for an actor, key or stream lock, so it cannot wait on one while
  holding the subject lock. Below the subject lock, both paths queue on the same per-employment lock.
- Employee view. `ownOfflineClaimResolution` returns the actor's own claim outcome and its resolution
  (decision, derived state `pending`/`accepted`/`rejected`/`cancelled`, instant, correction, derived
  punch, time). HR's list and the resolve result carry the same derived state. It leaves out the resolver, reason and baseline. It is a separate
  read, not a v1 receipt field.
- Superseded RISK. The earlier accept ran every live clock rule at the chosen instant, so a claim
  reviewed after later clockings, or held for geofence, photo or device, could not be accepted. Decision 8
  (above) replaces that path. The former UNKNOWN about multi-level workflows is settled by D-A.
- New suite: `test/mobile-offline-claim-review.test.ts`, including an accept behind a later offline
  clocking the live rules refuse, geofence and photo holds overridden, the day recomputed, the provenance
  chain and its trigger binding. The draft worker restore drops the new table and its three functions
  (window, bound trigger, state) and checks each is gone (the capture policy no longer exists). D-A
  and D-B cases (28 October 2026): a two-level accept pending with no punch until the final approval,
  a later-level rejection, pending blocking a second resolution, and a group admin refused while the
  photo is retained (service and trigger) but able to reject, or to accept after expiry or with no
  photo.

### Deployment configuration and assembly (28 October 2026; IMPLEMENTED, UNVERIFIED)

Status: implemented on `claude/mobile-offline-assembly`; hosted verification pending. No route mounts it, so
offline attendance stays off on every installation. Absent configuration is `not_configured`; anything malformed
or inconsistent is `configuration_unavailable`. Nothing is cached: each request and each commit guard re-reads the
environment.

Owners. `AIHR_MOBILE_OFFLINE_POLICY` (`lib/mobile-offline-rollout-policy.ts`) owns the per-actor allowlist
(tenant, company, actor ids), the issuer registry, `signingKeyId`, `windowMs`, `permitCount`,
`maximumIssuesPerHour`, `photoRetentionMs` and `mode`. `AIHR_MOBILE_OFFLINE_SIGNING_KEY` holds the Ed25519 PKCS#8
PEM for `signingKeyId`. The actor must also be in `AIHR_MOBILE_CLOCK_POLICY` for the platform. That entry owns
`apiOrigin`, the app target and the Play settings; the offline policy does not repeat them. The snapshot port
still owns offline-enabled, policy revision, sites and attendance. The assembly
(`lib/mobile-api/deployed-offline-clock.ts`) puts the deployment's window, permit count and target into the
snapshot it hands to issuance, and into the one it hands to the adjudicator. Both see the same values, so drift is
measured consistently. A side effect: changing `windowMs` while claims are in flight sends those claims to review
as `policy_changed`. It never accepts them.

Schema bounds. These are engineering admission limits, not HR, retention or legal rules: version 1; mode `active`
or `drain`; 1 to 16 issuers with unique key ids, where each `keyId` is the SHA-256 of its raw public key;
`signingKeyId` must be one of the issuers; `windowMs` from 60 000 ms to 72 h; `permitCount` from 1 to 32;
`maximumIssuesPerHour` from 1 to 24; `photoRetentionMs` from 1 h to 366 days; at most 100 entries, unique by
tenant and company, each with 1 to 1000 unique actor ids; policy JSON at most 262 144 UTF-8 bytes; key PEM at most
4096 bytes.

Fail-closed table (`core/mobile-offline-rollout.ts`, `readMobileOfflineDeployment`):

| Condition | Result |
| --- | --- |
| `AIHR_MOBILE_OFFLINE_POLICY` absent or empty | `not_configured`, before any database or snapshot work |
| Actor/company not in the offline entries | `not_configured` |
| Actor not in the clock rollout for this platform, or that platform entry is null | `not_configured` |
| Offline policy over 262 144 bytes, not JSON, or failing the schema (bounds, registry, unknown keys) | `configuration_unavailable` |
| `signingKeyId` not among the issuers | `configuration_unavailable` |
| Active mode: signer revoked, not yet valid or expired, or no key configured | `configuration_unavailable` |
| Key over 4096 bytes, unparsable, public, not Ed25519, or not matching the signer's public key | `configuration_unavailable` |
| Clock rollout malformed | `configuration_unavailable` |
| `AI_CONFIG_SECRET` storage unavailable, integrity storage not ready, or 0647 storage not ready | `configuration_unavailable` |
| Attendance module not enabled for the company | `module_unavailable` |

`isMobileOfflineStorageReady` follows the enrollment precedent. It reads only catalog metadata, as the
application role, and checks four things. First, the four 0647 tables exist with forced RLS and SELECT/INSERT
grants, plus UPDATE on the context's cursor and close columns. Second, all twelve 0647 triggers are present and
enabled. Third, `app.mobile_offline_key_leased` can be executed. Fourth, the capture's `effective_at` column and
the `mobile_offline` clock method exist. It detects missing or partial storage. It does not replace the migration
release checks.

Commit guards. Both run inside the service's own transaction, after its tentative writes, and use no pooled read.
- `assertOfflineIssueCommit`, for a new issuance (`issue`). The deployment must still be configured for this
  actor and the context's company, be in active mode (otherwise `draining`), and be identical in every fact it
  signs or admits: origin, target, clock entry, signer, key digest, window, permit count and budget. The signer
  must be unrevoked, with validity covering the context. The context must carry the configured window, permit
  count and signer. A failure rolls back the context, permits, audit and admission budget.
- `assertOfflineIssueCommit`, for recovery (`recover`). The deployment must still be configured, active or drain,
  with the same origin and target. The original issuer does not have to be active or still listed.
- `assertOfflineClaimCommit`. The deployment must still be configured, active or drain, with unchanged origin,
  target, clock entry and photo retention. It deliberately does not check company offline-enabled, so an
  adjudicated `offline_disabled` refusal commits and advances the stream. It does not check mode or the issuer
  registry either: the stored AES-GCM record is the authority.

Drain mode. Claim upload and close stay available. A new issuance is refused before any snapshot read or budget
charge, and the commit guard refuses it again. If a valid key is still configured, an exact retry of an earlier
issuance can recover the original bytes, so a phone that lost the response can learn its context id and close
it. Drain allows a revoked signer, for incident response. Removing the variable altogether stops close and
upload too, and leaves open leases held until the key is revoked. Withdraw a deployment by switching to drain.

Close (`closeOwnOfflineContext` in `core/mobile-offline-context.ts`). Authority is the bearer session's actor
plus ownership of the context's registered key, revoked or not. The lock order is the actor admission lock, then
the key, then the stream. The service retires the context (`retired`) only when the phone's `consumedThrough`
equals `nextSequence - 1`. If the phone holds claims it has not uploaded, the result is `claims_pending`; if the
phone is behind the server, it is `cursor_mismatch`. Either way nothing changes. An exact retry (same
`closeRequestId` and `consumedThrough`) returns the recorded closure. Any other request on a closed or exhausted
context is `context_closed`. A closed context is never reopened. One `mobile.offline.context.closed` event is
written. Closing releases the lease, so online clocking and a new issuance work again. If the employment has
become unreadable, RLS hides the context, and revoking the key is the release path. The deployed close finds the
deployment through the company the context was issued under, and so does claim upload. Issuance gained the
refusal `offline_disabled` for the case where the trusted snapshot reports offline as off; no rows are written.

Platforms. iOS claim upload uses the claim's own App Attest assertion and creates no later transport assertion.
Android claim upload answers `configuration_unavailable` until the transport task supplies the fresh,
payload-bound Play preparer. The Android capabilities report says so (`claimUpload: unavailable`).

Owner decisions (28 October 2026):
1. Signing key custody. An environment secret (`AIHR_MOBILE_OFFLINE_SIGNING_KEY`) for the fictional-data pilot;
   a managed KMS before any real employee data. Rotation: publish the new issuer's public key at least 72 hours
   plus one registry refresh ahead, then switch `signingKeyId`. Keep the old issuer listed and unrevoked until
   its contexts expire.
2. Limits are owned by the deployment: `windowMs` 24 h (cap 72 h), `permitCount` 8, `maximumIssuesPerHour` 4.
3. `photoRetentionMs` is 30 days. The owner will confirm this with counsel before real data.
4. If the Android Play verdict fails at sync, the transport refuses with no receipt. The phone keeps the claim
   queued and retries; HR can revoke the key to release a stuck queue. This is enforced in the later transport
   task, not here.
5. Taken as recommended: a company that requires a registered device has issuance refused; drain mode when a
   deployment is withdrawn; close requires the bearer session plus key ownership; a per-actor rollout allowlist;
   Android freshness means a payload-bound token plus `maxTokenAgeMs`.

NOT done here: routes and transport; the Android Play preparer; delivering or refreshing the trusted registry to
phones (capabilities expose no issuers); refusing issuance for a registered-device company (decision 5 is
recorded, but its enforcement point is the snapshot owner or a later task, UNKNOWN which); wiring
`offlineClockSnapshotPort(deployment)` from the snapshot branch into `deps.snapshot`; KMS custody. Operator
inputs still needed: an Ed25519 key pair generated off-repo, the issuer's `keyId`/`publicKey` and its
`validFrom`/`validUntil` instants (validity must cover every context window that will be issued), and the actor
allowlist together with matching clock-rollout entries.
