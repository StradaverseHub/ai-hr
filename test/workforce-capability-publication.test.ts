/** Actual storage transaction, default availability, stale-writer and runtime-refusal contracts. */
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {migrateTestDb,resetDb,seedBase,adminCtx,owner,closeAll,type Base} from './harness';
import {client,db,withTenant} from '../db/client';
import {appUser,tenant} from '../db/schema';
import {publishWorkforceCapabilities,WORKFORCE_CAPABILITY_BINDINGS,WORKFORCE_CAPABILITY_BINDINGS_SHA256} from '../deploy/access/publish-workforce-capabilities';
import {workforceCompanies} from '../core/workforce-access';
import {readAccessConfigurationEditor} from '../core/access-configuration-editor';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {accessConfigurationStore} from '../core/access-configuration-store';
let b:Base;
const ids=['workforce.view','workforce.maintain','profile.review'];
beforeAll(migrateTestDb);
// Publication state (migration 5071) is global: clear it with the catalogue so every case starts uninstalled.
const clearPublication=async()=>{await owner.client`delete from app.access_capability_tenant_publication`;await owner.client`delete from app.access_capability_publication`;};
beforeEach(async()=>{await resetDb();b=await seedBase();await clearPublication();await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${ids}::text[])`;});
afterAll(async()=>{try{await clearPublication();await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${ids}::text[])`;}finally{await closeAll();}});
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
// ── Per-tenant publication (migration 5071). Safety property: no capability ever becomes effective for a tenant
// without that tenant's own immutable publication audit, which commits with its publication, preview revision and
// physical writer generation. ───────────────────────────────────────────────────────────────────────────────────────
const ids3=['workforce.view','workforce.maintain','profile.review'];
/** What each of the three capabilities looks like to one tenant, through the per-tenant catalogue every reader uses. */
const effective=async(tenantId:string)=>Object.fromEntries((await owner.client<{id:string;supported:boolean;bindings:unknown[]}[]>`select id,supported,bindings from app.access_capability_effective(${tenantId}::uuid) where id=any(${ids3}::text[]) order by id`).map(r=>[r.id,{supported:r.supported,bindings:r.bindings}]));
const unpublished=Object.fromEntries(ids3.map(id=>[id,{supported:false,bindings:[]}]));
const publishedCatalogue=Object.fromEntries([...WORKFORCE_CAPABILITY_BINDINGS].map(c=>[c.id,{supported:true,bindings:c.bindings.map(x=>({...x}))}]));
/** A real application reader: the tenant's Access configuration as the editor loads it (app role, row security). */
const appCatalogue=async(ctx=adminCtx(b))=>Object.fromEntries((await withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx))).catalog.filter(c=>ids3.includes(c.id)).map(c=>[c.id,{supported:c.supported,bindings:c.bindings}]));
/** One tenant's publication facts: its publication row, preview revision, physical generation and audit events. */
async function tenantFacts(tenantId:string){
 const [row]=await owner.client<{published:boolean;revision:string|null;generation:string|null;audits:number}[]>`select
  exists(select 1 from app.access_capability_tenant_publication p where p.version=1 and p.tenant_id=${tenantId}::uuid) as published,
  (select revision::text from access_configuration where tenant_id=${tenantId}::uuid) as revision,
  (select generation::text from app.access_profile_write_generation where tenant_id=${tenantId}::uuid) as generation,
  (select count(*)::int from domain_event where tenant_id=${tenantId}::uuid and event_type='access-configuration.capabilities-published') as audits`;
 return row;
}
const refuseAuditFor=async(tenantId:string|null)=>{
 await owner.client.unsafe(`create function public.fixture_refuse_capability_publication() returns trigger language plpgsql as $$begin
  if NEW.event_type='access-configuration.capabilities-published' ${tenantId?`and NEW.tenant_id='${tenantId}'`:''} then raise exception 'Fictional publication audit refusal';end if;return NEW;end$$`);
 await owner.client`create trigger fixture_refuse_capability_publication before insert on domain_event for each row execute function public.fixture_refuse_capability_publication()`;
 return async()=>{await owner.client`drop trigger fixture_refuse_capability_publication on domain_event`;await owner.client`drop function public.fixture_refuse_capability_publication()`;};
};
it('rolls back a tenant\'s publication, preview revision and physical generation when its immutable publication audit refuses',async()=>{
 const before=await snapshot(),facts=await tenantFacts(b.tenantId);
 expect(await appCatalogue()).toEqual(unpublished);
 const restore=await refuseAuditFor(null);
 try{await expect(publishWorkforceCapabilities(owner.client)).rejects.toMatchObject({code:'P0001'});}finally{await restore();}
 // The global flip committed, but it made nothing effective: the refused tenant's publication, preview revision,
 // physical generation and audit all rolled back together, and every reader still sees the previous catalogue.
 expect((await owner.client`select supported from access_capability where id='workforce.view'`)[0]?.supported).toBe(true);
 expect(await tenantFacts(b.tenantId)).toEqual(facts);
 const stopped=await snapshot();
 for(const key of ['configuration','generation','grants','memberships','overrides','roles','users','events'] as const)expect(stopped[key]).toEqual(before[key]);
 for(const row of before.generation)expect(await effective(row.tenant_id)).toEqual(unpublished);
 expect(await appCatalogue()).toEqual(unpublished);
 expect((await owner.client`select count(*)::int n from app.access_capability_tenant_publication`)[0]?.n).toBe(0);
 // Once the audit succeeds the resumed run publishes the tenant once, with its fence and its audit.
 expect(await publishWorkforceCapabilities(owner.client)).toMatchObject({changed:true,capabilities:3,tenantsFenced:before.generation.length});
 const after=await tenantFacts(b.tenantId);
 expect(after).toMatchObject({published:true,audits:1,generation:String(BigInt(facts.generation!)+BigInt(1))});expect(after.revision).not.toBe(facts.revision);
 expect(await effective(b.tenantId)).toEqual(publishedCatalogue);expect(await appCatalogue()).toEqual(publishedCatalogue);
 expect((await owner.client`select state from app.access_capability_publication where version=1`)[0]?.state).toBe('published');
 expect(await publishWorkforceCapabilities(owner.client)).toMatchObject({changed:false,tenantsFenced:0});
 expect(await tenantFacts(b.tenantId)).toEqual(after);
});
it('leaves tenants already published consistent and unaffected when a later tenant\'s audit refuses, then resumes that tenant',async()=>{
 // A tenant that sorts before the fixture tenant is published first; the fixture tenant's audit then refuses.
 const early='00000000-0000-4000-8000-0000000000e1';
 await owner.db.insert(tenant).values({id:early,name:'Fictional early publication tenant',workosOrgId:'fictional-early-'+randomUUID()});
 const tenantsBefore=(await owner.client<{id:string}[]>`select id from tenant order by id`).map(r=>r.id);
 expect(tenantsBefore.indexOf(early)).toBeLessThan(tenantsBefore.indexOf(b.tenantId));
 const earlyBefore=await tenantFacts(early),lateBefore=await tenantFacts(b.tenantId);
 const restore=await refuseAuditFor(b.tenantId);
 try{await expect(publishWorkforceCapabilities(owner.client)).rejects.toMatchObject({code:'P0001'});}finally{await restore();}
 // Published before the refusal: its own publication, revision, generation step and exactly one audit, consistent.
 const earlyPublished=await tenantFacts(early);
 expect(earlyPublished).toMatchObject({published:true,audits:1,generation:String(BigInt(earlyBefore.generation!)+BigInt(1))});
 expect(await effective(early)).toEqual(publishedCatalogue);
 // The refused tenant rolled back entirely and stays on its previous catalogue, for every reader.
 expect(await tenantFacts(b.tenantId)).toEqual(lateBefore);
 expect(await effective(b.tenantId)).toEqual(unpublished);expect(await appCatalogue()).toEqual(unpublished);
 // Tenants after it were never reached, so they too keep their previous catalogue.
 for(const id of tenantsBefore.slice(tenantsBefore.indexOf(b.tenantId)+1)){expect((await tenantFacts(id)).published).toBe(false);expect(await effective(id)).toEqual(unpublished);}
 // Resuming publishes the remaining tenants once each and never touches the early tenant again.
 expect(await publishWorkforceCapabilities(owner.client)).toMatchObject({changed:true,tenantsFenced:tenantsBefore.length-tenantsBefore.indexOf(b.tenantId)});
 expect(await tenantFacts(early)).toEqual(earlyPublished);
 const late=await tenantFacts(b.tenantId);
 expect(late).toMatchObject({published:true,audits:1,generation:String(BigInt(lateBefore.generation!)+BigInt(1))});expect(late.revision).not.toBe(lateBefore.revision);
 expect(await appCatalogue()).toEqual(publishedCatalogue);
 const audits=await owner.client<{n:number}[]>`select count(*)::int n from domain_event where event_type='access-configuration.capabilities-published' group by tenant_id`;
 expect(audits).toHaveLength(tenantsBefore.length);expect(audits.every(row=>row.n===1)).toBe(true);
});
it('gates every installed reader of the capability catalogue on the tenant\'s own completed publication',async()=>{
 // Structural: every installed function that still names the stored catalogue reads only ids or scopes (default
 // grants, reference checks, the configuration commit, the payroll root fence's table list); every reader of
 // supported/bindings reads the per-tenant catalogue, so the global flip alone can make nothing effective.
 const functions=async(pattern:string)=>(await owner.client<{sig:string;body:string}[]>`select p.oid::regprocedure::text as sig,pg_get_functiondef(p.oid) as body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('app','public') and p.prokind='f' and p.proname<>'access_capability_effective' and pg_get_functiondef(p.oid) ~ ${pattern} order by 1`);
 const stored=await functions(String.raw`\maccess_capability\M`);
 expect(stored.map(f=>f.sig).sort()).toEqual(['app._payroll_completion_writer_fence()','app.access_configuration_commit(uuid,text,jsonb,uuid)','app.access_install_defaults(uuid,uuid)','app.access_validate_reference()'].sort());
 for(const f of stored)expect(f.body,f.sig).not.toMatch(/\b(c|cap)\.(supported|bindings)\b/);
 const gated=await functions('app[.]access_capability_effective[(]');
 expect(gated.length).toBeGreaterThanOrEqual(14);
 for(const sig of ['app.access_allowed_for_tenant(uuid,uuid,text,uuid)','app.access_configuration_state()','app.access_workforce_company(uuid,text)','app.letter_automation_owner_eligible_at(uuid,uuid,uuid,boolean)','app._payroll_completion_authority(uuid,uuid,uuid)'])
  expect(gated.map(f=>f.sig)).toContain(sig);
 // Behavioural: an open version with no tenant published keeps the previous catalogue for every tenant and reader.
 await owner.client`update access_capability set supported=true,bindings=${JSON.stringify(WORKFORCE_CAPABILITY_BINDINGS[0].bindings)}::text::jsonb where id='workforce.view'`;
 await owner.client`insert into app.access_capability_publication(version,bindings_sha256,state,previous) values(1,${WORKFORCE_CAPABILITY_BINDINGS_SHA256},'publishing',${JSON.stringify(unpublished)}::text::jsonb)`;
 try{
  expect((await effective(b.tenantId))['workforce.view']).toEqual({supported:false,bindings:[]});
  expect((await appCatalogue())['workforce.view']).toEqual({supported:false,bindings:[]});
  const allowed=async()=>(await withTenant(adminCtx(b),tx=>tx.execute<{allowed:boolean}>(sql`select app.access_capability_allowed('workforce.view',${b.companyId}::uuid) as allowed`)))[0].allowed;
  expect(await allowed()).toBe(false);
  // Only the tenant's own publication row (written with its audit) makes it effective, exactly as a catalogue
  // published with no version open.
  await owner.client`insert into app.access_capability_tenant_publication(version,tenant_id) values(1,${b.tenantId}::uuid)`;
  expect((await effective(b.tenantId))['workforce.view']?.supported).toBe(true);
  const afterOwnPublication=await allowed();
  await clearPublication();
  expect(afterOwnPublication).toBe(await allowed());expect(afterOwnPublication).toBe(true);
 }finally{await clearPublication();await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id='workforce.view'`;}
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
  await tx.execute(sql`select app.access_configuration_write_lock()`);
 },{isolationLevel:'repeatable read'}).then(()=>null,error=>{pinned();return error;});
 await reached;try{expect(pinnedReached).toBe(true);await publishWorkforceCapabilities(owner.client);}finally{resume();}
 const error=await outcome;let code:string|undefined;for(let e=error;e&&typeof e==='object';e=e.cause){if(typeof e.code==='string'){code=e.code;break;}}
 expect(code).toBe('40001');
});
