/** Real Attendance task reads against a frozen independent pre-batch reader; no authority mocks. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {roleAssignment} from '../db/schema';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {client,withTenant,type SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {pendingAttendanceTaskMetadata,requestAttendanceCorrection} from '../core/attendance';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
import {comparePendingHeaderPrototype} from './helpers/attendance-task-header-prototype';
import {legacyPendingAttendanceTaskMetadata} from './helpers/attendance-task-original';

type ExplainNode = {
 'Node Type':string;
 'Function Name'?:string;
 'Actual Loops'?:number;
 'Actual Rows'?:number;
 'Shared Hit Blocks'?:number;
 Plans?:ExplainNode[];
};

async function attendanceSubjectPlan(actor:SessionContext,companyId:string){
 const captured:{query:string;params:unknown[]}[]=[];
 const nativeBegin=client.begin;
 const begin=vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{
  const callbackIndex=args.findIndex(arg=>typeof arg==='function');
  const callback=args[callbackIndex] as (native:typeof client)=>unknown;
  args[callbackIndex]=(native:typeof client)=>callback(new Proxy(native,{
   get(target,key,receiver){
    if(key!=='unsafe')return Reflect.get(target,key,receiver);
    return (query:string,...values:unknown[])=>{
     if(query.startsWith('select pending_attendance.id'))captured.push({query,params:values[0] as unknown[]});
     return Reflect.apply(target.unsafe,target,[query,...values]);
    };
   },
  }));
  return Reflect.apply(nativeBegin,client,args);
 }) as typeof client.begin);
 try{
  await pendingAttendanceTaskMetadata(actor,[companyId]);
 }finally{
  begin.mockRestore();
 }
 expect(captured).toHaveLength(1);
 const [{query,params}]=captured;
 const fragments=query.split(/(\$\d+)/).map((part,index)=>index%2?sql`${params[Number(part.slice(1))-1]}`:sql.raw(part));
 const [row]=await withTenant(actor,tx=>tx.execute<{'QUERY PLAN':{Plan:ExplainNode}[]}>(sql`
  explain (analyze, buffers, format json) ${sql.join(fragments,sql.raw(''))}
 `));
 const compact=(node:ExplainNode):unknown=>({
  type:node['Node Type'],function:node['Function Name'],loops:node['Actual Loops'],
  rows:node['Actual Rows'],sharedHits:node['Shared Hit Blocks'],children:node.Plans?.map(compact),
 });
 return compact(row['QUERY PLAN'][0].Plan);
}

beforeAll(migrateTestDb);afterAll(closeAll);
it('keeps the exact uncapped actionable queue while reducing repeated administrator and manager subject work',async()=>{
 await resetDb();const b=await seedBase(),admin=adminCtx(b);await setModule(b.tenantId,'attendance','active');
 const hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const subject=await hire('Fictional retained metadata subject'),manager=await hire('Fictional metadata manager');
 await setReportingLine(admin,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const login=async(personId:string,role:'employee'|'manager'):Promise<SessionContext>=>({...admin,userId:await createAppUser(b.tenantId,personId,role),personId,roles:[role],grants:[{role,companyId:b.companyId}]});
 const self=await login(subject.personId,'employee'),reviewer=await login(manager.personId,'manager');
 const ids:string[]=[];const today=todayInKualaLumpur(),fixtureStarted=performance.now();
 for(let index=1;index<=211;index++){
  const day=new Date(today+'T00:00:00Z');day.setUTCDate(day.getUTCDate()-index);
  const {correctionId}=await requestAttendanceCorrection(self,{employmentId:subject.employmentId,date:day.toISOString().slice(0,10),checkIn:'09:00',checkOut:'18:00',reason:'PRIVATE_METADATA_REASON_NOT_FOR_HEADER'});ids.push(correctionId);
 }
 const fixturePreparationMs=performance.now()-fixtureStarted;
 const expected=await legacyPendingAttendanceTaskMetadata(admin,[b.companyId]);expect(expected).toHaveLength(211);
 expect(new Set(expected.map(row=>row.id))).toEqual(new Set(ids));expect(JSON.stringify(expected)).not.toContain('PRIVATE_METADATA_REASON');
 const audienceChecks:string[]=[];
 for(const [name,actor,scope]of [['admin',admin,[b.companyId]],['manager',reviewer,[b.companyId]],['self',self,[b.companyId]],['emptyScope',admin,[]],['unscoped',admin,undefined]]as const){
  expect(await pendingAttendanceTaskMetadata(actor,scope===undefined?undefined:[...scope])).toEqual(await legacyPendingAttendanceTaskMetadata(actor,scope===undefined?undefined:[...scope]));audienceChecks.push(name);
 }
 const foreign=await seedBase();expect(await pendingAttendanceTaskMetadata(adminCtx(foreign),[b.companyId])).toEqual([]);audienceChecks.push('foreignTenant');
 await expect(pendingAttendanceTaskMetadata({...self,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]},[b.companyId])).rejects.toThrow();audienceChecks.push('forgedAdminRefused');
 const measurements:Record<string,{phase:string;reads:number;elapsedMs:number}[]>={};
 const improvementRatios:Record<string,number>={};
 for(const [name,actor] of [['administrator',admin],['manager',reviewer]] as const){
  const actorExpected=await legacyPendingAttendanceTaskMetadata(actor,[b.companyId]);
  expect(actorExpected).toEqual(expected);
  const phases=[];
  for(const phase of ['original','candidate','candidate-warm','restored'] as const){
   const started=performance.now();
   const read=phase==='original'||phase==='restored'?legacyPendingAttendanceTaskMetadata:pendingAttendanceTaskMetadata;
   for(let index=0;index<15;index++)expect(await read(actor,[b.companyId])).toEqual(actorExpected);
   phases.push({phase,reads:15,elapsedMs:performance.now()-started});
  }
  measurements[name]=phases;
  const control=Math.min(phases[0].elapsedMs,phases[3].elapsedMs);
  const candidate=Math.max(phases[1].elapsedMs,phases[2].elapsedMs);
  improvementRatios[name]=candidate/control;
 }
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR){
  const plans={administrator:await attendanceSubjectPlan(admin,b.companyId),manager:await attendanceSubjectPlan(reviewer,b.companyId)};
  writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'attendance-task-subject-plans.json'),JSON.stringify(plans,null,2));
  const prototype=await comparePendingHeaderPrototype({admin,reviewer,self,foreign:adminCtx(foreign)});
  writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'attendance-task-header-prototype.json'),JSON.stringify(prototype,null,2));
 }
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,reviewer.userId!));
 await expect(legacyPendingAttendanceTaskMetadata(reviewer,[b.companyId])).rejects.toThrow();
 await expect(pendingAttendanceTaskMetadata(reviewer,[b.companyId])).rejects.toThrow();
 audienceChecks.push('staleManagerRefused');
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'attendance-task-subject-batch.json'),JSON.stringify({kind:'NATIVE_ATTENDANCE_SUBJECT_BATCH_COMPONENT_ONLY',releaseEligible:false,fixtureRequests:ids.length,fixture:'211 actual native self-submission commands; all triggers and RLS intact',fixturePreparationMs,measurements,audienceChecks,exactUncappedDTOOrder:true,privatePayloadOmitted:true,improvementRatios,limitations:'two principals and 211 requests; no 500-user capacity or whole-page timings'},null,2));
 for(const [name,ratio] of Object.entries(improvementRatios)){
  expect(ratio,`${name}: both measured batch phases must improve by at least 20% over the faster control`).toBeLessThan(.8);
 }
},600000);
