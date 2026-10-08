/**
 * Lifecycle module (ADR-0095) — employee onboarding / offboarding cases, IT requisitions, the asset
 * register and asset requests. Runs against real Postgres as the RLS-governed app role, so a refusal
 * asserted here is either the service's rule or the policy's — and the tests that matter assert BOTH
 * layers (an admin session sails through RLS, so it can only be the service refusing).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { ModuleNotEnabledError } from '../core/entitlements';
import {
  LifecycleError, addComment, advanceAssetRequest, assetHistory, bulkAssetStatus, cancelAssetRequest, cancelCase, cancelRequisition, createAssetRequest,
  createOffboardingCase, createOnboardingCase, createStandaloneRequisition, decideAssetRequest, decideRequisition, ensureCatalogue, getAsset,
  getCase, getRequisition, listAssetRequests, listAssets, listCases, listRequisitions, listStaff, loadHandoverDefaults, registerAsset, getMyOnboarding, submitMyAcknowledgement,
  reopenCase, returnAssets, saveCompanyConfig, saveCustomFields, saveProvisionDefs, saveStepDefs, setAssetRequestHandler, setOutcome, setProvision,
  setStaff, tickStep, undoStep, updateAsset, updateCase, caseHistory, listComments,
} from '../packs/lifecycle/service';
import { ONBOARDING_STEPS, OFFBOARDING_STEPS } from '../core/lifecycle-defaults';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';

const today = '2026-10-08';

describe('Lifecycle module', () => {
  let b: Base;
  let admin: SessionContext;
  let agent: SessionContext;
  let manager: SessionContext;
  let manager2: SessionContext;
  let requester: SessionContext;
  let requester2: SessionContext;
  let companyB: string;
  const ids: Record<string, { userId: string; personId: string; employmentId: string }> = {};

  async function person(name: string, role: 'employee' | 'manager' = 'employee', companyId?: string) {
    const h = await hireEmployee(admin, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
      companyId: companyId ?? b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-01-01',
    });
    const userId = await createAppUser(b.tenantId, h.personId, role);
    ids[name] = { userId, personId: h.personId, employmentId: h.employmentId };
    return { ...ids[name]!, ctx: { ...admin, userId, personId: h.personId, roles: [role], grants: undefined } as SessionContext };
  }

  beforeAll(async () => { /* worker DB is stamped from the migrated template */ });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    await setModule(b.tenantId, 'lifecycle', 'active');
    admin = await entitledCtx(b);
    const a = await person('Alice Agent'); const m = await person('Mia Manager'); const m2 = await person('Max Manager');
    const r = await person('Rita Requester'); const r2 = await person('Rob Requester');
    agent = a.ctx; manager = m.ctx; manager2 = m2.ctx; requester = r.ctx; requester2 = r2.ctx;
    await owner.db.insert(schema.lcStaff).values([
      { tenantId: b.tenantId, userId: a.userId, companyId: null, level: 'agent' },
      { tenantId: b.tenantId, userId: m.userId, companyId: null, level: 'manager' },
      { tenantId: b.tenantId, userId: m2.userId, companyId: null, level: 'manager' },
    ]);
    const [cb] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd', companyLabel: 'BETA' }).returning({ id: schema.company.id });
    companyB = cb!.id;
    await owner.db.update(schema.company).set({ companyLabel: 'CHGP' }).where(eq(schema.company.id, b.companyId));
  });
  afterAll(async () => { await closeAll(); });

  const onbInput = (o: Partial<Parameters<typeof createOnboardingCase>[1]> = {}) => ({
    companyId: b.companyId, fullName: 'New Hire', employeeNo: 'E100', joinDate: '2026-10-12', jobTitle: 'Analyst', department: 'Finance',
    supervisor: 'Boss', laptopRequired: true, carparkRequired: true, newhireEmail: 'new.hire@acme.test', ...o,
  });
  const rejects = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };

  // ───────────────────────── the gate and the wall ─────────────────────────
  describe('module gate and authorization', () => {
    it('refuses every entry point for a tenant that has not bought the module', async () => {
      await setModule(b.tenantId, 'lifecycle', null);
      const off = await entitledCtx(b);
      await expect(createOnboardingCase(off, onbInput())).rejects.toBeInstanceOf(ModuleNotEnabledError);
      await expect(listAssets(off)).rejects.toBeInstanceOf(ModuleNotEnabledError);
      await expect(listAssetRequests(off)).rejects.toBeInstanceOf(ModuleNotEnabledError);
    });

    it('a plain requester is forbidden on cases, requisitions and the asset register', async () => {
      const { number } = await createOnboardingCase(agent, onbInput());
      await rejects(listCases(requester, 'onboarding'), /Not permitted/);
      await rejects(getCase(requester, 'onboarding', number), /Not permitted|not found/i);
      await rejects(listRequisitions(requester), /Not permitted/);
      await rejects(listAssets(requester), /Not permitted/);
      await rejects(createOnboardingCase(requester, onbInput({ employeeNo: 'E999', newhireEmail: null })), /Not permitted/);
      await rejects(registerAsset(requester, { companyId: b.companyId, assetType: 'laptop' }), /Not permitted/);
    });

    it('RLS alone also hides cases from a requester (read the table directly)', async () => {
      await createOnboardingCase(agent, onbInput());
      const { withTenant } = await import('../db/client');
      const rows = await withTenant(requester, (tx) => tx.select().from(schema.lcCase));
      expect(rows).toEqual([]);
      const reqs = await withTenant(requester, (tx) => tx.select().from(schema.itRequisition));
      expect(reqs).toEqual([]);
    });

    it('staff scoped to one company cannot touch another company', async () => {
      await owner.db.delete(schema.lcStaff).where(eq(schema.lcStaff.tenantId, b.tenantId));
      await owner.db.insert(schema.lcStaff).values({ tenantId: b.tenantId, userId: ids['Alice Agent']!.userId, companyId: b.companyId, level: 'agent' });
      await createOnboardingCase(agent, onbInput());
      await rejects(createOnboardingCase(agent, onbInput({ companyId: companyB, employeeNo: 'E200', newhireEmail: null })), /Not permitted/);
      await createOnboardingCase(admin, onbInput({ companyId: companyB, employeeNo: 'E200', newhireEmail: null }));
      const seen = await listCases(agent, 'onboarding');
      expect(seen.map((c) => c.employeeNo)).toEqual(['E100']);
    });

    it('only an administrator manages module staff', async () => {
      await rejects(setStaff(manager, { userId: ids['Rita Requester']!.userId, companyId: null, level: 'agent' }), /Not permitted/);
      await setStaff(admin, { userId: ids['Rita Requester']!.userId, companyId: null, level: 'agent' });
      expect((await listStaff(admin)).some((s) => s.name === 'Rita Requester')).toBe(true);
      await rejects(listStaff(agent), /Not permitted/);
    });
  });

  // ───────────────────────── onboarding ─────────────────────────
  describe('onboarding', () => {
    it('creates the case and its requisition together, with display numbers', async () => {
      const r = await createOnboardingCase(agent, onbInput());
      expect(r.number).toBe('ONB-0001');
      expect(r.requisitionNumber).toBe('ITR-0001');
      const c = await getCase(agent, 'onboarding', r.number);
      expect(c.requisitions).toHaveLength(1);
      expect(c.requisitions[0]!.kind).toBe('requisition');
      expect(c.steps).toHaveLength(20);
      const second = await createOnboardingCase(agent, onbInput({ employeeNo: 'E101', newhireEmail: 'two@acme.test' }));
      expect(second.number).toBe('ONB-0002');
    });

    it('is all-or-nothing: no checklist configured, no case either', async () => {
      await saveProvisionDefs(admin, 'requisition', null, []);
      await saveProvisionDefs(admin, 'requisition', b.companyId, []); // this company also has its own extras
      await rejects(createOnboardingCase(agent, onbInput()), /No checklist is configured/);
      expect(await listCases(agent, 'onboarding')).toEqual([]);
    });

    it('allows one active case per employee number and per new-hire email', async () => {
      await createOnboardingCase(agent, onbInput());
      await rejects(createOnboardingCase(agent, onbInput({ newhireEmail: 'other@acme.test' })), /already has an active/);
      await rejects(createOnboardingCase(agent, onbInput({ employeeNo: 'E102', newhireEmail: 'NEW.HIRE@acme.test' })), /already has an active/);
    });

    it('validates required fields, a replacement hire and dates', async () => {
      await rejects(createOnboardingCase(agent, onbInput({ fullName: ' ' })), /Full name/);
      await rejects(createOnboardingCase(agent, onbInput({ joinDate: '12/10/2026' })), /valid date/);
      await rejects(createOnboardingCase(agent, onbInput({ hireType: 'replacement' })), /person being replaced/);
      await rejects(createOnboardingCase(agent, onbInput({ accessSystems: ['Nonexistent System'] })), /not offered/);
    });

    it('enforces phase locks and skipped steps on the server', async () => {
      const { number } = await createOnboardingCase(agent, onbInput({ carparkRequired: false, laptopRequired: false }));
      await rejects(tickStep(agent, 'onboarding', number, 'tour'), /earlier phase/);
      await rejects(tickStep(agent, 'onboarding', number, 'carpark'), /does not apply/);
      await rejects(tickStep(agent, 'onboarding', number, 'daa_ack'), /does not apply/);
      for (const s of ONBOARDING_STEPS.filter((s) => s.phase === 0 && s.key !== 'carpark')) await tickStep(agent, 'onboarding', number, s.key);
      await tickStep(agent, 'onboarding', number, 'tour');
      await rejects(tickStep(agent, 'onboarding', number, 'bg_intro'), /earlier phase/);
      await rejects(tickStep(agent, 'onboarding', number, 'tour'), /already done/);
    });

    it('completes when every applicable step is done, and undo reverts it (manager only)', async () => {
      const { number } = await createOnboardingCase(agent, onbInput({ carparkRequired: false, laptopRequired: false }));
      for (const s of ONBOARDING_STEPS.filter((s) => s.key !== 'carpark' && s.key !== 'daa_ack')) await tickStep(agent, 'onboarding', number, s.key);
      let c = await getCase(agent, 'onboarding', number);
      expect(c.case.status).toBe('completed');
      await rejects(undoStep(agent, 'onboarding', number, 'survey'), /Not permitted/);
      await undoStep(manager, 'onboarding', number, 'survey', 'ticked by mistake');
      c = await getCase(agent, 'onboarding', number);
      expect(c.case.status).toBe('in_progress');
      expect((await caseHistory(agent, 'onboarding', number)).some((h) => h.action === 'step.undone' && (h.detail as { reason?: string }).reason === 'ticked by mistake')).toBe(true);
    });

    it('the new hire sees only their own checklist, with no sensitive fields; their one action is the acknowledgement', async () => {
      const hire = await person('Sarah Tan');
      const { number } = await createOnboardingCase(agent, onbInput({
        fullName: 'Sarah Tan', employeeNo: 'E321', newhireEmail: 'sarah.tan@acme.test', costCentre: 'CC-SECRET', nricPassport: '900101-14-5678', notes: 'internal note only',
      }));
      expect(await getMyOnboarding(requester)).toBeNull(); // someone else's account sees nothing
      const mine = (await getMyOnboarding(hire.ctx))!;
      expect(mine.number).toBe(number);
      expect(mine.steps.length).toBeGreaterThan(10);
      const blob = JSON.stringify(mine);
      for (const secret of ['CC-SECRET', '900101-14-5678', 'internal note only', 'Alice Agent']) expect(blob).not.toContain(secret);
      // not available until the laptop was handed over
      expect(mine.acknowledgement.available).toBe(false);
      await rejects(submitMyAcknowledgement(hire.ctx, { contactNumber: '012', serialNumber: 'SN1', acknowledged: true }), /not been marked/);
      for (const s of ONBOARDING_STEPS.filter((s) => s.phase === 0)) await tickStep(agent, 'onboarding', number, s.key);
      await tickStep(agent, 'onboarding', number, 'laptop_dist');
      expect((await getMyOnboarding(hire.ctx))!.acknowledgement.available).toBe(true);
      await rejects(submitMyAcknowledgement(hire.ctx, { contactNumber: '012', serialNumber: 'SN1', acknowledged: false }), /acknowledgement/);
      await rejects(submitMyAcknowledgement(hire.ctx, { contactNumber: '', serialNumber: 'SN1', acknowledged: true }), /contact number/);
      await submitMyAcknowledgement(hire.ctx, { contactNumber: '012-3456789', serialNumber: 'SN1', pcType: 'Laptop', acknowledged: true });
      const after = (await getMyOnboarding(hire.ctx))!;
      expect(after.acknowledgement.submittedAt).toBeTruthy();
      expect(after.steps.find((s) => s.key === 'daa_ack')!.done).toBe(true);
      await rejects(submitMyAcknowledgement(hire.ctx, { contactNumber: '012', serialNumber: 'SN2', acknowledged: true }), /not available/);
      // staff see it recorded in the case history
      expect((await caseHistory(agent, 'onboarding', number)).some((h) => h.action === 'daa.submitted')).toBe(true);
      // a cancelled case disappears from the new hire's view
      await cancelCase(manager, 'onboarding', number, 'withdrawn');
      expect(await getMyOnboarding(hire.ctx)).toBeNull();
    });

    it('cancel needs a manager and a reason, blocks ticking, and reopen restores it', async () => {
      const { number } = await createOnboardingCase(agent, onbInput());
      await rejects(cancelCase(agent, 'onboarding', number, 'no show'), /Not permitted/);
      await rejects(cancelCase(manager, 'onboarding', number, ' '), /reason/);
      await cancelCase(manager, 'onboarding', number, 'offer withdrawn');
      await rejects(tickStep(agent, 'onboarding', number, 'p_file'), /cancelled/);
      expect((await listCases(manager, 'onboarding', { history: true })).map((c) => c.number)).toEqual([number]);
      await rejects(listCases(agent, 'onboarding', { history: true }), /manager/);
      await reopenCase(manager, 'onboarding', number);
      await tickStep(agent, 'onboarding', number, 'p_file');
    });

    it('editing mirrors person fields onto the requisition and keeps the employee number fixed', async () => {
      const { number, requisitionNumber } = await createOnboardingCase(agent, onbInput());
      await updateCase(agent, 'onboarding', number, { jobTitle: 'Senior Analyst', department: 'Treasury', costCentre: 'CC9' });
      const req = await getRequisition(agent, requisitionNumber);
      expect(req.requisition.jobTitle).toBe('Senior Analyst');
      expect(req.requisition.department).toBe('Treasury');
      await rejects(updateCase(agent, 'onboarding', number, { replacedPerson: 'X', hireType: 'new_hire', accessSystems: ['Bogus'] }), /not offered/);
    });

    it('comments are kept per case and visible only to staff', async () => {
      const a = await createOnboardingCase(agent, onbInput());
      await addComment(agent, 'onboarding', a.number, '@Mia please check');
      expect((await listComments(manager, 'onboarding', a.number)).map((c) => c.body)).toEqual(['@Mia please check']);
      await rejects(listComments(requester, 'onboarding', a.number), /Not permitted|not found/i);
    });
  });

  // ───────────────────────── offboarding ─────────────────────────
  describe('offboarding', () => {
    const ofbInput = (o: Record<string, unknown> = {}) => ({ companyId: b.companyId, fullName: 'Leaver One', employeeNo: 'E500', resignationDate: '2026-10-01', lastWorkingDay: '2026-10-31', ...o });

    it('locks the processing phase until the outcome is recorded', async () => {
      const { number } = await createOffboardingCase(agent, ofbInput());
      await rejects(tickStep(agent, 'offboarding', number, 'it_asset_return'), /outcome first/);
      await tickStep(agent, 'offboarding', number, 'resign_submit');
      await rejects(tickStep(agent, 'offboarding', number, 'resign_outcome'), /outcome control/);
    });

    it('Accepted raises exactly one IT Return and unlocks processing', async () => {
      const { number } = await createOffboardingCase(agent, ofbInput());
      const r = await setOutcome(agent, number, 'accepted');
      expect(r.returnNumber).toMatch(/^ITR-\d{4}$/);
      const c = await getCase(agent, 'offboarding', number);
      expect(c.case.outcome).toBe('accepted');
      expect(c.requisitions.filter((x) => x.kind === 'return' && x.status !== 'cancelled')).toHaveLength(1);
      await tickStep(agent, 'offboarding', number, 'share_resign_letter');
      await rejects(tickStep(agent, 'offboarding', number, 'retention_bg_approval'), /does not apply/);
    });

    it('records the outcome once by staff; changing it is admin-only with a reason', async () => {
      const { number } = await createOffboardingCase(agent, ofbInput());
      await setOutcome(agent, number, 'accepted');
      await rejects(setOutcome(agent, number, 'rejected', 'changed mind'), /administrator/);
      await rejects(setOutcome(manager, number, 'rejected', 'changed mind'), /administrator/);
      await rejects(setOutcome(admin, number, 'rejected'), /reason is required/);
      await setOutcome(admin, number, 'rejected', 'Retention agreed');
      expect((await getCase(agent, 'offboarding', number)).case.outcome).toBe('rejected');
    });

    it('Accepted -> Rejected cancels the open Return; Rejected -> Accepted raises a new one', async () => {
      const { number } = await createOffboardingCase(agent, ofbInput());
      const first = (await setOutcome(agent, number, 'accepted')).returnNumber!;
      await setOutcome(admin, number, 'rejected', 'Retention agreed');
      expect((await getRequisition(agent, first)).requisition.status).toBe('cancelled');
      const second = (await setOutcome(admin, number, 'accepted', 'Employee resigned again')).returnNumber!;
      expect(second).not.toBe(first);
      const open = (await getCase(agent, 'offboarding', number)).requisitions.filter((x) => x.kind === 'return' && x.status !== 'cancelled');
      expect(open.map((x) => x.number)).toEqual([second]);
      const hist = (await caseHistory(agent, 'offboarding', number)).map((h) => h.action);
      expect(hist).toEqual(expect.arrayContaining(['outcome.set', 'outcome.changed', 'return.created', 'return.cancelled']));
    });

    it('validates dates and one active case per employee number', async () => {
      await rejects(createOffboardingCase(agent, ofbInput({ lastWorkingDay: '2026-09-01' })), /before the resignation/);
      await createOffboardingCase(agent, ofbInput());
      await rejects(createOffboardingCase(agent, ofbInput()), /already has an active/);
    });

    it('a Rejected case completes through the retention path alone', async () => {
      const { number } = await createOffboardingCase(agent, ofbInput());
      await setOutcome(agent, number, 'rejected');
      for (const s of OFFBOARDING_STEPS.filter((s) => s.rule !== 'outcome_accepted' && s.key !== 'resign_outcome')) await tickStep(agent, 'offboarding', number, s.key);
      expect((await getCase(agent, 'offboarding', number)).case.status).toBe('completed');
    });
  });

  // ───────────────────────── requisitions ─────────────────────────
  describe('IT requisitions', () => {
    const standalone = () => createStandaloneRequisition(agent, { companyId: b.companyId, fullName: 'Walk In', employeeNo: 'E700' });

    it('company approval levels drive the chain: 0 needs none, 1 one approver, 2 L1 then a different L2', async () => {
      // CHGP (this company) has 0 levels by default: counts as approved.
      const a = await standalone();
      expect((await getRequisition(agent, a.number)).requisition.approvalStatus).toBe('approved');
      await rejects(decideRequisition(manager, a.number, 'approve'), /needs no approval/);

      await saveCompanyConfig(admin, b.companyId, { approvalLevels: 2, accessSystems: [] });
      const two = await standalone();
      expect((await getRequisition(agent, two.number)).requisition.approvalStatus).toBe('pending');
      await rejects(decideRequisition(agent, two.number, 'approve'), /Not permitted/);
      expect(await decideRequisition(manager, two.number, 'approve')).toBe('pending_l2');
      await rejects(decideRequisition(manager, two.number, 'approve'), /different person/);
      expect(await decideRequisition(manager2, two.number, 'approve', 'ok')).toBe('approved');
      await rejects(decideRequisition(manager2, two.number, 'approve'), /already been decided/);

      await saveCompanyConfig(admin, b.companyId, { approvalLevels: 1, accessSystems: [] });
      const one = await standalone();
      expect(await decideRequisition(manager, one.number, 'reject', 'not needed')).toBe('rejected');
      await rejects(setProvision(agent, one.number, 'email_create', 'done'), /rejected/);
    });

    it('nobody approves a requisition they raised', async () => {
      await saveCompanyConfig(admin, b.companyId, { approvalLevels: 1, accessSystems: [] });
      const r = await createStandaloneRequisition(manager, { companyId: b.companyId, fullName: 'X', employeeNo: 'E710' });
      await rejects(decideRequisition(manager, r.number, 'approve'), /cannot approve a requisition you raised/);
      expect(await decideRequisition(manager2, r.number, 'approve')).toBe('approved');
    });

    it('completes only when every item is resolved AND the requisition is approved', async () => {
      await saveCompanyConfig(admin, b.companyId, { approvalLevels: 1, accessSystems: [] });
      const r = await standalone();
      const items = (await getRequisition(agent, r.number)).items;
      for (const it of items) await setProvision(agent, r.number, it.itemKey, it.itemKey === 'access_card' ? 'na' : 'done');
      expect((await getRequisition(agent, r.number)).requisition.status).toBe('in_progress');
      await decideRequisition(manager, r.number, 'approve');
      expect((await getRequisition(agent, r.number)).requisition.status).toBe('completed');
    });

    it('cancel needs a manager and a reason; a cancelled requisition cannot be worked', async () => {
      const r = await standalone();
      await rejects(cancelRequisition(agent, r.number, 'x'), /Not permitted/);
      await rejects(cancelRequisition(manager, r.number, ''), /reason/);
      await cancelRequisition(manager, r.number, 'duplicate');
      await rejects(setProvision(agent, r.number, 'email_create', 'done'), /cancelled/);
    });
  });

  // ───────────────────────── assets ─────────────────────────
  describe('asset register and hand-offs', () => {
    it('generates BG-TYPE-0001 codes from the company code, per prefix', async () => {
      const a = await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop' });
      const c = await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop' });
      const m = await registerAsset(agent, { companyId: b.companyId, assetType: 'monitor' });
      const o = await registerAsset(admin, { companyId: companyB, assetType: 'laptop' });
      expect([a.code, c.code, m.code, o.code]).toEqual(['CHGP-LAP-0001', 'CHGP-LAP-0002', 'CHGP-MON-0001', 'BETA-LAP-0001']);
    });

    it('an issued asset needs a named user; bulk change excludes Issued; every change is in the history', async () => {
      await rejects(registerAsset(agent, { companyId: b.companyId, assetType: 'laptop', status: 'issued' }), /named user/);
      const a = await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop' });
      const c = await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop' });
      await rejects(updateAsset(agent, a.code, { status: 'issued' }), /named user/);
      await updateAsset(agent, a.code, { status: 'issued', userName: 'Sam', userEmployeeNo: 'E1' });
      await rejects(bulkAssetStatus(agent, [a.code, c.code], 'issued'), /one at a time/);
      expect((await bulkAssetStatus(agent, [a.code, c.code], 'under_repair')).changed).toBe(2);
      const asset = await getAsset(agent, a.code);
      expect(asset.status).toBe('under_repair');
      expect(asset.userName).toBeNull();
      const h = (await assetHistory(agent, a.code)).map((x) => x.action);
      expect(h.filter((x) => x === 'asset.status')).toHaveLength(2);
    });

    it('filters by status and warranty expiring within 30 days', async () => {
      const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
      const far = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
      await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop', warrantyEnd: soon });
      await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop', warrantyEnd: far });
      expect(await listAssets(agent, { expiringWarranty: true })).toHaveLength(1);
      expect(await listAssets(agent, { status: 'in_stock' })).toHaveLength(2);
      expect(await listAssets(agent, { status: 'issued' })).toHaveLength(0);
    });

    it('Issue Laptop with an asset code issues the device, only once approved; Return receives it', async () => {
      await saveCompanyConfig(admin, b.companyId, { approvalLevels: 1, accessSystems: [] });
      const asset = await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop' });
      const { requisitionNumber } = await createOnboardingCase(agent, onbInput());
      await rejects(setProvision(agent, requisitionNumber, 'laptop_issue', 'done', { assetCode: asset.code }), /approved before a device/);
      await decideRequisition(manager, requisitionNumber, 'approve');
      const out = await setProvision(agent, requisitionNumber, 'laptop_issue', 'done', { assetCode: asset.code });
      expect(out.issued).toBe(asset.code);
      const issued = await getAsset(agent, asset.code);
      expect(issued.status).toBe('issued');
      expect(issued.userName).toBe('New Hire');
      expect(issued.userEmployeeNo).toBe('E100');
      // The same device cannot be issued twice.
      const other = await createStandaloneRequisition(admin, { companyId: b.companyId, fullName: 'Other', employeeNo: 'E800' });
      await rejects(setProvision(agent, other.number, 'laptop_issue', 'done', { assetCode: asset.code }), /cannot be issued|issued/);

      // Offboarding: Accepted creates a Return; receiving the device returns the asset.
      const off = await createOffboardingCase(agent, { companyId: b.companyId, fullName: 'New Hire', employeeNo: 'E100', resignationDate: '2026-10-08' });
      const ret = (await setOutcome(agent, off.number, 'accepted')).returnNumber!;
      await setProvision(agent, ret, 'asset_return', 'done');
      const back = await getAsset(agent, asset.code);
      expect(back.status).toBe('returned');
      expect(back.userName).toBeNull();
      const hist = (await assetHistory(agent, asset.code)).map((x) => x.action);
      expect(hist).toEqual(expect.arrayContaining(['asset.issued', 'asset.returned']));
    });

    it('with several devices out, the return must say which came back; a stranger\'s device is refused', async () => {
      const a1 = await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop' });
      const a2 = await registerAsset(agent, { companyId: b.companyId, assetType: 'monitor' });
      const a3 = await registerAsset(agent, { companyId: b.companyId, assetType: 'monitor' });
      await updateAsset(agent, a1.code, { status: 'issued', userName: 'Lee', userEmployeeNo: 'E900' });
      await updateAsset(agent, a2.code, { status: 'issued', userName: 'Lee', userEmployeeNo: 'e900' });
      await updateAsset(agent, a3.code, { status: 'issued', userName: 'Someone Else', userEmployeeNo: 'E901' });
      const off = await createOffboardingCase(agent, { companyId: b.companyId, fullName: 'Lee', employeeNo: 'E900', resignationDate: '2026-10-08' });
      const ret = (await setOutcome(agent, off.number, 'accepted')).returnNumber!;
      await rejects(setProvision(agent, ret, 'asset_return', 'done'), /choose which/);
      await rejects(returnAssets(agent, ret, [a3.code]), /not issued to E900/);
      await returnAssets(agent, ret, [a1.code, a2.code]);
      expect((await getAsset(agent, a1.code)).status).toBe('returned');
      expect((await getAsset(agent, a3.code)).status).toBe('issued');
      // returns for a cancelled requisition are refused
      await cancelRequisition(manager, ret, 'wrong person');
      await rejects(returnAssets(agent, ret, [a1.code]), /cancelled/);
    });
  });

  // ───────────────────────── asset requests ─────────────────────────
  describe('asset requests', () => {
    async function catalogue(code = 'HW-001') {
      await ensureCatalogue(manager);
      return (await import('../packs/lifecycle/service')).listCatalogue(requester).then((c) => c.find((x) => x.itemCode === code)!);
    }

    it('any employee requests from the catalogue and sees only their own', async () => {
      const item = await catalogue('HW-003');
      const mine = await createAssetRequest(requester, { catalogueId: item.id, companyId: b.companyId, justification: 'second screen', quantity: 1 });
      await createAssetRequest(requester2, { catalogueId: item.id, companyId: b.companyId, justification: 'also' });
      expect(mine.number).toBe('AR-0001');
      expect((await listAssetRequests(requester)).map((r) => r.number)).toEqual(['AR-0001']);
      expect((await listAssetRequests(requester2)).map((r) => r.number)).toEqual(['AR-0002']);
      expect((await listAssetRequests(manager)).map((r) => r.number).sort()).toEqual(['AR-0001', 'AR-0002']);
    });

    it('refuses an empty catalogue item, a bad quantity, and a company the requester does not work for', async () => {
      const item = await catalogue();
      await rejects(createAssetRequest(requester, { catalogueId: item.id, companyId: b.companyId, quantity: 0 }), /Quantity/);
      await rejects(createAssetRequest(requester, { catalogueId: item.id, companyId: companyB }), /company you work for/);
    });

    it('two-level items need L1 then a different L2; fulfilment cannot start before approval or skip a stage', async () => {
      const item = await catalogue('HW-001');
      expect(item.approvalLevels).toBe(2);
      const { number } = await createAssetRequest(requester, { catalogueId: item.id, companyId: b.companyId });
      await rejects(advanceAssetRequest(manager, number, 'procured'), /cannot move to procured/);
      await rejects(decideAssetRequest(agent, number, 'approve'), /Not permitted|not found/);
      expect(await decideAssetRequest(manager, number, 'approve')).toBe('pending_approval');
      await rejects(advanceAssetRequest(manager, number, 'procured'), /cannot move to procured/);
      await rejects(decideAssetRequest(manager, number, 'approve'), /different person/);
      expect(await decideAssetRequest(manager2, number, 'approve')).toBe('approved');
      await rejects(advanceAssetRequest(agent, number, 'procured'), /Not permitted|not found/);
      await rejects(advanceAssetRequest(manager, number, 'assigned', { assetCode: 'X' }), /cannot move to assigned/);
      await advanceAssetRequest(manager, number, 'procured');
      await advanceAssetRequest(manager, number, 'tagged');
      await rejects(advanceAssetRequest(manager, number, 'assigned'), /asset code/);
      const asset = await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop' });
      await advanceAssetRequest(manager, number, 'assigned', { assetCode: asset.code });
      await advanceAssetRequest(manager, number, 'completed');
      const held = await getAsset(agent, asset.code);
      expect(held.status).toBe('issued');
      expect(held.userName).toBe('Rita Requester');
    });

    it('nobody approves their own request; the requester cancels only their own', async () => {
      const item = await catalogue('HW-003');
      const { number } = await createAssetRequest(manager, { catalogueId: item.id, companyId: b.companyId });
      await rejects(decideAssetRequest(manager, number, 'approve'), /your own request/);
      const mine = await createAssetRequest(requester, { catalogueId: item.id, companyId: b.companyId });
      await rejects(cancelAssetRequest(requester2, mine.number), /not found|Not permitted/i);
      await cancelAssetRequest(requester, mine.number, 'no longer needed');
      expect((await listAssetRequests(requester))[0]!.status).toBe('cancelled');
    });

    it('rejection is final, and the handler must be module staff', async () => {
      const item = await catalogue('HW-003');
      const { number } = await createAssetRequest(requester, { catalogueId: item.id, companyId: b.companyId });
      await rejects(setAssetRequestHandler(manager, number, ids['Rob Requester']!.userId), /module staff/);
      await setAssetRequestHandler(manager, number, ids['Alice Agent']!.userId);
      expect(await decideAssetRequest(manager, number, 'reject', 'no budget')).toBe('rejected');
      await rejects(decideAssetRequest(manager2, number, 'approve'), /already been decided/);
      await rejects(advanceAssetRequest(manager, number, 'procured'), /cannot move/);
    });
  });

  // ───────────────────────── configuration ─────────────────────────
  describe('configuration', () => {
    it('is admin-only; edits keep step keys and deactivate removed steps without losing history', async () => {
      await rejects(saveStepDefs(manager, 'onboarding', []), /administrator|between 1/);
      const { number } = await createOnboardingCase(agent, onbInput());
      await tickStep(agent, 'onboarding', number, 'seat');
      const edited = ONBOARDING_STEPS.filter((s) => s.key !== 'seat').map((s) => ({ key: s.key, phase: s.phase, label: s.key === 'buddy' ? 'Assign a buddy (renamed)' : s.label, ownerTeam: s.ownerTeam, rule: s.rule, hrms: s.hrms }));
      await saveStepDefs(admin, 'onboarding', edited);
      const c = await getCase(agent, 'onboarding', number);
      expect(c.steps.find((s) => s.key === 'buddy')!.label).toBe('Assign a buddy (renamed)');
      expect(c.steps.find((s) => s.key === 'seat')!.done).toBe(true); // removed but already ticked: stays in the history
      const fresh = await createOnboardingCase(agent, onbInput({ employeeNo: 'E300', newhireEmail: null }));
      expect((await getCase(agent, 'onboarding', fresh.number)).steps.some((s) => s.key === 'seat')).toBe(false);
    });

    it('custom fields: validated, company-scoped, capped at 40, staff-only values', async () => {
      await rejects(saveCustomFields(manager, 'onboarding', [{ label: 'X' }]), /administrator/);
      await saveCustomFields(admin, 'onboarding', [
        { label: 'Shirt size', type: 'choice', options: ['S', 'M', 'L'], required: true },
        { label: 'Project code', type: 'text', companyIds: [companyB] },
      ]);
      await rejects(createOnboardingCase(agent, onbInput()), /Shirt size is required/);
      await rejects(createOnboardingCase(agent, onbInput({ custom: { shirt_size: 'XXL' } })), /one of/);
      const ok = await createOnboardingCase(agent, onbInput({ custom: { shirt_size: 'M', project_code: 'ignored: not this company' } }));
      const view = await getCase(agent, 'onboarding', ok.number);
      expect(view.case.custom).toEqual({ shirt_size: 'M' });
      await rejects(saveCustomFields(admin, 'onboarding', Array.from({ length: 41 }, (_, i) => ({ label: `F${i}` }))), /At most 40/);
    });

    it('loading the handover defaults is idempotent and picks per-company extras by company code', async () => {
      const first = await loadHandoverDefaults(admin);
      expect(first.steps).toBe(41);
      expect(first.catalogue).toBe(12);
      expect(first.fields).toBeGreaterThan(0);
      const second = await loadHandoverDefaults(admin);
      expect(second.steps).toBe(0);
      expect(second.catalogue).toBe(0);
      const { number } = await createStandaloneRequisition(agent, { companyId: b.companyId, fullName: 'P', employeeNo: 'E1' });
      const items = (await getRequisition(agent, number)).items.map((i) => i.itemKey);
      expect(items).toEqual(expect.arrayContaining(['mytepro', 'rr_account', 'car_park'])); // CHGP extras
      const { number: n2 } = await createStandaloneRequisition(admin, { companyId: companyB, fullName: 'Q', employeeNo: 'E2' });
      expect((await getRequisition(agent, n2)).items.map((i) => i.itemKey)).not.toContain('mytepro');
    });

    it('configuration writes are in the audit ledger', async () => {
      await saveCompanyConfig(admin, b.companyId, { approvalLevels: 2, accessSystems: ['M365'] });
      const ev = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId));
      expect(ev.some((e) => e.eventType === 'lifecycle-config.company-saved')).toBe(true);
    });
  });
});
