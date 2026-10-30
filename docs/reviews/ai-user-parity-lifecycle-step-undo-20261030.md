# Bounded offboarding step undo

This followup normally merges verified choices/metadata33619bc31af98274b3513c4d42dffe0b30f89fe4 and adds one human-reviewed action: lifecycle.offboarding.step.undo. Draft development only; no installation, protected merge or deployment authority.

## Native behavior and human review

One active, applicable, done non-outcome offboarding step can be undone by the current company's native lifecycle LEVEL.manager. A USER may have no PERSON or employment; no extra HR role, self prohibition or delegated alias is invented. The reason remains optional, matching the mounted native confirmation and service. The review shows case/step/dates, retained reference/notes, done→pending and any completed→in_progress case reopening. Undo consent and acceptance of derived case reopening are separate. Inactive, not-applicable and outcome variants stay in the native workflow.

The existing native Promise<void> undoStep delegates to undoStepTx in the caller's transaction. It clears done/doneBy/doneAt, retains reference/notes, writes exact step-undone history/event, then calls the same reconciliation owner. The generic owner can derive other transitions for historical cases; the bounded adapter refuses those. Step event payload binds PostgreSQL row hash AND xmin: undo→redo→undo can recreate identical logical content, so a hash alone is not a durable original-event witness.

## Admission, custody and effect proof

The same encrypted ledger/createReviewCustody owns pending content, commitments, rate/body bounds, expiry/discard, privacy targets and completion erasure. Binding uses actual case/company and nullable case PERSON/employment. Access/principal/module/pause checks are fresh; source locks actual lifecycle staff writers, definitions, case and steps through commit. Choices use the verified fresh-guard/native-projection supplied-transaction pattern and project only case identity/number and eligible step labels after native manager scope. Default getCase stays unchanged.

Allocated0742_assistant_lifecycle_offboarding_step_undo.sql, idx721/version7/when1793330000079/breakpoints:true, is UNAPPLIED PROVISIONAL DEVELOPMENT ONLY. It adds one closed kind and three bounded columns, retains predecessor predicates exactly once in the three necessary constraints and requires all unrelated actual columns NULL. Native proof requires current top-transaction step/history/event, matching actor/case/company/nullable links, undone state/null actor/time, row hash/version and required-or-absent exact derived reopened event. Recovery reuses original event references and refuses redo, identical-state ABA, source relink and authority loss. No parallel business table or engine is added.

The dedicated browser protocol remains separate from generic employment protocols; it bounds responses, validates operation/review correspondence and keeps uncertainty on the same review ID. Six locales and /assistant/offboarding-step-undo expose human choices and confirmation. Registry entryPoints is empty because the mounted generic undoStepAction covers onboarding/outcome variants; its inventory remains backlog:confirm. The native page/service anchor is truthful without claiming the whole export.

## Focused verification

Authored native6, contract10, browser correspondence9, DOM3, HTTP1, actual-ledger shape2 and real custody tests cover authority, retained metadata, consent, exact event pairs, current-transaction refusal, rollback, stale source/definitions, company/outcome narrowing, erasure/expiry, repeat recovery and ABA. Lifecycle role probes add the second action to the existing group, preserving all other groups/declarations. Existing lifecycle native, completion choices and affected shared registry/catalogue/transport tests plus whole compiler are planned on the frozen full SHA. No local application tests, compiler, migrations, DB or server were run. Hosted evidence is recorded in the exclusive phase file after actual jobs finish; this note does not claim a pass.

## Original failure and narrow recovery

Original aa600e282e8f5916fe3cdb66ef3a4022179507e0 run41037460486 retained117 actual passing non-DB cases, then PostgreSQL OOMKilled:true while rebuilding0742 against an inherited6.93MB predicate, before any DB cases executed. Whole compiler failed only on a duplicate tickStep test import. All original jobs finished before repairs.

The separate recovery branch adopts only the expressly approved b55c3168 isolated UNAPPLIED0716 finite eight-NULL branch (every other0716 byte independently compared unchanged), removes the duplicate import, and bounds own0742 catalogue discovery to the exact original-notice constraint identities with expected-shape checks and raw conbin size notices. It does not deparse every ledger constraint, weaken admission, edit applied SQL or increase resources. All117 non-DB results remain on actual aa600; recovery runs unexecuted DB files, the newly affected emergency custody file, manifest-bound catalogue and whole compiler. Exact candidate and results belong in the exclusive phase file after actual checks.
