# Native Rewards PRE observation under the actual command transaction

This is a disposable verification repair, not an application permission change,
a production migration, Rewards adoption or release authorization. The parent is
`bc294094b6e42c3070dd21abc6583e4594c8d37b`. Production remains held.

## Actual failure retained

Authenticated run `42450210754` finished all24 cases with20 PASS,4 FAIL and zero
pending. Artifact `13605132855`, ZIP SHA256
`5ea48fce6a3180d7ca34b2f07b5d8e8f865fc16316281023c65b6b11b69d8ba8`,
retains the complete diagnostics. Case15's original200ms native wait now passes;
this repair does not alter it. Bank16/17 fail in the test's private-column SELECT,
with native42501 and `aclcheck_error`, after the actual Bank preparation succeeds.
Catalogue18/19 reach actual confirm42501 after guard/lock/stored parsing, before
an observed native-save call. The source-owned case-time callback also attempted
a denied private-column SELECT before forwarding to the canonical owner. That is
a concrete observer defect; whether removing it closes Catalogue's remaining
failure is still unqualified until the hosted24 cases finish.

The earlier16-case original-family PASS at83ac and all prior failed24-case runs
retain their original source/artifact identities. No receipt is relabelled.

## Capability and business boundary

The fixed uninstalled SQL creates only `reward_policy_test.read_review(uuid,text)`
and two private fixture tables in `reward_policy_test_private`. The function is
STABLE, SECURITY DEFINER, with fixed pg_catalog/pg_temp search path. It can return
only a Catalogue phase and the native audit PRE object for exactly Bank maintenance
or position archive. It cannot execute supplied SQL, return bank/employee payloads,
perform business writes or alter an audit decision.

A temporary test-only schema USAGE and exact function EXECUTE grant is added to
the existing application LOGIN. **Not all grants are unchanged:** this fixture
capability is an explicit addition. Original business table/column grants, RLS,
canonical function ABI/bodies and audit policy remain unchanged. PUBLIC and both
dedicated Rewards LOGINs receive neither schema access nor EXECUTE. Neither
fixture private table is exposed. This port is not imported by application code,
installed by a migration, or an available production service.

The owner first checks the actual committed prepared review and native app backend.
Its private binding records the exact review/action/tenant/user, actual session role
OID, native PID, full backend-start timestamp and root xid8. The function itself
rechecks current native session/principal/scope/root and the underlying review,
including an armed native root where present. A GUC or caller JSON is insufficient.
The SAME actual application Tx supplies every PRE read; an owner connection outside
that Tx is not used to invent or infer its uncommitted PRE. Owner records bind a
native observation, never grant business permissions.

Function full metadata, exact source body, schema ACLs, private relation metadata,
ABI and direct dependency images are captured after exact installation. The port
checks its current function and canonical relation decoder metadata before reading
its sealed schema/relation closure. JavaScript owner admission also checks complete
fresh images and unchanged original business metadata before binding. Any changed
profile refuses; it is never silently recaptured as a valid replacement.

## Native verification additions, not yet executed

All24 declarations and original PRE/History/effect/hash/financial rollback oracles
remain. The independent native History advisory-key derivation, actual PID/start,
older reader, concurrent receipt commit, controlled unsafe counterexample and
canonical app writer still execute. The two illegal test SELECTs are replaced with
the minimal same-Tx port. Closed bank-test-pre/catalogue-test-pre diagnostic
boundaries distinguish observer failure from canonical service failure; they
retain the exact value/error identity and never publish messages or payloads. Actual private-column SELECT must still return42501
BEFORE and AFTER every successful observation, using a real savepoint rollback.

The first Bank and Catalogue counterexample each prepare a real other tenant and
its actual principal. Additional statements verify unknown review, wrong action,
null, malformed UUID, foreign actor/tenant, explicit own-role setting, and actual
owner LOGIN refusal. The valid foreign principal is independently required to pass
native principal_snapshot_current before the bound-review refusal. Wrong PID,
full-start and xid use values derived from the actual other owner backend/root;
there is no forged native JSON witness. Each binding mutation restores the exact
original app identity in mandatory cleanup before further application work.

Actual EXECUTE revocation must refuse42501 and restore its exact original ACL.
Native function COST drift must refuse55000 and restore its exact full metadata.
Both restore paths preserve any original failure and poison successors if cleanup
is uncertain. The source body/ABI/ACL and positive read are checked again afterward.
The controls are inside the existing24 cases; no case is skipped or weakened.

## Constructor and lifetime

The constructor performs real fixed installation under a savepoint, verifies its
native body/ACL/ABI, rolls back, and requires both schemas absent plus original
business metadata exact before the actual installation. Its native postimage is
recorded before possible COMMIT. An installation failure runs the same strict
restoration path; unknown objects are retained/refused rather than guessed away.

Binding reset runs only during the existing admitted work phase, before canonical
fixture reset. It requires every recorded PID/full-start/root transaction to be
absent from actual exclusive transaction locks. Hook socket cleanup does not
reacquire owner SQL while the existing lifetime is idle. Final cleanup uses the
already admitted cleanup connection, verifies complete owned metadata, drops the
exact function/two tables/two schemas WITHOUT CASCADE, and requires native absence
and unchanged business metadata. Unknown dependencies or altered ownership refuse.
The original policy restoration span is byte-identical to the parent.

No pool/resource/clock grows: existing owner max1/2s connect,20s SQL/300ms lock,
30s native cases,18s aggregate cleanup and original200ms wait remain. The original
controlled promise/abort/drain owner remains authoritative. Newly added negative
queries and restoration consume those existing budgets.

## Frozen-source checks requested

Six new pure contract/source cases cover exact full-body extraction, closed actual
root claims/suffix refusal, two-action UUID scope, minimal result/null semantics,
unchanged24 native declarations/source boundary, and deferred/error identity of
the two closed test-observation phases. These do not prove native
permissions or custody. Both existing real singleton profiles bind all three new
prototype source owners, with independent critical-owner omission checks. The full
runtime closure grows1668→1671; the explicit Tamil dependency bound remains intact.

Before any native rerun: independent full source review; hosted six pure cases and
controller/complete-plan checks. Then rerun the affected24 native cases against
this exact frozen source. All existing source/permission/business assertions must
pass, with zero pending and actual rollback/cleanup proof. No local behavioral
checks were run, and no new PASS, staging arrival, architecture adoption or
zero-Busy claim is made by this document.
