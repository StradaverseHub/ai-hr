/** Only an owned GitHub fixture database. Session records use canonical encrypted storage. */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {fixtureAuditCounts,assertFixtureAudit} from './fixture-audit.ts';
import {performanceFixtureCalendar,clockingFixtureText} from './fixture-workload.mjs';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.AUTH_PROVIDER,'internal');
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']){
 const url=new URL(process.env[key]);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5433');assert.equal(url.pathname,'/ai_hr_dev');
}
const auditRequested=process.env.AUDIT_HASH_CHAIN_ENABLED==='true';
assert(auditRequested,'the production workload requires audit chaining');
const {seedBase,entitledCtx,owner,closeAll,setModule}=await import('../../test/harness.ts');
// The ordinary unit harness deliberately clears deployment gates. Restore this fixture's
// explicit opt-in before seeding any domain events; production app/driver already retain it.
process.env.AUDIT_HASH_CHAIN_ENABLED='true';
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']){
 const url=new URL(process.env[key]);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5433');assert.equal(url.pathname,'/ai_hr_dev');
}
const s=await import('../../db/schema.ts');
const {hireEmployee}=await import('../../core/org.ts');
const {grantAssistant}=await import('../../core/assistant-grant.ts');
const {createClockingMapping,validateClockingImport}=await import('../../packs/attendance/service.ts');
const {createClaimType}=await import('../../packs/claims/service.ts');
const {saveAttendanceWorkflow,setAttendanceWorkflowEnabled}=await import('../../core/attendance-workflow.ts');
const {createBatch,generatePayslips,closeBatch}=await import('../../packs/payroll/service.ts');
const {MODULE_CATALOG}=await import('../../packs/catalog.ts');
const {todayInKualaLumpur}=await import('../../lib/hr-date.ts');
const {passwordHash,opaque,digest}=await import('../../lib/internal-auth/crypto.ts');
const {writeRecord}=await import('../../lib/internal-auth/record-store.ts');
const {internalIssuer}=await import('../../lib/internal-auth/config.ts');
const {generateSecret}=await import('otplib');
const today=todayInKualaLumpur(),month=today.slice(0,7),password='Synthetic-'+randomBytes(24).toString('hex');
const {historicalMonth,publicationMonth,importDate}=performanceFixtureCalendar(today);
const attendanceDays=Number(process.env.PERF_ATTENDANCE_DAYS||180);assert([180,2000].includes(attendanceDays));
const claimsPerEmployee=process.env.PERF_HTTP_SUITE==='workflow-preflight'?200:2000;
// Retained attendance must not predate employment; preserve the old 180-day fixture's hire date.
const hiredOn=attendanceDays===180?'2025-01-01':new Date(Date.parse(today+'T12:00:00Z')-(attendanceDays+1)*86400000).toISOString().slice(0,10);
const hash=await passwordHash(password),users=[],tenants=[];
const operationTimings={hire:[],identityAndSessionProvisioning:[],historyAndCompensationSeed:[],payrollGenerate50:[],payrollClose50:[]};
const timingSummary=values=>{const rows=[...values].sort((a,b)=>a-b);return{samples:rows.length,totalMs:rows.reduce((sum,value)=>sum+value,0),p50Ms:rows[Math.ceil(rows.length*.5)-1]??null,p95Ms:rows[Math.ceil(rows.length*.95)-1]??null,maxMs:rows.at(-1)??null};};
const fixturePhases=[];
async function fixturePhase(tenant,phase,run){
 const entry={tenant,phase,status:'running'};
 fixturePhases.push(entry);
 const path=join(process.env.PERF_EVIDENCE_DIR,'fixture-phases.json');
 const save=()=>writeFileSync(path,JSON.stringify(fixturePhases,null,2));
 save();
 const start=performance.now();
 try{const result=await run();entry.status='passed';return result;}
 catch(error){entry.status='failed';throw error;}
 finally{entry.elapsedMs=performance.now()-start;save();}
}
try{
 await owner.client`create extension if not exists pg_stat_statements`;
 // Tenants have independent identity, payroll and audit state.
 const seeded=await Promise.allSettled([0,1].map(async t=>{
  const b=await seedBase(),organization=t?'perf-b':'perf-a';
  await owner.db.insert(s.tenantModule).values(MODULE_CATALOG.filter(m=>!m.isCore&&(m.packBacked||m.code==='system_testing'||m.code==='system_explorer')).map(m=>({tenantId:b.tenantId,moduleCode:m.code,status:'active'}))).onConflictDoNothing();
  // Platform notifications are implemented outside a module pack. Exercise the real bell
  // and in-app projector too; no email delivery worker or external relay runs in this fixture.
  await setModule(b.tenantId,'notifications','active');
  // Read-only AI Centre journeys must exercise admitted Ask, not a module-off fallback.
  // No provider is configured and no prompt/turn is submitted by this harness.
  await setModule(b.tenantId,'assistant','active');
  const ctx=await entitledCtx(b);
  const org={code:organization,tenantId:b.tenantId,name:'Performance organization '+t};
  await writeRecord(owner.client,'org:'+organization,org,null);await writeRecord(owner.client,'tenant:'+b.tenantId,org,null);
  const type=await createClaimType(ctx,{code:'PERF',name:'Performance claim',defaultTaxable:false,requiresReceipt:false});
  const clockingMappingId=await createClockingMapping(ctx,{name:'PERF coded clocking CSV',description:'Fictional load fixture',deviceName:'Synthetic CSV',fileType:'csv',layout:'delimited',delimiter:',',hasHeader:false,encoding:'utf-8',active:true,
   fields:{cardId:{column:1},day:{column:2},month:{column:3},year:{column:4},hours:{column:5},minute:{column:6},inOutCode:{column:7}},inOutCodes:[{code:'IN',direction:'in'},{code:'OUT',direction:'out'}],sampleLines:['PERF0004,01,01,2026,08,31,IN'],sampleFileName:'perf.csv'});
  const companies=[];
  for(let c=0;c<5;c++){
   let companyId=b.companyId,departmentId=b.deptA;
   if(c){const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:`PERF Company ${t}-${c}`,country:'MY'}).returning();companyId=company.id;
    const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId,name:'Performance department'}).returning();departmentId=department.id;
   }
   const {batchId}=await createBatch(ctx,{companyId,payPeriod:month});
   const {batchId:historicalBatchId}=await createBatch(ctx,{companyId,payPeriod:historicalMonth});
   // Separate past-month draft: HTTP publication must not close the live correction workload's period.
   const publicationBatchId=t===0&&c===1?(await createBatch(ctx,{companyId,payPeriod:publicationMonth})).batchId:undefined;
   companies.push({companyId,departmentId,batchId,historicalBatchId,publicationBatchId});
  }
  tenants[t]={tenantId:b.tenantId,organization,claimTypeId:type.id,clockingMappingId,companies};
  // Two companies make the staff hub's open count distinguish group and company scope.
  if(process.env.PERF_HTTP_SUITE==='whole-system')await fixturePhase(t,'lifecycle-hub',()=>owner.db.insert(s.itRequisition).values([
   {tenantId:b.tenantId,companyId:companies[0].companyId,number:'REQ-PERF-PENDING',kind:'standalone',status:'open',approvalStatus:'pending',approvalLevels:1,fullName:'Fictional pending requisition',employeeNo:'PERF-REQ-01'},
   {tenantId:b.tenantId,companyId:companies[1].companyId,number:'REQ-PERF-APPROVED',kind:'standalone',status:'open',approvalStatus:'approved',approvalLevels:1,fullName:'Fictional approved requisition',employeeNo:'PERF-REQ-02'},
   {tenantId:b.tenantId,companyId:companies[0].companyId,number:'REQ-PERF-CANCELLED',kind:'standalone',status:'cancelled',approvalStatus:'pending',approvalLevels:1,fullName:'Fictional cancelled requisition',employeeNo:'PERF-REQ-03'},
  ]));
  for(let i=0;i<250;i++){
   const index=t*250+i,c=Math.floor(i/50),position=i%50,company=companies[c];
   const role=position===0&&c===0?'groupHR':position<2?'companyHR':position<4?'manager':'employee';
   const name=`PERF Person ${String(index).padStart(4,'0')}`,email=`person${index}@example.invalid`,username='person'+index;
   const hireStarted=performance.now();const hired=await hireEmployee(ctx,{person:{fullName:name,primaryEmail:email},companyId:company.companyId,departmentId:company.departmentId,employmentType:'full_time',hiredOn,employeeCode:'PERF'+String(index).padStart(4,'0')});
   operationTimings.hire.push(performance.now()-hireStarted);const identityStarted=performance.now();
   const userId=randomUUID(),subject=randomUUID(),version=randomUUID(),secret=generateSecret(),issuer=internalIssuer(b.tenantId);
   await owner.db.insert(s.appUser).values({id:userId,tenantId:b.tenantId,personId:hired.personId,workosUserId:'perf_'+userId});
   const grants=[{tenantId:b.tenantId,appUserId:userId,role:'employee',companyId:company.companyId}];
   if(role==='manager')grants.push({tenantId:b.tenantId,appUserId:userId,role:'manager',companyId:company.companyId});
   if(role==='companyHR'||role==='groupHR')grants.push({tenantId:b.tenantId,appUserId:userId,role:'hr_admin',companyId:role==='groupHR'?null:company.companyId});
   if(role==='groupHR')for(const r of ['payroll_partner','performance_comp_partner'])grants.push({tenantId:b.tenantId,appUserId:userId,role:r,companyId:null});
   await owner.db.insert(s.roleAssignment).values(grants);
   await grantAssistant(ctx,{appUserId:userId});
   await owner.client`insert into app_external_identity(issuer,subject,app_user_id)values(${issuer},${subject},${userId}::uuid)`;
   const credential={subject,version,tenantId:b.tenantId,issuer,organization,username,email,emailVerified:true,enabled:true,password:hash,mustChange:false,totpSecret:secret,lastStep:-1,recoveryHashes:[]};
   const token=opaque(),family=randomUUID(),expiry=Date.now()+8*3600000;
   // Keep the four related records atomic and pay one durable commit per identity.
   await owner.client.begin(async tx=>{
    await writeRecord(tx,'credential:'+subject,credential,subject);
    await writeRecord(tx,'login:'+digest(organization+'\0'+username),{subject},subject);
    await writeRecord(tx,'family:'+family,{subject},subject,expiry);
    await writeRecord(tx,'session:'+digest(token),{subject,version,family,native:false,absoluteExpiry:expiry},subject,expiry);
   });
   users.push({index,tenant:t,company:c,role,name,userId,subject,employmentId:hired.employmentId,personId:hired.personId,companyId:company.companyId,batchId:company.batchId,claimTypeId:type.id,leaveTypeId:b.annualLeaveTypeId,token,organization,username,password,secret});
   operationTimings.identityAndSessionProvisioning.push(performance.now()-identityStarted);
   if(index%50===49)console.log('[system-perf-fixture] provisioned '+(index+1)+' principals');
  }
  const cohort=users.filter(u=>u.tenant===t);
  if(process.env.PERF_HTTP_SUITE==='workflow-preflight'&&t===0){
   tenants[t].letterDraft=await fixturePhase(t,'letter-draft-prerequisites',async()=>{
    const {saveLetterField,saveLetterTemplate,decideLetterTemplate,saveLetterPolicy}=await import('../../core/letters.ts');
    const companyId=companies[2].companyId;
    const [reviewer,author]=cohort.filter(user=>user.companyId===companyId&&user.role==='companyHR');
    assert(reviewer&&author&&reviewer.userId!==author.userId);
    const reviewerContext={...ctx,userId:reviewer.userId,personId:reviewer.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}]};
    const category='confirmation',name='Fictional browser draft lifecycle';
    const employee=await saveLetterField(ctx,{companyId,definition:{key:'employeeName',label:'Employee name',description:'Fictional recipient',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},active:true});
    const date=await saveLetterField(ctx,{companyId,definition:{key:'effectiveDate',label:'Effective date',description:'Fictional date for the browser journey',kind:'date',source:'custom.date',required:true,editable:true,sensitive:false},active:true});
    const template=await saveLetterTemplate(ctx,{companyId,code:'PERF-LETTER-DRAFT',name,category,effectiveFrom:today,
     document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Fictional letter for '},{type:'field',key:'employeeName'},{type:'text',text:' effective '},{type:'field',key:'effectiveDate'}]}]},
     fieldVersionIds:[employee.id,date.id]});
    await decideLetterTemplate(ctx,{versionId:template.versionId,expectedStatus:'draft',action:'submit'});
    await decideLetterTemplate(reviewerContext,{versionId:template.versionId,expectedStatus:'submitted',action:'approve'});
    await saveLetterPolicy(ctx,{companyId,category,enabled:true,policy:{version:1,stages:[{key:'signatory',label:'Fictional signatory',userIds:[reviewer.userId],allowDelegation:false}],signatoryUserId:reviewer.userId,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'acknowledge',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:false,emailNotifications:false}});
    return {companyId,versionId:template.versionId,authorIndex:author.index,name};
   });
  }
  const historyStarted=performance.now();
  await fixturePhase(t,'claims-history',()=>owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
    select ${b.tenantId}::uuid,e.id,${type.id}::uuid,1,${today}::date,'pending',now()-n*interval '1 minute'
    from unnest(${cohort.map(u=>u.employmentId)}::uuid[]) e(id)cross join generate_series(1,${claimsPerEmployee}::integer)n`);
  // Insert adjacent dates for each employment together for better index locality.
  await fixturePhase(t,'attendance-history',()=>owner.client`insert into attendance(tenant_id,employment_id,attendance_date,check_in_at,check_out_at,status,worked_minutes,ot_minutes)
    select ${b.tenantId}::uuid,e.id,${today}::date-n,'09:00'::time,'17:00'::time,'present',480,0
    from unnest(${cohort.map(u=>u.employmentId)}::uuid[]) e(id)cross join generate_series(0,${attendanceDays-1}::integer)n
    order by e.id,n desc`);
  await owner.db.insert(s.compensation).values(cohort.map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,basicSalary:'5000',validFrom:hiredOn})));
  operationTimings.historyAndCompensationSeed.push(performance.now()-historyStarted);
  // Retained published slips belong to a real completed historical run. Processing drafts stay empty.
  for(const company of companies){
   let started=performance.now();
   await fixturePhase(t,'historical-payroll-generate',()=>generatePayslips(ctx,{batchId:company.historicalBatchId}));
   operationTimings.payrollGenerate50.push(performance.now()-started);
   started=performance.now();
   await fixturePhase(t,'historical-payroll-close',()=>closeBatch(ctx,{batchId:company.historicalBatchId}));
   operationTimings.payrollClose50.push(performance.now()-started);
  }
  for(const company of companies){
   const approver=cohort.find(u=>u.companyId===company.companyId&&['companyHR','groupHR'].includes(u.role));assert(approver);
   await saveAttendanceWorkflow(ctx,{companyId:company.companyId,applicationType:'irregularity',routingVersion:4,code:'PERF',name:'Fictional performance approval',priority:100,active:true,criteria:{employeeIds:cohort.filter(u=>u.companyId===company.companyId&&u.role==='employee').map(u=>u.employmentId)},stages:[{name:'HR',mode:'any_one',sources:[{kind:'specific_employee',employmentIds:[approver.employmentId]}],hrAlternative:false}],cc:[]});
   await setAttendanceWorkflowEnabled(ctx,company.companyId,'irregularity',true);
  }
  // A real current administrative reporting line, inside the same company, for each manager.
  await owner.db.insert(s.reportingLine).values(cohort.filter(u=>u.role==='manager').flatMap(u=>cohort.filter(v=>v.company===u.company&&v.index%50>=4+(u.index%50-2)*10&&v.index%50<14+(u.index%50-2)*10).map(v=>({tenantId:b.tenantId,managerEmploymentId:u.employmentId,subordinateEmploymentId:v.employmentId,lineType:'administrative',validFrom:'2025-01-01'}))));
 }));
 for(const result of seeded)if(result.status==='rejected')throw result.reason;
 users.sort((a,b)=>a.index-b.index);
 for(const table of ['claim_request','attendance','employment','person','app_user','role_assignment','assignment','reporting_line','payslip'])await owner.client.unsafe('analyze '+table);
 const counts=await owner.client`select (select count(*)::int from claim_request)as claims,(select count(*)::int from attendance)as attendance,(select count(*)::int from payslip)as payslips`;
 assert.equal(counts[0].claims,500*claimsPerEmployee);assert.equal(users.length,500);
 assert.equal(counts[0].attendance,users.length*attendanceDays);assert.equal(counts[0].payslips,500);
 const [attendanceBounds]=await owner.client`select count(*) filter(where a.attendance_date=${today}::date)::int as current_rows,
  count(*) filter(where a.attendance_date<e.hired_on)::int as before_hire
  from attendance a join employment e on e.id=a.employment_id and e.tenant_id=a.tenant_id`;
 assert.equal(attendanceBounds.current_rows,500);assert.equal(attendanceBounds.before_hire,0);
 const audit=await fixturePhase(null,'audit-counts',()=>fixtureAuditCounts(owner.client,tenants.map(tenant=>tenant.tenantId)));
 const auditCounts=tenants.map((tenant,index)=>({tenant:index,...Object.fromEntries(Object.entries(audit.find(row=>row.tenant_id===tenant.tenantId)??{}).filter(([key])=>key!=='tenant_id'))}));
 writeFileSync(join(process.env.PERF_EVIDENCE_DIR,'audit-fixture.json'),JSON.stringify(auditCounts,null,2));
 assertFixtureAudit(audit,tenants.map(tenant=>tenant.tenantId));
 for(const tenant of tenants)tenant.auditUnchainedPrefix=audit.find(row=>row.tenant_id===tenant.tenantId).initialization_prefix;
 // Fail before the expensive production build if payroll dates or mapping reject the real file.
 const importPreflights=[];
 for(const [tenantIndex,tenant]of tenants.entries()){
  const hr=users.find(user=>user.tenant===tenantIndex&&user.role==='companyHR');
  const entitlements=(await entitledCtx({tenantId:tenant.tenantId,adminUserId:hr.userId})).entitlements;
  const context={tenantId:tenant.tenantId,userId:hr.userId,personId:hr.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:hr.companyId}],entitlements};
  const preview=await validateClockingImport(context,{mappingId:tenant.clockingMappingId,text:clockingFixtureText(users,tenantIndex,hr.company,importDate(2))});
  const result={tenant:tenantIndex,date:importDate(2),counts:preview.counts,refusalKinds:[...new Set(preview.errorRows.map(row=>row.result))]};
  importPreflights.push(result);writeFileSync(join(process.env.PERF_EVIDENCE_DIR,'fixture-import-preflight.json'),JSON.stringify(importPreflights,null,2));
  assert.equal(preview.counts.total,100);assert.equal(preview.counts.valid,100,'native clocking fixture preview refused: '+result.refusalKinds.join(','));
  assert.equal(preview.counts.employees,50);assert.equal(preview.errorRows.length,0);
  const expected=new Set(users.filter(user=>user.tenant===tenantIndex&&user.company===hr.company).map(user=>user.employmentId));
  assert(preview.validRows.every(row=>expected.has(row.employmentId)),'clocking fixture crossed company/tenant');
 }
 const modules=await owner.client`select tenant_id,array_agg(module_code order by module_code)as modules from tenant_module where tenant_id=any(${tenants.map(t=>t.tenantId)}::uuid[])and status='active'group by tenant_id`;

 const fixturePath=join(process.env.PERF_PRIVATE_DIR,'fixture.json');
 writeFileSync(fixturePath,JSON.stringify({today,month,users,tenants}),{mode:0o600});
 // Use the actual server-only package export only for this child; the existing fixture stays in ordinary Node.
 await fixturePhase(null,'assistant-saved-history',()=>execFileSync(process.execPath,['--import','tsx','scripts/performance/assistant-history-seed.mjs'],{stdio:'inherit',timeout:120000}));
 const seededHistory=JSON.parse(readFileSync(fixturePath,'utf8')).assistantHistory;
 assert.equal(Object.keys(seededHistory).length,4);assert(Object.values(seededHistory).every(history=>history.rowsVerified===true));
 writeFileSync(join(process.env.PERF_EVIDENCE_DIR,'fixture.json'),JSON.stringify({fictional:true,operationTimingScope:'sequential fictional native fixture commands, not HTTP concurrency',operationTimings:Object.fromEntries(Object.entries(operationTimings).map(([key,values])=>[key,timingSummary(values)])),tenants:2,companies:10,users:500,claimsPerEmployee,fixtureVolumeKind:claimsPerEmployee===2000?'full-load':'workflow-preflight-only',historicalMonth,publicationMonth,monthlyBasicSalary:5000,fixtureCommandContext:'native database-resolved entitlements',payslipFixture:'500 native-generated/closed historical slips; current processing drafts start empty',attendanceDays,attendanceBounds,roles:Object.fromEntries(['employee','manager','companyHR','groupHR'].map(role=>[role,users.filter(u=>u.role===role).length])),counts:counts[0],authentication:'canonical encrypted internal sessions; normal HTTP session validation; not 500 account-enrollment throughput',auditHashChainRequested:process.env.AUDIT_HASH_CHAIN_ENABLED==='true',auditHashChain:audit.every(row=>row.chained>0&&row.events===row.chained+row.initialization_prefix),auditPolicy:'All post-initialization events chained; one canonical initialization prefix per tenant',auditCounts,notificationFixture:'Enabled in-app projection; no external email delivery worker or relay',aiCentreFixture:'Assistant module and native user grants active; four representative owned sealed histories,640retained exchanges; no provider created or prompt submitted',assistantHistoryFixture:{actors:4,tenants:2,threadsPerActor:20,exchangesPerActor:160,rowsVerified:true,scope:'representative browser actors, notall500users'},explicitActiveModules:tenants.map((t,index)=>({tenant:index,modules:modules.find(row=>row.tenant_id===t.tenantId)?.modules??[]})),coreModules:MODULE_CATALOG.filter(m=>m.isCore).map(m=>m.code)},null,2));
 console.log('[system-perf-fixture] complete; private sessions are outside artifact directory');
}finally{await closeAll();}
