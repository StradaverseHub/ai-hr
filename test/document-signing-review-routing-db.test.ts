import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {createSigningDocumentTx,readSigningDocumentTx,recordDocumentSigningActionTx,resendSigningDocumentTx,reviseSigningDocumentTx,signingContentVisibleTx,type SigningDocument,type SigningRoute} from '../packs/document-signing/service';
import {pendingSigningSteps,signingStepFulfilled} from '../lib/document-signing-model';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

/**
 * Migration 5747 (lib/document-signing-model.ts): Review steps, parallel stages, the owner, send back clearing every
 * completed step, the owner's re-send, the edit lock after the first signature and content visibility, enforced by the
 * SQL functions independently of the TypeScript model. The Probation subject hooks are replaced by a fictional test
 * subject for the duration of this file, as in test/document-signing-persistence.test.ts.
 */
const hash='a'.repeat(64),rules={requiredRoles:[] as string[]};
const hooks=['probation_signing_access','probation_signing_guardrails','probation_signing_route_allowed','probation_signing_content','probation_signing_action_allowed'];
const originalHooks:{name:string;definition:string}[]=[];
type Actor={userId:string;personId:string;ctx:SessionContext};
let b:Base,admin:SessionContext,subjectId:string,employmentId:string,reviewer:Actor,signerA:Actor,signerB:Actor,outsider:Actor,route:SigningRoute;
beforeAll(async()=>{
 await migrateTestDb();
 originalHooks.push(...await owner.db.execute<{name:string;definition:string}>(sql`select p.proname as name,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname in ('probation_signing_access','probation_signing_guardrails','probation_signing_route_allowed','probation_signing_content','probation_signing_action_allowed')`));
 await owner.db.execute(sql.raw(`create table public.test_routed_signing_subject(id uuid primary key,tenant_id uuid not null references public.tenant(id),admin_id uuid not null,readers uuid[] not null,route jsonb not null,rules jsonb not null,content jsonb not null);`));
 await owner.db.execute(sql.raw(`
 create or replace function app.probation_signing_access(p_subject uuid,p_operation text) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select exists(select 1 from public.test_routed_signing_subject s where s.id=$1 and s.tenant_id=app.current_tenant_id() and (case when $2='create' then s.admin_id=app.current_user_id() else app.current_user_id()=any(s.readers) end)); $$;
 create or replace function app.probation_signing_guardrails(p_subject uuid) returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select rules from public.test_routed_signing_subject where id=$1 and tenant_id=app.current_tenant_id(); $$;
 create or replace function app.probation_signing_route_allowed(p_subject uuid,p_route jsonb) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select coalesce((select route=$2 from public.test_routed_signing_subject where id=$1 and tenant_id=app.current_tenant_id()),false); $$;
 create or replace function app.probation_signing_action_allowed(p_subject uuid,p_action jsonb) returns boolean language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select exists(select 1 from public.test_routed_signing_subject s where s.id=$1 and s.tenant_id=app.current_tenant_id() and app.current_user_id()=any(s.readers)); $$;
 create or replace function app.probation_signing_content(p_subject uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
 declare value jsonb;begin select content into value from public.test_routed_signing_subject where id=$1 and tenant_id=app.current_tenant_id() for update;return value;end; $$;`));
});
afterAll(async()=>{
 for(const name of hooks.filter(name=>!originalHooks.some(old=>old.name===name))){const args=name==='probation_signing_access'?'uuid,text':['probation_signing_route_allowed','probation_signing_action_allowed'].includes(name)?'uuid,jsonb':'uuid';await owner.db.execute(sql.raw(`drop function if exists app.${name}(${args});`));}
 for(const old of originalHooks)await owner.db.execute(sql.raw(old.definition));
 await owner.db.execute(sql.raw('drop table if exists public.test_routed_signing_subject;'));await closeAll();
});
async function actor(name:string):Promise<Actor&{employmentId:string}>{const e=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@routing.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});const userId=await createAppUser(b.tenantId,e.personId,'employee');return{userId,personId:e.personId,employmentId:e.employmentId,ctx:{...admin,userId,roles:['employee'],grants:undefined}};}
const routing=()=>({templateId:'letter-template',templateVersion:3,caseOwnerId:admin.userId!,fallbackGroupId:null});
async function create(withRouting=true){return withTenant(admin,tx=>createSigningDocumentTx(tx,admin,{companyId:b.companyId,employmentId,subjectId,subjectType:'probation',contentHash:hash,route,guardrails:rules,...(withRouting?{routing:routing()}:{})}));}
const act=(id:string,who:Actor,stepId:string,action:'signed'|'returned'|'reviewed'|'approved',comment?:string)=>withTenant(who.ctx,tx=>{const doc=readSigningDocumentTx(tx,who.ctx,id);return doc.then(d=>recordDocumentSigningActionTx(tx,who.ctx,{id,stepId,revision:d.contentRevision,hash:d.contentHash,action,comment,...(action==='signed'?{method:'typed' as const,value:'Fictional signature',consent:true}:{})}));});
async function rawAct(id:string,who:Actor,action:Record<string,unknown>){return withTenant(who.ctx,async tx=>(await tx.execute<{document:SigningDocument}>(sql`select app.document_signing_act(${id}::uuid,${JSON.stringify(action)}::jsonb) as document`))[0].document);}
const raw=(who:Actor,stepId:string,role:string,action:string,extra:Record<string,unknown>={})=>({id:randomUUID(),stepId,contentRevision:1,contentHash:hash,actorId:who.userId,actorPersonId:who.personId,actorName:'Caller name',representedId:who.userId,role,at:'2026-11-16T00:00:00Z',action,comment:'',signature:null,...extra});
const visible=(id:string,who:Actor|SessionContext,released=false)=>{const ctx='ctx' in who?who.ctx:who;return withTenant(ctx,tx=>signingContentVisibleTx(tx,id,released));};
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin=adminCtx(b);
 reviewer=await actor('Fictional Reviewer');const a=await actor('Fictional Signer A');signerA=a;signerB=await actor('Fictional Signer B');outsider=await actor('Fictional Outsider');employmentId=a.employmentId;subjectId=randomUUID();
 route={version:1,steps:[
  {id:'review',role:'group:gbs',kind:'review',stage:1,holderId:reviewer.userId,holderPersonId:reviewer.personId,required:true},
  {id:'sign-a',role:'routing:bp',kind:'sign',stage:2,holderId:signerA.userId,holderPersonId:signerA.personId,required:true},
  {id:'sign-b',role:'employee',kind:'sign',stage:2,holderId:signerB.userId,holderPersonId:signerB.personId,required:true},
 ]};
 await owner.db.execute(sql`insert into test_routed_signing_subject(id,tenant_id,admin_id,readers,route,rules,content) values(${subjectId}::uuid,${b.tenantId}::uuid,${admin.userId}::uuid,array[${sql.join([admin.userId!,reviewer.userId,signerA.userId,signerB.userId,outsider.userId].map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],${JSON.stringify(route)}::jsonb,${JSON.stringify(rules)}::jsonb,${JSON.stringify({contentHash:hash,contentRevision:1,companyId:b.companyId,employmentId})}::jsonb)`);
});

describe('template-routing signing documents in the database',()=>{
 it('records a Review without a signature, then both Sign steps of a stage in parallel',async()=>{
  const d=await create();
  expect(d.document.routing).toMatchObject({templateId:'letter-template',templateVersion:3,caseOwnerId:admin.userId});
  await expect(act(d.id,signerA,'sign-a','signed')).rejects.toThrow();
  await expect(rawAct(d.id,reviewer,raw(reviewer,'review','group:gbs','signed',{signature:{method:'typed',value:'Not for reviews',consent:true}}))).rejects.toThrow();
  const reviewed=await act(d.id,reviewer,'review','reviewed');
  expect(reviewed.actions.at(-1)).toMatchObject({action:'reviewed',signature:null,actorName:'Fictional Reviewer'});
  expect(pendingSigningSteps(reviewed).map(s=>s.id)).toEqual(['sign-a','sign-b']);
  const signedB=await act(d.id,signerB,'sign-b','signed');expect(pendingSigningSteps(signedB).map(s=>s.id)).toEqual(['sign-a']);
  const done=await act(d.id,signerA,'sign-a','signed');expect(pendingSigningSteps(done)).toEqual([]);
  const events=await owner.db.execute<{event_type:string}>(sql`select event_type from domain_event where aggregate_id=${d.id}::uuid order by sequence`);
  expect(events.map(e=>e.event_type)).toEqual(['document-signing.created','document-signing.reviewed','document-signing.signed','document-signing.signed']);
 });
 it('sends back from any step, clears every signature of the round and lets only the owner send it round again',async()=>{
  const d=await create();await act(d.id,reviewer,'review','reviewed');await act(d.id,signerA,'sign-a','signed');
  await expect(act(d.id,signerB,'sign-b','returned','  ')).rejects.toThrow();
  const returned=await act(d.id,signerB,'sign-b','returned','Wrong extension length');
  expect(pendingSigningSteps(returned)).toEqual([]);
  await expect(act(d.id,signerA,'sign-a','signed')).rejects.toThrow();
  // The owner is the first Review step's holder; nobody else may re-send, and the database refuses a forged re-send.
  await expect(withTenant(signerA.ctx,tx=>resendSigningDocumentTx(tx,signerA.ctx,{id:d.id}))).rejects.toThrow();
  await expect(rawAct(d.id,signerA,raw(signerA,'review','owner','resent'))).rejects.toThrow();
  const resent=await withTenant(reviewer.ctx,tx=>resendSigningDocumentTx(tx,reviewer.ctx,{id:d.id,comment:'Corrected and sent again'}));
  expect(pendingSigningSteps(resent).map(s=>s.id)).toEqual(['review']);
  expect(signingStepFulfilled(resent,resent.route.steps[1])).toBe(false);
  expect(resent.actions.map(a=>a.action)).toEqual(['reviewed','signed','returned','resent']);
  const[sqlPending]=await owner.db.execute<{ids:string[]}>(sql`select array_agg(s->>'id') ids from document_signing_document d,app.document_signing_pending_steps(d.data) s where d.id=${d.id}::uuid`);
  expect(sqlPending.ids).toEqual(['review']);
 });
 it('lets the Review step edit until the first signature and locks the content for everyone after it',async()=>{
  const d=await create(),next='b'.repeat(64);
  await owner.db.execute(sql`update test_routed_signing_subject set content=content||${JSON.stringify({contentHash:next,contentRevision:2})}::jsonb where id=${subjectId}::uuid`);
  await expect(withTenant(signerA.ctx,tx=>reviseSigningDocumentTx(tx,signerA.ctx,{id:d.id,hash:next,reason:'Signer edits'}))).rejects.toThrow();
  const revised=await withTenant(reviewer.ctx,tx=>reviseSigningDocumentTx(tx,reviewer.ctx,{id:d.id,hash:next,reason:'Reviewer corrects the date'}));
  expect(revised.contentRevision).toBe(2);
  await act(d.id,reviewer,'review','reviewed');await act(d.id,signerA,'sign-a','signed');
  const third='c'.repeat(64);
  await owner.db.execute(sql`update test_routed_signing_subject set content=content||${JSON.stringify({contentHash:third,contentRevision:3})}::jsonb where id=${subjectId}::uuid`);
  // The SQL store refuses even when the TypeScript check is bypassed.
  const stored=await withTenant(reviewer.ctx,tx=>readSigningDocumentTx(tx,reviewer.ctx,d.id));
  const[row]=await owner.db.execute<{revision:number}>(sql`select revision from document_signing_document where id=${d.id}::uuid`);
  await expect(withTenant(reviewer.ctx,tx=>tx.execute(sql`select app.document_signing_store(${d.id}::uuid,${employmentId}::uuid,${b.companyId}::uuid,${subjectId}::uuid,${JSON.stringify({...stored,contentRevision:3,contentHash:third})}::jsonb,${JSON.stringify(rules)}::jsonb,${row.revision},'revise','Edit after a signature')`))).rejects.toThrow();
  await expect(withTenant(reviewer.ctx,tx=>reviseSigningDocumentTx(tx,reviewer.ctx,{id:d.id,hash:third,reason:'Owner edits after a signature'}))).rejects.toThrow();
 });
 it('shows the content only to the owner, the person whose turn it is, people who acted, and everyone after release',async()=>{
  const d=await create();
  // The first Review step owns the document; the case owner is only the last fallback.
  expect(await visible(d.id,reviewer)).toBe(true);
  expect(await visible(d.id,admin)).toBe(false);
  expect(await visible(d.id,signerA)).toBe(false);
  expect(await visible(d.id,outsider)).toBe(false);
  expect(await visible(d.id,outsider,true)).toBe(true);
  await act(d.id,reviewer,'review','reviewed');
  expect(await visible(d.id,signerA)).toBe(true);
  expect(await visible(d.id,reviewer)).toBe(true);
  expect(await visible(d.id,outsider)).toBe(false);
  const foreign={...outsider.ctx,tenantId:randomUUID()};expect(await withTenant(foreign,tx=>signingContentVisibleTx(tx,d.id,true))).toBe(false);
 });
 it('keeps documents without template routing exactly as before',async()=>{
  route={version:1,steps:[{id:'lm',role:'lm',kind:'sign',stage:0,holderId:signerA.userId,holderPersonId:signerA.personId,required:true},{id:'hod',role:'hod',kind:'approve',stage:1,holderId:signerB.userId,holderPersonId:signerB.personId,required:true}]};
  await owner.db.execute(sql`update test_routed_signing_subject set route=${JSON.stringify(route)}::jsonb where id=${subjectId}::uuid`);
  const d=await create(false);expect(d.document.routing).toBeUndefined();
  expect(await visible(d.id,outsider)).toBe(true);
  await act(d.id,signerA,'lm','signed');
  await expect(rawAct(d.id,signerB,raw(signerB,'hod','hod','approved'))).rejects.toThrow();
  await expect(withTenant(admin,tx=>resendSigningDocumentTx(tx,admin,{id:d.id}))).rejects.toThrow();
  const approved=await act(d.id,signerB,'hod','signed');expect(pendingSigningSteps(approved)).toEqual([]);
 });
 it('refuses a second owner',async()=>{
  const twoOwners={...route,steps:route.steps.map(s=>({...s,owner:true}))};
  await owner.db.execute(sql`update test_routed_signing_subject set route=${JSON.stringify(twoOwners)}::jsonb where id=${subjectId}::uuid`);
  route=twoOwners;await expect(create()).rejects.toThrow();
 });
});
