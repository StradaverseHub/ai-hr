# Native represented facet membership

Status: candidate, not measured adoption. Production held. Base is exact
`1de4d9047a7e8d58f79693ba614b2e5e0a586a43`; prior evidence remains unchanged.

## Actual bottleneck

Hosted controlled run42387710131 compared original0cf, set-wise employee population
and two disposable Assignment indexes on one physical application backend. Set-wise
Department+BU improved4496→2972ms and complete400IDs1919→224ms, but initial stayed
~2993ms. The remaining department facet consumed~2188ms/2972ms. Its actual plan
estimated cost56 yet performed50001 Assignment GiST probes and~1.19million shared
buffer hits for two department rows. It had no JIT or physical shared reads.
Principal proof cost~0.7ms. Selected projection cost~143ms. Native visibility scalar
InitPlans cost~62–66ms each (already included in statement timing). Container
counters showed zero CPU throttle/high/max/OOM and~924–1017MiB peak under2016MiB.
The earlier1.27s result from a different job is not a controlled comparison.

The experimental department index was unused. The unit index helped some empty
queries and BU facets but changed Department+BU whole port only2972→2936ms. Both
indexes are deferred. This candidate performs no index DDL, numbered migration,
visibility-function, grant, policy, JIT, work_mem or timeout change.

## Query decision

Keep the company-only represented identity branch, including people without open
assignments. For department/BU options, materialize only native authorized tuples
`(current Employment company, open Assignment department, open Assignment BU)`.
Both dimension branches use positive composite IN wrapped in IS TRUE against this
single relation, combined by UNION ALL. The materialized relation is used as set
membership, never joined to another cardinality-misestimated CTE. It carries only
three UUIDs per matching assignment; it is not a cached or bypassed authorization
result and is discarded at statement end. Actual plans must prove that the native
join itself does not become quadratic and that assignment scanning is independent
of the number of empty catalogue identities.

Every underlying Assignment, Employment, Person and outer catalogue access still
uses native RLS. Scope remains the server population: company IDs, explicit empty
employment IDs and terminatedAfter. Query/status/browser department/BU/page filters
must not narrow options. Company selection partitions display options afterward,
while allDepartmentOptions remains across the full authorized population. Native
NULLs do not qualify membership; future valid_from open assignments still do, and
closed/superseded history does not. Assignment.company and department.company must
not replace current Employment company or invalidate historical transferred pairs.
Label/name/code precedence, collision qualification, locale ordering, independent
selected row and search/count/page/complete-ID behavior remain owned by existing
helpers. The ordinary RR/RO carrier and fresh principal stay unchanged.

## Controlled verification

The new test-only reader freezes exact1de4d904, with only import paths changed;
SHA256 `d938403de31ac827b000b83d04642afbe649aa09850d53ec17dce02bfc804a0e`.
The sole-file hosted50k comparison now has two modes, original1de and facet query,
on the same native fixture and max1/PID, with all11 original/affected page cases,
complete400IDs, authority/refusal/revocation matrix and held Access/History writers.
Existing20s statements,300ms locks and300s preparation/case budgets remain. Native
policy/function/grant/settings/index inventory must match before/after. Every actual
canonical statement gets EXPLAIN ANALYZE BUFFERS, including composite facets, exact
counts and independently selected row. Candidate facet Assignment nodes must scan
at most once per statement; no50001 empty-department probes or new quadratic join
is acceptable. Existing bounded page assertions remain.

A separate native fixture spans three companies,160 unrepresented departments and
64 unrepresented business units, open NULLs, closed/superseded history, a future
assignment, transferred historical pairs, an ended employee, hidden Person and
Assignment-denied partners. It compares frozen/current full results plus independent
fixture-derived company/department/BU identities and exact duplicate labels. Actual
sparse facet plans must return all seven represented tuples with one Assignment scan.
This is native correctness/shape coverage, not a substitute for50k measurements.

Timing targets remain explicit per whole port. Test completion or an improved
component is insufficient: the goal is whole lookup below1s, which has NOT yet been
measured for this candidate. Original successful/failing evidence is retained;
standard hosted focused checks, compiler/build, actual plans and parent browser/
worker acceptance are pending. No local app/DB/runtime/compiler/build checks ran.
