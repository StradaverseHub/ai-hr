// Authorized services on the same disposable fixture used for the Rewards browser comparison.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const env=process.env;
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_JOB==='selected-tests');
assert(env.PERF_HTTP_SUITE==='whole-system'&&env.AUTH_PROVIDER==='internal');
assert.equal(env.DATABASE_URL,'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
assert.equal(env.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');

const fixture=JSON.parse(readFileSync(resolve(env.PERF_PRIVATE_DIR,'fixture.json'),'utf8'));
const tenant=fixture.tenants[0],target=tenant.rewardDraft;
const group=fixture.users.find(actor=>actor.tenant===0&&actor.role==='groupHR');
assert(group?.tenantId===tenant.tenantId&&target?.unitId&&target.expectedEmploymentIds.length>0);
const source=file=>import(pathToFileURL(resolve(process.cwd(),file)).href);
const [{client,createDb},{resolveEntitlementsTx},rewards]=await Promise.all([
 source('db/client.ts'),source('core/entitlements.ts'),source('packs/rewards/service.ts'),
]);
const owner=createDb(env.MIGRATION_DATABASE_URL,{max:1});
const output=resolve(env.PERF_PRIVATE_DIR,'rewards-read-profile.json');
const report={rosterSize:target.expectedEmploymentIds.length,reads:[]};
const save=()=>writeFileSync(output,JSON.stringify(report),{mode:0o600});
const debug=client.options.debug;
try{
 const [principal]=await owner.client`select tenant_id,grants from app.principal(${group.userId}::uuid)`;
 assert(principal?.tenant_id===tenant.tenantId&&Array.isArray(principal.grants));
 assert(principal.grants.some(grant=>grant.role==='hr_admin'&&grant.companyId===null));
 const ctx={tenantId:tenant.tenantId,userId:group.userId,personId:group.personId,grants:principal.grants,
  roles:[...new Set(principal.grants.map(grant=>grant.role))],
  entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenant.tenantId))};
 const [draft]=await owner.client`select revision from reward_unit
  where id=${target.unitId}::uuid and tenant_id=${tenant.tenantId}::uuid and status='draft'`;
 assert(Number.isInteger(draft?.revision));
 const unitId=target.unitId;
 const reads=[
  ['preparation-status',()=>rewards.getRewardPreparationStatus(ctx,unitId),result=>result.setupVisible&&result.isGr],
  ['checklist',()=>rewards.getRewardPreparationChecklist(ctx,unitId),result=>result.canEdit&&result.revision===draft.revision&&Object.keys(result.checks??{}).length===6],
  ['refresh-preview',()=>rewards.previewRewardSourceRefresh(ctx,unitId,draft.revision,target.snapshotDate),result=>result.asOf===target.snapshotDate&&/^[a-f0-9]{64}$/.test(result.digest)],
  ['review-projection',()=>rewards.getRewardUnit(ctx,unitId),result=>result.cycle?.name===target.planName&&result.rows.length>0],
  ['unit-governance',()=>rewards.getRewardUnitGovernance(ctx,unitId),result=>result.isGr&&result.revision===draft.revision],
  ['senior-membership',()=>rewards.getRewardSeniorMembership(ctx,unitId),result=>result.canEdit&&result.revision===draft.revision],
 ];
 for(let pass=0;pass<6;pass++){
  for(const [phase,read,valid] of [...reads.slice(pass),...reads.slice(0,pass)]){
   const counts={statements:0,compensation:0,performanceReview:0,onehr:0,architecture:0};
   client.options.debug=(_connection,statement)=>{
    counts.statements++;
    if(/\bfrom\s+"compensation"/i.test(statement))counts.compensation++;
    if(/\bfrom\s+"performance_review"/i.test(statement))counts.performanceReview++;
    if(/\bapp\.reward_onehr_source\(/i.test(statement))counts.onehr++;
    if(/\bapp\.reward_architecture_for_source\(/i.test(statement))counts.architecture++;
   };
   const started=performance.now();
   try{
    const result=await read();
    assert(valid(result),'Unexpected Rewards read result');
    report.reads.push({phase,pass,elapsedMs:Math.round((performance.now()-started)*100)/100,...counts});
   }catch(error){
    report.reads.push({phase,pass,failure:error.code==='ERR_ASSERTION'?'assertion':'read'});
   }finally{
    client.options.debug=debug;
    save();
   }
  }
 }
 assert(report.reads.length===36&&report.reads.every(row=>!row.failure&&row.statements>0));
}finally{
 client.options.debug=debug;
 await Promise.all([client.end({timeout:5}),owner.client.end({timeout:5})]);
}
