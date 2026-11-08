# Nested navigation composition and honest runtime coverage

Status: Proposed; design review required before renderer or protocol changes.
Date: 8 November 2026.
Deciders: architecture owner and independent reviewer.
Source: `04c478818ac8dcadfee0c63377de844898953b22`.

## Context

The user requires fast, usable navigation across every module and submenu while retaining permissions, history, money and current behavior. The present `NAVIGATION_COVERAGE_BACKLOG` correctly blocks universal runtime acceptance. Its six examples are not the full work list. The current catalogue's 222 declarations describe published shell/static destinations, not every nested panel or record-specific destination. Existing v2 captures describe a smaller fixed scenario set; their provenance and outcomes remain unchanged.

The accompanying [owner inventory](../qualification/nested-navigation-owner-inventory-20261108.json) freezes 46 source families, 258 renderer candidates and every one of the 120 parameterized `app/**/page.tsx` owners at this source. It binds 394 exact source hashes. The census spans all 2,113 TSX files in `app`, `components` and `packs`, with a digest of ordered path/hash pairs. Lexical signals locate review candidates; they are not an execution oracle or proof that every possible interaction has been exercised. Dynamic routes without an advertised menu remain explicit obligations, including command forms, aliases, downloads and invitation/operator realms. The expanded generic-carrier census includes callers whose component name contains Navigation/Tabs/Steps; a name match can also be a nonvisual unsaved-change adapter, so it cannot establish a leaf. They are not silently counted as usable menu leaves.

The static inventory is finite in **source families**, not record cardinality. A thousand employees do not create a thousand menu definitions. A record selection still needs actual native identity, scope and usable record content for the selected fixture. The inventory records unexecuted/unbound obligations explicitly. It does not clear the backlog or authorize release.

## Source owners and preservation requirements

The JSON is the exact machine-readable owner list. This table identifies the main semantic seams and required composition; it is not a replacement registry.

| Family | Canonical choice/address owner | Required preservation |
| --- | --- | --- |
| Personnel record | actual `tabs` supplied by `[employmentId]/page.tsx`, generic `ClientTabs` | Ten actual tabs; `PersonnelTabKey` has eleven. Preserve all mounted panels, dirty guard, `selectRef`, submit tab carry, history state and save scopes. |
| Draft Personnel | `DRAFT_TABS` in `lib/employee-draft-schema.ts` | Five choices; retain persisted `current_step`, missing-field jumps and activation gates. |
| ESS profile | `ESS_PROFILE_TABS`, profile editor keys and `profileHiddenTabs` | Eleven positional choices before native policy filtering; do not widen self-service fields or hidden panels. |
| Personnel movement | `movementPageHref`, `movementHistoryHref` | Current employment/event ownership, corrected history and `from=org`; opening form never submits it. |
| Company edit/view | `COMPANY_PANEL_TABS` | General/Bank/Statutory; separate readonly route and statutory authority screen; original encoding, guards, mounted state and write scopes. |
| Schedule Group | `SCHEDULE_GROUP_SECTIONS`, `scheduleGroupSectionHref`, actual group sections | Seven choices, four built. Holiday/Request/Notification remain intentionally unsupported. Preserve both query and fragment plus keyboard selection. |
| Attendance policy/workflow | schedule-panel and approval-workflow `navigation.ts` | Existing visible-company resolver, repeated/foreign query refusal, panel precedence and native lineage. |
| Leave Type | actual five keys in `leave-type-tabs.tsx`, workspace picker | Local storage merge, legacy keys, `openTab`, archived selection and independent forms; do not invent a tab URL. |
| Leave adjustment/generation | Actual STEP_KEYS and SubStepBar callers | Four adjustment and five generation panels, legacy stored-key remaps and native preview gates; visiting Process does not execute a grant. |
| Leave Config | `LEAVE_CONFIG_MAP`, screen/record builders | Original grouping and configuration/balances records; retired labels are not destinations. |
| Probation preparation | `PreparationNav` and actual `canPrepare` caller | Six company-bound routes; original capability check remains at its owner. |
| Probation case | native `view.parts` plus part editor | Exact case/part/cycle; employee/LM panel and dirty/signer/evidence guards; letters/outcomes/files are typed record links. |
| Contract management | `ContractNavigation` and native case detail | Cases plus conditional Templates/Settings/Intake; preserve native authority, current path and record states. |
| Lifecycle legacy | actual `_ui.tsx` tabs, admin TABS | Level gates, six settings tabs, nested module/subkind/company distinctions. |
| Lifecycle V9 | `V9_NAVIGATION`, `V9_SHARED_NAVIGATION`, actual client owners | Nine plus two route choices; module selectors, checklist/template/workflow record pickers, steps/runs, mine/teams/done and content/fields/preview panels. Preserve native filters and modal/dirty behavior. |
| AI management | `AI_MANAGEMENT_SECTIONS`, `availableAiManagementSections`, `aiManagementHref` | Eight sections; use actual `hrefOf` overrides, provider/spend visibility, q truncation and anchor context; no generation-capable calls. |
| AI guidance/assistant | centre registries, HOW_CHAPTERS/HOW_STEPS, assistant native flow and action registries | Work/calendar and guidance panels, actual private saved histories, exact flow addresses; no provider call, approval renewal or sensitive action. |
| Performance admin | `adminSections` → tabs → `visibleAdminPages`; native href helpers | Full hierarchy, real cycle routes and hidden report pages. Never fabricate the hidden report query. Native cycle/module policy continues to govern content. |
| Performance workspace | `resolveWorkspaceSelection`, tab-route model and actual href function | Views/modules/stages, locked choices, cycle/item/return context and native review/feedback/calibration selection. No unfiltered Cartesian product. |
| Performance records/talent | personal-record and talent/leader owners | Current versus historical tabs/plan year, four talent-person panels, board/leader population filters and dirty confirmations. |
| Payroll | Pay Schedule/Cycle builders, transaction view and individual workspace | Company/cycle/q carry; six transaction views (History default), actual employee/period/history content. Navigation never executes close/reset/reprocess/remove. |
| Formula builder | actual method/test/help owners | Write/Conditions, Sample/Employee and help panels preserve raw draft and evaluation boundary. No evaluation or formula apply implied. |
| Rewards | actual unit/access/approval owners | Unit view/annual/gr branches, matrix/list/groups and native record selectors; original budget/approval/financial behavior unchanged. |
| Settings | System Labels kind owner, actual Profile Options categories, Access native group list and dashboard section owner | Preserve category/record paging, dirty rows and Save scopes; no copied access policy. |
| Movement settings/JD | actual route, anchor and editor owners | Types/Reasons, conditional section anchors, four JD panels and native version history; no generation/save. |
| Letters | `LETTER_NAV_ITEMS`, native `visibleLetterDestinations`, register owner | Company-bound Issued/Ready, actual letter/template/version/batch; no signing/issue/generate. |
| Home/team/org | actual workbench data and My Team employee panel | Attendance/Leave Balance/Roster and current manager relationship; unavailable sources cannot qualify healthy content. |
| Operator | operator shell/customer owner | Separate actor realm, unseeded in the four HR roles; never impersonate operator or grant access to complete matrix. |
| Mobile preview | preview shownNav/screens/composition owner | Desktop preview only; no native mobile API/device qualification or design publish implied. |
| Queues, imports and account | Actual task/approval/feedback/testing views, import/history owners, native notification/account controls | Preserve category/recipient/record authority; no approvals, imports, notification writes, logout or test execution implied by traversal. |
| Secondary controls | containing source owner | Paging, dates, search, status filters, disclosure, breadcrumbs and form pickers remain visible obligations, not inflated destination counts. |

## Decision

### One fact owner, one renderer projection, one catalogue projection

Use small neutral descriptor modules per surface. Existing neutral registries remain canonical; augment them only with explicit stable descriptor metadata. Where choices are currently inline, move the exact choice tuple to a narrow module consumed by the original renderer and the catalogue. The renderer continues to own labels, translation, visibility filtering, default selection, conditional composition, query/context builders and actions. Do not move server authority to the catalogue. Do not make a client renderer import the whole application catalogue or a large translation union.

A descriptor contains an explicit semantic ID, source owner, surface ID, choice key, presentation kind and typed parameter requirements. Route templates, panels, anchors, record pickers, controls and unsupported choices are different kinds. IDs are written explicitly by the source owner; they are never calculated from a URL, translated label, array index or a mutable fixture UUID. Reuse the current key unions rather than introducing another vocabulary.

Parameterized families resolve through the canonical builder with a **validated native fixture binding**. They do not concatenate a caller-supplied URL. Record instances are keyed separately from the stable definition. A descriptor is not a permission, a service capability or evidence that a destination is visible. Actual page/session/native owners still resolve allowed and hidden choices. Alias placement does not create a second leaf definition.

For generic carriers (`ClientTabs`, ScheduleGroupTabs, record pickers), concrete callers supply descriptor identity with their existing ordered choices. Generic primitives have no global leaf IDs. Metadata attributes expose only static surface/choice identity and the existing DOM panel relationship. Do not put private user/session/capability data in attributes. Nested instances must be scoped to the actual visible native record container; duplicate/unscoped matching refuses.

### Preserve behavior before adding coverage

Client panels remain mounted exactly as they are today. Keep existing `history.replaceState`/state flags, local storage, submit hidden fields, imperative selection, tour reveal, keyboard controls and unsaved-change prompts. Do not replace a client panel with a route or remount forms for simpler tests. Opening a tab must not run business mutations; methods with an existing command boundary remain commands. Preserve separate Save scopes, default tabs, conditional order and readonly displays. New descriptor tests must compare the **rendered** choices, addresses and panel state with independent expected contracts, including i18n, not merely search a moved file.

Schedule Group's three not-built panels remain explicit `unsupported` definitions. Their visible placeholder can be checked for honest status, but cannot satisfy an applicable built leaf's usable-content proof. Hidden and intentionally denied choices are recorded with their actual owner rationale. `unseeded`, `uncovered`, `unsupported`, `not-applicable` and `denied` are different outcomes; none is a healthy usable leaf.

### Versioned runtime interaction contract

V2 currently rejects queries/fragments and has only an `open-details` interaction. It cannot truthfully represent these surfaces. Add a separate v3 contract after review, retaining v2 source/receipt identity and validators. Never reinterpret historical v2 observations as nested navigation coverage.

V3 has closed interactions: follow a canonical resolved choice, select a named client choice, follow a typed record choice, and open an existing disclosure. Query/fragment equality is validated against the resolved canonical builder and exact parameter allowlist, including repeated/unknown parameter refusal. No arbitrary evaluate/script/selector/program step. A client click proves its actual `aria-selected`/active relationship, unique visible panel and meaningful native data/control; it does not require a network response or invent HTTP 200 for state-only interaction. Anchor-only choices prove a real target and its content. Route choices prove the final canonical address and usable content. Hidden mounted panel text cannot satisfy another tab.

Keep one remaining-time budget of **90 seconds per scenario**, current failure observation and original strict performance limits. Wait for streamed controls and panels inside that budget; assert uniqueness and actionability before clicking. No timeout increase, retries that hide failure, additional workers/actors, duplicated existing journeys or new independent resource pool. Record source/descriptor/fixture/scenario/harness/run/attempt/role and interaction evidence in authenticated captures. `releaseAuthorized` remains false. Live GitHub/controller/source/artifact verification remains the receipt trust boundary; candidate JSON cannot authenticate itself.

Keep exact unique signed-in account-button identity and native record identity separately. A matching employee name elsewhere on the page does not prove either. Require the expected employee code/company/record facts and current native permission results. Wrong tenant/company/employment/record/part/version/role, archived/revoked/unknown records, stale bindings and forged selector/ID pairs refuse or remain uncovered. Do not infer permission from a redirect, HTTP result or descriptor presence.

### Native fixture and role matrix

Extend existing fictional native fixture helpers, not a second seed policy. The current text projection proves allocation shape, not native authority, and exposes no sufficient record bindings for most new families. Add a closed binding union only for native records actually created/verified by their canonical domain helpers. Keep secret fixture files private and evidence minimized. Never create real HR data, call a provider, disable RLS, grant broad access or claim a caller JSON `rowsVerified` flag as fresh authority.

For each applicable family/choice, enumerate four original HR roles and actual native availability: usable/read-only, hidden/denied, unsupported, unseeded or outside actor realm. Give each usable case independent expected nonempty content and an enabled safe control; valid empty controls are an explicitly weaker readiness state and cannot replace required seeded data. Hierarchical choices use actual permitted parent context; no guessed full cross-product. Finite repeated record classes need at least own/current, second allowed company where legitimately available, historical, and foreign/unknown/revoked refusal controls as applicable. Native permission source remains the business owner.

Existing 1,024-scenario/8-step/16-check limits remain until the resolved matrix is computed. If the complete matrix does not fit the current steady-window capacity, report capacity refusal and propose reviewed bounded scenario batches using the same frozen workload protocol. Do not expand a budget, skip a role or substitute a global union for per-role obligations. Baseline and actual active500 steady-window execution are both required for the claimed scope.

## Alternatives and tradeoffs

- Merely adding URL strings to the catalogue is quick but loses client state, native context and hidden branches; reject.
- Centralizing all menu/permission policy creates another business authority and a large client/compiler dependency graph; reject.
- Discovering links from arbitrary DOM/translated labels cannot provide stable source identity or fixture authority; useful exploratory evidence only, not acceptance.
- Small owner descriptors add explicit extraction/behavior checks but preserve one canonical fact and allow future source drift to fail closed. Choose this option.

## Implementation sequence and ownership

1. Review this design and exact inventory. Keep the existing backlog unchanged. Root chooses the integration base/lease before application edits.
2. Compose existing neutral registry families first (Company, Schedule, Leave map, V9, AI and Performance admin) without altering their guards/builders. Add independent rendered parity tests and metadata-only markers.
3. Extract inline client descriptor facts in Personnel/draft/ESS, Leave Type, lifecycle/client and remaining inventoried owners, preserving exact current tuple/order/branch and generic-carrier behavior. Keep every census record mapped to a concrete owner or a reviewed non-leaf/excluded rationale; new matching sources fail the coverage inventory until triaged. Root reviews each coherent extraction.
4. Implement v3 typed resolver/fixture bindings/capture interactions with negative source/role/record/query/identity/panel models. Retain v2 tests and exact prior receipts. Coordinate **before** editing root-owned system-load integration; this task owns navigation helpers/scenarios only.
5. Hosted native fictional fixture and rendered behavior checks; then actual authenticated browser baseline plus loaded500 execution of the resolved bounded matrix. Do not clear `NAVIGATION_COVERAGE_BACKLOG` until every source family and applicable native branch is composed; do not declare runtime acceptance until every required executed obligation passes.
6. Root integrates with complete correctness/compiler/build/worker tests and guarded staging release. This design performs no deployment and grants no production authorization.

## Required focused proof

- Descriptor/renderer parity: exact choices/order/default/conditional visibility, translated labels, href encoding/context and aliases; missing/new/duplicate ID and owner drift fail closed.
- Actual client behavior: select every panel, confirm unique visible usable content, hidden-panel spoof refusal, preserved dirty fields and Cancel/confirm navigation, mounted state and hidden-tab form carry, keyboard behavior and existing tour selection.
- Parameterized navigation: actual native allowed records, own/foreign/unknown/archived/revoked cases, historical context, repeated query/hash encoding, record mismatch and stale permission refusal; no authority copied into fixture resolver.
- Three not-built Schedule Group choices, hidden Performance report and separate operator/invitation realms remain explicitly unsupported/unseeded until their respective native proof exists.
- Capture trust/limits: no v2 relabel, forged native JSON/identity/source/run/artifact refusal, exact role/steady500, deadline failures, Busy/500/crash/unavailable observation and no arbitrary browser commands.
- All new builder/test/compiler/browser execution runs on standard hosted Actions. Static source inventory and hashes here are not tests. No local behavior checks have been run.

## Consequences and open gates

The catalogue can become complete in source without becoming complete in runtime. This distinction remains explicit in the ledger and command-line result. All 46 proposed families are currently runtime-unexecuted in this slice; 120 dynamic page owners are an obligation census, not 120 advertised or authorized destinations. Final leaf/scenario totals are intentionally not guessed. The current backlog remains live, all six architecture phases remain open at the root, worker comparisons and staging remain gated, and production remains held.
