/** Local fictional Schedule journeys. Run under both test slots + dev DB lock; repeated completed runs preserve edits. */
import {and,eq,isNull} from 'drizzle-orm';
import {createDb,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard';
import {resolveEntitlementsTx} from '../core/entitlements';
import {createCompany,createBusinessUnit,createDepartment} from '../core/admin';
import {hireEmployee,setReportingLine} from '../core/org';
import {createShift,assignDefaultShift,setEmploymentScheduleGroup} from '../core/roster';
import {createAttendanceRule,setRuleShifts,listScheduleGroupMemberships,checkIn,checkOut,saveShiftPay,type AttendanceRuleInput} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
if(demoSeedRefusal(process.env))throw new Error(demoSeedRefusal(process.env)!);
if(process.env.NODE_ENV==='production')throw new Error('Local development only.');
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']){
 const url=new URL(process.env[key]??'');
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/ai_hr_board15schedules_browser')throw new Error('This fixture requires its own named localhost:5433 disposable database.');
}
const owner=createDb(process.env.MIGRATION_DATABASE_URL!),tenantId=DEMO_TENANT_ID;
async function context(user:typeof s.appUser.$inferSelect):Promise<SessionContext>{const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));return {tenantId,userId:user.id,personId:user.personId,roles:[...new Set(grants.map(g=>g.role))],grants,entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId))};}
async function principal(key:string,personId:string,role:'hr_admin'|'manager'|'employee',companyId:string|null){
 const workosUserId=`board15-schedules:${key}`;let [user]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,workosUserId)));
 if(!user)[user]=await owner.db.insert(s.appUser).values({tenantId,personId,workosUserId,onboardedAt:new Date()}).returning();
 if(user.personId!==personId||user.archivedAt)throw new Error('Fixture principal changed; preserving it.');
 const roles=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
 if(!roles.length)await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:user.id,role,companyId});
 else if(roles.length!==1||roles[0].role!==role||roles[0].companyId!==companyId)throw new Error('Fixture grants changed; preserving them.');
 return user;
}
const ruleInput=(name:string,label:string):AttendanceRuleInput=>({name,label,weeklyPattern:[1,2,3,4,5],halfPattern:[],offPattern:[6],lateGracePeriodMinutes:0,lateAfterMinutes:5,lateDeductMinutes:5,includeGraceInLateness:false,earlyGracePeriodMinutes:1,earlyAfterMinutes:5,earlyDeductMinutes:5,includeGraceInEarlyOut:false,applyDeductions:true,applyToEarlyOt:false,otRows:[{fromMinutes:0,toMinutes:120,ratePattern:'flat',rate:1.5,phRate:null,roundingMode:'down',roundToMinutes:15}]});
async function main(){
 const tenants=await owner.db.select({id:s.tenant.id}).from(s.tenant);if(tenants.some(t=>![tenantId,SYSTEM_TENANT_ID].includes(t.id)))throw new Error('A non-demo tenant exists; refusing.');
 for(const moduleCode of ['attendance','payroll','typed_pay_components']){const [module]=await owner.db.select().from(s.tenantModule).where(and(eq(s.tenantModule.tenantId,tenantId),eq(s.tenantModule.moduleCode,moduleCode),isNull(s.tenantModule.companyId)));if(!module)await owner.db.insert(s.tenantModule).values({tenantId,moduleCode,status:'active'});else if(module.status!=='active'||module.expiresAt)throw new Error('Existing module grant is not active; preserving it.');}
 const [seed]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,'user_dev_admin')));if(!seed)throw new Error('Run demo seed first.');const bootstrap=await context(seed);
 let [company]=await owner.db.select().from(s.company).where(and(eq(s.company.tenantId,tenantId),eq(s.company.companyLabel,'BOARD15-SCHEDULES')));const reused=!!company;
 if(!company){const made=await createCompany(bootstrap,{legalName:'Schedule board review (fictional)',companyLabel:'BOARD15-SCHEDULES',country:'MY',currency:'MYR'});[company]=await owner.db.select().from(s.company).where(eq(s.company.id,made.id));}
 let [hrPerson]=await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,'board15-schedules-hr@demo.test')));
 if(!hrPerson)[hrPerson]=await owner.db.insert(s.person).values({tenantId,fullName:'Schedules fictional HR',primaryEmail:'board15-schedules-hr@demo.test'}).returning();
 const hr=await principal('hr',hrPerson.id,'hr_admin',null),ctx=await context(hr);
 let [bu]=await owner.db.select().from(s.businessUnit).where(and(eq(s.businessUnit.companyId,company.id),eq(s.businessUnit.code,'SCHEDULES')));if(!bu){const made=await createBusinessUnit(ctx,{companyId:company.id,code:'SCHEDULES',name:'Schedules fictional unit'});[bu]=await owner.db.select().from(s.businessUnit).where(eq(s.businessUnit.id,made.id));}
 let [dept]=await owner.db.select().from(s.department).where(and(eq(s.department.companyId,company.id),eq(s.department.name,'Schedules fictional department')));if(!dept){const made=await createDepartment(ctx,{companyId:company.id,businessUnitId:bu.id,name:'Schedules fictional department'});[dept]=await owner.db.select().from(s.department).where(eq(s.department.id,made.id));}
 const groups=[];for(const [name,label] of [['Schedules review Office','OFFICE'],['Schedules review Plant','PLANT']]){let [group]=await owner.db.select().from(s.attendanceRule).where(and(eq(s.attendanceRule.tenantId,tenantId),eq(s.attendanceRule.name,name)));const fresh=!group;if(!group){const made=await createAttendanceRule(ctx,ruleInput(name,label));[group]=await owner.db.select().from(s.attendanceRule).where(eq(s.attendanceRule.id,made.id));}groups.push({group,fresh});}
 const shifts=[];for(const [code,type] of [['BOARD15-SHARED','normal'],['BOARD15-FLEXI','full_flexi']] as const){let [shift]=await owner.db.select().from(s.shift).where(and(eq(s.shift.tenantId,tenantId),eq(s.shift.code,code)));if(!shift){const made=await createShift(ctx,{companyId:company.id,name:type==='normal'?'Schedules review shared fixed':'Schedules review Full Flexi',code,type,startTime:type==='normal'?'09:00':null,endTime:type==='normal'?'18:00':null,normalMinutesOverride:type==='full_flexi'?480:null,weeklyPattern:[1,2,3,4,5],breakPeriods:[{start:'12:00',end:'13:00',flexible:true,flexibleMinutes:30}],color:type==='normal'?'#334155':'#7C3AED',ruleId:type==='normal'?groups[0].group.id:null});[shift]=await owner.db.select().from(s.shift).where(eq(s.shift.id,made.id));if(type==='normal')await saveShiftPay(ctx,{shiftId:shift.id,windows:[{label:'Evening',startTime:'18:00',endTime:'21:00'}],differential:{kind:'flat_per_shift',value:20},confirmClear:false});}shifts.push(shift);}
 for(const {group,fresh} of groups)if(fresh)await setRuleShifts(ctx,{ruleId:group.id,shiftIds:shifts.map(sh=>sh.id)});
 const people=[];const today=todayInKualaLumpur(),date=new Date(Date.parse(today+'T00:00:00Z')-7*86400000).toISOString().slice(0,10);
 for(const [key,role,shiftId,groupId] of [['manager','manager',shifts[0].id,groups[0].group.id],['fixed','employee',shifts[0].id,groups[1].group.id],['flexi','employee',shifts[1].id,groups[0].group.id]] as const){
  const email=`board15-schedules-${key}@demo.test`;let [person]=await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,email)));let [emp]=person?await owner.db.select().from(s.employment).where(and(eq(s.employment.personId,person.id),eq(s.employment.companyId,company.id))):[];
  if(!emp){const made=await hireEmployee(ctx,{person:{fullName:`Schedules fictional ${key}`,primaryEmail:email},companyId:company.id,departmentId:dept.id,employmentType:'full_time',hiredOn:date});[emp]=await owner.db.select().from(s.employment).where(eq(s.employment.id,made.employmentId));await assignDefaultShift(ctx,{employmentId:emp.id,shiftId});await setEmploymentScheduleGroup(ctx,{employmentId:emp.id,attendanceRuleId:groupId});if(key==='flexi'){await checkIn(ctx,{employmentId:emp.id,date,time:'09:00'});await checkOut(ctx,{employmentId:emp.id,date,time:'12:00'});await checkIn(ctx,{employmentId:emp.id,date,time:'13:00'});await checkOut(ctx,{employmentId:emp.id,date,time:'18:30'});}}
  const user=await principal(key,emp.personId,role,company.id);people.push({key,userId:user.id,employmentId:emp.id});
 }
 const manager=people.find(p=>p.key==='manager')!;for(const e of people.filter(p=>p.key!=='manager')){const [line]=await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId,e.employmentId),eq(s.reportingLine.lineType,'administrative'),isNull(s.reportingLine.validTo)));if(!line)await setReportingLine(ctx,{subordinateEmploymentId:e.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:date});}
 const memberships=await listScheduleGroupMemberships(ctx);
 console.log(JSON.stringify({reused,companyId:company.id,logins:[{key:'hr',id:hr.id},...people.map(p=>({key:p.key,id:p.userId,employmentId:p.employmentId}))],groups:groups.map(({group})=>({id:group.id,name:group.name})),shifts:shifts.map(sh=>({id:sh.id,code:sh.code})),attendanceDate:date,memberships:memberships.filter(m=>groups.some(g=>g.group.id===m.ruleId)),limitations:['No browser actions or release have run.','Group-wide HR is fictional and exists only in the named local disposable database.','Completed fixture reruns preserve edits; use a fresh database to restore initial state.']}));
}
main().then(async()=>{await owner.client.end();process.exit(0);}).catch(async e=>{console.error(e);await owner.client.end();process.exit(1);});
