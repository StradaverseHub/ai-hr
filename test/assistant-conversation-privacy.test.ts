/** Authored UNRUN. Actual canonical privacy owner and actual app-role source bindings; no forged
 * erasure audit, private guard removal, production data or live provider. Normally installed draft required. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as events from '../db/events';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {resolveActiveAiConfig} from '../core/ai-config';
import {bindAiSpendTaskTx} from '../core/ai-spend-task';
import {erasePersonPii,erasePersonPiiTx} from '../core/pdpa';
import {prepareAssistantConversationStrategyTx,recheckAssistantConversationStrategyTx} from '../core/module-agent-releases';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
/** Narrows the canonical pii.erased payload (typed unknown by appendEvent) without asserting its shape. */
function erasedPayload(payload:unknown):payload is Record<string,unknown>&{erasedFields:string[]}{return typeof payload==='object'&&payload!==null&&'erasedFields' in payload&&Array.isArray(payload.erasedFields)&&payload.erasedFields.every(field=>typeof field==='string');}
let base:Base;
beforeAll(migrateTestDb);afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-conversation-privacy');vi.stubEnv('OPENAI_API_KEY','fictional-conversation-key');vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('GOOGLE_API_KEY','');vi.stubEnv('GEMINI_API_KEY','');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
async function hired(){return hireEmployee(adminCtx(base),{person:{fullName:'Fictional privacy subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});}
async function actor(){const subject=await hired(),userId=await createAppUser(base.tenantId,subject.personId,'hr_admin');await grantAssistant(adminCtx(base),{appUserId:userId});return{...await entitledCtx(base,['hr_admin']),userId,personId:subject.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}],employmentId:subject.employmentId} satisfies SessionContext&{employmentId:string};}
async function prepare(ctx:SessionContext,tx?:Tx){const run=async(carrier:Tx)=>{const cfg=await resolveActiveAiConfig(carrier,ctx,'hr_assistant');if(!cfg)throw Error('Missing fictional provider');return prepareAssistantConversationStrategyTx(carrier,ctx,await bindAiSpendTaskTx(carrier,ctx,cfg,{kind:'assistant_question'}),'fictional privacy question');};return tx?run(tx):withTenant(ctx,run);}
const request=(id:string)=>({subjectEmploymentId:id,scope:'contact' as const,reason:'Fictional canonical privacy request',requestRef:'fictional-conversation-'+randomUUID()});
async function stored(){return owner.db.execute<{id:string;person_id:string|null}>(sql`select id,person_id from public.ai_assistant_answer_strategy_use order by id`);}
describe('canonical conversation metadata erasure and non-resurrection',()=>{
 it('erases the exact original PERSON after account relink and preserves unrelated later new-PERSON rows on that same USER',async()=>{
  const original=await actor(),old=await prepare(original),next=await hired();await owner.db.execute(sql`update public.app_user set person_id=${next.personId}::uuid where id=${original.userId}::uuid`);const current={...original,personId:next.personId},keep=await prepare(current);expect((await stored()).map(row=>row.person_id).sort()).toEqual([original.personId!,next.personId].sort());
  const result=await erasePersonPii(adminCtx(base),request(original.employmentId));expect(result.erased).toContain('assistantConversationLearning');expect((await stored()).map(row=>row.person_id)).toEqual([next.personId]);await withTenant(current,tx=>recheckAssistantConversationStrategyTx(tx,current,keep.capability));await expect(withTenant(original,tx=>recheckAssistantConversationStrategyTx(tx,original,old.capability))).rejects.toThrow();
 });
 it('reaches actual canonical erasure/audit and immediate constraints, then refuses later same-Tx capture and rolls back the whole command',async()=>{
  const ctx=await actor();await prepare(ctx);const before=await stored(),[eventsBefore]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.domain_event`);let afterConstraints=false;
  await expect(withTenant(ctx,async tx=>{const report=await erasePersonPiiTx(tx,ctx,request(ctx.employmentId));expect(report.erased).toContain('assistantConversationLearning');await tx.execute(sql`set constraints all immediate`);afterConstraints=true;await prepare(ctx,tx);})).rejects.toThrow();
  expect(afterConstraints).toBe(true);expect(await stored()).toEqual(before);const[eventsAfter]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.domain_event`);expect(eventsAfter.n).toBe(eventsBefore.n);
 });
 it('rolls back actual metadata erasure when the real canonical audit omits its required positive-count flag',async()=>{
  const ctx=await actor();await prepare(ctx);const before=await stored(),append=events.appendEvent;
  vi.spyOn(events,'appendEvent').mockImplementation(async(tx,event,options)=>{if(event.eventType==='pii.erased'){const payload=event.payload;if(!erasedPayload(payload))throw Error('Canonical pii.erased payload unavailable');const fields=payload.erasedFields;return append(tx,{...event,payload:{...payload,erasedFields:fields.filter(field=>field!=='assistantConversationLearning')}},options);}return append(tx,event,options);});
  await expect(erasePersonPii(ctx,request(ctx.employmentId))).rejects.toThrow();expect(await stored()).toEqual(before);const[rows]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.domain_event where event_type='pii.erased'`);expect(rows.n).toBe(0);
 });
});
