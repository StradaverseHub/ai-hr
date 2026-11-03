/** AI v2 Phase 2 wave 2 — letter requests in the AI Centre chat custody and retention model, on fictional data, through
 * the real chat card (core/proposals/letter-request.ts, core/assistant-actions/letter-request-proposal-confirm.ts), the
 * real stored chats (core/teras-chats.ts), the retention runner (scripts/ai-retention-runner.ts) and person erasure
 * (core/pdpa.ts), under forced row-level security. No migration: the classification is core/teras-chat-expiry.ts
 * TERAS_CHAT_SURVIVING_RECORDS.
 *
 * Two custody classes:
 *  - chat-linked: the chat and its task memory, holding the open card (confirmed or not). They go on every path: chat
 *    expiry (the retention runner), the person deleting one chat or erasing all of theirs, and person erasure;
 *  - the HR record: the request (type, purpose, status, linked letter, HR's decision, reason and message, version, times),
 *    its letter-request.* events and the card's id on it (client_key, an opaque idempotency key with no chat content).
 *    They stay, byte for byte, whichever path removed the chat, so a repeated Confirm of the same card is still the same
 *    request and never a second one.
 * Never another login's or another tenant's chat; no application caller can change the card id.
 * The task memory row is a fictional storage fixture (only its openProposals matter here), not a harness turn. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as s from '../db/schema';
import {terasChat} from '../db/teras-chat-schema';
import {terasTaskMemory} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {erasePersonPii} from '../core/pdpa';
import {decideLetterTemplate,saveLetterField,saveLetterTemplate} from '../core/letters';
import {declineLetterRequest,saveLetterRequestOptions} from '../core/letter-requests';
import {prepareChatLetterRequestProposal} from '../core/proposals/letter-request';
import {confirmLetterRequestProposal} from '../core/assistant-actions/letter-request-proposal-confirm';
import {LETTER_REQUEST_ACTION} from '../core/proposals/letter-request';
import {DELETED_CHAT_DIGEST,deleteOwnChat,eraseOwnChats,recordChatTurn} from '../core/teras-chats';
import {TERAS_CHAT_MAINTAINED_RELATIONS,TERAS_CHAT_SURVIVING_RECORDS} from '../core/teras-chat-expiry';
import type {Proposal} from '../core/proposals/proposal';
import {todayInKualaLumpur} from '../lib/hr-date';
import {runAiRetentionTick} from '../scripts/ai-retention-runner';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={ctx:SessionContext&{userId:string;personId:string};employmentId:string;personId:string};
type Letters={b:Base;hr:SessionContext;confirmationId:string;salaryId:string};
let main:Letters,aina:Person,badrul:Person;
const zero={reviews:0,feedback:0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0,importEvaluations:0,nativeOutcomes:0,nativeSources:0,conversationArms:0,conversationUses:0,conversationIntents:0,transcripts:0};
const tick=()=>runAiRetentionTick(owner as unknown as Parameters<typeof runAiRetentionTick>[0]);
const CONFIRMATION_WORDS='I need an employment confirmation letter',SALARY_WORDS='I need a salary confirmation letter';

/** A tenant with two published templates its company opened for employee requests. */
async function letters():Promise<Letters>{
 const b=await seedBase();for(const code of ['assistant','notifications'])await setModule(b.tenantId,code,'active');
 const hr=await entitledCtx(b);
 const [reviewerPerson]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional template approver',primaryEmail:randomUUID()+'@fixture.test'}).returning();
 const reviewer={...hr,userId:await createAppUser(b.tenantId,reviewerPerson.id,'hr_admin'),personId:reviewerPerson.id};
 const name=await saveLetterField(hr,{companyId:b.companyId,definition:{key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},active:true});
 const made=async(code:string,title:string)=>{const template=await saveLetterTemplate(hr,{companyId:b.companyId,code,name:title,category:'confirmation',effectiveFrom:todayInKualaLumpur(),
   document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'To '},{type:'field',key:'employeeName'}]}]},fieldVersionIds:[name.id]});
  await decideLetterTemplate(hr,{versionId:template.versionId,expectedStatus:'draft',action:'submit'});await decideLetterTemplate(reviewer,{versionId:template.versionId,expectedStatus:'submitted',action:'approve'});
  return template.templateId;};
 const confirmationId=await made('EMPCONF','Employment Confirmation Letter'),salaryId=await made('SALARY','Salary Confirmation Letter');
 await saveLetterRequestOptions(hr,{companyId:b.companyId,changes:[confirmationId,salaryId].map(templateId=>({templateId,requestable:true}))});
 return{b,hr,confirmationId,salaryId};
}
async function hire(at:Letters,name:string):Promise<Person>{
 const hired=await hireEmployee(at.hr,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:at.b.companyId,departmentId:at.b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(at.b.tenantId,hired.personId,'employee');await grantAssistant(at.hr,{appUserId:userId});
 return{ctx:{...await entitledCtx(at.b,['employee']),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]},employmentId:hired.employmentId,personId:hired.personId};
}
/** One stored chat of the person, holding `cards` open in its task memory (as the harness keeps an open card). */
async function chat(at:Letters,who:Person,cards:readonly Proposal[]=[]):Promise<string>{
 const conversationId=randomUUID();
 const id=await recordChatTurn(who.ctx,{conversationId,conversationScope:JSON.stringify([at.b.companyId]),companyId:at.b.companyId,question:'Fictional letter question',
  reply:'Fictional letter reply',modelRows:[{role:'user',content:'Fictional letter question'},{role:'assistant',content:'Fictional letter reply'}],withheld:false});
 if(id!==conversationId)throw Error('Fictional chat not stored.');
 await owner.db.insert(terasTaskMemory).values({tenantId:at.b.tenantId,appUserId:who.ctx.userId,conversationId:id,memory:{fictional:true,openProposals:JSON.parse(JSON.stringify(cards))}});
 return id;
}
async function card(who:Person,words:string):Promise<Proposal>{
 const outcome=await prepareChatLetterRequestProposal(who.ctx,{letterType:words.replace(/^I need an? /,'')},words);
 if(outcome?.kind!=='proposal')throw Error('Fictional letter card not prepared: '+JSON.stringify(outcome));
 return outcome.proposal;
}
async function confirm(who:Person,proposal:Proposal):Promise<string>{
 const done=await confirmLetterRequestProposal(who.ctx,{proposal,confirm:true});
 if(done.kind!=='submitted')throw Error('Fictional confirmation refused: '+JSON.stringify(done));
 return done.requestId;
}
const requests=(tenantId=main.b.tenantId)=>owner.db.select().from(s.letterRequest).where(eq(s.letterRequest.tenantId,tenantId)).orderBy(asc(s.letterRequest.id));
const request=async(id:string)=>(await owner.db.select().from(s.letterRequest).where(eq(s.letterRequest.id,id)))[0];
const events=(tenantId=main.b.tenantId)=>owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,tenantId),eq(s.domainEvent.aggregateType,'letter-request'))).orderBy(asc(s.domainEvent.id));
const chatsOf=(userId:string)=>owner.db.select({id:terasChat.id,digest:terasChat.scopeDigest}).from(terasChat).where(eq(terasChat.appUserId,userId))
 .then(rows=>rows.filter(row=>row.digest!==DELETED_CHAT_DIGEST).map(row=>row.id).sort());
const memoryOf=(userId:string)=>owner.db.select({id:terasTaskMemory.conversationId}).from(terasTaskMemory).where(eq(terasTaskMemory.appUserId,userId)).then(rows=>rows.map(row=>row.id).sort());
const keys=(rows:readonly {id:string;clientKey:string|null}[])=>Object.fromEntries(rows.map(row=>[row.id,row.clientKey]));
/** Moves a chat `days` into the past and expires it (database triggers bypassed), as the 0952 tests do. */
async function expire(chatId:string,days=40){
 await owner.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role=replica`);
  await tx.execute(sql`update public.teras_chat set created_at=now()-make_interval(days=>${days+1}),last_message_at=now()-make_interval(days=>${days}),
   expires_at=now()-make_interval(days=>${days-30}) where id=${chatId}::uuid`);});
}
type PgCause={code?:string;cause?:unknown};
/** The Postgres error code behind a Drizzle wrapper (the cause chain), if any. */
const pgCode=(error:unknown)=>{for(let at=error as PgCause|undefined,depth=0;at&&typeof at==='object'&&depth<6;at=at.cause as PgCause|undefined,depth++)if(typeof at.code==='string'&&/^[0-9A-Z]{5}$/.test(at.code))return at.code;return undefined;};

beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-letter-chat-custody-key');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-letter-chat-custody-proposal-secret-0123456789');
 await resetDb();main=await letters();aina=await hire(main,'Aina Fictional');badrul=await hire(main,'Badrul Fictional');
});

/** A repeated Confirm of the same card: the same request, and no second row. */
async function sameRequest(who:Person,proposal:Proposal,requestId:string){
 const count=(await requests(who.ctx.tenantId)).length;
 expect(await confirmLetterRequestProposal(who.ctx,{proposal,confirm:true})).toEqual({kind:'submitted',action:LETTER_REQUEST_ACTION,requestId});
 expect(await requests(who.ctx.tenantId)).toHaveLength(count);
}

describe('letter requests in the chat custody model',()=>{
 it('classifies letter_request as an HR record that survives the chat, outside the relations the chat pass maintains',()=>{
  expect(TERAS_CHAT_SURVIVING_RECORDS).toEqual([{relation:'public.letter_request',custody:'hr_record',chatOrigin:{column:'client_key',classification:'opaque_idempotency_key'}}]);
  expect(TERAS_CHAT_MAINTAINED_RELATIONS).toEqual(['public.teras_chat','public.teras_chat_turn','public.teras_task_memory']);
  for(const record of TERAS_CHAT_SURVIVING_RECORDS)expect(TERAS_CHAT_MAINTAINED_RELATIONS as readonly string[]).not.toContain(record.relation);
 });

 it('chat expiry: the runner deletes the chat and its task memory with the open cards; the requests, HR decision and events stay',async()=>{
  const declined=await card(aina,CONFIRMATION_WORDS),unconfirmed=await card(aina,SALARY_WORDS);
  const expiring=await chat(main,aina,[declined,unconfirmed]);
  const declinedId=await confirm(aina,declined);
  await declineLetterRequest(main.hr,{requestId:declinedId,reason:'Fictional reason: probation still open',employeeMessage:'Fictional message: ask again later',expectedVersion:1});
  // The person's live chat and its own submitted request; another person's chat and request.
  const open=await card(aina,SALARY_WORDS),live=await chat(main,aina,[open]);const openId=await confirm(aina,open);
  const theirs=await card(badrul,CONFIRMATION_WORDS),peerChat=await chat(main,badrul,[theirs]);const peerId=await confirm(badrul,theirs);
  const before=await requests(),eventsBefore=await events();
  // Non-vacuity: each card id is on its request, the decision is HR's, and the never-confirmed card is in task memory.
  expect(keys(before)).toEqual({[declinedId]:declined.body.id,[openId]:open.body.id,[peerId]:theirs.body.id});
  expect(await request(declinedId)).toMatchObject({status:'declined',declineReason:'Fictional reason: probation still open',employeeMessage:'Fictional message: ask again later',version:2});
  expect(JSON.stringify(await owner.db.select().from(terasTaskMemory).where(eq(terasTaskMemory.conversationId,expiring)))).toContain(unconfirmed.body.id);
  // No event of a request ever carried a card id.
  for(const id of [declined.body.id,unconfirmed.body.id,open.body.id,theirs.body.id])expect(JSON.stringify(eventsBefore)).not.toContain(id);
  await expire(expiring);

  expect(await tick()).toEqual({...zero,chats:1,tenants:0,busy:0,backlog:false,oldestExpiredAgeSeconds:null});
  // Chat-linked: the chat and its task memory (the declined card and the never-confirmed one) are gone; nothing else.
  expect(await chatsOf(aina.ctx.userId)).toEqual([live]);expect(await memoryOf(aina.ctx.userId)).toEqual([live]);
  expect(await chatsOf(badrul.ctx.userId)).toEqual([peerChat]);expect(await memoryOf(badrul.ctx.userId)).toEqual([peerChat]);
  // The HR record: every request, HR's decision and the card ids, byte for byte; every event.
  expect(await requests()).toEqual(before);expect(await events()).toEqual(eventsBefore);
  // A repeated Confirm of the expired chat's card, and of the live one, is still the same request.
  await sameRequest(aina,declined,declinedId);await sameRequest(aina,open,openId);
  expect(await requests()).toEqual(before);
  expect(await tick()).toEqual({...zero,chats:0,tenants:0,busy:0,backlog:false,oldestExpiredAgeSeconds:null});
  expect(await requests()).toEqual(before);
 });

 it('own delete and own erase remove the chats and their task memory; the requests stay and stay idempotent',async()=>{
  const fromChat=await card(aina,CONFIRMATION_WORDS),one=await chat(main,aina,[fromChat]);const fromChatId=await confirm(aina,fromChat);
  const second=await card(aina,SALARY_WORDS),two=await chat(main,aina,[second]);const secondId=await confirm(aina,second);
  const peerCard=await card(badrul,CONFIRMATION_WORDS),peerChat=await chat(main,badrul,[peerCard]);const peerId=await confirm(badrul,peerCard);
  const before=await requests(),eventsBefore=await events();
  expect(keys(before)).toEqual({[fromChatId]:fromChat.body.id,[secondId]:second.body.id,[peerId]:peerCard.body.id});
  expect(await deleteOwnChat(aina.ctx,one)).toBe(1);
  expect(await chatsOf(aina.ctx.userId)).toEqual([two]);expect(await memoryOf(aina.ctx.userId)).toEqual([two]);
  expect(await requests()).toEqual(before);expect(await events()).toEqual(eventsBefore);
  await sameRequest(aina,fromChat,fromChatId);
  // Erasing all of one's chats: the same, and still only one's own.
  expect(await eraseOwnChats(aina.ctx)).toBe(1);
  expect(await chatsOf(aina.ctx.userId)).toEqual([]);expect(await memoryOf(aina.ctx.userId)).toEqual([]);
  expect(await chatsOf(badrul.ctx.userId)).toEqual([peerChat]);expect(await memoryOf(badrul.ctx.userId)).toEqual([peerChat]);
  expect(await requests()).toEqual(before);expect(await events()).toEqual(eventsBefore);
  await sameRequest(aina,second,secondId);
 });

 it('person erasure deletes the subject\'s chats and task memory only; every request stays and stays idempotent',async()=>{
  const mine=await card(aina,CONFIRMATION_WORDS);await chat(main,aina,[mine]);const mineId=await confirm(aina,mine);
  const theirs=await card(badrul,CONFIRMATION_WORDS),peerChat=await chat(main,badrul,[theirs]);const peerId=await confirm(badrul,theirs);
  const before=await requests(),eventsBefore=await events();
  await erasePersonPii(main.hr,{subjectEmploymentId:aina.employmentId,scope:'contact',reason:'Fictional canonical privacy request',requestRef:'fixture-'+randomUUID()});
  expect(await chatsOf(aina.ctx.userId)).toEqual([]);expect(await memoryOf(aina.ctx.userId)).toEqual([]);
  expect(await chatsOf(badrul.ctx.userId)).toEqual([peerChat]);expect(await memoryOf(badrul.ctx.userId)).toEqual([peerChat]);
  expect(await requests()).toEqual(before);expect(keys(before)).toEqual({[mineId]:mine.body.id,[peerId]:theirs.body.id});
  expect(await events()).toEqual(eventsBefore);
  await sameRequest(aina,mine,mineId);
 });

 it('stays inside the tenant and login, and no application caller can change the card id',async()=>{
  const foreign=await letters(),outsider=await hire(foreign,'Fictional Foreign Requester');
  const foreignCard=await card(outsider,CONFIRMATION_WORDS),foreignChat=await chat(foreign,outsider,[foreignCard]);const foreignId=await confirm(outsider,foreignCard);
  const mine=await card(aina,CONFIRMATION_WORDS),myChat=await chat(main,aina,[mine]);const mineId=await confirm(aina,mine);
  const foreignBefore=await requests(foreign.b.tenantId),mineBefore=await requests();
  // Another tenant's chat is invisible to the person and cannot be deleted by them.
  await expect(deleteOwnChat(aina.ctx,foreignChat).catch(()=>0)).resolves.toBe(0);
  expect(await chatsOf(outsider.ctx.userId)).toEqual([foreignChat]);expect(await memoryOf(outsider.ctx.userId)).toEqual([foreignChat]);
  // Neither tenant's request is readable from the other, nor is a card from one tenant confirmable in the other.
  expect(await withTenant(aina.ctx,tx=>tx.select({id:s.letterRequest.id}).from(s.letterRequest))).toEqual([{id:mineId}]);
  expect(await withTenant(outsider.ctx,tx=>tx.select({id:s.letterRequest.id}).from(s.letterRequest))).toEqual([{id:foreignId}]);
  expect(await confirmLetterRequestProposal(aina.ctx,{proposal:foreignCard,confirm:true})).toMatchObject({kind:'refused'});
  // The person's own chat goes; the other tenant's chat, memory and request are untouched.
  expect(await deleteOwnChat(aina.ctx,myChat)).toBe(1);
  expect(await requests(foreign.b.tenantId)).toEqual(foreignBefore);expect(await requests()).toEqual(mineBefore);
  // The other tenant's expiry removes only its own chat.
  await expire(foreignChat);
  expect((await tick()).chats).toBe(1);
  expect(await chatsOf(outsider.ctx.userId)).toEqual([]);expect(await requests(foreign.b.tenantId)).toEqual(foreignBefore);
  expect(await requests()).toEqual(mineBefore);
  await sameRequest(outsider,foreignCard,foreignId);

  // The card id is the request's own: neither the person nor HR holding `generate` may change it (no column grant).
  for(const ctx of [aina.ctx,main.hr]){
   const written=await withTenant(ctx,tx=>tx.execute(sql`update public.letter_request set client_key=null where id=${mineId}::uuid`)).then(()=>'written',(error:unknown)=>pgCode(error));
   expect(written).toBe('42501');
  }
  expect(await requests()).toEqual(mineBefore);
 });
});
