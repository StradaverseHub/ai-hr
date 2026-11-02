import {pgErrorChain} from '../lib/db-error';
import {configureRewardFixture,refreshRewardFixtureBudget,changeRewardFixtureInputs} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, setPayrollInput } from '../packs/payroll/service';
import { returnedRewardUnits, getRewardSeniorMembership, previewRewardSeniorMembership, saveRewardSeniorMembership, getRewardConfiguration, listRewardUnits, pendingRewardReviews, rewardSetupChoices, rewardNotificationRecipients, createOffcycleReview, createRewardUnit, getRewardUnit, saveRewardEntry, saveRewardPolicy, decideRewardUnit, postRewardUnit, canPostRewardUnit, rewardPayrollChoices, prepareReviewedRewardPostTx, postReviewedRewardUnitTx } from '../packs/rewards/service';
import { emptyFacts,emptyRecommendation,visibleEntry,isSeniorPlanMember, returnedState, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { dispatchNotificationsFromSweep, renderRewardRouted } from '../core/notifications';
import { todayInKualaLumpur } from '../lib/hr-date';
import { lockLeaveDependenciesTx } from '../core/leave-dependency-lock';
import {createHash} from 'node:crypto';
import {pgErrorChain} from '../lib/db-error';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {resolveEntitlementsTx} from '../core/entitlements';
import {calculateRewards} from '../packs/rewards/engine';
import {calculateOffcycle,offcycleRoute} from '../packs/rewards/offcycle';
import {emptyGovernance,effectiveRewardPolicy,confirmedSeniorAwards,governanceBasis,maySeeSeniorAmounts} from '../packs/rewards/governance-model';

const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
/** Independent native oracle reads fixture-owned stored facts; production cannot call it. */
async function calculationOracle(actor:SessionContext,id:string){
 const [unit]=await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,id)),entries=await owner.db.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,id)).orderBy(schema.rewardEntry.id);
 const roleRows=await withTenant(actor,tx=>tx.execute<{role:RewardRole}>(sql`select app.reward_roles(${id}::uuid)as role`)),roles=roleRows.map(row=>row.role);
 const [privateState]=roles.includes('gr')?await owner.db.select().from(schema.rewardGovernance).where(eq(schema.rewardGovernance.unitId,id)):[],[publicState]=await owner.db.select().from(schema.rewardGovernancePublic).where(eq(schema.rewardGovernancePublic.unitId,id));
 const state=privateState?.state??null,pub=publicState?.snapshot??null,awardRows=maySeeSeniorAmounts(roles)?await owner.db.select().from(schema.rewardSeniorAward).where(eq(schema.rewardSeniorAward.unitId,id)):[];
 const policy=state?effectiveRewardPolicy(unit.policy,state):pub?{...unit.policy,patActual:0,patTarget:100,targetMonthsBp:pub.targetMonthsBp,multiplierBp:pub.multiplierBp,branchRatings:pub.branchRatings,exemptReason:''}:unit.policy;
 const [funding]=unit.kind==='annual'?[]:await withTenant(actor,tx=>tx.execute<{value:{standard:number;h:number;duplicate:boolean}}>(sql`select app.reward_funding(${id}::uuid,false)as value`));
 const calculated=unit.kind==='annual'?calculateRewards(entries,policy,{poolStatus:pub?.status??'legacy',...(pub?{bonusPools:pub.pools}:{}),seniorAwards:confirmedSeniorAwards({...(state??emptyGovernance()),awards:Object.fromEntries(awardRows.map(row=>[row.entryId,row.award]))},entries)}):calculateOffcycle(entries,unit.policy,unit.kind,unit.offcycle!,funding.value);
 if(unit.kind==='annual'&&pub&&pub.basis!==governanceBasis(unit.policy,entries))calculated.flags.push({severity:'block',code:'PAT-STALE',message:'Eligibility or employee source facts changed. Group Rewards must review and refresh the unit budget inputs.'});
 if(funding?.value.duplicate)calculated.flags.push({severity:'block',code:'OC-12',message:'An employee already has an open off-cycle request against this annual review.'});
 const visible=calculated.rows.filter(row=>visibleEntry(row,roles,actor.personId)).map(row=>maySeeSeniorAmounts(roles)||!isSeniorPlanMember(unit.policy,row.facts,row.source.grade)?row:{...row,recommendation:emptyRecommendation(),newBasicCents:row.source.basicCents,bonusCents:0,meritCents:0,promotionCents:0,specialCents:0,lumpCents:0});
 const ids=new Set(visible.map(row=>row.id)),flags=calculated.flags.filter(flag=>!flag.entryId||ids.has(flag.entryId));
 if(calculated.flags.some(flag=>flag.entryId&&!ids.has(flag.entryId)&&flag.severity==='block'))flags.push({severity:'block',code:'ACCESS-01',message:'A restricted record needs review by its authorised reviewer.'});
 const count=(plan:'standard'|'h')=>{const group=calculated.rows.filter(row=>row.plan===plan&&!isSeniorPlanMember(unit.policy,row.facts,row.source.grade));return group.some(row=>!ids.has(row.id))?null:{eligible:group.filter(row=>row.bonusEligible).length,increases:group.filter(row=>row.bonusCents>row.standardBonusCents).length,reductions:group.filter(row=>row.bonusCents<row.standardBonusCents).length,lump:group.filter(row=>row.lumpCents>0).length};};
 const window=(plan:'standard'|'h')=>calculated.rows.some(row=>row.plan===plan&&!ids.has(row.id))?null:{count:calculated.budgets[plan].excludedCount,payrollCents:calculated.budgets[plan].excludedPayrollCents};
 return{...calculated,unit,rows:visible,flags,budgets:{standard:calculated.budgets.standard,h:calculated.budgets.h},poolStatus:pub?.status??'legacy',suggestion:roles.includes('gr')&&'suggestion'in calculated?calculated.suggestion:null,hiddenCount:entries.length-visible.length,route:unit.kind==='annual'?['bu','bg','gr','ctro','ec']:offcycleRoute(unit.kind,unit.offcycle!,entries),bonusCounts:{standard:count('standard'),h:count('h')},payWindow:{standard:window('standard'),h:window('h')}};
}

describe('Rewards persistence, authorization and atomic enactment', () => {
  let b: Base, admin: SessionContext, unitId: string, employmentId: string;
  const actors: Partial<Record<RewardRole, SessionContext>> = {};
  const view = () => getRewardUnit(admin, unitId);
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    // New grants select an existing readable person-backed account; only the BU seat also needs current People/BU scope.
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
    await configureRewardFixture(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, targetMonthsBp: 20000, ranges: { '12': [300000, 500000, 700000] } });
    const v2 = await view();
    await saveRewardEntry(admin, unitId, v2.unit.revision, v2.rows[0].id, v2.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
    await refreshRewardFixtureBudget(admin,unitId);
  });
  afterAll(closeAll);
  async function approve() {
    await refreshRewardFixtureBudget(admin,unitId);
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
    const original=await view();await owner.db.update(schema.rewardEntry).set({source:{...original.rows[0].source,grade:'21'}}).where(eq(schema.rewardEntry.id,original.rows[0].id));
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
    expect(before.rows[0].incrementEligible).toBe(true);expect(after.rows[0].incrementEligible).toBe(false);
    expect(after.rows[0].recommendation).toEqual(before.rows[0].recommendation);
    expect(after.rows[0].source).toEqual(before.rows[0].source);
    expect(after.rows[0].facts.reviewed).toBe(false);
    const deselect = { employmentIds: [], adoptLegacy: false };
    const next = await previewRewardSeniorMembership(admin, unitId, after.unit.revision, deselect);
    await saveRewardSeniorMembership(admin, unitId, after.unit.revision, deselect, next.digest);
    expect((await getRewardSeniorMembership(admin, unitId)).rows[0].member).toBe(false);
  });
  it('refuses duplicate, unavailable, stale and altered-preview selections with no writes', async () => {
    const original=await view();await owner.db.update(schema.rewardEntry).set({source:{...original.rows[0].source,grade:'21'}}).where(eq(schema.rewardEntry.id,original.rows[0].id));
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
    const original=await view();await owner.db.update(schema.rewardEntry).set({source:{...original.rows[0].source,grade:'21'}}).where(eq(schema.rewardEntry.id,original.rows[0].id));
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
    // cd72f915: the last active BU CEO cannot be removed, so a second holder keeps the seat covered.
    await setRewardMember(admin, unitId, v.unit.revision, actors.ctro!.userId!, 'bu');
    await setRewardMember(admin, unitId, (await view()).unit.revision, actors.bu!.userId!, 'bu', true);
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
    await expect(decideRewardUnit(actors.bu!, unitId, (await view()).unit.revision, 'submit', 'Reviewed recommendations')).rejects.toThrow(/Assign every approval role.*Missing: BG CEO \/ authorised proxy\.$/);
    // cd72f915: every missing seat is named, in route order, payroll handoff included.
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, actors.ctro!.userId!));
    await owner.db.delete(schema.rewardMember).where(and(eq(schema.rewardMember.unitId, unitId), eq(schema.rewardMember.role, 'payroll')));
    await expect(decideRewardUnit(actors.bu!, unitId, (await view()).unit.revision, 'submit', 'Reviewed recommendations')).rejects.toThrow('Missing: BG CEO / authorised proxy, CTRO, Payroll handoff.');
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
  it('reads native payroll choices and posting-offer authority without any raw employee pay read',async()=>{
    const batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)});
    // A restrictive read trap proves absence of a raw invoker read, rather than letting load()
    // silently return an empty roster. It adds no role, grant, bypass or private execution lease.
    await owner.db.execute(sql`create policy rewards_metadata_forbid_raw on reward_entry as restrictive for select to ai_hr_app using(length(id::text)/0>0)`);
    try{
      let refusal:unknown;try{await withTenant(admin,tx=>tx.select({id:schema.rewardEntry.id}).from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,unitId)));}catch(error){refusal=error;}
      expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'22012',message:'division by zero'}));
      expect(await canPostRewardUnit(admin,unitId)).toBe(true);expect(await rewardPayrollChoices(admin,unitId)).toEqual([{id:batch.batchId,period:today.slice(0,7)}]);
      expect(await canPostRewardUnit(actors.bu!,unitId)).toBe(false);expect(await rewardPayrollChoices(actors.bu!,unitId)).toEqual([]);
    }finally{await owner.db.execute(sql`drop policy rewards_metadata_forbid_raw on reward_entry`);}
    expect((await view()).unit.status).toBe('draft');
  });
  it('observes the original app native prepare and enact under pre-existing immediate constraints',async()=>{
    // Uses the original exported native transaction owners and their real app ACL, with no
    // private posting constructor, new grants, bridge, policy, flag or source replacement.
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)}),selection={unitId,revision,batchId:batch.batchId};
    const baseline=await withTenant(admin,tx=>prepareReviewedRewardPostTx(tx,admin,selection));expect(baseline.reviewedDigest).toMatch(/^[a-f0-9]{64}$/);let prepared=false;
    const receipt=await withTenant(admin,async tx=>{
      await tx.execute(sql`set constraints all immediate`);const original=await prepareReviewedRewardPostTx(tx,admin,selection);prepared=true;
      return postReviewedRewardUnitTx(tx,admin,selection,original.reviewedDigest);
    });
    expect(prepared).toBe(true);expect(receipt).toMatchObject({unitId,currentStatus:'posted',postedRevision:revision});expect((await view()).unit.status).toBe('posted');
  });
  it('owns the leave graph interval before reward funding/source/grade and payroll effects', async () => {
    const rev=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)});
    const state=async()=>({unit:await view(),employees:await owner.db.select().from(schema.employment),compensation:await owner.db.select().from(schema.compensation),inputs:await owner.db.select().from(schema.payrollInput),events:await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id)});
    const before=await state();let ready!:()=>void,fail!:(error:unknown)=>void,release!:()=>void;
    const started=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
    const timer=setTimeout(()=>{fail(new Error('owned reward interval handshake timed out'));release();},10000);
    const holder=withTenant(admin,async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[employmentId]);ready();await finish;});void holder.catch(fail);
    try{await started;await expect(postRewardUnit(admin,unitId,rev,batch.batchId)).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);}
    finally{release();clearTimeout(timer);await holder;}
    expect(await postRewardUnit(admin,unitId,rev,batch.batchId)).toEqual({alreadyPosted:false});
    const after=await state();expect(after.unit.unit.status).toBe('posted');
    expect(await postRewardUnit(admin,unitId,rev,batch.batchId)).toEqual({alreadyPosted:true});expect(await state()).toEqual(after);
  });
  it('privately admits actual ordinary posting with canonical awards and no effects, preserving authority-first posted retries',async()=>{
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)}),expected=await calculationOracle(admin,unitId);
    const snapshot=async()=>({units:await owner.db.select().from(schema.rewardUnit),entries:await owner.db.select().from(schema.rewardEntry),decisions:await owner.db.select().from(schema.rewardDecision),compensation:await owner.db.select().from(schema.compensation),inputs:await owner.db.select().from(schema.payrollInput),events:await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id)}),before=await snapshot();
    const admit=(actor:SessionContext,rev=revision,batchId:string|null=batch.batchId)=>owner.withTenant(actor,tx=>tx.execute<{value:{alreadyPosted:boolean;authorityStamp:string;decisionDigest:string;calculation:{rows:unknown[];flags:unknown[];budgets:typeof expected.budgets};postingAwards:Record<string,unknown>}}>(sql`select app.reward_post_admission(${unitId}::uuid,${rev},${batchId}::uuid)as value`));
    const [result]=await admit(admin);expect(result.value.alreadyPosted).toBe(false);expect(result.value.authorityStamp).toMatch(/^[a-f0-9]{64}$/);expect(result.value.decisionDigest).toBe(expected.unit.approvedDigest);expect(result.value.calculation.rows).toEqual(expected.rows);expect(result.value.calculation.flags).toEqual(expected.flags);expect(result.value.calculation.budgets.standard).toEqual(expected.budgets.standard);expect(result.value.calculation.budgets.h).toEqual(expected.budgets.h);expect(result.value.postingAwards).toEqual({});expect(await snapshot()).toEqual(before);
    await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_post_admission(${unitId}::uuid,${revision},${batch.batchId}::uuid)`))).rejects.toThrow();
    await expect(admit(actors.bu!)).rejects.toThrow('assigned payroll');await expect(admit(admin,revision+1)).rejects.toThrow('another session');await expect(admit(admin,revision,null)).rejects.toThrow('draft payroll batch');
    await expect(owner.withTenant(admin,async tx=>{await tx.execute(sql`select set_config('app.agent_principal_id','not-a-valid-agent',true)`);await tx.execute(sql`select app.reward_post_admission(${unitId}::uuid,${revision},${batch.batchId}::uuid)`);})).rejects.toThrow('current human');
    expect(await snapshot()).toEqual(before);
    await postRewardUnit(admin,unitId,revision,batch.batchId);const posted=await snapshot();
    const [retry]=await admit(admin,revision,null);expect(retry.value).toEqual({alreadyPosted:true,unitId,revision});await expect(admit(actors.bu!,revision,null)).rejects.toThrow('assigned payroll');expect(await snapshot()).toEqual(posted);
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
  it('privately prepares exact locked employee salary and existing payroll sources, then refuses a genuinely changed native salary',async()=>{
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)});
    await setPayrollInput(admin,{batchId:batch.batchId,employmentId,overtimeAmount:12,bonusAmount:34,tp1Deduction:56,zakat:78});
    const before=await view(),[comp]=await owner.db.select().from(schema.compensation).where(and(eq(schema.compensation.employmentId,employmentId),isNull(schema.compensation.validTo),isNull(schema.compensation.supersededAt))),inputs=await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batch.batchId)),events=await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id);
    const prepare=()=>owner.withTenant(admin,tx=>tx.execute<{value:{transactionId:string;sourcePlan:{entryId:string;employmentBefore:{id:string};compensationBefore:{id:string;basic_salary:number};payrollInputBefore:{bonus_amount:number;overtime_amount:number;tp1_deduction:number;zakat:number};awardCents:number;newBasicCents:number}[]}}>(sql`select app.reward_post_sources(${unitId}::uuid,${revision},${batch.batchId}::uuid)as value`));
    const [prepared]=await prepare();expect(prepared.value.transactionId).toMatch(/^\d+$/);expect(prepared.value.sourcePlan).toHaveLength(1);expect(prepared.value.sourcePlan[0]).toMatchObject({entryId:before.rows[0].id,employmentBefore:{id:employmentId},compensationBefore:{id:comp.id,basic_salary:Number(comp.basicSalary)},payrollInputBefore:{bonus_amount:34,overtime_amount:12,tp1_deduction:56,zakat:78},newBasicCents:before.rows[0].newBasicCents,newBasicSalary:(before.rows[0].newBasicCents/100).toFixed(2),awardCents:before.rows[0].bonusCents+before.rows[0].lumpCents,newBonusAmount:(34+(before.rows[0].bonusCents+before.rows[0].lumpCents)/100).toFixed(2)});
    expect(await view()).toEqual(before);expect(await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batch.batchId))).toEqual(inputs);expect(await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id)).toEqual(events);
    await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_post_sources(${unitId}::uuid,${revision},${batch.batchId}::uuid)`))).rejects.toThrow();
    await setCompensation(admin,{employmentId,basicSalary:5500,effectiveFrom:`${year-1}-01-01`});
    await expect(prepare()).rejects.toThrow('Salary data changed');await expect(postRewardUnit(admin,unitId,revision,batch.batchId)).rejects.toThrow('Salary data changed');expect((await view()).unit.status).toBe('approved');expect(await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batch.batchId))).toEqual(inputs);
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
  it('privately performs one actual native decision with its exact actor, physical effects and audit under a savepoint',async()=>{
    const before=await view(),why='Actual private native decision reviewed';
    await expect(withTenant(actors.bu!,tx=>tx.execute(sql`select app.reward_decision_native(${unitId}::uuid,${before.unit.revision},'submit',${why},false)`))).rejects.toThrow();
    await owner.withTenant(actors.bu!,async tx=>{
      await tx.execute(sql`savepoint actual_reward_decision`);
      const [result]=await tx.execute<{next:string}>(sql`select app.reward_decision_native(${unitId}::uuid,${before.unit.revision},'submit',${why},false)as next`);expect(result.next).toBe('bg');
      await tx.execute(sql`release savepoint actual_reward_decision`);await tx.execute(sql`set constraints all immediate`);
      const [proof]=await tx.execute<{retained:number;receipts:number}>(sql`select count(*)::integer as retained,(select count(*)::integer from app.reward_decision_native_receipt r join app.reward_decision_native_effect e on e.id=r.effect_id where e.xact_id=pg_current_xact_id()and e.unit_id=${unitId}::uuid)as receipts from app.reward_decision_native_effect where xact_id=pg_current_xact_id()and unit_id=${unitId}::uuid and completed and not active`);expect(proof).toEqual({retained:1,receipts:2});
    });
    const [decision]=await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId)),events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,unitId),eq(schema.domainEvent.eventType,'reward-unit.routed')));
    expect(decision).toMatchObject({actorId:actors.bu!.userId,revision:before.unit.revision,action:'submit',fromStage:'draft',toStage:'bg',reason:why});expect(events).toHaveLength(1);expect(events[0]).toMatchObject({actorType:'user',actorId:actors.bu!.userId,subjectEmploymentId:null,payload:{from:'draft',to:'bg',revision:before.unit.revision}});
    expect(await decideRewardUnit(actors.bg!,unitId,before.unit.revision,'approve','Actual separate native reviewer')).toBe('gr');
  });
  it('closes the actual final EC approval without requiring its now-completed stage to remain pending',async()=>{
    const revision=(await view()).unit.revision,why='Actual final native approval reviewed';
    await decideRewardUnit(actors.bu!,unitId,revision,'submit',why);
    for(const seat of ['bg','gr','ctro']as const)await decideRewardUnit(actors[seat]!,unitId,revision,'approve',why);
    await owner.withTenant(actors.ec!,async tx=>{const [result]=await tx.execute<{next:string}>(sql`select app.reward_decision_native(${unitId}::uuid,${revision},'approve',${why},false)as next`);expect(result.next).toBe('approved');await tx.execute(sql`set constraints all immediate`);});
    expect((await view()).unit.status).toBe('approved');
    const [event]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,unitId),eq(schema.domainEvent.eventType,'reward-unit.approved')));expect(event).toMatchObject({actorType:'user',actorId:actors.ec!.userId,payload:{from:'ec',to:'approved',revision}});
  });
  it.each([false,true])('revalidates an early-flushed private decision after later authority revoke (restored: %s)',async restore=>{
    const before=await view(),why='Actual private revocation rollback',beforeDecisions=await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId)),beforeEvents=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId));let didRestore=false;
    let refusal:unknown;try{await owner.withTenant(actors.bu!,async tx=>{
      await tx.execute(sql`select app.reward_decision_native(${unitId}::uuid,${before.unit.revision},'submit',${why},false)`);await tx.execute(sql`set constraints all immediate`);
      if(restore)await tx.execute(sql`set constraints app.rewards_decision_native_effect deferred`);
      await tx.execute(sql`update role_assignment set role='manager'where app_user_id=${actors.bu!.userId!}::uuid and tenant_id=${b.tenantId}::uuid and role='employee'`);
      if(restore){await tx.execute(sql`update role_assignment set role='employee'where app_user_id=${actors.bu!.userId!}::uuid and tenant_id=${b.tenantId}::uuid and role='manager'`);didRestore=true;}
    });}catch(error){refusal=error;}
    expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'Native Rewards decision authority changed'}));expect(didRestore).toBe(restore);
    expect((await view()).unit).toEqual(before.unit);expect(await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId))).toEqual(beforeDecisions);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId))).toEqual(beforeEvents);
    await owner.withTenant(actors.bu!,tx=>tx.execute(sql`select app.reward_decision_native(${unitId}::uuid,${before.unit.revision},'submit',${why},false)`));expect((await view()).unit.status).toBe('bg');
  });
  it('refuses actual agent and any supplied agent stamp before private native mutation',async()=>{
    const principalId=await ensureAgentPrincipal(owner.db,b.tenantId),entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,b.tenantId)),agent=agentContext(b.tenantId,principalId,entitlements),before=await view();
    expect(await owner.withTenant(agent,tx=>tx.execute(sql`select app.current_agent_principal()as principal`))).toEqual([{principal:principalId}]);
    for(const supplied of [null,principalId,'not-a-uuid']){
      let refusal:unknown;try{await owner.withTenant(supplied===null?agent:actors.bu!,async tx=>{if(supplied!==null)await tx.execute(sql`select set_config('app.agent_principal_id',${supplied},true)`);return tx.execute(sql`select app.reward_decision_native(${unitId}::uuid,${before.unit.revision},'submit','Agent must not decide native Rewards',false)`);});}catch(error){refusal=error;}
      expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'A current human Rewards principal is required'}));
    }
    expect((await view()).unit).toEqual(before.unit);expect(await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId))).toEqual([]);
  });
  it('privately admits the exact native decision source and preserves different-reviewer stage separation',async()=>{
    await setRewardMember(admin,unitId,(await view()).unit.revision,actors.bu!.userId!,'bg');
    const before=await view(),why='Actual independently reviewed native decision';
    const admission=(actor:SessionContext,action:string,revision=before.unit.revision)=>owner.withTenant(actor,tx=>tx.execute<{value:{fromStage:string;toStage:string;decisionDigest:string;authorityStamp:string}}>(sql`select app.reward_decision_admission(${unitId}::uuid,${revision},${action},${why},false)as value`));
    const [admitted]=await admission(actors.bu!,'submit'),entries=await owner.db.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,unitId));
    const [storedUnit]=await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId));
    const expectedDigest=createHash('sha256').update(JSON.stringify({policy:storedUnit.policy,kind:storedUnit.kind,parentUnitId:storedUnit.parentUnitId,offcycle:storedUnit.offcycle,entries:[...entries].sort((a,b)=>a.id.localeCompare(b.id)).map(e=>({id:e.id,source:e.source,facts:e.facts,recommendation:e.recommendation}))})).digest('hex');
    expect(admitted.value).toMatchObject({fromStage:'draft',toStage:'bg',decisionDigest:expectedDigest});expect(admitted.value.authorityStamp).toMatch(/^[a-f0-9]{64}$/);
    expect((await view()).unit).toEqual(before.unit);expect(await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId))).toEqual([]);
    await expect(withTenant(actors.bu!,tx=>tx.execute(sql`select app.reward_decision_admission(${unitId}::uuid,${before.unit.revision},'submit',${why},false)`))).rejects.toThrow();
    await expect(admission(actors.bu!,'submit',before.unit.revision+1)).rejects.toThrow();
    expect(await decideRewardUnit(actors.bu!,unitId,before.unit.revision,'submit',why)).toBe('bg');
    let refusal:unknown;try{await admission(actors.bu!,'approve');}catch(error){refusal=error;}
    expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'A different reviewer must sign the next approval stage.'}));
    await expect(decideRewardUnit(actors.bu!,unitId,before.unit.revision,'approve',why)).rejects.toThrow('different reviewer');
    const [next]=await admission(actors.bg!,'approve');expect(next.value).toMatchObject({fromStage:'bg',toStage:'gr',decisionDigest:expectedDigest});
    expect(await decideRewardUnit(actors.bg!,unitId,before.unit.revision,'approve',why)).toBe('gr');
  });
  it('derives bounded annual calculations from actual governance and native membership without exporting hidden inputs',async()=>{
    for(const actor of [admin,actors.bu!,actors.bg!,actors.ctro!,actors.ec!,actors.pbp!]){
      const expected=await calculationOracle(actor,unitId),actualProjection=await getRewardUnit(actor,unitId),[native]=await withTenant(actor,tx=>tx.execute<{value:Record<string,unknown>&{rows:Record<string,unknown>[]}}>(sql`select app.reward_annual_calculation(${unitId}::uuid,${expected.unit.revision})as value`));
      expect(native.value.rows).toEqual(expected.rows.map(row=>Object.fromEntries(Object.keys(native.value.rows[0]).map(key=>[key,(row as unknown as Record<string,unknown>)[key]]))));
      for(const key of ['budgets','flags','poolStatus','suggestedMultiplierBp','suggestion','suggestedLumpCents','lumpUnitCents','lumpWorking','bonusCounts','payWindow','route','hiddenCount']){expect(native.value[key]).toEqual((expected as unknown as Record<string,unknown>)[key]);expect((actualProjection as unknown as Record<string,unknown>)[key]).toEqual((expected as unknown as Record<string,unknown>)[key]);}
      await expect(withTenant(actor,tx=>tx.execute(sql`select app.reward_calc_annual_unit(${unitId}::uuid,${expected.unit.revision})`))).rejects.toThrow();
    }
    // Deny every raw pay-row SELECT to the app role: the real review read must still
    // calculate its authorized bounded result through the private owner, with no raw fallback.
    const boundedOracle=await calculationOracle(actors.bu!,unitId);
    await owner.client`create policy reward_native_read_fixture on public.reward_entry as restrictive for select to ai_hr_app using(false)`;
    try{
      expect(await withTenant(actors.bu!,tx=>tx.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,unitId)))).toEqual([]);
      const bounded=await getRewardUnit(actors.bu!,unitId);expect(bounded.rows.map(row=>row.source)).toEqual(boundedOracle.rows.map(row=>row.source));expect(bounded.budgets).toEqual(boundedOracle.budgets);expect(bounded.flags).toEqual(boundedOracle.flags);
    }finally{await owner.client`drop policy reward_native_read_fixture on public.reward_entry`;}
    const actual=await view(),recipient=actual.rows[0];
    await owner.db.update(schema.rewardEntry).set({source:{...recipient.source,personId:admin.personId!}}).where(eq(schema.rewardEntry.id,recipient.id));
    await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_annual_calculation(${unitId}::uuid,${actual.unit.revision})`))).rejects.toThrow();
    await owner.db.update(schema.rewardEntry).set({source:recipient.source}).where(eq(schema.rewardEntry.id,recipient.id));
    expect((await view()).rows[0].source).toEqual(recipient.source);
  });
  it('posts an approved off-cycle increase once and retains its funding consumption', async () => {
    const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await postRewardUnit(admin, unitId, rev, batch.batchId);
    const parent = await view();
    const childId = await createOffcycleReview(actors.bu!, unitId, { kind: 'adhoc', entryIds: [parent.rows[0].id], effectiveFrom: `${year + 1}-02-01`, exceptionReason: '' });
    let child = await getRewardUnit(actors.bu!, childId);
    const [nativeCalculation]=await withTenant(actors.bu!,tx=>tx.execute<{value:{rows:typeof child.rows;budgets:typeof child.budgets;flags:typeof child.flags;route:typeof child.route;hiddenCount:number}}>(sql`select app.reward_offcycle_calculation(${childId}::uuid,${child.unit.revision})as value`));
    const oracle=await calculationOracle(actors.bu!,childId);
    expect(nativeCalculation.value.rows).toEqual(oracle.rows.map(row=>Object.fromEntries(Object.keys(nativeCalculation.value.rows[0]).map(key=>[key,(row as unknown as Record<string,unknown>)[key]]))));
    expect(nativeCalculation.value.budgets).toEqual(oracle.budgets);expect(nativeCalculation.value.flags).toEqual(oracle.flags);expect(nativeCalculation.value.route).toEqual(oracle.route);expect(nativeCalculation.value.hiddenCount).toBe(oracle.hiddenCount);
    await expect(withTenant(actors.bu!,tx=>tx.execute(sql`select app.reward_offcycle_calculation(${childId}::uuid,${child.unit.revision+1})`))).rejects.toThrow();
    await expect(withTenant(actors.bu!,tx=>tx.execute(sql`select app.reward_offcycle_calculation(${unitId}::uuid,${parent.unit.revision})`))).rejects.toThrow();
    const sourcePerson=child.rows[0].source.personId,ownLogin=await createAppUser(b.tenantId,sourcePerson,'employee');
    const selfReviewer:SessionContext={...admin,userId:ownLogin,personId:sourcePerson,roles:['employee'],grants:undefined};
    await expect(withTenant(selfReviewer,tx=>tx.execute(sql`select app.reward_offcycle_calculation(${childId}::uuid,${child.unit.revision})`))).rejects.toThrow();
    await setRewardMember(admin,childId,(await getRewardUnit(admin,childId)).unit.revision,ownLogin,'bu');
    child=await getRewardUnit(actors.bu!,childId);
    const ownProjection=await calculationOracle(selfReviewer,childId),[bounded]=await withTenant(selfReviewer,tx=>tx.execute<{value:{rows:unknown[];budgets:typeof child.budgets;flags:typeof child.flags;hiddenCount:number}}>(sql`select app.reward_offcycle_calculation(${childId}::uuid,${child.unit.revision})as value`));
    expect(bounded.value.rows).toEqual([]);expect(bounded.value.budgets).toEqual(ownProjection.budgets);expect(bounded.value.flags).toEqual(ownProjection.flags);expect(bounded.value.hiddenCount).toBe(1);
    for(const secret of [sourcePerson,child.rows[0].source.employmentId,child.rows[0].source.name,child.rows[0].id])expect(JSON.stringify(bounded.value)).not.toContain(secret);
    await setRewardMember(admin,childId,(await getRewardUnit(admin,childId)).unit.revision,ownLogin,'bu',true);
    child=await getRewardUnit(actors.bu!,childId);
    await expect(withTenant(selfReviewer,tx=>tx.execute(sql`select app.reward_offcycle_calculation(${childId}::uuid,${child.unit.revision})`))).rejects.toThrow();
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
      const currentReview = await getRewardUnit(admin, unitId);
      await owner.db.update(schema.assignment).set({ businessUnitId: currentReview.unit.businessUnitId }).where(eq(schema.assignment.employmentId, hire.employmentId));
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
