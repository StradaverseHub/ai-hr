/**
 * Board 511aa74a — REHIRED: a resigned employee comes back (docs/adr/2026-11-15-rehired-movement.md).
 *
 * THE SHAPE. USER, PERSON, EMPLOYEE and EMPLOYMENT stay distinct (GLOSSARY.md). The returning employee is the
 * SAME PERSON (personal details, IC, EPF/SOCSO/tax numbers and bank details are person-keyed) with the SAME
 * login, and starts a NEW EMPLOYMENT with a NEW Employee ID. employee_code is unique per tenant across
 * employments and imports find employees by it, and each period's payslips and EA Forms stay with the ID they
 * were issued under. The previous employment is never written: its rows, its events and its Resigned status
 * stay exactly as they were. The two periods are linked by employment.rehired_from_employment_id (migration
 * 5695), which only this module writes.
 *
 * THE OWNER. rehireEmploymentTx composes the existing hire owner (hireEmployee: assignment, reporting line,
 * probation default, opening leave grants, tax selection, organisation tags), the salary owner
 * (setCompensation) and the payment-method owner in ONE transaction with the link and the Rehired event. The
 * generic movement dispatcher refuses the kind (no writer there), the movement import never offers it, and a
 * Rehired history row is never corrected or rolled back through the generic paths (correctabilityOf). Roll Back
 * is rollBackRehire below: it voids the new employment through the 5695 void writer while the period has no
 * activity, and names what blocks it otherwise.
 *
 * PERMISSIONS. An admin (super_admin / hr_admin, the movement rule) with Workforce maintain on the previous
 * period, on the person, and on the destination company, who administers the destination company
 * (app.is_admin_for, the hire rule). The reads below authorize first and read one bounded set per concern.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { assignment, company, compensation, domainEvent, employment, reportingLine } from '../db/schema';
import { deriveEmploymentStatus, type EmploymentStatus } from './employment-status';
import { computeProvisionalEndOn, hireEmployee, resolveProbationMonths, setEmploymentPaymentMethod, type EmploymentTypeValue } from './org';
import { setCompensation } from './comp';
import { listLeaveTypes } from './read';
import { assertWorkforceCompanyTx, assertWorkforceEmploymentTx, assertWorkforcePersonTx, WorkforceAccessError, workforceEmploymentSetPredicate } from './workforce-access';
import { withPersonnelRead } from './personnel-read-bounds';
import { lockMovementTypeCatalogueTx, resolveMovementEventTypeTx } from './movement-type';
import { issueEmployeeCode, listConfigs, resolveEmployeeIdRule } from './employee-id-config';
import { findEmployeeCodeClaim } from './employee-code-claims';
import { lockLeaveDependencyConfigurationTx } from './leave-dependency-lock';
import { requireEmployeeCode } from '../lib/employee-code';
import { resolveEmployeeIdMode, type EmployeeIdRule } from '../lib/employee-id-mode';
import { isCalendarDate } from '../lib/calendar-date';
import { todayInKualaLumpur } from '../lib/hr-date';

/** The built-in catalogue code of the Rehired event type (a tenant may rename or switch it off, never remap it). */
export const REHIRE_KIND = 'rehire';
const STANDING_GRANTS = new Set(['ANNUAL', 'SICK', 'HOSPITALIZATION']);
const MAX_AUTO_CODE_SKIPS = 50;
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Finite refusal codes; the screens translate them (people.detail.movement.rehire.error.*). */
export type RehireRefusal =
  | 'permission' | 'type_inactive' | 'not_resigned' | 'blacklisted' | 'current_employment' | 'already_rehired'
  | 'date_invalid' | 'date_not_after_end' | 'group_join_date_invalid' | 'company_unavailable' | 'department_required'
  | 'employment_type_invalid' | 'salary_invalid' | 'employee_code_required' | 'employee_code_not_allowed'
  | 'employee_code_invalid' | 'employee_code_taken' | 'manager_invalid' | 'reason_required' | 'rollback_unavailable'
  | 'rollback_blocked';

export class RehireError extends Error {
  constructor(readonly code: RehireRefusal, readonly detail: Record<string, string> = {}, message?: string) {
    super(message ?? `rehire_${code}`);
    this.name = 'RehireError';
  }
}

export type RehireInput = {
  /** The previous (resigned) employment period. */
  fromEmploymentId: string;
  /** Rehired Effective Date: the first day of the new period ('YYYY-MM-DD'). */
  effectiveDate: string;
  /** Group Join Date of the new period. Defaults to the effective date; may be earlier when service continues. */
  groupJoinDate?: string | null;
  /** 'auto' issues the company's next running number at save; 'manual' uses `employeeCode`. */
  employeeIdMode?: 'auto' | 'manual' | null;
  employeeCode?: string | null;
  companyId: string;
  businessUnitId?: string | null;
  departmentId: string;
  positionId?: string | null;
  gradeId?: string | null;
  employmentType: string;
  basicSalary: number;
  currency?: string | null;
  managerEmploymentId?: string | null;
  remarks?: string | null;
};

function assertRehireAdmin(ctx: SessionContext) {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) throw new RehireError('permission');
}

const blank = (v: string | null | undefined) => {
  const s = (v ?? '').trim();
  return s ? s : null;
};

/** One advisory lock per person: two rehires of the same person serialize, so neither sees the other's absence. */
async function lockPersonEmploymentsTx(tx: Tx, tenantId: string, personId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'employment-person:' + tenantId + ':' + personId}, 0))`);
}

type SourceRow = {
  id: string; personId: string; companyId: string; employeeCode: string | null; hiredOn: string;
  joinDate: string | null; terminatedOn: string | null; lastWorkingDate: string | null; resignationDate: string | null;
  blacklistedAt: string | null; confirmationDate: string | null; finalConfirmationDate: string | null;
  probationEndDate: string | null; provisionalEndOn: string | null; gradeId: string | null; paymentMethod: string | null;
};

async function sourceTx(tx: Tx, employmentId: string): Promise<SourceRow | null> {
  if (!UUID.test(employmentId)) return null;
  const [row] = await tx
    .select({
      id: employment.id, personId: employment.personId, companyId: employment.companyId, employeeCode: employment.employeeCode,
      hiredOn: employment.hiredOn, joinDate: employment.joinDate, terminatedOn: employment.terminatedOn,
      lastWorkingDate: employment.lastWorkingDate, resignationDate: employment.resignationDate,
      blacklistedAt: employment.blacklistedAt, confirmationDate: employment.confirmationDate,
      finalConfirmationDate: employment.finalConfirmationDate, probationEndDate: employment.probationEndDate,
      provisionalEndOn: employment.provisionalEndOn, gradeId: employment.gradeId, paymentMethod: employment.paymentMethod,
    })
    .from(employment)
    .where(and(eq(employment.id, employmentId), isNull(employment.voidedAt)))
    .limit(1);
  return row ?? null;
}

type PersonState = { openPeriods: number; blacklistedPeriods: number; latestEnd: string | null; rehiredAsCode: string | null };

async function personStateTx(tx: Tx, sourceId: string, today: string): Promise<PersonState> {
  const [row] = await tx.execute<{ open_periods: number; blacklisted_periods: number; latest_end: string | null; rehired_as_code: string | null }>(
    sql`select open_periods,blacklisted_periods,latest_end::text as latest_end,rehired_as_code from app.employment_rehire_person_state(${sourceId}::uuid,${today}::date)`,
  );
  return {
    openPeriods: Number(row?.open_periods ?? 0),
    blacklistedPeriods: Number(row?.blacklisted_periods ?? 0),
    latestEnd: row?.latest_end ?? null,
    rehiredAsCode: row?.rehired_as_code ?? null,
  };
}

/** The earliest of the previous period's end dates: what "Resigned" is derived from. */
function sourceEnd(s: SourceRow): string | null {
  return [s.resignationDate, s.lastWorkingDate, s.terminatedOn].filter((d): d is string => !!d).sort()[0] ?? null;
}

/** Why this period cannot be rehired today, or null when it can. The same rule the command enforces. */
function eligibilityRefusal(source: SourceRow, state: PersonState, today: string): { code: RehireRefusal; detail?: Record<string, string> } | null {
  const status: EmploymentStatus = deriveEmploymentStatus(source, today);
  if (status === 'blacklisted' || state.blacklistedPeriods > 0) return { code: 'blacklisted' };
  if (state.rehiredAsCode !== null) return { code: 'already_rehired', detail: { code: state.rehiredAsCode } };
  if (status !== 'resigned') return { code: 'not_resigned' };
  if (state.openPeriods > 0) return { code: 'current_employment' };
  return null;
}

/** Form defaults: the previous period's LAST live placement and pay (a resignation closes the open rows). */
async function previousValuesTx(tx: Tx, source: SourceRow) {
  const [asg] = await tx
    .select({
      companyId: assignment.companyId, departmentId: assignment.departmentId, positionId: assignment.positionId,
      businessUnitId: assignment.businessUnitId, employmentType: assignment.employmentType,
    })
    .from(assignment)
    .where(and(eq(assignment.employmentId, source.id), isNull(assignment.supersededAt)))
    .orderBy(desc(assignment.validFrom))
    .limit(1);
  const [comp] = await tx
    .select({
      basicSalary: compensation.basicSalary, currency: compensation.currency, payMode: compensation.payMode,
      paymentTerm: compensation.paymentTerm, rateAmount: compensation.rateAmount,
    })
    .from(compensation)
    .where(and(eq(compensation.employmentId, source.id), isNull(compensation.supersededAt)))
    .orderBy(desc(compensation.validFrom))
    .limit(1);
  const [line] = await tx
    .select({ managerEmploymentId: reportingLine.managerEmploymentId })
    .from(reportingLine)
    .where(and(eq(reportingLine.subordinateEmploymentId, source.id), eq(reportingLine.lineType, 'administrative'), isNull(reportingLine.supersededAt)))
    .orderBy(desc(reportingLine.validFrom))
    .limit(1);
  return {
    companyId: asg?.companyId ?? source.companyId,
    departmentId: asg?.departmentId ?? null,
    positionId: asg?.positionId ?? null,
    businessUnitId: asg?.businessUnitId ?? null,
    employmentType: asg?.employmentType ?? 'full_time',
    gradeId: source.gradeId,
    basicSalary: comp?.basicSalary ?? null,
    currency: comp?.currency ?? null,
    payMode: comp?.payMode ?? null,
    paymentTerm: comp?.paymentTerm ?? null,
    rateAmount: comp?.rateAmount ?? null,
    managerEmploymentId: line?.managerEmploymentId ?? null,
  };
}

export type RehireFormDefaults = {
  /** Null when Rehired can be offered; otherwise why not (the command refuses the same). */
  refusal: { code: RehireRefusal; detail?: Record<string, string> } | null;
  previousEmployeeCode: string | null;
  previousStart: string;
  previousEnd: string | null;
  /** The effective date must be AFTER this date (the latest end of any of the person's periods). */
  notOnOrBefore: string | null;
  values: Awaited<ReturnType<typeof previousValuesTx>>;
  /** The Employee ID rule (and its suggested next number) for each company the form may choose. */
  employeeIdRules: Record<string, EmployeeIdRule>;
};

/**
 * The New Event screen's Rehired read: whether it may be offered, and the previous period's values. Authorizes
 * first (Workforce maintain on the previous period), then reads one row per concern.
 */
export async function rehireFormDefaults(ctx: SessionContext, employmentId: string, companyIds: readonly string[] = []): Promise<RehireFormDefaults | null> {
  if (!(ctx.roles ?? []).some((r) => r === 'super_admin' || r === 'hr_admin') || !UUID.test(employmentId)) return null;
  return withPersonnelRead(ctx, async (tx) => {
    const [allowed] = await tx.execute<{ allowed: boolean }>(
      sql`select app.access_workforce_employment(${employmentId}::uuid,'workforce.maintain') as allowed`,
    );
    if (allowed?.allowed !== true) return null;
    const source = await sourceTx(tx, employmentId);
    if (!source) return null;
    const today = todayInKualaLumpur();
    const state = await personStateTx(tx, source.id, today);
    const values = await previousValuesTx(tx, source);
    const scope = [...new Set([values.companyId, ...companyIds].filter((id) => UUID.test(id)))];
    const configs = await listConfigs(ctx, scope, tx);
    return {
      refusal: eligibilityRefusal(source, state, today),
      previousEmployeeCode: source.employeeCode,
      previousStart: source.joinDate ?? source.hiredOn,
      previousEnd: sourceEnd(source),
      notOnOrBefore: state.latestEnd,
      values,
      employeeIdRules: Object.fromEntries(scope.map((id) => [id, resolveEmployeeIdRule(configs, id)])),
    };
  });
}

/** The Employee ID the new period takes: the typed one (when the company's setup allows it) or the next number. */
async function rehireEmployeeCodeTx(tx: Tx, ctx: SessionContext, companyId: string, input: RehireInput): Promise<string> {
  const rule: EmployeeIdRule = resolveEmployeeIdRule(await listConfigs(ctx, [companyId], tx), companyId);
  const typed = blank(input.employeeCode);
  const decision = resolveEmployeeIdMode(rule, { chosen: input.employeeIdMode ?? null, hasCode: typed !== null });
  if (decision.mode === 'manual') {
    if (!typed) throw new RehireError('employee_code_required');
    let code: string;
    try { code = requireEmployeeCode(typed); } catch { throw new RehireError('employee_code_invalid'); }
    if (await findEmployeeCodeClaim(tx, ctx.tenantId, code)) throw new RehireError('employee_code_taken', { code });
    return code;
  }
  if (typed && input.employeeIdMode === 'manual' && decision.forcedBecause === 'manualNotAllowed') {
    throw new RehireError('employee_code_not_allowed');
  }
  // Auto: the company's running number, skipping numbers already held (the Create Employee rule).
  for (let attempt = 0; attempt < MAX_AUTO_CODE_SKIPS; attempt += 1) {
    const issued = await issueEmployeeCode(tx, ctx.tenantId, companyId);
    if (!issued) throw new RehireError('employee_code_required');
    if ((await findEmployeeCodeClaim(tx, ctx.tenantId, issued.code)) === null) return issued.code;
  }
  throw new RehireError('employee_code_taken');
}

/**
 * Record a Rehired event: a new employment for the same person from the effective date. One transaction: the
 * hire, the salary, the payment method, the link and the Rehired event commit together or not at all.
 */
export async function rehireEmployment(ctx: SessionContext, input: RehireInput) {
  assertRehireAdmin(ctx);
  return withTenant(ctx, (tx) => rehireEmploymentTx(tx, ctx, input));
}

export async function rehireEmploymentTx(tx: Tx, supplied: SessionContext, input: RehireInput) {
  const ctx: SessionContext = { ...supplied, roles: supplied.roles?.slice(), grants: supplied.grants?.map((g) => ({ ...g })) };
  assertRehireAdmin(ctx);
  const effectiveDate = (input.effectiveDate ?? '').trim();
  if (!isCalendarDate(effectiveDate)) throw new RehireError('date_invalid');
  const groupJoinDate = blank(input.groupJoinDate) ?? effectiveDate;
  if (!isCalendarDate(groupJoinDate) || groupJoinDate > effectiveDate) throw new RehireError('group_join_date_invalid');
  const employmentType = (input.employmentType ?? '').trim();
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(employmentType)) throw new RehireError('employment_type_invalid');
  const departmentId = blank(input.departmentId);
  if (!departmentId || !UUID.test(departmentId)) throw new RehireError('department_required');
  if (!Number.isFinite(input.basicSalary) || input.basicSalary < 0) throw new RehireError('salary_invalid');
  const companyId = (input.companyId ?? '').trim();
  if (!UUID.test(companyId)) throw new RehireError('company_unavailable');
  for (const id of [input.businessUnitId, input.positionId, input.gradeId, input.managerEmploymentId]) {
    if (blank(id) && !UUID.test(blank(id)!)) throw new RehireError('company_unavailable');
  }

  // Authorize first, on the Workforce barrier every maintain owner (and hireEmployee) joins.
  if (!UUID.test(input.fromEmploymentId)) throw new WorkforceAccessError();
  await assertWorkforceEmploymentTx(tx, ctx, input.fromEmploymentId, 'maintain');
  const unlocked = await sourceTx(tx, input.fromEmploymentId);
  if (!unlocked) throw new WorkforceAccessError();
  await assertWorkforcePersonTx(tx, ctx, unlocked.personId, 'maintain');
  await assertWorkforceCompanyTx(tx, ctx, companyId, 'maintain');
  const [target] = await tx
    .select({ id: company.id, probationMonths: company.probationMonths })
    .from(company)
    .where(and(eq(company.tenantId, ctx.tenantId), eq(company.id, companyId), isNull(company.archivedAt), sql`app.is_admin_for(${company.id})`))
    .limit(1);
  if (!target) throw new RehireError('company_unavailable');

  // The event type: the built-in Rehired, possibly renamed, refused when switched off. Shared catalogue lock as
  // every movement write takes, so a settings change cannot interleave with this use.
  await lockMovementTypeCatalogueTx(tx, ctx.tenantId);
  const type = await resolveMovementEventTypeTx(tx, ctx.tenantId, REHIRE_KIND);
  if (!type || type.behaviourKind !== REHIRE_KIND || !type.active) throw new RehireError('type_inactive');

  // Admission, under the person's lock and re-read inside it.
  await lockPersonEmploymentsTx(tx, ctx.tenantId, unlocked.personId);
  const source = await sourceTx(tx, input.fromEmploymentId);
  if (!source) throw new WorkforceAccessError();
  const today = todayInKualaLumpur();
  const state = await personStateTx(tx, source.id, today);
  const refusal = eligibilityRefusal(source, state, today);
  if (refusal) throw new RehireError(refusal.code, refusal.detail);
  const notOnOrBefore = state.latestEnd ?? sourceEnd(source);
  if (notOnOrBefore && effectiveDate <= notOnOrBefore) throw new RehireError('date_not_after_end', { date: notOnOrBefore });

  const managerEmploymentId = blank(input.managerEmploymentId);
  if (managerEmploymentId) {
    const [manager] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(and(eq(employment.id, managerEmploymentId), eq(employment.tenantId, ctx.tenantId), isNull(employment.voidedAt)))
      .limit(1);
    if (!manager || manager.personId === source.personId) throw new RehireError('manager_invalid');
  }

  const employeeCode = await rehireEmployeeCodeTx(tx, ctx, companyId, input);
  const previous = await previousValuesTx(tx, source);
  const types = await listLeaveTypes(ctx, {}, tx);
  const { employmentId } = await hireEmployee(ctx, {
    person: { id: source.personId },
    companyId,
    departmentId,
    positionId: blank(input.positionId) ?? undefined,
    businessUnitId: blank(input.businessUnitId) ?? undefined,
    gradeId: blank(input.gradeId),
    employmentType: employmentType as EmploymentTypeValue,
    hiredOn: effectiveDate,
    employeeCode,
    reportingManagerEmploymentId: managerEmploymentId ?? undefined,
    // The company's probation setting decides Probation or Active from the effective date, as for a new joiner.
    provisionalEndOn: computeProvisionalEndOn(effectiveDate, employmentType as EmploymentTypeValue, resolveProbationMonths(target.probationMonths)),
    grantLeaveTypes: types
      .filter((t) => STANDING_GRANTS.has(t.code))
      .map((t) => ({ id: t.id, code: t.code, yearCycleOverride: t.yearCycleOverride })),
  }, tx);

  // An earlier Group Join Date (service continues) moves only hired_on; the period itself starts on the
  // effective date (join date, assignment, salary and opening leave grants all start there).
  if (groupJoinDate < effectiveDate) {
    await tx.update(employment).set({ hiredOn: groupJoinDate }).where(eq(employment.id, employmentId));
  }

  // Pay structure carries over from the previous period; the basic salary and currency are what HR entered.
  const sameStructure = previous.payMode && previous.paymentTerm;
  await setCompensation(ctx, {
    employmentId,
    basicSalary: input.basicSalary,
    ...(blank(input.currency) ? { currency: blank(input.currency)! } : previous.currency ? { currency: previous.currency } : {}),
    ...(sameStructure ? { payMode: previous.payMode!, paymentTerm: previous.paymentTerm!, rateAmount: previous.rateAmount == null ? null : Number(previous.rateAmount) } : {}),
    effectiveFrom: effectiveDate,
  }, tx);
  if (source.paymentMethod) {
    await setEmploymentPaymentMethod(ctx, { employmentId, paymentMethod: source.paymentMethod as Parameters<typeof setEmploymentPaymentMethod>[1]['paymentMethod'] }, tx);
  }

  // The link, through its guard (5695): the marker names the employment this command is linking.
  await tx.execute(sql`select pg_catalog.set_config('app.rehire_link', ${employmentId}, true)`);
  try {
    await tx.update(employment).set({ rehiredFromEmploymentId: source.id }).where(eq(employment.id, employmentId));
  } catch (e) {
    const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
    const c = err.cause ?? err;
    if (c.code === '23505' && (c.constraint ?? '').includes('rehired_from')) throw new RehireError('already_rehired');
    throw e;
  }
  await tx.execute(sql`select pg_catalog.set_config('app.rehire_link', '', true)`);

  // The Rehired event: Employment History's row on the new period, and the audit trail of who recorded it,
  // when, the effective date and every detail entered. Pay amounts stay on the compensation row (ADR-0030).
  const remarks = blank(input.remarks);
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'employment',
    aggregateId: employmentId,
    eventType: 'employment.movement.recorded',
    actor: actorOf(ctx),
    subjectEmploymentId: employmentId,
    payload: {
      type: REHIRE_KIND,
      effectiveDate,
      endDate: null,
      remarks,
      fromEmploymentId: source.id,
      previousEmployeeCode: source.employeeCode,
      employeeCode,
      groupJoinDate,
      values: {
        companyId, businessUnitId: blank(input.businessUnitId), departmentId, positionId: blank(input.positionId),
        gradeId: blank(input.gradeId), employmentType, managerEmploymentId,
        currency: blank(input.currency) ?? previous.currency ?? null,
      },
    },
  });
  return { employmentId, employeeCode, personId: source.personId, fromEmploymentId: source.id, groupJoinDateEarlier: groupJoinDate < effectiveDate };
}

export type RehireRollbackBlocker = { source: string; count: number };

/** Why this rehired period cannot be rolled back now (empty when it can). Read-only; same rule as the writer. */
export async function rehireRollbackBlockersTx(tx: Tx, employmentId: string): Promise<RehireRollbackBlocker[]> {
  const rows = await tx.execute<{ source: string; row_count: string | number }>(
    sql`select source,row_count from app.employment_rehire_rollback_blockers(${employmentId}::uuid) order by source`,
  );
  return rows.map((r) => ({ source: r.source, count: Number(r.row_count) }));
}

/**
 * Roll Back a Rehired event: allowed only while the new period has no recorded activity. The new employment is
 * voided (its Employee ID released, its rows kept for audit); the previous period is untouched and stays
 * Resigned. Otherwise refused with the blockers named.
 */
export async function rollBackRehire(ctx: SessionContext, p: { employmentId: string; reason: string }) {
  assertRehireAdmin(ctx);
  const reason = (p.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 1000) throw new RehireError('reason_required');
  return withTenant(ctx, async (tx) => {
    if (!UUID.test(p.employmentId)) throw new WorkforceAccessError();
    await assertWorkforceEmploymentTx(tx, ctx, p.employmentId, 'maintain');
    await lockLeaveDependencyConfigurationTx(tx, ctx.tenantId);
    const [row] = await tx
      .select({ personId: employment.personId, employeeCode: employment.employeeCode, fromEmploymentId: employment.rehiredFromEmploymentId })
      .from(employment)
      .where(and(eq(employment.id, p.employmentId), isNull(employment.voidedAt)))
      .limit(1);
    if (!row) throw new WorkforceAccessError();
    if (!row.fromEmploymentId) throw new RehireError('rollback_unavailable');
    await lockPersonEmploymentsTx(tx, ctx.tenantId, row.personId);
    const blockers = await rehireRollbackBlockersTx(tx, p.employmentId);
    if (blockers.length) throw new RehireError('rollback_blocked', { sources: blockers.map((b) => b.source).join(',') });
    const [rehired] = await tx
      .select({ id: domainEvent.id })
      .from(domainEvent)
      .where(and(
        eq(domainEvent.tenantId, ctx.tenantId), eq(domainEvent.subjectEmploymentId, p.employmentId),
        eq(domainEvent.eventType, 'employment.movement.recorded'), sql`${domainEvent.payload}->>'type' = ${REHIRE_KIND}`,
      ))
      .orderBy(desc(domainEvent.sequence))
      .limit(1);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.rehire.rolled-back',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { movementId: rehired?.id ?? null, fromEmploymentId: row.fromEmploymentId, employeeCode: row.employeeCode, reason },
    });
    await tx.execute(sql`select employment_id from app.employment_rehire_rollback(${p.employmentId}::uuid, ${reason})`);
    return { employmentId: p.employmentId, fromEmploymentId: row.fromEmploymentId };
  });
}

export type EmploymentPeriod = {
  employmentId: string;
  employeeCode: string | null;
  companyName: string | null;
  start: string;
  end: string | null;
  status: EmploymentStatus;
  current: boolean;
  rehiredFromEmploymentId: string | null;
  /** The period that rehired from this one (the "Rehired as" link), when the reader may see it. */
  rehiredAs: { employmentId: string; employeeCode: string | null } | null;
};

const PERIODS_LIMIT = 50;

/**
 * The Employment Periods card: every period of this employment's person the reader may see, newest first.
 * Authorize first (Workforce view of this employment), then ONE bounded statement for the person's periods.
 */
export function employmentPeriods(ctx: SessionContext, employmentId: string): Promise<EmploymentPeriod[]> {
  return withPersonnelRead(ctx, async (tx) => {
    if (!UUID.test(employmentId)) throw new WorkforceAccessError();
    const [allowed] = await tx.execute<{ allowed: boolean }>(
      sql`select app.access_workforce_employment(${employmentId}::uuid,'workforce.view') as allowed`,
    );
    if (allowed?.allowed !== true) throw new WorkforceAccessError();
    const rows = await tx
      .select({
        employmentId: employment.id, employeeCode: employment.employeeCode, companyName: company.legalName,
        hiredOn: employment.hiredOn, joinDate: employment.joinDate, terminatedOn: employment.terminatedOn,
        lastWorkingDate: employment.lastWorkingDate, resignationDate: employment.resignationDate,
        blacklistedAt: employment.blacklistedAt, confirmationDate: employment.confirmationDate,
        finalConfirmationDate: employment.finalConfirmationDate, probationEndDate: employment.probationEndDate,
        provisionalEndOn: employment.provisionalEndOn, rehiredFromEmploymentId: employment.rehiredFromEmploymentId,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(and(
        eq(employment.tenantId, ctx.tenantId),
        sql`${employment.personId} = (select e.person_id from employment e where e.id = ${employmentId}::uuid)`,
        workforceEmploymentSetPredicate({ tenantId: sql`${employment.tenantId}`, companyId: sql`${employment.companyId}`, voidedAt: sql`${employment.voidedAt}`, importPendingAttemptId: sql`${employment.importPendingAttemptId}` }, 'view'),
      ))
      .orderBy(desc(sql`coalesce(${employment.joinDate},${employment.hiredOn})`), desc(employment.createdAt))
      .limit(PERIODS_LIMIT);
    const today = todayInKualaLumpur();
    const byFrom = new Map(rows.filter((r) => r.rehiredFromEmploymentId).map((r) => [r.rehiredFromEmploymentId!, r]));
    return rows.map((r) => {
      const status = deriveEmploymentStatus(r, today);
      const next = byFrom.get(r.employmentId);
      return {
        employmentId: r.employmentId,
        employeeCode: r.employeeCode,
        companyName: r.companyName,
        start: r.joinDate ?? r.hiredOn,
        end: [r.resignationDate, r.lastWorkingDate, r.terminatedOn].filter((d): d is string => !!d).sort()[0] ?? null,
        status,
        current: status !== 'resigned',
        rehiredFromEmploymentId: r.rehiredFromEmploymentId,
        rehiredAs: next ? { employmentId: next.employmentId, employeeCode: next.employeeCode } : null,
      };
    });
  });
}

/**
 * Personnel search: "Rehired as {code}" for the page's own rows. One statement over the caller-bounded ids,
 * under the caller's Workforce snapshot (row security and the Workforce view predicate apply to the new period).
 */
export async function rehiredAsForEmploymentsTx(tx: Tx, employmentIds: readonly string[]): Promise<Map<string, { employmentId: string; employeeCode: string | null }>> {
  const ids = [...new Set(employmentIds.filter((id) => UUID.test(id)))].slice(0, 1000);
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ fromId: employment.rehiredFromEmploymentId, employmentId: employment.id, employeeCode: employment.employeeCode })
    .from(employment)
    .where(and(
      inArray(employment.rehiredFromEmploymentId, ids),
      workforceEmploymentSetPredicate({ tenantId: sql`${employment.tenantId}`, companyId: sql`${employment.companyId}`, voidedAt: sql`${employment.voidedAt}`, importPendingAttemptId: sql`${employment.importPendingAttemptId}` }, 'view'),
    ));
  return new Map(rows.filter((r) => r.fromId).map((r) => [r.fromId!, { employmentId: r.employmentId, employeeCode: r.employeeCode }]));
}
