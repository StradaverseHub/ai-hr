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

## Hosted fixture recovery after1b78

Original focused run42509856754 at1b78/controller00a27 completed its planned batch with failures. Its Node report recorded90PASS/2FAIL; the separate DOM viewport failures remain outside this correction. Full artifact authentication belongs to the independent CI owner. No original failure is relabelled.

The existing SQL-inventory case selected the actual final3500 wrapper but incorrectly required3200's historical ALTER RENAME there. Its rename assertion now names3200; a closed468-byte comparison requires the final CREATE OR REPLACE wrapper's complete FUNCTION definition to equal the installed3200 oracle. Added source assertions cover native MD5/owner/ACL/OID/attribute custody; the original delegation/centre-stop/inventory checks remain. No generic SQL parser or filename waiver is introduced.

The new KL-boundary fixture's reported-zero row used the helper's default openai provider. The actual23514 cause was ai_model_run_observation_fields:0625 permits reported accounting only for openrouter. Only that fictional zero row now overrides provider to openrouter; every zero/missing/day-boundary assertion and the native constraint remain unchanged. No provider request occurs.

This recovery changes two test owners only, retaining all6 existing contract cases and16 expanded projection cases, their caps, and all other callbacks. Its parent source index is retained by exact1b78 Git commit/blob/hash/byte provenance; current hashes and the small recovery record identify the new source without duplicating historical contents. Product, SQL/journal, authority, approvals and all DOM files remain whole1b78. The corrected source is unrun pending root and independent peer review; no retry, browser or release claim follows.

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

## Composition of the reviewed recoveries

This normal merge preserves the exact Node-fixture recovery and mobile/client-fixture recovery bytes and both parent histories. The preceding recovery sections and their qualification records retain their original source-authoring claims. Their later hosted observations remain separate: f97 run42511453856 passed22 Node cases, while85de run42512334101 passed68 DOM cases, each with controller00a27 and its own source. They are not90 fresh passing cases on this composition. The original1b78 failed course remains preserved.

The aggregate source is UNQUALIFIED until its actual current import graph, source bindings and relevant controls are reviewed and exercised coherently. The shared management-sections leaf remains absent from the Employee source arrays observed in these lineages; the isolated component array has3447 members, while the separately observed root has3474. Their active restoration rows and source/count metadata need a separately leased root integration after the pending shared-prerequisite composition. No CI/source-array repair, admission, browser keyboard journey, staging or release qualification is performed here. Production remains held.

## Page active-model correctness

Source review found a distinct active-versus-pending display defect: when OpenRouter model A is active and model B is saved as its candidate, the settings form overlays B into its editable `model` while retaining A in `activeModel`. The page common status previously selected that editable B after validating the usable active A. Company administrators already received A.

The page-purpose common provider/model now uses only the already validated active resolver result. The full three-argument compatibility API retains its existing selection, and the Provider form continues to show pending B and active A separately. All configuration reads, principal proofs, locks, isolation, provider snapshot issuance and command/native owners are unchanged. This correction does not implement the separate RR/RO presentation design.

One new fictional native case seeds an encrypted preexisting active A, saves B through the existing group command, and independently checks the actual app-role active/candidate native functions. It asserts A on all eight group/company page purposes, the explicit compatibility/form distinction, and no display-created run, reservation, evaluation, audit or provider/network call. All preceding22 Node cases and their assertions remain intact. The new case is authored, not executed; prior source-specific passing and failed courses retain their original identities. Source/data review and affected hosted verification remain required. No migration, disclosure approval or release authority is renewed.

## Stored active-row decoder boundary

A separate enabling slice moves only the stored active provider row's CPU validation/decryption into `core/ai-provider-row.ts`. Its sole exported function returns a frozen decoded configuration. It performs no database read, environment fallback, principal proof, snapshot issuance, provider call or command admission. The existing server/core import boundary is retained; no new `server-only` package condition changes the native test load path.

The original active snapshot owner still performs its principal proof, native v2 query, cardinality refusal, missing-row-only environment fallback, origin fingerprint, WeakSet issuance and request/principal/time binding. The fingerprint retains the same first five origin inputs and the same normalized options, gateway address or empty object, now taken from the exact decoded result. Candidate, baseline, feature-purpose, freshness and actual current-configuration checks remain byte-for-byte unchanged. All native SQL, grants, locks, isolation and command behavior remain unchanged.

The existing snapshot fixture retains all10 original expanded cases and adds11 authored controls: five actual stored providers with independently expected decoded values and origin fingerprints; four native legal-but-unusable rows that must refuse despite a working environment key; absent-row fallback and no-row/no-key behavior; and one table of strict CPU refusals/normalization. Invalid options/models that storage constraints prevent are tested at the CPU boundary without weakening those constraints. The new cases guard all provider/fetch entry points and show that a decoded value cannot become an issued snapshot. Legacy synthetic transport cases keep their original guards and behavior. These are source-authored controls, not passing results.

This does not add a presentation route or RR/RO authority. The new leaf/import edge requires coherent source-graph and disclosure binding review before adoption; no existing approval is renewed. The former whole-protected snapshot pin becomes explicitly historical, its current source and exact whole-parent inverse are recorded separately, and all five existing product inverses remain unchanged. Root and independent source/data review precede hosted verification. Production remains held.

## Common page snapshot preparation — not an installed feature

The common page `status`/`allowances` purposes now start actual Repeatable Read / Read Only at BEGIN. The existing full three-argument API keeps its configuration read, current RC principal/Access barrier, active resolver, native RC spend query and isolation. One query/derivation body still owns feature/allowance precedence, usage, attention, quiet zero caps, group memberships, ordering and limits. Allowances keeps its top-user/budget facts in that same page snapshot. The page provider is the active v2 row validated through the extracted decoder, never a pending candidate or issued command snapshot. SQL/native errors propagate and roll back; only CPU-invalid stored data becomes unavailable, with no environment fallback for a present invalid row.

The page proves the native snapshot principal and native administrator scope before facts. Group spend uses a new RR/RO-only native ABI and the exact mapper shared with the old RC service. Company reads return no private spend, candidates or group users. No role/grant result cache, trusted/readOnly bypass flag, fake Assistant module gate, effect admission, provider call or global Stop/RC-actor relaxation is added. The full/bulk/preview/provider/command owners remain intact except the explicitly extracted pure status mapper.

This SOURCE branch needs an unallocated native append and is deliberately UNQUALIFIED. Its proposed native implementation exists only as private JSON review data: strict RR/RO group predicate, metadata-only candidate view, SELECT policy addressed ONLY to the guarded relation-owner role, two private VOLATILE monetary fact helpers, and guarded delegation by the original two RC status wrappers and the new presentation wrapper. The base payload and final0678 nonprobe/unknown extension each have one fact owner. New private functions receive no app/PUBLIC EXECUTE; no ciphertext/table grant, role creation or BYPASS is introduced. Native predecessor/postimage guards and namespace-wide all-overload absence checks are unresolved until the central migration reconciliation selects the baseline. Actual710 and future pending principal bodies are different evidence. No executable SQL, migration filename, journal tuple or timestamp is added here; missing/drifted ABI must fail rather than fall back to RC.

The original17 projection names and fact/DTO oracles remain. Three callbacks explicitly adopt page RR/RO and a closed authority census: ordinary group full reads have21 authority statements versus5 for the page, plus the unchanged one/three detail omissions; company authority drops10 to4. These are source-derived assertions checked against actual future native observations, not measured results. The legacy RC mode/census remains asserted. Nine new authored native cases cover four native modes, zero/null/unknown/probe accounting, owner-only metadata/ACL refusal, held Access commit/rollback and raw Stop writers in both start orders, after-snapshot scope revocation and stale command refusal, actual DML/SQL rollback, and Stop snapshot facts versus unchanged live command denial/resume. Fixtures use the existing app/owner pools; the native mode matrix opens no extra driver pool. Instrumentation only bounds native lock wait and observes actual modes/PIDs/advisory locks; it substitutes no principal or permission decision. No provider transport is permitted.

The populated-upgrade fixture remains a concrete private plan because no accepted executable append/baseline exists. It cannot be replaced by a placeholder/skipped passing test. Real non-super owner LOGIN, actual historical preimages, stock whole-batch rollback/no-op, drift/ACL/business postimages and bounded cleanup still require implementation/review once allocation is resolved.

This slice closes only the common read owner. Provider form, Workers child reads, Assistant provenance/erasure, bulk preview and coherent optional-panel composition remain separate leases; the whole React tree is not one snapshot. Existing optional SQL failures must retain separate cohorts or real savepoint rollback. No all-eight-GET, browser/keyboard, load, zero Busy, blocking-lock, native-upgrade, staging, provider-disclosure or production PASS is claimed. Source graph and approval bindings remain open until the coherent aggregate is reviewed and qualified.


## Common PAGE recovery after a previous entitlement query failure

A source review found that the new PAGE snapshot replaced its entitlement data after a successful same-transaction resolution but retained the session's earlier `entitlementsError`. The canonical entitlement owner prioritizes that error, so scheduled feature, module and attributed-switch derivations could still fail despite current readable data. PAGE status and Allowances purposes now clear that old error only after the actual resolution succeeds. The full three-argument API retains its historical context/error behavior; the separate RC Assistant-status owner, all native admission, provider/spend owners and commands are unchanged.

Two appended fictional native controls cover a real app session carrying the previous error and no cached snapshot, independently expected current feature/switch facts, current module and canonical switch changes, the unchanged legacy FULL refusal, and a genuine resolver SQL lock-timeout followed by rollback settlement and a fresh successful PAGE read. Existing nine common native cases and seventeen projection cases retain their names, bodies, assertions and caps. These additions are authored UNRUN: the common native ABI remains private/unallocated with unresolved baseline guards, and no current source/provider/disclosure approval or eight-route/rendered qualification follows.


## Common recovery fixture follows the existing PAGE switch DTO

Source review of the unrun `ab8e5f1843a0102ad9f1fe04c936147cdcd49c69` recovery child found that its first new control asserted the native switch array's user/event fields on the PAGE's keyed display DTO. The fixture now checks the actual `agentSwitches.claims_triage` value: attributed state, independently queried fixture actor label and canonical event timestamp, or the off state alone. A separate real app RR/RO transaction first proves the native presentation principal and checks the native switch owner's user/event attribution against that independently read event. Product DTOs, disclosure, authority and all production bytes are unchanged.

The `ab8` source record remains whole historical evidence. The genuine resolver SQL-failure case, original nine common native cases and seventeen projection cases remain whole with the same names, assertions and caps. The same ten registrations/eleven common cases are authored UNRUN; no native ABI allocation, hosted result, source approval or release qualification is claimed.
