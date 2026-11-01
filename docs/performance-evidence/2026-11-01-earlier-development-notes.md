# Earlier development notes — frozen historical snapshot

These notes preserve earlier source identities, failures and component receipts. Pending
statements describe that earlier snapshot. Read [the current audit](../SYSTEM-PERFORMANCE-AUDIT.md)
for current status; this archive grants no release or deployment authority.

# System performance and capacity review

## Outcome and limits

Owner direction,1 November2026: prioritize the fastest system with the least
practical resources. Use existing standard hosted runners and focused component
comparisons before expensive full-load repeats; do not provision paid or larger
infrastructure. The owner has no connection details for an isolated production-size
environment. Continue development qualification on the available small topology;
production-equivalent acceptance remains unavailable and is not inferred.

**The 500-concurrent-user speed target is not met.** This is development evidence,
not release acceptance. [Draft PR 113](https://github.com/StradaverseHub/ai-hr/pull/113)
is held; this work has not deployed to staging or production.

The latest completed500-user timed mixed-workflow source is
`396c5d36f5b0afa599f2a4f722788e6c3e372eda` (application/SQL unchanged from4b0a8bc56).
Both runs reached500 active HTTP principals against one million Claims and one
million attendance records. Both failed functional and speed acceptance on
standard4-CPU hosted runners:

| Activity pause | Successful-read p95 | Successful-write p95 | Completed / failed journeys | Complete loaded browsers |
| --- | ---: | ---: | ---: | ---: |
| [1s](https://github.com/StradaverseHub/ai-hr/actions/runs/41194141433) | 70.4s | 84.1s | 83 /417 | 0/6 |
| [5s](https://github.com/StradaverseHub/ai-hr/actions/runs/41194146086) | 66.5s | 86.2s | 52 /448 | 0/6 |

All failed journeys in these two runs aborted. Both passed all six expanded baseline
workflows, including50-person native Payroll close/employee publication. The new
past-month batch was unavailable before release, then its real employee statement
and PDF became available, while foreign-person/tenant requests still returned404.
Loaded Home cards timed out, and native post-load audits passed in both tenants.
Timed PostgreSQL CPU was1003.5s/378.3wall(1s) and985.9s/377.3wall(5s); app CPU
was286.0s and280.1s. The largest timed query remains Attendance task metadata.
Actual advisory waiters are classified as access-configuration keys in both tenants
(197exclusive/21shared connection-samples in1s,136exclusive/35shared in5s).
These are observations, not total wait durations. No audit-chain or employment-key
waiter was seen in that bounded sample. Reusable plans improve component costs but
do not by themselves resolve the whole-system workload. The newer standalone
metadata reader fix was absent from these frozen runs and is qualified separately.

The subsequent frozen workload source is `baef664fc` (application/SQL matches verified
metadata fix1be4d2d26); runs41296295314(1s)/41296304113(5s) failed before traffic, as detailed below. A separate
reversible experiment41296321846 passed, but the added three guard plans improved
only the unrelated employee materially (63.1→40.3ms); HR/delegate/manager medians
were not convincingly better. That bundle is not promoted. Follow-up experiment
41296762228 on source94353cade instead measures delaying subject metadata until
after the unchanged request decision proof; it passed exact task/refusal checks but has uneven performance (manager137.9→113.9ms,
employee88.7→91.8ms, HR86.1→86.3ms, delegate164.7→162.9ms versus its restored
baseline). It is not promoted. The subsequent principal/grant experiment41297191155 on sourcee52d9ae18
passed. Candidate/restored medians(ms): assigned HR75.1/87.0, delegate144.5/151.3,
manager124.7/130.1, employee75.8/87.6. These modest component gains preserve exact
ordered tasks and existing expiry/archive/person refusals, not500-user capacity.
Unapplied draft0877 copies the complete original principal query into a reusable
PL/pgSQL query plan; no result is cached. Frozen candidate7b93d22e4 undergoes
exact-file/whole-compiler41297609428 and12 affected identity/tenant/RLS files
41297616183. Exact-file41297609428 PASS: identical task results and owner/ACL/security attributes,
unknown user returns no row, actual grant changes appear immediately and stale
claimed HR grants refuse. The whole compiler PASS. All220 affected
cases in12 files41297616183 PASS, zero failures/skips.

The two metadata-source workloads41296295314/41296304113 failed before load at
clocking import; no500-user timing exists for that source. Native code refuses
clockings inside closed payroll. The1 November fixture's prior-month closed slips
overlap the recent-day import dates; the UI therefore never offers100 valid
records. The original failures are retained. A shared fixture calendar now puts
closed history before a90-day import window, including month/year/leap boundaries.
The real100-line native validation is checked for both tenant fixtures before
building, to fail cheaply on dates/mapping/permissions. A workflow-only diagnostic
uses100k Claims/90k Attendance instead of2m records, with the same500 identities,
50-person Payroll batches and all workflow assertions. Full-load fixtures retain
one million Claims plus requested Attendance volume. All61 focused calendar/native clocking cases41298348436 PASS on sourcee53d2298f.
The first smaller preflight41298355480 was canceled deliberately after source
review caught a positional validator call instead of its canonical input object;
that original canceled run is retained. Corrected sourcee27e97cbc runs single
preflight41298406747, whose process-completion failure and focused recovery are retained below.
That preflight's application and SQL source were unchanged from verified7b93d22e4.

Preflight41298406747 FAILS process completion: all six native/browser workflows,
PDF/foreign boundaries and both native audits completed, withpreflightPassed:true,
zero Home failures and zero browser runtime errors, but the child remained alive
until its600s timeout. Native import admission passed100/100 lines and50 people
for both tenants. Reduced fixture took46.9s (versus prior432.2s full-load fixture;
different datasets/hosts, not a controlled speed ratio). Build392.2s; original
run is not relabelled PASS. Native audit import opened an additional application
pool not closed by the driver. Focused real-child regression41300123720 initially
FAILS2/2 due to TS module export interop; repaired shared loader/cleanup on source
00b93196a passes2/2 in41300411156: the observer-only control remains alive, and
closing both actual restricted-role pools exits normally. No application build
was needed for that focused recovery.

A separate necessary-only Attendance experiment41300133755 on source6d2d95466
passes: no-assignment employee median45.0→1.4ms versus its restored original,
with exact tasks/refusals and real named non-admin/delegated actors preserved.
Positive paths still invoke the complete original reader with fresh authority.
Original scale41300741520 failed on benchmark JSON-array serialization, then
41301231393 and41301899447 failed because the generic EXISTS/LIMIT plan still
chose a full scan after adding an index. Those failures are retained. The corrected
materialized candidate access path41302458111 on source514b77485 PASS:2/2 native
and scale cases, zero failures/skips. On1,000,002 synthetic workflow documents,
three real prepared reads per present/absent/foreign-only case took0.176–0.542ms,
versus7.19–7.30s full scans before/after. The indexed EXPLAIN ANALYZE uses the GIN
index even under disposable forced generic plans. Heap215,580,672bytes;
index99,074,048bytes; index build+ANALYZE21.23s. This is query-access evidence,
not a native million-request creation or HTTP throughput certificate.

Current application candidate `16e662e6b15e0d072cdbe02a313b449a1e67d0f8` normally
merges main/alpha1a74336e68abf0c06067b19857ad68c8aeb93049. All639 canonical journal
entries and SQL bytes are preserved. Eight never-installed performance drafts
move byte-identically to0879–0886 above observed competing reservations; new0887
adds the exact UUID-native actor-key parser, three expression indexes, statistics,
and a necessary-only precheck in the existing Attendance task transaction after
real principal validation. Historical lines/assignments deliberately fall through;
positive paths retain complete original request RLS and current decision guards.
No permission/result caching, command changes or production settings are added.
Native assigned non-admin/delegate/ordered-refusal behavior and a reversible
scan-required control are tested through the real application entry point.
Qualification41303017578:208 cases in16 affected files PASS (204DB-classified,4model),
zero failures/skips; the independent whole compiler PASS. The real scan-required
control fails without the gate, then the same native employee call avoids correction
SELECT while HR retains the complete reader. Exact application paired comparison
and million-document index profile41303020809 PASS:2/2 cases, zero failures/skips.
Native employee median76.59ms before /1.80ms candidate /78.35ms restored; named
HR82.05/82.18ms, delegate148.74/149.37ms and manager123.18/122.62ms candidate/
restored. Every phase preserves ordered results and expiry/archive/person refusals.
Exact native parser indexed lookups over1,000,002 synthetic documents take0.185–
0.691ms. Both full500-user workloads now run on frozen16e662e6b:41304047446(1s),
41304050133(5s),5min steady activity,1mClaims+1mAttendance, one app worker, total
pool10/heap4GiB and the existing PostgreSQL2GiB cap. No later capacity pass exists.
A benchmark-only positive-path batching experiment41303932550 uses source
6fb2e0f2be64f2d86488bd0f28054952f660c030; application/SQL bytes match16e662e6b.
Incorrect-SHA diagnostic41303908353 was canceled while queued before checks;
its original cancellation is retained. No app batching optimization is promoted. Its native experiment41303932550
FAILS on benchmark-only SQL assembly (`NULLas`,42601) before batch timing; the
independent compiler is allowed to finish. A whitespace/parenthesis-only recovery
reruns just the affected benchmark, retaining the original failure and compiler
evidence. Frozen500-user application16e662e6b is unaffected.
The canonical payroll-tax-reader session flag and both Personnel integration imports
are preserved. Current source fingerprints regenerate without editing human approval
literals; exact-source approval remains held before any later integration/release.
No later speed pass is claimed. These new fixtures derive their business dates from
the native date owner; the current-month boundary differs from31 October tests,
so cross-run performance changes must not be treated as controlled causal ratios.

The preceding expanded source1a0ed296a also failed:1s0/500 journeys, read p9569.6s,
no completed writes;5s226/500 journeys, read38.2s/write88.5s. It had narrower
publication coverage; neither difference establishes a causal speed ratio.

Those preceding1a0ed296a runs passed the then-expanded preflights: Leave create/edit/withdraw, Personnel
draft create/edit/delete, Attendance correction/approval/applied punches, native
50-person Payroll calculation/scoped CSV and100-line clocking import. Actual own
payslip browser downloads passed, with no unsolicited PDF requests, parsed one-page
PDFs and native404 refusals for another person and another tenant. Post-load native
audit verification passed for both tenants in both runs. Home cards timed out under
load; baseline cards passed. Successful-response latency excludes aborted requests:
all500 one-second journeys aborted; the five-second failures include265 aborts,
five Personnel deletion state mismatches and four business refusals whose causes
remain unresolved. These failures are retained, not retried or suppressed.

On that preceding1a0ed296a source, PostgreSQL consumed983.4 CPU seconds over355.5 wall seconds in the one-second run,
and1084.1 over399.2 in the five-second run. Application CPU was252.7 and258.6 seconds
respectively. Host counters overlap these components; they must not be summed.
Timed SQL identifies Attendance approval metadata as the largest recorded query
cost, alongside repeated visibility/routing proofs and advisory lock waits. Nested
execution times include waits and overlap; they are not independent CPU costs.
A reversible native routing experiment passed on source2f6523765 (run41191380816):
32 actual requests/35 linked principals, exact ordered results, audit on, expired
delegation/archived assigned actor/forged person refusals. Combined plan reuse and
necessary denial gates reduce warmed manager median323.4→177.1ms and employee
199.1→113.3ms; assigned HR122.8→111.8ms and delegate208.4→188.6ms. The additional native comparison41191787745 on sourceabbd32ce4 passed: warmed
manager160.8→65.0ms, employee103.8→41.6ms, assigned HR61.4→37.4ms and
delegate97.4→77.6ms, always against its own restored baseline. Separate runners
show materially different absolute timings; only within-run comparisons are used.
The first benchmark candidate's whole compiler also passed.

Candidate `4b0a8bc56a521d9d471da2dd109c91bcbf4d1b6c` now drafts0871–0872:
five unchanged live query bodies use reusable plans and named actor validation
returns early only when a necessary identity/recipient condition cannot hold.
No authorization result is cached. All636 canonical journal entries/SQL bytes
remain unchanged; the candidate appends seven unapplied performance reservations.
Exact-file qualification and the whole compiler41192498275 PASS. All14 affected
files41192504628 PASS:278 cases (268DB-classified/10model), zero failures/skips.
The complete pre-existing canonical migration prefix remains unchanged.

Expanded HTTP/browser runs41192576077(1s)/41192579997(5s) both FAIL before load.
Build/migration/two-million-record fixture checks passed, as did Leave, Personnel,
Attendance and50-person Payroll processing/export preflights. The added past-month
publication check verified native close, release/event identity and the employee's
rendered statement, but its PDF GET then hit an HTML-only principal-marker assertion
in the shared driver. Neither run reached500-user traffic; neither supplies latency
evidence. Their exact original failures remain retained. The driver repair checks
the exact personal-PDF route's binary header, MIME, private/no-store and attachment
headers; HTML identity checks and native foreign-person/tenant refusals remain.
Only affected HTTP/browser evidence reruns on harness-only source
`396c5d36f5b0afa599f2a4f722788e6c3e372eda`:41194141433(1s)/41194146086(5s),
both completed and failed after reaching500 users; see the current outcome table. Its application/SQL code is byte-identical to4b0a8bc56.
Native/compiler receipts retain source4b0a8bc56 and are not relabelled.

Measured Claims queue improvements and129 affected passing cases remain component
evidence; they do not establish500-user capacity. Read-only infrastructure checks
found production's two16-CPU/~64GiB VMs, whereas configured staging is2 CPUs/~4GiB.
The owner selected an existing isolated matching environment; its connection
alias/config path remains required. No live load ran and nothing was deployed.
See [resumed verification](#resumed-verification--31-october-2026) for exact-source
receipts and remaining module gaps. The wider workload includes additional Home
API reads and mutation owners, so comparison with older workloads is not causal.

The older completed 30-route workload (`645a2ac90`) retains **one million Claims
and one million attendance rows**. All500 data journeys, allsix loaded browser
journeys and native audit checks complete at both activity levels, but speed
acceptance fails:

| Activity pause | Read p95 | Mutation p95 | Complete data journeys | Complete loaded browsers |
| --- | ---: | ---: | ---: | ---: |
| [1s](https://github.com/StradaverseHub/ai-hr/actions/runs/41115991569) | 54.4s | 58.3s | 500/500 | 6/6 |
| [5s](https://github.com/StradaverseHub/ai-hr/actions/runs/41115973494) | 50.8s | 54.4s | 500/500 | 6/6 |

Both builds, migration runs and fixture assertions pass. Each verifies500 current-day
attendance rows, no attendance before hire, all30 selected concurrent routes, nine
authorization boundaries, no browser runtime errors and valid post-load native audit
chains with only the known initialization prefix. Earlier browser timeouts remain
failures in their original runs. These separate hosted runners do not establish a causal scaling ratio.
An additional measured Home-role query fix is now an unapplied development migration.
Its 188 affected application cases pass, and an exact-file populated-database
comparison passes. Its HTTP/browser qualification fails speed despite allsix
browser journeys completing in each run.

Actual CPU counters over the timed phase distinguish database and application work:
one-second app320.96s / PostgreSQL622.92s over309.14wall seconds; five-second
app323.42s / PostgreSQL632.27s over313.02wall seconds. Database throttling and host
steal are zero. Host user/system counters include these components and Chromium,
so they must not be added to component CPU. No production sizing claim follows.

Six principals across roles/tenants each have create, edit and delete visibility
observed every100ms through an independent committed-state reader. All18 per run
become visible: one-second by11.6–22.5s; five-second by12.9–20.7s. Their HTTP
responses still finish tens of seconds after these observations. These are
upper bounds on when committed data became visible, not exact transaction timings
or a causal attribution of the response tail. The frozen thresholds remain unmet.

Earlier comparable development checkpoints are retained below with their original
sources and narrower data volumes.

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

The earlier measured candidate was based on merged main `2ab4f6c12`. The resumed
development candidate merges main/alpha `b0907303c`; its new integration checks
are separate from the results above. The complete 583-entry canonical source
journal is preserved, followed by the four unchanged performance SQL drafts renamed
0812–0815 at sequences1793330000212–215. They remain development reservations;
the installed ledger and final allocation must be verified before release.
See [migration allocation](MIGRATION-ALLOCATION.md). Applied SQL was not rewritten.
