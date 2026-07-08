/**
 * Statutory reporting seam (ADR-0010). Generic over jurisdiction: it asks the localization pack for
 * its report registry, then lists / previews / records reports. Reports are derived from payroll, but
 * a recorded generation is persisted as an append-only `statutory_report` artefact + domain event
 * (audit / idempotency / reproducibility). Filed per legal entity — RLS gates on is_admin_for.
 */
import { and, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  assignment,
  attendance,
  attendanceCorrection,
  attendancePolicy,
  clockingLocation,
  company,
  compensation,
  department,
  employment,
  person,
  position,
  statutoryReport,
} from '../db/schema';
import { packFor } from '../localization/registry';
import type { EaStatement, ReportDef, ReportResult } from '../localization/my/reports';
import type { ReportData } from '../lib/report-export';
import { daysInMonth } from './payroll';

async function companyCountry(ctx: SessionContext, companyId: string): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const [co] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, companyId))
      .limit(1);
    return co?.country ?? null;
  });
}

function reportsForCountry(country: string | null): ReportDef[] {
  const pack = packFor(country) as { reports?: ReportDef[] } | undefined;
  return pack?.reports ?? [];
}

/** Report definitions (metadata only) available for a company's jurisdiction. */
export async function listReports(ctx: SessionContext, companyId: string) {
  const country = await companyCountry(ctx, companyId);
  return reportsForCountry(country).map((r) => ({
    id: r.id,
    label: r.label,
    cadence: r.cadence,
    periodKind: r.periodKind,
  }));
}

async function resolveDef(ctx: SessionContext, companyId: string, reportId: string): Promise<ReportDef> {
  const country = await companyCountry(ctx, companyId);
  const def = reportsForCountry(country).find((r) => r.id === reportId);
  if (!def) throw new Error(`Unknown report '${reportId}' for ${country ?? 'company'}`);
  return def;
}

/** Generate a report for preview — pure, no artefact persisted. */
export async function reportPreview(
  ctx: SessionContext,
  p: { companyId: string; reportId: string; periodKey: string },
): Promise<ReportResult> {
  const def = await resolveDef(ctx, p.companyId, p.reportId);
  return def.generate(ctx, { companyId: p.companyId, periodKey: p.periodKey });
}

/** Generate and RECORD a report: persist a statutory_report artefact + append a domain event. */
export async function recordReport(
  ctx: SessionContext,
  p: { companyId: string; reportId: string; periodKey: string },
) {
  const def = await resolveDef(ctx, p.companyId, p.reportId);
  const result = await def.generate(ctx, { companyId: p.companyId, periodKey: p.periodKey });
  const country = await companyCountry(ctx, p.companyId);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(statutoryReport)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        jurisdiction: country ?? 'MY',
        reportType: def.id,
        periodKind: def.periodKind,
        periodKey: p.periodKey,
        status: 'draft',
        statutoryVersion: result.meta.statutoryVersion,
        rowCount: result.rows.length,
        totals: result.totals,
        generatedBy: ctx.userId,
      })
      .returning({ id: statutoryReport.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-report',
      aggregateId: row.id,
      eventType: 'statutory-report.generated',
      actor: actorOf(ctx),
      payload: {
        reportType: def.id,
        companyId: p.companyId,
        periodKey: p.periodKey,
        rowCount: result.rows.length,
        totals: result.totals,
      },
    });
    return row;
  });
}

/** Record a Layer-B submission FILE generation (byte-exact agency files, ADR-0010 §6D) as the
 *  same append-only artefact + event the table reports use. The file itself is not stored —
 *  it is reproducible from the payslips + the stamped statutory version. */
export async function recordFileReport(
  ctx: SessionContext,
  p: {
    companyId: string;
    reportType: string; // e.g. 'my.cp39-file'
    periodKey: string;
    rowCount: number;
    totals: Record<string, number>;
    statutoryVersion: string;
  },
) {
  const country = await companyCountry(ctx, p.companyId);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(statutoryReport)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        jurisdiction: country ?? 'MY',
        reportType: p.reportType,
        periodKind: 'month',
        periodKey: p.periodKey,
        status: 'draft',
        statutoryVersion: p.statutoryVersion,
        rowCount: p.rowCount,
        totals: p.totals,
        generatedBy: ctx.userId,
      })
      .returning({ id: statutoryReport.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-report',
      aggregateId: row.id,
      eventType: 'statutory-report.file-generated',
      actor: actorOf(ctx),
      payload: {
        reportType: p.reportType,
        companyId: p.companyId,
        periodKey: p.periodKey,
        rowCount: p.rowCount,
        totals: p.totals,
      },
    });
    return row;
  });
}

/**
 * Per-employee EA statement for a tax year, via the employment's jurisdiction pack. RLS scopes
 * visibility: an employee sees only their own (+ reports'); admins see their company scope.
 */
export async function employeeEaStatement(
  ctx: SessionContext,
  p: { employmentId: string; year: string },
): Promise<EaStatement | null> {
  const country = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ country: company.country })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    return row?.country ?? null;
  });
  const pack = packFor(country) as
    | { eaStatement?: (ctx: SessionContext, p: { employmentId: string; year: string }) => Promise<EaStatement | null> }
    | undefined;
  if (!pack?.eaStatement) return null;
  return pack.eaStatement(ctx, p);
}

// ── Compliance worklist (CP22 / CP22A) ──────────────────────────────────────
export type WorklistItem = {
  employmentId: string;
  name: string;
  form: 'CP22' | 'CP22A';
  reason: string;
  eventDate: string;
  dueBy: string;
  status: 'overdue' | 'due_soon' | 'upcoming';
};

const isoAddDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const statusFor = (today: string, dueBy: string): WorklistItem['status'] =>
  today > dueBy ? 'overdue' : today >= isoAddDays(dueBy, -7) ? 'due_soon' : 'upcoming';

/**
 * CP22 (new-hire) / CP22A (cessation) notifications due to LHDN, driven by the hire/termination
 * lifecycle (the same events the domain log records). MY-shaped — would move to the localization
 * pack for other jurisdictions. This is a human-reviewed worklist: filing happens in MyTax; we only
 * surface what's outstanding, never auto-submit (ADR-0010). No persistence yet — items age out of
 * the relevance window rather than being marked filed (a documented follow-up).
 */
export function complianceWorklist(
  ctx: SessionContext,
  p: { companyId: string; today?: string },
): Promise<WorklistItem[]> {
  const today = p.today ?? new Date().toISOString().slice(0, 10);
  const hireFloor = isoAddDays(today, -60); // recent hires still within / just past the 30-day window
  const ceaseFloor = isoAddDays(today, -60);
  const ceaseCeil = isoAddDays(today, 90); // upcoming cessations need notice before the date
  return withTenant(ctx, async (tx) => {
    const emps = await tx
      .select({
        id: employment.id,
        name: person.fullName,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(employment.companyId, p.companyId));
    const items: WorklistItem[] = [];
    for (const e of emps) {
      if (e.hiredOn >= hireFloor && e.hiredOn <= today) {
        const dueBy = isoAddDays(e.hiredOn, 30); // notify within 30 days of commencement
        items.push({ employmentId: e.id, name: e.name, form: 'CP22', reason: 'New hire', eventDate: e.hiredOn, dueBy, status: statusFor(today, dueBy) });
      }
      if (e.terminatedOn && e.terminatedOn >= ceaseFloor && e.terminatedOn <= ceaseCeil) {
        const dueBy = isoAddDays(e.terminatedOn, -30); // notify ≥30 days before cessation
        items.push({ employmentId: e.id, name: e.name, form: 'CP22A', reason: 'Cessation', eventDate: e.terminatedOn, dueBy, status: statusFor(today, dueBy) });
      }
    }
    const rank = { overdue: 0, due_soon: 1, upcoming: 2 };
    return items.sort((a, b) => rank[a.status] - rank[b.status] || a.dueBy.localeCompare(b.dueBy));
  });
}

/** Recently recorded report artefacts for a company (audit trail). */
export function recentReports(ctx: SessionContext, companyId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: statutoryReport.id,
        reportType: statutoryReport.reportType,
        periodKey: statutoryReport.periodKey,
        status: statutoryReport.status,
        rowCount: statutoryReport.rowCount,
        totals: statutoryReport.totals,
        statutoryVersion: statutoryReport.statutoryVersion,
        generatedAt: statutoryReport.generatedAt,
      })
      .from(statutoryReport)
      .where(eq(statutoryReport.companyId, companyId))
      .orderBy(desc(statutoryReport.generatedAt))
      .limit(20),
  );
}

// ─────────────────────────── Overtime report (Overtime Rate Config, #e410da83) ───────────────────────────
// A per-employee monthly overtime view that reconciles with the actual payslip: normal + total worked hours,
// OT hours split by category, the configured rate per category, the RM amount computed by the SAME
// `overtimePay` path payroll uses (so eligibility gate + configured excess multipliers are reflected), and an
// explicit eligibility label. Pure READ — no DomainEvent is appended (per substrate rules, read-only surfaces
// skip the event; this comment documents the deliberate skip). The report is exported via lib/report-export
// (CSV / XLSX / PDF) from the admin-gated route app/attendance/ot-report/export.

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const minToHours = (m: number) => r2(m / 60);

/** Structured OT report (for the export route + tests). Amounts reflect eligibility + configured rates. */
export type OvertimeReportRow = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  normalWorkingHours: number;
  totalWorkedHours: number;
  totalOtHours: number;
  normalDayOtHours: number;
  restDayOtHours: number;
  publicHolidayOtHours: number;
  workdayMultiplier: number;
  restDayExcessMultiplier: number;
  holidayExcessMultiplier: number;
  otAmount: number;
  eligible: boolean;
  otSource: 'system' | 'requested' | 'none';
  otApprovalStatus: 'approved' | 'pending' | 'none';
};

export type OvertimeReport = {
  month: string;
  /** The statutory version that produced the rate columns (for the report footnote / audit). */
  statutoryVersion: string | null;
  rows: OvertimeReportRow[];
};

/**
 * Build the monthly overtime report for the given companies. Resolves the effective OT ruleset once at
 * month-end (the same asOf payroll's prefill uses for the period), reads each active employee's current s.2
 * wages + per-day classified attendance OT, and monetizes via `overtimePay` so the RM figure equals what the
 * payslip would pay (including the >RM4,000 eligibility gate ⇒ RM 0.00, labelled "Above ceiling").
 */
export async function overtimeReport(
  ctx: SessionContext,
  p: { month: string; companyIds?: string[] },
): Promise<OvertimeReport> {
  return withTenant(ctx, async (tx) => {
    const [y, m] = p.month.split('-').map(Number);
    const monthStart = `${p.month}-01`;
    const monthEnd = `${p.month}-${String(daysInMonth(y, m)).padStart(2, '0')}`;

    const emps = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: employment.companyId,
        country: company.country,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined,
          lte(employment.hiredOn, monthEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, monthStart)),
        ),
      )
      .orderBy(person.fullName);
    if (emps.length === 0) return { month: p.month, statutoryVersion: null, rows: [] };
    const empIds = emps.map((e) => e.employmentId);

    // Effective OT ruleset ONCE at month-end (matches payroll prefill's periodEnd asOf). All companies in scope
    // share the tenant-wide ruleset; resolve via the pack of the first company that has one.
    const packCountry = emps.find((e) => packFor(e.country))?.country ?? null;
    const pack = packFor(packCountry);
    const ruleset = pack ? await pack.payroll.loadRuleset(tx, { asOf: monthEnd }) : null;
    const ot = ruleset?.ot;
    const restMult = ot?.restDayExcessMultiplier ?? 2;
    const holidayMult = ot?.holidayExcessMultiplier ?? 3;

    // Current s.2 wages (basic + fixed allowance) — the ORP basis, same as prefillOvertimeFromAttendance.
    const comps = await tx
      .select({
        employmentId: compensation.employmentId,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
      })
      .from(compensation)
      .where(
        and(
          inArray(compensation.employmentId, empIds),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      );
    const wagesBy = new Map(comps.map((c) => [c.employmentId, r2(Number(c.basic) + Number(c.allowance ?? 0))]));

    // Per-day attendance rows (the rest-day ½/1-day rule is per-day, so aggregates would be wrong).
    const attRows = await tx
      .select({
        employmentId: attendance.employmentId,
        dayType: attendance.dayType,
        workedMinutes: attendance.workedMinutes,
        otMinutes: attendance.otMinutes,
      })
      .from(attendance)
      .where(
        and(
          inArray(attendance.employmentId, empIds),
          gte(attendance.attendanceDate, monthStart),
          lte(attendance.attendanceDate, monthEnd),
        ),
      );

    // OT provenance/approval per employee, from the correction workflow (ADR-0069): a decided OT correction in
    // the month ⇒ employee-requested; a pending OT correction ⇒ approval still outstanding.
    const corrections = await tx
      .select({
        employmentId: attendanceCorrection.employmentId,
        status: attendanceCorrection.status,
        requestedOtMinutes: attendanceCorrection.requestedOtMinutes,
      })
      .from(attendanceCorrection)
      .where(
        and(
          inArray(attendanceCorrection.employmentId, empIds),
          gte(attendanceCorrection.attendanceDate, monthStart),
          lte(attendanceCorrection.attendanceDate, monthEnd),
        ),
      );
    const hasRequestedOt = new Set<string>();
    const hasPendingOt = new Set<string>();
    for (const c of corrections) {
      if (c.requestedOtMinutes == null) continue;
      hasRequestedOt.add(c.employmentId);
      if (c.status === 'pending') hasPendingOt.add(c.employmentId);
    }

    type Agg = { worked: number; ot: { workday: number; rest: number; holiday: number } };
    const aggBy = new Map<string, Agg>();
    const daysBy = new Map<string, { dayType: 'workday' | 'rest_day' | 'holiday'; minutes: number }[]>();
    for (const row of attRows) {
      const agg = aggBy.get(row.employmentId) ?? { worked: 0, ot: { workday: 0, rest: 0, holiday: 0 } };
      agg.worked += row.workedMinutes ?? 0;
      const otMin = row.otMinutes ?? 0;
      const dayType = row.dayType ?? 'workday';
      if (dayType === 'rest_day') agg.ot.rest += otMin;
      else if (dayType === 'holiday') agg.ot.holiday += otMin;
      else agg.ot.workday += otMin;
      aggBy.set(row.employmentId, agg);
      if (otMin > 0) {
        const arr = daysBy.get(row.employmentId) ?? [];
        arr.push({ dayType, minutes: otMin });
        daysBy.set(row.employmentId, arr);
      }
    }

    const rows: OvertimeReportRow[] = emps.map((e) => {
      const agg = aggBy.get(e.employmentId) ?? { worked: 0, ot: { workday: 0, rest: 0, holiday: 0 } };
      const otMinutesTotal = agg.ot.workday + agg.ot.rest + agg.ot.holiday;
      const wages = wagesBy.get(e.employmentId);
      const result =
        pack && wages != null
          ? pack.payroll.overtimePay({
              monthlyWages: wages,
              days: daysBy.get(e.employmentId) ?? [],
              wageCeiling: ot?.wageCeiling,
              restDayExcessMultiplier: restMult,
              holidayExcessMultiplier: holidayMult,
            })
          : null;
      const eligible = result?.eligible ?? false;
      const hasOt = otMinutesTotal > 0;
      return {
        employmentId: e.employmentId,
        name: e.name,
        employeeCode: e.employeeCode,
        // Normal working hours = worked minus OT (OT is over-and-above normal). Total = worked (already ex-OT).
        normalWorkingHours: minToHours(Math.max(0, agg.worked - otMinutesTotal)),
        totalWorkedHours: minToHours(agg.worked),
        totalOtHours: minToHours(otMinutesTotal),
        normalDayOtHours: minToHours(agg.ot.workday),
        restDayOtHours: minToHours(agg.ot.rest),
        publicHolidayOtHours: minToHours(agg.ot.holiday),
        // The workday rate is the EA s.60A statutory 1.5× (a higher per-employee policy multiplier is applied
        // downstream in payroll, not here); the two excess factors are the configured ruleset values.
        workdayMultiplier: 1.5,
        restDayExcessMultiplier: restMult,
        holidayExcessMultiplier: holidayMult,
        otAmount: result ? r2(result.total) : 0,
        eligible,
        otSource: hasOt ? (hasRequestedOt.has(e.employmentId) ? 'requested' : 'system') : 'none',
        otApprovalStatus: hasOt ? (hasPendingOt.has(e.employmentId) ? 'pending' : 'approved') : 'none',
      };
    });

    return { month: p.month, statutoryVersion: ruleset?.version ?? null, rows };
  });
}

/** English report column labels (export headers stay English by design, matching app/analytics/export). */
export const OVERTIME_REPORT_COLUMNS = [
  'Employee',
  'Employee code',
  'Normal working hours',
  'Total worked hours',
  'Total OT hours',
  'Normal day OT (h)',
  'Rest day OT (h)',
  'Public holiday OT (h)',
  'Workday rate',
  'Rest day excess rate',
  'Public holiday excess rate',
  'OT amount (RM)',
  'Eligibility status',
  'OT source',
  'OT approval status',
] as const;

/** Serialize the structured report into the neutral ReportData shape for lib/report-export. */
export function overtimeReportToReportData(report: OvertimeReport): ReportData {
  const eligibility = (row: OvertimeReportRow) =>
    row.eligible ? 'Eligible' : 'Above ceiling — no OT pay';
  const sourceLabel: Record<OvertimeReportRow['otSource'], string> = {
    system: 'System-calculated',
    requested: 'Employee-requested',
    none: '—',
  };
  const approvalLabel: Record<OvertimeReportRow['otApprovalStatus'], string> = {
    approved: 'Approved',
    pending: 'Pending',
    none: '—',
  };
  return {
    title: `Overtime report — ${report.month}`,
    filename: `overtime-report_${report.month}`,
    columns: [...OVERTIME_REPORT_COLUMNS],
    rows: report.rows.map((r) => [
      r.name,
      r.employeeCode ?? '',
      r.normalWorkingHours,
      r.totalWorkedHours,
      r.totalOtHours,
      r.normalDayOtHours,
      r.restDayOtHours,
      r.publicHolidayOtHours,
      `${r.workdayMultiplier}x`,
      `${r.restDayExcessMultiplier}x`,
      `${r.holidayExcessMultiplier}x`,
      r.otAmount.toFixed(2),
      eligibility(r),
      sourceLabel[r.otSource],
      approvalLabel[r.otApprovalStatus],
    ]),
  };
}

// ─────────────────────────── Daily attendance report (c440b365 gap-6) ───────────────────────────
// A per-day attendance view exposing the reporter's full field list (Branch, Position, Shift, Clock In/Out,
// Late Minutes, Early Out, Attendance Status, Clocking Location, Geofencing Status, Remarks, …) — the raw
// punch grid the OT summary omits. Pure READ (no DomainEvent — read-only surface, deliberate skip). Rows are
// keyed by field id for the custom-report registry to project. Company scope is enforced by the caller's
// scopeIds (already RLS-fenced); one month at a time.

const _toMin = (t: string | null): number | null => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const _hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

export type AttendanceDailyRow = Record<string, string | number | null>;

/** Build the per-day attendance grid for a month across the given companies. */
export async function attendanceDailyReport(
  ctx: SessionContext,
  p: { month: string; companyIds?: string[] },
): Promise<AttendanceDailyRow[]> {
  return withTenant(ctx, async (tx) => {
    const monthStart = `${p.month}-01`;
    const [y, m] = p.month.split('-').map(Number);
    const monthEnd = `${p.month}-${String(daysInMonth(y, m)).padStart(2, '0')}`;

    // One attendance policy per company → work-end / late-after thresholds for late/early-out minutes.
    const policies = await tx
      .select({ companyId: attendancePolicy.companyId, lateAfter: attendancePolicy.lateAfter, workEnd: attendancePolicy.workEnd })
      .from(attendancePolicy);
    const polByCompany = new Map(policies.map((pp) => [pp.companyId, pp]));

    const rows = await tx
      .select({
        name: person.fullName,
        employeeCode: employment.employeeCode,
        position: position.title,
        companyName: company.legalName,
        companyId: employment.companyId,
        departmentName: department.name,
        attendanceDate: attendance.attendanceDate,
        checkInAt: attendance.checkInAt,
        checkOutAt: attendance.checkOutAt,
        dayType: attendance.dayType,
        status: attendance.status,
        workedMinutes: attendance.workedMinutes,
        otMinutes: attendance.otMinutes,
        remarks: attendance.remarks,
        geofenceStatus: attendance.checkInGeofenceStatus,
        clockingLocationName: clockingLocation.name,
      })
      .from(attendance)
      .innerJoin(employment, eq(employment.id, attendance.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      // Current assignment (validTo/supersededAt null) → department + position.
      .leftJoin(
        assignment,
        and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
      )
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .leftJoin(clockingLocation, eq(clockingLocation.id, attendance.checkInClockingLocationId))
      .where(
        and(
          p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined,
          gte(attendance.attendanceDate, monthStart),
          lte(attendance.attendanceDate, monthEnd),
        ),
      )
      .orderBy(attendance.attendanceDate, person.fullName);

    return rows.map((r) => {
      const pol = polByCompany.get(r.companyId);
      const ci = _toMin(r.checkInAt);
      const co = _toMin(r.checkOutAt);
      const lateAfter = _toMin(pol?.lateAfter ?? null);
      const workEnd = _toMin(pol?.workEnd ?? null);
      const lateMinutes = ci != null && lateAfter != null && ci > lateAfter ? ci - lateAfter : 0;
      const earlyOut = co != null && workEnd != null && co < workEnd ? workEnd - co : 0;
      return {
        name: r.name,
        employeeCode: r.employeeCode ?? null,
        branch: r.companyName,
        department: r.departmentName ?? null,
        position: r.position,
        attendanceDate: r.attendanceDate,
        shift: r.dayType ?? null,
        clockIn: _hhmm(r.checkInAt),
        clockOut: _hhmm(r.checkOutAt),
        workingHours: r.workedMinutes == null ? null : r2(r.workedMinutes / 60),
        otHours: r.otMinutes == null ? null : r2(r.otMinutes / 60),
        lateMinutes,
        earlyOutMinutes: earlyOut,
        attendanceStatus: r.status,
        clockingLocation: r.clockingLocationName ?? null,
        geofencingStatus: r.geofenceStatus ?? null,
        remarks: r.remarks ?? null,
      };
    });
  });
}
