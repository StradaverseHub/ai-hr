# ADR-0112 — Date corrections preserve schedule and application ownership

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- Date: 2026-10-13
- Status: Accepted
- Related: ADR-0069, ADR-0102, ADR-0105, ADR-0107; approved feedback 16c8bf4d revision 1.

Attendance Detail needs to correct one employment/date without rewriting a recurring schedule, the
employee's submitted request, an earlier approval, or Leave's records. A direct attendance update from
the page would create another calculation owner and would disappear during recomputation.

`attendance_day_adjustment` owns explicit date-only shift/day-kind selections and manual overtime rows.
The existing dated schedule resolver applies it ahead of the roster/default/rotation ladder. Records,
absence/payroll counts, the hourly schedule clamp, allowance facts and worked-day/OT calendars consume
the same corrected date. Resetting the shift or day kind to Auto removes that selection while keeping
other date decisions. No shift definition, recurring arrangement or calendar holiday is changed.

An overtime decision identifies a configured band by its stable row ID. Rule saves retain unchanged
band definitions and their creation history, including when another attendance setting is edited.
Changed or removed definitions require the dated decision to be reviewed explicitly. The editor
shows an unavailable band and calculation as unavailable, rather than inventing a zero-rate band. The no-band calculation has
one stable default row. Each manual row retains its exact integer minutes, the calculated value at the
decision, actor and time. Calculation traces preserve automatic results alongside effective results.
Other manual rows survive a save or recomputation. Auto removes only the selected row. A configuration
change that removes a manually decided row refuses recalculation until that row is explicitly returned
to Auto; the system neither drops the decision nor adds it to unrelated new bands. Manual totals cannot
exceed recorded worked minutes. A new aggregate overtime approval cannot silently replace live row
decisions; return those rows to Auto first. Existing approved totals remain the baseline for Auto.

Approved full-day, half-day and hourly leave remain authoritative. This editor shows the leave and
refuses a day-type replacement. A day with a dependent Leave Credit must be reviewed through Leave
Credits before its attendance evidence changes. Processed payroll requires explicit recalculation
consent and receives the existing recalculation mark; closed payroll refuses the transaction.

An irregularity correction operates on an existing request for the selected employment/date. The
original proposal, employee remarks and requested-event actor are unchanged. An administrator's amended
proposal is stored separately and audited with the actual actor. Amendments are allowed before any
frozen approval stage completes; later stages review the preserved proposal. The existing decision
service completes only the authorised stage and reports a remaining stage as pending. Self decisions,
stale views, cross-company subjects and unrelated requests refuse. An empty section creates no request.

Subject locks, date fingerprints, the existing payroll locks, RLS and one transaction protect saves.
Every correction records before/after schedule and row results in the domain-event ledger. The page
does not mutate raw punch evidence, application status, payroll totals, leave balances or AI decisions.
