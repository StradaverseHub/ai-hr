/** Only an owned GitHub fixture database. Session records use canonical encrypted storage. */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixtureAuditCounts,assertFixtureAudit} from './fixture-audit.ts';
assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.AUTH_PROVIDER,'internal');
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']){
 const url=new URL(process.env[key]);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5433');assert.equal(url.pathname,'/ai_hr_system_perf');
}
const auditRequested=process.env.AUDIT_HASH_CHAIN_ENABLED==='true';
assert(auditRequested,'the production workload requires audit chaining');
const {seedBase,entitledCtx,owner,closeAll}=await import('../../test/harness.ts');
// The ordinary unit harness deliberately clears deployment gates. Restore this fixture's
// explicit opt-in before seeding any domain events; production app/driver already retain it.
process.env.AUDIT_HASH_CHAIN_ENABLED='true';
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']){
 const url=new URL(process.env[key]);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5433');assert.equal(url.pathname,'/ai_hr_system_perf');
}
const s=await import('../../db/schema.ts');
const {hireEmployee}=await import('../../core/org.ts');
const {createClockingMapping}=await import('../../packs/attendance/service.ts');
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
const historicalMonth=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-2,1)).toISOString().slice(0,7);
const attendanceDays=Number(process.env.PERF_ATTENDANCE_DAYS||180);assert([180,2000].includes(attendanceDays));
// Retained attendance must not predate employment; preserve the old 180-day fixture's hire date.
const hiredOn=attendanceDays===180?'2025-01-01':new Date(Date.parse(today+'T12:00:00Z')-(attendanceDays+1)*86400000).toISOString().slice(0,10);
const hash=await passwordHash(password),users=[],tenants=[];
try{
 await owner.client`create extension if not exists pg_stat_statements`;
 for(let t=0;t<2;t++){
  const b=await seedBase(),organization=t?'perf-b':'perf-a';
  await owner.db.insert(s.tenantModule).values(MODULE_CATALOG.filter(m=>!m.isCore&&(m.packBacked||m.code==='system_testing'||m.code==='system_explorer')).map(m=>({tenantId:b.tenantId,moduleCode:m.code,status:'active'}))).onConflictDoNothing();
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
   const {batchId:historicalBatchId}=await createBatch(ctx,{companyId,payPeriod:historicalMonth});companies.push({companyId,departmentId,batchId,historicalBatchId});
  }
  tenants.push({tenantId:b.tenantId,organization,claimTypeId:type.id,clockingMappingId,companies});
  for(let i=0;i<250;i++){
   const index=t*250+i,c=Math.floor(i/50),position=i%50,company=companies[c];
   const role=position===0&&c===0?'groupHR':position<2?'companyHR':position<4?'manager':'employee';
   const name=`PERF Person ${String(index).padStart(4,'0')}`,email=`person${index}@example.invalid`,username='person'+index;
   const hired=await hireEmployee(ctx,{person:{fullName:name,primaryEmail:email},companyId:company.companyId,departmentId:company.departmentId,employmentType:'full_time',hiredOn,employeeCode:'PERF'+String(index).padStart(4,'0')});
   const userId=randomUUID(),subject=randomUUID(),version=randomUUID(),secret=generateSecret(),issuer=internalIssuer(b.tenantId);
   await owner.db.insert(s.appUser).values({id:userId,tenantId:b.tenantId,personId:hired.personId,workosUserId:'perf_'+userId});
   const grants=[{tenantId:b.tenantId,appUserId:userId,role:'employee',companyId:company.companyId}];
   if(role==='manager')grants.push({tenantId:b.tenantId,appUserId:userId,role:'manager',companyId:company.companyId});
   if(role==='companyHR'||role==='groupHR')grants.push({tenantId:b.tenantId,appUserId:userId,role:'hr_admin',companyId:role==='groupHR'?null:company.companyId});
   if(role==='groupHR')for(const r of ['payroll_partner','performance_comp_partner'])grants.push({tenantId:b.tenantId,appUserId:userId,role:r,companyId:null});
   await owner.db.insert(s.roleAssignment).values(grants);
   await owner.client`insert into app_external_identity(issuer,subject,app_user_id)values(${issuer},${subject},${userId}::uuid)`;
   const credential={subject,version,tenantId:b.tenantId,issuer,organization,username,email,emailVerified:true,enabled:true,password:hash,mustChange:false,totpSecret:secret,lastStep:-1,recoveryHashes:[]};
   await writeRecord(owner.client,'credential:'+subject,credential,subject);await writeRecord(owner.client,'login:'+digest(organization+'\0'+username),{subject},subject);
   const token=opaque(),family=randomUUID(),expiry=Date.now()+8*3600000;
   await writeRecord(owner.client,'family:'+family,{subject},subject,expiry);
   await writeRecord(owner.client,'session:'+digest(token),{subject,version,family,native:false,absoluteExpiry:expiry},subject,expiry);
   users.push({index,tenant:t,company:c,role,name,userId,subject,employmentId:hired.employmentId,personId:hired.personId,companyId:company.companyId,batchId:company.batchId,claimTypeId:type.id,leaveTypeId:b.annualLeaveTypeId,token,organization,username,password,secret});
   if(index%50===49)console.log('[system-perf-fixture] provisioned '+(index+1)+' principals');
  }
  const cohort=users.filter(u=>u.tenant===t);
  await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
    select ${b.tenantId}::uuid,e.id,${type.id}::uuid,1,${today}::date,'pending',now()-n*interval '1 minute'
    from unnest(${cohort.map(u=>u.employmentId)}::uuid[]) e(id)cross join generate_series(1,2000)n`;
  await owner.client`insert into attendance(tenant_id,employment_id,attendance_date,check_in_at,check_out_at,status,worked_minutes,ot_minutes)
    select ${b.tenantId}::uuid,e.id,${today}::date-n,'09:00'::time,'17:00'::time,'present',480,0
    from unnest(${cohort.map(u=>u.employmentId)}::uuid[]) e(id)cross join generate_series(0,${attendanceDays-1}::integer)n`;
  await owner.db.insert(s.compensation).values(cohort.map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,basicSalary:'5000',validFrom:hiredOn})));
  // Retained published slips belong to a real completed historical run. Processing drafts stay empty.
  for(const company of companies){await generatePayslips(ctx,{batchId:company.historicalBatchId});await closeBatch(ctx,{batchId:company.historicalBatchId});}
  for(const company of companies){
   const approver=cohort.find(u=>u.companyId===company.companyId&&['companyHR','groupHR'].includes(u.role));assert(approver);
   await saveAttendanceWorkflow(ctx,{companyId:company.companyId,applicationType:'irregularity',routingVersion:4,code:'PERF',name:'Fictional performance approval',priority:100,active:true,criteria:{employeeIds:cohort.filter(u=>u.companyId===company.companyId&&u.role==='employee').map(u=>u.employmentId)},stages:[{name:'HR',mode:'any_one',sources:[{kind:'specific_employee',employmentIds:[approver.employmentId]}],hrAlternative:false}],cc:[]});
   await setAttendanceWorkflowEnabled(ctx,company.companyId,'irregularity',true);
  }
  // A real current administrative reporting line, inside the same company, for each manager.
  await owner.db.insert(s.reportingLine).values(cohort.filter(u=>u.role==='manager').flatMap(u=>cohort.filter(v=>v.company===u.company&&v.index%50>=4+(u.index%50-2)*10&&v.index%50<14+(u.index%50-2)*10).map(v=>({tenantId:b.tenantId,managerEmploymentId:u.employmentId,subordinateEmploymentId:v.employmentId,lineType:'administrative',validFrom:'2025-01-01'}))));
 }
 for(const table of ['claim_request','attendance','employment','person','app_user','role_assignment','assignment','reporting_line','payslip'])await owner.client.unsafe('analyze '+table);
 const counts=await owner.client`select (select count(*)::int from claim_request)as claims,(select count(*)::int from attendance)as attendance,(select count(*)::int from payslip)as payslips`;
 assert.equal(counts[0].claims,1000000);assert.equal(users.length,500);
 assert.equal(counts[0].attendance,users.length*attendanceDays);assert.equal(counts[0].payslips,500);
 const [attendanceBounds]=await owner.client`select count(*) filter(where a.attendance_date=${today}::date)::int as current_rows,
  count(*) filter(where a.attendance_date<e.hired_on)::int as before_hire
  from attendance a join employment e on e.id=a.employment_id and e.tenant_id=a.tenant_id`;
 assert.equal(attendanceBounds.current_rows,500);assert.equal(attendanceBounds.before_hire,0);
 const audit=await fixtureAuditCounts(owner.client,tenants.map(tenant=>tenant.tenantId));
 const auditCounts=tenants.map((tenant,index)=>({tenant:index,...Object.fromEntries(Object.entries(audit.find(row=>row.tenant_id===tenant.tenantId)??{}).filter(([key])=>key!=='tenant_id'))}));
 writeFileSync(join(process.env.PERF_EVIDENCE_DIR,'audit-fixture.json'),JSON.stringify(auditCounts,null,2));
 assertFixtureAudit(audit,tenants.map(tenant=>tenant.tenantId));
 for(const tenant of tenants)tenant.auditUnchainedPrefix=audit.find(row=>row.tenant_id===tenant.tenantId).initialization_prefix;
 const modules=await owner.client`select tenant_id,array_agg(module_code order by module_code)as modules from tenant_module where tenant_id=any(${tenants.map(t=>t.tenantId)}::uuid[])and status='active'group by tenant_id`;

 writeFileSync(join(process.env.PERF_PRIVATE_DIR,'fixture.json'),JSON.stringify({today,month,users,tenants}),{mode:0o600});
 writeFileSync(join(process.env.PERF_EVIDENCE_DIR,'fixture.json'),JSON.stringify({fictional:true,tenants:2,companies:10,users:500,historicalMonth,monthlyBasicSalary:5000,fixtureCommandContext:'native database-resolved entitlements',payslipFixture:'500 native-generated/closed historical slips; current processing drafts start empty',attendanceDays,attendanceBounds,roles:Object.fromEntries(['employee','manager','companyHR','groupHR'].map(role=>[role,users.filter(u=>u.role===role).length])),counts:counts[0],authentication:'canonical encrypted internal sessions; normal HTTP session validation; not 500 account-enrollment throughput',auditHashChainRequested:process.env.AUDIT_HASH_CHAIN_ENABLED==='true',auditHashChain:audit.every(row=>row.chained>0&&row.events===row.chained+row.initialization_prefix),auditPolicy:'All post-initialization events chained; one canonical initialization prefix per tenant',auditCounts,explicitActiveModules:tenants.map((t,index)=>({tenant:index,modules:modules.find(row=>row.tenant_id===t.tenantId)?.modules??[]})),coreModules:MODULE_CATALOG.filter(m=>m.isCore).map(m=>m.code)},null,2));
 console.log('[system-perf-fixture] complete; private sessions are outside artifact directory');
}finally{await closeAll();}
