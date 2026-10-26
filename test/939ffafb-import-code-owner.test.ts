/** Existing service APIs: these assertions detect restoring the old label-first/colliding-code paths. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import * as s from '../db/schema';
import { createProfileOption } from '../core/profile-options';
import { bulkSaveLabels, createJobGrade } from '../core/admin';
import { validateEmployeeImport, commitEmployeeImport } from '../core/import';
import { commitSectionImport } from '../core/import-sections';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { listQualifications } from '../core/qualifications';
import { previewMovementImport, commitMovementImport, movementImportCatalog } from '../core/movement-import';
import { todayInKualaLumpur } from '../lib/hr-date';
import { toCsv } from '../lib/csv';
import {parseMovementTypeCsv} from '../lib/movement-type-csv';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b:Base;
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const fullRow=(code:string,base:string)=>({full_name:'Fictional code selection',email:`${code.toLowerCase()}@codes.test`,employee_code:code,department:'Finance',hired_on:day(-100),employment_type:'full_time',basic_salary:'4200',ic_number:'900101010001',org_base:base});

describe('939ffafb canonical code admission through existing owners',()=>{
 it('keeps a same-label Base code change visible in the single-type Movement preview before committing',async()=>{
  const ctx=adminCtx(b);
  await createProfileOption(ctx,{category:'base',value:'001',label:'Shared base'});
  await createProfileOption(ctx,{category:'base',value:'002',label:'Shared base'});
  expect((await commitEmployeeImport(ctx,{companyId:b.companyId,records:[fullRow('000BASECHANGE','001')]})).imported).toBe(1);
  const catalog=await movementImportCatalog(ctx,b.companyId),type=catalog.types.find(type=>type.code==='orgAssignmentChange');
  expect(type).toBeDefined();
  const parsed=parseMovementTypeCsv(toCsv([['employeeCode','orgBase','effectiveDate','remarks'],['000BASECHANGE','002',day(-1),'Fictional same-label Base change']]),type!,(_key,fallback)=>fallback);
  expect(parsed.fileErrors).toEqual([]);expect(parsed.records[0].cells.orgBase).toBe('002');
  const input={companyId:b.companyId,csv:'',records:parsed.records,sourceHash:'same-label-base-fixture'},preview=await previewMovementImport(ctx,input);
  expect(preview.valid).toBe(1);
  const row=preview.employees[0].rows[0];
  expect(row.before?.orgBase).toContain('001');expect(row.proposed?.orgBase).toContain('002');
  expect(row.before?.orgBase).not.toBe(row.proposed?.orgBase);
  const result=await commitMovementImport(ctx,{...input,selection:preview.selection,inputHash:preview.inputHash,fingerprints:Object.fromEntries(preview.employees.filter(employee=>employee.fingerprint).map(employee=>[employee.employeeCode,employee.fingerprint!])),acknowledgeExcluded:true});
  expect(result.imported).toBe(1);
  const [stored]=await owner.db.select().from(s.employment).where(and(eq(s.employment.companyId,b.companyId),eq(s.employment.employeeCode,'000BASECHANGE'))).orderBy(s.employment.id);
  expect(stored.orgBase).toBe('002');
 });

 it('full preview and commit choose the code owner over another record label, with exact stored identity',async()=>{
  const ctx=adminCtx(b);
  await createProfileOption(ctx,{category:'base',value:'001',label:'Shared base'});
  await createProfileOption(ctx,{category:'base',value:'002',label:'Shared base'});
  await createProfileOption(ctx,{category:'base',value:'003',label:'001'});
  await bulkSaveLabels(ctx,'department',{creates:[],updates:[{key:'code',id:b.deptA,name:'Finance',label:'People operations'},{key:'alias',id:b.deptB,name:'Operations',label:'Finance'}]});
  const records=[fullRow('000CODES','001')],preview=await validateEmployeeImport(ctx,{companyId:b.companyId,records});
  expect(preview.fileErrors).toEqual([]);expect(preview.validCount).toBe(1);
  expect((await commitEmployeeImport(ctx,{companyId:b.companyId,records})).imported).toBe(1);
  const [employee]=await owner.db.select().from(s.employment).where(and(eq(s.employment.companyId,b.companyId),eq(s.employment.employeeCode,'000CODES'))).orderBy(s.employment.id);
  expect(employee.orgBase).toBe('001');
  const assignments=await owner.db.select().from(s.assignment).where(and(eq(s.assignment.employmentId,employee.id),isNull(s.assignment.validTo),isNull(s.assignment.supersededAt))).orderBy(s.assignment.id);
  expect(assignments).toHaveLength(1);expect(assignments[0].departmentId).toBe(b.deptA);
  const ambiguous=await validateEmployeeImport(ctx,{companyId:b.companyId,records:[{...fullRow('BAD-CODES','Shared base'),email:'bad@codes.test',ic_number:'900101010002'}]});
  expect(ambiguous.validCount).toBe(0);expect(ambiguous.rows[0].errors.some(error=>/ambiguous/i.test(error))).toBe(true);
 });
 it('section qualification updates use canonical codes and keep unambiguous older label input',async()=>{
  const ctx=adminCtx(b),employee=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-100),employeeCode:'000UPDATE',person:{fullName:'Fictional section update',primaryEmail:'section-update@codes.test'}});
  await createProfileOption(ctx,{category:'qualificationLevel',value:'Q001',label:'Academic qualification'});
  await createProfileOption(ctx,{category:'qualificationLevel',value:'Q002',label:'Q001'});
  const result=await commitSectionImport(ctx,{section:'qualification',records:[{employee_code:'000UPDATE',qualification:'Q001',institute:'First institute'},{employee_code:'000UPDATE',qualification:'Academic qualification',institute:'Second institute'}]});
  expect(result.fileErrors).toEqual([]);expect(result.updated).toBe(2);
  const rows=await listQualifications(ctx,{employmentId:employee.employmentId});
  expect(rows).toHaveLength(2);expect(rows.every(row=>row.qualification==='Q001')).toBe(true);
 });
 it('Movement preview and commit resolve grade codes before another grade label without bypassing its canonical owner',async()=>{
  const ctx=adminCtx(b),employee=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-100),employeeCode:'000MOVEMENT',person:{fullName:'Fictional Movement code',primaryEmail:'movement@codes.test'}});
  await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:3500,effectiveFrom:day(-100)});
  const grade=await createJobGrade(ctx,{code:'G01',name:'Specialist',rank:1});
  await createJobGrade(ctx,{code:'G02',name:'G01',rank:2});
  const csv=toCsv([['employee_code','event_type','effective_date','grade_id','remarks'],['000MOVEMENT','promotion',day(-1),'G01','Fictional grade change by exact code']]);
  const preview=await previewMovementImport(ctx,{companyId:b.companyId,csv});
  expect(preview.fileErrors).toEqual([]);expect(preview.valid).toBe(1);
  const result=await commitMovementImport(ctx,{companyId:b.companyId,csv,selection:preview.selection,inputHash:preview.inputHash,fingerprints:Object.fromEntries(preview.employees.filter(employee=>employee.fingerprint).map(employee=>[employee.employeeCode,employee.fingerprint!])),acknowledgeExcluded:true});
  expect(result.imported).toBe(1);
  const [stored]=await owner.db.select().from(s.employment).where(eq(s.employment.id,employee.employmentId)).orderBy(s.employment.id);
  expect(stored.gradeId).toBe(grade.id);expect(stored.employeeCode).toBe('000MOVEMENT');
 });
});
