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

## Workers display services in a supplied snapshot

The Workers service slice adds explicit page DTOs for the four visible built-in statuses, registry rows, agreement metrics, outcome family totals and conditional worker detail. Each exported page reader verifies the actual supplied Repeatable Read, database-enforced read-only transaction and native calling principal; group-only readers also verify the native group role. Calling context is captured before suspension and entitlements are read afresh in that transaction. These are display services, not a new HTTP endpoint or an issued authority object.

Provider usability and attributed specialist switches are ordinary render facts supplied by the common reader in the same transaction. They neither prove that transaction nor admit execution. The page services do not issue a provider snapshot, call a live running gate, execute a provider, cache permissions, or alter Stop, generation/CAS, command, review, audit or accounting owners. A decoded provider row is still not a governed execution configuration. The existing full APIs retain their contracts and execution prerequisites.

The fixed20-worker list reads switch controls and job enablement in batches, mandate state inputs once, and last-run values in five queries, one per record kind. The old last-run answer is already MAX(timestamp); filtered aggregates preserve each exact tenant/RLS, identity, tool, job, proposal-type, loop or event-source predicate. They do not select a tied record or replace any ordering rule. Detail retains each original recent20 ordering, internal follow-up linkage and latest-decision rule, while omitting unused record payloads, grantor facts and the recomputed full worker row. Summary preserves the tool-based worker discriminator and native private-to-asker visibility while reading only the fields required for record and family totals.

Shared pure owners retain the full services' sweep query, proposal-rate arithmetic, tested-closure reversal blanking, tool/source predicates and summary join/scope. The page agreement purpose refuses tested-closure metrics rather than fabricating their classification. Current Workers uses only anomaly narration, claims triage and readiness proposal rates; blockers and recurrence classification are not rendered. The full agreement service still reads those facts.

The new fictional native fixture contains18 registrations expanding to28 authored cases: full visible parity across20 workers and five record families; actual query batching and omissions; null denominators; encrypted and broken keys with zero egress; native group/company scope and stale, revoked, blocked or mismatched identities; mandate boundaries; captured mutable inputs; MVCC revocation; reads behind held Access and Stop writers through commit/rollback; enforced read-only refusal, cancellation and rollback settlement. Existing test files and their callbacks remain whole. These controls are UNRUN: external source parsing and whole-parent comparisons are not runtime verification.

This slice does not compose the page route, inventory or rendered controls into the supplied transaction. Workers/Teras policy, helper and control metadata still require their own bounded native catalogue custody check; the earlier common41-function survey does not cover them. Root and independent full source/data review, coherent current source/disclosure binding and affected hosted verification remain required before integration or qualification. No migration is allocated, no eight-route nonblocking result is claimed, and staging and production remain held.

## Workers presentation refresh recovery

Independent review found that the two new Workers presentation refresh results replaced `entitlements` but retained an earlier session `entitlementsError`. The entitlement owner correctly refuses that contradictory context, so a successful current database read could still fail a billable-module check. The presentation readers now follow `core/module-presentation-read.ts`: only after the actual native principal/group admission and a successful awaited entitlement resolution do they construct a fresh result with `entitlementsError:undefined`. Supplied context, failed resolution behavior, full legacy RC APIs and all commands remain unchanged.

Five additional native cases independently specify all four built-ins and fresh context attributes for a prior-error session without cached entitlements, a current module disabled after an enabled snapshot, foreign/revoked refusal, and actual entitlement SQL failure through both refresh owners with awaited rollback and subsequent recovery. The SQL-failure fixture uses a transaction-local search path to make the real entitlement query fail; it neither mocks the resolver nor substitutes an authority result. All previous28 cases and callback bodies remain whole. The combined33 cases are authored and UNRUN. Original source evidence stays attached to its exact commit; the bounded repair record preserves the whole parent preimages. Native Workers custody, current source/disclosure binding and route/runtime qualification remain open. Staging and production remain held.
