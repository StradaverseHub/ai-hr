/**
 * HR analytics & master-data reporting (Wave 4 / ADR-pending, consultant #3). Read-only — these
 * functions never mutate, so they append no domain events. Admin-only + company-scoped by the caller
 * (the /analytics page uses scopedAdmin()); compensation columns are additionally gated to admins
 * (Wave 1 #5 — managers must not see subordinate base pay), defensively re-checked here.
 *
 * First tranche: headcount, master-data export (±comp), new hires, terminations, turnover %.
 */
import {
  aliasedTable,
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { isAdmin } from '../lib/authz';
import { todayInKualaLumpur } from '../lib/hr-date';
// 9cbf5e0d — one Employee Status engine; the dashboard reads it instead of the legacy stored enum.
import { employmentStatusSql } from './employment-status-sql';
import {
  CARRY_FORFEIT_REASON_CAP,
  CARRY_FORFEIT_REASON_EXPIRY,
  earnedCycleStart,
  resolveCarryBreakdown,
  resolveGradePolicy,
  serviceYearsAt,
  type GradePolicyRow,
} from './leave';
import {
  assignment,
  company,
  compensation,
  costCenter,
  department,
  employeeStatutoryMy,
  employment,
  leaveLedger,
  leavePolicy,
  leaveType,
  person,
  position,
  reportingLine,
} from '../db/schema';

const round1 = (n: number) => Math.round(n * 10) / 10;
// Leave-day amounts elsewhere (core/leave.ts) use 2dp precision — match it here so forfeit totals never
// silently lose a hundredth vs. the ledger rows they're summed from.
const round2 = (n: number) => Math.round(n * 100) / 100;

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

/**
 * Roster/event scoping filter (ADR-0047). Department + free-text `q`, reusing the predicate shape from
 * core/read.ts#listEmployeesPage. Never widens access — it only narrows on top of the RLS-scoped rows.
 */
export type ReportFilter = { departmentId?: string; q?: string };

/** Free-text `q` predicate over name/email (case-insensitive), mirroring listEmployeesPage. */
const qWhere = (filter: ReportFilter | undefined) => {
  const q = filter?.q?.trim();
  return q ? or(ilike(person.fullName, `%${q}%`), ilike(person.primaryEmail, `%${q}%`)) : undefined;
};

// ─────────────────── Dashboards (visual charts) — Reporting & Analytics ───────────────────
// One filter source of truth shared by the /analytics page AND the export route, so an exported
// report can never disagree with the on-screen chart for the same filter set (no screen/export drift).
// Read-only — every function below tallies; none mutates, so none appends a DomainEvent (matches the
// file header note and the substrate read-only skip rule).
//
// Scoping decision (Phase 0): the schema lacks real `nationality` / `location` / `business_unit`
// columns. We use read-only proxies — `epfCitizenship` (nationality), `employment.workState`
// (location), `costCenter` (cost-centre) — and defer the real columns to a follow-up migration slice.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string | null | undefined): v is string => !!v && UUID_RE.test(v);

/** The unified dashboard filter set. Every field narrows on top of RLS-scoped rows (never widens).
 *  Two distinct status concepts (kept un-blurred):
 *   - `lifecycleStatus`: employment.terminatedOn lifecycle (active vs terminated) — the date-range filter.
 *   - `assignmentStatus`: the DERIVED Employee Status bucket (9cbf5e0d) — probation / active /
 *     active_serving_notice / resigned / blacklisted. The query-string name is kept so existing saved
 *     dashboard links keep working; the retired stored-enum values simply no longer match anything. */
export type AnalyticsFilters = {
  companyId?: string;
  departmentId?: string;
  costCenterId?: string;
  gender?: string;
  nationality?: string; // epfCitizenship proxy: 'citizen' | 'pr' | 'non_citizen'
  workState?: string; // location proxy
  managerEmploymentId?: string;
  lifecycleStatus?: 'active' | 'terminated';
  assignmentStatus?: string; // an EmploymentStatus bucket (see core/employment-status.ts)
  q?: string;
};

/** Shared date-range default so the page and the export route never disagree on the implicit window:
 *  from = Jan 1 of the current year, to = today, with any valid YYYY-MM-DD overriding. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function analyticsDateRange(
  get: (k: string) => string | null | undefined,
  today = new Date().toISOString().slice(0, 10),
): { from: string; to: string } {
  const isDate = (v: string | null | undefined): v is string => !!v && ISO_DATE_RE.test(v);
  const fromRaw = get('from');
  const toRaw = get('to');
  return {
    from: isDate(fromRaw) ? fromRaw : `${today.slice(0, 4)}-01-01`,
    to: isDate(toRaw) ? toRaw : today,
  };
}

/** Shared year-selector parse for the carry-forward report: a validated 4-digit integer year, or the
 *  current year by default. Garbage input (non-numeric, out-of-range) falls back to the default rather
 *  than ever reaching the report as a bad value (never a 500) — the page and export route call this so
 *  they can never disagree on which year is showing. */
export function parseReportYear(
  get: (k: string) => string | null | undefined,
  today = new Date().toISOString().slice(0, 10),
): number {
  const currentYear = Number(today.slice(0, 4));
  const raw = get('year');
  if (raw == null || raw === '') return currentYear;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : currentYear;
}

/** Parse + validate raw query params into AnalyticsFilters. Shared by page and export route so the two
 *  derive identical filters (UUIDs validated; enum-ish values length-clamped; unknowns dropped). */
export function parseAnalyticsFilters(get: (k: string) => string | null | undefined): AnalyticsFilters {
  const v = (k: string) => {
    const raw = get(k);
    return raw == null || raw === '' ? undefined : raw;
  };
  const uuid = (k: string) => (isUuid(get(k)) ? (get(k) as string) : undefined);
  const lifecycle = v('lifecycleStatus');
  return {
    companyId: uuid('companyId'),
    departmentId: uuid('departmentId'),
    costCenterId: uuid('costCenterId'),
    gender: v('gender')?.slice(0, 20),
    nationality: v('nationality')?.slice(0, 20),
    workState: v('workState')?.slice(0, 40),
    managerEmploymentId: uuid('managerEmploymentId'),
    lifecycleStatus: lifecycle === 'active' || lifecycle === 'terminated' ? lifecycle : undefined,
    assignmentStatus: v('assignmentStatus')?.slice(0, 20),
    q: v('q')?.slice(0, 100),
  };
}

/** Open, non-superseded reporting line for the manager filter (the analogue of currentAssignment).
 *  Scope decision: direct reports only, lineType='administrative' (the primary/solid line), as-of today
 *  — NOT the date-range (transitive subtree + dotted-line rollups are deferred). The open-line predicate
 *  (validTo IS NULL AND supersededAt IS NULL) is REQUIRED or it matches historical/superseded edges and
 *  returns stale/duplicated subordinates. */
const managerLineWhere = (managerEmploymentId: string): SQL =>
  inArray(
    employment.id,
    sql`(
      select ${reportingLine.subordinateEmploymentId}
      from ${reportingLine}
      where ${reportingLine.managerEmploymentId} = ${managerEmploymentId}
        and ${reportingLine.lineType} = 'administrative'
        and ${reportingLine.validTo} is null
        and ${reportingLine.supersededAt} is null
    )`,
  );

/** The shared WHERE clause for every dashboard aggregation. All employment-level + person-level +
 *  current-assignment predicates compose with AND (so each filter strictly narrows). Functions that
 *  add their own per-event temporal predicate (e.g. movementByMonth) pass `withAssignment=false` and
 *  rely on their own joins; the assignment-derived filters (department/costCentre) apply only when the
 *  caller has joined the current assignment. */
export function analyticsWhere(
  filters: AnalyticsFilters,
  scopeIds: string[] | undefined,
  opts: { asOf?: string; withAssignment?: boolean } = {},
): SQL | undefined {
  const { asOf, withAssignment = true } = opts;
  const parts: (SQL | undefined)[] = [
    scopeWhere(scopeIds),
    filters.companyId ? eq(employment.companyId, filters.companyId) : undefined,
    filters.workState ? eq(employment.workState, filters.workState) : undefined,
    filters.gender ? eq(person.gender, filters.gender) : undefined,
    filters.managerEmploymentId ? managerLineWhere(filters.managerEmploymentId) : undefined,
    qWhere({ q: filters.q }),
    // lifecycle status (employment-level). active = not terminated as of asOf; terminated = has a
    // terminatedOn <= asOf. When no asOf given, active = terminatedOn IS NULL outright.
    filters.lifecycleStatus === 'active'
      ? asOf
        ? activeAsOf(asOf)
        : isNull(employment.terminatedOn)
      : undefined,
    filters.lifecycleStatus === 'terminated'
      ? asOf
        ? lte(employment.terminatedOn, asOf)
        : sql`${employment.terminatedOn} is not null`
      : undefined,
  ];
  if (withAssignment) {
    parts.push(
      filters.departmentId ? eq(assignment.departmentId, filters.departmentId) : undefined,
      filters.costCenterId ? eq(assignment.costCenterId, filters.costCenterId) : undefined,
    );
  }
  // 9cbf5e0d — the Employee Status filter narrows on the DERIVED status (employmentStatusSql), not the
  // legacy stored assignment.status: the dashboard must offer the same five buckets every other screen
  // shows, and must not offer the retired On Leave / Offboarding / Terminated values. It reads `employment`
  // columns only, so unlike the department/cost-centre filters it does NOT need the assignment join.
  if (filters.assignmentStatus) {
    parts.push(sql`${employmentStatusSql(asOf ?? todayInKualaLumpur())} = ${filters.assignmentStatus}`);
  }
  return and(...parts.filter((p): p is SQL => p != null));
}

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
 *  AND asks for them (Wave 1 #5). `includeComp` for a non-admin is silently ignored.
 *  The optional `filter` (ADR-0047) narrows by department (on the CURRENT assignment) and free-text `q`.
 *  Note: a department-filtered master-data export legitimately excludes employees with no open
 *  assignment — that is intended behaviour for the roster view (see ADR-0047 §4). */
export function masterDataExport(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  opts: { includeComp?: boolean; includeTerminated?: boolean; filter?: ReportFilter } = {},
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
          opts.filter?.departmentId ? eq(assignment.departmentId, opts.filter.departmentId) : undefined,
          qWhere(opts.filter),
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

/** Assignment version effective at a given date column (ADR-0047 temporal-coherence): the version whose
 *  validity range covers the event date, non-superseded. Used so department-filtered event reports
 *  resolve the department AS OF the event, not the (possibly closed/null) current assignment.
 *  `eventDate` is an employment column (hiredOn / terminatedOn).
 *
 *  `inclusiveEnd` controls the upper bound:
 *   - new-hire (false): standard half-open [validFrom, validTo) — `validTo > eventDate`. The genesis
 *     row is open (validTo null) so it always matches; a same-day transfer (validFrom = hireDate) is
 *     not a hire-date department, so the half-open bound correctly keeps the genesis row.
 *   - termination (true): the leaver's last assignment is CLOSED exactly on the termination date
 *     (`terminateEmploymentTx` sets validTo = terminationDate). The employee was in that department
 *     through their last day, so we include `validTo = eventDate` (`validTo >= eventDate`). */
const assignmentEffectiveAt = (
  eventDate: typeof employment.hiredOn | typeof employment.terminatedOn,
  inclusiveEnd = false,
) =>
  and(
    eq(assignment.employmentId, employment.id),
    isNull(assignment.supersededAt),
    lte(assignment.validFrom, eventDate),
    or(isNull(assignment.validTo), inclusiveEnd ? gte(assignment.validTo, eventDate) : gt(assignment.validTo, eventDate)),
  );

/** Employees hired within [from, to] (inclusive) — the new-hire cohort for the period.
 *  `filter` (ADR-0047): department resolved against the assignment effective on the hire date. */
export function newHires(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  p: { from: string; to: string; filter?: ReportFilter },
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
      .leftJoin(assignment, assignmentEffectiveAt(employment.hiredOn))
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(
        and(
          gte(employment.hiredOn, p.from),
          lte(employment.hiredOn, p.to),
          p.filter?.departmentId ? eq(assignment.departmentId, p.filter.departmentId) : undefined,
          qWhere(p.filter),
          scopeWhere(scopeIds),
        ),
      )
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

/** Employees terminated within [from, to] (inclusive) — the leaver cohort, with classification.
 *  `filter` (ADR-0047): department resolved against the assignment effective on the termination date.
 *  This matters because a terminated employee's open assignment is CLOSED (validTo set), so a current
 *  assignment join would yield a null department and silently drop every leaver from a dept filter. */
export function terminations(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  p: { from: string; to: string; filter?: ReportFilter },
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
      .leftJoin(assignment, assignmentEffectiveAt(employment.terminatedOn, true))
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .where(
        and(
          gte(employment.terminatedOn, p.from),
          lte(employment.terminatedOn, p.to),
          p.filter?.departmentId ? eq(assignment.departmentId, p.filter.departmentId) : undefined,
          qWhere(p.filter),
          scopeWhere(scopeIds),
        ),
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

export type ChangeJobRow = {
  name: string;
  company: string;
  fromDepartment: string | null;
  toDepartment: string | null;
  fromPosition: string | null;
  toPosition: string | null;
  effectiveOn: string;
};

/**
 * Change Job Transactions (ADR-0047) — every in-period department/position move, read from the
 * bitemporal `assignment` version history. Read-only — no domain event.
 *
 * Versioning semantics:
 *  - The SUCCESSOR is an `assignment` version with `validFrom` in [from, to] and `supersededAt IS NULL`
 *    (correction tombstones excluded).
 *  - The PREDECESSOR is INNER-joined on `prior.employmentId = next.employmentId AND
 *    prior.validTo = next.validFrom AND prior.supersededAt IS NULL` — `transferEmployee` closes the
 *    prior open row (validTo = effectiveDate) and inserts the successor, so a real change always has a
 *    closed predecessor abutting the successor's validFrom.
 *  - The INNER JOIN is the "this is a job change, not a hire" guard: a hire's genesis assignment has
 *    `validFrom = hiredOn` and no predecessor row with `validTo = validFrom`, so it is dropped.
 *  - Terminations are excluded for free: `terminateEmploymentTx` closes the open row WITHOUT inserting
 *    a successor, so there is no in-window `validFrom` successor to falsely report.
 */
export function changeJobTransactions(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  p: { from: string; to: string; filter?: ReportFilter },
): Promise<ChangeJobRow[]> {
  const prior = aliasedTable(assignment, 'prior_assignment');
  const fromDept = aliasedTable(department, 'from_department');
  const fromPos = aliasedTable(position, 'from_position');
  return withTenant(ctx, (tx) =>
    tx
      .select({
        name: person.fullName,
        company: company.legalName,
        fromDepartment: fromDept.name,
        toDepartment: department.name,
        fromPosition: fromPos.title,
        toPosition: position.title,
        effectiveOn: assignment.validFrom,
      })
      .from(assignment)
      .innerJoin(employment, eq(employment.id, assignment.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      // predecessor: closed version abutting the successor's validFrom — INNER drops genesis hires.
      .innerJoin(
        prior,
        and(
          eq(prior.employmentId, assignment.employmentId),
          eq(prior.validTo, assignment.validFrom),
          isNull(prior.supersededAt),
        ),
      )
      .leftJoin(department, eq(department.id, assignment.departmentId)) // to-department
      .leftJoin(position, eq(position.id, assignment.positionId)) // to-position
      .leftJoin(fromDept, eq(fromDept.id, prior.departmentId))
      .leftJoin(fromPos, eq(fromPos.id, prior.positionId))
      .where(
        and(
          gte(assignment.validFrom, p.from),
          lte(assignment.validFrom, p.to),
          isNull(assignment.supersededAt), // exclude correction tombstones on the successor
          // dept filter matches a move that TOUCHED the department (either side).
          p.filter?.departmentId
            ? or(eq(assignment.departmentId, p.filter.departmentId), eq(prior.departmentId, p.filter.departmentId))
            : undefined,
          qWhere(p.filter),
          scopeWhere(scopeIds),
        ),
      )
      .orderBy(desc(assignment.validFrom), person.fullName),
  );
}

// ───────────────────────── Dimension distributions (visual charts) ─────────────────────────
// Every distribution is filter-aware and tallied in JS (small result sets) so the Unknown / Unassigned
// bucketing logic lives in one place. Person-level dimensions (gender / marital / age) sum to the
// total headcount INCLUDING the explicit "Unknown" bucket (NULL value); they don't depend on the
// current assignment so they never need an Unassigned bucket. Assignment-derived dimensions
// (cost-centre / department / 5-way status come from the current assignment) count rows with no current
// assignment into an explicit "Unassigned" bucket so the design narrows intentionally and the chart
// still sums to the total headcount.
//
// Bucket sentinel keys are returned as machine codes; the UI maps them to localized labels.
export const UNKNOWN_BUCKET = '__unknown__';
export const UNASSIGNED_BUCKET = '__unassigned__';

/** Tally a list of (nullable) string keys into a sorted DimensionCount[], folding null → nullBucket. */
function tally(rows: (string | null)[], nullBucket = UNKNOWN_BUCKET): DimensionCount[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const name = r ?? nullBucket;
    m.set(name, (m.get(name) ?? 0) + 1);
  }
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/** The base row set for person-level dimensions: one row per active-as-of-asOf employment matching the
 *  filters, carrying the person attributes + the current assignment's dept/costCentre/status. */
function dimensionRows(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  filters: AnalyticsFilters,
  asOf: string,
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        gender: person.gender,
        maritalStatus: person.maritalStatus,
        dateOfBirth: person.dateOfBirth,
        workState: employment.workState,
        costCenterName: costCenter.name,
        // 9cbf5e0d — the DERIVED Employee Status as of asOf, so the chart shows what the Personnel screens
        // show. The legacy stored assignment.status is not read here any more.
        employmentStatus: employmentStatusSql(asOf),
        departmentName: department.name,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(costCenter, eq(costCenter.id, assignment.costCenterId))
      .where(
        analyticsWhere({ ...filters, lifecycleStatus: filters.lifecycleStatus ?? 'active' }, scopeIds, { asOf }),
      ),
  );
}

/** Bucket a date-of-birth (ISO) into an age band as of `asOf`; null DOB → UNKNOWN_BUCKET. */
function ageBand(dob: string | null, asOf: string): string {
  if (!dob) return UNKNOWN_BUCKET;
  const a = new Date(asOf);
  const b = new Date(dob);
  let age = a.getFullYear() - b.getFullYear();
  const m = a.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && a.getDate() < b.getDate())) age--;
  if (age < 25) return '<25';
  if (age < 35) return '25-34';
  if (age < 45) return '35-44';
  if (age < 55) return '45-54';
  return '55+';
}

export type Demographics = {
  total: number;
  byGender: DimensionCount[];
  byMarital: DimensionCount[];
  byAgeBand: DimensionCount[];
  byLocation: DimensionCount[];
  byCostCentre: DimensionCount[];
  byEmploymentStatus: DimensionCount[]; // the five DERIVED Employee Status buckets (9cbf5e0d)
  byDepartment: DimensionCount[];
};

const AGE_ORDER = ['<25', '25-34', '35-44', '45-54', '55+', UNKNOWN_BUCKET];

/** Workforce demographics in one query — gender / marital / age-band / location / cost-centre / 5-way
 *  assignment-status / department, all filter-aware. Person-level dimensions sum to `total` (Unknown
 *  bucket inclusive). Assignment-derived dimensions (costCentre/department/status) fold no-current-
 *  assignment rows into the Unassigned bucket so they also sum to total. */
export async function workforceDemographics(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  opts: { asOf: string; filters?: AnalyticsFilters },
): Promise<Demographics> {
  const filters = opts.filters ?? {};
  const rows = await dimensionRows(ctx, scopeIds, filters, opts.asOf);
  const byAgeBand = tally(rows.map((r) => ageBand(r.dateOfBirth, opts.asOf))).sort(
    (a, b) => AGE_ORDER.indexOf(a.name) - AGE_ORDER.indexOf(b.name),
  );
  return {
    total: rows.length,
    byGender: tally(rows.map((r) => r.gender)),
    byMarital: tally(rows.map((r) => r.maritalStatus)),
    byAgeBand,
    byLocation: tally(rows.map((r) => r.workState)),
    // assignment-derived → no current assignment folds to UNASSIGNED_BUCKET (so the chart sums to total).
    byCostCentre: tally(rows.map((r) => r.costCenterName), UNASSIGNED_BUCKET),
    byDepartment: tally(rows.map((r) => r.departmentName), UNASSIGNED_BUCKET),
    // Derived from the employment's own lifecycle, so — unlike the other assignment-derived dimensions —
    // an employee with no current assignment still lands in a real bucket, never "Unassigned".
    byEmploymentStatus: tally(rows.map((r) => r.employmentStatus)),
  };
}

/**
 * Nationality distribution (epfCitizenship proxy) — the HIGHEST-RISK dimension, with three fixes:
 *  (a) RLS scope mismatch: employee_statutory_my RLS is can_see_person (an ABAC subtree check), not the
 *      company-scope every other function uses. Under a scoped (non-admin) viewer this would silently
 *      undercount, so this dimension is ADMIN-ONLY — returns null for non-admins (the UI hides the card).
 *  (b) Per-person, not per-employment: employee_statutory_my is keyed one-row-per-person while a person
 *      can hold concurrent employments. We count DISTINCT person, not employment rows.
 *  (c) epfCitizenship defaults to 'citizen' when unset, and persons with no statutory row must not
 *      vanish: LEFT JOIN to a DISTINCT-person base and fold missing rows to UNKNOWN_BUCKET. A UI footnote
 *      flags the default-citizen caveat. Approximate proxy pending a real `nationality` column.
 */
export async function demographicsByNationality(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  opts: { asOf: string; filters?: AnalyticsFilters },
): Promise<DimensionCount[] | null> {
  if (!isAdmin(ctx)) return null; // (a) admin-only — scoped viewers get the card omitted.
  const filters = opts.filters ?? {};
  return withTenant(ctx, async (tx) => {
    // (b) DISTINCT person base: select the person id + citizenship once per person, not per employment.
    const rows = await tx
      .selectDistinct({ personId: person.id, citizenship: employeeStatutoryMy.epfCitizenship })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      // (c) LEFT JOIN statutory so persons with no row are kept (citizenship → null → Unknown).
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, person.id))
      .where(
        analyticsWhere({ ...filters, lifecycleStatus: filters.lifecycleStatus ?? 'active' }, scopeIds, { asOf: opts.asOf }),
      );
    return tally(rows.map((r) => r.citizenship));
  });
}

// ───────────────────────────── Leave analytics ─────────────────────────────
// leave_ledger is tenant-scoped only (no companyId/department/costCenter), so EVERY leave aggregation
// JOINs leave_ledger → employment → company and applies scopeWhere explicitly. Read-only → no events.

export type LeaveUtilisationRow = { name: string; granted: number; taken: number };

/** Leave utilisation per leave type: granted = accrual + in_lieu_accrual + positive adjustments;
 *  taken = −(sum of debits). Separate columns — NOT a single signed sum (which conflates adjustments). */
export async function leaveUtilisation(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  filters: AnalyticsFilters = {},
): Promise<LeaveUtilisationRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        name: leaveType.name,
        // granted: positive accrual-style entries + positive adjustments.
        granted: sql<string>`coalesce(sum(case
          when ${leaveLedger.entryType} in ('accrual','in_lieu_accrual') then ${leaveLedger.days}
          when ${leaveLedger.entryType} = 'adjustment' and ${leaveLedger.days} > 0 then ${leaveLedger.days}
          else 0 end), 0)`,
        // taken: the magnitude of debits (stored negative) as a positive number.
        taken: sql<string>`coalesce(-sum(case when ${leaveLedger.entryType} = 'debit' then ${leaveLedger.days} else 0 end), 0)`,
      })
      .from(leaveLedger)
      .innerJoin(leaveType, eq(leaveType.id, leaveLedger.leaveTypeId))
      .innerJoin(employment, eq(employment.id, leaveLedger.employmentId))
      .where(and(scopeWhere(scopeIds), filters.companyId ? eq(employment.companyId, filters.companyId) : undefined))
      .groupBy(leaveType.name)
      .orderBy(leaveType.name);
    return rows.map((r) => ({ name: r.name, granted: Number(r.granted), taken: Number(r.taken) }));
  });
}

// ─────────────────── Carry-forward & forfeiture report ───────────────────
// Per (employment, ANNUAL leave type) row for the leave-year cycle STARTING in the selected year: what
// carried in, its expiry date, and what was forfeited at open (cap-excess) vs at expiry — sourced from
// the SAME shared helper the /me breakdown uses (core/leave.ts#resolveCarryBreakdown), fed by bulk
// GROUP BY aggregates (no per-employee loop; Chin Hin scale ~4.5k employments is the sizing target).
//
// forfeitedAtOpen / forfeitedAtExpiry are read ONLY from reason-tagged ledger rows (CARRY_FORFEIT_REASON_
// CAP / _EXPIRY) — never reconstructed. Reconstruction cannot reproduce a PAST forfeit (its currentBalance
// input moves after the sweep runs), and date-matching untagged rows would misclassify a manual Jan-1
// adjustment as a system forfeit. The system is undeployed, so real tenants have zero untagged forfeit
// rows at release; an untagged negative adjustment is simply not counted as a forfeit (see test (e)).
export type CarryForwardReportRow = {
  employmentId: string;
  employeeName: string;
  company: string;
  department: string | null;
  leaveYear: number;
  /** Cycle start actually used (calendar 1 Jan, or the employee's hire-month anniversary). */
  cycleStart: string;
  carried: number;
  /** null when the policy has no expiry configured, OR the cycle is anniversary-earned and therefore
   *  outside expireCarriedLeave's sweep coverage (a real engine gap — see ORDERED STEPS / OUT OF SCOPE
   *  in the approved plan). Printing a date the system never enforces would be dishonest. */
  carryForwardExpiryDate: string | null;
  forfeitedAtOpen: number;
  forfeitedAtExpiry: number;
  /** Machine reason code(s) present on this row's tagged forfeits — 'cap' (exceeded the carry-forward
   *  limit at year/cycle open) and/or 'expiry' (auto forfeit due to expiry). Empty when neither forfeit
   *  occurred. Callers localize/label these (English for export, translated for the on-screen UI). */
  reasonCodes: ('cap' | 'expiry')[];
};

/** True iff this (employment, type)'s cycle is an earned-method policy on an anniversary-leaveCycle
 *  company — accrueEarnedLeave (not openLeaveYear) owns its carry-cap, and expireCarriedLeave's Jan-1
 *  "open marker" check never finds a marker for it, so the expiry sweep never covers it (engine gap). */
const isAnniversaryEarned = (leaveCycle: string | null, method: string | undefined): boolean =>
  leaveCycle === 'anniversary' && (method === 'earned_monthly' || method === 'earned_quarterly');

export async function carryForwardReport(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  p: { year: number; filter?: ReportFilter; companyId?: string },
): Promise<CarryForwardReportRow[]> {
  return withTenant(ctx, async (tx) => {
    const year = p.year;
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const [annualType] = await tx
      .select({ id: leaveType.id })
      .from(leaveType)
      .where(eq(leaveType.code, 'ANNUAL'))
      .limit(1);
    if (!annualType) return [];
    const leaveTypeId = annualType.id;

    // Population: employments hired on/before the year-end (so a cycle could have started this year) and
    // NOT terminated before Jan 1 of the year — leavers mid-year Y still appear (their final forfeit is a
    // record). Since-archived ANNUAL types are not filtered (history, not future action).
    const emps = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        company: company.legalName,
        department: department.name,
        hiredOn: employment.hiredOn,
        gradeId: employment.gradeId,
        companyId: employment.companyId,
        leaveCycle: company.leaveCycle,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, currentAssignment)
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .where(
        and(
          scopeWhere(scopeIds),
          p.companyId ? eq(employment.companyId, p.companyId) : undefined,
          p.filter?.departmentId ? eq(assignment.departmentId, p.filter.departmentId) : undefined,
          qWhere(p.filter),
          lte(employment.hiredOn, yearEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, yearStart)),
        ),
      );
    if (emps.length === 0) return [];
    const empIds = emps.map((e) => e.employmentId);

    // Every ANNUAL policy version (dated), so we can resolve the version active at EACH employee's cycle
    // open — not just the currently-active one (past-year reports must use the historical cap/expiry).
    const policies = await tx
      .select({
        gradeId: leavePolicy.gradeId,
        companyId: leavePolicy.companyId,
        accrual: leavePolicy.accrual,
        validFrom: leavePolicy.validFrom,
        validTo: leavePolicy.validTo,
      })
      .from(leavePolicy)
      .where(eq(leavePolicy.leaveTypeId, leaveTypeId));

    // Per-employee cycle start (calendar 1 Jan / anniversary hire-month), evaluated as-of the year-end so
    // a mid-year joiner in year Y still resolves to their own cycle. Only rows whose cycle START falls in
    // the SELECTED year are kept — a report for year Y is the cycle starting in Y (ORDERED STEPS #3).
    const cycleStartByEmp = new Map<string, string>();
    for (const e of emps) {
      const cs = earnedCycleStart(e.hiredOn, yearEnd, e.leaveCycle);
      if (cs.slice(0, 4) === String(year)) cycleStartByEmp.set(e.employmentId, cs);
    }
    const inScopeEmps = emps.filter((e) => cycleStartByEmp.has(e.employmentId));
    if (inScopeEmps.length === 0) return [];
    const inScopeIds = inScopeEmps.map((e) => e.employmentId);

    // Bulk GROUP BY aggregates — one round-trip each, no per-employee loop.
    const priorBalRows = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
      })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, inScopeIds),
          eq(leaveLedger.leaveTypeId, leaveTypeId),
          lt(leaveLedger.effectiveOn, yearStart),
        ),
      )
      .groupBy(leaveLedger.employmentId);
    const priorBalByEmp = new Map(priorBalRows.map((r) => [r.employmentId, Number(r.bal)]));

    // Reason-tagged forfeit rows whose effectiveOn falls in the selected year (catches BOTH the Jan-1
    // cap-excess forfeit and an anniversary-dated 2D-3 cap forfeit, and the year-qualified expiry date).
    const forfeitRows = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        reason: leaveLedger.reason,
        days: sql<string>`sum(${leaveLedger.days})`,
      })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, inScopeIds),
          eq(leaveLedger.leaveTypeId, leaveTypeId),
          eq(leaveLedger.entryType, 'adjustment'),
          inArray(leaveLedger.reason, [CARRY_FORFEIT_REASON_CAP, CARRY_FORFEIT_REASON_EXPIRY]),
          gte(leaveLedger.effectiveOn, yearStart),
          lte(leaveLedger.effectiveOn, yearEnd),
        ),
      )
      .groupBy(leaveLedger.employmentId, leaveLedger.reason);
    const forfeitByEmp = new Map<string, { atOpen: number; atExpiry: number }>();
    for (const r of forfeitRows) {
      const cur = forfeitByEmp.get(r.employmentId) ?? { atOpen: 0, atExpiry: 0 };
      const amt = Math.abs(Number(r.days));
      if (r.reason === CARRY_FORFEIT_REASON_CAP) cur.atOpen += amt;
      else if (r.reason === CARRY_FORFEIT_REASON_EXPIRY) cur.atExpiry += amt;
      forfeitByEmp.set(r.employmentId, cur);
    }

    // Debits inside each employee's carry window — needed by the shared helper (it derives
    // carryForwardExpiryDate + carried; the forfeit figures below come from the tagged rows above, NOT
    // from this reconstruction, per the plan's dual-path rejection).
    const debitRows = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        taken: sql<string>`coalesce(-sum(${leaveLedger.days}), 0)`,
      })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, inScopeIds),
          eq(leaveLedger.leaveTypeId, leaveTypeId),
          eq(leaveLedger.entryType, 'debit'),
          gte(leaveLedger.effectiveOn, yearStart),
          lte(leaveLedger.effectiveOn, yearEnd),
        ),
      )
      .groupBy(leaveLedger.employmentId);
    const debitByEmp = new Map(debitRows.map((r) => [r.employmentId, Number(r.taken)]));

    const rows: CarryForwardReportRow[] = [];
    for (const e of inScopeEmps) {
      const cycleStart = cycleStartByEmp.get(e.employmentId)!;
      // Policy version active AT this cycle's open (yearStart) — resolveGradePolicy picks the
      // most-generous match for the employee's grade among versions valid at that date, exactly as
      // expireCarriedLeave does for a past year.
      const activeAtOpen: GradePolicyRow[] = policies
        .filter((pol) => pol.validFrom <= yearStart && (pol.validTo == null || pol.validTo > yearStart))
        .map((pol) => ({ gradeId: pol.gradeId, companyId: pol.companyId, accrual: pol.accrual }));
      const policy = resolveGradePolicy(activeAtOpen, e.gradeId, e.companyId, serviceYearsAt(e.hiredOn, yearStart));
      const carryMax = policy?.carryMax ?? 0;
      const anniversaryEarned = isAnniversaryEarned(e.leaveCycle, policy?.method);
      const priorBalance = priorBalByEmp.get(e.employmentId) ?? 0;
      const debitsInWindow = debitByEmp.get(e.employmentId) ?? 0;
      const { carried, carryForwardExpiryDate } = resolveCarryBreakdown({
        cycleStart,
        carryMax,
        expiry: policy?.carryExpiry ?? null,
        priorBalanceAtCycleStart: priorBalance,
        debitsInWindow,
        // currentBalance only affects capExcess/expiryForfeit (unused here — tagged rows are the source
        // of truth for forfeits), so a placeholder is safe.
        currentBalance: 0,
        asOf: yearEnd,
      });
      const forfeit = forfeitByEmp.get(e.employmentId) ?? { atOpen: 0, atExpiry: 0 };
      const forfeitedAtExpiry = anniversaryEarned ? 0 : round2(forfeit.atExpiry);
      const reasonCodes: ('cap' | 'expiry')[] = [];
      if (forfeit.atOpen > 0) reasonCodes.push('cap');
      if (forfeitedAtExpiry > 0) reasonCodes.push('expiry');
      rows.push({
        employmentId: e.employmentId,
        employeeName: e.name,
        company: e.company,
        department: e.department,
        leaveYear: year,
        cycleStart,
        carried,
        // Anniversary-earned cycles are outside the expiry sweep's coverage (no Jan-1 open marker) —
        // print a blank expiry rather than a date the system never enforces (ACCEPTED, unenforced-expiry).
        carryForwardExpiryDate: anniversaryEarned ? null : carryForwardExpiryDate,
        forfeitedAtOpen: round2(forfeit.atOpen),
        forfeitedAtExpiry,
        reasonCodes,
      });
    }
    rows.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
    return rows;
  });
}

export type LeaveBalanceRow = { name: string; balance: number };

/** Leave balances per leave type — the SAME canonical balance logic as core/leave.ts#leaveBalance
 *  (coalesce(sum(days),0) over FULL ledger history, carry-forward + forfeit entries included), summed
 *  across the scoped employees per type. Matching the Leave page is the requirement: full-history signed
 *  sum, no year-boundary cut. */
export async function leaveBalancesSummary(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  filters: AnalyticsFilters = {},
): Promise<LeaveBalanceRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        name: leaveType.name,
        // identical expression to core/leave.ts#leaveBalance (coalesce(sum(days),0)), grouped by type.
        balance: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
      })
      .from(leaveLedger)
      .innerJoin(leaveType, eq(leaveType.id, leaveLedger.leaveTypeId))
      .innerJoin(employment, eq(employment.id, leaveLedger.employmentId))
      .where(and(scopeWhere(scopeIds), filters.companyId ? eq(employment.companyId, filters.companyId) : undefined))
      .groupBy(leaveType.name)
      .orderBy(leaveType.name);
    return rows.map((r) => ({ name: r.name, balance: Number(r.balance) }));
  });
}

export type SickLeaveTrendRow = { month: string; days: number };
export type SickLeaveTrend = { configured: boolean; series: SickLeaveTrendRow[] };

/** There is NO sick/category column on leave_type — only a free-text tenant-configurable `code`. We
 *  default to a candidate pattern (SICK / MC / MEDICAL / HOSPITAL...) rather than hard-coding 'SICK';
 *  callers may pass an explicit code to override. If no type matches, the trend renders "not configured"
 *  (configured=false, empty series) rather than a silently-wrong line. */
const SICK_CODE_RE = /SICK|^MC$|MEDICAL|HOSPITAL/i;

export async function sickLeaveTrend(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  p: { from: string; to: string; sickCode?: string; filters?: AnalyticsFilters },
): Promise<SickLeaveTrend> {
  const filters = p.filters ?? {};
  return withTenant(ctx, async (tx) => {
    const types = await tx.select({ id: leaveType.id, code: leaveType.code }).from(leaveType);
    const sickIds = p.sickCode
      ? types.filter((t) => t.code === p.sickCode).map((t) => t.id)
      : types.filter((t) => SICK_CODE_RE.test(t.code)).map((t) => t.id);
    if (sickIds.length === 0) return { configured: false, series: [] };
    const rows = await tx
      .select({
        month: sql<string>`to_char(${leaveLedger.effectiveOn}, 'YYYY-MM')`,
        days: sql<string>`coalesce(-sum(case when ${leaveLedger.entryType} = 'debit' then ${leaveLedger.days} else 0 end), 0)`,
      })
      .from(leaveLedger)
      .innerJoin(employment, eq(employment.id, leaveLedger.employmentId))
      .where(
        and(
          inArray(leaveLedger.leaveTypeId, sickIds),
          gte(leaveLedger.effectiveOn, p.from),
          lte(leaveLedger.effectiveOn, p.to),
          scopeWhere(scopeIds),
          filters.companyId ? eq(employment.companyId, filters.companyId) : undefined,
        ),
      )
      .groupBy(sql`to_char(${leaveLedger.effectiveOn}, 'YYYY-MM')`)
      .orderBy(sql`to_char(${leaveLedger.effectiveOn}, 'YYYY-MM')`);
    return { configured: true, series: rows.map((r) => ({ month: r.month, days: Number(r.days) })) };
  });
}

// ─────────────────────────── Employee-movement series ───────────────────────────
export type MovementRow = { month: string; hires: number; leavers: number; netChange: number };

/** Hires / leavers / net-change per month over [from, to] — powers the movement line/trend chart.
 *  Honours company / department / manager / etc. filters via analyticsWhere (department resolves against
 *  the CURRENT assignment — consistent with the dimension charts; event-date dept resolution is the
 *  detail-table report's job, not this aggregate trend). */
export async function movementByMonth(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  p: { from: string; to: string; filters?: AnalyticsFilters },
): Promise<MovementRow[]> {
  const filters = p.filters ?? {};
  return withTenant(ctx, async (tx) => {
    const baseWhere = (dateCol: typeof employment.hiredOn | typeof employment.terminatedOn) =>
      and(gte(dateCol, p.from), lte(dateCol, p.to), analyticsWhere({ ...filters, lifecycleStatus: undefined }, scopeIds, {}));
    const hireRows = await tx
      .select({ month: sql<string>`to_char(${employment.hiredOn}, 'YYYY-MM')`, c: count() })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      .where(baseWhere(employment.hiredOn))
      .groupBy(sql`to_char(${employment.hiredOn}, 'YYYY-MM')`);
    const leaveRows = await tx
      .select({ month: sql<string>`to_char(${employment.terminatedOn}, 'YYYY-MM')`, c: count() })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(assignment, currentAssignment)
      .where(baseWhere(employment.terminatedOn))
      .groupBy(sql`to_char(${employment.terminatedOn}, 'YYYY-MM')`);
    const m = new Map<string, MovementRow>();
    const ensure = (month: string) => {
      let row = m.get(month);
      if (!row) {
        row = { month, hires: 0, leavers: 0, netChange: 0 };
        m.set(month, row);
      }
      return row;
    };
    for (const r of hireRows) ensure(r.month).hires = Number(r.c);
    for (const r of leaveRows) ensure(r.month).leavers = Number(r.c);
    for (const row of m.values()) row.netChange = row.hires - row.leavers;
    return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
  });
}

/** Turnover honouring the new dashboard filters (extends the period KPI to company-filter parity).
 *  Average headcount = (active at from + active at to) / 2; turnover = leavers ÷ avg × 100. */
export function turnoverRateFiltered(
  ctx: SessionContext,
  scopeIds: string[] | undefined,
  p: { from: string; to: string; filters?: AnalyticsFilters },
): Promise<TurnoverResult> {
  const filters = p.filters ?? {};
  const companyWhere = filters.companyId ? eq(employment.companyId, filters.companyId) : undefined;
  return withTenant(ctx, async (tx) => {
    const headcountAt = async (d: string): Promise<number> => {
      const [r] = await tx
        .select({ c: count() })
        .from(employment)
        .where(and(activeAsOf(d), scopeWhere(scopeIds), companyWhere));
      return Number(r?.c ?? 0);
    };
    const [lv] = await tx
      .select({ c: count() })
      .from(employment)
      .where(and(gte(employment.terminatedOn, p.from), lte(employment.terminatedOn, p.to), scopeWhere(scopeIds), companyWhere));
    const leavers = Number(lv?.c ?? 0);
    const headcountStart = await headcountAt(p.from);
    const headcountEnd = await headcountAt(p.to);
    const avgHeadcount = round1((headcountStart + headcountEnd) / 2);
    const turnoverPct = avgHeadcount > 0 ? round1((leavers / avgHeadcount) * 100) : 0;
    return { leavers, headcountStart, headcountEnd, avgHeadcount, turnoverPct };
  });
}
