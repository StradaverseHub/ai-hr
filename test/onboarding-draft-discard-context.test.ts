/** Real app-role permission, membership-fence and fresh-snapshot proofs. Hosted execution only. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {saveEmployeeDraft} from '../core/employee-draft';
import {onboardingDraftDiscardContextTx} from '../packs/lifecycle/service';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,writer:SessionContext,draftId:string,otherCompany:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle',null);
 const userId=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
 ctx={...adminCtx(b),userId,personId:null,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional hidden-case company',companyLabel:'Hidden'}).returning({id:s.company.id});otherCompany=company.id;
 const writerId=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:otherCompany}).where(eq(s.roleAssignment.appUserId,writerId));writer={...ctx,userId:writerId,grants:[{role:'hr_admin',companyId:otherCompany}]};
 draftId=(await saveEmployeeDraft(ctx,{data:{profile:{fullName:'PRIVATE fictional draft'},employment:{companyId:b.companyId}},currentStep:1})).id;
});
const subject=()=>({draftId,companyId:b.companyId});
const run=(who:SessionContext=ctx)=>withTenant(who,async tx=>{await lockAccessConfigurationTx(tx,who.tenantId);return onboardingDraftDiscardContextTx(who,tx,subject(),{tryOnly:true});});
const linked=(tx:Tx,state='pending',source=draftId)=>tx.execute(sql`insert into lc_onboarding_case(tenant_id,company_id,source_draft_id,data) values(${b.tenantId}::uuid,${otherCompany}::uuid,${source}::uuid,${JSON.stringify({version:1,state,source:{fullName:'PRIVATE hidden case'},tasks:[],requisitions:[]})}::jsonb)`);
async function denied(work:Promise<unknown>){let error:unknown;try{await work;}catch(cause){error=cause;}expect(pgSqlState(error)).toBe('42501');expect(String(error)).not.toContain('PRIVATE');return error;}
async function tryKeys(){const [r]=await owner.db.execute<{access:boolean;audit:boolean;onboarding:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0)) access,pg_try_advisory_xact_lock(hashtext(${'audit-chain:'+b.tenantId})) audit,pg_try_advisory_xact_lock(hashtextextended(${b.tenantId+':onboarding'},0)) onboarding`);return r;}
it('admits a genuine unlinked HR USER and returns only absence even with lifecycle OFF and no configuration',async()=>{
 expect(ctx.personId).toBeNull();expect(await owner.db.select().from(s.lcOnboardingConfig)).toHaveLength(0);expect(await run()).toEqual({noLinkedCase:true});
 await setModule(b.tenantId,'lifecycle','active');await owner.db.insert(s.lcOnboardingConfig).values({tenantId:b.tenantId,revision:0,data:{} as never});expect(await run()).toEqual({noLinkedCase:true});
});
it.each(['pending','cancelled','completed'])('refuses ANY hidden linked %s case even with module OFF/config0',async state=>{
 await owner.db.insert(s.lcOnboardingConfig).values({tenantId:b.tenantId,revision:0,data:{} as never});await withTenant(writer,tx=>linked(tx,state));
 expect(await withTenant(ctx,tx=>tx.select({id:s.lcOnboardingCase.id}).from(s.lcOnboardingCase))).toEqual([]);await denied(run());expect(await tryKeys()).toEqual({access:true,audit:true,onboarding:true});
});
it('holds actual Access/audit/onboarding, case-membership and draft locks through COMMIT then releases them',async()=>{
 await withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);expect(await onboardingDraftDiscardContextTx(ctx,tx,subject(),{tryOnly:true})).toEqual({noLinkedCase:true});expect(await tryKeys()).toEqual({access:false,audit:false,onboarding:false});
  let tableError:unknown;try{await owner.db.transaction(other=>other.execute(sql`lock table lc_onboarding_case in row exclusive mode nowait`));}catch(e){tableError=e;}expect(pgSqlState(tableError)).toBe('55P03');
  let draftError:unknown;try{await owner.db.transaction(other=>other.select({id:s.employeeDraft.id}).from(s.employeeDraft).where(eq(s.employeeDraft.id,draftId)).for('update',{noWait:true}));}catch(e){draftError=e;}expect(pgSqlState(draftError)).toBe('55P03');
 });expect(await tryKeys()).toEqual({access:true,audit:true,onboarding:true});await withTenant(writer,tx=>linked(tx));await denied(run());
});
it.each(['audit','onboarding','case_table','draft_row'] as const)('fails fast on %s contention and rolls back every acquired lock',async lock=>{
 await owner.db.transaction(async held=>{
  if(lock==='audit')await held.execute(sql`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+b.tenantId}))`);
  else if(lock==='onboarding')await held.execute(sql`select pg_advisory_xact_lock(hashtextextended(${b.tenantId+':onboarding'},0))`);
  else if(lock==='case_table')await held.execute(sql`lock table lc_onboarding_case in row exclusive mode nowait`);
  else await held.select({id:s.employeeDraft.id}).from(s.employeeDraft).where(eq(s.employeeDraft.id,draftId)).for('update');
  await denied(run());const keys=await tryKeys();expect(keys.access).toBe(true);if(lock!=='audit')expect(keys.audit).toBe(true);if(lock!=='onboarding')expect(keys.onboarding).toBe(true);
 });expect(await run()).toEqual({noLinkedCase:true});
});
it('refuses direct app-role entry when Access is held elsewhere',async()=>{await owner.db.transaction(async held=>{await held.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`);await denied(withTenant(ctx,tx=>onboardingDraftDiscardContextTx(ctx,tx,subject(),{tryOnly:true})));});expect(await run()).toEqual({noLinkedCase:true});});
it.each(['roles','person_link','archived'] as const)('refuses stale actual %s without a body projection',async change=>{
 expect(await run()).toEqual({noLinkedCase:true});if(change==='roles')await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,ctx.userId!));
 else if(change==='archived')await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,ctx.userId!));
 else{const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'New fictional link',primaryEmail:randomUUID()+'@fixture.invalid'}).returning({id:s.person.id});await owner.db.update(s.appUser).set({personId:person.id}).where(eq(s.appUser.id,ctx.userId!));}
 await denied(run());
});
it.each(['workforce.view','workforce.maintain'] as const)('preserves the restrictive native %s denial',async capabilityId=>{
 await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"discard-context-fixture","operation":"read-write"}]'::jsonb where id in ('workforce.view','workforce.maintain')`);
 const root=adminCtx(b),before=await withTenant(root,tx=>accessConfigurationStore.loadCurrent(tx,root));const edit={expectedRevision:before.snapshot.revision,command:{kind:'setOverride' as const,userId:ctx.userId!,capabilityId,companyId:b.companyId,effect:'deny' as const}};
 const preview=await previewAccessConfiguration(root,edit,accessConfigurationStore);await saveAccessConfiguration(root,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);await denied(run());
});
it('refuses missing/foreign company, SYSTEM, non-admin and foreign-tenant nominations',async()=>{
 await denied(run(writer));await denied(run({...ctx,userId:undefined}));const employeeId=await createAppUser(b.tenantId,null,'employee');await denied(run({...ctx,userId:employeeId,roles:['employee'],grants:[{role:'employee',companyId:null}]}));
 await denied(withTenant(ctx,tx=>onboardingDraftDiscardContextTx(ctx,tx,{draftId:randomUUID(),companyId:b.companyId},{tryOnly:true})));await denied(withTenant(ctx,tx=>onboardingDraftDiscardContextTx(ctx,tx,{draftId,companyId:otherCompany},{tryOnly:true})));
 const other=await seedBase();await denied(run(adminCtx(other)));
});
it('is a volatile narrow app EXECUTE projection with no PUBLIC grant',async()=>{
 const [r]=await owner.db.execute<{volatility:string;security:boolean;publicExecute:boolean;appExecute:boolean}>(sql`select p.provolatile as volatility,p.prosecdef as security,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as "publicExecute",has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as "appExecute" from pg_proc p where p.oid='app.onboarding_draft_discard_absence_context(uuid,uuid,uuid)'::regprocedure`);expect(r).toEqual({volatility:'v',security:true,publicExecute:false,appExecute:true});
});
it('uses a fresh post-fence snapshot when a raw app writer COMMITs after initial statement admission',async()=>{
 const gate='test-only-discard-statement:'+randomUUID();let entered!:(pid:number)=>void;const admission=new Promise<number>(resolve=>{entered=resolve;});let outcome:Promise<{ok:boolean;error?:unknown}>|undefined;
 await owner.db.transaction(async held=>{
  await held.execute(sql`select pg_advisory_xact_lock(hashtextextended(${gate},0))`);
  outcome=withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);entered(row.pid);return tx.execute(sql`with gate as materialized(select pg_advisory_xact_lock(hashtextextended(${gate},0))) select app.onboarding_draft_discard_absence_context(${draftId}::uuid,${b.companyId}::uuid,null::uuid) as absent from gate`);}).then(()=>({ok:true}),error=>({ok:false,error}));
  const pid=await admission,deadline=Date.now()+10000;for(;;){const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks where pid=${pid} and locktype='advisory' and not granted) waiting`);if(row.waiting)break;if(Date.now()>deadline)throw Error('statement admission interleaving not reached');await new Promise(resolve=>setTimeout(resolve,20));}
  // Outer SELECT snapshot already exists; this writer bypasses native advisory locks using real app DML.
  await withTenant(writer,tx=>linked(tx));
 });const result=await outcome!;expect(result.ok).toBe(false);expect(pgSqlState(result.error)).toBe('42501');expect(await withTenant(ctx,tx=>tx.select({id:s.lcOnboardingCase.id}).from(s.lcOnboardingCase))).toEqual([]);await denied(run());
});
it('keeps the draft and releases all fences when the enclosing command rolls back',async()=>{
 await expect(withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);await onboardingDraftDiscardContextTx(ctx,tx,subject(),{tryOnly:true});await tx.delete(s.employeeDraft).where(eq(s.employeeDraft.id,draftId));throw Error('outer refusal');})).rejects.toThrow('outer refusal');expect(await owner.db.select({id:s.employeeDraft.id}).from(s.employeeDraft).where(eq(s.employeeDraft.id,draftId))).toHaveLength(1);expect(await tryKeys()).toEqual({access:true,audit:true,onboarding:true});
});
it('preserves the actual native author course for a linked HR USER without inventing a company-admin-only floor',async()=>{
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional draft author',primaryEmail:randomUUID()+'@fixture.invalid'}).returning({id:s.person.id});await owner.db.update(s.appUser).set({personId:person.id}).where(eq(s.appUser.id,ctx.userId!));await owner.db.update(s.roleAssignment).set({companyId:otherCompany}).where(eq(s.roleAssignment.appUserId,ctx.userId!));await owner.db.update(s.employeeDraft).set({createdByPersonId:person.id}).where(eq(s.employeeDraft.id,draftId));const author={...ctx,personId:person.id,grants:[{role:'hr_admin',companyId:otherCompany}]};
 const [scope]=await withTenant(author,tx=>tx.execute<{admin:boolean;author:boolean}>(sql`select app.is_admin_for(${b.companyId}::uuid) admin,app.is_self_person(${person.id}::uuid) author`));expect(scope).toEqual({admin:false,author:true});expect(await run(author)).toEqual({noLinkedCase:true});
 const employeeId=await createAppUser(b.tenantId,person.id,'employee');await denied(run({...author,userId:employeeId,roles:['employee'],grants:[{role:'employee',companyId:null}]}));
});
it.each(['insert','update'] as const)('fences actual raw app %s source-link DML through COMMIT then permits retry',async operation=>{
 const unrelated=randomUUID();if(operation==='update')await withTenant(writer,tx=>linked(tx,'pending',unrelated));
 const mutate=async(tx:Tx):Promise<void>=>{if(operation==='insert')await linked(tx);else await tx.update(s.lcOnboardingCase).set({sourceDraftId:draftId}).where(and(eq(s.lcOnboardingCase.tenantId,b.tenantId),eq(s.lcOnboardingCase.sourceDraftId,unrelated)));};
 await withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);expect(await onboardingDraftDiscardContextTx(ctx,tx,subject(),{tryOnly:true})).toEqual({noLinkedCase:true});let error:unknown;try{await withTenant(writer,async other=>{await other.execute(sql`set local lock_timeout='100ms'`);await mutate(other);});}catch(e){error=e;}expect(pgSqlState(error)).toBe('55P03');});
 await withTenant(writer,mutate);await denied(run());
});
