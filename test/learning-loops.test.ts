/** AI v2 Phase 2, P2-6 — the learning loops on fictional records (migration 0972, core/learning/*).
 *
 *  1. Capture: a card's Confirm, Edit and Discard, an answer's mark and a recommendation not followed are recorded once
 *     each, as the person, for their own turn; never for a gated (private) turn, another login's turn or a forged card,
 *     and the database refuses a direct write for either. A gap is counted with its intent, once, and stores no words;
 *     nothing an administrator reads links it to the person who asked (AI v2 Phase 2 hardening, review finding 8).
 *  2. Who reads and decides: HR and group administrators, for the companies they administer; nobody else, and nothing
 *     crosses a tenant.
 *  3. The figures, against values worked out by hand from the fixtures.
 *  4. Review: dismiss and reopen, an eval candidate redacted on save, approved, exported only after approval, and final
 *     after export; gap statuses as versions.
 *  5. Proposals: applied only by an administrator, versioned, and reverted.
 * Expected values are written out from the fixtures, never re-derived from the services' own helpers. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import {terasOutcomeFollowup,terasOutcomeRecord} from '../db/teras-schema';
import {terasEvalCandidate,terasGapOccurrence,terasGapStatus,terasGapTurn,terasLearningSignal,terasLearningSignalReview} from '../db/teras-learning-schema';
import {terasPayrollLoopSetting} from '../db/teras-payroll-cycle-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {issueProposal,type Proposal} from '../core/proposals/proposal';
import {recordAnswerMark,recordCardSignal,recordGapFromTurn,recordRecommendationSignal} from '../core/learning/signals';
import {aiQuality} from '../core/learning/quality';
import {candidateExportFile,markCandidateExported,moveCandidate,promoteGap,promoteSignal,editCandidate,reviewSignal,setGapStatus} from '../core/learning/review';
import {decideLoopProposal,revertLoopProposal} from '../core/learning/proposals';
import type {GapTurn} from '../core/learning/gaps';
import {askAiQuality} from '../core/learning/ask';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {deleteOwnChat,recordChatTurn} from '../core/teras-chats';
import {todayInKualaLumpur} from '../lib/hr-date';
import {ASSISTANT_TURN_IDENTITY,RECOMMENDER_IDENTITY} from '../core/learning/capture';
import {ASSISTANT_AGENT_IDENTITY} from '../core/harness/trace-persistence';
import {RECOMMENDER_AGENT_IDENTITY} from '../core/recommenders/leave-decision';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const DAY=86_400_000;
let b:Base,group:Login,employee:Login,manager:Login,second:{id:string;dept:string};
type Login=SessionContext&{employmentId:string;personId:string;userId:string};

async function login(base:Base,name:string,role:'employee'|'manager'|'hr_admin',companyId=base.companyId,departmentId=base.deptA):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 const ctx=await entitledCtx(base,[role]);
 return {...ctx,userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}],employmentId:hired.employmentId};
}
async function companyAdmin(base:Base,companyId:string,departmentId:string):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Company Administrator',primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:hired.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role:'hr_admin'});
 const ctx=await entitledCtx(base,['hr_admin']);
 return {...ctx,userId:user.id,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}],employmentId:hired.employmentId};
}
const REPLAY={model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null};
/** One outcome record of a turn, written as the database owner (the turn wiring writes it as the person). */
async function turnRecord(asker:Login,p:Readonly<{companyId?:string;privateToAsker?:boolean;agent?:string;reads?:{tool:string;status:string}[];at?:Date;tenantId?:string}>={}){
 const at=p.at??new Date(Date.now()-DAY);
 const [row]=await owner.db.insert(terasOutcomeRecord).values({tenantId:p.tenantId??b.tenantId,companyId:p.companyId??b.companyId,runId:randomUUID(),runKind:'turn',startedAt:at,finishedAt:at,
  authorityKind:'person',askedByUserId:asker.userId,agentIdentity:p.agent??'teras.assistant',reads:p.reads??[],checks:[],replay:REPLAY,outcomeKind:'answered',outcome:{},
  humanInvolvement:'none',notice:'not_applicable',privateToAsker:p.privateToAsker??false}).returning();
 return row;
}
function card(asker:Login,action='leave.apply'):Proposal{
 const created=new Date();
 return issueProposal({what:{action,contractVersion:1,entity:'leave_request',effect:'create',selectors:{date:'2026-11-14'},reviewedDigest:'a'.repeat(64)},
  forWhom:{tenantId:b.tenantId,subject:'own_employment',subjectId:asker.employmentId},authority:{kind:'person',tenantId:b.tenantId,userId:asker.userId,personId:asker.personId},
  checks:[{check:'leave_type_eligible',owner:'core/read.ts#listEligibleLeaveTypesFor',ruleVersion:null,result:'pass'}],
  review:{route:'/assistant/leave',href:'/assistant/leave?review='+asker.employmentId,reference:asker.employmentId},
  createdAt:created.toISOString(),expiresAt:new Date(created.getTime()+600_000).toISOString()});
}
/** A stored chat of the person (core/teras-chats.ts), as the wiring writes one before a gap is counted. */
async function storedChat(who:Login):Promise<string>{
 const chatId=await recordChatTurn(who,{conversationId:randomUUID(),conversationScope:JSON.stringify([b.companyId]),companyId:b.companyId,
  question:'A fictional question',reply:'A fictional reply.',modelRows:[{role:'user',content:'A fictional question'},{role:'assistant',content:'A fictional reply.'}],withheld:false});
 expect(chatId).toBeTruthy();return chatId!;
}
const gapTurn=(over:Partial<GapTurn>={}):GapTurn=>({mode:'honest_gap',sensitive:false,refused:false,crisis:false,fallback:false,offered:['product_guidance','product_capabilities'],
 calls:[],suggested:false,...over});
/** A signal written as the owner, for figures (its record too), `daysAgo` days ago. */
async function signalRow(asker:Login,kind:typeof terasLearningSignal.$inferInsert['kind'],p:Readonly<{companyId?:string;daysAgo?:number;role?:'employee'|'manager'|'hr_admin'}>={}){
 const at=new Date(Date.now()-(p.daysAgo??2)*DAY);
 const record=await turnRecord(asker,{companyId:p.companyId,at});
 const card=kind.startsWith('card_')?randomUUID():null;
 const [row]=await owner.db.insert(terasLearningSignal).values({tenantId:b.tenantId,companyId:p.companyId??b.companyId,recordId:record.id,
  signalKey:card?`card:${card}`:kind.startsWith('answer_')?'answer':'recommendation',kind,action:card?'leave.apply':kind.startsWith('answer_')?'answer':'approvals.leave.decide',
  area:'leave',role:p.role??'employee',locale:'en',proposalId:card,byUserId:asker.userId,at}).returning();
 return row;
}
const pgText=(error:unknown)=>{const parts:string[]=[];for(let cur=error as Record<string,unknown>|undefined,n=0;cur&&typeof cur==='object'&&n<5;cur=cur.cause as never,n++)
 for(const key of ['message','detail','code','reason'])if(typeof cur[key]==='string')parts.push(cur[key] as string);return parts.join(' | ');};
const refusedWith=async(promise:Promise<unknown>,pattern:RegExp)=>{let error:unknown=null;try{await promise;}catch(e){error=e;}expect(error,'expected a refusal').not.toBeNull();expect(pgText(error)).toMatch(pattern);};

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-learning-loops-proposal-secret-0123456789abcdef');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-learning-loops-chat-passphrase-0123456789');
 await resetDb();b=await seedBase();
 group=await login(b,'Fictional Group Administrator','hr_admin');
 employee=await login(b,'Fictional Employee','employee');employee={...employee,grants:[{role:'employee',companyId:b.companyId}]};
 manager=await login(b,'Fictional Manager','manager');manager={...manager,grants:[{role:'manager',companyId:b.companyId}]};
 const [co]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Sdn Bhd'}).returning();
 const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:co.id,name:'Fictional Ops'}).returning();
 second={id:co.id,dept:dept.id};
});

describe('capturing what people did',()=>{
 it('learns from the agent identities the turn and the recommender write',()=>{
  expect([ASSISTANT_TURN_IDENTITY,RECOMMENDER_IDENTITY]).toEqual([ASSISTANT_AGENT_IDENTITY,RECOMMENDER_AGENT_IDENTITY]);
 });

 it('records a card\'s Confirm, Edit and Discard once each, for the person\'s own turn',async()=>{
  const record=await turnRecord(employee);
  const [confirmed,edited,discarded]=[card(employee),card(employee,'attendance.correction.request'),card(employee,'claims.submit')];
  expect(await recordCardSignal(employee,{proposal:confirmed,turnId:record.runId,signal:'card_confirmed',locale:'ms'})).toEqual({recorded:true});
  // The first stands: a repeat, or another button on the same card, records nothing.
  expect(await recordCardSignal(employee,{proposal:confirmed,turnId:record.runId,signal:'card_confirmed',locale:'ms'})).toEqual({recorded:false});
  expect(await recordCardSignal(employee,{proposal:confirmed,turnId:record.runId,signal:'card_discarded',locale:'ms'})).toEqual({recorded:false});
  expect(await recordCardSignal(employee,{proposal:edited,turnId:record.runId,signal:'card_edited',locale:'en'})).toEqual({recorded:true});
  expect(await recordCardSignal(employee,{proposal:discarded,turnId:record.runId,signal:'card_discarded',locale:'zz'})).toEqual({recorded:true});
  const rows=await owner.db.select().from(terasLearningSignal).where(eq(terasLearningSignal.tenantId,b.tenantId)).orderBy(terasLearningSignal.at);
  expect(rows.map(row=>[row.kind,row.action,row.area,row.role,row.locale,row.proposalId,row.recordId,row.companyId,row.byUserId])).toEqual([
   ['card_confirmed','leave.apply','leave','employee','ms',confirmed.body.id,record.id,b.companyId,employee.userId],
   ['card_edited','attendance.correction.request','attendance','employee','en',edited.body.id,record.id,b.companyId,employee.userId],
   ['card_discarded','claims.submit','claims','employee','en',discarded.body.id,record.id,b.companyId,employee.userId]]);
  // The person may read their own signals; nothing of anyone else's.
  expect((await withTenant(employee,tx=>tx.select().from(terasLearningSignal))).length).toBe(3);
  expect(await withTenant(manager,tx=>tx.select().from(terasLearningSignal))).toEqual([]);
 });

 it('never records for a gated turn, another login\'s turn or a forged card, and the database refuses a direct write',async()=>{
  const gated=await turnRecord(employee,{privateToAsker:true});
  const others=await turnRecord(manager);
  expect(await recordCardSignal(employee,{proposal:card(employee),turnId:gated.runId,signal:'card_discarded'})).toEqual({recorded:false});
  expect(await recordAnswerMark(employee,{turnId:gated.runId,helpful:false})).toEqual({recorded:false,mark:null,canChange:false});
  expect(await recordGapFromTurn(employee,{turnId:gated.runId,turn:gapTurn(),question:'I am being harassed by my manager',companyId:b.companyId})).toEqual({captured:false});
  expect(await recordCardSignal(employee,{proposal:card(employee),turnId:others.runId,signal:'card_edited'})).toEqual({recorded:false});
  expect(await recordAnswerMark(employee,{turnId:others.runId,helpful:true})).toEqual({recorded:false,mark:null,canChange:false});
  const own=await turnRecord(employee);
  // Someone else's card, a tampered card and an agent are refused before any write.
  expect(await recordCardSignal(employee,{proposal:card(manager),turnId:own.runId,signal:'card_confirmed'})).toEqual({recorded:false});
  const forged=JSON.parse(JSON.stringify(card(employee)));forged.body.what.action='claims.submit';
  expect(await recordCardSignal(employee,{proposal:forged,turnId:own.runId,signal:'card_confirmed'})).toEqual({recorded:false});
  expect(await recordCardSignal({...employee,agent:{principalId:randomUUID(),enablements:[]}} as SessionContext,{proposal:card(employee),turnId:own.runId,signal:'card_confirmed'})).toEqual({recorded:false});
  expect(await owner.db.select().from(terasLearningSignal)).toEqual([]);
  expect(await owner.db.select().from(terasGapOccurrence)).toEqual([]);
  // Directly, the 0972 policies refuse a gated turn's record and another login's record.
  for(const record of [gated,others])await refusedWith(withTenant(employee,tx=>tx.insert(terasLearningSignal).values({tenantId:b.tenantId,companyId:b.companyId,recordId:record.id,
   signalKey:'answer',kind:'answer_unhelpful',action:'answer',area:'general',role:'employee',locale:'en',byUserId:employee.userId})),/row-level security/i);
  // A gap is counted only through the asker's own note on their own open turn: a gated turn's record is refused there.
  for(const record of [gated,others])await refusedWith(withTenant(employee,tx=>tx.insert(terasGapTurn).values({tenantId:b.tenantId,recordId:record.id,companyId:b.companyId,
   byUserId:employee.userId})),/row-level security/i);
  expect(await owner.db.select().from(terasGapTurn)).toEqual([]);
  // Nor may a signal name a company other than its turn's, or be attributed to someone else.
  await refusedWith(withTenant(employee,tx=>tx.insert(terasLearningSignal).values({tenantId:b.tenantId,companyId:second.id,recordId:own.id,
   signalKey:'answer',kind:'answer_unhelpful',action:'answer',area:'general',role:'employee',locale:'en',byUserId:employee.userId})),/row-level security/i);
  await refusedWith(withTenant(employee,tx=>tx.insert(terasLearningSignal).values({tenantId:b.tenantId,companyId:b.companyId,recordId:own.id,
   signalKey:'answer',kind:'answer_unhelpful',action:'answer',area:'general',role:'employee',locale:'en',byUserId:manager.userId})),/row-level security/i);
  // And signals are append-only.
  const row=await signalRow(employee,'answer_unhelpful');
  await refusedWith(owner.db.update(terasLearningSignal).set({kind:'answer_helpful'}).where(eq(terasLearningSignal.id,row.id)),/append-only/i);
  await refusedWith(withTenant(group,tx=>tx.delete(terasLearningSignal).where(eq(terasLearningSignal.id,row.id))),/permission denied|append-only/i);
 });

 it('records an answer marked helpful or not, with its optional reason, changeable once, with the area its reads came from',async()=>{
  const leave=await turnRecord(employee,{reads:[{tool:'my_leave_balances',status:'ok'}]}),plain=await turnRecord(employee);
  // "Not helpful" is recorded at once; the reason chip then adds the reason, once.
  expect(await recordAnswerMark(employee,{turnId:leave.runId,helpful:false,locale:'vi'})).toEqual({recorded:true,mark:'unhelpful',canChange:true});
  expect(await recordAnswerMark(employee,{turnId:leave.runId,helpful:false,reason:'not_what_asked',locale:'vi'})).toEqual({recorded:true,mark:'unhelpful',canChange:true});
  expect(await recordAnswerMark(employee,{turnId:leave.runId,helpful:false,reason:'wrong'})).toEqual({recorded:false,mark:'unhelpful',canChange:true});
  // Changed once to "Helpful": the change counts instead; a third choice records nothing.
  expect(await recordAnswerMark(employee,{turnId:leave.runId,helpful:true})).toEqual({recorded:true,mark:'helpful',canChange:false});
  expect(await recordAnswerMark(employee,{turnId:leave.runId,helpful:false})).toEqual({recorded:false,mark:'helpful',canChange:false});
  expect(await recordAnswerMark(employee,{turnId:plain.runId,helpful:true})).toEqual({recorded:true,mark:'helpful',canChange:true});
  // Malformed: a non-boolean mark, a reason on "Helpful", an unknown reason.
  for(const input of [{helpful:'yes'},{helpful:true,reason:'wrong'},{helpful:false,reason:'rude'}])
   expect(await recordAnswerMark(employee,{turnId:plain.runId,...input})).toEqual({recorded:false,mark:null,canChange:false});
  const rows=await owner.db.select().from(terasLearningSignal).orderBy(terasLearningSignal.at);
  expect(rows.map(row=>[row.recordId,row.kind,row.area,row.locale,row.signalKey,row.reason])).toEqual([[leave.id,'answer_unhelpful','leave','vi','answer','not_what_asked'],
   [leave.id,'answer_helpful','leave','en','answer_changed',null],[plain.id,'answer_helpful','general','en','answer',null]]);
  // Only the latest mark counts: two helpful, none unhelpful; and no correction to review for the changed answer.
  const view=await aiQuality(group);
  expect(view.figures.helpful).toEqual({part:2,whole:2,share:1});
  expect(view.corrections).toEqual([]);
  // The database lets only the person add a missing reason to their own "Not helpful", nothing else.
  const fresh=await turnRecord(employee);
  await recordAnswerMark(employee,{turnId:fresh.runId,helpful:false});
  const [mark]=await owner.db.select().from(terasLearningSignal).where(eq(terasLearningSignal.recordId,fresh.id));
  expect((await aiQuality(group)).corrections.map(row=>[row.kind,row.reason])).toEqual([['answer_unhelpful',null]]);
  await refusedWith(withTenant(employee,tx=>tx.update(terasLearningSignal).set({kind:'answer_helpful'}).where(eq(terasLearningSignal.id,mark.id))),/permission denied/i);
  expect(await withTenant(manager,tx=>tx.update(terasLearningSignal).set({reason:'wrong'}).where(eq(terasLearningSignal.id,mark.id)).returning())).toEqual([]);
  expect(await withTenant(employee,tx=>tx.update(terasLearningSignal).set({reason:'missing_something'}).where(eq(terasLearningSignal.id,mark.id)).returning({reason:terasLearningSignal.reason}))).toEqual([{reason:'missing_something'}]);
  await refusedWith(withTenant(employee,tx=>tx.update(terasLearningSignal).set({reason:'wrong'}).where(eq(terasLearningSignal.id,mark.id))),/append-only/i);
  expect((await aiQuality(group)).corrections.map(row=>[row.kind,row.reason])).toEqual([['answer_unhelpful','missing_something']]);
 });

 it('records a recommendation not followed only once the recommender\'s own follow-up says so',async()=>{
  const record=await turnRecord(manager,{agent:'worker.approver_recommendation'});
  expect(await recordRecommendationSignal(manager,{recordId:record.id})).toEqual({recorded:false});
  await owner.db.insert(terasOutcomeFollowup).values({tenantId:b.tenantId,recordId:record.id,kind:'decision',decision:'rejected',humanInvolvement:'decided',byUserId:manager.userId});
  expect(await recordRecommendationSignal(employee,{recordId:record.id})).toEqual({recorded:false});
  expect(await recordRecommendationSignal(manager,{recordId:record.id,locale:'zh'})).toEqual({recorded:true});
  expect(await recordRecommendationSignal(manager,{recordId:record.id})).toEqual({recorded:false});
  // A chat turn is not a recommendation.
  const turn=await turnRecord(manager);
  await owner.db.insert(terasOutcomeFollowup).values({tenantId:b.tenantId,recordId:turn.id,kind:'decision',decision:'rejected',humanInvolvement:'decided',byUserId:manager.userId});
  expect(await recordRecommendationSignal(manager,{recordId:turn.id})).toEqual({recorded:false});
  expect((await owner.db.select().from(terasLearningSignal)).map(row=>[row.kind,row.role,row.locale,row.action,row.area])).toEqual([['recommendation_rejected','manager','zh','approvals.leave.decide','approvals']]);
 });

 it('counts a gap with its intent, once, and stores no words; an answered or gated turn is not one',async()=>{
  const record=await turnRecord(employee);
  expect(await recordGapFromTurn(employee,{turnId:record.runId,turn:gapTurn(),question:'Can you show me the payslip of Siti Rahman for RM4,200?',companyId:b.companyId,locale:'en'}))
   .toEqual({captured:true,intentKey:'not_supported:payroll'});
  // Only once per turn.
  expect(await recordGapFromTurn(employee,{turnId:record.runId,turn:gapTurn(),question:'again',companyId:b.companyId})).toEqual({captured:false});
  // The occurrence: closed vocabularies and the Malaysian day only (the repository's HR date owner gives today).
  const [occurrence]=await owner.db.select().from(terasGapOccurrence);
  expect(Object.keys(occurrence).sort()).toEqual(['area','companyId','id','intentKey','kind','locale','role','seenOn','tenantId']);
  expect([occurrence.kind,occurrence.area,occurrence.intentKey,occurrence.role,occurrence.locale,occurrence.companyId,occurrence.seenOn])
   .toEqual(['not_supported','payroll','not_supported:payroll','employee','en',b.companyId,todayInKualaLumpur()]);
  // No word of the question is anywhere in the learning tables, nor in the asker's note.
  for(const table of ['teras_learning_signal','teras_learning_signal_review','teras_gap_turn','teras_gap_occurrence','teras_gap_status','teras_eval_candidate']){
   const [row]=await owner.db.execute(sql`select coalesce(string_agg(row_to_json(t)::text,' '),'') as text from ${sql.identifier(table)} t`) as unknown as {text:string}[];
   expect(row.text,table).not.toMatch(/Siti|Rahman|4,200|payslip|again/i);
  }
  // The person who asked reads their own note and not the occurrence; nobody else reads the note.
  expect((await withTenant(employee,tx=>tx.select().from(terasGapTurn))).map(row=>[row.recordId,row.companyId,row.byUserId])).toEqual([[record.id,b.companyId,employee.userId]]);
  expect(await withTenant(employee,tx=>tx.select().from(terasGapOccurrence))).toEqual([]);
  for(const other of [group,manager])expect(await withTenant(other,tx=>tx.select().from(terasGapTurn))).toEqual([]);
  // Gated, answered, or a different company than the turn's: nothing.
  for(const turn of [gapTurn({sensitive:true}),gapTurn({refused:true}),gapTurn({mode:'answer'}),gapTurn({fallback:true})]){
   const other=await turnRecord(employee);
   expect(await recordGapFromTurn(employee,{turnId:other.runId,turn,question:'What is my leave?',companyId:b.companyId})).toEqual({captured:false});
  }
  const elsewhere=await turnRecord(employee);
  expect(await recordGapFromTurn(employee,{turnId:elsewhere.runId,turn:gapTurn(),question:'Can you run payroll?',companyId:second.id})).toEqual({captured:false});
  expect(await owner.db.select().from(terasGapOccurrence)).toHaveLength(1);
  expect(await owner.db.select().from(terasGapTurn)).toHaveLength(1);
  // The database refuses an occurrence without its writer's own note from the same transaction, a note for another login's
  // turn, and any change to either.
  await refusedWith(withTenant(employee,tx=>tx.insert(terasGapOccurrence).values({tenantId:b.tenantId,companyId:b.companyId,kind:'cannot_answer',area:'general',
   intentKey:'cannot_answer:general',role:'employee',locale:'en'})),/row-level security/i);
  const peers=await turnRecord(manager);
  await refusedWith(withTenant(employee,tx=>tx.insert(terasGapTurn).values({tenantId:b.tenantId,recordId:peers.id,companyId:b.companyId,byUserId:employee.userId})),/row-level security/i);
  await refusedWith(owner.db.update(terasGapOccurrence).set({area:'leave'}).where(eq(terasGapOccurrence.id,occurrence.id)),/append-only/i);
  await refusedWith(owner.db.update(terasGapTurn).set({companyId:second.id}),/append-only/i);
  // The backlog keeps intent, area, count, first and last seen, and status: no words.
  const view=await aiQuality(group);
  expect(view.gaps).toEqual([{intentKey:'not_supported:payroll',kind:'not_supported',area:'payroll',count:1,roles:['employee'],firstSeen:todayInKualaLumpur(),
   lastSeen:todayInKualaLumpur(),statuses:[{companyId:b.companyId,status:'open',duplicateOf:null}],status:'open',rank:1}]);
 });

 it('links no gap to the person who asked, for any administrator, even one who reads the turn\'s outcome record and its signals',async()=>{
  const record=await turnRecord(employee),chatId=await storedChat(employee);
  expect(await recordGapFromTurn(employee,{turnId:record.runId,turn:gapTurn(),question:'Can you show me the payroll calendar?',companyId:b.companyId,locale:'ms'}))
   .toMatchObject({captured:true});
  // The same turn marked not helpful: a signal an administrator reads, which names the turn's record and its writer.
  expect(await recordAnswerMark(employee,{turnId:record.runId,helpful:false,locale:'ms'})).toMatchObject({recorded:true});
  // A group administrator may read the outcome record itself (0928) and the signal, so a gap that named either would name
  // the asker. The gap names neither: no record, login, chat, person or time finer than the day.
  expect((await withTenant(group,tx=>tx.select({asker:terasOutcomeRecord.askedByUserId}).from(terasOutcomeRecord).where(eq(terasOutcomeRecord.id,record.id))))).toEqual([{asker:employee.userId}]);
  const [signal]=await withTenant(group,tx=>tx.select().from(terasLearningSignal));
  expect([signal.recordId,signal.byUserId]).toEqual([record.id,employee.userId]);
  const gaps=await withTenant(group,tx=>tx.select().from(terasGapOccurrence));
  expect(gaps).toHaveLength(1);
  const seen=JSON.stringify(gaps);
  for(const id of [record.id,record.runId,employee.userId,employee.personId,employee.employmentId,chatId,signal.id])expect(seen).not.toContain(id);
  expect(seen).not.toMatch(/T\d{2}:\d{2}/);
  // Nothing an administrator reads joins them: the note that holds the record is the asker's alone.
  expect(await withTenant(group,tx=>tx.select().from(terasGapTurn))).toEqual([]);
  expect((await aiQuality(group)).gaps.map(row=>[row.intentKey,row.count,Object.keys(row).sort()])).toEqual([['not_supported:payroll',1,
   ['area','count','firstSeen','intentKey','kind','lastSeen','rank','roles','status','statuses']]]);
  // The person deleting the chat changes nothing about the count: a gap keeps nothing from a chat.
  expect(await deleteOwnChat(employee,chatId)).toBe(1);
  expect(await owner.db.select().from(terasGapOccurrence)).toHaveLength(1);
 });

 it('answers ai_quality_summary for an administrator as the page shows it, with no example, name or person; refuses anyone else',async()=>{
  for(const kind of ['card_confirmed','card_confirmed','card_confirmed','card_edited','answer_helpful','answer_unhelpful'] as const)await signalRow(employee,kind);
  const record=await turnRecord(employee);
  await recordGapFromTurn(employee,{turnId:record.runId,turn:gapTurn(),question:'Can Siti Rahman see the payroll of Wei Ling?',companyId:b.companyId});
  const answer=await askAiQuality(group,{period:'last30'}) as Record<string,unknown>;
  expect(answer).toMatchObject({ok:true,period:{name:'last30'},companies:2,helpful:{percent:50,count:1,of:2},confirmedUnchanged:{percent:75,count:3,of:4},
   edited:{percent:25,count:1,of:4},discarded:{percent:0,count:0,of:4},openGaps:{intents:1,questions:{percent:100,count:1,of:1}},
   topGaps:[{kind:'not_supported',area:'payroll',count:1,status:'open'}],openProposals:0});
  // No example, name or placeholder of one: the read carries counts and closed names only.
  expect(JSON.stringify(answer)).not.toMatch(/Siti|Rahman|Wei|Ling|NAME_|\{\{/);
  for(const id of [b.tenantId,b.companyId,employee.userId,record.id])expect(JSON.stringify(answer)).not.toContain(id);
  expect(await askAiQuality(employee,{})).toMatchObject({ok:false,refusal:'not_permitted'});
  expect(await askAiQuality(manager,{})).toMatchObject({ok:false,refusal:'not_permitted'});
  // Offered to administrators only.
  expect(TERAS_CAPABILITIES.find(row=>row.name==='ai_quality_summary')).toMatchObject({admin:true,module:null,worker:null});
 });
});

describe('who reads and decides',()=>{
 it('refuses an employee, a manager and an agent before any read or decision',async()=>{
  const agent={...group,agent:{principalId:randomUUID(),enablements:[]}} as SessionContext;
  for(const ctx of [employee,manager,agent]){
   await expect(aiQuality(ctx)).rejects.toMatchObject({name:'LearningRefused',reason:'not_administrator'});
   await expect(reviewSignal(ctx,{signalId:randomUUID()},'dismissed')).rejects.toMatchObject({reason:'not_administrator'});
   await expect(setGapStatus(ctx,{companyIds:[b.companyId],intentKey:'cannot_answer:leave',status:'planned'})).rejects.toMatchObject({reason:'not_administrator'});
   await expect(decideLoopProposal(ctx,{companyId:b.companyId,proposalKey:'a'.repeat(64),decision:'approved'})).rejects.toMatchObject({reason:'not_administrator'});
  }
 });

 it('shows each administrator only the companies they administer, and nothing crosses a tenant',async()=>{
  const worker=await login(b,'Fictional Second Worker','employee',second.id,second.dept);
  const scoped=await companyAdmin(b,second.id,second.dept);
  await signalRow(employee,'card_edited');
  await signalRow(worker,'answer_unhelpful',{companyId:second.id});
  const all=await aiQuality(group);
  expect(all.companies.map(row=>row.name)).toEqual(['Acme Sdn Bhd','Fictional Second Sdn Bhd']);
  expect(all.corrections.map(row=>[row.kind,row.companyId]).sort()).toEqual([['answer_unhelpful',second.id],['card_edited',b.companyId]].sort());
  // The second company's own administrator: its signal only, even when asking for the first company.
  const own=await aiQuality(scoped,{companyId:b.companyId});
  expect(own.companies.map(row=>row.id)).toEqual([second.id]);
  expect(own.corrections.map(row=>row.kind)).toEqual(['answer_unhelpful']);
  expect((await withTenant(scoped,tx=>tx.select().from(terasLearningSignal))).map(row=>row.companyId)).toEqual([second.id]);
  await expect(setGapStatus(scoped,{companyIds:[b.companyId],intentKey:'cannot_answer:leave',status:'planned'})).rejects.toMatchObject({reason:'not_administrator'});
  // Another tenant sees none of it.
  const b2=await seedBase();
  const foreign=await login(b2,'Fictional Other Tenant Administrator','hr_admin');
  const view=await aiQuality(foreign,{companyId:second.id});
  expect(view.companies.map(row=>row.id)).toEqual([b2.companyId]);
  expect(view.corrections).toEqual([]);expect(view.figures.prepared.decided).toBe(0);
  for(const table of [terasLearningSignal,terasLearningSignalReview,terasGapOccurrence,terasGapTurn,terasGapStatus,terasEvalCandidate])
   expect(await withTenant(foreign,tx=>tx.select().from(table))).toEqual([]);
 });
});

describe('the figures',()=>{
 it('works out each tile and the trend from the records, by hand',async()=>{
  const worker=await login(b,'Fictional Second Worker','employee',second.id,second.dept);
  // First company: 3 cards confirmed, 1 edited, 1 discarded; 2 answers helpful, 1 not. Second: 1 discarded.
  for(const kind of ['card_confirmed','card_confirmed','card_confirmed','card_edited','card_discarded','answer_helpful','answer_helpful','answer_unhelpful'] as const)await signalRow(employee,kind);
  await signalRow(worker,'card_discarded',{companyId:second.id});
  // Loop cards in the first company: 4 completed as prepared, 1 changed; one with no value of its own (not counted).
  for(const resolution of ['as_prepared','as_prepared','as_prepared','as_prepared','changed','completed'] as const)await owner.db.execute(sql`insert into public.teras_loop_case
   (tenant_id,worker_id,company_id,employment_id,subject_key,recipient,state,close_reason,resolution,facts,first_opened_at,opened_at,checked_at,closed_at,opened_run_id,checked_run_id)
   values (${b.tenantId}::uuid,'loop_missed_clock_outs',${b.companyId}::uuid,${employee.employmentId}::uuid,${'clockout:'+randomUUID()},'employee','closed','done',${resolution},'{}'::jsonb,
    now()-interval '3 days',now()-interval '3 days',now()-interval '2 days',now()-interval '2 days',${randomUUID()}::uuid,${randomUUID()}::uuid)`);
  // Gaps: 3 on one open intent, 1 on an intent marked planned.
  for(const intentKey of ['not_supported:payroll','not_supported:payroll','not_supported:payroll','cannot_answer:leave']){
   const record=await turnRecord(employee);
   const [kind,area]=intentKey.split(':') as ['not_supported'|'cannot_answer',string];
   await owner.db.insert(terasGapOccurrence).values({tenantId:b.tenantId,companyId:b.companyId,recordId:record.id,kind,area,intentKey,role:'employee',locale:'en',at:new Date(Date.now()-DAY)});
  }
  await setGapStatus(group,{companyIds:[b.companyId],intentKey:'cannot_answer:leave',status:'planned'});
  const view=await aiQuality(group);
  // Helpful: 2 of 3 marked. Decided prepared actions: chat 3+1+1+1 = 6, loop 4+1 = 5 -> 11. Unchanged 3+4 = 7, edited 1+1 = 2, discarded 2.
  expect(view.figures.helpful).toEqual({part:2,whole:3,share:2/3});
  expect(view.figures.prepared).toEqual({decided:11,chatCards:6,loopCards:5,unchanged:{part:7,whole:11,share:7/11},edited:{part:2,whole:11,share:2/11},
   discarded:{part:2,whole:11,share:2/11}});
  // Open gaps: one intent (payroll), 3 of the 4 gap questions.
  expect(view.figures.gaps).toEqual({openIntents:1,questions:4,openQuestions:{part:3,whole:4,share:0.75}});
  expect(view.gaps.map(row=>[row.intentKey,row.count,row.status])).toEqual([['not_supported:payroll',3,'open'],['cannot_answer:leave',1,'planned']]);
  // The first company alone: the second's discarded card is not counted.
  const first=await aiQuality(group,{companyId:b.companyId});
  expect(first.figures.prepared).toMatchObject({decided:10,discarded:{part:1,whole:10,share:0.1}});
  // This month's bar holds everything decided two days ago (when that is still this month); older months are empty.
  const recent=view.figures.trend.filter(row=>row.decided>0);
  expect(recent.reduce((total,row)=>total+row.decided,0)).toBe(11);
  expect(recent.reduce((total,row)=>total+row.unchanged,0)).toBe(7);
 });
});

describe('reviewing corrections and eval candidates',()=>{
 it('dismisses and reopens a correction, each a new version',async()=>{
  const signal=await signalRow(employee,'card_discarded');
  expect((await aiQuality(group)).corrections.map(row=>row.id)).toEqual([signal.id]);
  expect(await reviewSignal(group,{signalId:signal.id},'dismissed')).toEqual({version:1});
  expect((await aiQuality(group)).corrections).toEqual([]);
  await expect(reviewSignal(group,{signalId:signal.id},'dismissed')).rejects.toMatchObject({reason:'state'});
  expect(await reviewSignal(group,{signalId:signal.id},'reopened')).toEqual({version:2});
  expect((await aiQuality(group)).corrections.map(row=>row.id)).toEqual([signal.id]);
  expect((await owner.db.select().from(terasLearningSignalReview).orderBy(terasLearningSignalReview.version)).map(row=>[row.decision,row.version,row.byUserId]))
   .toEqual([['dismissed',1,group.userId],['reopened',2,group.userId]]);
  // A confirmed card needs no correction and cannot be reviewed.
  const fine=await signalRow(employee,'card_confirmed');
  await expect(reviewSignal(group,{signalId:fine.id},'dismissed')).rejects.toMatchObject({reason:'not_found'});
  await refusedWith(owner.db.delete(terasLearningSignalReview),/append-only/i);
 });

 it('redacts a candidate on every save, exports it only after approval, and keeps it final once exported',async()=>{
  const signal=await signalRow(employee,'answer_unhelpful');
  const created=await promoteSignal(group,{signalId:signal.id,question:'Can Wei Ling claim RM88 for parking on 2026-10-02? Her number is 012-3456789',
   expectation:'Says yes and prepares the claim for Wei Ling dated 2026-10-02, for her to confirm.',kind:'do',factor:'doing'});
  expect(created.version).toBe(1);
  const [row]=await owner.db.select().from(terasEvalCandidate);
  expect([row.question,row.expectation,row.state,row.role,row.locale,row.signalId,row.createdByUserId]).toEqual([
   'Can {{NAME_A}} {{NAME_B}} claim {{AMOUNT_A}} for parking on {{DATE_A}}? Her number is {{PHONE_A}}',
   'Says yes and prepares the claim for {{NAME_A}} {{NAME_B}} dated {{DATE_A}}, for her to confirm.','draft','employee','en',signal.id,group.userId]);
  // The correction leaves the list once it is a candidate; it cannot be promoted twice.
  expect((await aiQuality(group)).corrections).toEqual([]);
  await expect(promoteSignal(group,{signalId:signal.id,question:'q',expectation:'e',kind:'answer',factor:'facts'})).rejects.toMatchObject({reason:'state'});
  // Not exported before it is approved.
  await expect(markCandidateExported(group,{candidateId:row.id})).rejects.toMatchObject({reason:'state'});
  await expect(candidateExportFile(group,{candidateId:row.id})).rejects.toMatchObject({reason:'not_found'});
  // A stale screen cannot overwrite a newer version.
  expect(await editCandidate(group,{candidateId:row.id,version:1,question:'Can Wei Ling claim parking from last Tuesday?',expectation:'Prepares the claim for her to confirm.',kind:'do',factor:'doing'}))
   .toEqual({id:row.id,version:2});
  await expect(moveCandidate(group,{candidateId:row.id,version:1},'approve')).rejects.toMatchObject({reason:'changed'});
  // Another company's administrator cannot touch it.
  const scoped=await companyAdmin(b,second.id,second.dept);
  await expect(moveCandidate(scoped,{candidateId:row.id,version:2},'approve')).rejects.toMatchObject({reason:'not_found'});
  expect(await moveCandidate(group,{candidateId:row.id,version:2},'approve')).toMatchObject({version:3,state:'approved'});
  // Approved text is fixed: the database refuses a change that is not a draft's, or by anyone but the current administrator.
  await refusedWith(withTenant(group,tx=>tx.update(terasEvalCandidate).set({question:'Something else',version:4,changedByUserId:group.userId}).where(eq(terasEvalCandidate.id,row.id))),/state approved cannot become approved/i);
  await refusedWith(withTenant(group,tx=>tx.update(terasEvalCandidate).set({state:'draft',question:'Something else',version:4,changedByUserId:group.userId,approvedByUserId:null,approvedAt:null})
   .where(eq(terasEvalCandidate.id,row.id))),/only while it is a draft/i);
  expect(await markCandidateExported(group,{candidateId:row.id})).toEqual({id:row.id,version:4});
  const file=await candidateExportFile(group,{candidateId:row.id});
  expect(file.text).toContain("question:'Can Siti Fictional Wei Fictional claim parking from last Tuesday?',locale:'en',");
  expect(file.text).toContain("ideal:'Prepares the claim for her to confirm.'}]},");
  for(const id of [b.tenantId,b.companyId,group.userId,employee.userId,signal.id,signal.recordId,row.id])expect(file.text).not.toContain(id);
  expect(file.text).not.toMatch(/\{\{|Wei Ling/);
  // Exported is final.
  await expect(moveCandidate(group,{candidateId:row.id,version:4},'withdraw')).rejects.toMatchObject({reason:'state'});
  await refusedWith(owner.db.delete(terasEvalCandidate),/never deleted/i);
  const events=await owner.db.select({type:schema.domainEvent.eventType}).from(schema.domainEvent)
   .where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.aggregateType,'teras-learning')));
  expect(events.map(event=>event.type).sort()).toEqual(['teras-learning.candidate-approved','teras-learning.candidate-created','teras-learning.candidate-edited',
   'teras-learning.candidate-exported','teras-learning.signal-reviewed'].sort());
 });

 it('refuses text that redaction cannot clean, and makes a gap intent a candidate with its most common role and locale',async()=>{
  const record=await turnRecord(employee);
  await owner.db.insert(terasGapOccurrence).values({tenantId:b.tenantId,companyId:b.companyId,recordId:record.id,kind:'no_route',area:'claims',intentKey:'no_route:claims',role:'employee',locale:'ms'});
  const created=await promoteGap(group,{companyId:b.companyId,intentKey:'no_route:claims',question:'Boleh anda hantar tuntutan perjalanan saya?',expectation:'Prepares the travel claim for one Confirm.',
   kind:'do',factor:'doing'});
  const [row]=await owner.db.select().from(terasEvalCandidate).where(eq(terasEvalCandidate.id,created.id));
  expect([row.intentKey,row.role,row.locale,row.signalId]).toEqual(['no_route:claims','employee','ms',null]);
  await expect(promoteGap(group,{companyId:b.companyId,intentKey:'not_supported:payroll',question:'q',expectation:'e',kind:'answer',factor:'facts'})).rejects.toMatchObject({reason:'not_found'});
  // The database refuses digits or an "@" in a stored candidate, whoever writes it.
  await refusedWith(withTenant(group,tx=>tx.insert(terasEvalCandidate).values({tenantId:b.tenantId,companyId:b.companyId,intentKey:'no_route:claims',role:'employee',locale:'en',
   kind:'do',factor:'doing',question:'Claim RM88',expectation:'ok',redactionVersion:1,createdByUserId:group.userId,changedByUserId:group.userId})),/check constraint/i);
 });

 it('sets a gap\'s status per company as versions, and sets it back',async()=>{
  const record=await turnRecord(employee);
  await owner.db.insert(terasGapOccurrence).values({tenantId:b.tenantId,companyId:b.companyId,recordId:record.id,kind:'cannot_answer',area:'leave',intentKey:'cannot_answer:leave',role:'employee',locale:'en'});
  expect(await setGapStatus(group,{companyIds:[b.companyId],intentKey:'cannot_answer:leave',status:'planned'})).toEqual({changed:1});
  expect(await setGapStatus(group,{companyIds:[b.companyId],intentKey:'cannot_answer:leave',status:'planned'})).toEqual({changed:0});
  await expect(setGapStatus(group,{companyIds:[b.companyId],intentKey:'cannot_answer:leave',status:'duplicate'})).rejects.toMatchObject({reason:'invalid'});
  expect(await setGapStatus(group,{companyIds:[b.companyId],intentKey:'cannot_answer:leave',status:'duplicate',duplicateOf:'not_supported:leave'})).toEqual({changed:1});
  expect(await setGapStatus(group,{companyIds:[b.companyId],intentKey:'cannot_answer:leave',status:'open'})).toEqual({changed:1});
  expect((await owner.db.select().from(terasGapStatus).orderBy(terasGapStatus.version)).map(row=>[row.status,row.duplicateOf,row.version]))
   .toEqual([['planned',null,1],['duplicate','not_supported:leave',2],['open',null,3]]);
  expect((await aiQuality(group)).gaps.map(row=>row.status)).toEqual(['open']);
  await refusedWith(owner.db.update(terasGapStatus).set({status:'wont_do'}),/append-only/i);
 });
});

describe('the loops\' proposals',()=>{
 it('applies a threshold proposal only by an administrator, as a new settings version, and reverts it as another',async()=>{
  // Payroll HR cleared five net-swing flags as expected (20% to 24%) in the last 30 days.
  for(const swing of [2000,2100,2200,2300,2400]){
   const caseId=randomUUID();
   await owner.db.execute(sql`insert into public.teras_loop_case (id,tenant_id,worker_id,company_id,employment_id,subject_key,recipient,state,close_reason,resolution,facts,
     first_opened_at,opened_at,checked_at,closed_at,opened_run_id,checked_run_id)
    values (${caseId}::uuid,${b.tenantId}::uuid,'loop_salary_payroll',${b.companyId}::uuid,null,${`salaryrun:${randomUUID()}`},'payroll','closed','done','completed','{}'::jsonb,
     now()-interval '5 days',now()-interval '5 days',now()-interval '4 days',now()-interval '4 days',${randomUUID()}::uuid,${randomUUID()}::uuid)`);
   await owner.db.execute(sql`insert into public.teras_payroll_swing_disposition (tenant_id,case_id,company_id,employment_id,pay_period,pattern,swing_bp,threshold_bp,disposition,decided_by_user_id,decided_at)
    values (${b.tenantId}::uuid,${caseId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,'2026-10','cause:salary_change',${swing},1500,'expected',${group.userId}::uuid,now()-interval '3 days')`);
  }
  let view=await aiQuality(group);
  // Hand-worked: 80% of the 5 expected swings fall at or below the 4th (2300 bp), so 15% -> 23%; and the one pattern, all expected.
  expect(view.proposals.map(p=>[p.state,p.kind,p.fromThresholdBp,p.toThresholdBp,p.pattern,p.evidence.flags,p.evidence.expected])).toEqual([
   ['open','exclusion',1500,null,'cause:salary_change',5,5],['open','threshold',1500,2300,null,5,5]]);
  const threshold=view.proposals.find(p=>p.kind==='threshold')!;
  await expect(decideLoopProposal(employee,{companyId:b.companyId,proposalKey:threshold.proposalKey,decision:'approved'})).rejects.toMatchObject({reason:'not_administrator'});
  const scoped=await companyAdmin(b,second.id,second.dept);
  await expect(decideLoopProposal(scoped,{companyId:b.companyId,proposalKey:threshold.proposalKey,decision:'approved'})).rejects.toMatchObject({reason:'not_administrator'});
  // Nothing applies by itself.
  expect(await owner.db.select().from(terasPayrollLoopSetting)).toEqual([]);
  const approved=await decideLoopProposal(group,{companyId:b.companyId,proposalKey:threshold.proposalKey,decision:'approved'});
  expect(approved.setting).toMatchObject({version:1,swingThresholdBp:2300,source:'proposal'});
  view=await aiQuality(group);
  const applied=view.proposals.find(p=>p.state==='applied')!;
  expect([applied.kind,applied.fromThresholdBp,applied.toThresholdBp,applied.decisionId]).toEqual(['threshold',1500,2300,approved.decision.id]);
  await expect(revertLoopProposal(employee,{companyId:b.companyId,decisionId:applied.decisionId})).rejects.toMatchObject({reason:'not_administrator'});
  expect((await revertLoopProposal(group,{companyId:b.companyId,decisionId:applied.decisionId})).setting).toMatchObject({version:2,swingThresholdBp:1500,source:'admin'});
  // Reverted: no longer in force, so it cannot be reverted again; every version is kept.
  await expect(revertLoopProposal(group,{companyId:b.companyId,decisionId:applied.decisionId})).rejects.toMatchObject({reason:'changed'});
  expect((await owner.db.select().from(terasPayrollLoopSetting).orderBy(terasPayrollLoopSetting.version)).map(row=>[row.version,row.swingThresholdBp,row.source]))
   .toEqual([[1,2300,'proposal'],[2,1500,'admin']]);
  const [reverted]=await owner.db.select({payload:schema.domainEvent.payload,actorId:schema.domainEvent.actorId}).from(schema.domainEvent)
   .where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'teras-learning.proposal-reverted')));
  expect(reverted.actorId).toBe(group.userId);
  expect(reverted.payload).toMatchObject({companyId:b.companyId,decisionId:approved.decision.id,kind:'threshold',settingVersion:2,fromThresholdBp:1500,toThresholdBp:2300});
 });
});
