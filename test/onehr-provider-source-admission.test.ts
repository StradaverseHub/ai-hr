/** Authored UNRUN. Actual app-role source projections, issued config and gateway admission;
 * provider transport and its explicitly fictional monetary certificate are mocked.
 * No live provider/key, forged governance, source permissions or receipts. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as ai from '../lib/ai';
import * as governance from '../core/ai-governance';
import {createArticle} from '../core/knowledge-base';
import {resolveActiveAiConfig} from '../core/ai-config';
import {bindPerformanceMessageSpend} from '../core/ai-spend-task';
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
let b:Base,a:SessionContext,self:SessionContext,mgr:SessionContext,subject:{employmentId:string;personId:string},manager:{employmentId:string;personId:string},peers:{employmentId:string;ctx:SessionContext}[],cycleId:string,reviewId:string;
let spendPrice:Awaited<ReturnType<typeof installSyntheticSpendCapability>>;
let beforeAdmission:(()=>Promise<void>)|undefined,afterSourceReplay:(()=>Promise<void>)|undefined,alterInput=false;
const f=createOnehrServiceFixtures({get b(){return b;},get a(){return a;},get subject(){return subject;},get manager(){return manager;},get self(){return self;},get mgr(){return mgr;},get cycleId(){return cycleId;},get reviewId(){return reviewId;},get peers(){return peers;}});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{spendPrice?.restore();vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await resetDb();b=await seedBase();for(const code of ['performance','rewards'])await setModule(b.tenantId,code,'active');a=await entitledCtx(b);
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
 vi.stubEnv('OPENAI_API_KEY','fictional-admission-transport-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');beforeAdmission=undefined;afterSourceReplay=undefined;alterInput=false;
 const issued=await withTenant(a,tx=>resolveActiveAiConfig(tx,a,'performance_review'));if(!issued)throw Error('Missing actual fixture provider');spendPrice=await installSyntheticSpendCapability(a,{provider:issued.provider,model:issued.model});
 const issue=governance.withAiAdmissionCheck;vi.spyOn(governance,'withAiAdmissionCheck').mockImplementation((config,feature,check)=>issue(config,feature,async(tx,request)=>{await check(tx,request);const tail=afterSourceReplay;afterSourceReplay=undefined;if(tail)await tail();}));
 const original=ai.generateDraft;vi.spyOn(ai,'generateDraft').mockImplementation(async(cfg,args)=>{const hook=beforeAdmission;beforeAdmission=undefined;if(hook)await hook();return original(cfg,alterInput?{...args,prompt:args.prompt+' CHANGED'}:args);});
 vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});if(args.system.includes('fact IDs'))return '{"facts":["dashboard"],"unanswered":false}';if(args.system.includes('longer-term career aspiration'))return '{"aspirationLong":"I aim to deepen my delivery practice."}';if(args.system.startsWith('Propose development goals'))return '[{"title":"Collaborative delivery","area":"Collaborative delivery","item_ids":["lp:0"],"experience":"Lead a delivery retrospective","exposure":"Seek colleague feedback","education":"Study facilitation"}]';return '{"items":[0]}';});
});
const runs=()=>owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,b.tenantId));
async function alternativeNativeReviewer(){const next=await f.hire('Actual second-level manager');await setReportingLine(a,{subordinateEmploymentId:manager.employmentId,managerEmploymentId:next.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});return next;}
const sources=['narrative','guide','development','career'] as const;
type Source=typeof sources[number];
async function prepare(kind:Source){if(kind==='development'||kind==='career'){await f.complete();await perf.releaseOnehrResult(a,reviewId,'feedback',true);}}
const call=(kind:Source)=>kind==='narrative'?perf.draftOnehrNarrative(self,reviewId,'Completed the agreed delivery.'):kind==='guide'?askPerformanceGuide(self,'What are my current tasks?'):kind==='development'?perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID()):perf.suggestAssessmentCareerPlan(self,reviewId,randomUUID());
describe('OneHR legacy drafting replays actual native source before provider admission',()=>{
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
 it('current competency SQL projection reaches one governed provider call',async()=>{await f.complete();await perf.getAssessmentCompetencyInsight(mgr,reviewId,{generate:true});expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await runs()).toMatchObject([{state:'completed'}]);});
 it('changed actual competency evidence refuses before transport or allowance',async()=>{await f.complete();beforeAdmission=async()=>{await owner.db.update(schema.onehrReview).set({competencySelfRemark:'Changed actual self competency source.'}).where(eq(schema.onehrReview.reviewId,reviewId));};await Promise.allSettled([perf.getAssessmentCompetencyInsight(mgr,reviewId,{generate:true})]);expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it.each(['draft','guide'] as const)('assigned colleague %s retains current canonical identity and reaches transport',async intent=>{const id=await assignedFeedback();await perf.sendFeedbackMessage(peers[0].ctx,reviewId,id,null,randomUUID(),'Clear follow-through in our agreed delivery.',intent);expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await runs()).toMatchObject([{state:'completed'}]);const card=await perf.getOnehrFeedback(peers[0].ctx,id);expect(card.submitted).toBe(false);});
 it.each(['draft','guide'] as const)('colleague %s is never disclosed after actual assigned feedback is submitted',async intent=>{const id=await assignedFeedback(),card=await perf.getOnehrFeedback(peers[0].ctx,id);beforeAdmission=async()=>{await perf.submitOnehrFeedback(peers[0].ctx,id,Object.fromEntries(card.statements.map(statement=>[statement.id,'yes'])),'Actual human submitted feedback.');};await Promise.allSettled([perf.sendFeedbackMessage(peers[0].ctx,reviewId,id,null,randomUUID(),'Clear follow-through in our agreed delivery.',intent)]);expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
});

/** Source-only regression for the precise callback-tail race: the second native command owns a
 * different real transaction and attempts mutation AFTER the final projection, BEFORE ai_admit. */
describe('native source custody survives the final source-check to admission gap',()=>{
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
  vi.mocked(openaiAdapter.generate).mockImplementationOnce(async(_cfg,args)=>{await createArticle(a,{title:'Current tasks added after admission',body:'A newly published native guide.',category:'performance-faq',audience:'all'});args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return '{"facts":["dashboard"],"unanswered":false}';});
  expect(await askPerformanceGuide(self,'What are my current tasks?')).toMatchObject({mode:'search'});expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await runs()).toMatchObject([{state:'completed'}]);
 });
 it('shared source custody grants no native review or impersonation permission',async()=>{for(const actor of [peers[0].ctx,{...mgr,personId:subject.personId}])await expect(perf.draftOnehrNarrative(actor,reviewId,'Unpermitted source.')).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});

});

// Authored UNRUN: exact native operation roots; synthetic monetary capability is test transport only.
describe('native Performance Assistant/Guide spend operation ownership',()=>{
 const tasks=()=>owner.db.execute<{id:string;source_kind:string;source_id:string;operation:string}>(sql`select id,source_kind,source_id,operation from app.ai_spend_task where tenant_id=${b.tenantId}::uuid order by created_at,id`);
 const reserves=()=>owner.db.execute<{root_id:string}>(sql`select root_id from app.ai_spend_reservation where tenant_id=${b.tenantId}::uuid order by created_at,run_id`);
 it('a caller object or foreign native request cannot issue the private message context',async()=>{const cfg=await withTenant(self,tx=>resolveActiveAiConfig(tx,self,'performance_assistant'));expect(cfg).not.toBeNull();expect(()=>bindPerformanceMessageSpend(cfg!,self,reviewId,{})).toThrow('spend context');await expect(withTenant(peers[0].ctx,tx=>tx.execute(sql`select app.ai_spend_task_issue('performance_assistant','performance_review_message',${reviewId}::uuid,${'results:'+randomUUID()})`))).rejects.toThrow();expect(await tasks()).toHaveLength(0);expect(await reserves()).toHaveLength(0);expect(openaiAdapter.generate).not.toHaveBeenCalled();});
 it('Guide binds the actual preprovider reserved native operation, not its text or a new per-step UUID',async()=>{await askPerformanceGuide(self,'What are my current tasks?');expect(openaiAdapter.generate).toHaveBeenCalledOnce();const[t]=await tasks(),[r]=await reserves(),[operation]=await owner.db.execute<{id:string}>(sql`select id from performance_assessment_guide_use where tenant_id=${b.tenantId}::uuid and actor_user_id=${self.userId}::uuid`);expect(t).toMatchObject({source_kind:'performance_guide_request',source_id:operation.id,operation:'guide'});expect(r.root_id).toBe(t.id);expect(JSON.stringify(t)).not.toContain('What are');});
 it('actual review message retry reuses one source-issued task after native conversation storage failure, then completed duplicate spends nothing',async()=>{
  const kpiId=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await f.view(self)).revision,[{id:kpiId,title:'Agreed delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}],true);await perf.approveOnehrScorecard(mgr,reviewId,(await f.view(mgr)).revision,true,'Targets verified');vi.mocked(openaiAdapter.generate).mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return '{"commands":[]}';});
  const nonce=randomUUID(),text='Record Agreed delivery result as 3';
  await owner.db.execute(sql`create function app.fictional_spend_message_storage_failure() returns trigger language plpgsql as $$begin raise exception 'Fictional conversation persistence refusal';end$$`);await owner.db.execute(sql`create trigger fictional_spend_message_storage_failure before insert on performance_assessment_conversation for each row execute function app.fictional_spend_message_storage_failure()`);
  try{await expect(perf.sendReviewMessage(self,reviewId,'results',null,nonce,text)).rejects.toThrow();expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await reserves()).toHaveLength(1);}finally{await owner.db.execute(sql`drop trigger fictional_spend_message_storage_failure on performance_assessment_conversation`);await owner.db.execute(sql`drop function app.fictional_spend_message_storage_failure()`);}
  const done=await perf.sendReviewMessage(self,reviewId,'results',null,nonce,text);expect(openaiAdapter.generate).toHaveBeenCalledTimes(2);const rows=await reserves(),task=await tasks();expect(task).toHaveLength(1);expect(rows).toHaveLength(2);expect(new Set(rows.map(r=>r.root_id))).toEqual(new Set([task[0].id]));expect(task[0]).toMatchObject({source_kind:'performance_review_message',source_id:reviewId});expect(task[0].operation).toBe(self.userId+':results:'+nonce);
  expect(await perf.sendReviewMessage(self,reviewId,'results',null,nonce,text)).toEqual(done);expect(openaiAdapter.generate).toHaveBeenCalledTimes(2);expect(await tasks()).toHaveLength(1);
 });
 it('actual assigned feedback message owns its context and opaque task; another employee cannot create or spend it',async()=>{
  await perf.assignOnehrPanel(mgr,reviewId,(await f.view(mgr)).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));const assignment=(await perf.onehrAssignments(peers[0].ctx)).feedback.find(r=>r.subject==='Assessment subject')!;expect(assignment).toBeDefined();const card=await perf.getOnehrFeedback(peers[0].ctx,assignment.id),nonce=randomUUID();vi.mocked(openaiAdapter.generate).mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return '{"commands":[]}';});
  const text='Mark '+card.statements[0].text+' yes',done=await perf.sendFeedbackMessage(peers[0].ctx,reviewId,assignment.id,null,nonce,text);expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await tasks()).toMatchObject([{source_kind:'performance_feedback_message',source_id:assignment.id,operation:peers[0].ctx.userId+':feedback:'+nonce}]);expect(await perf.sendFeedbackMessage(peers[0].ctx,reviewId,assignment.id,null,nonce,text)).toEqual(done);expect(openaiAdapter.generate).toHaveBeenCalledOnce();await expect(perf.sendFeedbackMessage(peers[1].ctx,reviewId,assignment.id,null,randomUUID(),text)).rejects.toThrow();expect(openaiAdapter.generate).toHaveBeenCalledOnce();expect(await tasks()).toHaveLength(1);
 });
});
