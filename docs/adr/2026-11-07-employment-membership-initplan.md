# Preserve statement-local authorization while hashing Employment membership

Status: uninstalled implementation candidate; qualification pending.

The existing Employment policy evaluates positive membership in the native
`app.visible_employment_ids()` result using `id = ANY(uuid[])`. A complete employee
choice read on a fictional 50,000-employment fixture still took several seconds even
after paging and payload reduction. Actual native query plans separated that cost
from the independent Analytics temporal join defect.

## Decision

Use `id IN (SELECT unnest((SELECT app.visible_employment_ids())))` in the policy's
two existing positive membership terms. Keep the scalar subquery around the existing
visibility function. This retains statement-local authorization evaluation while
making membership hashable. A direct `unnest(app.visible_employment_ids())` rewrite
caused planner-time population evaluation and expensive JIT optimization in the
measured full query; count-only gains did not establish a useful whole-read gain.

The migration guards the complete predecessor USING expression, role, command,
permissiveness, WITH CHECK and the visibility owner's body/security attributes.
It replaces exactly two matching terms in the original native expression instead
of reconstructing the surrounding CASE. It refuses unexpected predecessors with
SQLSTATE55000. Every existing tenant/void guard, bank point-read branch, payroll and
performance partner path remains. No function, grant, write check, timeout, JIT
setting, cross-request cache or permission lifetime changes.

Only TRUE admits a row under a PostgreSQL USING policy. NULL and empty populations
must both continue denying non-partners, and partner OR branches must retain their
existing effect. Duplicate visible IDs cannot multiply rows. The new qualification
must prove these cases through the native policy and current calling principal.

## Evidence and acceptance

The isolated five-variant diagnostic42372708778 used the same single native app
backend, with unchanged read-only repeatable-read authority and20s SQL/300ms lock
budgets. Two original full reads measured3582/3138ms; the scalar wrapper measured
675/661ms. Direct IN with JIT on measured3149/3113ms, and with JIT off2391/2389ms.
These are one-host component samples, not production capacity or release evidence.
The aggregate authority case hit its300s case budget before the wrapper's authority
calls; its separated-case recovery42374518333 remains pending at authoring.

Qualification requires the actual appended migration, committed populated
predecessor replay, unexpected-predecessor refusal without mutation, complete
before/after native DTO equality and independent authority expectations. Existing
employee choice, hierarchy, policy-visibility, partner, write and bank-point owners
remain affected checks. The50k complete read and integrated Analytics/Roster timings
must be measured again on the combined candidate before worker comparisons.

The source must pass browser preflight before sustained2/4-worker qualification.
An8-worker run on a4-vCPU runner is an oversubscription diagnostic, not a matching
production-capacity result. Zero observed Busy, handled unavailable pages, HTTP500s,
crashes and blocking ordinary-read locks remain separate runtime requirements.

Applied SQL and the installed ledger are immutable. Recheck all allocations and the
installed watermark before staging. This candidate does not install itself;
production deployment and production stress testing remain on hold.
