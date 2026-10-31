/** Authored UNRUN. Actual app-role source projections, issued config and gateway admission;
 * provider transport and its explicitly fictional monetary certificate are mocked.
 * No live provider/key, forged governance, source permissions or receipts. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import * as ai from '../lib/ai';
import * as governance from '../core/ai-governance';
import * as moduleGate from '../core/module-gate';
import {createArticle} from '../core/knowledge-base';
import {resolveActiveAiConfig} from '../core/ai-config';
import {bindPerformanceMessageSpend} from '../core/ai-spend-task';
import {AiSpendControlError} from '../core/ai-spend-capability';
import {AiAllowanceError} from '../lib/ai/types';
import {performanceAiErrorMessage} from '../packs/performance/onehr/ai-refusal';
import {installSyntheticSpendCapability} from './ai-spend-fixture';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {hireEmployee,setReportingLine} from '../core/org';
import * as perf from '../packs/performance/service';
import {askPerformanceGuide} from '../packs/performance/onehr/guide-service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {defaultPolicy} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import {createOnehrServiceFixtures,year} from './onehr-service-fixture';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import { switchOnPerformanceAi } from './performance-ai-switches-fixture';
let b:Base,a:SessionContext,self:SessionContext,mgr:SessionContext,subject:{employmentId:string;personId:string},manager:{employmentId:string;personId:string},peers:{employmentId:string;ctx:SessionContext}[],cycleId:string,reviewId:string;
let spendPrice:Awaited<ReturnType<typeof installSyntheticSpendCapability>>;
let beforeAdmission:(()=>Promise<void>)|undefined,sourceChange:Promise<void>|undefined,afterSourceReplay:(()=>Promise<void>)|undefined,alterInput=false;
const f=createOnehrServiceFixtures({get b(){return b;},get a(){return a;},get subject(){return subject;},get manager(){return manager;},get self(){return self;},get mgr(){return mgr;},get cycleId(){return cycleId;},get reviewId(){return reviewId;},get peers(){return peers;}});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{spendPrice?.restore();vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await resetDb();b=await seedBase();for(const code of ['performance','rewards'])await setModule(b.tenantId,code,'active');await switchOnPerformanceAi(b.tenantId);a=await entitledCtx(b);
 subject=await f.hire('Assessment subject');manager=await f.hire('Assessment manager');
 const actor=async(personId:string,role:'employee'|'manager'):Promise<SessionContext>=>({...a,userId:await createAppUser(b.tenantId,personId,role),personId,roles:[role],grants:undefined});
 self=await actor(subject.personId,'employee');mgr=await actor(manager.personId,'manager');peers=[];
 for(let i=0;i<4;i++){const person=await f.hire(`Peer ${i}`);peers.push({employmentId:person.employmentId,ctx:await actor(person.personId,'employee')});}
 const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Grade 12'}).returning();
 for(const person of [subject,manager,...peers])await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.id,person.employmentId));
 for(const person of [subject,...peers])await setReportingLine(a,{subordinateEmploymentId:person.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
 ({cycleId}=await perf.createCycle(a,{name:'Actual fictional source cycle',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`}));
 const policy=defaultPolicy(framework);policy.modules.evidence=true;policy.profiles=[{id:randomUUID(),companyId:b.companyId,grade:'12',name:'Engineering',competencies:[{id:'skill-1',principle:'Technical',text:'Current skill',future:false},{id:'skill-2',principle:'Technical',text:'Future skill',future:true}]}];
 await perf.configureOnehrCycle(a,cycleId,null,policy);await perf.openCycle(a,{cycleId});
 const [review]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,subject.employmentId)));reviewId=review.id;
 vi.stubEnv('OPENAI_API_KEY','fictional-admission-transport-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');beforeAdmission=undefined;sourceChange=undefined;afterSourceReplay=undefined;alterInput=false;
 const issued=await withTenant(a,tx=>resolveActiveAiConfig(tx,a,'performance_review'));if(!issued)throw Error('Missing actual fixture provider');spendPrice=await installSyntheticSpendCapability(a,{provider:issued.provider,model:issued.model});
 const issue=governance.withAiAdmissionCheck;vi.spyOn(governance,'withAiAdmissionCheck').mockImplementation((config,feature,check)=>issue(config,feature,async(tx,request)=>{await check(tx,request);const tail=afterSourceReplay;afterSourceReplay=undefined;if(tail)await tail();}));
 const original=ai.generateDraft;vi.spyOn(ai,'generateDraft').mockImplementation(async(cfg,args)=>{
  // Every concurrent call (the career plan sends two) waits for the one source change, so none reaches admission
  // first and holds source custody while the change is refused as busy.
  if(beforeAdmission){sourceChange=beforeAdmission();beforeAdmission=undefined;}if(sourceChange)await sourceChange;return original(cfg,alterInput?{...args,prompt:args.prompt+' CHANGED'}:args);});
 vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});if(args.system.includes('Performance guide'))return '{"items":[0],"unanswered":false}';if(args.system.includes('explicit user draft command'))return JSON.stringify({items:[0]});if(args.system.includes('longer-term career aspiration'))return '{"aspirationLong":"I aim to deepen my delivery practice."}';if(args.system.startsWith('Propose development goals'))return '[{"title":"Collaborative delivery","area":"Collaborative delivery","item_ids":["lp:0"],"experience":"Lead a delivery retrospective","exposure":"Seek colleague feedback","education":"Study facilitation"}]';return '{"items":[0]}';});
});
const runs=()=>owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,b.tenantId));
/** Owner decision: USD caps are OPTIONAL. The shared fixture configures a tenant USD cap for the native-rooted
 * Assistant/Guide spend tests. Legacy rootless drafting (narrative, development, career, competency insight,
 * colleague draft) has no native task root, so its cost cannot be reserved: under ANY configured cap it fails
 * closed (pinned below). The source-custody suites therefore run the no-cap configuration, where no USD ceiling
 * is promised and authorization, module, source, token and concurrency controls still apply in full. */
const withoutUsdCap=async()=>{await owner.db.execute(sql`delete from app.ai_spend_budget where tenant_id=${b.tenantId}::uuid`);};
async function alternativeNativeReviewer(){const next=await f.hire('Actual second-level manager');await setReportingLine(a,{subordinateEmploymentId:manager.employmentId,managerEmploymentId:next.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});return next;}
const sources=['narrative','guide','development','career'] as const;
type Source=typeof sources[number];
async function prepare(kind:Source){if(kind==='development'||kind==='career'){await f.complete();await perf.releaseOnehrResult(a,reviewId,'feedback',true);}}
const call=(kind:Source)=>kind==='narrative'?perf.draftOnehrNarrative(self,reviewId,'Completed the agreed delivery.'):kind==='guide'?askPerformanceGuide(self,'What are my current tasks?'):kind==='development'?perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID()):perf.suggestAssessmentCareerPlan(self,reviewId,randomUUID());
describe('OneHR legacy drafting replays actual native source before provider admission',()=>{
 beforeEach(withoutUsdCap);
 it.each(sources)('%s stable source reaches actual issued gateway and transport without saving a plan',async kind=>{await prepare(kind);await call(kind);expect(openaiAdapter.generate).toHaveBeenCalled();const observed=await runs();expect(observed.length).toBeGreaterThan(0);expect(observed.every(row=>row.state==='completed')).toBe(true);expect((await f.view(self)).plans).toEqual([]);});
 it.each(sources)('%s module revocation after gathering refuses before network or admission',async kind=>{await prepare(kind);beforeAdmission=()=>setModule(b.tenantId,'performance','disabled');await expect(call(kind)).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it.each(sources)('%s changed native source after gathering is never sent or charged',async kind=>{await prepare(kind);beforeAdmission=async()=>{if(kind==='narrative')await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Newly shared native source evidence.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]});else if(kind==='guide')await owner.db.update(schema.reviewCycle).set({name:'Changed native calendar name'}).where(eq(schema.reviewCycle.id,cycleId));else await owner.db.update(schema.onehrReview).set({selfRemark:'Changed native own assessment words'}).where(eq(schema.onehrReview.reviewId,reviewId));};const result=await Promise.allSettled([call(kind)]);if(kind==='guide')expect(result[0]).toMatchObject({status:'fulfilled',value:{mode:'search'}});else expect(result[0].status).toBe('rejected');expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it('an actually reassigned native reviewer loses drafting access before admission',async()=>{const next=await alternativeNativeReviewer(),revision=(await f.view(a)).revision;beforeAdmission=async()=>{await perf.reassignOnehrReviewer(a,reviewId,revision,next.employmentId);};await expect(perf.draftOnehrNarrative(mgr,reviewId,'Verified the agreed delivery.')).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it.each(sources)('%s altered outbound prompt cannot reuse the sealed native-source check',async kind=>{await prepare(kind);alterInput=true;await Promise.allSettled([call(kind)]);expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
});

// Additional real native owners using the shared same-transaction admission carrier.
async function assignedFeedback(){
 await perf.assignOnehrPanel(a,reviewId,(await f.view(a)).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));
 const request=(await perf.onehrAssignments(peers[0].ctx)).feedback.find(row=>row.subject==='Assessment subject');if(!request)throw Error('Missing actual assigned colleague feedback');return request.id;
}
describe('additional native insight and feedback admission',()=>{
 beforeEach(withoutUsdCap);
 it('current competency SQL projection reaches one governed provider call',async()=>{await f.complete(true,'',false,true);const source=await f.view(mgr);expect(source.competencies).toHaveLength(2);expect(source.competencies.map(row=>({self:row.self,remark:row.selfRemark}))).toEqual([{self:'yes',remark:''},{self:'yes',remark:''}]);const result=await perf.getAssessmentCompetencyInsight(mgr,reviewId,{generate:true});expect(result).toMatchObject({source:'ai',data:{verdict:'not_justified',discuss:['Ask Assessment for an example of Future skill at the next level.']}});expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(JSON.parse(vi.mocked(openaiAdapter.generate).mock.calls[0][1].prompt)).toEqual({task:'assessment_narrative',passages:[{index:0,kind:'evidence',lengthBand:'short'}]});expect(await runs()).toMatchObject([{state:'completed'}]);});
 it('changed actual competency evidence refuses before transport or allowance',async()=>{await f.complete(true,'',false,true);let changed=false;beforeAdmission=async()=>{await owner.db.update(schema.onehrReview).set({competencySelfRemark:'Changed actual self competency source.'}).where(eq(schema.onehrReview.reviewId,reviewId));changed=true;};await Promise.allSettled([perf.getAssessmentCompetencyInsight(mgr,reviewId,{generate:true})]);expect(changed).toBe(true);expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it.each(['draft','guide'] as const)('assigned colleague %s retains current canonical identity and reaches transport',async intent=>{const id=await assignedFeedback(),card=await perf.getOnehrFeedback(peers[0].ctx,id),text=intent==='guide'?'Record '+card.statements[0].text+' as yes':'Clear follow-through in our agreed delivery.';const done=await perf.sendFeedbackMessage(peers[0].ctx,reviewId,id,null,randomUUID(),text,intent);expect(done.draftUpdated).toBe(intent==='guide');expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await runs()).toMatchObject([{state:'completed'}]);const after=await perf.getOnehrFeedback(peers[0].ctx,id);expect(after.submitted).toBe(false);});
 it.each(['draft','guide'] as const)('colleague %s is never disclosed after actual assigned feedback is submitted',async intent=>{const id=await assignedFeedback(),card=await perf.getOnehrFeedback(peers[0].ctx,id);beforeAdmission=async()=>{await perf.submitOnehrFeedback(peers[0].ctx,id,Object.fromEntries(card.statements.map(statement=>[statement.id,'yes'])),'Actual human submitted feedback.');};await Promise.allSettled([perf.sendFeedbackMessage(peers[0].ctx,reviewId,id,null,randomUUID(),intent==='guide'?'Record '+card.statements[0].text+' as yes':'Clear follow-through in our agreed delivery.',intent)]);expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
});

/** Source-only regression for the precise callback-tail race: the second native command owns a
 * different real transaction and attempts mutation AFTER the final projection, BEFORE ai_admit. */
describe('native source custody survives the final source-check to admission gap',()=>{
 beforeEach(withoutUsdCap);
 it('refuses actual reviewer reassignment at callback tail with no native mutation, then permits the original native writer after admission',async()=>{
  const next=await alternativeNativeReviewer(),revision=(await f.view(a)).revision;
  const [before]=await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,reviewId));const eventsBefore=await owner.db.select().from(schema.domainEvent);
  afterSourceReplay=async()=>{await expect(perf.reassignOnehrReviewer(a,reviewId,revision,next.employmentId)).rejects.toThrow();const [during]=await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,reviewId));expect(during).toEqual(before);expect(await owner.db.select().from(schema.domainEvent)).toEqual(eventsBefore);};
  await expect(perf.draftOnehrNarrative(mgr,reviewId,'Verified the agreed delivery.')).resolves.toBe('Verified the agreed delivery.');expect(openaiAdapter.generate).toHaveBeenCalledOnce();
  await perf.reassignOnehrReviewer(a,reviewId,revision,next.employmentId);await expect(perf.draftOnehrNarrative(mgr,reviewId,'Verified the agreed delivery.')).rejects.toThrow();expect(openaiAdapter.generate).toHaveBeenCalledOnce();
 });
 it('refuses new child evidence and hidden-to-visible evidence updates under actual native custody',async()=>{
  const id=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Private native evidence before admission.',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]}),before=await owner.db.select().from(schema.onehrEvidence);
  afterSourceReplay=async()=>{await expect(perf.changeOnehrEvidenceState(self,id,'shared')).rejects.toThrow();await expect(perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'New child phantom.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]})).rejects.toThrow();expect(await owner.db.select().from(schema.onehrEvidence)).toEqual(before);};
  await perf.draftOnehrNarrative(mgr,reviewId,'Verified the agreed delivery.');expect(openaiAdapter.generate).toHaveBeenCalledOnce();await perf.changeOnehrEvidenceState(self,id,'shared');expect((await f.view(mgr)).evidence.some(row=>row.id===id)).toBe(true);
 });
 it('refuses an entirely new matching KB article at guide callback tail, then allows native publication after admission',async()=>{
  const article={title:'Current tasks Performance guide',body:'Use the current tasks in your Performance workspace.',category:'performance-faq',audience:'all' as const},before=await owner.db.select().from(schema.kbDocument);
  afterSourceReplay=async()=>{await expect(createArticle(a,article)).rejects.toThrow();expect(await owner.db.select().from(schema.kbDocument)).toEqual(before);};
  await askPerformanceGuide(self,'What are my current tasks?');expect(openaiAdapter.generate).toHaveBeenCalledOnce();const created=await createArticle(a,article);expect((await owner.db.select().from(schema.kbDocument).where(eq(schema.kbDocument.id,created.id))).length).toBe(1);
 });
 it('does not retain native source custody across external provider latency',async()=>{
  vi.mocked(openaiAdapter.generate).mockImplementationOnce(async(_cfg,args)=>{await createArticle(a,{title:'Current tasks added after admission',body:'A newly published native guide.',category:'performance-faq',audience:'all'});args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return '{"items":[0],"unanswered":false}';});
  expect(await askPerformanceGuide(self,'What are my current tasks?')).toMatchObject({mode:'search'});expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await runs()).toMatchObject([{state:'completed'}]);
 });
 it('shared source custody grants no native review or impersonation permission',async()=>{for(const actor of [peers[0].ctx,{...mgr,personId:subject.personId}])await expect(perf.draftOnehrNarrative(actor,reviewId,'Unpermitted source.')).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});

});

// Any configured USD cap, including zero, needs verified monetary enforcement; unknown cost is never zero.
describe('legacy rootless Performance drafting under the optional USD policy',()=>{
 it.each(['narrative','development','career'] as const)('%s fails closed before transport or admission while a USD cap is configured',async kind=>{
  await prepare(kind);await expect(call(kind)).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);
 });
 it('a zero USD cap is still a configured cap that refuses the rootless call; with no cap configured the same call is admitted',async()=>{
  await owner.db.execute(sql`update app.ai_spend_budget set monthly_nanos=0,root_nanos=null where tenant_id=${b.tenantId}::uuid and kind='tenant'`);
  await expect(call('narrative')).rejects.toBeInstanceOf(AiSpendControlError);
  expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);
  await withoutUsdCap();await call('narrative');expect(openaiAdapter.generate).toHaveBeenCalled();const observed=await runs();expect(observed.length).toBeGreaterThan(0);expect(observed.every(row=>row.state==='completed')).toBe(true);
 });
 // Owner rule: the user sees the product's brief, translated AI refusal: no raw error, SQL, provider or internal
 // detail, and nothing that confirms a hidden record. The action layer maps through performanceAiErrorMessage.
 const LEAK=/Failed query|params:|select |from app\.|ai_spend|P0001|monetary|native AI task root|performance_[a-z]+|Unpriced|openai|fictional-model/i;
 const shownRefusals=()=>['en','ms','ta','th','vi','zh'].map(locale=>(JSON.parse(readFileSync(`messages/${locale}.json`,'utf8')) as {assistant:{err_ai_control:string}}).assistant.err_ai_control);
 it.each(['narrative','development','career'] as const)('%s refused by a USD cap reaches its user only as the translated AI control refusal, with no SQL or internal text',async kind=>{
  await prepare(kind);const refusal=await call(kind).then(()=>null,(error:unknown)=>error);
  // Before the typed mapping this was Drizzle's 'Failed query: select monetary_required from app.ai_spend_policy_context(...) params: performance_...'.
  expect(refusal).toBeInstanceOf(AiSpendControlError);expect(refusal).toBeInstanceOf(AiAllowanceError);expect((refusal as Error).cause).toBeUndefined();expect((refusal as Error).message).not.toMatch(LEAK);
  const sentences=shownRefusals();expect(sentences).toHaveLength(6);
  for(const sentence of sentences){expect(sentence.trim().length).toBeGreaterThan(10);expect(sentence).not.toMatch(LEAK);expect(await performanceAiErrorMessage(refusal,key=>{expect(key).toBe('err_ai_control');return sentence;})).toBe(sentence);}
  expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);
 });
 it('competency insight keeps its designed non-AI summary under a USD cap, with no transport and no raw text',async()=>{
  await f.complete(true,'',false,true);const insight=await perf.getAssessmentCompetencyInsight(mgr,reviewId,{generate:true});expect(insight).toMatchObject({source:'plain',data:{verdict:'not_justified',discuss:['Ask Assessment for an example of Future skill at the next level.']}});expect(JSON.stringify(insight)).not.toMatch(/Failed query|params:|app\.ai_spend|P0001|monetary limit/i);
  expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);
 });
 it('colleague draft keeps its designed guidance reply under a USD cap, with no transport and no raw text',async()=>{
  const id=await assignedFeedback(),reply=await perf.sendFeedbackMessage(peers[0].ctx,reviewId,id,null,randomUUID(),'Clear follow-through in our agreed delivery.','draft');
  expect(JSON.stringify(reply)).not.toMatch(/Failed query|params:|app\.ai_spend|P0001|monetary limit/i);expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);
 });
});

// Authored UNRUN: exact native operation roots; synthetic monetary capability is test transport only.
describe('native Performance Assistant/Guide spend operation ownership',()=>{
 const tasks=()=>owner.db.execute<{id:string;source_kind:string;source_id:string;operation:string}>(sql`select id,source_kind,source_id,operation from app.ai_spend_task where tenant_id=${b.tenantId}::uuid order by created_at,id`);
 const reserves=()=>owner.db.execute<{root_id:string}>(sql`select root_id from app.ai_spend_reservation where tenant_id=${b.tenantId}::uuid order by created_at,run_id`);
 it('a caller object or foreign native request cannot issue the private message context',async()=>{const cfg=await withTenant(self,tx=>resolveActiveAiConfig(tx,self,'performance_assistant'));expect(cfg).not.toBeNull();expect(()=>bindPerformanceMessageSpend(cfg!,self,reviewId,{})).toThrow('spend context');await expect(withTenant(peers[0].ctx,tx=>tx.execute(sql`select app.ai_spend_task_issue('performance_assistant','performance_review_message',${reviewId}::uuid,${'results:'+randomUUID()})`))).rejects.toThrow();expect(await tasks()).toHaveLength(0);expect(await reserves()).toHaveLength(0);expect(openaiAdapter.generate).not.toHaveBeenCalled();});
 it('Guide binds the actual preprovider reserved native operation, not its text or a new per-step UUID',async()=>{await askPerformanceGuide(self,'What are my current tasks?');expect(openaiAdapter.generate).toHaveBeenCalledOnce();const[t]=await tasks(),[r]=await reserves(),[operation]=await owner.db.execute<{id:string}>(sql`select id from performance_assessment_guide_use where tenant_id=${b.tenantId}::uuid and actor_user_id=${self.userId}::uuid`);expect(t).toMatchObject({source_kind:'performance_guide_request',source_id:operation.id,operation:'guide'});expect(r.root_id).toBe(t.id);expect(JSON.stringify(t)).not.toContain('What are');});
 it('actual review message retry reuses one source-issued task after native conversation storage failure, then completed duplicate spends nothing',async()=>{
  const kpiId=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await f.view(self)).revision,[{id:kpiId,title:'Agreed delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}],true);await perf.approveOnehrScorecard(mgr,reviewId,(await f.view(mgr)).revision,true,'Targets verified');vi.mocked(openaiAdapter.generate).mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return JSON.stringify({items:[0]});});
  const nonce=randomUUID(),text='remark: Completed the agreed delivery.';
  await owner.db.execute(sql`create function app.fictional_spend_message_storage_failure() returns trigger language plpgsql as $$begin raise exception 'Fictional conversation persistence refusal';end$$`);await owner.db.execute(sql`create trigger fictional_spend_message_storage_failure before insert on performance_assessment_conversation for each row execute function app.fictional_spend_message_storage_failure()`);
  try{await expect(perf.sendReviewMessage(self,reviewId,'results',null,nonce,text)).rejects.toThrow();expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await reserves()).toHaveLength(1);}finally{await owner.db.execute(sql`drop trigger fictional_spend_message_storage_failure on performance_assessment_conversation`);await owner.db.execute(sql`drop function app.fictional_spend_message_storage_failure()`);}
  const done=await perf.sendReviewMessage(self,reviewId,'results',null,nonce,text);expect(openaiAdapter.generate).toHaveBeenCalledTimes(2);const rows=await reserves(),task=await tasks();expect(task).toHaveLength(1);expect(rows).toHaveLength(2);expect(new Set(rows.map(r=>r.root_id))).toEqual(new Set([task[0].id]));expect(task[0]).toMatchObject({source_kind:'performance_review_message',source_id:reviewId});expect(task[0].operation).toBe(self.userId+':results:'+nonce);
  expect(await perf.sendReviewMessage(self,reviewId,'results',null,nonce,text)).toEqual(done);expect(openaiAdapter.generate).toHaveBeenCalledTimes(2);expect(await tasks()).toHaveLength(1);
 });
 it('actual assigned feedback message owns its context and opaque task; another employee cannot create or spend it',async()=>{
  await perf.assignOnehrPanel(mgr,reviewId,(await f.view(mgr)).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));const assignment=(await perf.onehrAssignments(peers[0].ctx)).feedback.find(r=>r.subject==='Assessment subject')!;expect(assignment).toBeDefined();const card=await perf.getOnehrFeedback(peers[0].ctx,assignment.id),nonce=randomUUID();vi.mocked(openaiAdapter.generate).mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return JSON.stringify({items:[0]});});
  const text='Record '+card.statements[0].text+' as yes',done=await perf.sendFeedbackMessage(peers[0].ctx,reviewId,assignment.id,null,nonce,text);expect(done.draftUpdated).toBe(true);expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await tasks()).toMatchObject([{source_kind:'performance_feedback_message',source_id:assignment.id,operation:peers[0].ctx.userId+':feedback:'+nonce}]);expect(await perf.sendFeedbackMessage(peers[0].ctx,reviewId,assignment.id,null,nonce,text)).toEqual(done);expect(openaiAdapter.generate).toHaveBeenCalledOnce();await expect(perf.sendFeedbackMessage(peers[1].ctx,reviewId,assignment.id,null,randomUUID(),text)).rejects.toThrow();expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await tasks()).toHaveLength(1);
 });
});


describe('native historical review retry stage ownership',()=>{
 const tasks=()=>owner.db.execute(sql`select id,source_kind,source_id,operation from app.ai_spend_task where tenant_id=${b.tenantId}::uuid order by created_at,id`);
 const reserves=()=>owner.db.execute(sql`select root_id from app.ai_spend_reservation where tenant_id=${b.tenantId}::uuid order by created_at,run_id`);
 it('refuses an existing reply after actual stage disable between first authorization and its message-read transaction; unchanged retry spends nothing',async()=>{
  const nonce=randomUUID(),text='How do I build my scorecard?';
  const completed=await perf.sendReviewMessage(self,reviewId,'setting',null,nonce,text);
  expect(completed.messages.some(message=>message.id===nonce)).toBe(true);
  const originalRuns=await runs(),originalTasks=await tasks(),originalReservations=await reserves(),providerCalls=vi.mocked(openaiAdapter.generate).mock.calls.length;
  const conversationsBefore=await owner.db.select().from(schema.assessmentConversation).where(eq(schema.assessmentConversation.reviewId,reviewId));
  expect(await perf.sendReviewMessage(self,reviewId,'setting',null,nonce,text)).toEqual(completed);
  expect(await runs()).toEqual(originalRuns);expect(await tasks()).toEqual(originalTasks);expect(await reserves()).toEqual(originalReservations);expect(openaiAdapter.generate).toHaveBeenCalledTimes(providerCalls);

  // Only the transaction boundary is intercepted; both reads and the intervening operational
  // policy writer use the genuine app role, native authority, source triggers and actual database.
  const native=moduleGate.withPerformanceTenant;let userTransactions=0,changed=false;
  vi.spyOn(moduleGate,'withPerformanceTenant').mockImplementation(async<T>(ctx:SessionContext,run:(tx:Tx)=>Promise<T>):Promise<T>=>{
   const result=await native(ctx,run);
   if(ctx.userId===self.userId&&++userTransactions===1){
    const before=(await perf.getOnehrCycle(a,cycleId))!;expect(before.policy.modules.pm).toBe(true);
    await perf.updateAssessmentModules(a,cycleId,before.revision,{...before.policy.modules,pm:false});
    const after=(await perf.getOnehrCycle(a,cycleId))!;expect(after.policy.modules.pm).toBe(false);expect(after.revision).toBe(before.revision+1);changed=true;
   }
   return result;
  });
  await expect(perf.sendReviewMessage(self,reviewId,'setting',null,nonce,text)).rejects.toThrow('This review module is disabled.');
  expect(changed).toBe(true);expect(userTransactions).toBe(1); // failed second read never completes
  expect(await owner.db.select().from(schema.assessmentConversation).where(eq(schema.assessmentConversation.reviewId,reviewId))).toEqual(conversationsBefore);
  expect(await runs()).toEqual(originalRuns);expect(await tasks()).toEqual(originalTasks);expect(await reserves()).toEqual(originalReservations);expect(openaiAdapter.generate).toHaveBeenCalledTimes(providerCalls);
 });
});
