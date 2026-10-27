import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, setPayrollInput } from '../packs/payroll/service';
import { returnedRewardUnits, getRewardSeniorMembership, previewRewardSeniorMembership, saveRewardSeniorMembership, getRewardConfiguration, listRewardUnits, pendingRewardReviews, rewardSetupChoices, rewardNotificationRecipients, createOffcycleReview, createRewardUnit, getRewardUnit, saveRewardEntry, saveRewardPolicy, setRewardMember, decideRewardUnit, postRewardUnit } from '../packs/rewards/service';
import { emptyFacts, returnedState, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { dispatchNotificationsFromSweep, renderRewardRouted } from '../core/notifications';
import { todayInKualaLumpur } from '../lib/hr-date';

const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
describe('Rewards persistence, authorization and atomic enactment', () => {
  let b: Base, admin: SessionContext, unitId: string, employmentId: string;
  const actors: Partial<Record<RewardRole, SessionContext>> = {};
  const view = () => getRewardUnit(admin, unitId);
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    // New grants select an existing readable person-backed account; external reviewers need no employment.
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Rewards administrator', primaryEmail: 'administrator@rewards.test' }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, admin.userId!));
    admin = { ...admin, personId: adminPerson.id };
    const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'HQ', name: 'Headquarters' }).returning();
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    const hire = await hireEmployee(admin, { person: { fullName: 'Reward Employee', primaryEmail: 'employee@rewards.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    employmentId = hire.employmentId;
    await owner.db.update(schema.assignment).set({ businessUnitId: bu.id }).where(eq(schema.assignment.employmentId, employmentId));
    await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, employmentId));
    await setCompensation(admin, { employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    unitId = await createRewardUnit(admin, { name: 'Annual rewards', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    for (const role of ['bu', 'bg', 'ctro', 'ec', 'pbp'] as const) {
      const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `${role} reviewer`, primaryEmail: `${role}@rewards.test` }).returning();
      const userId = await createAppUser(b.tenantId, p.id, 'employee');
      actors[role] = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
      await setRewardMember(admin, unitId, (await view()).unit.revision, userId, role);
    }
    actors.gr = admin; actors.payroll = admin;
    await setRewardMember(admin, unitId, (await view()).unit.revision, admin.userId!, 'payroll');
    const v = await view();
    await saveRewardPolicy(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] } });
    const v2 = await view();
    await saveRewardEntry(admin, unitId, v2.unit.revision, v2.rows[0].id, v2.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
  });
  afterAll(closeAll);
  async function approve() {
    const rev = (await view()).unit.revision;
    expect(await decideRewardUnit(actors.bu!, unitId, rev, 'submit', 'Reviewed recommendations')).toBe('bg');
    for (const role of ['bg', 'gr', 'ctro', 'ec'] as const) await decideRewardUnit(actors[role]!, unitId, rev, 'approve', 'Reviewed recommendations');
    return rev;
  }
  it.each([
    ['  Current Rewards unit  ', 'Current Rewards unit'],
    ['', 'HQ'],
    [null, 'HQ'],
  ] as const)('uses the canonical unit label or code across setup, review, configuration and pending work (%s)', async (label, expected) => {
    // Actual app reproduction: the selector showed the current label while both review headings
    // and the review list showed a different legacy name for this same retained unit UUID.
    const before = await view();
    await owner.db.update(schema.businessUnit).set({ label, name: 'Legacy unit name must not display' }).where(eq(schema.businessUnit.id, before.unit.businessUnitId));
    expect((await rewardSetupChoices(admin, [b.companyId])).units.find(row => row.id === before.unit.businessUnitId)?.name).toBe(expected);
    expect((await listRewardUnits(admin, [b.companyId])).find(row => row.id === unitId)?.unit).toBe(expected);
    expect((await getRewardConfiguration(admin, unitId)).name).toBe(expected);
    expect((await view()).name).toBe(expected);
    await decideRewardUnit(actors.bu!, unitId, before.unit.revision, 'submit', 'Fictional canonical unit display acceptance');
    expect((await pendingRewardReviews(actors.bg!, [b.companyId])).find(row => row.id === unitId)?.name).toBe(expected);
  });
  it('previews and saves named membership without exposing pay or changing recommendations', async () => {
    const before = await view();
    const selection = { employmentIds: [employmentId], adoptLegacy: false };
    const preview = await previewRewardSeniorMembership(admin, unitId, before.unit.revision, selection);
    expect(preview.rows).toMatchObject([{ employmentId, member: false, nextMember: true }]);
    for (const privateKey of ['basicCents', 'recommendation', 'compensationId', 'budget']) expect(JSON.stringify(preview)).not.toContain(privateKey);
    await saveRewardSeniorMembership(admin, unitId, before.unit.revision, selection, preview.digest);
    const reopened = await getRewardSeniorMembership(admin, unitId);
    expect(reopened.mode).toBe('named-members');
    expect(reopened.rows).toMatchObject([{ employmentId, member: true }]);
    const after = await view();
    expect(after.rows[0].bonusEligible).toBe(false);
    expect(after.rows[0].incrementEligible).toBe(before.rows[0].incrementEligible);
    expect(after.rows[0].recommendation).toEqual(before.rows[0].recommendation);
    expect(after.rows[0].source).toEqual(before.rows[0].source);
    expect(after.rows[0].facts.reviewed).toBe(false);
    const deselect = { employmentIds: [], adoptLegacy: false };
    const next = await previewRewardSeniorMembership(admin, unitId, after.unit.revision, deselect);
    await saveRewardSeniorMembership(admin, unitId, after.unit.revision, deselect, next.digest);
    expect((await getRewardSeniorMembership(admin, unitId)).rows[0].member).toBe(false);
  });
  it('refuses duplicate, unavailable, stale and altered-preview selections with no writes', async () => {
    const before = await view(), rev = before.unit.revision;
    await expect(previewRewardSeniorMembership(admin, unitId, rev, { employmentIds: [employmentId, employmentId], adoptLegacy: false })).rejects.toThrow(/once/);
    await expect(previewRewardSeniorMembership(admin, unitId, rev, { employmentIds: ['00000000-0000-4000-8000-000000000099'], adoptLegacy: false })).rejects.toThrow(/visible review roster/);
    const selected = { employmentIds: [employmentId], adoptLegacy: false };
    const preview = await previewRewardSeniorMembership(admin, unitId, rev, selected);
    await expect(saveRewardSeniorMembership(admin, unitId, rev, { employmentIds: [], adoptLegacy: false }, preview.digest)).rejects.toThrow(/preview.*again/i);
    expect((await view()).unit.revision).toBe(rev);
    await saveRewardEntry(admin, unitId, rev, before.rows[0].id, before.rows[0].recommendation);
    await expect(saveRewardSeniorMembership(admin, unitId, rev, selected, preview.digest)).rejects.toThrow(/another session/);
  });
  it('requires explicit draft conversion and preserves an own-person hidden legacy membership', async () => {
    const v = await view(), entry = v.rows[0];
    const legacy = { ...v.unit.policy, seniorGrades: ['21'] }; delete legacy.seniorMembershipMode;
    await owner.db.update(schema.rewardUnit).set({ policy: legacy }).where(eq(schema.rewardUnit.id, unitId));
    await owner.db.update(schema.rewardEntry).set({ source: { ...entry.source, grade: '21' } }).where(eq(schema.rewardEntry.id, entry.id));
    await expect(saveRewardPolicy(admin, unitId, v.unit.revision, { ...legacy, seniorMembershipMode: 'named-members' })).rejects.toThrow(/Preview and confirm/);
    await expect(previewRewardSeniorMembership(admin, unitId, v.unit.revision, { employmentIds: [], adoptLegacy: false })).rejects.toThrow(/Confirm conversion/);
    const userId = await createAppUser(b.tenantId, entry.source.personId, 'employee');
    await setRewardMember(admin, unitId, v.unit.revision, userId, 'gr');
    const own = { ...admin, userId, personId: entry.source.personId, roles: ['employee'] as SessionContext['roles'], grants: undefined };
    const state = await getRewardSeniorMembership(own, unitId);
    expect(state.rows).toEqual([]);
    await expect(previewRewardSeniorMembership(own, unitId, state.revision, { employmentIds: [employmentId], adoptLegacy: true })).rejects.toThrow(/visible review roster/);
    const selection = { employmentIds: [], adoptLegacy: true };
    const preview = await previewRewardSeniorMembership(own, unitId, state.revision, selection);
    expect(preview.rows).toEqual([]);
    await saveRewardSeniorMembership(own, unitId, state.revision, selection, preview.digest);
    const after = await view();
    expect(after.rows[0].facts.seniorPlan).toBe(true);
    expect(after.rows[0].bonusEligible).toBe(false);
    expect(after.rows[0].facts.reviewed).toBe(entry.facts.reviewed);
  });
  it('refuses BU-only and revoked Group Rewards membership even when a preview was obtained earlier', async () => {
    const v = await view();
    await expect(getRewardSeniorMembership(actors.bu!, unitId)).rejects.toThrow(/Group Rewards/);
    await expect(previewRewardSeniorMembership(actors.bu!, unitId, v.unit.revision, { employmentIds: [], adoptLegacy: false })).rejects.toThrow(/Group Rewards/);
    const userId = actors.bu!.userId!;
    await setRewardMember(admin, unitId, v.unit.revision, userId, 'gr');
    const state = await getRewardSeniorMembership(actors.bu!, unitId);
    const selection = { employmentIds: [employmentId], adoptLegacy: false };
    const preview = await previewRewardSeniorMembership(actors.bu!, unitId, state.revision, selection);
    await setRewardMember(admin, unitId, state.revision, userId, 'gr', true);
    await expect(saveRewardSeniorMembership(actors.bu!, unitId, state.revision, selection, preview.digest)).rejects.toThrow();
    expect((await view()).rows[0].facts.seniorPlan).toBe(false);
  });

  it('snapshots real employment and compensation and rejects stale forms', async () => {
    const v = await view(); expect(v.rows[0].source.employmentId).toBe(employmentId); expect(v.rows[0].newBasicCents).toBe(522500);
    await saveRewardEntry(admin, unitId, v.unit.revision, v.rows[0].id, v.rows[0].recommendation);
    await expect(saveRewardEntry(admin, unitId, v.unit.revision, v.rows[0].id, v.rows[0].recommendation)).rejects.toThrow(/another session/);
  });
  it('lets a fresh company administrator configure participants without disclosing a salary roster or granting policy ownership', async () => {
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Configuration administrator', primaryEmail: 'admin@rewards.test' }).returning();
    const userId = await createAppUser(b.tenantId, adminPerson.id, 'hr_admin');
    const otherAdmin = { ...admin, userId, personId: adminPerson.id, roles: ['hr_admin'] as SessionContext['roles'], grants: undefined };
    await expect(getRewardUnit(otherAdmin, unitId)).rejects.toThrow(/assign your/);
    await expect(getRewardSeniorMembership(otherAdmin, unitId)).rejects.toThrow(/assign your/);
    const config = await getRewardConfiguration(otherAdmin, unitId);
    expect(config.canManageMembers).toBe(true);
    expect(config.canConfigure).toBe(false);
    expect(config).not.toHaveProperty('rows');
    expect(JSON.stringify(config)).not.toContain('Reward Employee');
    expect(JSON.stringify(config)).not.toContain(employmentId);
    await expect(saveRewardPolicy(otherAdmin, unitId, config.unit.revision, config.unit.policy)).rejects.toThrow();
    await setRewardMember(otherAdmin, unitId, config.unit.revision, actors.bu!.userId!, 'pbp');
    const fresh = await getRewardConfiguration(otherAdmin, unitId);
    expect(fresh.members.some(m => m.userId === actors.bu!.userId && m.role === 'pbp')).toBe(true);
    await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, userId));
    await expect(getRewardConfiguration(otherAdmin, unitId)).rejects.toThrow();
  });
  it('preserves delegated Group Rewards policy access and refuses other reviewers or a disabled module', async () => {
    await expect(getRewardConfiguration(actors.pbp!, unitId)).rejects.toThrow(/configuration requires/);
    await setRewardMember(admin, unitId, (await view()).unit.revision, actors.pbp!.userId!, 'gr');
    const config = await getRewardConfiguration(actors.pbp!, unitId);
    expect(config.canConfigure).toBe(true); expect(config.canManageMembers).toBe(false);
    await saveRewardPolicy(actors.pbp!, unitId, config.unit.revision, { ...config.unit.policy, lumpShareBp: 5000 });
    expect((await getRewardConfiguration(actors.pbp!, unitId)).unit.policy.lumpShareBp).toBe(5000);
    await approve();
    const locked = await getRewardConfiguration(actors.pbp!, unitId);
    expect(locked.canConfigure).toBe(false); expect(locked.canManageMembers).toBe(false);
    await expect(saveRewardPolicy(actors.pbp!, unitId, locked.unit.revision, config.unit.policy)).rejects.toThrow(/Return/);
    await setModule(b.tenantId, 'rewards', 'disabled');
    const disabled = await entitledCtx(b);
    await expect(getRewardConfiguration(disabled, unitId)).rejects.toThrow();
  });
  it('enforces tenant, live membership, module and read-only boundaries', async () => {
    const v = await view();
    await expect(saveRewardEntry(actors.pbp!, unitId, v.unit.revision, v.rows[0].id, v.rows[0].recommendation)).rejects.toThrow(/cannot edit|not found/);
    await setRewardMember(admin, unitId, v.unit.revision, actors.bu!.userId!, 'bu', true);
    await expect(getRewardUnit(actors.bu!, unitId)).rejects.toThrow(/not found|removed/);
    expect(await withTenant(actors.bu!, tx => tx.select().from(schema.rewardEntry))).toEqual([]);
    const other = await seedBase(); await setModule(other.tenantId, 'rewards', 'active');
    await expect(getRewardUnit(await entitledCtx(other), unitId)).rejects.toThrow(/not found|removed/);
    await setModule(b.tenantId, 'rewards', null);
    await expect(getRewardUnit(await entitledCtx(b), unitId)).rejects.toThrow();
  });
  it('revokes archived reviewer access even with an existing session and refuses an incomplete route', async () => {
    const ctx = actors.bg!;
    expect((await getRewardUnit(ctx, unitId)).rows).toHaveLength(1);
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, ctx.userId!));
    await expect(getRewardUnit(ctx, unitId)).rejects.toThrow();
    expect(await withTenant(ctx, tx => tx.select().from(schema.rewardEntry))).toEqual([]);
    await expect(decideRewardUnit(actors.bu!, unitId, (await view()).unit.revision, 'submit', 'Reviewed recommendations')).rejects.toThrow(/Assign every approval role/);
  });
  it('delivers current-stage notifications from the userless overnight dispatcher without pay details', async () => {
    await setModule(b.tenantId, 'notifications', 'active');
    const employee = await hireEmployee(admin, { person: { fullName: 'BG Reviewer', primaryEmail: 'bg.employee@rewards.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    await owner.db.update(schema.appUser).set({ personId: employee.personId }).where(eq(schema.appUser.id, actors.bg!.userId!));
    const rev = (await view()).unit.revision;
    await decideRewardUnit(actors.bu!, unitId, rev, 'submit', 'Reviewed recommendations');
    const enabled = await entitledCtx(b);
    const system: SessionContext = { tenantId: b.tenantId, roles: ['hr_admin'], entitlements: enabled.entitlements };
    await dispatchNotificationsFromSweep(system,owner);
    const notices = await owner.db.select().from(schema.notification).where(eq(schema.notification.kind, 'rewards.review'));
    expect(notices).toHaveLength(1);
    expect(notices[0].recipientEmploymentId).toBe(employee.employmentId);
    expect(notices[0].linkPath).toBe(`/rewards/${unitId}?view=approvals`);
    expect(notices[0].body).not.toMatch(/5000|5225|10055/);
    expect((await dispatchNotificationsFromSweep(system,owner)).created).toBe(0);
    expect(await withTenant(actors.bu!, tx => rewardNotificationRecipients(tx, unitId, 'bg'))).toEqual([]);
    expect(await withTenant(system, tx => rewardNotificationRecipients(tx, unitId, 'ctro'))).toEqual([]);
  });
  it('allows BU case decisions but refuses a classification or rating change', async () => {
    const v = await getRewardUnit(actors.bu!, unitId), e = v.rows[0];
    await saveRewardEntry(actors.bu!, unitId, v.unit.revision, e.id, e.recommendation, { ...e.facts, erDecision: 'in', caseReason: 'Reviewed with the people business partner' });
    const fresh = await getRewardUnit(actors.bu!, unitId);
    expect(fresh.rows[0].facts.erDecision).toBe('in');
    await expect(saveRewardEntry(actors.bu!, unitId, fresh.unit.revision, e.id, e.recommendation, { ...fresh.rows[0].facts, confidentiality: 'ec' })).rejects.toThrow(/Only Group Rewards/);
  });
  it('does not serialize own-person or EC reward rows to unauthorized viewers', async () => {
    const v = await view(), row = v.rows[0];
    await saveRewardEntry(admin, unitId, v.unit.revision, row.id, row.recommendation, { ...row.facts, confidentiality: 'ec' });
    await saveRewardEntry(admin, unitId, (await view()).unit.revision, row.id, { ...row.recommendation, bonusCents: 987654321 });
    const bu = await getRewardUnit(actors.bu!, unitId);
    expect(bu.rows).toEqual([]); expect(bu.ec).toBeNull(); expect(JSON.stringify(bu)).not.toContain('987654321');
    // Give the employee a genuine review role; self exclusion still wins.
    const userId = await createAppUser(b.tenantId, row.source.personId, 'employee');
    await setRewardMember(admin, unitId, (await view()).unit.revision, userId, 'gr');
    const self = await getRewardUnit({ ...actors.bu!, userId, personId: row.source.personId }, unitId);
    expect(self.rows).toEqual([]); expect(self.ec?.count).toBe(0);
    await expect(saveRewardEntry({ ...actors.bu!, userId, personId: row.source.personId }, unitId, self.unit.revision, row.id, row.recommendation)).rejects.toThrow(/not available/);
  });
  it('counts the complete authorized bonus cohort and withholds counts for a partial confidential roster', async () => {
    const v = await view(), row = v.rows[0];
    expect(v.bonusCounts.standard).toEqual({eligible:1,increases:0,reductions:0,lump:0});
    await saveRewardEntry(admin, unitId, v.unit.revision, row.id, row.recommendation, {...row.facts,confidentiality:'bg'});
    const restricted = await getRewardUnit(actors.bu!, unitId);
    expect(restricted.rows).toEqual([]); expect(restricted.bonusCounts.standard).toBeNull();
    expect((await getRewardUnit(actors.bg!, unitId)).bonusCounts.standard?.eligible).toBe(1);
  });
  it('checks approval order, freezes submitted inputs and can reopen an unposted approval', async () => {
    const v = await view();
    await expect(decideRewardUnit(actors.ec!, unitId, v.unit.revision, 'approve', 'Approved')).rejects.toThrow(/current approval stage/);
    const rev = await approve();
    await expect(saveRewardEntry(admin, unitId, rev, v.rows[0].id, v.rows[0].recommendation)).rejects.toThrow(/Return/);
    expect(await decideRewardUnit(admin, unitId, rev, 'return', 'Source salary needs refreshing')).toBe('draft');
    expect((await view()).unit.revision).toBe(rev + 1);
  });
  it('posts exactly once, adds awards to existing payroll and preserves unrelated inputs', async () => {
    const rev = await approve();
    const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await setPayrollInput(admin, { batchId: batch.batchId, employmentId, overtimeAmount: 123, bonusAmount: 80, tp1Deduction: 44, zakat: 9 });
    const results = await Promise.all([postRewardUnit(admin, unitId, rev, batch.batchId), postRewardUnit(admin, unitId, rev, batch.batchId)]);
    expect(results.map(r => r.alreadyPosted).sort()).toEqual([false, true]);
    const [comp] = await owner.db.select().from(schema.compensation).where(and(eq(schema.compensation.employmentId, employmentId), isNull(schema.compensation.validTo)));
    expect(Number(comp.basicSalary)).toBe(5225);
    const [input] = await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batch.batchId));
    expect(Number(input.bonusAmount)).toBe(10055); expect(Number(input.overtimeAmount)).toBe(123); expect(Number(input.tp1Deduction)).toBe(44); expect(Number(input.zakat)).toBe(9);
    expect((await view()).unit.status).toBe('posted');
  });
  it('a changed salary rejects posting without writing any award', async () => {
    const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await setCompensation(admin, { employmentId, basicSalary: 5500, effectiveFrom: `${year - 1}-01-01` });
    await expect(postRewardUnit(admin, unitId, rev, batch.batchId)).rejects.toThrow(/Salary data changed/);
    expect(await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batch.batchId))).toEqual([]);
    expect((await view()).unit.status).toBe('approved');
  });
  it('rolls back earlier employee writes when a later salary is stale', async () => {
    const initial = (await view()).rows[0];
    const hire = await hireEmployee(admin, { person: { fullName: 'Second Reward Employee', primaryEmail: 'second@rewards.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    await owner.db.update(schema.employment).set({ gradeId: initial.source.gradeId }).where(eq(schema.employment.id, hire.employmentId));
    const comp = await setCompensation(admin, { employmentId: hire.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    const [employee] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, hire.employmentId));
    await owner.db.insert(schema.rewardEntry).values({ tenantId: b.tenantId, unitId, employmentId: hire.employmentId, source: { ...initial.source, employmentId: hire.employmentId, personId: employee.personId, compensationId: comp.compensationId }, facts: initial.facts, recommendation: initial.recommendation });
    const ordered = [employmentId, hire.employmentId].sort((a, b) => a.localeCompare(b));
    const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await setCompensation(admin, { employmentId: ordered[1], basicSalary: 5500, effectiveFrom: `${year - 1}-01-01` });
    await expect(postRewardUnit(admin, unitId, rev, batch.batchId)).rejects.toThrow(/Salary data changed/);
    const [unchanged] = await owner.db.select().from(schema.compensation).where(and(eq(schema.compensation.employmentId, ordered[0]), isNull(schema.compensation.validTo)));
    expect(Number(unchanged.basicSalary)).toBe(5000);
    expect(await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batch.batchId))).toEqual([]);
    expect((await view()).unit.status).toBe('approved');
  });
  it('posts an approved off-cycle increase once and retains its funding consumption', async () => {
    const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await postRewardUnit(admin, unitId, rev, batch.batchId);
    const parent = await view();
    const childId = await createOffcycleReview(actors.bu!, unitId, { kind: 'adhoc', entryIds: [parent.rows[0].id], effectiveFrom: `${year + 1}-02-01`, exceptionReason: '' });
    let child = await getRewardUnit(actors.bu!, childId);
    await saveRewardEntry(actors.bu!, childId, child.unit.revision, child.rows[0].id, { ...child.rows[0].recommendation, meritBp: 100, reason: 'Expanded responsibilities' });
    child = await getRewardUnit(actors.bu!, childId);
    await decideRewardUnit(actors.bu!, childId, child.unit.revision, 'submit', 'Reviewed recommendations');
    for (const role of ['bg', 'gr', 'ctro'] as const) await decideRewardUnit(actors[role]!, childId, child.unit.revision, 'approve', 'Reviewed recommendations');
    expect(await postRewardUnit(admin, childId, child.unit.revision)).toEqual({ alreadyPosted: false });
    expect(await postRewardUnit(admin, childId, child.unit.revision)).toEqual({ alreadyPosted: true });
    const [salary] = await owner.db.select().from(schema.compensation).where(and(eq(schema.compensation.employmentId, employmentId), isNull(schema.compensation.validTo)));
    expect(Number(salary.basicSalary)).toBe(5277);
    const nextId = await createOffcycleReview(actors.bu!, unitId, { kind: 'adhoc', entryIds: [parent.rows[0].id], effectiveFrom: `${year + 1}-03-01`, exceptionReason: '' });
    expect((await getRewardUnit(actors.bu!, nextId)).budgets.standard.pools[0]).toBe(7300);
  });
  it('reserves annual remainder atomically and rejects a concurrent duplicate employee request', async () => {
    const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await postRewardUnit(admin, unitId, rev, batch.batchId);
    const parent = await view();
    expect(parent.unit.fundingCents.standard).toBe(12500);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = await createOffcycleReview(actors.bu!, unitId, { kind: 'adhoc', entryIds: [parent.rows[0].id], effectiveFrom: `${year + 1}-02-01`, exceptionReason: '' });
      const v = await getRewardUnit(actors.bu!, id);
      await saveRewardEntry(actors.bu!, id, v.unit.revision, v.rows[0].id, { ...v.rows[0].recommendation, meritBp: 100, reason: 'Expanded responsibilities' });
      ids.push(id);
    }
    const results = await Promise.allSettled(ids.map(async id => decideRewardUnit(actors.bu!, id, (await getRewardUnit(actors.bu!, id)).unit.revision, 'submit', 'Reviewed off-cycle request')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const accepted = ids[results.findIndex(r => r.status === 'fulfilled')];
    let v = await getRewardUnit(actors.bg!, accepted);
    expect(v.unit.reservedCents.standard).toBe(5200);
    await decideRewardUnit(actors.bg!, accepted, v.unit.revision, 'return', 'Please revise the business case');
    const other = ids.find(id => id !== accepted)!;
    v = await getRewardUnit(actors.bu!, other);
    expect(await decideRewardUnit(actors.bu!, other, v.unit.revision, 'submit', 'Revised and ready for approval')).toBe('bg');
  });

  // WP-F (RW-131): Returned is derived from the latest decision, never a stored stage.
  describe('derived Returned state', () => {
    const submit = async (who: RewardRole = 'bu', id = unitId) => decideRewardUnit(actors[who]!, id, (await getRewardUnit(actors[who]!, id)).unit.revision, 'submit', 'Reviewed recommendations');
    const giveEmployment = async (role: RewardRole, name: string) => {
      const hire = await hireEmployee(admin, { person: { fullName: name, primaryEmail: `${role}.employment@rewards.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
      await owner.db.update(schema.appUser).set({ personId: hire.personId }).where(eq(schema.appUser.id, actors[role]!.userId!));
      actors[role] = { ...actors[role]!, personId: hire.personId };
      return hire;
    };
    it('shows a BG return to the BU CEO and the BG reviewer with reason, actor and date; resubmission clears it', async () => {
      const before = Date.now();
      expect(await submit()).toBe('bg');
      const rev = (await getRewardUnit(actors.bg!, unitId)).unit.revision;
      expect(await decideRewardUnit(actors.bg!, unitId, rev, 'return', 'Merit for the sales team needs a rethink')).toBe('draft');
      for (const who of ['bu', 'bg'] as const) {
        const v = await getRewardUnit(actors[who]!, unitId);
        expect(v.unit.status).toBe('draft');
        expect(v.returned).toMatchObject({ toSeat: 'bu', fromStage: 'bg', reason: 'Merit for the sales team needs a rethink', actorRole: 'bg' });
        expect(Date.parse(v.returned!.at)).toBeGreaterThanOrEqual(before - 5000);
        // The actor's name is joined under person RLS; with none readable the role still identifies the seat.
        expect(v.returned!.actorName ?? v.returned!.actorRole).toBeTruthy();
      }
      const history = (await view()).decisions;
      expect(history.map(d => d.action)).toEqual(['return', 'submit']);
      expect(history.map(d => d.actorName)).toEqual(['bg reviewer', 'bu reviewer']);
      expect(history.map(d => d.actorRole)).toEqual(['bg', 'bu']);
      expect((await listRewardUnits(actors.bu!, [b.companyId])).find(u => u.id === unitId)?.returnedTo).toBe('bu');
      expect(await submit()).toBe('bg');
      expect((await getRewardUnit(actors.bu!, unitId)).returned).toBeNull();
      expect((await listRewardUnits(actors.bu!, [b.companyId])).find(u => u.id === unitId)?.returnedTo).toBeNull();
      expect(await returnedRewardUnits(actors.bu!)).toEqual([]);
    });
    it('treats a return from approved as Returned and the latest of two returns wins', async () => {
      const rev = await approve();
      expect(await decideRewardUnit(admin, unitId, rev, 'return', 'Source salary needs refreshing')).toBe('draft');
      expect((await getRewardUnit(actors.bu!, unitId)).returned).toMatchObject({ fromStage: 'approved', toSeat: 'bu', reason: 'Source salary needs refreshing', actorRole: 'gr' });
      await submit();
      await decideRewardUnit(actors.bg!, unitId, (await view()).unit.revision, 'return', 'Second return supersedes the first');
      const v = await getRewardUnit(actors.bu!, unitId);
      expect(v.returned).toMatchObject({ fromStage: 'bg', reason: 'Second return supersedes the first' });
      // Newest first by (created_at DESC, id DESC); the projection reads that ordering, not insertion position.
      const times = v.decisions.map(d => new Date(d.createdAt).getTime());
      expect(times).toEqual([...times].sort((x, y) => y - x));
      expect(v.decisions.filter(d => d.action === 'return').map(d => d.reason)).toEqual(['Second return supersedes the first', 'Source salary needs refreshing']);
    });
    it('lists returned units only for the seat that must act, never for PBP or Group Rewards', async () => {
      await submit();
      await decideRewardUnit(actors.bg!, unitId, (await view()).unit.revision, 'return', 'Merit for the sales team needs a rethink');
      const mine = await returnedRewardUnits(actors.bu!);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ id: unitId, toSeat: 'bu', reason: 'Merit for the sales team needs a rethink', kind: 'annual' });
      expect(Object.keys(mine[0]).sort()).toEqual(['actorName', 'cycle', 'id', 'kind', 'name', 'reason', 'returnedAt', 'toSeat']);
      expect(await returnedRewardUnits(actors.bu!, [b.companyId])).toHaveLength(1);
      expect(await returnedRewardUnits(actors.bu!, [])).toEqual([]);
      for (const who of ['pbp', 'gr', 'bg'] as const) expect(await returnedRewardUnits(actors[who]!)).toEqual([]);
    });
    it('routes a returned BG-originated off-cycle request back to the BG seat', async () => {
      const v0 = await view();
      await saveRewardEntry(admin, unitId, v0.unit.revision, v0.rows[0].id, v0.rows[0].recommendation, { ...v0.rows[0].facts, confidentiality: 'bg' });
      const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
      await postRewardUnit(admin, unitId, rev, batch.batchId);
      const parent = await getRewardUnit(actors.bg!, unitId);
      const childId = await createOffcycleReview(actors.bg!, unitId, { kind: 'adhoc', entryIds: [parent.rows[0].id], effectiveFrom: `${year + 1}-02-01`, exceptionReason: '' });
      let child = await getRewardUnit(actors.bg!, childId);
      expect(child.unit.offcycle?.bgOrigin).toBe(true);
      await saveRewardEntry(actors.bg!, childId, child.unit.revision, child.rows[0].id, { ...child.rows[0].recommendation, meritBp: 100, reason: 'Expanded responsibilities' });
      child = await getRewardUnit(actors.bg!, childId);
      expect(await decideRewardUnit(actors.bg!, childId, child.unit.revision, 'submit', 'Reviewed off-cycle request')).toBe('gr');
      await decideRewardUnit(admin, childId, child.unit.revision, 'return', 'Business case needs a comparator');
      expect((await getRewardUnit(actors.bg!, childId)).returned).toMatchObject({ toSeat: 'bg', fromStage: 'gr', actorRole: 'gr' });
      expect((await listRewardUnits(actors.bg!, [b.companyId])).find(u => u.id === childId)?.returnedTo).toBe('bg');
      expect((await returnedRewardUnits(actors.bg!)).map(u => [u.id, u.toSeat])).toEqual([[childId, 'bg']]);
      expect((await returnedRewardUnits(actors.bu!)).map(u => u.id)).not.toContain(childId);
    });
    it('notifies the BU CEO that the review was returned, without amount or reason', async () => {
      await setModule(b.tenantId, 'notifications', 'active');
      const buEmployment = await giveEmployment('bu', 'BU Reviewer');
      await submit();
      await decideRewardUnit(actors.bg!, unitId, (await view()).unit.revision, 'return', 'Merit for the sales team needs a rethink');
      const enabled = await entitledCtx(b);
      await dispatchNotificationsFromSweep({ tenantId: b.tenantId, roles: ['hr_admin'], entitlements: enabled.entitlements }, owner);
      const notices = await owner.db.select().from(schema.notification).where(and(eq(schema.notification.kind, 'rewards.review'), eq(schema.notification.recipientEmploymentId, buEmployment.employmentId)));
      expect(notices).toHaveLength(1);
      expect(notices[0].title).toBe('Rewards review returned to you');
      expect(notices[0].linkPath).toBe(`/rewards/${unitId}?view=approvals`);
      expect(`${notices[0].title} ${notices[0].body}`).not.toMatch(/sales team|rethink|5000|5225|RM/);
      const events = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, unitId), eq(schema.domainEvent.eventType, 'reward-unit.routed')));
      const returnedEvent = events.find(e => (e.payload as { to?: string }).to === 'draft');
      expect(Object.keys(returnedEvent!.payload as object).sort()).toEqual(['from', 'revision', 'to']);
    });
    it('renders return and forward routing copy distinctly', () => {
      const ev = { aggregateId: unitId, subjectEmploymentId: null };
      expect(renderRewardRouted({ from: 'bg', to: 'draft', revision: 1 }, ev).title).toBe('Rewards review returned to you');
      expect(renderRewardRouted({ from: 'approved', to: 'draft', revision: 1 }, ev).title).toBe('Rewards review returned to you');
      expect(renderRewardRouted({ from: 'draft', to: 'bg', revision: 1 }, ev).title).toBe('Rewards review needs attention');
      expect(renderRewardRouted({ from: 'bg', to: 'gr', revision: 1 }, ev).title).toBe('Rewards review needs attention');
      expect(renderRewardRouted(null, ev).title).toBe('Rewards review needs attention');
      const returned = renderRewardRouted({ from: 'bg', to: 'draft', revision: 1 }, ev);
      expect(Object.keys(returned).sort()).toEqual(['body', 'linkPath', 'severity', 'title']);
    });
    it('derives Returned only from a return that is the latest decision on a draft', () => {
      const at = new Date();
      const ret = { action: 'return', fromStage: 'bg', toStage: 'draft', reason: 'Needs a rethink', actorId: unitId, createdAt: at };
      expect(returnedState('draft', ret, false)).toMatchObject({ toSeat: 'bu', reason: 'Needs a rethink' });
      expect(returnedState('draft', ret, true)?.toSeat).toBe('bg');
      expect(returnedState('bg', ret, false)).toBeNull();
      expect(returnedState('draft', { ...ret, action: 'submit', toStage: 'bg' }, false)).toBeNull();
      expect(returnedState('draft', null, false)).toBeNull();
    });
  });

});
