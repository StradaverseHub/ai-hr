# 420ebab5 · Personnel detail — which saves can fold into one Save per tab, and which cannot

> Historical summary. Original observations apply only to their recorded source/date, not today.
> Full detail: `git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/audits/420ebab5-personnel-save-classification.md`. Verify current code and evidence before acting.

Personnel tab-wide Save/Discard covers only ordinary editable fields. Ledger/lifecycle operations (salary revisions, CP38 changes, archive/delete and other irreversible actions) keep explicit independent commits and confirmations. Discard must never imply reversal of an already recorded transaction.

Audit both page forms and action-bound component islands, including identity, tax and bank cards. Retain tri-state markers and hidden identifiers; omission must not wipe neighboring fields. Recount current bindings rather than reusing the September form counts. Verify successful saves stay on the selected employee/tab, ordinary edits discard correctly, and standalone transactions remain outside the encompassing form.

Relevant checks: `test/personnel-tab-save.test.ts`, `test/personnel-tab-save.dom.test.tsx`, `test/personnel-payroll-tab-order.test.ts`.
