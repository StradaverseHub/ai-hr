/**
 * Lifecycle cases (ADR-0095) — employee ONBOARDING and OFFBOARDING.
 *
 * NOT the first-login product tour (core/onboarding.ts, ADR-0018). A case is the checklist that follows one
 * person into or out of the company. It does not create or end employment: the case holds the new hire's
 * details itself, and `person_id` / `employment_id` are optional links to the identity graph. Termination
 * remains owned by the resignation workflow (core/offboarding.ts, ADR-0042); the outcome recorded here
 * decides which CHECKLIST applies and whether an IT Return is raised, nothing more.
 *
 * The Device Acceptance Acknowledgement is the NEW HIRE's own action from their signed-in checklist view
 * (see core/lifecycle-self.ts) — there is deliberately no public link.
 *
 * Hand-offs (all in the caller's transaction, so both records exist or neither does):
 *   onboarding case  --creates-->  IT requisition
 *   outcome Accepted --creates-->  IT Return (one open return per case); Accepted -> Rejected cancels it
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { itRequisition, lcCase, lcCaseStep, lcComment, lcHistory } from '../db/schema';
import { OFFBOARDING_OUTCOME_STEP, type CaseKind } from './lifecycle-defaults';
import { cancelOpenReturnTx, createRequisitionTx } from './lifecycle-it';
import { cleanCustomValues, fieldsFor, loadCompanyConfigTx, loadCustomFieldsTx, loadStepDefsTx, phaseLabels } from './lifecycle-config';
import { buildStepViews, isCaseComplete, progressOf, type CaseFacts, type StepView } from './lifecycle-rules';
import {
  LEVEL, LifecycleError, asBool, clean, cleanDate, normEmail, recordChange, requireLevel, withTenant,
} from './lifecycle-base';

export type CaseRow = typeof lcCase.$inferSelect;

const isUnique = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code === '23505' || x?.cause?.code === '23505';
};

const factsOf = (c: CaseRow): CaseFacts => ({
  kind: c.kind as CaseKind, status: c.status as CaseFacts['status'], laptopRequired: c.laptopRequired, carparkRequired: c.carparkRequired,
  outcome: c.outcome as CaseFacts['outcome'],
});

async function loadCase(tx: Tx, number: string, kind: CaseKind, lock = false): Promise<CaseRow> {
  const q = tx.select().from(lcCase).where(and(eq(lcCase.number, number), eq(lcCase.kind, kind))).limit(1);
  const [c] = lock ? await q.for('update') : await q;
  if (!c) throw new LifecycleError('Case not found.', 'not_found');
  return c;
}

async function stepViews(tx: Tx, c: CaseRow): Promise<StepView[]> {
  const [defs, recs] = await Promise.all([
    loadStepDefsTx(tx, c.kind as CaseKind),
    tx.select({ key: lcCaseStep.stepKey, done: lcCaseStep.done }).from(lcCaseStep).where(eq(lcCaseStep.caseId, c.id)),
  ]);
  // A removed (inactive) step stays visible only when it was already ticked on this case: the history survives.
  const doneKeys = new Set(recs.filter((r) => r.done).map((r) => r.key));
  const visible = defs.filter((d) => d.active || doneKeys.has(d.key));
  return buildStepViews(visible, recs, factsOf(c));
}

/** Re-derive Completed / In Progress from the steps; call after anything that can change them. */
async function reconcileCompletion(tx: Tx, ctx: SessionContext, c: CaseRow): Promise<CaseRow> {
  if (c.status === 'cancelled') return c;
  const views = await stepViews(tx, c);
  const complete = isCaseComplete(views, { kind: c.kind as CaseKind, outcome: c.outcome as CaseFacts['outcome'] });
  if (complete && c.status === 'in_progress') {
    const [u] = await tx.update(lcCase).set({ status: 'completed', completedAt: new Date() }).where(eq(lcCase.id, c.id)).returning();
    await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: 'case.completed', detail: {}, eventType: 'lifecycle-case.completed', subjectEmploymentId: c.employmentId, eventRef: { number: c.number, kind: c.kind } });
    return u!;
  }
  if (!complete && c.status === 'completed') {
    const [u] = await tx.update(lcCase).set({ status: 'in_progress', completedAt: null }).where(eq(lcCase.id, c.id)).returning();
    await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: 'case.reverted', detail: {}, eventType: 'lifecycle-case.reopened', subjectEmploymentId: c.employmentId, eventRef: { number: c.number, kind: c.kind } });
    return u!;
  }
  return c;
}

// ═══════════════════════════════ create ═══════════════════════════════
export type CaseCommon = {
  companyId: string; fullName: string; employeeNo: string; jobTitle?: string | null; department?: string | null; supervisor?: string | null;
  gbsTa?: string | null; notes?: string | null; custom?: Record<string, unknown>; personId?: string | null; employmentId?: string | null;
  costCentre?: string | null; nricPassport?: string | null; newhireEmail?: string | null; itOwnerUserId?: string | null;
};
export type OnboardingInput = CaseCommon & {
  joinDate: string; hireType?: 'new_hire' | 'replacement'; replacedPerson?: string | null; laptopRequired?: boolean | string; deviceType?: string | null;
  carparkRequired?: boolean | string; floorBuilding?: string | null; accessSystems?: string[]; emailRequired?: boolean | string;
};
export type OffboardingInput = CaseCommon & {
  resignationDate: string; lastWorkingDay?: string | null; workLocation?: string | null; deviceName?: string | null; balanceLeave?: number | null;
};

async function assertNoActiveDuplicate(tx: Tx, kind: CaseKind, employeeNo: string, email: string | null, exceptId?: string): Promise<void> {
  const same = await tx.select({ id: lcCase.id, number: lcCase.number }).from(lcCase)
    .where(and(eq(lcCase.kind, kind), eq(lcCase.status, 'in_progress'), sql`lower(${lcCase.employeeNo}) = lower(${employeeNo})`));
  const hit = same.find((x) => x.id !== exceptId);
  if (hit) throw new LifecycleError(`Employee number ${employeeNo} already has an active ${kind} case (${hit.number}).`, 'conflict');
  if (email) {
    const byMail = await tx.select({ id: lcCase.id, number: lcCase.number }).from(lcCase)
      .where(and(eq(lcCase.kind, kind), eq(lcCase.status, 'in_progress'), sql`lower(${lcCase.newhireEmail}) = ${email}`));
    const m = byMail.find((x) => x.id !== exceptId);
    if (m) throw new LifecycleError(`${email} already has an active ${kind} case (${m.number}).`, 'conflict');
  }
}

export async function createOnboardingCase(ctx: SessionContext, p: OnboardingInput): Promise<{ id: string; number: string; requisitionNumber: string }> {
  const fullName = clean(p.fullName, 200); const employeeNo = clean(p.employeeNo, 60);
  if (!fullName) throw new LifecycleError('Full name is required.');
  if (!employeeNo) throw new LifecycleError('Employee number is required.');
  const joinDate = cleanDate(p.joinDate, 'Join date');
  if (!joinDate) throw new LifecycleError('Join date is required.');
  const hireType = p.hireType === 'replacement' ? 'replacement' : 'new_hire';
  const replaced = clean(p.replacedPerson, 200);
  if (hireType === 'replacement' && !replaced) throw new LifecycleError('A replacement hire needs the name of the person being replaced.');
  const email = normEmail(p.newhireEmail);
  const laptop = asBool(p.laptopRequired, true);
  try {
    return await withTenant(ctx, async (tx) => {
      await requireLevel(tx, p.companyId, LEVEL.agent, 'only staff create onboarding cases');
      const cfg = await loadCompanyConfigTx(tx, p.companyId);
      const systems = p.accessSystems ?? [];
      const bad = systems.filter((s) => !cfg.accessSystems.includes(s));
      if (bad.length) throw new LifecycleError(`Access system not offered for this company: ${bad.join(', ')}.`);
      const custom = cleanCustomValues(await loadCustomFieldsTx(tx, 'onboarding'), p.companyId, p.custom);
      await assertNoActiveDuplicate(tx, 'onboarding', employeeNo, email);
      const { nextNumber } = await import('./lifecycle-base');
      const number = await nextNumber(tx, 'ONB');
      const [c] = await tx.insert(lcCase).values({
        tenantId: ctx.tenantId, kind: 'onboarding', number, companyId: p.companyId, fullName, employeeNo,
        jobTitle: clean(p.jobTitle, 200), department: clean(p.department, 200), supervisor: clean(p.supervisor, 200), gbsTa: clean(p.gbsTa, 200),
        joinDate, hireType, replacedPerson: hireType === 'replacement' ? replaced : null, laptopRequired: laptop, deviceType: clean(p.deviceType, 100),
        carparkRequired: asBool(p.carparkRequired, false), floorBuilding: clean(p.floorBuilding, 200), accessSystems: systems,
        emailRequired: asBool(p.emailRequired, true), costCentre: clean(p.costCentre, 100), nricPassport: clean(p.nricPassport, 40), newhireEmail: email,
        itOwnerUserId: p.itOwnerUserId ?? null, notes: clean(p.notes, 4000), custom, personId: p.personId ?? null, employmentId: p.employmentId ?? null,
        createdBy: ctx.userId ?? null,
      }).returning();
      const req = await createRequisitionTx(tx, ctx, {
        kind: 'requisition', companyId: p.companyId, caseId: c!.id, fullName, employeeNo, jobTitle: p.jobTitle, department: p.department, costCentre: p.costCentre,
        username: email, laptopRequired: laptop, deviceType: p.deviceType, accessSystems: systems, floorBuilding: p.floorBuilding, assignedToUserId: p.itOwnerUserId,
        notes: p.notes,
      });
      await recordChange(tx, ctx, { refType: 'case', refId: c!.id, action: 'case.created', detail: { number, requisition: req.number }, eventType: 'lifecycle-case.created', subjectEmploymentId: c!.employmentId, eventRef: { number, kind: 'onboarding', requisition: req.number } });
      return { id: c!.id, number, requisitionNumber: req.number };
    });
  } catch (e) {
    if (isUnique(e)) throw new LifecycleError('An active onboarding case already exists for that employee number or email.', 'conflict');
    throw e;
  }
}

export async function createOffboardingCase(ctx: SessionContext, p: OffboardingInput): Promise<{ id: string; number: string }> {
  const fullName = clean(p.fullName, 200); const employeeNo = clean(p.employeeNo, 60);
  if (!fullName) throw new LifecycleError('Full name is required.');
  if (!employeeNo) throw new LifecycleError('Employee number is required.');
  const resignationDate = cleanDate(p.resignationDate, 'Resignation date');
  if (!resignationDate) throw new LifecycleError('Resignation date is required.');
  const lwd = cleanDate(p.lastWorkingDay, 'Last working day');
  if (lwd && lwd < resignationDate) throw new LifecycleError('The last working day cannot be before the resignation date.');
  if (p.balanceLeave != null && !Number.isFinite(Number(p.balanceLeave))) throw new LifecycleError('Balance leave must be a number.');
  try {
    return await withTenant(ctx, async (tx) => {
      await requireLevel(tx, p.companyId, LEVEL.agent, 'only staff create offboarding cases');
      const custom = cleanCustomValues(await loadCustomFieldsTx(tx, 'offboarding'), p.companyId, p.custom);
      await assertNoActiveDuplicate(tx, 'offboarding', employeeNo, null);
      const { nextNumber } = await import('./lifecycle-base');
      const number = await nextNumber(tx, 'OFB');
      const [c] = await tx.insert(lcCase).values({
        tenantId: ctx.tenantId, kind: 'offboarding', number, companyId: p.companyId, fullName, employeeNo,
        jobTitle: clean(p.jobTitle, 200), department: clean(p.department, 200), supervisor: clean(p.supervisor, 200), gbsTa: clean(p.gbsTa, 200),
        resignationDate, lastWorkingDay: lwd, workLocation: clean(p.workLocation, 200), deviceName: clean(p.deviceName, 200),
        balanceLeave: p.balanceLeave == null ? null : Number(p.balanceLeave).toFixed(2), costCentre: clean(p.costCentre, 100), notes: clean(p.notes, 4000),
        custom, personId: p.personId ?? null, employmentId: p.employmentId ?? null, createdBy: ctx.userId ?? null,
      }).returning();
      await recordChange(tx, ctx, { refType: 'case', refId: c!.id, action: 'case.created', detail: { number }, eventType: 'lifecycle-case.created', subjectEmploymentId: c!.employmentId, eventRef: { number, kind: 'offboarding' } });
      return { id: c!.id, number };
    });
  } catch (e) {
    if (isUnique(e)) throw new LifecycleError('An active offboarding case already exists for that employee number.', 'conflict');
    throw e;
  }
}

// ═══════════════════════════════ read ═══════════════════════════════
export type CaseListRow = CaseRow & { progress: { done: number; total: number; percent: number }; requisitionNumber: string | null };

export async function listCases(ctx: SessionContext, kind: CaseKind, f: { companyId?: string; history?: boolean } = {}): Promise<CaseListRow[]> {
  return withTenant(ctx, async (tx) => {
    const lvl = await requireLevel(tx, f.companyId ?? null, LEVEL.agent, 'only staff read cases');
    if (f.history && lvl < LEVEL.manager) throw new LifecycleError('Not permitted: only a manager reads the history lists.', 'forbidden');
    const conds = [eq(lcCase.kind, kind), f.history ? inArray(lcCase.status, ['completed', 'cancelled']) : eq(lcCase.status, 'in_progress')];
    if (f.companyId) conds.push(eq(lcCase.companyId, f.companyId));
    const rows = await tx.select().from(lcCase).where(and(...conds)).orderBy(desc(lcCase.number)).limit(1000);
    if (rows.length === 0) return [];
    const defs = (await loadStepDefsTx(tx, kind));
    const recs = await tx.select({ caseId: lcCaseStep.caseId, key: lcCaseStep.stepKey, done: lcCaseStep.done }).from(lcCaseStep).where(inArray(lcCaseStep.caseId, rows.map((r) => r.id)));
    const reqs = await tx.select({ caseId: itRequisition.caseId, number: itRequisition.number, kind: itRequisition.kind, status: itRequisition.status }).from(itRequisition).where(inArray(itRequisition.caseId, rows.map((r) => r.id)));
    return rows.map((c) => {
      const mine = recs.filter((r) => r.caseId === c.id);
      const done = new Set(mine.filter((m) => m.done).map((m) => m.key));
      const views = buildStepViews(defs.filter((d) => d.active || done.has(d.key)), mine, factsOf(c));
      const req = reqs.filter((r) => r.caseId === c.id && r.status !== 'cancelled')[0];
      return { ...c, progress: progressOf(views), requisitionNumber: req?.number ?? null };
    });
  });
}

export async function getCase(ctx: SessionContext, kind: CaseKind, number: string) {
  return withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, kind);
    const lvl = await requireLevel(tx, c.companyId, LEVEL.agent, 'only staff read cases');
    const [steps, doneRows, reqs, fieldDefs] = await Promise.all([
      stepViews(tx, c),
      tx.select().from(lcCaseStep).where(eq(lcCaseStep.caseId, c.id)),
      tx.select().from(itRequisition).where(eq(itRequisition.caseId, c.id)).orderBy(asc(itRequisition.number)),
      loadCustomFieldsTx(tx, kind),
    ]);
    const byKey = new Map(doneRows.map((r) => [r.stepKey, r]));
    return {
      case: c,
      steps: steps.map((s) => ({ ...s, record: byKey.get(s.key) ?? null })),
      phases: phaseLabels(kind),
      progress: progressOf(steps),
      requisitions: reqs,
      openRequisition: reqs.find((r) => r.status !== 'cancelled') ?? null,
      customFields: fieldsFor(fieldDefs, c.companyId),
      daa: { required: c.laptopRequired, submittedAt: c.daaSubmittedAt, details: c.daa },
      myLevel: lvl,
    };
  });
}

export async function caseHistory(ctx: SessionContext, kind: CaseKind, number: string) {
  return withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, kind);
    await requireLevel(tx, c.companyId, LEVEL.agent, 'only staff read cases');
    return tx.select().from(lcHistory).where(and(eq(lcHistory.refType, 'case'), eq(lcHistory.refId, c.id))).orderBy(desc(lcHistory.at), desc(lcHistory.id));
  });
}

// ═══════════════════════════════ steps ═══════════════════════════════
const BLOCK_MESSAGE: Record<NonNullable<StepView['blocked']>, string> = {
  cancelled: 'Nothing can be ticked on a cancelled case.',
  not_applicable: 'This step does not apply to this case.',
  outcome_pending: 'Record the resignation outcome first: this step depends on it.',
  phase_locked: 'Finish every applicable step of the earlier phase first.',
  already_done: 'This step is already done.',
};

export async function tickStep(
  ctx: SessionContext, kind: CaseKind, number: string, key: string, p: { reference?: string | null; notes?: string | null } = {},
): Promise<{ status: string }> {
  return withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, kind, true);
    await requireLevel(tx, c.companyId, LEVEL.agent, 'only staff work cases');
    const views = await stepViews(tx, c);
    const st = views.find((v) => v.key === key);
    if (!st) throw new LifecycleError('Step not found.', 'not_found');
    if (st.blocked) throw new LifecycleError(BLOCK_MESSAGE[st.blocked], 'conflict');
    if (kind === 'offboarding' && key === OFFBOARDING_OUTCOME_STEP && c.outcome === 'pending') {
      throw new LifecycleError('Record the resignation outcome with the outcome control; this step ticks itself.', 'conflict');
    }
    await tx.insert(lcCaseStep).values({ caseId: c.id, tenantId: ctx.tenantId, stepKey: key, done: true, doneBy: ctx.userId ?? null, doneAt: new Date(), reference: clean(p.reference, 100), notes: clean(p.notes, 2000) })
      .onConflictDoUpdate({ target: [lcCaseStep.caseId, lcCaseStep.stepKey], set: { done: true, doneBy: ctx.userId ?? null, doneAt: new Date(), reference: clean(p.reference, 100), notes: p.notes !== undefined ? clean(p.notes, 2000) : sql`${lcCaseStep.notes}` } });
    await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: 'step.done', detail: { step: st.label, key, reference: clean(p.reference, 100) }, eventType: 'lifecycle-case.step-done', subjectEmploymentId: c.employmentId, eventRef: { number, step: key } });
    const after = await reconcileCompletion(tx, ctx, c);
    return { status: after.status };
  });
}

export async function undoStep(ctx: SessionContext, kind: CaseKind, number: string, key: string, reason?: string | null): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, kind, true);
    await requireLevel(tx, c.companyId, LEVEL.manager, 'only a manager undoes a step');
    if (c.status === 'cancelled') throw new LifecycleError(BLOCK_MESSAGE.cancelled, 'conflict');
    const [r] = await tx.select().from(lcCaseStep).where(and(eq(lcCaseStep.caseId, c.id), eq(lcCaseStep.stepKey, key))).limit(1).for('update');
    if (!r || !r.done) throw new LifecycleError('That step is not done.', 'conflict');
    if (kind === 'offboarding' && key === OFFBOARDING_OUTCOME_STEP && c.outcome !== 'pending') {
      throw new LifecycleError('The outcome step stays done while an outcome is recorded.', 'conflict');
    }
    await tx.update(lcCaseStep).set({ done: false, doneBy: null, doneAt: null }).where(and(eq(lcCaseStep.caseId, c.id), eq(lcCaseStep.stepKey, key)));
    await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: 'step.undone', detail: { key, reason: clean(reason, 500) }, eventType: 'lifecycle-case.step-undone', subjectEmploymentId: c.employmentId, eventRef: { number, step: key } });
    await reconcileCompletion(tx, ctx, c);
  });
}

export async function saveStepNotes(ctx: SessionContext, kind: CaseKind, number: string, key: string, notes: string | null): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, kind, true);
    await requireLevel(tx, c.companyId, LEVEL.agent, 'only staff work cases');
    if (c.status === 'cancelled') throw new LifecycleError(BLOCK_MESSAGE.cancelled, 'conflict');
    const defs = await loadStepDefsTx(tx, kind);
    if (!defs.some((d) => d.key === key)) throw new LifecycleError('Step not found.', 'not_found');
    await tx.insert(lcCaseStep).values({ caseId: c.id, tenantId: ctx.tenantId, stepKey: key, notes: clean(notes, 2000) })
      .onConflictDoUpdate({ target: [lcCaseStep.caseId, lcCaseStep.stepKey], set: { notes: clean(notes, 2000) } });
  });
}

// ═══════════════════════════════ edit / outcome / cancel ═══════════════════════════════
export type CasePatch = Partial<Omit<OnboardingInput & OffboardingInput, 'companyId' | 'employeeNo'>> & { lastWorkingDay?: string | null };

export async function updateCase(ctx: SessionContext, kind: CaseKind, number: string, patch: CasePatch): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, kind, true);
    await requireLevel(tx, c.companyId, LEVEL.agent, 'only staff edit cases');
    if (c.status === 'cancelled') throw new LifecycleError('A cancelled case cannot be edited.', 'conflict');
    const set: Partial<typeof lcCase.$inferInsert> = {};
    const txt = (k: keyof CasePatch, col: keyof typeof lcCase.$inferInsert, max = 200) => { if (patch[k] !== undefined) (set as Record<string, unknown>)[col] = clean(patch[k] as string, max); };
    txt('jobTitle', 'jobTitle'); txt('department', 'department'); txt('supervisor', 'supervisor'); txt('gbsTa', 'gbsTa'); txt('costCentre', 'costCentre', 100);
    txt('nricPassport', 'nricPassport', 40); txt('notes', 'notes', 4000); txt('floorBuilding', 'floorBuilding'); txt('deviceType', 'deviceType', 100);
    txt('workLocation', 'workLocation'); txt('deviceName', 'deviceName'); txt('replacedPerson', 'replacedPerson');
    if (patch.fullName !== undefined) { const n = clean(patch.fullName, 200); if (!n) throw new LifecycleError('Full name cannot be blank.'); set.fullName = n; }
    if (patch.joinDate !== undefined) { if (kind !== 'onboarding') throw new LifecycleError('Only onboarding cases have a join date.'); const d = cleanDate(patch.joinDate, 'Join date'); if (!d) throw new LifecycleError('Join date is required.'); set.joinDate = d; }
    if (patch.resignationDate !== undefined) { if (kind !== 'offboarding') throw new LifecycleError('Only offboarding cases have a resignation date.'); const d = cleanDate(patch.resignationDate, 'Resignation date'); if (!d) throw new LifecycleError('Resignation date is required.'); set.resignationDate = d; }
    if (patch.lastWorkingDay !== undefined) set.lastWorkingDay = cleanDate(patch.lastWorkingDay, 'Last working day');
    const resign = (set.resignationDate ?? c.resignationDate) as string | null; const last = (set.lastWorkingDay === undefined ? c.lastWorkingDay : set.lastWorkingDay) as string | null;
    if (kind === 'offboarding' && resign && last && last < resign) throw new LifecycleError('The last working day cannot be before the resignation date.');
    if (patch.hireType !== undefined) set.hireType = patch.hireType === 'replacement' ? 'replacement' : 'new_hire';
    if ((set.hireType ?? c.hireType) === 'replacement' && !((set.replacedPerson ?? c.replacedPerson))) throw new LifecycleError('A replacement hire needs the name of the person being replaced.');
    if (patch.laptopRequired !== undefined) set.laptopRequired = asBool(patch.laptopRequired, c.laptopRequired);
    if (patch.carparkRequired !== undefined) set.carparkRequired = asBool(patch.carparkRequired, c.carparkRequired);
    if (patch.emailRequired !== undefined) set.emailRequired = asBool(patch.emailRequired, c.emailRequired);
    if (patch.balanceLeave !== undefined) set.balanceLeave = patch.balanceLeave == null ? null : Number(patch.balanceLeave).toFixed(2);
    if (patch.accessSystems !== undefined) {
      const cfg = await loadCompanyConfigTx(tx, c.companyId);
      const bad = patch.accessSystems.filter((s) => !cfg.accessSystems.includes(s));
      if (bad.length) throw new LifecycleError(`Access system not offered for this company: ${bad.join(', ')}.`);
      set.accessSystems = patch.accessSystems;
    }
    if (patch.custom !== undefined) set.custom = cleanCustomValues(await loadCustomFieldsTx(tx, kind), c.companyId, patch.custom, c.custom);
    const events: string[] = [];
    if (patch.itOwnerUserId !== undefined && patch.itOwnerUserId !== c.itOwnerUserId) { set.itOwnerUserId = patch.itOwnerUserId; events.push('owner'); }
    if (patch.newhireEmail !== undefined) {
      const e = normEmail(patch.newhireEmail);
      if (e !== c.newhireEmail) { await assertNoActiveDuplicate(tx, kind, c.employeeNo, e, c.id); set.newhireEmail = e; events.push('email'); }
    }
    if (Object.keys(set).length === 0) return;
    try { await tx.update(lcCase).set(set).where(eq(lcCase.id, c.id)); } catch (err) { if (isUnique(err)) throw new LifecycleError('That email already has an active case.', 'conflict'); throw err; }
    // The linked requisition mirrors the person fields; it never owns them.
    const mirror: Partial<typeof itRequisition.$inferInsert> = {};
    for (const k of ['fullName', 'jobTitle', 'department', 'costCentre', 'laptopRequired', 'deviceType', 'floorBuilding', 'accessSystems'] as const) if (k in set) (mirror as Record<string, unknown>)[k] = (set as Record<string, unknown>)[k];
    if ('newhireEmail' in set) mirror.username = set.newhireEmail ?? null;
    if ('itOwnerUserId' in set) mirror.assignedToUserId = set.itOwnerUserId ?? null;
    if (Object.keys(mirror).length) await tx.update(itRequisition).set(mirror).where(and(eq(itRequisition.caseId, c.id), sql`${itRequisition.status} <> 'cancelled'`));
    await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: 'case.edited', detail: { fields: Object.keys(set).filter((f) => f !== 'nricPassport'), sensitiveEdited: 'nricPassport' in set }, eventType: 'lifecycle-case.edited', subjectEmploymentId: c.employmentId, eventRef: { number } });
    for (const ev of events) await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: ev === 'owner' ? 'case.owner_changed' : 'case.email_changed', detail: {}, eventType: ev === 'owner' ? 'lifecycle-case.owner-changed' : 'lifecycle-case.email-changed', subjectEmploymentId: c.employmentId, eventRef: { number } });
    await reconcileCompletion(tx, ctx, { ...c, ...(set as Partial<CaseRow>) } as CaseRow);
  });
}

/**
 * Record the resignation outcome. The first time, any staff member may; after that only an ADMIN, and only
 * with a reason. Accepted raises the IT Return; Accepted -> Rejected cancels the open Return; Rejected ->
 * Accepted raises a new one. Pending can never be restored.
 */
export async function setOutcome(ctx: SessionContext, number: string, outcome: 'accepted' | 'rejected', reason?: string | null): Promise<{ returnNumber: string | null }> {
  if (outcome !== 'accepted' && outcome !== 'rejected') throw new LifecycleError('Outcome must be accepted or rejected.');
  return withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, 'offboarding', true);
    const lvl = await requireLevel(tx, c.companyId, LEVEL.agent, 'only staff record the outcome');
    if (c.status === 'cancelled') throw new LifecycleError('A cancelled case cannot take an outcome.', 'conflict');
    if (c.outcome === outcome) return { returnNumber: null };
    const first = c.outcome === 'pending';
    if (!first) {
      if (lvl < LEVEL.admin) throw new LifecycleError('Not permitted: only an administrator changes a recorded outcome.', 'forbidden');
      if (!clean(reason, 500)) throw new LifecycleError('A reason is required to change a recorded outcome.');
    }
    const [u] = await tx.update(lcCase).set({ outcome, outcomeSetBy: ctx.userId ?? null, outcomeSetAt: new Date() }).where(eq(lcCase.id, c.id)).returning();
    await tx.insert(lcCaseStep).values({ caseId: c.id, tenantId: ctx.tenantId, stepKey: OFFBOARDING_OUTCOME_STEP, done: true, doneBy: ctx.userId ?? null, doneAt: new Date() })
      .onConflictDoNothing();
    await tx.update(lcCaseStep).set({ done: true }).where(and(eq(lcCaseStep.caseId, c.id), eq(lcCaseStep.stepKey, OFFBOARDING_OUTCOME_STEP)));
    await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: first ? 'outcome.set' : 'outcome.changed', detail: { from: c.outcome, to: outcome, reason: clean(reason, 500) }, eventType: first ? 'lifecycle-case.outcome-set' : 'lifecycle-case.outcome-changed', subjectEmploymentId: c.employmentId, eventRef: { number, to: outcome } });
    let returnNumber: string | null = null;
    if (outcome === 'accepted') {
      const r = await createRequisitionTx(tx, ctx, {
        kind: 'return', companyId: c.companyId, caseId: c.id, fullName: c.fullName, employeeNo: c.employeeNo, jobTitle: c.jobTitle, department: c.department,
        costCentre: c.costCentre, workLocation: c.workLocation,
        returnDetails: { balanceLeave: c.balanceLeave, deviceName: c.deviceName, redeployedTo: c.redeployedTo },
      });
      returnNumber = r.number;
      await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: 'return.created', detail: { requisition: r.number }, eventType: 'lifecycle-case.return-created', subjectEmploymentId: c.employmentId, eventRef: { number, requisition: r.number } });
    } else if (!first) {
      const cancelled = await cancelOpenReturnTx(tx, ctx, c.id, 'Resignation outcome changed to Rejected.');
      if (cancelled) await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: 'return.cancelled', detail: { requisition: cancelled }, eventType: 'lifecycle-case.return-cancelled', subjectEmploymentId: c.employmentId, eventRef: { number, requisition: cancelled } });
    }
    await reconcileCompletion(tx, ctx, u!);
    return { returnNumber };
  });
}

export async function cancelCase(ctx: SessionContext, kind: CaseKind, number: string, reason: string): Promise<void> {
  const why = clean(reason, 500);
  if (!why) throw new LifecycleError('A reason is required to cancel.');
  await withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, kind, true);
    await requireLevel(tx, c.companyId, LEVEL.manager, 'only a manager cancels a case');
    if (c.status === 'cancelled') return;
    if (c.status === 'completed') throw new LifecycleError('A completed case cannot be cancelled.', 'conflict');
    await tx.update(lcCase).set({ status: 'cancelled', cancelReason: why }).where(eq(lcCase.id, c.id));
    await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: 'case.cancelled', detail: { reason: why }, eventType: 'lifecycle-case.cancelled', subjectEmploymentId: c.employmentId, eventRef: { number } });
  });
}

export async function reopenCase(ctx: SessionContext, kind: CaseKind, number: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, kind, true);
    await requireLevel(tx, c.companyId, LEVEL.manager, 'only a manager reopens a case');
    if (c.status !== 'cancelled') throw new LifecycleError('Only a cancelled case can be reopened.', 'conflict');
    // Reopening could collide with a newer active case for the same employee; the unique index decides.
    try { await tx.update(lcCase).set({ status: 'in_progress', cancelReason: null }).where(eq(lcCase.id, c.id)); }
    catch (e) { if (isUnique(e)) throw new LifecycleError('That employee already has another active case.', 'conflict'); throw e; }
    await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: 'case.reopened', detail: {}, eventType: 'lifecycle-case.reopened', subjectEmploymentId: c.employmentId, eventRef: { number } });
  });
}

// ═══════════════════════════════ comments ═══════════════════════════════
export async function listComments(ctx: SessionContext, kind: CaseKind, number: string) {
  return withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, kind);
    await requireLevel(tx, c.companyId, LEVEL.agent, 'only staff read comments');
    return tx.select().from(lcComment).where(eq(lcComment.caseId, c.id)).orderBy(asc(lcComment.at), asc(lcComment.id));
  });
}

export async function addComment(ctx: SessionContext, kind: CaseKind, number: string, body: string): Promise<void> {
  const text = clean(body, 4000);
  if (!text) throw new LifecycleError('Write a comment first.');
  await withTenant(ctx, async (tx) => {
    const c = await loadCase(tx, number, kind);
    await requireLevel(tx, c.companyId, LEVEL.agent, 'only staff comment');
    const { actorName } = await import('./lifecycle-base');
    await tx.insert(lcComment).values({ tenantId: ctx.tenantId, caseId: c.id, authorUserId: ctx.userId ?? null, authorName: await actorName(tx, ctx), body: text });
    await recordChange(tx, ctx, { refType: 'case', refId: c.id, action: 'case.commented', detail: {}, eventType: 'lifecycle-case.commented', subjectEmploymentId: c.employmentId, eventRef: { number } });
  });
}

