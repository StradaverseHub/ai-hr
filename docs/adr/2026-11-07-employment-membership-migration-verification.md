# Employment membership migration verification

Status: populated-upgrade recovery pending. No installation or release acceptance is established by this document.

Migration `3001_employment_membership_initplan` changes the two positive Employment read-policy membership terms while preserving the same native visibility owner. Qualification must exercise the appended SQL itself, in addition to the separate reversible query-planning experiments.

`test/employment-membership-initplan.test.ts` uses the disposable migrated worker database. It first inspects the installed policy and unchanged write check, then reconstructs the exact independently pinned predecessor expression from PostgreSQL's deparsed current expression. It commits that predecessor against populated fictional data, records native results, executes the actual append bytes in an owner transaction, and records the same native results again. No migration-ledger entry or execution receipt is fabricated. A final restoration protects subsequent test files even when an assertion fails.

Independently known fixtures cover employee self, manager/direct report, department-head membership, future-dated reporting lines, company and tenant negatives, Payroll and Performance partners, archived/revoked/restored callers, forged person claims, voided Employments and People, independently selected identities, represented organisation options, and an Assignment whose historical company differs from its current Employment company. Complete before/after page DTOs are compared after removing only the intentionally changing snapshot context identifier.

The Bank point-read GUC is exercised as a test-only transaction-local setting on actual native app-role reads. Current roles and company scope still determine visibility with the flag both off and on. A visible Employee remains unable to write its Employment; an authorized native administrator can write, with an intentional complete rollback. Policy command, roles, permissiveness and `WITH CHECK`, visibility-function definitions/security attributes, table grants and every other policy are compared independently.

Owner-only drift rehearsals alter the predecessor's `USING`, `WITH CHECK`, roles or visibility-function search path inside transactions, then execute the actual append and require SQLSTATE `55000`. Their transactions must roll back all changes. A PostgreSQL truth matrix includes NULL, empty, duplicated and matching UUID membership arrays with both allowed and denied partner alternatives; only positive policy truth is compared.

The historical 0515 fixture remains unchanged. Its current-policy owner test independently composes the explicit 3001 Employment expression with the existing void narrowing and Bank point-read arm, normalizes it through PostgreSQL, and still requires exactly two wrapped positive terms. All other historical policy and write-check expectations retain their existing owners.

The focused manifest also names existing hierarchy, visibility, employee-choice and Claim membership suites. The employee-choice suite contains the real 50,000-person component case; its timings are distinct from smaller authority/replay fixtures and from whole-system browser/load qualification. The root integration owner decides whether to run that expensive suite separately, retaining exact source and evidence identities.

Run all application checks, compiler checks and migration rehearsals on standard hosted Actions. These tests do not prove production-equivalent capacity, zero Busy under sustained traffic, full-menu coverage or installed worker/proxy readiness. Those remain separate release prerequisites. Production stays on hold.

## Populated upgrade inventory recovery

The original populated-upgrade run [42376045111](https://github.com/StradaverseHub/ai-hr/actions/runs/42376045111) failed its exact added-function inventory: the combined tail installs 16 functions, while the test listed 15. The missing declaration was the already-reviewed 2701 helper `app.personnel_overview_filter_fields(date,uuid[])`. Its explicit inventory entry retains the existing native application EXECUTE permission and PUBLIC denial assertions; no function grant or migration is changed by the recovery.

The same rehearsal must also account for the deliberate 3001 Employment `USING` transition. It independently parses the full predecessor and successor CASE expressions against PostgreSQL, pins exactly two wrapped positive membership terms after upgrade, and compares every remaining policy field, including roles, command, permissiveness and `WITH CHECK`, unchanged. Only those already-verified Employment and Claim `qual` values are normalized in the complete ACL/policy comparison. Employment is not excluded from that comparison, and no broad policy exception is introduced.

The recovery changes only this test and its qualification note. The failed run remains failed; its recovery is a dedicated affected populated-upgrade rerun. Previously successful native, parity, compiler and 50,000-person component evidence retain their original candidate/run identities and are not relabeled or repeated merely for this test-inventory repair. Hosted recovery remains pending until the controller records its actual result.
