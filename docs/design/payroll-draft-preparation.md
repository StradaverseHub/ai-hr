# Payroll Draft preparation for approved formula overtime

Before this change, the visible fresh Payroll Process wizard created and generated a run together.
The formula overtime transfer owner requires a Draft run; using Reset as preparation would require a
separate platform risk switch. Save as draft now prepares Regular runs directly through the existing
canonical createBatch owner, with no generation, reset, flags or alternate financial writer.

On the final review step, Save as draft carries all selected companies, period, each company's active
Regular cycle, payment date, exact selected employee IDs and the return filters. It works for one or
multiple companies. Per-company failures remain visible beside successful Draft links. The result
screen says Draft saved and does not claim calculated payslips. Open the Draft to review or transfer
approved formula overtime, then use normal Process when ready. Existing Draft resume already has a
Draft and continues to offer normal Process.

Additional cycles retain normal Process. Draft preparation is visibly and server-side Regular-only:
additional-run owners intentionally allocate new run sequences and do not expose a replay identity.
No additional cycle is silently replaced with Regular. Regular duplicate/repeated/concurrent saves
are bounded by the existing canonical creation/uniqueness refusal; this is not an update-or-reuse promise.
A synchronous UI guard and awaited transition prevent accidental double clicks or competing buttons.
A partial multi-company save is not an all-or-nothing group transaction. Review its per-company outcomes
rather than blindly retrying; an existing Regular run is reported as already present.

Both Draft and Process now preserve explicit employee-selection intent. A touched empty selection or
a selected company containing none of those employees must refuse, never fall back to the entire
company. Employee membership is checked against the canonical period-aware Payroll population;
stale/outside IDs refuse the request instead of being silently dropped. An untouched selection alone
retains the existing whole-company default. Authentication, company grants, module/cycle/closed-period
creation guards and Payroll RLS remain owned by existing services. No new permission or reset grant.

For the fictional b3 ordering journey: grant ToilFirst through HR before any period Payroll exists;
then save the five-subject Regular Draft in this UI. Read the saved formula source/claim; ToilFirst
remains TOIL-claimed and unavailable for cash, while CashFirst can transfer to this Draft. After that
cash claim, HR Leave Credit review must refuse CashFirst. Save as draft itself does not bank credit,
calculate formula output, reserve cash or create payslips.

Source regression coverage added: real-owner two-company Draft/no-payslip/exact date-cycle-scope;
repeat/concurrent creation; both modes' explicit subset and touched-empty/stale refusal; period leaver
inclusion; company authorization; stale cycle refusal. DOM coverage drives the actual wizard Save and
Process buttons, full form payload, pending double-click prevention, additional-cycle explanation and
six-locale/result-shape contracts. Types, tests, DB and actual app verification remain unrun by the
builder. Parent must execute those checks and the saved Draft-to-transfer-to-Process journey.

An explicit stale, inactive or unknown selected cycle now refuses INVALID_CYCLE in both Draft and
Process. The visible wizard and inspected callers always supply a cycle; there is no supported
empty-cycle caller requiring a Regular fallback, so empty selections refuse too. A cycle's type is
not invented when its selected row cannot be resolved.

Population reads retain per-company safe failure outcomes. With an untouched whole-company selection,
a failed company read does not erase successful companies' outcomes. With explicit selected IDs,
creation proceeds only when their entire ownership/population can be proven; an unreadable company
that might contain a selected ID makes the selection unproven and prevents partial scope dropping.
No failed population read becomes an empty whole-company scope. Reader-failure regressions inject a
bounded owner-read failure and still exercise real canonical creation for the proven company.
