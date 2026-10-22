/** ADR-0009: administrative authority follows the subject company; structural read access cannot lend it. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {company,department,domainEvent,person} from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {assignRole} from '../core/admin';
import {appendEvent,actorOf} from '../db/events';
import policy from '../lib/pdpa-erasure-policy.json';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
let b:Base;
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function fixture(){
 const [c]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional sibling B'}).returning({id:company.id});
 const [d]=await owner.db.insert(department).values({tenantId:b.tenantId,companyId:c.id,name:'Fictional B department'}).returning({id:department.id});
 const hire=(label:string,companyId:string,departmentId:string)=>hireEmployee(admin(),{person:{fullName:label,primaryEmail:`${randomUUID()}@example.invalid`},companyId,departmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const manager=await hire('Actual A HR and B structural manager',c.id,d.id),subject=await hire('Fictional B contact subject',c.id,d.id),inside=await hire('Fictional A contact subject',b.companyId,b.deptA);
 const userId=await createAppUser(b.tenantId,manager.personId,'employee');
 await assignRole(admin(),{appUserId:userId,role:'hr_admin',companyId:b.companyId});
 const ctx:SessionContext={...admin(),userId,personId:manager.personId,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:b.companyId}]};
 for(const s of [subject,inside])await owner.db.update(person).set({firstName:'FICTIONAL RETAINED FIRST',phone:'FICTIONAL-RETAIN-THIS',personalEmail:'fictional-contact@example.invalid'}).where(eq(person.id,s.personId));
 return {companyB:c.id,manager,subject,inside,ctx};
}
const input=(id:string)=>({subjectEmploymentId:id,scope:'contact' as const,reason:'Fictional scope diagnostic',requestRef:'FICTIONAL-COMPANY-SCOPE'});
const snapshot=async(p:string)=>({rows:await owner.db.select().from(person).where(eq(person.id,p)),events:await owner.db.select({id:domainEvent.id}).from(domainEvent).where(and(eq(domainEvent.aggregateId,p),eq(domainEvent.eventType,'pii.erased'))).orderBy(domainEvent.id)});
async function directWitness(ctx:SessionContext,employmentId:string,personId:string){
 return withTenant(ctx,async tx=>{
  const p=input(employmentId);
  await tx.execute(sql`select app.access_privacy_erasure_begin(${employmentId}::uuid,${p.scope},${p.requestRef},${p.reason})`);
  const fields=policy.fields.filter(f=>f.table==='person'&&!f.statutoryLocked&&f.scopes.includes('contact'));
  const patch=Object.fromEntries(fields.map(f=>[f.key,null]));
  await tx.update(person).set(patch).where(eq(person.id,personId));
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'person',aggregateId:personId,subjectEmploymentId:employmentId,eventType:'pii.erased',actor:actorOf(ctx),payload:{scope:p.scope,requestRef:p.requestRef,reason:p.reason,erasedFields:fields.map(f=>f.key),withheld:[]}});
 });
}
describe('privacy SQL witness selected-company boundary',()=>{
 it('can complete the exact finite contact witness for actual HR within its company',async()=>{
  const f=await fixture();await directWitness(f.ctx,f.inside.employmentId,f.inside.personId);
  const after=await snapshot(f.inside.personId);expect(after.rows[0].phone).toBeNull();expect(after.events).toHaveLength(1);
 });
 it('does not let HR in A use structural visibility in B to complete the same runtime SQL witness for B',async()=>{
  const f=await fixture();
  await setReportingLine(admin(),{subordinateEmploymentId:f.subject.employmentId,managerEmploymentId:f.manager.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
  const [facts]=await withTenant(f.ctx,tx=>tx.execute<{principalCurrent:boolean;adminSomewhere:boolean;seesB:boolean;administersB:boolean}>(sql`select app.principal_snapshot_current() as "principalCurrent",app.is_admin() as "adminSomewhere",app.can_see_employment(${f.subject.employmentId}::uuid) as "seesB",app.can_admin_employment(${f.subject.employmentId}::uuid) as "administersB"`));
  expect(facts).toEqual({principalCurrent:true,adminSomewhere:true,seesB:true,administersB:false});
  const before=await snapshot(f.subject.personId);const error=await directWitness(f.ctx,f.subject.employmentId,f.subject.personId).then(()=>null,e=>e);
  const after=await snapshot(f.subject.personId);
  expect(error).not.toBeNull();expect(pgSqlState(error)).toBe('42501');expect(after).toEqual(before);
 });
});
