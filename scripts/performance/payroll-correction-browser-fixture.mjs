/** Process one payroll run in the disposable browser database before opening correction forms. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const env=process.env;
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_JOB==='selected-tests');
assert(env.PERF_HTTP_SUITE==='browser-route-baseline'&&env.AUTH_PROVIDER==='internal');
assert.equal(env.DATABASE_URL,'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
assert.equal(env.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');
const fixture=JSON.parse(readFileSync(resolve(env.PERF_PRIVATE_DIR,'fixture.json'),'utf8'));
const [group]=fixture.users;
const company=fixture.tenants[0]?.companies[0];
assert.equal(fixture.users.length,500);
assert(group.role==='groupHR'&&group.tenantId===fixture.tenants[0].tenantId&&group.companyId===company.companyId);
const source=file=>import(pathToFileURL(resolve(process.cwd(),file)).href);
const [{client,createDb},{resolveEntitlementsTx},{generatePayslips,savePayFormula,setEmploymentPayComponent,upsertPayComponent},{setTenantSetting}]=await Promise.all([
 source('db/client.ts'),source('core/entitlements.ts'),source('packs/payroll/service.ts'),source('core/tenant-settings.ts'),
]);
const owner=createDb(env.MIGRATION_DATABASE_URL,{max:1});
const mark=stage=>writeFileSync(resolve(env.PERF_PRIVATE_DIR,'payroll-correction-seed-stage'),stage,{mode:0o600});
try{
 mark('module');
 await owner.client`insert into tenant_module (tenant_id,module_code,status)
  values (${group.tenantId}::uuid,'multi_cycle_payroll','active')
  on conflict (tenant_id,module_code,coalesce(company_id,'00000000-0000-0000-0000-000000000000'::uuid))
  do update set status=excluded.status,expires_at=null`;
 mark('principal');
 const [principal]=await owner.client`select tenant_id,grants from app.principal(${group.userId}::uuid)`;
 assert(principal?.tenant_id===group.tenantId&&Array.isArray(principal.grants));
 const grants=principal.grants;
 assert(grants.some(grant=>grant.role==='hr_admin'&&grant.companyId===null));
 const ctx={tenantId:group.tenantId,userId:group.userId,personId:group.personId,grants,
  roles:[...new Set(grants.map(grant=>grant.role))],
  entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,group.tenantId))};
 mark('reset-setting');
 await setTenantSetting(ctx,{key:'payroll.reset_enabled',value:true});
 mark('payroll-records');
 const employee=fixture.users[4];
 assert(employee.role==='employee'&&employee.tenantId===group.tenantId&&employee.companyId===company.companyId);
 await owner.client`insert into tenant_module (tenant_id,module_code,status)
  values (${group.tenantId}::uuid,'typed_pay_components','active')
  on conflict (tenant_id,module_code,coalesce(company_id,'00000000-0000-0000-0000-000000000000'::uuid))
  do update set status=excluded.status,expires_at=null`;
 ctx.entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,group.tenantId));
 const component=await upsertPayComponent(ctx,{
  code:'PERF_FIXED_ITEM',name:'Fictional fixed pay item',label:'Fixture item',kind:'allowance',
  includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false,
 });
 await setEmploymentPayComponent(ctx,{
  employmentId:employee.employmentId,componentId:component.id,amount:123.45,
  effectiveFrom:fixture.today.slice(0,7)+'-01',
 });
 await savePayFormula(ctx,{
  formulaId:'BROWSER_FIXED',description:'Fictional browser formula',method:'write',source:'Return 1',
 });
 mark('calculate');
 await generatePayslips(ctx,{batchId:company.batchId});
 mark('complete');
}catch(error){
 const code=error?.cause?.code??error?.code;
 if(typeof code==='string'&&/^(?:[0-9A-Z]{5}|ERR_ASSERTION)$/.test(code)){
  writeFileSync(resolve(env.PERF_PRIVATE_DIR,'payroll-correction-seed-failure'),code,{mode:0o600});
 }
 throw error;
}finally{await Promise.all([owner.client.end(),client.end()]);}
