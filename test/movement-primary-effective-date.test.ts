import {randomUUID} from 'node:crypto';
import {asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {assignment,compensation,domainEvent,employment} from '../db/schema';
import {withTenant} from '../db/client';
import {hireEmployee,setEmploymentGrade,setEmploymentAssignment} from '../core/org';
import {setCompensation} from '../core/comp';
import {createJobGrade} from '../core/admin';
import {createMovementEvent,editMovementEvent,movementCurrentState,movementDetail,movementHistory,reverseMovementEvent,MovementNoChangeError} from '../core/movement';
import {previewMovementImport,commitMovementImport} from '../core/movement-import';
import {todayInKualaLumpur} from '../lib/hr-date';
import {toCsv} from '../lib/csv';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
async function hire(){
 const ctx=adminCtx(b),base=await createJobGrade(ctx,{code:'BASE',name:'Original Grade'}),higher=await createJobGrade(ctx,{code:'HIGHER',name:'Higher Grade'});
 const {employmentId}=await hireEmployee(ctx,{person:{fullName:'Fictional grade anchored Movement',primaryEmail:`${randomUUID()}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',gradeId:base.id,hiredOn:day(-60),employeeCode:'EMP-0004'});
 await setCompensation(ctx,{employmentId,basicSalary:3000,effectiveFrom:day(-40)});return {id:employmentId,ctx,base,higher};
}
async function snapshot(id:string){return{
 employment:await owner.db.select().from(employment).where(eq(employment.id,id)),
 assignments:await owner.db.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id)),
 compensation:await owner.db.select().from(compensation).where(eq(compensation.employmentId,id)).orderBy(asc(compensation.id)),
 events:await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence)),
};}
async function assertPromotionBeforeTransfer(id:string){
 const ctx=adminCtx(b),before=await snapshot(id),history=await movementHistory(ctx,id),promotion=history.find(row=>row.kind==='promotion')!,transfer=history.find(row=>row.kind==='transfer')!;
 expect(history.filter(row=>row.kind==='promotion')).toHaveLength(1);expect(promotion.effectiveDate).toBe(day(-6));expect(transfer.effectiveDate).toBe(day(-4));
 expect(promotion.canEdit).toBe(true);expect(transfer.canEdit).toBe(true);
 const detail=await movementDetail(ctx,id,promotion.id);
 expect(detail?.row.effectiveDate).toBe(day(-6));
 expect(detail?.before).toMatchObject({department:'Finance',salaryAmount:'3000.00',grade:'Original Grade'});
 expect(detail?.after).toMatchObject({department:'Finance',salaryAmount:'3500.00',grade:'Higher Grade'});
 expect(await movementCurrentState(ctx,id)).toMatchObject({departmentId:b.deptB,basicSalary:'3500.00'});
 expect(await snapshot(id)).toEqual(before);return {promotion,transfer};
}
describe('comparison Movement effective date is independent of its primary leg',()=>{
 it('imports grade+salary on the entered day before a later transfer, then preserves correction/rollback ordering',async()=>{
  const {id,ctx,base,higher}=await hire(),csv=toCsv([['employee_code','event_type','effective_date','department_id','grade_id','basic_salary'],['EMP-0004','promotion',day(-6),'',higher.id,3500],['EMP-0004','transfer',day(-4),b.deptB,'','']]);
  const preview=await previewMovementImport(ctx,{companyId:b.companyId,csv});expect(preview.valid).toBe(2);
  const result=await commitMovementImport(ctx,{companyId:b.companyId,csv,selection:preview.selection,inputHash:preview.inputHash,fingerprints:Object.fromEntries(preview.employees.filter(row=>row.fingerprint).map(row=>[row.employeeCode,row.fingerprint!])),acknowledgeExcluded:true});expect(result).toMatchObject({imported:2,failed:0});
  const {promotion,transfer}=await assertPromotionBeforeTransfer(id),before=await snapshot(id);
  const gradeAnchor=before.events.find(row=>row.id===promotion.id)!;expect(gradeAnchor.eventType).toBe('employment.grade.changed');expect(gradeAnchor.payload).toMatchObject({movement:{effectiveDate:day(-6)}});
  await expect(editMovementEvent(ctx,{employmentId:id,movementId:promotion.id,kind:'promotion',effectiveDate:day(-6),gradeId:higher.id,basicSalary:3500,reason:'Unchanged older correction'})).rejects.toBeInstanceOf(MovementNoChangeError);expect(await snapshot(id)).toEqual(before);
  await reverseMovementEvent(ctx,{employmentId:id,movementId:transfer.id,reason:'Fictional latest transfer rollback'});
  const noOpBefore=await snapshot(id);
  await expect(editMovementEvent(ctx,{employmentId:id,movementId:promotion.id,kind:'promotion',effectiveDate:day(-6),gradeId:higher.id,basicSalary:3500,reason:'Unchanged promotion'})).rejects.toBeInstanceOf(MovementNoChangeError);expect(await snapshot(id)).toEqual(noOpBefore);
  await reverseMovementEvent(ctx,{employmentId:id,movementId:promotion.id,reason:'Fictional promotion rollback'});
  expect(await movementCurrentState(ctx,id)).toMatchObject({departmentId:b.deptA,gradeId:base.id,basicSalary:'3000.00'});
  expect((await movementHistory(ctx,id)).find(row=>row.id===promotion.id)).toMatchObject({effectiveDate:day(-6),status:'reversed'});
 });
 it('reconstructs an immutable legacy grade anchor from the uniquely dated companion in the SAME group without changing any row',async()=>{
  const {id,ctx,higher}=await hire(),groupId=randomUUID();
  await withTenant(ctx,async tx=>{
   await setEmploymentGrade(ctx,{employmentId:id,gradeId:higher.id,movement:{type:'promotion',groupId}},tx);
   await setCompensation(ctx,{employmentId:id,basicSalary:3500,effectiveFrom:day(-6),movement:{type:'promotion',groupId,secondary:true}},tx);
  });
  await createMovementEvent(ctx,{employmentId:id,kind:'transfer',effectiveDate:day(-4),departmentId:b.deptB});
  const before=await snapshot(id),{promotion}=await assertPromotionBeforeTransfer(id);
  const anchor=before.events.find(row=>row.id===promotion.id)!;expect(anchor.payload).toMatchObject({movement:{type:'promotion',groupId}});expect(anchor.payload).not.toHaveProperty('movement.effectiveDate');
  expect(await snapshot(id)).toEqual(before);
 });
 it('freezes a grade-only new movement date, but does not borrow a date for a legacy grade-only group from unrelated compensation',async()=>{
  const first=await hire();await createMovementEvent(first.ctx,{employmentId:first.id,kind:'promotion',effectiveDate:day(-6),gradeId:first.higher.id});
  const [fresh]=(await movementHistory(first.ctx,first.id)).filter(row=>row.kind==='promotion');expect(fresh.effectiveDate).toBe(day(-6));
  // A historical, independently classified grade write has no recoverable entered day.
  const legacyGrade=await createJobGrade(first.ctx,{code:'LEGACY',name:'Legacy Grade'}),legacyGroup=randomUUID();
  await setEmploymentGrade(first.ctx,{employmentId:first.id,gradeId:legacyGrade.id,movement:{type:'promotion',groupId:legacyGroup}});
  await setCompensation(first.ctx,{employmentId:first.id,basicSalary:3600,effectiveFrom:day(-3),movement:{type:'promotion',groupId:randomUUID(),secondary:true}});
  const before=await snapshot(first.id),event=before.events.find(row=>row.eventType==='employment.grade.changed'&&typeof row.payload==='object'&&row.payload!==null&&'movement' in row.payload&&JSON.stringify(row.payload).includes(legacyGroup))!;
  expect((await movementHistory(first.ctx,first.id)).find(row=>row.id===event.id)?.effectiveDate).toBe(todayInKualaLumpur(event.occurredAt));expect(await snapshot(first.id)).toEqual(before);
 });
 it('keeps an entered comparison day when the flat info leg rather than grade owns the history row',async()=>{
  const {id,ctx}=await hire();
  await createMovementEvent(ctx,{employmentId:id,kind:'promotion',effectiveDate:day(-6),orgDivision:'Retail',basicSalary:3500});
  const before=await snapshot(id),[promotion]=(await movementHistory(ctx,id)).filter(row=>row.kind==='promotion');
  expect(before.events.find(row=>row.id===promotion.id)?.eventType).toBe('employment.info.updated');expect(promotion.effectiveDate).toBe(day(-6));
  const detail=await movementDetail(ctx,id,promotion.id);expect(detail?.before?.salaryAmount).toBe('3000.00');expect(detail?.after.salaryAmount).toBe('3500.00');
  expect(detail?.flatChanges).toEqual([{field:'orgDivision',before:null,after:'Retail'}]);expect(await snapshot(id)).toEqual(before);
 });
 it('keeps occurrence fallback when a historical group has conflicting dated evidence instead of choosing one leg arbitrarily',async()=>{
  const {id,ctx,higher}=await hire(),groupId=randomUUID();
  await withTenant(ctx,async tx=>{
   await setEmploymentGrade(ctx,{employmentId:id,gradeId:higher.id,movement:{type:'promotion',groupId}},tx);
   await setCompensation(ctx,{employmentId:id,basicSalary:3500,effectiveFrom:day(-6),movement:{type:'promotion',groupId,secondary:true}},tx);
   await setEmploymentAssignment(ctx,{employmentId:id,effectiveDate:day(-4),departmentId:b.deptB,movement:{type:'promotion',groupId,secondary:true}},tx);
  });
  const before=await snapshot(id),anchor=before.events.find(row=>row.eventType==='employment.grade.changed')!;
  expect((await movementHistory(ctx,id)).find(row=>row.id===anchor.id)?.effectiveDate).toBe(todayInKualaLumpur(anchor.occurredAt));expect(await snapshot(id)).toEqual(before);
 });
});
