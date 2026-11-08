import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {withTenant,type Tx} from '../db/client';
import {hireEmployee} from '../core/org';
import {createAttendanceRule} from '../core/attendance-rule';
import {createShift,listShiftsForTenant,rosterDisplayShiftsTx,usualShiftsFor} from '../core/roster';
import {rotationLookupTx} from '../packs/attendance/service';
import {rosterWindowPage} from '../core/roster-presentation';
import {todayInKualaLumpur} from '../lib/hr-date';
import {resolveRosterCell} from '../lib/roster-month';
import {legacyUsualShiftsFor} from './helpers/roster-usual-original';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const add=(date:string,days:number)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
type Census={sql:string;params:unknown[];rows:number};
/** Observe real query results without replacing any native owner or driver. */
function observedTx(tx:Tx,census:Census[]):Tx {
 const wrap=(query:object):object=>new Proxy(query,{get(target,key,receiver){
  const value=Reflect.get(target,key,receiver);
  if(key==='then')return (resolve:(rows:unknown[])=>unknown,reject:(error:unknown)=>unknown)=>{
   const prepared=(target as {toSQL:()=>{sql:string;params:unknown[]}}).toSQL();
   return Reflect.apply(value,target,[(rows:unknown[])=>{census.push({...prepared,rows:rows.length});return resolve(rows);},reject]);
  };
  return typeof value==='function'? (...args:unknown[])=>{
   const result=Reflect.apply(value,target,args);return result&&typeof result==='object'&&'then' in result?wrap(result):result;
  }:value;
 }});
 return new Proxy(tx,{get(target,key,receiver){
  if(key==='select')return (...args:unknown[])=>wrap(Reflect.apply(target.select,target,args));
  const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
 }});
}
async function fixture(){
 const b=await seedBase(),ctx=adminCtx(b),date=add(todayInKualaLumpur(),14);
 // The canonical writer also stamps the required legacy-overtime snapshot under
 // this real administrator; an owner SQL insert has no calling authority for it.
 const rules=[];
 for(const name of ['Group','Default','Dated','Unrelated'])rules.push(await createAttendanceRule(ctx,{
  name:'Fictional '+name,weeklyPattern:[1,2,3,4,5],lateGracePeriodMinutes:0,lateAfterMinutes:0,lateDeductMinutes:0,
  includeGraceInLateness:false,earlyGracePeriodMinutes:0,earlyAfterMinutes:0,earlyDeductMinutes:0,
  includeGraceInEarlyOut:false,applyToEarlyOt:false,otRows:[],
 }));
 const shifts=[];
 for(const [i,ruleId] of [rules[0].id,rules[0].id,rules[1].id,rules[2].id,null,rules[3].id].entries())
  shifts.push((await createShift(ctx,{code:'READ'+i,name:'Fictional shift '+i,startTime:'09:00',endTime:'18:00',weeklyPattern:[1,2,3,4,5],...(ruleId?{ruleId}:{})})).id);
 const ids=[];
 for(let i=0;i<6;i++)ids.push((await hireEmployee(ctx,{person:{fullName:'Fictional scoped roster '+i,primaryEmail:`roster-scope-${i}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'})).employmentId);
 for(let i=0;i<ids.length;i++)await owner.db.update(schema.employment).set({defaultShiftId:i===2?null:i===3?shifts[4]:shifts[2],attendanceRuleId:i===0||i===2?rules[0].id:null}).where(eq(schema.employment.id,ids[i]));
 await owner.db.insert(schema.employmentShiftArrangement).values([
  {tenantId:b.tenantId,employmentId:ids[0],shiftType:'fixed',shiftId:shifts[3],validFrom:'2020-01-01'},
  {tenantId:b.tenantId,employmentId:ids[1],shiftType:'fixed',shiftId:shifts[3],validFrom:'2020-01-01',validTo:add(date,3)},
  {tenantId:b.tenantId,employmentId:ids[1],shiftType:'fixed',shiftId:shifts[4],validFrom:add(date,4)},
  {tenantId:b.tenantId,employmentId:ids[5],shiftType:'fixed',shiftId:shifts[4],validFrom:'2020-01-01'},
 ]);
 const cycle=(ruleId:string,shiftId:string,effectiveFrom:string,kind:'full'|'half'='full')=>({tenantId:b.tenantId,ruleId,effectiveFrom,anchorDate:effectiveFrom,unit:'day' as const,length:1,allowedShiftIds:[shiftId],days:[{kind,shiftId}],createdBy:ctx.userId!});
 await owner.db.insert(schema.attendanceRotation).values([
  cycle(rules[0].id,shifts[0],date),cycle(rules[0].id,shifts[1],add(date,4),'half'),
  cycle(rules[1].id,shifts[2],date),cycle(rules[2].id,shifts[3],date),
  ...Array.from({length:100},(_,i)=>cycle(rules[3].id,shifts[5],add(date,i))),
 ]);
 await owner.db.update(schema.shift).set({archivedAt:new Date()}).where(eq(schema.shift.id,shifts[1]));
 // createShift already owns this membership. Confirm its actual native fact
 // instead of writing a second copy of the same (rule, shift) primary key.
 const membership=await withTenant(ctx,tx=>tx.select({ruleId:schema.attendanceRuleShift.ruleId,shiftId:schema.attendanceRuleShift.shiftId})
  .from(schema.attendanceRuleShift).where(and(eq(schema.attendanceRuleShift.ruleId,rules[3].id),eq(schema.attendanceRuleShift.shiftId,shifts[5]))));
 expect(membership).toEqual([{ruleId:rules[3].id,shiftId:shifts[5]}]);
 return {b,ctx,date,rules,shifts,ids};
}

it('retains every native version/source for scoped rules and distinguishes empty from omitted scope',async()=>{
 const f=await fixture(),census:Census[]=[];
 await withTenant(f.ctx,async tx=>{
  const full=await rotationLookupTx(tx),scoped=await rotationLookupTx(tx,{ruleIds:[f.rules[0].id]});
  expect(full.versions).toHaveLength(104);expect(scoped.versions).toEqual(full.versions.filter(v=>v.ruleId===f.rules[0].id));
  expect(scoped.shifts.map(row=>row.id).sort()).toEqual([f.shifts[0],f.shifts[1]].sort());
  expect(scoped(f.rules[0].id,add(f.date,4))?.shift?.id).toBe(f.shifts[1]);
  const empty=await rotationLookupTx(observedTx(tx,census),{ruleIds:[]});
  expect(empty.versions).toEqual([]);expect(empty.shifts).toEqual([]);expect(empty(f.rules[0].id,f.date)).toBeNull();
 });
 expect(census).toEqual([]);
});

it('matches the frozen usual-shift owner while reading only each page member’s exact precedence rules',async()=>{
 const f=await fixture(),baseline:Census[]=[],candidate:Census[]=[];
 const result=await withTenant(f.ctx,async tx=>{
  const start=performance.now(),old=await legacyUsualShiftsFor(f.ctx,f.ids,observedTx(tx,baseline)),baselineMs=performance.now()-start;
  const next=performance.now(),current=await usualShiftsFor(f.ctx,f.ids,observedTx(tx,candidate)),candidateMs=performance.now()-next;
  expect(current).toEqual(old);
  return {current,baselineMs,candidateMs};
 },{readOnlySnapshot:true});
 const byId=new Map(result.current.map(row=>[row.employmentId,row]));
 expect(byId.get(f.ids[0])?.rotations?.map(v=>v.ruleId)).toEqual([f.rules[0].id,f.rules[0].id]);
 expect(byId.get(f.ids[2])?.noDefault).toBe(true);
 expect(resolveRosterCell(f.date,null,byId.get(f.ids[1]))).toEqual({kind:'usual',shiftId:f.shifts[3]});
 expect(resolveRosterCell(add(f.date,4),null,byId.get(f.ids[0]))).toEqual({kind:'usual',shiftId:f.shifts[1]});
 expect(byId.get(f.ids[5])?.rotations).toBeUndefined();
 const oldHistory=baseline.filter(q=>q.sql.includes('from "attendance_rotation"')),history=candidate.filter(q=>q.sql.includes('from "attendance_rotation"'));
 expect(oldHistory.map(q=>q.rows)).toEqual([104]);expect(history.map(q=>q.rows)).toEqual([4]);
 expect(history[0].params.sort()).toEqual(f.rules.slice(0,3).map(row=>row.id).sort());
 for(const [index,expectedRules] of [[0,[f.rules[0].id]],[1,[f.rules[2].id]],[2,[f.rules[0].id]],[3,[]],[4,[f.rules[1].id]],[5,[]]] as const){
  const census:Census[]=[];
  await withTenant(f.ctx,tx=>usualShiftsFor(f.ctx,[f.ids[index]],observedTx(tx,census)));
  const selected=census.filter(q=>q.sql.includes('from "attendance_rotation"'));
  expect(selected.flatMap(q=>q.params).sort()).toEqual([...expectedRules].sort());
  if(!expectedRules.length)expect(selected).toEqual([]);
 }
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'roster-shift-scope-component.json'),JSON.stringify({
  kind:'NATIVE_ROSTER_SHIFT_SCOPE_COMPONENT_ONLY',releaseEligible:false,employees:f.ids.length,tenantVersions:104,
  baselineMs:result.baselineMs,candidateMs:result.candidateMs,baselineRotationRows:104,candidateRotationRows:4,exactParity:true,
  baselineStatementCount:baseline.length,candidateStatementCount:candidate.length,
 },null,2));
});

it('projects the complete active shared shift library in one native statement and preserves archived rotation overlays',async()=>{
 const f=await fixture(),legacy=await createShift(f.ctx,{companyId:f.b.companyId,code:'LEGACY',name:'Fictional legacy company shift',startTime:'07:00',endTime:'16:00'});
 const other=await seedBase(),foreign=await createShift(adminCtx(other),{code:'FOREIGN',name:'Fictional foreign shift',startTime:'06:00',endTime:'15:00'});
 const census:Census[]=[];
 await withTenant(f.ctx,async tx=>{
  const full=await listShiftsForTenant(f.ctx,undefined,tx),display=await rosterDisplayShiftsTx(observedTx(tx,census));
  expect(display).toEqual(full.map(({id,code,name,startTime,endTime,color})=>({id,code,name,startTime,endTime,color})));
  expect(display.map(row=>row.id)).toContain(legacy.id);expect(display.map(row=>row.id)).not.toContain(foreign.id);
  expect(display.map(row=>row.id)).not.toContain(f.shifts[1]);
 });
 expect(census).toHaveLength(1);expect(census[0].sql).toContain('from "shift"');expect(census[0].rows).toBe(6);
 const page=await rosterWindowPage(f.ctx,{companyIds:[f.b.companyId],from:f.date,to:add(f.date,5),offset:0,limit:25});
 expect(page.employees.map(row=>row.employmentId)).toEqual(f.ids);expect(page.total).toBe(6);
 expect(page.shifts.map(row=>row.id)).toContain(f.shifts[1]);expect(page.shifts.map(row=>row.id)).not.toContain(foreign.id);
 expect(page.usual[f.ids[2]]?.noDefault).toBe(true);
});
