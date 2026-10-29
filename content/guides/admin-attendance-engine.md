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

Open [Attendance settings](/admin/attendance/settings), choose **Locations**, then create or open a [Clocking location](/admin/work-locations/clocking). Set the location, latitude, longitude and geofencing radius in metres. Check the map and coordinates before saving. If the map cannot load, use its Retry action or enter the coordinates directly; a missing map does not establish that the coordinates are correct.

Web/mobile clocking may require location permission, an allowed location and the configured device checks. A denied browser permission or an out-of-range location needs investigation; creating a manual punch is not a substitute for diagnosing the clocking policy.

## Set up overtime patterns

Open [Overtime patterns](/admin/attendance/settings/overtime-patterns) from Attendance settings. The setup has four steps: **General Settings**, **Overtime Rates**, **Eligibility** and **Preview**. Enter the general settings, review the applicable rates, define eligibility, then inspect the complete preview. Resolve validation messages before continuing.

Review the pattern's company and effective settings before saving. Saving a draft, activating a pattern and assigning it to employees are separate actions; check the resulting status and intended assignments. A preview does not activate a pattern or authorize payment for recorded hours.

## Payroll handoff

Review planned overtime, actual attendance and approval results before consolidating attendance into payroll. Corrected attendance and approved overtime are inputs; payroll processing and review remain explicit actions.
