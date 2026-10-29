# Persist scoped, one-use mobile integrity challenges

This implements the challenge substrate required by ADR-0147. A challenge is neither an enrolled key,
an integrity verdict, a capture attempt nor accepted attendance. Existing clock/leave receipts and their
owners remain authoritative for business outcomes. No public route currently exposes this substrate.

An installation identity is generated once by migration and read through a narrow function. Application
sessions cannot replace its row; the identity grants no tenant authority. A client app-installation UUID
is a scope label, not a device credential or proof of hardware. A challenge additionally binds tenant,
actual login actor, own employment, request UUID, purpose and an immutable digest computed by the trusted
parent owner. A phone-supplied digest is not authority. The parent must reconstruct authenticated scope,
command/attachment or enrollment context before computing and comparing that digest.

Issue and consume repeat active own-employment eligibility. Database scope derives the Person from
the actual login; manager/report and administrator visibility does not confer access. RLS is forced on
challenge rows. Only the consumed timestamp is updateable; an immutable-state trigger prevents reopening
or rebinding, and the application has no delete grant. Installation metadata remains private.

Issuance serializes per tenant/actor, including first use. Repeating a request UUID returns its original
nonce and expiry, including expired/consumed states. A changed binding, purpose, app installation or
employment cannot replace it. The server generates 32 random nonce bytes. Online clock challenges last
two minutes; enrollment challenges last ten minutes, with matching database upper bounds. Expiry does
not silently issue a new hash for an App Attest key. The native owner must retain evidence and reconcile
an expired enrollment explicitly, including Apple's same-key/same-hash outage rule.

Resource controls are separate from attendance policy: at most four unconsumed, unexpired challenges
per actor; enrollment issuance uses a bucket of five with five-per-hour refill, and online issuance a
bucket of thirty with thirty-per-minute refill. Existing committed references bypass new-issuance
budgets so a lost response remains recoverable. The shared budget function runs inside the existing
transaction, avoiding a second pooled connection while an actor lock is held. These are security
mechanism lifetimes/capacity limits, not offline attendance or payroll acceptance windows.

Consumption locks the row, checks exact scope/binding and expiry, and records the transition only if
the update changes the expected row. A concurrent retry waits, then observes the committed terminal
state without rerunning the business callback. Transition, callback writes and consumption audit commit
together; any throw rolls them all back. A database write veto or later RLS refusal cannot run business
writes after a zero-row transition. The callback must use the supplied transaction, perform no vendor
network request and open no nested transaction. Vendor proof checks occur outside this short transaction;
the final owner must recheck key ownership, revocation and business permissions inside it.

An already-consumed result supplies its original consumption time; it does not reconstruct the callback's
business result. The parent reconciles its stable command receipt/outcome. Audit contains the challenge
reference and purpose, never nonce bytes. Retention/reclamation needs its own approved lifecycle; this
change introduces no silent evidence deletion. Stored keys, canonical enrollment context, vendor-proof
assembly, atomic business receipts, supported-version routes and native orchestration remain required.
In particular, do not wire these generic issue/consume functions directly to caller-provided hashes.

## Apple enrollment custody

The local enrollment owner now assembles the canonical challenge context itself from authenticated
scope, stored challenge and server configuration. Its positional UTF-8 bytes bind API origin, server
installation, tenant, actor, original employment, app installation, request, challenge nonce/lifetime,
Apple application/environment and required metadata. UUID case and metadata version-set order are
normalized; unknown properties and unsupported domains are refused. A client app-installation UUID
still grants no device assurance. No public endpoint currently exposes this owner.

An enrolled key belongs to a tenant/login actor/app installation. Its enrollment employment remains
historical provenance, rather than permanently preventing use by another own active employment.
Enrollment and receipt recovery nevertheless require the original active own employment. Public-key
fingerprints remain globally reserved after revocation, preventing transfer or resurrection. The
application cannot rewrite key material, reopen revocation, decrease counters or delete keys. An
installation's active key is never silently replaced; the actor has at most five active keys.

Verification occurs before the short consume transaction. The transaction serializes actor capacity,
consumes the original challenge, inserts the key and writes audit together. A conflicting insert or
write veto rolls back all changes. Repeated completion recovers only the original exact proof digest
and intent, before attempting vendor verification again. This preserves receipt recovery after a lost
response, certificate expiry or encryption-master outage; a revoked receipt stays revoked. Recovery
does not confer new verification or attendance acceptance.

Opaque Apple receipts are encrypted through the existing secret-store AES-GCM mechanism, with AAD
binding tenant, actor, key and challenge. Public receipts and audit omit vendor receipt bytes, key
material and trust tiers. This uses the existing installation-wide secret master; it does not provide
per-person crypto-shredding. Retention, lawful erasure, master rotation, vendor receipt/fraud checks
and revocation checking require explicit lifecycle work before activation. The key-proof result keeps
those vendor checks marked unchecked. Metadata requirements are server configuration: missing modern
metadata cannot be promoted to metadata assurance, and a synthetic metadata fixture is not platform
acceptance evidence.

Migration names/indices for the local integrity additions are provisional pending reconciliation with
the central migration coordinator. Only disposable local test databases have applied them. No shared
database may apply or renumber these drafts until the allocation is resolved. Android key custody,
assertion verification against stored counters inside command acceptance, versioned API/native
orchestration and real-device acceptance remain required.

## Stored-key online assertion transaction

The internal Apple online owner derives a challenge binding from the server configuration, stored key
reference, exact command and reported source facts. It hashes a defensive copy of the exact submitted
photo bytes itself; a caller-provided photo digest is not accepted. Scope and nonce/lifetime in the
signed positional context come from the authenticated actor and stored challenge. The enrolled key's
installation, app identity, environment and configured enrollment metadata must match. Source flags,
app version and build remain signed client claims. Historical enrollment metadata does not attest the
currently running build or independently prove presence.

Within challenge consumption, the owner locks the enrolled key, rechecks current employment eligibility
after any lock wait, rejects revoked keys and verifies the signature against the stored unsigned
counter. It then rechecks database time against the challenge window, advances the counter only if an
actual matching row is returned, and invokes the business callback in the same transaction. Callback
failure rolls back the counter, challenge, callback writes and audit together. Different challenges for
the same key serialize; a reused counter cannot become valid merely because it targets another request.
No vendor request occurs while holding these database locks.

The callback must use that transaction and the checked command/photo snapshot for its authoritative
receipt and writes. Already-consumed challenges return a reconciliation state without re-running the
callback or claiming that a submitted replacement assertion was checked. The business owner must recover
its original receipt before deciding the user-facing result. A proof-check event records references and
counter, not signature bytes, coordinates, photo or vendor receipt.

This remains an internal seam. Existing v1 routes do not invoke it. It adds no new migration, integrity
tier, location/attendance policy, offline acceptance or deployed security guarantee. Real vendor/device
evidence, metadata/modern assertion support and complete release verification remain required.

## Joining online attendance acceptance

The signed Apple carrier now invokes the existing capture writer inside the proof transaction. The
writer's existing web/native entry points retain their transaction ownership; its narrow joined native
entry point uses the parent's transaction and repeats own-employment selection there. It preserves
registered-device, photo, location freshness, uncertainty containment, ordering, corrected-day and
server-ordered abandonment rules. It stamps accepted attendance with server time, rather than promoting
the signed claimed sample time to an attendance timestamp. No vendor network request occurs inside
the joined transaction. After the employment advisory lock, the joined writer repeats salary-free
own-profile eligibility. After tentative business writes, the proof owner repeats eligibility and
database expiry once more before commit. Waiting for a subject/day lock cannot extend a proof grant;
an expired grant rolls those tentative writes back.

The immutable challenge binding additionally includes a digest of the exact registered-device bearer
credential, when supplied. Its nonce therefore commits to that credential without publishing it in
client data or audit. Changing credentials after issuance changes the binding and refuses. This
preserves the legacy registration gate; it does not create a hardware association between that bearer
credential and the attested key. A valid key never silently exempts the employee from the configured
registered-device policy.

The joined writer requires a new capture. A reference already accepted through another carrier cannot
be retroactively upgraded with integrity evidence. Successful capture, punch, proof-to-capture link,
counter advance and challenge consumption commit together. A duplicate completion recovers only the
original actor/capture/request linked to that exact challenge, without re-running acceptance. Revoking
the key after acceptance does not erase its receipt. Independent native receipt lookup remains the
recovery path when deployment configuration changes. Invalid proof or refused attendance leaves the
challenge and counter unchanged. Outside-geofence audit is appended only after rollback, through the
existing separate blocked-attempt owner, and never creates an accepted punch.

The link records key/challenge references, counter and historical enrollment proof kind. It records no
signature, photo, coordinates, vendor receipt or bearer credential. The ordinary public clock receipt
gains no trust tier or verified-presence claim. A supported API/configuration boundary, native durable
orchestration and signed-device acceptance still precede activation; current public routes are unchanged.

## Versioned HTTP assembly

`createIntegrityHttpHandlers` assembles the enrollment, inventory, revocation and signed online clock
handlers through the existing bearer-only mobile wrapper. Its portable protocol v1 contracts separate
prepared, enrolled, accepted, refused and unavailable outcomes. Capability discovery describes protocol
support; it grants no attendance policy exemption, verified presence or offline acceptance. A prepared
response includes the canonical context and state, with no private binding digest or database row.

Every operation requires an explicit, unique own-employment selector and repeats active own-profile
eligibility before configuration reads. Tenant, actor, expected app/environment/origin, verification
function and policy are never request fields. Configuration is a trusted server assembly port, read
afresh for that subject. An absent/invalid configuration returns unavailability without issuing proof
material. The port receives an abort signal and a bounded deadline; a late read cannot initiate issuance
after the handler has timed out. Key inventory and revocation do not depend on that configuration port.

Enrollment JSON and canonical base64 have separate encoded/decoded bounds. Clock requests use bounded
multipart bodies, one command part and at most one exact JPEG/PNG attachment. Unknown/duplicate fields,
forged authority, ambiguous encodings and invalid photo metadata refuse before vendor verification.
Expected proof/domain refusals map to closed codes without raw errors or per-request failure logs;
unexpected failures retain the common private support-reference behavior. All responses retain
no-store headers and shared actor/source admission, with additional transactional issuance limits.
No handler automatically retries, generates replacement keys or falls back to unsigned clocking.

Response envelopes discard additive fields so supported older clients can keep reading their known
shape. Discovery accepts bounded future feature names, which grant no authority by themselves.
Request authority, operation outcomes, refusal codes and signed-context versions stay closed; an
unknown outcome/version cannot be treated as acceptance. Expected location-quality failures preserve
a closed typed reason rather than a raw error. Configuration cancellation is normalized whether the
read ignores abort or cooperatively rejects; neither a late value nor a cancellation error starts
issuance after the request has stopped.

The signed carrier lives inside the attendance pack. Its narrow `mobile-integrity` facade keeps vendor
crypto imports separate from the ordinary attendance facade, so an inactive optional stack cannot
prevent established clock routes from loading. Import-ratchet exceptions are not added for the adapter.

No filesystem API route is registered yet. Route assembly still requires the company-owned rollout
policy/configuration source, supported-version behavior, treatment of older carriers and the human
exception path from the approved review. Do not invent a deployment-wide feature environment flag or
blanket hardware refusal as a substitute. This assembly changes no existing v1 response or deployment.


## Coordinated source allocation, 27 October 2026

The coordinator resolved the unapplied Mobile filename collisions after the human-authorized report.
Ordinary descendant `cd9833e89` preserves the exact501-entry alpha9541 journal prefix and all canonical
SQL bytes. It appends Board616–617, AI618–629 and Mobile630–633 in the coordinated order. Mobile retains
`0613_request_abuse_budgets`, then renames the unapplied geofence/challenge/key files to
`0633_geofence_reported_uncertainty`, `0634_mobile_integrity_challenges` and `0635_mobile_integrity_keys`.
All eighteen allocated SQL hashes and timestamps remain unchanged. Original candidates/evidence stay
in Git history; old local indices616–619 and names0621–0623 describe historical candidates only.

The external allocation witness is pinned in the test fixture, including the source manifest hash,
canonical-prefix digest and all ordered additions. Its guard checks prevent omitted prerequisite rows,
altered SQL bodies or accidental resurrection of superseded Mobile filenames. This source integration
has been applied only to disposable local test databases. It does not authorize shared/staging apply,
branch advancement, publication or deployment.

This is a development SQL overlay, not a deployable application integration. Board0602 changes payroll
visibility and requires its paired history locks/readers/reporting/compensation/YTD/headcount/schema/
facade/import code;0603 pairs Letters services/private-agent capabilities. The paired Board and AI
application ancestry must be integrated and semantically verified before any runtime-ready/release
claim. Full gate and populated/live-baseline upgrade rehearsals remain required, including reconciliation
of the earlier reported historical staging-ledger differences. Never deploy later Mobile timestamps
while silently omitting earlier allocated prerequisites or their application owners.
