/** Attribute Rewards Set-up read time using the same fictional review as the browser suite. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';

const env = process.env;
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_JOB==='selected-tests');
assert(env.PERF_HTTP_SUITE==='whole-system'&&env.AUTH_PROVIDER==='internal');
assert.equal(env.DATABASE_URL,'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
assert.equal(env.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');

async function source(file) {
  const loaded = await import(pathToFileURL(resolve(file)).href);
  return {...loaded.default,...loaded};
}

const fixture = JSON.parse(readFileSync(join(env.PERF_PRIVATE_DIR,'fixture.json'),'utf8'));
const [tenant] = fixture.tenants;
const user = fixture.users.find(actor => actor.tenant===0&&actor.role==='groupHR');
const unitId = tenant.rewardDraft?.unitId;
assert(fixture.users.length===500&&fixture.tenants.length===2&&unitId&&user?.tenantId===tenant.tenantId);
const [{client,createDb},{resolveEntitlementsTx},rewards] = await Promise.all([
  source('db/client.ts'),source('core/entitlements.ts'),source('packs/rewards/service.ts'),
]);
const owner = createDb(env.MIGRATION_DATABASE_URL,{max:1});
try {
  const grants = await owner.client`
    select role,company_id as "companyId" from role_assignment
    where tenant_id=${tenant.tenantId}::uuid and app_user_id=${user.userId}::uuid
  `;
  assert(grants.some(grant => grant.role==='hr_admin'&&grant.companyId===null));
  const ctx = {tenantId:user.tenantId,userId:user.userId,personId:user.personId,
    grants:grants.map(({role,companyId})=>({role,companyId})),roles:[...new Set(grants.map(grant=>grant.role))],
    entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,user.tenantId))};
  const owners = [
    ['preparationStatus',()=>rewards.getRewardPreparationStatus(ctx,unitId),value=>value.setupVisible&&value.isGr],
    ['preparationChecklist',()=>rewards.getRewardPreparationChecklist(ctx,unitId),
      value=>value.unitId===unitId&&value.access.setupVisible&&value.access.isGr&&Boolean(value.checks)],
    ['fullReview',()=>rewards.getRewardUnit(ctx,unitId),value=>value.unit.id===unitId&&value.rows.length>0],
    ['unitGovernance',()=>rewards.getRewardUnitGovernance(ctx,unitId),value=>value.unitId===unitId&&value.available&&value.isGr],
    ['seniorMembership',()=>rewards.getRewardSeniorMembership(ctx,unitId),value=>value.unitId===unitId&&value.canEdit],
  ];
  const rows = Object.fromEntries(owners.map(([name])=>[name,[]]));
  for (let pass=0;pass<4;pass++) {
    const order=pass%2===0?owners:[...owners].reverse();
    for (const [name,read,verify] of order) {
      const started=performance.now();
      const value=await read();
      rows[name].push(Math.round(performance.now()-started));
      assert(verify(value),'The native '+name+' owner did not admit the configured review');
    }
  }
  writeFileSync(join(env.PERF_PRIVATE_DIR,'rewards-setup-owner-profile.json'),JSON.stringify({
    scope:'Sequential native owner reads on the authenticated fictional review after the browser visits',
    samplesMs:rows,
  }),{mode:0o600});
} finally {
  await Promise.all([owner.client.end({timeout:5}),client.end({timeout:5})]);
}
