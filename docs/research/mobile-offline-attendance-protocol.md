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
