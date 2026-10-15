# Fictional Draft activation and Delete Record journey

Source preparation only; this document contains no runtime PASS. Core checkpoint `a452944a` stays
unchanged. Parent must integrate the safe action result, wizard consumer, Delete Record confirmation
and PMTM reminder-epoch prerequisite before execution. The current isolated branch still has the old
UI/action signatures. The runner checks the safe action helper and `.ok` consumer as a prerequisite;
that check does not prove the rendered workflow or Delete dialog is correct.

## Coordinator entry and environment

After the coordinator explicitly hands off resources and provisions real worktree dependencies/local
credentials, run the self-locking entry (substitute the owned worktree path):

```sh
node --env-file=/absolute/owned/worktree/.env.local --import tsx /absolute/owned/worktree/scripts/dev-browser-draft-activation.mjs
```

Do not wrap that command in another both-slot wrapper: this entry already acquires both slots and the
shared dev DB lock. `--held-lock-worker` is a separate internal/debug entry; it refuses unless all three
named live locks exist in its own process ancestry. Lock wrappers run in an isolated process group so
a terminal interrupt reaches the coordinator, which requests a graceful worker stop rather than
releasing wrappers early. The runner derives its root from `import.meta.url`, requires a clean candidate,
retargets only local `localhost:5433` credentials to **ai_hr_board15_activation_browser**, and binds
**127.0.0.1:3204** with namespace **board15activation**. It never installs dependencies, kills an
occupied port holder, drops a database, resets existing data or changes another database. Existing
non-demo tenants cause refusal before migration or seed. A new named DB is migrated and seeded once;
an existing seeded fictional DB is preserved. No production identity/data is copied.

The runner migrates only its explicit generated target configuration, runs the fixture twice under
120-second watchdogs, requires both fixture processes to exit with identical declared facts, then
starts one owned Next server under a 45-minute lifetime watchdog. Both slots + DB remain held through
child cleanup. Stop by creating `scratchpad/board15-draft-activation/browser.stop`. Only fresh child
process groups owned by this invocation receive TERM/KILL, and locks are not released while an owned
group exists. Inspect `browser-stopped.json` and the coordinator's exit before taking the next slot.
The runner never treats an HTTP response as a rendered outcome and does not issue a browser PASS.

## Manifest and named cases

Read generated `scratchpad/board15-draft-activation/browser-manifest.json` before browser work. It pins
candidate/root/database/port, actual user/person/employment IDs, companies, departments, numbering
configuration, held Draft IDs/codes/numbers, exact captured data/hash, required fields and six localized
routes. `fixture-manifest.json` contains the fixture declaration independently. Logs are named
`browser-migrate`, `browser-seed`, `browser-fixture-first`, `browser-fixture-second`, `browser-dev`.

Use the actual app demo-principal switcher for **Activation15 HR**, **Manager**, **Employee**,
**ForeignHR**, **ForeignEmployee**. HR administers Main only; ForeignHR administers Foreign only.
The existing employee/manager employment, reporting line and foreign-company Draft are real canonical
fictional facts, not mocked session data. Owner inserts are restricted to these login/grant fixtures.

| Manifest case | Intended observable outcome |
| --- | --- |
| `valid` | Fictional Shaair, MY profile/statutory/bank/pay/Family, held `ACT15-G00002`-style code. Save, Activate, open saved Personnel and refresh. Leading zeros, IC-derived/typed DOB, same-as-permanent addresses, salary and both Family records persist. |
| `optionalBlank` | Optional groups absent, basic salary present. Activate successfully without requiring IC/passport/bank/Family or conjuring a statutory row. |
| `locale_en/ms/zh/ta/th/vi` | Separate valid optional-blank Draft per locale, allowing a real success/open/refresh in each without recreating an activated Draft. |
| `invalidIdentity` | Supplied malformed IC stays captured. Activate produces safe Profile/IC validation (or the app's earlier actionable field refusal), no React/server digest/raw details; no employment is created. |
| `missingRequired` | Missing Department names Job/Department. Save/reopen keeps the Draft/code. Activate may be correctly disabled by the field rule; do not call that a server-error demonstration. |
| `stalePolicy` | Initially valid selected Monthly policy. Open Draft first; in a second real app tab change that policy to Draft/inactive, then Activate the still-open wizard. Server returns safe Payroll/Policy pointer, retains Draft/code, creates no employee. Restore active via the app only after capturing refusal. |
| `deleteCancel` | Inspect the dedicated confirmation in each locale. Cancel, Escape and supported backdrop dismissal retain exact Draft/data/code and do not navigate away. Refresh/reopen proves persistence. |
| `deleteConfirm` | Last Main numbering reservation. After reviewing the named warning, Confirm once removes only this fictional Draft and returns to Personnel. Repeat/stale confirmation must be refused safely. Tip release follows the canonical owner; this is not a new general gapless-number promise. |
| `foreign` | Main HR cannot open, activate or delete. ForeignHR can open/cancel. For a stale-session refusal, open as ForeignHR, switch to Main HR in another real app tab, then attempt the old tab's action; it must retain the foreign Draft and return a safe denial. |

The fixture is append-or-verify, not a reset command. Before any browser mutation, a second fixture run
must produce identical identities, held facts and hashes and no new owner writes. After activation,
policy edits, deletion or changed captured values, a rerun deliberately refuses rather than replacing
or silently repairing the journey's data. Its existing manifest also pins previously declared Drafts so
a deleted case is not recreated. Preserve that receipt, state and logs for review; if the parent
intentionally starts a fresh disposable database, archive the old evidence explicitly first.

## Walkthrough and evidence checklist (all unchecked until execution)

- [ ] Verify the candidate includes parent action/wizard/Delete-dialog changes and the prerequisite
  migration; confirm non-owner app connections and the intended named DB. Run fixture twice and require
  clean exit, not watchdog termination. Production-equivalent non-BYPASSRLS definer/grant proof remains
  a separate PMTM check; migration success under a local superuser cannot supply it.
- [ ] As scoped Main HR, choose Main in the company switcher. Open `valid` using its manifest route;
  review every tab, edit a harmless fictional phone/remark through the app, Save, reopen and compare
  held ID and captured fields. Capture the before state, then Activate and record the returned route's
  actual new employment ID, Personnel render, status and refreshed persisted values. Exactly one
  completion audit/employee must be observed with a read-only verification; never infer that from toast.
- [ ] Repeat success with optional blank groups and each locale's dedicated Draft. For the rich result,
  inspect Profile, Employment, Bank/Statutory, Payroll and Family. Record all omitted/reinterpreted fields;
  do not silently replace an expected value with a label-only assertion.
- [ ] Exercise `missingRequired`, `invalidIdentity` and stale policy. Verify tab navigation, specific
  field pointer and recoverability through normal edits, with held Draft/code retained after refusal.
  Inspect runtime logs and visible DOM for React errors, MISSING_MESSAGE, raw SQL, IC/bank values or stack
  text in an error response. A correct earlier field block and a safe server refusal are distinct claims.
- [ ] For Delete Record: inspect name/held ID/destructive consequence, focus placement, keyboard Tab and
  Shift+Tab containment, Escape/Cancel, focus return and pending/double-click behavior. Verify Cancel
  leaves every captured value and reservation untouched. Confirm only on `deleteConfirm`; reopen/list/
  refresh shows removal. Check stale/repeated and changed-role refusal without deleting another Draft.
- [ ] Verify Main HR's foreign-company denial; ForeignHR's own access; employee and manager denied on
  Draft routes/actions. Switch identity only through actual app controls. Existing fictional people
  remain unchanged. Cross-tenant and arbitrary forged-input security proof remains in targeted DB tests.
- [ ] Review en/ms/zh/ta/th/vi with realistic strings, 375px and desktop widths, keyboard-only actions,
  light/dark, error/success/pending/dialog states. Capture CUA screenshots with matching local runtime
  logs and file paths. A catalogue key or successful response is not a render check.
- [ ] Stop the owned server, verify owned process groups ended and lock release, then report exact SHA,
  environment, executed cases and omissions to the parent. Parent owns final gate/build/release/live
  arrival and actual G00002/HR activation proof.

Not prepared as an automatic browser fault: an unexpected late database failure/safe system reference.
The committed app-role DB regression owns late owner/audit rollback proof. If the parent needs an app
fault demonstration, coordinate a separately bounded disposable fault and remove it before continuing;
never inject it into production or call a caught test exception a browser outcome. No browser
screenshots, live record verification, types, tests, DB or server execution have happened here.
