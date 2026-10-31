# Personnel Family register parity — source candidate

Own package base460f70436002781704ae47e75730fb3a30ce29be, branch
`codex/ai-user-parity-personnel-family-20261030`. Fresh origin/main and origin/alpha were both
2f81373e5e18fb2b734dba0ded94866446afc065 before editing. The earlier compensation and custody trees
remain unchanged. This package grants no installation, deployment or protected-ref authority.

| Native HR intent | Actual owner and effect | Refusals |
| --- | --- | --- |
| Add | dependent-actions.addDependentAction → workforce-registers.addDependent → dependents.addDependent; insert one PERSON register row and dependent.added event, then native automatic relief sync | Missing current HR/Assistant authority, self, tenant/person/company scope or explicit retained-company denial; invalid relationship catalog/gender/category/share; unavailable automatic jurisdiction |
| Edit | Same wrapper resolves stored row's actual person → updateDependent; immediate patch, relationship applicability and obsolete spouse/child-field clearing; dependent.updated | Missing/archived row, foreign person ID, invalid native input, changed reviewed row/register/source/policy |
| Archive | Same stored-person wrapper → archiveDependent; retain row/history with archived_at; dependent.archived; sync automatic relief | Missing/archived row, native person authority or stale review |

All operations are immediate; birth, marriage and death dates remain native register values. There is
no scheduled effective-date command or second family fact owner. The current HR form permits the
full native field set; the separate positive Workforce editor has a smaller field capability set and
remains explicitly pending. A family or ESS field capability is not a statutory read permission.

The person owner permits an administered retained employment and refuses explicit workforce.maintain
denials in every retained company. The selected employment is only navigation/custody context. The
source reuses that owner through0716's nomination helper and native assertWorkforcePersonTx; it does
not invent all-company HR authority. Self is refused against the actual current app_user person as
well as captured context. Existing human grant, principal, Access configuration and Approve guards
apply before private values. No Automatic tier, provider calls, model command or tax/money arithmetic
is introduced; only a human browser packet reaches this package.

## Exact consequence and privacy boundary

core/dependent-review.ts owns a rollback-only SAVEPOINT over the same core/dependents commands used by
native wrappers. With outerTx supplied, their only writes are dependent row + event and the SQL
access_family_relief_sync owner, which writes statutory relief columns + event. No called writer
sends notifications/outgoing work or independently commits. The source holds Access/profile-policy,
retained employment, family-row, person/statutory, company and current payroll locks outside the
savepoint. It captures normalized before/after, rolls back every preview write, compares the private
reviewed digest on confirmation, then invokes the actual workforce wrapper once at top level. Native
row/event XIDs therefore belong to the completion transaction, not the rolled-back preview subtransaction.

The installed MY SQL owner derives only num_children and child_relief_table when mode is auto. Manual
and auto_table modes, no statutory row and already-current derivations return their native skipped
DTO with null before/after/values. A changed result includes only a closed auto-relief before/after
DTO with child count, mode auto and five category full/half cells. Before displaying it the caller
must read those THREE columns through ordinary current-login statutory RLS, matching the native
statutory read owner, and the newly emitted event must pass access_tax_audit_read. The source never
reads a whole statutory profile or copies tax/bank identifiers. Missing visibility, unknown legacy
category keys, incomplete/oversized register values or non-applicable posted fields hand off to the
native HR screen before custody is created or writes are committed. The UI always provides that
native handoff and explains the narrower supported shapes. Positive non-HR Workforce admission is
not claimed.

The native current-period payroll alert contains only period and batch count. It is an alert, NOT a
recalculation marker, generated payroll, approval or payment. Closed payroll is unchanged. Native MY
jurisdiction disagreement or sync failure propagates in the enclosing transaction and undoes the
family mutation, preserving native failure semantics rather than silently swallowing an automatic
consequence. Country logic and all eligibility/grid decisions remain inside the installed owner.

The private fingerprint binds the Access configuration revision and all retained employment revisions, all family row revisions (including
archived rows), statutory row revision, country revisions, current-period payroll revisions/status,
relationship/country option revisions, the HR date and native UTC payroll period, and installed relief
function definitions. Private statutory fingerprints contain no disclosed values. No public lookup
returns hidden-company IDs or payroll amounts. New employment insertion is also serialized by the
native person's enclosing FOR UPDATE/FK boundary; existing retained rows are locked.

## Custody and authored verification

0718 appends one action employees.family.maintain to the physical encrypted generic assigned ledger.
Receipt subject is PERSON; nomination preserves selected employment/company. Completion requires the
native employee_dependent row and dependent event written in the current transaction by this login,
matching aggregate/person/active-or-archived state. Canonical native event employment may differ from
the navigation employment but must name the SAME PERSON. Previous kinds delegate to their exact
predecessor helpers/constraints/index predicates; native outcome readers preserve dynamic bounds.
Completed replay/reopen returns the same receipt and never repeats a mutation. Review recovery keeps
all posted values local and encrypted; model handoffs carry only a fixed review route.

Authored tests cover real add/edit/archive, current-XID/old-event/foreign-row and wrong-digest custody,
shared-person cross-employment selection and explicit denial, role matrix, tenant/company/self and
revoked Assistant refusal, native failure parity, relationship clearing, stale family/statutory/
catalog/membership/payroll state, exact count/grid and alert, manual/auto_table/unchanged privacy,
statutory-row AND tax-audit hiding, preview rollback of full rows/events/payroll/outgoing work,
concurrent confirmation, replay and lost-response reopen. DOM fixtures cover exact before/after,
consent, archive, uncertain recovery, expiry and all six locales at desktop/mobile sizes.

No tests, compiler, build, database, dev server, CI or business actions were executed locally.
The checkout has no installed Next documentation; the new page follows the existing verified page
signature without changing framework APIs. Parent review and exact-SHA GitHub Actions remain pending.
0718/idx699/when1793330000047 is a PROVISIONAL source claim only. No release is inferred.
