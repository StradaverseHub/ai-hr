# Attribute the remaining employee organisation-filter cost

Status: original-only hosted diagnostic; execution pending. No production change is decided.

The real appended Employment membership migration3001 improved the unfiltered50k
employee-choice read, while a department/active-filtered port still measured about
5.5s in run42376032916. Its estimated plan alone cannot establish the cause. The
current native organisation path retains an indexed lateral Assignment lookup;
Assignment membership still uses the original positive visible-employment array.

First capture complete native port timings and actual EXPLAIN ANALYZE/BUFFERS plans
for the exact SQL objects issued by the canonical port. Do not infer Assignment
membership cost, join behavior or JIT overhead from an estimate. The first checkpoint
changes no policy, function, grant, JIT/work_mem setting, deadline or production source.

The fictional50k fixture adds a represented500-row Business Unit subset and an
unrepresented unit. Independently expected cases cover initial/deep/search pages,
department plus active status, department plus unit, empty results, independent
selected identity and represented options. A foreign-company scope stays empty.
Every measured/replayed transaction uses the real ai_hr_app role, current calling
principal proof and enforced repeatable-read/read-only mode on one physical backend.
Original policies, function definitions/security identity, table grants and session
settings are compared before/after. Case limits stay300s; SQL20s and lock300ms.

Plans replay the captured SQL objects unchanged. For a cursor, the original nested
SELECT object is extracted from DECLARE; FETCH/CLOSE timings are retained separately.
Artifacts omit raw SQL parameters. CPU and cumulative container memory telemetry
are collected outside timed port calls on the job-owned database only. The singleton
focused manifest avoids unrelated selected files contaminating CPU attribution.

This baseline is an attribution probe, not a new authority implementation. Existing
native authority coverage remains owned by employment-membership-initplan.test.ts
and the migration qualification manifest. If actual plans justify a later Assignment
experiment, only its exact positive membership may change in the disposable job DB,
with full predecessor/roles/command/WITH CHECK/function/grant guards and unconditional
restoration. That comparison must repeat employee, manager/HOD/date, tenant/company,
historical Assignment/current Employment company, partner, archive/revoke, void and
selection/options controls in separate bounded cases before any production proposal.
No Assignment company shortcut or cross-request authorization cache is authorized.

Run this probe and the whole compiler on standard hosted Actions after source review.
Retain original outcomes and wait for all planned jobs before repairs. Root owns any
eventual migration allocation, independent review and release qualification. Neither
this diagnostic nor a component PASS grants installation or production authority.

## Department options candidate

The later hosted component run `42535097408` tested a valid department index in
an isolated 50,000-employee fixture. PostgreSQL did not choose it. All four
captured plans retained the same 31 nodes, including 50,001 Assignment GiST
probes. Their execution times were 2.23 to 2.26 seconds. JIT was enabled and none
of the four plans reported JIT activity. The test removed the index and verified
restoration. The exact historical DISTINCT failure remains unlocated.

The candidate changes only the department existence query. It selects Assignment
witnesses by tenant, department and current state before checking the associated
Employment and Person against the existing population and native row security.
Company, business unit, page, selection and scope remain with their current
owners. A department's origin company can differ from Employment's company.

The dedicated hosted component probe compares the frozen historical department
statement with the actual candidate statement over one read-only snapshot. Two
separate stress reads exercise eight extra empty departments with broad and sparse
scope. Their limits apply to these fixtures. The matched timings are individual
observations. The stress checks establish absolute limits and exact results for
their inputs. Verification requires the observed native plan, original lookup
results and owned transaction settlement. This source candidate has no release
qualification or deployment receipt.

The dedicated probe disables postgres.js type discovery on both existing pools.
Its fixtures use scalar and JSON values, with array arguments cast on the server.
The driver can otherwise start a discovery query outside the awaited operation
after its connection timer stops. The fixture owner awaits one authenticated
scalar query before immediately reserving its connection. The reservation must
have the same backend identity before setting limits. Ordinary runs keep their
connection settings. The five stress statements count product calls. Driver
protocol messages and prepared-query retries have separate semantics.
