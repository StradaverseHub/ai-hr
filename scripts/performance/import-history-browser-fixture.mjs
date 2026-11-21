/** Seed retained Personnel and Payroll records through the real import owners. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
assert(fixture.users.length===500&&group.role==='groupHR'&&companyHr.role==='companyHR');
assert.equal(companyHr.companyId,group.companyId);
const source=file=>import(pathToFileURL(resolve(process.cwd(),file)).href);
const [{client,createDb},{resolveEntitlementsTx},{commitEmployeeImport},{getImportAttempt,getImportRun},
 payroll,{parseCsvRecords,toCsv},{PAYROLL_HISTORY_HEADERS},fixedImports,{runBulkJobTick}]=await Promise.all([
 source('db/client.ts'),source('core/entitlements.ts'),source('core/import.ts'),source('core/import-history.ts'),
 source('packs/payroll/service.ts'),source('lib/csv.ts'),source('lib/payroll-history-import-schema.ts'),
 source('core/fixed-transaction-import-job.ts'),source('core/bulk-job-worker.ts'),
]);
const owner=createDb(env.MIGRATION_DATABASE_URL,{max:1});
const resultPath=name=>resolve(env.PERF_PRIVATE_DIR,name);
const mark=stage=>writeFileSync(resultPath('import-history-seed-stage'),stage,{mode:0o600});
const employeeName='Fictional Import History Joiner';
const personnelFile='fictional-personnel-history.csv';
const payrollFile='fictional-payroll-history.csv';
const companyLabel='PERFHIST';
const employeeCode='PERFHIST01';
const email='fictional-import-history-joiner@fixture.invalid';
const period=String(Number(fixture.month.slice(0,4))-2)+'-02';
try{
 mark('principal');
 const [principal]=await owner.client`select tenant_id,grants from app.principal(${group.userId}::uuid)`;
 assert(principal?.tenant_id===group.tenantId&&principal.grants.some(grant=>grant.role==='hr_admin'&&grant.companyId===null));
 const ctx={tenantId:group.tenantId,userId:group.userId,personId:group.personId,grants:principal.grants,
  roles:[...new Set(principal.grants.map(grant=>grant.role))],
  entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,group.tenantId))};

 mark('personnel');
 const [department]=await owner.client`select name from department where tenant_id=${group.tenantId}::uuid
  and company_id=${group.companyId}::uuid order by id limit 1`;
 assert(department,'Expected a department in the shared fictional company');
 const personnelCsv=toCsv([
  ['full_name','email','employee_code','department','hired_on','ic_number','basic_salary','monthly_allowance','bank_name','bank_account_no','tax_category'],
  [employeeName,email,employeeCode,department.name,period.slice(0,4)+'-01-01','900101099927','5000','0','','','1'],
 ]);
 const imported=await commitEmployeeImport(ctx,{companyId:group.companyId,records:parseCsvRecords(personnelCsv).records,
  fileName:personnelFile,source:{name:personnelFile,content:Buffer.from(personnelCsv)}});
 assert(imported.imported===1&&imported.attemptId&&imported.runId,'Expected the committed Personnel item and both history records');
 const [attempt,run]=await Promise.all([getImportAttempt(ctx,imported.attemptId),getImportRun(ctx,imported.runId)]);
 assert(attempt?.sourceName===personnelFile&&attempt.items.some(item=>item.status==='applied'&&item.label.includes(employeeName)));
 assert(run?.fileName===personnelFile&&run.importedRows===1);

 mark('payroll');
 await owner.client`update company set company_label=${companyLabel} where id=${group.companyId}::uuid and tenant_id=${group.tenantId}::uuid`;
 await payroll.seedPayrollCycleCatalog(ctx,group.companyId);
 await payroll.seedPayComponentCatalog(ctx);
 const amount='1037.00';
 const payrollCsv=toCsv([Array.from(PAYROLL_HISTORY_HEADERS),
  ...[['BASIC',amount],['EEEPF','0.00'],['EESOCSO','0.00'],['EEEIS','0.00'],['PCB','0.00']]
   .map(([code,value])=>[employeeCode,period,'ME',code,companyLabel,value]),
 ]);
 const preview=await payroll.previewPayrollHistoryUpload(ctx,{name:payrollFile,content:Buffer.from(payrollCsv)});
 await payroll.confirmPayrollHistoryUpload(ctx,{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:true});
 const [history,records]=await Promise.all([payroll.getPayrollHistoryAttempt(ctx,preview.attemptId),
  payroll.payrollHistoryMaintenanceRecords(ctx,{limit:10})]);
 assert(history?.sourceName===payrollFile&&history.events.some(event=>event.kind==='confirmed'));
 const record=records.items.find(row=>row.employeeNo===employeeCode&&row.period===period);
 assert(record,'Expected a retained Payroll record for the imported employee');
 const detail=await payroll.payrollHistoryMaintenanceRecord(ctx,record.id);
 assert(detail?.items.some(item=>item.code==='BASIC'&&Number(item.amount)===Number(amount)&&item.sourceAttemptId===preview.attemptId));

 mark('fixed-transaction');
 const fixedFile='fictional-fixed-transaction-errors.xlsx';
 const missingEmployee='PERF-UNKNOWN-FIXED';
 const scope=[group.companyId];
 const fixedId=await fixedImports.queueFixedTransactionImport(ctx,{
  csv:toCsv([['Employee ID','Pay Item Code','Amount','Start Date'],
   [missingEmployee,'BONUS','100',fixture.month+'-01']]),
  fileName:fixedFile,companyIds:scope,operationKey:randomUUID(),validationOnly:true,
 });
 let job=await fixedImports.readFixedTransactionImport(ctx,fixedId,scope);
 for(let tick=0;tick<10&&!['completed','failed'].includes(job.state);tick++){
  await runBulkJobTick(owner.client,{handlers:[fixedImports.fixedTransactionImportJobHandler]});
  job=await fixedImports.readFixedTransactionImport(ctx,fixedId,scope);
 }
 assert.equal(job.state,'failed');
 assert.equal(job.error,'noValidRows');
 assert.equal(job.counters.invalid,1);
 assert.equal(job.counters.written??0,0);
 assert(job.rows.some(row=>row.employeeId===missingEmployee&&row.reason==='employeeUnknown'));
 writeFileSync(resultPath('import-history-browser.json'),JSON.stringify({
  companyId:group.companyId,employeeName,employeeCode,
  personnel:{attemptId:imported.attemptId,runId:imported.runId,file:personnelFile},
  payroll:{attemptId:preview.attemptId,recordId:record.id,file:payrollFile},
  fixed:{id:fixedId,file:fixedFile,missingEmployee},
 }),{mode:0o600});
 mark('complete');
}finally{await Promise.all([owner.client.end(),client.end()]);}
