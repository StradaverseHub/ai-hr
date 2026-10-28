# Leave Configuration — the order of build, cutover and removal

> Historical summary. Original observations apply only to their recorded source/date, not today.
> Full detail: `git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/design/a6fe37fc-migration-order.md`. Verify current code and evidence before acting.

The original sequence preserved working leave screens and employee journeys at every step: build routing replay first, add replacement type/entitlement/rule screens alongside existing pages, reconcile behavior, then replace old routes with redirects. No original round was authorized to redesign the leave engine or silently migrate data.

Preserve existing canonical calculation/approval owners, form action signatures, tri-state markers and hidden names. A missing marker must not clear neighboring fields. Include every configuration sub-form and leave-type selector; a visual reorganization cannot reduce the editable surface.

Before cutover, compare exact approver/rule/fallback decisions through the canonical resolver and authorized read-only replay. Test balances, requests, generation, archive/history and employee-facing routes. Prove reconciliation can fail; preserve historical records and hand-built rules. Delete old components only with proven replacements and same-commit route redirects. Any newly discovered schema requirement needs explicit migration allocation.

This sequence is historical, not a claim that a round is pending. Read the retained IA, current routes, replay tooling and regression tests before further changes. Installation-specific commands and September source counts remain only in Git.
