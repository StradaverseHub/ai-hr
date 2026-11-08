# AI management page projections share the full read owner

Status: source implementation; hosted verification and integration pending.
Base: `cd47c63c77d26431ee33de38b75790c62924a1ad`. Production remains held.

Every AI management section previously requested the full management API. Its
user query ranks usage over every matching login before returning 51 rows. Only
Allowances renders that list or the legacy assistant budget. No current section
renders the API's recent-50 run list: Runs already owns dated, paged history.

The existing three-argument `aiManagementView` remains the full API. One private
query/derivation owner serves it and a new closed page-purpose reader. Allowances
retains its exact user/budget reads; seven other sections omit those reads. Every
page omits the unused recent-run read. SQL templates, ordering, limits and
derivation of retained reads are unchanged. The membership lookup naturally
shrinks to every attention actor when the unused visible-user list is omitted;
no actor needed by attention is dropped. Full API consumers retain their
existing users, recent runs, filters and legacy budget.

The page result is a discriminated DTO. Common state remains present. Only the
`allowances` section returns allowance details; other sections return a null
allowance detail, and legacy run/filter fields are absent. Inventory and alerts
accept the six common display fields they actually consume, through a type-only
narrowing. They do not receive a fake empty full result. The eight existing section
values and order live in one pure shared leaf, re-exported by navigation; paths,
availability and links retain their existing owner and behavior.

Actors and failure behavior remain:

- Group administrators retain current native principal/group verification,
  provider-key usability, all attention users (including quiet zero caps),
  complete group precedence, switch attribution/drift, and spend visibility.
- Company administrators retain their native company scope; the page reader does
  not grant group user/run/audit/private spend access. Existing unavailable-section
  redirects remain in the screen.
- Employees, foreign/mismatched carriers, revoked/archived/blocked logins still
  fail the existing authority checks. Unknown page purposes fail before SQL.
- No command, Stop generation/CAS, grant, audit, provider snapshot, accounting,
  transaction isolation or access-lock owner changes. Current management reads
  remain Read Committed/read-write and can wait behind an Access writer. This
  slice does not establish nonblocking display reads or zero Busy under load.

The Workers timing course now includes its actual registry Promise.all cohort,
conditional selected-worker query, controls, inventory and alerts. The controls
component's identical three-result Promise.all is extracted into an ordinary
server read helper; query order, independent catches and output stay unchanged.
The module gains no `use server` directive or client-callable action. Translations,
React/JSX, session resolution, RSC serialization and network remain unmeasured.
Incomplete/retired R8 courses stay clearly marked historical. The hypothetical
overlap calculation is arithmetic, not proof of lock/concurrency feasibility.

Proposed native controls cover all eight page purposes for group/company admins,
independent cap/held-token/group-tier facts, Kuala Lumpur boundaries, reported
zero versus missing accounting, encrypted fictional keys and broken-key refusal,
authority failure paths, input capture, and actual native query/transport counts.
The scaled course uses full/page/page/full ordering and asserts exact visible DTO
parity. All provider adapters and fetch are guarded and counted at zero. These are
unrun controls, not a speed percentage or browser/load result. Existing full API,
inventory, principal, navigation and affected rendered fixtures remain verification
obligations; no prior result is relabeled onto this source.

The new shared leaf is an actual runtime dependency of the Employee source owner
through existing management/navigation imports. Its static source binding needs
coherent integration review; this slice does not silently claim the previous
member count or global source qualification. No CI registry/framework is changed.

## Recovery of captured mobile overflow and fixture translation context

The complete course on source `1b78bee247e47c8d9ae85209bb3b0e852aedb321`
(run `42509856754`) settled with 190 of 198 cases passing. The eight failures
remain historical failures: six How it works mobile captures and two unrelated
DB source-fixture cases. No successful result transfers automatically to a child.

All six How desktop captures fit their 1440px viewport. Their mobile captures
report overflow at 390px and produce 454px-wide full-page PNGs. The mobile CSS
requires 44px button targets, but the nine step targets occupy one nonwrapping
strip. Nine targets plus the step panel padding/border and page inset account
for the captured width. The How fixture already merges its separate AI Centre
catalogue; its translation context is not the cause of this overflow.

The step section now permits shrinking within its grid track and constrains its
width. Its tablist wraps within the panel. All nine targets, the global touch
minimum, keyboard and playback handlers, reduced-motion behavior, captions and
step state remain unchanged. No overflow clipping or screenshot tolerance is
introduced. Existing six-locale desktop/mobile captures remain the regression
check; rendered success is pending hosted execution.

Separately, five other DOM fixtures supplied merged messages to mocked server
translations while their client providers supplied only base catalogues. Their
client mounts now use the existing `withAiCentre` or `enWithAiCentre` helper to
match the server. Locale matrices, data owners, assertions, captures, production
catalogue loading, permissions and query/command behavior are unchanged.

The source-failure/correction record identifies exact parent Git objects, small
reversible source substitutions, protected owners and the original failed course.
It is non-runtime review data, not release evidence. Source review by another
reviewer and affected hosted recovery are required before composition/adoption.
Browser preflight, worker/load qualification and staging remain pending;
production remains held.
