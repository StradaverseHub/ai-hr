# Set-wise organization membership before employee display projection

Status: candidate for hosted comparison, not measured adoption. Production is held.

The actual controlled same-backend result42383332942 isolated Assignment membership
representation under native authority. Real migration3102 adopts only that reviewed
RLS representation. Its wrapped result still performed40000 per-employment lateral
probes for Department+Business Unit (2797ms SQL;3489ms whole port). An empty unit
performed50000 probes in both page and fallback count (4176+4110ms SQL;8898ms whole
port). Initial whole-port time remained1270ms. These are historical component
measurements, not results for this candidate.

## Query decision and preserved facts

The candidate filters native Assignment rows into a positive membership subplan,
then applies it while counting/paging minimal Employment/Person/Company identities.
The bounded page alone receives the existing lateral Assignment/label projection.
Search and complete server-side ID enumeration use the same membership owner.
The positive IN expression is wrapped in IS TRUE to retain a subplan boundary;
a plain flattened join risks the already observed RLS cardinality misestimate.
Actual EXPLAIN ANALYZE must confirm the intended bounded loop behavior before this
candidate can be adopted. A source shape alone is not performance evidence.

Assignment visibility stays native. The predicate retains tenant, valid_to NULL and
superseded_at NULL exactly, with no valid_from or active-employment cutoff. Current
Employment company owns scope; Assignment.company_id must not replace it. The
validated immediate assignment_no_overlap exclusion means one unsuperseded open
assignment per employment, so positive membership preserves the old joined count.
Without an organization filter, unassigned employees remain. Search still applies
the original conservative native candidate followed by exact ECMAScript lower/includes.
Names/order, page ceiling, independent selected row, unfiltered represented facets,
server employment/date fences, fresh RR/RO principal and command owners are unchanged.
No policy, visibility function, grant, writer, schema or numbered migration changes.

## Controlled schema comparison

The prior actual catalogue has assignment_pkey, assignment_company_idx,
assignment_employment_idx and the GiST exclusion index. None starts with a Department
or Business Unit identity. The hosted comparison provisionally adds these two indexes
only to its owned disposable database:

- (tenant_id, department_id, business_unit_id, employment_id)
- (tenant_id, business_unit_id, department_id, employment_id)

Both use WHERE valid_to IS NULL AND superseded_at IS NULL. The three modes are the
frozen0cf29593 reader, candidate with existing indexes, and candidate with both
provisional indexes. The experiment compares full ports, actual per-query plans,
index use, buffers and component timings; it must not infer benefit merely because
an index was created. An unused or negligible-benefit index should not be adopted.
Any real index allocation, populated migration and write-cost rehearsal belong to
the integration owner after results. This source reserves no migration number.

## Required evidence and execution

A hash-pinned test-only copy preserves the exact baseline reader except import paths.
It is an explicit historical comparison fixture, never an application port or fallback.
The sole-file50k diagnostic uses one max1 native application connection, real3001+3102,
unchanged20s statement/300ms lock/300s case budgets and the standard hosted runner.
Setup has its own existing300s budget; timeout cancellation closes the owned client,
drains finally and prevents successor DB work. Metadata/settings and exact original
indexes are checked before/after every mode. No JIT/work_mem/permission bypass or cache.

Independent fixtures assert expected IDs/counts/facets/selection, active/ended,
current/future/historical/unassigned and transferred-company facts, Unicode/literal
search, complete server populations and native self/manager/HOD/partner/refusal parity.
The50k comparison adds unit-only/deep/search, all11 original/affected page cases,
complete400-ID population, actual Access and History barriers held through each read,
actual JSON plans for every captured canonical statement and exact result equality.
Candidate identity/count plans must have no Assignment node looping beyond the25-row
page bound; final plan review must distinguish one set scan from bounded display joins.
All timings and sub-second targets remain explicit; test completion is not a claim
that a latency target or full500-user architecture gate passed.

No local application checks or runtime have been run. Root reviews and dispatches
hosted evidence, qualifies compiler/build and actual browser/worker behavior, then
chooses whether measured query/index changes are safe to integrate. Production stays held.
