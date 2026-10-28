# Wave 2 — payroll flexibility: design brief & decision register

> Historical summary. Original observations apply only to their recorded source/date, not today.
> Full detail: `git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/wave2-payroll-design.md`. Verify current code and evidence before acting.

June design covered HRDF, EPF modes and multiple payroll cycles. Its shipping statuses, branch names, statutory figures and pending work are historical.

Use ADR-0024 for the pay-period parent and cumulative-month delta model, ADR-0025 for typed components, and later signed-delta/EPF decisions for amendments. Preserve immutable saved payroll provenance and accountant sign-off requirements. Do not enable financial gates from an old status note; verify current source, configuration and required sign-off.
