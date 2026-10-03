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
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import {
  company,
  companyPayrollConfig,
  compensation,
  employeeStatutoryMy,
  employment,
  payComponent,
  payrollCycle,
  payrollIndividualTxn,
  payrollPolicy,
  person,
} from '../db/schema';
import { daysInMonth } from './payroll';
import { compensationEffectiveOn } from './comp';

export type ReadinessStatus = 'ok' | 'warning' | 'blocker';

/** The reporter's PRE-PROCESS VALIDATION bullets, mapped to config-level checks. */
export type ReadinessCheckKey =
  | 'masterData' // Employee Profile Complete
  | 'payrollItems' // Mandatory Payroll Data Available (pay-item master)
  | 'statutoryConfig' // Statutory Configuration Valid
  | 'payrollCycle' // Payroll Cycle Available
  | 'defaultCycle' // 707b3851 — the company's named default cycle actually exists and is active
  | 'payrollSchedule' // Payroll Schedule Available (pay-day)
  | 'payrollPolicy' // Payroll Policy Assigned
  | 'payModes' // ADR-0078 — no employee on a pay mode with no calculation (custom_period)
  | 'transactions'; // Payroll Transactions Completed

export type ReadinessCheck = {
  key: ReadinessCheckKey;
  status: ReadinessStatus;
  /** Machine-readable numbers the UI localises (never raw English). */
  detail: Record<string, number>;
  /** ADR-0078 — the affected employees BY NAME, for blockers that must name who is unpayable
   *  (payModes). Optional; absent for every count-only check. */
  names?: string[];
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
        and(eq(compensation.employmentId, employment.id), compensationEffectiveOn(periodEnd)),
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

    // ── defaultCycle ── feedback 707b3851. company.default_payroll_cycle stores a cycle NAME, and the
    // Payroll Process wizard preselects it. Two production companies name "Monthly" while holding ZERO
    // cycles: the field READS as configured and nothing says otherwise until a run is refused. This is a
    // distinct fact from payrollCycle above (which asks "are there any cycles?") — a company can have a
    // full catalog and still point its default at a cycle that was archived or renamed. Not a blocker in
    // its own right: the wizard falls back to letting the operator pick, so a stale default is a WARNING;
    // the hard stop is the cycle catalog being empty, which payrollCycle already raises. Name-matched
    // case-insensitively, exactly as setCompanyDefaultPayrollCycle validates on save.
    const [co] = await tx
      .select({ defaultCycle: company.defaultPayrollCycle })
      .from(company)
      .where(eq(company.id, p.companyId))
      .limit(1);
    const defaultCycleName = (co?.defaultCycle ?? '').trim();
    const [defMatch] = defaultCycleName
      ? await tx
          .select({ id: payrollCycle.id })
          .from(payrollCycle)
          .where(
            and(
              eq(payrollCycle.companyId, p.companyId),
              isNull(payrollCycle.archivedAt),
              sql`lower(${payrollCycle.name}) = lower(${defaultCycleName})`,
            ),
          )
          .limit(1)
      : [];
    const defaultCycleCheck: ReadinessCheck = {
      key: 'defaultCycle',
      status: !defaultCycleName ? 'warning' : defMatch ? 'ok' : 'warning',
      detail: { named: defaultCycleName ? 1 : 0, resolves: defMatch ? 1 : 0 },
      // The name itself is data, not a translatable string — carried through `names` so the UI can quote
      // the missing cycle without the core building an English sentence.
      ...(defaultCycleName && !defMatch ? { names: [defaultCycleName] } : {}),
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

    // ── payModes ── ADR-0078 (642ecc55): any period-active employee whose OPEN compensation row carries
    // pay_mode='custom_period' BLOCKS the run — that mode has no calculation behind it, and letting the run
    // proceed would quietly pay the monthly-equivalent basic for a structure explicitly marked not-monthly.
    // Named per employee (the feedback's decision 4: "naming the employee"). Hourly is NOT blocked: per_hour
    // is a real, kernel-resolved calculation against attendance hours, live now that the rate is per-employee.
    const payModeRows = await tx
      .select({ name: person.fullName })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(
        compensation,
        and(eq(compensation.employmentId, employment.id), compensationEffectiveOn(periodEnd)),
      )
      .where(
        and(
          eq(employment.companyId, p.companyId),
          eq(compensation.payMode, 'custom_period'),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
        ),
      )
      .orderBy(person.fullName);
    const payModes: ReadinessCheck = {
      key: 'payModes',
      status: payModeRows.length > 0 ? 'blocker' : 'ok',
      detail: { unpayable: payModeRows.length },
      ...(payModeRows.length > 0 ? { names: payModeRows.map((r) => r.name) } : {}),
      href: '/people',
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
      defaultCycleCheck,
      payrollSchedule,
      payrollPolicyCheck,
      payModes,
      transactions,
    ];
    const blockers = checks.filter((c) => c.status === 'blocker').length;
    const warnings = checks.filter((c) => c.status === 'warning').length;
    return { companyId: p.companyId, payPeriod, checks, blockers, warnings, ready: blockers === 0 };
  });
}

// ─── Cross-company cycle readiness (feedback 707b3851) ────────────────────────────────────────────────

/**
 * What one company is missing before a payroll run can START, expressed against the ONE gate that
 * actually refuses: core/payroll-run-group.ts resolves the company's own active cycle of the intended run
 * type and fails that company with `INVALID_CYCLE` when there is none. Everything else in
 * payrollReadiness is advice; this is the wall.
 */
export type CompanyCycleReadiness = {
  companyId: string;
  companyName: string;
  /** Active (non-archived) cycles in this company's catalog. */
  activeCycles: number;
  /** Of those, the ones mapped to the 'regular' run type — what an ordinary monthly run needs. */
  activeRegularCycles: number;
  /** The name stored on company.default_payroll_cycle. May name a cycle that does not exist. */
  defaultCycleName: string;
  /** True when that name matches an active cycle of this company (case-insensitive). */
  defaultCycleResolves: boolean;
  /** False ⇒ a regular payroll run would be refused today with INVALID_CYCLE. */
  canRunRegularPayroll: boolean;
  /** 6df24751 — the most recent edit across this company's cycles (max payroll_cycle.updated_at), for the
   *  company-first listing's Last Updated column. NULL when no cycle has been edited since migration 0443
   *  shipped, which the listing renders as an em dash rather than inventing a date. */
  lastUpdatedAt: Date | null;
};

/**
 * The readiness list ACROSS companies the reporter asked for: "list, in one place, every company not yet
 * able to run payroll and what each is missing."
 *
 * Deliberately cheap — two grouped queries for the whole set, not the eight-check payrollReadiness per
 * company — because it renders on the Payroll Settings landing page, which must stay fast. It answers only
 * the blocking question (can this company open a run at all?) plus the stale-default fact that made the
 * problem invisible. The full per-company report is `payrollReadiness` below, rendered on the SAME page
 * behind ?readiness=full (efe1d230 moved it there from the retired /payroll/guide) — that is why it is
 * gated on a query param rather than always on: this cheap version exists to keep the default render fast.
 *
 * It does NOT create cycles. Which cycles a company should have is a business decision, and inventing them
 * would make a company that has never run payroll silently start being able to.
 */
export function payrollCycleReadiness(
  ctx: SessionContext,
  companyIds: string[],
): Promise<CompanyCycleReadiness[]> {
  return withTenant(ctx, async (tx) => {
    if (companyIds.length === 0) return [];
    const companies = await tx
      .select({ id: company.id, name: company.legalName, defaultCycle: company.defaultPayrollCycle })
      .from(company)
      .where(inArray(company.id, companyIds))
      .orderBy(company.legalName);
    if (companies.length === 0) return [];

    // One pass over the catalog: per company, how many active cycles, how many active REGULAR cycles, and
    // whether any active cycle carries the company's stored default name. The name comparison happens in
    // SQL against company.default_payroll_cycle so it uses the same case-insensitive rule as the save-time
    // validation in setCompanyDefaultPayrollCycle.
    const rows = await tx
      .select({
        companyId: payrollCycle.companyId,
        active: sql<number>`count(*) filter (where ${payrollCycle.archivedAt} is null)::int`,
        activeRegular: sql<number>`count(*) filter (where ${payrollCycle.archivedAt} is null and ${payrollCycle.runType} = 'regular')::int`,
        defaultMatches: sql<number>`count(*) filter (where ${payrollCycle.archivedAt} is null and lower(${payrollCycle.name}) = lower(${company.defaultPayrollCycle}))::int`,
        // 6df24751 — folded into the SAME grouped pass rather than a third query: this function is the
        // cheap one BY DESIGN (see the docblock above), and Last Updated must not cost a query per company.
        lastUpdated: sql<Date | null>`max(${payrollCycle.updatedAt})`,
      })
      .from(payrollCycle)
      .innerJoin(company, eq(company.id, payrollCycle.companyId))
      .where(inArray(payrollCycle.companyId, companyIds))
      .groupBy(payrollCycle.companyId);
    const byCompany = new Map(rows.map((r) => [r.companyId, r]));

    return companies.map((c) => {
      const r = byCompany.get(c.id);
      const activeRegularCycles = r?.activeRegular ?? 0;
      const defaultCycleName = (c.defaultCycle ?? '').trim();
      return {
        companyId: c.id,
        companyName: c.name,
        activeCycles: r?.active ?? 0,
        activeRegularCycles,
        defaultCycleName,
        defaultCycleResolves: defaultCycleName !== '' && (r?.defaultMatches ?? 0) > 0,
        canRunRegularPayroll: activeRegularCycles > 0,
        // A company with no catalog row at all has no group row either ⇒ null, same as a catalog nobody
        // has edited. Both are honestly "never changed here".
        lastUpdatedAt: r?.lastUpdated ? new Date(r.lastUpdated) : null,
      };
    });
  });
}
