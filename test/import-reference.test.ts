/** Board 8d02748a — pure display rules for readable import log references (no database). */
import {describe,expect,it} from 'vitest';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import {formatImportActor,formatImportBatch,importActorEmployeeCode,importActorFromFacts,importBatchCode,type ImportActorEmployment} from '../lib/import-reference';
import {currentEmployeeCode} from '../lib/current-employee-code';

const ACME='11111111-1111-4111-8111-111111111111',BETA='22222222-2222-4222-8222-222222222222';
const job=(code:string,companyId:string,hiredOn:string,end:Partial<ImportActorEmployment>={}):ImportActorEmployment=>({employeeCode:code,companyId,hiredOn,terminatedOn:null,lastWorkingDate:null,...end});
const t=createTranslator({locale:'en',messages:en,namespace:'importLog'});

describe('batch reference',()=>{
 it('is the first 8 hex characters of the internal id, upper case, and never the full id',()=>{
  expect(importBatchCode('7f3a2c19-4b8e-4d21-9a6f-0c5e8b13d7a2')).toBe('7F3A2C19');
  expect(formatImportBatch(t,'7f3a2c19-4b8e-4d21-9a6f-0c5e8b13d7a2')).toBe('Batch 7F3A2C19');
 });
});

describe('Employee ID on the import date',()=>{
 it('uses the only coded employment',()=>{
  expect(importActorEmployeeCode([job('EMP-0412',ACME,'2024-01-01')],'2026-11-05',[ACME])).toBe('EMP-0412');
 });
 it('prefers the employment in the import company when two are concurrent',()=>{
  const both=[job('EMP-0412',ACME,'2024-01-01'),job('BETA-0077',BETA,'2025-01-01')];
  expect(importActorEmployeeCode(both,'2026-11-05',[BETA])).toBe('BETA-0077');
  expect(importActorEmployeeCode(both,'2026-11-05',[ACME])).toBe('EMP-0412');
  // No company on the log (attendance, leave): the most recent active hire.
  expect(importActorEmployeeCode(both,'2026-11-05',[])).toBe('BETA-0077');
 });
 it('ignores an employment that ended before the import date, and one that started after it',()=>{
  const history=[job('OLD-1',ACME,'2020-01-01',{terminatedOn:'2023-12-31'}),job('NEW-2',ACME,'2024-01-01')];
  expect(importActorEmployeeCode(history,'2026-11-05',[ACME])).toBe('NEW-2');
  expect(importActorEmployeeCode(history,'2022-05-01',[ACME])).toBe('OLD-1');
  expect(importActorEmployeeCode([job('LWD-1',ACME,'2020-01-01',{lastWorkingDate:'2026-01-31'}),job('X-2',BETA,'2026-01-01')],'2026-03-01',[ACME])).toBe('X-2');
 });
 it('keeps the ID held on the import day after a rehire under a new ID',()=>{
  const rehire=[job('BETA-0009',BETA,'2023-03-01',{terminatedOn:'2026-06-30'}),job('BETA-0100',BETA,'2026-09-01')];
  expect(importActorEmployeeCode(rehire,'2026-01-10',[BETA])).toBe('BETA-0009');
  expect(importActorEmployeeCode(rehire,'2026-10-01',[BETA])).toBe('BETA-0100');
 });
 it('falls back to the most recently hired coded employment when none was active that day',()=>{
  expect(importActorEmployeeCode([job('A-1',ACME,'2019-01-01',{terminatedOn:'2020-01-01'}),job('B-2',ACME,'2021-01-01',{terminatedOn:'2022-01-01'})],'2026-11-05',[ACME])).toBe('B-2');
 });
 it('returns one code, never a joined list, and nothing without a coded employment',()=>{
  const both=[job('EMP-0412',ACME,'2024-01-01'),job('BETA-0077',BETA,'2025-01-01')];
  expect(importActorEmployeeCode(both,'2026-11-05',[ACME,BETA])).not.toContain(',');
  expect(importActorEmployeeCode([],'2026-11-05',[ACME])).toBeNull();
  expect(importActorEmployeeCode([job('  ',ACME,'2024-01-01')],'2026-11-05',[ACME])).toBeNull();
 });
 it('leaves the Users directory rule unchanged (joined list of current codes)',()=>{
  expect(currentEmployeeCode([{employeeCode:'A',hiredOn:'2024-01-01',terminatedOn:null,lastWorkingDate:null},{employeeCode:'B',hiredOn:'2025-01-01',terminatedOn:null,lastWorkingDate:null}],'2026-11-05')).toBe('B, A');
 });
});

describe('Imported by',()=>{
 const base={userExists:true,importDate:'2026-11-05',companyIds:[ACME],employments:[] as ImportActorEmployment[]};
 it('shows name and Employee ID',()=>{
  const actor=importActorFromFacts({...base,fullName:'Aisyah Rahman',loginSuffix:null,employments:[job('EMP-0412',ACME,'2024-01-01')]});
  expect(formatImportActor(t,actor)).toBe('Aisyah Rahman (EMP-0412)');
 });
 it('shows the name alone without an Employee ID',()=>{
  expect(formatImportActor(t,importActorFromFacts({...base,fullName:'Farid Osman',loginSuffix:null}))).toBe('Farid Osman');
 });
 it('names an administrator login with no employee record by its login ending, as Admin > Users does',()=>{
  expect(formatImportActor(t,importActorFromFacts({...base,fullName:null,loginSuffix:'9C41E2'}))).toBe('Administrator login (no employee record · login ending 9C41E2)');
 });
 it('says Unavailable user for a missing login or a row with no facts',()=>{
  expect(formatImportActor(t,importActorFromFacts({...base,userExists:false,fullName:null,loginSuffix:null}))).toBe('Unavailable user');
  expect(formatImportActor(t,importActorFromFacts(undefined))).toBe('Unavailable user');
  expect(formatImportActor(t,undefined)).toBe('Unavailable user');
 });
 it('formats in all six languages with the values filled in',()=>{
  for(const messages of [en,ms,ta,th,vi,zh]){
   const tr=createTranslator({locale:'en',messages,namespace:'importLog'});
   expect(formatImportActor(tr,{kind:'person',name:'Aisyah Rahman',employeeCode:'EMP-0412'})).toMatch(/Aisyah Rahman.*EMP-0412/);
   expect(formatImportActor(tr,{kind:'unlinked',loginSuffix:'9C41E2'})).toContain('9C41E2');
   expect(formatImportBatch(tr,'7f3a2c19-4b8e-4d21-9a6f-0c5e8b13d7a2')).toContain('7F3A2C19');
   expect(formatImportActor(tr,{kind:'unavailable'}).length).toBeGreaterThan(0);
  }
 });
});
