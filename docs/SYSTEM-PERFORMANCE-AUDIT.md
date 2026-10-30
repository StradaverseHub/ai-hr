# System performance and capacity review

The system has verified growth risks. Returning a short browser table does not always mean that the database read, calculation or response is bounded. The changes in this candidate reduce unnecessary reads and payloads; they do not certify every module for millions of records or simultaneous users.

The source baseline is `c4fad43c1d67d69125a3f37e7549a5a8a7053362`, fetched from matching main and alpha refs on 30 October 2026. The repository inventory covered 6,945 JavaScript and TypeScript files and 417 page routes. Static scans identify candidates; the workflow traces and tests below establish the narrower implementation findings. This is not a line-by-line correctness review of every file.

## Changes in this candidate

| Area | Previous work | Result |
| --- | --- | --- |
| Shared page shell | Independent notification and lifecycle reads waited sequentially | Small parallel batches; dispatch still precedes notification reads and approval fan-out remains separate |
| Personnel employee record | Twelve independent supporting reads waited individually | Three batches of four, retaining the session and each person, employment and company boundary |
| Personnel New Event | Current company options were fetched again | Reuses the exact current-company lists already loaded; other companies still use their own resolvers |
| Claims history | All claims and attachment metadata loaded before browser pagination; rejection facts fetched for all historical rejections | History uses SQL limit and offset with stable time/id ordering; facts are fetched for displayed rejections; drafts use a separate read |
| Mobile claim lists | All claims loaded before status filtering, counts and cursor slicing | Status aggregates and cursor continuation run in SQL; only the bounded page receives receipt metadata |
| Payroll batch detail | Every payslip statutory snapshot loaded before slicing | SQL pages fetch only displayed snapshots; count and minimal off-page recalculation identities preserve totals and warnings |
| Lifecycle shell | All cases and notes loaded; directory resolved even without relevant mentions | Actionable case predicates, unresolved actor mentions, SQL recent-joiner counter and lazy name lookup |
| Employee master export | Each employment repeatedly scanned shared source arrays | Projection-local grouped rows and descriptor/name maps; fresh slices preserve local sorting |
| Personnel list switcher | Whole authorized directory shipped on every page opening | Debounced remote search returns at most eight authorized matches; abort/stale-result handling and explicit errors |
| Mobile claim detail | Loaded every claim to locate one id | Narrows by employment and claim id in SQL |
| Analytics | Generated the full employee master export solely to obtain its length | SQL aggregate with the same joins and shared filter predicate |
| Payroll list | Loaded all historical batches and their totals for two counters | SQL aggregates over the same effective-history source and visibility predicate; selected-year behaviour stays intact |
| Individual Attendance | Loaded punch details for the entire selected date range | Loads only the displayed attendance ids through the existing page-scoped owner |
| Unused code | Four modules had no import, export, source-string or symbol consumers | Removed 540 lines from three retired controls and the unused benefit-scheme label module |

The retired controls are `components/add-company.tsx`, `components/period-switcher.tsx` and `components/schedule-group-week-editor.tsx`. The label module is `lib/benefit-scheme-label.ts`. No active route was removed. Other apparent orphans were retained: tests read some files directly, the evidence extractor is launched as a process, and compatibility facades need contract review. Identical route layout guards are framework entry points using an existing shared helper; deleting them would remove route coverage.

## Measured behaviour

### Shared layout scheduling

A test invokes the actual root layout with deferred read owners. The original layout fails its concurrency assertions. With each mocked I/O operation taking 20 ms, the affected lifecycle and bell groups take 180 ms before the change and 40 ms afterward. These are deterministic scheduling measurements, not live page-load timings.

The Personnel support test verifies twelve reads in three 20 ms windows, with at most four supporting reads active. The original twelve sequential waits would require twelve windows. Existing database service guards remain responsible for data access.

### Claims history growth

The opt-in database benchmark creates synthetic claims in a disposable migrated namespace and calls the actual service as the application role. It uses one employment to stress the worst case of a single very large history. Five serial reads per size measure the first page and its exact total. Times include service work; response sizes are JSON before HTTP compression. They exclude a browser, network latency and competing users.

| Claims in fixture | Returned history rows | Response bytes | Median service time | Slowest of five |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 25 | 12,305 | 18.7 ms | 21.3 ms |
| 100,000 | 25 | 12,306 | 108.9 ms | 115.1 ms |
| 1,000,000 | 25 | 12,307 | 2,975.1 ms | 3,245.8 ms |

At 10,000 claims, the legacy full-list read returned 10,000 rows and 4,859,999 JSON bytes in 83.7 ms. The bounded result is about 395 times smaller. This comparison does not measure peak memory and is not a percentile estimate from production traffic.

A second run under application permissions separated the million-row plans: the count took 1,596 ms and a representative ordered id-page lookup took 1,322 ms. That run measured a 3,206 ms median for the complete service. The million-row result is a failed latency objective despite successful functional assertions and bounded output. Exact totals, sorting and policy-filtered joins need further work. Offset pagination also becomes more expensive on deep pages. A million records distributed across many employments is a different workload and needs its own measurement.

Reproduce the opt-in fixture through complete-set local resource admission, with valid local test URLs in private configuration:

```sh
python3 scripts/local-resource-lock.py --test-slots 2 --database performance-scale -- \
  env TEST_DB_NAMESPACE=perf_scale VITEST_MAX_WORKERS=1 AIHR_SCALE_CLAIMS=true \
  AIHR_SCALE_REPORT=/private/tmp/aihr-claims-scale.json \
  pnpm exec vitest run --project node --maxWorkers 1 \
  test/claims-history-pagination.test.ts -t 'grows to one million'
```

The namespace must be unique, within the test helper's length limit, and disposable. The fixture deletes its own template and worker databases at teardown. Do not use installation database credentials.

## Review across the system

| Area | Verified source finding | Remaining capacity concern |
| --- | --- | --- |
| Navigation and notifications | Shared root composes approvals, lifecycle, notifications and assistant access; database pool defaults to ten connections | Per-page query count, opportunistic notification dispatch and repeated access reads can dominate; measure pool waits under concurrency |
| Personnel and organization | Record renders ten panels; current list has SQL pagination and a bounded picker service exists | Record still prepares hidden panels and some pickers preload the workforce; move large pickers to authorized search without losing unsaved form state |
| Leave and approvals | Canonical leave reads already support SQL paging and keyset continuation; inbox fans out across owners | Full actionable queues and per-request breakdown reads grow with backlog; batch metadata and derive badges without loading private decision workspaces |
| Attendance and roster | Daily attendance pages in SQL; individual punch details are now page-scoped | Individual/range and summary views still derive complete selected ranges before slicing; bound date windows and page the authorized subject set before expensive derivation |
| Payroll and statutory | All-time counters now aggregate in SQL; selected year remains filtered in SQL | Batch detail loads all payslips before pagination; preflight and payroll generation require size-dependent capacity tests and resumable work rather than optimistic UI-only changes |
| Claims and loans | Web history is SQL-paged; one-record mobile lookups are bounded | Exact counts remain expensive at the extreme; draft lists and mobile claims list still load complete sets; move mobile listing to SQL cursor pages with status aggregates |
| Performance and Rewards | Module services include bounded task projections and batched home reads | Review/calibration cohorts and reward evaluation perform per-subject work; load-test large cycles and batches while preserving releases, self-exclusion and frozen outcomes |
| Lifecycle | `onboardingTasks` reads all visible cases and notes; navigation independently reads case data | A shell-level task read grows with accumulated onboarding history; add purpose-specific, SQL-filtered actionable projections and summary counts |
| Reports and analytics | Master count no longer builds an export; Employee Master explicitly caps 2,000 subjects and 50,000 records per source read | Export projection still calls some domain readers per employment and per leave type; large reports need queued, streamed generation with fresh scoped admission |
| Imports and bulk changes | Bank import uses a durable worker, 100-row apply batches and explicit 250,000-row/128 MiB bounds | Initial source decoding holds a complete file; other imports have their own limits and transaction patterns; measure peak memory, restart recovery and writer contention independently |
| Assistant and Control Tower | Domain readers and prepared action boundaries exist; browser action panels contain timeouts and uncertain-outcome handling | Provider latency, concurrent tool reads and serialized proposal steps require separate budgets; preserve deterministic service authorization and idempotent commands |
| Documents, letters and exports | Spreadsheet browser entry points lazily import the parser; PDF and workbook generation have specialized owners | CPU-heavy rendering competes with interactive requests in the application process; measure worker isolation, bounded queues and file-store throughput |
| Identity, access and shared database | `withTenant` installs caller context in one statement and preserves RLS; source contains roughly 435 schema index declarations | Query plans must be measured under real role and company scopes; owner-role timings cannot establish user performance; no global private-data cache should be introduced |
| Browser payload and refreshes | English message catalogue is 1,793,684 source bytes and root uses an unrestricted internationalization provider; 44 root-layout invalidation call sites were found | Measure compressed RSC/JavaScript and hydration; narrow message delivery by actual client namespaces; verify whether explicit refreshes duplicate server-action refresh work before changing freshness |

There were 17 page files with actual `paginateRows(...)` calls at baseline; claims history removes one. The remaining 16 include high-growth payroll and attendance paths as well as small configuration catalogues. They are not equally urgent. Counts of `await` expressions or nearby loop awaits are investigation aids, not proof of unnecessary sequential work. Financial writes, audit append order, lock acquisition and dependent reads must retain their order.

## Prioritized remaining work

Scores use `(impact + risk) × (6 − effort)`, with each input from 1 to 5. Effort is relative, not a delivery promise.

| Priority | Work | Impact | Risk | Effort | Score | Acceptance condition |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| P1 | Separate claims exact-count and ordered-page costs; validate candidate ordering indexes and cursor navigation | 5 | 4 | 2 | 36 | Application-role plans and latency stay within the chosen interactive budget at 10k, 100k and 1m histories, including deep pages |
| P1 | Replace shell lifecycle scans with actionable projections and counters | 5 | 4 | 3 | 27 | Completed history growth does not increase rows loaded for a viewer's current shell; task parity and scope tests pass |
| P1 | Page payroll batch payslips and attendance derivation in the database | 5 | 5 | 3 | 30 | Fixed page size bounds fetched and derived records; totals remain correct; payroll and attendance financial gates pass |
| P1 | Use authorized remote employee search in large pickers | 5 | 4 | 3 | 27 | Maximum 100 results, cursor continuation, current-value retention and grant revocation coverage |
| P1 | Establish request, query and pool-wait measurements under concurrency | 5 | 4 | 3 | 27 | Per-role p50/p95/p99, errors, memory and lock waits at agreed user counts, without logging HR values or tokens |
| P2 | Queue and stream expensive exports and long imports | 5 | 4 | 4 | 18 | Bounded memory, progress, cancellation, retries and permission revalidation; concurrent simple reads and writes remain responsive |
| P2 | Reduce browser translation payload and verify mutation refresh duplication | 4 | 3 | 3 | 21 | Smaller measured RSC/JS payload and hydration work; all languages and post-write freshness pass |
| P2 | Deepen oversized modules along domain boundaries | 3 | 4 | 4 | 14 | Smaller interfaces and one owner per business fact, with unchanged behaviour and shrinking boundary-debt allowlists |

`core/leave.ts` and `core/payroll.ts` each exceed 12,000 lines at baseline; attendance exceeds 7,000. This makes changes harder to reason about, but file length itself does not establish a runtime bottleneck. Refactor cohesive readers and writers after profiling, instead of splitting files solely to reduce line counts.

## Capacity acceptance before a scale claim

Test at 10,000, 100,000 and 1,000,000 relevant records using both concentrated and distributed tenant/company histories. Include employee, manager, company HR and group HR scopes. Exercise cold and warm page opening, search, deep paging, create, edit and delete, with simultaneous exports, imports and payroll work.

Candidate budgets for agreement are p95 under one second for ordinary authenticated page data and under 500 ms for a simple record mutation, excluding file transfer and long-running calculation jobs. A tab already loaded in the browser should respond within 100 ms. These are proposed acceptance targets, not established results. The owner confirmed a target of **500 concurrent users** on 30 October 2026. Distinguish 500 signed-in active users with realistic think time from a simultaneous 500-request burst; measure both before setting server/database capacity.

Capture server duration, database execution and planning, rows scanned/returned, response bytes, browser interaction/hydration, pool waits, lock waits, CPU, memory and failure rate. Verify authorization, audit history, idempotency and transaction outcomes under the same load. Add indexes only against measured plans and real tenant distributions, then coordinate migrations through the current allocation and deployed-watermark policy.

A Git-discovered private SSH configuration now permits read-only staging diagnostics. The observed installation reported an incomplete prior deployment and a stale build; this candidate has not changed that other-owner state. Live request measurements and rendered acceptance remain outstanding. The exported 569-row ledger matches current source hashes except three historical differences: two match historical Git bytes; the0240 hash remains unresolved. No applied SQL was changed. The0726 index reservation is development-only until the complete ledger and competing allocations are reconciled. No installation or production change is part of this candidate. Focused test passes do not replace the repository's impact-selected release gate, build, migration policy or staging acceptance.

## Earlier development verification (before hosted continuation)

- Nine focused shell, Personnel, attendance display and pack-boundary suites pass: 109 tests.
- Four focused database suites pass: 40 tests covering claim pagination, analytics parity, mobile claims and claim forms.
- Five additional workflow/database suites pass: 86 tests covering rendered Personnel module gating, payroll timelines, daily attendance, punch reads and claim drafts.
- The scale fixture and payroll list suite pass together: 10 tests. The separate measured scale runs also pass their functional assertions and clean up their private databases. Passing these assertions does not override the three-second latency finding.
- Changed-file lint reports 15 errors and 14 warnings. Running the same checks against the baseline reproduces exactly those counts; there are no new diagnostics. Existing examples include render-local analytics components and a pure payroll helper named like a React hook.
- The default full TypeScript check exhausted its 4 GB heap. The 8 GB rerun was stopped after more than twelve minutes without a result. It is not a full-repository type-check pass. The complete application project passes `tsc --project tsconfig.build.json --noEmit --incremental false` with a 6 GB heap; test and CLI typing remain outside that successful check.
- The production build, complete impact-selected release gate, browser journeys on the candidate and installation acceptance remain outstanding. The staging SSH alias is unavailable here.

## Hosted continuation and capacity evidence

Development source includes freshly fetched main/alpha7098cde19 through a normal merge.
All new application tests, whole compiler checks and production builds run on standard
GitHub-hosted runners, following the updated repository policy. Earlier local evidence
above retains its original scope; it is not relabelled onto the later candidate.

The first hosted million-row claims probe failed its under1000ms median budget at
approximately5218ms despite bounded response rows. Its retained permission-scoped
plans showed full-history sorting plus nearly a million repeated person/type index
lookups. Disabling JIT alone did not fix this. The successor replaces count joins with
semi-joins and adds an employment/time/id ordering index. The first index migration
failed the fresh baseline because its partial predicate referenced an enum value added
in the same transaction. The unpublished index was corrected to cover all statuses;
existing migration bytes and grants remain unchanged. Retain these failures as evidence.

The500-session probe uses500 distinct real fictional employee principals and one
million claims distributed across500 employments. Every concurrent journey reads a
history page, creates/edits/deletes its own draft and verifies the persisted outcomes.
It records per-operation p50/p95/p99, maximum latency and errors through the normal
ten-connection application pool. This is a service burst probe, not an HTTP/browser
capacity certificate or a measurement of pool wait in isolation. Functional completion
does not establish the proposed latency budgets. Multi-role/multi-tenant HTTP workloads,
deep paging, imports/exports/payroll contention and target-host resource measurements
remain required before a whole-system500-user or millions-of-records readiness claim.
