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

This remains an internal seam: the current attendance writer owns its own transaction, so it must be
refactored to join this one before a supported API version can use the service. Existing v1 routes do
not invoke it. It adds no new migration, integrity tier, location/attendance policy, offline acceptance
or deployed security guarantee. Real vendor/device evidence, metadata/modern assertion support,
registered-device policy integration and complete release verification remain required.
