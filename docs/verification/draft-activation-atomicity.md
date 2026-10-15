# Draft activation — 467664c3 verification contract

This is a verification plan, not a PASS receipt. No database, test, TypeScript, build, browser or
production activation has run for this change. The external AI deployment boundary currently holds the
shared resources. Syntax parsing and `git diff --check` do not establish runtime correctness.

The Draft row is locked and re-read under its original RLS session. Activation composes the existing
Personnel, country-pack statutory, Payroll and Family owners with one explicit transaction. A failed
owner, derived Family tax sync, final Draft deletion or completion audit rolls everything back. A
successful commit consumes the held ID by replacing its Draft claim with exactly one Employment claim;
it does not advance or release the reserved number again. Default owner calls retain their existing
transaction behavior. Ordinary Family saves retain their existing post-commit sync behavior; explicit
activation sync propagates failure.

The safe action seam is `draftActivationValidation(error): DraftActivationProblem | null`. The payload
contains only `DraftActivationValidationCode` and allowlisted `{tab, field}` tokens. Existing typed owner
errors remain available to service consumers. Unknown, driver and database faults return null so the
parent action can display its private-log reference. Neither owner messages nor captured input belong
in the action response. Parent owns action/locales; the wizard owner owns tab navigation and rendering.

## Focused checks after the coordinator hands off both test slots and the database lock

Use namespace `board15activation` and real worktree dependencies/environment. No checks are queued.

- New `draft-activation-atomicity.test.ts`: four real app-role late trigger faults (second Family member,
  completion audit after Draft removal, compliance update, derived child-tax update), exact whole-tenant
  state/reservation rollback and recovery of the same Draft; concurrency/repeat; all owner facts and
  leading zeros; optional blank groups/zero salary with remarks; malformed persisted data; changed,
  deleted or invisible references; scoped HR, employee/manager, other company and other tenant.
- New `draft-activation-safe-contract.test.ts`: finite safe projections, wrapped SQL failures,
  unexpected messages, owner-specific pointers, no PII/message/stack/cause reflection and explicit Tx
  composition guard. This is supporting source-contract coverage, not a substitute for the DB tests.
- Consumers: `employee-draft-wizard`, `employee-draft-family`, `draft-activation-field-survival`,
  `draft-record-tabs`, `r393-draft-payroll-tab`, `r393-draft-statutory`,
  `da7463b4-draft-ic-dob-address`, `optional-ic-statutory`, `r374-no-basic-salary-forms`,
  `dependents`, `dependents-family-fields`, `child-relief-review`, `shared-system-labels`,
  `payroll-policy`, `employee-id-config`, `personnel-import-atomic`, `draft-company-scope`,
  `country-pack-drift`, `payroll-pack-drift`, `leave-pack-drift` and relevant RLS guards.
  Resolve exact existing filenames from the test catalogue before dispatching; do not interpret an
  unmatched selector as coverage.
- Regress the late-fault test against the old independently committed orchestration in an isolated
  candidate, when permitted. A test written to detect the defect has not yet demonstrated that control.
- Run repository TypeScript, required impact/security gate, build and migration rehearsal centrally
  after all integrations. Parent alone owns the final gate and release.

## Experience and production evidence still required

Use a named disposable local fixture/database `ai_hr_board15_activation_browser`, namespace
`board15activation`, port `3204`, with both slots + DB held for the entire owned server lifetime.
Fixture/runner provisioning and the actual app walk are pending. Do not use a production tenant as a
local fixture. Walk save → Activate → Personnel open → refresh, missing/invalid fields and actionable
focus/tab pointers, retained Draft after a late failure, unexpected safe reference, optional blanks,
scoped HR and denied roles. Review all six locales, keyboard, narrow viewport, light/dark and runtime
logs. Repeat a disposable fixture cleanly twice under watchdogs and stop the owned server before release.

The Performance reminder-epoch definer/RLS prerequisite is owned by PMTM (0542); this branch does not
alter or duplicate it. Rehearse that prerequisite and activation with production-equivalent non-BYPASSRLS
function ownership/grants: local owner/superuser fixture setup can mask the reported person-INSERT
failure. Actual G00002 activation, Personnel rendering after refresh and live employee state remain
unverified and require the coordinated production/HR journey. No unrelated employee is activated here.
Import template changes are not applicable to this orchestration repair.
