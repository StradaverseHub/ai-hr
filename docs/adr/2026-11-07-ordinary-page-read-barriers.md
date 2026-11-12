# Ordinary page reads: remove only proven presentation barriers

Status: source candidate; hosted native/browser qualification pending. Production held.
Audit base: `f380e826a5371b0e60606fec5a05790c444fca32`.

## Decision

Rewards setup currently routes every `setupTenant` operation through an exclusive
Access advisory lock, including pure plan/grade/history display. Separate ten pure
public readers into `setupReadTenant`, using the existing database-enforced
REPEATABLE READ / READ ONLY carrier. Check the exact current tenant/login, live
unblocked account and native `principal_snapshot_current()` within that snapshot.
Each existing `setupAuthority`, native RLS and restricted projection remains the
owner of its data. No person claim supplies authority. The snapshot is presentation
only; it is never admission for a mutation or provider call.

The ten readers are library grade choices/history; plan detail, choices, settings,
suggestions, creation/split/new-plan previews and uncovered-plan preview. The
uncovered preview now shares one transaction for eligible IDs and suggestions.
Existing ordering, complete results, salary cents, bonus basis points, version IDs,
digests and company/date rules remain. Preview callers still enter the unchanged
locked command owner to revalidate and perform effects. No schema, grant, policy,
module entitlement, calculation, money writer or migration changes.

Do not move `rewardLibraries`, `rewardPatInputs`, library/PAT exports, commands or
approval transitions onto this carrier. Their explicit viewed/exported events,
Access serialization, independent checker rules, audit-chain appends and history
must remain. These event-producing GETs are an unresolved page loading bottleneck.
The Plans and Libraries pages call those readers too: this candidate alone does
**not** make those entire pages nonblocking or establish zero Busy.

## Source audit and remaining work

This is a source-owner audit across module families, not a completed per-destination
runtime audit. The declared navigation ledger and every unresolved dynamic submenu
remain unqualified. A direct `withTenant` read does not prove speed, a single coherent
snapshot, fresh authorization for every nested helper, or freedom from database
function locks. No blanket conversion is justified.

| Surface / ordinary GET chain inspected | Source finding and disposition |
| --- | --- |
| Personnel `/admin/personnel` → `core/read.personnelListPage` → `withPersonnelRead` | Standalone snapshot carrier already exists; supplied command transaction retains its Access barrier. Leave owner unchanged. |
| Home / ESS → `core/employee-home`, `core/read`, profile/loans/payroll sections | Home identity snapshots exist; composite widgets still use separate owners. Complete widget and selected-employment qualification remains required. |
| Organization, System Labels → `core/admin`, `core/system-labels` | Native list/label owners and head projection retained. Full recursive SQL-function/write audit and submenu browser evidence remain open. |
| Leave `/leave`, inquiry, balances → `core/my-leave`, `core/read`, `core/leave-inquiry` | Inquiry owns explicit snapshots; generic leave and TOIL use their own native read/adjudication paths. Do not reuse a read snapshot for accrual, claim or approval effects. |
| Attendance `/attendance` → `attendanceMonthSummary` → `withCanonicalAiReadTx` | Ordinary call uses module tenant reader; existing Assistant transaction intentionally repeats its command/admission principal. Whole-month employment/attendance arrays remain a scale lead, not a lock finding. |
| Roster `/roster` → `core/roster-presentation` | Enforced RR/RO presentation already exists; mutation/import/recompute locks remain in canonical owners. Runtime loaded-row acceptance still required. |
| Analytics `/analytics` → report/page/manager ports in `core/analytics` | Manager selection/paged workforce projections and ordinary reports have different carriers; no universal lock was found at the file wrapper. Native plans and all-submenu loaded evidence remain open. |
| Payroll and multi-cycle / typed components → `withPayrollTenant`, `withPayrollHistoryTenant` | Shared History barrier remains intentional. Existing native payroll processing/correction proof must remain, including the RC result that prevents stale money. Never bypass this globally with RR. Report-only reader changes need their own native money/correction proof. |
| Claims `/claims` → `packs/claims/service` → `core/claims.listClaimHistoryPage` | Page count/details use native module/RLS reader; separate reimbursement/draft reservation/approval commands own effects. Count/page snapshot and large-history scale are separate gaps. |
| Performance `/performance` → `listCyclePage`, OneHR company/cycle readers | Native module reader, bounded cycle list plus summaries. No generic exclusive Access barrier in that inspected list body. Summaries, dynamic review pages and partner permissions still need independent runtime proof. |
| Rewards Plans / Libraries → `setupTenant` | Confirmed unnecessary exclusive Access on ten pure presentation ports; fixed here with native tests prepared. Audit-producing GETs remain unchanged and blocking; see below. |
| Lifecycle `/lifecycle` → hub counts/worklist/self readers → module-bound `lifecycle-base` | Hub counts have native level/RLS and explicit list bounds; other v9, equipment, sensitive detail and approval paths remain separate owners. No claim that all are read-only. |
| Knowledge Base `/knowledge-base` → `listDocumentsPage` → canonical read seam | Ordinary metadata list/count uses existing native carrier; content/download access logging and publish/upload commands must be audited separately. |
| AI Centre management → `aiManagementView`, `getAiConfigView`, provider snapshot, spend status | Actual RC `assertAiPrincipalTx` takes Access; group metadata read repeats provider-admin checks; resolving an issued provider snapshot is an admission contract. Activity/policies/quiet-capped lists and membership arrays remain unbounded. A separate display-only metadata owner with exact totals/attention semantics is needed; do not broaden the issued capability contract. Inventory/alerts already have separate presentation snapshots. No provider calls were made. |
| Access editor `/admin/users/access` → `readAccessConfigurationEditor` → store | Actual exclusive Access plus `access_configuration_initialize()` on GET. Initialization can write; converting only the wrapper to READ ONLY would be wrong. Separate native initialize/read owner and retained preview/CAS safety proof needed. |
| Personnel movement import catalogue → `movementImportCatalog` | Actual limits + exclusive Access even on catalogue read. Native `catalogTx`/reference and actor proof needed before splitting it from apply/import admission. Not changed in this Rewards-only chunk. |
| Letters → presentation helpers versus artifact/content/read operations | Ordinary lists already use RR/RO `letterPresentation`; sensitive artifact, token and command owners keep History/Access and audit. Retain that distinction. |
| Reports / general tools → employee-master hub, payroll comparison, custom reports, schema explorer, system testing | Mixed native readers; some explicit snapshots, some canonical ordinary read seams, some execution/audit owners. A listing GET and report execution/download are different contracts. No global bypass applied. |
| Notifications | Separate owner is auditing workers/API. No files changed here. |
| Country MY | Parent country pack supplies deterministic payroll/statutory calculations, not an independent blanket page transaction owner. Retain its existing payroll/read contracts. |

Highest remaining barrier priorities: (1) audited Rewards GETs; (2) Access editor
initialization; (3) movement catalogue; (4) display-only AI management, with bounded
queries preserving its complete attention and spend semantics. Removing an audit
append or moving it behind an unawaited promise is not a safe repair. Any durable
receipt/outbox design needs a separately reviewed native history contract and the
integration owner's schema allocation. No such migration is reserved here.

## Required verification

`test/rewards-setup-presentation-snapshot.test.ts` uses native fictional approved
libraries/plans, an actual employee and compensation, independently checked setup,
real native history and nonempty IDs/money. It holds actual Access and audit-chain
writers through the read and checks they are still held afterward. The former
`setupTenant` carrier must actually time out behind Access; the new projections
must finish with unchanged expected facts and no appended events. It separately
proves PostgreSQL RR/RO and write refusal, retained command/audited-view blocking,
durable viewed events, native setup/login grant revocation with retained contexts,
and foreign-ID refusal. It uses existing 20s statements / 300ms locks / 30s case
budgets; no timeout increase, RLS disabling or permission-result mocks.

Run the affected selectors in the adjacent qualification manifest, compiler and
Linux build on standard hosted Actions. Inspect actual failures before changing
code or budgets. Then qualify browser pages and remaining audit-producing owners
under the parent worker harness. No local application checks, runtime, compiler or
build were run for this candidate. Source review and tests being prepared are not
executed results or release acceptance.
