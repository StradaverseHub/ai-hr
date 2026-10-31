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
import {ownAssistantClarification,assertOwnAssistantClarificationCurrentTx,canClarifyAssistantQuestion,ASSISTANT_CONVERSATION_LIMITS,AssistantClarificationError,type OwnAssistantClarification} from '../core/assistant-clarification';
import * as clarificationOwner from '../core/assistant-clarification';
import {askAssistant} from '../core/assistant';
import {assistantConversationScopeDigest,assistantConversationContextFromClarification} from '../core/assistant-conversation-context';
import {eraseOwnAssistantHistory} from '../core/assistant-history-retention';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {sealAssistantDisclosure,assistantSourceDigest,type AssistantDisclosureBinding} from '../lib/ai/assistant-disclosure';
import type {AssistantAnswerPlan} from '../lib/ai/assistant-answer-plan';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
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
 return {ctx,admin,userId,employmentId:employee.employmentId};
}
async function exchange(ctx:SessionContext,plan:AssistantAnswerPlan|undefined={version:1,mode:'clarify',slot:'period'},question='Which period does my leave question cover?',askedAt?:Date){
 const binding:AssistantDisclosureBinding={tenantId:ctx.tenantId,userId:ctx.userId!,exchangeId:randomUUID(),question,answer:terminal};
 const reads=[{name:'employee_profile',input:{},digest:assistantSourceDigest({ok:true,sourcePrivate})}];
 const receipt=sealAssistantDisclosure(binding,reads,plan);expect(receipt).toBeTruthy();
 await owner.db.insert(s.assistantExchange).values({id:binding.exchangeId,tenantId:ctx.tenantId,appUserId:ctx.userId!,question,answer:terminal,disclosureReceipt:receipt,stop:'end',...(askedAt?{askedAt}:{})});
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
  expect(answer).toEqual({originalQuestion:stored.binding.question,slot,answer:'My own current record',earlier:[]});expect(Object.isFrozen(answer)).toBe(true);
  expect(Object.keys(answer).sort()).toEqual(['answer','earlier','originalQuestion','slot']);
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
 it('refuses an expired 30-day conversation before delayed cleanup without deleting its accounting row',async()=>{
  const {ctx}=await actor(),stored=await exchange(ctx,undefined,undefined,new Date(Date.now()-31*24*60*60*1000)),before=await state();
  await refused(ctx,stored.binding.exchangeId);expect(await state()).toEqual(before);
  expect(before.exchanges.find(row=>row.id===stored.binding.exchangeId)?.question).toBe(stored.binding.question);
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
 it('retains linked genuine legacy clarification context without inventing saved-chat scope, but stops at different authenticated v3 threads or scopes',async()=>{
  const {ctx}=await actor(),root=await exchange(ctx,{version:1,mode:'clarify',slot:'leave_type'},'My leave balance'),tail=await exchange(ctx,{version:1,mode:'clarify',slot:'leave_type'},'Unknown Leave'),threadId=tail.binding.exchangeId;
  const tailReceipt=sealAssistantDisclosure(tail.binding,[],{version:1,mode:'clarify',slot:'leave_type'},{threadId,scopeDigest:assistantConversationScopeDigest(ctx)})!;
  await owner.db.update(s.assistantExchange).set({disclosureReceipt:tailReceipt,continuesExchangeId:root.binding.exchangeId}).where(eq(s.assistantExchange.id,tail.binding.exchangeId));
  const issued=await ownAssistantClarification(ctx,threadId,'Annual Leave');expect(issued.earlier).toEqual([{question:'My leave balance',slot:'leave_type'}]);
  expect(()=>assistantConversationContextFromClarification(ctx,{...issued})).toThrow('Current clarification unavailable.');
  expect(()=>assistantConversationContextFromClarification(ctx,issued,'other-company')).toThrow('Current clarification unavailable.');
  for(const metadata of [{threadId:randomUUID(),scopeDigest:assistantConversationScopeDigest(ctx)},{threadId,scopeDigest:assistantConversationScopeDigest(ctx,'other-company')}]){
   const receipt=sealAssistantDisclosure(root.binding,[],{version:1,mode:'clarify',slot:'leave_type'},metadata)!;await owner.db.update(s.assistantExchange).set({disclosureReceipt:receipt}).where(eq(s.assistantExchange.id,root.binding.exchangeId));
   expect((await ownAssistantClarification(ctx,threadId,'Annual Leave')).earlier).toEqual([]);
  }
 });
 it.each(['answer','receipt','missing_receipt'] as const)('rechecks genuine legacy clarify %s bytes after read, before any later admission',async change=>{
  const {ctx}=await actor(),stored=await exchange(ctx,{version:1,mode:'clarify',slot:'leave_type'},'My leave balance'),issued=await ownAssistantClarification(ctx,stored.binding.exchangeId,'Annual Leave');
  const patch=change==='answer'?{answer:'CHANGED PRIVATE BODY'}:{disclosureReceipt:change==='missing_receipt'?null:stored.receipt+'!'};
  await owner.db.update(s.assistantExchange).set(patch).where(eq(s.assistantExchange.id,stored.binding.exchangeId));
  await expect(withTenant(ctx,tx=>assertOwnAssistantClarificationCurrentTx(tx,ctx,issued))).rejects.toThrow('Current clarification unavailable.');
  await refused(ctx,stored.binding.exchangeId,'Annual Leave');
 });
 it.each(['expired','retired','foreign'] as const)('excludes %s legacy ancestors from a new scoped explicit clarification',async state=>{
  const {ctx}=await actor(),other=state==='foreign'?await actor():null,root=await exchange(other?.ctx??ctx,{version:1,mode:'clarify',slot:'leave_type'},'My leave balance',state==='expired'?new Date(Date.now()-31*86400000):undefined),tail=await exchange(ctx,{version:1,mode:'clarify',slot:'leave_type'},'Unknown Leave');
  const receipt=sealAssistantDisclosure(tail.binding,[],{version:1,mode:'clarify',slot:'leave_type'},{threadId:tail.binding.exchangeId,scopeDigest:assistantConversationScopeDigest(ctx)})!;
  await owner.db.update(s.assistantExchange).set({disclosureReceipt:receipt,continuesExchangeId:root.binding.exchangeId}).where(eq(s.assistantExchange.id,tail.binding.exchangeId));
  if(state==='retired')await owner.db.execute(sql`select app._assistant_transcripts_retire(${ctx.tenantId}::uuid,array[${root.binding.exchangeId}::uuid],true)`);
  expect((await ownAssistantClarification(ctx,tail.binding.exchangeId,'Annual Leave')).earlier).toEqual([]);
 });
 it('accepts a full original 2000-character human question and 500-character clarification without serialization overhead or truncation',async()=>{
  const {ctx}=await actor(),question='q'.repeat(2000),answer='x'.repeat(500),stored=await exchange(ctx,undefined,question),before=await state();
  const result=await ownAssistantClarification(ctx,stored.binding.exchangeId,answer);
  expect(result).toEqual({originalQuestion:question,slot:'period',answer,earlier:[]});expect(Object.isFrozen(result)).toBe(true);
  expect(await state()).toEqual(before);
 });
 it('enforces exact 8000-character human history and 500-character response bounds without truncation',async()=>{
  const {ctx}=await actor(),answer='x'.repeat(ASSISTANT_CONVERSATION_LIMITS.humanAnswer),length=ASSISTANT_CONVERSATION_LIMITS.history-2-answer.length;
  const stored=await exchange(ctx,undefined,'q'.repeat(length)),tooLong=await exchange(ctx,undefined,'q'.repeat(length+1));
  const before=await state(),exact=await ownAssistantClarification(ctx,stored.binding.exchangeId,answer);
  expect(exact).toEqual({originalQuestion:stored.binding.question,slot:'period',answer,earlier:[]});
  expect((exact.originalQuestion+'\n\n'+exact.answer).length).toBe(8000);
  expect(canClarifyAssistantQuestion(stored.binding.question)).toBe(true);expect(canClarifyAssistantQuestion(tooLong.binding.question)).toBe(false);
  expect(canClarifyAssistantQuestion('q'.repeat(2000))).toBe(true);expect(canClarifyAssistantQuestion('q'.repeat(8000))).toBe(false);
  expect(Object.isFrozen(ASSISTANT_CONVERSATION_LIMITS)).toBe(true);
  for(const malformed of [null,undefined,{},[],42])expect(canClarifyAssistantQuestion(malformed)).toBe(false);
  await refused(ctx,tooLong.binding.exchangeId,answer);await refused(ctx,stored.binding.exchangeId,'x'.repeat(501));
  await refused(ctx,stored.binding.exchangeId,'  ');await refused(ctx,stored.binding.exchangeId,null);await refused(ctx,'not-an-id');
  let invoked=false;await refused(ctx,stored.binding.exchangeId,{toString(){invoked=true;return '2026';}});expect(invoked).toBe(false);expect(await state()).toEqual(before);
 });
 it('keeps the explicit clarification bridge within the existing six whole-question token suffix',async()=>{
  const {ctx}=await actor(),ids:string[]=[];let parent:string|null=null;
  for(let n=0;n<8;n++){const stored=await exchange(ctx,{version:1,mode:'clarify',slot:'leave_type'},'q'+n+'x'.repeat(400));await owner.db.update(s.assistantExchange).set({continuesExchangeId:parent}).where(eq(s.assistantExchange.id,stored.binding.exchangeId));ids.push(stored.binding.exchangeId);parent=stored.binding.exchangeId;}
  const issued=await ownAssistantClarification(ctx,parent!,'Annual Leave'),bridge=assistantConversationContextFromClarification(ctx,issued);
  expect(bridge.questions).toHaveLength(5);expect(bridge.questions.every(question=>question.length===402)).toBe(true);expect(bridge.questions[0]).toBe('q3'+'x'.repeat(400));expect(bridge.questions.reduce((sum,question)=>sum+question.length+2,0)).toBeLessThanOrEqual(8000);
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
  expect(result).toEqual({originalQuestion:stored.binding.question,slot:'period',answer:'My original human answer',earlier:[]});expect(Object.isFrozen(result)).toBe(true);expect(await state()).toEqual(before);
 });
 it('bounds the real held Access wait, rolls back before a generic refusal, and continues after release',async()=>{
  const {ctx,admin}=await actor(),stored=await exchange(ctx),before=await state();
  let ready!:()=>void,release!:()=>void,fail!:(error:unknown)=>void,held=false;
  const started=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
  const watchdog=setTimeout(()=>{fail(Error('owned bounded clarification handshake timed out'));release();},10000);
  const holder=withTenant(admin,async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);held=true;ready();await finish;held=false;});
  void holder.catch(fail);let pending:ReturnType<typeof ownAssistantClarification>|undefined;
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{
   await started;pending=ownAssistantClarification(ctx,stored.binding.exchangeId,'Original current period');
   // The timeout is a failure oracle, not the expected outcome. The holder is released only after
   // the actual command has returned its bounded public refusal and unchanged-state assertions.
   const bounded=Promise.race([pending,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(Error('clarification did not bound the owned Access wait')),2500);})]);
   await expect(bounded).rejects.toThrow(/^Current clarification unavailable\.$/);
   clearTimeout(deadline);expect(held).toBe(true);expect(await state()).toEqual(before);
   const [probe]=await withTenant(ctx,tx=>tx.execute<{user_id:string;ok:number}>(sql`select app.current_user_id() as user_id,1 as ok`));
   expect(probe).toEqual({user_id:ctx.userId,ok:1});expect(held).toBe(true);
  }finally{
   release();clearTimeout(watchdog);if(deadline)clearTimeout(deadline);await holder;
   if(pending)await pending.catch(()=>undefined);
  }
  const result=await ownAssistantClarification(ctx,stored.binding.exchangeId,'Original current period');
  expect(result).toEqual({originalQuestion:stored.binding.question,slot:'period',answer:'Original current period',earlier:[]});
  expect(Object.isFrozen(result)).toBe(true);expect(await state()).toEqual(before);
 });

});

/** Actual app-role admission with ONLY the provider transport mocked. The original question is transient
 * local context; no raw question or label leaves, and its own exchange remains current at each admission. */
describe('a continuation rechecks its own original exchange before every provider round trip',()=>{
 const usage={inputTokens:0,outputTokens:0,cachedInputTokens:0};
 const end={text:'Fictional continuation answer',stop:'end' as const,toolCalls:[],usage,usageReported:true};
 const tool={...end,text:'',stop:'tool_use' as const,toolCalls:[{id:'fictional-continuation-call',name:'unknown_fictional_tool',input:{}}]};
 const reply='Annual Leave';
 async function providerActor(){const result=await actor();await seedEntitlement(result.admin,{leaveTypeId:b.annualLeaveTypeId,annualDays:113.75,validFrom:'2020-01-01'});await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:result.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'113.75',effectiveOn:todayInKualaLumpur()});return result;}
 const provider=()=>{vi.stubEnv('OPENAI_API_KEY','fictional-continuation-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');};
 const custody=async(tenantId:string)=>(await owner.db.execute<{markers:number;tasks:number}>(sql`select (select count(*)::int from public.ai_assistant_answer_strategy_use where tenant_id=${tenantId}::uuid) as markers,(select count(*)::int from app.ai_spend_task where tenant_id=${tenantId}::uuid) as tasks`))[0];
 const own=(ctx:SessionContext)=>owner.db.select().from(s.assistantExchange).where(eq(s.assistantExchange.appUserId,ctx.userId!)).orderBy(s.assistantExchange.id);
 afterEach(()=>vi.restoreAllMocks());
 it('positive control: resolves the local slot and sends only closed references while its own exchange stays current',async()=>{
  provider();const {ctx}=await providerActor(),stored=await exchange(ctx,{version:1,mode:'clarify',slot:'leave_type'},'My leave balance');
  const transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValueOnce(end);
  const result=await askAssistant(ctx,{question:reply,clarificationExchangeId:stored.binding.exchangeId});
  expect(transport).toHaveBeenCalledOnce();
  for(const [,args] of transport.mock.calls){expect(args.turns).toHaveLength(1);expect(args.turns[0]).toMatchObject({role:'user'});expect(JSON.stringify(args)).not.toContain(stored.binding.question);expect(JSON.stringify(args)).not.toContain(reply);expect(JSON.stringify(args)).toContain('leave_available');}
  expect((await own(ctx)).find(row=>row.id===result.exchangeId)?.question).toBe(reply);
 });
 it('refuses in the strategy-marker transaction when own history is erased after the clarification read',async()=>{
  provider();const {ctx}=await providerActor(),stored=await exchange(ctx,{version:1,mode:'clarify',slot:'leave_type'},'My leave balance'),read=clarificationOwner.ownAssistantClarification;
  const transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValue(end);
  // The actual own-history owner erases between the read and the admission transaction.
  vi.spyOn(clarificationOwner,'ownAssistantClarification').mockImplementationOnce(async(supplied,id,response)=>{
   const issued=await read(supplied,id,response);expect(await eraseOwnAssistantHistory(ctx)).toEqual({retired:1});return issued;});
  const before=await custody(ctx.tenantId);
  await expect(askAssistant(ctx,{question:reply,clarificationExchangeId:stored.binding.exchangeId})).rejects.toBeInstanceOf(AssistantClarificationError);
  expect(transport).not.toHaveBeenCalled();expect(await custody(ctx.tenantId)).toEqual(before);
  const rows=await own(ctx);expect(rows.map(row=>row.id)).toEqual([stored.binding.exchangeId]);
  expect(rows[0].question).toBe('');expect(rows[0].contentRetiredAt).not.toBeNull();
 });
 it.each(['answer','receipt'] as const)('refuses legacy clarification %s mutation after source read before marker/provider/persist',async field=>{
  provider();const {ctx}=await providerActor(),stored=await exchange(ctx,{version:1,mode:'clarify',slot:'leave_type'},'My leave balance'),read=clarificationOwner.ownAssistantClarification,transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValue(end);
  vi.spyOn(clarificationOwner,'ownAssistantClarification').mockImplementationOnce(async(supplied,id,response,scope)=>{const issued=await read(supplied,id,response,scope);await owner.db.update(s.assistantExchange).set(field==='answer'?{answer:'CHANGED LEGACY BODY'}:{disclosureReceipt:stored.receipt+'!'}).where(eq(s.assistantExchange.id,stored.binding.exchangeId));return issued;});
  const before=await custody(ctx.tenantId);await expect(askAssistant(ctx,{question:reply,clarificationExchangeId:stored.binding.exchangeId})).rejects.toBeInstanceOf(AssistantClarificationError);
  expect(transport).not.toHaveBeenCalled();expect(await custody(ctx.tenantId)).toEqual(before);expect((await own(ctx)).map(row=>row.id)).toEqual([stored.binding.exchangeId]);
 });
 it('makes no additional dispatch and retires content when the original exchange is erased during the sole call',async()=>{
  provider();const {ctx}=await providerActor(),stored=await exchange(ctx,{version:1,mode:'clarify',slot:'leave_type'},'My leave balance');
  const transport=vi.spyOn(openaiAdapter,'converse').mockImplementationOnce(async()=>{
   // The physical retirement primitive the 30-day expiry owner applies, run by the table owner between
   // turns. It deletes only markers LINKED to the retired exchange, so this continuation's own pending
   // marker survives and the strategy recheck alone would admit the original question again.
   await owner.db.execute(sql`select app._assistant_transcripts_retire(${ctx.tenantId}::uuid,array[${stored.binding.exchangeId}::uuid],true)`);
   return tool;}).mockResolvedValue(end);
  await expect(askAssistant(ctx,{question:reply,clarificationExchangeId:stored.binding.exchangeId})).rejects.toMatchObject({code:'provider_error'});
  expect(transport).toHaveBeenCalledOnce();expect(JSON.stringify(transport.mock.calls[0][1])).not.toContain(stored.binding.question);expect(JSON.stringify(transport.mock.calls[0][1])).not.toContain(reply);
  const rows=await own(ctx);expect(rows.find(row=>row.id===stored.binding.exchangeId)?.contentRetiredAt).not.toBeNull();
  const accounting=rows.filter(row=>row.id!==stored.binding.exchangeId);expect(accounting).toHaveLength(1);expect(accounting[0]).toMatchObject({question:'',answer:null,disclosureReceipt:null,toolCalls:[],error:null,turnCount:1,stop:'other'});expect(accounting[0].contentRetiredAt).not.toBeNull();
  expect(JSON.stringify(rows)).not.toContain(stored.binding.question);
 });
});
