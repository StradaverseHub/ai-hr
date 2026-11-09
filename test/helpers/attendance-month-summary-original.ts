/** Frozen2264 original full owner: function body byte-exact except its export name.
 * Test oracle only; no product selection, alternate writer or runtime permission. */
import {and,eq,gte,inArray,isNull,lte} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendance,employment,person} from '../../db/schema';
import {withAttendanceTenant as withTenant} from '../../core/module-gate';
import {withCanonicalAiReadTx} from '../../core/ai-read-transaction';
import {absenceBreakdownByEmployment,deductAbsentDaysByEmployment,type AbsenceBreakdown} from '../../core/absence-days';
import {formulaOvertimeForRowsTx} from '../../packs/attendance/overtime-records';
import {summarizeOvertimeRecords,type FormulaOvertimeRecord} from '../../lib/overtime-records';
import {todayInKualaLumpur} from '../../lib/hr-date';
import type {MonthSummaryRow} from '../../core/attendance';
const OT_CAP_MINUTES=104*60,WEEK_LIMIT_MINUTES=45*60;

export function attendanceMonthSummaryOriginal(
  ctx: SessionContext,
  p: { month: string; companyIds?: string[]; today?: string; measurement?:'raw' },
  existingTx?: Tx,
): Promise<MonthSummaryRow[]> {
  return withCanonicalAiReadTx(ctx, existingTx, 'attendance', withTenant, async (tx) => {
    const monthStart = `${p.month}-01`;
    const [y, m] = p.month.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const today = p.today ?? todayInKualaLumpur(); // absence only up to today (clamped in absence-days.ts)

    const emps = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode, // Employee ID left-of-name (feedback 38668d9b)
        companyId: employment.companyId,
        hiredOn: employment.hiredOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          isNull(employment.terminatedOn),
          p.companyIds && p.companyIds.length
            ? inArray(employment.companyId, p.companyIds)
            : undefined,
        ),
      )
      .orderBy(person.fullName);
    if (emps.length === 0) return [];
    const empIds = emps.map((e) => e.employmentId);

    const rows = await tx
      .select({
        employmentId: attendance.employmentId,
        date: attendance.attendanceDate,
        status: attendance.status,
        dayType: attendance.dayType,
        workedMinutes: attendance.workedMinutes,
        otMinutes: attendance.otMinutes,
        calcTrace:attendance.calcTrace,
      })
      .from(attendance)
      .where(
        and(
          inArray(attendance.employmentId, empIds),
          gte(attendance.attendanceDate, monthStart),
          lte(attendance.attendanceDate, monthEnd),
        ),
      );
    // e2632276 — the absence / leave-day counts are no longer derived here. They come from
    // core/absence-days.ts, the SAME helper the payroll deduction reads, so the number the month roll-up
    // prints and the number an employee is charged for can never drift apart.
    //
    // BUT THIS ROLL-UP IS MONEY, AND IT IS NOT THE DEDUCTION'S MONEY. `evaluateAllowancesForPeriod` →
    // `evaluateMonthly` (core/attendance-allowance.ts) gates a policy's `amount` on `present`, `absent`,
    // `late` and `leaveDays` straight off these rows. Every correction the `scheduled` rules make is
    // therefore a live change to who is paid an attendance allowance — landing on all nine companies the
    // day it deploys, with nobody having asked for it. The approved plan promises the opposite ("all 9 of
    // your companies keep behaving exactly as they do now until you turn it on"), so the corrections ride
    // behind the same switch the deduction does, resolved PER EMPLOYMENT off its assigned payroll policy:
    //
    //   OFF (every employment, day one) → `legacy`, a transcription of the loop that used to live right
    //       here. Company weekday pattern only; any attendance row means the day is spoken for; a
    //       partial-day leave date with no clock-in is an absence. Pinned byte-for-byte against a copy of
    //       main's algorithm over identical fixtures in test/absence-deduction.test.ts.
    //   ON  → `scheduled`, which differs in exactly four ways, all of them corrections:
    //       (a) an attendance row explicitly marked `status='absent'` is counted as ABSENT (legacy skipped
    //           every recorded date, and the tally below filed such a row under `present` — while the
    //           daily and individual screens have always shown it in red);
    //       (b) the ROSTER wins over the company weekday pattern, so a rostered rest day — or a
    //           default-shift pattern rest day — on a company working day is no longer an absence;
    //       (c) …and symmetrically a rostered SHIFT on a company non-working day now IS a scheduled day
    //           that can be absent;
    //       (d) an approved HALF-DAY or HOURLY leave date is no longer counted as a whole absent day.
    //
    // Two calls, not one, because the rule set is per employment. Each returns immediately on an empty id
    // list, so with the switch off nowhere — the shipped state — this is exactly one call, doing exactly
    // what the inline loop did.
    const deductAbsence = await deductAbsentDaysByEmployment(tx, empIds);
    const scheduledIds = empIds.filter((id) => deductAbsence.has(id));
    const legacyIds = empIds.filter((id) => !deductAbsence.has(id));
    const absence = new Map<string, AbsenceBreakdown>([
      ...(await absenceBreakdownByEmployment(tx, monthStart, monthEnd, legacyIds, {
        rules: 'legacy',
        until: today,measurement:p.measurement,
      })),
      ...(await absenceBreakdownByEmployment(tx, monthStart, monthEnd, scheduledIds, {
        rules: 'scheduled',
        until: today,measurement:p.measurement,
      })),
    ]);
    const formulaByDay=p.measurement==='raw'?new Map<string,FormulaOvertimeRecord|null>():await formulaOvertimeForRowsTx(tx,ctx,rows);
    const rowsByEmp = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = rowsByEmp.get(r.employmentId);
      if (arr) arr.push(r);
      else rowsByEmp.set(r.employmentId, [r]);
    }

    const MS_DAY = 86_400_000;
    const mondayOf = (iso: string) => {
      const d = new Date(`${iso}T00:00:00Z`);
      const off = (d.getUTCDay() + 6) % 7;
      return new Date(d.getTime() - off * MS_DAY).toISOString().slice(0, 10);
    };

    return emps.map((e) => {
      const myRows = rowsByEmp.get(e.employmentId) ?? [];

      let present = 0;
      let late = 0;
      let halfDay = 0;
      let workedMinutes = 0;
      let otWorkday = 0;
      let otRestDay = 0;
      let otHoliday = 0;
      const weekMinutes = new Map<string, number>();
      for (const r of myRows) {
        if (r.status === 'late') late += 1;
        else if (r.status === 'half_day') halfDay += 1;
        // e2632276 (a) — an explicit `absent` row is NOT a present day. It used to fall into this `else`
        // and inflate `present` while the same row rendered red as "Absent" on every other screen. Once
        // the switch is on it is counted by the `scheduled` breakdown instead, so nothing is counted
        // twice; with the switch OFF the row stays under `present`, exactly as it does in production —
        // `present` feeds evaluateMonthly's minAttendanceDays, so moving it un-gated would withhold
        // allowances nobody decided to withhold.
        else if (!(r.status === 'absent' && deductAbsence.has(e.employmentId))) present += 1;
        workedMinutes += r.workedMinutes ?? 0;
        const ot = r.otMinutes ?? 0;
        if (r.dayType === 'rest_day') otRestDay += ot;
        else if (r.dayType === 'holiday') otHoliday += ot;
        else otWorkday += ot;
        const wk = mondayOf(r.date);
        weekMinutes.set(wk, (weekMinutes.get(wk) ?? 0) + (r.workedMinutes ?? 0));
      }

      // e2632276 — one definition, shared with payroll (see the note above the call).
      const { absentDays: absent, leaveDays } = absence.get(e.employmentId) ?? { absentDays: 0, leaveDays: 0 };

      const totalOt = otWorkday + otRestDay + otHoliday;
      // The numeric legacy fields remain the raw measurement consumed by existing allowance owners.
      // Records display uses this explicit selected-stage projection, with unknown days preserved.
      const selectedRows=myRows.map(row=>({...row,formulaOvertime:formulaByDay.get(row.employmentId+'|'+row.date)??null}));
      const overtimeSummary=summarizeOvertimeRecords(selectedRows);
      const overtimeCapState=overtimeSummary.complete?(BigInt(overtimeSummary.knownMinutes.numerator)>BigInt(OT_CAP_MINUTES)*BigInt(overtimeSummary.knownMinutes.denominator)?'exceeded' as const:'within' as const):'unknown' as const;
      return {
        employmentId: e.employmentId,
        overtimeSummary,overtimeCapState,
        name: e.name,
        employeeCode: e.employeeCode,
        present,
        late,
        halfDay,
        absent,
        leaveDays,
        workedMinutes,
        otWorkday,
        otRestDay,
        otHoliday,
        otCapExceeded: totalOt > OT_CAP_MINUTES,
        over45hWeek: [...weekMinutes.values()].some((v) => v > WEEK_LIMIT_MINUTES),
      };
    });
  });
}
