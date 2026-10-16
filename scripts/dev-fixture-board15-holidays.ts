/** Fictional replacement holiday journeys, restricted to one named local disposable database. */
import {and,eq,isNull} from 'drizzle-orm';
import {createDb,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard';
import {resolveEntitlementsTx} from '../core/entitlements';
import {createCompany,createBusinessUnit,createDepartment} from '../core/admin';
import {hireEmployee} from '../core/org';
import {createShift,assignDefaultShift} from '../core/roster';
import {setAttendancePolicy} from '../packs/attendance/service';
import {saveReplacementHolidayPolicy} from '../core/holiday-replacements';
import {listReplacementHolidays} from '../core/holiday-replacement-read';
import {sweepReplacementHolidayQueue} from './replacement-holiday-sweep';
import {addHolidayDays} from '../lib/holiday-replacement';
import {todayInKualaLumpur} from '../lib/hr-date';
if(demoSeedRefusal(process.env))throw new Error(demoSeedRefusal(process.env)!);
if(process.env.NODE_ENV==='production')throw new Error('Local development only.');
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']){
 const url=new URL(process.env[key]??'');
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/ai_hr_board15holiday_browser')throw new Error('Only the named localhost:5433 disposable holiday database is allowed.');
}
const owner=createDb(process.env.MIGRATION_DATABASE_URL!),tenantId=DEMO_TENANT_ID;
async function context(user:typeof s.appUser.$inferSelect):Promise<SessionContext>{
 const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
 return {tenantId,userId:user.id,personId:user.personId,roles:[...new Set(grants.map(g=>g.role))],grants,entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId))};
}
async function principal(key:string,personId:string,role:'hr_admin'|'employee',companyId:string|null){
 const workosUserId=`board15-holidays:${key}`;
 let [user]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,workosUserId)));
 if(!user)[user]=await owner.db.insert(s.appUser).values({tenantId,personId,workosUserId,onboardedAt:new Date()}).returning();
 if(user.personId!==personId||user.archivedAt)throw new Error('Existing fixture principal was changed; preserving it.');
 const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
 if(!grants.length)await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:user.id,role,companyId});
 else if(grants.length!==1||grants[0].role!==role||grants[0].companyId!==companyId)throw new Error('Existing fixture grants were changed; preserving them.');
 return user;
}
async function main(){
 if((await owner.db.select({id:s.tenant.id}).from(s.tenant)).some(t=>![tenantId,SYSTEM_TENANT_ID].includes(t.id)))throw new Error('Non-demo tenant detected; refusing.');
 for(const moduleCode of ['attendance','payroll']){
  const [row]=await owner.db.select().from(s.tenantModule).where(and(eq(s.tenantModule.tenantId,tenantId),eq(s.tenantModule.moduleCode,moduleCode),isNull(s.tenantModule.companyId)));
  if(!row)await owner.db.insert(s.tenantModule).values({tenantId,moduleCode,status:'active'});
  else if(row.status!=='active'||row.expiresAt)throw new Error('Existing commercial grant was changed; preserving it.');
 }
 const [seed]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,'user_dev_admin')));if(!seed)throw new Error('Demo seed is required first.');
 let [hrPerson]=await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,'board15-holidays-hr@demo.test')));
 if(!hrPerson)[hrPerson]=await owner.db.insert(s.person).values({tenantId,fullName:'Holidays fictional HR',primaryEmail:'board15-holidays-hr@demo.test'}).returning();
 const hr=await principal('hr',hrPerson.id,'hr_admin',null),ctx=await context(hr),bootstrap=await context(seed);
 const [already]=await owner.db.select().from(s.company).where(and(eq(s.company.tenantId,tenantId),eq(s.company.companyLabel,'BOARD15-HOLIDAY-A')));
 const scenarios:{key:string;companyId:string;employmentId?:string;userId?:string;sourceDate?:string}[]=[];
 for(const key of ['A','B','C','REVIEW','EMPTY']){
  const label=`BOARD15-HOLIDAY-${key}`;
  let [company]=await owner.db.select().from(s.company).where(and(eq(s.company.tenantId,tenantId),eq(s.company.companyLabel,label)));
  if(!company){const made=await createCompany(bootstrap,{legalName:`Replacement holiday ${key} (fictional)`,companyLabel:label,country:'MY',currency:'MYR'});[company]=await owner.db.select().from(s.company).where(eq(s.company.id,made.id));await owner.db.update(s.company).set({defaultWorkState:'Selangor'}).where(eq(s.company.id,company.id));}
  if(key==='EMPTY'){scenarios.push({key,companyId:company.id});continue;}
  let [original]=await owner.db.select().from(s.holiday).where(and(eq(s.holiday.companyId,company.id),eq(s.holiday.name,'Fictional original public holiday')));
  if(!original)[original]=await owner.db.insert(s.holiday).values({tenantId,country:'MY',companyId:company.id,holidayDate:addHolidayDays(todayInKualaLumpur(),3),name:'Fictional original public holiday'}).returning();
  const sourceDate=original.holidayDate,next=addHolidayDays(sourceDate,1),dow=(date:string)=>new Date(date+'T00:00:00Z').getUTCDay()||7;
  if(key==='B'){
   const [following]=await owner.db.select().from(s.holiday).where(and(eq(s.holiday.companyId,company.id),eq(s.holiday.name,'Fictional following public holiday')));
   if(!following)await owner.db.insert(s.holiday).values({tenantId,country:'MY',companyId:company.id,holidayDate:next,name:'Fictional following public holiday'});
  }
  let [bu]=await owner.db.select().from(s.businessUnit).where(and(eq(s.businessUnit.companyId,company.id),eq(s.businessUnit.code,'HOLIDAYS')));
  if(!bu){const made=await createBusinessUnit(ctx,{companyId:company.id,code:'HOLIDAYS',name:'Fictional holiday unit'});[bu]=await owner.db.select().from(s.businessUnit).where(eq(s.businessUnit.id,made.id));}
  let [department]=await owner.db.select().from(s.department).where(and(eq(s.department.companyId,company.id),eq(s.department.name,'Fictional holiday department')));
  if(!department){const made=await createDepartment(ctx,{companyId:company.id,businessUnitId:bu.id,name:'Fictional holiday department'});[department]=await owner.db.select().from(s.department).where(eq(s.department.id,made.id));}
  let [shift]=await owner.db.select().from(s.shift).where(and(eq(s.shift.tenantId,tenantId),eq(s.shift.code,`HOLIDAY-${key}`)));
  if(!shift){const made=await createShift(ctx,{companyId:company.id,name:`Fictional holiday ${key}`,code:`HOLIDAY-${key}`,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7].filter(d=>d!==dow(sourceDate)&&(key!=='C'||d!==dow(next)))});[shift]=await owner.db.select().from(s.shift).where(eq(s.shift.id,made.id));}
  const email=`board15-holidays-${key.toLowerCase()}@demo.test`;
  let [person]=await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,email)));
  let [emp]=person?await owner.db.select().from(s.employment).where(and(eq(s.employment.personId,person.id),eq(s.employment.companyId,company.id))):[];
  if(!emp){const made=await hireEmployee(ctx,{person:{fullName:`Holidays fictional ${key}`,primaryEmail:email},companyId:company.id,departmentId:department.id,employmentType:'full_time',hiredOn:addHolidayDays(todayInKualaLumpur(),-90)});[emp]=await owner.db.select().from(s.employment).where(eq(s.employment.id,made.employmentId));await assignDefaultShift(ctx,{employmentId:emp.id,shiftId:shift.id});}
  const user=await principal(key.toLowerCase(),emp.personId,'employee',company.id);
  const policies=await owner.db.select().from(s.replacementHolidayPolicy).where(eq(s.replacementHolidayPolicy.companyId,company.id));
  if(!policies.length&&key!=='REVIEW')await saveReplacementHolidayPolicy(ctx,{companyId:company.id,effectiveFrom:todayInKualaLumpur(),regime:'company_confirmed',confirmed:true,restMode:'scheduled_rest',halfEligible:false,searchDays:30,reason:'Fictional explicit company rule for local verification; no statutory applicability inferred.'});
  const [attendancePolicy]=await owner.db.select().from(s.attendancePolicy).where(eq(s.attendancePolicy.companyId,company.id));
  if(!attendancePolicy)await setAttendancePolicy(ctx,{companyId:company.id,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});
  scenarios.push({key,companyId:company.id,employmentId:emp.id,userId:user.id,sourceDate});
 }
 const a=scenarios.find(s=>s.key==='A')!;const scopedHr=await principal('scoped-hr',hrPerson.id,'hr_admin',a.companyId);
 // Invoke the same exported automatic queue pass as the deployed runner, rather than calling allocation
 // manually for each employee. A completed repeat leaves configured policy and manual decisions intact.
 const sweep=await sweepReplacementHolidayQueue(owner,{limitPerTenant:100});if(sweep.failed)throw new Error('Automatic holiday fixture sweep failed.');
 const allocations=await listReplacementHolidays(ctx,{companyIds:scenarios.map(s=>s.companyId)});
 console.log(JSON.stringify({reused:!!already,logins:[{key:'hr',id:hr.id},{key:'scoped-hr',id:scopedHr.id},...scenarios.filter(s=>s.userId).map(s=>({key:s.key.toLowerCase(),id:s.userId,employmentId:s.employmentId}))],scenarios,allocations:allocations.map(row=>({id:row.id,employmentId:row.employmentId,sourceDate:row.sourceDate,date:row.replacementDate,status:row.status,reason:row.reason})),sweep,limitations:['Fictional company rules; no production or statutory defaults changed.','Completed repeats preserve existing UI edits.','Browser, TypeScript and runtime verification still required.']}));
}
main().then(async()=>{await owner.client.end();process.exit(0);}).catch(async error=>{console.error(error);await owner.client.end();process.exit(1);});
