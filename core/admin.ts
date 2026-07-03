/**
 * Admin / setup services — org structure, leave config, and role management.
 * Each mutation runs via withTenant and appends a domain event (substrate discipline,
 * ADR-0006). RLS (migration 0002) requires an admin role for these writes.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { CrossCompanyError } from './org';
import { isValidMonthDay, LEAVE_DURATION_TYPES, type LeaveDurationType, type LeaveEligibility } from './leave';
import { MY_STATES } from '../localization/my/holidays';
import {
  appUser,
  assignment,
  businessUnit,
  company,
  costCenter,
  department,
  domainEvent,
  employment,
  holiday,
  holidayGroup,
  leaveLedger,
  jobGrade,
  leavePolicy,
  leaveRequest,
  leaveType,
  location,
  person,
  position,
  roleAssignment,
} from '../db/schema';

/** The three holiday-calendar KINDS (ADR-0067). 'standard' = official gazette only (no resolver branch);
 *  'extended' = gazette ∪ company ad-hoc; 'custom' = company ad-hoc only (national NOT auto-added). */
export const HOLIDAY_GROUP_ARCHETYPES = ['standard', 'extended', 'custom'] as const;
export type HolidayGroupArchetype = (typeof HOLIDAY_GROUP_ARCHETYPES)[number];
function cleanArchetype(v: string | undefined): HolidayGroupArchetype {
  const s = (v ?? 'standard').trim();
  if (!(HOLIDAY_GROUP_ARCHETYPES as readonly string[]).includes(s))
    throw new Error(`Unknown holiday-calendar kind “${s}”.`);
  return s as HolidayGroupArchetype;
}

/** Thrown when a hard delete is attempted on a referenced record (archive it instead). Pass `message`
 *  to override the default "archive it instead" sentence with a record-specific one. */
export class InUseError extends Error {
  constructor(what: string, message?: string) {
    super(message ?? `This ${what} is in use — archive it instead of deleting.`);
    this.name = 'InUseError';
  }
}

export class DuplicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateError';
  }
}

/** Postgres unique-violation (the 0030 partial unique indexes on the org catalog).
 *  Drizzle wraps the PostgresError, so walk the cause chain for code 23505. */
function isUniqueViolation(e: unknown): boolean {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
}

/** Trim + collapse internal whitespace; the 0030 indexes are case-insensitive on the result. */
function cleanName(v: string | undefined, label: string): string {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error(`${label} is required`);
  return s;
}

/**
 * Normalise + validate a leave-type eligibility rule (#25 visibility). Tri-state by the caller:
 *   undefined → caller leaves the column untouched (a name-only rename must NOT clobber a rule);
 *   null / all-blank → returns null (open to all);
 *   populated → returns a sanitised object built from only the three known fields.
 * Because requestLeave reads whatever JSONB is stored, validation lives in core (not just the action):
 * a malformed POST can't land arbitrary JSONB or an out-of-range value. Throws on bad input.
 */
function cleanEligibility(e: LeaveEligibility | null | undefined): LeaveEligibility | null {
  if (e == null) return null;
  const out: LeaveEligibility = {};
  if (e.gender != null && e.gender !== '') {
    if (e.gender !== 'male' && e.gender !== 'female') throw new Error('Eligibility gender must be male or female');
    out.gender = e.gender;
  }
  if (e.maritalStatus != null && (e.maritalStatus as string) !== '') {
    if (!['single', 'married', 'other'].includes(e.maritalStatus)) {
      throw new Error('Eligibility marital status must be single, married, or other');
    }
    out.maritalStatus = e.maritalStatus;
  }
  if (e.minServiceMonths != null && (e.minServiceMonths as unknown) !== '') {
    const n = Number(e.minServiceMonths);
    if (!Number.isInteger(n) || n < 0) throw new Error('Minimum service months must be a non-negative whole number');
    if (n > 0) out.minServiceMonths = n; // 0 = no service floor → omit so the stored object stays minimal
  }
  // All three blank ⇒ open to all.
  return Object.keys(out).length === 0 ? null : out;
}

/** Uppercased fixed-length ISO code — company.country/currency drive pack lookup and holiday
 *  matching by raw equality, so the shape is enforced here and CHECKed in the DB (0030). */
function isoCode(v: string | undefined, fallback: string, label: string): string {
  const s = (v || fallback).trim().toUpperCase();
  if (!new RegExp(`^[A-Z]{${fallback.length}}$`).test(s)) {
    throw new Error(`${label} must be ${fallback.length} letters (e.g. ${fallback})`);
  }
  return s;
}

type Role =
  | 'employee'
  | 'manager'
  | 'hr_admin'
  | 'super_admin'
  | 'payroll_partner'
  | 'performance_comp_partner';

/** Roles that carry a company scope (ADR-0049): hr_admin plus the two job-function partners. Every
 *  other role is normalized to a null (group-wide / inert) company_id by assignRole. */
const SCOPABLE_ROLES = new Set<Role>(['hr_admin', 'payroll_partner', 'performance_comp_partner']);

export async function createCompany(
  ctx: SessionContext,
  p: { legalName: string; country?: string; currency?: string; registrationNo?: string },
) {
  const legalName = cleanName(p.legalName, 'Legal name');
  const country = isoCode(p.country, 'MY', 'Country');
  const currency = isoCode(p.currency, 'MYR', 'Currency');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(company)
      .values({
        tenantId: ctx.tenantId,
        legalName,
        country,
        currency,
        registrationNo: p.registrationNo?.trim() || null,
      })
      .returning({ id: company.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: row.id,
      eventType: 'company.created',
      actor: actorOf(ctx),
      payload: { legalName: p.legalName, country: p.country || 'MY' },
    });
    return row;
  });
}

/** Set (or clear) a company's parent in the group tree. Cycles are rejected by a DB trigger. */
export async function setCompanyParent(
  ctx: SessionContext,
  p: { companyId: string; parentCompanyId: string | null },
) {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(company)
      .set({ parentCompanyId: p.parentCompanyId })
      .where(eq(company.id, p.companyId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.companyId,
      eventType: 'company.parent.changed',
      actor: actorOf(ctx),
      payload: { parentCompanyId: p.parentCompanyId },
    });
    return { id: p.companyId };
  });
}

/** A department's Business Unit (ADR-0068) must belong to the SAME company as the department. Validates a
 *  non-empty id inside the caller's tx; returns the normalised id-or-null. Empty/blank → null (unassigned). */
async function resolveDepartmentBusinessUnitId(
  tx: Tx,
  businessUnitId: string | null | undefined,
  companyId: string,
): Promise<string | null> {
  const id = (businessUnitId ?? '').trim();
  if (!id) return null;
  const [bu] = await tx
    .select({ companyId: businessUnit.companyId })
    .from(businessUnit)
    .where(eq(businessUnit.id, id))
    .limit(1);
  if (!bu || bu.companyId !== companyId) throw new CrossCompanyError('business-unit');
  return id;
}

export async function createDepartment(
  ctx: SessionContext,
  p: { companyId: string; name: string; parentDepartmentId?: string; businessUnitId?: string | null },
) {
  const name = cleanName(p.name, 'Department name');
  return withTenant(ctx, async (tx) => {
    // Belt-and-braces (mirrors the RLS clamp in app.heads_department_of, migration 0121): a parent
    // department must belong to the SAME company, so a cross-company department tree — which would leak
    // employees across companies to a HOD of the parent — can never be built in the first place.
    if (p.parentDepartmentId) {
      const [parent] = await tx
        .select({ companyId: department.companyId })
        .from(department)
        .where(eq(department.id, p.parentDepartmentId))
        .limit(1);
      if (!parent || parent.companyId !== p.companyId) throw new CrossCompanyError('department');
    }
    const businessUnitId = await resolveDepartmentBusinessUnitId(tx, p.businessUnitId, p.companyId);
    const [row] = await tx
      .insert(department)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        name,
        parentDepartmentId: p.parentDepartmentId || null,
        businessUnitId,
      })
      .returning({ id: department.id })
      .catch((e) => {
        if (isUniqueViolation(e)) throw new DuplicateError(`A department named “${name}” already exists in this company.`);
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'department',
      aggregateId: row.id,
      eventType: 'department.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, name: p.name, businessUnitId },
    });
    return row;
  });
}

export async function createPosition(
  ctx: SessionContext,
  p: { companyId: string; title: string; jobFamily?: string },
) {
  const title = cleanName(p.title, 'Position title');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(position)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, title, jobFamily: p.jobFamily?.trim() || null })
      .returning({ id: position.id })
      .catch((e) => {
        if (isUniqueViolation(e)) throw new DuplicateError(`A position titled “${title}” already exists in this company.`);
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'position',
      aggregateId: row.id,
      eventType: 'position.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, title: p.title },
    });
    return row;
  });
}

export async function createCostCenter(
  ctx: SessionContext,
  p: { companyId: string; code: string; name: string },
) {
  const code = cleanName(p.code, 'Cost-center code');
  const name = cleanName(p.name, 'Cost-center name');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(costCenter)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, code, name })
      .returning({ id: costCenter.id })
      .catch((e) => {
        if (isUniqueViolation(e)) throw new DuplicateError(`A cost center with code “${code}” already exists in this company.`);
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'cost-center',
      aggregateId: row.id,
      eventType: 'cost-center.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, code: p.code },
    });
    return row;
  });
}

/** Business Unit master (ADR-0068) — a FLAT, company-scoped catalog cloning the cost_center pattern
 *  end-to-end: company-scoped, DB partial-unique index (from migration 0136), DuplicateError on clash,
 *  and a DomainEvent on every write. No parent/child hierarchy (reporter decision). */
export async function createBusinessUnit(
  ctx: SessionContext,
  p: { companyId: string; code: string; name: string },
) {
  const code = cleanName(p.code, 'Business-unit code');
  const name = cleanName(p.name, 'Business-unit name');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(businessUnit)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, code, name })
      .returning({ id: businessUnit.id })
      .catch((e) => {
        if (isUniqueViolation(e)) throw new DuplicateError(`A business unit with code “${code}” already exists in this company.`);
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'business-unit',
      aggregateId: row.id,
      eventType: 'business-unit.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, code: p.code },
    });
    return row;
  });
}

export async function createLeaveType(
  ctx: SessionContext,
  p: { code: string; name: string; paid?: boolean },
) {
  // The code is the semantic key the statutory floor / standing grants / carry-forward match on
  // (exact, uppercase). Normalize hard so 'annual' can never silently miss the EA floor.
  const code = cleanName(p.code, 'Leave-type code').toUpperCase().replace(/ /g, '_');
  if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(code)) {
    throw new Error('Leave-type code must be letters, digits or underscores (e.g. ANNUAL)');
  }
  const name = cleanName(p.name, 'Leave-type name');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(leaveType)
      .values({ tenantId: ctx.tenantId, code, name, paid: p.paid ?? true })
      .returning({ id: leaveType.id })
      .catch((e) => {
        if (isUniqueViolation(e)) throw new DuplicateError(`A leave type with code “${code}” already exists.`);
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-type',
      aggregateId: row.id,
      eventType: 'leave-type.created',
      actor: actorOf(ctx),
      payload: { code, name },
    });
    return row;
  });
}

// ── Job grades (ADR-0041 2E) ──────────────────────────────────────────────────────────────────────
export async function createJobGrade(
  ctx: SessionContext,
  p: { code: string; name: string; rank?: number },
) {
  const code = cleanName(p.code, 'Grade code').toUpperCase().replace(/ /g, '_');
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(code)) {
    throw new Error('Grade code must be letters, digits or underscores (e.g. EXEC, G1)');
  }
  const name = cleanName(p.name, 'Grade name');
  const rank = Number.isFinite(p.rank) ? Number(p.rank) : 0;
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(jobGrade)
      .values({ tenantId: ctx.tenantId, code, name, rank })
      .returning({ id: jobGrade.id })
      .catch((e) => {
        if (isUniqueViolation(e)) throw new DuplicateError(`A grade with code “${code}” already exists.`);
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'job-grade',
      aggregateId: row.id,
      eventType: 'job-grade.created',
      actor: actorOf(ctx),
      payload: { code, name, rank },
    });
    return row;
  });
}

export async function updateJobGrade(
  ctx: SessionContext,
  p: { id: string; name: string; rank?: number },
) {
  const name = cleanName(p.name, 'Grade name');
  const rank = Number.isFinite(p.rank) ? Number(p.rank) : 0;
  return withTenant(ctx, async (tx) => {
    await tx.update(jobGrade).set({ name, rank }).where(eq(jobGrade.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'job-grade',
      aggregateId: p.id,
      eventType: 'job-grade.updated',
      actor: actorOf(ctx),
      payload: { name, rank },
    });
  });
}

export async function archiveJobGrade(ctx: SessionContext, p: { id: string; archived: boolean }) {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(jobGrade)
      .set({ archivedAt: p.archived ? sql`now()` : null })
      .where(eq(jobGrade.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'job-grade',
      aggregateId: p.id,
      eventType: p.archived ? 'job-grade.archived' : 'job-grade.unarchived',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}

/**
 * ADR-0038 carry-forward expiry (R4 Build #1 — mode-authoritative + validated).
 *
 * Returns the carry-expiry keys to spread into `accrual`, emitting EXACTLY one mode's pair so a switch
 * (date→months or vice-versa) never leaves a stale cross-mode key behind in the rebuilt JSONB:
 *   - 'months' mode: `{ carryForwardExpiryMode: 'months', carryForwardExpiryMonths: X }` (X ∈ 1..12). An
 *     empty/missing X ⇒ `{}` (never expires — mirrors the date "both unset" branch). Month/day keys omitted.
 *   - 'date' mode (or mode absent — back-compat): validate month/day with `isValidMonthDay` and emit
 *     `{ carryForwardExpiryMonth, carryForwardExpiryDay }`; both unset ⇒ `{}` (never expires). Months keys
 *     omitted so the writer never persists mode without months.
 *
 * Throws a plain-English error (matching the sibling `throw new Error(string)` convention in this file —
 * there is no code→i18n machinery) on an impossible calendar date or an out-of-range months value; the
 * server action's try/catch surfaces the message to the error banner.
 */
function carryExpiryAccrual(p: {
  mode?: 'date' | 'months';
  month?: number | null;
  day?: number | null;
  months?: number | null;
}): {
  carryForwardExpiryMode?: 'months';
  carryForwardExpiryMonths?: number;
  carryForwardExpiryMonth?: number;
  carryForwardExpiryDay?: number;
} {
  if (p.mode === 'months') {
    // Empty months ⇒ never expires (blank = never, matching the date branch). Do NOT persist mode-only.
    if (p.months == null || String(p.months) === '') return {};
    const x = Number(p.months);
    if (!Number.isInteger(x) || x < 1 || x > 12) {
      throw new Error('Carry-forward expiry months must be between 1 and 12.');
    }
    return { carryForwardExpiryMode: 'months', carryForwardExpiryMonths: x };
  }
  // date mode (or absent)
  const m = Number(p.month ?? 0);
  const d = Number(p.day ?? 0);
  if (m === 0 && d === 0) return {}; // both unset ⇒ never expires
  if (!isValidMonthDay(m, d)) {
    throw new Error('Carry-forward expiry must be a real calendar date (e.g. 30 April, not 31 April).');
  }
  return { carryForwardExpiryMonth: m, carryForwardExpiryDay: d };
}

/**
 * Carry-forward enhancement — JSONB-rebuild safety. createLeavePolicy/updateLeavePolicy rebuild the
 * whole `accrual` JSONB on every save, so a key the form did not submit is dropped. We therefore
 * distinguish ABSENT (`undefined`) from explicit-off (`false`): when the carry block was not rendered
 * for this policy (e.g. a non-ANNUAL edit), the action leaves `enabled` undefined and we OMIT the key
 * entirely so the back-compat `carryForwardMax > 0` default still governs. Only an explicit boolean is
 * persisted. The include-earned flag is config-only (persisted, not yet read by the engine) and follows
 * the same omit-when-undefined rule so it can't be silently lost either.
 */
function carryFlagsAccrual(
  enabled?: boolean,
  includeEarned?: boolean,
): { carryForwardEnabled?: boolean; carryForwardIncludeEarned?: boolean } {
  const out: { carryForwardEnabled?: boolean; carryForwardIncludeEarned?: boolean } = {};
  if (typeof enabled === 'boolean') out.carryForwardEnabled = enabled;
  if (typeof includeEarned === 'boolean') out.carryForwardIncludeEarned = includeEarned;
  return out;
}

export async function createLeavePolicy(
  ctx: SessionContext,
  p: {
    leaveTypeId: string;
    annualDays: number;
    /** Max unused ANNUAL days carried into the next leave year (default 0 = forfeit). */
    carryForwardMax?: number;
    /** ADR-0038: month/day on which the carried-forward portion expires (auto-forfeit). Both unset = never. */
    carryForwardExpiryMonth?: number | null;
    carryForwardExpiryDay?: number | null;
    /** R4 Build #1: expiry mode. 'date' (or absent) reads month/day; 'months' reads carryForwardExpiryMonths. */
    carryForwardExpiryMode?: 'date' | 'months';
    /** R4 Build #1: X ∈ 1..12 — "expire X months after year-end". Only read in 'months' mode. */
    carryForwardExpiryMonths?: number | null;
    /** Carry-forward enhancement: explicit on/off switch. undefined = omit (back-compat `cap > 0` default). */
    carryForwardEnabled?: boolean;
    /** Carry-forward enhancement (config-only): include monthly-earned balance. Persisted; engine wiring deferred. */
    carryForwardIncludeEarned?: boolean;
    method?: string;
    /** ADR-0041 2E: grade this policy applies to. null/undefined = all grades (the company default). */
    gradeId?: string | null;
    /** ADR-0066: company this policy applies to. null/undefined = group default (all companies). A company
     *  override ALWAYS wins for that company in the resolver — even when it grants fewer days. */
    companyId?: string | null;
    validFrom: string;
  },
) {
  return withTenant(ctx, async (tx) => {
    const carryForwardMax = Math.max(0, Number(p.carryForwardMax ?? 0));
    const expiry = carryExpiryAccrual({
      mode: p.carryForwardExpiryMode,
      month: p.carryForwardExpiryMonth,
      day: p.carryForwardExpiryDay,
      months: p.carryForwardExpiryMonths,
    });
    const carryFlags = carryFlagsAccrual(p.carryForwardEnabled, p.carryForwardIncludeEarned);
    const companyId = p.companyId ?? null;
    const [row] = await tx
      .insert(leavePolicy)
      .values({
        tenantId: ctx.tenantId,
        leaveTypeId: p.leaveTypeId,
        gradeId: p.gradeId ?? null,
        companyId,
        accrual: {
          annualDays: p.annualDays,
          carryForwardMax,
          method: p.method || 'grant_on_hire_prorated',
          ...expiry,
          ...carryFlags,
        },
        validFrom: p.validFrom,
        validTo: null,
      })
      .returning({ id: leavePolicy.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-policy',
      aggregateId: row.id,
      eventType: 'leave-policy.created',
      actor: actorOf(ctx),
      payload: { leaveTypeId: p.leaveTypeId, annualDays: p.annualDays, carryForwardMax, companyId, ...expiry, ...carryFlags },
    });
    return row;
  });
}

/** Correct an existing entitlement in place (same effective date) — for fixing a mis-typed
 *  value. A change *going forward* is a new dated policy via createLeavePolicy, not this. */
export async function updateLeavePolicy(
  ctx: SessionContext,
  p: {
    id: string;
    annualDays: number;
    carryForwardMax?: number;
    /** ADR-0038: month/day on which the carried-forward portion expires (auto-forfeit). Both unset = never. */
    carryForwardExpiryMonth?: number | null;
    carryForwardExpiryDay?: number | null;
    /** R4 Build #1: expiry mode. 'date' (or absent) reads month/day; 'months' reads carryForwardExpiryMonths. */
    carryForwardExpiryMode?: 'date' | 'months';
    /** R4 Build #1: X ∈ 1..12 — "expire X months after year-end". Only read in 'months' mode. */
    carryForwardExpiryMonths?: number | null;
    /** Carry-forward enhancement: explicit on/off switch. undefined = omit (back-compat `cap > 0` default). */
    carryForwardEnabled?: boolean;
    /** Carry-forward enhancement (config-only): include monthly-earned balance. Persisted; engine wiring deferred. */
    carryForwardIncludeEarned?: boolean;
    method?: string;
    gradeId?: string | null;
    /** ADR-0066: company this policy applies to. null/undefined = group default (all companies). */
    companyId?: string | null;
    validFrom: string;
  },
) {
  return withTenant(ctx, async (tx) => {
    const carryForwardMax = Math.max(0, Number(p.carryForwardMax ?? 0));
    const expiry = carryExpiryAccrual({
      mode: p.carryForwardExpiryMode,
      month: p.carryForwardExpiryMonth,
      day: p.carryForwardExpiryDay,
      months: p.carryForwardExpiryMonths,
    });
    const carryFlags = carryFlagsAccrual(p.carryForwardEnabled, p.carryForwardIncludeEarned);
    const companyId = p.companyId ?? null;
    await tx
      .update(leavePolicy)
      .set({
        gradeId: p.gradeId ?? null,
        companyId,
        accrual: {
          annualDays: p.annualDays,
          carryForwardMax,
          method: p.method || 'grant_on_hire_prorated',
          ...expiry,
          ...carryFlags,
        },
        validFrom: p.validFrom,
      })
      .where(eq(leavePolicy.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-policy',
      aggregateId: p.id,
      eventType: 'leave-policy.updated',
      actor: actorOf(ctx),
      payload: { annualDays: p.annualDays, carryForwardMax, companyId, validFrom: p.validFrom, ...expiry, ...carryFlags },
    });
  });
}

/** Remove an entitlement policy. Safe: the ledger references the leave *type*, not the policy,
 *  so past grants are untouched — this only stops the row from driving future grants. */
export async function deleteLeavePolicy(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    await tx.delete(leavePolicy).where(eq(leavePolicy.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-policy',
      aggregateId: p.id,
      eventType: 'leave-policy.deleted',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}

export async function assignRole(
  ctx: SessionContext,
  p: { appUserId: string; role: Role; companyId?: string },
) {
  // SCOPABLE_ROLES (hr_admin + the two partners, ADR-0049) consume a company scope. super_admin is
  // inherently group-wide (DB CHECK enforces it); manager/employee scoping isn't implemented — so
  // normalize companyId to null for every other role rather than persist inert, misleading grants.
  // RLS additionally requires the assigner to be a group admin to mint partners (0099 tightening),
  // so this never escalates privilege.
  const companyId = SCOPABLE_ROLES.has(p.role) ? p.companyId || null : null;
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(roleAssignment)
      .values({ tenantId: ctx.tenantId, appUserId: p.appUserId, role: p.role, companyId })
      .returning({ id: roleAssignment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'role-assignment',
      aggregateId: row.id,
      eventType: 'role.assigned',
      actor: actorOf(ctx),
      payload: { appUserId: p.appUserId, role: p.role, companyId },
    });
    return row;
  });
}

export async function revokeRole(ctx: SessionContext, p: { roleAssignmentId: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(roleAssignment)
      .where(eq(roleAssignment.id, p.roleAssignmentId))
      .limit(1);
    if (!row) throw new Error('role assignment not found');
    // Reads are tenant-wide but writes are subtree-gated (migration 0023): a delegated admin can
    // SELECT a grant they may not DELETE. Use returning() and bail if RLS removed nothing, so we
    // never log a revoke for a row that still exists.
    const deleted = await tx
      .delete(roleAssignment)
      .where(eq(roleAssignment.id, p.roleAssignmentId))
      .returning({ id: roleAssignment.id });
    if (deleted.length === 0) throw new Error('Not permitted to revoke this role assignment');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'role-assignment',
      aggregateId: p.roleAssignmentId,
      eventType: 'role.revoked',
      actor: actorOf(ctx),
      payload: { appUserId: row.appUserId, role: row.role },
    });
  });
}

// ── Reads ──────────────────────────────────────────────────────────

export function listPositions(
  ctx: SessionContext,
  opts: { includeArchived?: boolean; companyIds?: string[] } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: position.id,
        companyId: position.companyId,
        title: position.title,
        jobFamily: position.jobFamily,
        archivedAt: position.archivedAt,
        inUse: sql<boolean>`exists (select 1 from assignment a where a.position_id = position.id and a.superseded_at is null)`,
      })
      .from(position)
      .where(
        and(
          opts.includeArchived ? undefined : isNull(position.archivedAt),
          opts.companyIds && opts.companyIds.length ? inArray(position.companyId, opts.companyIds) : undefined,
        ),
      )
      .orderBy(position.title),
  );
}

export function listCostCenters(
  ctx: SessionContext,
  opts: { includeArchived?: boolean; companyIds?: string[] } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: costCenter.id,
        companyId: costCenter.companyId,
        code: costCenter.code,
        name: costCenter.name,
        archivedAt: costCenter.archivedAt,
        inUse: sql<boolean>`exists (select 1 from assignment a where a.cost_center_id = cost_center.id and a.superseded_at is null)`,
      })
      .from(costCenter)
      .where(
        and(
          opts.includeArchived ? undefined : isNull(costCenter.archivedAt),
          opts.companyIds && opts.companyIds.length ? inArray(costCenter.companyId, opts.companyIds) : undefined,
        ),
      )
      .orderBy(costCenter.code),
  );
}

/** Business Unit master list (ADR-0068), cost_center-shaped. `inUse` = at least one department links to it
 *  (the correct guard column for a future delete path). */
export function listBusinessUnits(
  ctx: SessionContext,
  opts: { includeArchived?: boolean; companyIds?: string[] } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: businessUnit.id,
        companyId: businessUnit.companyId,
        code: businessUnit.code,
        name: businessUnit.name,
        archivedAt: businessUnit.archivedAt,
        inUse: sql<boolean>`exists (select 1 from department d where d.business_unit_id = business_unit.id)`,
      })
      .from(businessUnit)
      .where(
        and(
          opts.includeArchived ? undefined : isNull(businessUnit.archivedAt),
          opts.companyIds && opts.companyIds.length ? inArray(businessUnit.companyId, opts.companyIds) : undefined,
        ),
      )
      .orderBy(businessUnit.code),
  );
}

export function listLeavePolicies(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: leavePolicy.id,
        leaveTypeId: leavePolicy.leaveTypeId,
        leaveType: leaveType.name,
        typeCode: leaveType.code,
        accrual: leavePolicy.accrual,
        gradeId: leavePolicy.gradeId,
        gradeName: jobGrade.name,
        // ADR-0066: the owning company (null = group default) + its name for the policy-row scope badge.
        companyId: leavePolicy.companyId,
        companyName: company.legalName,
        validFrom: leavePolicy.validFrom,
        validTo: leavePolicy.validTo,
      })
      .from(leavePolicy)
      .innerJoin(leaveType, eq(leaveType.id, leavePolicy.leaveTypeId))
      .leftJoin(jobGrade, eq(jobGrade.id, leavePolicy.gradeId))
      .leftJoin(company, eq(company.id, leavePolicy.companyId))
      .orderBy(leaveType.name),
  );
}

export type AdHocLeaveGrantRow = {
  occurredAt: Date;
  leaveTypeId: string | null;
  companyId: string | null;
  days: number | null;
  count: number | null;
  reason: string | null;
  effectiveOn: string | null;
};

/** ADR-0066: recent festive / one-off grants, reconstructed from the `leave.ad-hoc.granted` event log
 *  (no dedicated table — the summary event is the record). Newest first. */
export function listAdHocLeaveGrants(ctx: SessionContext, limit = 10) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ occurredAt: domainEvent.occurredAt, payload: domainEvent.payload })
      .from(domainEvent)
      .where(eq(domainEvent.eventType, 'leave.ad-hoc.granted'))
      .orderBy(desc(domainEvent.occurredAt))
      .limit(limit);
    return rows.map((r): AdHocLeaveGrantRow => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      return {
        occurredAt: r.occurredAt,
        leaveTypeId: (p.leaveTypeId as string | null) ?? null,
        companyId: (p.companyId as string | null) ?? null,
        days: p.days != null ? Number(p.days) : null,
        count: p.count != null ? Number(p.count) : null,
        reason: (p.reason as string | null) ?? null,
        effectiveOn: (p.effectiveOn as string | null) ?? null,
      };
    });
  });
}

// ───────────────────────── Public holiday calendar ─────────────────────────
// Holidays are country-scoped (the attendance/leave working-day counters match on company.country),
// not company-scoped — the table is keyed (tenant, country, holiday_date). Admin-only writes (RLS 0006).

/** List holidays for the tenant, newest first. Optionally filter by country, calendar year, and/or the
 *  owning company (org-scoped rows). Returns raw scope fields (state, companyId) + the joined company name
 *  so the UI can build a scope label from the static i18n key map (National / State:X / Group:<name>). */
export function listHolidays(
  ctx: SessionContext,
  opts: { country?: string; year?: number; companyId?: string } = {},
) {
  return withTenant(ctx, (tx) => {
    const filters = [
      opts.country ? eq(holiday.country, opts.country) : undefined,
      opts.year ? sql`extract(year from ${holiday.holidayDate}) = ${opts.year}` : undefined,
      opts.companyId ? eq(holiday.companyId, opts.companyId) : undefined,
    ].filter(Boolean);
    return tx
      .select({
        id: holiday.id,
        country: holiday.country,
        state: holiday.state,
        companyId: holiday.companyId,
        companyName: company.legalName,
        holidayDate: holiday.holidayDate,
        name: holiday.name,
        // Follow-on #15b (ADR-0063): surface the provisional marker so the UI can render a Tentative badge.
        tentative: holiday.tentative,
      })
      .from(holiday)
      .leftJoin(company, eq(company.id, holiday.companyId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(holiday.holidayDate);
  });
}

/** Distinct years that have at least one holiday — drives the year filter UI. */
export function listHolidayYears(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ year: sql<number>`extract(year from ${holiday.holidayDate})::int` })
      .from(holiday)
      .groupBy(sql`extract(year from ${holiday.holidayDate})`)
      .orderBy(sql`extract(year from ${holiday.holidayDate}) desc`);
    return rows.map((r) => r.year);
  });
}

export async function createHoliday(
  ctx: SessionContext,
  p: {
    country: string;
    holidayDate: string;
    name: string;
    state?: string | null;
    companyId?: string | null;
    // Follow-on #15b (ADR-0063): provisional date for a not-yet-gazetted holiday. Still counts as a holiday.
    tentative?: boolean;
  },
) {
  const country = isoCode(p.country, 'MY', 'Country');
  const name = cleanName(p.name, 'Holiday name');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.holidayDate)) throw new Error('Holiday date must be YYYY-MM-DD');
  const state = p.state?.trim() || null; // 2C: null = national (applies everywhere)
  const companyId = p.companyId?.trim() || null; // ADR-0055: set = business-group (company-subtree) scope
  const tentative = p.tentative ?? false;
  // Scope is single-axis: national, state, OR business-group — never two at once (mirrors the DB CHECK
  // holiday_scope_excl; thrown here so the user gets a clear message before hitting the constraint).
  if (state && companyId) throw new Error('A holiday is either state-scoped or company-scoped, not both.');
  return withTenant(ctx, async (tx) => {
    let companyName: string | null = null;
    if (companyId) {
      // Cross-tenant FK guard: the FK is satisfied by any existing id, so verify the company is THIS
      // tenant's under the tenant-scoped role before trusting it (RLS on holiday alone can't catch this).
      const [c] = await tx
        .select({ name: company.legalName })
        .from(company)
        .where(and(eq(company.id, companyId), eq(company.tenantId, ctx.tenantId)))
        .limit(1);
      if (!c) throw new Error('Unknown company for this holiday scope.');
      companyName = c.name;
    }
    const [row] = await tx
      .insert(holiday)
      .values({ tenantId: ctx.tenantId, country, state, companyId, holidayDate: p.holidayDate, name, tentative })
      .returning({ id: holiday.id })
      .catch((e) => {
        if (isUniqueViolation(e)) {
          const scope = companyId ? `group ${companyName} ` : state ? `${state} ` : '';
          throw new DuplicateError(`A ${country} ${scope}holiday on ${p.holidayDate} already exists.`);
        }
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'holiday',
      aggregateId: row.id,
      eventType: 'holiday.created',
      actor: actorOf(ctx),
      // Scope-in-audit (ADR-0055 acceptance goal): carry state AND companyId, not just country/date/name.
      payload: { country, holidayDate: p.holidayDate, name, state, companyId, tentative },
    });
    return row;
  });
}

/**
 * Follow-on #15b (ADR-0063) — edit an existing holiday's date, name and/or tentative flag. The missing
 * CRUD op: until now HR could only add + delete, so correcting a shifted (often last-minute gazetted) state
 * holiday meant losing the row's identity. Only the supplied fields change; scope (country/state/companyId)
 * is IMMUTABLE here — a scope change is delete + recreate (keeps the single-axis holiday_scope_excl CHECK
 * out of update churn). Loads the before-row (throws if missing), maps a moved-date collision to
 * DuplicateError (same scope-aware message as create), and appends holiday.updated {before, after}.
 */
export async function updateHoliday(
  ctx: SessionContext,
  p: { id: string; holidayDate?: string; name?: string; tentative?: boolean },
) {
  // Validate up front (before any DB work), reusing create's guards so update is no laxer than create.
  if (p.holidayDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(p.holidayDate)) {
    throw new Error('Holiday date must be YYYY-MM-DD');
  }
  const nextName = p.name !== undefined ? cleanName(p.name, 'Holiday name') : undefined;
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        country: holiday.country,
        state: holiday.state,
        companyId: holiday.companyId,
        holidayDate: holiday.holidayDate,
        name: holiday.name,
        tentative: holiday.tentative,
      })
      .from(holiday)
      .where(eq(holiday.id, p.id))
      .limit(1);
    if (!before) throw new Error('Holiday not found');

    const after = {
      holidayDate: p.holidayDate ?? before.holidayDate,
      name: nextName ?? before.name,
      tentative: p.tentative ?? before.tentative,
    };
    await tx
      .update(holiday)
      .set({ holidayDate: after.holidayDate, name: after.name, tentative: after.tentative })
      .where(eq(holiday.id, p.id))
      .catch((e) => {
        if (isUniqueViolation(e)) {
          // Scope is immutable here, so reuse the BEFORE scope for the message (mirrors create).
          const scope = before.companyId ? 'group ' : before.state ? `${before.state} ` : '';
          throw new DuplicateError(`A ${before.country} ${scope}holiday on ${after.holidayDate} already exists.`);
        }
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'holiday',
      aggregateId: p.id,
      eventType: 'holiday.updated',
      actor: actorOf(ctx),
      // Scope-in-audit (ADR-0055): carry the unchanged scope on both sides alongside date/name/tentative.
      payload: {
        before: {
          holidayDate: before.holidayDate,
          name: before.name,
          tentative: before.tentative,
          country: before.country,
          state: before.state,
          companyId: before.companyId,
        },
        after: {
          ...after,
          country: before.country,
          state: before.state,
          companyId: before.companyId,
        },
      },
    });
    return { id: p.id };
  });
}

export async function deleteHoliday(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    const [deleted] = await tx
      .delete(holiday)
      .where(eq(holiday.id, p.id))
      .returning({
        country: holiday.country,
        holidayDate: holiday.holidayDate,
        name: holiday.name,
        // Echo full scope so the holiday.deleted payload mirrors holiday.created (ADR-0055).
        state: holiday.state,
        companyId: holiday.companyId,
      });
    if (!deleted) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'holiday',
      aggregateId: p.id,
      eventType: 'holiday.deleted',
      actor: actorOf(ctx),
      payload: { ...deleted },
    });
  });
}

// ───────────────────────── Holiday groups ─────────────────────────
// A holiday group is a NAMED bundle of states (MY_STATES labels). It is delivered OVER the existing state
// engine: holidays are not re-tagged; the resolver (core/leave.ts) expands the assigned group to its
// member states and feeds them into the same holiday.state UNION predicate as work_state. Admin-only
// writes (RLS 0100). Assignment lives on employment.holiday_group_id (mutually exclusive with work_state).

/** Sanitise + validate a group's member states: each ∈ MY_STATES, de-duplicated. For a 'custom' calendar
 *  states supply nothing (national is NOT auto-added) so an empty list is allowed; for 'standard'/'extended'
 *  the states[] ARE the gazette state source, so at least one is required (a zero-state non-custom group ==
 *  national, which already exists). */
function cleanHolidayGroupStates(states: string[] | undefined, archetype: HolidayGroupArchetype): string[] {
  const valid = new Set<string>(MY_STATES);
  const out = [...new Set((states ?? []).map((s) => (s ?? '').trim()).filter(Boolean))];
  if (archetype !== 'custom' && out.length === 0)
    throw new Error('A standard or extended holiday calendar must include at least one state.');
  for (const s of out) {
    if (!valid.has(s)) throw new Error(`Unknown state “${s}”.`);
  }
  return out;
}

/** All holiday groups for the tenant (id, name, states, archetype), ordered by name. Read-only — no event. */
export function listHolidayGroups(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: holidayGroup.id,
        name: holidayGroup.name,
        states: holidayGroup.states,
        archetype: holidayGroup.archetype,
      })
      .from(holidayGroup)
      .orderBy(holidayGroup.name),
  );
}

export async function createHolidayGroup(
  ctx: SessionContext,
  p: { name: string; states: string[]; archetype?: string },
) {
  const name = cleanName(p.name, 'Group name');
  const archetype = cleanArchetype(p.archetype);
  const states = cleanHolidayGroupStates(p.states, archetype);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(holidayGroup)
      .values({ tenantId: ctx.tenantId, name, states, archetype })
      .returning({ id: holidayGroup.id })
      .catch((e) => {
        if (isUniqueViolation(e)) throw new DuplicateError(`A holiday group named “${name}” already exists.`);
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'holiday-group',
      aggregateId: row.id,
      eventType: 'holiday-group.created',
      actor: actorOf(ctx),
      payload: { name, states, archetype },
    });
    return row;
  });
}

export async function updateHolidayGroup(
  ctx: SessionContext,
  p: { id: string; name?: string; states?: string[]; archetype?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ name: holidayGroup.name, states: holidayGroup.states, archetype: holidayGroup.archetype })
      .from(holidayGroup)
      .where(eq(holidayGroup.id, p.id))
      .limit(1);
    if (!before) throw new Error('Holiday group not found');
    const name = p.name !== undefined ? cleanName(p.name, 'Group name') : before.name;
    const archetype = p.archetype !== undefined ? cleanArchetype(p.archetype) : (before.archetype as HolidayGroupArchetype);
    const states = p.states !== undefined ? cleanHolidayGroupStates(p.states, archetype) : (before.states as string[]);
    // A standard/extended calendar still needs ≥1 gazette state even if only the archetype changed.
    if (archetype !== 'custom' && states.length === 0)
      throw new Error('A standard or extended holiday calendar must include at least one state.');
    await tx
      .update(holidayGroup)
      .set({ name, states, archetype })
      .where(eq(holidayGroup.id, p.id))
      .catch((e) => {
        if (isUniqueViolation(e)) throw new DuplicateError(`A holiday group named “${name}” already exists.`);
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'holiday-group',
      aggregateId: p.id,
      eventType: 'holiday-group.updated',
      actor: actorOf(ctx),
      payload: {
        before: { name: before.name, states: before.states, archetype: before.archetype },
        after: { name, states, archetype },
      },
    });
    return { id: p.id };
  });
}

export async function deleteHolidayGroup(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    // Lock the referencing employments inside the tx so the count can't change under us between the guard
    // and the delete. The ON DELETE SET NULL FK is the DB-level backstop (a lost race can't orphan); this
    // in-tx guard gives the friendly "still assigned to N employees" UX instead of silent reassignment.
    const refs = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(eq(employment.holidayGroupId, p.id))
      .for('update');
    if (refs.length > 0) {
      throw new InUseError(
        'holiday group',
        `This holiday group is still assigned to ${refs.length} employee${refs.length === 1 ? '' : 's'}. Reassign them before deleting it.`,
      );
    }
    // ADR-0067: also block when a LOCATION maps to this calendar (lock those rows too). The ON DELETE SET
    // NULL FK is the backstop; the guard is the authoritative friendly path so a mapped calendar can't be
    // silently un-mapped from every location at its site.
    const locRefs = await tx
      .select({ id: location.id })
      .from(location)
      .where(eq(location.holidayGroupId, p.id))
      .for('update');
    if (locRefs.length > 0) {
      throw new InUseError(
        'holiday group',
        `This holiday calendar is still assigned to ${locRefs.length} location${locRefs.length === 1 ? '' : 's'}. Unassign it there before deleting it.`,
      );
    }
    const [deleted] = await tx
      .delete(holidayGroup)
      .where(eq(holidayGroup.id, p.id))
      .returning({ name: holidayGroup.name, states: holidayGroup.states });
    if (!deleted) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'holiday-group',
      aggregateId: p.id,
      eventType: 'holiday-group.deleted',
      actor: actorOf(ctx),
      payload: { name: deleted.name, states: deleted.states },
    });
  });
}

export function listUsers(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    const users = await tx
      .select({
        id: appUser.id,
        workosUserId: appUser.workosUserId,
        personId: appUser.personId,
        name: person.fullName,
        email: person.primaryEmail,
      })
      .from(appUser)
      .leftJoin(person, eq(person.id, appUser.personId))
      .orderBy(person.fullName);
    const roles = await tx
      .select({
        id: roleAssignment.id,
        appUserId: roleAssignment.appUserId,
        role: roleAssignment.role,
        companyId: roleAssignment.companyId,
        company: company.legalName,
      })
      .from(roleAssignment)
      .leftJoin(company, eq(company.id, roleAssignment.companyId));
    return users.map((u) => ({ ...u, roles: roles.filter((r) => r.appUserId === u.id) }));
  });
}

// ───────────────── Edit + state-aware remove (delete if unused, else archive) ─────────────────

export async function updateDepartment(
  ctx: SessionContext,
  p: { id: string; name: string; businessUnitId?: string | null },
) {
  const name = cleanName(p.name, 'Department name');
  return withTenant(ctx, async (tx) => {
    // businessUnitId is tri-state: undefined → leave the column untouched (a name-only rename must NOT wipe
    // the BU); null/'' → clear it; an id → set it (validated to the department's own company). Fetch the
    // department's company for the cross-company guard when a non-empty id is supplied.
    const setValues: { name: string; businessUnitId?: string | null } = { name };
    if (p.businessUnitId !== undefined) {
      const [dep] = await tx
        .select({ companyId: department.companyId })
        .from(department)
        .where(eq(department.id, p.id))
        .limit(1);
      if (!dep) throw new Error('Department not found');
      setValues.businessUnitId = await resolveDepartmentBusinessUnitId(tx, p.businessUnitId, dep.companyId);
    }
    await tx.update(department).set(setValues).where(eq(department.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError(`A department named “${name}” already exists in this company.`);
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'department', aggregateId: p.id, eventType: 'department.updated', actor: actorOf(ctx), payload: setValues });
  });
}
export function archiveDepartment(ctx: SessionContext, p: { id: string; archived: boolean }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(department).set({ archivedAt: p.archived ? sql`now()` : null }).where(eq(department.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError('An active department with this name already exists — rename it before unarchiving.');
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'department', aggregateId: p.id, eventType: p.archived ? 'department.archived' : 'department.unarchived', actor: actorOf(ctx), payload: {} });
  });
}
export async function deleteDepartment(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    const [u] = await tx.select({ n: sql<number>`count(*)::int` }).from(assignment).where(eq(assignment.departmentId, p.id));
    if ((u?.n ?? 0) > 0) throw new InUseError('department');
    await tx.delete(department).where(eq(department.id, p.id));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'department', aggregateId: p.id, eventType: 'department.deleted', actor: actorOf(ctx), payload: {} });
  });
}

export async function updatePosition(ctx: SessionContext, p: { id: string; title: string; jobFamily?: string }) {
  const title = cleanName(p.title, 'Position title');
  return withTenant(ctx, async (tx) => {
    await tx.update(position).set({ title, jobFamily: p.jobFamily?.trim() || null }).where(eq(position.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError(`A position titled “${title}” already exists in this company.`);
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'position', aggregateId: p.id, eventType: 'position.updated', actor: actorOf(ctx), payload: { title } });
  });
}
export function archivePosition(ctx: SessionContext, p: { id: string; archived: boolean }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(position).set({ archivedAt: p.archived ? sql`now()` : null }).where(eq(position.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError('An active position with this title already exists — rename it before unarchiving.');
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'position', aggregateId: p.id, eventType: p.archived ? 'position.archived' : 'position.unarchived', actor: actorOf(ctx), payload: {} });
  });
}
export async function deletePosition(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    const [u] = await tx.select({ n: sql<number>`count(*)::int` }).from(assignment).where(eq(assignment.positionId, p.id));
    if ((u?.n ?? 0) > 0) throw new InUseError('position');
    await tx.delete(position).where(eq(position.id, p.id));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'position', aggregateId: p.id, eventType: 'position.deleted', actor: actorOf(ctx), payload: {} });
  });
}

export async function updateCostCenter(ctx: SessionContext, p: { id: string; code: string; name: string }) {
  const code = cleanName(p.code, 'Cost-center code');
  const name = cleanName(p.name, 'Cost-center name');
  return withTenant(ctx, async (tx) => {
    await tx.update(costCenter).set({ code, name }).where(eq(costCenter.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError(`A cost center with code “${code}” already exists in this company.`);
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'cost-center', aggregateId: p.id, eventType: 'cost-center.updated', actor: actorOf(ctx), payload: { code } });
  });
}
export function archiveCostCenter(ctx: SessionContext, p: { id: string; archived: boolean }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(costCenter).set({ archivedAt: p.archived ? sql`now()` : null }).where(eq(costCenter.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError('An active cost center with this code already exists — change it before unarchiving.');
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'cost-center', aggregateId: p.id, eventType: p.archived ? 'cost-center.archived' : 'cost-center.unarchived', actor: actorOf(ctx), payload: {} });
  });
}
export async function deleteCostCenter(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    const [u] = await tx.select({ n: sql<number>`count(*)::int` }).from(assignment).where(eq(assignment.costCenterId, p.id));
    if ((u?.n ?? 0) > 0) throw new InUseError('cost center');
    await tx.delete(costCenter).where(eq(costCenter.id, p.id));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'cost-center', aggregateId: p.id, eventType: 'cost-center.deleted', actor: actorOf(ctx), payload: {} });
  });
}

export async function updateBusinessUnit(ctx: SessionContext, p: { id: string; code: string; name: string }) {
  const code = cleanName(p.code, 'Business-unit code');
  const name = cleanName(p.name, 'Business-unit name');
  return withTenant(ctx, async (tx) => {
    await tx.update(businessUnit).set({ code, name }).where(eq(businessUnit.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError(`A business unit with code “${code}” already exists in this company.`);
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'business-unit', aggregateId: p.id, eventType: 'business-unit.updated', actor: actorOf(ctx), payload: { code } });
  });
}
export function archiveBusinessUnit(ctx: SessionContext, p: { id: string; archived: boolean }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(businessUnit).set({ archivedAt: p.archived ? sql`now()` : null }).where(eq(businessUnit.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError('An active business unit with this code already exists — change it before unarchiving.');
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'business-unit', aggregateId: p.id, eventType: p.archived ? 'business-unit.archived' : 'business-unit.unarchived', actor: actorOf(ctx), payload: {} });
  });
}

/**
 * Update a leave type's name and (optionally) its eligibility rule (#25 visibility).
 * `eligibility` is tri-state: omit it for a name-only rename (the column is left untouched, so a
 * rename never wipes an existing rule — a real data-loss guard, since the 2A-1 seed rows carry rules);
 * pass null / all-blank to reopen the type to everyone; pass a populated object to restrict it.
 * Records who restricted a type via a before/after event (substrate discipline) — hence the
 * read-before-write SELECT inside the tx.
 */
/** ADR-0048: normalise the allowed-durations allow-list. undefined ⇒ untouched; an array is filtered to
 *  the known set; empty or full-day-only ⇒ null (full-day-only, the clean default). */
function cleanDurations(d: LeaveDurationType[] | null | undefined): LeaveDurationType[] | null | undefined {
  if (d === undefined) return undefined;
  if (d == null) return null;
  const set = new Set(d.filter((x): x is LeaveDurationType => LEAVE_DURATION_TYPES.includes(x)));
  set.delete('full_day'); // full_day is always available; storing only it is the same as null
  return set.size === 0 ? null : [...set];
}

/** Supporting-document config: the closed set of mime types an admin may allow. No generic ceiling. */
const DOC_MIME_SET = ['application/pdf', 'image/jpeg', 'image/png'] as const;
const MAX_DOC_BYTES_CEILING = 10 * 1024 * 1024; // the feedback fixes the max at 10 MB

export async function updateLeaveType(
  ctx: SessionContext,
  p: {
    id: string;
    name: string;
    eligibility?: LeaveEligibility | null;
    durations?: LeaveDurationType[] | null;
    // Supporting-document config (claims-style flat signature; each is tri-state — undefined = leave column).
    requiresDocument?: boolean;
    mandatoryAfterDays?: number | null;
    allowedMimeTypes?: string[];
    maxDocBytes?: number;
    employeeRemarkRequired?: boolean;
    hrRemarkRequired?: boolean; // stored only this slice; not enforced
    sendToPayroll?: boolean; // unpaid payroll-impact gate (tri-state, like the doc fields); gates the on-approval signal only
    // Configurable backdated-leave restriction (0133): how many days back a leave of this type may be applied.
    // OWN tri-state (undefined = leave column), NOT nested under touchDoc — it is a request-validation rule,
    // not a document setting, so a doc-only save must not touch it and the audit diff must label it correctly.
    backdatingLimitDays?: number | null;
  },
) {
  const name = cleanName(p.name, 'Leave-type name');
  const touchEligibility = p.eligibility !== undefined;
  const nextEligibility = touchEligibility ? cleanEligibility(p.eligibility) : undefined;
  const touchDurations = p.durations !== undefined;
  const nextDurations = cleanDurations(p.durations);

  // Doc-config validation (kept minimal — the fields are a fixed, closed set).
  const touchDoc =
    p.requiresDocument !== undefined ||
    p.mandatoryAfterDays !== undefined ||
    p.allowedMimeTypes !== undefined ||
    p.maxDocBytes !== undefined ||
    p.employeeRemarkRequired !== undefined ||
    p.hrRemarkRequired !== undefined;
  // Unpaid payroll-impact gate — its OWN tri-state, NOT nested in touchDoc: a payroll-only save carries no
  // document marker, so touchDoc is false; nesting would drop the flag from the set + event diff.
  const touchPayroll = p.sendToPayroll !== undefined;
  // Configurable backdated-leave restriction (0133): its OWN tri-state, mirroring touchPayroll above — a
  // doc-only save carries no backdating marker, so nesting it under touchDoc would drop it from the set and
  // mislabel the audit diff.
  const touchBackdating = p.backdatingLimitDays !== undefined;
  if (p.mandatoryAfterDays != null && (!Number.isInteger(p.mandatoryAfterDays) || p.mandatoryAfterDays < 0)) {
    throw new Error('“Required after more than N days” must be a whole number ≥ 0.');
  }
  if (p.backdatingLimitDays != null && (!Number.isInteger(p.backdatingLimitDays) || p.backdatingLimitDays < 0)) {
    throw new Error('“Backdating limit (days)” must be a whole number ≥ 0.');
  }
  if (p.allowedMimeTypes !== undefined && p.allowedMimeTypes.some((m) => !DOC_MIME_SET.includes(m as (typeof DOC_MIME_SET)[number]))) {
    throw new Error('Allowed file types must be a subset of PDF, JPG, PNG.');
  }
  if (p.maxDocBytes !== undefined && (!(p.maxDocBytes > 0) || p.maxDocBytes > MAX_DOC_BYTES_CEILING)) {
    throw new Error('Max file size must be between 0 and 10 MB.');
  }

  const docSet = {
    ...(p.requiresDocument !== undefined ? { requiresDocument: p.requiresDocument } : {}),
    ...(p.mandatoryAfterDays !== undefined ? { mandatoryAfterDays: p.mandatoryAfterDays } : {}),
    ...(p.allowedMimeTypes !== undefined ? { allowedMimeTypes: p.allowedMimeTypes } : {}),
    ...(p.maxDocBytes !== undefined ? { maxDocBytes: p.maxDocBytes } : {}),
    ...(p.employeeRemarkRequired !== undefined ? { employeeRemarkRequired: p.employeeRemarkRequired } : {}),
    ...(p.hrRemarkRequired !== undefined ? { hrRemarkRequired: p.hrRemarkRequired } : {}),
  };
  // Configurable backdated-leave restriction (0133): its own set fragment, merged alongside docSet.
  const backdatingSet = touchBackdating ? { backdatingLimitDays: p.backdatingLimitDays } : {};

  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        name: leaveType.name,
        eligibility: leaveType.eligibility,
        durations: leaveType.durations,
        requiresDocument: leaveType.requiresDocument,
        mandatoryAfterDays: leaveType.mandatoryAfterDays,
        allowedMimeTypes: leaveType.allowedMimeTypes,
        maxDocBytes: leaveType.maxDocBytes,
        employeeRemarkRequired: leaveType.employeeRemarkRequired,
        hrRemarkRequired: leaveType.hrRemarkRequired,
        sendToPayroll: leaveType.sendToPayroll,
        backdatingLimitDays: leaveType.backdatingLimitDays,
      })
      .from(leaveType)
      .where(eq(leaveType.id, p.id))
      .limit(1);
    await tx
      .update(leaveType)
      .set({
        name,
        ...(touchEligibility ? { eligibility: nextEligibility } : {}),
        ...(touchDurations ? { durations: nextDurations } : {}),
        ...docSet,
        ...backdatingSet,
        ...(touchPayroll ? { sendToPayroll: p.sendToPayroll } : {}),
      })
      .where(eq(leaveType.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-type',
      aggregateId: p.id,
      eventType: 'leave-type.updated',
      actor: actorOf(ctx),
      payload: {
        before: {
          name: before?.name ?? null,
          eligibility: before?.eligibility ?? null,
          durations: before?.durations ?? null,
          ...(touchDoc
            ? {
                requiresDocument: before?.requiresDocument ?? null,
                mandatoryAfterDays: before?.mandatoryAfterDays ?? null,
                allowedMimeTypes: before?.allowedMimeTypes ?? null,
                maxDocBytes: before?.maxDocBytes ?? null,
                employeeRemarkRequired: before?.employeeRemarkRequired ?? null,
                hrRemarkRequired: before?.hrRemarkRequired ?? null,
              }
            : {}),
          ...(touchPayroll ? { sendToPayroll: before?.sendToPayroll ?? null } : {}),
          ...(touchBackdating ? { backdatingLimitDays: before?.backdatingLimitDays ?? null } : {}),
        },
        after: {
          name,
          eligibility: touchEligibility ? nextEligibility : (before?.eligibility ?? null),
          durations: touchDurations ? nextDurations : (before?.durations ?? null),
          ...(touchDoc
            ? {
                requiresDocument: p.requiresDocument ?? before?.requiresDocument ?? null,
                mandatoryAfterDays: p.mandatoryAfterDays !== undefined ? p.mandatoryAfterDays : (before?.mandatoryAfterDays ?? null),
                allowedMimeTypes: p.allowedMimeTypes !== undefined ? p.allowedMimeTypes : (before?.allowedMimeTypes ?? null),
                maxDocBytes: p.maxDocBytes !== undefined ? p.maxDocBytes : (before?.maxDocBytes ?? null),
                employeeRemarkRequired: p.employeeRemarkRequired ?? before?.employeeRemarkRequired ?? null,
                hrRemarkRequired: p.hrRemarkRequired ?? before?.hrRemarkRequired ?? null,
              }
            : {}),
          ...(touchPayroll ? { sendToPayroll: p.sendToPayroll ?? before?.sendToPayroll ?? null } : {}),
          ...(touchBackdating
            ? { backdatingLimitDays: p.backdatingLimitDays !== undefined ? p.backdatingLimitDays : (before?.backdatingLimitDays ?? null) }
            : {}),
        },
      },
    });
  });
}
export function archiveLeaveType(ctx: SessionContext, p: { id: string; archived: boolean }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(leaveType).set({ archivedAt: p.archived ? sql`now()` : null }).where(eq(leaveType.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError('An active leave type with this code already exists — it cannot be unarchived.');
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'leave-type', aggregateId: p.id, eventType: p.archived ? 'leave-type.archived' : 'leave-type.unarchived', actor: actorOf(ctx), payload: {} });
  });
}
export async function deleteLeaveType(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select({ n: sql<number>`count(*)::int` }).from(leaveRequest).where(eq(leaveRequest.leaveTypeId, p.id));
    const [led] = await tx.select({ n: sql<number>`count(*)::int` }).from(leaveLedger).where(eq(leaveLedger.leaveTypeId, p.id));
    const [pol] = await tx.select({ n: sql<number>`count(*)::int` }).from(leavePolicy).where(eq(leavePolicy.leaveTypeId, p.id));
    if ((req?.n ?? 0) + (led?.n ?? 0) + (pol?.n ?? 0) > 0) throw new InUseError('leave type');
    await tx.delete(leaveType).where(eq(leaveType.id, p.id));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'leave-type', aggregateId: p.id, eventType: 'leave-type.deleted', actor: actorOf(ctx), payload: {} });
  });
}

export async function updateCompany(
  ctx: SessionContext,
  p: { id: string; legalName: string; registrationNo?: string; country?: string; currency?: string },
) {
  const legalName = cleanName(p.legalName, 'Legal name');
  const country = isoCode(p.country, 'MY', 'Country');
  const currency = isoCode(p.currency, 'MYR', 'Currency');
  return withTenant(ctx, async (tx) => {
    await tx
      .update(company)
      .set({ legalName, registrationNo: p.registrationNo?.trim() || null, country, currency })
      .where(eq(company.id, p.id));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'company', aggregateId: p.id, eventType: 'company.updated', actor: actorOf(ctx), payload: { legalName: p.legalName } });
  });
}
/** ADR-0040 2D-2: set a company's earned-accrual cycle ('calendar' | 'anniversary'). RLS (the company
 *  update policy) already requires admin-for-company, same as updateCompany. */
export async function setCompanyLeaveCycle(ctx: SessionContext, p: { companyId: string; cycle: string }) {
  const cycle = p.cycle === 'anniversary' ? 'anniversary' : 'calendar';
  return withTenant(ctx, async (tx) => {
    await tx.update(company).set({ leaveCycle: cycle }).where(eq(company.id, p.companyId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.companyId,
      eventType: 'company.leave-cycle.set',
      actor: actorOf(ctx),
      payload: { cycle },
    });
  });
}
/** Feedback request 31474452: set a company's half-day leave-deduction toggle. OFF (default): leave on a
 *  "Half Day" work-schedule day (attendance_policy.half_working_days) deducts 0.5 day. ON: it deducts 1.0
 *  day. RLS (the company update policy) already requires admin-for-company, same as updateCompany. Frozen at
 *  submission (D6) — flipping this does not recompute already-submitted/approved leave. */
export async function setLeaveHalfDayFullDeduction(ctx: SessionContext, p: { companyId: string; enabled: boolean }) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ enabled: company.leaveHalfDayFullDeduction })
      .from(company)
      .where(eq(company.id, p.companyId))
      .limit(1);
    await tx.update(company).set({ leaveHalfDayFullDeduction: p.enabled }).where(eq(company.id, p.companyId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.companyId,
      eventType: 'company.leave-half-day-deduction.changed',
      actor: actorOf(ctx),
      payload: { before: before?.enabled ?? false, after: p.enabled },
    });
  });
}
export function archiveCompany(ctx: SessionContext, p: { id: string; archived: boolean }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(company).set({ archivedAt: p.archived ? sql`now()` : null }).where(eq(company.id, p.id));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'company', aggregateId: p.id, eventType: p.archived ? 'company.archived' : 'company.unarchived', actor: actorOf(ctx), payload: {} });
  });
}
export async function deleteCompany(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    const [dep] = await tx.select({ n: sql<number>`count(*)::int` }).from(department).where(eq(department.companyId, p.id));
    const [emp] = await tx.select({ n: sql<number>`count(*)::int` }).from(employment).where(eq(employment.companyId, p.id));
    const [sub] = await tx.select({ n: sql<number>`count(*)::int` }).from(company).where(eq(company.parentCompanyId, p.id));
    if ((dep?.n ?? 0) + (emp?.n ?? 0) + (sub?.n ?? 0) > 0) throw new InUseError('company');
    await tx.delete(company).where(eq(company.id, p.id));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'company', aggregateId: p.id, eventType: 'company.deleted', actor: actorOf(ctx), payload: {} });
  });
}
