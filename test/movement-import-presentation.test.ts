/** Real app-role reads under held writers; no mocked permission/data replies. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {movementImportCatalog,movementImportTemplateData,movementImportTypes} from '../core/movement-import';
import {hireEmployee} from '../core/org';
import {WorkforceAccessError} from '../core/workforce-access';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
const ctx=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const capabilities=['workforce.view','workforce.maintain'];
let original:{id:string;supported:boolean;bindings:unknown}[]=[];
beforeAll(async()=>{await migrateTestDb();original=await owner.client`select id,supported,bindings from access_capability where id=any(${capabilities}) order by id`;});
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${capabilities})`;
});
afterAll(async()=>{try{for(const row of original)await owner.client`update access_capability set supported=${row.supported},bindings=${JSON.stringify(row.bindings)}::jsonb where id=${row.id}`;}finally{await closeAll();}});
async function deny(capabilityId:string){
 const actor=ctx(),current=await database.withTenant(actor,tx=>accessConfigurationStore.loadCurrent(tx,actor));
 const edit={expectedRevision:current.snapshot.revision,command:{kind:'setOverride' as const,userId:actor.userId!,capabilityId,companyId:b.companyId,effect:'deny' as const}};
 const preview=await previewAccessConfiguration(actor,edit,accessConfigurationStore);
 await saveAccessConfiguration(actor,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
}
it('returns the native complete catalogue and template under Access, History, Workforce-generation and type writers',async()=>{
 const actor=ctx(),subject=await hireEmployee(actor,{person:{fullName:'Fictional template colleague',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01',employeeCode:'NATIVE-TEMPLATE'});
 const expected=await movementImportCatalog(actor,b.companyId),template=await movementImportTemplateData(actor),types=await movementImportTypes(actor);
 expect(expected.types.length).toBeGreaterThan(0);expect(expected.fields.departmentId?.map(row=>row.value)).toContain(b.deptA);
 expect(expected.fields.managerEmploymentId?.find(row=>row.value===subject.employmentId)).toMatchObject({codes:['NATIVE-TEMPLATE'],companyId:b.companyId});
 expect(template.companies).toHaveLength(1);expect(template.companies[0]).toMatchObject({companyId:b.companyId,catalog:expected});expect(template.types).toEqual(types);
 const events=[...await owner.client`select to_jsonb(e) as value from domain_event e where tenant_id=${b.tenantId}::uuid order by id`];
 const actual=database.withTenant,modes:{role:string;isolation:string;mode:string;advisory:boolean}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  const result=await read(tx);
  const [mode]=await tx.execute<{role:string;isolation:string;mode:string;advisory:boolean}>(sql`select current_user as role,current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as mode,exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted) as advisory`);
  modes.push(mode);return result;
 },options));
 try{
  for(const kind of ['access','history','generation','types']as const){
   await owner.client.begin(async holder=>{
    if(kind==='access')await holder`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
    if(kind==='history')await holder`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+b.tenantId}))`;
    if(kind==='generation')await holder`select tenant_id from app.access_profile_write_generation where tenant_id=${b.tenantId}::uuid for update`;
    if(kind==='types')await holder`select pg_advisory_xact_lock(hashtextextended(${'movement-type-catalogue:'+b.tenantId},0))`;
    const [identity]=await holder`select pg_backend_pid() as pid`;
    expect(await movementImportCatalog(actor,b.companyId)).toEqual(expected);
    expect(await movementImportTemplateData(actor)).toEqual(template);
    expect(await movementImportTypes(actor)).toEqual(types);
    const [held]=await holder`select exists(select 1 from pg_locks where pid=${identity.pid} and granted and locktype=${kind==='generation'?'relation':'advisory'}) as held`;
    expect(held.held).toBe(true);
   });
  }
 }finally{spy.mockRestore();}
 expect(modes).toHaveLength(12);expect(modes.every(row=>row.role==='ai_hr_app'&&row.isolation==='repeatable read'&&row.mode==='on'&&!row.advisory)).toBe(true);
 expect([...await owner.client`select to_jsonb(e) as value from domain_event e where tenant_id=${b.tenantId}::uuid order by id`]).toEqual(events);
},30000);
it.for(capabilities)('retains fresh native %s permission refusal for catalogue and template',async capability=>{
 const actor=ctx();expect((await movementImportTemplateData(actor)).companies).toHaveLength(1);
 await owner.client`update access_capability set supported=true,bindings='[{"owner":"movement-native-test","operation":"reference-display"}]'::jsonb where id=any(${capabilities})`;
 await deny(capability);
 const before=[...await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`];
 await expect(movementImportCatalog(actor,b.companyId)).rejects.toBeInstanceOf(WorkforceAccessError);
 expect((await movementImportTemplateData(actor)).companies).toEqual([]);
 expect([...await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`]).toEqual(before);
});
it('captures supplied identity and rejects native role drift, archived users and foreign companies',async()=>{
 const supplied=ctx(),pending=movementImportTemplateData(supplied);supplied.tenantId=randomUUID();supplied.userId=randomUUID();supplied.roles![0]='employee';supplied.grants![0].role='employee';
 expect((await pending).companies.map(row=>row.companyId)).toEqual([b.companyId]);
 await expect(movementImportCatalog(ctx(),randomUUID())).rejects.toBeInstanceOf(WorkforceAccessError);
 const foreign=await seedBase();await expect(movementImportCatalog(ctx(),foreign.companyId)).rejects.toBeInstanceOf(WorkforceAccessError);
 await owner.client`update role_assignment set role='employee' where app_user_id=${b.adminUserId}::uuid`;
 await expect(movementImportTypes(ctx())).rejects.toBeInstanceOf(WorkforceAccessError);
 await owner.client`update role_assignment set role='hr_admin' where app_user_id=${b.adminUserId}::uuid`;
 await owner.client`update app_user set archived_at=now() where id=${b.adminUserId}::uuid`;
 await expect(movementImportTemplateData(ctx())).rejects.toBeInstanceOf(WorkforceAccessError);
});
