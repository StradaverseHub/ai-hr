# Employee Master manual report acceptance fixture

This is setup source and an execution checklist, **not an acceptance receipt**. Runtime, types, migrations, two identical fixture invocations and browser outcomes remain UNRUN until the parent executes them on the integrated clean candidate.

The human explicitly chose “Use existing HR Admin for this test” for the approved HR Manager sharing example. Both peers use the real `hr_admin` role. This release does not claim configurable role names or a custom role framework.

## Controlled setup and resume

Use the original18 browser coordinator’s Reports course, with both test slots and the dev DB lock. The fixture is `scripts/dev-fixture-employee-master.mts`; it accepts no target arguments. The only allowed target is local port 5433 database `ai_hr_board18_reports_browser`, namespace `board18reports`, browser port 3197. **Migrate a pristine target; never run db:seed for this course.** The only existing tenant at first setup must be the reserved System tenant.

The coordinator supplies its actual immediate PID and clean HEAD as `REPORT_FIXTURE_COORDINATOR_PID` and `REPORT_FIXTURE_COORDINATOR_CANDIDATE`. All three named lock holders must be actual live ancestors: `board18reports-browser-a`, `board18reports-browser-b`, `board18reports-browser-db`. Fictional demo mode must be explicit, no real provider secrets/production mode or selected DEV tenant. DEV_USER_ID is also absent during fixture setup. Both app and owner URLs must name the exact same local endpoint and database; the actual application role is checked as `ai_hr_app` with no superuser or RLS bypass.

The fixture creates `Reports18 fictional primary tenant` and `Reports18 fictional foreign tenant` through canonical provisioning. Activation invitations are discarded, never consumed or sent. No internal credential, provider binding, email consent, report, preview, export, schedule or delivery is fabricated. Only fictional demo login/bootstrap grants use the limited fixture owner seam; all further actor grants use `assignRole`.

Private manifest: candidate-root-derived `scratchpad/board18-reports/fixture-manifest.json` (directory 0700, file 0600). Output begins `REPORT18_MANIFEST`. A complete second invocation returns identical text only after matching candidate, KL date and read-only setup proof. Partial setup without a manifest or changed setup refuses; it never repairs/resets. Close both pools and exit under the coordinator watchdog.

For receipt-bound resume import **only** `scripts/employee-master-fixture-proof.mts`, not the executable fixture. `readEmployeeMasterFixtureProof({client}, {tenantId,foreignTenantId})` uses the caller’s already targeted client, opens one SELECT-only Repeatable Read/Read Only snapshot, and returns `{version:1,metadataDigest,stateDigest,tables}`. There are no import-time clients, environment reads or connections. Compare the full `manifest.proof`; refuse metadata/catalog/source drift. It intentionally excludes saved reports/runs/schedules/occurrences and report audit. Real Personnel historical source events remain included. App dashboard/list/onboarding preferences are excluded; exact login/person/tenant/grants/lifecycle remain included. The resume coordinator must preserve all actual browser report edits and use zero fixture calls/migrations/seeding.

## Actors and data

`people` declares actual user/person/employment separately, exact demo login and grant tuples. Choose the actor in the existing identity switcher; `/login` is the canonical demo entry. Never assume the initial bootstrap login is HR_A.

| Actor | Actual grant | Intended control |
| --- | --- | --- |
| HR_A / HR_B | hr_admin separately for MainA, MainB, Empty | Peer private isolation, role sharing and authorised salary |
| NoSalary | super_admin group-wide, explicit compensation category deny | Actual UI access without basic salary or salary history; administrator status cannot override denial |
| HiddenHR | hr_admin Hidden only | Other-company scope control |
| Employee | employee group tuple; actual own person | Admin report route refusal |
| ForeignHR | hr_admin foreign tenant/company | Other-tenant boundary |

Permission overrides explicitly allow hr_admin compensation and deny super_admin compensation at tenant scope; this owner replaces defaults at an override tier, so setting only a deny would incorrectly remove the HR default too.

`companies` values have `{id,name,code,departmentId,tenantId,purpose}` for MainA, MainB, Hidden, Empty, Provisioned and Foreign. Empty has no employment. Hidden has its own HR employment, outside A/B grants. Provisioned is the canonical initial company, outside A/B grants. Foreign belongs to the second tenant.

The 56 data subjects plus HR_A/HR_B/NoSalary/Employee make 60 A+B employment rows at today (including the ended row), before adding the one unfinished Draft. This is a declared setup expectation, **not observed report output**. There are 61 primary employments including HiddenHR and one foreign employment. Row001 has authentic salary 3001 → 4321.25 at `dates.salaryChange`, then MainA → MainB at `dates.transferOn`; dates and source IDs are in the private manifest. Row054 resigned with recorded reason and zero notice; Row055 hired this month; Row056 is a contract ending in 20 days. Row001 has two same-name children with distinct birth dates/IDs, two independent qualifications with YYYY-MM precision, and leading-zero statutory/bank values. Row003’s name starts `=1+1` as inert literal text for spreadsheet safety. No arbitrary SQL changes create the business facts.

## Actual UI sequence

1. As HR_A open `/reports` → Employee Master → new builder. Select MainA+MainB. Verify all 11 tabs/groups and concrete fields/disabled reasons; search familiar Personnel labels. Select Code/Name/Company and salary, with explicit displayed date. Preview first 50 against 60 authorised employees, then export XLSX/CSV/PDF and inspect full row count, typed salary/date, leading-zero codes/bank, literal Row003 text, headings, totals and separate sections. Do not infer export PASS from a downloaded filename.
2. Save **Only Me** “Reports18 A Private”. Verify immediate hub listing, reopen/reorder columns/change formatting, save/reopen exact settings. Record the generated report URL/ID. As HR_B, verify absent listing and refusal for exact direct read/run/export/duplicate/delete paths through legitimate UI, not a forged fixture result. Return to HR_A and verify unchanged access.
3. As HR_A save “Reports18 HR Shared” with actual HR Admin role. HR_B must see/open it within MainA/MainB only and exercise permitted edit/duplicate. A duplicate must be private to B with no schedule. A cannot discover B’s private copy. Delete only a dedicated UI-created copy and confirm owner/visible-admin policy as displayed.
4. As HR_A additionally create two dedicated reports shared to the actual **Super Admin** role: one name/code-only control and one requiring salary. As NoSalary, the name/code shared control must open (proving sharing eligibility), while the salary report must refuse from the exact saved URL/export. Inspect the catalogue and salary-history groups; compensation fields must be absent/unavailable for columns, conditions, sort, group, totals and exports. Create a permitted name/code report normally. Do not mistake a hidden UI column for proof of direct stale-spec security; canonical regression coverage remains necessary.
5. As HR_A run Row001 at `asAtBefore`, then after salary change but before transfer, then today; compare authentic company/salary dates against manifest. Past nonversioned Profile/Family/Qualification/current configuration fields must show Unavailable, never today’s value relabelled as historical. Include unfinished Draft explicitly, preserving draft identity rather than a manufactured employment.
6. Use All records for Family and Qualification concurrently; prove separate aligned register sections without unrelated row multiplication. Change one selected register column to Latest. Inspect repeated same-name IDs/birth dates and month-only qualification values; verify distinct employee/person counts and compatible currency/unit totals.
7. Build nested AND/OR filters, typed numbers/dates/text/choices, quick filters, three stable sorts and group totals. Confirm live count/preview/export all use the saved expression; Empty yields honest zero, not an error or another scope. Neither Hidden nor Foreign appears in company selectors/results/counts; direct forbidden company/report paths refuse. Employee cannot open builder.
8. Create more than five UI reports to exercise recent first five, View All/search, immediate saves, last successful run ordering, duplicate and delete. Open/duplicate each actual starter: headcount, new hires, Resigned (canonical ended-status semantics), contract expiry. Verify the corresponding controlled subjects rather than merely the title.
9. Check wide/narrow, light/dark, keyboard focus/reordering and all six in-app locales. Routes are unprefixed; the app language cookie chooses en/ms/zh/ta/th/vi. Capture actual render/runtime errors and unsatisfied outcomes honestly.

## Boundaries and remaining evidence

Scheduled delivery/weekly/monthly/consent/SMTP/worker memory and isolation are separate required acceptance; this fixture supplies none of those prerequisites or proofs. Human internal-auth/TLS/MFA enrollment is not simulated. Future registry-field propagation requires a controlled source/test change through the one registry; this fixture does not add a fake field. Role revocation during export, forged/stale expressions, snapshot isolation, oversized export and financial leakage require actual owner/route regressions in addition to manual UI. Historical old-candidate receipts do not satisfy latest integrated-candidate acceptance. An unresolved required outcome remains incomplete.
