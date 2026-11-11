# Analytics dashboard composition in one presentation snapshot

Status: source implemented; hosted behavior qualification pending.

## Context and ownership

The candidate is an isolated child of `c5e36cb03095527ba1fb6a0e8fc2bf54080f2c46`. Fresh canonical `main` and `alpha` were `9dd3847b4a3ce9e4cf4df744edcf10b250dcbbb8`; the intervening canonical commits do not touch these Analytics owners. Canonical integration belongs to the root candidate owner.

The Analytics page previously started twelve independent report transactions together, then opened a thirteenth for the master-data count. Those reports could consume different committed states and compete for thirteen pool admissions per page. Four metadata reads are separate: company/department/cost-centre choices and the selected manager. The existing `withAnalyticsPresentation` already owns calling-principal admission in a database-enforced REPEATABLE READ / READ ONLY transaction.

## Decision

The page calls `analyticsDashboard` for its thirteen reports. This is adoption of the existing presentation read architecture. It captures session claims, company scope, filters, dates, year and four independently validated page queries before asynchronous admission. It uses the existing principal proof and one actual transaction, then awaits each private Tx report reader in page order. A failed report propagates its original error before another report starts. No parallel borrowed reader can outlive the transaction.

The extracted bodies preserve all existing joins, filters, effective-date choices, counters, complete counts, pagination, locale order, age bucketing and leave arithmetic. Each report retains its existing filter set; composition does not expand department/query/manager filters onto reports that previously accepted only company filtering. Standalone APIs retain their existing transaction owners; exports remain complete. The nationality reader retains its administrator gate inside the Tx helper as well as its original standalone boundary. Metadata remains outside this slice. This does not convert any AI/effect admission or command transaction to a presentation purpose.

| Report readers reviewed | Guards and effects retained |
| --- | --- |
| Headcount, turnover, demographics, nationality, movement | Original native RLS and scope predicates; nationality is administrator-only. Native selects and pure tally/ratio/date logic. |
| New hires, terminations, job changes, master-data count | Original page validation, temporal assignment joins, query matching, exact count and ordered page projection. Native selects only. |
| Leave utilisation, balances and sick trend | Original complete ledger history, signed arithmetic, configured-type selection and company scope. Native selects only. |
| Carry-forward page | Original bounded selected-row calculation after complete identity ordering; read-only cursor declaration/fetch/close. Canonical template/eligibility/criteria readers use the same supplied Tx and native selects; no grant, sweep, audit, command lock or effect is invoked. |

No new cache, pool, timeout, broad shared lock, migration or loading framework is introduced. Demographic/nationality population transport and the carry-forward identity sort remain unchanged and may still be large. Serial composition reduces simultaneous transaction demand and gives coherent snapshots; its latency under actual concurrent module navigation remains unmeasured.

## Qualification

External AST source comparison checks all thirteen original report bodies and the demographic row query, allowing only the explicit Tx row-reader invocation and the required nationality boundary guard. Twenty-five other original functions, including the presentation admission, report/export sources, carry calculation and shared filters, remain AST-identical. This is source evidence, not runtime evidence.

Seven prepared native cases compare all thirteen composed results and exact data-query/row census with the standalone owners; assert independently known headcount, hire/termination/change cohorts, turnover and signed/carry leave facts; observe thirteen original transaction admissions versus one actual `ai_hr_app` RR/RO carrier and five original principal queries versus one; commit a data change between reports to prove one snapshot; mutate caller inputs while admission is asynchronous; preserve real RLS/foreign/nonadmin/current-principal refusal; complete behind an open Access writer; prove no audit writes and a real PostgreSQL read-only write refusal; and settle the original report error with no later reader or active sibling. The existing bounded page DOM test retains every previous table/count/filter/pager/export assertion and additionally checks one composed call with all four page selections.

Run the new native composition file and existing Analytics bounded-report, dashboard, native-scale and DOM regressions on standard GitHub-hosted Actions after full source review. Whole compiler, browser navigation, load, zero-blocking, staging acceptance and production authority remain separate. No local repository tests, imports, database, generators, compiler or build are used. No passing behavior, speed improvement, all-module acceptance or deployment is claimed by this document.
