/** Authored actual two-connection roster-source cases, UNRUN. Each write uses its real canonical
 * owner. Independent backfill rows/upload groups and the separate upload audit are not whole-file Tx. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createShift,assignDefaultShift,backfillBackupShift,assignRosterRow,assignShift} from '../core/roster';
import {analyzeRosterImport} from '../core/roster-import';
import {lockLeaveDependenciesTx} from '../packs/leave/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
const date='2026-12-15',secondDate='2026-12-16';
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function fixture(){
 const ctx=adminCtx(b),employees=[];
 const shift=await createShift(ctx,{name:'Fictional bulk source shift',code:'FBS',startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7]});
 for(let n=0;n<2;n++)employees.push(await hireEmployee(ctx,{person:{fullName:'Fictional bulk source employee '+n,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}));
 const ids=employees.map(row=>row.employmentId).sort();
 return{ctx,shift,employees,ids};
}
async function state(){return{
 employees:await owner.db.select().from(s.employment).where(eq(s.employment.tenantId,b.tenantId)).orderBy(s.employment.id),
 arrangements:await owner.db.select().from(s.employmentShiftArrangement).where(eq(s.employmentShiftArrangement.tenantId,b.tenantId)).orderBy(s.employmentShiftArrangement.id),
 roster:await owner.db.select().from(s.rosterAssignment).where(eq(s.rosterAssignment.tenantId,b.tenantId)).orderBy(s.rosterAssignment.id),
 attendance:await owner.db.select().from(s.attendance).where(eq(s.attendance.tenantId,b.tenantId)).orderBy(s.attendance.id),
 ledger:await owner.db.select().from(s.leaveLedger).where(eq(s.leaveLedger.tenantId,b.tenantId)).orderBy(s.leaveLedger.id),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),
};}
async function held(id:string,work:()=>Promise<void>){
 let ready!:()=>void,fail!:(error:unknown)=>void,release!:()=>void;
 const started=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
 const timer=setTimeout(()=>{fail(Error('owned roster source handshake timed out'));release();},10000);
 const holder=withTenant(adminCtx(b),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[id]);ready();await finish;});void holder.catch(fail);
 try{await started;await work();}finally{release();clearTimeout(timer);await holder;}
}
async function csv(ids:string[],brush:string){const employees=await owner.db.select().from(s.employment);return['employee_no,'+date,...ids.map(id=>employees.find(row=>row.id===id)!.employeeCode+','+brush)].join('\n');}
describe('roster bulk source intervals',()=>{
 it('keeps legacy default assignment and row-edit dates within their existing protected canonical owners',async()=>{
  const f=await fixture();const before=await state();
  await held(f.ids[1],async()=>{await expect(assignDefaultShift(f.ctx,{employmentId:f.ids[1],shiftId:f.shift.id})).rejects.toThrow('Leave source is unavailable');await expect(assignRosterRow(f.ctx,{employmentId:f.ids[1],shiftDates:[date,secondDate],brush:f.shift.id})).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);});
  await assignDefaultShift(f.ctx,{employmentId:f.ids[1],shiftId:f.shift.id});await assignRosterRow(f.ctx,{employmentId:f.ids[1],shiftDates:[date,secondDate],brush:f.shift.id});
  const after=await state();expect(after.employees.find(row=>row.id===f.ids[1])?.defaultShiftId).toBe(f.shift.id);expect(after.roster).toHaveLength(2);expect(after.roster.every(row=>row.shiftId===f.shift.id)).toBe(true);
 });
 it('backfill nominates the whole uncovered cohort and refuses a held final subject before any profile/event effect, then applies per row after release',async()=>{
  const f=await fixture(),before=await state();expect(before.employees.every(row=>row.defaultShiftId===null)).toBe(true);
  await held(f.ids[1],async()=>{
   const preview=await backfillBackupShift(f.ctx,{shiftCode:'FBS',apply:false});expect(preview.applied).toBe(false);expect(preview.before).toHaveLength(2);expect(preview.after).toEqual(preview.before);expect(await state()).toEqual(before);
   await expect(backfillBackupShift(f.ctx,{shiftCode:'FBS',apply:true})).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);
   await withTenant(f.ctx,tx=>lockLeaveDependenciesTx(tx,b.tenantId,[f.ids[0]]));
  });
  const result=await backfillBackupShift(f.ctx,{shiftCode:'FBS',apply:true});expect(result.before).toHaveLength(2);expect(result.after).toEqual([]);expect(result.applied).toBe(true);
  const after=await state();expect(after.employees.every(row=>row.defaultShiftId===f.shift.id&&row.shiftType==='fixed')).toBe(true);expect(after.events.filter(row=>row.eventType==='employment.shift-arrangement.assigned')).toHaveLength(2);
  const repeated=await backfillBackupShift(f.ctx,{shiftCode:'FBS',apply:true});expect(repeated.before).toEqual([]);expect(await state()).toEqual(after);
 });
 it.each(['FBS','RD'])('protects the actual %s upload group before fresh code/day planning; rollback releases earlier partial ownership and retry applies the original group',async brush=>{
  const f=await fixture(),csvText=await csv(f.ids,brush),input={csvText,month:'2026-12',companyId:b.companyId,fileName:'fictional-source-grid.csv',dryRun:false};const before=await state();
  await held(f.ids[1],async()=>{
   const preview=await analyzeRosterImport(f.ctx,{...input,dryRun:true});expect(preview.changed).toBe(2);expect(preview.committed).toBe(false);expect(await state()).toEqual(before);
   await expect(analyzeRosterImport(f.ctx,input)).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);
   await withTenant(f.ctx,tx=>lockLeaveDependenciesTx(tx,b.tenantId,[f.ids[0]]));
  });
  const result=await analyzeRosterImport(f.ctx,input);expect(result.committed).toBe(true);expect(result.changed).toBe(2);expect(result.rejects).toEqual([]);
  const after=await state();expect(after.roster).toHaveLength(2);expect(after.roster.every(row=>brush==='RD'?row.isRestDay:row.shiftId===f.shift.id)).toBe(true);expect(after.events.filter(row=>row.eventType==='roster.bulk.uploaded')).toHaveLength(1);
 });
 it('preserves independently committed clear rows when a later row refuses, then retries only the remaining change with one separate successful upload audit',async()=>{
  const f=await fixture();for(const id of f.ids)await assignShift(f.ctx,{employmentId:id,shiftDate:date,shiftId:f.shift.id});
  const input={csvText:await csv(f.ids,'OFF'),month:'2026-12',companyId:b.companyId,fileName:'fictional-independent-clears.csv',dryRun:false};
  await held(f.ids[1],async()=>{
   await expect(analyzeRosterImport(f.ctx,input)).rejects.toThrow('Leave source is unavailable');const partial=await state();
   expect(partial.roster.map(row=>row.employmentId)).toEqual([f.ids[1]]);expect(partial.events.filter(row=>row.eventType==='roster.cleared')).toHaveLength(1);expect(partial.events.filter(row=>row.eventType==='roster.bulk.uploaded')).toHaveLength(0);
  });
  const result=await analyzeRosterImport(f.ctx,input);expect(result.changed).toBe(1);expect(result.committed).toBe(true);const after=await state();expect(after.roster).toEqual([]);expect(after.events.filter(row=>row.eventType==='roster.cleared')).toHaveLength(2);expect(after.events.filter(row=>row.eventType==='roster.bulk.uploaded')).toHaveLength(1);
 });
});
