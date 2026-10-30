# Emergency contact maintenance parity

Source package on isolated branch `codex/ai-user-parity-personnel-emergency-20261030`, based on parent
qualification candidate `3d8a12d01b518eaefc18d3d828ac74ccc03a609c`. Freshly fetched main/alpha were
aligned at `2f81373e5e18fb2b734dba0ded94866446afc065`, with this package base ahead233/behind0 at session entry. Source implementation,
authored checks, executed CI, installation and acceptance are separate states. No CI or local execution
is claimed by this implementation record.

## Source-to-native-effect map

| Native entry point | Unique native effect | Owner and permission |
| --- | --- | --- |
| `emergency-contact-actions.ts#addEmergencyContactAction` | Add one shared-person emergency contact; choosing Primary demotes an existing Primary to Secondary | `core/workforce-registers.ts#addEmergencyContact` resolves supplied person, calls `assertWorkforcePersonTx('maintain')`, then `core/emergency-contacts.ts#addEmergencyContact` |
| `emergency-contact-actions.ts#editEmergencyContactAction` | Edit an existing contact; promoting it to Primary demotes the previous Primary | `core/workforce-registers.ts#updateEmergencyContact` resolves the existing row's true person, checks the same person permission, then calls `core/emergency-contacts.ts#updateEmergencyContact` |
| `emergency-contact-actions.ts#deleteEmergencyContactAction` | Archive one contact, preserving audit history; no automatic new Primary | `core/workforce-registers.ts#archiveEmergencyContact` resolves stored person, checks the same permission, then calls `core/emergency-contacts.ts#archiveEmergencyContact` |
| `workforce-record-actions.ts#saveWorkforceRecordAction` with kind Emergency | Positive non-HR fixed-command lane, with finite fields and expected version | Separate `core/workforce-maintenance.ts#maintainWorkforceRecord` / `app.access_workforce_maintain_record` owner; remains pending, not counted as implemented by this HR package |

All three legacy entry points first call `requireAdmin`. This package adds the caller's fresh Assistant
principal/grant/module/pause requirements and always refuses the caller's own person. It covers three native
operation intents under one registry action, `employees.emergency_contact.maintain`, with Approve ceiling.
No Automatic effect, model-supplied field values, provider request or new HR fact owner is added.

## Shared-person authority and custody

A contact belongs to a PERSON, not an employment. `app.access_workforce_person` (migration0579) preserves
any-administered-employment ownership but refuses an explicit denial on ANY retained employment company.
Requiring admin over every company would invent a stricter permission model; checking only the selected
employment would miss an explicit denial. The native person predicate is checked before private fields
and again by the native write. Legacy direct person maintenance uses that native permission; this package
does not borrow a payroll report grant or treat positive non-HR field grants as legacy HR authority.

The existing generic assigned ledger remains the only preparation owner. A compatibility adapter retains
both the HR-selected employment/company and the actual shared-person subject. Its receipt subject kind is
`person` and `receipt_subject_id=decision_subject_person_id`; it never chooses an arbitrary canonical
employment on recovery. Actor-owned nomination returns only the stored employment/person metadata after
fresh SQL login and native person checks, before sealed content is read or decrypted.

Access configuration and profile-value owners are locked before source reads. The reviewed digest binds:
selected employment/company/person and labels, an opaque fingerprint of every retained employment's
membership/version, every live contact's values and revision, the exact normalized native effect, and the
specific previous Primary that will become Secondary. The fingerprint reveals no other-company IDs.
Unknown/inaccessible/oversized sources fail closed without a partial review or effect. The native owner
still validates required names, relationship catalog rules with legacy tolerance, priority vocabulary and
the one-Primary invariant. Field text is data; no prose instruction chooses a service or widens authority.

The native `subjectEmploymentForPerson` may stamp a different employment of that same person. Completion
therefore proves the contact's person, the event employment's matching person, current-transaction contact
row and event, exact native aggregate/type/state and the caller's login. It does not require the event to
lie about the selected profile. Reopen returns the original receipt; duplicate or uncertain confirmation
never repeats the native effect. Archived contact history remains reconcilable.

## Human review and provider boundary

The person picks the employee, operation and existing contact, enters values, sees canonical before/after
facts, shared-person consequences and the exact previous Primary's identity, and confirms the reviewed
digest through the existing same-origin browser command. GET performs no maintenance. Search is bounded;
record choices are read only after selection and native authority. Six-locale panel copy and CI-only
1440px/390px fixtures cover add/primary transfer and archive review. New values and IDs stay local in
existing encrypted custody; no direct provider path or raw disclosure bypass is introduced.

## Authored evidence and limits

- `test/assistant-emergency-contact-maintenance.test.ts`: real migrated SQL/native writers, person-keyed
  receipts, old/wrong events, selected versus canonical event employment, actor/company/tenant refusal,
  preservation of qualification custody, concurrent confirmation, receipt recovery, source/membership
  staleness, exact Primary demotion, archive retention, explicit denied-company behavior and grant revocation.
- Existing registry role matrix has a native screen/offer/prepare/confirm adapter for all11 roles, including
  both performance partners, company/group HR, foreign company/tenant and cross-user custody probes.
- `test/emergency-contact-maintenance-contract.test.ts`: finite human input, operation/subject shape,
  hidden/forged fields and actual serialized Unicode budgets.
- `test/emergency-contact-maintenance-panel.dom.test.tsx`: explicit confirmation, person substitution,
  operation reset, archive, same-ID uncertain recovery, expiry, exact arbitrary text and six-locale visual
  fixtures using real controls and fictional same-origin responses.

These checks are authored, not locally executed. Parent owns exact40-character-SHA GitHub Actions
`alpha-focused-checks` with whole typecheck ON and standard hosted runners. No compiler, tests, build,
DB, dev server, staging business action, credential access, merge or deployment was run for this package.
The global release hold remains. SQL0716/idx697/when1793330000045 is an UNAPPLIED provisional source
claim, not installation priority; integration freeze must reconcile it with the then-live ordered ledger.
Historical SQL bytes remain unchanged. Positive non-HR Workforce command parity remains a distinct pending
capability. Other personnel packages and later requested domains remain with their owners.
