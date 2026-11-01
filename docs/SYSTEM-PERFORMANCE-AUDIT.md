# System performance and capacity review

## Outcome and limits

**The500-user speed target is not met:0/2 activity levels accepted.** Prioritize the
fastest system with the least practical resources. Use standard hosted runners;
no paid capacity, protected integration, live configuration/data change or deployment.
[Draft PR113](https://github.com/StradaverseHub/ai-hr/pull/113) remains held.
The owner has no connection details for an isolated production-size environment;
these small-host development results are not production-equivalent acceptance.

The newest full HTTP/browser attempts ran source
`16e662e6b15e0d072cdbe02a313b449a1e67d0f8`, including the earlier metadata-reader
shared locks and unassigned-employee Attendance precheck. Both reached500 active
HTTP principals and passed all six baseline workflows, including50-person Payroll
close/publication, own PDF and foreign-person/tenant fences. Both then exceeded the
600s HTTP-child budget; the parent completed termination at610s. **Neither has final
traffic accounting, final latency metrics or post-load native audit verification.**

| Activity / original receipt | Last completed / failed / active snapshot | Recorded request errors | Native Personnel deletion refusal |
| --- | --- | ---: | --- |
| [1s —41304047446](https://github.com/StradaverseHub/ai-hr/actions/runs/41304047446) |26 /312 /162 at390s of timed traffic |310 |`DRAFT-8B8CF331`,SQLSTATE55P03 |
| [5s —41304050133](https://github.com/StradaverseHub/ai-hr/actions/runs/41304050133) |23 /352 /125 at400s |351 |`DRAFT-82588DF7`,SQLSTATE55P03 |

These are last persisted snapshots, not manufactured final outcomes. All500 users
are accounted for in each snapshot, including unfinished journeys. One-second
traffic additionally recorded a Leave source-busy refusal. Both expose handled
Home-card failures under load. Advisory samples identify access-configuration
contention:457exclusive/96shared connection-samples(1s),463/153(5s); two audit-key
wait samples occur in5s. Counts are observations, not wait durations. No retries,
suppressed business errors or relaxed deadlines turn these failures into passes.
Fixtures contain1m Claims and1m Attendance rows,500 employments,2 tenants and10
companies. Actual hosts have4 CPUs/~16GiB; app1worker/pool10/heap4GiB and the
existing PostgreSQL~2GiB cap with fsync/synchronous_commit on. Build508.8/509.9s;
fixture430.3/338.5s. Separate hosts/dates/workloads prohibit causal cross-run ratios.

The latest earlier runs with **complete** timed metrics remain source396c5d36f
(application/SQL4b0a8bc56):1s83/500 journeys, read p9570.4s/write84.1s;
5s52/500,read66.5s/write86.2s. Both failed, including0/6 complete loaded browsers.
Their post-load audits passed. Keep these original receipts
[41194141433](https://github.com/StradaverseHub/ai-hr/actions/runs/41194141433) /
[41194146086](https://github.com/StradaverseHub/ai-hr/actions/runs/41194146086);
they predate the newer fixes and are not relabelled onto them.

### Qualified components and current candidate

| Frozen source / receipt | Established result; not HTTP capacity acceptance |
| --- | --- |
|1be4d2d26 /41195110022,41195116641 |158 affected cases and whole compiler PASS. Three standalone scope-metadata methods share the read barrier; writer/borrowed exclusion remains. Native500-principal triple-read p95 shared2669.6ms vs restored-exclusive6222.1ms. |
|16e662e6b /[41303017578](https://github.com/StradaverseHub/ai-hr/actions/runs/41303017578),[41303020809](https://github.com/StradaverseHub/ai-hr/actions/runs/41303020809) |208 affected cases and whole compiler PASS;2/2 native/index profile cases PASS. Unassigned employee median76.59ms before/1.80 candidate/78.35 restored. Exact parser indexed lookups over1,000,002 synthetic workflow documents0.185–0.691ms; no native million-request creation claim. |
|cf7f69758 /[41305425007](https://github.com/StradaverseHub/ai-hr/actions/runs/41305425007),[41305427586](https://github.com/StradaverseHub/ai-hr/actions/runs/41305427586) |217 cases in18 files(213DB-classified/4model), zero failures/skips; whole compiler PASS. Exact application batch vs restored-scalar medians:HR50.00/77.04ms,delegate108.08/132.83,manager98.38/119.39. Native decision owners and command guards remain unchanged; transport chunks never cap returned tasks. |
|804287fa9 /[41306444884](https://github.com/StradaverseHub/ai-hr/actions/runs/41306444884),[41306447168](https://github.com/StradaverseHub/ai-hr/actions/runs/41306447168) |185 affected cases in11 files, zero failures/skips. Exact installed SQL refinement: unassigned manager1.19ms vs restored54.15ms. Real legacy/unrouted administrative assignment, named non-admin actor and valid delegate are preserved. Existing actual application TS/SQL-index bodies match cf7 except the new necessary-only helper replacement; cf7 compiler evidence is retained on its original source. |
|5008006c1 /[41307278542](https://github.com/StradaverseHub/ai-hr/actions/runs/41307278542) |Native red regression:10PASS/5FAIL. Only five complete standalone Workforce projections fail overlap; writer and borrowed-command controls pass. Original failure retained. |
|1d0c22968 /[41308108373](https://github.com/StradaverseHub/ai-hr/actions/runs/41308108373),[41308110703](https://github.com/StradaverseHub/ai-hr/actions/runs/41308110703) |Current combined candidate. Five complete owned list/picker/count/page/detail transactions share the configuration read barrier; supplied transactions remain exclusive.220 cases in16 files(139DB-classified/81model) PASS, zero failures/skips. All15 native concurrency cases pass, including the five original failures. Independent whole compiler and paired500-principal five-reader comparison pending. |

The current candidate retains all earlier fixes and adds no permission/result cache.
Every positive Attendance precheck still uses full native request/decision proofs.
The negative gate includes frozen historical identities and delegates; an
administrative manager falls through whenever any legacy request is pending.
All217-case and185-case native results preserve identity, scopes and private fields;
the uncapped metadata regression includes1,201 headers with private proposal columns
unavailable. No command authorization or writer barrier is weakened.

Load diagnostics now save periodic normalized SQL snapshots, bounded blocker
pid/state/query IDs and explicitly incomplete latency/accounting snapshots.
Timeouts retain budget/signal facts even if a child exits normally after termination.
Request90s limits,5min steady window and p95 targets(read/page<1s,write<500ms) are
unchanged. These diagnostics are being qualified in the next actual HTTP runs;
partial data is never an acceptance receipt. Both activity levels rerun only after
current native/compiler/component qualification.

Current integration base is main/alpha1a74336e68abf0c06067b19857ad68c8aeb93049,
freshly fetched1 November. Preserve its639-entry journal and all SQL bytes.
Eight never-installed drafts were moved byte-identically to0879–0886;0887 adds
UUID actor-key indexes/precheck,0892 refines only legacy discovery. Ten drafts
remain unapplied outside disposable jobs. Foreign claims0888–0891 are not included.
Allocation source audits and exact mapping live in[MIGRATION-ALLOCATION.md](MIGRATION-ALLOCATION.md).
Reconcile source/live ledger again before any separately authorized installation.
Current provider digest70c2f9c4a1f629c3489d5053c5dda506fd1717ea60721831c4120675c06c6bff;
agent digest412bfabeeded8ef7eb8562db614115e3dd123f282a0aa32093272d4b29548239.
Human approval literals remain unchanged; earlier exact-source approvals do not
approve this newer candidate.

Coverage is bounded:30 page routes, Claims draft CRUD, Leave create/edit/withdraw,
Personnel draft CRUD, Attendance correction/approval, Payroll calculation/export,
100-line clocking import and baseline50-person close/publication. Six representative
loaded Chromium contexts accompany500 HTTP identities. Concurrent close/publication,
Lifecycle/Performance/Rewards mutations, large Personnel imports, report-definition
CRUD, long documents and external AI-provider load remain uncertified. Millions are
retained Claims/Attendance rows, not millions of employees or every table.

[Earlier development notes](performance-evidence/2026-11-01-earlier-development-notes.md)
preserve original failed scale experiments, calendar/preflight failures, cleanup
recovery and older component/source receipts. The detailed sections below are retained
historical evidence and implementation context; this section owns current status.

## Retained development verification — 31 October 2026

Source `0331b4cf6547f0613a17ab3f1e24e00f2b8d98df` includes published main/alpha
`b0907303c`, the preserved canonical migration prefix and the following additional
reductions. It has not been installed anywhere:

- Manager/HR review task queues share one native principal proof, query and tenant
  transaction. Existing per-row stage authority and single-stage APIs remain.
- Empty leave cancellation metadata returns after its first native principal proof,
  avoiding a second transaction for zero decision candidates.
- Complete ESS policy projections compute their visibility closure once per call,
  instead of recomputing it for each editable field. No permission result is cached
  between calls. Disclosure/primary-contact/route checks and a separate public-policy CPU
  comparison pass, with their original sources and counts below.
- Generated client translation scopes include current main's new consumers. The
  wider HTTP/browser mix grows from 27 to 30 routes, adding Security Center,
  Formula Builder and its new-form screen. New measurements must retain this changed mix.
- The load fixture supports 180 or 2,000 attendance days per employee: 90,000 or
  one million attendance rows alongside one million Claims and 500 frozen payslips.
  It independently asserts counts, 500 current-day records and no attendance before hire.
  This is retained-history read coverage, not a payroll/attendance calculation certificate.

The retained one-second `e09a841ca` SQL sample still records154 Home role calls
averaging1,236.8ms, alongside84,827 employment-visibility calls. The nested SQL
planning/execution values overlap and must not be summed as independent CPU time.
A reversible disposable-database experiment now isolates role/visibility plan reuse
and a necessary reporting-edge precheck that retains the full original visibility
query whenever any edge exists. The winning necessary-edge precheck is now drafted in unapplied migration0862;
188 affected application cases and exact-file populated qualification pass; full
HTTP/browser qualification fails speed. Function language, security
attributes and execute ACLs remain unchanged. No installation has been changed.
The first diagnostic run stopped before timing because the isolated worker lacked
`pg_stat_statements`; its original failed setup is retained and the corrected run
explicitly installs the extension in that worker database.

The review-reader comparison on `cdb51ea36` uses 500 actual linked principals and
five pairs of empty-queue reads each. Separate-before p95 is10,217.5ms, grouped
5,197.5ms, separate-after9,666.1ms, with no errors. This supports the reader change;
it does not establish an equivalent page-speed improvement or meet HTTP acceptance.

Source `4303321f6` removes a redundant edit-policy refresh from the first profile
task candidate read. That refresh took the exclusive access/profile write barriers
and resolved edit settings even for an empty queue. The native reader/RLS still
checks current routing and access in the candidate statement. Nonempty candidates
still pass the existing second locked current-policy decision check; writers and
decisions retain all their locks. A500-principal, three-reads-each native comparison
measures p952,855.3ms before,978.9ms current and2,617.6ms restored, with identical
empty outputs and forged-user/person refusals. The57 affected application cases
pass. Full HTTP/browser qualification on `c6a904865` is pending; that additional
commit changes only a diagnostic fixture's enum type, not its runtime value.

| Run | Exact source and result |
| --- | --- |
| [41103360230](https://github.com/StradaverseHub/ai-hr/actions/runs/41103360230) | `cba553212`: 272 cases PASS, one stale generated translation-inventory assertion FAIL, zero skipped assertions. Whole compiler FAIL: BigInt literal under ES2017 plus an untyped money-snapshot array, in two imported tests. Original failures retained; assertions/compiler target were not weakened. The million-claim helper median is565.0ms, max565.8ms over five reads, returning25rows/12,307bytes; not HTTP capacity. |
| [41103845727](https://github.com/StradaverseHub/ai-hr/actions/runs/41103845727) | `cdb51ea36`: native 500-principal review-reader comparison PASS; all three phases and measured figures above. |
| [41103850616](https://github.com/StradaverseHub/ai-hr/actions/runs/41103850616) | Requested `cdb51ea36`; resolver refused a moved candidate branch before tests/compiler. No behavior evidence. Replaced by a frozen-ref task regression below; original refusal remains. |
| [41104695275](https://github.com/StradaverseHub/ai-hr/actions/runs/41104695275) | `e09a841ca`: translation/inventory and affected Formula/Security rendering recovery **47 cases PASS**, zero skips. Generated hosted inventory equals repaired source. |
| [41104188955](https://github.com/StradaverseHub/ai-hr/actions/runs/41104188955), [41104191072](https://github.com/StradaverseHub/ai-hr/actions/runs/41104191072) | `e09a841ca`: 30-route HTTP/browser,90,000 attendance rows. One-second read/write p95 **52.8/53.3s**; five-second **39.6/39.6s**. Both complete500/500 journeys, all30routes, allsix loaded browsers, nine authority boundaries and native audit verification; zero HTTP journey/runtime errors. **Speed FAIL** in both; changed main/mix prevents a causal ratio against earlier runs. |
| [41105244228](https://github.com/StradaverseHub/ai-hr/actions/runs/41105244228) | `63b36a4c3`: both imported test typing repairs verified with **19 cases PASS** (two DB,17 non-DB), zero skips; whole compiler PASS. Assertions and ES2017 target preserved. |
| [41105246682](https://github.com/StradaverseHub/ai-hr/actions/runs/41105246682), [41105238515](https://github.com/StradaverseHub/ai-hr/actions/runs/41105238515) | `63b36a4c3`: both30-route loads complete500/500 data journeys and actual audit verification, with zero HTTP journey/runtime errors. One-second read/write p9569.8/63.3s and0/6loaded browsers; five-second64.5/57.3s and1/6browsers. **Speed/browser FAIL**; exact fixture counts and independent date bounds PASS. |
| [41105777866](https://github.com/StradaverseHub/ai-hr/actions/runs/41105777866) | `0331b4cf6`: complete ESS policy CPU comparison PASS.243 public fields /79 editable /five primary-only;100 measured calls per phase/version. Versions3/4/5 previous-before p95 7.97/12.90/13.30ms; current0.47/0.65/0.43ms; previous-after7.36/12.37/12.62ms. Identical outputs and fresh policy changes verified; helper CPU, not HTTP capacity. |
| [41105777665](https://github.com/StradaverseHub/ai-hr/actions/runs/41105777665) | `0331b4cf6`: affected ESS disclosure, edit/approval routes, photos and calling authority **79 cases PASS** (38 DB,41 non-DB), zero skips; whole compiler PASS. |
| [41106189667](https://github.com/StradaverseHub/ai-hr/actions/runs/41106189667) | `0331b4cf6`: frozen-ref native task metadata, actual assignment, stage transitions and shell regression **47 cases PASS** (40 DB,seven non-DB), zero skips. |
| [41106766391](https://github.com/StradaverseHub/ai-hr/actions/runs/41106766391) | `f7dd66c60`: Home-role diagnostic setup FAIL before timing: missing worker extension. No capacity or performance result. |
| [41107920846](https://github.com/StradaverseHub/ai-hr/actions/runs/41107920846) | `35a9544ed`: repaired native experiment PASS.500 actual principals/100 active probes: baseline p9513,995.9ms; role-plan12,102.5; necessary-edge guard98.8; visibility-plan wrappers5,841.0; restored baseline12,373.3. All phase identity/assignment/archival/forged-grant/foreign-subject checks and owner/ACL/security attributes PASS. Only the necessary-edge guard is selected for product SQL; global visibility wrappers are not adopted. |
| [41110030641](https://github.com/StradaverseHub/ai-hr/actions/runs/41110030641) | `d883ce28e`: **188 affected application cases PASS** (159 DB,29 non-DB), zero skipped assertions, including future reporting-edge activation/revocation, current identity, isolation, sharing, restricted-owner and privacy boundaries. Whole compiler FAIL on a stray quote in the development diagnostic, not application source. Original failure retained. |
| [41110027898](https://github.com/StradaverseHub/ai-hr/actions/runs/41110027898) | `d883ce28e`: exact-file Home-role diagnostic FAIL to load because of the same diagnostic syntax error. No timing claim from this run. |
| [41111998461](https://github.com/StradaverseHub/ai-hr/actions/runs/41111998461) | `83d3e4304`: diagnostic-only syntax recovery; application and migration bytes unchanged. Exact-file populated native experiment PASS:500-principal inventory/100 active probes; canonical baseline p9528,335.5ms; guarded role178.4ms; restored baseline25,617.1ms. All phases return zero errors and pass live authorization checks; installed headers/security retained and original functions restored. Whole compiler FAIL: diagnostic fixture reporting-line enum widened to string. The `as const` repair on `c6a904865` changes no runtime value; compiler recovery is separate. |
| [41110032639](https://github.com/StradaverseHub/ai-hr/actions/runs/41110032639), [41110030713](https://github.com/StradaverseHub/ai-hr/actions/runs/41110030713) | `d883ce28e`: exact Home migration,30-route HTTP/browser with one million Claims and one million attendance records. Both complete500/500 CRUD journeys, allsix loaded browsers, all30routes, nine boundaries and native audit verification, with zero journey/runtime errors. One-second p95 read/write60.2/65.5s; five-second50.6/53.9s. **Speed FAIL**. Actual component CPU and18 visibility observations per run are described above. |
| [41113395991](https://github.com/StradaverseHub/ai-hr/actions/runs/41113395991) | `4303321f6`: profile queue native comparison PASS;500 linked principals/three reads each per phase, p95 before2,855.3ms/current978.9ms/restored2,617.6ms; zero errors and forged user/person refusals. Empty-queue component evidence only. |
| [41113396927](https://github.com/StradaverseHub/ai-hr/actions/runs/41113396927) | `4303321f6`: **57 affected cases PASS** (40 DB,17 non-DB), zero skipped assertions. Native profile assignments, actual decisions, denied/revoked photo access, field routing and policy behavior. Compiler qualification is separate; this source still carries the diagnostic enum typing error retained above. |
| [41113543529](https://github.com/StradaverseHub/ai-hr/actions/runs/41113543529) | `c6a904865`: diagnostic enum typing repair; nine selected profile-option cases PASS, zero skips. **Whole compiler PASS.** |
| [41113693279](https://github.com/StradaverseHub/ai-hr/actions/runs/41113693279), [41113711375](https://github.com/StradaverseHub/ai-hr/actions/runs/41113711375) | Frozen `c6a904865`: one/five-second30-route full HTTP/browser recovery, one million Claims plus one million attendance rows, unchanged speed checks. Both complete500/500 data journeys,6/6 loaded browsers, all30routes, nine boundaries and native audit verification, with zero journey/runtime errors. One-second read/write p9554.5/59.1s; five-second50.5/53.9s. **Speed FAIL**. All18 visibility observations per run succeed. Separate hosts prevent attributing a causal improvement ratio. |

An additional development candidate, `645a2ac90`, batches audit arming into session
setup **only when the existing one-way tenant marker is already true**. The arming
decision still runs after setup. Unknown/first-arm tenants retain the original
separate setter, including if another transaction arms the tenant during the setup
await. No new cache or permission-result reuse is introduced. Native audit/RLS/
privacy/suspended-tenant checks and same-backend commit/rollback isolation pass
**322 cases** (264 DB,58 non-DB), with zero skipped assertions. The whole compiler
also passes. The500-principal native setup/query-count comparison passes in runs
[41114900759](https://github.com/StradaverseHub/ai-hr/actions/runs/41114900759) and
[41114890203](https://github.com/StradaverseHub/ai-hr/actions/runs/41114890203).
Each phase has1,500 transactions: separate-before and separate-after each issue
1,500 session setters plus1,500 audit setters; combined issues1,500 combined
setters and no separate audit setters. All native principal/tenant/armed checks
pass. Per-principal three-transaction p95 is1,073.2ms before /811.9ms combined /
807.1ms restored. The warmed control is comparable to combined, so this establishes
a round-trip reduction, **not a consistent latency improvement**.
Full one/five-second HTTP/browser qualification completes in frozen source645 runs
[41115991569](https://github.com/StradaverseHub/ai-hr/actions/runs/41115991569) and
[41115973494](https://github.com/StradaverseHub/ai-hr/actions/runs/41115973494).
Both complete500/500 persisted CRUD journeys,6/6 loaded browsers, all30routes,
nine authority boundaries and native audit verification with zero journey/runtime
errors. One-second read/write p9554.4/58.3s; five-second50.8/54.4s. **Speed FAIL**.
The results remain comparable in magnitude to the preceding profile-reader runs;
the audit setup reduction does not resolve the HTTP bottleneck. Separate hosted
runners do not establish a causal improvement or regression ratio.
The earlier `c6a904865` HTTP tests do not qualify this later setup change.

## Earlier main integration and protected-source binding

Fresh main/alpha advanced together to `7c57d5f64` during the frozen tests. Normal
merge `6430d9570` preserves their CI/fixture repairs; the sole merge conflict takes
main's stronger `nativeMoneySnapshot` return type. Main's583-entry migration prefix
and all existing SQL bytes remain unchanged; the candidate has588 entries with the
five separately held performance drafts. No protected ref was moved by this task.

The source review also finds SQL/JavaScript legacy parity gaps in lifecycle JSON:
an absent task status remains unfinished, an absent state remains not cancelled,
and an explicit unknown source join date must not inherit a local date. Repairs
`7b7e4b444` / `f256f8f34` add direct native comparisons with the existing owner.
Current-main fixture/lifecycle checks and whole compiler run
[41119700182](https://github.com/StradaverseHub/ai-hr/actions/runs/41119700182);
**75 cases PASS** (32 DB,43 non-DB), zero skips; **whole compiler PASS** on
`2cfde7e0b`. The final explicit-null date assertion and lifecycle suite then pass
**29 native cases**, zero skips, plus the **whole compiler** on frozen
`e0897e409` in [41120612459](https://github.com/StradaverseHub/ai-hr/actions/runs/41120612459).
These later source changes are not relabelled onto the source645 load runs.

Generated fingerprints are refreshed after integration. The immutable Git-blob
privacy closure independently matches998 files and digest
`c1c073ea81f8f90c3d70d2794aca562470ffd74252ec38066e3ef8a55193cc41`;
976 files are unchanged,21 change and one dependency is added. The same24 literal
approved-contract records still identify the earlier approved digest, and the two
pending records are untouched. The source-bound approval gate therefore remains
closed in this draft; ordinary protected-provider positive checks cannot yet pass.
Run [41119710456](https://github.com/StradaverseHub/ai-hr/actions/runs/41119710456)
retains the real gate result on `2cfde7e0b`: two cases PASS (including exact manifest
freshness), one FAIL because approved records still carry the old digest. No skipped
assertions. This is an unresolved approval-binding hold, not an all-green application
receipt. No generated hash alone renews human approval.
The [technical review and exact proposed scope](reviews/system-performance-provider-source-review-20261031.md)
records the reviewed changes; a fingerprint-only proposal is prepared and unapplied.

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
- One million pending claims, 90,000 or one million attendance rows as identified
  per run, and 500 frozen payslips.
  Other worklists are not populated at million-row scale. Payroll calculation,
  publication, imports, exports, document generation and AI-provider throughput
  are not capacity-certified by this fixture.
- Ten-second arrival ramp, then 30 seconds of sustained activity; requests wait
  for responses. Think time applies after each of three page reads and after
  create and edit; delete is followed by the next journey without an extra pause.
  These are closed-loop full-document page requests and real server actions,
  not a claim of 500 requests per second or a measured warm SPA navigation mix.
- The wider mix rotates over 27 or 30 selected routes as identified per run across employee, manager and HR
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
| Home role read | An unapplied necessary reporting-edge gate avoids unrelated visibility evaluations for unassigned employees. If any eligible edge exists, the entire original visibility query remains authoritative. The188 affected cases and exact-file populated comparison pass; both full loads pass browser/functional checks but fail speed. |
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

The Claims action's own-employment selection is an authority boundary, not merely
a display lookup. The draft owner's person equality check does not replace active
subject selection. Any faster save path must compose the equivalent native selection
proof with the canonical command, retain receipt rollback and submit rules, and keep
the client view current across employment changes and navigation. Returning bounded
draft state without rebuilding the global shell needs its own behavior/browser proof;
removing the existing action guard is not an approved performance shortcut.

Priorities remain:

1. Reduce repeated authorized shell reads and measure each change with paired
   native-service experiments plus the unchanged HTTP/browser acceptance checks.
2. Establish application CPU, database execution, pool wait and browser budgets on
   representative installation hardware. Do not infer required hardware solely
   from this shared development runner.
3. Exercise million-row histories beyond the retained Claims/attendance fixture, concentrated and distributed
   companies, deep paging, imports/exports and payroll calculation/publication
   alongside ordinary interactive reads and writes.
4. Add bounded queued/streamed generation for expensive reports and documents;
   measure restart recovery, memory and effect on interactive latency.
5. Reconcile migrations and fresh main/alpha before any release gate. A passing
   focused run, merged source or draft PR grants no deployment authority.

Additional whole-system source findings need their own behavior and load evidence:

- The Reports hub requests every authorized Master report and then displays five.
  The preview reader also materializes its full ID inventory before checking each
  definition individually. A bounded candidate scan plus a separate authorized
  lookup for the saved-report banner must preserve denied-report skipping, order,
  definition recovery and the explicit full-list API.
- Personnel draft rows are deliberately pinned into the employee list and counted
  separately from employments. They are unpaged and include full draft data to
  compute missing fields. Any bounded replacement must preserve the current draft
  card, filter/scope rules, outstanding-work visibility and employment-only totals.
- Hydrated baseline visits cover the selected routes, but Home cards can handle a
  failed fetch without a JavaScript runtime error. Explicit card-ready/error checks
  and loaded Home navigation should supplement the existing heading/table checks;
  successful root HTML alone does not certify all asynchronous cards.

On 31 October 2026 the owner selected **production-equivalent infrastructure**
for final 500-concurrent-user acceptance, at both one-second and five-second
activity levels. The historical production record describes separate application
and PostgreSQL VMs, Nginx HTTPS and TLS between application and database. Current
CPU/RAM allocations, storage performance, network latency, process limits and
PostgreSQL configuration still require verification before an isolated acceptance
environment can be described as equivalent. Generic customer sizing guidance is
not evidence of the actual production installation.

The shared four-CPU development runner remains diagnostic evidence only. Final
acceptance must also cover representative writes and processing outside Claims;
the existing concurrent mutation workload exercises Claims draft CRUD only. Tests
must use fictional data in an isolated environment, with load generation separated
from application/database capacity. Standard hosted Actions remain the authorized
execution route; do not provision paid runners, incur new infrastructure costs or
load-test the live installation by inference from this selection. No live host,
database or configuration was changed or load-tested. Deployment remains excluded.

Fixtures, private keys and native session tokens stay outside public artifacts.
The HTTP evidence contains fictional screenshots, timings, normalized SQL, sampled
CPU frames and request outcomes. No private production data was used in load tests.


## Production-equivalent target — read-only inventory, 31 October 2026

After the owner connected the required network, bounded SSH inventory succeeded
on the separately configured production application and database hosts. Both expose
16 CPUs and approximately62.7GiB RAM. The application unit has MemoryHigh10GiB,
MemoryMax12GiB, unlimited CPU quota and TasksMax512. The active application uses
Node24.22.1, internal authentication and production mode; NODE_OPTIONS and
AIHR_DB_POOL_MAX are unset in the inspected process environment. The latter alone
does not establish the installed application's effective pool size.

PostgreSQL reports16.15, max_connections100, shared_buffers16384x8kB(128MiB),
effective_cache_size524288x8kB(4GiB), work_mem4096kB, maintenance_work_mem65536kB,
max_parallel_workers8, max_worker_processes8, effective_io_concurrency1 and
random_page_cost4. TLS, fsync, synchronous_commit and JIT are enabled. The database
VM exposes a900GiB data disk. These are observed settings, not evidence of disk
IOPS, network latency, sustained available capacity or an accepted tuning change.
The inspected application cgroup contains one Next.js server process; its observed current memory charge was2022572032bytes (not a peak-load measurement). All five observed app database sessions used TLS. Three bounded app-to-DB ICMP probes averaged0.319ms (not application request latency or sustained network capacity). No database benchmark, write, restart, installation or configuration change ran on production.

The standard four-CPU shared Actions diagnostic environment cannot reproduce this
two-host capacity/topology. Matching isolated infrastructure remains required for
final acceptance. The owner selected an existing isolated environment; its SSH alias or connection-config path remains required.

Expanded workload candidates capture actual built Leave and Personnel actions,
including typed Personnel transport. Independent database reads verify create/edit/
delete or state transitions. A later candidate also adds an explicit fictional
Attendance approval workflow, verifies corrected punches after authorized review,
and calculates50-person Payroll batches with scoped CSV content checks. Leave
withdrawal preserves history; it is not a physical DELETE. These additions require
hosted execution before they establish any coverage or speed claim.

A subsequent read-only `pg_db_role_setting` check found no role/database overrides
for the inspected buffer, work-memory, durability, JIT, parallelism or connection
settings. The next development workload pins its application toolchain to observed
Node24.22.1 and can hold sustained activity for five minutes. Neither runtime
alignment nor a longer interval makes the smaller shared runner production-equivalent.

Native run41179640317 on9098adc7fcf68b294075ac699fc8836ca885c9cf executed74
selected cases (68DB/6nonDB), zero failures and zero skips; its whole compiler passed.
HTTP/browser outcomes remain separate, as recorded below.

## Resumed verification — 31 October 2026

Current candidate `1a0ed296a1ddc03afebbed627de2a1547d957f22` passed129 focused
cases (105DB/24nonDB), zero failures/skips, and the whole compiler. The current
expanded HTTP/browser runs are41188713821(one-second) and41188713828(five-second);
both completed and failed; see the current outcome table above. No500-user speed pass or production-equivalent
acceptance is established. The owner selected an existing isolated environment;
its SSH alias/config path remains required. Configured staging is2 CPUs/~4GiB,
compared with production's two16-CPU/~64GiB VMs. No workload ran on either live
installation, and no deployment occurred.

Baseline main `70bdafbc8a7d4aa69ffa7dee5741af73f497a344` was integrated normally in
`f1444f59c`. Its636-entry journal and every canonical SQL byte were independently
verified unchanged. The641-entry candidate appends only reservations0866–0870.
No migration was applied outside disposable hosted databases; allocation/fresh refs
must be checked again before integration.

| Hosted native evidence | Source | Result |
| --- | --- | --- |
|41179640317 |9098adc7fcf68b294075ac699fc8836ca885c9cf |74PASS(68DB/6nonDB), no skips; whole compiler PASS |
|41179939683 |9098adc7fcf68b294075ac699fc8836ca885c9cf |304PASS(257DB/47nonDB),18 module suites, no skips |
|41180173334 |dbc3c4e33db31d52f3a3eacacd3375fa020d2b3d |Original selection FAIL(nonexistent test path); independent compiler PASS |
|41180201688 |dbc3c4e33db31d52f3a3eacacd3375fa020d2b3d |Corrected selection40PASS(23DB/17nonDB), no skips |
|41180553216 |310b5977c815c2ff37a9b595f058c714de885e60 |165 fixture/role-transfer/task cases PASS, no skips; whole compiler PASS |
|41185074563 |5012f28a1bda64cb8674153f768dfca3695d3167 |54 metadata/assignment/delegation cases PASS, no skips |
|41185013098 |5012f28a1bda64cb8674153f768dfca3695d3167 |Original benchmark FAIL(object-key insertion order affected JSON digest); independent compiler PASS |
|41185593278 |748352f59364493725ef23d79a30d4345f6ea916 |54 affected cases PASS, no skips; whole compiler PASS |
|41185840215 |3c5cec42b1430757d5f3da7574dc6ae11d14e8a4 |Original delegated-preview regression30PASS/1FAIL: preview0 while authorized metadata contains1 |
|41185883781 |2a0077ca6361bcdf3e189cb40d338c6c4106e977 |Repaired preview/Home checks60PASS, no skips; whole compiler PASS |
|41188544388 |26c7d0730c701b0bbcaa513744b10c70b98c1922 |Original large-count regressions19PASS/2FAIL, both HomeConfigurationError(template.values.count) |
|41188641438 |1a0ed296a1ddc03afebbed627de2a1547d957f22 |129PASS(105DB/24nonDB), no skips; whole compiler PASS |

Paired component measurements below retain their exact sources. Values are
initial/changed/restored, on the same runner within each experiment. They are not
500-user HTTP measurements, and independent hosted runners do not establish a
causal scaling ratio.

| Benchmark | Source | Paired result |
| --- | --- | --- |
|41180556156 |310b5977c815c2ff37a9b595f058c714de885e60 |500 actual principals x3 empty Profile reads: journey p95 1178.46/624.44/934.05ms; no errors; forged-principal checks retained |
|41185420342 |6387cc10bd4f504852f4ddb6b805d42f4ddce8b8 |100,000 claims, three principals x3 reads/phase. Median full metadata: HR1421.3/1219.8/1389.4ms; manager20,000-item queue364.2/250.1/373.5ms; empty employee106.1/3.7/107.0ms |
|41185610048 |748352f59364493725ef23d79a30d4345f6ea916 |Same-shaped native full-reader comparison: HR1283.7/188.3/1132.8ms; manager295.6/59.8/316.2ms; employee90.2/3.4/98.8ms |
|41187886869 |c04fe51b8bfed90d6a3a8410169b1c7c9f68c82a |Preview experiment, actual audit GUC verified on: HR169.9/120.1/157.7ms; manager79.2/71.0/79.4ms; employee6.0/5.7/5.1ms. Ordered rows and exact100,000/20,000/0 totals match |

The corrected full-reader oracle sorts object keys only; every field, value and
row order remains checked. Profile now probes one native-authorized pending header
before employment/person joins. Nonempty queues retain their projection/current
policy checks. Claims resolves delegated subject names once per pending employment,
then repeats native principal/decision authority in a separate transaction before
reading all current pending headers. No full task list is silently truncated.

The counted preview now shares that delegated-subject owner, preserving a valid
stand-in whose subject is outside ordinary Personnel visibility. Each authorized
employment contributes at most its top N to a global top N; anything below that
subject's top N cannot enter the global top N. Native request RLS and the separate
uncapped exact count remain authoritative. Limits1/25/200 and private-column
restrictions are covered by the affected native checks.

The Home template validator previously rejected every task count above10,000.
The fixture manager has20,000 actual pending assignments, so that valid workload
could fail summary rendering with503. Counts now accept nonnegative safe integers;
the separate200-year anniversary bound, permitted fields, text safety and rendered
length limits remain. Counts are not clamped or replaced with a calm message.
The native HTTP manifestation after repair remains to be verified by current runs.

| Original expanded HTTP/browser evidence | Source | Retained outcome |
| --- | --- | --- |
|41179453346/41179456415;41179633915/41179637258;41180079447/41180082400 |b28d7f00b;9098adc7f;871342bb8 |Before traffic: dedicated disposable DB/job refused by newly enforced migration prerequisites; observed builds PASS |
|41180175791(service profile) |dbc3c4e33 |Before case: role-prerequisite owner did not admit the service benchmark job |
|41180573016/41180575968 |56fc0848f |Fixture correctly refused a self-approving Attendance workflow; applicants repaired to exclude HR approver |
|41180942249/41180945047 |ab55b5775 |30 route pilots, Claims browser CRUD and persisted Leave CRUD passed; Personnel driver omitted required manual employee ID; no500-user phase |
|41182199060(workflow-only) |2c50477ff |Persisted Leave, Personnel draft CRUD and Attendance correction/approval/punch changes passed. Payroll preflight failed. Draft fixture wrongly contained historical payslips; historical runs are now natively generated/closed and processing drafts start empty. No particular SQL error was independently captured |
|41183418076 |af950afcae5607c429e76da032ac1a724fb1d26d |Fixture/build PASS; strict readiness caught two handled manager Home failures, despite HTTP200 and no JavaScript errors; no load |
|41185134683;41185378631 |606a35db41a3a4b177e167cca50e0d6d5fdf6c1d |Original empty selection refused by controller. Corrected-input run retained one manager summary failure and hit600-second browser phase limit waiting on response.finished() at Leave edit; no completed expanded mutation preflight/load |
|41185656999(1s)/41185654964(5s) |748352f59364493725ef23d79a30d4345f6ea916 |Fixture/build PASS. Both fail at90-second browser navigation to/me/payslip before concurrent traffic. First employee Home had no handled failures; other Home roles were not all reached. Screenshots show the statement rendered, later DB sessions idle and V8 mostly idle; the unfinished request/cause is not established |
|41186781411;41187497364 |4849474d0;d5efdaf43 |Manager Home summary503 and handled failure before mutation/load; no concurrent latency receipt |
|41188286052 |f95f7788989a9941c5dac0caae65a4d64490aa97 |Same uncorrected manager503 blocks preflight before the explicit PDF checks. Independent whole compiler PASS |
|41191367882 |dispatch input error |Refused an incorrect expected SHA before candidate checks; corrected dispatch41191380816 retained separately |
|41188713821(1s)/41188713828(5s) |1a0ed296a1ddc03afebbed627de2a1547d957f22 |Both FAIL; all expanded preflights PASS,500 peak users; 1s0/500 journeys,5s226/500 journeys; current outcome table retains latency and errors |

Performance-job admission is finite: only the two named hosted performance jobs,
fixed evidence directories and exact password-free loopback DB target were added.
Existing host/workflow/source/URL/evidence checks and the exact native role graph
remain. No job identity is spoofed, live target admitted or unsafe existing role
repaired. Its negative cases/role-transfer checks are covered by41180553216.

Browser action capture now binds to a request initiated after its click listener,
not a response already in flight. Capture needs transport headers; follow-up
navigation can cancel the original stream. Independent UI/committed native checks
still decide functional success, while the timed HTTP driver consumes complete
responses. Periodic pending-request snapshots retain paths/statuses but hide
external addresses/query values. No readiness deadline or latency threshold was
relaxed. Diagnostic41187497364 used90,000 Attendance rows, not one million.

The own PDF download uses a native attachment anchor; HTML review remains a Next
Link. Its passing native browser checks require no unsolicited PDF request on statement
open, correct own identity/salary, an explicit valid PDF and two foreign PDF refusals.
This change is not yet established as the90-second navigation timeout's cause.

Standalone Workforce metadata scheduling is also being qualified. Native500-principal
experiment41194330229 on sourcea1d73a804 returned identical values and live archive
refusals: triple-reader p95 exclusive4704.0ms / shared1926.1ms / restored4667.3ms.
The original-code concurrency regression41194802272 on source7d202c06e is deliberately
RED:4PASS/3FAIL, no skips. Only the three standalone metadata methods fail reader
overlap; existing writer exclusion and borrowed view/maintain exclusivity pass.
The prepared fix uses the existing shared barrier only for complete owned read-only
transactions. Borrowed transactions and all actual write/assertion paths retain
their exclusive barrier. Source `1be4d2d267867cc2337d8689a705ba94858eb029` passes all158 affected cases
in12 files (145DB-classified/13model), no failures/skips, in41195110022. All seven
native concurrency cases pass, including the three original failures. The same
source's500-principal paired experiment41195116641 passes: triple-reader p95
exclusive6281.9ms / shared2669.6ms / restored6222.1ms, with unchanged native
results and archive refusals. The whole compiler PASS. This newer
metadata source has no whole-system HTTP acceptance receipt yet.

Coverage remains bounded:30 selected page routes, Claims draft CRUD, Leave
create/edit/withdraw(history retained), Personnel draft CRUD, Attendance correction/
approval, Payroll calculation/scoped CSV and100-line clocking import. Individual
PDF transport and50-person Payroll close/publication HTTP pass current baseline
preflights; concurrent Payroll close/publication,
Lifecycle/Performance/Rewards mutations, large Personnel imports, report-definition
CRUD and long document jobs are not certified. The fixture has500 employments;
its millions are Claims/Attendance rows. Six representative loaded Chromium
contexts accompany500 HTTP principals; this is not500 real browser instances.
The shared four-CPU diagnostic host is not the two-host acceptance environment.

Generated provider source digest is
`70c2f9c4a1f629c3489d5053c5dda506fd1717ea60721831c4120675c06c6bff`;
module-agent source digest is
`412bfabeeded8ef7eb8562db614115e3dd123f282a0aa32093272d4b29548239`.
Literal human approval records remain unchanged. Earlier exact-source reviews do
not approve this newer source; the approval hold remains before integration/release.
No provider call, release, protected integration or deployment is claimed.
