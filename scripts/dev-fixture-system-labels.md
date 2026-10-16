# System Labels browser fixture — original item 6d26c915

Preparation only. The fixture never applies a workbook, creates a Global/multi-company label,
adds a collision exception, changes a legacy sharing flag or asserts browser acceptance.

## Coordinated launch and preservation

After the reviewed generic coordinator and this fixture are integrated into one clean candidate,
the coordinator's closed entry is:

```sh
node scripts/dev-browser-original18.mjs --scenario=labels
```

The coordinator owns both test slots and the development DB lock for the whole server lifetime.
It migrates **only** `ai_hr_board18_labels_browser` on localhost:5433, does **not** demo-seed it,
then invokes `scripts/dev-fixture-system-labels.mts` twice before starting port **3198**.
The fixture accepts no arguments or generic target overrides; namespace must be `board18labels`.
`LABELS_FIXTURE_COORDINATOR_PID` must equal its actual parent PID, and
`LABELS_FIXTURE_COORDINATOR_CANDIDATE` must equal clean repository HEAD. All three named lock
owners must be live ancestors. App URL must use restricted `ai_hr_app`; migration URL must
use a separate actual role on that same named local database. Never print either URL.

Only an empty migrated target or the reserved `System (auth audit)` tenant is accepted initially.
Canonical provisioning creates exactly `Labels18 Primary (fictional)` and `Labels18 Foreign
(fictional)`, country MY, **no commercial modules**. All business rows go through canonical owners;
direct owner writes are limited to fictional login/grant/onboarding fixtures. Activation links
are discarded. A partial setup, unknown tenant, altered receipt/artifact/candidate/date or second-run
state drift refuses rather than resetting anything. A rerun after browser edits intentionally refuses.

Private receipt: `scratchpad/board18-labels/fixture-manifest.json` (0600), artifacts in `files/`
(0700 directory/0600 files). Stdout marker is `BOARD18_LABELS_MANIFEST` followed by the same JSON
plus `reused`. The second clean run preserves every identifier and artifact. It compares a bounded
read-only snapshot hash; no credentials/invitation tokens are exported. Pools close and the process
exits naturally under the coordinator watchdog. Stop through the owned coordinator, which stops
only its recorded child process group and releases its own locks; never kill a port occupant.

Resume must **not** rerun preparation or compare mutable label state against the setup hash.
Use the generic coordinator's owned resume controls after independently verifying its saved
manifest/process/candidate. `system-label-fixture-contract.mjs` provides the side-effect-free
`systemLabelFixtureSourceProof(root)` static source fingerprint. Compare that proof and crossbind
actual app_user/person/tenant/login/grants and company identities; preserve intended UI edits.

## Actors and visible paths

All exact IDs and actual `login` subjects come from the receipt, never an inferred login pattern.
Set the dev login only through the coordinator's existing local role control; this is not an
external-authentication or installation-operator proof.

| Manifest key | Canonical authority/context | Intended observation |
|---|---|---|
| GroupHR | Actual provisioned admin Person/login, sole tenant-wide hr_admin grant; no employment | Common library, Global and Main+B criteria, import, future-company behavior |
| ScopedHR | Main employment, hr_admin grants exactly Main+B | Authorized changes only, Global read-only/creation refusal, Hidden refusal |
| EmptyHR | User only, hr_admin exactly Empty | Honest empty four-org-list state; tenant-wide catalogues can still exist |
| Manager / Employee | Main employments, scoped manager/employee respectively; canonical reporting edge | Admin route denial and authorized Personnel/own-profile picker visibility |
| BEmployee / HiddenEmployee | Real B/Hidden employments, own company employee grant | Distinct company downstream references |
| Operator | User only, operator/null; no HR grant/person/employment | Installation role must not confer System Labels HR access |
| ForeignHR | Actual foreign tenant provisioned admin | Primary tenant records remain inaccessible |

Routes: `/admin/settings/system-labels`, `/admin/settings/system-labels/profile-options`,
`/admin/organization`, `/admin/personnel`, `/admin/personnel/new`, and actual existing Personnel
`/admin/personnel/{people[key].employmentId}?tab=employment` (the route parameter is employmentId). Do not invent a record ID or an API for role changes.

Main/B have distinct scoped rows with the same `LBL18_DUPLICATE` codes in all four org kinds;
Hidden has `LBL18_HIDDEN`; Empty has no org labels. Optional descriptions are empty, one cost
centre has a long real caption, and `LBL18_EDIT` has a nonempty optional description. Eight
canonical employment label categories have referenced values. Two Branch values have distinct
immutable codes and the same display caption; name-only resolution must remain ambiguous.
Existing employees retain actual grade/department/position/cost-centre/profile references.

## Actual UI journey (not executed by preparation)

1. GroupHR: inspect full-width common list, absence of page company dropdown/Sharing Settings;
   verify initial scoped IDs/codes/criteria. Add several drafts: newest prepends/focuses, partial
   drafts survive sibling validation, save/reopen records exact text. Check keyboard/focus, empty
   optional values, long caption, mobile 390px/dark and all en/ms/zh/ta/th/vi labels.
2. Create one unique Global code **in the UI**, verify it is usable in Main/B/Hidden/Empty without
   a flag, then create a new fictional company **in the UI** and verify Global availability there.
   Change another unique code to exactly Main+B, save/reopen, confirm Hidden/Empty exclusion.
   Attempts to expand `LBL18_DUPLICATE` Main to Global/Main+B must refuse without changing either ID.
3. ScopedHR: verify Global row read-only and Main+B-only permission. Try Hidden sharing and Global
   creation; refuse. EmptyHR sees an honest empty org list. Manager/Employee/Operator direct admin
   routes refuse. ForeignHR cannot see primary IDs. Do not infer these outcomes from seeded grants.
4. Download blank and current-data Excel through the real controls. Re-upload unchanged current-data
   file: review skips/no-op and confirm no spurious change. Edit and preview intended updates, then
   apply/reopen through canonical actions. Verify distinct codes with duplicate Branch captions are
   never selected by first-row/name guessing. Workbook files below are preparation controls, not a
   substitute for testing the actual download producer.
5. Use an actor's current-data file; make a real later UI change to `LBL18_EDIT`, then re-upload the
   older file as **the same actor**. Observe canonical stale warning, reviewer choice and fresh preview
   handling; stale is not universally a hard refusal. Other actor's actor-bound export must refuse.
6. Compare visible authorized choices in Personnel Employment/new-hire and applicable existing
   employee flows; real save/reopen must retain exact label IDs/codes. Demonstrate out-of-scope
   choices cannot be forged via import. Record downstream module prerequisites separately; this
   fixture grants no paid Attendance/Payroll modules and cannot prove their approval screens.

## Generated artifact controls

These are created only when the guarded fixture runs, using the actual workbook builder/owner.

| File | UI action and expected contract |
|---|---|
| blank-current-template.xlsx | Canonical blank template; real UI download must also be exercised |
| valid-main-new.xlsx / valid-multi-new.xlsx | Main-only / explicit Main+B additions; group HR review/apply/reopen |
| global-group-only.xlsx | GroupHR positive; scoped actor Global refusal |
| empty-company-criteria.xlsx | Nonempty company-set validation |
| unauthorized-hidden-company.xlsx / foreign-company.xlsx | Scoped/cross-tenant refusal |
| existing-code-global-collision.xlsx | New overlap refusal for existing disjoint duplicate code |
| conflicting-duplicate-rows.xlsx | Conflicting same-file identity refusal |
| optional-clear-update.xlsx | Merge: blank Label retains; optional Description `[CLEAR]` clears |
| group-current-before-ui.xlsx / scoped-current-before-ui.xlsx | Actual actor-bound exports; initially current, later real UI edit establishes staleness |
| unsupported-label-upload.csv | Explicit negative file-format control, same authoritative Department columns |

System Labels has **XLSX-only** upload authority; no CSV import owner exists. Do not call the CSV
control a supported import or strip its format refusal. A historical pre-0550 flag/overlap baseline
cannot be created by current canonical owners and is deliberately not fabricated here. Preserve
separate genuine upgrade/migration evidence for that acceptance. No browser, types, tests, DB,
release, external authentication or production acceptance is established by this source.
