# Stored overtime in Attendance Records

Source implementation for fcc2ea42; no runtime, type, database, test or release pass is claimed.

`formulaOvertimeForRowsTx` projects only already RLS-visible employment/date rows, in batches of5000, using the immutable duration owner. `FormulaOvertimeRecord` contains status, cash status, exact payable rational and source/calculation/version references. It contains no salary, formula input JSON, rates or monetary evidence. An explicit sourceUnavailable marker or unreadable/mismatched recorded marker refuses the projection instead of falling back to legacy OT. A duration may remain known when cash pricing alone is refused.

Daily, Individual, My Records, their day views, Breakdown, recent Attendance loader and the past-day OT application fact carry the same projection. Formula-covered rows do not print old fixed-rate buckets or open a legacy rate explanation. Formula references are secondary disclosures; the primary value is the exact duration/status. Decimal minutes are printed exactly when finite, otherwise as a rational. No fractional minute is rounded into an integer or a fixed legacy rate.

Monthly display totals aggregate selected formula duration with unassigned legacy OT, preserving unknown days. Existing raw monthly numeric fields and measurement:'raw' retain their Attendance Allowance ownership and skip the new display read. Ordinary work/lateness/absence are unchanged. The warning-only Plan OT month view uses the same selected exact duration plus each approved, unlanded plan once. BigInt comparison preserves fractional boundaries against the existing integer cap; incomplete months show unable-to-assess and no progress bar. The old numeric month API remains raw compatibility for other consumers.

`formulaOvertimeCashForRowsTx` bulk-reads stored line amounts and the recorded expected total under existing financial/self RLS plus an explicit financial/self predicate. It selects no salary JSON. Missing or inconsistent private evidence is unavailable, not zero. Export formula totals preserve each recorded currency/minor scale and report active cash/TOIL/unsettled attribution separately; a recorded result is not asserted to have been paid. Formula days never enter current-wage/country legacy monetization. Duration and cash calculation pins must agree before a combined export is known.

Generic attendance_ot and attendance_daily report fields distinguish legacy numeric compatibility fields from new exact text duration/status/reference fields. Saved field identities remain stable. Personnel catalogue declarations are untouched; the present Employee Master Attendance owner reads profile/schedule configuration and exposes no daily OT calculation field.

## Review of the source UI

| Before | After | Why |
| --- | --- | --- |
| A formula day displayed old integer OT or fixed-rate buckets | Exact stored minutes and a formula status/reference; legacy buckets are blank | Arbitrary tiers and fractions cannot be represented by the old buckets |
| Missing calculation could appear as a known legacy amount | Unavailable duration and explicit incomplete export counts | Unknown is distinct from recorded zero |
| A legacy hover could explain a formula bucket | Formula details disclose stored version/reference; no legacy hover for blank buckets | Avoids presenting another calculation's working |

Native details disclosure is keyboard accessible; components pass only serializable data, use existing light/dark tokens and table overflow, and add no effects, animation or per-row network fetch. All new screen wording is present in six locales. Generic report labels/export headers remain English per their existing explicit contract. Actual narrow/light/dark/keyboard rendering and runtime logs remain unverified during the shared hold.

## Narrow first-check-in correction

An out-first Attendance row exists before its first actual in-punch. The check-in loader now selects its previous checkInAt, derives the updated day first, then captures current Personnel only when the old row had no check-in (or did not exist). Repeated in-punches preserve the original capture; an already observed first in with missing historical context does not backfill from today's profile. A dedicated regression covers out-first → first actual in → profile edit → repeated in, plus the missing-context historical control.

## Verification and remaining work

Written regressions cover fractional/repeating exact display, known zero/ineligible/refused/null, mixed totals, marker mismatch, no salary projection, fixed-bucket suppression, currency precision and explicit unknown export states; real scoped Daily/Individual/cash readers, cross-tenant refusal and first-in capture have database regressions. Existing column-span and nullable legacy-bucket type guards were updated without removing their invariants. These tests are UNRUN.

The exact monthly warning has pure fractional/boundary/unknown regressions and a database regression for approved-unlanded plans. It remains warning-only and changes no cap value or submission/approval policy. Parent owns facade exports, actual app walkthrough, focused checks, release gate and deployment. No source, schema, journal, Payroll/TOIL mutation or formula-engine changes are made by this Records slice, except the explicitly assigned narrow first-check-in hook correction.
