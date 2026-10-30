import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {asc,eq} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {domainEvent,employment} from '../db/schema';
import {hireEmployee} from '../core/org';
import {createDepartment} from '../core/admin';
import {createMovementEvent,movementHistory,editMovementEvent,movementCurrentState} from '../core/movement';
import {previewMovementImport,commitMovementImport} from '../core/movement-import';
import {saveMovementEventType} from '../core/movement-type';
import {isComparisonKind} from '../core/movement-kinds';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const hire=(code:string)=>hireEmployee(adminCtx(b),{person:{fullName:'Fictional '+code,primaryEmail:randomUUID()+'@fixture.test'},employeeCode:code,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-60)});
async function importFile(csv:string){const ctx=adminCtx(b),preview=await previewMovementImport(ctx,{companyId:b.companyId,csv});expect(preview.valid).toBe(1);const result=await commitMovementImport(ctx,{companyId:b.companyId,csv,selection:preview.selection,inputHash:preview.inputHash,fingerprints:Object.fromEntries(preview.employees.map(row=>[row.employeeCode,row.fingerprint!])),acknowledgeExcluded:false});expect(result.imported).toBe(1);return {preview,result};}
describe('canonical Movement date and correction parity',()=>{
 it('preserves an entered Probation Extension effective date in manual history, import preview and committed history',async()=>{
  const manual=await hire('B20-MANUAL'),imported=await hire('B20-IMPORT'),ctx=adminCtx(b),effectiveDate=day(-2),endDate=day(30);
  await createMovementEvent(ctx,{employmentId:manual.employmentId,kind:'probationExtension',effectiveDate,endDate,remarks:'Fictional date parity'});
  const text=toCsv([['employee_code','event_type','effective_date','end_date','remarks'],['B20-IMPORT','probationExtension',effectiveDate,endDate,'Fictional date parity']]);
  const {preview}=await importFile(text);expect(preview.employees[0].rows[0].effectiveDate).toBe(effectiveDate);expect(preview.employees[0].rows[0].proposed?.extendedConfirmationDate).toBe(endDate);
  for(const id of [manual.employmentId,imported.employmentId]){
   const row=(await movementHistory(ctx,id)).find(item=>item.kind==='probationExtension');expect(row).toMatchObject({effectiveDate,endDate,status:'applied'});
   const events=await owner.db.select({id:domainEvent.id,eventType:domainEvent.eventType,payload:domainEvent.payload}).from(domainEvent).where(eq(domainEvent.id,row!.id)).orderBy(asc(domainEvent.id));expect(events).toEqual([expect.objectContaining({eventType:'employment.info.updated',payload:expect.objectContaining({movement:expect.objectContaining({type:'probationExtension',effectiveDate,endDate})})})]);
   const [record]=await owner.db.select({extendedConfirmationDate:employment.extendedConfirmationDate}).from(employment).where(eq(employment.id,id));expect(record.extendedConfirmationDate).toBe(endDate);
  }
 });
 it('keeps legacy probation history on its occurrence day when no valid frozen effective day was recorded',async()=>{
  const e=await hire('B20-LEGACY'),today=todayInKualaLumpur(),occurrence=new Date(today+'T00:00:00Z');
  for(const effectiveDate of [undefined,'2026-02-30'])await owner.db.insert(domainEvent).values({tenantId:b.tenantId,aggregateType:'employment',aggregateId:e.employmentId,eventType:'employment.info.updated',actorType:'system',subjectEmploymentId:e.employmentId,occurredAt:occurrence,payload:{fields:['extendedConfirmationDate'],after:{extendedConfirmationDate:day(30)},movement:{type:'probationExtension',endDate:day(30),...(effectiveDate?{effectiveDate}:{})}}});
  const rows=(await movementHistory(adminCtx(b),e.employmentId)).filter(item=>item.kind==='probationExtension');expect(rows).toHaveLength(2);for(const row of rows)expect(row.effectiveDate).toBe(today);
 });
 it('refuses a forged malformed probation effective day before writing the employment or audit',async()=>{
  const e=await hire('B20-BAD-DATE'),before=await owner.db.select().from(employment).where(eq(employment.id,e.employmentId));
  const audit=()=>owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,e.employmentId)).orderBy(asc(domainEvent.sequence));const events=await audit();
  await expect(createMovementEvent(adminCtx(b),{employmentId:e.employmentId,kind:'probationExtension',effectiveDate:'2026-02-30',endDate:day(30)})).rejects.toThrow('valid effective date');
  expect(await owner.db.select().from(employment).where(eq(employment.id,e.employmentId))).toEqual(before);expect(await audit()).toEqual(events);
 });
 it('returns resolved comparison behaviour when editing an imported custom event and keeps the action’s entitlement decision on that behaviour',async()=>{
  const e=await hire('B20-CUSTOM'),ctx=adminCtx(b),type=await saveMovementEventType(ctx,{label:'Fictional career step',behaviourKind:'promotion'}),third=await createDepartment(ctx,{companyId:b.companyId,name:'Fictional third department'});
  await importFile(toCsv([['employee_code','event_type','effective_date','department_id'],['B20-CUSTOM',type.code,day(-2),b.deptB]]));
  const original=(await movementHistory(ctx,e.employmentId)).find(row=>row.kind===type.code);expect(original).toBeDefined();
  const edited=await editMovementEvent(ctx,{employmentId:e.employmentId,movementId:original!.id,kind:type.code,effectiveDate:day(-2),departmentId:third.id,reason:'Fictional correction'});
  expect(edited.behaviourKind).toBe('promotion');expect(isComparisonKind(edited.behaviourKind)).toBe(true);expect(isComparisonKind(type.code)).toBe(false);
  expect((await movementCurrentState(ctx,e.employmentId)).departmentId).toBe(third.id);expect((await movementHistory(ctx,e.employmentId)).find(row=>row.id===original!.id)?.status).toBe('reversed');
  const source=readFileSync(join(process.cwd(),'app/admin/personnel/[employmentId]/actions.ts'),'utf8'),start=source.indexOf('export async function editMovementEventAction'),end=source.indexOf('\n}',start);
  expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start+200);const action=source.slice(start,end);
  expect(action).toContain('const result=await editMovementEvent(');expect(action).toContain('movementNeedsEntitlementReprojection(result.behaviourKind)');expect(action).toContain('movementNeedsEntitlementReprojection(result.previousBehaviourKind)');expect(action).toContain('recomputeEntitlement(s, employmentId');expect(action).not.toContain('isComparisonKind(p.kind)');
 });
});
