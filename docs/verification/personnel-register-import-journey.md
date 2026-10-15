# Personnel register import experience — c44575e0

Prepared source only. The fixture, runner, tests, type check and browser journey have **not run**. This checklist does not establish completion or release readiness. Integration must retain the parent’s scalar/card/photo/payment imports and Schedules’ form adapters/registry source coverage.

## Coordinated entry and target

Run only after the parent explicitly hands off the verification window and provisions a real worktree `node_modules` and its private local environment. The runner does not install dependencies, link directories, copy environments, change production or reset an existing database.

Coordinator entry, from the required mainwt shell working directory (replace `$PERSONNEL_WORKTREE` with the exact owned worktree):

```sh
node --env-file="$PERSONNEL_WORKTREE/.env.local" --import tsx "$PERSONNEL_WORKTREE/scripts/dev-browser-personnel-registers.mjs"
```

This entry itself acquires `board15personnelregisters-browser-a`, `board15personnelregisters-browser-b` and `board15personnelregisters-browser-db`. **Do not wrap that entry in another both-slot wrapper:** doing so deadlocks. Its internal `--held-lock-worker` command is a separate entry for an already-coordinated holder; it proves those three exact live lock names before work. The parent should normally use only the coordinator entry.

Both scripts derive their root from `import.meta.url`; every child has an explicit root `cwd` and target environment. The target is only `ai_hr_board15_personnel_browser` on local PostgreSQL port 5433, namespace `board15personnelregisters`, app `http://127.0.0.1:3203`. Production, real authentication, mismatched demo tenants, foreign tenants, symlinked/missing dependencies and an occupied reserved port refuse. Migration uses a generated target-only config; seeding occurs only if the named database lacks the demo tenant. An existing fictional demo database is preserved.

The runner migrates, seeds if empty, then runs the fixture twice under 120-second watchdogs and compares its declared manifest. Both fixture processes must exit naturally with code 0, not merely finish queries. It then owns the Next process group for at most 45 minutes. No HTTP/UI probe supplies an application PASS. Use CUA for every actual app action.

Stop by creating `$PERSONNEL_WORKTREE/scratchpad/board15-personnel-registers/browser.stop`. The runner sends signals only to process groups it spawned, waits for their disappearance and then lets the lock wrappers return. It never kills a process just because it holds port 3203. Preserve `browser-*.log`, `browser-manifest.json`, `browser-stopped.json`, screenshots and observations in that same scratchpad. Logs contain fictional fixture identity only, never connection strings.

## Fixture and uploads

`dev-fixture-personnel-registers.mts` refuses any database except the exact target, any namespace except the assigned one, and tenants beyond the seeded Demo Group/system tenant. Company, department, hire, profile, bank/statutory, reporting line, termination, catalogue, Family, Qualification and Contact facts go through their canonical owners/packs. The migration connection inserts only fictional app-user/role grants; all other use is read-only lookup. Existing facts are preserved on rerun, not reset to make a test green.

The fixture declares its fictional Main and Foreign companies, company-scoped HR, manager, employee, other employee, inactive employee and foreign employee in `fixture-manifest.json`. The Employee has a spouse and two same-name children with different birthdays, two live qualifications, two same-name live contacts, archived records, leading-zero bank/profile values and stored inactive legacy catalogue values. Active catalogue aliases include an unambiguous label and two values with the same ambiguous label.

Generated actual CSV/XLSX files are in `uploads/` under the scratchpad. Upload these through the app; do not call import actions/services from a fixture or substitute mocked previews. Six localized full workbooks create separate new fictional employees and two Family/Qualification/Contact records each. Register files contain exact saved IDs for updates. Refusal files cover orphan rows, unknown worksheets, wrong employment/person/company IDs, archived IDs, inactive employees/options, ambiguous option labels, duplicate IDs, conflicting Highest/Primary flags and malformed dates. Profile/Bank/Family files cover blank retention, leading zeros and same-name members with distinct birthdays.

## Walkthrough and evidence

1. As scoped HR, open Personnel Import. Download the actual full workbook and separate Qualification/Emergency CSV/XLSX templates. Inspect all nine/seven fields, exact labels, required-on-create guidance, month format, current choice lists, text IDs and separate sheets. Download current register records by the fixture Employee ID and confirm the IDs match the displayed records and manifest. Record downloaded filenames and screenshots.
2. Edit an actual downloaded file (or use the declared upload case as the reproducible edited input), upload it, Check, inspect every proposed value and explicit record create/update action, Apply, reopen Personnel and verify all affected fields. For new records, a blank ID creates even when names/qualification values match existing records. For explicit IDs, blank cells retain original institute, months, phone, bank name, address and unrelated fields. Observe exact new values and unchanged neighboring values.
3. Promote a second qualification to Highest and a Secondary contact to Primary. Confirm the previous holder is cleared/demoted in the register, Profile resolves the new Primary, and canonical audit events show the real actor and transfer. Verify Family same-name/different-DOB records remain independent. Record before/after values and IDs, not only toast text.
4. For each locale en/ms/zh/ta/th/vi, upload the corresponding full workbook, inspect the complete preview (employee plus both repeated registers and Family), apply, reopen each register/Profile and confirm the exact values/row counts. Verify forward reporting-line/full imports, parent scalar/card/photo/payment fields and field coverage on the integrated candidate, not merely this child base.
5. Exercise every refusal file. Check the message identifies the corrective action, Apply is blocked or refuses, counts remain truthful, and no target/new employee/register changes occur. Add mixed valid/invalid full-workbook rows and prove whole-file rollback when an orphan/register owner refuses. For the later-writer rollback injection, use the targeted regression; never add a failure trigger in a browser fixture.
6. Switch through the actual UI to employee and manager: confirm they cannot reach or apply Personnel imports. Return to scoped HR and try Foreign company/person IDs; confirm no expansion of Personnel visibility. Inactive login is a lifecycle refusal fixture, not a browser role to impersonate. Cross-tenant forged IDs are separately pinned by targeted DB tests; do not invent another tenant in this guarded demo database.
7. Test all six locales, narrow 375-pixel screen, light/dark, keyboard tab order/focus, labels/errors, long names and empty/large lists. Check repeated file pick, wrong file, retry, paste edit, replacement workbook, stale-preview invalidation and no silently ignored extra tables. Main-sheet edits must retain linked repeated sheets until explicit replacement/reset/sample.
8. Save the exact candidate/environment, role, inputs, expected/observed values, screenshots and negative controls. Stop the owned server, prove both slots and DB release, and hand evidence to the parent. TypeScript/focused tests and final gate/release remain separate claims.

Import template: updated Qualification and Emergency Contact full-workbook sheets and per-section CSV/XLSX templates; fixture preparation alone proves no delivered app outcome.
