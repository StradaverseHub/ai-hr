# Analytics presentation reads before calculation and transport

Status: component implementation; hosted qualification pending. This is not release or production acceptance.

## Problem and preserved contracts

The Analytics screen fetched a complete employee roster for the manager selector, complete detail reports for its tables, and a complete master-data export merely to display its length. Headcount also returned every matching source row to JavaScript before tallying. These are verified source paths, not measured claims that all latency comes from transport. Native RLS membership and join plans remain potential bottlenecks and need actual 50,000-employment measurements.

Reports retain their existing populations and filters. The three detail reports use their existing department/name/email filter, including SQL ILIKE wildcard behavior. Hire assignments are effective at hire date; termination assignments include the closed version ending on termination day; transfers require an unsuperseded adjacent predecessor. Existing empty company scope means RLS-only, not an artificial empty result. Complete exports retain all matching rows and their existing primary order. No policy, role, calculation, ledger writer, command or provider disclosure approval changes here.

## Decision

One query builder per report supplies both complete export and paged presentation. Presentation uses the shared PageQuery/PageState contract and exact native window counts before LIMIT/OFFSET. An out-of-range page performs an exact native count in the same transaction. The only All limit is the existing explicit shared 2,000-row UI ceiling, with the complete export retained. The API rejects malformed page carriers instead of silently clipping them. Native page order adds name, employment ID and assignment ID tie breakers after the existing descending event date. Full export projections discard internal tie-breaker IDs.

New presentation roots clone supplied role/grant inputs and own one database-enforced REPEATABLE READ, READ ONLY transaction. The current calling-login proof and ordinary native table RLS run inside that snapshot. There is no Access writer barrier, row lock, cross-request authority cache, event append or provider call. A selected manager filter resolves only its authorized employment ID/name with the old employment/person/company population. The UI can load bounded searchable choices on demand; the initial page does not need a full manager population or its facets/count.

Master-data count uses the same complete source joins and predicates as export. It returns only COUNT; left joins are retained so even their existing row multiplicity cannot accidentally change the displayed number. Headcount uses GROUPING SETS over the same prior employment/company/assignment/department/position source. No Person join is added. NULL buckets coalesce before grouping, including a literal em dash in the same bucket; empty strings remain distinct. The AI workforce support function still reads its original source and counts distinct people independently. Equal-count dimension order, previously dependent on an unordered native scan, now has a deterministic name tie breaker.

## Carry-forward report

Full export and page share one canonical financial calculation helper, including tagged cap/expiry forfeits, historical type/template rules, anniversary earned-method gaps and existing date choices. The page first streams only authorized employment IDs/names in batches of 512, sorts with the existing JavaScript localeCompare, selects page IDs, then resolves ledger sums and entitlement templates only for those IDs. The original JS comparator is not approximated by a database collation. Equal names use employment-ID input order for both full export and pages; their previous native input order was unspecified.

Population membership is known before calculation: hired on/before December 31 and not terminated before January 1, plus the existing scope/company/department/q filters. At December 31 every valid hire month is on/before the as-of month; the canonical earnedCycleStart therefore starts in the selected year for calendar and anniversary cycles, including leap-day hires. Archived ANNUAL types remain historical sources; missing ANNUAL still yields an empty report.

The entitlement template resolver reads active type templates/rules independently of employee population size. Its criteria target narrowing and winner/ranking maps are per employment; selecting page IDs does not alter another employee's band or precedence. No alternative financial arithmetic is introduced.

Limitation: exact JS locale sorting still retains O(population) minimal identity facts. The expensive full financial DTO/resolver work and browser payload are page-bounded, but this is not a fully native bounded-memory sort. Native visibility and identity sorting costs remain visible in the component measurements. A later collation or cursor design must establish exact order semantics before changing this contract.

## Verification

Native tests cover temporal membership, correction tombstones, wildcard/email search, date-string DTOs, deep/out-of-range pages, explicit All truncation and complete exports, actual tenant/company RLS and revoked callers, selected-only identities, grouping buckets, a real exclusive Access writer overlap, read-only write refusal, no audit writes, and calendar/anniversary/leap/year population. The established carry-forward arithmetic suite additionally compares paged output with the independently asserted full report on each fixture.

The native scale fixture records actual runner resources, timings, row counts and transport bytes for 50,000 fictional employments, with complete-export baselines on the same runner. It is component-only evidence and cannot establish authenticated browser readiness, whole-system speed, a resource-valid worker recommendation or staging acceptance.


## Measured termination temporal join repair

The native component run 42369891494 on source 01d44 completed its 50,000-employment fixture and returned correct bounded results, but termination took 20.6 seconds. Follow-up actual-SQL probe 42371085046 passed both selected native checks and compiler. Its first termination statement took 14.3 seconds; EXPLAIN ANALYZE showed 499,990,000 rows removed by the assignment LEFT join (10,000 leavers times 50,000 assignment candidates), with 17.995 seconds plan execution and no JIT for that statement. Payload bounds alone did not fix this execution cost.

The shared termination source now uses Drizzle's public SQL/LATERAL join API to put the unchanged employment/date/supersession predicate inside an explicitly emitted OFFSET 0 subquery. It projects assignment ID and department ID and retains every matching assignment. No LIMIT 1 or other population cap is introduced: inclusive termination dates can legitimately match both adjacent versions, even though the native assignment exclusion constraint rejects overlap of their half-open ranges. Page and complete export use the same source.

The raw SQL fence is deliberate: installed Drizzle 0.45.2 omits `.offset(0)` because its dialect tests offset truthiness. A compiled-SQL contract therefore asserts actual LEFT JOIN LATERAL, the correlated employment predicate, the inclusive end predicate and literal OFFSET 0 with no inner LIMIT. Schema/alias objects supply identifiers and parameterization through the public SQL API; no SQL-to-number cast or private query-builder mutation is used.

The paired hosted fixture retains the original source only as a test baseline, compares original/repaired native DTOs and independent expected counts/names on the same runner, and captures actual plans under one current-principal RR/READ ONLY app backend. It checks original removed join rows and the repaired indexed employment probes. The two-version boundary, correction tombstone, absent/future assignment, department filters, empty/deep/company-negative pages and complete export remain explicit cases. Policies, helper functions, timeouts and financial logic are unchanged; the probe only tightens an otherwise longer/unlimited diagnostic timeout to 20 seconds. Qualification of this repair is pending its frozen hosted run. Other 3–5 second reads and global RLS planning remain separate unresolved performance work.
