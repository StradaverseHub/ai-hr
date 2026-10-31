import {expect,it} from 'vitest';
import {EmployeeCodeMaintenance as C} from '../lib/assistant-actions/employee-code-maintenance-contract';
const id='82000000-0000-4000-8000-000000000001',human={action:C.action,contractVersion:1,employmentId:id,subjectId:id,expectedCode:null,employeeCode:' human-42 '};
it('requires an explicit nullable baseline and preserves human input until native normalization',()=>{expect(C.Human.parse(human)).toEqual(human);for(const forged of [{...human,expectedCode:undefined},{...human,actor:'hr_admin'},{...human,personId:id},{...human,subjectId:'82000000-0000-4000-8000-000000000002'}])expect(C.Human.safeParse(forged).success).toBe(false);});

it('binds displayed native before/after to the exact nominated baseline and normalized human code',()=>{
 const value={action:C.action,contractVersion:1,actionId:id,reviewedDigest:'a'.repeat(64),createdAt:'2026-10-30T01:00:00.000Z',expiresAt:'2026-10-30T01:10:00.000Z',content:human,review:{employmentId:id,subjectId:id,employeeName:'Fictional Dana',employeeCode:null,companyName:'Fictional Company',before:null,after:'HUMAN-42'},consequence:C.consequence};
 expect(C.Prepared.safeParse(value).success).toBe(true);expect(C.Prepared.safeParse({...value,review:{...value.review,after:'OTHER-42'}}).success).toBe(false);expect(C.Prepared.safeParse({...value,content:{...human,expectedCode:'DIFFERENT'}}).success).toBe(false);
});
