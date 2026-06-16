/**
 * Payroll kernel — generic, jurisdiction-neutral (ADR-0008). Computes gross→net and delegates
 * every statutory contribution to the company's country pack. Each mutation appends an event.
 */
import { and, desc, eq, gt, gte, inArray, isNull, like, lt, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { packFor } from '../localization/registry';
import { toCsv } from '../lib/csv';
import {
  attendance,
  company,
  compensation,
  employeeStatutoryMy,
  employment,
  leaveLedger,
  leaveRequest,
  leaveType,
  payrollBatch,
  payrollInput,
  payslip,
  person,
} from '../db/schema';

export class BatchNotDraftError extends Error {
  constructor() {
    super('Payslips can only be generated for a draft batch');
    this.name = 'BatchNotDraftError';
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function daysInMonth(year: number, month1: number): number {
  if (month1 === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return DAYS_IN_MONTH[month1 - 1];
}

/**
 * EA-1955 incomplete-month proration factor for a 'YYYY-MM' wage period: the employee is paid for
 * the calendar days they were employed within the month, over the number of days in that month
 * (Employment Act 1955 s.18A ordinary-rate basis). Returns 1 for a full month, 0 if not employed
 * during the period. Date strings are ISO ('YYYY-MM-DD'), so lexical comparison is chronological.
 */
function prorationFactor(payPeriod: string, hiredOn: string, terminatedOn: string | null): number {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const periodStart = `${payPeriod}-01`;
  const periodEnd = `${payPeriod}-${String(dim).padStart(2, '0')}`;
  const start = hiredOn > periodStart ? hiredOn : periodStart;
  const end = terminatedOn && terminatedOn < periodEnd ? terminatedOn : periodEnd;
  if (start > periodEnd || end < periodStart) return 0;
  const eligibleDays = Math.max(0, Number(end.slice(8, 10)) - Number(start.slice(8, 10)) + 1);
  return Math.min(1, eligibleDays / dim);
}

/**
 * Unpaid-leave days per employment for a wage period, auto-derived from APPROVED requests of an
 * unpaid leave type (leave_type.paid = false) that START within the period. Single source of truth
 * with the leave module — no double entry. (Requests straddling a month boundary are attributed to
 * their start month; cross-month splitting is a documented future refinement.)
 */
/**
 * Approved unpaid-leave days to deduct this period, by employment. Policy: a request is deducted in
 * full in the month it STARTS (filter on startDate ∈ period). Splitting a request that straddles a
 * month boundary across both months would need per-day expansion keyed to each leave type's counting
 * mode (the model stores per-request totals, not per-day) — deliberately deferred as a rare edge case.
 */
async function unpaidDaysByEmployment(
  tx: Tx,
  periodStart: string,
  periodEnd: string,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      employmentId: leaveRequest.employmentId,
      days: sql<string>`coalesce(sum(${leaveRequest.days}), 0)`,
    })
    .from(leaveRequest)
    .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
    .where(
      and(
        eq(leaveRequest.status, 'approved'),
        eq(leaveType.paid, false),
        gte(leaveRequest.startDate, periodStart),
        lte(leaveRequest.startDate, periodEnd),
      ),
    )
    .groupBy(leaveRequest.employmentId);
  return new Map(rows.map((r) => [r.employmentId, Number(r.days)]));
}

export async function createBatch(ctx: SessionContext, p: { companyId: string; payPeriod: string }) {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.payPeriod, p.payPeriod)))
      .limit(1);
    if (existing) throw new Error('A payroll batch already exists for this period');
    const [row] = await tx
      .insert(payrollBatch)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        payPeriod: p.payPeriod,
        batchDate: `${p.payPeriod}-28`,
        status: 'draft',
      })
      .returning({ id: payrollBatch.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: row.id,
      eventType: 'payroll-batch.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, payPeriod: p.payPeriod },
    });
    return { batchId: row.id };
  });
}

/** Upsert a draft batch's manual overtime input for one employee. Draft-only; appends an event. */
export async function setPayrollInput(
  ctx: SessionContext,
  p: {
    batchId: string;
    employmentId: string;
    overtimeAmount: number;
    bonusAmount?: number;
    tp1Deduction?: number;
    zakat?: number;
  },
  /** Optional caller transaction — pass it so this participates in an enclosing transaction
   *  (the performance bonus enact) and commits/rolls back atomically with it. */
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();
    const overtimeAmount = Math.max(0, Number(p.overtimeAmount) || 0);
    const bonusAmount = Math.max(0, Number(p.bonusAmount) || 0);
    const tp1Deduction = Math.max(0, Number(p.tp1Deduction) || 0);
    const zakat = Math.max(0, Number(p.zakat) || 0);
    const [existing] = await tx
      .select({ id: payrollInput.id })
      .from(payrollInput)
      .where(and(eq(payrollInput.batchId, p.batchId), eq(payrollInput.employmentId, p.employmentId)))
      .limit(1);
    if (existing) {
      await tx
        .update(payrollInput)
        .set({
          overtimeAmount: overtimeAmount.toFixed(2),
          bonusAmount: bonusAmount.toFixed(2),
          tp1Deduction: tp1Deduction.toFixed(2),
          zakat: zakat.toFixed(2),
          updatedAt: sql`now()`,
        })
        .where(eq(payrollInput.id, existing.id));
    } else {
      await tx.insert(payrollInput).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: p.employmentId,
        overtimeAmount: overtimeAmount.toFixed(2),
        bonusAmount: bonusAmount.toFixed(2),
        tp1Deduction: tp1Deduction.toFixed(2),
        zakat: zakat.toFixed(2),
      });
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.input-set',
      actor: actorOf(ctx),
      payload: { employmentId: p.employmentId, overtimeAmount, bonusAmount, tp1Deduction, zakat },
    });
    return { ok: true };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

/**
 * Prefill a draft batch's overtime inputs from classified attendance (ADR-0011 → money).
 * Per employee, the period's per-day OT minutes (workday / rest day / holiday) are
 * monetized by the country pack — ORP = wages/26, 1.5× workday, rest-day ½/1-day rule
 * + 2×, holiday +2 days' ORP + 3×, and the First Schedule RM4,000 eligibility gate
 * (STATUTORY-SOURCES §6). Existing bonus inputs are preserved; the admin can still
 * override any figure. Each applied row appends an input-set event carrying the
 * derivation, so every ringgit is traceable to hours and rates.
 */
export async function prefillOvertimeFromAttendance(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
        country: company.country,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();
    const pack = packFor(batch.country);
    if (!pack) throw new Error(`No localization pack for country ${batch.country}`);

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Statutory ruleset in effect at period end (ADR-0019): DB override or the verified default.
    const rules = await pack.payroll.loadRuleset(tx, { asOf: periodEnd });

    // Per-day classified OT minutes within the pay period (per-day matters: the
    // rest-day ½/1-day rule cannot be computed from monthly aggregates).
    const otRows = await tx
      .select({
        employmentId: attendance.employmentId,
        dayType: attendance.dayType,
        otMinutes: attendance.otMinutes,
      })
      .from(attendance)
      .innerJoin(employment, eq(employment.id, attendance.employmentId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          gte(attendance.attendanceDate, periodStart),
          lte(attendance.attendanceDate, periodEnd),
          gt(attendance.otMinutes, 0),
        ),
      );
    if (otRows.length === 0) return { applied: 0, ineligible: 0 };
    const empIds = [...new Set(otRows.map((r) => r.employmentId))];

    // Current s.2 wages (basic + fixed allowance) — the ORP basis.
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
    const wagesBy = new Map(
      comps.map((c) => [c.employmentId, round2(Number(c.basic) + Number(c.allowance ?? 0))]),
    );

    // Existing inputs: bonus must survive the prefill.
    const existing = await tx
      .select({
        id: payrollInput.id,
        employmentId: payrollInput.employmentId,
        bonus: payrollInput.bonusAmount,
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, p.batchId));
    const existingBy = new Map(existing.map((r) => [r.employmentId, r]));

    const daysBy = new Map<string, { dayType: 'workday' | 'rest_day' | 'holiday'; minutes: number }[]>();
    for (const r of otRows) {
      const arr = daysBy.get(r.employmentId) ?? [];
      arr.push({ dayType: r.dayType ?? 'workday', minutes: r.otMinutes ?? 0 });
      daysBy.set(r.employmentId, arr);
    }

    let applied = 0;
    let ineligible = 0;
    for (const employmentId of empIds) {
      const wages = wagesBy.get(employmentId);
      if (wages == null) continue; // no active compensation — nothing to monetize against
      const result = pack.payroll.overtimePay({
        monthlyWages: wages,
        days: daysBy.get(employmentId) ?? [],
        wageCeiling: rules.ot.wageCeiling,
      });
      if (!result.eligible) {
        ineligible += 1;
        continue; // > RM4,000 wages: no statutory OT — left for a manual (ex-gratia) entry
      }
      const prior = existingBy.get(employmentId);
      const bonusAmount = prior ? Number(prior.bonus) : 0;
      if (prior) {
        await tx
          .update(payrollInput)
          .set({ overtimeAmount: result.total.toFixed(2), updatedAt: sql`now()` })
          .where(eq(payrollInput.id, prior.id));
      } else {
        await tx.insert(payrollInput).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId,
          overtimeAmount: result.total.toFixed(2),
          bonusAmount: bonusAmount.toFixed(2),
        });
      }
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-batch',
        aggregateId: p.batchId,
        eventType: 'payroll-batch.input-set',
        actor: actorOf(ctx),
        payload: {
          employmentId,
          overtimeAmount: result.total,
          bonusAmount,
          source: 'attendance',
          derivation: {
            orp: result.orp,
            hourly: result.hourly,
            workday: result.workday,
            restDay: result.restDay,
            holiday: result.holiday,
          },
        },
      });
      applied += 1;
    }
    return { applied, ineligible };
  });
}

export async function generatePayslips(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx.select().from(payrollBatch).where(eq(payrollBatch.id, p.batchId)).limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    const [co] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, batch.companyId))
      .limit(1);
    const pack = packFor(co?.country);
    if (!pack) throw new Error(`No localization pack for ${co?.country ?? 'company'}`);

    // Active employees with current compensation.
    const { payPeriod } = batch;
    const [pYear, pMonth] = payPeriod.split('-').map(Number);
    const periodStart = `${payPeriod}-01`;
    const periodEnd = `${payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Statutory ruleset in effect at period end (ADR-0019 / ADR-0020). Loaded ONCE with its provenance
    // (source + packVersion + signedKeyId) and threaded into the (pure, synchronous) calculators below; the
    // ruleset `version` + pack provenance are snapshotted onto every payslip so a later edit/pack can never
    // alter this batch, and a forged/wrong-pack incident is traceable to the key + packVersion that produced it.
    const resolved = await pack.payroll.loadRulesetResolved(tx, { asOf: periodEnd });
    const rules = resolved.ruleset;
    const statutoryProvenance =
      resolved.source === 'pack' ? { packVersion: resolved.packVersion, signedKeyId: resolved.signedKeyId } : {};

    // Anyone employed for at least part of the period: hired on/before period end AND not
    // terminated before period start. Mid-period joiners/leavers get a prorated (final) payslip.
    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
        taxCategory: employeeStatutoryMy.taxCategory,
        numChildren: employeeStatutoryMy.numChildren,
        isResident: employeeStatutoryMy.isResident,
        eisEligible: employeeStatutoryMy.eisEligible,
        dateOfBirth: person.dateOfBirth,
        tp3Year: employeeStatutoryMy.tp3Year,
        tp3Net: employeeStatutoryMy.tp3NetRemuneration,
        tp3Epf: employeeStatutoryMy.tp3EpfClaimed,
        tp3Pcb: employeeStatutoryMy.tp3PcbPaid,
        tp3Zakat: employeeStatutoryMy.tp3ZakatPaid,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(
        compensation,
        and(
          eq(compensation.employmentId, employment.id),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
        ),
      );

    // Per-employee inputs: manual overtime (entered on the draft batch) + auto-derived unpaid days.
    const dim = daysInMonth(pYear, pMonth);
    const inputRows = await tx
      .select({
        employmentId: payrollInput.employmentId,
        overtime: payrollInput.overtimeAmount,
        bonus: payrollInput.bonusAmount,
        tp1: payrollInput.tp1Deduction,
        zakat: payrollInput.zakat,
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, p.batchId));
    const overtimeByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.overtime)]));
    const bonusByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.bonus)]));
    const tp1ByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.tp1)]));
    const zakatByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.zakat)]));
    const unpaidByEmp = await unpaidDaysByEmployment(tx, periodStart, periodEnd);

    // ── PCB accumulators (ADR-0014) ──
    // The accumulators (∑(Y−K), K claimed, X) are DERIVED by replaying this tax year's prior
    // payslips per employment, in period order, applying the cumulative EPF relief cap — the
    // payslip history is the ledger; no mutable accumulator state. TP3 / opening balances on the
    // statutory profile seed the replay for mid-year joiners or mid-year system adoption.
    const EPF_RELIEF_CAP = pack.payroll.epfReliefCap; // pack-owned: cap math always matches the calculator
    type Acc = {
      netRemuneration: number;
      epfClaimed: number;
      pcbPaid: number;
      zakatPaid: number;
      lpAccumulated: number;
    };
    const empIds = emps.map((e) => e.employmentId);
    const priorSlips = empIds.length
      ? await tx
          .select({
            employmentId: payslip.employmentId,
            period: payrollBatch.payPeriod,
            gross: payslip.grossPay,
            statutory: payslip.statutory,
          })
          .from(payslip)
          .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
          .where(
            and(
              inArray(payslip.employmentId, empIds),
              like(payrollBatch.payPeriod, `${pYear}-%`),
              lt(payrollBatch.payPeriod, payPeriod),
            ),
          )
      : [];
    priorSlips.sort((a, b) => a.period.localeCompare(b.period));
    const accByEmp = new Map<string, Acc>();
    for (const e of emps) {
      const tp3Applies = e.tp3Year === pYear;
      accByEmp.set(e.employmentId, {
        netRemuneration: tp3Applies ? Number(e.tp3Net ?? 0) : 0,
        epfClaimed: tp3Applies ? Math.min(Number(e.tp3Epf ?? 0), EPF_RELIEF_CAP) : 0,
        pcbPaid: tp3Applies ? Number(e.tp3Pcb ?? 0) : 0,
        zakatPaid: tp3Applies ? Number(e.tp3Zakat ?? 0) : 0,
        lpAccumulated: 0,
      });
    }
    for (const s of priorSlips) {
      const acc = accByEmp.get(s.employmentId);
      if (!acc) continue;
      const st = (s.statutory ?? {}) as { epfEmployee?: number; pcb?: number; lp?: number; zakat?: number };
      const claimed = Math.min(Number(st.epfEmployee ?? 0), Math.max(0, EPF_RELIEF_CAP - acc.epfClaimed));
      acc.netRemuneration = round2(acc.netRemuneration + Number(s.gross) - claimed);
      acc.epfClaimed = round2(acc.epfClaimed + claimed);
      acc.pcbPaid = round2(acc.pcbPaid + Number(st.pcb ?? 0));
      acc.zakatPaid = round2(acc.zakatPaid + Number(st.zakat ?? 0)); // §E.5: full zakat accrues to Z
      acc.lpAccumulated = round2(acc.lpAccumulated + Number(st.lp ?? 0));
    }

    /** Age at the period end; null when DOB is not captured (treated as < 60). */
    const ageAt = (dob: string | null): number | null => {
      if (!dob) return null;
      const d = new Date(`${dob}T00:00:00Z`);
      const ref = new Date(`${periodEnd}T00:00:00Z`);
      let age = ref.getUTCFullYear() - d.getUTCFullYear();
      if (
        ref.getUTCMonth() < d.getUTCMonth() ||
        (ref.getUTCMonth() === d.getUTCMonth() && ref.getUTCDate() < d.getUTCDate())
      ) {
        age -= 1;
      }
      return age;
    };

    const totals = {
      gross: 0, net: 0, epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0,
      socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0, deductions: 0, employerCost: 0,
    };

    for (const e of emps) {
      // Prorate contractual pay for mid-period joiners/leavers (full month → factor 1).
      // Allowance prorates with basic — EA-1955 incomplete-month treats fixed monthly wages as a whole.
      const factor = prorationFactor(payPeriod, e.hiredOn, e.terminatedOn);
      const daysWorked = Math.round(factor * dim); // proration basis surfaced on the payslip
      const basic = round2(Number(e.basic) * factor);
      const allowance = round2(Number(e.allowance ?? 0) * factor);
      const overtime = round2(overtimeByEmp.get(e.employmentId) ?? 0);
      const bonus = round2(bonusByEmp.get(e.employmentId) ?? 0);
      // Unpaid leave deducts at the EA-1955 ordinary rate of pay (monthly basic / days in month).
      const unpaidDeduction = round2((Number(e.basic) / dim) * (unpaidByEmp.get(e.employmentId) ?? 0));
      const normalWage = round2(basic + allowance + overtime); // regular monthly remuneration
      // Agency bases differ (STATUTORY-SOURCES §6): EPF EXCLUDES overtime, SOCSO/EIS/PCB
      // include it — so the calculator takes wages ex-OT and the OT separately.
      const wagesExOt = Math.max(0, round2(basic + allowance - unpaidDeduction));
      // Bonus is additional remuneration: EPF + PCB (difference method), excluded from SOCSO/EIS.
      const lp = round2(tp1ByEmp.get(e.employmentId) ?? 0);
      const zakat = round2(zakatByEmp.get(e.employmentId) ?? 0);
      const age = ageAt(e.dateOfBirth);
      const st = {
        ...pack.payroll.statutory(
          wagesExOt,
          { category: (e.taxCategory ?? 1) as 1 | 2 | 3, children: e.numChildren ?? 0 },
          bonus,
          overtime,
          { month: pMonth, acc: accByEmp.get(e.employmentId), lpCurrent: lp, zakatCurrent: zakat },
          {
            // Age 60+: SOCSO Second Category (employer-only) and EIS coverage ends (Act 800,
            // 18–60). The 57+-no-prior-contribution EIS exemption maps to the eisEligible flag.
            socsoCategory: age != null && age >= 60 ? 2 : 1,
            eisEligible: (e.eisEligible ?? true) && (age == null || age < 60),
            resident: e.isResident ?? true,
          },
          rules,
        ),
        // Stamped so future months' replay can accumulate Z and ∑LP (spec §E.5 / §D.1).
        lp,
        zakat,
      };
      const statDeductions = round2(st.epfEmployee + st.socsoEmployee + st.eisEmployee + st.pcb);
      const totalDeductions = round2(statDeductions + unpaidDeduction);
      const grossPay = round2(normalWage + bonus); // total earnings before deductions
      const net = round2(grossPay - totalDeductions);
      const employerCost = round2(
        wagesExOt + overtime + bonus + st.epfEmployer + st.socsoEmployer + st.eisEmployer,
      );

      await tx.insert(payslip).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: e.employmentId,
        basicSalary: basic.toFixed(2),
        allowance: allowance.toFixed(2),
        overtimePay: overtime.toFixed(2),
        bonus: bonus.toFixed(2),
        daysWorked: String(daysWorked),
        grossPay: grossPay.toFixed(2),
        statutory: { ...st, ...statutoryProvenance }, // `version` + (when source=pack) packVersion/signedKeyId snapshot
        otherDeductions: unpaidDeduction.toFixed(2),
        totalDeductions: totalDeductions.toFixed(2),
        netPay: net.toFixed(2),
        employerCost: employerCost.toFixed(2),
      });

      totals.gross += grossPay;
      totals.net += net;
      totals.epfEmployee += st.epfEmployee;
      totals.epfEmployer += st.epfEmployer;
      totals.socsoEmployee += st.socsoEmployee;
      totals.socsoEmployer += st.socsoEmployer;
      totals.eisEmployee += st.eisEmployee;
      totals.eisEmployer += st.eisEmployer;
      totals.pcb += st.pcb;
      totals.deductions += totalDeductions;
      totals.employerCost += employerCost;
    }
    (Object.keys(totals) as (keyof typeof totals)[]).forEach((k) => {
      totals[k] = round2(totals[k]);
    });

    await tx
      .update(payrollBatch)
      .set({ status: 'processed', employeeCount: emps.length, totals })
      .where(eq(payrollBatch.id, p.batchId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.processed',
      actor: actorOf(ctx),
      payload: { count: emps.length, totalNet: totals.net },
    });
    return { payslips: emps.length, totalNet: totals.net };
  });
}

export async function closeBatch(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'processed') throw new Error('Only a processed batch can be closed');
    await tx.update(payrollBatch).set({ status: 'closed' }).where(eq(payrollBatch.id, p.batchId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.closed',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}

export function listBatches(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollBatch.id,
        company: company.legalName,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
        employeeCount: payrollBatch.employeeCount,
        totals: payrollBatch.totals,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(companyIds && companyIds.length ? inArray(payrollBatch.companyId, companyIds) : undefined)
      .orderBy(desc(payrollBatch.payPeriod)),
  );
}

export type LeaverAdvisoryRow = {
  employmentId: string;
  name: string;
  terminatedOn: string;
  basic: number;
  annualBalance: number;
  /** Suggested pay-in-lieu for unused annual leave at ORP (basic / 26 per day, EA 1955). */
  suggested: number;
};

/**
 * Final-pay ADVISORY for employees terminating within a draft batch's period: unused annual
 * leave × ORP daily rate, per EA 1955 s.60E pay-in-lieu. Deliberately NO auto-pay — the
 * EPF/PCB treatment of encashment is not yet sourced, so the admin keys the amount into the
 * bonus input consciously (documented in STATUTORY-SOURCES.md).
 */
export function leaverAdvisory(ctx: SessionContext, batchId: string): Promise<LeaverAdvisoryRow[]> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) return [];
    const [y, m] = batch.payPeriod.split('-').map(Number);
    const start = `${batch.payPeriod}-01`;
    const end = `${batch.payPeriod}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
    const leavers = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        terminatedOn: employment.terminatedOn,
        basic: compensation.basicSalary,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(
        compensation,
        and(eq(compensation.employmentId, employment.id), isNull(compensation.validTo), isNull(compensation.supersededAt)),
      )
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          gte(employment.terminatedOn, start),
          lte(employment.terminatedOn, end),
        ),
      );
    if (leavers.length === 0) return [];
    const [annual] = await tx
      .select({ id: leaveType.id })
      .from(leaveType)
      .where(eq(leaveType.code, 'ANNUAL'))
      .limit(1);
    const out: LeaverAdvisoryRow[] = [];
    for (const l of leavers) {
      let balance = 0;
      if (annual) {
        const [row] = await tx
          .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
          .from(leaveLedger)
          .where(and(eq(leaveLedger.employmentId, l.employmentId), eq(leaveLedger.leaveTypeId, annual.id)));
        balance = Number(row?.bal ?? 0);
      }
      const basic = Number(l.basic);
      out.push({
        employmentId: l.employmentId,
        name: l.name,
        terminatedOn: l.terminatedOn!,
        basic,
        annualBalance: balance,
        suggested: balance > 0 ? round2((basic / 26) * balance) : 0,
      });
    }
    return out;
  });
}

export function batchDetail(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx.select().from(payrollBatch).where(eq(payrollBatch.id, batchId)).limit(1);
    if (!batch) return null;
    const slips = await tx
      .select({
        id: payslip.id,
        name: person.fullName,
        basic: payslip.basicSalary,
        bonus: payslip.bonus,
        daysWorked: payslip.daysWorked,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
        totalDeductions: payslip.totalDeductions,
        net: payslip.netPay,
        employerCost: payslip.employerCost,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payslip.batchId, batchId))
      .orderBy(person.fullName);
    return { batch, slips };
  });
}

export class PaymentSummaryNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentSummaryNotReadyError';
  }
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';

/**
 * Batch payment summary for manual bank upload. A plain, neutral CSV — employee, bank, account,
 * net pay — deliberately NOT a byte-exact bank giro / IBG file: every bank's bulk-payment format
 * differs and must be verified against that bank's own portal (tracked separately as Layer-B).
 * Available once the batch is processed/closed (payslips exist). Logs an export event on the
 * batch so this egress of bank + net-pay data is auditable.
 */
export function paymentSummaryForBatch(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        payPeriod: payrollBatch.payPeriod,
        company: company.legalName,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) throw new PaymentSummaryNotReadyError('Payroll batch not found.');
    if (batch.status === 'draft') {
      throw new PaymentSummaryNotReadyError(
        'Process the batch before exporting a payment summary — a draft has no payslips yet.',
      );
    }

    const rows = await tx
      .select({
        name: person.fullName,
        code: employment.employeeCode,
        ic: employeeStatutoryMy.icNumber,
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
        net: payslip.netPay,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(payslip.batchId, batchId))
      .orderBy(person.fullName);
    if (rows.length === 0) throw new PaymentSummaryNotReadyError('This batch has no payslips to export.');

    const header = ['No', 'Employee', 'Employee Code', 'IC', 'Bank', 'Account No', 'Net Pay (RM)'];
    const body = rows.map((r, i) => [
      i + 1,
      r.name,
      r.code ?? '',
      r.ic ?? '',
      r.bankName ?? '',
      r.bankAccountNo ?? '',
      Number(r.net).toFixed(2),
    ]);
    const content = toCsv([header, ...body]);
    const netTotalCents = rows.reduce((sum, r) => sum + Math.round(Number(r.net) * 100), 0);
    const missingBank = rows.filter((r) => !r.bankName || !r.bankAccountNo).length;
    const filename = `payment-summary_${slugify(batch.company)}_${batch.payPeriod}.csv`;

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: batchId,
      eventType: 'payroll-batch.payment-summary.exported',
      actor: actorOf(ctx),
      payload: { payeeCount: rows.length, netTotalCents, missingBank, payPeriod: batch.payPeriod },
    });

    return { content, filename, payeeCount: rows.length, netTotalCents, missingBank, payPeriod: batch.payPeriod };
  });
}

/** A single payslip's full breakdown for the employee detail/print view. RLS scopes it to
 *  what the caller may see (the employee sees their own via can_see_employment). */
export function payslipDetail(ctx: SessionContext, payslipId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: payslip.id,
        employee: person.fullName,
        company: company.legalName,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
        basic: payslip.basicSalary,
        allowance: payslip.allowance,
        overtime: payslip.overtimePay,
        bonus: payslip.bonus,
        daysWorked: payslip.daysWorked,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
        otherDeductions: payslip.otherDeductions,
        totalDeductions: payslip.totalDeductions,
        net: payslip.netPay,
        employerCost: payslip.employerCost,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payslip.id, payslipId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Rows for the draft-batch input editor: each active-in-period employee with their current manual
 * overtime and the auto-derived unpaid-leave days (read-only preview of what generation will apply).
 */
export function batchInputRows(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) return [];
    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;
    const emps = await tx
      .select({ employmentId: employment.id, name: person.fullName, basic: compensation.basicSalary })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(
        compensation,
        and(
          eq(compensation.employmentId, employment.id),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
        ),
      )
      .orderBy(person.fullName);
    const inputs = await tx
      .select({
        employmentId: payrollInput.employmentId,
        overtime: payrollInput.overtimeAmount,
        bonus: payrollInput.bonusAmount,
        tp1: payrollInput.tp1Deduction,
        zakat: payrollInput.zakat,
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, batchId));
    const otMap = new Map(inputs.map((r) => [r.employmentId, Number(r.overtime)]));
    const bonusMap = new Map(inputs.map((r) => [r.employmentId, Number(r.bonus)]));
    const tp1Map = new Map(inputs.map((r) => [r.employmentId, Number(r.tp1)]));
    const zakatMap = new Map(inputs.map((r) => [r.employmentId, Number(r.zakat)]));
    const unpaid = await unpaidDaysByEmployment(tx, periodStart, periodEnd);
    return emps.map((e) => ({
      employmentId: e.employmentId,
      name: e.name,
      basic: Number(e.basic),
      overtimeAmount: otMap.get(e.employmentId) ?? 0,
      bonusAmount: bonusMap.get(e.employmentId) ?? 0,
      tp1Deduction: tp1Map.get(e.employmentId) ?? 0,
      zakat: zakatMap.get(e.employmentId) ?? 0,
      unpaidDays: unpaid.get(e.employmentId) ?? 0,
    }));
  });
}
