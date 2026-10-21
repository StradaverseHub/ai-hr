/** Named disposable-local Payroll journeys only. Real report/Payroll owners decide every effect.
 * No production URL, SQL result fabrication, alternate principal or financial permission bypass.
 */
import {readFile,writeFile} from 'node:fs/promises';
for(const raw of [process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL]){
 const url=new URL(raw??'');
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)
  ||url.port!=='5433'||url.pathname!=='/ai_hr_board1_acceptance'||url.search||url.hash)
  throw Error('Only the named disposable Board 1 local database is allowed.');
}
if(process.env.NODE_ENV==='production')throw Error('Development fixture only.');
process.env.TEST_DATABASE_URL=process.env.DATABASE_URL;
process.env.TEST_MIGRATION_DATABASE_URL=process.env.MIGRATION_DATABASE_URL;
const directory='/private/tmp/aihr-board1-remaining4-20261021';
const command=process.argv[2];
if(!['prepare','revoke','restore','stale','reprocess'].includes(command))throw Error('Choose an explicit local journey command.');
async function main(){
 const {eq}=await import('drizzle-orm');
 const schema=await import('../db/schema');
 const {owner,entitledCtx,createAppUser,closeAll}=await import('../test/harness');
 const {hireEmployee}=await import('../core/org');
 const {saveCustomReport,getCustomReport}=await import('../core/custom-reports');
 const {payrollComparisonSpec}=await import('../core/report-payroll-comparison');
 const {setPayrollPermissionGrant,createIndividualTxn,generatePayslips,createBatch}=await import('../packs/payroll/service');
 const {todayInKualaLumpur}=await import('../lib/hr-date');
 try{
  const fixture=JSON.parse(await readFile(directory+'/payroll-fixture.json','utf8'));
  const ctx={...await entitledCtx(fixture),grants:[{role:'hr_admin',companyId:null}]};
  if(command==='prepare'){
   const prior=await readFile(directory+'/payroll-access-journey.json','utf8').then(JSON.parse,()=>null);
   if(prior){
    if(prior.tenantId!==fixture.tenantId||!await getCustomReport(ctx,prior.privateReportId,[fixture.companyId]))throw Error('Stale local journey metadata.');
    console.log('Existing named local access journey validated.');return;
   }
   const person=await hireEmployee(ctx,{person:{fullName:'Fictional Review HR',primaryEmail:'board1-review-hr@example.test'},
    companyId:fixture.companyId,departmentId:fixture.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(),employeeCode:'00001999'});
   const peerUserId=await createAppUser(fixture.tenantId,person.personId,'hr_admin');
   await owner.db.update(schema.appUser).set({onboardedAt:new Date()}).where(eq(schema.appUser.id,peerUserId));
   const spec=payrollComparisonSpec();
   const privateReport=await saveCustomReport(ctx,{name:'Fictional private ownership review',datasetId:'payroll_period_comparison',spec,companyIds:[fixture.companyId]});
   const shared=payrollComparisonSpec();shared.layout={permissions:{hr_admin:['view','create','edit','delete','share']}};
   const sharedReport=await saveCustomReport(ctx,{name:'Fictional shared view without export',datasetId:'payroll_period_comparison',spec:shared,shared:true,companyIds:[fixture.companyId]});
   const draftPeriod=todayInKualaLumpur().slice(0,7);
   const draft=await createBatch(ctx,{companyId:fixture.companyId,payPeriod:draftPeriod});
   await writeFile(directory+'/payroll-access-journey.json',JSON.stringify({tenantId:fixture.tenantId,peerUserId,privateReportId:privateReport.id,sharedReportId:sharedReport.id,draft,draftPeriod},null,2),{mode:0o600,flag:'wx'});
   console.log('Prepared fictional second HR, private/shared definitions and an uncalculated draft.');
  }else if(command==='revoke'||command==='restore'){
   await setPayrollPermissionGrant(ctx,{companyId:fixture.companyId,permissionKey:'report.read.compensation',role:'hr_admin',allowed:command==='restore'});
   console.log(command==='restore'?'Restored the named fictional company compensation-report grant.':'Revoked the named fictional company compensation-report grant.');
  }else if(command==='stale'){
   await createIndividualTxn(ctx,{batchId:fixture.current.batchId,employmentId:fixture.people.increase.employmentId,kind:'earning',txnDate:fixture.currentPeriod+'-01',amount:1});
   console.log('Marked the named fictional processed run stale through its transaction owner.');
  }else{
   await generatePayslips(ctx,{batchId:fixture.current.batchId});
   console.log('Reprocessed the named fictional run through Payroll.');
  }
 }finally{await closeAll();}
}
main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
