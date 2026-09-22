-- 0479 — r328 (a96d320c) "Individual Payslip: Payment Date, Payslip Layout and Rate/Input": where the
-- overtime HOURS and the RATE the run used are written down.
--
-- WHY A COLUMN AT ALL. The reporter asked to see, on their payslip, the rate and the hours behind the
-- overtime figure. Those numbers exist for one instant and are then thrown away: `prefillOvertimeFromAttendance`
-- reads the month's classified attendance, hands it to the statutory overtime engine, writes the single
-- RINGGIT TOTAL to payroll_input.overtime_amount and keeps nothing else. `payslip` has `overtime_pay` and
-- no hours column; `statutory.componentLines` carries code/name/amount/buckets and no quantity and no rate
-- (verified against a production row).
--
-- AND WHY IT MAY NOT BE RE-DERIVED WHEN THE PAYSLIP IS OPENED. Attendance is correctable after a run —
-- r322 made mid-month correction a one-press admin action — so a payslip opened next month would report
-- TODAY's attendance about a month already paid, and disagree with the money printed beside it. The
-- kernel already refuses exactly this for `recordLines.nonPayable` and for the non-payable pay items on
-- the printed document. So the derivation is stamped WHERE AND WHEN IT HAPPENS, and read back.
--
-- WHY ON payroll_input AND NOT ON payslip. The decomposition is an INPUT: it belongs to the row whose
-- `overtime_amount` it produced, it is written by the prefill (which runs before the payslip exists), and
-- it survives a recalculation for the same reason the OT figure itself does. generatePayslips copies it
-- onto the payslip's own immutable statutory snapshot, and ONLY when the decomposition's own total still
-- equals the overtime figure that payslip is about to print — so a hand-keyed figure, an OT cap that
-- clipped, a one-off overtime transaction or an additional run all yield NO detail rather than a caption
-- that contradicts the amount above it.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL, AND THAT IS THE POINT. Every payroll_input row that exists today
-- reads as "this run did not record the detail", which is the truth: it did not. Those payslips keep
-- printing exactly the overtime line they print now. There is no GRANT here because no table is created —
-- payroll_input's grants already cover its columns.

ALTER TABLE "payroll_input" ADD COLUMN IF NOT EXISTS "ot_derivation" jsonb;--> statement-breakpoint

-- The DB asserts only "an object", the same depth of check 0475 applies to a jsonb rule column. The SHAPE
-- ({ version, orp, hourly, total, lines[] }) is the kernel's contract, written by one function and read by
-- one function, and is validated where it is read rather than by a constraint that would have to be
-- migrated every time a leg is added.
ALTER TABLE "payroll_input" DROP CONSTRAINT IF EXISTS "payroll_input_ot_derivation_check";--> statement-breakpoint
ALTER TABLE "payroll_input"
	ADD CONSTRAINT "payroll_input_ot_derivation_check"
	CHECK ("ot_derivation" IS NULL OR jsonb_typeof("ot_derivation") = 'object');
