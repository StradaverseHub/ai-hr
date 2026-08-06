/**
 * Create New Employee — drafts (item 6d671f44).
 *
 * A DRAFT IS CAPTURED INPUT, NOT A RECORD. Nothing is created until `completeEmployeeDraft`, and when
 * it is, it goes through the SAME writers the single-hire form and the bulk importer use —
 * `hireEmployee` → the company pack's `statutory.set` → `setCompensation` (+ the IC-derived date of
 * birth autofill) — so a wizard-created employee is indistinguishable from a hand-entered or imported
 * one, events included. This is the plan's explicit requirement ("Creation on completion must go
 * through the existing writers, not a bespoke insert") and it is what makes the r73 Decision 3 failure
 * mode — a writer silently dropping a column it predates — impossible to reintroduce here: there is no
 * second writer to fall behind.
 *
 * IT ALSO DOES NOT EMIT A MOVEMENT EVENT. The initial assignment IS the Hired row, which
 * `core/movement.ts` synthesizes from the employment itself with a pseudo-id; emitting an event for it
 * would give every new employee a spurious second history row — the exact fault r78 (`4d391ab7`) fixed
 * for the reporting line. `hireEmployee` already tags its inline `reporting-line.set` as `secondary`;
 * nothing here untags or duplicates it.
 *
 * WHY THE DRAFT IS NOT AN EMPLOYMENT WITH A FLAG — see migration 0337's header. In short: every list
 * read in the product joins `employment`, so a flag would need a new exclusion in each of them forever,
 * and the failure mode is a half-entered person appearing in a headcount or a payroll run.
 */
import { and, desc, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { company, employeeDraft, employment, person } from '../db/schema';
import { appendEvent, actorOf } from '../db/events';
import { hireEmployee } from './org';
import { setCompensation } from './comp';
import { setPersonComplianceFields } from './profile';
import { listLeaveTypes } from './read';
import { listConfigs, resolveEmployeeIdRule } from './employee-id-config';
import { requirePackFor } from '../localization/registry';
import { normalizeEmployeeCode } from '../lib/employee-code';
import { resolveEmployeeIdMode, type EmployeeIdRule } from '../lib/employee-id-mode';
import {
  draftLabel,
  missingForCreation,
  stepKey,
  type EmployeeDraftData,
} from '../lib/employee-draft-schema';

/** Standing entitlements granted on hire — the same three the hire form and the importer grant. */
const STANDING_GRANTS = new Set(['ANNUAL', 'SICK', 'HOSPITALIZATION']);

export type EmployeeDraftRow = {
  id: string;
  label: string;
  companyId: string | null;
  companyName: string | null;
  currentStep: number;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Outstanding required fields, recomputed on read so an old draft is judged by today's rules. */
  missing: string[];
};

const asData = (v: unknown): EmployeeDraftData => (v && typeof v === 'object' ? (v as EmployeeDraftData) : {});
const str = (v: string | undefined) => {
  const s = (v ?? '').trim();
  return s === '' ? undefined : s;
};

/** Drafts visible to the caller, most recently touched first. RLS (0337) is the authority: an author
 *  sees their own, an admin sees the tenant's. */
export function listEmployeeDrafts(ctx: SessionContext): Promise<EmployeeDraftRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: employeeDraft.id,
        label: employeeDraft.label,
        companyId: employeeDraft.companyId,
        companyName: company.legalName,
        currentStep: employeeDraft.currentStep,
        createdByName: person.fullName,
        createdAt: employeeDraft.createdAt,
        updatedAt: employeeDraft.updatedAt,
        data: employeeDraft.data,
      })
      .from(employeeDraft)
      .leftJoin(company, eq(company.id, employeeDraft.companyId))
      .leftJoin(person, eq(person.id, employeeDraft.createdByPersonId))
      .orderBy(desc(employeeDraft.updatedAt));
    return rows.map(({ data, ...r }) => ({ ...r, missing: missingForCreation(asData(data)) }));
  });
}

export function getEmployeeDraft(
  ctx: SessionContext,
  id: string,
): Promise<{ id: string; data: EmployeeDraftData; currentStep: number } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: employeeDraft.id, data: employeeDraft.data, currentStep: employeeDraft.currentStep })
      .from(employeeDraft)
      .where(eq(employeeDraft.id, id))
      .limit(1);
    return row ? { id: row.id, data: asData(row.data), currentStep: row.currentStep } : null;
  });
}

/**
 * Create or update a draft. Returns its id so the wizard can keep saving into the same one.
 *
 * `label` and `companyId` are DERIVED from the payload here rather than passed in, so the list can
 * never show a name the draft does not actually contain.
 */
export async function saveEmployeeDraft(
  ctx: SessionContext,
  p: { id?: string; data: EmployeeDraftData; currentStep: number },
): Promise<{ id: string }> {
  assertAdmin(ctx);
  const label = draftLabel(p.data);
  const companyId = str(p.data.employment?.companyId) ?? null;
  const currentStep = Math.min(Math.max(Math.trunc(p.currentStep) || 1, 1), 20);
  return withTenant(ctx, async (tx) => {
    let id = p.id;
    if (id) {
      // RLS decides whether this row is even visible; `returning` tells us whether it applied.
      const updated = await tx
        .update(employeeDraft)
        .set({ label, companyId, data: p.data, currentStep, updatedAt: new Date() })
        .where(eq(employeeDraft.id, id))
        .returning({ id: employeeDraft.id });
      if (updated.length === 0) throw new Error('Draft not found (or not visible).');
    } else {
      const [row] = await tx
        .insert(employeeDraft)
        .values({
          tenantId: ctx.tenantId,
          companyId,
          createdByPersonId: ctx.personId ?? null,
          label,
          data: p.data,
          currentStep,
        })
        .returning({ id: employeeDraft.id });
      id = row.id;
    }
    // One event per explicit save (the wizard saves on a button press, not on a keystroke), so the
    // audit trail records that a draft was worked on without recording what was typed into it.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-draft',
      aggregateId: id,
      eventType: p.id ? 'employee-draft.updated' : 'employee-draft.created',
      actor: actorOf(ctx),
      payload: { currentStep, step: stepKey(currentStep), companyId, hasLabel: label !== '' },
    });
    return { id };
  });
}

/**
 * The Employee ID rule in force for one company RIGHT NOW (item bd271009).
 *
 * Read at every decision point rather than stored on the draft: an administrator may edit the setup
 * screen between a draft being saved and being created, and a remembered rule would let the wizard
 * promise a number the engine would not issue.
 */
export async function employeeIdRuleFor(ctx: SessionContext, companyId: string): Promise<EmployeeIdRule> {
  return resolveEmployeeIdRule(await listConfigs(ctx), companyId);
}

/**
 * Is this Employee ID already taken? Powers the wizard's on-blur look-ahead (item bd271009), so a clash
 * is named while HR is still in the field instead of at the final button.
 *
 * ADVISORY ONLY. `hireEmployee`'s `assertEmployeeCodeUnique` plus the tenant-wide unique index remain the
 * authority — this read can go stale between the blur and the create, and is allowed to.
 */
export async function isEmployeeCodeTaken(ctx: SessionContext, raw: string): Promise<boolean> {
  const code = normalizeEmployeeCode(raw);
  if (!code) return false;
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(and(eq(employment.tenantId, ctx.tenantId), eq(employment.employeeCode, code)))
      .limit(1);
    return rows.length > 0;
  });
}

export async function discardEmployeeDraft(ctx: SessionContext, id: string): Promise<void> {
  assertAdmin(ctx);
  await withTenant(ctx, async (tx) => {
    const deleted = await tx
      .delete(employeeDraft)
      .where(eq(employeeDraft.id, id))
      .returning({ id: employeeDraft.id });
    if (deleted.length === 0) throw new Error('Draft not found (or not visible).');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-draft',
      aggregateId: id,
      eventType: 'employee-draft.discarded',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}

/**
 * Turn a completed draft into a real employee.
 *
 * NOT one transaction, and that is deliberate rather than an oversight: each writer owns its own
 * transaction (this is the same composition `commitEmployeeImport` performs, for the same reason —
 * the services are the contract, not their internals). The consequence is honest and worth stating:
 * if the statutory or compensation write fails, the EMPLOYEE EXISTS and the draft is kept, so HR can
 * see what is missing and finish it on the profile screen. Deleting the employee to "roll back" would
 * be worse — it would silently discard an employment that other tables may already reference.
 *
 * The draft is deleted only after every writer has succeeded.
 */
export async function completeEmployeeDraft(
  ctx: SessionContext,
  id: string,
): Promise<{ employmentId: string }> {
  assertAdmin(ctx);
  const draft = await getEmployeeDraft(ctx, id);
  if (!draft) throw new Error('Draft not found (or not visible).');
  const data = draft.data;

  const p = data.profile ?? {};
  const e = data.employment ?? {};
  const s = data.statutory ?? {};
  const pay = data.payroll ?? {};

  // ── Employee ID (item bd271009) ────────────────────────────────────────────────────────────────
  // The rule is resolved HERE, from the live setup, at the moment of creation — never from anything the
  // draft remembered. A draft saved last week under a setup that has since been edited is judged by the
  // setup that exists today, which is the only answer the engine can actually honour.
  const chosenCompanyId = str(e.companyId);
  const rule = chosenCompanyId ? await employeeIdRuleFor(ctx, chosenCompanyId) : null;

  // The client renders the same rules, but the client is not trusted: re-run them here. The Employee ID
  // is judged only once a company is known — demanding an ID before the company that decides its rule
  // has been chosen would report a fault the reporter cannot act on.
  const missing = chosenCompanyId ? missingForCreation(data, { employeeIdRule: rule }) : missingForCreation(data);
  if (missing.length > 0) throw new Error(`Cannot create the employee yet: ${missing.join(', ')}`);

  const companyId = chosenCompanyId!;
  const hiredOn = str(e.hiredOn)!;

  const decision = resolveEmployeeIdMode(rule, {
    chosen: p.employeeIdMode,
    hasCode: str(p.employeeCode) !== undefined,
  });
  const typedCode = str(p.employeeCode);
  // "Allow manual override" is OFF for this company's setup — obeyed for the first time (the switch has
  // been stored and displayed since 0261 and read by nothing). Refusing LOUDLY rather than quietly
  // dropping the typed value: HR typed an ID on purpose and must be told it will not be used.
  if (typedCode && decision.forcedBecause === 'manualNotAllowed') {
    throw new Error(
      `Employee ID "${typedCode}" was entered by hand, but the selected company's Employee ID Auto Running Number Setup does not allow manual entry. Remove it and the next running number will be issued automatically.`,
    );
  }
  // In Auto mode we send NO code, so `hireEmployee` runs the generator. A code left behind by someone who
  // switched Manual → Auto is deliberately ignored rather than used — the mode on screen is the promise.
  const employeeCodeToIssue = decision.mode === 'manual' ? typedCode : undefined;

  // The company's country pack owns the IC rules (ADR-0080 D1/D6) — resolved from the COMPANY, never
  // from a hardcoded jurisdiction, and fail-loud when the country resolves nothing.
  const country = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, companyId))
      .limit(1);
    if (!row) throw new Error('Company not found (or not visible).');
    return row.country;
  });
  const pack = requirePackFor(country);
  const icNumber = str(p.icNumber);
  // Optional (item e3ce0d4d — a non-Malaysian passport holder has no IC) but validated when supplied,
  // because an invalid IC stored now is a payroll fault later.
  if (icNumber && !pack.statutory.validateIC(icNumber)) throw new Error(`Invalid identity number "${icNumber}".`);

  const nationality = str(p.nationality);

  const types = await listLeaveTypes(ctx);
  const { employmentId, personId } = await hireEmployee(ctx, {
    // 35b7af0a group 8 — the nationality is seeded on the person HERE, at creation, because everything
    // downstream keys on it: the Personnel screen decides NRIC-vs-passport from `person.nationality`, and
    // before this the wizard left it NULL, so a hire it created showed NO Identity No card at all and the
    // number it had just collected was invisible until somebody set a nationality by hand. Undefined on a
    // draft saved before this change ⇒ null ⇒ byte-identical to what the wizard always did.
    person: {
      fullName: str(p.fullName)!,
      primaryEmail: str(p.primaryEmail)!,
      phone: str(p.phone),
      nationality,
    },
    // Blank ⇒ hireEmployee generates the next code. That IS the reporter's rule that a draft consumes
    // no Employee ID: the counter only ever advances inside this call. bd271009 decides WHICH of the two
    // happens above, in the open, instead of leaving it to whether a box happened to be filled in.
    employeeCode: employeeCodeToIssue,
    companyId,
    departmentId: str(e.departmentId)!,
    positionId: str(e.positionId),
    costCenterId: str(e.costCenterId),
    gradeId: str(e.gradeId) ?? null,
    reportingManagerEmploymentId: str(e.reportingManagerEmploymentId),
    employmentType: (str(e.employmentType) ?? 'full_time') as 'full_time' | 'part_time' | 'contract' | 'intern',
    hiredOn,
    provisionalEndOn: str(e.provisionalEndOn) ?? null,
    grantLeaveTypes: types
      .filter((t) => STANDING_GRANTS.has(t.code))
      .map((t) => ({ id: t.id, code: t.code, yearCycleOverride: t.yearCycleOverride })),
  });

  if (icNumber || hasAnyStatutory(s)) {
    await pack.statutory.set(ctx, {
      personId,
      // Item 35524d1f — null, not ''. The setter used to reject a blank IC, so a draft carrying any statutory
      // detail (an EPF number, a bank account) but no Identity No failed HERE, after hireEmployee had already
      // committed the employee. Nothing in the wizard marks Identity No required, and e3ce0d4d made it
      // optional for passport holders; the statutory row is now stored with a null IC instead.
      icNumber: icNumber ?? null,
      epfNumber: str(s.epfNumber),
      // 35b7af0a group 8 — the SAME IC-derived default `setStatutoryAction` applies on the Personnel card
      // (PERKESO registers locals under their MyKad). It lives in the WRITER, not only in the shared field
      // group, because the group's controlled mode DISPLAYS a default without committing it: an HR user who
      // never touches the box would otherwise create a hire showing a SOCSO number and storing none. Group 7
      // could not do this at all — the default keys on nationality and the wizard did not collect one.
      socsoNumber: pack.statutory.defaultSocsoEisNumber({
        socsoNumber: str(s.socsoNumber),
        icNumber,
        nationality,
      }),
      taxNumber: str(s.taxNumber),
      taxCategory: numOrUndef(s.taxCategory),
      numChildren: numOrUndef(s.numChildren),
      // 35b7af0a group 7 — the wizard now sends the CATEGORY, matching the Personnel screen and item
      // a7271737's consolidation. setStatutoryProfileMY derives the legacy booleans from it.
      //
      // BACK-COMPAT, and it is the whole reason this is not a one-line swap: a draft saved BEFORE this
      // change carries the legacy `eisEligible: 'yes' | 'no'` and no categories at all. Map it forward
      // so that draft still creates exactly the employee it always would have — 'no' is the scheme off,
      // anything else is the automatic derivation, which is what boolOrUndef(...)===false meant.
      socsoCategory: str(s.socsoCategory) as 'auto' | 'first' | 'second' | 'none' | undefined,
      eisCategory:
        (str(s.eisCategory) as 'auto' | 'none' | undefined) ??
        (boolOrUndef(s.eisEligible) === false ? 'none' : undefined),
      isResident: boolOrUndef(s.isResident),
      epfCitizenship: citizenship(s.epfCitizenship),
      bankName: str(s.bankName),
      bankAccountNo: str(s.bankAccountNo),
    });
  }

  // Gender / marital status / date of birth are compliance-gated fields with their own writer. An
  // explicitly typed DOB wins; otherwise the IC derives one, exactly as setIcAction and the importer
  // do (`dobOnlyIfEmpty` guarantees a real value is never overwritten).
  const typedDob = str(p.dateOfBirth);
  const derivedDob = icNumber ? pack.statutory.dobFromIC(icNumber) : null;
  const dob = typedDob ?? derivedDob ?? undefined;
  if (str(p.gender) || str(p.maritalStatus) || dob) {
    try {
      await setPersonComplianceFields(ctx, {
        employmentId,
        ...(str(p.gender) ? { gender: str(p.gender) } : {}),
        ...(str(p.maritalStatus) ? { maritalStatus: str(p.maritalStatus) } : {}),
        ...(dob ? { dateOfBirth: dob, dobOnlyIfEmpty: !typedDob } : {}),
      });
    } catch {
      // Best-effort, matching commitEmployeeImport: the employee exists and is payable; a rejected
      // profile detail must not strand the whole creation.
    }
  }

  await setCompensation(ctx, {
    employmentId,
    basicSalary: Number((pay.basicSalary ?? '').replace(/[,_]/g, '')),
    monthlyAllowance: numOrUndef(pay.monthlyAllowance),
    payMode: str(pay.payMode),
    paymentTerm: str(pay.paymentTerm),
    rateAmount: numOrUndef(pay.rateAmount),
    effectiveFrom: hiredOn,
    remarks: str(pay.remarks),
  });

  // Only now: the draft has become an employee, so it stops existing as a draft.
  await withTenant(ctx, async (tx) => {
    await tx.delete(employeeDraft).where(eq(employeeDraft.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-draft',
      aggregateId: id,
      eventType: 'employee-draft.completed',
      actor: actorOf(ctx),
      subjectEmploymentId: employmentId,
      payload: { employmentId, companyId },
    });
  });

  return { employmentId };
}

function hasAnyStatutory(s: Record<string, string | undefined>): boolean {
  return Object.values(s).some((v) => (v ?? '').trim() !== '');
}
function numOrUndef(v: string | undefined): number | undefined {
  const s = (v ?? '').replace(/[,_]/g, '').trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
function boolOrUndef(v: string | undefined): boolean | undefined {
  const s = (v ?? '').trim().toLowerCase();
  if (s === '') return undefined;
  return ['true', 'yes', 'y', '1'].includes(s);
}
function citizenship(v: string | undefined): 'citizen' | 'pr' | 'non_citizen' | undefined {
  const s = (v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'citizen' || s === 'pr' || s === 'non_citizen') return s;
  return undefined;
}

function assertAdmin(ctx: SessionContext): void {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error('Only an admin can create employees.');
  }
}
