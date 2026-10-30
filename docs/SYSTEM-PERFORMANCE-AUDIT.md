# System performance and capacity review

## Outcome and limits

**The 500-concurrent-user speed target is not met.** This is development evidence,
not release acceptance. [Draft PR 113](https://github.com/StradaverseHub/ai-hr/pull/113)
is held; this work has not deployed to staging or production.

The owner requested both one-second and five-second activity levels. All four
workloads on source `5249c199a98a0509638426383bc6f356f2a10f0a` reached 500 active
users and failed speed acceptance. Each used 1,500 page reads and approximately
1,500 real create/edit/delete requests. These are aggregate timed-phase p95
values, not successful steady-state capacity measurements:

| Workload / pause | Page read p95 | Mutation p95 | Completed users | Loaded browsers |
| --- | ---: | ---: | ---: | ---: |
| [Claims-heavy, 1 s](https://github.com/StradaverseHub/ai-hr/actions/runs/41056536098) | 83.0 s | 53.2 s | 500/500 | 2/6 |
| [Claims-heavy, 5 s](https://github.com/StradaverseHub/ai-hr/actions/runs/41056521892) | 86.4 s | 51.0 s | 500/500 | 0/6 |
| [27-route mix, 1 s](https://github.com/StradaverseHub/ai-hr/actions/runs/41056541678) | 51.4 s | 53.0 s | 500/500 | 6/6 |
| [27-route mix, 5 s](https://github.com/StradaverseHub/ai-hr/actions/runs/41056528025) | 46.9 s | 45.8 s | 498/500 | 6/6 |

The wider five-second run returned two HTTP 502 responses on Claims writes; 498
journeys completed. The other three completed all 500 data journeys. Both wider
runs covered all 27 selected routes. All four passed the nine authorization
boundaries, six-locale/browser baseline and actual post-load audit verification:
each tenant retained exactly one canonical initialization prefix, with no later
unchained events or invalid chain links. All had zero browser runtime errors.
Loaded browser timeouts and the latency checks remain failures where shown.

Broad regression source `08356ad57` passed 727 test cases. Its auxiliary ORM
factory typing errors were repaired; recovery passed 104 affected cases and the
whole compiler. The empty-profile-task change passed 48 affected cases and the
whole compiler. The exact audit fixture SQL, including negative cases, passed
six native cases and the whole compiler on `5249c199a`. These receipts retain
their original source identities in the table below; counts are not summed
because coverage overlaps.

The measured app CPU was 279.5 seconds over 277.9 wall seconds in the wider
one-second run, and 269.2 over 266.3 in the wider five-second run. This shows
roughly one app CPU core continuously occupied. Driver CPU was about 25 seconds
in each run. Database, TLS-proxy and Chromium CPU are separate and are not
included in those counters. PostgreSQL active-state samples are not CPU usage.

A subsequent development-only comparison (`8ec8eac23`) runs one versus two app
workers on the same four-CPU runner class. Both use a total of ten application
connections and 4 GiB of app heap. Application/service/schema/test source is
unchanged from `5249c199a`; only the harness and its workflow change. The proxy
uses fresh backend connections and records transport errors without automatic
write retries. Both comparisons complete all 500 data journeys with zero HTTP errors, all
27 routes, nine authorization boundaries and valid post-load audit chains.
The one-worker control measures 62.7 s read / 58.2 s write p95, with two of six
loaded browsers completing. The two-worker run measures 60.8 s / 52.0 s, with
three of six loaded browsers completing. Both fail speed/browser acceptance.
These are separate hosted runners; the difference is not a controlled speed ratio
and does not justify a production worker-count change.

The two earlier HTTP 502s do not recur in these 1,000 combined user journeys.
Recorded proxy errors in the new runs are exclusively aborted browser requests,
not failed virtual-user writes. The earlier stale-backend-socket hypothesis remains
an inference; the original failure is retained. No mutations were automatically retried.

One worker ends at 1,857 MiB RSS (2,013 MiB high-water mark). Two workers end at
2,850 MiB RSS combined; their individual high-water marks sum to 3,049 MiB. That
sum is not a measured simultaneous combined peak. Equal configured heap budgets
do not imply equal resident memory. The two-worker app processes consume 385.7
CPU seconds over 320.1 wall seconds, about 1.2 cores combined, versus 340.4 over
346.6 for the control. More processes alone do not resolve this shared-host workload.

The current candidate is based on merged main `2ab4f6c12`; main and alpha have
subsequently advanced. It requires fresh integration review before release.
Migrations 0726, 0736, 0745 and 0810 remain development reservations; competing
allocations, the complete journal prefix and installed ledger must be reconciled.
See [migration allocation](MIGRATION-ALLOCATION.md). Applied SQL was not rewritten.

## Workload and acceptance

- Standard GitHub-hosted runner (four CPUs, about 15.6 GiB RAM); one production
  Next.js process, PostgreSQL 16,
  HTTPS proxy, HTTP driver and six Chromium contexts share the runner. This is
  not a production hardware sizing certificate or 500 simultaneous browsers.
  V8 CPU sampling is enabled; an unprofiled controlled repeat is still required
  before claiming final production capacity.
- Actual native encrypted internal sessions for 500 fictional people: 460
  employees, 20 managers, 18 company HR and two group HR; two tenants and ten
  companies. Normal session validation, RLS, module gates and domain services run.
  Login enrollment, MFA enrollment and recovery throughput are not measured.
- One million pending claims, 90,000 attendance rows and 500 frozen payslips.
  Other worklists are not populated at million-row scale. Payroll calculation,
  publication, imports, exports, document generation and AI-provider throughput
  are not capacity-certified by this fixture.
- Ten-second arrival ramp, then 30 seconds of sustained activity; requests wait
  for responses. Think time applies after each of three page reads and after
  create and edit; delete is followed by the next journey without an extra pause.
  These are closed-loop full-document page requests and real server actions,
  not a claim of 500 requests per second or a measured warm SPA navigation mix.
- The wider mix rotates over 27 selected routes across employee, manager and HR
  areas. The harness rejects missing route coverage. Browser pilots also prove
  six locales, client-link navigation, translated form labels and persisted CRUD.
- Real captured multipart server-action order is retained. The driver verifies
  persisted create/edit/delete outcomes, rather than treating HTTP 200 as success.
  Nine anonymous/company/person/tenant boundary checks must pass before load.
- PostgreSQL durability remains on (`fsync`, `synchronous_commit`, full-page
  writes). The application process requests audit chaining. Earlier fixture metadata incorrectly
  claimed every seeded event was chained: importing the unit harness cleared that
  fixture process flag. The failed five-second precondition exposed this; earlier
  runs do not prove complete fixture-chain coverage. The repaired harness additionally
  asserts one canonical `access-configuration.initialized` prefix per tenant,
  requires every subsequent event to be chained and runs the canonical tenant-chain
  verifier after timed load. Verification is outside measured request latency.
- Current speed checks require nonempty steady samples, per-role read p95 below
  1,000 ms, write p95 below 500 ms, peak 500 active users, zero journey errors,
  complete loaded browsers and zero browser runtime errors. They were not relaxed.

## Implemented reductions

| Area | Change and preserved contract |
| --- | --- |
| Claims | SQL count and ordered page IDs before joins, bounded receipt metadata, mobile cursor, JIT removed only from the measured interactive read; full history and authorization remain available. |
| Approval shell | Canonical decision authority is batched in chunks of 1,000; shell claims preview is capped at 25 with a separate total. Full task readers retain their semantics. |
| Translation payload | Fixed route-segment providers ship required public namespaces; unknown dynamic consumers fall back to the full catalog. Six locales and actual leave-to-claims client navigation are checked. English Claims catalog falls from 1,561,561 bytes to 49,891; decoded pilot Claims HTML is about 212 KB instead of about 1.8 MB. |
| ORM | Application transactions no longer construct unused relational-query helpers for 319 schema tables. Explicit typed table queries remain; application, maintenance and bootstrap factories agree. |
| Workforce access | The sealed read-only scope projection takes a shared advisory lock on the existing key. Configuration writers retain exclusive locks; no read-to-write upgrade or permission-result cache was added. |
| Session and visibility SQL | Development migrations retain the canonical queries and cache PL/pgSQL execution plans per connection. Current principals, grants, termination and dates remain freshly evaluated; data/results are not cached. |
| Date display | Reuse immutable Kuala Lumpur date/time formatter objects; dates and formatted results remain fresh. Midnight, leap-day and year-boundary test cases cover behavior. |
| Payroll, attendance and reports | SQL paging/aggregates and narrowed source reads; totals remain global to authorized scope. Employee Master avoids an export for its count and explicitly bounds source rows. |
| Personnel | Authorized remote search returns eight matches, aborts stale requests and preserves current selection. No unbounded employment download for the picker. |
| Profile task metadata | An empty queue returns after its first native principal/policy read; it no longer opens a second locked policy transaction to authorize zero candidate IDs. Nonempty queues still refresh decision authority. |
| Lifecycle and cleanup | SQL-filtered actionable reads, lazy names, independent shell scheduling; four unused modules and roughly 540 dead lines removed. File size alone was not treated as a runtime bottleneck. |

Application pool default remains ten. Earlier controlled native-service experiment
[41015751657](https://github.com/StradaverseHub/ai-hr/actions/runs/41015751657)
asserted actual pool sizes and removed only closed fixture pools between phases:
paced read p95 was 3,053 ms with ten connections and 3,133 ms with twenty. That
source predates later optimizations; it did not justify increasing the default.

## Retained evidence

Each result belongs to its exact source/run. Unaffected passes are retained;
failed runs are not relabelled as successful after a repair. All recent builds,
tests and whole-repository compiler checks ran on standard hosted Actions.

| Run | Evidence and interpretation |
| --- | --- |
| [41047735790](https://github.com/StradaverseHub/ai-hr/actions/runs/41047735790) | `08356ad57`: one-second claims-heavy; 500/500 complete, 1,500 reads and 1,500 writes, six browsers complete, zero data/runtime errors; **speed FAIL**, 64.1 s/43.9 s read/write p95. |
| [41047747182](https://github.com/StradaverseHub/ai-hr/actions/runs/41047747182) | Same source, one-second wider mix: all 27 routes, 500/500 complete, 1,500 reads/writes; **speed/browser FAIL**, 72.4 s/65.4 s p95. |
| [41047756949](https://github.com/StradaverseHub/ai-hr/actions/runs/41047756949) | Same source: **727 test cases PASS**, 495 DB and 232 non-DB, zero skips. Whole-project compiler **FAIL** with 37 errors caused by two auxiliary ORM factories retaining the old relational schema type. Both factories repaired in `bfa624c0d`; recovery is recorded separately below. |
| [41060140746](https://github.com/StradaverseHub/ai-hr/actions/runs/41060140746), [41060146463](https://github.com/StradaverseHub/ai-hr/actions/runs/41060146463) | `8ec8eac23`: same-source five-second wider mix, one/two workers with equal total pool/heap budgets. Both complete 500/500 data journeys, 27 routes and actual audit verification. No HTTP 502s; speed and loaded browser acceptance FAIL. Detailed figures above. |
| [41056536098](https://github.com/StradaverseHub/ai-hr/actions/runs/41056536098), [41056521892](https://github.com/StradaverseHub/ai-hr/actions/runs/41056521892) | `5249c199a`: one-/five-second Claims-heavy runs complete 500/500 data journeys, actual audit verification PASS; latency FAIL and four/six loaded browser timeouts respectively. |
| [41056541678](https://github.com/StradaverseHub/ai-hr/actions/runs/41056541678), [41056528025](https://github.com/StradaverseHub/ai-hr/actions/runs/41056528025) | Same source: both wider mixes cover all 27 routes and complete six loaded browsers; one-second completes 500/500 data journeys, five-second 498/500 with two HTTP 502s. Actual audit verification PASS; latency FAIL in both. |
| [41055981483](https://github.com/StradaverseHub/ai-hr/actions/runs/41055981483) | `5249c199a`: six native audit test cases PASS, including the exact fixture SQL, canonical initialization prefix, extra-unprotected-event rejection and wrong-tenant rejection; whole-project compiler PASS. |
| [41055375797](https://github.com/StradaverseHub/ai-hr/actions/runs/41055375797) | `c2d775ab3`: six native audit test cases and whole-project compiler PASS; isolated the fixture's overly strict prefix assertion. |
| [41053423025](https://github.com/StradaverseHub/ai-hr/actions/runs/41053423025), [41053428767](https://github.com/StradaverseHub/ai-hr/actions/runs/41053428767), [41053434679](https://github.com/StradaverseHub/ai-hr/actions/runs/41053434679), [41053440323](https://github.com/StradaverseHub/ai-hr/actions/runs/41053440323) | `0452e61c0`: production builds PASS; all four runs stop at the fixture's all-events-chained assertion. Restoring the flag alone did not satisfy that assertion. No HTTP capacity result. |
| [41051720296](https://github.com/StradaverseHub/ai-hr/actions/runs/41051720296), [41051776196](https://github.com/StradaverseHub/ai-hr/actions/runs/41051776196) | `8f17f01ca`: production builds PASS; both five-second runs FAIL fixture audit-chain assertion before HTTP load. No capacity result. Explicit fixture opt-in repaired afterward. |
| [41052704338](https://github.com/StradaverseHub/ai-hr/actions/runs/41052704338) | `d410275ff`: all 48 profile metadata, photo and routing test cases PASS (39 DB, nine non-DB), zero skips; whole-project compiler PASS. |
| [41051827777](https://github.com/StradaverseHub/ai-hr/actions/runs/41051827777) | `8f17f01ca`: all 104 affected test cases PASS (92 DB, 12 non-DB), zero skips; separate whole-project compiler PASS. |
| [41046741731](https://github.com/StradaverseHub/ai-hr/actions/runs/41046741731) | `af8d76fa0`: native 500-user, 5,000-transaction ORM comparison. Full-schema-before p95 3,748.7 ms; lean 2,706.2; restored full schema 3,384.3. Zero context/role errors. Helper benchmark, not HTTP acceptance. |
| [41044578625](https://github.com/StradaverseHub/ai-hr/actions/runs/41044578625) | `c4fe191c9`: canonical Workforce scope, 500 native users; exclusive-before p95 6,083.7 ms, shared 2,474.1, exclusive-after 5,872.3. Zero authority errors. |
| [41044430904](https://github.com/StradaverseHub/ai-hr/actions/runs/41044430904) | `16dc`: 73 DB test cases PASS including overlapping readers and writer exclusion. Seven old shell mock failures retained; fixtures repaired in `07948f38d`. |
| [41045771750](https://github.com/StradaverseHub/ai-hr/actions/runs/41045771750) | `07948f38d`: affected shell checks and compiler PASS. Original test cases retained. |
| [41044045493](https://github.com/StradaverseHub/ai-hr/actions/runs/41044045493) | `aac43d9f6`: valid real action protocol, 222/500 journeys complete, 278 aborted; read/write p95 85.5 s/25.9 s, six browser timeouts. Original capacity FAIL. |
| [41044054072](https://github.com/StradaverseHub/ai-hr/actions/runs/41044054072) | Same source wider mix: 500/500 data journeys complete, but 68.7 s/63.3 s p95, browser timeouts and four missing concurrent routes. Sampler repaired later; this run is not complete route coverage. |
| [41044060062](https://github.com/StradaverseHub/ai-hr/actions/runs/41044060062) | `aac43d9f6`: two real multipart serialization test cases and compiler PASS. |
| [41042991046](https://github.com/StradaverseHub/ai-hr/actions/runs/41042991046) | `1157fdda5`: 589 test cases PASS (403 DB, 186 non-DB), whole compiler PASS. Million-claim history median 513.4 ms, maximum 561.8 ms over five measured reads; 25 rows/12,307 serialized bytes. This is not HTTP latency or a percentile estimate. |
| [41042136707](https://github.com/StradaverseHub/ai-hr/actions/runs/41042136707) | `8dfe24a75`: 500 native users/20 guard pairs: baseline p95 5,198.7 ms, candidate 3,709.8, restored 5,214.1; live archive/termination/forged-role checks retained. |
| [41041869992](https://github.com/StradaverseHub/ai-hr/actions/runs/41041869992) | `f6b5a9faf`: 83 browser entries, six locales and client navigation without runtime errors. HTTP preflight correctly failed due to multipart root argument being emitted before its referenced form. No 500-user capacity result. |
| [41041875352](https://github.com/StradaverseHub/ai-hr/actions/runs/41041875352) | Route provider recovery: 121 test cases PASS, one Attendance module-guard contract FAIL; corrected by using Attendance template rather than adding a layout. Compiler PASS; later 589 test cases cover recovery. |
| [41038620726](https://github.com/StradaverseHub/ai-hr/actions/runs/41038620726) | `b73671eff`: old HTTP write replays failed persistence; these timings are invalid as write-capacity evidence. Client navigation also exposed missing Claims messages. Both defects retained and repaired with real browser/protocol checks. |
| [41038847752](https://github.com/StradaverseHub/ai-hr/actions/runs/41038847752) | `ba4bb00cf`: preflight failure before 500 users; no capacity claim. |
| [41038629207](https://github.com/StradaverseHub/ai-hr/actions/runs/41038629207) | `b73671eff`: 400 test cases and whole compiler PASS; measured million-row history median 556.7 ms, maximum 568 ms. |
| [41036691608](https://github.com/StradaverseHub/ai-hr/actions/runs/41036691608) | Batched authority: 31 test cases and whole compiler PASS. |
| [41035010001](https://github.com/StradaverseHub/ai-hr/actions/runs/41035010001) | Public message projection: 34 test cases and whole compiler PASS. |
| [41023273405](https://github.com/StradaverseHub/ai-hr/actions/runs/41023273405), [41023694694](https://github.com/StradaverseHub/ai-hr/actions/runs/41023694694) | Earlier sources `019ba0274`/`1fe2a621d`: 185 and 203 test cases PASS; first run whole compiler PASS. Their scope is retained without relabelling onto later candidates. |
| [41019376795](https://github.com/StradaverseHub/ai-hr/actions/runs/41019376795), [41022122955](https://github.com/StradaverseHub/ai-hr/actions/runs/41022122955), [41022430730](https://github.com/StradaverseHub/ai-hr/actions/runs/41022430730) | Original HTTP manager timeout retained. Deduplication alone still produced 156 MB decoded group-HR pages; bounded source `7a535ba34` reduced that sample to 1.9 MB. Different runners; no controlled speed ratio claimed. |
| [41023627029](https://github.com/StradaverseHub/ai-hr/actions/runs/41023627029) | Earlier visibility repeat measured 733 ms reads/689–719 ms writes and exceeded its deadline during final baseline. Original failure retained. |
| [41026824898](https://github.com/StradaverseHub/ai-hr/actions/runs/41026824898) | `79a4eadea`: original valid 500-active-user stress failure; zero completed journeys, all 500 failed. Retained as failure, not a successful baseline. |
| [41022556721](https://github.com/StradaverseHub/ai-hr/actions/runs/41022556721), [41024687484](https://github.com/StradaverseHub/ai-hr/actions/runs/41024687484), [41026831338](https://github.com/StradaverseHub/ai-hr/actions/runs/41026831338) | Visibility plan experiments show improvement but substantial runner variance: some candidate measurements near 28 ms; later candidate measurements around 513–539 ms. Do not advertise a universal 28 ms result. |
| [41025823216](https://github.com/StradaverseHub/ai-hr/actions/runs/41025823216) | Strict skip verifier rejected diagnostic `runIf` suites. Diagnostic profiles were moved to explicit separate jobs; verifier was not weakened. |

The initial million-claim reader took roughly 5.2 seconds. Later isolated readings
are around half a second, but those five-read helper measurements cannot establish
500-user request performance. Historical local checks in earlier revisions also
retain their original scope; they are not whole-project compiler/release passes.

## Remaining bottlenecks and next acceptance

On `08356ad57`, all 44 unloaded HTTP pilots in the wider mix were below 900 ms
(the slowest was the employee home at 892 ms). Their loaded counterparts take
tens of seconds. This indicates capacity/queueing growth under contention; a
fast isolated page is not a concurrent capacity pass.

The production CPU profiles originally identified eager ORM construction for all
319 tables and repeated Intl formatter construction. Those frames disappear after
the fixes. Remaining sampled cost includes SQL construction, PostgreSQL result
allocation, native socket writes, compression and garbage collection. Database
profiles still show repeated current-principal/visibility evaluation and shell
profile/workforce projections. PostgreSQL samples include client waits as well as
CPU-ready work: another pool-size increase is not justified by these observations.
The completed frozen runs measure application and driver CPU separately from wall time.
The most expensive recorded SQL statements report zero JIT compilation time in
the retained one-/five-second profiles. Further JIT changes are not justified by
that evidence. Root-shell source still performs multiple authorized task/policy
reads on redirecting draft saves. Reducing repeated shell work and measuring warm
client navigation remain high-priority application work; they have not been implemented
or validated as completed fixes in this batch.

Next's installed server-action implementation removes the router state before
fetching a redirect target, rebuilding the root shell. The current test intentionally
measures full documents and real redirecting actions. A separately labelled warm
client-navigation workload is still needed; it must preserve principal, scoped-data
and persistence checks rather than substituting HTTP success alone.

Priorities remain:

1. Reduce repeated authorized shell reads and measure each change with paired
   native-service experiments plus the unchanged HTTP/browser acceptance checks.
2. Establish application CPU, database execution, pool wait and browser budgets on
   representative installation hardware. Do not infer required hardware solely
   from this shared development runner.
3. Exercise million-row histories beyond Claims, concentrated and distributed
   companies, deep paging, imports/exports and payroll calculation/publication
   alongside ordinary interactive reads and writes.
4. Add bounded queued/streamed generation for expensive reports and documents;
   measure restart recovery, memory and effect on interactive latency.
5. Reconcile migrations and fresh main/alpha before any release gate. A passing
   focused run, merged source or draft PR grants no deployment authority.

Fixtures, private keys and native session tokens stay outside public artifacts.
The HTTP evidence contains fictional screenshots, timings, normalized SQL, sampled
CPU frames and request outcomes. No private production data was used in load tests.
