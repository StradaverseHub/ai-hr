/**
 * Board 4604dccc revision 2 — correcting dates that were keyed or migrated wrongly to their real, EARLIER values.
 * The saved Group Join Date / Join Date are never the limit: the limit is the Group Join Date as corrected.
 *  - Information-Only Correction moves the Group Join Date, the Join Date and the Effective Date earlier in one save;
 *    the Effective Date may precede the Join Date; a date before the corrected Group Join Date is refused, naming it.
 *  - A Group Join Date Correction movement moves the start of the dated records with it, so movements dated between
 *    the new and the old Group Join Date can follow (New Event, or later rows of the same Movement import);
 *    its Roll Back returns them, refused while an earlier-dated movement depends on it.
 *  - A movement before the Group Join Date is refused with that date.
 * Fictional tenant, companies and people.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,asc,eq,isNull} from 'drizzle-orm';
import * as schema from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {createMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
import {previewMovementImport,commitMovementImport} from '../core/movement-import';
import {previewInformationCorrection,correctInformation} from '../core/information-correction';
import {movementImportIssueText} from '../lib/movement-import-issues';
import type {InformationChanges} from '../lib/information-correction';
import type {MovementImportRecord} from '../lib/movement-import-contract';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();});

/** Keyed wrongly: the employee really joined on REAL. */
const KEYED='2026-03-15',REAL='2026-01-02';
const ctx=()=>adminCtx(b);
async function hire(code:string,hiredOn=KEYED){
 const e=await hireEmployee(ctx(),{person:{fullName:'Fictional '+code,primaryEmail:`${randomUUID().slice(0,8)}@fixture.test`},employeeCode:code,companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn});
 return e.employmentId as string;
}
const versions=async(id:string)=>(await owner.db.select({validFrom:schema.assignment.validFrom,validTo:schema.assignment.validTo,departmentId:schema.assignment.departmentId}).from(schema.assignment).where(and(eq(schema.assignment.employmentId,id),isNull(schema.assignment.supersededAt))).orderBy(asc(schema.assignment.validFrom))).map(v=>[v.validFrom,v.departmentId]);
const dates=async(id:string)=>(await owner.db.select({hiredOn:schema.employment.hiredOn,joinDate:schema.employment.joinDate}).from(schema.employment).where(eq(schema.employment.id,id)))[0];
async function correct(id:string,changes:InformationChanges,effectiveOn:string){
 const review=await previewInformationCorrection(ctx(),{employmentId:id,changes,reason:'Fictional correction',effectiveOn});
 await correctInformation(ctx(),{employmentId:id,changes,reason:'Fictional correction',fingerprint:review.fingerprint,method:'manual',effectiveOn});
 return review;
}
async function groupJoinCorrection(id:string){
 const row=(await movementHistory(ctx(),id)).find(r=>r.kind==='groupJoinDateCorrection'&&!r.reversed);
 if(!row)throw new Error('no Group Join Date Correction');
 return row.id;
}

describe('Information-Only Correction to earlier dates',()=>{
 it('moves the Group Join Date, the Join Date and the Effective Date earlier in one save',async()=>{
  const id=await hire('R2-ONE');
  const review=await correct(id,{hiredOn:REAL,joinDate:REAL,departmentId:b.deptB},REAL);
  expect(review.effectiveOn).toBe(REAL);
  expect(await dates(id)).toEqual({hiredOn:REAL,joinDate:REAL});
  // The dated records start on the corrected Group Join Date and carry the corrected value from it.
  expect(await versions(id)).toEqual([[REAL,b.deptB]]);
  const [event]=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.subjectEmploymentId,id),eq(schema.domainEvent.eventType,'employment.information.corrected')));
  expect(event.payload).toMatchObject({effectiveOn:REAL,before:{hiredOn:KEYED,joinDate:KEYED},after:{hiredOn:REAL,joinDate:REAL}});
 });
 it('accepts an Effective Date before the Join Date when it is on or after the Group Join Date',async()=>{
  const id=await hire('R2-JOIN');
  await correct(id,{hiredOn:REAL,departmentId:b.deptB},'2026-02-01');
  expect(await dates(id)).toEqual({hiredOn:REAL,joinDate:KEYED});
  expect(await versions(id)).toEqual([[REAL,b.deptA],['2026-02-01',b.deptB]]);
 });
 it('refuses an Effective Date before the corrected Group Join Date, naming it and the fix',async()=>{
  const id=await hire('R2-EARLY');
  await expect(previewInformationCorrection(ctx(),{employmentId:id,changes:{hiredOn:REAL,departmentId:b.deptB},reason:'Fictional correction',effectiveOn:'2025-12-01'}))
   .rejects.toThrow(/before 2026-01-02, the Group Join Date.*correct the Group Join Date in this same correction/);
  expect(await dates(id)).toEqual({hiredOn:KEYED,joinDate:KEYED});
 });
});

describe('Group Join Date Correction moves the start of the dated records',()=>{
 it('lets a movement dated between the new and the old Group Join Date follow it',async()=>{
  const id=await hire('R2-GJD');
  await createMovementEvent(ctx(),{employmentId:id,kind:'groupJoinDateCorrection',effectiveDate:REAL,remarks:'Corrected from the personnel file'});
  expect((await dates(id)).hiredOn).toBe(REAL);
  expect(await versions(id)).toEqual([[REAL,b.deptA]]);
  const [aligned]=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.subjectEmploymentId,id),eq(schema.domainEvent.eventType,'employment.history.start.aligned')));
  expect(aligned.payload).toMatchObject({trigger:'groupJoinDateCorrection',alignedStart:{from:KEYED,to:REAL}});
  await createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB,remarks:'Fictional transfer'});
  expect(await versions(id)).toEqual([[REAL,b.deptA],['2026-02-01',b.deptB]]);
 });
 it('refuses a movement before the Group Join Date, naming the date',async()=>{
  const id=await hire('R2-BEFORE');
  await expect(createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB,remarks:'Fictional transfer'}))
   .rejects.toThrow(/before the employee's Group Join Date \(2026-03-15\)\. If the employee joined earlier, correct the Group Join Date first/);
  expect(await versions(id)).toEqual([[KEYED,b.deptA]]);
 });
 it('Roll Back returns the dated records to the original Group Join Date',async()=>{
  const id=await hire('R2-BACK');
  await createMovementEvent(ctx(),{employmentId:id,kind:'groupJoinDateCorrection',effectiveDate:REAL,remarks:'Corrected from the personnel file'});
  await reverseMovementEvent(ctx(),{employmentId:id,movementId:await groupJoinCorrection(id),reason:'Keyed against the wrong employee'});
  expect((await dates(id)).hiredOn).toBe(KEYED);
  expect(await versions(id)).toEqual([[KEYED,b.deptA]]);
 });
 it('Roll Back is refused while a movement dated before the original Group Join Date depends on it',async()=>{
  const id=await hire('R2-HOLD');
  await createMovementEvent(ctx(),{employmentId:id,kind:'groupJoinDateCorrection',effectiveDate:REAL,remarks:'Corrected from the personnel file'});
  await createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB,remarks:'Fictional transfer'});
  await expect(reverseMovementEvent(ctx(),{employmentId:id,movementId:await groupJoinCorrection(id),reason:'Keyed against the wrong employee'})).rejects.toThrow();
  expect((await dates(id)).hiredOn).toBe(REAL);
  expect(await versions(id)).toEqual([[REAL,b.deptA],['2026-02-01',b.deptB]]);
 });
});

describe('Movement import with a Group Join Date Correction in the same file',()=>{
 const row=(n:number,cells:Record<string,string>):MovementImportRecord=>({row:n,employeeCode:'R2-IMP',cells:{remarks:'Fictional history',...cells},errors:[],importVersion:2,source:{sheet:'Movements',row:n}} as MovementImportRecord);
 it('checks the earlier rows against the corrected Group Join Date and saves them in date order',async()=>{
  const id=await hire('R2-IMP');
  const records=[row(2,{kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB}),row(3,{kind:'groupJoinDateCorrection',effectiveDate:REAL})];
  const preview=await previewMovementImport(ctx(),{companyId:b.companyId,csv:'',records});
  expect(preview.employees[0].rows.map(r=>[r.row,r.errors]).sort()).toEqual([[2,[]],[3,[]]]);
  const committed=await commitMovementImport(ctx(),{companyId:b.companyId,csv:'',records,selection:preview.selection,inputHash:preview.inputHash,fingerprints:Object.fromEntries(preview.employees.map(e=>[e.employeeCode,e.fingerprint!])),acknowledgeExcluded:false});
  expect(committed.imported).toBe(2);
  expect((await dates(id)).hiredOn).toBe(REAL);
  expect(await versions(id)).toEqual([[REAL,b.deptA],['2026-02-01',b.deptB]]);
 });
 it('refuses a row before the corrected Group Join Date, naming the corrected date',async()=>{
  await hire('R2-IMP');
  const records=[row(2,{kind:'groupJoinDateCorrection',effectiveDate:REAL}),row(3,{kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB}),row(4,{kind:'transfer',effectiveDate:'2025-12-15',departmentId:b.deptB})];
  const preview=await previewMovementImport(ctx(),{companyId:b.companyId,csv:'',records});
  const refused=preview.employees[0].rows.find(r=>r.row===4)!;
  expect(refused.status).toBe('invalid');
  expect(refused.errors.join('; ')).toMatch(/^event_before_hire:2026-01-02/);
 });
});

describe('the Movement import message',()=>{
 const resolve=(key:string,fallback:string)=>key==='people.import.movement.issues.event_before_hire'?'This date is before the employee’s Group Join Date (%date%). Correct it first.':fallback;
 it('names the Group Join Date, and drops the bracket for a row recorded before the code carried it',()=>{
  expect(movementImportIssueText('event_before_hire:2026-01-02',resolve)).toBe('This date is before the employee’s Group Join Date (02-Jan-2026). Correct it first.');
  expect(movementImportIssueText('event_before_hire',resolve)).toBe('This date is before the employee’s Group Join Date. Correct it first.');
 });
});
