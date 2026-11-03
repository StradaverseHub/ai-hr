/** AI v2 Phase 2 wave 2 — letter requests in the AI Centre chat custody and retention model (migration 0973), on fictional
 * data, through the real chat card (core/proposals/letter-request.ts, core/assistant-actions/letter-request-proposal-confirm.ts),
 * the real stored chats (core/teras-chats.ts), the retention runner (scripts/ai-retention-runner.ts) and person erasure
 * (core/pdpa.ts), under forced row-level security.
 *
 * Two custody classes:
 *  - chat-linked: the open card in the conversation's task memory, and the card's id on the request (client_key). Both go
 *    when the chat goes, on every path: chat expiry (the retention runner), the person deleting one chat or erasing all of
 *    theirs, and person erasure;
 *  - the HR record: the request (type, purpose, status, linked letter, HR's decision, reason and message, version, times)
 *    and its letter-request.* events. They stay, byte for byte, whichever path removed the chat.
 * Never another login's or another tenant's request; the application role cannot clear a card id even with a forged
 * marker; and the database guard still refuses any other change to a request, from the owner too.
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
import {DELETED_CHAT_DIGEST,deleteOwnChat,eraseOwnChats,recordChatTurn} from '../core/teras-chats';
import {TERAS_CHAT_MAINTAINED_RELATIONS} from '../core/teras-chat-expiry';
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
/** The HR record, before and after: every column but the card id. */
const withoutKey=(rows:readonly Record<string,unknown>[])=>rows.map(row=>{const copy={...row};delete copy.clientKey;return copy;});
const keys=(rows:readonly {id:string;clientKey:string|null}[])=>Object.fromEntries(rows.map(row=>[row.id,row.clientKey]));
/** Moves a chat `days` into the past and expires it (database triggers bypassed), as the 0952 tests do. */
async function expire(chatId:string,days=40){
 await owner.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role=replica`);
  await tx.execute(sql`update public.teras_chat set created_at=now()-make_interval(days=>${days+1}),last_message_at=now()-make_interval(days=>${days}),
   expires_at=now()-make_interval(days=>${days-30}) where id=${chatId}::uuid`);});
}
async function backdateRequest(requestId:string,interval:string){
 await owner.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role=replica`);
  await tx.execute(sql`update public.letter_request set created_at=now()-${interval}::interval,status_changed_at=now()-${interval}::interval where id=${requestId}::uuid`);});
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

describe('letter requests in the chat custody model',()=>{
 it('registers letter_request with the chat pass, which owns every relation it changes',()=>{
  expect(TERAS_CHAT_MAINTAINED_RELATIONS).toEqual(['public.teras_chat','public.teras_chat_turn','public.teras_task_memory','public.letter_request']);
 });

 it('chat expiry: the runner deletes the chat with its open card and clears the card id; the request and HR decision stay',async()=>{
  const declined=await card(aina,CONFIRMATION_WORDS),unconfirmed=await card(aina,SALARY_WORDS);
  const expiring=await chat(main,aina,[declined,unconfirmed]);
  const declinedId=await confirm(aina,declined);
  await declineLetterRequest(main.hr,{requestId:declinedId,reason:'Fictional reason: probation still open',employeeMessage:'Fictional message: ask again later',expectedVersion:1});
  // The person's live chat and its own submitted request; another person's chat and request.
  const open=await card(aina,SALARY_WORDS),live=await chat(main,aina,[open]);const openId=await confirm(aina,open);
  const theirs=await card(badrul,CONFIRMATION_WORDS),peerChat=await chat(main,badrul,[theirs]);const peerId=await confirm(badrul,theirs);
  const before=await requests(),eventsBefore=await events();
  // Non-vacuity: each card id is on its request, and the decision is HR's.
  expect(keys(before)).toEqual({[declinedId]:declined.body.id,[openId]:open.body.id,[peerId]:theirs.body.id});
  expect(await request(declinedId)).toMatchObject({status:'declined',declineReason:'Fictional reason: probation still open',employeeMessage:'Fictional message: ask again later',version:2});
  // No event of the request ever carried a card id.
  for(const id of [declined.body.id,unconfirmed.body.id,open.body.id,theirs.body.id])expect(JSON.stringify(eventsBefore)).not.toContain(id);
  await expire(expiring);

  expect(await tick()).toEqual({...zero,chats:1,tenants:0,busy:0,backlog:false,oldestExpiredAgeSeconds:null});
  // Chat-linked: the chat and its task memory (the declined card and the never-confirmed one) are gone.
  expect(await chatsOf(aina.ctx.userId)).toEqual([live]);expect(await memoryOf(aina.ctx.userId)).toEqual([live]);
  expect(await chatsOf(badrul.ctx.userId)).toEqual([peerChat]);expect(await memoryOf(badrul.ctx.userId)).toEqual([peerChat]);
  const after=await requests();
  // The HR record: every request and HR's decision, unchanged but for the card id; same version, same status time.
  expect(withoutKey(after)).toEqual(withoutKey(before));
  expect(keys(after)).toEqual({[declinedId]:null,[openId]:null,[peerId]:theirs.body.id});
  expect(await request(declinedId)).toMatchObject({status:'declined',declineReason:'Fictional reason: probation still open',employeeMessage:'Fictional message: ask again later',version:2,clientKey:null});
  expect(await events()).toEqual(eventsBefore);
  // The person's still-open request stays the only one for its type: a repeated Confirm of its card is refused in place.
  expect(await confirmLetterRequestProposal(aina.ctx,{proposal:open,confirm:true})).toEqual({kind:'refused',reason:'duplicate'});
  expect((await requests()).length).toBe(3);
  // Idempotent: the next pass removes and clears nothing.
  expect(await tick()).toEqual({...zero,chats:0,tenants:0,busy:0,backlog:false,oldestExpiredAgeSeconds:null});
  expect(await requests()).toEqual(after);
 });

 it('own delete and own erase clear the card ids of requests confirmed since the chat started, never earlier ones',async()=>{
  const earlier=await card(aina,SALARY_WORDS);const earlierId=await confirm(aina,earlier);
  // Confirmed two hours before any chat of this test started: not from it.
  await backdateRequest(earlierId,'2 hours');
  const fromChat=await card(aina,CONFIRMATION_WORDS),one=await chat(main,aina,[fromChat]);const fromChatId=await confirm(aina,fromChat);
  const peerCard=await card(badrul,CONFIRMATION_WORDS);await chat(main,badrul,[peerCard]);const peerId=await confirm(badrul,peerCard);
  const before=await requests();
  expect(await deleteOwnChat(aina.ctx,one)).toBe(1);
  expect(await chatsOf(aina.ctx.userId)).toEqual([]);expect(await memoryOf(aina.ctx.userId)).toEqual([]);
  const afterDelete=await requests();
  expect(withoutKey(afterDelete)).toEqual(withoutKey(before));
  expect(keys(afterDelete)).toEqual({[earlierId]:earlier.body.id,[fromChatId]:null,[peerId]:peerCard.body.id});
  // Erasing all of one's chats: the same, for every chat, and still only one's own.
  await chat(main,aina);const erasedCount=await eraseOwnChats(aina.ctx);expect(erasedCount).toBe(1);
  const afterErase=await requests();
  expect(withoutKey(afterErase)).toEqual(withoutKey(before));
  expect(keys(afterErase)).toEqual({[earlierId]:earlier.body.id,[fromChatId]:null,[peerId]:peerCard.body.id});
  // The trigger leaves its marker empty again within the deleting transaction itself.
  const last=await chat(main,aina);
  expect(await withTenant(aina.ctx,async tx=>{
   const gone=await tx.execute<{id:string}>(sql`delete from public.teras_chat where id=${last}::uuid returning id`);
   const [marker]=await tx.execute<{marker:string}>(sql`select coalesce(current_setting('app.letter_request_card_keys',true),'') as marker`);
   return{gone:gone.map(row=>row.id),marker:marker?.marker};
  })).toEqual({gone:[last],marker:''});
  expect(keys(await requests())).toEqual({[earlierId]:earlier.body.id,[fromChatId]:null,[peerId]:peerCard.body.id});
 });

 it('person erasure deletes the subject\'s chats and clears the subject\'s card ids only; the requests stay',async()=>{
  const mine=await card(aina,CONFIRMATION_WORDS);await chat(main,aina,[mine]);const mineId=await confirm(aina,mine);
  const theirs=await card(badrul,CONFIRMATION_WORDS),peerChat=await chat(main,badrul,[theirs]);const peerId=await confirm(badrul,theirs);
  const before=await requests();
  await erasePersonPii(main.hr,{subjectEmploymentId:aina.employmentId,scope:'contact',reason:'Fictional canonical privacy request',requestRef:'fixture-'+randomUUID()});
  expect(await chatsOf(aina.ctx.userId)).toEqual([]);expect(await memoryOf(aina.ctx.userId)).toEqual([]);
  expect(await chatsOf(badrul.ctx.userId)).toEqual([peerChat]);expect(await memoryOf(badrul.ctx.userId)).toEqual([peerChat]);
  const after=await requests();
  expect(withoutKey(after)).toEqual(withoutKey(before));
  expect(keys(after)).toEqual({[mineId]:null,[peerId]:theirs.body.id});
 });

 it('stays inside the tenant and login, and no other path can clear or change a request',async()=>{
  const foreign=await letters(),outsider=await hire(foreign,'Fictional Foreign Requester');
  const foreignCard=await card(outsider,CONFIRMATION_WORDS),foreignChat=await chat(foreign,outsider,[foreignCard]);const foreignId=await confirm(outsider,foreignCard);
  const mine=await card(aina,CONFIRMATION_WORDS),myChat=await chat(main,aina,[mine]);const mineId=await confirm(aina,mine);
  const foreignBefore=await requests(foreign.b.tenantId);
  // Another tenant's chat is invisible to the person and cannot be deleted by them.
  await expect(deleteOwnChat(aina.ctx,foreignChat).catch(()=>0)).resolves.toBe(0);
  expect(await chatsOf(outsider.ctx.userId)).toEqual([foreignChat]);
  // Deleting the person's own chat leaves the other tenant's request whole, card id included.
  expect(await deleteOwnChat(aina.ctx,myChat)).toBe(1);
  expect((await request(mineId)).clientKey).toBeNull();
  expect(await requests(foreign.b.tenantId)).toEqual(foreignBefore);
  // And the other tenant's expiry clears only its own request's card id.
  await expire(foreignChat);
  expect((await tick()).chats).toBe(1);
  expect((await request(foreignId)).clientKey).toBeNull();expect(withoutKey(await requests(foreign.b.tenantId))).toEqual(withoutKey(foreignBefore));

  // The application role cannot clear a card id itself, even with a forged marker for its own tenant and login.
  const kept=await card(badrul,CONFIRMATION_WORDS);const keptId=await confirm(badrul,kept);
  const forged=await withTenant(badrul.ctx,async tx=>{
   await tx.execute(sql`select set_config('app.letter_request_card_keys',${main.b.tenantId+':'+badrul.ctx.userId},true)`);
   return tx.execute(sql`update public.letter_request set client_key=null where id=${keptId}::uuid`);
  }).then(()=>'written',(error:unknown)=>pgCode(error));
  expect(forged).toBe('42501');
  // HR holding `generate` cannot either: its column grants exclude the card id.
  const hrForged=await withTenant(main.hr,async tx=>{
   await tx.execute(sql`select set_config('app.letter_request_card_keys',${main.b.tenantId+':'+badrul.ctx.userId},true)`);
   return tx.execute(sql`update public.letter_request set client_key=null where id=${keptId}::uuid`);
  }).then(()=>'written',(error:unknown)=>pgCode(error));
  expect(hrForged).toBe('42501');
  // The guard refuses the table owner too: without the marker, and with it for anything beyond clearing the card id.
  const ownerWrite=(marker:string|null,assignment:ReturnType<typeof sql>)=>owner.db.transaction(async tx=>{
   if(marker!==null)await tx.execute(sql`select set_config('app.letter_request_card_keys',${marker},true)`);
   await tx.execute(sql`update public.letter_request set ${assignment} where id=${keptId}::uuid`);
  }).then(()=>'written',(error:unknown)=>pgCode(error));
  const right=main.b.tenantId+':'+badrul.ctx.userId;
  expect(await ownerWrite(null,sql`client_key=null`)).toBe('42501');
  expect(await ownerWrite(main.b.tenantId+':'+aina.ctx.userId,sql`client_key=null`)).toBe('42501');
  expect(await ownerWrite(right,sql`client_key=null,purpose='Fictional rewritten purpose'`)).toBe('42501');
  expect(await ownerWrite(right,sql`client_key=${randomUUID()}::uuid`)).toBe('42501');
  expect((await request(keptId)).clientKey).toBe(kept.body.id);
 });
});
