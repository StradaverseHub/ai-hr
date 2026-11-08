# Rewards observer parent-frame and direct-grant repair

Source-only successor of153ae301bb4798235c6deb71bc87f5663d6d7959.
The frozen predecessor worktree and every earlier failure remain unchanged.
Native run42458313768 at153 completed16PASS/8FAIL/0pending of24, not a PASS.
Authenticated artifact13608274977 ZIP SHA256:
13ddc63663052ba9d72cde23bfe731cbf58873dec9021a1573269e361399b2a0.
No predecessor receipt is relabelled onto this source.

Case16 observed actual has_function_privilege(session_user, fixed observer,
EXECUTE)=true after committed REVOKE. That disproves the predecessor's assertion
that this call must already be false; it does not independently prove a cache
mechanism. Case17 passed the private-column negative and PRE, then found zero
Bank events under the existing exact xmin=pg_current_xact_id()::xid oracle.
Its unconsumed command failure poisoned cleanup and blocked six later cases.
Those later cases are not six independent business regressions.

## Proper driver custody and native frame restoration

The pinned postgres3.4.9 nested scope catches query failures, awaits ROLLBACK TO
its generated savepoint and rejects with its original scope error. It does not
RELEASE on either its success or failure path. PostgreSQL16 documents that
ROLLBACK TO starts another subtransaction and leaves the named savepoint valid;
RELEASE pops the named savepoint and all descendants, restoring its parent.

Primary sources:
- https://raw.githubusercontent.com/porsager/postgres/v3.4.9/src/index.js
- https://www.postgresql.org/docs/16/sql-rollback-to.html
- https://www.postgresql.org/docs/16/sql-release-savepoint.html

The repair adds a FIXED parent fence around each REAL nested driver owner:

1. Parent SAVEPOINT, without submitting negative work on that parent scope.
2. Actual Drizzle tx.transaction, or actual raw TransactionSql.savepoint for
   the wrong-login probe; ALL negative work uses that nested lease.
3. Await actual nested-owner rejection/rollback settlement completely.
4. Parent ROLLBACK TO the fixed fence, including after abort or unexpected success.
5. Only after that rollback succeeds, parent RELEASE the fixed fence.
6. Fresh abort check, exact original callback/owner identity, then SQLSTATE check.

No driver-generated sN name is guessed. Parent rollback removes even unexpected
positive effects and all retained inner frames. A failed/uncertain open still
requires a rollback attempt. A failed rollback MUST NOT proceed to RELEASE,
which could merge uncertain work. Open, rollback, release, repeated/swallowed/
unopened/different-error scope uncertainty poisons admission and preserves
original callback, owner, abort, frame and poison failures by identity. No abort
skips mandatory cleanup; no verification happens before owner AND frame settle.
Outer transaction rollback and existing controlled task drain remain authoritative.

runRewardPolicyReviewTxRefusal is the one actual fixed Drizzle wrapper used by
both the observer and the ordinary native frame regression. This is not a general
transaction broker, capability, factory, caller-selected SQL port or pool.

## Current direct-grant frontier, retaining every exact profile guard

The observer constructor already verifies that its fixed function ACL admits
ONLY owner and a direct, non-grantable ai_hr_app EXECUTE entry, from that owner.
The SQL body retains its native has_function_privilege requirement. It additionally
reads the CURRENT statement's pg_proc row through aclexplode and requires that
exact login/owner/EXECUTE/non-grantable entry BEFORE complete pg_proc comparison.
Missing direct grant therefore refuses42501; unchanged direct grant with COST101
still reaches the original full metadata refusal55000. Extra ACL/profile changes
remain subject to complete native pg_proc/schema/relation/trigger/policy guards.
No guard, original body field, authority check or private-column denial is dropped.

The execute mutation proof records FIVE closed, non-authorizing observations:
owner direct grant before REVOKE, owner direct grant after actual COMMIT, FIRST
app-side effective permission, app-side current direct grant, then app-side
effective permission again. Owner checks match the actual bound PID/start/root
transaction lock; app checks re-read native root and compare the existing binding.
The FIRST app effective call precedes ANY added app catalog/root query. It may
be true or false; neither is guessed or accepted as proof of a cache mechanism.
Owner/app direct grant must actually be false after committed REVOKE, and the real
observer must still refuse exactly42501 under its actual nested owner.

Observation schema is closed: fixed kind, releaseAuthorized=false, fixed action,
fixed stage, actual boolean and exact native root shape. Console output contains
no SQL, credentials, application identity/tenant IDs, HR values or error message.
This output never admits authority or changes native acceptance. Any failure
still propagates; mutation restoration and fixture drain remain mandatory.

## Source controls and hosted verification request

The original12 observer intentions remain. Seven additional source/model cases
cover ordered deferred parent restoration, abort during open, uncertain open,
rollback/release failure, abort during parent rollback/release, closed ACL output,
and exact native/abort/frame/poison failure retention. Total19 ordinary pure cases.
They are not native driver or permission evidence. Diagnostic11 source unchanged.

Two NEW ordinary real-DB tests use actual nonowner ai_hr_app withTenant and a
fixed temporary table ON COMMIT DROP. The first reproduces the original raw
nested-driver behavior: after actual22012, a new tuple has subtransaction xmin
while pg_current_xact_id remains the original root. The second uses the ACTUAL
observer wrapper repeatedly, writes a temporary negative effect before22012,
requires each effect rolled back, and requires all subsequent tuple xmin values
to equal that SAME root. Actual login/nonowner/restricted-role checks and final
temporary relation absence are asserted. These are ordinary regressions, not a
new native admission/profile or authority attestation.

The existing24 native cases and declarations, complete financial DTO expectations,
Bank/Catalogue canonical owners, case17 exact root-xmin oracle and all original
200ms/20s/300ms/30s/18s limits remain WHOLE-BYTE unchanged. No application/core,
model, migration, grant, approval, native lease/process owner or pool change.

After ROOT plus independent review of this complete frozen source, run19 observer
models plus11 existing diagnostic cases, then the TWO ordinary native-frame tests,
then the existing COMPLETE24-case normal native singleton, on standard hosted
Actions only. Authenticate exact source/controller/artifact identities, strict
counts and terminal cleanup. Retain earlier failures and unaffected evidence.
No local application/model/compiler/test/native/DB/provider behavior was run.
Static syntax parsing and source/Git/hash checks make no behavioral PASS claim.
This source is UNQUALIFIED, unuploaded and undeployed at freeze. Staging is gated;
production remains held. It is not architecture adoption or release authority.
