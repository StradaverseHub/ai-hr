/** Authored UNRUN. Actual native OneHR readers/admission/RLS, fictional adapter outputs; no API. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
const hooks=vi.hoisted(()=>({draft:undefined as undefined|(()=>Promise<void>),image:undefined as undefined|(()=>Promise<void>)}));
vi.mock('../lib/ai',async importActual=>{const actual=await importActual<typeof import('../lib/ai')>();return{...actual,generateDraft:vi.fn(async(...args:Parameters<typeof actual.generateDraft>)=>{await hooks.draft?.();return actual.generateDraft(...args);}),readImage:vi.fn(async(...args:Parameters<typeof actual.readImage>)=>{await hooks.image?.();return actual.readImage(...args);})};});
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as perf from '../packs/performance/service';
import {defaultPolicy,frameworkFor} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import {rewriteAssessmentField} from '../packs/performance/onehr/rewrite-service';
import {getAssessmentPerformanceInsight} from '../packs/performance/onehr/insight-service';
import {readAssessmentFileTexts} from '../packs/performance/onehr/evidence-reading';
import {anthropicAdapter} from '../lib/ai/providers/anthropic';
import {encryptSecret} from '../lib/ai/crypto';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hireEmployee,setReportingLine} from '../core/org';
import {createJobGrade} from '../core/admin';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,a:SessionContext,self:SessionContext,mgr:SessionContext,subject:{personId:string;employmentId:string},manager:{personId:string;employmentId:string},reviewId:string,kpiId:string;
const year=Number(todayInKualaLumpur().slice(0,4));
const png=()=>Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const runs=()=>owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,b.tenantId));
const view=async(ctx=self)=>{const v=await perf.getOnehrReview(ctx,reviewId);if(!v)throw Error('Fictional fixture review missing');return v;};
beforeAll(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-performance-source-secret-01234567890123456789');await migrateTestDb();});
beforeEach(async()=>{hooks.draft=undefined;hooks.image=undefined;await resetDb();b=await seedBase();await setModule(b.tenantId,'performance','active');a={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 await withTenant(a,async tx=>{const [proof]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() and app.is_group_admin() as ok`);expect(proof.ok).toBe(true);});
 // A real grade must match exactly one native framework before opening the cycle.
 const grade=await createJobGrade(a,{code:'JG12',name:'Fictional grade 12'});
 const hire=(name:string)=>hireEmployee(a,{person:{fullName:name,primaryEmail:`${randomUUID()}@synthetic.test`},companyId:b.companyId,departmentId:b.deptA,gradeId:grade.id,employmentType:'full_time',hiredOn:`${year-2}-01-01`});subject=await hire('Fictional assessment subject');manager=await hire('Fictional assessment manager');
 const ctx=async(personId:string,role:'employee'|'manager'):Promise<SessionContext>=>({...a,userId:await createAppUser(b.tenantId,personId,role),personId,roles:[role],grants:undefined});self=await ctx(subject.personId,'employee');mgr=await ctx(manager.personId,'manager');
 await setReportingLine(a,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
 const {cycleId}=await perf.createCycle(a,{name:'Fictional native annual cycle',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});const policy=defaultPolicy(framework);expect(frameworkFor(policy,'JG12').length).toBeGreaterThan(0);policy.modules.evidence=true;await perf.configureOnehrCycle(a,cycleId,null,policy);await perf.openCycle(a,{cycleId});
 const [review]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,subject.employmentId)));reviewId=review.id;kpiId=randomUUID();
 await perf.saveOnehrKpis(self,reviewId,(await view()).revision,[{id:kpiId,title:'Fictional agreed delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,50,100,150,200]},moderatorEmploymentId:manager.employmentId}],true);await perf.approveOnehrScorecard(mgr,reviewId,(await view(mgr)).revision,true,'Fictional agreed target');
 // Owner fixtures an existing active provider, not a claimed protocol evaluation or live activation.
 await owner.db.insert(schema.aiProviderConfig).values({tenantId:b.tenantId,provider:'anthropic',model:'fictional-model',apiKeyCiphertext:encryptSecret('fictional-key',b.tenantId),keyLast4:'-key',isActive:true});
 await owner.db.insert(schema.tenantSetting).values({tenantId:b.tenantId,key:'performance.ai_pm_enabled',value:true,source:'customer'}).onConflictDoUpdate({target:[schema.tenantSetting.tenantId,schema.tenantSetting.key],set:{value:true}});
});
afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});
async function submit(image=false){const file=image?await perf.addPerformanceAttachment(self,{reviewId,kpiId,stageKind:null,fileName:'synthetic.png',mimeType:'image/png',content:png()}):null;await perf.submitOnehrResults(self,reviewId,(await view()).revision,[{id:kpiId,actual:100,note:'Completed agreed delivery.'}],'Completed agreed delivery.');return file;}
/** Added AFTER result submission: current recognition files are not immutable submitted-proof files. */
async function currentRecognition(name:string,content:Buffer){
 const evidenceId=await perf.addOnehrEvidence(self,reviewId,{kind:'recognition',body:'Fictional current supporting evidence.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[{kind:'kpi',id:kpiId}]});
 const file=await perf.addPerformanceAttachment(self,{reviewId,evidenceId,stageKind:null,fileName:name,mimeType:name.endsWith('.png')?'image/png':'text/plain',content});
 const source=await perf.getAssessmentInsightSource(mgr,reviewId);expect(source.attachments.some(row=>row.id===file.id)).toBe(true);
 const [entry]=await owner.db.select().from(schema.onehrEvidence).where(eq(schema.onehrEvidence.id,evidenceId));expect(entry.state).toBe('shared');
 const [review]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));expect(review.submittedProof.some(proof=>proof.attachmentId===file.id)).toBe(false);
 return {...file,evidenceId};
}
async function retractCurrent(file:{id:string;evidenceId:string}){
 await perf.changeOnehrEvidenceState(self,file.evidenceId,'retracted');
 const [entry]=await owner.db.select().from(schema.onehrEvidence).where(eq(schema.onehrEvidence.id,file.evidenceId));expect(entry.state).toBe('retracted');
 expect((await perf.getAssessmentInsightSource(mgr,reviewId)).attachments.some(row=>row.id===file.id)).toBe(false);
}
function insightOutput(title:string){return JSON.stringify({paragraph:'Their result met target, and their note explains the period.',overall:'Their note explains the result.',verdict:'well_justified',verdict_why:'Their note explains the result.',kpis:[{kpi:title,read:'The result met target.',evidence:'none',evidence_note:'',justified:'yes',why:'Their note explains the result.'}],discuss:[]});}
it('dispatches a current native self field exactly once through actual admission',async()=>{const adapter=vi.spyOn(anthropicAdapter,'generate').mockResolvedValue('{"layout":"paragraph"}');try{await expect(rewriteAssessmentField(self,reviewId,{kind:'pm_self_remark'},'Completed agreed delivery.','Polish the wording.',randomUUID())).resolves.toMatchObject({text:'Completed agreed delivery.'});expect(adapter).toHaveBeenCalledTimes(1);expect((await runs())[0].state).toBe('completed');}finally{adapter.mockRestore();}});
it('refuses a field that became submitted before drafting admission, without reservation',async()=>{hooks.draft=async()=>{await submit();};const adapter=vi.spyOn(anthropicAdapter,'generate');try{await expect(rewriteAssessmentField(self,reviewId,{kind:'pm_self_remark'},'Completed agreed delivery.','Polish the wording.',randomUUID())).rejects.toThrow();expect(adapter).not.toHaveBeenCalled();expect(await runs()).toHaveLength(0);}finally{adapter.mockRestore();}});
it('dispatches a current assigned manager insight through real admission, not a structural fake config',async()=>{await submit();const source=await perf.getAssessmentInsightSource(mgr,reviewId);expect(source.facts.rows).toHaveLength(1);const adapter=vi.spyOn(anthropicAdapter,'generate').mockResolvedValue('{"items":[0]}');try{expect(await getAssessmentPerformanceInsight(mgr,reviewId,reviewId,{generate:true})).toMatchObject({source:'ai',pending:false});expect(adapter).toHaveBeenCalledTimes(1);expect((await runs())[0].state).toBe('completed');}finally{adapter.mockRestore();}});
it('refuses changed current submitted facts before the final insight provider request',async()=>{await submit();hooks.draft=async()=>{await owner.db.update(schema.onehrReview).set({selfRemark:'Fictional changed submitted source'}).where(eq(schema.onehrReview.reviewId,reviewId));};const adapter=vi.spyOn(anthropicAdapter,'generate');try{await expect(getAssessmentPerformanceInsight(mgr,reviewId,reviewId,{generate:true})).rejects.toThrow();expect(adapter).not.toHaveBeenCalled();expect(await runs()).toHaveLength(0);}finally{adapter.mockRestore();}});
it('refuses native reviewer reassignment before final text dispatch even though the login and role remain current',async()=>{await submit();hooks.draft=async()=>{await owner.db.update(schema.performanceReview).set({reviewerEmploymentId:subject.employmentId}).where(eq(schema.performanceReview.id,reviewId));};const adapter=vi.spyOn(anthropicAdapter,'generate');try{await expect(getAssessmentPerformanceInsight(mgr,reviewId,reviewId,{generate:true})).rejects.toThrow();expect(adapter).not.toHaveBeenCalled();expect(await runs()).toHaveLength(0);}finally{adapter.mockRestore();}});
it('keeps an authorized retained image unavailable without a protected local image transform',async()=>{const file=await submit(true);const adapter=vi.spyOn(anthropicAdapter,'readImage');try{const result=(await readAssessmentFileTexts(mgr,reviewId,{contextId:reviewId,allowImages:true})).get(file!.id);expect(result?.status).not.toBe('ok');expect(adapter).not.toHaveBeenCalled();expect(await runs()).toHaveLength(0);}finally{adapter.mockRestore();}});
it.each(['retracted','replaced'] as const)('refuses genuinely %s current recognition evidence before image provider admission and spends nothing',async change=>{await submit();const file=await currentRecognition('synthetic.png',png());let changed=false;hooks.image=async()=>{await retractCurrent(file);if(change==='replaced'){const replacement=await currentRecognition('replacement.png',Buffer.from([...png().slice(0,11),1]));expect(replacement.id).not.toBe(file.id);}changed=true;};const adapter=vi.spyOn(anthropicAdapter,'readImage');try{const result=await readAssessmentFileTexts(mgr,reviewId,{contextId:reviewId,allowImages:true});expect(changed).toBe(true);expect(result.has(file.id)).toBe(false);expect(adapter).not.toHaveBeenCalled();expect(await runs()).toHaveLength(0);}finally{adapter.mockRestore();}});
it('refuses actual reviewer reassignment immediately before image dispatch',async()=>{await submit(true);hooks.image=async()=>{await owner.db.update(schema.performanceReview).set({reviewerEmploymentId:subject.employmentId}).where(eq(schema.performanceReview.id,reviewId));};const adapter=vi.spyOn(anthropicAdapter,'readImage');try{await expect(readAssessmentFileTexts(mgr,reviewId,{contextId:reviewId,allowImages:true})).rejects.toThrow();expect(adapter).not.toHaveBeenCalled();expect(await runs()).toHaveLength(0);}finally{adapter.mockRestore();}});
it('refuses genuinely retracted text evidence before final-text dispatch and does not cache a stale plain fallback',async()=>{await submit();const file=await currentRecognition('synthetic.txt',Buffer.from('Fictional original evidence.'));let changed=false;hooks.draft=async()=>{await retractCurrent(file);changed=true;};const adapter=vi.spyOn(anthropicAdapter,'generate');try{await expect(getAssessmentPerformanceInsight(mgr,reviewId,reviewId,{generate:true})).rejects.toThrow();expect(changed).toBe(true);expect(adapter).not.toHaveBeenCalled();expect(await runs()).toHaveLength(0);expect(await owner.db.select().from(schema.assessmentInsight).where(eq(schema.assessmentInsight.reviewId,reviewId))).toHaveLength(0);}finally{adapter.mockRestore();}});
it('refuses current Performance module revocation before provider despite a retained enabled session snapshot',async()=>{hooks.draft=async()=>{await setModule(b.tenantId,'performance','disabled');};const adapter=vi.spyOn(anthropicAdapter,'generate');try{await expect(rewriteAssessmentField(self,reviewId,{kind:'pm_self_remark'},'Completed agreed delivery.','Polish the wording.',randomUUID())).rejects.toThrow();expect(adapter).not.toHaveBeenCalled();expect(await runs()).toHaveLength(0);}finally{adapter.mockRestore();}});
