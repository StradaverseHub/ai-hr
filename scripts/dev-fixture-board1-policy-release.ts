/** Fresh named-local fixture: prospective owners, plus an explicitly separate historical replay profile.
 * Capture timestamps are fixture evidence, not a claim that browser clocking or historical
 * activation has been exercised. Approval and settlement are deliberately left for the app. */
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {board1LocalAcceptanceTarget} from './board1-local-acceptance-target';
import type {Base} from '../test/harness';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createShift,assignDefaultShift,setEmploymentScheduleGroup} from '../core/roster';
import {createPayComponent,createBatch} from '../packs/payroll/service';
import {requirePackFor} from '../localization/registry';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import {setToilPolicy} from '../core/toil';
import {createAttendanceRule,setRuleShifts,saveOvertimePatternDraft,validateOvertimePatternActivation,activateOvertimePattern,scheduleAttendanceGroupPolicy,checkInTx,checkOutTx,type AttendanceRuleInput} from '../packs/attendance/service';
import {prepareOvertimeStarter} from '../lib/overtime-pattern-starters';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {todayInKualaLumpur} from '../lib/hr-date';

const target=board1LocalAcceptanceTarget();
if(process.env.BOARD1_ACCEPTANCE_TARGET!=='release20261023'||process.env.NODE_ENV==='production')throw Error('Fresh local release fixture only.');
for(const raw of [process.env.DATABASE_URL,process.env.MIGRATION_DATABASE_URL]){
 const u=new URL(raw??'');if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1'].includes(u.hostname)||u.port!=='5433'||u.pathname!=='/'+target.homeDatabase||u.search||u.hash)throw Error('Named disposable release database only.');
}
process.env.TEST_DATABASE_URL=process.env.DATABASE_URL;process.env.TEST_MIGRATION_DATABASE_URL=process.env.MIGRATION_DATABASE_URL;
const profile=process.env.BOARD1_POLICY_FIXTURE_PROFILE??'initial';
if(!['initial','positioned','historicalCurrent'].includes(profile))throw Error('Choose an explicit fictional fixture profile.');
const historicalCurrent=profile==='historicalCurrent';
const prefix=historicalCurrent?'REL24C':profile==='positioned'?'REL23P':'REL23';
const destination=target.directory+(historicalCurrent?'/policy-historical-current-fixture.json':profile==='positioned'?'/policy-positioned-fixture.json':'/policy-fixture.json');
const add=(date:string,days:number)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const ruleInput=(name:string,label:string):AttendanceRuleInput=>({name,label,weeklyPattern:historicalCurrent?[1,2,3,4,5,6,7]:[1,2,3,4,5],halfPattern:[],offPattern:historicalCurrent?[]:[6],lateGracePeriodMinutes:0,lateAfterMinutes:5,lateDeductMinutes:5,includeGraceInLateness:false,earlyGracePeriodMinutes:0,earlyAfterMinutes:5,earlyDeductMinutes:5,includeGraceInEarlyOut:false,applyDeductions:true,applyToEarlyOt:false,otRows:[]});
async function main(){
 const {owner,entitledCtx,createAppUser,setModule}=await import('../test/harness');
 if(await readFile(destination,'utf8').then(()=>true,()=>false))throw Error('Policy fixture already has identities; preserve them and their app edits.');
 const f=JSON.parse(await readFile(target.directory+'/home-fixture.json','utf8')) as Base&{people:{scopedHr:{userId:string;personId:string;employmentId:string}}};
 const [tenant]=await owner.db.select().from(s.tenant).where(eq(s.tenant.id,f.tenantId));
 if(tenant?.name!=='Fictional Board 1 Home Acceptance')throw Error('Fresh fictional tenant receipt mismatch.');
 for(const code of ['attendance','payroll','typed_pay_components','toil'])await setModule(f.tenantId,code,'active');
 const hr=f.people.scopedHr;
 const ctx={...await entitledCtx(f),userId:hr.userId,personId:hr.personId,roles:['hr_admin'],grants:[{role:'hr_admin' as const,companyId:f.companyId}]};
 const today=todayInKualaLumpur(),effectiveFrom=add(today,1);
 let sourceDate=historicalCurrent?today:profile==='positioned'?new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),1)).toISOString().slice(0,10):add(today,2);
 while(!historicalCurrent&&[0,6].includes(new Date(sourceDate+'T12:00:00Z').getUTCDay()))sourceDate=add(sourceDate,1);
 const nextDate=add(sourceDate,1);
 const groups=[];
 for(const [name,label] of [['rounded actual','ACTUAL'],['approved plan','PLAN']])groups.push(await createAttendanceRule(ctx,ruleInput('Fictional '+prefix+' '+name,prefix+'-'+label)));
 const shifts=[];
 for(let index=1;index<=32;index++)shifts.push(await createShift(ctx,{companyId:f.companyId,code:prefix+'-'+String(index).padStart(2,'0'),name:'Fictional '+prefix+' shift '+String(index).padStart(2,'0'),startTime:'09:00',endTime:'18:00',breakMinutes:60,breakPeriods:[{start:'12:00',end:'13:00'}],weeklyPattern:[1,2,3,4,5,6,7],ruleId:groups[0].id}));
 for(const group of groups)await setRuleShifts(ctx,{ruleId:group.id,shiftIds:shifts.map(row=>row.id)});
 const seed=requirePackFor('MY').payComponents.defaults.find(row=>row.code===requirePackFor('MY').payComponents.backfillCodes.overtime)!;
 const earning=await createPayComponent(ctx,{...seed,code:prefix+'_OT',name:'Fictional '+prefix+' policy overtime',label:prefix+' OT'});
 const definition=prepareOvertimeStarter('ot15','day','earliest');definition.currency={code:'MYR',minorScale:2};definition.eligibility={id:'release_eligible',type:'constant',value:true};definition.rates[0].when={id:'release_rate_eligible',type:'constant',value:true};
 const tier=definition.rates[0].tiers[0];tier.mapping={earningItemId:earning.id,currency:'MYR'};
 if(tier.payment.method!=='hourly')throw Error('Retain hourly starter');
 tier.payment.rate={id:'release_hourly',unit:'moneyPerHour',type:'literal',value:'12',currency:'MYR'};
 const draft=await saveOvertimePatternDraft(ctx,{draft:{code:prefix+'_OT',name:'Fictional '+prefix+' 12 x 1.5',creationCompanyId:f.companyId,companyIds:[f.companyId],definition}});
 const validation=await validateOvertimePatternActivation(ctx,{versionId:draft.versionId,expectedRevision:draft.revision});
 if(validation.issues.length||!validation.validationDigest)throw Error('Prospective formula validation failed');
 await activateOvertimePattern(ctx,{versionId:draft.versionId,expectedRevision:draft.revision,validationDigest:validation.validationDigest,effectiveFrom:historicalCurrent?today:effectiveFrom});
 const revisions=[];
 for(const [index,group] of groups.entries()){
  const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:false},overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:true,splitAtMidnight:true,offsetLateness:false,approval:'auto',autoMethod:index===0?'actual':'preApproved',rounding:index===0?{mode:'up',step:30}:{mode:'none',step:null},days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:draft.versionId}])) as AttendanceGroupPolicy['overtime']['days']}};
  revisions.push(await scheduleAttendanceGroupPolicy(ctx,{companyId:f.companyId,ruleId:group.id,expectedOrdinal:0,effectiveFrom,reason:'Fictional prospective current-release app review',policy}));
 }
 // The separate current-day replay profile restores a declared pre-existing group baseline
 // BEFORE any clock/request/decision. It does not exercise a historical activation command.
 // The prospective fixture above remains untouched; no runtime clock or future-date guard changes.
 const historicalBaselines=[];
 if(historicalCurrent){
  for(const revision of revisions){
   const [issued]=await owner.db.select().from(s.attendanceGroupPolicyRevision).where(eq(s.attendanceGroupPolicyRevision.id,revision.id));
   if(!issued||issued.activationEpoch<=0)throw Error('Require the genuine positive scheduling epoch');
   await owner.db.transaction(async tx=>{
    await tx.execute(sql`ALTER TABLE attendance_group_policy_revision DISABLE TRIGGER attendance_group_policy_revision_guard`);
    await tx.update(s.attendanceGroupPolicyRevision).set({effectiveFrom:add(today,-1)}).where(eq(s.attendanceGroupPolicyRevision.id,revision.id));
    await tx.execute(sql`ALTER TABLE attendance_group_policy_revision ENABLE TRIGGER attendance_group_policy_revision_guard`);
   });
   historicalBaselines.push({revisionId:revision.id,issuedEffectiveFrom:issued.effectiveFrom,restoredEffectiveFrom:add(today,-1)});
  }
  const guards=await owner.db.execute(sql`select tgname,tgenabled from pg_trigger where tgrelid='attendance_group_policy_revision'::regclass and tgname in ('attendance_group_policy_revision_guard','zz_attendance_policy_activation_epoch') order by tgname`);
  if(guards.length!==2||guards.some(row=>row.tgenabled!=='O'))throw Error('All policy guards must be enabled BEFORE business work');
 }
 const people=[];
 for(const [index,key] of ['roundedCash','plannedCash','plannedToil'].entries()){
  const hired=await hireEmployee(ctx,{person:{fullName:'Fictional '+prefix+' '+key,primaryEmail:prefix.toLowerCase()+'-'+key+'@example.test'},companyId:f.companyId,departmentId:f.deptA,employmentType:'full_time',employeeCode:prefix+'-EMP'+(index+1),hiredOn:add(today,-10)});
  await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:add(today,-10)});
  await requirePackFor('MY').statutory.set(ctx,{personId:hired.personId,icNumber:(historicalCurrent?'90010101126':'90010101124')+(index+1)});
  await assignDefaultShift(ctx,{employmentId:hired.employmentId,shiftId:shifts[0].id});
  await setEmploymentScheduleGroup(ctx,{employmentId:hired.employmentId,attendanceRuleId:groups[index===0?0:1].id});
  const userId=await createAppUser(f.tenantId,hired.personId,'employee');await owner.db.update(s.appUser).set({onboardedAt:new Date()}).where(eq(s.appUser.id,userId));
  for(const [direction,time,date] of [['in','23:00:00',sourceDate],['out',index===0?'01:05:00':'01:00:00',nextDate]] as const){
   const [capture]=await owner.db.insert(s.attendanceClockCapture).values({tenantId:f.tenantId,employmentId:hired.employmentId,attendanceDate:sourceDate,direction,requestId:randomUUID(),commandDigest:'a'.repeat(64),serverRecordedAt:new Date(Date.parse(date+'T'+time+'+08:00')+555)}).returning();
   await (direction==='in'?checkInTx:checkOutTx)(ctx,{employmentId:hired.employmentId,date:sourceDate,time,clockCaptureId:capture.id,preciseOrder:true});
  }
  people.push({key,...hired,userId});
 }
 await setToilPolicy(ctx,{companyId:f.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
 await saveAttendanceWorkflow(ctx,{companyId:f.companyId,routingVersion:4,code:prefix+'_PLAN',name:'Fictional '+prefix+' plan review',applicationType:'self_overtime',priority:100,criteria:{employeeIds:people.map(row=>row.employmentId)},active:true,cc:[],stages:[{name:'Final HR plan review',mode:'sequential',sources:[{kind:'specific_employee',employmentIds:[hr.employmentId]}],hrAlternative:false}]});
 await setAttendanceWorkflowEnabled(ctx,f.companyId,'self_overtime',true);
 const batch=await createBatch(ctx,{companyId:f.companyId,payPeriod:sourceDate.slice(0,7),scope:{employmentIds:people.map(row=>row.employmentId)}});
 await writeFile(destination,JSON.stringify({tenantId:f.tenantId,companyId:f.companyId,today,effectiveFrom:historicalCurrent?add(today,-1):effectiveFrom,formulaEffectiveFrom:historicalCurrent?today:effectiveFrom,sourceDate,nextDate,groups,shifts,versionId:draft.versionId,revisions,earningId:earning.id,people,batch,historicalBaselines,scope:historicalCurrent?'Fictional current-day replay of a privately restored pre-existing policy baseline; guards enabled before all business work. Not historical activation-command proof. Synthetic captures; no browser approval, banking, transfer or release yet.':'Fictional prospective fixture only; no browser approval, banking, transfer or release yet; no policy backdating or trigger disable.'},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('Created separate '+profile+' fictional policy sources; app decisions remain pending.');
}
main().then(async()=>{await (await import('../test/harness')).closeAll();process.exit(0);},async error=>{console.error(error);await (await import('../test/harness')).closeAll();process.exit(1);});
