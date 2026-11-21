# Employee native benchmark restoration: proposed source contract

Design only, based on frozen 517c5a697f9260b9342ce612125c6325bf334131.
No executable, SQL, test, policy, migration or application change is made here.
No native acceptance, performance result or deployment is claimed. Root review
must precede implementation, and all already-planned frozen checks must finish
before a repair is applied to their candidate.

## Reproduced gate and precise source findings

The normal native receiver requires both restorationAccepted fields to be true.
The classic six-case benchmark creates both false before native COMMIT custody
but never updates either. It therefore cannot qualify even if all measurements
and ordinary cleanup succeed. Setting those booleans after a method returns is
insufficient: the actual native postimage must be observed and accepted first.

The ASCII benchmark is different. Its existing terminal coordinator starts false,
awaits independent source-executed guards and makes completion depend on both.
It fresh-reads the database settings and checks function absence plus retained
security after restoration. Preserve that work and its four meaningful models.
It is a design precedent, not evidence that the classic benchmark ran successfully.

The shared base function owner currently sets removed before its final absence
and security checks. A failed postcheck can consequently make a subsequent call
return early. Logging restore checks its ordered settings inside its transaction
and then latches restored, without a separate post-COMMIT native observation.
Repeated calls return early. Its coalesced array also cannot distinguish a missing
pg_db_role_setting row from an existing empty row. These are finite owner seams
to close, without changing the function body, business grants or SQL semantics.

Classic cleanup progress writes currently occur before the protected work call.
A failed progress write can skip that cleanup and subsequent owners. Use the
existing ASCII pattern: telemetry failures remain failures but cannot prevent
mandatory resource settlement or the other independent native restoration guard.

## One coherent repair, preserving existing owners

Keep remove() and restore() as the canonical operations and retain their public
Promise<void> shape. Do not introduce another pool, arbitrary SQL callback,
general restoration broker or caller-authenticated receipt. Their fixed owners
retain the actual native preimages before COMMIT and perform fresh verification.

For prototype removal:

1. Preserve the exact SQL source digest, complete installed pg_proc JSON,
   pg_get_functiondef, owner/ABI/ACL checks and original security snapshot. Preserve
   the guarded absent predecessor for rollback or lost delivery. The SQL guard
   already refuses every overload with the prototype name before creation.
2. Accept removal only for the exact installed object or the guarded absent
   predecessor. An unknown replacement remains untouched and refuses acceptance.
   Never use DROP CASCADE or drop a similarly named object.
3. After the real DROP has completed, fresh-read both exact-signature absence and
   absence of every overload under the owned name; fresh-read the entire existing
   retained-security vector and compare with its original native value. Move the
   success latch after these checks. Repeated calls must recheck the postimage,
   rather than treating the latch as a new observation.
4. Keep the original snapshot scope honest: app function metadata, public/app
   policies and table grants, and role edges. The installed function itself keeps
   its full raw native body/ABI/OID/owner/ACL. This does not certify restoration of
   all unrelated database state or authorize an otherwise unknown schema profile.

For database logging restoration:

1. Retain the complete logical native pg_db_role_setting row, including its
   presence or absence and setdatabase/setrole/setconfig, in addition to the
   original ordered settings array and existing hashes. Do not compare physical
   MVCC fields that canonical ALTER DATABASE cannot restore.
2. Capture the complete instrumented logical row before its COMMIT response can
   be lost. Retain both known preimage and known postimage. Restore only from
   either exact known state; any other current state refuses and is retained.
3. Use the same exact per-key ALTER DATABASE restoration, reverse order and prior
   values. Never RESET ALL, alter unrelated settings or directly update catalogs.
   If a beforeimage cannot be restored exactly through the canonical operation,
   refuse before instrumentation instead of normalizing it away.
4. After COMMIT, fresh-read the full logical row and ordered configuration through
   the admitted cleanup carrier and require exact equality with the preimage.
   Repeated restore calls also perform this fresh read before returning success.
   The existing beforeSha256/instrumentedSha256 array meanings remain unchanged;
   distinct native-row hashes must have distinct names.

Actual role/login/database/loopback identity must be checked on the carrier used
for the terminal queries. Do not claim it is the same backend as the work carrier;
the existing work-to-cleanup handoff deliberately changes carriers. The existing
native container/postmaster/source custody remains the separate physical owner.
The design assumes the isolated admitted fixture's DDL owners have settled. It
does not claim to defeat an arbitrary concurrent superuser or introduce broad
catalog locks as a substitute for that ownership boundary.

## Source-executed terminal proof before closing pools

Classic cleanup should reuse the existing ASCII false-first, one-attempt pure
proof coordinator unchanged. Its historical internal name is not a claim of
native authority. Do not copy another terminal state machine. A separate fixed
native guard owns the actual SQL observations; one builtin-only pure proof codec
can be shared by that guard and the CI receiver without importing DB or Vitest.
A coordinator/model or parsed proof is not native evidence by itself.

Close work admission and await all actual registered callbacks, resources and
native backend settlement before semantic cleanup. Derive the cleanup deadline
from the existing min(26 seconds, remaining 900-second envelope). Keep plan-client,
log follower and timing-client settlement before their restoration dependencies.
When the cleanup carrier is uncertain, do not admit new semantic SQL. Still run
all mandatory socket/pool closure attempts, retain each distinct error and poison
later admission through the existing owner/lifetime. Abort cannot skip cleanup.

Execute each fixed native restoration guard before closeAll/owned-pool closure.
Only after a guard fully succeeds may its report witness become accepted. Retain
bounded native observations alongside the flags: exact prototype name/signature
absence, original installed identity digest, before/after retained-security
digests and counts; and full before/after logical logging rows with independent
hashes. Bind these to the original actual database/source witnesses. The receiver
must recompute hashes/equality/absence and require a complete terminal state, not
accept a bare true. It must retain its API/ZIP/source/job/lifecycle conjunctions.

These are source-executed native observations in the authenticated complete test
job, not a separately signed database attestation. A caller JSON packet or a pure
model may not construct authority. Keep the native query owners fixed and the
report's release flag false. Reuse the existing retained report member when its
unchanged size bound permits; do not add unrestricted archive names or raise caps.
Evidence write failures must leave completion false while cleanup continues.

Apply the shared owner corrections coherently to both classic and ASCII. Preserve
the ASCII original-to-candidate-to-original full object checks before final drop,
its independent metadata cleanup carrier, terminal state and strict speed gate.
Do not delete those existing guards while adapting the shared native-row proof.

## Review and verification sequence

Preserve whole predecessor sources/inverses and original failure identities. New
source maps must cover every changed helper, caller, model, receiver and any new
source member. Do not simply recapture historical inverse expectations. Root owns
the integrated source closure and any policy-allocation decision; no version is
allocated by this design.

First qualify source/pure controls on standard hosted Actions. Preserve the four
existing terminal intentions, three factory/source-inverse intentions and existing
lifecycle receiver intentions. Add eight finite model intentions: complete bound
prototype proof; missing/partial/overload-presence refusal; changed installed or
retained-security metadata refusal; absent versus existing-empty native setting
row distinction; unknown setting postimage refusal; deferred guard/abort ownership;
telemetry failure that still drains every mandatory owner; and fresh repeated-call
checks after success or failed postchecking. Models must distinguish actual query
owner execution from fabricated native outcomes. They do not prove PostgreSQL.

Then use the existing admitted three-case native factory file. Retain each whole
legacy/default-wrapper, private-factory and rollback/lost-delivery intention.
Extend the third case's EXISTING rollback and committed witnesses: its rolled-back
resource first observes the guarded absent predecessor. After the existing next
installation commits, the old resource's repeated removal must refuse and preserve
that new object's distinct native OID. The actual committed resource still receives
its original single cleanup-carrier DROP in final settlement. Do not create a new
installation after entering cleanup or weaken that existing SQL-vector assertion.
Qualify logging in the same isolated scope through actual before/instrumented/
restored native rows and fresh post-COMMIT reads. A source-owned known mutation
must prove unknown-change refusal and be restored only from its exact recorded
mutation image; it may not reset an uncertain database wholesale. Bind the dynamic
legacy logging owner to the case's existing work/cleanup carriers and restore that
binding unconditionally. Do not open another connection pool. The original three
case declarations, 18-second work, 8-second cleanup and outer registry bounds
remain; if the actual work cannot fit, refuse and review instead of raising them.
No selected-file or fabricated CI capability is introduced.

Finally run the five complete normal employee units under the reviewed current
policy, with exact case/source/controller/resource evidence and independent raw
plan replay. The shared-owner change invalidates affected ASCII evidence too.
Do not infer a pass from six measurement cases or from successful cleanup alone.
The unchanged strict requirement is every native whole-port sample below 1000 ms.

The classic 334 target misses (1058/1289/1994 ms) and cancelled ASCII benchmark stay
unresolved. Original catalogue replay 42457228060 authenticated 2308 functions,
127 functions with defaults and exact raw default equality; its explicit
expectedProfileAuthorized=false remains false. These employee owners have no
direct import of that authorization flag. Neither this design nor a restoration
pass turns the catalogue comparison into a canonical-profile approval, application
adoption, release receipt or permission to deploy. Staging/production remain held.
