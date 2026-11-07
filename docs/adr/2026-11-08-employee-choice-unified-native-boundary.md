# Reuse one native employee-choice read boundary

Status: unmeasured prototype. Production held. Fixed application base is
`c2f5c019e414e3876fc3268443de183dffb4d560`; the valid unassigned-fixture repair
`bc9fe5373dfffe6673c257049e624d85aa439615` is merged normally. No release claim.

## Evidence and decision

Preserve prior run42387710131 and current controlled run42390546115. The latter
passed measurement/correctness but missed the1s whole-port target. Frozen1de took
1234ms for Department+BU, versus1308ms for7b6. In the earlier run, the same1de
department SQL chose50001 Assignment GiST probes,1.19million shared hits and2208ms;
the current frozen query chose short-circuit Assignment scans, one Employment and
Person lookup each, and199ms. SQL, native security/index definitions and principal
settings match, but plans/estimates and host CPUs differ. Both fixtures ANALYZE
principal tables. Statistics/page-layout evidence was not captured, so the exact
cross-run plan-flip cause is unknown; do not attribute that improvement to7b6.

The7b6 shared facet still performed50000 Employment and50000 Person PK lookups,
404542 shared hits and528ms including64ms JIT. Its page had four visibility scalar
InitPlans, selected two, company one and facet two, each roughly84–87ms, plus page
JIT107ms. These are repeated native relation/statement proofs, not per-row calls.
Reducing only Assignment probes does not establish a fast whole lookup.

The prototype reads minimal native Employment, Person, Company and open Assignment
relations once inside one statement, then reuses a coherent identity projection for
count/page, independent selected employee and complete represented catalogues.
Person/Assignment/Company are narrowed through positive `IN ... IS TRUE` membership
before projection joins. All native RLS remains active. MATERIALIZED is reuse;
it does **not** guarantee join complexity or accurate cardinality. Actual dense and
sparse plans must reject quadratic CTE rescans and100000 base PK probes.

## Exact behavior and bounded transfer

The native statement emits ordered tagged count, company, department, unit,
independent selected and candidate rows. Without search, only the requested page
and selected identity leave the database. Their identity facts are carried through
the page; Employment/Person/Assignment are not reread for DTO projection.

With search, SQL retains the existing conservative ASCII/non-ASCII candidate rule.
A512-row cursor streams minimal name/code/current-company/organisation/status
facts; ECMAScript `toLowerCase().includes()` still computes exact count and page.
Only that page and independent selected identity are retained. Native catalogue
metadata supplies labels afterward. There is no50000-employee JSON aggregation,
search ceiling, SQL-only Unicode approximation or cross-request authorization cache.
An aborted fetch/count issues no subsequent SQL; transaction rollback owns cleanup.

Company/status/search/page/department/BU browser controls do not narrow metadata or
independent selection. Server company IDs, explicit employee populations and
terminatedAfter still narrow everything. Current Employment company remains the
owner, including historical department/unit pairs after transfers. Future NULL-ended
unsuperseded Assignments remain current; closed/superseded history is excluded.
Unassigned employees remain company representatives. Independently denied Person
rows disappear; denied Assignments produce NULL organisation; denied catalogue
labels remain NULL while visible Assignment IDs are retained. Native label/code
precedence, collision qualification and locale ordering remain with existing helpers.
The complete-ID helper keeps its minimal, exact existing cursor and grants no
command authority. Principal, RR/READ ONLY admission, date/money/writers are unchanged.

## Required hosted qualification

The exact c2 reader is frozen with imports moved only, SHA256
`7e570d816d3ac9533de176ae85b26ed96948994ecff92554f946404cc1ec0879`.
Existing native authority/history/revocation/Unicode/server-population tests remain.
New613-person native search crosses cursor batches and checks independently expected
IDs/counts, deep/independent selection, missing/literal/NUL queries and full IDs.
Sparse plans retain all seven represented tuples and three companies; a real
no-search boundary returns six candidates, seven facets, three companies and count.

The sole hosted50k comparison pins frozen c2 versus unified on one actual max1/PID,
native3001+3102, unchanged20s statement/300ms lock/300s case budgets and settings.
All original14 ports, complete400IDs, Access/History held barriers and native
authority matrix remain. Cursor EXPLAIN row counts use actual streamed candidate
counts, which can exceed exact JS matches. Read-only relation/index pages, tuple
estimates, column statistics/analyze state and planner cost settings are captured
outside timed calls. No index DDL, policy/function/grant, JIT or timeout experiment.

Actual unified plans must read each base Employment/Person/Assignment at most once,
scan a materialized reference at most eight times, keep per-node processed/removed
work at most1.6million rows and whole-statement shared hits at most150000. These
bounds reject the identified pathological plans; they do not establish latency.
All14 measured whole ports must independently meet1s before a speed claim. A workflow
PASS with `allUnderTarget:false` is not acceptance, p95, capacity or browser proof.
Whole compiler/build, hosted affected checks and parent browser/worker acceptance
remain required. No local application/runtime checks or deployment ran.
