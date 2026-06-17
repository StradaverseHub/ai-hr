/**
 * HR analytics & master-data reporting (Wave 4 / ADR-pending, consultant #3). Read-only — these
 * functions never mutate, so they append no domain events. Admin-only + company-scoped by the caller
 * (the /analytics page uses scopedAdmin()); compensation columns are additionally gated to admins
 * (Wave 1 #5 — managers must not see subordinate base pay), defensively re-checked here.
 *
 * First tranche: headcount, master-data export (±comp), new hires, terminations, turnover %.
 */
import { and, count, desc, eq, gt, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { isAdmin } from '../lib/authz';
import { assignment, company, compensation, department, employment, person, position } from '../db/schema';

const round1 = (n: number) => Math.round(n * 10) / 10;

const scopeWhere = (scopeIds: string[] | undefined) =>
  scopeIds && scopeIds.length ? inArray(employment.companyId, scopeIds) : undefined;

/** Active as of date D: hired on/before D and not yet terminated on D (terminated strictly after D). */
const activeAsOf = (d: string) =>
  and(lte(employment.hiredOn, d), or(isNull(employment.terminatedOn), gt(employment.terminatedOn, d)));

/** Current-assignment join condition (open, non-superseded). */
const currentAssignment = and(
  eq(assignment.employmentId, employment.id),
  isNull(assignment.validTo),
  isNull(assignment.supersededAt),
);

export type DimensionCount = { name: string; count: number };
export type HeadcountSummary = {
  total: number;
  byCompany: DimensionCount[];
  byDepartment: DimensionCount[];
  byPosition: DimensionCount[];
};

/** Active headcount as of a date, tallied by company, department, and position. */
export function headcountSummary(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  opts: { asOf: string },
): Promise<HeadcountSummary> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ company: company.legalName, department: department.name, position: position.title })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(and(activeAsOf(opts.asOf), scopeWhere(scopeIds)));
    const tally = (key: 'company' | 'department' | 'position'): DimensionCount[] => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const name = r[key] ?? '—';
        m.set(name, (m.get(name) ?? 0) + 1);
      }
      return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    };
    return {
      total: rows.length,
      byCompany: tally('company'),
      byDepartment: tally('department'),
      byPosition: tally('position'),
    };
  });
}

export type MasterDataRow = {
  employeeCode: string | null;
  name: string;
  email: string;
  company: string;
  department: string | null;
  position: string | null;
  status: string | null;
  employmentType: string | null;
  hiredOn: string;
  terminatedOn: string | null;
  basicSalary?: string;
  monthlyAllowance?: string;
  currency?: string;
};

/** Employee master-data roster. Compensation columns are included ONLY when the caller is an admin
 *  AND asks for them (Wave 1 #5). `includeComp` for a non-admin is silently ignored. */
export function masterDataExport(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  opts: { includeComp?: boolean; includeTerminated?: boolean } = {},
): Promise<MasterDataRow[]> {
  const withComp = !!opts.includeComp && isAdmin(ctx);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employeeCode: employment.employeeCode,
        name: person.fullName,
        email: person.primaryEmail,
        company: company.legalName,
        department: department.name,
        position: position.title,
        status: assignment.status,
        employmentType: assignment.employmentType,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        basicSalary: compensation.basicSalary,
        monthlyAllowance: compensation.monthlyAllowance,
        currency: compensation.currency,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .leftJoin(
        compensation,
        and(
          eq(compensation.employmentId, employment.id),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .where(
        and(
          opts.includeTerminated ? undefined : isNull(employment.terminatedOn),
          scopeWhere(scopeIds),
        ),
      )
      .orderBy(person.fullName);
    return rows.map((r) => {
      const base: MasterDataRow = {
        employeeCode: r.employeeCode,
        name: r.name,
        email: r.email,
        company: r.company,
        department: r.department,
        position: r.position,
        status: r.status,
        employmentType: r.employmentType,
        hiredOn: r.hiredOn,
        terminatedOn: r.terminatedOn,
      };
      if (withComp) {
        base.basicSalary = r.basicSalary ?? undefined;
        base.monthlyAllowance = r.monthlyAllowance ?? undefined;
        base.currency = r.currency ?? undefined;
      }
      return base;
    });
  });
}

export type HireRow = {
  name: string;
  company: string;
  department: string | null;
  position: string | null;
  hiredOn: string;
};

/** Employees hired within [from, to] (inclusive) — the new-hire cohort for the period. */
export function newHires(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  p: { from: string; to: string },
): Promise<HireRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        name: person.fullName,
        company: company.legalName,
        department: department.name,
        position: position.title,
        hiredOn: employment.hiredOn,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(and(gte(employment.hiredOn, p.from), lte(employment.hiredOn, p.to), scopeWhere(scopeIds)))
      .orderBy(desc(employment.hiredOn)),
  );
}

export type TerminationRow = {
  name: string;
  company: string;
  department: string | null;
  terminatedOn: string | null;
  terminationType: string | null;
  terminationReason: string | null;
};

/** Employees terminated within [from, to] (inclusive) — the leaver cohort, with classification. */
export function terminations(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  p: { from: string; to: string },
): Promise<TerminationRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        name: person.fullName,
        company: company.legalName,
        department: department.name,
        terminatedOn: employment.terminatedOn,
        terminationType: employment.terminationType,
        terminationReason: employment.terminationReason,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .where(
        and(gte(employment.terminatedOn, p.from), lte(employment.terminatedOn, p.to), scopeWhere(scopeIds)),
      )
      .orderBy(desc(employment.terminatedOn)),
  );
}

export type TurnoverResult = {
  leavers: number;
  headcountStart: number;
  headcountEnd: number;
  avgHeadcount: number;
  turnoverPct: number;
};

/** Turnover rate for [from, to] = leavers ÷ average headcount × 100 (standard HR KPI).
 *  Average headcount = (active at `from` + active at `to`) / 2. */
export function turnoverRate(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  p: { from: string; to: string },
): Promise<TurnoverResult> {
  return withTenant(ctx, async (tx) => {
    const headcountAt = async (d: string): Promise<number> => {
      const [r] = await tx
        .select({ c: count() })
        .from(employment)
        .where(and(activeAsOf(d), scopeWhere(scopeIds)));
      return Number(r?.c ?? 0);
    };
    const [lv] = await tx
      .select({ c: count() })
      .from(employment)
      .where(
        and(gte(employment.terminatedOn, p.from), lte(employment.terminatedOn, p.to), scopeWhere(scopeIds)),
      );
    const leavers = Number(lv?.c ?? 0);
    const headcountStart = await headcountAt(p.from);
    const headcountEnd = await headcountAt(p.to);
    const avgHeadcount = round1((headcountStart + headcountEnd) / 2);
    const turnoverPct = avgHeadcount > 0 ? round1((leavers / avgHeadcount) * 100) : 0;
    return { leavers, headcountStart, headcountEnd, avgHeadcount, turnoverPct };
  });
}
