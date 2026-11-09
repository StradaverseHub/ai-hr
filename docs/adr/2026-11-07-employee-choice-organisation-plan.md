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

Run `42550790661` retained a failed matched comparison. PostgreSQL put
Assignment first in the legacy statement and used two sequential scans. The
Assignment-first candidate did the same scan work in this fixture. The sampled
planner inputs do not identify why the legacy plan changed. On ten departments
the candidate ran ten Assignment scans while each of its two authority
witnesses still read the full visible employment set.

The next hosted diagnostic keeps that matched gate and tests the same captured
Assignment-first statements against one disposable partial index. It records the
broad and sparse product results before creation, while indexed, and after
drop, plus a second indexed read of each exact captured department statement.
The sparse scope can encounter Finance witnesses in a different order under the
index. The comparison requires the original DTOs and limits, actual tenant and
department index conditions, and lower ordinary time, EXPLAIN execution time and
buffer traffic against both no-index observations.

The reserved owner records the native index identity before commit and removes
only that identity. A fresh read of the owned realm and catalogue verifies the
original statistics, policies, grants and index inventory after drop. The test
records the matched, stress and index outcomes separately and keeps native
rollback and handback within the original 300-second case. The new comparison
requires 65 seconds of remaining case time, including 10 for cleanup. The
source comparison has no observed hosted outcome.

## Represented department pairs diagnostic

Run `42553305798` kept the original matched failure and reached both indexed
observations. The partial index was unused in all four indexed plans. Every
broad and sparse plan had 10 Assignment sequential scan loops and 11,432 shared
buffer hits at the root. The committed drop returned the original index inventory
but relation row and visibility estimates drifted. The native test refused the
post-drop comparison before the final baseline workload. The mandatory hosted
cleanup step succeeded. This diagnostic leaves the older failure intact.

The next test compares the unchanged reader against a test-only department query
that groups exact represented `(current Employment company, open Assignment
department)` pairs. Broad scope materializes native authorized Employment/Person
keys separately from a single Assignment scan, joins those key sets, then
projects the visible catalogue rows. Sparse scope starts with up to 25 explicit
server Employment IDs and uses one bounded lateral Assignment lookup per
admitted key through an existing index. The diagnostic crossover comes from the
fixed fixture. Native RLS and the unchanged product entry and DTO remain in force.

One Assignment scan alone is insufficient. Historical run `42390546115` had one
scan followed by 50,000 Employment and 50,000 Person index probes. The earlier
corrected fixture also failed its sparse loop check in run `42392436988`.
The new broad gate requires bulk Employment/Person and Assignment-key joins,
with no repeated input scans or temporary spill. The sparse gate requires a
native Employment-key index path with no full Assignment scan. Both need
consistent improvement against bracketing baseline observations on the existing
50k fixture and must meet its original latency ceilings. The earlier population
DISTINCT warning and whole lookup goal remain applicable.

The original four Unicode reads, matched gate and 300-second case remain. The
additional measured work prioritizes ten-department ABBA. Two-department
candidate timing and a production crossover remain unmeasured. The ordinary DB
suite adds a bounded native parity case with fixture-derived exact pairs and
separate Person and Assignment denial controls. Existing index/catalogue reads
admit and bracket the scale comparison. This change adds no DDL, product query
replacement or release authority. Hosted execution is pending.
