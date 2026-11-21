/** Create real retained formula evidence in the disposable hosted browser database. */
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
const [group,companyHr]=fixture.users;
const employee=fixture.users.find(user=>user.role==='employee'&&user.companyId===group.companyId&&user.tenantId===group.tenantId);
assert(fixture.users.length===500&&group.role==='groupHR'&&companyHr.role==='companyHR'&&employee);
assert.equal(companyHr.companyId,group.companyId);
const source=file=>import(pathToFileURL(resolve(process.cwd(),file)).href);
const [{client,createDb},{resolveEntitlementsTx},payroll,{addCalendarMonths}]=await Promise.all([
 source('db/client.ts'),source('core/entitlements.ts'),source('packs/payroll/service.ts'),source('lib/hr-date.ts'),
]);
const owner=createDb(env.MIGRATION_DATABASE_URL,{max:1});
const mark=stage=>writeFileSync(resolve(env.PERF_PRIVATE_DIR,'payroll-formula-seed-stage'),stage,{mode:0o600});
try{
 mark('principal');
 await owner.client`insert into tenant_module (tenant_id,module_code,status) values
  (${group.tenantId}::uuid,'typed_pay_components','active'),
  (${group.tenantId}::uuid,'multi_cycle_payroll','active')
  on conflict (tenant_id,module_code,coalesce(company_id,'00000000-0000-0000-0000-000000000000'::uuid))
  do update set status=excluded.status,expires_at=null`;
 const [principal]=await owner.client`select tenant_id,grants from app.principal(${group.userId}::uuid)`;
 assert(principal?.tenant_id===group.tenantId&&Array.isArray(principal.grants)&&principal.grants.some(grant=>grant.role==='hr_admin'&&grant.companyId===null));
 const ctx={tenantId:group.tenantId,userId:group.userId,personId:group.personId,grants:principal.grants,
  roles:[...new Set(principal.grants.map(grant=>grant.role))],
  entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,group.tenantId))};
 mark('formula');
 const [cycle]=await owner.client`insert into payroll_cycle (tenant_id,company_id,name,code,run_type)
  values (${group.tenantId}::uuid,${group.companyId}::uuid,'Fictional trace cycle','PERF_TRACE','regular') returning id`;
 const period=addCalendarMonths(fixture.month+'-01',1).slice(0,7);
 const asOf=period+'-01';
 const component={code:'PERF_TRACE_AMOUNT',name:'Fictional trace amount',label:'Fictional trace amount',kind:'allowance',
  includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false};
 await payroll.seedPayComponentCatalog(ctx);
 await payroll.upsertPayComponent(ctx,{...component,rule:null});
 const saved=await payroll.savePayFormula(ctx,{formulaId:'PERF_TRACE',description:'Fictional retained calculation',method:'write',source:'Return {#Input} * 2'});
 const receipt=await payroll.testPayFormula(ctx,{...saved,context:{
  companyId:group.companyId,employmentId:employee.employmentId,cycleId:cycle.id,period,asOf,currentCode:component.code,input:'12.5',
 }});
 assert(receipt.passed&&Number(receipt.amount)===25,'Expected a successful independently known formula test');
 await payroll.setPayFormulaActive(ctx,{...saved,testId:receipt.id,active:true});
 const linked=await payroll.upsertPayComponent(ctx,{...component,rule:{kind:'formula_builder',formulaId:'PERF_TRACE',dependencies:[]}});
 await payroll.setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:linked.id,amount:12.5,effectiveFrom:asOf});
 mark('calculate');
 const {batchId}=await payroll.createBatch(ctx,{companyId:group.companyId,payPeriod:period,payrollCycleId:cycle.id});
 await payroll.generatePayslips(ctx,{batchId});
 const rows=await owner.client`select id,amount,component_code from pay_formula_evaluation
  where tenant_id=${group.tenantId}::uuid and company_id=${group.companyId}::uuid
    and employment_id=${employee.employmentId}::uuid and batch_id=${batchId}::uuid`;
 assert(rows.length===1&&Number(rows[0].amount)===25&&rows[0].component_code===component.code,
  'Payroll must retain exactly one matching calculation for the fictional employee');
 writeFileSync(resolve(env.PERF_PRIVATE_DIR,'payroll-formula-evaluation.json'),JSON.stringify({
  id:rows[0].id,amount:rows[0].amount,componentCode:component.code,companyId:group.companyId,
 }),{mode:0o600});
 mark('complete');
}finally{await Promise.all([owner.client.end(),client.end()]);}
