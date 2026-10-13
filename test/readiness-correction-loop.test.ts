import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
vi.mock('../lib/ai', async importActual => ({ ...await importActual<typeof import('../lib/ai')>(), generateDraft: vi.fn() }));
vi.mock('../core/ai-config', async importActual => ({ ...await importActual<typeof import('../core/ai-config')>(), resolveActiveAiConfig: vi.fn(async () => null) }));
import { generateDraft } from '../lib/ai';
import { resolveActiveAiConfig } from '../core/ai-config';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestProfileChange, decideProfileChange } from '../core/profile';
import { myReadinessActions, loadReadinessActions } from '../core/readiness-actions';
import { reconcileReadinessCases, orchestrationQueue } from '../core/hr-orchestrator';
import { sweepReadinessNudges } from '../core/readiness-nudge';
import { dispatchNotifications } from '../core/notifications';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); vi.mocked(resolveActiveAiConfig).mockResolvedValue(null); vi.mocked(generateDraft).mockReset(); });
afterAll(closeAll);
async function fixture() {
  const e = await hireEmployee(adminCtx(b), { person: { fullName: 'Correction employee', primaryEmail: `correction-${crypto.randomUUID()}@example.test` }, companyId: b.companyId,
    departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
  await owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: b.tenantId, personId: e.personId,
    passportNumber: crypto.randomUUID(), epfNumber: 'EPF', socsoNumber: 'SOCSO', taxNumber: 'TAX' });
  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  const employee: SessionContext = { ...adminCtx(b), userId, personId: e.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  return { e, employee };
}
const bankRequest = (employee: SessionContext, employmentId: string) => requestProfileChange(employee, { employmentId,
  proposed: { bankName: 'Test bank', bankAccountNo: '12345678' } });
const bankCase = async (id: string) => (await owner.db.select().from(schema.hrOrchestrationCase).where(eq(schema.hrOrchestrationCase.employmentId, id))).find(r => r.gap === 'no_bank_account')!;
async function nudgesOn() { await setModule(b.tenantId, 'notifications', 'active'); await setSetting(b.tenantId, 'notifications.readiness_nudge_enabled', true); return adminCtx(b); }

describe('approval-aware correction loop', () => {
  it('submits, pauses chasing, reviews, then verifies the actual source correction', async () => {
    const { e, employee } = await fixture(); const admin = await nudgesOn();
    await reconcileReadinessCases(admin); const original = await bankCase(e.employmentId);
    expect(await myReadinessActions(employee, e.employmentId)).toMatchObject([{ gap: 'no_bank_account', type: 'submit_correction' }]);
    const request = await bankRequest(employee, e.employmentId);
    expect(await myReadinessActions(employee, e.employmentId)).toMatchObject([{ gap: 'no_bank_account', type: 'review_submission', requestId: request.requestId }]);
    expect((await orchestrationQueue(admin)).rows.find(r => r.id === original.id)?.action).toMatchObject({ type: 'review_submission', mayReview: true });
    expect(await sweepReadinessNudges(admin)).toMatchObject({ sent: 0, awaitingReview: 1 });
    await reconcileReadinessCases(admin);
    expect(await bankCase(e.employmentId)).toMatchObject({ id: original.id, state: 'needs_review', verifiedAt: null });
    await decideProfileChange(admin, { requestId: request.requestId, decision: 'approved' });
    await reconcileReadinessCases(admin);
    expect(await bankCase(e.employmentId)).toMatchObject({ id: original.id, state: 'verified', reopenCount: 0 });
    expect(await myReadinessActions(employee, e.employmentId)).toEqual([]);
  });
  it('rejecting resumes employee work without claiming a correction or creating a second case', async () => {
    const { e, employee } = await fixture(); const admin = adminCtx(b);
    const request = await bankRequest(employee, e.employmentId); await reconcileReadinessCases(admin);
    const before = await bankCase(e.employmentId);
    await expect(decideProfileChange(admin, { requestId: request.requestId, decision: 'rejected' })).rejects.toThrow();
    await decideProfileChange(admin, { requestId: request.requestId, decision: 'rejected', reason: 'Check the bank statement.' });
    await reconcileReadinessCases(admin);
    expect(await bankCase(e.employmentId)).toMatchObject({ id: before.id, state: 'needs_input', reopenCount: 0, verifiedAt: null });
    expect((await myReadinessActions(employee, e.employmentId))[0].type).toBe('submit_correction');
  });
  it('routes locked fields and absent statutory profiles to HR, and keeps group approval narrow', async () => {
    const { e, employee } = await fixture();
    await setSetting(b.tenantId, 'ess.profile_change_fields', []);
    expect(await myReadinessActions({ ...employee, entitlements: adminCtx(b).entitlements }, e.employmentId)).toEqual([]);
    await owner.db.delete(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, e.personId));
    expect(await myReadinessActions(employee, e.employmentId)).toEqual([]);
    await owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: b.tenantId, personId: e.personId });
    // Existing pending rows remain reviewable for rejection when permissions have since closed.
    await owner.db.insert(schema.profileChangeRequest).values({ tenantId: b.tenantId, personId: e.personId,
      employmentId: e.employmentId, proposed: { bankName: 'Bank', bankAccountNo: '123' } });
    await setSetting(b.tenantId, 'ess.profile_change_approver', 'group_admin');
    const admin = adminCtx(b);
    const action = async (ctx: SessionContext) => (await withTenant(ctx, tx => loadReadinessActions(tx, ctx, [e.employmentId]))).get(`${e.employmentId}:no_bank_account`);
    expect(await action({ ...admin, grants: [{ role: 'hr_admin', companyId: b.companyId }] })).toMatchObject({ approver: 'group_admin', mayReview: false });
    expect(await action({ ...admin, grants: [{ role: 'hr_admin', companyId: null }] })).toMatchObject({ mayReview: true });
    expect(await action({ ...admin, personId: e.personId, grants: [{ role: 'hr_admin', companyId: null }] })).toMatchObject({ mayReview: false });
  });
  it('never exposes another person, company or tenant through personal tasks', async () => {
    const first = await fixture(); const other = await fixture();
    expect((await myReadinessActions(first.employee, first.e.employmentId)).length).toBeGreaterThan(0);
    expect(await myReadinessActions(first.employee, other.e.employmentId)).toEqual([]);
    const foreign = await seedBase();
    expect(await myReadinessActions({ ...adminCtx(foreign), personId: first.e.personId }, first.e.employmentId)).toEqual([]);
    const scoped = { ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: crypto.randomUUID() }] };
    expect((await withTenant(scoped, tx => loadReadinessActions(tx, scoped, [first.e.employmentId]))).size).toBe(0);
  });
  it('keeps observed cases visible when action settings cannot be resolved', async () => {
    await fixture(); await reconcileReadinessCases(adminCtx(b));
    const view = await orchestrationQueue({ ...adminCtx(b), entitlements: undefined, entitlementsError: 'fixture outage' });
    expect(view.total).toBeGreaterThan(0);
    expect(view.actionsUnavailable).toBe(true);
    expect(view.rows.every(row => row.action === null)).toBe(true);
  });
  it('ignores blank or irrelevant pending values; a pending status alone is not evidence', async () => {
    const { e, employee } = await fixture();
    await owner.db.insert(schema.profileChangeRequest).values({ tenantId: b.tenantId, personId: e.personId,
      employmentId: e.employmentId, proposed: { bankName: '   ', bankAccountNo: '', preferredName: 'Name' } });
    expect((await myReadinessActions(employee, e.employmentId))[0].type).toBe('submit_correction');
  });
  it.each(['submission', 'permission', 'switch', 'source'] as const)('suppresses stale effects when %s changes during drafting', async change => {
    const { e, employee } = await fixture(); const admin = await nudgesOn();
    vi.mocked(resolveActiveAiConfig).mockResolvedValue({ provider: 'anthropic', model: 'fixture', apiKey: 'test-only' });
    vi.mocked(generateDraft).mockImplementation(async () => {
      if (change === 'submission') await bankRequest(employee, e.employmentId);
      if (change === 'permission') await setSetting(b.tenantId, 'ess.profile_change_fields', []);
      if (change === 'switch') await setSetting(b.tenantId, 'notifications.readiness_nudge_enabled', false);
      if (change === 'source') await owner.db.update(schema.employment).set({ paymentMethod: 'cash' }).where(eq(schema.employment.id, e.employmentId));
      return 'Please submit your missing bank account for HR approval.';
    });
    expect(await sweepReadinessNudges(admin)).toMatchObject({ sent: 0, changed: 1 });
    expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'readiness.nudge-raised'))).toEqual([]);
  });
  it('projects a governed employee form link without exposing proposed values', async () => {
    const { e } = await fixture(); const admin = await nudgesOn();
    expect((await sweepReadinessNudges(admin)).sent).toBe(1);
    await dispatchNotifications(admin);
    const notifications = await owner.db.select().from(schema.notification).where(eq(schema.notification.recipientEmploymentId, e.employmentId));
    expect(notifications.some(n => n.linkPath === '/me?tab=bankStatutory#section-request-bankStatutory')).toBe(true);
  });
});
