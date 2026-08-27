/**
 * Admin / setup services — org structure, leave config, and role management.
 * Each mutation runs via withTenant and appends a domain event (substrate discipline,
 * ADR-0006). RLS (migration 0002) requires an admin role for these writes.
 */
import { and, desc, eq, getTableName, inArray, isNotNull, isNull, or, sql, type AnyColumn } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
// ADR-0077 slice 5 — the per-company install hook (see createCompany).
import { companyInstallersFor } from './module-activation';
import { CrossCompanyError } from './org';
import { isEssViewComponentKey, type EssViewConfig } from './ess-view';
import { normalizeLeaveFormulaConfig, type LeaveFormulaConfig } from './leave-formula';
import { isLeaveColorToken, isLeaveIconKey } from '@/lib/leave-visual';
import { isCurrencyCode } from '../lib/currencies';
import { visibleLabelIdsCondition } from './system-labels';
// 1ae7f3ab + 4fdb69b2 — the ONE declaration of what references a leave type, shared with
// listLeaveTypes' inUse predicate. Two hand-written lists are what drifted into the reported bug.
//
// This REPLACED an import of countTemplatesForLeaveType / countEligibilityRulesForLeaveType from
// ./entitlement-template, which 6e9a126e added here for deleteLeaveType's guard. Those two counters are
// still exported and still used by their own tests; deleteLeaveType no longer calls them because the
// entitlement layer is now declared like every other referrer rather than special-cased in the guard.
import { configReferrers, historyReferrers } from './leave-type-refs';
import { isLoginBlocked } from './employment-status';
import {
  isValidMonthDay,
  // 6e9a126e — the write-time band validator, moved into the pure module (beside `isWellFormedBands`, the
  // defensive resolver whose ceiling it must match) so the three writers — leave_policy here, and
  // entitlement_template's create and update — share ONE definition. `isWellFormedBands` and
  // `MAX_SERVICE_BANDS` left this file's import list with it: they were only ever used INSIDE the
  // validator, and an unused import of the constant is how a second literal creeps back in.
  validateServiceBands,
  LEAVE_DURATION_TYPES,
  todayInKualaLumpur,
  STATUTORY_APPLY_CODES,
  // Edit Leave Type Code (a7194511): EMERGENCY joins the statutory codes as a LOCKED code — its literal
  // is the semantic key the leave engine splits emergency leave on, so it must never be renamed.
  // 65f466e2: the codes are now only the FALLBACK for an unclassified row; the roles below are the real
  // test, because a tenant's statutory types are rarely coded the way the pack seeds them.
  EMERGENCY_LEAVE_CODE,
  STATUTORY_APPLY_ROLES,
  isStatutoryApplyType,
  type AccrualConfig,
  type DayTypeInclusion,
  type LeaveDurationType,
  type LeaveEligibility,
  type ProbationEligibility,
  PROBATION_ELIGIBILITY_VALUES,
  // Leave Year Type override (e1a51aea, extended by f3a64d90): the closed { a2a, c2c, a2c } live-value set
  // for year_cycle_override, plus the a2c first-year correction fired when the override moves to/from a2c.
  LEAVE_YEAR_CYCLE_OVERRIDES,
  A2C_OVERRIDE,
  reprojectA2cEntitlement,
  type LeaveYearCycleOverride,
  // Feedback b81d3c52 — the Rounding Method value set persisted on `leave_policy.accrual`.
  type LeaveRoundingMethod,
  // 8fec719e — the TWO methods an administrator may now choose, plus the single authority on what is wrong
  // with a custom rounding table. `roundingBandErrors` is the same function the editor draws its live
  // warnings from, so a table the screen calls valid can never be refused here for a reason it did not show.
  isUserRoundingMethod,
  roundingBandErrors,
  type RoundingBand,
  // 8fec719e — the same engagement test applyLeaveTypeRules uses, so the writer can refuse to leave a type
  // "unruled" by a rounding change (see the guard in setLeaveTypeRules).
  hasAnyLeaveTypeRule,
  // ad9cb5c5 — the closed period vocabulary for max_days_period, shared with the enforcement side so the
  // write-time validator and the resolver cannot drift on what a savable period is (the isUserRoundingMethod
  // precedent immediately above).
  APPLICATION_LIMIT_PERIODS,
  type ApplicationLimitPeriod,
  type ServiceBand,
} from './leave';
// Override Leave Application (56910869): the write validator reads the SAME vocabulary the engine acts on,
// so a rule that saves is exactly a rule that fires.
import {
  normalizeLeaveOverrideRules,
  validateLeaveOverrideRules,
  type LeaveOverrideRule,
} from './leave-override';
import { countryPacks, packFor } from '../localization/registry';
import { NON_STATUTORY, resolveCompanyTier } from './company-tier';
import { statesForCountries } from './state-vocabulary';
import { ORG_ASSIGNMENT_CRITERIA } from './leave-org-criteria';
import { MARITAL_STATUSES } from './profile';
import {
  appUser,
  assignment,
  businessUnit,
  company,
  companyLogo,
  costCenter,
  department,
  domainEvent,
  employment,
  holiday,
  holidayGroup,
  holidayGroupHoliday,
  leaveLedger,
  jobGrade,
  leaveRequest,
  leaveType,
  location,
  payrollCycle,
  person,
  position,
  roleAssignment,
  tenantModule,
} from '../db/schema';
// Organization Module — Automatic Payroll Cycle Assignment (361e3b15): the admin Add-company path now seeds
// the standard cycle catalog (the seed the account-setup / provisioning paths already run) so a company is
// payroll-ready the moment it is created, and stores its default cycle by name. Imported through the pack
// FACADE, not `./payroll-cycle` directly (ADR-0080 D9, test/payroll-pack-drift.test.ts): this is a new
// cross-module consumer, and the ratchet allowlist only ever shrinks.
import { DEFAULT_PAYROLL_CYCLES, seedPayrollCycleCatalog } from '../packs/payroll/service';

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

/** 66b8f5a8 — Holiday master `holiday_type` (migration 0190): a display/classification tag on the
 *  centralized holiday record. Public = gazetted public holiday (DEFAULT — existing rows), Company = an
 *  employer-declared day, Optional = a day staff may opt into. The resolver never reads it; it is metadata
 *  only, so it never affects working-day / OT arithmetic. */
export const HOLIDAY_TYPES = ['public', 'company', 'optional'] as const;
export type HolidayType = (typeof HOLIDAY_TYPES)[number];
function cleanHolidayType(v: string | undefined): HolidayType {
  const s = (v ?? 'public').trim();
  if (!(HOLIDAY_TYPES as readonly string[]).includes(s)) throw new Error(`Unknown holiday type “${s}”.`);
  return s as HolidayType;
}

/** Thrown when a hard delete is attempted on a referenced record (archive it instead). Pass `message`
 *  to override the default "archive it instead" sentence with a record-specific one. */
export class InUseError extends Error {
  constructor(what: string, message?: string) {
    super(message ?? `This ${what} is in use — archive it instead of deleting.`);
    this.name = 'InUseError';
  }
}

/** A rule value the operator supplied is outside what the engine (and the 0325 CHECK constraints) accept.
 *  Separate from DuplicateError so the caller can distinguish "you typed something impossible" from
 *  "that name is taken" — and so a constraint violation never reaches the operator as an opaque 23514. */
export class LeaveTypeRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaveTypeRuleError';
  }
}

export class DuplicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateError';
  }
}

/**
 * r224 — the grade code being created is ALREADY HELD BY AN ARCHIVED GRADE.
 *
 * Deliberately NOT a DuplicateError: a duplicate is a dead end ("pick another code"), whereas this one has
 * a correct answer the operator can take — restore the grade that is already there. It therefore carries
 * `archivedId`, so the caller can OFFER that restore rather than just refusing. `job_grade_code_uq` is a
 * PARTIAL index (`WHERE archived_at IS NULL`), so nothing in the database raises 23505 here: without this
 * class the insert simply succeeds and the tenant ends up with two grades sharing one code, which is the
 * duplicate historical record the reporter asked us to prevent.
 */
export class ArchivedGradeCodeError extends Error {
  constructor(
    message: string,
    readonly archivedId: string,
  ) {
    super(message);
    this.name = 'ArchivedGradeCodeError';
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

/** The constraint/index name behind a 23505 unique violation (walks the same cause chain), so a caller
 *  with more than one unique index on a table (e.g. job_grade code + name) can map each to the right
 *  friendly message. */
function uniqueViolationConstraint(e: unknown): string | undefined {
  let cur = e as { code?: string; constraint?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return cur.constraint;
    cur = cur.cause as { code?: string; constraint?: string; cause?: unknown } | null | undefined;
  }
  return undefined;
}

/** Trim + collapse internal whitespace; the 0030 indexes are case-insensitive on the result. */
function cleanName(v: string | undefined, label: string): string {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error(`${label} is required`);
  return s;
}

/** 4ec5a940 — the reporter's "Why the change was made" audit column. An OPTIONAL free-text note the admin
 *  may attach to a leave-config change; it is recorded on the DomainEvent payload only (never persisted to
 *  the aggregate row) and rendered by `describePayload`'s `reason` branch. Returns `undefined` for a
 *  blank/whitespace value so the payload key is simply omitted (no empty `reason:` line in the audit UI).
 *  Capped at 500 chars — long enough for a real justification, short enough to keep rows scannable. It is
 *  tenant free-text, not personal/financial data, so it is PDPA-safe to store in cleartext (ADR-0030
 *  Layer-0) — the key name also never collides with the banned-key guard. */
export const REASON_MAX_LEN = 500;
export function normalizeReason(v: string | null | undefined): string | undefined {
  if (v == null) return undefined;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > REASON_MAX_LEN ? s.slice(0, REASON_MAX_LEN) : s;
}

/**
 * Normalise + validate a leave-type eligibility rule (#25 visibility). Tri-state by the caller:
 *   undefined → caller leaves the column untouched (a name-only rename must NOT clobber a rule);
 *   null / all-blank → returns null (open to all);
 *   populated → returns a sanitised object built from only the three known fields.
 * Because requestLeave reads whatever JSONB is stored, validation lives in core (not just the action):
 * a malformed POST can't land arbitrary JSONB or an out-of-range value. Throws on bad input.
 */
// Allow-lists for the two multi-select eligibility criteria (#badc5966). The gender list matches the master
// person.gender values that this gate supports (male|female — 'undisclosed' is never a rule value, see
// eligibilityUndisclosedNote). The marital list is the shared master enum (core/profile.ts MARITAL_STATUSES,
// #12129e77) so a rule value and a profile value are provably drawn from the same list — the "centralized
// marital status master list" the item asks for. Adding a value there (divorced/widowed/separated) makes it a
// rule option AND a reachable profile value in one edit.
export const ELIGIBILITY_GENDER_OPTIONS = ['male', 'female'] as const;
export const ELIGIBILITY_MARITAL_OPTIONS = MARITAL_STATUSES;

/** Normalize a scalar-or-array eligibility field to a de-duped, blank-stripped, validated list. Accepts a
 *  legacy scalar (single-select rows / in-flight event payloads) or a multi-select array. Empty ⇒ undefined
 *  (the field carries no restriction). Throws on any value outside `allowed`. */
function cleanEligList(
  v: string | string[] | null | undefined,
  allowed: readonly string[],
  label: string,
): string[] | undefined {
  const arr = (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim()).filter((x) => x !== '');
  const deduped = [...new Set(arr)];
  for (const x of deduped) {
    if (!allowed.includes(x)) throw new Error(`Eligibility ${label} must be one of: ${allowed.join(', ')}`);
  }
  return deduped.length > 0 ? deduped : undefined;
}

/** Normalize an org-assignment eligibility field to a de-duped, blank-stripped list WITHOUT catalogue
 *  validation. Unlike cleanEligList, the stored values are NOT allow-listed against the profile_option catalogue:
 *  the picker limits NEW picks to active values, but a value later deactivated/removed must still re-save cleanly
 *  (legacy tolerance — the same rule assertProfileValueAllowed applies on the profile side). Empty ⇒ undefined
 *  (the field carries no restriction). */
function cleanOrgEligList(v: string | string[] | null | undefined): string[] | undefined {
  const arr = (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim()).filter((x) => x !== '');
  const deduped = [...new Set(arr)];
  return deduped.length > 0 ? deduped : undefined;
}

function cleanEligibility(e: LeaveEligibility | null | undefined): LeaveEligibility | null {
  if (e == null) return null;
  const out: LeaveEligibility = {};
  const gender = cleanEligList(e.gender, ELIGIBILITY_GENDER_OPTIONS, 'gender');
  if (gender) out.gender = gender;
  const maritalStatus = cleanEligList(e.maritalStatus, ELIGIBILITY_MARITAL_OPTIONS, 'marital status');
  if (maritalStatus) out.maritalStatus = maritalStatus;
  // Organisation Assignment criteria: one de-duped list per org field, no catalogue hard-validation (legacy
  // tolerance). Absent/empty ⇒ key omitted, so the field carries no restriction. Iterating the single
  // descriptor keeps this in lock-step with the gates + the UI.
  for (const c of ORG_ASSIGNMENT_CRITERIA) {
    const list = cleanOrgEligList(e[c.key]);
    if (list) out[c.key] = list;
  }
  if (e.minServiceMonths != null && (e.minServiceMonths as unknown) !== '') {
    const n = Number(e.minServiceMonths);
    if (!Number.isInteger(n) || n < 0) throw new Error('Minimum service duration must be a non-negative whole number');
    if (n > 0) {
      out.minServiceMonths = n; // 0 = no service floor → omit so the stored object stays minimal
      // Min-service unit (#f88f0a63): validate against the closed set (mirror the expiry-unit gate). Absent ⇒
      // 'months' (legacy compat — a pre-unit row and a new months row store the identical value). Only persist
      // the unit alongside a surviving positive value: a lone unit with no/zero value is never stored, so a
      // legacy row re-saved without a value can never invent a unit — the load-bearing backward-compat rule.
      const rawUnit = e.minServiceUnit == null || (e.minServiceUnit as unknown) === '' ? 'months' : e.minServiceUnit;
      if (rawUnit !== 'months' && rawUnit !== 'days') throw new Error('Minimum service unit must be months or days');
      out.minServiceUnit = rawUnit;
    }
  }
  // All fields blank ⇒ open to all.
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

/**
 * The company's ISO-4217 currency. r79a (4fb8b75a step 3): `company.currency` absorbed
 * company_payroll_config.default_currency, so this field went from inert master data to the value the
 * Basic Salary form preselects. It therefore has to be validated as strictly as the field it replaced —
 * against the real lib/currencies.ts master, not merely "three letters", which would have let 'ZZZ'
 * through onto a salary form. Blank ⇒ 'MYR' (the column default); a non-ISO code is REJECTED rather than
 * clamped, matching the rest of core/admin.ts (throw-not-clamp) and surfacing as a form error.
 */
function currencyCode(v: string | undefined): string {
  const s = (v || 'MYR').trim().toUpperCase();
  if (!isCurrencyCode(s)) throw new Error(`Currency must be a valid ISO 4217 code (e.g. MYR), not “${s}”`);
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

/** Resolve a create-form Default Payroll Cycle name to a canonical DEFAULT_PAYROLL_CYCLES name. The picker
 *  only ever offers the six seeded names, so an unknown/blank value falls back to 'Monthly' (the column
 *  default) — never a name that isn't in the freshly-seeded catalog. Case-insensitive match. */
function resolveDefaultCycleName(v: string | undefined): string {
  const s = (v ?? '').trim();
  const match = DEFAULT_PAYROLL_CYCLES.find((c) => c.name.toLowerCase() === s.toLowerCase());
  return match ? match.name : 'Monthly';
}

export async function createCompany(
  ctx: SessionContext,
  p: {
    legalName: string;
    country?: string;
    currency?: string;
    registrationNo?: string;
    defaultPayrollCycle?: string;
    /**
     * ADR-0080 D-14 — declare this company NON-STATUTORY. Required (and only accepted) when the
     * country has no registered pack. Never inferred, so a mis-keyed ISO code cannot become a tier.
     */
    nonStatutory?: boolean;
  },
) {
  const legalName = cleanName(p.legalName, 'Legal name');
  const country = isoCode(p.country, 'MY', 'Country');
  // ADR-0080 D-14 — F7's blanket refusal is REPLACED by the two-tier model it always pointed at.
  //
  // The old guard called requirePackFor(country) and refused any packless country outright, because
  // isoCode is a SHAPE check ('ZZ' and 'XX' pass) and a packless company fails SILENT on leave. That
  // silence is now reported (r103's packBlocked), and refusing onboarding is the wrong permanent
  // answer: a customer with a Thai plant either cannot onboard it, or misfiles Thai staff under the
  // Malaysian company to get past the refusal — silently applying MY rules to foreign employees.
  //
  // resolveCompanyTier keeps the refusal for an UNDECLARED packless country (identical outcome to
  // before, with a stated way through) and adds the declared non-statutory tier. It also refuses the
  // opposite mistake: declaring non-statutory where a pack DOES exist.
  const statutoryTier = resolveCompanyTier(country, p.nonStatutory === true);
  const currency = currencyCode(p.currency);
  // Organization Module (361e3b15): the chosen default, resolved against the standard catalog we are about to
  // seed. Defaults to 'Monthly' (the column default) so the common case is a single accept-and-move-on step.
  const defaultPayrollCycle = resolveDefaultCycleName(p.defaultPayrollCycle);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(company)
      .values({
        tenantId: ctx.tenantId,
        legalName,
        country,
        currency,
        statutoryTier,
        registrationNo: p.registrationNo?.trim() || null,
        defaultPayrollCycle,
      })
      .returning({ id: company.id });
    // Organization Module (361e3b15) — the actual pain fix: seed the six standard payroll cycles inside THIS
    // transaction (tx-injection, the provisionTenant/seedCompanyCatalogs precedent) so a company added via the
    // admin form is payroll-ready immediately, exactly like the account-setup / provisioning paths already are.
    await seedPayrollCycleCatalog(ctx, row.id, tx);
    // ADR-0077 slice 5 — THE PER-COMPANY INSTALL HOOK. Every module the tenant already has active gets
    // its per-company defaults for this new company, in THIS transaction.
    //
    // Without it, company #2 is born missing the defaults company #1 received when the module was
    // activated — a TOIL module bought last month simply has no policy row here, so its config screen is
    // empty and nothing accrues. That failure is invisible at creation time and surfaces weeks later as
    // "TOIL doesn't work for the new company", with nothing connecting it to the purchase.
    //
    // Tenant-WIDE grants only (`company_id IS NULL`): a grant already scoped to one company is, by
    // definition, not about this one. The tenant-level pass is NOT run here — `tenant_setting` was
    // seeded once when the module was activated and is not per company.
    const activeModules = await tx
      .select({ code: tenantModule.moduleCode })
      .from(tenantModule)
      .where(
        and(
          eq(tenantModule.tenantId, ctx.tenantId),
          isNull(tenantModule.companyId),
          inArray(tenantModule.status, ['active', 'trial']),
        ),
      );
    const installed: string[] = [];
    for (const m of activeModules) {
      for (const install of companyInstallersFor(m.code)) {
        const outcome = await install({ tx, tenantId: ctx.tenantId, companyId: row.id });
        if (outcome.seeded > 0) installed.push(m.code);
      }
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: row.id,
      eventType: 'company.created',
      actor: actorOf(ctx),
      // `modulesInstalled` recorded on the event so "why does the new company have a TOIL policy?" is
      // answerable from the audit log rather than by reading this function.
      payload: { legalName: p.legalName, country: p.country || 'MY', defaultPayrollCycle, modulesInstalled: installed },
    });
    return row;
  });
}

/**
 * Organization Module — Automatic Payroll Cycle Assignment (361e3b15). Change a company's default payroll
 * cycle later, from the company's General settings. Reads the prior value, validates the new name resolves to
 * an ACTIVE cycle in THAT company's own catalog (rejecting unknown/archived names — no silent invalid save),
 * writes it, then appends `company.default-payroll-cycle.set` with a before→after payload (the
 * setLeaveHalfDayFullDeduction audit precedent). Future-only by construction: batches snapshot their run
 * type at creation and store no cycle id, so changing the default never touches a completed run. RLS (the
 * company update policy) already requires admin-for-company, same as updateCompany.
 */
export async function setCompanyDefaultPayrollCycle(
  ctx: SessionContext,
  p: { companyId: string; cycleName: string },
) {
  const cycleName = (p.cycleName ?? '').replace(/\s+/g, ' ').trim();
  if (!cycleName) throw new Error('Choose a payroll cycle.');
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ defaultPayrollCycle: company.defaultPayrollCycle })
      .from(company)
      .where(eq(company.id, p.companyId))
      .limit(1);
    // Validate against THIS company's ACTIVE catalog (name match, case-insensitive) — an unknown or archived
    // name is rejected rather than saved, so the stored default always points at a usable cycle.
    const [match] = await tx
      .select({ name: payrollCycle.name })
      .from(payrollCycle)
      .where(
        and(
          eq(payrollCycle.companyId, p.companyId),
          isNull(payrollCycle.archivedAt),
          sql`lower(${payrollCycle.name}) = lower(${cycleName})`,
        ),
      )
      .limit(1);
    if (!match) throw new Error(`“${cycleName}” is not an active payroll cycle for this company.`);
    await tx.update(company).set({ defaultPayrollCycle: match.name }).where(eq(company.id, p.companyId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.companyId,
      eventType: 'company.default-payroll-cycle.set',
      actor: actorOf(ctx),
      payload: { before: before?.defaultPayrollCycle ?? null, after: match.name },
    });
    return { id: p.companyId };
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

/** 6fadb036 — validate an org-head employment (department / business-unit head) belongs to the SAME company
 *  as the unit it heads (same-company guard, ADR-0071 §i). Blank ⇒ null (clears the head). */
async function resolveHeadEmploymentId(
  tx: Tx,
  headEmploymentId: string | null | undefined,
  companyId: string,
): Promise<string | null> {
  const id = (headEmploymentId ?? '').trim();
  if (!id) return null;
  const [emp] = await tx
    .select({ companyId: employment.companyId })
    .from(employment)
    .where(eq(employment.id, id))
    .limit(1);
  if (!emp || emp.companyId !== companyId) throw new CrossCompanyError('employment');
  return id;
}

export async function createDepartment(
  ctx: SessionContext,
  p: { companyId: string; name: string; parentDepartmentId?: string; businessUnitId?: string | null; description?: string },
) {
  const name = cleanName(p.name, 'Department name');
  const description = p.description?.trim() || null;
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
        description,
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
      payload: { companyId: p.companyId, name: p.name, businessUnitId, description },
    });
    return row;
  });
}

export async function createPosition(
  ctx: SessionContext,
  p: { companyId: string; title: string; jobFamily?: string; description?: string },
) {
  const title = cleanName(p.title, 'Position title');
  const description = p.description?.trim() || null;
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(position)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, title, jobFamily: p.jobFamily?.trim() || null, description })
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
      payload: { companyId: p.companyId, title: p.title, description },
    });
    return row;
  });
}

export async function createCostCenter(
  ctx: SessionContext,
  p: { companyId: string; code: string; name: string; description?: string },
) {
  const code = cleanName(p.code, 'Cost-center code');
  const name = cleanName(p.name, 'Cost-center name');
  const description = p.description?.trim() || null;
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(costCenter)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, code, name, description })
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
      payload: { companyId: p.companyId, code: p.code, description },
    });
    return row;
  });
}

/** Business Unit master (ADR-0068) — a FLAT, company-scoped catalog cloning the cost_center pattern
 *  end-to-end: company-scoped, DB partial-unique index (from migration 0136), DuplicateError on clash,
 *  and a DomainEvent on every write. No parent/child hierarchy (reporter decision). */
export async function createBusinessUnit(
  ctx: SessionContext,
  p: { companyId: string; code: string; name: string; description?: string },
) {
  const code = cleanName(p.code, 'Business-unit code');
  const name = cleanName(p.name, 'Business-unit name');
  const description = p.description?.trim() || null;
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(businessUnit)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, code, name, description })
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
      payload: { companyId: p.companyId, code: p.code, description },
    });
    return row;
  });
}

export async function createLeaveType(
  ctx: SessionContext,
  // Leave Type master page (feedback 097de541): the add-type form now carries an optional description and a
  // create-time active/inactive status (default active). Code + name stay required.
  // Leave Unit Configuration (e4980382): whether this type is managed in Days or Hours. Optional; the service
  // defaults to 'day' so an omitted value reproduces today's behaviour. Validated against the closed set.
  p: { code: string; name: string; paid?: boolean; description?: string | null; active?: boolean; leaveUnit?: 'day' | 'hour' },
) {
  // The code is the semantic key the statutory floor / standing grants / carry-forward match on
  // (exact, uppercase). Normalize hard so 'annual' can never silently miss the EA floor.
  const code = cleanName(p.code, 'Leave-type code').toUpperCase().replace(/ /g, '_');
  if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(code)) {
    throw new Error('Leave-type code must be letters, digits or underscores (e.g. ANNUAL)');
  }
  const name = cleanName(p.name, 'Leave-type name');
  // Leave Unit Configuration (e4980382): default 'day'; reject anything outside the closed { day, hour } set.
  const leaveUnit = p.leaveUnit ?? 'day';
  if (leaveUnit !== 'day' && leaveUnit !== 'hour') {
    throw new Error('Leave unit must be day or hour.');
  }
  // Leave Type master page (feedback 097de541): trim the optional description; empty ⇒ null (never store "").
  const description = typeof p.description === 'string' && p.description.trim() !== '' ? p.description.trim() : null;
  // Create-time status. active=false ⇒ insert already archived (mirrors archiveLeaveType semantics). Note the
  // code-unique index is PARTIAL on archived_at IS NULL, so an inactive-created type does not hold the code —
  // same trade-off as archiving an existing type; acceptable.
  const active = p.active !== false;
  return withTenant(ctx, async (tx) => {
    // Name uniqueness (feedback 097de541): case-insensitive, ACTIVE types only (mirrors the partial code
    // index which only guards archived_at IS NULL). Enforced in the service — not a DB index — because
    // existing tenant data may already hold duplicate names. Gives the friendly warning the ticket asks for.
    const [dupe] = await tx
      .select({ id: leaveType.id })
      .from(leaveType)
      .where(and(isNull(leaveType.archivedAt), sql`lower(${leaveType.name}) = lower(${name})`))
      .limit(1);
    if (dupe) throw new DuplicateError(`A leave type named “${name}” already exists.`);
    const [row] = await tx
      .insert(leaveType)
      .values({
        // ADR-0077 slice 5 — same seam as core/toil.ts: an HR-created type is tenant-scoped, and which
        // country it belongs to is slice 6's question, not one to answer by guessing here.
        tenantId: ctx.tenantId,
        code,
        name,
        description,
        paid: p.paid ?? true,
        leaveUnit,
        ...(active ? {} : { archivedAt: sql`now()` }),
      })
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
      payload: { code, name, paid: p.paid ?? true, description, active, leaveUnit },
    });
    return row;
  });
}

// ── Job grades (ADR-0041 2E) ──────────────────────────────────────────────────────────────────────
export async function createJobGrade(
  ctx: SessionContext,
  // `description` (e3c733df): optional display-only detail, mirroring profile_option.description. Omitted
  // ⇒ NULL, so every existing caller is unchanged.
  p: { code: string; name: string; rank?: number; description?: string | null },
) {
  const code = cleanName(p.code, 'Grade code').toUpperCase().replace(/ /g, '_');
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(code)) {
    throw new Error('Grade code must be letters, digits or underscores (e.g. EXEC, G1)');
  }
  const name = cleanName(p.name, 'Grade name');
  const rank = Number.isFinite(p.rank) ? Number(p.rank) : 0;
  // Trimmed, and blank collapses to NULL so an empty box and an untouched field mean the same thing in
  // the database rather than one storing '' and the other NULL.
  const description = p.description?.trim() ? p.description.trim() : null;
  return withTenant(ctx, async (tx) => {
    // r224 — RESTORE INSTEAD OF DUPLICATE. Both grade uniqueness indexes are PARTIAL —
    // job_grade_code_uq (0090) and job_grade_name_uq (0183) are `... WHERE archived_at IS NULL` — so an
    // archived grade does NOT hold its code and this insert would SUCCEED, leaving the tenant with two
    // rows carrying one code: the new empty one the operator is looking at, and the archived one that
    // every historical reader (employment.grade_id, an eligibility rule's `criteria -> 'gradeIds'`,
    // grade_group_member) still points at. The index will never stop that — releasing the code on archive
    // is the whole point of the partial predicate — so the guard has to be here, in the writer.
    //
    // It is raised BEFORE the insert rather than mapped from a constraint failure for the same reason:
    // there is no constraint to fail. The error carries the archived row's id so the grid can offer the
    // restore, and restoring reuses that id, which is what keeps the history attached.
    const [archivedTwin] = await tx
      .select({ id: jobGrade.id, name: jobGrade.name })
      .from(jobGrade)
      .where(and(eq(jobGrade.code, code), isNotNull(jobGrade.archivedAt)))
      .limit(1);
    if (archivedTwin) {
      throw new ArchivedGradeCodeError(
        `Code “${code}” belongs to an archived grade (“${archivedTwin.name}”). Restore that grade instead of creating a second one with the same code.`,
        archivedTwin.id,
      );
    }
    const [row] = await tx
      .insert(jobGrade)
      .values({ tenantId: ctx.tenantId, code, name, rank, description })
      .returning({ id: jobGrade.id })
      .catch((e) => {
        // Grade Management (728a7db6): two partial-unique indexes now guard the row — map each to its own
        // friendly message so the admin knows which field clashed.
        if (uniqueViolationConstraint(e) === 'job_grade_name_uq') {
          throw new DuplicateError(`A grade named “${name}” already exists.`);
        }
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
  // 4ec5a940 — optional `reason` for the change (free-text from the config form), recorded on the audit
  // event payload only (never persisted to the aggregate row).
  // 728a7db6 — `code` is now editable too (reporter: "Update Grade Code"). Optional/undefined ⇒ leave the
  // code untouched (rank/name-only edits stay backward compatible); when present it is normalized +
  // re-validated + uniqueness-checked exactly like createJobGrade.
  // e3c733df — `description` follows the same optional/undefined rule as `code`: undefined leaves the
  // stored value alone, so a rank-or-name-only edit can never blank a description someone wrote.
  p: { id: string; name: string; rank?: number; code?: string; reason?: string | null; description?: string | null },
) {
  const name = cleanName(p.name, 'Grade name');
  const rank = Number.isFinite(p.rank) ? Number(p.rank) : 0;
  const reason = normalizeReason(p.reason);
  // Only touch `code` when the caller supplied one, so a name/rank edit never clears it.
  const code =
    p.code === undefined
      ? undefined
      : (() => {
          const c = cleanName(p.code, 'Grade code').toUpperCase().replace(/ /g, '_');
          if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(c)) {
            throw new Error('Grade code must be letters, digits or underscores (e.g. EXEC, G1)');
          }
          return c;
        })();
  return withTenant(ctx, async (tx) => {
    // 4ec5a940 — read the prior row so the audit event carries a real before→after comparison (forward-only:
    // events that predate this change keep their new-values-only payload; the log is append-only).
    const [prev] = await tx
      .select({ name: jobGrade.name, rank: jobGrade.rank, code: jobGrade.code })
      .from(jobGrade)
      .where(eq(jobGrade.id, p.id))
      .limit(1);
    await tx
      .update(jobGrade)
      .set({
        name,
        rank,
        ...(code === undefined ? {} : { code }),
        ...(p.description === undefined
          ? {}
          : { description: p.description?.trim() ? p.description.trim() : null }),
      })
      .where(eq(jobGrade.id, p.id))
      .catch((e) => {
        // 728a7db6 — same dual-index mapping as create: name clash vs code clash → distinct message.
        if (uniqueViolationConstraint(e) === 'job_grade_name_uq') {
          throw new DuplicateError(`A grade named “${name}” already exists.`);
        }
        if (isUniqueViolation(e)) throw new DuplicateError(`A grade with code “${code}” already exists.`);
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'job-grade',
      aggregateId: p.id,
      eventType: 'job-grade.updated',
      actor: actorOf(ctx),
      payload: {
        before: prev ? { name: prev.name, rank: prev.rank, code: prev.code } : null,
        after: { name, rank, ...(code === undefined ? (prev ? { code: prev.code } : {}) : { code }) },
        ...(reason ? { reason } : {}),
      },
    });
  });
}

/**
 * 728a7db6 — hard-delete a grade from the catalog. Reporter requires a Delete action that is BLOCKED when
 * the grade is currently in use, preserving historical records. We re-check the in-use predicate INSIDE the
 * write tx (not just the UI's disabled state) so a concurrent assignment can't slip a delete through.
 * Unused ⇒ hard delete + a `job-grade.deleted` event (the only new substrate event this feature introduces).
 *
 * b1b81a08 — the predicate now spans ALL FIVE referencing tables (employment, leave_policy,
 * leave_approval_policy, claim_policy, grade_group_member), matching listJobGrades' `inUse` byte for byte so
 * the grid's disabled Delete and this guard never disagree. Before, an approval rule or a claim limit was
 * invisible to both, so Delete rendered enabled and raised a raw 23503 foreign-key string at the admin;
 * grade_group_member CASCADES, so the delete silently dropped benefit-scheme group membership.
 *
 * 6e9a126e RELEASE THREE — `leave_policy` IS DROPPED (migration 0405), so the clause naming it did not
 * merely go stale, it made this whole query raise `relation "leave_policy" does not exist` — and the same
 * clause in listJobGrades' projection broke every read of the grade catalog. The guard is REPOINTED, not
 * removed: a grade is now also in use when an ENTITLEMENT ELIGIBILITY RULE names it. That reference lives
 * inside `criteria` JSONB with no foreign key, so unlike the other six this one can never raise 23503 —
 * the delete would simply SUCCEED and leave a dead grade id in a rule that still targets people, silently
 * narrowing (or widening) who an entitlement table reaches. RETIRED rules count too: the dated readers
 * reproduce closed years through them, so a historical rule's grade is still load-bearing.
 */
export async function deleteJobGrade(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    const [g] = await tx
      .select({ code: jobGrade.code, name: jobGrade.name })
      .from(jobGrade)
      .where(eq(jobGrade.id, p.id))
      .limit(1);
    if (!g) throw new Error('Grade not found.');
    const [used] = await tx
      .select({
        // e7eb5d83 (0408): claim_mileage_rate.grade_id is the SIXTH referencing table — a per-grade mileage
        // rate table, another plain FK with no onDelete. Kept byte-identical to listJobGrades' predicate.
        inUse: sql<boolean>`exists (select 1 from employment e where e.grade_id = ${p.id})
          or exists (select 1 from entitlement_eligibility_rule eer
                     where eer.criteria -> 'gradeIds' @> to_jsonb(${p.id}::text))
          or exists (select 1 from leave_approval_policy lap where lap.grade_id = ${p.id})
          or exists (select 1 from claim_policy cp where cp.grade_id = ${p.id})
          or exists (select 1 from claim_mileage_rate cmr where cmr.grade_id = ${p.id})
          or exists (select 1 from grade_group_member ggm where ggm.grade_id = ${p.id})`,
      })
      .from(jobGrade)
      .where(eq(jobGrade.id, p.id))
      .limit(1);
    if (used?.inUse) {
      throw new Error(
        'This grade is in use by employees, entitlement eligibility rules, approval rules, claim limits, mileage rates or a grade group and cannot be deleted. Archive it instead.',
      );
    }
    await tx.delete(jobGrade).where(eq(jobGrade.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'job-grade',
      aggregateId: p.id,
      eventType: 'job-grade.deleted',
      actor: actorOf(ctx),
      payload: { code: g.code, name: g.name },
    });
  });
}

/**
 * Archive / restore — ONE toggle on archived_at, so "restore" has never needed a service of its own. r224
 * leans on that: the restore offered when a create hits an archived code calls this with archived:false,
 * which clears archived_at IN PLACE and therefore keeps the grade's id, its history and every reference
 * that was already pointing at it.
 */
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

/**
 * Feedback b81d3c52 — Rounding Method persistence, generalised to the SAME tri-state the bands use
 * (serviceBandsAccrual), under the JSONB-rebuild rule: `accrual` is rebuilt wholesale on every save, so a
 * key the caller did not supply is dropped. The Rounding Method now REMEMBERS itself on its own instead of
 * riding a hidden input on every unrelated form:
 *  - `undefined` (the form did not render the Rounding dropdown / posted no marker) ⇒ PRESERVE the current
 *    stored value (only meaningful on update — the caller passes it as `preserve`; create passes undefined
 *    so absent means "nothing", byte-identical to before this ticket).
 *  - `null` (the dropdown WAS rendered and 'none'/anything unrecognised was chosen) ⇒ CLEAR (omit the key),
 *    so a No-Rounding policy stays byte-identical to a row written before this feature existed.
 *  - 'up' / 'down' ⇒ SET. The resolvers read an absent key as 'none'.
 */
function roundingAccrual(
  method: string | null | undefined,
  preserve: LeaveRoundingMethod | undefined,
): { roundingMethod?: LeaveRoundingMethod } {
  if (method === undefined) return preserve ? { roundingMethod: preserve } : {};
  if (method === null) return {};
  return method === 'up' || method === 'down' ? { roundingMethod: method } : {};
}

// 6e9a126e — `validateServiceBands` MOVED to core/leave-compute.ts, unchanged, and is imported above.
// It now guards THREE writers instead of one (leave_policy here, and entitlement_template's create +
// update), and it lives next to `isWellFormedBands`, the defensive resolver whose ceiling it must match.
// Keeping a private copy here while a second writer grew its own would be the duplicate-maintenance
// defect this whole feedback item is about.

/** Leave Entitlement Rules Engine — tri-state persistence for `serviceBands` (the carryFlagsAccrual
 *  precedent, generalised): `undefined` = PRESERVE the current row's bands (only meaningful on update — the
 *  caller must pass the current value); `null` or `[]` = CLEAR (omit the key, falling back to flat
 *  annualDays); a non-empty array = REPLACE after validation. */
function serviceBandsAccrual(
  bands: ServiceBand[] | null | undefined,
  preserve: ServiceBand[] | undefined,
): { serviceBands?: ServiceBand[] } {
  if (bands === undefined) return preserve ? { serviceBands: preserve } : {};
  if (bands === null || bands.length === 0) return {};
  validateServiceBands(bands);
  return { serviceBands: bands };
}

/** Correct an existing entitlement in place (same effective date) — for fixing a mis-typed
 *  value. A change *going forward* is a new dated policy via createLeavePolicy, not this.
 *
 *  Feedback 49809272: an in-place correction now FLOWS THROUGH to already-granted balances — when the
 *  corrected values move the entitlement (days / method / bands / scope), every affected employee's
 *  CURRENT cycle is re-projected and a compensating ledger `adjustment` posted for the delta, in this
 *  same transaction (see reprojectEntitlementForPolicy in core/leave.ts for the invariants). Returns
 *  `{ affected, totalDelta }` so the action can tell the admin the blast radius. */

// ─────────────────────── Service-Based Entitlements (company × grade) ───────────────────────
// Restructure Service-Based Leave Entitlements by Company and Grade. The Service Based Entitlements
// sub-step is a company-driven table: pick a company, edit each grade's three service-band figures.
// It is backed by the SAME leave_policy store the Company Entitlements timeline uses, so existing data
// and the resolver are preserved. Writes go through createLeavePolicy / updateLeavePolicy (no new writer
// primitive) — this service only ORCHESTRATES them so the first save materialises the whole company
// scope safely.

/** Mirror resolveGradePolicy's scope + grade tiering, but return the WINNING ROW (with its full accrual
 *  JSONB) instead of the resolved days — so the seeding path can copy the config that currently RESOLVES
 *  for a (grade, company) verbatim (method / carry-forward / rounding / bands preserved, not just days).
 *  "Most generous" is compared on flat annualDays (the governing metric; a lone grade default is the
 *  common shape) — good enough to identify the one policy that governs the grade. */
type ActivePolicyRow = { id: string; gradeId: string | null; companyId: string | null; accrual: unknown; validFrom: string };
function pickResolvingPolicyRow(
  rows: ActivePolicyRow[],
  gradeId: string | null,
  companyId: string | null,
): ActivePolicyRow | null {
  const pickMax = (subset: ActivePolicyRow[]): ActivePolicyRow | null => {
    let best: ActivePolicyRow | null = null;
    let bestDays = -1;
    for (const r of subset) {
      const days = Number((r.accrual as AccrualConfig | null)?.annualDays ?? 0);
      if (days > bestDays) {
        bestDays = days;
        best = r;
      }
    }
    return best;
  };
  const within = (scope: ActivePolicyRow[]): ActivePolicyRow | null => {
    const graded = gradeId ? pickMax(scope.filter((r) => r.gradeId === gradeId)) : null;
    return graded ?? pickMax(scope.filter((r) => r.gradeId == null));
  };
  if (companyId != null) {
    const companyScope = rows.filter((r) => r.companyId === companyId);
    if (companyScope.length > 0) return within(companyScope);
  }
  return within(rows.filter((r) => r.companyId == null));
}

/** Map a stored accrual JSONB into createLeavePolicy's argument shape — a FAITHFUL FULL COPY (annualDays,
 *  service bands, method, carry-forward config + flags, rounding), so a seeded company+grade row resolves
 *  byte-identically to the row it copies (never a days-only downgrade). */
function accrualToCreateArgs(accrual: unknown): {
  annualDays: number;
  carryForwardMax: number;
  carryForwardExpiryMonth: number | null;
  carryForwardExpiryDay: number | null;
  carryForwardExpiryMode?: 'date' | 'months';
  carryForwardExpiryMonths: number | null;
  carryForwardEnabled?: boolean;
  carryForwardIncludeEarned?: boolean;
  method?: string;
  serviceBands: ServiceBand[] | null;
  roundingMethod?: string;
} {
  const acc = (accrual ?? {}) as AccrualConfig;
  return {
    annualDays: Number(acc.annualDays ?? 0),
    carryForwardMax: Math.max(0, Number(acc.carryForwardMax ?? 0)),
    carryForwardExpiryMonth: acc.carryForwardExpiryMonth ?? null,
    carryForwardExpiryDay: acc.carryForwardExpiryDay ?? null,
    carryForwardExpiryMode: acc.carryForwardExpiryMode === 'months' ? 'months' : undefined,
    carryForwardExpiryMonths: acc.carryForwardExpiryMonths ?? null,
    carryForwardEnabled: typeof acc.carryForwardEnabled === 'boolean' ? acc.carryForwardEnabled : undefined,
    carryForwardIncludeEarned: acc.carryForwardIncludeEarned,
    method: acc.method,
    serviceBands: Array.isArray(acc.serviceBands) && acc.serviceBands.length > 0 ? acc.serviceBands : null,
    roundingMethod: acc.roundingMethod,
  };
}

/**
 * Save one grade's Service-Based Entitlement for a company from the company-driven table.
 *
 * The three inputs are the days for < 2 years / 2–5 years / 5+ years service. If all three are equal AND the
 * grade's currently-resolving policy is FLAT (no bands), the row is written flat (annualDays, no bands) so a
 * flat policy stays flat; otherwise the fixed 0–2 / 2–5 / 5+ three-band shape is written (annualDays = the
 * 5+ figure, which is always set so legacy/no-band resolution and the EA floor path keep a value).
 *
 * FIRST-SAVE SAFEGUARD (ADR-0066). Writing a company-scoped row makes the resolver short-circuit to the
 * company tier and abandon the group default for EVERY other grade of that company — which would silently
 * drop the untouched grades to zero. So the first time any grade is saved for a company, the WHOLE company
 * scope is materialised first: every active grade gets a company+grade row copied verbatim from what
 * currently resolves for it, plus a company null-grade default mirroring the group null-grade default.
 * Those copies resolve byte-identically, so untouched grades keep their exact days and no balance moves.
 *
 * WRITER ROUTING (fix 4). Seeding uses createLeavePolicy (genuinely new scopes). The edited grade is then
 * updated IN PLACE via updateLeavePolicy on its own row id (keeping validFrom, so only the current-cycle
 * recalc fires and the reprojection posts the real delta). A grade first touched after seeding is copied
 * then updated the same way, so its employees are recalculated too.
 */

/** Remove an entitlement policy. Safe: the ledger references the leave *type*, not the policy,
 *  so past grants are untouched — this only stops the row from driving future grants. */

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
          // Shared System Labels (62de487d): resolve via origin ∪ shared-in ∪ global (flag-gated).
          opts.companyIds && opts.companyIds.length
            ? visibleLabelIdsCondition(position, 'position', opts.companyIds)
            : undefined,
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
          // Shared System Labels (62de487d): resolve via origin ∪ shared-in ∪ global (flag-gated).
          opts.companyIds && opts.companyIds.length
            ? visibleLabelIdsCondition(costCenter, 'cost_center', opts.companyIds)
            : undefined,
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
          // Shared System Labels (62de487d): resolve via origin ∪ shared-in ∪ global (flag-gated).
          opts.companyIds && opts.companyIds.length
            ? visibleLabelIdsCondition(businessUnit, 'business_unit', opts.companyIds)
            : undefined,
        ),
      )
      .orderBy(businessUnit.code),
  );
}

// ── System Labels reads (description-bearing) ───────────────────────────────────────────────────────
// The System Labels admin page is the ONLY consumer of `description`, so it gets its own read queries that
// select the column. The general-purpose listDepartments/listPositions/listCostCenters/listBusinessUnits
// used by the hire form and People filters are deliberately left untouched (no description) — narrow scope.
//
// Audit columns (62de487d): the four label tables carry `created_at` but no updated_at/updated_by — the
// "Last updated" audit info the grid shows is DERIVED from the domain-event log (each create/update/archive
// already appends one; substrate discipline). Correlated subqueries over domain_event keyed by the row's
// aggregate id: latest occurred_at + the actor's display name (SYSTEM/agent events → null name). RLS on
// domain_event grants admins tenant-wide read, and this page is scopedAdmin, so the subqueries resolve.

/** The outer table's id column, FULLY QUALIFIED ("table"."id"), for correlating into the domain_event
 *  subqueries. Drizzle interpolates a bare column into sql`` unqualified ("id"), which Postgres binds to
 *  the SUBQUERY's own relations first — silently wrong in lastUpdatedAtSql (de.id) and fatally ambiguous
 *  in lastUpdatedBySql (de/au/p all carry id). Caught by the R17 clean-room gate. */
function qualifiedId(idCol: AnyColumn) {
  return sql.raw(`"${getTableName(idCol.table)}"."${idCol.name}"`);
}
/** Scalar SQL: the most-recent domain-event timestamp for a label row (its aggregate). The idCol is the
 *  outer table's id column, correlated into the subquery. */
function lastUpdatedAtSql(agg: string, idCol: AnyColumn) {
  return sql<string | null>`(select max(de.occurred_at) from domain_event de
    where de.aggregate_type = ${agg} and de.aggregate_id = ${qualifiedId(idCol)})`;
}
/** Scalar SQL: the display name of the actor on the most-recent domain-event for a label row. SYSTEM /
 *  agent events (no actor_id, or no linked person) resolve to null — the UI shows a system fallback. */
function lastUpdatedBySql(agg: string, idCol: AnyColumn) {
  return sql<string | null>`(select p.full_name from domain_event de
    left join app_user au on au.id = de.actor_id
    left join person p on p.id = au.person_id
    where de.aggregate_type = ${agg} and de.aggregate_id = ${qualifiedId(idCol)}
    order by de.occurred_at desc limit 1)`;
}


export function listDepartmentsForLabels(
  ctx: SessionContext,
  opts: { companyIds?: string[] } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: department.id,
        companyId: department.companyId,
        name: department.name,
        // 797e3523: optional short code shown in the System Labels grid.
        label: department.label,
        businessUnitId: department.businessUnitId,
        // 6fadb036: the department head an approval `department_head` step routes to (nullable).
        headEmploymentId: department.headEmploymentId,
        description: department.description,
        archivedAt: department.archivedAt,
        isGlobal: department.isGlobal,
        createdAt: department.createdAt,
        lastUpdatedAt: lastUpdatedAtSql('department', department.id),
        lastUpdatedBy: lastUpdatedBySql('department', department.id),
        inUse: sql<boolean>`exists (select 1 from assignment a where a.department_id = department.id and a.superseded_at is null)`,
      })
      .from(department)
      .where(
        opts.companyIds && opts.companyIds.length ? inArray(department.companyId, opts.companyIds) : undefined,
      )
      .orderBy(department.name),
  );
}

export function listPositionsForLabels(
  ctx: SessionContext,
  opts: { companyIds?: string[] } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: position.id,
        companyId: position.companyId,
        title: position.title,
        // 797e3523: optional short code shown in the System Labels grid.
        label: position.label,
        jobFamily: position.jobFamily,
        description: position.description,
        archivedAt: position.archivedAt,
        isGlobal: position.isGlobal,
        createdAt: position.createdAt,
        lastUpdatedAt: lastUpdatedAtSql('position', position.id),
        lastUpdatedBy: lastUpdatedBySql('position', position.id),
        inUse: sql<boolean>`exists (select 1 from assignment a where a.position_id = position.id and a.superseded_at is null)`,
      })
      .from(position)
      .where(
        opts.companyIds && opts.companyIds.length ? inArray(position.companyId, opts.companyIds) : undefined,
      )
      .orderBy(position.title),
  );
}

export function listCostCentersForLabels(
  ctx: SessionContext,
  opts: { companyIds?: string[] } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: costCenter.id,
        companyId: costCenter.companyId,
        code: costCenter.code,
        name: costCenter.name,
        // 797e3523: optional short code shown in the System Labels grid.
        label: costCenter.label,
        description: costCenter.description,
        archivedAt: costCenter.archivedAt,
        isGlobal: costCenter.isGlobal,
        createdAt: costCenter.createdAt,
        lastUpdatedAt: lastUpdatedAtSql('cost-center', costCenter.id),
        lastUpdatedBy: lastUpdatedBySql('cost-center', costCenter.id),
        inUse: sql<boolean>`exists (select 1 from assignment a where a.cost_center_id = cost_center.id and a.superseded_at is null)`,
      })
      .from(costCenter)
      .where(
        opts.companyIds && opts.companyIds.length ? inArray(costCenter.companyId, opts.companyIds) : undefined,
      )
      .orderBy(costCenter.code),
  );
}

export function listBusinessUnitsForLabels(
  ctx: SessionContext,
  opts: { companyIds?: string[] } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: businessUnit.id,
        companyId: businessUnit.companyId,
        code: businessUnit.code,
        name: businessUnit.name,
        // 797e3523: optional short code shown in the System Labels grid.
        label: businessUnit.label,
        // 6fadb036: the BU head an approval `business_unit_head` step routes to (nullable).
        headEmploymentId: businessUnit.headEmploymentId,
        description: businessUnit.description,
        archivedAt: businessUnit.archivedAt,
        isGlobal: businessUnit.isGlobal,
        createdAt: businessUnit.createdAt,
        lastUpdatedAt: lastUpdatedAtSql('business-unit', businessUnit.id),
        lastUpdatedBy: lastUpdatedBySql('business-unit', businessUnit.id),
        inUse: sql<boolean>`exists (select 1 from department d where d.business_unit_id = business_unit.id)`,
      })
      .from(businessUnit)
      .where(
        opts.companyIds && opts.companyIds.length ? inArray(businessUnit.companyId, opts.companyIds) : undefined,
      )
      .orderBy(businessUnit.code),
  );
}



// ───────────────────────── Public holiday calendar ─────────────────────────
// Holidays are country-scoped (the attendance/leave working-day counters match on company.country),
// not company-scoped — the table is keyed (tenant, country, holiday_date). Admin-only writes (RLS 0006).

/** List holidays for the tenant, newest first. Optionally filter by country, calendar year, and/or the
 *  owning company (org-scoped rows). Returns raw scope fields (state, companyId) + the joined company name
 *  so the UI can build a scope label from the static i18n key map (National / State:X / Group:<name>). */
export function listHolidays(
  ctx: SessionContext,
  opts: { country?: string; year?: number; companyId?: string; holidayGroupId?: string } = {},
) {
  return withTenant(ctx, (tx) => {
    const filters = [
      opts.country ? eq(holiday.country, opts.country) : undefined,
      opts.year ? sql`extract(year from ${holiday.holidayDate}) = ${opts.year}` : undefined,
      opts.companyId ? eq(holiday.companyId, opts.companyId) : undefined,
      opts.holidayGroupId ? eq(holiday.holidayGroupId, opts.holidayGroupId) : undefined,
    ].filter(Boolean);
    return tx
      .select({
        id: holiday.id,
        country: holiday.country,
        state: holiday.state,
        companyId: holiday.companyId,
        companyName: company.legalName,
        // R18 a519a96e: group-scoped "additional day" rows carry their owning group so the UI can badge them.
        holidayGroupId: holiday.holidayGroupId,
        holidayGroupName: holidayGroup.name,
        holidayDate: holiday.holidayDate,
        name: holiday.name,
        // Follow-on #15b (ADR-0063): surface the provisional marker so the UI can render a Tentative badge.
        tentative: holiday.tentative,
        // 66b8f5a8 — Holiday master fields (migration 0190).
        holidayCode: holiday.holidayCode,
        holidayType: holiday.holidayType,
        description: holiday.description,
        active: holiday.active,
      })
      .from(holiday)
      .leftJoin(company, eq(company.id, holiday.companyId))
      .leftJoin(holidayGroup, eq(holidayGroup.id, holiday.holidayGroupId))
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
    // R18 a519a96e: set = a GROUP-scoped "additional day" that applies only to staff resolving through
    // that holiday group (or a child group inheriting from it) — the per-office extra.
    holidayGroupId?: string | null;
    // Follow-on #15b (ADR-0063): provisional date for a not-yet-gazetted holiday. Still counts as a holiday.
    tentative?: boolean;
    // 66b8f5a8 — Holiday master fields (migration 0190). All optional; defaults reproduce today's behaviour.
    holidayCode?: string | null;
    holidayType?: string;
    description?: string | null;
    active?: boolean;
  },
) {
  const country = isoCode(p.country, 'MY', 'Country');
  const name = cleanName(p.name, 'Holiday name');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.holidayDate)) throw new Error('Holiday date must be YYYY-MM-DD');
  const state = p.state?.trim() || null; // 2C: null = national (applies everywhere)
  const companyId = p.companyId?.trim() || null; // ADR-0055: set = business-group (company-subtree) scope
  const holidayGroupId = p.holidayGroupId?.trim() || null; // R18 a519a96e: set = holiday-group scope
  const tentative = p.tentative ?? false;
  // 66b8f5a8 — master fields. Empty strings ⇒ null (never store ""); type defaults to 'public'.
  const holidayCode = p.holidayCode?.trim() || null;
  const holidayType = cleanHolidayType(p.holidayType);
  const description = p.description?.trim() || null;
  const active = p.active ?? true;
  // Scope is single-axis: national, state, business-group, OR holiday-group — never two at once (mirrors
  // the DB CHECK holiday_scope_excl; thrown here so the user gets a clear message before the constraint).
  if ([state, companyId, holidayGroupId].filter(Boolean).length > 1)
    throw new Error('A holiday is scoped to a state, a company, or a holiday group — pick at most one.');
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
    let groupName: string | null = null;
    if (holidayGroupId) {
      // Same cross-tenant FK guard for the group scope (mirrors the company check above).
      const [g] = await tx
        .select({ name: holidayGroup.name })
        .from(holidayGroup)
        .where(and(eq(holidayGroup.id, holidayGroupId), eq(holidayGroup.tenantId, ctx.tenantId)))
        .limit(1);
      if (!g) throw new Error('Unknown holiday group for this holiday scope.');
      groupName = g.name;
    }
    const [row] = await tx
      .insert(holiday)
      .values({
        tenantId: ctx.tenantId,
        country,
        state,
        companyId,
        holidayGroupId,
        holidayDate: p.holidayDate,
        name,
        tentative,
        holidayCode,
        holidayType,
        description,
        active,
      })
      .returning({ id: holiday.id })
      .catch((e) => {
        if (isUniqueViolation(e)) {
          const scope = companyId
            ? `group ${companyName} `
            : holidayGroupId
              ? `${groupName} calendar `
              : state
                ? `${state} `
                : '';
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
      // Scope-in-audit (ADR-0055 acceptance goal): carry the FULL scope, not just country/date/name.
      payload: {
        country,
        holidayDate: p.holidayDate,
        name,
        state,
        companyId,
        holidayGroupId,
        tentative,
        holidayCode,
        holidayType,
        description,
        active,
      },
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
  // 66b8f5a8: the master fields (holidayCode/holidayType/description/active) are EDITABLE here (unlike scope,
  // which stays immutable). Each is tri-state via `undefined` = leave untouched.
  p: {
    id: string;
    holidayDate?: string;
    name?: string;
    tentative?: boolean;
    holidayCode?: string | null;
    holidayType?: string;
    description?: string | null;
    active?: boolean;
  },
) {
  // Validate up front (before any DB work), reusing create's guards so update is no laxer than create.
  if (p.holidayDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(p.holidayDate)) {
    throw new Error('Holiday date must be YYYY-MM-DD');
  }
  const nextName = p.name !== undefined ? cleanName(p.name, 'Holiday name') : undefined;
  const nextType = p.holidayType !== undefined ? cleanHolidayType(p.holidayType) : undefined;
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        country: holiday.country,
        state: holiday.state,
        companyId: holiday.companyId,
        holidayGroupId: holiday.holidayGroupId,
        holidayDate: holiday.holidayDate,
        name: holiday.name,
        tentative: holiday.tentative,
        holidayCode: holiday.holidayCode,
        holidayType: holiday.holidayType,
        description: holiday.description,
        active: holiday.active,
      })
      .from(holiday)
      .where(eq(holiday.id, p.id))
      .limit(1);
    if (!before) throw new Error('Holiday not found');

    const after = {
      holidayDate: p.holidayDate ?? before.holidayDate,
      name: nextName ?? before.name,
      tentative: p.tentative ?? before.tentative,
      holidayCode: p.holidayCode !== undefined ? p.holidayCode?.trim() || null : before.holidayCode,
      holidayType: nextType ?? before.holidayType,
      description: p.description !== undefined ? p.description?.trim() || null : before.description,
      active: p.active ?? before.active,
    };
    await tx
      .update(holiday)
      .set({
        holidayDate: after.holidayDate,
        name: after.name,
        tentative: after.tentative,
        holidayCode: after.holidayCode,
        holidayType: after.holidayType,
        description: after.description,
        active: after.active,
      })
      .where(eq(holiday.id, p.id))
      .catch((e) => {
        if (isUniqueViolation(e)) {
          // Scope is immutable here, so reuse the BEFORE scope for the message (mirrors create).
          const scope = before.companyId
            ? 'group '
            : before.holidayGroupId
              ? 'calendar '
              : before.state
                ? `${before.state} `
                : '';
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
          holidayCode: before.holidayCode,
          holidayType: before.holidayType,
          description: before.description,
          active: before.active,
          country: before.country,
          state: before.state,
          companyId: before.companyId,
          holidayGroupId: before.holidayGroupId,
        },
        after: {
          ...after,
          country: before.country,
          state: before.state,
          companyId: before.companyId,
          holidayGroupId: before.holidayGroupId,
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
        holidayGroupId: holiday.holidayGroupId,
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
// A holiday group is a NAMED bundle of states (pack `states` labels). It is delivered OVER the existing state
// engine: holidays are not re-tagged; the resolver (core/leave.ts) expands the assigned group to its
// member states and feeds them into the same holiday.state UNION predicate as work_state. Admin-only
// writes (RLS 0100). Assignment lives on employment.holiday_group_id (mutually exclusive with work_state).

/** Sanitise + validate a group's member states, de-duplicated.
 *
 *  ADR-0077 slice 6 — this used the UNION across every registered pack, with a comment saying
 *  per-company narrowing was a later slice. A holiday group is TENANT-level, so there is no single
 *  company to narrow by; it now narrows to the countries the tenant's companies actually operate in,
 *  which is the same rule one level up. A tenant that operates only Malaysia can no longer be given a
 *  Singapore state on a calendar its employees will never match against. See core/state-vocabulary.ts.
 *
 *  For a 'custom' calendar
 *  states supply nothing (national is NOT auto-added) so an empty list is allowed; for 'standard'/'extended'
 *  the states[] ARE the gazette state source, so at least one is required (a zero-state non-custom group ==
 *  national, which already exists) — UNLESS the group has a PARENT (R18 a519a96e): then the parent's
 *  archetype + states[] are the gazette source and the child may carry zero states of its own. */
function cleanHolidayGroupStates(
  states: string[] | undefined,
  archetype: HolidayGroupArchetype,
  hasParent: boolean,
  tenantCountries: readonly (string | null)[],
): string[] {
  const valid = statesForCountries(tenantCountries);
  const out = [...new Set((states ?? []).map((s) => (s ?? '').trim()).filter(Boolean))];
  if (archetype !== 'custom' && out.length === 0 && !hasParent)
    throw new Error('A standard or extended holiday calendar must include at least one state.');
  for (const s of out) {
    if (!valid.has(s)) throw new Error(`Unknown state “${s}”.`);
  }
  return out;
}

/**
 * The distinct countries this tenant's companies operate in — the state vocabulary a TENANT-level
 * calendar is judged against. Read inside the tx so RLS scopes it to the caller's own tenant.
 *
 * A tenant with no companies yet resolves to an empty set, which rejects every state. That is the right
 * refusal rather than an edge case to paper over: a holiday calendar keyed to states, in a tenant that
 * operates in no country, cannot match anybody.
 */
async function tenantCompanyCountries(tx: Tx): Promise<string[]> {
  const rows = await tx.selectDistinct({ country: company.country }).from(company);
  return rows.map((r) => r.country).filter((c): c is string => !!c);
}

/** R18 a519a96e — validate a prospective PARENT group inside the tx: it must exist in THIS tenant (the FK
 *  alone would accept a cross-tenant id) and must itself be parentless (single-level nesting only: base
 *  group → office groups; no chains, so no cycles are possible without recursive writes). Returns the
 *  parent's name for events/messages. */
async function assertValidParentGroup(tx: Tx, tenantId: string, parentGroupId: string): Promise<string> {
  const [parent] = await tx
    .select({ name: holidayGroup.name, parentGroupId: holidayGroup.parentGroupId })
    .from(holidayGroup)
    .where(and(eq(holidayGroup.id, parentGroupId), eq(holidayGroup.tenantId, tenantId)))
    .limit(1);
  if (!parent) throw new Error('Unknown parent holiday group.');
  if (parent.parentGroupId)
    throw new Error('A parent holiday group cannot itself inherit from another group (one level only).');
  return parent.name;
}

/** All holiday groups for the tenant (id, name, states, archetype, parent), ordered by name. The parent's
 *  name is joined via a self-alias so the UI can render the "Inherits from {name}" badge. Read-only — no
 *  event. */
export function listHolidayGroups(ctx: SessionContext) {
  const parentGroup = alias(holidayGroup, 'parent_group');
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: holidayGroup.id,
        name: holidayGroup.name,
        // 66b8f5a8 — Holiday Group master fields (migration 0190).
        code: holidayGroup.code,
        description: holidayGroup.description,
        active: holidayGroup.active,
        states: holidayGroup.states,
        archetype: holidayGroup.archetype,
        parentGroupId: holidayGroup.parentGroupId,
        parentName: parentGroup.name,
      })
      .from(holidayGroup)
      .leftJoin(parentGroup, eq(parentGroup.id, holidayGroup.parentGroupId))
      .orderBy(holidayGroup.name),
  );
}

/** 66b8f5a8 — a single holiday group by id (for the dedicated edit page), including the master fields and
 *  parent name. Read-only — no event. Returns null when not found (or not visible under RLS). */
export function getHolidayGroup(ctx: SessionContext, p: { id: string }) {
  const parentGroup = alias(holidayGroup, 'parent_group');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: holidayGroup.id,
        name: holidayGroup.name,
        code: holidayGroup.code,
        description: holidayGroup.description,
        active: holidayGroup.active,
        states: holidayGroup.states,
        archetype: holidayGroup.archetype,
        parentGroupId: holidayGroup.parentGroupId,
        parentName: parentGroup.name,
      })
      .from(holidayGroup)
      .leftJoin(parentGroup, eq(parentGroup.id, holidayGroup.parentGroupId))
      .where(eq(holidayGroup.id, p.id))
      .limit(1);
    return row ?? null;
  });
}

/** 66b8f5a8 — the ids of the holidays explicitly TICKED into a group via the holiday_group_holiday junction.
 *  Drives the tick-list on the dedicated group page. Read-only — no event. */
export function listGroupHolidayIds(ctx: SessionContext, p: { groupId: string }) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ holidayId: holidayGroupHoliday.holidayId })
      .from(holidayGroupHoliday)
      .where(eq(holidayGroupHoliday.holidayGroupId, p.groupId));
    return rows.map((r) => r.holidayId);
  });
}

/** 66b8f5a8 — replace a group's ticked-holiday set with `holidayIds` (the reporter's tick-list). Computes
 *  the add/remove delta, applies it, and appends ONE holiday-group-holiday.set event carrying the before /
 *  after id sets (not a per-row event — the group is the aggregate). A cross-tenant/unknown holiday id is
 *  rejected (the FK + RLS backstop, but we validate for a friendly error). Idempotent: an unchanged set is a
 *  no-op that still records the (empty-delta) event for audit completeness. Runs inside the caller's tx when
 *  provided so it composes atomically with createHolidayGroup / updateHolidayGroup. */
async function setGroupHolidaysTx(
  tx: Tx,
  ctx: SessionContext,
  p: { groupId: string; holidayIds: string[] },
): Promise<void> {
  const desired = [...new Set(p.holidayIds.map((s) => s.trim()).filter(Boolean))];
  // Validate every desired id belongs to THIS tenant's holiday set (RLS already scopes, but a clear error
  // beats a raw FK violation). Skip the query when nothing is desired.
  if (desired.length) {
    const found = await tx
      .select({ id: holiday.id })
      .from(holiday)
      .where(inArray(holiday.id, desired));
    const foundIds = new Set(found.map((r) => r.id));
    for (const id of desired) if (!foundIds.has(id)) throw new Error('Unknown holiday selected for this group.');
  }
  const existing = (
    await tx
      .select({ holidayId: holidayGroupHoliday.holidayId })
      .from(holidayGroupHoliday)
      .where(eq(holidayGroupHoliday.holidayGroupId, p.groupId))
  ).map((r) => r.holidayId);
  const existingSet = new Set(existing);
  const desiredSet = new Set(desired);
  const toAdd = desired.filter((id) => !existingSet.has(id));
  const toRemove = existing.filter((id) => !desiredSet.has(id));
  if (toRemove.length) {
    await tx
      .delete(holidayGroupHoliday)
      .where(
        and(
          eq(holidayGroupHoliday.holidayGroupId, p.groupId),
          inArray(holidayGroupHoliday.holidayId, toRemove),
        ),
      );
  }
  if (toAdd.length) {
    await tx
      .insert(holidayGroupHoliday)
      .values(toAdd.map((holidayId) => ({ tenantId: ctx.tenantId, holidayGroupId: p.groupId, holidayId })))
      .onConflictDoNothing();
  }
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'holiday-group-holiday',
    aggregateId: p.groupId,
    eventType: 'holiday-group.holidays.set',
    actor: actorOf(ctx),
    payload: { before: existing, after: desired, added: toAdd, removed: toRemove },
  });
}

/** 66b8f5a8 — public wrapper: set a group's ticked holidays in its own transaction. */
export async function setGroupHolidays(ctx: SessionContext, p: { groupId: string; holidayIds: string[] }) {
  return withTenant(ctx, (tx) => setGroupHolidaysTx(tx, ctx, p));
}

export async function createHolidayGroup(
  ctx: SessionContext,
  // 66b8f5a8 — code/description/active are the new master fields (migration 0190); holidayIds is the
  // reporter's tick-list (persisted to the holiday_group_holiday junction). All optional/backward compatible.
  p: {
    name: string;
    states: string[];
    archetype?: string;
    parentGroupId?: string | null;
    code?: string | null;
    description?: string | null;
    active?: boolean;
    holidayIds?: string[];
  },
) {
  const name = cleanName(p.name, 'Group name');
  const archetype = cleanArchetype(p.archetype);
  const parentGroupId = p.parentGroupId?.trim() || null;
  const code = p.code?.trim() || null;
  const description = p.description?.trim() || null;
  const active = p.active ?? true;
  return withTenant(ctx, async (tx) => {
    // Inside the tx: the vocabulary depends on which countries this tenant operates in.
    const states = cleanHolidayGroupStates(p.states, archetype, !!parentGroupId, await tenantCompanyCountries(tx));
    let parentName: string | null = null;
    if (parentGroupId) parentName = await assertValidParentGroup(tx, ctx.tenantId, parentGroupId);
    const [row] = await tx
      .insert(holidayGroup)
      .values({ tenantId: ctx.tenantId, name, code, description, active, states, archetype, parentGroupId })
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
      payload: { name, code, description, active, states, archetype, parentGroupId, parentName },
    });
    // Persist the ticked-holiday set in the SAME tx (own holiday-group.holidays.set event) so a group and
    // its selection commit or roll back together.
    if (p.holidayIds !== undefined) await setGroupHolidaysTx(tx, ctx, { groupId: row.id, holidayIds: p.holidayIds });
    return row;
  });
}

export async function updateHolidayGroup(
  ctx: SessionContext,
  // 66b8f5a8 — code/description/active (master fields) and holidayIds (tick-list) are all tri-state via
  // `undefined` = leave untouched. holidayIds present ⇒ replace the junction set in this same tx.
  p: {
    id: string;
    name?: string;
    states?: string[];
    archetype?: string;
    parentGroupId?: string | null;
    code?: string | null;
    description?: string | null;
    active?: boolean;
    holidayIds?: string[];
  },
) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        name: holidayGroup.name,
        code: holidayGroup.code,
        description: holidayGroup.description,
        active: holidayGroup.active,
        states: holidayGroup.states,
        archetype: holidayGroup.archetype,
        parentGroupId: holidayGroup.parentGroupId,
      })
      .from(holidayGroup)
      .where(eq(holidayGroup.id, p.id))
      .limit(1);
    if (!before) throw new Error('Holiday group not found');
    const name = p.name !== undefined ? cleanName(p.name, 'Group name') : before.name;
    const code = p.code !== undefined ? p.code?.trim() || null : before.code;
    const description = p.description !== undefined ? p.description?.trim() || null : before.description;
    const active = p.active ?? before.active;
    const archetype = p.archetype !== undefined ? cleanArchetype(p.archetype) : (before.archetype as HolidayGroupArchetype);
    // parentGroupId is tri-state: undefined → keep, ''/null → clear, an id → set (validated below).
    const parentGroupId =
      p.parentGroupId !== undefined ? p.parentGroupId?.trim() || null : before.parentGroupId;
    if (parentGroupId === p.id) throw new Error('A holiday group cannot be its own parent.');
    const states =
      p.states !== undefined
        ? cleanHolidayGroupStates(p.states, archetype, !!parentGroupId, await tenantCompanyCountries(tx))
        : (before.states as string[]);
    // A standard/extended calendar still needs ≥1 gazette state even if only the archetype changed —
    // unless a parent supplies the gazette source (R18 a519a96e).
    if (archetype !== 'custom' && states.length === 0 && !parentGroupId)
      throw new Error('A standard or extended holiday calendar must include at least one state.');
    let parentName: string | null = null;
    if (parentGroupId && parentGroupId !== before.parentGroupId) {
      parentName = await assertValidParentGroup(tx, ctx.tenantId, parentGroupId);
      // Single-level nesting the other way round too: a group that already has CHILDREN cannot itself
      // become a child (locked so a concurrent createHolidayGroup pointing at us can't slip through).
      const children = await tx
        .select({ id: holidayGroup.id })
        .from(holidayGroup)
        .where(eq(holidayGroup.parentGroupId, p.id))
        .for('update');
      if (children.length > 0)
        throw new Error(
          `This group is the parent of ${children.length} other group${children.length === 1 ? '' : 's'} and cannot inherit from another group (one level only).`,
        );
    }
    await tx
      .update(holidayGroup)
      .set({ name, code, description, active, states, archetype, parentGroupId })
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
        before: {
          name: before.name,
          code: before.code,
          description: before.description,
          active: before.active,
          states: before.states,
          archetype: before.archetype,
          parentGroupId: before.parentGroupId,
        },
        after: { name, code, description, active, states, archetype, parentGroupId, parentName },
      },
    });
    // 66b8f5a8 — replace the ticked-holiday set in the SAME tx when the caller supplied one.
    if (p.holidayIds !== undefined) await setGroupHolidaysTx(tx, ctx, { groupId: p.id, holidayIds: p.holidayIds });
    return { id: p.id };
  });
}

export async function deleteHolidayGroup(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    // R18 a519a96e: block deleting a PARENT while child groups still inherit from it (lock the children so
    // a concurrent re-parent can't race the guard). The ON DELETE SET NULL FK is the backstop — a bypassed
    // delete detaches children rather than orphaning them — but the friendly path is to re-parent first.
    const childRefs = await tx
      .select({ id: holidayGroup.id })
      .from(holidayGroup)
      .where(eq(holidayGroup.parentGroupId, p.id))
      .for('update');
    if (childRefs.length > 0) {
      throw new InUseError(
        'holiday group',
        `This holiday group is the parent of ${childRefs.length} other group${childRefs.length === 1 ? '' : 's'}. Detach or delete them before deleting it.`,
      );
    }
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
    // R18 a519a96e: the group's OWN group-scoped "additional day" holiday rows are removed by the
    // ON DELETE CASCADE FK on holiday.holiday_group_id — deliberate (extras have no meaning without the
    // group), covered by the holiday-group.deleted event below rather than per-row holiday.deleted events.
    const [deleted] = await tx
      .delete(holidayGroup)
      .where(eq(holidayGroup.id, p.id))
      .returning({
        name: holidayGroup.name,
        states: holidayGroup.states,
        parentGroupId: holidayGroup.parentGroupId,
      });
    if (!deleted) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'holiday-group',
      aggregateId: p.id,
      eventType: 'holiday-group.deleted',
      actor: actorOf(ctx),
      payload: { name: deleted.name, states: deleted.states, parentGroupId: deleted.parentGroupId },
    });
  });
}

/** R18 a519a96e — one row of a group's EFFECTIVE calendar as shown on the admin Holidays screen.
 *  `source` drives the UI: 'own' rows belong to the group itself (editable); 'inherited' rows come from
 *  the parent group's extras, the gazette, or company ad-hoc days (read-only, "Inherited" badge). */
export type EffectiveGroupHolidayRow = {
  id: string;
  country: string;
  state: string | null;
  companyId: string | null;
  companyName: string | null;
  holidayGroupId: string | null;
  holidayDate: string;
  name: string;
  tentative: boolean;
  source: 'own' | 'inherited';
};

/**
 * R18 a519a96e — the EFFECTIVE calendar of a holiday group, resolved the same way holidayDatesFor
 * composes it (resolve-at-read; nothing is copied):
 *
 *   own group-scoped extras
 *   ∪ parent group's own extras                       (when a parent is set)
 *   ∪ gazette: national ∪ base.states                 (base = parent if set, else the group; skipped for
 *                                                      a 'custom' base — custom ignores the gazette)
 *   ∪ company ad-hoc rows                             (for an 'extended'/'custom' base — shown so the admin
 *                                                      sees the full extended calendar; which of these apply
 *                                                      to a given employee depends on their company chain)
 *
 * Because the parent is read LIVE, a holiday added to the parent group appears here (and in every linked
 * location's resolution) immediately — the reporter's Step-5 auto-sync. Read-only — no event.
 */
export function listGroupEffectiveHolidays(ctx: SessionContext, p: { groupId: string; year?: number }) {
  const parentGroup = alias(holidayGroup, 'parent_group');
  return withTenant(ctx, async (tx) => {
    const [g] = await tx
      .select({
        id: holidayGroup.id,
        name: holidayGroup.name,
        states: holidayGroup.states,
        archetype: holidayGroup.archetype,
        parentGroupId: holidayGroup.parentGroupId,
        parentName: parentGroup.name,
        parentStates: parentGroup.states,
        parentArchetype: parentGroup.archetype,
      })
      .from(holidayGroup)
      .leftJoin(parentGroup, eq(parentGroup.id, holidayGroup.parentGroupId))
      .where(eq(holidayGroup.id, p.groupId))
      .limit(1);
    if (!g) throw new Error('Holiday group not found');
    // With a parent, the parent's archetype + states ARE the gazette source (the child only adds extras).
    const baseArchetype = (g.parentGroupId ? g.parentArchetype : g.archetype) as HolidayGroupArchetype;
    const baseStates: string[] = g.parentGroupId
      ? Array.isArray(g.parentStates)
        ? (g.parentStates as string[])
        : []
      : Array.isArray(g.states)
        ? (g.states as string[])
        : [];

    const scopes = [eq(holiday.holidayGroupId, g.id)];
    if (g.parentGroupId) scopes.push(eq(holiday.holidayGroupId, g.parentGroupId));
    if (baseArchetype !== 'custom') {
      // Gazette half: national ∪ the base states (custom deliberately excludes the gazette).
      scopes.push(
        and(
          isNull(holiday.companyId),
          isNull(holiday.holidayGroupId),
          baseStates.length ? or(isNull(holiday.state), inArray(holiday.state, baseStates)) : isNull(holiday.state),
        )!,
      );
    }
    if (baseArchetype !== 'standard') {
      // Extended/custom calendars union the company-defined ad-hoc days (per-employee the resolver narrows
      // these to the employee's company chain; the admin view shows them all, labelled with the company).
      scopes.push(sql`${holiday.companyId} IS NOT NULL`);
    }
    const rows = await tx
      .select({
        id: holiday.id,
        country: holiday.country,
        state: holiday.state,
        companyId: holiday.companyId,
        companyName: company.legalName,
        holidayGroupId: holiday.holidayGroupId,
        holidayDate: holiday.holidayDate,
        name: holiday.name,
        tentative: holiday.tentative,
      })
      .from(holiday)
      .leftJoin(company, eq(company.id, holiday.companyId))
      .where(
        and(
          or(...scopes),
          p.year ? sql`extract(year from ${holiday.holidayDate}) = ${p.year}` : undefined,
        ),
      )
      .orderBy(holiday.holidayDate);
    return {
      group: { id: g.id, name: g.name, parentGroupId: g.parentGroupId, parentName: g.parentName },
      rows: rows.map(
        (r): EffectiveGroupHolidayRow => ({ ...r, source: r.holidayGroupId === g.id ? 'own' : 'inherited' }),
      ),
    };
  });
}

/**
 * The logins on the Users & roles screen (0279). Hidden-by-default lifecycle, matching the
 * `includeArchived` shape listCompanies/listJobGrades use in core/read.ts.
 *
 * Two ways a row is "switched off", surfaced as one status but distinguished by cause:
 *   • archivedAt set          → "Archived by an administrator", and Restore is offered.
 *   • blockedByTermination    → "Left the company". No Restore: the unwind is clearing the end dates
 *                               on the employment record, which restores access by itself.
 *
 * blockedByTermination is derived here through isLoginBlocked(), the SAME rule app.login_blocked()
 * enforces in SQL, so the screen can never claim someone has access that the auth path refuses (or
 * vice versa). test/user-lifecycle.test.ts pins the two against each other across a matrix.
 *
 * `name`/`email` come only from the joined person. Deliberately NOT falling back to the invitation
 * email: test/pdpa-erasure.test.ts erases person rows, and surfacing a retained invitation email for
 * an erased person would re-expose exactly what erasure removed. Such a row renders as an unlinked
 * login instead.
 */
export function listUsers(ctx: SessionContext, opts: { includeArchived?: boolean } = {}) {
  return withTenant(ctx, async (tx) => {
    const users = await tx
      .select({
        id: appUser.id,
        workosUserId: appUser.workosUserId,
        personId: appUser.personId,
        name: person.fullName,
        email: person.primaryEmail,
        archivedAt: appUser.archivedAt,
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
    // Every employment of every linked person, in one read, so the block predicate runs in TS.
    const personIds = users.map((u) => u.personId).filter((v): v is string => Boolean(v));
    const emps = personIds.length
      ? await tx
          .select({
            personId: employment.personId,
            resignationDate: employment.resignationDate,
            lastWorkingDate: employment.lastWorkingDate,
            terminatedOn: employment.terminatedOn,
            blacklistedAt: employment.blacklistedAt,
          })
          .from(employment)
          .where(inArray(employment.personId, personIds))
      : [];
    const rows = users.map((u) => {
      const mine = u.personId ? emps.filter((e) => e.personId === u.personId) : [];
      return {
        ...u,
        roles: roles.filter((r) => r.appUserId === u.id),
        // Blocked purely by the employment dates — archivedAt is reported separately so the UI can
        // tell the two causes apart and only offer Restore for the manual one.
        blockedByTermination: isLoginBlocked({ archivedAt: null, employments: mine }),
      };
    });
    const visible = opts.includeArchived
      ? rows
      : rows.filter((r) => !r.archivedAt && !r.blockedByTermination);
    // The count of rows the default view omits, so the screen never silently drops a set.
    return { users: visible, hiddenCount: rows.length - visible.length };
  });
}

// ───────────────── Edit + state-aware remove (delete if unused, else archive) ─────────────────

export async function updateDepartment(
  ctx: SessionContext,
  p: { id: string; name: string; businessUnitId?: string | null; headEmploymentId?: string | null; description?: string },
) {
  const name = cleanName(p.name, 'Department name');
  // description always overwrites (like name), stored null when blank — no tri-state.
  const description = p.description?.trim() || null;
  return withTenant(ctx, async (tx) => {
    // businessUnitId + headEmploymentId are tri-state: undefined → leave the column untouched (a name-only
    // rename must NOT wipe them); null/'' → clear it; an id → set it (validated to the department's own
    // company). Fetch the department's company once when either is supplied.
    const setValues: {
      name: string;
      description: string | null;
      businessUnitId?: string | null;
      headEmploymentId?: string | null;
    } = { name, description };
    if (p.businessUnitId !== undefined || p.headEmploymentId !== undefined) {
      const [dep] = await tx
        .select({ companyId: department.companyId })
        .from(department)
        .where(eq(department.id, p.id))
        .limit(1);
      if (!dep) throw new Error('Department not found');
      if (p.businessUnitId !== undefined) {
        setValues.businessUnitId = await resolveDepartmentBusinessUnitId(tx, p.businessUnitId, dep.companyId);
      }
      if (p.headEmploymentId !== undefined) {
        // 6fadb036: the head (a `department_head` approval decider) must be an employment in the SAME
        // company as the department (mirrors ADR-0071 §i same-company guard for org-chart approvers).
        setValues.headEmploymentId = await resolveHeadEmploymentId(tx, p.headEmploymentId, dep.companyId);
      }
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

export async function updatePosition(ctx: SessionContext, p: { id: string; title: string; jobFamily?: string; description?: string }) {
  const title = cleanName(p.title, 'Position title');
  const description = p.description?.trim() || null;
  return withTenant(ctx, async (tx) => {
    await tx.update(position).set({ title, jobFamily: p.jobFamily?.trim() || null, description }).where(eq(position.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError(`A position titled “${title}” already exists in this company.`);
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'position', aggregateId: p.id, eventType: 'position.updated', actor: actorOf(ctx), payload: { title, description } });
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

export async function updateCostCenter(ctx: SessionContext, p: { id: string; code: string; name: string; description?: string }) {
  const code = cleanName(p.code, 'Cost-center code');
  const name = cleanName(p.name, 'Cost-center name');
  const description = p.description?.trim() || null;
  return withTenant(ctx, async (tx) => {
    await tx.update(costCenter).set({ code, name, description }).where(eq(costCenter.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError(`A cost center with code “${code}” already exists in this company.`);
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'cost-center', aggregateId: p.id, eventType: 'cost-center.updated', actor: actorOf(ctx), payload: { code, description } });
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

export async function updateBusinessUnit(
  ctx: SessionContext,
  p: { id: string; code: string; name: string; headEmploymentId?: string | null; description?: string },
) {
  const code = cleanName(p.code, 'Business-unit code');
  const name = cleanName(p.name, 'Business-unit name');
  const description = p.description?.trim() || null;
  return withTenant(ctx, async (tx) => {
    // headEmploymentId is tri-state (undefined ⇒ untouched; blank ⇒ clear; id ⇒ set, same-company-validated).
    const setValues: { code: string; name: string; description: string | null; headEmploymentId?: string | null } = {
      code,
      name,
      description,
    };
    if (p.headEmploymentId !== undefined) {
      const [bu] = await tx
        .select({ companyId: businessUnit.companyId })
        .from(businessUnit)
        .where(eq(businessUnit.id, p.id))
        .limit(1);
      if (!bu) throw new Error('Business unit not found');
      setValues.headEmploymentId = await resolveHeadEmploymentId(tx, p.headEmploymentId, bu.companyId);
    }
    await tx.update(businessUnit).set(setValues).where(eq(businessUnit.id, p.id)).catch((e) => {
      if (isUniqueViolation(e)) throw new DuplicateError(`A business unit with code “${code}” already exists in this company.`);
      throw e;
    });
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'business-unit', aggregateId: p.id, eventType: 'business-unit.updated', actor: actorOf(ctx), payload: { code, description } });
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

// ── System Labels grid: atomic bulk save (Excel-style edit → one Save) ───────────────────────────────
// Feedback 62de487d. The grid lets an admin edit many rows and add new ones, then Save commits them ALL
// in ONE transaction (Requirement 4: "all changes are saved in a single transaction"). Each row keeps
// its OWN DomainEvent (department.created / position.updated / …) — SUBSTRATE DISCIPLINE: the audit
// trail stays per-aggregate, one event per changed label. Any validation failure (duplicate code /
// missing mandatory field / cross-company BU / non-group-admin trying to set Global) aborts the WHOLE
// transaction (throw → rollback) and returns the offending rows so the grid can highlight them.

export type LabelKindStr = 'department' | 'position' | 'cost_center' | 'business_unit';

/** One new row to create. `key` is the client's row key, echoed back on any error for row highlighting. */
export type LabelCreateInput = {
  key: string;
  companyId: string;
  isGlobal?: boolean;
  code?: string;
  name?: string;
  title?: string;
  jobFamily?: string;
  businessUnitId?: string | null;
  // 6fadb036: department / business-unit head (approval routing target). Ignored for other kinds.
  headEmploymentId?: string | null;
  // 797e3523: optional short code / abbreviation shown in the System Labels grid.
  label?: string;
  description?: string;
};
/** One existing row to update. `archived` toggles the soft-archive; scope (isGlobal) is applied too. */
export type LabelUpdateInput = {
  key: string;
  id: string;
  isGlobal?: boolean;
  archived?: boolean;
  code?: string;
  name?: string;
  title?: string;
  jobFamily?: string;
  businessUnitId?: string | null;
  // 6fadb036: department / business-unit head (approval routing target). Ignored for other kinds.
  headEmploymentId?: string | null;
  // 797e3523: optional short code / abbreviation shown in the System Labels grid.
  label?: string;
  description?: string;
};
export type LabelRowError = { key: string; field?: string; message: string };

/** Thrown to roll the whole bulk-save transaction back; carries the per-row errors for the grid. */
export class LabelBulkError extends Error {
  rowErrors: LabelRowError[];
  constructor(rowErrors: LabelRowError[]) {
    super('One or more label rows are invalid.');
    this.name = 'LabelBulkError';
    this.rowErrors = rowErrors;
  }
}

const KIND_AGG: Record<LabelKindStr, string> = {
  department: 'department',
  position: 'position',
  cost_center: 'cost-center',
  business_unit: 'business-unit',
};

/** Postgres insufficient_privilege (42501) — raised by the app.guard_is_global() trigger when a
 *  non-group-admin tries to set is_global=true. Surfaced as a friendly per-row scope error. */
function isPrivilegeError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '42501';
}

export async function bulkSaveLabels(
  ctx: SessionContext,
  kind: LabelKindStr,
  p: { creates: LabelCreateInput[]; updates: LabelUpdateInput[] },
): Promise<{ created: number; updated: number; createdIds: { key: string; id: string }[] }> {
  const agg = KIND_AGG[kind];
  return withTenant(ctx, async (tx) => {
    const errors: LabelRowError[] = [];
    // Maps each created draft's client key → its new server id so the grid can convert the draft row
    // into a persisted row in place (instead of leaving it as a dirty draft that re-inserts on next Save).
    const createdIds: { key: string; id: string }[] = [];
    let created = 0;
    let updated = 0;

    // Field validation shared by create + update; returns cleaned values or pushes a row error.
    const clean = (
      key: string,
      raw: string | undefined,
      field: string,
      label: string,
      required: boolean,
    ): string | null => {
      const v = (raw ?? '').trim();
      if (!v) {
        if (required) errors.push({ key, field, message: `${label} is required.` });
        return null;
      }
      return v;
    };

    for (const c of p.creates) {
      try {
        if (kind === 'department') {
          const name = clean(c.key, c.name, 'name', 'Department name', true);
          if (!name) continue;
          const businessUnitId = await resolveDepartmentBusinessUnitId(tx, c.businessUnitId, c.companyId);
          // 6fadb036: same-company-validated head (blank ⇒ null).
          const headEmploymentId = await resolveHeadEmploymentId(tx, c.headEmploymentId, c.companyId);
          const [row] = await tx
            .insert(department)
            .values({ tenantId: ctx.tenantId, companyId: c.companyId, name, businessUnitId, headEmploymentId, label: c.label?.trim() || null, description: c.description?.trim() || null, isGlobal: c.isGlobal ?? false })
            .returning({ id: department.id });
          createdIds.push({ key: c.key, id: row.id });
          await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: agg, aggregateId: row.id, eventType: 'department.created', actor: actorOf(ctx), payload: { companyId: c.companyId, name, isGlobal: c.isGlobal ?? false } });
        } else if (kind === 'position') {
          const title = clean(c.key, c.title, 'title', 'Position title', true);
          if (!title) continue;
          const [row] = await tx
            .insert(position)
            .values({ tenantId: ctx.tenantId, companyId: c.companyId, title, jobFamily: c.jobFamily?.trim() || null, label: c.label?.trim() || null, description: c.description?.trim() || null, isGlobal: c.isGlobal ?? false })
            .returning({ id: position.id });
          createdIds.push({ key: c.key, id: row.id });
          await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: agg, aggregateId: row.id, eventType: 'position.created', actor: actorOf(ctx), payload: { companyId: c.companyId, title, isGlobal: c.isGlobal ?? false } });
        } else if (kind === 'cost_center') {
          const code = clean(c.key, c.code, 'code', 'Cost-center code', true);
          const name = clean(c.key, c.name, 'name', 'Cost-center name', true);
          if (!code || !name) continue;
          const [row] = await tx
            .insert(costCenter)
            .values({ tenantId: ctx.tenantId, companyId: c.companyId, code, name, label: c.label?.trim() || null, description: c.description?.trim() || null, isGlobal: c.isGlobal ?? false })
            .returning({ id: costCenter.id });
          createdIds.push({ key: c.key, id: row.id });
          await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: agg, aggregateId: row.id, eventType: 'cost-center.created', actor: actorOf(ctx), payload: { companyId: c.companyId, code, isGlobal: c.isGlobal ?? false } });
        } else {
          const code = clean(c.key, c.code, 'code', 'Business-unit code', true);
          const name = clean(c.key, c.name, 'name', 'Business-unit name', true);
          if (!code || !name) continue;
          // 6fadb036: same-company-validated head (blank ⇒ null).
          const headEmploymentId = await resolveHeadEmploymentId(tx, c.headEmploymentId, c.companyId);
          const [row] = await tx
            .insert(businessUnit)
            .values({ tenantId: ctx.tenantId, companyId: c.companyId, code, name, headEmploymentId, label: c.label?.trim() || null, description: c.description?.trim() || null, isGlobal: c.isGlobal ?? false })
            .returning({ id: businessUnit.id });
          createdIds.push({ key: c.key, id: row.id });
          await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: agg, aggregateId: row.id, eventType: 'business-unit.created', actor: actorOf(ctx), payload: { companyId: c.companyId, code, isGlobal: c.isGlobal ?? false } });
        }
        created++;
      } catch (e) {
        if (isUniqueViolation(e)) errors.push({ key: c.key, field: kind === 'department' || kind === 'position' ? (kind === 'department' ? 'name' : 'title') : 'code', message: 'A label with this code / name already exists in the company.' });
        else if (isPrivilegeError(e)) errors.push({ key: c.key, field: 'scope', message: 'Only a group admin can make a label global.' });
        // 6fadb036: CrossCompanyError('employment') comes from the head guard — highlight the Head cell.
        else if (e instanceof CrossCompanyError) errors.push({ key: c.key, field: e.message.includes('employment') ? 'headEmploymentId' : 'businessUnitId', message: e.message });
        else throw e;
      }
    }

    for (const u of p.updates) {
      try {
        if (kind === 'department') {
          const name = clean(u.key, u.name, 'name', 'Department name', true);
          if (!name) continue;
          const set: { name: string; label: string | null; description: string | null; isGlobal?: boolean; businessUnitId?: string | null; headEmploymentId?: string | null; archivedAt?: ReturnType<typeof sql> | null } = { name, label: u.label?.trim() || null, description: u.description?.trim() || null };
          if (u.isGlobal !== undefined) set.isGlobal = u.isGlobal;
          if (u.businessUnitId !== undefined || u.headEmploymentId !== undefined) {
            const [dep] = await tx.select({ companyId: department.companyId }).from(department).where(eq(department.id, u.id)).limit(1);
            if (dep) {
              if (u.businessUnitId !== undefined) set.businessUnitId = await resolveDepartmentBusinessUnitId(tx, u.businessUnitId, dep.companyId);
              // 6fadb036: tri-state head — undefined ⇒ untouched; blank ⇒ clear; id ⇒ same-company-validated.
              if (u.headEmploymentId !== undefined) set.headEmploymentId = await resolveHeadEmploymentId(tx, u.headEmploymentId, dep.companyId);
            }
          }
          if (u.archived !== undefined) set.archivedAt = u.archived ? sql`now()` : null;
          await tx.update(department).set(set).where(eq(department.id, u.id));
          await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: agg, aggregateId: u.id, eventType: 'department.updated', actor: actorOf(ctx), payload: { name, isGlobal: u.isGlobal, archived: u.archived } });
        } else if (kind === 'position') {
          const title = clean(u.key, u.title, 'title', 'Position title', true);
          if (!title) continue;
          const set: { title: string; jobFamily: string | null; label: string | null; description: string | null; isGlobal?: boolean; archivedAt?: ReturnType<typeof sql> | null } = { title, jobFamily: u.jobFamily?.trim() || null, label: u.label?.trim() || null, description: u.description?.trim() || null };
          if (u.isGlobal !== undefined) set.isGlobal = u.isGlobal;
          if (u.archived !== undefined) set.archivedAt = u.archived ? sql`now()` : null;
          await tx.update(position).set(set).where(eq(position.id, u.id));
          await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: agg, aggregateId: u.id, eventType: 'position.updated', actor: actorOf(ctx), payload: { title, isGlobal: u.isGlobal, archived: u.archived } });
        } else if (kind === 'cost_center') {
          const code = clean(u.key, u.code, 'code', 'Cost-center code', true);
          const name = clean(u.key, u.name, 'name', 'Cost-center name', true);
          if (!code || !name) continue;
          const set: { code: string; name: string; label: string | null; description: string | null; isGlobal?: boolean; archivedAt?: ReturnType<typeof sql> | null } = { code, name, label: u.label?.trim() || null, description: u.description?.trim() || null };
          if (u.isGlobal !== undefined) set.isGlobal = u.isGlobal;
          if (u.archived !== undefined) set.archivedAt = u.archived ? sql`now()` : null;
          await tx.update(costCenter).set(set).where(eq(costCenter.id, u.id));
          await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: agg, aggregateId: u.id, eventType: 'cost-center.updated', actor: actorOf(ctx), payload: { code, isGlobal: u.isGlobal, archived: u.archived } });
        } else {
          const code = clean(u.key, u.code, 'code', 'Business-unit code', true);
          const name = clean(u.key, u.name, 'name', 'Business-unit name', true);
          if (!code || !name) continue;
          const set: { code: string; name: string; label: string | null; description: string | null; isGlobal?: boolean; headEmploymentId?: string | null; archivedAt?: ReturnType<typeof sql> | null } = { code, name, label: u.label?.trim() || null, description: u.description?.trim() || null };
          if (u.isGlobal !== undefined) set.isGlobal = u.isGlobal;
          // 6fadb036: tri-state head — undefined ⇒ untouched; blank ⇒ clear; id ⇒ same-company-validated.
          if (u.headEmploymentId !== undefined) {
            const [bu] = await tx.select({ companyId: businessUnit.companyId }).from(businessUnit).where(eq(businessUnit.id, u.id)).limit(1);
            if (bu) set.headEmploymentId = await resolveHeadEmploymentId(tx, u.headEmploymentId, bu.companyId);
          }
          if (u.archived !== undefined) set.archivedAt = u.archived ? sql`now()` : null;
          await tx.update(businessUnit).set(set).where(eq(businessUnit.id, u.id));
          await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: agg, aggregateId: u.id, eventType: 'business-unit.updated', actor: actorOf(ctx), payload: { code, isGlobal: u.isGlobal, archived: u.archived } });
        }
        updated++;
      } catch (e) {
        if (isUniqueViolation(e)) errors.push({ key: u.key, field: kind === 'department' ? 'name' : kind === 'position' ? 'title' : 'code', message: 'A label with this code / name already exists in the company.' });
        else if (isPrivilegeError(e)) errors.push({ key: u.key, field: 'scope', message: 'Only a group admin can make a label global.' });
        // 6fadb036: CrossCompanyError('employment') comes from the head guard — highlight the Head cell.
        else if (e instanceof CrossCompanyError) errors.push({ key: u.key, field: e.message.includes('employment') ? 'headEmploymentId' : 'businessUnitId', message: e.message });
        else throw e;
      }
    }

    if (errors.length) throw new LabelBulkError(errors); // rollback everything — atomic save.
    return { created, updated, createdIds };
  });
}

/**
 * Turn a company's Shared System Labels feature ON/OFF (the resolver switch). OFF (default) = origin-only
 * for that company; ON = it also sees global + labels shared into it. RLS on `company` already requires
 * admin-for-company to write. Substrate: append a company-level event.
 */
export async function setCompanySharedLabels(ctx: SessionContext, p: { companyId: string; enabled: boolean }) {
  return withTenant(ctx, async (tx) => {
    await tx.update(company).set({ sharedSystemLabels: p.enabled }).where(eq(company.id, p.companyId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.companyId,
      eventType: p.enabled ? 'company.shared-labels.enabled' : 'company.shared-labels.disabled',
      actor: actorOf(ctx),
      payload: { enabled: p.enabled },
    });
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

/** Day Type Inclusion (feedback ef6d7146): normalise the five-toggle re-inclusion vector. undefined ⇒
 *  untouched (tri-state). null ⇒ clear. An object is coerced to strict booleans on the closed key set; an
 *  ALL-FALSE result collapses to null — it is exactly today's working_days behaviour (nothing re-included),
 *  so storing null keeps the counting kernel on its byte-identical legacy path (normalizeDayTypeInclusion). */
function cleanDayTypeInclusion(
  v: DayTypeInclusion | null | undefined,
): DayTypeInclusion | null | undefined {
  if (v === undefined) return undefined;
  if (v == null) return null;
  const r: DayTypeInclusion = {
    offDay: v.offDay === true,
    restDay: v.restDay === true,
    publicHoliday: v.publicHoliday === true,
    companyHoliday: v.companyHoliday === true,
    shutdownDay: v.shutdownDay === true,
  };
  const anyTrue = r.offDay || r.restDay || r.publicHoliday || r.companyHoliday || r.shutdownDay;
  return anyTrue ? r : null;
}

/** Supporting-document config: the closed set of mime types an admin may allow. No generic ceiling. */
const DOC_MIME_SET = ['application/pdf', 'image/jpeg', 'image/png'] as const;
const MAX_DOC_BYTES_CEILING = 10 * 1024 * 1024; // the feedback fixes the max at 10 MB

/**
 * Custom validation messages (custom-messages migration): the fixed allow-list of rule keys an admin may
 * author an override message for. Keyed by the same camelCase field name as the rule's config column, so
 * the "which rule → which message" mapping is self-evident. Two rules exist today — the backdating limit
 * (0133) and the minimum advance-notice rule (0159); a future validation rule adds its config-field name
 * here (and the LeaveType schema comment). Each message is capped at CUSTOM_MESSAGE_MAX_LEN characters
 * (enforced in the service, not the DB).
 */
// `applyNotice` (feedback 9d8cf621) is an APPLY-TIME custom message — not a block message. It rides the
// same customMessages JSONB + merge convention so no migration/column is needed: an empty value removes the
// key (message disabled), a non-empty value stores the HR-authored notice shown to employees on the apply form.
const CUSTOM_MESSAGE_RULE_KEYS = ['backdatingLimitDays', 'minAdvanceDays', 'applyNotice'] as const;
const CUSTOM_MESSAGE_MAX_LEN = 500;

export async function updateLeaveType(
  ctx: SessionContext,
  p: {
    id: string;
    name: string;
    // Edit Leave Type Code (feedback a7194511): OPTIONAL new code, forwarded ONLY by the identity/rename
    // sub-form and ONLY for NON-statutory types (the UI keeps the field readOnly + name-less for statutory
    // codes, so nothing is posted for them). undefined ⇒ code column untouched (tri-state). When present and
    // different from the current code the service (a) refuses if the CURRENT code is statutory/EMERGENCY —
    // those are locked because the code is the semantic key EA-1955 matching, carry-forward and encashment
    // resolve on; (b) normalizes + shape-validates; (c) rejects a duplicate (case-insensitive, active,
    // non-self); (d) refuses renaming TO a statutory/EMERGENCY code; (e) persists it + records before/after
    // in the leave-type.updated event. All FK relations key on leave_type_id, so a code rename never orphans
    // ledger rows, requests, policies or history.
    newCode?: string;
    // Leave Type master page (feedback 097de541): optional description edited from the identity sub-form.
    // OWN tri-state (undefined = column untouched), exactly like backdatingLimitDays — the identity form posts
    // a hidden `identity=1` marker so an unrelated sub-form save never touches this column. Empty string ⇒
    // null (never store ""); an explicit null clears it.
    description?: string | null;
    eligibility?: LeaveEligibility | null;
    // Probation eligibility (d6bdbd55): OWN tri-state (undefined = probation_eligibility column untouched),
    // posted alongside the eligibility sub-form. null ⇒ clear (no restriction); 'confirmed_only' /
    // 'probation_only' set the rule. Validated against the closed set (the DB CHECK is defence-in-depth).
    probationEligibility?: ProbationEligibility | null;
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
    // Minimum advance-notice rule (0159): how many days BEFORE its start date a leave of this type must be
    // submitted. OWN tri-state (undefined = leave column), mirroring backdatingLimitDays above — it is a
    // request-validation rule with its own sub-form, so an unrelated save must not touch it and the audit
    // diff must label it correctly.
    minAdvanceDays?: number | null;
    // Advance Notice — calendar days or working days (7daac043, migration 0447): the UNIT the requirement
    // above is read in. It rides minAdvanceDays' tri-state marker rather than carrying its own — the two are
    // ONE decision (a unit with no figure configures the reading of a rule that does not exist), exactly as
    // maxDaysPeriod rides maxDaysPerLeaveYear's. So: minAdvanceDays undefined ⇒ BOTH columns untouched;
    // minAdvanceDays null ⇒ both cleared; a figure ⇒ the figure plus this unit (null ⇒ calendar days, the
    // reading every existing row already takes).
    minAdvanceDayType?: 'calendar_days' | 'working_days' | null;
    // Application Limits (feedback c6ffa725, migration 0335): the maximum total days an employee may APPLY
    // for of this type within one leave year, regardless of entitlement balance. OWN tri-state (undefined =
    // leave column untouched), mirroring backdatingLimitDays — it has its own sub-form, so an unrelated
    // save must not touch it and the audit diff must label it correctly. null ⇒ Unlimited, which is what
    // every existing leave type means.
    maxDaysPerLeaveYear?: number | null;
    // ad9cb5c5 (migration 0352): the PERIOD the ceiling above is measured over — 'leave_year' (the default,
    // and what null means) | 'calendar_year' | 'employment'. Rides the SAME tri-state marker as
    // maxDaysPerLeaveYear rather than carrying its own, because the two are one decision: a period without
    // a ceiling configures the window of a limit that does not exist, and migration 0352 refuses that pair
    // in the database. One marker means the sub-form cannot post half of it.
    maxDaysPeriod?: string | null;
    // Maximum Consecutive Leave (c6ffa725 revision 2, migration 0343): the OTHER half of the same request —
    // the longest SINGLE application this type allows, and the unit that figure is read in. OWN tri-state,
    // and an ALL-OR-NOTHING PAIR: both undefined ⇒ columns untouched; both null ⇒ Unlimited (what every
    // existing leave type means); a figure + a unit ⇒ Limited. A half-set pair is rejected — "maximum 3" of
    // what is not answerable, and a unit with no figure is inert configuration that looks set.
    maxConsecutiveDays?: number | null;
    maxConsecutiveUnit?: 'calendar_days' | 'working_days' | null;
    // Partial Leave Approval (ADR-0068): expose per_date_approval as an editable toggle. OWN tri-state
    // (undefined = leave column untouched), mirroring sendToPayroll/backdating — its own sub-form so an
    // unrelated rename/doc/payroll save never silently resets it. The gate (single-step company + full-day
    // + working-days) is enforced at requestLeave time; this only stores the opt-in.
    perDateApproval?: boolean;
    // Custom validation messages (custom-messages migration): admin-authored override text keyed by the
    // rule's config field name (currently only `backdatingLimitDays`). OWN tri-state (undefined = leave
    // column). This is a read-then-patch-then-write on a SHARED JSONB column: we merge the caller's keys
    // onto whatever is already stored so a save that touches only one rule's message never clobbers
    // another rule's message. Any future writer of this column MUST follow the same merge-in-transaction
    // convention. Each message is capped at 500 chars and only known rule keys are accepted.
    customMessages?: Record<string, string> | null;
    // Employee Leave View Configuration (feedback 65dec703 / dup 1fedb473): which ESS breakdown components an
    // employee may see for this leave type. OWN tri-state (undefined = ess_view_config column untouched),
    // mirroring perDateApproval — its own sub-form posts `essView=1` so an unrelated save never resets it.
    // A full { key: boolean } map is REPLACED wholesale (not merged): the admin checklist always posts the
    // complete set of known keys, so there is no partial-key clobber risk (unlike customMessages). null ⇒
    // clear (revert to all-visible default). Every key MUST be in the closed allow-list (core/ess-view.ts);
    // an unknown key is rejected. Value false ⇒ hidden in ESS; missing/true ⇒ visible.
    essViewConfig?: EssViewConfig | null;
    // Leave Entitlement Formula Management (feedback 79011509, consolidated by 2bc2f2a3): HR-authored
    // per-component explanation store. OWN tri-state (undefined = formula_explanations column untouched),
    // mirroring essViewConfig — the merged view-configuration sub-form posts `formula=1` (alongside
    // `essView=1`) so an unrelated save never resets it. The full { key: entry } map is REPLACED wholesale
    // (the editor always posts the complete key set). Each entry's free-text fields are trimmed; blank fields
    // (and all-blank entries) are dropped; an empty result ⇒ null (clear). Every key MUST be in the closed
    // allow-list (core/leave-formula.ts LEAVE_EXPLANATION_KEYS — the 7 legacy calc-breakdown keys ∪ every
    // ess-view key); an unknown key is rejected. Explanation layer only — never read for entitlement /
    // accrual / eligibility / workflow / payroll.
    formulaExplanations?: LeaveFormulaConfig | null;
    // Day Type Inclusion (feedback ef6d7146): the five-toggle re-inclusion vector { offDay, restDay,
    // publicHoliday, companyHoliday, shutdownDay }. OWN tri-state (undefined = day_type_inclusion column
    // untouched), mirroring essViewConfig — its own "Day Type Inclusion" sub-form posts `dayTypeInclusion=1`
    // so an unrelated save never resets it. null ⇒ clear (revert to the counting-mode default). An all-false
    // vector is normalised to null (≡ working_days behaviour, so the counting kernel stays on its legacy
    // byte-identical path). See core/leave.ts dayWeight / normalizeDayTypeInclusion.
    dayTypeInclusion?: DayTypeInclusion | null;
    // Leave Type Visual Configuration Enhancement (feedback 639fdf77): OPTIONAL, DISPLAY-ONLY colour theme +
    // icon shown on the employee self-service Leave tab. OWN tri-state (undefined = column untouched),
    // mirroring perDateApproval/essViewConfig — the visual sub-form posts `visual=1` so an unrelated save
    // never resets them. color must be in the 7-token allow-list (lib/leave-visual.ts) or null/'' to clear;
    // icon must be a known icon-registry key or null/'' to clear. NEVER read for entitlement / eligibility /
    // workflow / calculation — purely cosmetic. Empty string ⇒ null (never store '').
    color?: string | null;
    icon?: string | null;
    // Leave Unit Configuration (e4980382): whether this type is managed in Days or Hours. OWN tri-state
    // (undefined = leave_unit column untouched), mirroring perDateApproval/visual — its own "Leave Unit"
    // sub-form posts `leaveUnit=1` so an unrelated save never resets it. Validated against { day, hour }.
    // Coarse labelling/reporting only — never read for entitlement / accrual / workflow / payroll.
    leaveUnit?: 'day' | 'hour';
    // Leave Year Type override (e1a51aea): this type's per-type leave-cycle override — 'a2a' (Anniversary
    // to Anniversary ⇒ the existing anniversary semantics) | 'c2c' (Calendar to Calendar ⇒ the existing
    // calendar semantics) | null (clear ⇒ follow the company cycle, today's behaviour). OWN tri-state
    // (undefined = year_cycle_override column untouched), mirroring leaveUnit — the "Leave Year Type"
    // sub-step posts `yearCycle=1` so an unrelated save never resets it. f3a64d90 added the third live
    // value 'a2c' (Anniversary to Calendar): its leave YEAR is the calendar year, and in the employee's
    // HIRE year ANNUAL builds day by day from the join date at (entitlement ÷ 365) × days worked. Saving
    // a move TO or FROM 'a2c' immediately re-corrects everyone on the type (reprojectA2cEntitlement, same
    // transaction) — HR never has to touch records one by one. Validated against the closed live set (the
    // DB CHECK, widened by migration 0310, is defence-in-depth).
    yearCycleOverride?: string | null;
    /** f3a64d90: tenant-local (MYT) "today" anchoring the a2c day-by-day correction fired on an override
     *  change. The action layer passes it; tests pass a fixed date. Defaults to todayInKualaLumpur(). */
    asOf?: string;
    // Leave Type Employee Visibility (feedback 7b11f1c1; contract narrowed by 464b58e6). Both remain
    // tri-state (undefined = column untouched, null = clear), but they are no longer BOTH posted from one
    // sub-form and the old wording here described a form that no longer exists:
    //   · `employeeCanApply` is what the Employee Visibility sub-form posts, and now the ONLY thing it
    //     posts — its `visibility=1` marker still stops an unrelated save resetting it.
    //   · `visibleToEmployee` is written from the Employee Tab Placement select alone. It stayed the one
    //     hidden mechanism (resolvePlacement reads it); 464b58e6 removed the second control that also
    //     wrote it, which is the duplication that item exists to remove. A caller may still set it
    //     directly — this is the service contract, not the form's.
    // STATUTORY SAFETY: employeeCanApply=false is REJECTED for a statutory-entitlement type, because an
    // employee must always be able to exercise a lawful entitlement. THAT TEST IS ROLE-FIRST, NOT
    // CODE-FIRST — it has been since 65f466e2, and saying "when the type's code is ANNUAL / SICK / …" was
    // the stale sentence behind this whole item: production's types are coded MTL, PTL and EL while
    // carrying role maternity / paternity / emergency, so a code-only reading called them ordinary, left
    // the box editable, and refused only after Save. lib/leave-statutory.ts now mirrors this precedence
    // client-side so the screen locks the box for the same set the service refuses.
    // Gating applies ONLY to /me reads + requestLeave; admin/HR reads are never gated.
    visibleToEmployee?: boolean | null;
    employeeCanApply?: boolean | null;
    // Leave grouping visibility (feedback b653ac1b): the HR-chosen placement of this leave type on the
    // employee self-service Leave tab — 'primary' | 'secondary' | 'hidden'. OWN tri-state (undefined =
    // untouched), mirroring visibleToEmployee — the placement sub-form posts `placement=1` so an unrelated
    // save never resets it. HIDDEN REUSES THE SINGLE VISIBILITY SWITCH (7b11f1c1): 'hidden' is translated to
    // visible_to_employee=false (never stored in ess_placement, which a DB CHECK constrains to
    // primary|secondary); 'primary'/'secondary' store the value AND set visible_to_employee=true (un-hide);
    // null clears the override (revert to the code-keyed default + un-hide). Presentation/config only — never
    // touches entitlement / accrual / eligibility / workflow / payroll.
    essPlacement?: 'primary' | 'secondary' | 'hidden' | null;
    // Edit Paid/Unpaid on rename (feedback 75953777): the paid/unpaid flag is the payroll-deduction source of
    // truth (schema paid boolean notNull default true). OWN tri-state (undefined = paid column untouched),
    // mirroring perDateApproval — the identity/rename sub-form posts an `identity=1` marker and always forwards
    // a concrete boolean, so an unrelated sub-form save omits paid and the column stays untouched (no silent
    // reset). Applies to FUTURE leave only (paid is read at request/payroll time); historical requests and the
    // ledger are unaffected.
    paid?: boolean;
    // Duplicate Leave Application Restriction (feedback d5e51c34): the same-date double-booking policy for this
    // leave type. OWN tri-state (undefined = duplicate_application_policy column untouched), mirroring
    // perDateApproval — its own "Duplicate leave applications" sub-form posts `duplicatePolicy=1` so an
    // unrelated save never resets it. Validated against the closed { allow, restrict_same, restrict_any } set
    // (the DB CHECK is defence-in-depth). Enforced at requestLeave/editLeaveRequest; 'allow' = today's behaviour.
    duplicateApplicationPolicy?: 'allow' | 'restrict_same' | 'restrict_any';
    // Override Leave Application (feedback 56910869, migration 0365): what the system does when one of this
    // type's rules is not met, as an ORDERED list of (trigger, action, enabled) rules. OWN tri-state
    // (undefined = override_rules column untouched), mirroring duplicateApplicationPolicy — its own
    // "Override Leave Application" sub-form posts `overrideRules=1` so an unrelated save never resets it.
    // null (or an empty list) ⇒ no exceptions, which is today's behaviour and every existing row. Validated
    // against the closed trigger/action vocabulary AND against "at most one enabled action per trigger",
    // because two enabled actions for one trigger is a contradiction rather than a precedence question.
    overrideRules?: LeaveOverrideRule[] | null;
    // Configurable Negative Leave Balance Validation (feedback 0ef0defd): whether employees may SUBMIT/EDIT a
    // leave application of this type that exceeds their available balance. OWN tri-state (undefined =
    // allow_negative_balance column untouched), mirroring duplicateApplicationPolicy — its own "Allow Negative
    // Balance" sub-form posts `negativeBalance=1` so an unrelated save never resets it. false = block over-
    // application at submission (the approved default); true = permit going negative. Enforced at
    // requestLeave/editLeaveRequest.
    allowNegativeBalance?: boolean;
    // bc512dc3 (migration 0352): how far negative is too far, as a POSITIVE magnitude (2.5 ⇒ the balance may
    // not pass -2.5). Rides the SAME `negativeBalance=1` marker as allowNegativeBalance — one switch, one
    // floor, one decision — so turning the switch off and leaving a floor behind is unrepresentable. null ⇒
    // unbounded, which is what every existing type with the switch on means today.
    maxNegativeBalance?: number | null;
    // Balance Deduction Source (feedback cdf9ca48): the leave type whose balance an application of THIS type
    // is checked against and debited from. OWN tri-state (undefined = balance_source_type_id untouched) —
    // its own "Balance Deduction Source" sub-form posts `balanceSource=1`. null ⇒ own balance (the default
    // and the way to clear it). Validated INSIDE the transaction (it needs other rows): self-reference and
    // chains in either direction are refused there.
    balanceSourceTypeId?: string | null;
    // Allow Unpaid Leave (feedback a7fab30b): whether an application of this type may exceed the available
    // balance with the excess treated as unpaid leave. OWN tri-state (undefined = allow_unpaid_leave
    // untouched), mirroring allowNegativeBalance — its own sub-form posts `allowUpl=1`. false = today's
    // behaviour. Enforced at requestLeave/editLeaveRequest, settled at approval + payroll.
    allowUnpaidLeave?: boolean;
    /** 4ec5a940 — optional free-text justification, recorded on the audit event payload only. */
    reason?: string | null;
  },
) {
  const name = cleanName(p.name, 'Leave-type name');
  const reason = normalizeReason(p.reason);
  // Edit Leave Type Code (a7194511): normalize the optional new code exactly like createLeaveType (uppercase,
  // spaces → underscores) so the canonical semantic key never drifts, then shape-validate. The statutory-code
  // guard + uniqueness check run inside the transaction below (they need the CURRENT stored code). undefined ⇒
  // code column untouched.
  const touchCode = p.newCode !== undefined;
  let normalizedNewCode: string | undefined;
  if (touchCode) {
    normalizedNewCode = cleanName(p.newCode!, 'Leave-type code').toUpperCase().replace(/ /g, '_');
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(normalizedNewCode)) {
      throw new Error('Leave-type code must be letters, digits or underscores (e.g. ANNUAL)');
    }
  }
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
  // Minimum advance-notice rule (0159): its OWN tri-state, mirroring touchBackdating above — a save from any
  // other sub-form omits minAdvanceDays, so min_advance_days stays untouched (no silent reset).
  const touchMinAdvance = p.minAdvanceDays !== undefined;
  // Application Limits (c6ffa725): its OWN tri-state, mirroring touchBackdating — a save from any other
  // sub-form omits maxDaysPerLeaveYear, so max_days_per_leave_year stays untouched (no silent reset, and no
  // silently-imposed ceiling on a type nobody configured one for).
  const touchApplicationLimits = p.maxDaysPerLeaveYear !== undefined;
  // Maximum Consecutive Leave (c6ffa725 rev 2): its OWN tri-state, separate from touchApplicationLimits
  // above even though the two controls sit in the same card. They are different rules — "how much in a
  // year" and "how much in one go" — and sharing a marker would make a save of one silently clear the
  // other. Touched when EITHER key is present; the sub-form always posts both together.
  const touchMaxConsecutive = p.maxConsecutiveDays !== undefined || p.maxConsecutiveUnit !== undefined;
  // Partial Leave Approval (ADR-0068): its OWN tri-state, mirroring touchPayroll/touchBackdating — a save
  // from any other sub-form omits perDateApproval, so per_date_approval stays untouched (no silent reset).
  const touchPartial = p.perDateApproval !== undefined;
  // Edit Paid/Unpaid on rename (feedback 75953777): its OWN tri-state, mirroring touchPartial — the identity/
  // rename sub-form posts a concrete `paid` boolean, any other save omits it so the paid column stays
  // untouched. Fixes the bug where paid/unpaid was immutable after creation.
  const touchPaid = p.paid !== undefined;
  const paidSet = touchPaid ? { paid: p.paid } : {};
  // Duplicate Leave Application Restriction (d5e51c34): OWN tri-state, mirroring touchPartial — the "Duplicate
  // leave applications" sub-form posts `duplicatePolicy=1`, any other save omits it so the column stays
  // untouched. Validate against the closed 3-value set (the DB CHECK is defence-in-depth).
  const touchDuplicatePolicy = p.duplicateApplicationPolicy !== undefined;
  if (
    touchDuplicatePolicy &&
    !['allow', 'restrict_same', 'restrict_any'].includes(p.duplicateApplicationPolicy!)
  ) {
    throw new Error('Duplicate-application policy must be allow, restrict_same, or restrict_any.');
  }
  const duplicatePolicySet = touchDuplicatePolicy
    ? { duplicateApplicationPolicy: p.duplicateApplicationPolicy }
    : {};
  // Configurable Negative Leave Balance Validation (0ef0defd): OWN tri-state, mirroring touchDuplicatePolicy —
  // the "Allow Negative Balance" sub-form posts `negativeBalance=1`, any other save omits it so
  // allow_negative_balance stays untouched (no silent reset). Plain boolean column (NOT NULL); the sub-form
  // always forwards a concrete boolean when its marker is present.
  const touchNegativeBalance = p.allowNegativeBalance !== undefined;
  const negativeBalanceSet = touchNegativeBalance
    ? {
        allowNegativeBalance: p.allowNegativeBalance,
        // bc512dc3 — the floor rides the same marker, and is FORCED to null when the switch goes off, so the
        // pair migration 0352 refuses (a floor with no permission to go negative) cannot be written.
        maxNegativeBalance:
          p.allowNegativeBalance === true && p.maxNegativeBalance != null
            ? p.maxNegativeBalance.toFixed(2)
            : null,
      }
    : {};
  // Balance Deduction Source (cdf9ca48) / Allow Unpaid Leave (a7fab30b): two OWN tri-states, mirroring
  // touchNegativeBalance. Each has its own sub-form + marker so an unrelated save never resets either. The
  // source's cross-row validation lives in the transaction below (it has to read the candidate source).
  const touchBalanceSource = p.balanceSourceTypeId !== undefined;
  const touchAllowUpl = p.allowUnpaidLeave !== undefined;
  const allowUplSet = touchAllowUpl ? { allowUnpaidLeave: p.allowUnpaidLeave } : {};
  // Custom validation messages (custom-messages migration): OWN tri-state, mirroring touchBackdating. The
  // fixed allow-list of rule keys — currently only the one rule that exists (backdating). A future rule
  // adds its config-field name here and to the LeaveType schema comment.
  const touchCustomMessages = p.customMessages !== undefined;
  // Day Type Inclusion (feedback ef6d7146): OWN tri-state, mirroring touchEssViewConfig — the "Day Type
  // Inclusion" sub-form posts `dayTypeInclusion=1`, any other save omits it so day_type_inclusion stays
  // untouched. The normaliser coerces to strict booleans and collapses an all-false vector to null (inert).
  const touchDayTypeInclusion = p.dayTypeInclusion !== undefined;
  const nextDayTypeInclusion = touchDayTypeInclusion ? cleanDayTypeInclusion(p.dayTypeInclusion) : undefined;
  // Override Leave Application (56910869): OWN tri-state, mirroring touchDayTypeInclusion. Normalised
  // through the SAME reader the engine uses, so a rule that survives the write is exactly a rule the engine
  // will act on — a shape only one of the two accepted would be configuration that silently does nothing.
  // Then validated for the contradiction the normaliser cannot express (two enabled actions on one trigger),
  // which is refused with a readable message rather than resolved by first-wins.
  const touchOverrideRules = p.overrideRules !== undefined;
  const nextOverrideRules = touchOverrideRules ? normalizeLeaveOverrideRules(p.overrideRules ?? []) : undefined;
  if (nextOverrideRules) {
    const problem = validateLeaveOverrideRules(nextOverrideRules);
    if (problem) throw new Error(problem);
  }
  // Leave Unit Configuration (e4980382): OWN tri-state, mirroring touchPartial — the "Leave Unit" sub-form
  // posts `leaveUnit=1`, any other save omits leaveUnit so leave_unit stays untouched (no silent reset).
  // Validate against the closed { day, hour } set (the DB CHECK is defence-in-depth).
  const touchLeaveUnit = p.leaveUnit !== undefined;
  if (touchLeaveUnit && p.leaveUnit !== 'day' && p.leaveUnit !== 'hour') {
    throw new Error('Leave unit must be day or hour.');
  }
  const leaveUnitSet = touchLeaveUnit ? { leaveUnit: p.leaveUnit } : {};
  // Leave Year Type override (e1a51aea): OWN tri-state, mirroring touchLeaveUnit — the "Leave Year Type"
  // sub-step posts `yearCycle=1`, any other save omits yearCycleOverride so year_cycle_override stays
  // untouched. Anything outside the closed live set is rejected; null clears (⇒ company cycle).
  // f3a64d90: 'a2c' (Anniversary to Calendar) is now IN that set — its engine semantics shipped with this
  // item (a2cFirstYearEntitledToDate + reprojectA2cEntitlement), and migration 0310 widened the DB CHECK
  // to match, so the previous explicit rejection is gone. The membership test below stays the primary
  // guard; the CHECK is defence-in-depth against a hand-crafted write.
  const touchYearCycle = p.yearCycleOverride !== undefined;
  if (touchYearCycle && p.yearCycleOverride != null) {
    if (!(LEAVE_YEAR_CYCLE_OVERRIDES as readonly string[]).includes(p.yearCycleOverride)) {
      throw new Error('Leave year type must be a2a (Anniversary to Anniversary), a2c (Anniversary to Calendar), c2c (Calendar to Calendar), or the company default.');
    }
  }
  const yearCycleSet = touchYearCycle
    ? { yearCycleOverride: (p.yearCycleOverride ?? null) as LeaveYearCycleOverride | null }
    : {};
  // Probation eligibility (d6bdbd55): OWN tri-state, mirroring touchLeaveUnit — posted with the eligibility
  // sub-form. undefined ⇒ column untouched; null ⇒ clear; else must be in the closed { confirmed_only,
  // probation_only } set (the DB CHECK is defence-in-depth).
  const touchProbation = p.probationEligibility !== undefined;
  if (touchProbation && p.probationEligibility != null && !PROBATION_ELIGIBILITY_VALUES.includes(p.probationEligibility)) {
    throw new Error('Probation eligibility must be confirmed_only or probation_only.');
  }
  const probationSet = touchProbation ? { probationEligibility: p.probationEligibility ?? null } : {};
  // Leave Type Employee Visibility (7b11f1c1): two INDEPENDENT OWN tri-states, mirroring touchLeaveUnit — the
  // visibility sub-form posts `visibility=1`, any other save omits both so the columns stay untouched. The
  // statutory-code guard on employeeCanApply=false runs inside the transaction below (it needs the type code).
  const touchVisibleToEmployee = p.visibleToEmployee !== undefined;
  const touchEmployeeCanApply = p.employeeCanApply !== undefined;
  const visibleToEmployeeSet = touchVisibleToEmployee ? { visibleToEmployee: p.visibleToEmployee ?? null } : {};
  const employeeCanApplySet = touchEmployeeCanApply ? { employeeCanApply: p.employeeCanApply ?? null } : {};
  // Leave grouping visibility (b653ac1b): OWN tri-state, mirroring touchVisibleToEmployee — the placement
  // sub-form posts `placement=1`, any other save omits it so both the ess_placement column and the shared
  // visibility flag stay untouched. Map the 3-way choice onto the stored column + the single visibility
  // switch (7b11f1c1): 'hidden' ⇒ clear ess_placement + set visible_to_employee=false (the ONE hidden
  // mechanism — never a second column); 'primary'/'secondary' ⇒ store it + set visible_to_employee=true
  // (a placed type is by definition visible); null ⇒ clear both (revert to code-keyed default + un-hide).
  const touchPlacement = p.essPlacement !== undefined;
  if (touchPlacement && p.essPlacement != null && !['primary', 'secondary', 'hidden'].includes(p.essPlacement)) {
    throw new Error('Leave placement must be primary, secondary, or hidden.');
  }
  let placementColSet: { essPlacement?: string | null } = {};
  let placementVisibilitySet: { visibleToEmployee?: boolean | null } = {};
  if (touchPlacement) {
    if (p.essPlacement === 'hidden') {
      placementColSet = { essPlacement: null };
      placementVisibilitySet = { visibleToEmployee: false };
    } else if (p.essPlacement === 'primary' || p.essPlacement === 'secondary') {
      placementColSet = { essPlacement: p.essPlacement };
      placementVisibilitySet = { visibleToEmployee: true };
    } else {
      // null ⇒ clear the override entirely: revert to the code-keyed default AND un-hide.
      placementColSet = { essPlacement: null };
      placementVisibilitySet = { visibleToEmployee: null };
    }
  }
  // Employee Leave View Configuration (65dec703): OWN tri-state, mirroring touchPartial — the ESS-view
  // sub-form posts `essView=1`, any other save omits essViewConfig so ess_view_config stays untouched.
  const touchEssViewConfig = p.essViewConfig !== undefined;
  // Validate against the closed component-key allow-list up front (reject unknown keys) and normalize to a
  // clean { key: boolean } map. null ⇒ clear (all-visible default). This map REPLACES the column wholesale.
  let nextEssViewConfig: EssViewConfig | null | undefined;
  if (touchEssViewConfig) {
    if (p.essViewConfig === null) {
      nextEssViewConfig = null;
    } else {
      const cleaned: EssViewConfig = {};
      for (const key of Object.keys(p.essViewConfig!)) {
        if (!isEssViewComponentKey(key)) {
          throw new Error(`Unknown leave-view component key: ${key}.`);
        }
        cleaned[key] = !!p.essViewConfig![key];
      }
      // An empty map is indistinguishable from "all visible" — store null so the default path stays clean.
      nextEssViewConfig = Object.keys(cleaned).length === 0 ? null : cleaned;
    }
  }
  // Leave Entitlement Formula Management (79011509): OWN tri-state, mirroring touchEssViewConfig — the formula
  // editor sub-form posts `formula=1`, any other save omits formulaExplanations so the column stays untouched.
  // Validate + normalise (reject unknown keys, trim, drop blank fields/entries, cap length); an all-blank map ⇒
  // null (clear). This map REPLACES the column wholesale.
  const touchFormulaExplanations = p.formulaExplanations !== undefined;
  let nextFormulaExplanations: LeaveFormulaConfig | null | undefined;
  if (touchFormulaExplanations) {
    nextFormulaExplanations = p.formulaExplanations === null ? null : normalizeLeaveFormulaConfig(p.formulaExplanations!);
  }
  // Leave Type Visual Configuration Enhancement (639fdf77): OWN tri-state, mirroring touchEssViewConfig — the
  // visual sub-form posts `visual=1`, any other save omits color/icon so those columns stay untouched. Both
  // keys are touched together (one sub-form). An empty string clears (⇒ null). color is validated against the
  // 7-token allow-list; icon against the icon-registry keys — an out-of-list value is rejected.
  const touchVisual = p.color !== undefined || p.icon !== undefined;
  let nextColor: string | null | undefined;
  let nextIcon: string | null | undefined;
  if (touchVisual) {
    const rawColor = typeof p.color === 'string' ? p.color.trim() : p.color;
    const rawIcon = typeof p.icon === 'string' ? p.icon.trim() : p.icon;
    if (rawColor == null || rawColor === '') {
      nextColor = null;
    } else if (!isLeaveColorToken(rawColor)) {
      throw new Error(`Unknown leave colour theme: ${rawColor}.`);
    } else {
      nextColor = rawColor;
    }
    if (rawIcon == null || rawIcon === '') {
      nextIcon = null;
    } else if (!isLeaveIconKey(rawIcon)) {
      throw new Error(`Unknown leave icon: ${rawIcon}.`);
    } else {
      nextIcon = rawIcon;
    }
  }
  // Leave Type master page (feedback 097de541): its OWN tri-state — the identity sub-form posts `identity=1`
  // and forwards `description`; any other save omits it, so the description column stays untouched.
  const touchDescription = p.description !== undefined;
  const nextDescription =
    touchDescription
      ? typeof p.description === 'string' && p.description.trim() !== ''
        ? p.description.trim()
        : null
      : undefined;
  if (p.mandatoryAfterDays != null && (!Number.isInteger(p.mandatoryAfterDays) || p.mandatoryAfterDays < 0)) {
    throw new Error('“Required after more than N days” must be a whole number ≥ 0.');
  }
  if (p.backdatingLimitDays != null && (!Number.isInteger(p.backdatingLimitDays) || p.backdatingLimitDays < 0)) {
    throw new Error('“Backdating limit (days)” must be a whole number ≥ 0.');
  }
  if (p.minAdvanceDays != null && (!Number.isInteger(p.minAdvanceDays) || p.minAdvanceDays < 0)) {
    throw new Error('“Minimum advance days” must be a whole number ≥ 0.');
  }
  // Advance Notice — calendar days or working days (7daac043): mirrors migration 0447's vocabulary CHECK.
  // Validated rather than silently coerced — an unrecognised value would fall back to calendar days at read
  // time, so accepting it here would store a rule that means something other than what the administrator
  // chose, and look correct in the audit trail while doing it. Defence in depth behind the DB CHECK.
  if (
    p.minAdvanceDayType != null &&
    p.minAdvanceDayType !== 'calendar_days' &&
    p.minAdvanceDayType !== 'working_days'
  ) {
    throw new Error('“Day type” for the advance-notice rule must be Calendar Days or Working Days.');
  }
  // Application Limits (c6ffa725): mirrors the DB CHECK in migration 0335. A zero or negative ceiling would
  // refuse EVERY application of the type, which is a configuration mistake, not a policy — archive or hide
  // the leave type instead. Fractional figures ARE allowed (half-day leave exists), unlike the whole-day
  // rules above.
  if (
    p.maxDaysPerLeaveYear != null &&
    (!Number.isFinite(p.maxDaysPerLeaveYear) || p.maxDaysPerLeaveYear <= 0 || p.maxDaysPerLeaveYear > 9999)
  ) {
    throw new Error('“Maximum application per leave year” must be greater than 0 and no more than 9999 days.');
  }
  // ad9cb5c5: mirrors migration 0352's vocabulary CHECK. Validated rather than silently coerced — an
  // unrecognised period would fall back to leave_year at read time, so accepting it here would store a
  // figure that means something other than what the administrator chose.
  if (p.maxDaysPeriod != null && !APPLICATION_LIMIT_PERIODS.includes(p.maxDaysPeriod as ApplicationLimitPeriod)) {
    throw new Error('“Limit period” must be one of: per leave year, per calendar year, once per employment.');
  }
  // bc512dc3: mirrors migration 0352's two CHECKs. Zero is refused deliberately — "may go negative, but not
  // by any amount" is what turning the switch OFF already says, and admitting both spellings gives one
  // policy two representations that the engines can disagree about. Fractional floors are allowed, because
  // half-day leave exists and "no further than -0.5" is a real policy.
  if (
    p.maxNegativeBalance != null &&
    (!Number.isFinite(p.maxNegativeBalance) || p.maxNegativeBalance <= 0 || p.maxNegativeBalance > 9999)
  ) {
    throw new Error('“Maximum negative balance” must be greater than 0 and no more than 9999 days.');
  }
  if (p.maxNegativeBalance != null && p.allowNegativeBalance !== true) {
    throw new Error('“Maximum negative balance” only applies when a negative balance is allowed.');
  }
  // 9861b8a4 — Yes now REQUIRES a figure, because Yes is what unlocks the approval gate. Before this item
  // the switch was inert at approval, so "Yes with no floor" was merely useless; now it would mean
  // "unbounded", which is not a policy anyone should be able to set by leaving a box empty. Existing rows
  // in that state are untouched (this only guards WRITES) and the leave-type screen lists them so they can
  // be resolved deliberately — a migration that guessed a floor for them would be inventing policy.
  if (touchNegativeBalance && p.allowNegativeBalance === true && p.maxNegativeBalance == null) {
    throw new Error(
      'Allowing a negative balance now requires a “Maximum negative balance” — enter how far below zero this leave type may go, or set it back to No.',
    );
  }
  // Maximum Consecutive Leave (c6ffa725 rev 2): mirrors the four DB CHECKs in migration 0343. The pair is
  // all-or-nothing — Unlimited is (null, null) and Limited is (figure, unit) — because a cap with no unit
  // cannot be read and a unit with no cap is inert configuration that looks set. A zero or negative cap
  // would refuse EVERY application of the type, which is a configuration mistake and not a policy.
  // Fractional figures ARE allowed: half-day leave exists and "at most 2.5 working days" is expressible.
  let nextMaxConsecutiveDays: number | null | undefined;
  let nextMaxConsecutiveUnit: 'calendar_days' | 'working_days' | null | undefined;
  if (touchMaxConsecutive) {
    const rawDays = p.maxConsecutiveDays ?? null;
    const rawUnit = p.maxConsecutiveUnit ?? null;
    if (rawDays == null && rawUnit == null) {
      nextMaxConsecutiveDays = null;
      nextMaxConsecutiveUnit = null;
    } else if (rawDays == null || rawUnit == null) {
      throw new Error('“Maximum consecutive leave” needs both a maximum and a unit, or neither (Unlimited).');
    } else {
      if (!Number.isFinite(rawDays) || rawDays <= 0 || rawDays > 9999) {
        throw new Error('“Maximum consecutive leave” must be greater than 0 and no more than 9999 days.');
      }
      if (rawUnit !== 'calendar_days' && rawUnit !== 'working_days') {
        throw new Error('“Maximum consecutive leave” unit must be Calendar Days or Working Days.');
      }
      nextMaxConsecutiveDays = rawDays;
      nextMaxConsecutiveUnit = rawUnit;
    }
  }
  // Custom validation messages: reject unknown rule keys and over-long messages up front. The set of
  // known keys is deliberately small (one rule today); expand it as new validation rules ship.
  if (touchCustomMessages && p.customMessages != null) {
    for (const key of Object.keys(p.customMessages)) {
      if (!CUSTOM_MESSAGE_RULE_KEYS.includes(key as (typeof CUSTOM_MESSAGE_RULE_KEYS)[number])) {
        throw new Error(`Unknown custom-message rule key: ${key}.`);
      }
      const raw = p.customMessages[key];
      if (typeof raw === 'string' && raw.trim().length > CUSTOM_MESSAGE_MAX_LEN) {
        throw new Error('Custom message must be 500 characters or fewer.');
      }
    }
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
  // Minimum advance-notice rule (0159): its own set fragment, mirroring backdatingSet.
  // 7daac043 — the DAY TYPE rides this same marker and is cleared WITH the requirement, so the pair
  // "no requirement, but read in working days" (inert configuration that looks set) can never be written
  // from here. Same shape as maxDaysPeriod riding maxDaysPerLeaveYear above.
  const minAdvanceSet = touchMinAdvance
    ? {
        minAdvanceDays: p.minAdvanceDays,
        minAdvanceDayType: p.minAdvanceDays == null ? null : (p.minAdvanceDayType ?? null),
      }
    : {};
  // Application Limits (c6ffa725): its own set fragment, mirroring backdatingSet. It is PRE-MERGED with the
  // two fragments above rather than spread as a fourth key in the `.set({...})` below — that literal is
  // already at TypeScript's union-complexity ceiling (TS2590 "union type that is too complex to represent"),
  // and one more conditional spread tips it over. The tri-states remain three genuinely independent ones;
  // only the assembly is flattened.
  // numeric(6,2) is a STRING column to drizzle, so the figure is serialised here rather than handed over as
  // a number — the same treatment leave_policy's numeric columns get on the way in.
  const applicationLimitSet = touchApplicationLimits
    ? {
        maxDaysPerLeaveYear: p.maxDaysPerLeaveYear == null ? null : p.maxDaysPerLeaveYear.toFixed(2),
        // ad9cb5c5 — the period rides the same marker. Clearing the ceiling clears the period with it, so
        // the pair migration 0352 refuses (period set, ceiling null) cannot be written from here.
        maxDaysPeriod: p.maxDaysPerLeaveYear == null ? null : (p.maxDaysPeriod ?? null),
      }
    : {};
  // The ANNOTATION is load-bearing, not decoration. Each `touchX ? {...} : {}` fragment has the union type
  // `{} | { x: … }`, and spreading N of them into one literal multiplies out to 2^N members; the `.set({…})`
  // below spreads enough of them that TypeScript gives up with TS2590. Declaring the merged shape collapses
  // these three back to ONE member and buys the headroom this column needed.
  // Maximum Consecutive Leave (c6ffa725 rev 2): its own set fragment, PRE-MERGED into the same declared
  // shape below for the same TS2590 reason. numeric(6,2) is a STRING column to drizzle, so the figure is
  // serialised here; the unit is plain text.
  const maxConsecutiveSet = touchMaxConsecutive
    ? {
        maxConsecutiveDays: nextMaxConsecutiveDays == null ? null : nextMaxConsecutiveDays.toFixed(2),
        maxConsecutiveUnit: nextMaxConsecutiveUnit ?? null,
      }
    : {};
  const requestRuleSet: {
    backdatingLimitDays?: number | null;
    minAdvanceDays?: number | null;
    minAdvanceDayType?: 'calendar_days' | 'working_days' | null;
    maxDaysPerLeaveYear?: string | null;
    maxConsecutiveDays?: string | null;
    maxConsecutiveUnit?: 'calendar_days' | 'working_days' | null;
  } = { ...backdatingSet, ...minAdvanceSet, ...applicationLimitSet, ...maxConsecutiveSet };
  // Partial Leave Approval (ADR-0068): its own set fragment.
  const partialSet = touchPartial ? { perDateApproval: p.perDateApproval } : {};
  // Leave Type master page (feedback 097de541): its own set fragment (the trimmed value, or null to clear).
  const descriptionSet = touchDescription ? { description: nextDescription ?? null } : {};
  // Leave Type Visual Configuration Enhancement (639fdf77): its own set fragment (the validated color/icon,
  // or null to clear). Display-only; nothing downstream reads these.
  const visualSet = touchVisual ? { color: nextColor ?? null, icon: nextIcon ?? null } : {};
  // Day Type Inclusion (feedback ef6d7146): its own set fragment (the normalised vector, or null to clear).
  const dayTypeInclusionSet = touchDayTypeInclusion ? { dayTypeInclusion: nextDayTypeInclusion ?? null } : {};
  // Override Leave Application (56910869): its own set fragment. An empty list stores NULL rather than `[]`
  // so "HR cleared every rule" and "HR never configured any" are the same row — one representation, one
  // reading, and the engine's Array.isArray branch never has to distinguish them.
  const overrideRulesSet = touchOverrideRules
    ? { overrideRules: nextOverrideRules && nextOverrideRules.length > 0 ? nextOverrideRules : null }
    : {};

  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        name: leaveType.name,
        // Leave Type Employee Visibility (7b11f1c1): the code drives the statutory-entitlement guard below;
        // the two flags feed the before/after audit diff.
        code: leaveType.code,
        // 65f466e2 — MUST BE SELECTED. The statutory lock and the can-apply guard below read the role and
        // fall back to the code only when it is absent. Omitting it here would make `before.role` undefined
        // on every row, silently reinstating the code-only comparison this item exists to replace — and
        // nothing would fail: the guards would simply go quiet again, exactly as they have been.
        role: leaveType.role,
        visibleToEmployee: leaveType.visibleToEmployee,
        employeeCanApply: leaveType.employeeCanApply,
        // Leave grouping visibility (b653ac1b): feeds the before/after placement audit diff.
        essPlacement: leaveType.essPlacement,
        // Leave Type master page (feedback 097de541): selected for the rename-uniqueness check (below) and the
        // description audit diff (MUST be here or before?.description is always undefined).
        description: leaveType.description,
        eligibility: leaveType.eligibility,
        // Probation eligibility (d6bdbd55): selected for the before/after audit diff.
        probationEligibility: leaveType.probationEligibility,
        durations: leaveType.durations,
        requiresDocument: leaveType.requiresDocument,
        mandatoryAfterDays: leaveType.mandatoryAfterDays,
        allowedMimeTypes: leaveType.allowedMimeTypes,
        maxDocBytes: leaveType.maxDocBytes,
        employeeRemarkRequired: leaveType.employeeRemarkRequired,
        hrRemarkRequired: leaveType.hrRemarkRequired,
        sendToPayroll: leaveType.sendToPayroll,
        // Edit Paid/Unpaid on rename (75953777): selected for the before/after audit diff.
        paid: leaveType.paid,
        backdatingLimitDays: leaveType.backdatingLimitDays,
        minAdvanceDays: leaveType.minAdvanceDays,
        // Advance Notice — calendar days or working days (7daac043): selected for the before/after audit
        // diff. MUST be here or before?.minAdvanceDayType is always undefined and a switch from calendar to
        // working days records itself as a change from nothing.
        minAdvanceDayType: leaveType.minAdvanceDayType,
        // Application Limits (c6ffa725): selected for the before/after audit diff.
        maxDaysPerLeaveYear: leaveType.maxDaysPerLeaveYear,
        maxDaysPeriod: leaveType.maxDaysPeriod,
        // Maximum Consecutive Leave (c6ffa725 rev 2): the pair, selected for the before/after audit diff.
        maxConsecutiveDays: leaveType.maxConsecutiveDays,
        maxConsecutiveUnit: leaveType.maxConsecutiveUnit,
        perDateApproval: leaveType.perDateApproval,
        // Must be selected so before?.customMessages reflects what was actually stored — without it the
        // audit diff and the read-then-patch merge would always see undefined (silently clobbering).
        customMessages: leaveType.customMessages,
        // ESS view config (65dec703): selected for the before/after audit diff.
        essViewConfig: leaveType.essViewConfig,
        // Leave Entitlement Formula Management (79011509): selected for the before/after audit diff.
        formulaExplanations: leaveType.formulaExplanations,
        // Day Type Inclusion (ef6d7146): selected for the before/after audit diff.
        dayTypeInclusion: leaveType.dayTypeInclusion,
        // Visual config (639fdf77): selected for the before/after audit diff.
        color: leaveType.color,
        icon: leaveType.icon,
        // Leave Unit Configuration (e4980382): selected for the before/after audit diff.
        leaveUnit: leaveType.leaveUnit,
        // Leave Year Type override (e1a51aea): selected for the before/after audit diff.
        yearCycleOverride: leaveType.yearCycleOverride,
        // Duplicate Leave Application Restriction (d5e51c34): selected for the before/after audit diff.
        duplicateApplicationPolicy: leaveType.duplicateApplicationPolicy,
        // Configurable Negative Leave Balance Validation (0ef0defd): selected for the before/after audit diff.
        allowNegativeBalance: leaveType.allowNegativeBalance,
        maxNegativeBalance: leaveType.maxNegativeBalance,
        // Balance Deduction Source (cdf9ca48) / Allow Unpaid Leave (a7fab30b): selected for the audit diff.
        balanceSourceTypeId: leaveType.balanceSourceTypeId,
        allowUnpaidLeave: leaveType.allowUnpaidLeave,
      })
      .from(leaveType)
      .where(eq(leaveType.id, p.id))
      .limit(1);
    // Balance Deduction Source (cdf9ca48) — refuse a configuration that has no well-defined answer, AT SAVE,
    // rather than letting it fail (or quietly mis-deduct) the first time somebody applies for leave.
    //
    // ONE HOP, ENFORCED FROM BOTH ENDS. Chains are refused, not just cycles: "A deducts from B, B deducts from
    // C" reads as though A spends C, but nothing in the request path walks the chain — and a walk would have
    // to answer what happens when the chain loops. Refusing depth > 1 removes the question entirely, and makes
    // cycles structurally impossible rather than merely detected. Both directions are checked because a chain
    // can be created from either end: by pointing at a type that already has a source, or by giving a source
    // to a type that something else already points at.
    if (touchBalanceSource && p.balanceSourceTypeId != null) {
      if (p.balanceSourceTypeId === p.id) {
        throw new Error('A leave type cannot deduct from itself. Choose a different leave type.');
      }
      const [src] = await tx
        .select({ name: leaveType.name, source: leaveType.balanceSourceTypeId, archivedAt: leaveType.archivedAt })
        .from(leaveType)
        .where(eq(leaveType.id, p.balanceSourceTypeId))
        .limit(1);
      // RLS scopes this read to the tenant, so a "not found" here also covers a cross-tenant id.
      if (!src) throw new Error('The selected balance deduction source is not a leave type of this tenant.');
      if (src.archivedAt) {
        throw new Error(`${src.name} is archived and cannot be used as a balance deduction source.`);
      }
      if (src.source != null) {
        throw new Error(
          `${src.name} already deducts from another leave type. Pick a leave type that keeps its own balance.`,
        );
      }
      const [borrower] = await tx
        .select({ name: leaveType.name })
        .from(leaveType)
        .where(eq(leaveType.balanceSourceTypeId, p.id))
        .limit(1);
      if (borrower) {
        throw new Error(
          `${borrower.name} already deducts from this leave type, so this one must keep its own balance.`,
        );
      }
    }
    // Name uniqueness on rename (feedback 097de541): only when the name actually changes (case-insensitive),
    // so an unrelated sub-form save that re-posts the current name — and any legacy duplicate that predates
    // this rule — never trips the guard. Excludes self and archived types (mirrors createLeaveType + the
    // partial code index).
    if (before && name.toLowerCase() !== before.name.toLowerCase()) {
      const [dupe] = await tx
        .select({ id: leaveType.id })
        .from(leaveType)
        .where(
          and(
            isNull(leaveType.archivedAt),
            sql`${leaveType.id} <> ${p.id}`,
            sql`lower(${leaveType.name}) = lower(${name})`,
          ),
        )
        .limit(1);
      if (dupe) throw new DuplicateError(`A leave type named “${name}” already exists.`);
    }
    // Edit Leave Type Code (a7194511): only act when the code actually changes (codes are canonical uppercase,
    // so this is an exact compare after normalization). Statutory codes (ANNUAL / SICK / HOSPITALIZATION /
    // MATERNITY / PATERNITY per EA-1955 + EMERGENCY) are LOCKED both ways: the CURRENT code cannot be renamed
    // (renaming would silently switch its legal entitlement / carry-forward / encashment matching off), and a
    // custom code cannot be renamed INTO a statutory code (which would silently start applying statutory rules
    // to a bespoke type). The uniqueness guard mirrors the rename-name guard above — active (non-archived),
    // non-self, case-insensitive on code — mapped to the reporter's exact message. The DB partial unique index
    // + CHECK from migration 0031 remain the backstop (the .set() below maps a 23505 to the same message).
    // 65f466e2 — THE LOCK NOW ASKS THE ROLE, NOT THE CODE.
    // LOCKED_CODES only ever matched the codes the pack SEEDS. Production's statutory types are coded EL,
    // MTL, PTL, so none of them were in this set and none of them were locked: a statutory type could be
    // renamed or altered, silently, which is the second of the three behaviours 65f466e2 found dead.
    // A classified row is judged by `before.role`; an unclassified one falls back to the code set, so a
    // tenant the backfill could not classify keeps exactly today's behaviour.
    const LOCKED_CODES = new Set<string>([...STATUTORY_APPLY_CODES, EMERGENCY_LEAVE_CODE]);
    const LOCKED_ROLES = new Set<string>([...STATUTORY_APPLY_ROLES, 'emergency']);
    const isLockedType = (row: { role?: string | null; code?: string | null } | null | undefined): boolean => {
      if (row == null) return false;
      if (row.role != null && row.role !== '') return LOCKED_ROLES.has(row.role);
      return LOCKED_CODES.has((row.code ?? '').toUpperCase());
    };
    let codeSet: { code?: string } = {};
    let codeChanged = false;
    if (touchCode && before && normalizedNewCode !== before.code) {
      if (isLockedType(before)) {
        throw new Error('statutory leave type code cannot be changed');
      }
      if (LOCKED_CODES.has(normalizedNewCode!)) {
        throw new Error('statutory leave type code cannot be changed');
      }
      const [dupeCode] = await tx
        .select({ id: leaveType.id })
        .from(leaveType)
        .where(
          and(
            isNull(leaveType.archivedAt),
            sql`${leaveType.id} <> ${p.id}`,
            sql`lower(${leaveType.code}) = lower(${normalizedNewCode})`,
          ),
        )
        .limit(1);
      if (dupeCode) throw new DuplicateError('Leave Type Code already exists. Please enter a unique code.');
      codeSet = { code: normalizedNewCode };
      codeChanged = true;
    }
    // Leave Type Employee Visibility (7b11f1c1) — STATUTORY SAFETY. Refuse to close off employee applications
    // on a leave type that carries a Malaysian statutory entitlement (ANNUAL / SICK / HOSPITALIZATION per EA
    // 1955 s.60E/s.60F, MATERNITY per s.37, PATERNITY per s.60FA): an employee must always be able to exercise
    // a lawful entitlement, so a well-meant configuration can never silently deny it. visible_to_employee=false
    // is NOT blocked on these (HR can still grant the leave directly), only the can-apply block. The type code
    // is immutable, so `before.code` is authoritative.
    if (
      touchEmployeeCanApply &&
      p.employeeCanApply === false &&
      before &&
      // 65f466e2 — role first, seeded codes as the fallback. Production's MTL/PTL were never in the code
      // list, so the statutory right to APPLY was unprotected on exactly the types the law names.
      isStatutoryApplyType(before)
    ) {
      throw new Error(
        `${before.code} is a statutory leave entitlement — employees must be able to apply for it. You cannot block applications for this leave type.`,
      );
    }
    // Custom validation messages: read-then-patch-then-write on the SHARED JSONB column. Start from what is
    // already stored, apply the caller's touched keys: a value that is empty or all-whitespace after trim is
    // treated as "not configured" and the key is REMOVED (never stored as an empty string, so it round-trips
    // to the built-in default rather than rendering a blank banner). An explicit null clears all messages.
    let nextCustomMessages: Record<string, string> | null | undefined;
    if (touchCustomMessages) {
      if (p.customMessages === null) {
        nextCustomMessages = null;
      } else {
        const merged: Record<string, string> = { ...(before?.customMessages ?? {}) };
        for (const key of Object.keys(p.customMessages!)) {
          const trimmed = (p.customMessages![key] ?? '').trim();
          if (trimmed.length === 0) delete merged[key];
          else merged[key] = trimmed;
        }
        nextCustomMessages = Object.keys(merged).length === 0 ? null : merged;
      }
    }
    await tx
      .update(leaveType)
      .set({
        name,
        // Edit Leave Type Code (a7194511): the validated new code (only present when it actually changed for a
        // non-locked type). All downstream relations key on leave_type_id, so nothing detaches.
        ...codeSet,
        ...(touchEligibility ? { eligibility: nextEligibility } : {}),
        ...probationSet,
        ...(touchDurations ? { durations: nextDurations } : {}),
        ...docSet,
        ...requestRuleSet,
        ...partialSet,
        ...descriptionSet,
        ...visualSet,
        ...(touchPayroll ? { sendToPayroll: p.sendToPayroll } : {}),
        ...paidSet,
        ...duplicatePolicySet,
        ...negativeBalanceSet,
        ...(touchBalanceSource ? { balanceSourceTypeId: p.balanceSourceTypeId ?? null } : {}),
        ...allowUplSet,
        ...(touchCustomMessages ? { customMessages: nextCustomMessages } : {}),
        ...(touchEssViewConfig ? { essViewConfig: nextEssViewConfig } : {}),
        ...(touchFormulaExplanations ? { formulaExplanations: nextFormulaExplanations } : {}),
        ...dayTypeInclusionSet,
        ...overrideRulesSet,
        ...leaveUnitSet,
        ...yearCycleSet,
        ...visibleToEmployeeSet,
        ...employeeCanApplySet,
        // Leave grouping visibility (b653ac1b): the stored placement column + the shared visibility flag it
        // drives (Hidden ⇒ flag false). Spread AFTER visibleToEmployeeSet so, in the (mutually-exclusive by
        // marker) case both were somehow forwarded, the placement decision is authoritative.
        ...placementColSet,
        ...placementVisibilitySet,
      })
      .where(eq(leaveType.id, p.id))
      // Edit Leave Type Code (a7194511): DB backstop — the migration 0031 partial unique index on
      // (tenant_id, lower(code)) WHERE archived_at IS NULL is the last line of defence against a duplicate code
      // slipping past the pre-flight check (e.g. a concurrent rename). Map its 23505 to the same friendly
      // message. The only unique index this write can violate is the code index, so the mapping is unambiguous.
      .catch((e) => {
        if (isUniqueViolation(e)) {
          throw new DuplicateError('Leave Type Code already exists. Please enter a unique code.');
        }
        throw e;
      });
    // Anniversary to Calendar (f3a64d90) — the BACKFILL. Unlike updateLeavePolicy, this service never
    // recalculated anything; a Leave Year Type save only rewrote a column, so employees already carrying a
    // figure computed under the OLD model kept it (the reporter's YTD 7.00 / balance −6.00). The moment the
    // override moves TO or FROM 'a2c', re-correct every live employee on this type IN THE SAME TRANSACTION:
    // accrual-class rows so YTD Entitled moves, plus the compensating reversal so Balance/Available agree.
    // Idempotent, so a re-save of the same value writes nothing. A move AWAY from a2c is a no-op inside the
    // helper (the type is no longer a2c) — the ordinary calendar engines own it from the next year-open.
    if (
      touchYearCycle &&
      (p.yearCycleOverride ?? null) !== (before?.yearCycleOverride ?? null) &&
      ((p.yearCycleOverride ?? null) === A2C_OVERRIDE || (before?.yearCycleOverride ?? null) === A2C_OVERRIDE)
    ) {
      await reprojectA2cEntitlement(tx, ctx, {
        leaveTypeId: p.id,
        asOf: p.asOf ?? todayInKualaLumpur(),
        trigger: 'year_cycle_override',
      });
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-type',
      aggregateId: p.id,
      eventType: 'leave-type.updated',
      actor: actorOf(ctx),
      payload: {
        before: {
          name: before?.name ?? null,
          // Edit Leave Type Code (a7194511): record the code diff only when it actually changed.
          ...(codeChanged ? { code: before?.code ?? null } : {}),
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
          ...(touchPaid ? { paid: before?.paid ?? null } : {}),
          ...(touchDuplicatePolicy ? { duplicateApplicationPolicy: before?.duplicateApplicationPolicy ?? null } : {}),
          ...(touchNegativeBalance
            ? {
                allowNegativeBalance: before?.allowNegativeBalance ?? null,
                maxNegativeBalance: before?.maxNegativeBalance ?? null,
              }
            : {}),
          ...(touchBalanceSource ? { balanceSourceTypeId: before?.balanceSourceTypeId ?? null } : {}),
          ...(touchAllowUpl ? { allowUnpaidLeave: before?.allowUnpaidLeave ?? null } : {}),
          ...(touchBackdating ? { backdatingLimitDays: before?.backdatingLimitDays ?? null } : {}),
          ...(touchMinAdvance
            ? {
                minAdvanceDays: before?.minAdvanceDays ?? null,
                // 7daac043 — the unit belongs in the same diff as the figure. "7" moving from calendar days
                // to working days changes the rule's meaning entirely while the FIGURE stays at 7; an audit
                // trail showing only the figure would show nothing at all. (Same reasoning as maxDaysPeriod.)
                minAdvanceDayType: before?.minAdvanceDayType ?? null,
              }
            : {}),
          ...(touchApplicationLimits
            ? {
                maxDaysPerLeaveYear: before?.maxDaysPerLeaveYear ?? null,
                maxDaysPeriod: before?.maxDaysPeriod ?? null,
              }
            : {}),
          ...(touchMaxConsecutive
            ? {
                maxConsecutiveDays: before?.maxConsecutiveDays ?? null,
                maxConsecutiveUnit: before?.maxConsecutiveUnit ?? null,
              }
            : {}),
          ...(touchPartial ? { perDateApproval: before?.perDateApproval ?? null } : {}),
          ...(touchCustomMessages ? { customMessages: before?.customMessages ?? null } : {}),
          ...(touchEssViewConfig ? { essViewConfig: before?.essViewConfig ?? null } : {}),
          ...(touchFormulaExplanations ? { formulaExplanations: before?.formulaExplanations ?? null } : {}),
          ...(touchDayTypeInclusion ? { dayTypeInclusion: before?.dayTypeInclusion ?? null } : {}),
          ...(touchVisual ? { color: before?.color ?? null, icon: before?.icon ?? null } : {}),
          ...(touchLeaveUnit ? { leaveUnit: before?.leaveUnit ?? null } : {}),
          ...(touchYearCycle ? { yearCycleOverride: before?.yearCycleOverride ?? null } : {}),
          ...(touchProbation ? { probationEligibility: before?.probationEligibility ?? null } : {}),
          ...(touchVisibleToEmployee ? { visibleToEmployee: before?.visibleToEmployee ?? null } : {}),
          ...(touchEmployeeCanApply ? { employeeCanApply: before?.employeeCanApply ?? null } : {}),
          // Leave grouping visibility (b653ac1b): record both the stored column and the shared flag it drives.
          ...(touchPlacement ? { essPlacement: before?.essPlacement ?? null, visibleToEmployee: before?.visibleToEmployee ?? null } : {}),
          ...(touchDescription ? { description: before?.description ?? null } : {}),
        },
        after: {
          name,
          // Edit Leave Type Code (a7194511): the persisted new code (only present when it changed).
          ...(codeChanged ? { code: normalizedNewCode } : {}),
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
          ...(touchPaid ? { paid: p.paid ?? before?.paid ?? null } : {}),
          ...(touchDuplicatePolicy
            ? { duplicateApplicationPolicy: p.duplicateApplicationPolicy ?? before?.duplicateApplicationPolicy ?? null }
            : {}),
          ...(touchNegativeBalance
            ? {
                allowNegativeBalance: p.allowNegativeBalance ?? before?.allowNegativeBalance ?? null,
                // bc512dc3 — same reasoning: the floor moving from 2 to 20 is the whole change, and the
                // switch it rides on did not move.
                maxNegativeBalance:
                  p.allowNegativeBalance === true && p.maxNegativeBalance != null ? p.maxNegativeBalance : null,
              }
            : {}),
          ...(touchBalanceSource ? { balanceSourceTypeId: p.balanceSourceTypeId ?? null } : {}),
          ...(touchAllowUpl ? { allowUnpaidLeave: p.allowUnpaidLeave ?? before?.allowUnpaidLeave ?? null } : {}),
          ...(touchBackdating
            ? { backdatingLimitDays: p.backdatingLimitDays !== undefined ? p.backdatingLimitDays : (before?.backdatingLimitDays ?? null) }
            : {}),
          ...(touchMinAdvance
            ? {
                minAdvanceDays: p.minAdvanceDays !== undefined ? p.minAdvanceDays : (before?.minAdvanceDays ?? null),
                // 7daac043 — the resolved next unit, cleared with the requirement exactly as the column is.
                minAdvanceDayType: p.minAdvanceDays == null ? null : (p.minAdvanceDayType ?? null),
              }
            : {}),
          ...(touchApplicationLimits
            ? {
                maxDaysPerLeaveYear:
                  p.maxDaysPerLeaveYear !== undefined ? p.maxDaysPerLeaveYear : (before?.maxDaysPerLeaveYear ?? null),
                // ad9cb5c5 — the period is part of the same decision, so it belongs in the same diff. A
                // limit that moved from per-leave-year to per-employment changed meaning entirely while its
                // FIGURE stayed at 1; an audit trail showing only the figure would show nothing at all.
                maxDaysPeriod: p.maxDaysPerLeaveYear == null ? null : (p.maxDaysPeriod ?? null),
              }
            : {}),
          ...(touchMaxConsecutive
            ? { maxConsecutiveDays: nextMaxConsecutiveDays ?? null, maxConsecutiveUnit: nextMaxConsecutiveUnit ?? null }
            : {}),
          ...(touchPartial ? { perDateApproval: p.perDateApproval ?? before?.perDateApproval ?? null } : {}),
          ...(touchCustomMessages ? { customMessages: nextCustomMessages ?? null } : {}),
          ...(touchEssViewConfig ? { essViewConfig: nextEssViewConfig ?? null } : {}),
          ...(touchFormulaExplanations ? { formulaExplanations: nextFormulaExplanations ?? null } : {}),
          ...(touchDayTypeInclusion ? { dayTypeInclusion: nextDayTypeInclusion ?? null } : {}),
          ...(touchVisual ? { color: nextColor ?? null, icon: nextIcon ?? null } : {}),
          ...(touchLeaveUnit ? { leaveUnit: p.leaveUnit ?? before?.leaveUnit ?? null } : {}),
          ...(touchYearCycle ? { yearCycleOverride: p.yearCycleOverride ?? null } : {}),
          ...(touchProbation ? { probationEligibility: p.probationEligibility ?? null } : {}),
          ...(touchVisibleToEmployee ? { visibleToEmployee: p.visibleToEmployee ?? null } : {}),
          ...(touchEmployeeCanApply ? { employeeCanApply: p.employeeCanApply ?? null } : {}),
          // Leave grouping visibility (b653ac1b): the resolved next values (Hidden ⇒ column null + flag false).
          ...(touchPlacement ? { essPlacement: placementColSet.essPlacement ?? null, visibleToEmployee: placementVisibilitySet.visibleToEmployee ?? null } : {}),
          ...(touchDescription ? { description: nextDescription ?? null } : {}),
        },
        ...(reason ? { reason } : {}),
      },
    });
  });
}
/**
 * THE TYPE-LEVEL RULE EDITOR (9816a5ad step 2). The five settings the reporter agreed to consolidate —
 * Earning Method, Carry Forward (+ expiry), Rounding, Maximum Balance, and the Leave Year Type that rides
 * with them — now live on `leave_type` and are READ by the engines via `applyLeaveTypeRules`. This is the
 * only thing that WRITES them.
 *
 * WHY IT HAD TO EXIST BEFORE STEP 3. Migration 0325 backfilled these columns and nothing has ever written
 * them since; `updateLeaveType` above sets name/code/eligibility/probation and none of the rule columns.
 * So without this function the sequence was: add columns → read them → delete the old editors
 * (`fa3f4ccb`), leaving five settings frozen at their backfilled values with no screen anywhere able to
 * change them. That gap is the reason 9816a5ad reached revision 8.
 *
 * TRI-STATE, NOT PATCH-BY-PRESENCE. Every field is `undefined ⇒ leave alone`, `null ⇒ clear`, value ⇒ set.
 * The Earning Method and Carry Forward sub-steps are separate forms editing disjoint halves of the same
 * row; a patch keyed on truthiness would let an earning-only save wipe the carry configuration, which is
 * precisely the trap the old per-policy front doors documented and worked around with hidden re-posts.
 *
 * VALIDATION MIRRORS THE 0325 CHECK CONSTRAINTS rather than trusting them. A constraint violation surfaces
 * as an opaque 23514 to the operator; these throw named, readable errors. The DB checks remain the backstop.
 */
export async function setLeaveTypeRules(
  ctx: SessionContext,
  p: {
    id: string;
    accrualMethod?: string | null;
    /** bc36c768 — the day of the month Monthly Accrual credits on, 1..31. null ⇒ clear (⇒ day 1). Stored
     *  whatever the method is: a type that switches away from monthly and back must not lose its day. */
    accrualDay?: number | null;
    carryForwardEnabled?: boolean | null;
    carryForwardMax?: number | null;
    /** 7cd914b1 — carry a percentage (0-100) of the year-end balance. null ⇒ no percentage rule. */
    carryForwardPercent?: number | null;
    carryForwardExpiryMode?: 'date' | 'months' | null;
    carryForwardExpiryMonths?: number | null;
    carryForwardExpiryMonth?: number | null;
    carryForwardExpiryDay?: number | null;
    carryForwardIncludeEarned?: boolean | null;
    /** 8fec719e — 'custom' (evaluate `roundingBands`) or null (No Rounding). The three fixed methods are
     *  no longer WRITABLE; `applyRounding` still reads them. */
    roundingMethod?: 'custom' | null;
    /** Feedback 9f5164d8 — the custom decimal threshold for 'nearest_half'. null ⇒ the standard rule. */
    roundingThreshold?: number | null;
    /** 8fec719e — the custom rounding table. null ⇒ no table. An EMPTY array is normalised to null so an
     *  emptied editor cannot leave a `[]` behind that reads as "this type carries rules" (hasAnyLeaveTypeRule
     *  tests for null, not for emptiness). */
    roundingBands?: RoundingBand[] | null;
    maxBalanceDays?: number | null;
  },
) {
  const intIn = (v: number | null | undefined, lo: number, hi: number, label: string) => {
    if (v === null || v === undefined) return v;
    if (!Number.isInteger(v) || v < lo || v > hi) throw new LeaveTypeRuleError(`${label} must be a whole number between ${lo} and ${hi}.`);
    return v;
  };
  // 7cd914b1 — a percentage, in its own validator rather than decIn's 0..9999.99 range. A carry-forward
  // percentage above 100 would hand back more than the employee held, so the ceiling is the point.
  const pctIn = (v: number | null | undefined) => {
    if (v === null || v === undefined) return v;
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      throw new LeaveTypeRuleError('Carry-forward percentage must be between 0 and 100.');
    }
    return Math.round(v * 100) / 100;
  };
  const decIn = (v: number | null | undefined, label: string) => {
    if (v === null || v === undefined) return v;
    if (!Number.isFinite(v) || v < 0 || v > 9999.99) throw new LeaveTypeRuleError(`${label} must be between 0 and 9999.99.`);
    return Math.round(v * 100) / 100;
  };
  // 8fec719e — the WRITABLE set is now the USER set, not the engine set. 'up' / 'down' / 'nearest_half'
  // are still evaluated by applyRounding (a value the migration did not reach must keep producing the
  // figure it always produced), but nothing may store them again: a retired choice that a hand-crafted
  // POST could still save is not retired. 'none' arrives here as null (the action maps it), so the only
  // value this accepts is 'custom'.
  if (p.roundingMethod !== undefined && p.roundingMethod !== null && !isUserRoundingMethod(p.roundingMethod)) {
    throw new LeaveTypeRuleError('Rounding must be either No Rounding or Custom Rounding.');
  }
  // 8fec719e — the AUTHORITATIVE band check. The editor renders the same problems live from the same
  // function, but the editor is a courtesy: this is what decides whether a table is storable. Gaps are
  // deliberately NOT refused (see checkRoundingBands) — a part-built table must be savable, and an
  // uncovered decimal simply keeps its calculated value.
  if (p.roundingBands !== undefined && p.roundingBands !== null && p.roundingBands.length > 0) {
    const problems = roundingBandErrors(p.roundingBands);
    if (problems.length > 0) {
      const kinds = [...new Set(problems.map((x) => x.kind))];
      const rows = [...new Set(problems.map((x) => (x.kind === 'gap' ? 0 : x.index + 1)))].join(', ');
      throw new LeaveTypeRuleError(
        `The rounding table is not usable (${kinds.join(', ')}) at row ${rows}. ` +
          // 4a1abc4a — kept in step with the client string `roundingBandRowInvalid`. This one is thrown by
          // the service and surfaced VERBATIM to the operator (the panel's submit is never disabled on a bad
          // table), so it was still telling them to change From — the field this round made derived and
          // read-only — and still quoting three decimals the boxes no longer accept.
          'Every row needs a Round To above where the row before it stopped, and both figures must be between 0.00 and 1.00.',
      );
    }
  }
  // Feedback 9f5164d8 — the reporter's four validation rules, all of which reduce to a bound on ONE number.
  // "Values between 0.000 and 1.000", "ranges must cover the whole interval", "must not overlap", "must not
  // have gaps" and "From must be less than To" are all satisfied by construction once the configuration is a
  // single boundary in (0, 1]: the down range is [0, t) and the up range is [t, 1]. A threshold of exactly 0
  // would make the down range empty (every value rounds up, which is what 'up' is for) and is refused;
  // exactly 1 is legal and means "only a whole 1.000 rounds up", the reporter's own upper bound.
  if (p.roundingThreshold !== undefined && p.roundingThreshold !== null) {
    const t = p.roundingThreshold;
    if (!Number.isFinite(t) || t <= 0 || t > 1) {
      throw new LeaveTypeRuleError('Rounding threshold must be greater than 0.000 and no more than 1.000.');
    }
    // Three decimal places, compared with a tolerance rather than an equality: 0.123 * 1000 is
    // 122.99999999999999 in binary floating point, so a strict `Math.round(x) !== x` would reject a value
    // the reporter's own table uses.
    if (Math.abs(t * 1000 - Math.round(t * 1000)) > 1e-6) {
      throw new LeaveTypeRuleError('Rounding threshold supports at most three decimal places.');
    }
  }
  if (p.carryForwardExpiryMode !== undefined && p.carryForwardExpiryMode !== null && !['date', 'months'].includes(p.carryForwardExpiryMode)) {
    throw new LeaveTypeRuleError('Carry-forward expiry mode must be a date or a number of months.');
  }
  // Leap-correct, matching isValidMonthDay in core/leave-compute.ts and 0325's own SQL: February is taken
  // from a leap year so a savable 29-Feb is not rejected here and then accepted by the engine.
  const month = intIn(p.carryForwardExpiryMonth, 1, 12, 'Carry-forward expiry month');
  const day = intIn(p.carryForwardExpiryDay, 1, 31, 'Carry-forward expiry day');
  if (month != null && day != null) {
    const last = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (day > last) throw new LeaveTypeRuleError(`Carry-forward expiry day is not a real date in that month.`);
  }
  const set: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined) set[k] = v;
  };
  put('accrualMethod', p.accrualMethod);
  // bc36c768 — validated here rather than only by the 0375 CHECK, so an out-of-range day surfaces as a
  // readable message instead of an opaque 23514. The DB constraint remains the backstop.
  put('accrualDay', intIn(p.accrualDay, 1, 31, 'Accrual day of month'));
  put('carryForwardEnabled', p.carryForwardEnabled);
  put('carryForwardMax', decIn(p.carryForwardMax, 'Carry-forward maximum'));
  put('carryForwardPercent', pctIn(p.carryForwardPercent));
  put('carryForwardExpiryMode', p.carryForwardExpiryMode);
  put('carryForwardExpiryMonths', intIn(p.carryForwardExpiryMonths, 1, 12, 'Carry-forward expiry months'));
  put('carryForwardExpiryMonth', month);
  put('carryForwardExpiryDay', day);
  put('carryForwardIncludeEarned', p.carryForwardIncludeEarned);
  put('roundingMethod', p.roundingMethod);
  put(
    'roundingThreshold',
    p.roundingThreshold == null ? p.roundingThreshold : Math.round(p.roundingThreshold * 1000) / 1000,
  );
  // 8fec719e — an empty table is stored as NULL, never as `[]`. `hasAnyLeaveTypeRule` asks whether the
  // column is null, so a `[]` would keep the type "ruled" on the strength of a table with nothing in it.
  put(
    'roundingBands',
    p.roundingBands == null || p.roundingBands.length === 0
      ? p.roundingBands === undefined
        ? undefined
        : null
      : p.roundingBands.map((b) => ({
          from: Math.round(b.from * 1000) / 1000,
          to: Math.round(b.to * 1000) / 1000,
          result: Math.round(b.result * 1000) / 1000,
        })),
  );
  put('maxBalanceDays', decIn(p.maxBalanceDays, 'Maximum balance days'));
  // bc36c768 — CLEARING THE NOT-CONFIGURED MARKER, and the trigger is a NON-NULL accrualMethod, nothing
  // else. Saving carry-forward, or saving the earning form while still on the "Not configured" placeholder
  // (which posts an empty method ⇒ null), leaves the type unconfigured — which is correct: neither of
  // those told us how this type earns, and until something does, granting is exactly the risk the marker
  // exists to hold off.
  const clearsUnconfigured = p.accrualMethod !== undefined && p.accrualMethod !== null;
  if (clearsUnconfigured) set.accrualUnconfigured = null;
  if (Object.keys(set).length === 0) return { unconfiguredCleared: false };

  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({
        accrualMethod: leaveType.accrualMethod,
        // bc36c768 — both new columns ride the before/after payload. The marker especially: "this save is
        // what took the type out of NOT CONFIGURED" is the single most useful fact in the audit trail
        // during the reset window, and it is only legible if the transition is recorded.
        accrualDay: leaveType.accrualDay,
        accrualUnconfigured: leaveType.accrualUnconfigured,
        carryForwardEnabled: leaveType.carryForwardEnabled,
        carryForwardMax: leaveType.carryForwardMax,
        carryForwardPercent: leaveType.carryForwardPercent,
        carryForwardExpiryMode: leaveType.carryForwardExpiryMode,
        carryForwardExpiryMonths: leaveType.carryForwardExpiryMonths,
        carryForwardExpiryMonth: leaveType.carryForwardExpiryMonth,
        carryForwardExpiryDay: leaveType.carryForwardExpiryDay,
        carryForwardIncludeEarned: leaveType.carryForwardIncludeEarned,
        roundingMethod: leaveType.roundingMethod,
        roundingThreshold: leaveType.roundingThreshold,
        roundingBands: leaveType.roundingBands,
        maxBalanceDays: leaveType.maxBalanceDays,
      })
      .from(leaveType)
      .where(eq(leaveType.id, p.id))
      .limit(1);
    if (!before) throw new LeaveTypeRuleError('Leave type not found.');

    // 8fec719e — THE UNRULED FALL-THROUGH GUARD. hasAnyLeaveTypeRule is a null test across the rule
    // columns, and applyLeaveTypeRules returns the LEGACY GRADE POLICY VERBATIM when it says false. So on
    // a type whose only remaining rule is its rounding, clearing rounding to NULL does not just switch
    // rounding off — it flips the type to "unruled" and silently restores its entire legacy JSONB rule
    // set: a different earning method, a different carry cap, a different balance, all under the heading
    // of a rounding change.
    //
    // The fix is to store the explicit string 'none' instead of NULL. It is a value, so the type stays
    // ruled; `isEngineRoundingMethod('none')` is false, so applyLeaveTypeRules resolves it to undefined
    // and nothing is rounded. Identical behaviour, without the fall-through. This guard belongs HERE and
    // not only in migration 0358, because the migration fixes the rows that exist on deploy day and this
    // fixes every save afterwards — the trap re-arms itself the moment someone saves No Rounding on a
    // type that has since lost its other rules.
    const merged = { ...before, ...set } as Record<string, unknown>;
    const clearsToUnruled =
      set.roundingMethod === null &&
      !hasAnyLeaveTypeRule({ ...merged, roundingMethod: null } as Parameters<typeof hasAnyLeaveTypeRule>[0]);
    if (clearsToUnruled) set.roundingMethod = 'none';

    await tx.update(leaveType).set(set).where(eq(leaveType.id, p.id));

    // The rules decide what every employee accrues, carries and forfeits, so the change is recorded with
    // both sides. `after` is the merge, not the posted patch — a reader must see the resulting state.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-type',
      aggregateId: p.id,
      eventType: 'leave-type.rules.updated',
      actor: actorOf(ctx),
      payload: { before, after: { ...before, ...set } },
    });
    // bc36c768 — reported to the CALLER, not acted on here. The catch-up cohort reproject must run AFTER
    // this transaction commits (each per-employee recalc opens its own transaction and must read the
    // COMMITTED rules), so this returns the fact and the action fires the reproject. Doing it inline would
    // have every employee reproject against the pre-save configuration.
    return { unconfiguredCleared: clearsUnconfigured && before.accrualUnconfigured != null };
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
/** Thrown when a leave type cannot be deleted because real leave history hangs off it. Names the tables
 *  that hold it, so the admin is told WHICH kind of history rather than "in use". */
export class LeaveTypeHasHistoryError extends Error {
  constructor(public readonly holders: { table: string; rows: number }[]) {
    const what = holders.map((h) => `${h.table} (${h.rows})`).join(', ');
    super(
      `This leave type cannot be deleted because leave has been recorded under it: ${what}. Archive it instead — archiving hides it from new applications and keeps the records intact.`,
    );
    this.name = 'LeaveTypeHasHistoryError';
  }
}

/**
 * Delete a leave type, taking its CONFIGURATION with it (items 1ae7f3ab + 4fdb69b2, one change).
 *
 * ## What changed, and why the old guard was not merely incomplete
 *
 * The old body counted five tables and refused if any held a row, while `listLeaveTypes` decided which
 * BUTTON to show from a different list of three, and the database carries TWELVE foreign keys. So Delete
 * was offered on types Postgres would refuse — Special Leave being the reported case, blocked by two
 * approval rules and by Caregiver Leave drawing its balance from it, neither of which either list counted.
 *
 * Both lists are gone. `core/leave-type-refs.ts` is now the only declaration, and this function and the
 * `inUse` predicate are both generated from it, so the button and the guard cannot span different tables.
 *
 * ## The cascade, and the line it does not cross
 *
 * The reporter asked for the configuration to be cleared automatically rather than by hand. So `config`
 * referrers are deleted here, in ONE transaction with the type itself — a partial cascade is impossible;
 * if any statement fails the type and every reference survive untouched.
 *
 * `history` referrers are NOT cascaded and never will be. "Remove all backend dependencies" meant
 * configuration; nobody asked to erase leave people actually took. When history exists this REFUSES and
 * says which table holds it, and the panel offers Archive instead.
 *
 * The self-reference is nulled on the OTHER type, not cascaded — deleting Caregiver Leave because it
 * pointed at Special Leave would be catastrophic.
 *
 * ## The limb that was on death row is now safe by construction
 *
 * The previous comment here warned that `leave_policy` is one of the counted tables and that 6e9a126e's
 * release three DROPS it, so the limb had to be replaced before the table went. That hazard is now
 * structural rather than remembered: the drift test fails the moment the declared set stops matching the
 * live foreign keys, in either direction, so removing the table forces the declaration to be updated.
 */
export async function deleteLeaveType(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    // 1. REFUSE on history. Counted from the shared declaration, so this can never count a different set
    //    of tables from the predicate that decided to show the button.
    //    The table and column come from the declaration and go through sql.identifier (quoted, never
    //    interpolated); the id is BOUND as a parameter. Building this string by hand would put a value
    //    from a form into raw SQL.
    const holders: { table: string; rows: number }[] = [];
    for (const ref of historyReferrers()) {
      const rows = (await tx.execute(
        sql`select count(*)::int as n from ${sql.identifier(ref.table)} where ${sql.identifier(ref.column)} = ${p.id}::uuid`,
      )) as unknown as { n: number }[];
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) holders.push({ table: ref.table, rows: n });
    }
    if (holders.length > 0) throw new LeaveTypeHasHistoryError(holders);

    // 2. Clear the SELF-reference on other types. Their balance source becomes null; they are not touched
    //    otherwise and are certainly not deleted.
    await tx
      .update(leaveType)
      .set({ balanceSourceTypeId: null })
      .where(eq(leaveType.balanceSourceTypeId, p.id));

    // 3. Cascade CONFIG, in declaration order so children precede parents. entitlement_eligibility_rule
    //    reaches the type through its template's lineage rather than a foreign key, which is why the
    //    declaration carries the join instead of a plain column match.
    for (const ref of configReferrers()) {
      if (ref.viaTemplateLineage) {
        await tx.execute(
          sql`delete from ${sql.identifier(ref.table)} where ${sql.identifier(ref.column)} in (
                select lineage_id from entitlement_template where leave_type_id = ${p.id}::uuid)`,
        );
        continue;
      }
      await tx.execute(
        sql`delete from ${sql.identifier(ref.table)} where ${sql.identifier(ref.column)} = ${p.id}::uuid`,
      );
    }

    await tx.delete(leaveType).where(eq(leaveType.id, p.id));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'leave-type', aggregateId: p.id, eventType: 'leave-type.deleted', actor: actorOf(ctx), payload: {} });
  });
}

// Enhance Company General Tab (bc5d4891): normalize a nullable free-text field — undefined = untouched
// (tri-state, so a caller that omits a field never wipes it), empty/whitespace = cleared (null), else trimmed.
const normNullableText = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

// Website validation (bc5d4891): blank clears; a non-empty value must parse as an http(s) URL. Centralized
// here so the mutation is the single source of truth (the action is a thin FormData reader).
function normalizeWebsite(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const s = (v ?? '').trim();
  if (s === '') return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error('Website must be a valid URL, including http:// or https://.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Website must start with http:// or https://.');
  }
  return s;
}

export async function updateCompany(
  ctx: SessionContext,
  p: {
    id: string;
    legalName: string;
    registrationNo?: string;
    /** ADR-0080 D-14 — declare the company non-statutory when moving it to a country with no pack. */
    nonStatutory?: boolean;
    country?: string;
    currency?: string;
    // Company Information (bc5d4891)
    companyLabel?: string | null;
    industry?: string | null;
    website?: string | null;
    businessType?: string | null;
    // Contact Information (bc5d4891). `addressCountry` is display-only; it never overrides `country` above.
    addressLine1?: string | null;
    addressLine2?: string | null;
    addressLine3?: string | null;
    city?: string | null;
    state?: string | null;
    addressCountry?: string | null;
    postcode?: string | null;
    phone?: string | null;
    fax?: string | null;
  },
) {
  const legalName = cleanName(p.legalName, 'Legal name');
  const country = isoCode(p.country, 'MY', 'Country');
  const currency = currencyCode(p.currency);
  const website = normalizeWebsite(p.website);
  // Tri-state set: only include a General-tab profile field when the caller actually provided it, so an
  // omitted field is never nulled out. The action always sends the full form, so empty -> null persists.
  const put = (key: string, v: string | null | undefined) => (v === undefined ? {} : { [key]: v });
  const profileSet = {
    ...put('companyLabel', normNullableText(p.companyLabel)),
    ...put('industry', normNullableText(p.industry)),
    ...put('website', website),
    ...put('businessType', normNullableText(p.businessType)),
    ...put('addressLine1', normNullableText(p.addressLine1)),
    ...put('addressLine2', normNullableText(p.addressLine2)),
    ...put('addressLine3', normNullableText(p.addressLine3)),
    ...put('city', normNullableText(p.city)),
    ...put('state', normNullableText(p.state)),
    ...put('addressCountry', normNullableText(p.addressCountry)),
    ...put('postcode', normNullableText(p.postcode)),
    ...put('phone', normNullableText(p.phone)),
    ...put('fax', normNullableText(p.fax)),
  };
  const nextCore = { legalName, registrationNo: p.registrationNo?.trim() || null, country, currency };
  return withTenant(ctx, async (tx) => {
    // F7, the other half. createCompany gained requirePackFor above, but EDIT is the easier route into
    // the same state: the add-company form is a free-text 2-letter box, while the company panel renders
    // a select over the COMPLETE ISO list (components/company-panel.tsx:625, deliberately so since
    // 94ae7e1f). "Create as MY, then switch to SG" would otherwise land exactly the packless company
    // the create-side guard exists to prevent — leave engines that `continue` past every employee and a
    // holiday resolver that yields an empty calendar, with nobody told.
    //
    // Guarded on CHANGE, not on every save, and the difference is deliberate: a company already sitting
    // in a packless country (legacy data, or a direct insert) must stay editable — refusing to save its
    // phone number because of its country would be a new outage, not a fix. What is refused is MOVING a
    // company into a jurisdiction this installation cannot compute.
    //
    // ADR-0080 D-14: moving a company between countries now RE-DERIVES its tier rather than refusing.
    // Into a packed country → 'statutory'. Into a packless one → still refused unless the caller
    // declares it non-statutory, because a country change is exactly the typo-shaped mistake the
    // declaration exists to catch. A company that was already non-statutory keeps that tier when its
    // country changes to another packless one, and is PROMOTED to statutory when moved somewhere we
    // model — the tier follows the jurisdiction, never the other way round.
    const [current] = await tx
      .select({ country: company.country, statutoryTier: company.statutoryTier })
      .from(company)
      .where(eq(company.id, p.id));
    // Re-derived only when the country actually CHANGES, so an unrelated save never re-litigates the
    // tier of a company that is sitting still. The existing tier carries the declaration forward: a
    // company already declared non-statutory does not have to re-declare on every country edit.
    // An EXPLICIT declaration wins and is validated (declaring non-statutory into a packed country is
    // a user error and throws). An INHERITED tier is not a declaration, so it is only carried where it
    // can still apply: moving into a packed country PROMOTES to statutory rather than conflicting with
    // the old tier. Collapsing these two into one flag is what made the first version throw on the
    // TH → MY move it was written to allow.
    const inheritedDeclaration =
      packFor(country) ? false : current?.statutoryTier === NON_STATUTORY;
    const tierSet =
      current && current.country !== country
        ? { statutoryTier: resolveCompanyTier(country, p.nonStatutory ?? inheritedDeclaration) }
        : {};
    await tx
      .update(company)
      .set({ ...nextCore, ...tierSet, ...profileSet })
      .where(eq(company.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.id,
      eventType: 'company.updated',
      actor: actorOf(ctx),
      payload: { after: { ...nextCore, ...tierSet, ...profileSet } },
    });
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

/**
 * 10e96227 — set the half-day full-deduction flag for the WHOLE administrable set in one save.
 *
 * The stored shape is unchanged: still one boolean per company (company.leave_half_day_full_deduction).
 * What changes is that the caller states the complete set of companies the rule applies to, instead of
 * posting one company at a time. Companies in `companyIds` are turned ON; every other administrable
 * company is turned OFF. An empty list therefore means "applies nowhere", which is exactly what every
 * box unticked meant before.
 *
 * ⚠️ THE SCOPE IS `app.is_admin_for`, NOT "every company the session can SEE", and that distinction is the
 * whole reason this function resolves its own candidate set rather than trusting the posted ids.
 * `listCompanies(ctx)` is tenant-wide, but the company UPDATE policy is admin-for-company — so a
 * company-scoped hr_admin can see companies it cannot write. Under the old per-row UI that merely made one
 * row's Save a silent no-op. Under an authoritative set-write it would be worse in BOTH directions: an
 * unadministrable company omitted from the post would look like a deliberate "turn this off", and the
 * write would silently fail to apply it — leaving the screen and the database disagreeing. Resolving the
 * candidate set in SQL means the function can only ever rewrite rows the caller could have written
 * one-by-one, and the returned summary reports precisely what moved.
 *
 * ONE EVENT PER CHANGED COMPANY, and none for the unchanged. The event type and payload are byte-identical
 * to setLeaveHalfDayFullDeduction's, so existing audit consumers are unaffected; emitting a no-op event for
 * every untouched company on every save would bury the real changes in the trail.
 *
 * Frozen at submission (D6) as before — flipping this never recomputes already-submitted or approved leave.
 */
export async function setLeaveHalfDayFullDeductionCompanies(
  ctx: SessionContext,
  p: { companyIds: string[] },
): Promise<{ enabled: string[]; disabled: string[]; unchanged: number }> {
  const wanted = new Set(p.companyIds);
  return withTenant(ctx, async (tx) => {
    const candidates = await tx
      .select({ id: company.id, enabled: company.leaveHalfDayFullDeduction })
      .from(company)
      .where(and(isNull(company.archivedAt), sql`app.is_admin_for(company.id)`));

    const enabled: string[] = [];
    const disabled: string[] = [];
    let unchanged = 0;

    for (const c of candidates) {
      const next = wanted.has(c.id);
      const before = !!c.enabled;
      if (next === before) {
        unchanged += 1;
        continue;
      }
      await tx.update(company).set({ leaveHalfDayFullDeduction: next }).where(eq(company.id, c.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'company',
        aggregateId: c.id,
        eventType: 'company.leave-half-day-deduction.changed',
        actor: actorOf(ctx),
        payload: { before, after: next },
      });
      (next ? enabled : disabled).push(c.id);
    }
    return { enabled, disabled, unchanged };
  });
}
// ─────────────────────────── Company logo (branding) ───────────────────────────
// A 1:1 logo stored in the company_logo SIDE TABLE (schema.ts). PNG/JPEG only; the mime is sniffed from
// magic bytes at the action boundary before it reaches here (SVG is excluded — scriptable). Read is
// tenant-wide (branding), WRITE is admin-of-the-company (RLS company_logo_rls WITH CHECK). updateCompany is
// UNTOUCHED — the logo is a separate mutation so the company details form stays byte-identical to today.
export const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB, same cap the app uses elsewhere
export const ALLOWED_LOGO_MIME = ['image/png', 'image/jpeg'] as const;

/** Fail-closed logo validation (empty / oversized / disallowed MIME). Mirrors the claims
 *  assertValidAttachment shape so callers reject the same files with the same-shaped errors. */
function assertValidLogo(mimeType: string, content: Buffer): void {
  if (content.byteLength === 0) throw new Error('Empty file');
  if (content.byteLength > LOGO_MAX_BYTES) throw new Error('Logo exceeds 2 MB');
  if (!(ALLOWED_LOGO_MIME as readonly string[]).includes(mimeType)) {
    throw new Error('Only PNG or JPG images are allowed');
  }
}

/** Upsert a company's logo (insert-or-update on the unique company_id). Substrate: appends company.logo.set
 *  with ONLY derived, non-PII payload fields — never the bytes and never the raw user-supplied fileName
 *  (PDPA / ADR-0030 posture). */
export async function setCompanyLogo(
  ctx: SessionContext,
  p: { companyId: string; content: Buffer; fileName: string; mimeType: string; sizeBytes: number },
) {
  assertValidLogo(p.mimeType, p.content);
  return withTenant(ctx, async (tx) => {
    await tx
      .insert(companyLogo)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.sizeBytes,
        uploadedByUserId: ctx.userId ?? null,
      })
      .onConflictDoUpdate({
        target: companyLogo.companyId,
        set: {
          content: p.content,
          fileName: p.fileName,
          mimeType: p.mimeType,
          sizeBytes: p.sizeBytes,
          uploadedByUserId: ctx.userId ?? null,
          updatedAt: sql`now()`,
        },
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.companyId,
      eventType: 'company.logo.set',
      actor: actorOf(ctx),
      payload: { mimeType: p.mimeType, sizeBytes: p.sizeBytes },
    });
    return { companyId: p.companyId };
  });
}

/** Remove a company's logo. No-op-safe if none exists. Substrate: appends company.logo.removed (no fileName). */
export async function removeCompanyLogo(ctx: SessionContext, p: { companyId: string }) {
  return withTenant(ctx, async (tx) => {
    await tx.delete(companyLogo).where(eq(companyLogo.companyId, p.companyId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.companyId,
      eventType: 'company.logo.removed',
      actor: actorOf(ctx),
      payload: { removed: true },
    });
    return { companyId: p.companyId };
  });
}

/** Read a company's logo bytes for the serve route (RLS scopes visibility to same-tenant members). */
export async function getCompanyLogo(
  ctx: SessionContext,
  companyId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ content: companyLogo.content, fileName: companyLogo.fileName, mimeType: companyLogo.mimeType })
      .from(companyLogo)
      .where(eq(companyLogo.companyId, companyId))
      .limit(1);
    return row ? { content: row.content, fileName: row.fileName, mimeType: row.mimeType } : null;
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
