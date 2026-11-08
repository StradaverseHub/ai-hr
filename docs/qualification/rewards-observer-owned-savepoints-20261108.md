# Rewards observer errors belong to the nested driver scope

Source-only successor of `c848c9057396ca7d6c86014cb453912dbd836d71`.
Run42456091376 retained16 passed and8 failed of24 native cases, with0 pending.
Artifact13607797097 ZIP SHA256
3d68635dcde94ae33ed4e6ff1b0e7138a12b23e7f024ad11e720df29488dcfb0
remains at its actual source. No old result is relabelled as this repair.

## Actual failures and owning seams

Case16 reached the explicit EXECUTE-revocation negative at observer line179 and
received55000 rather than its required42501. The observer compares the complete
native pg_proc row, including ACL, before its caller refusal. A revoked profile
can therefore enter that metadata refusal. The exact PostgreSQL executor/cache
reason for entering the body is unobserved; this source does not claim it proved
that mechanism or weaken the accepted SQLSTATE.

Case17 completed its PRE callback but its command subsequently failed with42501
from the intentional private-column denial query. Pinned postgres3.4.9
src/index.js234–293 retains every failed query in its current scope's
uncaughtError and checks that error when the scope finishes. Catching the promise
and sending raw SQL ROLLBACK TO does not create a new driver scope. Consequently
the old negative probe could leave a settled expected denial in the outer
command driver's error custody. Drizzle0.45.2 postgres-js/session.js uses the
driver's real savepoint scope for tx.transaction. That is the owning seam.

The resulting unconsumed command failure correctly poisoned the controlled wait.
The six later cases refused further work before their callbacks; they are not
six independently reproduced business defects. The poison and drain behavior
stays unchanged.

## Source repair

Every expected-negative application probe now runs through the ACTUAL Drizzle
nested transaction, and every work/read/GUC/role statement uses its nested Tx.
The raw owner-login negative similarly uses the actual postgres savepoint owner.
No caller-supplied SQL SAVEPOINT/ROLLBACK/RELEASE sequence stands in for those
negative probes. The constructor's successful installation/rollback rehearsal
remains unchanged; it is not an expected SQL-error probe.

The small pure coordinator admits one callback, requires it to fail, and awaits
the complete nested owner's rejection before verification. The owner rejection
must be the identical callback failure. A returned, swallowed, unopened, repeated
or different-error owner cannot manufacture settlement. Unknown rollback
poisons admission and retains callback/owner/abort and poisoning failures without
reflecting their private messages. An unexpected successful statement deliberately
throws a fixed marker so the native owner must still roll it back; it then fails
the test. A real case signal is checked before admission, inside the admitted
callback and after complete owner settlement. Abort never skips driver rollback.

The fixed disposable observer checks trusted database/owner/login configuration,
then requires current native has_function_privilege(session_user, fixed function,
EXECUTE) before the existing COMPLETE function/decoder/schema/relation/trigger/
policy/body/ACL checks. The execute-revocation control additionally observes that
same actual login's native permission is false before its42501 assertion.
Known COST101 still must refuse55000. No alternative SQLSTATE is accepted and no
profile field is omitted. Private-column reads remain denied on both sides of
the allowed narrow PRE read; no business-column SELECT grant is added.

## Prospective verification and unchanged scope

The original8 pure intentions remain, with the two abort models adapted to the
real nested-owner interface. Four additional intentions establish deferred exact
error/lease settlement, unexpected-positive rollback, different rollback-error
identity and poisoned refusal of swallowed/unopened/repeated callbacks. These12
models are not native driver or permission evidence. The affected diagnostic11
cases retain their source and all24 native case declarations/oracles are byte
unchanged. The full native file remains the real regression seam: case17 must
COMMIT the Bank effect after private denials; case16/18 must retain their actual
canonical counterexample refusals; Catalogue, crash and authority cases all run.

After root plus independent complete source review, request the12 observer models
and11 diagnostic cases on standard GitHub-hosted Actions, authenticate source and
strict counts, then run the existing complete24-case normal singleton. A workflow
headline, model pass or early PRE callback is not complete native acceptance.
Retain failures and source-specific successful evidence; repair only affected
checks after all frozen work is terminal.

Application/core/model/migrations, business grants, the original financial/audit
oracles, original200ms/20s/300ms/30s/18s limits, native process ownership and
controlled cleanup are unchanged. No local application, DB, model, compiler,
native runtime or provider behavior was executed. This is not architecture
adoption, a release witness, staging acceptance or production authorization.
Production remains held.
