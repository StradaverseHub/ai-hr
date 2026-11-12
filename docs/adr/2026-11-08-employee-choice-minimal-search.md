# Stream exact search facts before ordering the bounded page

Status: uninstalled development prototype; unrun source child of
9f51857dbc439f21a9ed6f4a0fc4b6aec4c5500c. Application core, original f151 reader
and frozen control remain unchanged. No migration number, index, grant, source
approval, provider call or production/staging adoption is introduced.

## Actual cause and preserved evidence

Run42405537839 passed the original harness: all34 real phases,17 native bodies,
authority, exact backend/config restoration and cleanup. Its raw44,553,316-byte
native log has SHA2561533842c78ae5600908c3e99897f04ad538c219f7fdbef1586fed03ac75e1fca.
Both implementations still reported allUnderTarget=false. Native search1449.64ms
and missing-search1202.35ms exceed1000ms; deep992.91ms is marginal and its original
run42403809918 sample1099.11ms remains a miss. These are retained observations,
not a p95, capacity, whole-page or release result.

Actual nested search body duration was566ms while its outer cursor statement took
1307ms. The outer query sorted50005 wide rows by phase, conditional UUID keys and
native name/ID, spilling7200KiB. Missing-search had the same spill. Deep pagination
sorted full matching tuples and spilled6136KiB inside the function. Early custom
plans also spilled Person merge sorts and2896KiB for repeated company legal names.
Later generic plans changed some joins/aggregates; no plan_cache_mode is forced.
Native maximum node work50000–50005 and shared blocks6649–6994 passed the original
envelope. Nested and outer timings/buffers overlap and must not be added together.

## One population owner, two explicit search calls

The fixed invoker function gains one typed matched-UUID-array argument and a closed
`project` purpose. Existing actual LOGIN, human principal, RR/READ ONLY, native RLS,
tenant/company/current Employment authority, archived/voided/ended/history and
NULL-ended unsuperseded Assignment predicates remain. No future valid_from filter,
locale-dependent SQL lower substitution, temporary write, cache or permission grant
is introduced. All original source IDs, selected identity and complete facets remain.

For search, the first call emits only employment ID/name/code candidate facts,
plus the independent selected record and complete represented catalogue. Candidates
are unordered; no name sort is paid for nonmatches. The existing ECMAScript
trim/lower/includes owner evaluates every candidate and retains every matching ID,
without a new population cap. It never sorts employee names with a JS locale.

Only if matches exist, a second call in the **same native RRRO transaction**
rechecks principal/RLS, original server population and browser filters against that
exact ID set. PostgreSQL orders the matching keys by the original collation/name/ID
and bounds the page before full identity hydration. Its exact admitted count must
equal the independently matched-ID count. Zero matches skip projection. Duplicate,
NULL, multidimensional, wrong-purpose or absent projection arrays refuse natively;
submitted IDs are narrowing facts, never a grant. Selected identity remains
independent of search/page/status/organisation filters within the server population.

No-query deep paging also sorts only name/ID keys before projecting full tuples.
The positive `IN (...) IS TRUE` membership boundary retains a set-wise subplan;
actual native plans must still prove its work. Company labels are joined only after
represented IDs are known, rather than copying/sorting legal names per employee.
Catalogue assembly tolerates arbitrary stream interleaving and retains canonical
PostgreSQL UUID byte order before the existing display-label/locale owner runs.
Complete-ID reads retain native name/ID ordering and never apply a page ceiling.

## Qualification measures all work

The original34-phase proof remains at9f518/run42405537839. The new source uses a
distinct V2 report and38 planned phases: the original ports plus broad and deep
broad searches for each variant. All16 ports/18 timing samples per variant retain
the same300s cases,20s statements,300ms locks,1000ms target, standard resources,
4MiB work_mem, natural cached-plan transitions and fixed current-root baseline.
Broad matches may still cost more; no universal subsecond promise is made.

Every candidate and projection call must have its own actual nested body, function
context, closed purpose marker, outer Function Scan and independently expected
stream count in the correct sequence. Missing/extra/reordered/wrong-purpose calls
refuse. No second scan is hidden inside the original single-call witness. All real
native statement plans receive the unchanged node-work/buffer rejection checks;
distinct main bodies additionally share that original envelope per phase. Nested
and outer copies are never summed as independent work. Raw logs/plans/failures are
retained before outcome assertions. The existing64MiB log bound is unchanged.

Ordinary native coverage adds same-snapshot and direct re-admission controls for
same-tenant denied IDs and server-limited populations, native malformed projection
arrays, Unicode/tied-name exact pages, All2000 and complete IDs beyond2000. Native
owner queries provide independent name/ID order expectations; no JS approximation
stands in for collation. Parser tests reject missing second-call provenance.

Prepared source is not speed acceptance. Root and independent reviews precede
standard hosted ordinary/native/controlled/compiler/build qualification. Normal
singleton registration, guarded allocation/populated upgrade, application adoption,
all-module browser/load/worker tests and staging acceptance remain separate gates.
Production stays held. No local application/database/compiler/build checks ran.
