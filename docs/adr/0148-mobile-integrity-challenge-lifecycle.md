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
