/**
 * Payroll readiness aggregation (feedback 5db3ae48, Phase A) — the config-LEVEL pre-flight the reporter's
 * proposed "PRE-PROCESS VALIDATION" step asks for, sitting one layer ABOVE the existing per-batch
 * preProcessAdvisory (core/payroll.ts). preProcessAdvisory checks employee master data on a concrete draft
 * batch; this checks whether the COMPANY is configured to run payroll at all — statutory tables resolvable,
 * an active cycle, a pay-day schedule, pay-item catalog, a payroll policy, and whether transactions have
 * been entered for the month.
 *
 * Read-only aggregation — NO writes, so no DomainEvent is appended (CLAUDE.md substrate skip rule: derived
 * read). // substrate: read-only, no event
 *
 * Each check resolves to one of three states (product decision 4, RECOMMENDED severities):
 *   • blocker — payroll cannot correctly run until fixed (no active cycle; employees with no salary record)
 *   • warning — payroll can run but a gap should be reviewed first (stale statutory pack, no pay-day, no
 *     assigned/default policy → monthly fallback applies, no statutory profile → defaults apply)
 *   • ok      — configured
 * The aggregate `blockers`/`warnings` counts and `ready` (blockers === 0) drive the guided Process view and
 * can gate the Generate action exactly as the per-batch blockers do today.
 */
import { and, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import {
  companyPayrollConfig,
  compensation,
  employeeStatutoryMy,
  employment,
  payComponent,
  payrollCycle,
  payrollIndividualTxn,
  payrollPolicy,
} from '../db/schema';
import { daysInMonth } from './payroll';

export type ReadinessStatus = 'ok' | 'warning' | 'blocker';

/** The reporter's PRE-PROCESS VALIDATION bullets, mapped to config-level checks. */
export type ReadinessCheckKey =
  | 'masterData' // Employee Profile Complete
  | 'payrollItems' // Mandatory Payroll Data Available (pay-item master)
  | 'statutoryConfig' // Statutory Configuration Valid
  | 'payrollCycle' // Payroll Cycle Available
  | 'payrollSchedule' // Payroll Schedule Available (pay-day)
  | 'payrollPolicy' // Payroll Policy Assigned
  | 'transactions'; // Payroll Transactions Completed

export type ReadinessCheck = {
  key: ReadinessCheckKey;
  status: ReadinessStatus;
  /** Machine-readable numbers the UI localises (never raw English). */
  detail: Record<string, number>;
  /** Deep-link the operator follows to close the gap. */
  href: string;
};

export type PayrollReadiness = {
  companyId: string;
  payPeriod: string;
  checks: ReadinessCheck[];
  blockers: number;
  warnings: number;
  /** True when nothing blocks a correct run (warnings may still be present). */
  ready: boolean;
};

const currentPayPeriod = () => new Date().toISOString().slice(0, 7);

/**
 * Aggregate every config-level readiness check for one company against a target pay month (defaults to the
 * current month). Pure reads; safe to call on any page. RLS confines every query to the caller's scope.
 */
export function payrollReadiness(
  ctx: SessionContext,
  p: { companyId: string; payPeriod?: string; statutoryStale?: boolean },
): Promise<PayrollReadiness> {
  const payPeriod = /^\d{4}-\d{2}$/.test(p.payPeriod ?? '') ? (p.payPeriod as string) : currentPayPeriod();
  return withTenant(ctx, async (tx) => {
    const [y, m] = payPeriod.split('-').map(Number);
    const periodStart = `${payPeriod}-01`;
    const periodEnd = `${payPeriod}-${String(daysInMonth(y, m)).padStart(2, '0')}`;

    // ── masterData ── the same period-active population as generatePayslips, compensation/statutory LEFT-
    // joined so gaps surface instead of silently dropping. Missing salary = blocker (the run's inner-join
    // would drop them); missing statutory profile = warning (EPF/SOCSO/PCB fall back to defaults).
    const masterRows = await tx
      .select({
        missingComp: sql<number>`count(*) filter (where ${compensation.id} is null)::int`,
        missingStat: sql<number>`count(*) filter (where ${employeeStatutoryMy.personId} is null)::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(employment)
      .leftJoin(
        compensation,
        and(eq(compensation.employmentId, employment.id), isNull(compensation.validTo), isNull(compensation.supersededAt)),
      )
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(
        and(
          eq(employment.companyId, p.companyId),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
        ),
      );
    const missingComp = masterRows[0]?.missingComp ?? 0;
    const missingStat = masterRows[0]?.missingStat ?? 0;
    const totalEmployees = masterRows[0]?.total ?? 0;
    const masterData: ReadinessCheck = {
      key: 'masterData',
      status: missingComp > 0 ? 'blocker' : missingStat > 0 ? 'warning' : 'ok',
      detail: { total: totalEmployees, missingCompensation: missingComp, missingStatutory: missingStat },
      href: '/people',
    };

    // ── payrollItems ── the pay-item master catalog (tenant-scoped). No active component ⇒ warning: the
    // kernel still computes basic pay + statutory, but no configured earnings/deductions can be applied.
    const [itemRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payComponent)
      .where(and(eq(payComponent.tenantId, ctx.tenantId), isNull(payComponent.archivedAt)));
    const activeItems = itemRow?.n ?? 0;
    const payrollItems: ReadinessCheck = {
      key: 'payrollItems',
      status: activeItems > 0 ? 'ok' : 'warning',
      detail: { activeComponents: activeItems },
      href: '/admin/pay-components',
    };

    // ── statutoryConfig ── the merged ruleset ALWAYS resolves (built-in default is the floor), so this is
    // never a hard blocker. Staleness (a newer pack file on disk not yet ingested) is a warning (decision
    // 4). Staleness is a disk read (`server-only`), so the CALLER (page) computes it and passes it in —
    // the core aggregator stays pure/testable and never touches the filesystem.
    const statutoryStale = p.statutoryStale === true;
    const statutoryConfig: ReadinessCheck = {
      key: 'statutoryConfig',
      status: statutoryStale ? 'warning' : 'ok',
      detail: { stale: statutoryStale ? 1 : 0 },
      href: '/payroll/configuration',
    };

    // ── payrollCycle ── at least one ACTIVE (non-archived) cycle is required to open a run (decision 4:
    // no active cycle = blocker). A configured company with cycles but none regular-mapped is a warning.
    const [cycleRow] = await tx
      .select({
        active: sql<number>`count(*) filter (where ${payrollCycle.archivedAt} is null)::int`,
        activeRegular: sql<number>`count(*) filter (where ${payrollCycle.archivedAt} is null and ${payrollCycle.runType} = 'regular')::int`,
      })
      .from(payrollCycle)
      .where(eq(payrollCycle.companyId, p.companyId));
    const activeCycles = cycleRow?.active ?? 0;
    const activeRegular = cycleRow?.activeRegular ?? 0;
    const payrollCycleCheck: ReadinessCheck = {
      key: 'payrollCycle',
      status: activeCycles === 0 ? 'blocker' : activeRegular === 0 ? 'warning' : 'ok',
      detail: { active: activeCycles, activeRegular },
      href: '/admin/payroll-cycle',
    };

    // ── payrollSchedule ── the company payroll-config pay-day is scheduling metadata; absent ⇒ warning
    // (decision 4: no schedule/pay-day = warning). The run still computes; the payment date defaults to
    // month-end. `hasConfig` distinguishes "no config row at all" from "row present, pay-day blank".
    const [cfg] = await tx
      .select({ payDay: companyPayrollConfig.payDay })
      .from(companyPayrollConfig)
      .where(eq(companyPayrollConfig.companyId, p.companyId))
      .limit(1);
    const hasPayDay = cfg != null && cfg.payDay != null;
    const payrollSchedule: ReadinessCheck = {
      key: 'payrollSchedule',
      status: hasPayDay ? 'ok' : 'warning',
      detail: { hasConfig: cfg != null ? 1 : 0, hasPayDay: hasPayDay ? 1 : 0 },
      href: '/admin/payroll-config',
    };

    // ── payrollPolicy ── an ACTIVE company policy OR a company-default policy id. Absent ⇒ warning, NOT a
    // blocker (decision 6, RECOMMENDED): resolveAssignedPolicy legitimately falls back to the monthly
    // default, so an unassigned company is a "review this" prompt, not a hard stop.
    const [polRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollPolicy)
      .where(and(eq(payrollPolicy.companyId, p.companyId), eq(payrollPolicy.status, 'active')));
    const activePolicies = polRow?.n ?? 0;
    const [cfgPol] = await tx
      .select({ def: companyPayrollConfig.defaultPayrollPolicyId })
      .from(companyPayrollConfig)
      .where(eq(companyPayrollConfig.companyId, p.companyId))
      .limit(1);
    const hasDefault = !!cfgPol?.def;
    const payrollPolicyCheck: ReadinessCheck = {
      key: 'payrollPolicy',
      status: activePolicies > 0 || hasDefault ? 'ok' : 'warning',
      detail: { activePolicies, hasDefault: hasDefault ? 1 : 0 },
      href: '/admin/payroll-policy',
    };

    // ── transactions ── an informational signpost (never blocks): how many individual (one-off) txns are
    // already keyed for this company+month — attached to a run OR unattached (batch_id NULL, pre-run). The
    // reporter's "enter transactions before you process" reminder; entering none is a legitimate month.
    const [txnRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollIndividualTxn)
      .where(and(eq(payrollIndividualTxn.companyId, p.companyId), eq(payrollIndividualTxn.payPeriod, payPeriod)));
    const txnCount = txnRow?.n ?? 0;
    const transactions: ReadinessCheck = {
      key: 'transactions',
      status: 'ok',
      detail: { entered: txnCount },
      href: '/payroll/transactions',
    };

    const checks: ReadinessCheck[] = [
      masterData,
      payrollItems,
      statutoryConfig,
      payrollCycleCheck,
      payrollSchedule,
      payrollPolicyCheck,
      transactions,
    ];
    const blockers = checks.filter((c) => c.status === 'blocker').length;
    const warnings = checks.filter((c) => c.status === 'warning').length;
    return { companyId: p.companyId, payPeriod, checks, blockers, warnings, ready: blockers === 0 };
  });
}
