# Current Personnel review actor scope — source repair

The native HR login is a USER and need not have an employee PERSON. Current principal resolution and native authority already admit a genuine `app_user.person_id IS NULL`. The original 0622 unnamed review scope CHECK nevertheless requires an actor person in its generic fallback. This accidentally prevents the six current Personnel review kinds from storing an otherwise authorized review. No source-level unlinked-user exclusion is intended.

## Exact repair

Unapplied provisional migration0719 wraps the COMPLETE previous unnamed actor-scope predicate, found through its original testing/employment shape. It verifies the predecessor still contains the 0714 draft branch. Only these six exact kinds receive a new branch: `employees.qualification.maintain`, `employees.compensation.maintain`, `employees.emergency_contact.maintain`, `employees.workforce_profile.maintain`, `employees.family.maintain`, and `employees.bank.maintain`.

Their branch requires `employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL`; actor `person_id` may be NULL. Every other action evaluates the captured previous expression unchanged, including the draft lifecycle branch. Separate stored subject, selected employment/company, native receipt, exact current USER binding, source authority, encrypted custody and no-own-person rules remain unchanged. No historical migration or production TypeScript owner is edited. A NULL actor person never substitutes for the true nonnull subject person.

Migration 0719 / idx700 / when1793330000048 remains an UNAPPLIED source claim, with no installation priority or deployment authority. This repair is based on frozen 56101b81c8a40db4b939d0389da1410311287731. Freshly fetched main/alpha were 7098cde191d98669560d08adb0bcc3b16d981ee9; the assigned isolated base was deliberately retained. Other frozen worktrees and recovery jobs are untouched.

## Authored hosted evidence

`test/assistant-personnel-unlinked-actor.test.ts` creates actual owner-inserted app users with `personId:null`, real role assignments, real Assistant grants, and normally resolved tenant entitlements. It never creates an actor Person or borrows a synthetic staff identity. Two independently authorized unlinked HR users are used for custody probes.

For each of the six kinds, four executable cases cover:

- The SAME native command in a rollback-only caller transaction; no persisted business effect; native choices, prepare, pending reopen, confirm and same-receipt replay/reopen. The ledger retains NULL actor person, real USER, true nonnull subject person, selected employment/company, one expected USER event and no completed private body. The other authorized NULL-person USER cannot reopen or confirm, before private body decryption.
- Relinking the real actor after preparation: both the old NULL-person context and fresh linked context refuse reopen/confirm before decryption or effects, retaining pending custody.
- Removing the actor’s actual role assignment: stale claimed HR roles cannot restore choices, reopen or confirmation; private body and business rows remain unchanged.
- Owner-level negative column updates: missing selected employment/company or any nonnull testing column still fails CHECK 23514.

One additional positive case grants an actual unlinked `employee` USER the native Workforce view and maintain capabilities through access configuration. The normal profile command succeeds in a rollback-only transaction, and profile review confirmation succeeds without adding an HR role or actor Person. Existing linked-self denial fixtures remain untouched. Total authored cases: 25 (four groups of six plus this positive case). The DB classifier sees direct `test/harness`, `db/client` and `db/schema` imports; no NODB exemption is added.

## Composition notes and verification limits

When the later packages compose, 0720 document metadata (`employees.document_metadata.maintain`), 0721 employee code (`employees.code.maintain`) and 0722 passport identity (`employees.passport.maintain`) also need the same bounded branch for their exact current action kind. Their then-current COMPLETE predecessor predicate must remain the ELSE expression; do not expand the generic fallback or fabricate a Person. Verify those exact action literals against each package before composition.

Only source inspection, static source-manifest generation and `git diff --check` were performed. No tests or collection, compiler, DB, build, dev server, CI, push, PR, merge or deployment ran locally. Runtime acceptance, including migrated constraint discovery, remains pending exact-SHA hosted verification. Release hold remains unchanged.
