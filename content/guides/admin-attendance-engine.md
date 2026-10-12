Use this guide when expected hours, lateness, overtime or attendance status looks wrong. Start with [Employee attendance](/attendance) or [Attendance breakdown](/attendance/breakdown) and open the affected employee and date.

## Check the source schedule

A day's schedule can come from its roster, the employee's assigned backup shift, or the company schedule fallback. A roster entry may explicitly represent a rest day. Review the actual source shown in the day's detail rather than assuming every employee follows the company week.

1. Check [Roster](/roster) for that employee and date.
2. Check the employee's shift arrangement and [Schedule assignment](/admin/attendance/schedule-assignment).
3. Review [Attendance settings](/admin/attendance/settings), including shifts, schedules, breaks and attendance rules.
4. Check holidays and approved leave for the date.
5. Compare raw clock events with the calculated result and its explanation.

Fixed-shift employees normally use their regular assignment; roster exceptions handle days that differ. A holiday changes day classification and can affect overtime treatment. Clock duration alone does not establish payable overtime: breaks, schedules, eligibility, rounding and approval rules also matter.

## Correct the right record

For a missed or incorrect punch, use the attendance request/correction workflow. For incorrect schedule configuration, correct the schedule or assignment with the intended dates. Use [Recompute attendance](/attendance/recompute) when an authorized historical recalculation is needed, and review its affected dates and result. Editing configuration alone is not proof that stored attendance or an existing payroll run has changed.

## Import clocking files

Open [File mappings](/admin/attendance/file-mappings) to define the device file's columns, date/time interpretation and employee/card mapping. Then open [Attendance import](/attendance/import), preview the file and resolve errors before committing. [Import logs](/attendance/import/logs) record the outcome. Check card assignments and avoid blindly re-uploading a file after an uncertain result.

## Clocking locations and devices

Configure approved locations through [Work locations](/admin/work-locations). Web/mobile clocking may require location permission, an allowed location and the configured device checks. A denied browser permission or an out-of-range location needs investigation; creating a manual punch is not a substitute for diagnosing the clocking policy.

## Payroll handoff

Review planned overtime, actual attendance and approval results before consolidating attendance into payroll. Corrected attendance and approved overtime are inputs; payroll processing and review remain explicit actions.
