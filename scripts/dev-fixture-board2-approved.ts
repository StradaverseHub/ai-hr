/**
 * Fictional Board 2 acceptance foundation. Run only after the reviewed migration union and handover.
 * Requires a seeded ai_hr_board2_browser on localhost:5433, separate app/owner roles, and namespace
 * board2approved. Completed reruns only read the stored fixture and current records; they never reset
 * browser edits. This prepares journeys; creating a fixture does not demonstrate their outcomes.
 */
import {mkdirSync,writeFileSync} from 'node:fs';
import {demoSeedRefusal,DEMO_TENANT_ID,SYSTEM_TENANT_ID} from '../db/seed-guard';
import {demoSwitcherEnabled} from '../lib/demo-mode';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addMonths} from '../lib/roster-month';
import type {SessionContext} from '../db/client';

const refusal=demoSeedRefusal(process.env);
if(refusal)throw new Error(refusal);
if(process.env.NODE_ENV==='production'||!demoSwitcherEnabled()||process.env.TEST_DB_NAMESPACE!=='board2approved')throw new Error('Board 2 fixture requires its local demo namespace.');
const urls=[process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL].map(raw=>{
 const url=new URL(raw??'');
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/ai_hr_board2_browser'||url.search||url.hash)throw new Error('Board 2 fixture requires the named disposable localhost:5433 database.');
 return url;
});
if(decodeURIComponent(urls[0].username)!=='ai_hr_app'||urls[0].username===urls[1].username)throw new Error('Board 2 fixture requires separate non-owner app and migration roles.');

type Role='employee'|'manager'|'hr_admin';
type Actor={key:string;userId:string;personId:string;employmentId:string;companyId:string;role:Role;hiredOn:string};
type Fixture={version:2;tenantId:string;companyId:string;otherCompanyId:string;departmentId:string;actors:Actor[];unlinkedUserId:string;batchIds:string[];policyId:string;workflowLineageId:string;correctionId:string;createdOn:string};
const companyCode='BOARD2-APPROVED',eventType='dev.board2-approved.fixture.completed';
const output=new URL('../scratchpad/board2-approved-ten-20261022/acceptance/',import.meta.url);

async function main(){
 const {and,eq,isNull,inArray,asc}=await import('drizzle-orm');
 const {createDb,client}=await import('../db/client');
 const s=await import('../db/schema');
 const {actorOf,appendEvent}=await import('../db/events');
 const {resolveEntitlementsTx}=await import('../core/entitlements');
 const {createCompany,createDepartment,updateCompany}=await import('../core/admin');
 const {hireEmployee,setReportingLine}=await import('../core/org');
 const {setCompensation}=await import('../core/comp');
 const attendance=await import('../packs/attendance/service');
 const payroll=await import('../packs/payroll/service');
 const {emptyAllowanceRulesV4}=await import('../lib/attendance-allowance-rules');
 const {requirePackFor}=await import('../localization/registry');
 const owner=createDb(process.env.MIGRATION_DATABASE_URL!),tenantId=DEMO_TENANT_ID,today=todayInKualaLumpur(),year=Number(today.slice(0,4));
 const lock=await owner.client.reserve();
 try{
  await lock`select pg_advisory_lock(hashtextextended('board2-approved-browser-fixture',0))`;
  const tenants=await owner.db.select({id:s.tenant.id}).from(s.tenant);
  if(!tenants.some(row=>row.id===tenantId)||tenants.some(row=>row.id!==tenantId&&row.id!==SYSTEM_TENANT_ID))throw new Error('Board 2 fixture requires only the seeded demo and reserved system tenants.');
  const [bootstrapUser]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,'user_dev_admin'),isNull(s.appUser.archivedAt)));
  if(!bootstrapUser)throw new Error('Seeded demo administrator missing.');
  async function context(user:{id:string;personId:string|null}):Promise<SessionContext>{
   const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,tenantId),eq(s.roleAssignment.appUserId,user.id)));
   return{tenantId,userId:user.id,personId:user.personId,grants,roles:[...new Set(grants.map(row=>row.role))],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId))};
  }
  const bootstrap=await context(bootstrapUser);
  if(!bootstrap.grants?.some(grant=>grant.companyId===null&&['hr_admin','super_admin'].includes(grant.role)))throw new Error('Seed administrator lacks its actual group grant.');
  let [company]=await owner.db.select().from(s.company).where(and(eq(s.company.tenantId,tenantId),eq(s.company.companyLabel,companyCode)));
  if(company){
   const [receipt]=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,tenantId),eq(s.domainEvent.aggregateId,company.id),eq(s.domainEvent.eventType,eventType))).orderBy(asc(s.domainEvent.sequence));
   if(receipt){
    const fixture=receipt.payload as unknown as Fixture;
    if(fixture.version!==2||fixture.companyId!==company.id||fixture.tenantId!==tenantId||!Array.isArray(fixture.actors)||fixture.actors.length!==6)throw new Error('Stored fixture receipt is incompatible; preserving it.');
    await manifest(fixture,true);return;
   }
  }
  for(const moduleCode of ['attendance','payroll','typed_pay_components']){
   const [existing]=await owner.db.select().from(s.tenantModule).where(and(eq(s.tenantModule.tenantId,tenantId),eq(s.tenantModule.moduleCode,moduleCode),isNull(s.tenantModule.companyId)));
   if(!existing)await owner.db.insert(s.tenantModule).values({tenantId,moduleCode,status:'active'});
   else if(existing.status!=='active'||existing.expiresAt)throw new Error(`Existing ${moduleCode} entitlement changed; preserving it.`);
  }
  // Resolve the real snapshot again after adding the local-demo module grants.
  const root=await context(bootstrapUser);
  async function companyFor(code:string,name:string){
   let [row]=await owner.db.select().from(s.company).where(and(eq(s.company.tenantId,tenantId),eq(s.company.companyLabel,code)));
   if(!row){const created=await createCompany(root,{companyLabel:code,legalName:name,country:'MY',currency:'MYR'});[row]=await owner.db.select().from(s.company).where(eq(s.company.id,created.id));}
   if(!row||row.archivedAt||row.legalName!==name)throw new Error('Existing fixture company changed; preserving it.');
   const existingCompany=row;
   const header={registrationNo:`FICTIONAL-${code}`,addressLine1:'Unit B2, Fictional Acceptance Park',city:'Kuala Lumpur',state:'Kuala Lumpur',addressCountry:'MY',postcode:'50000'};
   const keys=Object.keys(header) as (keyof typeof header)[];
   if(keys.some(key=>existingCompany[key]!==null&&existingCompany[key]!==header[key]))throw new Error('Existing fixture document header changed; preserving it.');
   if(keys.some(key=>existingCompany[key]!==header[key])){
    await updateCompany(root,{id:existingCompany.id,legalName:name,country:'MY',currency:'MYR',...header});
    [row]=await owner.db.select().from(s.company).where(eq(s.company.id,existingCompany.id));
    if(!row)throw new Error('Fixture company disappeared after its canonical update.');
   }
   return row;
  }
  company=await companyFor(companyCode,'Board 2 fictional employer');
  const otherCompany=await companyFor('BOARD2-OTHER','Board 2 fictional separate employer');
  async function departmentFor(companyId:string){
   const name='Board 2 fictional department';let [row]=await owner.db.select().from(s.department).where(and(eq(s.department.companyId,companyId),eq(s.department.name,name)));
   if(!row){const created=await createDepartment(root,{companyId,name});[row]=await owner.db.select().from(s.department).where(eq(s.department.id,created.id));}
   if(!row||row.archivedAt)throw new Error('Fixture department unavailable.');return row;
  }
  const department=await departmentFor(company.id),otherDepartment=await departmentFor(otherCompany.id);
  async function login(key:string,personId:string|null,companyId:string,role:Role){
   const identity=`board2-approved:${key}`;let [user]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,identity)));
   if(!user)[user]=await owner.db.insert(s.appUser).values({tenantId,workosUserId:identity,personId,onboardedAt:new Date()}).returning();
   if(user.personId!==personId||user.archivedAt)throw new Error('Existing fixture login changed; preserving it.');
   const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
   if(!grants.length)await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:user.id,companyId,role});
   else if(grants.length!==1||grants[0].companyId!==companyId||grants[0].role!==role)throw new Error('Existing fixture grants changed; preserving them.');
   return user;
  }
  async function actor(key:string,role:Role,hiredOn:string,companyId=company!.id,departmentId=department.id):Promise<Actor>{
   const email=`board2-approved-${key}@example.invalid`;let [person]=await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,email)));
   let [employment]=person?await owner.db.select().from(s.employment).where(and(eq(s.employment.personId,person.id),eq(s.employment.companyId,companyId))).orderBy(asc(s.employment.id)):[];
   if(!person){const created=await hireEmployee(root,{person:{fullName:`Board 2 fictional ${key}`,primaryEmail:email},companyId,departmentId,employmentType:'full_time',hiredOn});[person]=await owner.db.select().from(s.person).where(eq(s.person.id,created.personId));[employment]=await owner.db.select().from(s.employment).where(eq(s.employment.id,created.employmentId));}
   if(!person||!employment||employment.hiredOn!==hiredOn||employment.terminatedOn||employment.blacklistedAt)throw new Error('Existing fixture employment changed or initial creation is incomplete; preserving it.');
   const user=await login(key,person.id,companyId,role);return{key,userId:user.id,personId:person.id,employmentId:employment.id,companyId,role,hiredOn};
  }
  const applicant=await actor('applicant','employee',`${year}-01-01`),manager=await actor('superior','manager',`${year-2}-01-01`),named=await actor('named-approver','employee',`${year-2}-01-01`),hr=await actor('company-hr','hr_admin',`${year-2}-01-01`),noProfile=await actor('no-statutory-profile','employee',today),foreign=await actor('foreign-employee','employee',`${year-2}-01-01`,otherCompany.id,otherDepartment.id);
  const actors=[applicant,manager,named,hr,noProfile,foreign],hrContext=await context({id:hr.userId,personId:hr.personId});
  // Display fixtures are explicitly fictional; no filing, payment account or delivery is configured.
  const statutoryReferences={epfEmployerNo:'FICTIONAL-BOARD2-EPF',socsoEmployerCode:'FICTIONAL-BOARD2-SOCSO',lhdnEmployerNo:'FICTIONAL-BOARD2-LHDN',myinvoisTin:'FICTIONAL-BOARD2-TIN',ssmRegistrationNo:'FICTIONAL-BOARD2-SSM'};
  const statutory=await requirePackFor('MY').companyStatutory.get(hrContext,company.id);
  const statutoryKeys=Object.keys(statutoryReferences) as (keyof typeof statutoryReferences)[];
  if(statutory&&statutoryKeys.some(key=>statutory[key]!==null&&statutory[key]!==statutoryReferences[key]))throw new Error('Existing fixture employer references changed; preserving them.');
  if(!statutory||statutoryKeys.some(key=>statutory[key]!==statutoryReferences[key]))await requirePackFor('MY').companyStatutory.set(hrContext,{companyId:company.id,...statutoryReferences});
  const signatory={signatoryPersonId:hr.personId,phone:'+60 3 0000 0000',email:'board2-approved-company-hr@example.invalid'};
  const [authority]=await owner.db.select().from(s.companyStatutoryAuthority).where(and(eq(s.companyStatutoryAuthority.companyId,company.id),eq(s.companyStatutoryAuthority.authority,'lhdn')));
  if(!authority)await payroll.upsertCompanyStatutoryAuthority(hrContext,{companyId:company.id,authority:'lhdn',...signatory});
  else if(authority.signatoryPersonId!==signatory.signatoryPersonId||authority.phone!==signatory.phone||authority.email!==signatory.email)throw new Error('Existing fixture signatory changed; preserving it.');
  const unlinked=await login('unlinked',null,company.id,'employee');
  const paid=[applicant,manager,named,hr];
  for(const [index,person] of paid.entries()){
   const compensation=await owner.db.select().from(s.compensation).where(eq(s.compensation.employmentId,person.employmentId));
   if(!compensation.length)await setCompensation(hrContext,{employmentId:person.employmentId,basicSalary:5000+index*500,effectiveFrom:person.hiredOn});
   const [profile]=await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,person.personId));
   if(!profile)await requirePackFor('MY').statutory.set(hrContext,{personId:person.personId,icNumber:`90010110${String(index+1).padStart(4,'0')}`,taxCategory:1,numChildren:0});
  }
  const [line]=await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId,applicant.employmentId),eq(s.reportingLine.lineType,'administrative'),isNull(s.reportingLine.validTo),isNull(s.reportingLine.supersededAt)));
  if(!line)await setReportingLine(hrContext,{subordinateEmploymentId:applicant.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:applicant.hiredOn});
  else if(line.managerEmploymentId!==manager.employmentId)throw new Error('Existing fixture superior changed.');
  const [attendancePolicy]=await owner.db.select().from(s.attendancePolicy).where(eq(s.attendancePolicy.companyId,company.id));
  if(!attendancePolicy)await attendance.setAttendancePolicy(hrContext,{companyId:company.id,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
  const [day]=await owner.db.select().from(s.attendance).where(and(eq(s.attendance.employmentId,applicant.employmentId),eq(s.attendance.attendanceDate,today)));
  if(!day?.checkInAt)await attendance.checkIn(hrContext,{employmentId:applicant.employmentId,date:today,time:'08:00',manual:true});
  if(!day?.checkOutAt)await attendance.checkOut(hrContext,{employmentId:applicant.employmentId,date:today,time:'17:00',manual:true});
  const workflowCode='BOARD2_MIXED';
  let [workflow]=await owner.db.select().from(s.attendanceWorkflowTemplate).where(and(eq(s.attendanceWorkflowTemplate.companyId,company.id),eq(s.attendanceWorkflowTemplate.code,workflowCode),isNull(s.attendanceWorkflowTemplate.supersededAt)));
  if(!workflow){const saved=await attendance.saveAttendanceWorkflow(hrContext,{companyId:company.id,applicationType:'irregularity',routingVersion:4,code:workflowCode,name:'Board 2 fictional mixed sources',priority:100,active:true,criteria:{employeeIds:[applicant.employmentId]},stages:[{name:'Level 1',mode:'all_required',sources:[{kind:'direct_manager',depth:1},{kind:'specific_employee',employmentIds:[named.employmentId]}],hrAlternative:false},{name:'Level 2',mode:'sequential',sources:[{kind:'specific_employee',employmentIds:[hr.employmentId]}],hrAlternative:false}],cc:[]});[workflow]=await owner.db.select().from(s.attendanceWorkflowTemplate).where(eq(s.attendanceWorkflowTemplate.id,saved.id));}
  await attendance.setAttendanceWorkflowEnabled(hrContext,company.id,'irregularity',true);
  let [correction]=await owner.db.select().from(s.attendanceCorrection).where(and(eq(s.attendanceCorrection.employmentId,applicant.employmentId),eq(s.attendanceCorrection.attendanceDate,today))).orderBy(asc(s.attendanceCorrection.id));
  if(!correction){const saved=await attendance.requestAttendanceCorrection(await context({id:applicant.userId,personId:applicant.personId}),{employmentId:applicant.employmentId,date:today,checkIn:'09:00',checkOut:'18:00',reason:'Fictional Board 2 acceptance request'});[correction]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,saved.correctionId));}
  let [component]=await owner.db.select().from(s.payComponent).where(and(eq(s.payComponent.tenantId,tenantId),eq(s.payComponent.code,'ATTENDANCE')));
  if(!component){const defaults=requirePackFor('MY').payComponents.defaults.find(row=>row.code==='ATTENDANCE');if(!defaults)throw new Error('Canonical ATTENDANCE code missing.');await payroll.upsertPayComponent(root,{...defaults,label:defaults.name,rule:{kind:'fixed'}});[component]=await owner.db.select().from(s.payComponent).where(and(eq(s.payComponent.tenantId,tenantId),eq(s.payComponent.code,'ATTENDANCE')));}
  let [policy]=await owner.db.select().from(s.attendanceAllowancePolicy).where(and(eq(s.attendanceAllowancePolicy.companyId,company.id),eq(s.attendanceAllowancePolicy.code,'BOARD2_V4')));
  if(!policy){const rules=emptyAllowanceRulesV4();rules.employee.mode='selected';rules.employee.employmentIds=[applicant.employmentId];const saved=await attendance.createAllowancePolicy(hrContext,{companyId:company.id,code:'BOARD2_V4',name:'Board 2 fictional employee selection',policyType:'earning',method:'daily',amount:'12.50',effectiveFrom:`${today.slice(0,7)}-01`,payComponentId:component.id,rules});[policy]=await owner.db.select().from(s.attendanceAllowancePolicy).where(eq(s.attendanceAllowancePolicy.id,saved.id));}
  const batchIds:string[]=[];
  for(const period of [addMonths(today.slice(0,7),-1),today.slice(0,7)]){
   let [batch]=await owner.db.select().from(s.payrollBatch).where(and(eq(s.payrollBatch.companyId,company.id),eq(s.payrollBatch.payPeriod,period),eq(s.payrollBatch.runType,'regular')));
   if(!batch){const saved=await payroll.createBatch(hrContext,{companyId:company.id,payPeriod:period,paymentDate:today,scope:{employmentIds:paid.map(person=>person.employmentId)}});[batch]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,saved.batchId));}
   if(batch.status==='draft')await payroll.generatePayslips(hrContext,{batchId:batch.id});
   [batch]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batch.id));
   if(batch.status==='processed')await payroll.closeBatch(hrContext,{batchId:batch.id});
   else if(batch.status!=='closed')throw new Error('Fixture payroll is not in a canonical closable state.');
   const slips=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batch.id));
   if(!slips.length||slips.some(row=>Number(row.grossPay)<=0))throw new Error('Generated payroll lacks positive recorded payslips.');
   batchIds.push(batch.id);
  }
  const fixture:Fixture={version:2,tenantId,companyId:company.id,otherCompanyId:otherCompany.id,departmentId:department.id,actors,unlinkedUserId:unlinked.id,batchIds,policyId:policy.id,workflowLineageId:workflow.lineageId,correctionId:correction.id,createdOn:today};
  await owner.withTenant(root,tx=>appendEvent(tx,{tenantId,aggregateType:'dev-board2-fixture',aggregateId:company!.id,eventType,actor:actorOf(root),payload:fixture}));
  await manifest(fixture,false);

  async function manifest(fixture:Fixture,reused:boolean){
   const users=await owner.db.select({id:s.appUser.id,personId:s.appUser.personId,archivedAt:s.appUser.archivedAt}).from(s.appUser).where(inArray(s.appUser.id,[...fixture.actors.map(row=>row.userId),fixture.unlinkedUserId]));
   if(users.length!==7||users.some(row=>row.archivedAt)||users.find(row=>row.id===fixture.unlinkedUserId)?.personId!==null||fixture.actors.some(actor=>users.find(row=>row.id===actor.userId)?.personId!==actor.personId))throw new Error('Stored fixture logins changed; preserving saved data.');
   const currentGrants=await owner.db.select({userId:s.roleAssignment.appUserId,role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(inArray(s.roleAssignment.appUserId,users.map(row=>row.id))).orderBy(asc(s.roleAssignment.appUserId),asc(s.roleAssignment.role));
   const currentEmployments=await owner.db.select({id:s.employment.id,personId:s.employment.personId,companyId:s.employment.companyId,hiredOn:s.employment.hiredOn,joinDate:s.employment.joinDate,terminatedOn:s.employment.terminatedOn,blacklistedAt:s.employment.blacklistedAt}).from(s.employment).where(inArray(s.employment.id,fixture.actors.map(row=>row.employmentId))).orderBy(asc(s.employment.id));
   const batches=await owner.db.select().from(s.payrollBatch).where(inArray(s.payrollBatch.id,fixture.batchIds)).orderBy(asc(s.payrollBatch.payPeriod),asc(s.payrollBatch.id));
   const slips=await owner.db.select({id:s.payslip.id,batchId:s.payslip.batchId,employmentId:s.payslip.employmentId,gross:s.payslip.grossPay,net:s.payslip.netPay}).from(s.payslip).where(inArray(s.payslip.batchId,fixture.batchIds)).orderBy(asc(s.payslip.batchId),asc(s.payslip.employmentId),asc(s.payslip.id));
   const [documentEmployer]=await owner.db.select({id:s.company.id,legalName:s.company.legalName,registrationNo:s.company.registrationNo,addressLine1:s.company.addressLine1,city:s.company.city,state:s.company.state,postcode:s.company.postcode}).from(s.company).where(eq(s.company.id,fixture.companyId));
   const [documentReferences]=await owner.db.select({epfEmployerNo:s.companyStatutoryMy.epfEmployerNo,socsoEmployerCode:s.companyStatutoryMy.socsoEmployerCode,lhdnEmployerNo:s.companyStatutoryMy.lhdnEmployerNo,myinvoisTin:s.companyStatutoryMy.myinvoisTin,ssmRegistrationNo:s.companyStatutoryMy.ssmRegistrationNo}).from(s.companyStatutoryMy).where(eq(s.companyStatutoryMy.companyId,fixture.companyId));
   const [documentSignatory]=await owner.db.select({personId:s.companyStatutoryAuthority.signatoryPersonId,phone:s.companyStatutoryAuthority.phone,email:s.companyStatutoryAuthority.email}).from(s.companyStatutoryAuthority).where(and(eq(s.companyStatutoryAuthority.companyId,fixture.companyId),eq(s.companyStatutoryAuthority.authority,'lhdn')));
   mkdirSync(output,{recursive:true,mode:0o700});
   writeFileSync(new URL('fixture.json',output),JSON.stringify({...fixture,reused,currentGrants,currentEmployments,batches,slips,documentSources:{employer:documentEmployer,references:documentReferences,signatory:documentSignatory},screenPaths:['/admin/attendance-allowance','/admin/attendance/approval-workflow','/attendance','/attendance/application-history','/attendance/my-roster','/admin/personnel','/me/payslip','/me/tax-relief','/me/tp3','/me/ea'],limitations:['Prepared fictional data only; actual app outcomes remain unverified.','No CC transport, real provider identities, consent or email enabled. Use captured delivery tests and the private-service rehearsal.','Overtime cash/TOIL fixtures require Board 1 final canonical execution.','Holiday replacements, transfer/rehire, additional run types/currencies and unavailable EA/TP1/TP3 states remain explicit journey extensions.','At a January boundary the current-year applicant has no prior-year payslip; the historical manager/HR fixtures retain the two-period journey.','Completed reruns preserve browser changes and report current recorded payroll.']},null,2)+'\n',{mode:0o600});
   console.log(JSON.stringify({fixture:'board2-approved',reused,actors:fixture.actors.length,unlinked:1,batches:batches.length,payslips:slips.length,manifest:new URL('fixture.json',output).pathname}));
  }
 }finally{
  try{await lock`select pg_advisory_unlock(hashtextextended('board2-approved-browser-fixture',0))`;}finally{lock.release();await client.end({timeout:5});await owner.client.end({timeout:5});}
 }
}
main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
