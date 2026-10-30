# Native passport target scope

This source change extends the existing native bank target guard to passport writes. The Personnel page already checks selected-employment Workforce access, but its direct standalone and consolidated passport actions previously forwarded a posted Person ID without the same target check. Both actions now nominate employment; the native country owner proves its current tenant/person binding and selected/shared-person access inside the same transaction before nationality or passport values are read.

The native owner retains the HR floor, genuine unlinked USER checks, native HR self edits, no-user provisioning, exact normalization, stored-nationality completeness rules, and Malaysian no-row clear behavior. No IC, tax, TP3, broad RLS or wizard behavior changes. The Assistant keeps its additional no-self and field-category checks and exact migration0722 persisted row/event proof.

A metadata-only country capability drives passport editor availability. Only passport controls are disabled; existing localized read-only copy is reused. The role probe now includes the actual page gate, and unrelated-company denial is grounded in the native endpoint rather than an expectation-only change.

Authored regressions cover real standalone/consolidated actions, mismatched nominations, private-read denial, scoped/unlinked HR, system/self compatibility, retained-company denial, locks/rollback, normalization/nationality/sibling preservation and no-row clear. Actual editor DOM tests cover disabled serialization and enabled defaults. They have not run at this source checkpoint; exact-SHA hosted verification is required.

The human explicitly approved this concrete patch before application. Earlier rejection and the unapplied proposal remain in private continuation evidence. This isolated child preserves normal-merge2a9c5398c63b5e7a9114166e090494ab334a124a; the already-dispatched five-group candidate stays frozen until all planned chunks finish. No local tests, compiler, database, build or server ran. No push, merge into protected refs, live HR action or deployment is authorized by this commit.
