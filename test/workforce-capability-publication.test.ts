/** Actual storage transaction, default availability, stale-writer and runtime-refusal contracts. */
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {migrateTestDb,resetDb,seedBase,adminCtx,owner,closeAll,type Base} from './harness';
import {client,db} from '../db/client';
import {appUser,tenant} from '../db/schema';
import {publishWorkforceCapabilities,WORKFORCE_CAPABILITY_BINDINGS,WORKFORCE_CAPABILITY_BINDINGS_SHA256} from '../deploy/access/publish-workforce-capabilities';
import {workforceCompanies} from '../core/workforce-access';
import {readAccessConfigurationEditor} from '../core/access-configuration-editor';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {accessConfigurationStore} from '../core/access-configuration-store';
let b:Base;
const ids=['workforce.view','workforce.maintain','profile.review'];
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${ids}::text[])`;});
afterAll(async()=>{try{await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${ids}::text[])`;}finally{await closeAll();}});
async function snapshot(){return{
 catalog:await owner.client`select * from access_capability order by id`,
 configuration:await owner.client`select * from access_configuration order by tenant_id`,
 generation:await owner.client`select * from app.access_profile_write_generation order by tenant_id`,
 grants:await owner.client`select * from access_group_grant order by id`,
 memberships:await owner.client`select * from access_membership order by id`,
 overrides:await owner.client`select * from access_user_override order by id`,
 roles:await owner.client`select * from role_assignment order by id`,
 users:await owner.client`select * from app_user order by id`,
 events:await owner.client`select id from domain_event order by id`,
};}
it('publishes the exact three source bindings atomically, preserves actual role/grant/member facts and is idempotent',async()=>{
 const before=await snapshot(),scope=await workforceCompanies(adminCtx(b));expect(scope).toContain(b.companyId);
 const result=await publishWorkforceCapabilities(owner.client);expect(result).toMatchObject({changed:true,capabilities:3,bindingsSha256:WORKFORCE_CAPABILITY_BINDINGS_SHA256});
 const after=await snapshot();for(const key of ['grants','memberships','overrides','roles','users']as const)expect(after[key]).toEqual(before[key]);
 for(const expected of WORKFORCE_CAPABILITY_BINDINGS)expect(after.catalog.find(row=>row.id===expected.id)).toMatchObject({...expected,supported:true});
 for(const previous of before.catalog.filter(row=>!ids.includes(row.id)))expect(after.catalog.find(row=>row.id===previous.id)).toEqual(previous);
 for(const row of before.generation)expect(after.generation.find(next=>next.tenant_id===row.tenant_id)?.generation).toBe(String(BigInt(row.generation)+BigInt(1)));
 for(const row of before.configuration)expect(after.configuration.find(next=>next.tenant_id===row.tenant_id)?.revision).not.toBe(row.revision);
 expect(await workforceCompanies(adminCtx(b))).toEqual(scope);
 expect(await publishWorkforceCapabilities(owner.client)).toMatchObject({changed:false,tenantsFenced:0});expect(await snapshot()).toEqual(after);
});
it('publishes array bindings and object audits through the plain standalone installer connection',async()=>{
 const standalone=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:1});
 try{
  expect(await publishWorkforceCapabilities(standalone)).toMatchObject({changed:true,capabilities:3});
  const shapes=await owner.client`select id,jsonb_typeof(bindings) as shape from access_capability where id=any(${ids}::text[]) order by id`;
  expect(shapes.map(row=>row.shape)).toEqual(['array','array','array']);
  const audits=await owner.client`select jsonb_typeof(payload) as shape,payload->>'bindingsSha256' as hash from domain_event where event_type='access-configuration.capabilities-published' order by tenant_id,id`;
  expect(audits.length).toBeGreaterThan(0);expect(audits.every(row=>row.shape==='object'&&row.hash===WORKFORCE_CAPABILITY_BINDINGS_SHA256)).toBe(true);
 }finally{await standalone.end({timeout:3});}
});
it.each(['partial','unknown'])('refuses a %s catalogue without changing any other row or event',async kind=>{
 if(kind==='partial')await owner.client`update access_capability set supported=true,bindings='[{"owner":"foreign-fixture","operation":"unknown"}]'::jsonb where id='workforce.view'`;
 else await owner.client`update access_capability set supported=true,bindings='[{"owner":"foreign-fixture","operation":"unknown"}]'::jsonb where id=any(${ids}::text[])`;
 const before=await snapshot();await expect(publishWorkforceCapabilities(owner.client)).rejects.toThrow('Workforce capability installation refused');expect(await snapshot()).toEqual(before);
});
it('refuses runtime publication and a claimed owner GUC without installing a definer or raw catalogue grant',async()=>{
 const before=await snapshot();await expect(publishWorkforceCapabilities(client)).rejects.toBeTruthy();
 await expect(client.begin(async tx=>{await tx`select set_config('app.owner','true',true)`;await tx`update access_capability set supported=true where id='workforce.view'`;})).rejects.toMatchObject({code:'42501'});
 expect(await snapshot()).toEqual(before);
});
it('refuses an active tenant without initialized recovery defaults instead of inventing a grant or administrator',async()=>{
 const [other]=await owner.db.insert(tenant).values({name:'Fictional uninitialized publication tenant',workosOrgId:'fictional-uninitialized-'+randomUUID()}).returning({id:tenant.id});
 await owner.db.insert(appUser).values({tenantId:other.id,workosUserId:'fictional-publication-without-recovery'});
 const before=await snapshot();await expect(publishWorkforceCapabilities(owner.client)).rejects.toThrow('Workforce capability installation refused');expect(await snapshot()).toEqual(before);
});
it('rolls back catalogue, preview revision and physical generations when the immutable publication audit refuses',async()=>{
 await owner.client`create function public.fixture_refuse_capability_publication() returns trigger language plpgsql as $$begin if NEW.event_type='access-configuration.capabilities-published' then raise exception 'Fictional publication audit refusal';end if;return NEW;end$$`;
 await owner.client`create trigger fixture_refuse_capability_publication before insert on domain_event for each row execute function public.fixture_refuse_capability_publication()`;
 try{const before=await snapshot();await expect(publishWorkforceCapabilities(owner.client)).rejects.toMatchObject({code:'P0001'});expect(await snapshot()).toEqual(before);}
 finally{await owner.client`drop trigger fixture_refuse_capability_publication on domain_event`;await owner.client`drop function public.fixture_refuse_capability_publication()`;}
});
it('invalidates a genuine pre-publication access preview without granting or changing its command',async()=>{
 const ctx=adminCtx(b),state=await readAccessConfigurationEditor(ctx),group=state.snapshot.groups.find(g=>g.name==='Employees');expect(group).toBeDefined();
 const edit={expectedRevision:state.snapshot.revision,command:{kind:'renameGroup',groupId:group!.id,name:'Fictional publication stale preview'}};
 const preview=await previewAccessConfiguration(ctx,edit,accessConfigurationStore);await publishWorkforceCapabilities(owner.client);
 await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore)).rejects.toMatchObject({code:'changed'});
});
it('fences an actual pre-pinned repeatable-read maintenance transaction after publication',async()=>{
 let pinned!:()=>void,resume!:()=>void;const reached=new Promise<void>(r=>{pinned=r;}),changed=new Promise<void>(r=>{resume=r;});
 const ctx=adminCtx(b);let pinnedReached=false;
 const outcome=db.transaction(async tx=>{
  await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(ctx.grants??[{role:'hr_admin',companyId:null}])},true)`);
  await tx.select({id:appUser.id}).from(appUser).where(eq(appUser.id,b.adminUserId));pinnedReached=true;pinned();await changed;
  await tx.execute(sql`select app.access_workforce_write_lock()`);
 },{isolationLevel:'repeatable read'}).then(()=>null,error=>{pinned();return error;});
 await reached;try{expect(pinnedReached).toBe(true);await publishWorkforceCapabilities(owner.client);}finally{resume();}
 const error=await outcome;let code:string|undefined;for(let e=error;e&&typeof e==='object';e=e.cause){if(typeof e.code==='string'){code=e.code;break;}}
 expect(code).toBe('40001');
});
