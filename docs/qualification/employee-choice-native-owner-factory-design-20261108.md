# Native employee installer/security factory: design checkpoint

DESIGN ONLY, exact base334ed804b794ff945153b70c638f22193fbe177c. No source
extraction, test execution, SQL or environment change is part of this checkpoint.
Deferred ASCII source76b63f12190707553923ad62ad1bcd1dfc303f7e remains frozen and
blocked from commissioning. Its newer body/read/runtime proof is not adopted.

## Existing gap

The fixed original installer imports harness.owner. Its full security snapshot
inside the installation transaction reacquires owner.client for four catalog
queries. A genuine max1 private pool therefore deadlocks: the open transaction
owns its only connection. The installed package's postgres Sql and TransactionSql
both implement ISql, so the SAME actual tx can execute every unchanged metadata
query without reacquisition. Source-only cancellation or a claimed max1 option
cannot substitute for that native behavior.

ASCII's compositional owner separately imports harness.owner for definition,
replacement and restoration. Fixing only the original installer leaves those
queries unbounded. AllModule owns that later caller adaptation and has confirmed
the proposed dynamic private seam; this checkpoint does not edit76b or their
Rewards work. Root owns normal-CI registration/integration/dispatch.

## Minimal module boundary

Add test/performance/employee-choice-native-purpose-owner-factory.ts as the ONE
owner of the existing fixed installer/remove/security implementation. Its private
composition API binds getQuery(): postgres.Sql, which returns the already-owned
current work or cleanup carrier. It accepts no SQL source, identifiers, endpoint,
mode, role, approval, caller acceptance report or installation program. Existing
fixed source paths, hashes, signature and SQL are unchanged. The factory creates
no pool and has no role-grant, resource-admission or deployment authority.

Keep test/performance/employee-choice-native-purpose-owner.ts as the legacy
wrapper. It binds getQuery dynamically to ()=>harness.owner.client, preserving
existing benchmark owner swaps; never capture the original pool at module load.
Preserve every existing export name, zero-argument security function, optional
pre-COMMIT adoption argument, return fields and default behavior. Do not change
legacy pool settings, defaults, limits, roles or environment checks to force the
new private profile onto old callers.

The factory's security reader has an INTERNAL optional explicit postgres.ISql
carrier. The post-CREATE security snapshot receives the SAME actual transaction
object; it must not call getQuery or acquire another pool while that transaction
holds max1. Preserve all four complete ordered snapshots: functions/pg_proc MD5,
policies, table grants and role edges. Other operations resolve the private current
carrier; owned/remove/unchanged and every catalog verification must consistently
use it, never fall back to imported harness state. The wrapper's public security
signature remains zero-argument.

Pre-COMMIT adoption stays after ALL native full-field/ACL/security assertions and
before COMMIT delivery. The captured native OID/definition/pg_proc metadata,
absent predecessor and full security before-image remain exact. Unknown drift
never authorizes DROP/RESET or replacement. The additive ASCII owner later
preserves its original/candidate full identity and only-prosrc comparison,
restores that exact original definition, then invokes the original guarded remove.
No row/owner/role/grant oracle is replaced with a boolean.

## Bounded private caller contract (required before ASCII commissioning)

The caller must own real max1 work and cleanup pools, actual loopback5433 exact
worker database/LOGIN, bounded startup (<=2s),20s work SQL/300ms locks, cleanup SQL
<=2s plus an actual aggregate cleanup deadline below the30s hook. A1s cleanup cap
may be required to keep the complete statement inventory within that aggregate;
no statement or security snapshot may be skipped. The factory itself does NOT
certify bounds by accepting a plain object or option field. Verify real native
PID/settings and use the actual borrowed tx.

Before switching getQuery to cleanup, stop further work, settle every real
transaction callback (not only postgres.begin's connection-close race), own late
constructors and prove native backend quiescence for the exact scope. Reuse the
reviewed334 lifetime/callback/query-origin semantics where appropriate; do not
mutate global harness.owner for the private ASCII path. An external fixed
process owner remains necessary for blocked JavaScript. Timeout/unknown restore
is failed/poisoned disposal, never semantic-restoration success. Normal-CI requires
its genuine dedicated cluster/source closure/admission and cannot borrow a new
profile label from another test.

## Required preservation and qualification proofs

1. Freeze exact334 legacy owner source bytes as a provenance-bound text fixture.
   A small documented inverse must reconstruct the COMPLETE original file from
   factory plus wrapper, allowing only carrier substitution and the intentional
   in-transaction outer-client→actual-tx routing. Compare exact SHA, not selected
   source substrings. This is a mechanical preservation proof, not native PASS.
2. Independently assert original export/default binding/adopt shapes. A dynamic
   wrapper test must show changing the actual default accessor is observed on
   the next operation, not cached. Explicit statement/parameter logs must retain
   every original fixed query and full native assertion field.
3. Actual native default-wrapper versus injected max1 install/unchanged/remove
   must compare full OID/definition/pg_proc/ACL/security facts and final absence,
   preserving row data. Prove the security checks inside install use the SAME
   actual PID/transaction and no second checkout; hold the sole connection as a
   negative control so an outer-client regression deterministically refuses.
4. Test before-COMMIT rollback, committed-but-undelivered response, full unknown
   body/metadata/ACL/owner refusal and exact guarded restoration. Separate cleanup
   carrier must be used after actual work stop; no late callback or constructor
   may restart work. Distinct primary/finally/cleanup failures stay compound.
5. After normal-merging the reviewed seam into exact76b, AllModule routes ALL of
   ASCII's own definition/replace/restore/security/remove operations through the
   private carrier. Verify complete original/candidate identity and all9 native
   assertions,14 pure assertions and sole6-case/44-phase/22-native-pair benchmark
   under the original targets/budgets. Historical27-pair receipts remain historical.

Implementation ownership if approved: new factory, legacy wrapper, provenance
baseline/inverse/native seam tests and qualification docs only. AllModule owns
the ASCII composition/case integration on its later exact-history child. Shared
harness/defaults, application/reader/native SQL, migrations, grants, provider
inventory and root CI registration remain outside this extraction. No code or
hosted request may be called qualified by this design. Production remains held.
