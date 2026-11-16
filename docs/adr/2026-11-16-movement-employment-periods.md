# Employment periods on comparison movements

Status: implementation candidate for the probation/notice portion of Stage 1 of approved feedback 8cff7fef.
The complete Stage 1, staging acceptance, and Stages 2–3 remain separate work.

The existing employment-information owner continues to own Probation, Extended Probation, Notice Before
Confirmation and Notice After Confirmation. Each is a value/unit pair. The Movement comparison form and
Employment tab reuse the same scalar controls, constraints, translated labels and unit catalogue.

Comparison movements carry these fields through their existing information leg, in the same transaction
and movement group as placement or salary changes. An absent field stays untouched; an explicitly empty
field clears it. A value that remains present requires a unit. Canonical employment validation checks
whole nonnegative numbers and Month/Week/Day. Legacy month values use the same fallback as Employment
when building the comparison baseline, without a backfill or an unrelated write.

The same fields participate in scheduled intent, conflict keys, edit/no-op detection, recorded-input
reconstruction, rollback and later-event replay. Audit/detail values come from the event's own before and
after, normalized to strings for transport, rather than from today's profile. The original event is
immutable. Existing closed-payroll correction authority and retained-output safeguards remain in force;
this portion does not supersede ADR-0164's acknowledgement rule.

Existing per-type field controls apply to each scalar, including optional/required supporting documents.
Migration 5772 widens both field-name constraints without changing records, grants or policies. The
Movement import derives its columns and validation from the form contract and passes these values to
the same dispatcher; it adds no independent employment writer.

The new behavior checks cover one-event writes, correction, inverse, later replay, scheduled application,
import, closed payroll preservation, invalid values, field controls and ordinary-user refusal. Shared
control DOM checks also cover Employment and draft transport. Hosted focused evidence is development
verification only; release still requires the approved stage's complete implementation, preview review
and normal release verification.
