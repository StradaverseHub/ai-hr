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

The prototype materializes minimal native Employment, Person, Company and open
Assignment relations inside one statement, then reuses a coherent identity projection for
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
`9e830d169630dca113b96e34f9c05ebd3da13ef3ed2d391c91304e4397e4bffd`.
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

The initial prototype specified one base scan/eight CTE rescans; review replaced
those shape constraints with the evidence-backed work envelopes below. Repeated
small index/singleton lookups can be linear and must not fail solely on loop count.
Actual complete plans and exact native population/cardinality facts are persisted
before assertions. Limits scale from exact whole-owned-fixture relation counts,
with the retained dense1.6million node-work/150000 shared-block ceilings. These
bounds reject identified pathological work; they do not establish latency.
All14 measured whole ports must independently meet1s before a speed claim. A workflow
PASS with `allUnderTarget:false` is not acceptance, p95, capacity or browser proof.
Whole compiler/build, hosted affected checks and parent browser/worker acceptance
remain required. No local application/runtime checks or deployment ran.

## Verification review: shape is not complexity

Preserve the original7b6/c2/bc9 results: run42392436988 passed three sparse native
semantic/authority checks and failed the old plan assertion at7 Assignment loops
versus1. That result does not establish whether its sparse plan was efficient:
its complete EXPLAIN/cost was not retained. No old failure is relabeled PASS, and
7b6 remains held after its measured speed-target failure.

The verification child leaves the5510178d8 production reader byte-for-byte unchanged.
It restores the14-selector regression union (including native abort/Unicode50k,
DOM, migration/hierarchy/r395 coverage), plus one synthetic plan-work test. Existing
real result, history, selected, facet and permission assertions remain.

Both sparse and sole50k artifacts retain exact whole-owned-fixture base relation
counts and separately native authorized server-population facts. N is the largest
actual Employment/Person/Assignment/Company/Department/BU relation in the entire
owned fictional database, including foreign fixture tenants; it is not reltuples,
a planner estimate or the authorized result size. Authorized facts independently
record the actual context/server company scope, visible relation counts, joined
identities, companies and represented current-company department/unit pairs.
Fact reads run outside measured calls for both variants and can warm caches; these
are controlled component diagnostics, not cold-start or population-percentile data.

Each actual node records loops, returned rows and four removed counters (filter,
join filter, index recheck and conflict filter). Its approximate work is loops times
returned plus all removed rows. PostgreSQL reports per-loop averages, sometimes
rounded, so this is a diagnostic estimate, not exact work or CPU accounting.
The limit is min(1600000,32N). The root shared-hit-plus-shared-read limit is
min(150000,max(4096,3N)). The sparse fixed4096 floor allows finite native permission
startup/index work; below50k the remaining limits scale linearly. The dense caps
are preserved even if a future fixture grows, so no budget increases implicitly.
The32 multiplier allows bounded repeated passes; the dense block ceiling rejects
the retained404542/1.19million shared-hit plans. These provisional envelopes are
reviewed rejection criteria, not measured claims about a good plan. A failing future
plan must be captured/reviewed before changing a threshold.

Synthetic regression models allow7 efficient sparse index probes and20 singleton
CTE lookups; reject50000-by50000 rescans, work hidden in each removed counter and
404542/1.19million hit-only or read-only block costs. They supplement real EXPLAIN,
not replace it. Same physical application PID/native authority/security/grants,
read-only sessions/settings, no DDL, held Access/History writers and all14 whole
ports remain. Complexity success and all14-sub1s speed success are separate outcomes;
a workflow that completes with allUnderTarget:false remains unaccepted.

A third pre-dispatch verification defect was found by independent Spec review:
the frozen comparison retained `./ai-principal` from its original core location.
Only that import is corrected to `../../core/ai-principal`; the repaired baseline
byte digest is `9e830d169630dca113b96e34f9c05ebd3da13ef3ed2d391c91304e4397e4bffd`.
Reversing the exact import relocation and removing its provenance comment recreates
c2's original production reader byte-for-byte, SHA256
`c524f7e7d30ed742e81870da3b6e439faab32061363b3750893a5b5c2076ccbd`;
the prepared test pins both digests. Its prior broken import/digest is retained in
551 history;551 had not been dispatched, so no failed or passing result is inferred.
Static resolution found all78 actual relative imports across13 new/affected source
and fixture files, including both old frozen comparison readers. This checks target
existence only, not exported symbols, compilation or runtime. Hosted checks remain
pending.
