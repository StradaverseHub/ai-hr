import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {provenCompanyDatesTx} from '../core/employment-company';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
const today=()=>todayInKualaLumpur(),add=(d:string,n:number)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function worker(){
 const employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional dated proof',primaryEmail:randomUUID()+'@example.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:add(today(),-100)});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,employee.personId,'employee'),personId:employee.personId,roles:['employee']};
 return {...employee,ctx};
}
describe('canonical INVOKER dated-company point facts',()=>{
 it('retains inclusive tenure, unavailable versus missing proof, requested insertion order and duplicate keys',async()=>{
  const employee=await worker(),missing=randomUUID(),before=add(today(),-101),after=add(today(),1);
  await owner.db.update(s.employment).set({terminatedOn:today()}).where(eq(s.employment.id,employee.employmentId));
  const points=[{employmentId:employee.employmentId,date:after},{employmentId:missing,date:today()},
   {employmentId:employee.employmentId,date:today()},{employmentId:employee.employmentId,date:before},{employmentId:employee.employmentId,date:today()}];
  const proof=await withTenant(employee.ctx,tx=>provenCompanyDatesTx(tx,points));
  expect([...proof.keys()]).toEqual(points.slice(0,4).map(p=>p.employmentId+'|'+p.date));
  expect([...proof.values()]).toEqual([{companyId:null,reason:'outside_tenure'},{companyId:null,reason:'employment_unavailable'},
   {companyId:b.companyId,reason:null},{companyId:null,reason:'outside_tenure'}]);
  await owner.db.update(s.assignment).set({companyId:null}).where(eq(s.assignment.employmentId,employee.employmentId));
  expect((await withTenant(employee.ctx,tx=>provenCompanyDatesTx(tx,[points[2]]))).get(employee.employmentId+'|'+today())).toEqual({companyId:null,reason:'assignment_missing'});
 });
 it('uses the dated transfer boundary, ignores superseded rows, preserves owner maintenance, and adds no ordinary peer access',async()=>{
  const employee=await worker(),peer=await worker(),boundary=add(today(),-2),previous=add(boundary,-1);
  const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional dated destination'}).returning();
  const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional dated destination department'}).returning();
  const [initial]=await owner.db.select().from(s.assignment).where(eq(s.assignment.employmentId,employee.employmentId)).orderBy(s.assignment.validFrom,s.assignment.id);
  await owner.db.update(s.assignment).set({validTo:boundary}).where(eq(s.assignment.id,initial.id));
  await owner.db.insert(s.assignment).values({...initial,id:randomUUID(),companyId:company.id,departmentId:department.id,validFrom:boundary,validTo:null});
  await owner.db.insert(s.assignment).values({...initial,id:randomUUID(),validTo:null,supersededAt:new Date()});
  await owner.db.update(s.employment).set({companyId:company.id}).where(eq(s.employment.id,employee.employmentId));
  const points=[{employmentId:employee.employmentId,date:previous},{employmentId:employee.employmentId,date:boundary}];
  const proof=await withTenant(employee.ctx,tx=>provenCompanyDatesTx(tx,points));
  expect([...proof.values()]).toEqual([{companyId:b.companyId,reason:null},{companyId:company.id,reason:null}]);
  const maintenance=await owner.db.transaction(tx=>provenCompanyDatesTx(tx,points));expect(maintenance).toEqual(proof);
  const unavailable=await withTenant(peer.ctx,tx=>provenCompanyDatesTx(tx,points));
  expect([...unavailable.values()]).toEqual(points.map(()=>({companyId:null,reason:'employment_unavailable'})));
 });
});
