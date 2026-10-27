/** Actual application-role stored-exchange regressions, authored UNRUN. No model/provider mocks,
 * schema shortcuts or read receipt bypass: v2 proof is created by the real sealing owner.
 */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {ownAssistantClarification,canClarifyAssistantQuestion,ASSISTANT_CONVERSATION_LIMITS,type OwnAssistantClarification} from '../core/assistant-clarification';
import {sealAssistantDisclosure,assistantSourceDigest,type AssistantDisclosureBinding} from '../lib/ai/assistant-disclosure';
import type {AssistantAnswerPlan} from '../lib/ai/assistant-answer-plan';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-clarification-receipt-key');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');});
const terminal='UNTRUSTED_TERMINAL_MODEL_SALARY_987654';
const sourcePrivate='NEVER_REUSE_SOURCE_PERSON_BANK_876543';
async function actor(base:Base=b){
 const admin=adminCtx(base),employee=await hireEmployee(admin,{person:{fullName:'Fictional clarification actor',primaryEmail:randomUUID()+'@fixture.test'},
  companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,employee.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {ctx,admin,userId};
}
async function exchange(ctx:SessionContext,plan:AssistantAnswerPlan|undefined={version:1,mode:'clarify',slot:'period'},question='Which period does my leave question cover?'){
 const binding:AssistantDisclosureBinding={tenantId:ctx.tenantId,userId:ctx.userId!,exchangeId:randomUUID(),question,answer:terminal};
 const reads=[{name:'employee_profile',input:{},digest:assistantSourceDigest({ok:true,sourcePrivate})}];
 const receipt=sealAssistantDisclosure(binding,reads,plan);expect(receipt).toBeTruthy();
 await owner.db.insert(s.assistantExchange).values({id:binding.exchangeId,tenantId:ctx.tenantId,appUserId:ctx.userId!,question,answer:terminal,disclosureReceipt:receipt,stop:'end'});
 return {binding,receipt:receipt!};
}
const state=async()=>({exchanges:await owner.db.select().from(s.assistantExchange).orderBy(s.assistantExchange.id),
 events:await owner.db.select({id:s.domainEvent.id}).from(s.domainEvent).orderBy(s.domainEvent.id),runs:await owner.db.select().from(s.aiModelRun).orderBy(s.aiModelRun.id)});
const refused=(ctx:SessionContext,id:unknown,response:unknown='This calendar year')=>expect(ownAssistantClarification(ctx,id,response)).rejects.toThrow(/^Current clarification unavailable\.$/);
describe('actual caller-bound Assistant clarification continuation',()=>{
 it.each(['employment','leave_type','period','module'] as const)('continues the authenticated %s slot using only original human question and new human answer',async slot=>{
  const {ctx}=await actor(),stored=await exchange(ctx,{version:1,mode:'clarify',slot}),before=await state();
  const [identity]=await withTenant(ctx,tx=>tx.execute<{role:string;user_id:string}>(sql`select current_user as role,app.current_user_id() as user_id`));
  expect(identity).toEqual({role:'ai_hr_app',user_id:ctx.userId});
  const answer=await ownAssistantClarification(ctx,stored.binding.exchangeId,'  My own current record  ');
  expect(answer).toEqual({originalQuestion:stored.binding.question,slot,answer:'My own current record'});expect(Object.isFrozen(answer)).toBe(true);
  expect(Object.keys(answer).sort()).toEqual(['answer','originalQuestion','slot']);
  expect(JSON.stringify(answer)).not.toContain(terminal);expect(JSON.stringify(answer)).not.toContain(sourcePrivate);expect(JSON.stringify(answer)).not.toContain(stored.receipt);
  expect(await state()).toEqual(before);
 });
 it('exercises actual app-role own-row RLS and uniformly refuses another user, tenant and missing exchange',async()=>{
  const mine=await actor(),other=await actor(),foreignBase=await seedBase();await setModule(foreignBase.tenantId,'assistant','active');
  const foreign=await actor(foreignBase),owned=await exchange(mine.ctx),foreignStored=await exchange(foreign.ctx),before=await state();
  const visible=await withTenant(other.ctx,tx=>tx.select({id:s.assistantExchange.id}).from(s.assistantExchange).where(eq(s.assistantExchange.id,owned.binding.exchangeId)));
  expect(visible).toEqual([]);
  const cross=await withTenant(mine.ctx,tx=>tx.select({id:s.assistantExchange.id}).from(s.assistantExchange).where(eq(s.assistantExchange.id,foreignStored.binding.exchangeId)));
  expect(cross).toEqual([]);
  await refused(other.ctx,owned.binding.exchangeId);await refused(mine.ctx,foreignStored.binding.exchangeId);await refused(mine.ctx,randomUUID());
  expect(await state()).toEqual(before);
 });
 it('rechecks actual Assistant grant even when a caller retains its valid sealed own history',async()=>{
  const {ctx,admin,userId}=await actor(),stored=await exchange(ctx);
  expect(await ownAssistantClarification(ctx,stored.binding.exchangeId,'2026')).toMatchObject({answer:'2026'});
  await revokeAssistant(admin,{appUserId:userId});const before=await state();
  await refused(ctx,stored.binding.exchangeId);expect(await state()).toEqual(before);
 });
 it('refuses legacy, nonclarify, corrupt and swapped authenticated receipts without upgrading terminal prose',async()=>{
  const {ctx}=await actor();
  const legacy=await exchange(ctx,undefined),nonclarify=await exchange(ctx,{version:1,mode:'insufficient',code:'no_verified_facts'}),corrupt=await exchange(ctx),swapped=await exchange(ctx),donor=await exchange(ctx);
  // Explicit undefined uses the JS default parameter; install a real legacy v1 proof separately.
  const legacyProof=sealAssistantDisclosure(legacy.binding,[]);expect(legacyProof).toBeTruthy();
  await owner.db.update(s.assistantExchange).set({disclosureReceipt:legacyProof}).where(eq(s.assistantExchange.id,legacy.binding.exchangeId));
  await owner.db.update(s.assistantExchange).set({disclosureReceipt:corrupt.receipt+'!'}).where(eq(s.assistantExchange.id,corrupt.binding.exchangeId));
  await owner.db.update(s.assistantExchange).set({disclosureReceipt:donor.receipt}).where(eq(s.assistantExchange.id,swapped.binding.exchangeId));
  const before=await state();for(const row of [legacy,nonclarify,corrupt,swapped])await refused(ctx,row.binding.exchangeId);
  expect(await state()).toEqual(before);
 });
 it('accepts a full original 2000-character human question and 500-character clarification without serialization overhead or truncation',async()=>{
  const {ctx}=await actor(),question='q'.repeat(2000),answer='x'.repeat(500),stored=await exchange(ctx,undefined,question),before=await state();
  const result=await ownAssistantClarification(ctx,stored.binding.exchangeId,answer);
  expect(result).toEqual({originalQuestion:question,slot:'period',answer});expect(Object.isFrozen(result)).toBe(true);
  expect(await state()).toEqual(before);
 });
 it('enforces exact 8000-character human history and 500-character response bounds without truncation',async()=>{
  const {ctx}=await actor(),answer='x'.repeat(ASSISTANT_CONVERSATION_LIMITS.humanAnswer),length=ASSISTANT_CONVERSATION_LIMITS.history-2-answer.length;
  const stored=await exchange(ctx,undefined,'q'.repeat(length)),tooLong=await exchange(ctx,undefined,'q'.repeat(length+1));
  const before=await state(),exact=await ownAssistantClarification(ctx,stored.binding.exchangeId,answer);
  expect(exact).toEqual({originalQuestion:stored.binding.question,slot:'period',answer});
  expect((exact.originalQuestion+'\n\n'+exact.answer).length).toBe(8000);
  expect(canClarifyAssistantQuestion(stored.binding.question)).toBe(true);expect(canClarifyAssistantQuestion(tooLong.binding.question)).toBe(false);
  expect(canClarifyAssistantQuestion('q'.repeat(2000))).toBe(true);expect(canClarifyAssistantQuestion('q'.repeat(8000))).toBe(false);
  expect(Object.isFrozen(ASSISTANT_CONVERSATION_LIMITS)).toBe(true);
  for(const malformed of [null,undefined,{},[],42])expect(canClarifyAssistantQuestion(malformed)).toBe(false);
  await refused(ctx,tooLong.binding.exchangeId,answer);await refused(ctx,stored.binding.exchangeId,'x'.repeat(501));
  await refused(ctx,stored.binding.exchangeId,'  ');await refused(ctx,stored.binding.exchangeId,null);await refused(ctx,'not-an-id');
  let invoked=false;await refused(ctx,stored.binding.exchangeId,{toString(){invoked=true;return '2026';}});expect(invoked).toBe(false);expect(await state()).toEqual(before);
 });
 it('captures original caller context and scalar answer before an actual Access wait without retargeting',async()=>{
  const {ctx,admin}=await actor(),stored=await exchange(ctx),before=await state();
  let ready!:()=>void,release!:()=>void,fail!:(e:unknown)=>void;
  const started=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
  const watchdog=setTimeout(()=>{fail(Error('owned clarification handshake timed out'));release();},10000);
  const holder=withTenant(admin,async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);ready();await finish;});void holder.catch(fail);
  let pending:Promise<OwnAssistantClarification>|undefined,error:unknown;let result:OwnAssistantClarification|undefined;
  try{await started;const supplied={...ctx,roles:ctx.roles!.slice(),grants:ctx.grants!.map(g=>({...g}))};let scalar='My original human answer';
   pending=ownAssistantClarification(supplied,stored.binding.exchangeId,scalar);void pending.catch(e=>{error=e;});
   const deadline=Date.now()+4000;let waiting=false;
   while(Date.now()<deadline){if(error)throw error;const [r]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks l where l.locktype='advisory' and not l.granted and l.objsubid=1
    and l.database=(select oid from pg_database where datname=current_database()) and ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended(${'access-configuration:'+b.tenantId},0)) as waiting`);
    if(r?.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
   expect(waiting,'actual authority wait must be observed before caller mutation').toBe(true);
   supplied.userId=randomUUID();supplied.personId=randomUUID();supplied.roles!.splice(0,1,'super_admin');supplied.grants![0].role='super_admin';scalar='Retargeted';
  }finally{release();clearTimeout(watchdog);await holder;if(pending)result=await pending;}
  expect(result).toEqual({originalQuestion:stored.binding.question,slot:'period',answer:'My original human answer'});expect(Object.isFrozen(result)).toBe(true);expect(await state()).toEqual(before);
 });
});
