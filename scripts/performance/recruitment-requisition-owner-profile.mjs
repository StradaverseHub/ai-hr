/** Time the exact requisition owners on the browser's fictional company scope. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const env=process.env;
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_JOB==='selected-tests');
assert(env.PERF_HTTP_SUITE==='browser-route-baseline'&&env.AUTH_PROVIDER==='internal');
assert.equal(env.DATABASE_URL,'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
assert.equal(env.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');

const source=file=>import(pathToFileURL(resolve(file)).href);
const [{client,createDb},{resolveEntitlementsTx},recruitment]=await Promise.all([
 source('db/client.ts'),source('core/entitlements.ts'),source('packs/recruitment/service.ts'),
]);
const file=name=>resolve(env.PERF_PRIVATE_DIR,name);
const fixture=JSON.parse(readFileSync(file('fixture.json'),'utf8'));
const data=fixture.recruitmentRecords;
const [group,company]=fixture.users;
assert(group.role==='groupHR'&&company.role==='companyHR'&&group.tenantId===company.tenantId);
assert(group.companyId===data.companyId&&company.companyId===data.companyId);
assert(fixture.users.length===500&&fixture.tenants.length===2&&data.requisitionId);
const owner=createDb(env.MIGRATION_DATABASE_URL,{max:1});

async function timed(sample,key,run){
 const started=performance.now();
 const value=await run();
 sample[key]=Math.round(performance.now()-started);
 return value;
}

try{
 const companyRows=await owner.client`
  select id from company where tenant_id=${group.tenantId}::uuid and archived_at is null order by id
 `;
 assert(companyRows.length>=70);
 const receipts=[];
 for(const actor of [group,company]){
  const [principal]=await owner.client`select tenant_id,grants from app.principal(${actor.userId}::uuid)`;
  assert(principal?.tenant_id===actor.tenantId&&principal.grants.some(grant=>grant.role==='hr_admin'));
  const session={tenantId:actor.tenantId,userId:actor.userId,personId:actor.personId,grants:principal.grants,
   roles:[...new Set(principal.grants.map(grant=>grant.role))],
   entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,actor.tenantId))};
  const scope=actor.role==='groupHR'?companyRows.map(row=>row.id):[data.companyId];
  const samples=[];
  for(let pass=0;pass<3;pass++){
   const sample={};
   const viewer=await timed(sample,'viewerMs',()=>recruitment.recruitmentViewer(session,scope));
   const administered=viewer.adminCompanies.map(row=>row.id);
   assert(administered.includes(data.companyId));
   sample.administeredCompanies=administered.length;
   await timed(sample,'initializeDefaultsMs',()=>recruitment.ensureRecruitmentDefaults(session,administered));
   const detail=await timed(sample,'recordMs',()=>recruitment.getRequisition(session,data.requisitionId));
   assert(detail.manage&&detail.requisition.companyId===data.companyId&&detail.requisition.title===data.reqTitle);
   const options=await timed(sample,'formOptionsMs',()=>recruitment.requisitionFormOptions(session,data.companyId));
   assert(options.users.length>0&&options.grades.length>0);
   samples.push(sample);
  }
  receipts.push({role:actor.role,scopeCompanies:scope.length,samples});
 }
 writeFileSync(file('recruitment-requisition-owner-profile.json'),JSON.stringify({receipts}),{mode:0o600});
}finally{
 await Promise.all([owner.client.end({timeout:5}),client.end({timeout:5})]);
}
