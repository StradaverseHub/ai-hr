import {publishActionCapabilityPackage} from '../deploy/access/publish-workforce-capabilities';
import {configureRewardFixture,refreshRewardFixtureBudget,changeRewardFixtureInputs} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, setPayrollInput } from '../packs/payroll/service';
import { returnedRewardUnits, getRewardSeniorMembership, previewRewardSeniorMembership, saveRewardSeniorMembership, getRewardConfiguration, listRewardUnits, pendingRewardReviews, rewardSetupChoices, rewardNotificationRecipients, createOffcycleReview, createRewardUnit, getRewardUnit, saveRewardEntry, saveRewardEntryTx, importRewardFacts, importRewardFactsTx, saveRewardPolicy, decideRewardUnit, postRewardUnit, cancelRewardReviewTx, canPostRewardUnit, rewardPayrollChoices, prepareReviewedRewardPostTx, postReviewedRewardUnitTx } from '../packs/rewards/service';
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

async function expectPgRefusal(query: Promise<unknown>, code: string, message: string) {
  await expect(query.then(() => [], pgErrorChain)).resolves.toContainEqual(expect.objectContaining({ code, message }));
}

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
  it('publishes the bounded Rewards reads and prevents a denied GR course from falling through to HR',async()=>{
    const cap='function.rewards.configuration.assigned.view';
    try{
      expect(await publishActionCapabilityPackage(owner.client,'rewards_read')).toMatchObject({changed:true,capabilities:4});
      expect(await publishActionCapabilityPackage(owner.client,'rewards_read')).toMatchObject({changed:false});
      expect(await getRewardConfiguration(admin,unitId)).toMatchObject({canReadPat:true});
      expect((await getRewardUnit(admin,unitId)).rows.length).toBeGreaterThan(0);
      await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
       values(${b.tenantId}::uuid,${admin.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
      await expect(getRewardConfiguration(admin,unitId)).rejects.toThrow();
      expect((await getRewardUnit(admin,unitId)).rows.length).toBeGreaterThan(0);
    }finally{
      await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
      await owner.client`update access_capability set supported=false,bindings='[]'::jsonb
       where id in ('rewards.view','function.rewards.review.view','function.rewards.configuration.assigned.view',
        'function.rewards.configuration.administration.view')`;
    }
  });
  it('reads bounded configuration metadata without an employee/pay roster or PAT disclosure to HR-only',async()=>{
    const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Actual configuration administrator',primaryEmail:'configuration@rewards.test'}).returning();
    const userId=await createAppUser(b.tenantId,person.id,'hr_admin'),hr={...admin,userId,personId:person.id,roles:['hr_admin']as SessionContext['roles'],grants:undefined};
    for(const actor of [admin,hr]){
      const expected=await getRewardConfiguration(actor,unitId),[result]=await owner.withTenant(actor,tx=>tx.execute<{value:typeof expected}>(sql`select app.reward_configuration_review(${unitId}::uuid)as value`));
      const normalize=(value:typeof expected)=>({...value,unit:{...value.unit,createdAt:new Date(value.unit.createdAt).toISOString(),updatedAt:new Date(value.unit.updatedAt).toISOString(),postedAt:value.unit.postedAt?new Date(value.unit.postedAt).toISOString():null,deletedAt:value.unit.deletedAt?new Date(value.unit.deletedAt).toISOString():null}});
      expect(normalize(result.value)).toEqual(normalize(expected));expect(result.value).not.toHaveProperty('rows');expect(result.value.members.length).toBeGreaterThan(0);
      if(actor===hr)expect(result.value).toMatchObject({canReadPat:false,canConfigure:false,canManageMembers:true,unit:{policy:{patActual:0,patTarget:100}}});
      const [floor]=await owner.db.execute<{assigned:boolean;administration:boolean}>(sql`select app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actor.userId!}::uuid,'function.rewards.configuration.assigned.view',${b.companyId}::uuid)as assigned,app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actor.userId!}::uuid,'function.rewards.configuration.administration.view',${b.companyId}::uuid)as administration`);expect(floor).toEqual({assigned:actor===admin,administration:true});
      expect(await withTenant(actor,tx=>tx.execute(sql`select app.reward_configuration_review(${unitId}::uuid)as value`))).toEqual([{value:result.value}]);
    }
    const expected = await Promise.all([admin,hr].map(actor => getRewardConfiguration(actor,unitId)));
    await owner.db.execute(sql`create policy test_rewards_configuration_unit_fence on reward_unit as restrictive for select to ai_hr_app using(false)`);
    await owner.db.execute(sql`create policy test_rewards_configuration_state_fence on reward_governance as restrictive for select to ai_hr_app using(false)`);
    try {
      expect(await Promise.all([admin,hr].map(actor => getRewardConfiguration(actor,unitId)))).toEqual(expected);
    } finally {
      await owner.db.execute(sql`drop policy test_rewards_configuration_state_fence on reward_governance`);
      await owner.db.execute(sql`drop policy test_rewards_configuration_unit_fence on reward_unit`);
    }
    await expect(getRewardConfiguration(actors.bu!,unitId)).rejects.toThrow('Rewards configuration requires company administrator or Group Rewards access.');
    const claimed={...hr,roles:['employee']as SessionContext['roles'],grants:undefined};
    const [current]=await owner.withTenant(claimed,tx=>tx.execute<{pure:boolean;current:boolean}>(sql`select app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${hr.userId!}::uuid,'function.rewards.configuration.administration.view',${b.companyId}::uuid)as pure,app.rewards_function_current_legacy_allowed(${b.tenantId}::uuid,${hr.userId!}::uuid,'function.rewards.configuration.administration.view',${b.companyId}::uuid)as current`));expect(current).toEqual({pure:true,current:false});
    await expect(owner.withTenant(actors.bu!,tx=>tx.execute(sql`select app.reward_configuration_review(${unitId}::uuid)`))).rejects.toThrow();
  });
  it('reads pay-free Senior membership and seated counts through their real bounded owners after raw entry reads are fenced',async()=>{
    const expected=await getRewardSeniorMembership(admin,unitId),listed=await listRewardUnits(admin,[b.companyId]);expect(listed).toHaveLength(1);
    await owner.db.execute(sql`create policy test_rewards_metadata_read_fence on reward_entry as restrictive for select to ai_hr_app using(false)`);
    try {
      expect(await getRewardSeniorMembership(admin,unitId)).toEqual(expected);
      const bounded=await listRewardUnits(admin,[b.companyId]);expect(bounded).toHaveLength(1);expect({people:bounded[0].people,verified:bounded[0].verified}).toEqual({people:listed[0].people,verified:listed[0].verified});expect(bounded[0].people).toBe(1);
      expect(JSON.stringify(expected)).not.toMatch(/basicCents|compensationId|bonusCents|recommendation/);
    } finally { await owner.db.execute(sql`drop policy test_rewards_metadata_read_fence on reward_entry`); }
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
    const [bounded]=await owner.withTenant(own,tx=>tx.execute<{value:unknown}>(sql`select app.reward_senior_membership_metadata(${unitId}::uuid)as value`));expect(bounded.value).toEqual(state);expect(await withTenant(own,tx=>tx.execute(sql`select app.reward_senior_membership_metadata(${unitId}::uuid)as value`))).toEqual([{value:state}]);
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
    await expectPgRefusal(owner.withTenant(actors.bu!,tx=>tx.execute(sql`select app.reward_senior_membership_metadata(${unitId}::uuid)`)), '42501', 'Group Rewards membership access is required.');
    await expect(previewRewardSeniorMembership(actors.bu!, unitId, v.unit.revision, { employmentIds: [], adoptLegacy: false })).rejects.toThrow(/Group Rewards/);
    const userId = actors.bu!.userId!;
    await setRewardMember(admin, unitId, v.unit.revision, userId, 'gr');
    const state = await getRewardSeniorMembership(actors.bu!, unitId);
    const [bounded]=await owner.withTenant(actors.bu!,tx=>tx.execute<{value:unknown}>(sql`select app.reward_senior_membership_metadata(${unitId}::uuid)as value`));expect(bounded.value).toEqual(state);
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
  it('pairs pure target-user Rewards function defaults with actual native roles and current claimed posting authority',async()=>{
    for(const actor of [admin,actors.bu!,actors.bg!,actors.ctro!,actors.ec!,actors.pbp!]){
      const actual=await withTenant(actor,tx=>tx.execute<{role:string}>(sql`select app.reward_roles(${unitId}::uuid)as role`)),[pure]=await owner.db.execute<{roles:string[]}>(sql`select array(select app.rewards_roles_for_tenant(${b.tenantId}::uuid,${actor.userId!}::uuid,${unitId}::uuid))as roles`);expect(pure.roles.sort()).toEqual(actual.map(row=>row.role).sort());
      const [defaults]=await owner.db.execute<{review:boolean;post:boolean}>(sql`select app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actor.userId!}::uuid,'function.rewards.review.view',${b.companyId}::uuid)as review,app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actor.userId!}::uuid,'function.rewards.posting.execute',${b.companyId}::uuid)as post`);expect(defaults.review).toBe(true);expect(defaults.post).toBe(await canPostRewardUnit(actor,unitId));
    }
    const claimedEmployee:SessionContext={...admin,roles:['employee'],grants:[{role:'employee',companyId:null}]};
    const [current]=await owner.withTenant(claimedEmployee,tx=>tx.execute<{pure:boolean;current:boolean}>(sql`select app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${admin.userId!}::uuid,'function.rewards.posting.execute',${b.companyId}::uuid)as pure,app.rewards_function_current_legacy_allowed(${b.tenantId}::uuid,${admin.userId!}::uuid,'function.rewards.posting.execute',${b.companyId}::uuid)as current`));expect(current).toEqual({pure:true,current:false});expect(await canPostRewardUnit(claimedEmployee,unitId)).toBe(false);
    const [differentCaller]=await owner.withTenant(actors.bu!,tx=>tx.execute<{pure:boolean;current:boolean}>(sql`select app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${admin.userId!}::uuid,'function.rewards.posting.execute',${b.companyId}::uuid)as pure,app.rewards_function_current_legacy_allowed(${b.tenantId}::uuid,${admin.userId!}::uuid,'function.rewards.posting.execute',${b.companyId}::uuid)as current`));expect(differentCaller).toEqual({pure:true,current:false});
    const [draft]=await owner.db.execute<{submit:boolean;approve:boolean;reject:boolean;unknown:boolean}>(sql`select app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actors.bu!.userId!}::uuid,'function.rewards.decisions.submit.execute',${b.companyId}::uuid)as submit,app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actors.bg!.userId!}::uuid,'function.rewards.decisions.approve.approve',${b.companyId}::uuid)as approve,app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actors.bg!.userId!}::uuid,'function.rewards.decisions.reject.execute',${b.companyId}::uuid)as reject,app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${admin.userId!}::uuid,'function.rewards.unknown.execute',${b.companyId}::uuid)as unknown`);expect(draft).toEqual({submit:true,approve:false,reject:false,unknown:false});
    const revision=(await view()).unit.revision;await decideRewardUnit(actors.bu!,unitId,revision,'submit','Actual native transition for function defaults');
    const [pending]=await owner.db.execute<{submit:boolean;approve:boolean}>(sql`select app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actors.bu!.userId!}::uuid,'function.rewards.decisions.submit.execute',${b.companyId}::uuid)as submit,app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actors.bg!.userId!}::uuid,'function.rewards.decisions.approve.approve',${b.companyId}::uuid)as approve`);expect(pending).toEqual({submit:false,approve:true});
    await expect(withTenant(admin,tx=>tx.execute(sql`select app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${admin.userId!}::uuid,'function.rewards.review.view',${b.companyId}::uuid)`))).rejects.toThrow();
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
    const [result]=await admit(admin);expect(result.value.alreadyPosted).toBe(false);expect(result.value.authorityStamp).toMatch(/^[a-f0-9]{64}$/);expect(result.value.decisionDigest).toBe(expected.unit.approvedDigest);// The engine spreads its input row. The posting calculator receives business fields, not storage metadata.
    const storageFields=new Set(['createdAt','updatedAt','tenantId','unitId','employmentId','enactedCompensationId']);
    const expectedRows=expected.rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!storageFields.has(key))));
    expect(result.value.calculation.rows).toEqual(expectedRows);expect(result.value.calculation.flags).toEqual(expected.flags);expect(result.value.calculation.budgets.standard).toEqual(expected.budgets.standard);expect(result.value.calculation.budgets.h).toEqual(expected.budgets.h);expect(result.value.postingAwards).toEqual({});expect(await snapshot()).toEqual(before);
    await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_post_admission(${unitId}::uuid,${revision},${batch.batchId}::uuid)`))).rejects.toThrow();
    await expectPgRefusal(admit(actors.bu!), '42501', 'The assigned payroll role is required.');
    await expectPgRefusal(admit(admin,revision+1), '40001', 'This review changed in another session. Reload before saving.');
    await expectPgRefusal(admit(admin,revision,null), '42501', 'Select a draft payroll batch for the bonus and lump-sum awards.');
    await expectPgRefusal(owner.withTenant(admin,async tx=>{await tx.execute(sql`select set_config('app.agent_principal_id','not-a-valid-agent',true)`);await tx.execute(sql`select app.reward_post_admission(${unitId}::uuid,${revision},${batch.batchId}::uuid)`);}), '42501', 'A current human Rewards principal is required');
    expect(await snapshot()).toEqual(before);
    await postRewardUnit(admin,unitId,revision,batch.batchId);const posted=await snapshot();
    const [retry]=await admit(admin,revision,null);expect(retry.value).toEqual({alreadyPosted:true,unitId,revision});await expectPgRefusal(admit(actors.bu!,revision,null), '42501', 'The assigned payroll role is required.');expect(await snapshot()).toEqual(posted);
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
  it.each(['all','owned']as const)('preserves actual private posting under prior %s immediate constraints without an execution lease',async mode=>{
    // Original unchanged app prepare/enact positive is separately established at350cb7e0e.
    // This still qualifies private construction only; actual APP financial qualification uses
    // the eventual reviewed production port, never a private fixture grant.
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)});
    await owner.withTenant(admin,async tx=>{
      if(mode==='all')await tx.execute(sql`set constraints all immediate`);else await tx.execute(sql`set constraints app.rewards_post_native_effect immediate`);
      const [result]=await tx.execute<{value:{alreadyPosted:boolean}}>(sql`select app.reward_post_native(${unitId}::uuid,${revision},${batch.batchId}::uuid)as value`);expect(result.value).toEqual({alreadyPosted:false});
      const [proof]=await tx.execute<{completed:number;active:number}>(sql`select count(*)filter(where completed)::integer as completed,count(*)filter(where active)::integer as active from app.reward_post_native_context where unit_id=${unitId}::uuid and xact_id=pg_current_xact_id()`);expect(proof).toEqual({completed:1,active:0});
    });
    expect((await view()).unit.status).toBe('posted');expect(await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batch.batchId))).toHaveLength(1);
  });
  it.each(['all','owned']as const)('preserves the caller completed-constraint mode after owned insert restoration (%s)',async mode=>{
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)}),before=await view(),salaries=await owner.db.select().from(schema.compensation),inputs=await owner.db.select().from(schema.payrollInput),events=await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id);let posted=false,restored=false;let refusal:unknown;
    try{await owner.withTenant(admin,async tx=>{
      if(mode==='all')await tx.execute(sql`set constraints all immediate`);else await tx.execute(sql`set constraints app.rewards_post_native_effect immediate`);
      await tx.execute(sql`select app.reward_post_native(${unitId}::uuid,${revision},${batch.batchId}::uuid)`);posted=true;
      const changed=await tx.execute(sql`update role_assignment set role='manager'where tenant_id=${b.tenantId}::uuid and app_user_id=${admin.userId!}::uuid and role='hr_admin' returning id`);expect(changed).toHaveLength(1);
      const repaired=await tx.execute(sql`update role_assignment set role='hr_admin'where tenant_id=${b.tenantId}::uuid and app_user_id=${admin.userId!}::uuid and role='manager' returning id`);expect(repaired).toHaveLength(1);restored=true;
    });}catch(error){refusal=error;}
    expect(posted).toBe(true);expect(restored).toBe(mode==='owned');expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'Reward posting authority changed'}));expect(await view()).toEqual(before);expect(await owner.db.select().from(schema.compensation)).toEqual(salaries);expect(await owner.db.select().from(schema.payrollInput)).toEqual(inputs);expect(await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id)).toEqual(events);
  });
  it('restores the proven insert constraint to immediate before a second genuinely admitted posting construction',async()=>{
    const first=await view(),reason='Actual zero-change reviewed unit';
    await configureRewardFixture(admin,unitId,first.unit.revision,{...first.unit.policy,targetMonthsBp:0});
    let current=await view();await saveRewardEntry(admin,unitId,current.unit.revision,current.rows[0].id,{...current.rows[0].recommendation,meritBp:0,reason});
    // A distinct genuine native cycle uses the original employee's older snapshot. Current
    // reviewer employments were created later and do not manufacture zero-pay roster rows.
    const secondId=await createRewardUnit(admin,{name:'Actual constraint restoration review',year,companyId:b.companyId,businessUnitId:first.unit.businessUnitId,snapshotDate:`${year-1}-12-31`});
    for(const role of ['bu','bg','ctro','ec','payroll']as const)await setRewardMember(admin,secondId,(await getRewardUnit(admin,secondId)).unit.revision,actors[role]!.userId!,role);
    let second=await getRewardUnit(admin,secondId);expect(second.rows).toHaveLength(1);
    await configureRewardFixture(admin,secondId,second.unit.revision,{...second.unit.policy,effectiveFrom:today,targetMonthsBp:0,patActual:100,patTarget:100,ranges:{'12':[300000,500000,700000]}});
    second=await getRewardUnit(admin,secondId);await saveRewardEntry(admin,secondId,second.unit.revision,second.rows[0].id,{...second.rows[0].recommendation,meritBp:0,reason},{...emptyFacts(),reviewed:true,talent:'SCORE',performance:'ME'});await refreshRewardFixtureBudget(admin,secondId);
    const secondRevision=(await getRewardUnit(admin,secondId)).unit.revision;await decideRewardUnit(actors.bu!,secondId,secondRevision,'submit',reason);for(const role of ['bg','gr','ctro','ec']as const)await decideRewardUnit(actors[role]!,secondId,secondRevision,'approve',reason);
    const firstRevision=await approve();current=await view();expect(current.rows.map(row=>({before:row.source.basicCents,after:row.newBasicCents,bonus:row.bonusCents,lump:row.lumpCents}))).toEqual([{before:500000,after:500000,bonus:0,lump:0}]);
    await owner.withTenant(admin,async tx=>{
      await tx.execute(sql`set constraints app.rewards_post_native_effect immediate`);await tx.execute(sql`select app.reward_post_native(${unitId}::uuid,${firstRevision},null)`);
      let refusal:unknown;
      // postgres.js records the first failed query in its current transaction scope.
      // Give the intentionally failing probe a driver-owned savepoint scope.
      try {
        await tx.transaction(nested => nested.execute(sql`select app.reward_post_context_begin(${secondId}::uuid,${secondRevision},null)`));
      } catch (error) { refusal=error; }
      expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'Reward posting construction is incomplete'}));
      const diagnostics:Record<string,unknown>[]=[];let link=refusal;for(let depth=0;depth<4&&link&&typeof link==='object';depth++){diagnostics.push(link as Record<string,unknown>);link=(link as {cause?:unknown}).cause;}
      expect(diagnostics).toContainEqual(expect.objectContaining({schema_name:'app',table_name:'reward_post_native_context',constraint_name:'rewards_post_native_effect'}));
    });
    expect((await view()).unit.status).toBe('posted');expect((await getRewardUnit(admin,secondId)).unit.status).toBe('approved');
  });
  it('privately closes captured posting construction under owner inspection without granting an app mutation port',async()=>{
    // This qualifies private construction only; owner sessions do not establish the app's
    // financial guard positive. The eventual public finite owner must use its real reviewed ACL.
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)}),before=await view();
    await setPayrollInput(admin,{batchId:batch.batchId,employmentId,overtimeAmount:123,bonusAmount:55,tp1Deduction:44,zakat:9});
    await owner.withTenant(admin,async tx=>{
      const [posted]=await tx.execute<{value:{alreadyPosted:boolean}}>(sql`select app.reward_post_native(${unitId}::uuid,${revision},${batch.batchId}::uuid)as value`);expect(posted.value).toEqual({alreadyPosted:false});await tx.execute(sql`set constraints all immediate`);
      const [proof]=await tx.execute<{completed:number;receipts:number}>(sql`select count(*)::integer as completed,(select count(*)::integer from app.reward_post_native_receipt r join app.reward_post_native_context c on c.id=r.context_id where c.xact_id=pg_current_xact_id()and c.unit_id=${unitId}::uuid)as receipts from app.reward_post_native_context where xact_id=pg_current_xact_id()and unit_id=${unitId}::uuid and completed and not active`);expect(proof.completed).toBe(1);expect(proof.receipts).toBeGreaterThanOrEqual(5);
    });
    const after=await view();expect(after.unit.status).toBe('posted');const [input]=await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batch.batchId));expect(input).toMatchObject({overtimeAmount:'123.00',bonusAmount:(55+(before.rows[0].bonusCents+before.rows[0].lumpCents)/100).toFixed(2),tp1Deduction:'44.00',zakat:'9.00'});
    const compensation=await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId,employmentId));expect(compensation.filter(row=>row.validTo===null&&row.supersededAt===null).map(row=>row.basicSalary)).toEqual([(before.rows[0].newBasicCents/100).toFixed(2)]);
    await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_post_native(${unitId}::uuid,${revision},${batch.batchId}::uuid)`))).rejects.toThrow();expect(await postRewardUnit(admin,unitId,revision,batch.batchId)).toEqual({alreadyPosted:true});
  });
  it.each([false,true])('rechecks private completed posting after an early constraint flush and later authority mutation (restore=%s)',async restore=>{
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)}),before=await view(),salaries=await owner.db.select().from(schema.compensation),inputs=await owner.db.select().from(schema.payrollInput),events=await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id),[role]=await owner.db.select().from(schema.roleAssignment).where(and(eq(schema.roleAssignment.appUserId,admin.userId!),eq(schema.roleAssignment.role,'hr_admin')));expect(role).toBeTruthy();let flushed=false,didRestore=false,refusal:unknown;
    try{await owner.withTenant(admin,async tx=>{
      await tx.execute(sql`select app.reward_post_native(${unitId}::uuid,${revision},${batch.batchId}::uuid)`);await tx.execute(sql`set constraints all immediate`);flushed=true;
      if(restore)await tx.execute(sql`set constraints app.rewards_post_native_effect,app.rewards_post_native_completed deferred`);
      await tx.execute(sql`update role_assignment set role='manager'where id=${role.id}::uuid`);
      if(restore){await tx.execute(sql`update role_assignment set role='hr_admin'where id=${role.id}::uuid`);didRestore=true;}
    });}catch(error){refusal=error;}
    expect(flushed).toBe(true);expect(didRestore).toBe(restore);expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'Reward posting authority changed'}));expect(await view()).toEqual(before);expect(await owner.db.select().from(schema.compensation)).toEqual(salaries);expect(await owner.db.select().from(schema.payrollInput)).toEqual(inputs);expect(await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id)).toEqual(events);
    await owner.withTenant(admin,tx=>tx.execute(sql`select app.reward_post_native(${unitId}::uuid,${revision},${batch.batchId}::uuid)`));expect((await view()).unit.status).toBe('posted');
  });
  it('rolls back an orphan private salary construction instead of committing a partial Rewards posting',async()=>{
    // Owner inspection proves construction/rollback only. Actual app financial guard positivity
    // must use the future reviewed finite port's real ACL; no fixture grants or fake bridge.
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)}),before=await view(),compensation=await owner.db.select().from(schema.compensation),events=await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id);let constructed=false;
    await expect(owner.withTenant(admin,async tx=>{
      const [context]=await tx.execute<{id:string}>(sql`select app.reward_post_context_begin(${unitId}::uuid,${revision},${batch.batchId}::uuid)as id`);expect(context.id).toBeTruthy();
      const [changed]=await tx.execute<{id:string}>(sql`select app.reward_post_salary(${context.id}::uuid,${before.rows[0].id}::uuid)as id`);expect(changed.id).toBeTruthy();
      const [created]=await tx.select().from(schema.compensation).where(eq(schema.compensation.id,changed.id));expect(created).toMatchObject({employmentId,basicSalary:(before.rows[0].newBasicCents/100).toFixed(2),currency:'MYR',remarks:`Approved Reward Desk review ${unitId}`,validFrom:today,validTo:null});
      const [audit]=await tx.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,changed.id),eq(schema.domainEvent.eventType,'compensation.set')));expect(audit).toMatchObject({actorType:'user',actorId:admin.userId,subjectEmploymentId:employmentId,payload:{employmentId,effectiveFrom:today,fieldsChanged:['basicSalary','remarks']}});constructed=true;
    })).rejects.toThrow('Reward posting construction is incomplete');
    expect(constructed).toBe(true);expect(await view()).toEqual(before);expect(await owner.db.select().from(schema.compensation)).toEqual(compensation);expect(await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id)).toEqual(events);
    for(const query of [sql`select app.reward_post_context_begin(${unitId}::uuid,${revision},${batch.batchId}::uuid)`,sql`select app.reward_post_salary(${unitId}::uuid,${before.rows[0].id}::uuid)`])await expect(withTenant(admin,tx=>tx.execute(query))).rejects.toThrow();
  });
  it('rolls back an orphan private bonus construction while preserving native OT and TP1 metadata in its intermediate row',async()=>{
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)}),before=await view();
    await setPayrollInput(admin,{batchId:batch.batchId,employmentId,overtimeAmount:123,bonusAmount:55,tp1Deduction:44,zakat:9,otBreakdown:{flat:23,normal:100,rest:0,holiday:0}});
    const [original]=await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batch.batchId)),events=await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id);let constructed=false;
    await expect(owner.withTenant(admin,async tx=>{
      const [context]=await tx.execute<{id:string}>(sql`select app.reward_post_context_begin(${unitId}::uuid,${revision},${batch.batchId}::uuid)as id`),[changed]=await tx.execute<{id:string}>(sql`select app.reward_post_input(${context.id}::uuid,${before.rows[0].id}::uuid)as id`);
      expect(changed.id).toBe(original.id);const [input]=await tx.select().from(schema.payrollInput).where(eq(schema.payrollInput.id,changed.id));expect(input).toMatchObject({overtimeAmount:original.overtimeAmount,bonusAmount:(55+(before.rows[0].bonusCents+before.rows[0].lumpCents)/100).toFixed(2),tp1Deduction:original.tp1Deduction,zakat:original.zakat,otBreakdown:original.otBreakdown,otSource:original.otSource,tp1Source:original.tp1Source,otDerivation:original.otDerivation});
      const audits=await tx.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,batch.batchId),eq(schema.domainEvent.eventType,'payroll-batch.input-set'))).orderBy(schema.domainEvent.sequence);expect(audits.at(-1)).toMatchObject({actorType:'user',actorId:admin.userId,payload:{employmentId,payrollInputId:original.id,fieldsChanged:['overtimeAmount','bonusAmount','tp1Deduction','zakat']}});constructed=true;
    })).rejects.toThrow('Reward posting construction is incomplete');
    expect(constructed).toBe(true);expect(await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.id,original.id))).toEqual([original]);expect(await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id)).toEqual(events);expect(await view()).toEqual(before);
    for(const name of ['reward_post_grade','reward_post_input'])await expect(withTenant(admin,tx=>tx.execute(sql`select ${sql.raw('app.'+name)}(${unitId}::uuid,${before.rows[0].id}::uuid)`))).rejects.toThrow();
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
    await expectPgRefusal(prepare(), '42501', 'Salary data changed after the snapshot. Return and refresh the review.');await expect(postRewardUnit(admin,unitId,revision,batch.batchId)).rejects.toThrow('Salary data changed');expect((await view()).unit.status).toBe('approved');expect(await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batch.batchId))).toEqual(inputs);
  });
  it('preserves the original native NaN payroll carry behavior in private source preparation',async()=>{
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)});
    await setPayrollInput(admin,{batchId:batch.batchId,employmentId,overtimeAmount:123,bonusAmount:55,tp1Deduction:44,zakat:9});
    // Historical raw numeric NaN is deliberately fixture-owned, not admitted through a new grant.
    await owner.db.execute(sql`update payroll_input set overtime_amount='NaN'::numeric,bonus_amount='NaN'::numeric,tp1_deduction='NaN'::numeric where batch_id=${batch.batchId}::uuid and employment_id=${employmentId}::uuid`);
    const [plan]=await owner.withTenant(admin,tx=>tx.execute<{value:{sourcePlan:{newBonusAmount:string}[]}}>(sql`select app.reward_post_sources(${unitId}::uuid,${revision},${batch.batchId}::uuid)as value`));expect(plan.value.sourcePlan[0].newBonusAmount).toBe('0.00');
    await postRewardUnit(admin,unitId,revision,batch.batchId);const [input]=await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batch.batchId));expect(input).toMatchObject({overtimeAmount:'0.00',bonusAmount:'0.00',tp1Deduction:'0.00',zakat:'9.00'});
  });
  it('retains the canonical salary carry refusal for a nonfinite legacy monthly allowance',async()=>{
    const revision=await approve(),batch=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)});
    await owner.db.execute(sql`update compensation set monthly_allowance='NaN'::numeric where employment_id=${employmentId}::uuid and valid_to is null and superseded_at is null`);
    const before=await view(),salaries=await owner.db.select().from(schema.compensation),events=await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id);
    await expectPgRefusal(owner.withTenant(admin,async tx=>{const [context]=await tx.execute<{id:string}>(sql`select app.reward_post_context_begin(${unitId}::uuid,${revision},${batch.batchId}::uuid)as id`);await tx.execute(sql`select app.reward_post_salary(${context.id}::uuid,${before.rows[0].id}::uuid)`);}), '22003', 'Monthly allowance must be a number — a blank or unparseable amount cannot be stored on a salary record');
    await expect(postRewardUnit(admin,unitId,revision,batch.batchId)).rejects.toThrow('Monthly allowance must be a number');expect(await view()).toEqual(before);expect(await owner.db.select().from(schema.compensation)).toEqual(salaries);expect(await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id)).toEqual(events);
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
  it.each([9,10,4000,4001])('matches the original cancellation transaction code-point boundary at %i emoji',async length=>{
    const before=await view(),reason='  '+'😀'.repeat(length)+'  ',accepted=length>=10&&length<=4000,rollback=new Error('Native cancellation boundary rollback');
    let nativeError:unknown;
    try{await withTenant(admin,async tx=>{await cancelRewardReviewTx(tx,admin,unitId,before.unit.revision,reason);throw rollback;});}catch(error){nativeError=error;}
    if(accepted)expect(nativeError).toBe(rollback);
    else expect(nativeError).toMatchObject({name:'ZodError',issues:expect.arrayContaining([expect.objectContaining({code:length<10?'too_small':'too_big'})])});
    let admissionError:unknown;
    try{await owner.withTenant(admin,async tx=>{const [row]=await tx.execute<{value:{reason:string}}>(sql`select app.reward_cancel_admission(${unitId}::uuid,${before.unit.revision},${reason})as value`);expect(row.value.reason).toBe(reason.trim());throw rollback;});}catch(error){admissionError=error;}
    if(accepted)expect(admissionError).toBe(rollback);
    else expect(pgErrorChain(admissionError)).toContainEqual(expect.objectContaining({code:length<10?'42501':'22023'}));
    expect((await view()).unit).toEqual(before.unit);expect((await view()).rows).toEqual(before.rows);
    expect(await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId))).toEqual([]);
    expect(await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,unitId),eq(schema.domainEvent.eventType,'reward-unit.cancelled')))).toEqual([]);
  });
  it.each(['assigned','administration']as const)('privately preserves the original actor-only cancellation %s course and exact audit',async course=>{
    let actor=admin;
    if(course==='administration'){
      const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Actual no-seat cancellation administrator',primaryEmail:'cancel-administrator@rewards.test'}).returning();
      actor={...admin,userId:await createAppUser(b.tenantId,person.id,'hr_admin'),personId:person.id,roles:['hr_admin'],grants:undefined};
    }
    const before=await view(),why='Actual independently reviewed cancellation';let originalAfter:typeof before.unit|undefined,originalReceipt:Awaited<ReturnType<typeof cancelRewardReviewTx>>|undefined;const rollback=new Error('Original cancellation oracle rollback');
    try{await withTenant(actor,async tx=>{originalReceipt=await cancelRewardReviewTx(tx,actor,unitId,before.unit.revision,why);[originalAfter]=await tx.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId));throw rollback;});}catch(error){expect(error).toBe(rollback);}
    expect(originalReceipt).toMatchObject({unitId,cancelledRevision:before.unit.revision,currentRevision:before.unit.revision+1,status:'withdrawn'});expect(originalAfter).toBeDefined();expect((await view()).unit).toEqual(before.unit);
    await owner.withTenant(actor,async tx=>{const [result]=await tx.execute<{value:unknown}>(sql`select app.reward_cancel_native(${unitId}::uuid,${before.unit.revision},${why})as value`);expect(result.value).toEqual({unitId,eventId:expect.any(String),cancelledRevision:before.unit.revision,currentRevision:before.unit.revision+1,status:'withdrawn'});await tx.execute(sql`set constraints all immediate`);const [proof]=await tx.execute<{course:string}>(sql`select admission->>'course'as course from app.reward_cancel_native_effect where unit_id=${unitId}::uuid and xact_id=pg_current_xact_id()and completed and not active`);expect(proof.course).toBe(course);});
    const after=await view(),[afterRow]=await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId));expect(afterRow).toBeDefined();const stripTime=(unit:typeof schema.rewardUnit.$inferSelect)=>{const {updatedAt:_time,...rest}=unit;return rest;};expect(stripTime(afterRow!)).toEqual(stripTime(originalAfter!));expect(after.rows).toEqual(before.rows);
    const decisions=await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId));
    if(course==='assigned'){expect(decisions).toHaveLength(1);expect(decisions[0]).toMatchObject({actorId:actor.userId,action:'withdraw',fromStage:'draft',toStage:'withdrawn',reason:why,revision:before.unit.revision});}else expect(decisions).toEqual([]);
    const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,unitId),eq(schema.domainEvent.eventType,'reward-unit.cancelled')));expect(events).toHaveLength(1);expect(events[0]).toMatchObject({actorId:actor.userId,actorType:'user',subjectEmploymentId:null,payload:{fromStage:'draft',reason:why,revision:before.unit.revision,before:{status:'draft',revision:before.unit.revision},after:{status:'withdrawn',revision:before.unit.revision+1}}});const payload=events[0].payload;expect(payload).toBeTypeOf('object');if(payload===null||typeof payload!=='object'||Array.isArray(payload))throw new Error('Native cancellation audit payload must be an object');expect(Object.keys(payload).sort()).toEqual(['after','before','cancelRowHash','fromStage','reason','revision']);
    await expect(withTenant(actor,tx=>tx.execute(sql`select app.reward_cancel_command(${unitId}::uuid,${before.unit.revision},${why})`))).rejects.toThrow();
  });
  it('preserves original native unit invisibility before definer configuration governance or cancellation errors',async()=>{
    const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Actual unrelated employee account',primaryEmail:'unrelated-unit@rewards.test'}).returning();
    const outsider={...admin,userId:await createAppUser(b.tenantId,person.id,'employee'),personId:person.id,roles:['employee']as SessionContext['roles'],grants:undefined};
    await expect(getRewardConfiguration(outsider,unitId)).rejects.toThrow('Reward unit not found or access has been removed.');
    for(const source of [sql`select app.reward_configuration_review(${unitId}::uuid)`,sql`select app.reward_governance_review(${unitId}::uuid)`,sql`select app.reward_cancel_admission(${unitId}::uuid,${(await view()).unit.revision},'A real cancellation source must remain private')`]){
      let refusal:unknown;try{await owner.withTenant(outsider,tx=>tx.execute(source));}catch(error){refusal=error;}
      expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'Reward unit not found or access has been removed.'}));
    }
    for(const query of [sql`select app.reward_configuration_review(${unitId}::uuid)`,sql`select app.reward_governance_review(${unitId}::uuid)`]) {
      await expectPgRefusal(withTenant(outsider,tx=>tx.execute(query)), '42501', 'Reward unit not found or access has been removed.');
    }
    expect(await owner.withTenant(outsider,tx=>tx.execute(sql`select app.reward_unit_native_readable(${unitId}::uuid)as readable`))).toEqual([{readable:false}]);
  });
  it.each(['save','facts']as const)('matches the original native %s effects and fixed audit without a budget-submit gate',async course=>{
    const before=await view(),entry=before.rows[0],rec={...entry.recommendation,meritBp:100000,reason:'  '+'😀'.repeat(4000)+'  '},facts={...entry.facts,talent:'STAR' as const,segment:'  '+'😀'.repeat(80)+'  '},rollback=new Error('Original native entry effect rollback');
    const [beforeRaw]=await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId)),beforeEvents=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId));let originalEntry:typeof schema.rewardEntry.$inferSelect|undefined,originalUnit:typeof schema.rewardUnit.$inferSelect|undefined,originalEvent:typeof schema.domainEvent.$inferSelect|undefined;
    try{await withTenant(admin,async tx=>{if(course==='save')await saveRewardEntryTx(tx,admin,unitId,before.unit.revision,entry.id,rec,facts);else await importRewardFactsTx(tx,admin,unitId,before.unit.revision,[{employmentId,facts}]);[originalEntry]=await tx.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.id,entry.id));[originalUnit]=await tx.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId));originalEvent=(await tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId))).find(event=>!beforeEvents.some(old=>old.id===event.id));throw rollback;});}catch(error){expect(error).toBe(rollback);}
    expect(originalEntry).toBeDefined();expect(originalUnit).toBeDefined();expect(originalEvent).toBeDefined();expect((await view()).unit).toEqual(before.unit);
    await owner.withTenant(admin,async tx=>{await tx.execute(sql`set constraints all immediate`);if(course==='save')await tx.execute(sql`select app.reward_entry_save_command(${unitId}::uuid,${before.unit.revision},${entry.id}::uuid,${JSON.stringify(rec)}::jsonb,${JSON.stringify(facts)}::jsonb)`);else await tx.execute(sql`select app.reward_facts_import_command(${unitId}::uuid,${before.unit.revision},${JSON.stringify([{employmentId,facts}])}::jsonb)`);const [proof]=await tx.execute<{course:string;closed:boolean;receipts:number}>(sql`select e.course,app.reward_unit_native_chain_closed('entry',e.id)as closed,(select count(*)::integer from app.reward_entry_native_receipt r where r.effect_id=e.id)as receipts from app.reward_entry_native_effect e where e.unit_id=${unitId}::uuid and e.xact_id=pg_current_xact_id()and e.completed and not e.active`);expect(proof).toEqual({course,closed:true,receipts:2});});
    const [afterEntry]=await owner.db.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.id,entry.id)),[afterUnit]=await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId));const stripTime=<T extends{updatedAt:unknown}>(row:T)=>{const{updatedAt:_time,...rest}=row;return rest;};expect(stripTime(afterEntry)).toEqual(stripTime(originalEntry!));expect(stripTime(afterUnit)).toEqual(stripTime(originalUnit!));expect(afterUnit.revision).toBe(beforeRaw.revision+1);expect(afterUnit.status).toBe('draft');
    const afterEvents=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId)),created=afterEvents.filter(event=>!beforeEvents.some(old=>old.id===event.id));expect(created).toHaveLength(1);const audit=(event:typeof schema.domainEvent.$inferSelect)=>({tenantId:event.tenantId,aggregateType:event.aggregateType,aggregateId:event.aggregateId,eventType:event.eventType,actorType:event.actorType,actorId:event.actorId,subjectEmploymentId:event.subjectEmploymentId,payload:event.payload});expect(audit(created[0])).toEqual(audit(originalEvent!));
    if(course==='save')expect((await view()).flags.some(flag=>flag.severity==='block')).toBe(true);
    await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_entry_save_command(${unitId}::uuid,${afterUnit.revision},${entry.id}::uuid,${JSON.stringify(rec)}::jsonb)`))).rejects.toThrow();await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_facts_import_command(${unitId}::uuid,${afterUnit.revision},${JSON.stringify([{employmentId,facts}])}::jsonb)`))).rejects.toThrow();
  });
  it('routes published entry and facts commands through the fixed SQL ports',async()=>{
    const before=await view(),entry=before.rows[0],entryEdit='function.rewards.entries.edit',factsEdit='function.rewards.facts.edit';
    const recommendation={...entry.recommendation,reason:'Reviewed entry command'};
    const facts={...entry.facts,talent:'STAR' as const};
    try{
      await expectPgRefusal(withTenant(admin,tx=>tx.execute(sql`select app.reward_save_entry(
        ${unitId}::uuid,${before.unit.revision},${entry.id}::uuid,${JSON.stringify(recommendation)}::jsonb)`)),
        '42501','Reward entry command unavailable');
      await owner.client`insert into app.access_native_capability_default(capability_id,parity_function,current_parity_function)
        select id,'app.rewards_function_legacy_allowed','app.rewards_function_current_legacy_allowed'
        from access_capability where id in (${entryEdit},${factsEdit})`;
      await owner.client`update access_capability set supported=true where id in (${entryEdit},${factsEdit})`;
      await saveRewardEntry(admin,unitId,before.unit.revision,entry.id,recommendation);
      const effect=(course:string)=>owner.client`select course from app.reward_entry_native_effect where unit_id=${unitId}::uuid and completed and course=${course}`;
      expect(await effect('save')).toEqual([{course:'save'}]);
      const saved=await view();
      expect(saved.rows[0].recommendation).toEqual(recommendation);
      await importRewardFacts(admin,unitId,saved.unit.revision,[{employmentId,facts}]);
      const imported=await view();
      expect(imported.rows[0].facts).toEqual(facts);
      expect(imported.unit.revision).toBe(before.unit.revision+2);
      expect(await effect('facts')).toEqual([{course:'facts'}]);
    }finally{
      await owner.client`update access_capability set supported=false where id in (${entryEdit},${factsEdit})`;
      await owner.client`delete from app.access_native_capability_default where capability_id in (${entryEdit},${factsEdit})`;
    }
  });
  it('enforces exact entry and decision denials on direct writes while leaving review readable',async()=>{
    const before=await view(),entry=before.rows[0];
    const entryEdit='function.rewards.entries.edit',submit='function.rewards.decisions.submit.execute';
    try{
      await owner.client`update access_capability set supported=true where id in (${entryEdit},${submit})`;
      await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,effect) values
        (${b.tenantId}::uuid,${admin.userId!}::uuid,${entryEdit},'deny'),
        (${b.tenantId}::uuid,${actors.bu!.userId!}::uuid,${submit},'deny')`;
      await expectPgRefusal(withTenant(admin,tx=>tx.execute(sql`update reward_entry
        set recommendation=jsonb_set(recommendation,'{reason}',to_jsonb('Denied direct edit'::text))
        where id=${entry.id}::uuid`)),'42501','Reward entry editing unavailable');
      await expectPgRefusal(withTenant(actors.bu!,tx=>tx.execute(sql`update reward_unit set status='bg'
        where id=${unitId}::uuid`)),'42501','Reward review transition unavailable');
      expect((await view()).rows).toEqual(before.rows);
      expect((await view()).unit).toEqual(before.unit);
    }finally{
      await owner.client`update access_capability set supported=false where id in (${entryEdit},${submit})`;
    }
  });
  it('preserves the BU narrow case-facts course and refuses proposed classification or Senior selection changes',async()=>{
    const before=await view(),entry=before.rows[0],rec={...entry.recommendation,reason:'Actual BU recommendation'},facts={...entry.facts,erDecision:'in' as const,caseReason:'Actual BU employee relations decision'};
    await owner.withTenant(actors.bu!,async tx=>{await tx.execute(sql`select app.reward_entry_save_command(${unitId}::uuid,${before.unit.revision},${entry.id}::uuid,${JSON.stringify(rec)}::jsonb,${JSON.stringify(facts)}::jsonb)`);await tx.execute(sql`set constraints all immediate`);});const saved=await view();expect(saved.rows[0].facts).toEqual(facts);expect(saved.rows[0].recommendation).toEqual(rec);
    for(const proposed of [{...facts,talent:'STAR'},{...facts,seniorPlan:!facts.seniorPlan},{...facts,confidentiality:'ec'}]){await expect(saveRewardEntry(actors.bu!,unitId,saved.unit.revision,entry.id,rec,proposed)).rejects.toThrow();let refusal:unknown;try{await owner.withTenant(actors.bu!,tx=>tx.execute(sql`select app.reward_entry_save_command(${unitId}::uuid,${saved.unit.revision},${entry.id}::uuid,${JSON.stringify(rec)}::jsonb,${JSON.stringify(proposed)}::jsonb)`));}catch(error){refusal=error;}expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501'}));expect((await view()).unit).toEqual(saved.unit);expect((await view()).rows).toEqual(saved.rows);}
  });
  it('admits all facts targets before writing and rejects duplicate, unavailable, nonGR and raw-agent courses atomically',async()=>{
    const before=await view(),facts={...before.rows[0].facts,talent:'STAR' as const},events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId));
    for(const rows of [[{employmentId,facts},{employmentId,facts}],[{employmentId,facts},{employmentId:'00000000-0000-4000-8000-000000000099',facts}]]){await expect(importRewardFacts(admin,unitId,before.unit.revision,rows)).rejects.toThrow();let refusal:unknown;try{await owner.withTenant(admin,tx=>tx.execute(sql`select app.reward_facts_import_command(${unitId}::uuid,${before.unit.revision},${JSON.stringify(rows)}::jsonb)`));}catch(error){refusal=error;}expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501'}));expect((await view()).unit).toEqual(before.unit);expect((await view()).rows).toEqual(before.rows);}
    for(const actor of [actors.bu!,actors.pbp!])for(const target of [employmentId,'00000000-0000-4000-8000-000000000099']){let refusal:unknown;try{await owner.withTenant(actor,tx=>tx.execute(sql`select app.reward_facts_import_command(${unitId}::uuid,${before.unit.revision},${JSON.stringify([{employmentId:target,facts}])}::jsonb)`));}catch(error){refusal=error;}expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'Only Group Rewards may import ratings and classifications.'}));}
    for(const stamp of ['not-a-uuid','00000000-0000-4000-8000-000000000077']){let refusal:unknown;try{await owner.withTenant(admin,async tx=>{await tx.execute(sql`select set_config('app.agent_principal_id',${stamp},true)`);await tx.execute(sql`select app.reward_entry_save_command(${unitId}::uuid,${before.unit.revision},${before.rows[0].id}::uuid,${JSON.stringify(before.rows[0].recommendation)}::jsonb)`);});}catch(error){refusal=error;}expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'A current human Rewards principal is required'}));}expect((await view()).unit).toEqual(before.unit);expect((await view()).rows).toEqual(before.rows);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId))).toEqual(events);
  });
  it.each([false,true])('requeues the exact entry source after an unsealed later write (early flush: %s)',async immediate=>{
    const before=await view(),entry=before.rows[0],events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId));let refusal:unknown;
    try{await owner.withTenant(admin,async tx=>{await tx.execute(sql`select app.reward_entry_save_command(${unitId}::uuid,${before.unit.revision},${entry.id}::uuid,${JSON.stringify({...entry.recommendation,reason:'Actual sealed entry change'})}::jsonb)`);if(immediate)await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`update reward_entry set facts=jsonb_set(facts,'{branch}','"Unsealed later change"')where id=${entry.id}::uuid`);await tx.execute(sql`set constraints all immediate`);});}catch(error){refusal=error;}expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'Reward entry terminal source changed'}));expect((await view()).unit).toEqual(before.unit);expect((await view()).rows).toEqual(before.rows);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId))).toEqual(events);
  });
  it.each([false,true])('rechecks completed entry effects after authority revoke/restore (early flush: %s)',async immediate=>{
    const before=await view(),entry=before.rows[0],events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId));let refusal:unknown,restored=false;
    try{await owner.withTenant(admin,async tx=>{await tx.execute(sql`select app.reward_entry_save_command(${unitId}::uuid,${before.unit.revision},${entry.id}::uuid,${JSON.stringify({...entry.recommendation,reason:'Actual private entry edit'})}::jsonb)`);if(immediate){await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`set constraints app.rewards_entry_native_effect deferred`);}await tx.execute(sql`update reward_member set role='pbp'where unit_id=${unitId}::uuid and user_id=${admin.userId!}::uuid and role='gr'`);await tx.execute(sql`update reward_member set role='gr'where unit_id=${unitId}::uuid and user_id=${admin.userId!}::uuid and role='pbp'`);restored=true;await tx.execute(sql`set constraints all immediate`);});}catch(error){refusal=error;}expect(restored).toBe(true);expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501'}));expect((await view()).unit).toEqual(before.unit);expect((await view()).rows).toEqual(before.rows);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId))).toEqual(events);
  });
  it('derives separate entry and facts View/Edit defaults from actual native memberships in pure and current contexts',async()=>{
    for(const role of ['gr','bu','bg','ctro','ec','pbp']as const)await owner.withTenant(actors[role]!,async tx=>{for(const key of ['rewards.entries','rewards.facts'])for(const operation of ['view','edit']){const cap=`function.${key}.${operation}`,[row]=await tx.execute<{pure:boolean;current:boolean}>(sql`select app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actors[role]!.userId!}::uuid,${cap},${b.companyId}::uuid)as pure,app.rewards_function_current_legacy_allowed(${b.tenantId}::uuid,${actors[role]!.userId!}::uuid,${cap},${b.companyId}::uuid)as current`);const allowed=key==='rewards.facts'?role==='gr':role==='gr'||role==='bu';expect({role,key,operation,...row}).toEqual({role,key,operation,pure:allowed,current:allowed});}const [unknown]=await tx.execute<{allowed:boolean}>(sql`select app.rewards_function_legacy_allowed(${b.tenantId}::uuid,${actors[role]!.userId!}::uuid,'function.rewards.entries.execute',${b.companyId}::uuid)as allowed`);expect(unknown.allowed).toBe(false);});
  });
  it('prepares an exact private entry-save source against the independent actual native writer',async()=>{
    const before=await view(),entry=before.rows[0],recommendation={...entry.recommendation,reason:'  Actual independently reviewed recommendation  '},facts={...entry.facts,reviewed:true};
    await saveRewardEntry(admin,unitId,before.unit.revision,entry.id,recommendation,facts);
    const saved=await view();expect(saved.unit.revision).toBe(before.unit.revision+1);
    const [after]=await owner.db.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.id,entry.id));expect(after).toBeDefined();
    await owner.withTenant(admin,async tx=>{const [prepared]=await tx.execute<{value:{unitBefore:{revision:number};recommendation:unknown;facts:unknown;authorityStamp:string}}>(sql`select app.reward_entry_save_admission(${unitId}::uuid,${saved.unit.revision},${entry.id}::uuid,${JSON.stringify(recommendation)}::jsonb,${JSON.stringify(facts)}::jsonb)as value`);expect(prepared.value.unitBefore.revision).toBe(saved.unit.revision);expect(prepared.value.recommendation).toEqual(after.recommendation);expect(prepared.value.facts).toEqual(after.facts);expect(prepared.value.authorityStamp).toMatch(/^[a-f0-9]{64}$/);});
    expect((await view()).unit).toEqual(saved.unit);expect((await view()).rows).toEqual(saved.rows);
    await expect(withTenant(admin,tx=>tx.execute(sql`select app.reward_entry_save_admission(${unitId}::uuid,${saved.unit.revision},${entry.id}::uuid,${JSON.stringify(recommendation)}::jsonb,${JSON.stringify(facts)}::jsonb)`))).rejects.toThrow();
    const changedSelection={...facts,seniorPlan:!facts.seniorPlan};await expect(saveRewardEntry(admin,unitId,saved.unit.revision,entry.id,recommendation,changedSelection)).rejects.toThrow('checked Senior membership workflow');await expectPgRefusal(owner.withTenant(admin,tx=>tx.execute(sql`select app.reward_entry_save_admission(${unitId}::uuid,${saved.unit.revision},${entry.id}::uuid,${JSON.stringify(recommendation)}::jsonb,${JSON.stringify(changedSelection)}::jsonb)`)), '42501', 'Use the checked Senior membership workflow to change selection.');expect((await view()).unit).toEqual(saved.unit);expect((await view()).rows).toEqual(saved.rows);
  });
  it('refuses non-GR participants and any raw agent stamp at the private cancellation admission',async()=>{
    const before=await view();
    let participant:unknown;try{await owner.withTenant(actors.bu!,tx=>tx.execute(sql`select app.reward_cancel_admission(${unitId}::uuid,${before.unit.revision},'Actual cancelled unit request')`));}catch(error){participant=error;}
    expect(pgErrorChain(participant)).toContainEqual(expect.objectContaining({code:'42501',message:'Only the company Rewards administrator or Group Rewards may cancel this review.'}));
    for(const value of ['not-a-uuid','00000000-0000-4000-8000-000000000077']){let refusal:unknown;try{await owner.withTenant(admin,async tx=>{await tx.execute(sql`select set_config('app.agent_principal_id',${value},true)`);await tx.execute(sql`select app.reward_cancel_native(${unitId}::uuid,${before.unit.revision},'An actual human cancellation request')`);});}catch(error){refusal=error;}expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'A current human Rewards principal is required'}));}
    expect((await view()).unit).toEqual(before.unit);expect(await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId))).toEqual([]);
  });
  it.each([false,true])('revalidates an early-flushed cancellation after authority revoke (restore=%s)',async restore=>{
    const before=await view(),decisions=await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId)),events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId));let restored=false;let refusal:unknown;
    try{await owner.withTenant(admin,async tx=>{await tx.execute(sql`select app.reward_cancel_native(${unitId}::uuid,${before.unit.revision},'Actual cancellation authority rollback')`);await tx.execute(sql`set constraints all immediate`);if(restore)await tx.execute(sql`set constraints app.rewards_cancel_native_effect deferred`);await tx.execute(sql`update role_assignment set role='manager'where tenant_id=${b.tenantId}::uuid and app_user_id=${admin.userId!}::uuid and role='hr_admin'`);if(restore){await tx.execute(sql`update role_assignment set role='hr_admin'where tenant_id=${b.tenantId}::uuid and app_user_id=${admin.userId!}::uuid and role='manager'`);restored=true;}});}catch(error){refusal=error;}
    expect(pgErrorChain(refusal)).toContainEqual(expect.objectContaining({code:'42501',message:'Reward cancellation authority changed'}));expect(restored).toBe(restore);expect((await view()).unit).toEqual(before.unit);expect(await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId))).toEqual(decisions);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,unitId))).toEqual(events);
  });
  it('privately performs one actual native decision with its exact actor, physical effects and audit under a savepoint',async()=>{
    const before=await view(),why='Actual private native decision reviewed';
    const [registered]=await owner.db.execute<{capability_id:string;parent_capability:string|null;delegation_floor_function:string|null}>(sql`select capability_id,parent_capability,delegation_floor_function from app.access_function_action where function_key='rewards.decisions.submit'and operation='execute'`);
    expect(registered).toEqual({capability_id:'function.rewards.decisions.submit.execute',parent_capability:null,delegation_floor_function:'app.rewards_function_legacy_allowed'});
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
