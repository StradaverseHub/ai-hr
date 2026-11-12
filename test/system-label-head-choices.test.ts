import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {appUser,company,domainEvent,employment,person,roleAssignment} from '../db/schema';
import {LabelHeadChoiceAccessError,labelMaintenanceHeadChoices,labelMaintenanceHeadSelections} from '../core/system-labels';
import {matchesEmployeeSearch} from '../lib/employee-search';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
async function add(b:Base,name:string,code:string|null,companyId=b.companyId,ended=false){
 const personId=randomUUID(),employmentId=randomUUID();
 await owner.db.insert(person).values({id:personId,tenantId:b.tenantId,fullName:name,primaryEmail:personId+'@example.invalid'});
 await owner.db.insert(employment).values({id:employmentId,tenantId:b.tenantId,personId,companyId,hiredOn:'2020-01-01',employeeCode:code,...(ended?{terminatedOn:'2021-12-31',terminationType:'voluntary' as const}:{})});
 return {employmentId,companyId,employeeCode:code,name};
}
async function nativeCalls<T>(operation:()=>Promise<T>){
 const native=database.withTenant,identities:unknown[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<R>(ctx:SessionContext,read:(tx:Tx)=>Promise<R>,options?:Parameters<typeof database.withTenant>[2])=>native(ctx,async tx=>{
  const [identity]=await tx.execute<{role:string;readOnly:string;isolation:string;tenant:string;user:string;employmentRls:boolean;personRls:boolean}>(sql`select current_user as role,current_setting('transaction_read_only') as "readOnly",current_setting('transaction_isolation') as isolation,app.current_tenant_id() as tenant,app.current_user_id() as "user",row_security_active('employment'::regclass) as "employmentRls",row_security_active('person'::regclass) as "personRls"`);
  expect(identity).toEqual({role:'ai_hr_app',readOnly:'on',isolation:'repeatable read',tenant:ctx.tenantId,user:ctx.userId,employmentRls:true,personRls:true});identities.push(identity);return read(tx);
 },options));
 try{return {value:await operation(),identities};}finally{spy.mockRestore();}
}
it('loads exact first/deep and retained ended heads from5001employees without an initial whole-workforce dependency',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),ids=Array.from({length:5001},(_,index)=>({employmentId:randomUUID(),personId:randomUUID(),name:'Fictional head employee '+String(index).padStart(5,'0'),employeeCode:'HEAD'+String(index).padStart(5,'0')}));
 for(let start=0;start<ids.length;start+=500){
  const batch=ids.slice(start,start+500);
  await owner.db.insert(person).values(batch.map(row=>({id:row.personId,tenantId:b.tenantId,fullName:row.name,primaryEmail:row.personId+'@example.invalid'})));
  await owner.db.insert(employment).values(batch.map(row=>({id:row.employmentId,tenantId:b.tenantId,personId:row.personId,companyId:b.companyId,hiredOn:'2020-01-01',employeeCode:row.employeeCode})));
 }
 await owner.db.update(employment).set({terminatedOn:'2021-12-31',terminationType:'voluntary'}).where(eq(employment.id,ids.at(-1)!.employmentId));
 const [before]=await owner.db.select({n:sql<number>`count(*)::int`}).from(domainEvent);
 const timings:Record<string,number>={},start=performance.now();
 const observed=await nativeCalls(async()=>{
  const selectedId=ids.at(-1)!.employmentId;let at=performance.now();
  const retained=await labelMaintenanceHeadSelections(ctx,[selectedId,selectedId]);timings.retainedMs=performance.now()-at;
  expect(retained).toEqual([{employmentId:selectedId,companyId:b.companyId,employeeCode:'HEAD05000',name:'Fictional head employee 05000'}]);
  at=performance.now();const first=await labelMaintenanceHeadChoices(ctx,{companyId:b.companyId,selectedId});timings.firstMs=performance.now()-at;
  expect(first.total).toBe(5001);expect(first.rows.map(row=>row.employmentId)).toEqual(ids.slice(0,25).map(row=>row.employmentId));expect(first.selected).toEqual(retained[0]);
  at=performance.now();const deep=await labelMaintenanceHeadChoices(ctx,{companyId:b.companyId,offset:5000,selectedId:ids[0].employmentId});timings.deepMs=performance.now()-at;
  expect(deep.total).toBe(5001);expect(deep.rows.map(row=>row.employmentId)).toEqual([selectedId]);expect(deep.selected?.employmentId).toBe(ids[0].employmentId);
  const beyond=await labelMaintenanceHeadChoices(ctx,{companyId:b.companyId,offset:6000});expect(beyond.rows).toEqual([]);expect(beyond.total).toBe(5001);
  const search=await labelMaintenanceHeadChoices(ctx,{companyId:b.companyId,query:'head05000',selectedId:ids[0].employmentId});expect(search.total).toBe(1);expect(search.rows.map(row=>row.employmentId)).toEqual([selectedId]);expect(search.selected?.employmentId).toBe(ids[0].employmentId);
  return {firstCount:first.rows.length,deepCount:deep.rows.length};
 });
 expect(observed.identities).toHaveLength(5);expect(observed.value).toEqual({firstCount:25,deepCount:1});
 const [after]=await owner.db.select({n:sql<number>`count(*)::int`}).from(domainEvent);expect(after).toEqual(before);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'system-label-head-5001.json'),JSON.stringify({kind:'NATIVE_SYSTEM_LABEL_HEAD_CHOICES',releaseEligible:false,employees:5001,initialHeadIdentityReads:1,maxPageRows:25,nativeIdentities:observed.identities,timings,totalMs:performance.now()-start,endedAndUnassignedSelection:true},null,2));
},120000);

it('keeps native admin/company authority independent of workspace filters and rechecks revocation, voids and archival',async()=>{
 const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
 const [other]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional other head company'}).returning();
 const local=await add(b,'Local head','L001'),outside=await add(b,'Other company head','O001',other.id),alien=await add(foreign,'Foreign head','F001');
 const [localPerson]=await owner.db.select({personId:employment.personId}).from(employment).where(eq(employment.id,local.employmentId));
 const employeeUser=await createAppUser(b.tenantId,localPerson.personId,'employee');
 const employeeCtx:SessionContext={tenantId:b.tenantId,userId:employeeUser,personId:localPerson.personId,roles:['employee']};
 await expect(labelMaintenanceHeadChoices(employeeCtx,{companyId:b.companyId})).rejects.toBeInstanceOf(LabelHeadChoiceAccessError);
 expect(await labelMaintenanceHeadSelections(employeeCtx,[local.employmentId])).toEqual([]);
 await expect(labelMaintenanceHeadChoices({...employeeCtx,roles:['hr_admin']},{companyId:b.companyId})).rejects.toThrow('calling authority');
 const all=await labelMaintenanceHeadSelections(ctx,[local.employmentId,outside.employmentId,alien.employmentId]);expect(all.map(row=>row.employmentId).sort()).toEqual([local.employmentId,outside.employmentId].sort());
 const page=await labelMaintenanceHeadChoices(ctx,{companyId:b.companyId,selectedId:outside.employmentId});expect(page.rows).toEqual([local]);expect(page.selected).toBeNull();
 const scopedUser=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,scopedUser));
 const scoped:SessionContext={tenantId:b.tenantId,userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
 expect((await labelMaintenanceHeadChoices(scoped,{companyId:b.companyId})).rows).toEqual([local]);
 await expect(labelMaintenanceHeadChoices(scoped,{companyId:other.id})).rejects.toBeInstanceOf(LabelHeadChoiceAccessError);
 await expect(labelMaintenanceHeadChoices(ctx,{companyId:foreign.companyId})).rejects.toBeInstanceOf(LabelHeadChoiceAccessError);
 expect(await labelMaintenanceHeadSelections(scoped,[outside.employmentId,alien.employmentId])).toEqual([]);
 await owner.db.update(person).set({voidedAt:new Date()}).where(eq(person.id,localPerson.personId));
 expect(await labelMaintenanceHeadChoices(ctx,{companyId:b.companyId,selectedId:local.employmentId})).toMatchObject({rows:[],total:0,selected:null});
 const grants=await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,scopedUser)).returning();
 try{await expect(labelMaintenanceHeadChoices(scoped,{companyId:b.companyId})).rejects.toThrow('calling authority');}finally{await owner.db.insert(roleAssignment).values(grants);}
 await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,b.adminUserId));
 await expect(labelMaintenanceHeadSelections(ctx,[outside.employmentId])).rejects.toThrow('calling authority');
});

it('keeps the code-first population, exact shared Unicode/code-fold matching and literal wildcard searches',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),fixtures=[
  await add(b,'İpek','EMP-0008'),await add(b,'Straße','EMP 0008',b.companyId,true),await add(b,'A 100% literal','EMP_0009'),
  await add(b,'A wildcard_underscore','EMP.0010'),await add(b,'Kelvin K','EMP-0011'),await add(b,'Ordinary','EMP0012'),await add(b,'No employee code',null),
 ];
 const expected=await owner.db.select({employmentId:employment.id,companyId:employment.companyId,employeeCode:employment.employeeCode,name:person.fullName}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(eq(employment.tenantId,b.tenantId)).orderBy(employment.employeeCode,employment.id);
 expect((await labelMaintenanceHeadChoices(ctx,{companyId:b.companyId})).rows).toEqual(expected);
 for(const query of ['emp0008','EMP\u00a00008','i','i\u0307','straße','100%','wildcard_','K','ordinary','no employee','no matching employee anywhere']){
  const page=await labelMaintenanceHeadChoices(ctx,{companyId:b.companyId,query,selectedId:fixtures[0].employmentId});
  const known=expected.filter(row=>matchesEmployeeSearch(row,query));expect(page.rows,query).toEqual(known);expect(page.total,query).toBe(known.length);expect(page.selected?.employmentId).toBe(fixtures[0].employmentId);
 }
 for(const [query,known] of [['emp0008',[fixtures[0].employmentId,fixtures[1].employmentId]],['EMP\u00a00008',[fixtures[0].employmentId,fixtures[1].employmentId]],['100%',[fixtures[2].employmentId]],['wildcard_',[fixtures[3].employmentId]],['straße',[fixtures[1].employmentId]]] as const){
  const actual=await labelMaintenanceHeadChoices(ctx,{companyId:b.companyId,query});expect(actual.rows.map(row=>row.employmentId).sort()).toEqual([...known].sort());expect(actual.total).toBe(known.length);
 }
});

it('takes no workforce read for no configured heads and captures caller state before admission',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),row=await add(b,'Captured head','C001'),query={companyId:b.companyId,query:'Captured',selectedId:row.employmentId};
 const native=database.withTenant,ids=[row.employmentId],spy=vi.spyOn(database,'withTenant');
 expect(await labelMaintenanceHeadSelections(ctx,[])).toEqual([]);expect(spy).not.toHaveBeenCalled();spy.mockRestore();
 let resume!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),release=new Promise<void>(r=>{resume=r;});
 let calls=0;
 const paused=vi.spyOn(database,'withTenant').mockImplementation(async<T>(session:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>{if(++calls===2)entered();await release;return native(session,read,options);});
 const pending=labelMaintenanceHeadChoices(ctx,query),selection=labelMaintenanceHeadSelections(ctx,ids);
 await ready;query.companyId=randomUUID();query.query='changed';ids[0]=randomUUID();ctx.roles=[];resume();
 try{expect((await pending).rows).toEqual([row]);expect(await selection).toEqual([row]);}finally{paused.mockRestore();}
});

it('does not wait for the Access writer and prohibits a native write inside its presentation transaction',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),row=await add(b,'Nonblocking head','N001');
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),done=new Promise<void>(r=>{release=r;});
 const writer=database.withTenant(ctx,async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`);entered();await done;});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await ready;const page=await Promise.race([labelMaintenanceHeadChoices(ctx,{companyId:b.companyId}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Read waited for an unrelated Access writer')),5000);})]);expect(page.rows).toEqual([row]);
 }finally{clearTimeout(timer);release();await writer;}
 const native=database.withTenant,spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(session:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(session,async tx=>{await read(tx);await tx.execute(sql`update employment set employee_code='not-written' where id=${row.employmentId}::uuid`);throw Error('Read-only write unexpectedly succeeded');},options));
 try{await expect(labelMaintenanceHeadChoices(ctx,{companyId:b.companyId})).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='25006');}finally{spy.mockRestore();}
});

it('stops later cursor work after disconnect and releases the native transaction',async()=>{
 const b=await seedBase(),ctx=adminCtx(b);await add(b,'Cursor head','CUR-001');
 const controller=new AbortController(),stop=Error('Controlled head lookup disconnect'),native=database.withTenant;
 let afterAbort=0,sawFetch=false;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(session:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(session,tx=>read(new Proxy(tx,{
  get(target,key,receiver){
   if(key==='execute')return async(...args:unknown[])=>{
    if(controller.signal.aborted)afterAbort++;
    const result=await Reflect.apply(target.execute,target,args);
    if(Array.isArray(result)&&result.some(row=>row&&typeof row==='object'&&'employeeCode' in row)){sawFetch=true;controller.abort(stop);}
    return result;
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  },
 })),options));
 try{await expect(labelMaintenanceHeadChoices(ctx,{companyId:b.companyId,query:'cursor'},controller.signal)).rejects.toBe(stop);}finally{spy.mockRestore();}
 expect(sawFetch).toBe(true);expect(afterAbort).toBe(0);
 expect((await labelMaintenanceHeadChoices(ctx,{companyId:b.companyId})).total).toBe(1);
});
