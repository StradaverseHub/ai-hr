/** Authored UNRUN. Actual app-role source projections, issued config and gateway admission;
 * only provider transport is mocked. No live provider/key, forged governance or receipts. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as ai from '../lib/ai';
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
let beforeAdmission:(()=>Promise<void>)|undefined,alterInput=false;
const f=createOnehrServiceFixtures({get b(){return b;},get a(){return a;},get subject(){return subject;},get manager(){return manager;},get self(){return self;},get mgr(){return mgr;},get cycleId(){return cycleId;},get reviewId(){return reviewId;},get peers(){return peers;}});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
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
 vi.stubEnv('OPENAI_API_KEY','fictional-admission-transport-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');beforeAdmission=undefined;alterInput=false;
 const original=ai.generateDraft;vi.spyOn(ai,'generateDraft').mockImplementation(async(cfg,args)=>{const hook=beforeAdmission;beforeAdmission=undefined;if(hook)await hook();return original(cfg,alterInput?{...args,prompt:args.prompt+' CHANGED'}:args);});
 vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});if(args.system.includes('fact IDs'))return '{"facts":["dashboard"],"unanswered":false}';if(args.system.includes('longer-term career aspiration'))return '{"aspirationLong":"I aim to deepen my delivery practice."}';if(args.system.startsWith('Propose development goals'))return '[{"title":"Collaborative delivery","area":"Collaborative delivery","item_ids":["lp:0"],"experience":"Lead a delivery retrospective","exposure":"Seek colleague feedback","education":"Study facilitation"}]';return '{"items":[0]}';});
});
const runs=()=>owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,b.tenantId));
const sources=['narrative','guide','development','career'] as const;
type Source=typeof sources[number];
async function prepare(kind:Source){if(kind==='development'||kind==='career'){await f.complete();await perf.releaseOnehrResult(a,reviewId,'feedback',true);}}
const call=(kind:Source)=>kind==='narrative'?perf.draftOnehrNarrative(self,reviewId,'Completed the agreed delivery.'):kind==='guide'?askPerformanceGuide(self,'What are my current tasks?'):kind==='development'?perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID()):perf.suggestAssessmentCareerPlan(self,reviewId,randomUUID());
describe('OneHR legacy drafting replays actual native source before provider admission',()=>{
 it.each(sources)('%s stable source reaches actual issued gateway and transport without saving a plan',async kind=>{await prepare(kind);await call(kind);expect(openaiAdapter.generate).toHaveBeenCalled();const observed=await runs();expect(observed.length).toBeGreaterThan(0);expect(observed.every(row=>row.state==='completed')).toBe(true);expect((await f.view(self)).plans).toEqual([]);});
 it.each(sources)('%s module revocation after gathering refuses before network or admission',async kind=>{await prepare(kind);beforeAdmission=()=>setModule(b.tenantId,'performance','disabled');await expect(call(kind)).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it.each(sources)('%s changed native source after gathering is never sent or charged',async kind=>{await prepare(kind);beforeAdmission=async()=>{if(kind==='narrative')await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Newly shared native source evidence.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]});else if(kind==='guide')await owner.db.update(schema.reviewCycle).set({name:'Changed native calendar name'}).where(eq(schema.reviewCycle.id,cycleId));else await owner.db.update(schema.onehrReview).set({selfRemark:'Changed native own assessment words'}).where(eq(schema.onehrReview.reviewId,reviewId));};const result=await Promise.allSettled([call(kind)]);if(kind==='guide')expect(result[0]).toMatchObject({status:'fulfilled',value:{mode:'search'}});else expect(result[0].status).toBe('rejected');expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it('an actually reassigned native reviewer loses drafting access before admission',async()=>{beforeAdmission=async()=>{await perf.reassignOnehrReviewer(a,reviewId,(await f.view(a)).revision,peers[0].employmentId);};await expect(perf.draftOnehrNarrative(mgr,reviewId,'Verified the agreed delivery.')).rejects.toThrow();expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it.each(sources)('%s altered outbound prompt cannot reuse the sealed native-source check',async kind=>{await prepare(kind);alterInput=true;await Promise.allSettled([call(kind)]);expect(openaiAdapter.generate).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
});
