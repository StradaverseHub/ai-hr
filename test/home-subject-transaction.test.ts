/** Real APP-role Home admission accounting and fresh-read controls; not capacity evidence. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as tenantDb from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {myOwnEmploymentSubjects} from '../core/read';
import {ownHomeSubjectSelection} from '../core/employee-home';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
async function fixture(){
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Home admission',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee']};
 const [secondCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional second Home company'}).returning();
 const [secondDepartment]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:secondCompany.id,name:'Fictional second Home department'}).returning();
 const second=await hireEmployee(adminCtx(b),{person:{id:hired.personId},companyId:secondCompany.id,departmentId:secondDepartment.id,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const [otherPerson]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional other Home person',primaryEmail:randomUUID()+'@example.invalid'}).returning({id:s.person.id});
 return {b,foreign,hired,second,ctx,otherPersonId:otherPerson.id};
}
// Exact former service reads remain independent of the candidate facade.
async function formerSubjects(ctx:SessionContext){
 const [proof]=await tenantDb.withTenant(ctx,tx=>tx.execute(sql`SELECT (app.principal_snapshot_current()
  AND (${ctx.personId??null}::uuid IS NULL OR app.is_self_person(${ctx.personId??null}::uuid))) AS ok`));
 if(!proof.ok)throw Error('Former principal refused');
 return myOwnEmploymentSubjects(ctx);
}
it('keeps populated own subjects, dated proof and selection while using one APP setup instead of two',async()=>{
 const {ctx,hired,second}=await fixture();const expected=await formerSubjects(ctx);
 expect(expected.map(row=>row.employmentId).sort()).toEqual([hired.employmentId,second.employmentId].sort());
 expect(expected.every(row=>row.companyProof.companyId!==null)).toBe(true);
 expect((await ownHomeSubjectSelection(ctx)).state).toBe('choose');
 const value=await ownHomeSubjectSelection(ctx,second.employmentId);
 expect(value).toEqual({state:'selected',subjects:expected,subject:expected.find(row=>row.employmentId===second.employmentId)});
 const [actor]=await tenantDb.client`select current_user as role`;expect(actor.role).toBe('ai_hr_app');
 await owner.client.unsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
 const setups=async()=>{const [row]=await owner.client`select coalesce(sum(calls),0)::int as n from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())and lower(query)~'^select[[:space:]]+set_config.*set_config'`;return row.n as number;};
 await owner.client`select pg_stat_statements_reset()`;await formerSubjects(ctx);const legacySetups=await setups();expect(legacySetups).toBe(2);
 await owner.client`select pg_stat_statements_reset()`;expect(await ownHomeSubjectSelection(ctx,second.employmentId)).toEqual(value);const actualSetups=await setups();
 const evidence:Record<string,unknown>={kind:'NATIVE_HOME_ADMISSION_NOT_CAPACITY',role:actor.role,legacySetups,actualSetups,populatedSubjects:2,datedProof:true};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/home-subject-transactions.json',JSON.stringify(evidence));};save();
 expect(actualSetups).toBe(1);
 const burst=async(read:()=>Promise<unknown>)=>{const start=performance.now();for(let i=0;i<40;i++)await read();return performance.now()-start;};
 evidence.component40ReadBurstsMs={former1:await burst(()=>formerSubjects(ctx)),candidate1:await burst(()=>ownHomeSubjectSelection(ctx,second.employmentId)),former2:await burst(()=>formerSubjects(ctx)),candidate2:await burst(()=>ownHomeSubjectSelection(ctx,second.employmentId))};save();
},90000);
it('keeps forged-person, foreign-selector, stale-role and unauthenticated refusal paths',async()=>{
 const {ctx,hired,foreign,otherPersonId}=await fixture();
 await expect(ownHomeSubjectSelection({...ctx,userId:undefined},hired.employmentId)).rejects.toMatchObject({code:'authentication'});
 await expect(ownHomeSubjectSelection({...ctx,personId:otherPersonId},hired.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
 await expect(ownHomeSubjectSelection({...ctx,tenantId:foreign.tenantId},hired.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
 await expect(ownHomeSubjectSelection({...ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},hired.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
 await expect(ownHomeSubjectSelection(ctx,randomUUID())).rejects.toMatchObject({code:'employmentUnavailable'});
 expect(await ownHomeSubjectSelection({...ctx,personId:null})).toEqual({state:'none',subjects:[],subject:null});
});
it('observes actual login archive and person rebinding between the proof and subject SQL, without a result cache',async()=>{
 const {ctx,hired,otherPersonId}=await fixture();const original=tenantDb.withTenant;
 for(const change of ['archive','rebind'] as const){
  let injected=false;
  const intercept:typeof original=async<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>original(who,tx=>read(new Proxy(tx,{get(target,key,receiver){
   if(key==='execute')return async(...args:Parameters<Tx['execute']>)=>{
    const rows=await target.execute(...args);
    if(!injected&&Array.isArray(rows)&&rows[0]?.ok===true){
     injected=true;
     await owner.db.update(s.appUser).set(change==='archive'?{archivedAt:new Date()}:{personId:otherPersonId}).where(eq(s.appUser.id,ctx.userId!));
    }
    return rows;
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }})),options);
  const observer=vi.spyOn(tenantDb,'withTenant').mockImplementation(intercept);
  try{await expect(ownHomeSubjectSelection(ctx,hired.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});expect(injected).toBe(true);}
  finally{observer.mockRestore();await owner.db.update(s.appUser).set({archivedAt:null,personId:hired.personId}).where(eq(s.appUser.id,ctx.userId!));}
  expect((await ownHomeSubjectSelection(ctx,hired.employmentId)).subject?.employmentId).toBe(hired.employmentId);
 }
});
