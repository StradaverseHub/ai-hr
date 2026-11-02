import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as S from '../db/schema';
import {hireEmployee} from '../core/org';
import {createSigningDocumentTx,readSigningDocumentTx,recordDocumentSigningActionTx,replaceDocumentSignerTx,type SigningRoute,type SigningDocument} from '../packs/document-signing/service';
import {signingComplete} from '../lib/document-signing-model';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
const hash='a'.repeat(64),rules={requiredRoles:['lm','employee'],independentApprovalFromRole:'lm'};
let b:Base,admin:SessionContext,subjectId:string,employmentId:string;
let manager:{userId:string;personId:string;ctx:SessionContext},employee:typeof manager,head:typeof manager,delegate:typeof manager;
let route:SigningRoute;
const originalHooks:{name:string;definition:string}[]=[];
const hooks=['probation_signing_access','probation_signing_guardrails','probation_signing_route_allowed','probation_signing_content'];
beforeAll(async()=>{
 await migrateTestDb();
 originalHooks.push(...await owner.db.execute<{name:string;definition:string}>(sql`select p.proname as name,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname in ('probation_signing_access','probation_signing_guardrails','probation_signing_route_allowed','probation_signing_content')`));
 await owner.db.execute(sql.raw(`create table public.test_document_signing_subject(id uuid primary key,tenant_id uuid not null references public.tenant(id),company_id uuid not null,employment_id uuid not null,admin_id uuid not null,readers uuid[] not null,route jsonb not null,rules jsonb not null,content jsonb not null);`));
 await owner.db.execute(sql.raw(`
 create or replace function app.probation_signing_access(p_subject uuid,p_operation text) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select exists(select 1 from public.test_document_signing_subject s where s.id=$1 and s.tenant_id=app.current_tenant_id() and
 (case when $2 in ('create','revise','reroute','decline') then s.admin_id=app.current_user_id() else app.current_user_id()=any(s.readers) end)); $$;
 create or replace function app.probation_signing_guardrails(p_subject uuid) returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select rules from public.test_document_signing_subject where id=$1 and tenant_id=app.current_tenant_id(); $$;
 create or replace function app.probation_signing_route_allowed(p_subject uuid,p_route jsonb) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select coalesce((select route=$2 from public.test_document_signing_subject where id=$1 and tenant_id=app.current_tenant_id()),false); $$;
 create or replace function app.probation_signing_content(p_subject uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
 declare value jsonb;begin select content into value from public.test_document_signing_subject where id=$1 and tenant_id=app.current_tenant_id() for update;return value;end; $$;`));
});
afterAll(async()=>{
 for(const name of hooks.filter(name=>!originalHooks.some(old=>old.name===name))){const args=name==='probation_signing_access'?'uuid,text':name==='probation_signing_route_allowed'?'uuid,jsonb':'uuid';await owner.db.execute(sql.raw(`drop function if exists app.${name}(${args});`));}
 for(const old of originalHooks)await owner.db.execute(sql.raw(old.definition));
 await owner.db.execute(sql.raw('drop table if exists public.test_document_signing_subject;'));await closeAll();
});
async function actor(name:string){const e=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@signing.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});const userId=await createAppUser(b.tenantId,e.personId,'employee');return{userId,personId:e.personId,employmentId:e.employmentId,ctx:{...admin,userId,roles:['employee'],grants:undefined}};}
async function updateRoute(next:SigningRoute){await owner.db.execute(sql`update test_document_signing_subject set route=${JSON.stringify(next)}::jsonb where id=${subjectId}::uuid`);}
async function create(contentHash=hash,signingEmploymentId=employmentId){return withTenant(admin,tx=>createSigningDocumentTx(tx,admin,{companyId:b.companyId,employmentId:signingEmploymentId,subjectId,subjectType:'probation',contentHash,route,guardrails:rules}));}
async function sign(documentId:string,who:typeof manager,stepId:string){return withTenant(who.ctx,tx=>recordDocumentSigningActionTx(tx,who.ctx,{id:documentId,stepId,revision:1,hash,action:'signed',method:'typed',value:stepId==='lm'?'Fictional Manager':stepId==='employee'?'Fictional Employee':'Fictional Head',consent:true}));}
function rawAction(who:typeof manager,step='lm'):Record<string,unknown>{return{id:randomUUID(),stepId:step,contentRevision:1,contentHash:hash,actorId:who.userId,actorPersonId:who.personId,actorName:'Caller cannot choose my name',representedId:who.userId,role:step,at:'1900-01-01T00:00:00Z',action:'signed',comment:'',signature:{method:'typed',value:'Fictional signature',consent:true}};}
async function rawAct(documentId:string,who:typeof manager,action:unknown){return withTenant(who.ctx,async tx=>(await tx.execute<{document:SigningDocument}>(sql`select app.document_signing_act(${documentId}::uuid,${JSON.stringify(action)}::jsonb) as document`))[0].document);}
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin=adminCtx(b);manager=await actor('Fictional Manager');const staff=await actor('Fictional Employee');employee=staff;employmentId=staff.employmentId;head=await actor('Fictional Head');delegate=await actor('Fictional Delegate');subjectId=randomUUID();
 route={version:1,steps:[{id:'lm',role:'lm',kind:'sign',stage:0,holderId:manager.userId,holderPersonId:manager.personId,required:true},{id:'employee',role:'employee',kind:'acknowledge',stage:1,holderId:employee.userId,holderPersonId:employee.personId,required:true},{id:'hod',role:'hod',kind:'approve',stage:2,holderId:head.userId,holderPersonId:head.personId,required:true}]};
 await owner.db.execute(sql`insert into test_document_signing_subject(id,tenant_id,company_id,employment_id,admin_id,readers,route,rules,content) values(${subjectId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,${admin.userId}::uuid,${[admin.userId!,manager.userId,employee.userId,head.userId,delegate.userId]}::uuid[],${JSON.stringify(route)}::jsonb,${JSON.stringify(rules)}::jsonb,${JSON.stringify({contentHash:hash,contentRevision:1,companyId:b.companyId,employmentId})}::jsonb)`);
});
describe('authoritative signing persistence and SQL boundaries',()=>{
 it('reads with SELECT-only rights and signs a real scoped route with authoritative person/name/time and private audit',async()=>{
  const created=await create();expect(await withTenant(manager.ctx,tx=>readSigningDocumentTx(tx,manager.ctx,created.id))).toMatchObject({contentHash:hash,actions:[]});
  const action=rawAction(manager);const first=await rawAct(created.id,manager,action);expect(first.actions[0]).toMatchObject({actorId:manager.userId,actorPersonId:manager.personId,actorName:'Fictional Manager'});expect(first.actions[0].at).not.toBe('1900-01-01T00:00:00Z');
  expect((await rawAct(created.id,manager,action)).actions).toHaveLength(1);await sign(created.id,employee,'employee');const complete=await sign(created.id,head,'hod');expect(signingComplete(complete,rules)).toBe(true);
  const revisions=await owner.db.execute(sql`select revision from document_signing_revision where document_id=${created.id}::uuid order by revision`);expect(revisions.map(r=>r.revision)).toEqual([1,2,3,4]);
  const events=await owner.db.select().from(S.domainEvent).where(eq(S.domainEvent.aggregateId,created.id));expect(events).toHaveLength(4);for(const event of events){expect(JSON.stringify(event.payload)).not.toContain('Fictional signature');expect(JSON.stringify(event.payload)).not.toContain('data:image');}
 });
 it('denies direct table mutation and cross-tenant document access',async()=>{
  const d=await create();await expect(withTenant(admin,tx=>tx.execute(sql`update document_signing_document set data='{}'::jsonb where id=${d.id}::uuid`))).rejects.toThrow();await expect(withTenant(admin,tx=>tx.execute(sql`delete from document_signing_revision where document_id=${d.id}::uuid`))).rejects.toThrow();
  const foreign={...manager.ctx,tenantId:randomUUID()};await expect(withTenant(foreign,tx=>readSigningDocumentTx(tx,foreign,d.id))).rejects.toThrow();
  expect((await withTenant(manager.ctx,tx=>readSigningDocumentTx(tx,manager.ctx,d.id))).actions).toEqual([]);
 });
 it('rejects missing/null signature method, absent identity and forged person through direct SQL',async()=>{
  const d=await create();for(const signature of [{consent:true,value:'Forged'}, {method:null,consent:true,value:'Forged'},null]){await expect(rawAct(d.id,manager,{...rawAction(manager),signature})).rejects.toThrow();}
  const missing=rawAction(manager);delete missing.id;await expect(rawAct(d.id,manager,missing)).rejects.toThrow();await expect(rawAct(d.id,manager,{...rawAction(manager),actorPersonId:head.personId})).rejects.toThrow();expect((await withTenant(manager.ctx,tx=>readSigningDocumentTx(tx,manager.ctx,d.id))).actions).toEqual([]);
 });
 it('rejects fabricated content at creation and a previously current hash after authoritative content changes',async()=>{
  await expect(create('b'.repeat(64))).rejects.toThrow();const d=await create();await owner.db.execute(sql`update test_document_signing_subject set content=content||${JSON.stringify({contentHash:'b'.repeat(64),contentRevision:2})}::jsonb where id=${subjectId}::uuid`);await expect(rawAct(d.id,manager,rawAction(manager))).rejects.toThrow();expect((await withTenant(manager.ctx,tx=>readSigningDocumentTx(tx,manager.ctx,d.id))).actions).toEqual([]);
 });
 it('rechecks current holder routes at action and permits an audited pending delegation',async()=>{
  const d=await create(),next=structuredClone(route);next.steps[0]={...next.steps[0],holderId:delegate.userId,holderPersonId:delegate.personId,representedId:manager.userId};await updateRoute(next);
  await expect(rawAct(d.id,manager,rawAction(manager))).rejects.toThrow();
  await withTenant(admin,tx=>replaceDocumentSignerTx(tx,admin,{id:d.id,stepId:'lm',holderId:delegate.userId,kind:'delegation',reason:'Manager is on approved leave'}));
  const signed=await sign(d.id,delegate,'lm');expect(signed.actions[0]).toMatchObject({actorId:delegate.userId,actorPersonId:delegate.personId,representedId:manager.userId});
 });
 it('rejects a forged signer person through the SQL store and binds the source employment',async()=>{
  const alternate=await createAppUser(b.tenantId,manager.personId,'employee');
  const forged=structuredClone(route);forged.steps[2]={...forged.steps[2],holderId:alternate,holderPersonId:head.personId};
  const document={tenantId:b.tenantId,companyId:b.companyId,subjectId,subjectType:'probation',contentRevision:1,contentHash:hash,route:forged,actions:[]};await updateRoute(forged);
  const error=await withTenant(admin,tx=>tx.execute(sql`select app.document_signing_store(${randomUUID()}::uuid,${employmentId}::uuid,${b.companyId}::uuid,${subjectId}::uuid,${JSON.stringify(document)}::jsonb,${JSON.stringify(rules)}::jsonb,0,'create','Fixture')`)).catch(error=>error);
  expect(String(error.cause?.message??error.message)).toMatch(/Invalid signer/);
  await updateRoute(route);const [other]=await owner.db.select({id:S.employment.id}).from(S.employment).where(eq(S.employment.personId,manager.personId));
  await expect(create(hash,other.id)).rejects.toThrow();
 });
 it('counts actual people rather than two logins when enforcing independent approvals',async()=>{
  const alternate=await createAppUser(b.tenantId,manager.personId,'employee');route.steps[2]={...route.steps[2],holderId:alternate,holderPersonId:manager.personId};await updateRoute(route);await expect(create()).rejects.toThrow();
 });
 it('cannot confirm an employee refusal using another login for that same employee person',async()=>{
  const d=await create();await sign(d.id,manager,'lm');const alternate=await createAppUser(b.tenantId,employee.personId,'employee');const who={...employee,userId:alternate,ctx:{...employee.ctx,userId:alternate}};
  await owner.db.execute(sql`update test_document_signing_subject set admin_id=${alternate}::uuid,readers=array_append(readers,${alternate}::uuid) where id=${subjectId}::uuid`);
  await expect(rawAct(d.id,who,{...rawAction(who,'employee'),action:'declined',representedId:employee.userId,comment:'Caller claims the employee refused',signature:null})).rejects.toThrow();
 });
});
