# Approval rules that never decide anything — Demo Group

> Historical summary. Original observations apply only to their recorded source/date, not today.
> Full detail: `git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/reports/b2b31767-unreachable-approval-rules.md`. Verify current code and evidence before acting.

A read-only September routing audit found rules that never selected an approver, either because no active employment matched their scope or because another rule won. Its old counts and company-by-company rows are not current configuration.

Use the canonical approval resolver and read-only replay/coverage tooling against the explicitly selected tenant. Distinguish unmatched scope, precedence shadowing, company defaults and fallback routes. Compare exact employee/leave-type decisions before and after any proposed rule change. Never delete a rule merely because an old report called it unreachable. Preserve hand-built configuration and request history.
