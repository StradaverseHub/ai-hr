/** Fictional Attendance hierarchy journey, only in its named disposable local database.
 * Run cleanly twice before the app walkthrough. Existing decisions/configuration are preserved.
 * Business facts use their canonical owners; the migration connection creates only fictional logins.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { DEMO_TENANT_ID, SYSTEM_TENANT_ID, demoSeedRefusal } from '../db/seed-guard';
import { resolveEntitlementsTx } from '../core/entitlements';
import { createCompany, createDepartment, createPosition, createBusinessUnit, createJobGrade } from '../core/admin';
import { hireEmployee, setReportingLine, setEmploymentInfo, setEmploymentAssignment } from '../core/org';
import { createProfileOption, EMPLOYMENT_PROFILE_CATEGORIES, CATEGORY_EMPLOYMENT_COLUMN } from '../core/profile-options';
import { checkIn, checkOut, requestAttendanceCorrection, saveAttendanceWorkflow, setAttendanceWorkflowEnabled, type AttendanceWorkflowInput } from '../packs/attendance/service';
import { todayInKualaLumpur } from '../lib/hr-date';
const refusal=demoSeedRefusal(process.env);
if(refusal||process.env.NODE_ENV==='production')throw new Error(refusal??'Development only');
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']){
  const url=new URL(process.env[key]!);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/ai_hr_board15_approval_browser')throw new Error('Only the named disposable approval database is allowed.');
}
const owner=createDb(process.env.MIGRATION_DATABASE_URL!),tenantId=DEMO_TENANT_ID,today=todayInKualaLumpur();
const addDays=(date:string,n:number)=>new Date(Date.parse(`${date}T00:00:00Z`)+n*86400000).toISOString().slice(0,10);
async function context(user:{id:string;personId:string|null}):Promise<SessionContext>{
  const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
  const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId));
  return {tenantId,userId:user.id,personId:user.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements};
}
async function main(){
  const tenants=await owner.db.select().from(s.tenant);
  if(!tenants.some(t=>t.id===tenantId)||tenants.some(t=>t.id!==tenantId&&t.id!==SYSTEM_TENANT_ID))throw new Error('Seeded demo tenants only.');
  const [seedAdmin]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,'user_dev_admin'),isNull(s.appUser.archivedAt)));
  if(!seedAdmin)throw new Error('Seed administrator missing.');const bootstrap=await context(seedAdmin);
  const companies:Record<string,string>={},departments:Record<string,string>={};
  for(const key of ['Main','Empty','Foreign']){
    let [company]=await owner.db.select().from(s.company).where(and(eq(s.company.tenantId,tenantId),eq(s.company.companyLabel,`APPROVAL15-${key}`)));
    if(!company){const made=await createCompany(bootstrap,{legalName:`Approval hierarchy fixture ${key}`,companyLabel:`APPROVAL15-${key}`,country:'MY',currency:'MYR'});[company]=await owner.db.select().from(s.company).where(eq(s.company.id,made.id));}
    if(company.archivedAt)throw new Error('Existing fixture company archived; preserving it.');companies[key]=company.id;
    for(const team of key==='Main'?['Applicants','Superiors']:[key]){
      let [department]=await owner.db.select().from(s.department).where(and(eq(s.department.companyId,company.id),eq(s.department.name,`Approval fixture ${team}`)));
      if(!department){const made=await createDepartment(bootstrap,{companyId:company.id,name:`Approval fixture ${team}`});[department]=await owner.db.select().from(s.department).where(eq(s.department.id,made.id));}departments[team]=department.id;
    }
  }
  let [position]=await owner.db.select().from(s.position).where(and(eq(s.position.companyId,companies.Main),eq(s.position.title,'Approval fixture specialist')));
  if(!position){const made=await createPosition(bootstrap,{companyId:companies.Main,title:'Approval fixture specialist'});[position]=await owner.db.select().from(s.position).where(eq(s.position.id,made.id));}
  let [unit]=await owner.db.select().from(s.businessUnit).where(and(eq(s.businessUnit.companyId,companies.Main),eq(s.businessUnit.code,'APPROVAL15')));
  if(!unit){const made=await createBusinessUnit(bootstrap,{companyId:companies.Main,code:'APPROVAL15',name:'Approval fixture unit'});[unit]=await owner.db.select().from(s.businessUnit).where(eq(s.businessUnit.id,made.id));}
  let [grade]=await owner.db.select().from(s.jobGrade).where(and(eq(s.jobGrade.tenantId,tenantId),eq(s.jobGrade.code,'APPROVAL15')));
  if(!grade){const made=await createJobGrade(bootstrap,{code:'APPROVAL15',name:'Approval fixture grade'});[grade]=await owner.db.select().from(s.jobGrade).where(eq(s.jobGrade.id,made.id));}
  const profile:Record<string,string>={};
  for(const category of EMPLOYMENT_PROFILE_CATEGORIES){
    const value=`Approval15 ${category}`;let [option]=await owner.db.select().from(s.profileOption).where(and(eq(s.profileOption.tenantId,tenantId),eq(s.profileOption.category,category),eq(s.profileOption.value,value)));
    if(!option){await createProfileOption(bootstrap,{category,value,label:value});[option]=await owner.db.select().from(s.profileOption).where(and(eq(s.profileOption.category,category),eq(s.profileOption.value,value)));}
    if(!option.isActive)throw new Error('Existing fixture option deactivated; preserving it.');profile[CATEGORY_EMPLOYMENT_COLUMN[category]![0]]=value;
  }
  const people:Record<string,{employmentId:string;personId:string;userId:string;login:string}>={};
  for(const key of ['D','D2','A','Arjun','Daniel','HR','OtherHR','NoSuperior','ForeignHR']){
    const companyKey=key==='ForeignHR'?'Foreign':'Main',applicant=key==='D'||key==='D2'||key==='NoSuperior',departmentId=companyKey==='Foreign'?departments.Foreign:applicant?departments.Applicants:departments.Superiors,email=`approval15-${key.toLowerCase()}@demo.test`;
    let [person]=await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,email)));
    let [employment]=person?await owner.db.select().from(s.employment).where(and(eq(s.employment.personId,person.id),eq(s.employment.companyId,companies[companyKey]))):[];
    if(!person&&!employment){
      const made=await hireEmployee(bootstrap,{person:{fullName:key==='D2'?'Approval D':`Approval ${key}`,primaryEmail:email},employeeCode:`AP15-${key.toUpperCase()}`,companyId:companies[companyKey],departmentId,positionId:companyKey==='Main'?position.id:undefined,gradeId:grade.id,employmentType:'full_time',hiredOn:addDays(today,-365)});
      [person]=await owner.db.select().from(s.person).where(eq(s.person.id,made.personId));[employment]=await owner.db.select().from(s.employment).where(eq(s.employment.id,made.employmentId));
      if(companyKey==='Main'){await setEmploymentAssignment(bootstrap,{employmentId:employment.id,effectiveDate:employment.hiredOn,businessUnitId:unit.id});await setEmploymentInfo(bootstrap,{employmentId:employment.id,...profile});}
    }
    if(!person||!employment||employment.terminatedOn)throw new Error('Existing fixture person changed; preserving it.');
    const login=`approval15-fixture:${key}`;let [user]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,login)));
    if(!user)[user]=await owner.db.insert(s.appUser).values({tenantId,personId:person.id,workosUserId:login,onboardedAt:new Date()}).returning();
    if(user.archivedAt||user.personId!==person.id)throw new Error('Existing fixture login changed; preserving it.');
    const role=['HR','OtherHR','ForeignHR'].includes(key)?'hr_admin' as const:applicant?'employee' as const:'manager' as const;
    const expected=[{role,companyId:companies[companyKey]},...(key==='HR'?[{role:'hr_admin' as const,companyId:companies.Empty}]:[])];
    const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
    if(!grants.length)await owner.db.insert(s.roleAssignment).values(expected.map(g=>({tenantId,appUserId:user.id,...g})));
    else if(grants.length!==expected.length||expected.some(g=>!grants.some(r=>r.role===g.role&&r.companyId===g.companyId)))throw new Error('Existing fixture grants changed; preserving them.');
    people[key]={employmentId:employment.id,personId:person.id,userId:user.id,login};
  }
  for(const [sub,manager] of [['D','A'],['D2','A'],['A','Arjun'],['Arjun','Daniel']]){
    const [line]=await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId,people[sub].employmentId),eq(s.reportingLine.lineType,'administrative'),isNull(s.reportingLine.validTo),isNull(s.reportingLine.supersededAt)));
    if(!line)await setReportingLine(bootstrap,{subordinateEmploymentId:people[sub].employmentId,managerEmploymentId:people[manager].employmentId,lineType:'administrative',validFrom:addDays(today,-365)});
    else if(line.managerEmploymentId!==people[manager].employmentId)throw new Error('Existing fixture reporting path changed; preserving it.');
  }
  const hr=await context({id:people.HR.userId,personId:people.HR.personId}),templates:Record<string,string>={},requests:Record<string,string>={};
  for(const applicationType of ['irregularity','self_overtime'] as const){
    const code=applicationType==='irregularity'?'AP15_IRR':'AP15_OT';let [template]=await owner.db.select().from(s.attendanceWorkflowTemplate).where(and(eq(s.attendanceWorkflowTemplate.companyId,companies.Main),eq(s.attendanceWorkflowTemplate.code,code),isNull(s.attendanceWorkflowTemplate.supersededAt)));
    if(!template){const value:AttendanceWorkflowInput={companyId:companies.Main,code,name:`Approval fixture ${applicationType}`,applicationType,routingVersion:2,priority:100,criteria:{employeeIds:[people.D.employmentId,people.D2.employmentId]},active:true,stages:Array.from({length:3},(_,i)=>({name:`Level ${i+1}`,level:{kind:'direct_manager',employmentId:null,alternates:[]}}))};template=await saveAttendanceWorkflow(hr,value);}
    if(template.routingVersion!==2||!template.active||template.stages.length!==3)throw new Error('Existing fixture workflow changed; preserving it.');templates[applicationType]=template.lineageId;
    const [setting]=await owner.db.select().from(s.attendanceWorkflowSetting).where(and(eq(s.attendanceWorkflowSetting.companyId,companies.Main),eq(s.attendanceWorkflowSetting.applicationType,applicationType)));
    if(!setting?.enabled)await setAttendanceWorkflowEnabled(hr,companies.Main,applicationType,true);
  }
  const recent=addDays(today,-7),date=addDays(recent,3-new Date(`${recent}T00:00:00Z`).getUTCDay()),self=await context({id:people.D.userId,personId:people.D.personId});
  for(const [type,offset] of [['irregularity',0],['self_overtime',-1]] as const){
    const on=addDays(date,offset);let [day]=await owner.db.select().from(s.attendance).where(and(eq(s.attendance.employmentId,people.D.employmentId),eq(s.attendance.attendanceDate,on)));
    if(!day){await checkIn(hr,{employmentId:people.D.employmentId,date:on,time:'08:00',manual:true});await checkOut(hr,{employmentId:people.D.employmentId,date:on,time:'17:00',manual:true});}
    const reason=`Approval15 fixture ${type}`;let [request]=await owner.db.select().from(s.attendanceCorrection).where(and(eq(s.attendanceCorrection.employmentId,people.D.employmentId),eq(s.attendanceCorrection.reason,reason)));
    if(!request){const made=await requestAttendanceCorrection(self,{employmentId:people.D.employmentId,date:on,...(type==='irregularity'?{checkIn:'09:00',checkOut:'18:00'}:{requestedOtMinutes:60,requestKind:'self_overtime' as const}),reason});[request]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,made.correctionId));}requests[type]=request.id;
  }
  console.log(JSON.stringify({today,date,companies,departments,positionId:position.id,businessUnitId:unit.id,gradeId:grade.id,profile,people,templates,requests},null,2));await owner.client.end();
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
