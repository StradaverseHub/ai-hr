import {setRewardMember} from './rewards-access-fixture';
import type { NotificationEmailRequest } from '../lib/notification-email-model';
import {leadershipPrinciples} from '../packs/performance/onehr/framework-model';
import { kpiLibraryImportHeaders } from '../packs/performance/onehr/import-model';
import { architectureHeaders } from '../packs/performance/onehr/architecture-model';
import { recordLoginSucceeded } from '../core/auth';
import { parseCsv,toCsv } from '../lib/csv';
import { randomUUID } from 'node:crypto';
import {readFileSync} from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import * as perf from '../packs/performance/service';
import { defaultPolicy, type KPI } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import sourceGolden from './fixtures/onehr/source-golden.json';
import { createRewardUnit, getRewardUnit, importOnehrRewardResults } from '../packs/rewards/service';
import { adminCtx, closeAll, createAppUser, entitledCtx, harnessSnapshot, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { saveNotificationEmailPolicy,saveNotificationEmailPreferences,retryNotificationEmail } from '../core/notification-email';
import { deliverNotificationEmails,type NotificationEmailTransport } from '../core/notification-email-delivery';
import { dispatchNotifications,dispatchNotificationsFromSweep,notificationStillTargets } from '../core/notifications';
import { appendEvent,actorOf } from '../db/events';
import { todayInKualaLumpur } from '../lib/hr-date';

vi.mock('../lib/ai',async importActual=>({...await importActual<typeof import('../lib/ai')>(),generateDraft:vi.fn(),readImage:vi.fn()}));
vi.mock('../core/ai-config',async importActual=>({...await importActual<typeof import('../core/ai-config')>(),resolveActiveAiConfig:vi.fn()}));
import { generateDraft,readImage } from '../lib/ai';
// TEST ONLY transport: choose every offered protected reference; no model prose or values.
const referenceReply=async(_cfg:Parameters<typeof generateDraft>[0],args:Parameters<typeof generateDraft>[1])=>{const source=JSON.parse(args.prompt),items=source.sections??source.passages;if(!Array.isArray(items)||!items.length)throw Error('Missing actual protected source references');return JSON.stringify({items:items.map((item:{index:number})=>item.index)});};
import { resolveActiveAiConfig } from '../core/ai-config';
// Resolver-issued capabilities replace obsolete structural provider/key mocks.
async function issuedFixtureConfig(...args:Parameters<typeof resolveActiveAiConfig>){return (await vi.importActual<typeof import('../core/ai-config')>('../core/ai-config')).resolveActiveAiConfig(...args);}
import {createOnehrServiceFixtures,restrictedReminderMailOwner,year} from './onehr-service-fixture';
describe('Native performance workflow and Rewards boundary with real RLS',()=>{
  let b:Base,a:SessionContext,subject:{employmentId:string;personId:string},manager:{employmentId:string;personId:string},self:SessionContext,mgr:SessionContext,cycleId:string,reviewId:string;
  let peers:{employmentId:string;ctx:SessionContext}[];
const {hire,view,editableDraftKpi,complete,reviewerPlan}=createOnehrServiceFixtures({get b(){return b;},get a(){return a;},get subject(){return subject;},get manager(){return manager;},get self(){return self;},get mgr(){return mgr;},get cycleId(){return cycleId;},get reviewId(){return reviewId;},get peers(){return peers;}});

  afterEach(()=>vi.unstubAllEnvs());
  beforeEach(async()=>{
    vi.stubEnv('OPENAI_API_KEY','fictional-unit-transport-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
    vi.mocked(readImage).mockReset().mockResolvedValue('Verified 15.9 units.');vi.mocked(generateDraft).mockReset().mockImplementation(referenceReply);vi.mocked(resolveActiveAiConfig).mockReset().mockResolvedValue(null);
    await resetDb();b=await seedBase();a=adminCtx(b);await setModule(b.tenantId,'performance','active');await setModule(b.tenantId,'rewards','active');a=await entitledCtx(b);
    subject=await hire('Assessment subject');manager=await hire('Assessment manager');
    const ctx=async(personId:string,role:'employee'|'manager'):Promise<SessionContext>=>({...a,userId:await createAppUser(b.tenantId,personId,role),personId,roles:[role],grants:undefined});
    self=await ctx(subject.personId,'employee');mgr=await ctx(manager.personId,'manager');
    peers=[];for(let i=0;i<4;i++){const h=await hire(`Peer ${i}`);peers.push({employmentId:h.employmentId,ctx:await ctx(h.personId,'employee')});}
    const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Grade 12'}).returning();
    for(const e of [subject,manager,...peers])await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.id,e.employmentId));
    for(const e of [subject,...peers])await setReportingLine(a,{subordinateEmploymentId:e.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
    ({cycleId}=await perf.createCycle(a,{name:'Native annual assessment',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`}));
    const policy=defaultPolicy(framework);policy.modules.evidence=true;policy.profiles=[{id:randomUUID(),companyId:b.companyId,grade:'12',name:'Engineering',competencies:[{id:'skill-1',principle:'Technical',text:'Current skill',future:false},{id:'skill-2',principle:'Technical',text:'Future skill',future:true}]}];
    await perf.configureOnehrCycle(a,cycleId,null,policy);await perf.openCycle(a,{cycleId});
    const [r]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,subject.employmentId)));reviewId=r.id;
  });
  afterAll(closeAll);
  it('publishes written lower-tier notes only on scope submission and keeps distinct tier caches',async()=>{
    await complete(true,'Verified delivery outcomes.');const actor=peers[0].ctx,make=(tier:'hod'|'bu')=>perf.createOnehrCalibration(a,cycleId,{name:'Written tier evidence',companyId:b.companyId,tier,reviewerUserIds:[actor.userId!],reviewIds:[reviewId],pbtAchievement:100,mode:'after'}),hod=await make('hod'),bu=await make('bu');
    const before=await perf.getAssessmentWrittenRemarks(actor,reviewId,bu,'pm',{generate:true});expect(before.entries.some(e=>e.text==='Verified delivery outcomes.')).toBe(true);expect(before.entries.some(e=>e.text==='Completed outcomes')).toBe(true);
    await perf.saveOnehrCalibration(actor,hod,(await perf.getOnehrCalibration(actor,hod)).session.revision,{reviewId,axis:'performance',performance:'AE',potential:null,performanceNote:'Confirmed broader outcomes.',potentialNote:''});
    expect((await perf.getAssessmentWrittenRemarks(actor,reviewId,bu,'pm')).entries.some(e=>e.role==='hod')).toBe(false);
    await perf.lockOnehrCalibration(actor,hod,(await perf.getOnehrCalibration(actor,hod)).session.revision,'','performance');
    expect(await perf.getAssessmentWrittenRemarks(actor,reviewId,bu,'pm')).toMatchObject({pending:true});
    const released=await perf.getAssessmentWrittenRemarks(actor,reviewId,bu,'pm',{generate:true});expect(released.entries).toContainEqual(expect.objectContaining({role:'hod',text:'Confirmed broader outcomes.',move:'moved ME → AE'}));
    const own=await perf.getAssessmentWrittenRemarks(actor,reviewId,hod,'pm',{generate:true});expect(own.entries.some(e=>e.role==='hod')).toBe(false);
    await perf.saveOnehrCalibration(actor,hod,(await perf.getOnehrCalibration(actor,hod)).session.revision,{reviewId,axis:'potential',performance:null,potential:'Mid',performanceNote:'',potentialNote:'Practise team leadership.'});
    expect((await perf.getAssessmentWrittenRemarks(actor,reviewId,bu,'pot')).entries.some(e=>e.role==='hod')).toBe(false);
    await perf.lockOnehrCalibration(actor,hod,(await perf.getOnehrCalibration(actor,hod)).session.revision,'','potential');
    expect((await perf.getAssessmentWrittenRemarks(actor,reviewId,bu,'pot')).entries).toContainEqual(expect.objectContaining({role:'hod',text:'Practise team leadership.',move:'moved High → Mid'}));
    const caches=await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary));expect(caches.filter(c=>c.kind==='pm_remarks').map(c=>c.contextId).sort()).toEqual([hod,bu].sort());
    const foreign=await seedBase();await setModule(foreign.tenantId,'performance','active');await expect(perf.getAssessmentWrittenRemarks(await entitledCtx(foreign),reviewId,bu,'pm')).rejects.toThrow(/not assigned/);
  });
  it('generates written summaries explicitly and rechecks authorization and settings after the provider returns',async()=>{
    await complete(true,'Verified delivery outcomes.');const actor=peers[0].ctx,group={...a,grants:[{role:'hr_admin',companyId:null}]},sid=await perf.createOnehrCalibration(a,cycleId,{name:'Written summary cache',companyId:b.companyId,tier:'hod',reviewerUserIds:[actor.userId!],reviewIds:[reviewId],pbtAchievement:100,mode:'after'});
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);vi.mocked(generateDraft).mockImplementation(referenceReply);
    expect(await perf.getAssessmentWrittenRemarks(actor,reviewId,sid,'pm')).toMatchObject({pending:true});expect(generateDraft).not.toHaveBeenCalled();
    const result=await perf.getAssessmentWrittenRemarks(actor,reviewId,sid,'pm',{generate:true});expect(result).toMatchObject({source:'ai'});expect(await perf.getAssessmentWrittenRemarks(actor,reviewId,sid,'pm')).toEqual(result);expect(generateDraft).toHaveBeenCalledOnce();
    await perf.setAssessmentAiSwitch(group,'tc',false);expect(await perf.getAssessmentWrittenRemarks(actor,reviewId,sid,'pm',{generate:true})).toMatchObject({source:'plain'});expect(generateDraft).toHaveBeenCalledOnce();
    await perf.setAssessmentAiSwitch(group,'tc',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await perf.setAssessmentAiSwitch(group,'tc',false);return referenceReply(cfg,args);});await expect(perf.getAssessmentWrittenRemarks(actor,reviewId,sid,'pm',{generate:true})).rejects.toThrow(/remarks or access changed/);
    await perf.setAssessmentAiSwitch(group,'tc',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[]}).where(eq(schema.onehrCalibration.id,sid));return referenceReply(cfg,args);});await expect(perf.getAssessmentWrittenRemarks(actor,reviewId,sid,'pm',{generate:true})).rejects.toThrow(/not assigned/);
    expect(await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);
  });
  it('combines Talent Box evidence with shared plans and invalidates cached feedback on withdrawal',async()=>{
    await complete(true,'Verified delivery.');const actor=peers[0].ctx;
    const make=(tier:'hod'|'bg')=>perf.createOnehrCalibration(a,cycleId,{name:'Combined talent evidence',companyId:b.companyId,tier,reviewerUserIds:[actor.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'}),sid=await make('bg'),hod=await make('hod');
    await perf.saveOnehrPlan(self,reviewId,null,{career:{aspiration:'Private aspiration canary',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:randomUUID(),area:'Private goal canary',dueOn:'',onJob:'Practise service recovery',fromOthers:'',formalLearning:'',status:'not_started'}]});
    const source=async()=>{const [r]=await withTenant(actor,tx=>tx.execute<{value:unknown}>(sql`select app.assessment_talent_source(${reviewId}::uuid,${sid}::uuid) as value`));return r.value;};
    expect(await source()).not.toBeNull();expect(JSON.stringify(await source())).not.toContain('Private');
    expect(await perf.getAssessmentTalentInsight(actor,reviewId,sid)).toMatchObject({pending:true,data:null});expect(generateDraft).not.toHaveBeenCalled();
    const plain=await perf.getAssessmentTalentInsight(actor,reviewId,sid,{generate:true});expect(plain).toMatchObject({source:'plain',data:{insight:expect.stringContaining('Their one KPI landed on target.')}});expect(plain.data?.insight).toContain('none shared yet');expect(plain.data?.decision).not.toContain('You moved');expect(await perf.getAssessmentTalentInsight(actor,reviewId,sid)).toEqual(plain);
    for(const denied of [self,mgr,peers[1].ctx]){await expect(perf.getAssessmentTalentInsight(denied,reviewId,sid)).rejects.toThrow(/Talent Box/);expect(await withTenant(denied,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);}
    await expect(perf.getAssessmentTalentInsight(actor,reviewId,hod)).rejects.toThrow(/Talent Box/);
    const other=await seedBase();await setModule(other.tenantId,'performance','active');await expect(perf.getAssessmentTalentInsight(await entitledCtx(other),reviewId,sid)).rejects.toThrow(/Talent Box/);
    const plan=(await view(self)).plans[0];await perf.saveOnehrPlan(self,reviewId,plan.revision,{careerRevision:(await view(self)).careerProfile!.revision,career:{...plan.career,aspiration:'Grow service leadership; email secret@fixture.test'},goals:plan.goals},true);
    expect(await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);vi.mocked(generateDraft).mockImplementation(referenceReply);
    const generated=await perf.getAssessmentTalentInsight(actor,reviewId,sid,{generate:true});expect(generated.source).toBe('ai');expect(generateDraft).toHaveBeenCalledOnce();const prompt=vi.mocked(generateDraft).mock.calls[0][1].prompt;expect(JSON.parse(prompt)).toMatchObject({purpose:'talent'});expect(prompt).not.toContain('Grow service leadership');expect(prompt).not.toContain('secret@fixture.test');expect(prompt).not.toMatch(/Peer 0|peerEmploymentId|requestId/);
    const [panel]=await owner.db.select().from(schema.onehrPanel).where(and(eq(schema.onehrPanel.reviewId,reviewId),eq(schema.onehrPanel.peerEmploymentId,peers[0].employmentId)));await perf.changeAssessmentPanelState(a,reviewId,(await view(a)).revision,panel.requestId,'archive','Invalid feedback.');
    expect(await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);expect(await perf.getAssessmentTalentInsight(actor,reviewId,sid)).toMatchObject({pending:true});
    vi.mocked(generateDraft).mockResolvedValue('{}');const thin=await perf.getAssessmentTalentInsight(actor,reviewId,sid,{generate:true});expect(thin.source).toBe('plain');expect(thin.data?.insight).toContain('No 360 reading');expect((await source()) as object).toMatchObject({leadership:[],pot:{valid:false,competencies:[]}});
    await perf.changeAssessmentPanelState(a,reviewId,(await view(a)).revision,panel.requestId,'restore','Feedback confirmed valid.');expect(await perf.getAssessmentTalentInsight(actor,reviewId,sid)).toMatchObject({pending:true});await perf.getAssessmentTalentInsight(actor,reviewId,sid,{generate:true});
    await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[]}).where(eq(schema.onehrCalibration.id,sid));expect(await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);
  });
  it('keeps Talent Box IDP readings on saved facts, then caches only the BG actors own final reading',async()=>{
    const id=await editableDraftKpi();await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Saved delivery.'}],'Delivered service.');
    const input={career:{aspiration:'Become a regional manager',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:randomUUID(),area:'Current skill',dueOn:'',onJob:'Practise current skill',fromOthers:'Observe weekly',formalLearning:'Workshop',status:'not_started'}]};
    await perf.saveOnehrPlan(self,reviewId,null,input,true);
    const actor=peers[0].ctx,sid=await perf.createOnehrCalibration(a,cycleId,{name:'BG plan reading',companyId:b.companyId,tier:'bg',reviewerUserIds:[actor.userId!,mgr.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    await perf.saveAssessmentDraft(mgr,reviewId,(await view()).revision,null,{kind:'moderation',lines:[{id,actual:1,note:'PRIVATE_BG_DRAFT_CANARY'}],remark:'PRIVATE_BG_REMARK_CANARY'});
    vi.mocked(resolveActiveAiConfig).mockResolvedValue(null);
    const own=await perf.getAssessmentIdpFit(mgr,reviewId,{generate:true});expect(own.data?.verdict).toBe('not_yet');
    for(const ctx of [actor,mgr]){const bg=await perf.getAssessmentIdpFit(ctx,reviewId,{sessionId:sid,generate:true});expect(bg).toMatchObject({canGenerate:false,source:'plain',pending:false});expect(bg.data?.scores).toContain("line manager's moderation Meet Expectation");expect(JSON.stringify(bg)).not.toContain('PRIVATE_BG');expect(bg.data?.discuss.join(' ')).not.toMatch(/\byou(?:r|'ll|'re|'ve)?\b/i);}
    expect(generateDraft).not.toHaveBeenCalled();expect((await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary)))).toEqual([]);
    const frame=await perf.getAssessmentTalentPerson(actor,reviewId,sid);expect(frame.plan?.goals[0]).toMatchObject({area:'Current skill',fromOthers:'Observe weekly',formalLearning:'Workshop'});expect(JSON.stringify(frame)).not.toMatch(/PRIVATE_BG|"yes":|"total":|"drafts":|peerEmploymentId/);
    await perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,2,'Verified service.');
    expect(await perf.getAssessmentIdpFit(actor,reviewId,{sessionId:sid})).toMatchObject({pending:true,canGenerate:true});
    const bg=await perf.getAssessmentIdpFit(actor,reviewId,{sessionId:sid,generate:true});expect(bg).toMatchObject({source:'plain',data:{verdict:'fits'}});expect(bg.data?.discuss).toContain("Their line manager agrees the support they'll give and checks progress mid-year.");
    expect(await perf.getAssessmentIdpFit(actor,reviewId,{sessionId:sid})).toEqual(bg);expect(await perf.getAssessmentIdpFit(mgr,reviewId,{sessionId:sid})).toMatchObject({pending:true});
    const combined=await perf.getAssessmentTalentInsight(actor,reviewId,sid,{generate:true});expect(combined.data?.insight).toContain('Development plan: fits well.');
    const cached=await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary));expect(cached.map(c=>c.kind).sort()).toEqual(['talent','talent_idp']);
    await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[]}).where(eq(schema.onehrCalibration.id,sid));expect(await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);await expect(perf.getAssessmentIdpFit(actor,reviewId,{sessionId:sid})).rejects.toThrow(/not assigned/);
  });
  it('rechecks Talent Box IDP settings and cohort after generation without accepting optimistic fit',async()=>{
    const id=await editableDraftKpi();await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Delivery outcome.'}],'Delivered service.');await perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,1,'Verified saved result.');const actor=peers[0].ctx,group={...a,grants:[{role:'hr_admin',companyId:null}]},sid=await perf.createOnehrCalibration(a,cycleId,{name:'BG IDP freshness',companyId:b.companyId,tier:'bg',reviewerUserIds:[actor.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    await perf.saveOnehrPlan(self,reviewId,null,{career:{aspiration:'Grow service skills',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:randomUUID(),area:'Service',dueOn:'',onJob:'Practise service delivery',fromOthers:'',formalLearning:'',status:'not_started'}]},true);
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);vi.mocked(generateDraft).mockResolvedValue(JSON.stringify({paragraph:'Their plan develops service skills.',verdict:'fits'}));
    const final=await perf.getAssessmentIdpFit(actor,reviewId,{sessionId:sid,generate:true});expect(final).toMatchObject({source:'plain',data:{verdict:'partly_fits'}});expect(final.data?.discuss).toContain("Their line manager talks through where their view and Assessment's differ.");expect(final.data?.scores).toContain("their line manager's moderation");
    await perf.setAssessmentAiSwitch(group,'idp',false);vi.mocked(generateDraft).mockClear();expect(await perf.getAssessmentIdpFit(actor,reviewId,{sessionId:sid,generate:true})).toMatchObject({source:'plain'});expect(generateDraft).not.toHaveBeenCalled();
    await perf.setAssessmentAiSwitch(group,'idp',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await perf.setAssessmentAiSwitch(group,'idp',false);return referenceReply(cfg,args);});await expect(perf.getAssessmentIdpFit(actor,reviewId,{sessionId:sid,generate:true})).rejects.toThrow(/facts or access changed/);
    await perf.setAssessmentAiSwitch(group,'idp',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[]}).where(eq(schema.onehrCalibration.id,sid));return referenceReply(cfg,args);});await expect(perf.getAssessmentIdpFit(actor,reviewId,{sessionId:sid,generate:true})).rejects.toThrow(/not assigned/);
  });
  it('saves one optional BG overall remark with independent revision, exact cohort privacy and final unit locks',async()=>{
    await complete();const actor=peers[0].ctx,other=peers[1].ctx,sid=await perf.createOnehrCalibration(a,cycleId,{name:'BG shared remark',companyId:b.companyId,tier:'bg',reviewerUserIds:[actor.userId!,other.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    const before=await perf.getOnehrCalibration(actor,sid);expect((await perf.getAssessmentTalentPerson(actor,reviewId,sid)).remark).toEqual({remark:'',revision:0,locked:false});
    expect(await perf.saveAssessmentTalentRemark(actor,sid,reviewId,0,'Shared BG observation.')).toBe(1);
    expect((await perf.getAssessmentTalentPerson(other,reviewId,sid)).remark).toMatchObject({remark:'Shared BG observation.',revision:1});
    await expect(perf.saveAssessmentTalentRemark(other,sid,reviewId,0,'Stale note')).rejects.toThrow(/changed/);
    await expect(perf.saveAssessmentTalentRemark(actor,sid,reviewId,1,'word '.repeat(221))).rejects.toThrow(/220/);
    const after=await perf.getOnehrCalibration(actor,sid);expect(after.session.revision).toBe(before.session.revision);expect(after.rows[0].entry).toEqual(before.rows[0].entry);
    for(const ctx of [self,mgr,peers[2].ctx]){expect(await withTenant(ctx,tx=>tx.select().from(schema.assessmentTalentRemark))).toEqual([]);await expect(perf.saveAssessmentTalentRemark(ctx,sid,reviewId,1,'Forbidden')).rejects.toThrow();}
    await expect(withTenant(actor,tx=>tx.update(schema.assessmentTalentRemark).set({remark:'Bypassed revision'}))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/revision/)})});
    expect(await perf.saveAssessmentTalentRemark(other,sid,reviewId,1,'')).toBe(2);expect((await perf.getAssessmentTalentPerson(actor,reviewId,sid)).remark.remark).toBe('');
    const cycle=(await perf.getOnehrCycle(a,cycleId))!;await owner.db.update(schema.onehrCycle).set({policy:{...cycle.policy,windows:{...cycle.policy.windows,tb_bgceo:{opensAt:null,closesAt:new Date(Date.now()-60000).toISOString()}}}}).where(eq(schema.onehrCycle.cycleId,cycleId));
    expect((await perf.getAssessmentTalentPerson(actor,reviewId,sid)).remark.locked).toBe(true);await expect(withTenant(actor,tx=>tx.update(schema.assessmentTalentRemark).set({remark:'After deadline',revision:3,updatedBy:actor.userId!}))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/not open/)})});
    await owner.db.update(schema.onehrCycle).set({policy:cycle.policy}).where(eq(schema.onehrCycle.cycleId,cycleId));
    await perf.saveAssessmentTalentRemark(actor,sid,reviewId,2,'Preserved BG remark.');
    await owner.db.update(schema.onehrCalibrationEntry).set({performanceLockedAt:new Date(),potentialLockedAt:new Date(),lockedAt:new Date()}).where(eq(schema.onehrCalibrationEntry.sessionId,sid));
    expect((await perf.getAssessmentTalentPerson(actor,reviewId,sid)).remark).toMatchObject({remark:'Preserved BG remark.',locked:true});await expect(perf.saveAssessmentTalentRemark(actor,sid,reviewId,3,'After lock')).rejects.toThrow(/locked/);
    await expect(withTenant(actor,tx=>tx.update(schema.assessmentTalentRemark).set({remark:'After lock',revision:4,updatedBy:actor.userId!}))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/locked/)})});
    expect(await owner.db.select().from(schema.payrollInput)).toEqual([]);expect(generateDraft).not.toHaveBeenCalled();
  });
  it('refuses Talent Box recommendations and rechecks review settings and exact cohort during generation',async()=>{
    await complete();const actor=peers[0].ctx,group={...a,grants:[{role:'hr_admin',companyId:null}]};
    const sid=await perf.createOnehrCalibration(a,cycleId,{name:'Talent summary safety',companyId:b.companyId,tier:'bg',reviewerUserIds:[actor.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);vi.mocked(generateDraft).mockResolvedValue(JSON.stringify({insight:'They should be moved to the top box.',decision:'Promote them and award a bonus.'}));
    expect(await perf.getAssessmentTalentInsight(actor,reviewId,sid,{generate:true})).toMatchObject({source:'plain'});expect((await perf.getOnehrCalibration(actor,sid)).rows[0].entry.performance).toBeNull();
    await perf.setAssessmentAiSwitch(group,'review',false);vi.mocked(generateDraft).mockClear();expect(await perf.getAssessmentTalentInsight(actor,reviewId,sid,{generate:true})).toMatchObject({source:'plain'});expect(generateDraft).not.toHaveBeenCalled();
    await perf.setAssessmentAiSwitch(group,'review',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await perf.setAssessmentAiSwitch(group,'review',false);return referenceReply(cfg,args);});await expect(perf.getAssessmentTalentInsight(actor,reviewId,sid,{generate:true})).rejects.toThrow(/facts or access changed/);
    await perf.setAssessmentAiSwitch(group,'review',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[]}).where(eq(schema.onehrCalibration.id,sid));return referenceReply(cfg,args);});await expect(perf.getAssessmentTalentInsight(actor,reviewId,sid,{generate:true})).rejects.toThrow(/Talent Box/);
  });
  it('withholds potential themes below threshold and exposes only anonymous submitted and reviewed evidence',async()=>{
    const sid=await perf.createOnehrCalibration(a,cycleId,{name:'Potential evidence',companyId:b.companyId,tier:'hod',reviewerUserIds:[peers[0].ctx.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'}),actor=peers[0].ctx;
    await perf.saveAssessmentDraft(self,reviewId,(await view(self)).revision,null,{kind:'competency_self',answers:{'skill-1':{answer:'yes',remark:'Private skill canary'},'skill-2':{answer:'no',remark:''}},remark:'Private reflection canary'});
    expect(await perf.getAssessmentPotentialInsight(actor,reviewId,sid,{generate:true})).toMatchObject({pending:false,source:'plain',data:{paragraph:'Not enough 360 feedback yet for an insight — 0 of the 4 raters needed have submitted.'}});expect(generateDraft).not.toHaveBeenCalled();
    const [thin]=await withTenant(actor,tx=>tx.execute<{value:unknown}>(sql`select app.assessment_potential_source(${reviewId}::uuid,${sid}::uuid) as value`));expect(thin.value).toMatchObject({principles:[],remarks:[],competencies:[],competencyRemark:'',managerRemark:''});
    await complete(false);
    await perf.saveAssessmentDraft(mgr,reviewId,(await view()).revision,null,{kind:'competency_manager',answers:{'skill-1':{answer:'yes',remark:'Private manager canary'},'skill-2':{answer:'yes',remark:''}},remark:'Private manager reflection'});
    const [pending]=await withTenant(actor,tx=>tx.execute<{value:unknown}>(sql`select app.assessment_potential_source(${reviewId}::uuid,${sid}::uuid) as value`));expect(pending.value).toMatchObject({valid:true,competencies:[],managerRemark:'',competencyStatus:'submitted'});expect(JSON.stringify(pending.value)).not.toMatch(/Private|Peer 0|peerEmploymentId|requestId/);
    await perf.submitOnehrCompetencies(mgr,reviewId,(await view()).revision,{'skill-1':{answer:'yes',remark:'Observed delivery'},'skill-2':{answer:'no',remark:''}},true,'Practise future skills.');
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);vi.mocked(generateDraft).mockImplementation(referenceReply);
    expect(await perf.getAssessmentPotentialInsight(actor,reviewId,sid)).toMatchObject({pending:true,data:null});expect(generateDraft).not.toHaveBeenCalled();
    const output=await perf.getAssessmentPotentialInsight(actor,reviewId,sid,{generate:true});expect(output).toMatchObject({source:'ai',pending:false});expect(generateDraft).toHaveBeenCalledOnce();
    const prompt=vi.mocked(generateDraft).mock.calls[0][1].prompt;expect(JSON.parse(prompt)).toMatchObject({purpose:'potential'});expect(prompt).not.toContain('Observed delivery');expect(prompt).not.toMatch(/Private|Peer 0|peerEmploymentId|requestId/);for(const peer of peers)expect(prompt).not.toContain(peer.employmentId);
    expect(await perf.getAssessmentPotentialInsight(actor,reviewId,sid)).toEqual(output);expect(generateDraft).toHaveBeenCalledOnce();
    for(const denied of [self,mgr,peers[1].ctx]){await expect(perf.getAssessmentPotentialInsight(denied,reviewId,sid)).rejects.toThrow(/not assigned/);expect(await withTenant(denied,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);}
    const other=await seedBase();await setModule(other.tenantId,'performance','active');await expect(perf.getAssessmentPotentialInsight(await entitledCtx(other),reviewId,sid)).rejects.toThrow(/not assigned/);
    const [panel]=await owner.db.select().from(schema.onehrPanel).where(and(eq(schema.onehrPanel.reviewId,reviewId),eq(schema.onehrPanel.peerEmploymentId,peers[0].employmentId)));await perf.changeAssessmentPanelState(a,reviewId,(await view(a)).revision,panel.requestId,'archive','Remove invalid response.');
    expect(await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);expect(await perf.getAssessmentPotentialInsight(actor,reviewId,sid)).toMatchObject({source:'plain',data:{paragraph:'Not enough 360 feedback yet for an insight — 3 of the 4 raters needed have submitted.'}});
  });
  it('rechecks exact potential cohort access and independent assistance settings before saving',async()=>{
    await complete();const actor=peers[0].ctx,group={...a,grants:[{role:'hr_admin',companyId:null}]};
    const make=(tier:'hod'|'bu')=>perf.createOnehrCalibration(a,cycleId,{name:'Potential cohort',companyId:b.companyId,tier,reviewerUserIds:[actor.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'}),sid=await make('hod');
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    await perf.setAssessmentAiSwitch(group,'tc',false);expect(await perf.getAssessmentPotentialInsight(actor,reviewId,sid,{generate:true})).toMatchObject({source:'plain'});expect(generateDraft).not.toHaveBeenCalled();
    await perf.setAssessmentAiSwitch(group,'tc',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await perf.setAssessmentAiSwitch(group,'tc',false);return referenceReply(cfg,args);});
    await expect(perf.getAssessmentPotentialInsight(actor,reviewId,sid,{generate:true})).rejects.toThrow(/facts or access changed/);
    await perf.setAssessmentAiSwitch(group,'tc',true);const second=await make('bu');vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[]}).where(eq(schema.onehrCalibration.id,sid));return referenceReply(cfg,args);});
    await expect(perf.getAssessmentPotentialInsight(actor,reviewId,sid,{generate:true})).rejects.toThrow(/not assigned/);
    // Another permitted cohort does not authorize the revoked requested cohort, but may read viewer-independent facts.
    await expect(perf.getAssessmentPotentialInsight(actor,reviewId,sid)).rejects.toThrow(/not assigned/);expect(await perf.getAssessmentPotentialInsight(actor,reviewId,second)).toMatchObject({pending:true});
    await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[]}).where(eq(schema.onehrCalibration.id,second));expect(await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);
  });
  it('summarizes submitted competency self-claims only, caches explicitly and hides the cache from other actors',async()=>{
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    await perf.saveAssessmentDraft(self,reviewId,(await view(self)).revision,null,{kind:'competency_self',answers:{'skill-1':{answer:'yes',remark:'Private competency draft'},'skill-2':{answer:'no',remark:''}},remark:'Private competency reflection'});
    expect(await perf.getAssessmentCompetencyInsight(mgr,reviewId,{generate:true})).toMatchObject({status:'pending',pending:false,data:null});expect(generateDraft).not.toHaveBeenCalled();
    const [hidden]=await withTenant(mgr,tx=>tx.execute<{value:unknown}>(sql`select app.assessment_competency_source(${reviewId}::uuid) as value`));expect(hidden.value).toMatchObject({competencies:[],remark:''});
    await perf.submitOnehrCompetencies(self,reviewId,(await view(self)).revision,{'skill-1':{answer:'yes',remark:''},'skill-2':{answer:'yes',remark:''}},false,'I am developing these skills through assigned work. Contact secret@fixture.test.');
    await perf.submitOnehrCompetencies(mgr,reviewId,(await view()).revision,{'skill-1':{answer:'yes',remark:'Manager-only assessment canary'},'skill-2':{answer:'yes',remark:'Manager-only assessment canary'}},true,'Manager-only overall canary');
    expect(await perf.getAssessmentCompetencyInsight(mgr,reviewId)).toMatchObject({status:'reviewed',pending:true,data:null});expect(generateDraft).not.toHaveBeenCalled();
    vi.mocked(generateDraft).mockImplementation(referenceReply);
    const generated=await perf.getAssessmentCompetencyInsight(mgr,reviewId,{generate:true});expect(generated).toMatchObject({source:'ai',pending:false,data:{verdict:'not_justified'}});expect(generateDraft).toHaveBeenCalledOnce();
    const prompt=vi.mocked(generateDraft).mock.calls[0][1].prompt;expect(prompt).not.toContain('Manager-only');expect(prompt).not.toContain('Private competency');expect(prompt).not.toContain('secret@fixture.test');
    expect(await perf.getAssessmentCompetencyInsight(mgr,reviewId)).toEqual(generated);expect(generateDraft).toHaveBeenCalledOnce();
    for(const actor of [self,peers[0].ctx]){await expect(perf.getAssessmentCompetencyInsight(actor,reviewId)).rejects.toThrow(/not assigned/);expect(await withTenant(actor,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);}
    const other=await seedBase();await setModule(other.tenantId,'performance','active');await expect(perf.getAssessmentCompetencyInsight(await entitledCtx(other),reviewId)).rejects.toThrow(/not assigned/);
  });
  it('uses a plain competency summary when assistance is off and refuses changed access during generation',async()=>{
    await perf.submitOnehrCompetencies(self,reviewId,(await view(self)).revision,{'skill-1':{answer:'yes',remark:''},'skill-2':{answer:'yes',remark:''}},false,'I am developing these skills through assigned work.');
    const group={...a,grants:[{role:'hr_admin',companyId:null}]};vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    await perf.setAssessmentAiSwitch(group,'tc',false);expect(await perf.getAssessmentCompetencyInsight(mgr,reviewId,{generate:true})).toMatchObject({source:'plain',data:{verdict:'not_justified'}});expect(generateDraft).not.toHaveBeenCalled();
    await perf.setAssessmentAiSwitch(group,'tc',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await perf.setAssessmentAiSwitch(group,'tc',false);return referenceReply(cfg,args);});
    await expect(perf.getAssessmentCompetencyInsight(mgr,reviewId,{generate:true})).rejects.toThrow(/facts or access changed/);
    const [preserved]=await owner.db.select().from(schema.assessmentSummary).where(eq(schema.assessmentSummary.reviewId,reviewId));expect(preserved.source).toBe('plain');
    await perf.setAssessmentAiSwitch(group,'tc',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await owner.db.update(schema.performanceReview).set({reviewerEmploymentId:peers[0].employmentId}).where(eq(schema.performanceReview.id,reviewId));return referenceReply(cfg,args);});
    await expect(perf.getAssessmentCompetencyInsight(mgr,reviewId,{generate:true})).rejects.toThrow(/not assigned/);expect(await withTenant(mgr,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);
  });
  it('generates adjudicated insights explicitly, reuses current cache and discards a provider reply after reviewer access is revoked',async()=>{
    await complete();const source=await perf.getAssessmentInsightSource(mgr,reviewId),title=source.facts.rows[0].kpi;
    const raw=JSON.stringify({paragraph:'Their result met target, and their note explains the period.',overall:'Their note explains the result.',verdict:'well_justified',verdict_why:'Their note explains the result.',kpis:[{kpi:title,read:'The result met target.',evidence:'none',evidence_note:'',justified:'yes',why:'Their note explains the result.'}],discuss:[]});
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);vi.mocked(generateDraft).mockClear().mockImplementation(referenceReply);
    expect(await perf.getAssessmentPerformanceInsight(mgr,reviewId)).toMatchObject({pending:true,data:null});expect(generateDraft).not.toHaveBeenCalled();expect(readImage).not.toHaveBeenCalled();
    const result=await perf.getAssessmentPerformanceInsight(mgr,reviewId,reviewId,{generate:true});expect(result).toMatchObject({pending:false,source:'ai',data:{verdict:'well_justified'}});expect(generateDraft).toHaveBeenCalledOnce();expect(vi.mocked(generateDraft).mock.calls[0][1].timeoutMs).toBe(22000);
    expect(await perf.getAssessmentPerformanceInsight(mgr,reviewId)).toMatchObject({pending:false,source:'ai'});expect(generateDraft).toHaveBeenCalledOnce();
    expect(await withTenant(peers[0].ctx,tx=>tx.select().from(schema.assessmentInsight))).toEqual([]);
    await owner.db.update(schema.onehrReview).set({selfRemark:'New submitted delivery context.'}).where(eq(schema.onehrReview.reviewId,reviewId));
    expect(await perf.getAssessmentPerformanceInsight(mgr,reviewId)).toMatchObject({pending:true});
    vi.mocked(generateDraft).mockRejectedValueOnce(Error('fixture unavailable'));
    expect(await perf.getAssessmentPerformanceInsight(mgr,reviewId,reviewId,{generate:true})).toMatchObject({source:'plain',data:{verdict:'well_justified'}});
    const [cache]=await owner.db.select().from(schema.assessmentInsight).where(eq(schema.assessmentInsight.actorUserId,mgr.userId!));expect(cache.retry).toBe(true);
    vi.mocked(generateDraft).mockClear();await perf.getAssessmentPerformanceInsight(mgr,reviewId,reviewId,{generate:true});expect(generateDraft).not.toHaveBeenCalled();
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+11*60000);try{await perf.getAssessmentPerformanceInsight(mgr,reviewId,reviewId,{generate:true});expect(generateDraft).toHaveBeenCalledOnce();}finally{clock.mockRestore();}
    const sid=await perf.createOnehrCalibration(a,cycleId,{name:'Insight revocation',companyId:b.companyId,tier:'hod',reviewerUserIds:[peers[0].ctx.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[]}).where(eq(schema.onehrCalibration.id,sid));return referenceReply(cfg,args);});
    await expect(perf.getAssessmentPerformanceInsight(peers[0].ctx,reviewId,sid,{generate:true})).rejects.toThrow(/not assigned/);
    expect(await owner.db.select().from(schema.assessmentInsight).where(eq(schema.assessmentInsight.contextId,sid))).toEqual([]);
    // WP-B2: a live seat is revoked the same way. The seat ends during the provider call; the reply is discarded.
    const seated=peers[1],seatScope=await withTenant(a,async tx=>{const [s]=await tx.insert(schema.onehrCalibration).values({tenantId:b.tenantId,cycleId,companyId:b.companyId,name:'Seat insight revocation',tier:'bu',reviewerUserIds:[],anchorKind:'bu_ceo'}).returning();await tx.insert(schema.onehrCalibrationEntry).values({tenantId:b.tenantId,sessionId:s.id,reviewId,employmentId:subject.employmentId});return s.id;});
    const seat=await perf.appointLeaderSeat(a,{seatType:'bu_ceo',companyId:b.companyId,holderEmploymentId:seated.employmentId});
    vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await perf.endLeaderSeat(a,seat.id);return referenceReply(cfg,args);});
    await expect(perf.getAssessmentPerformanceInsight(seated.ctx,reviewId,seatScope,{generate:true})).rejects.toThrow(/not assigned/);
    expect(await owner.db.select().from(schema.assessmentInsight).where(eq(schema.assessmentInsight.contextId,seatScope))).toEqual([]);
  });
  it('projects insight facts and file text only for the assigned reviewer, retaining decimals and excluding private drafts',async()=>{
    const id=randomUUID(),scoring={mechanism:'A' as const,method:'more' as const,rates:[0,50,100,150,200] as [number,number,number,number,number]};
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Delivery',description:'Verified delivery',weightBp:10000,unit:'units',scoring,moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'Agreed objectives');
    const file=await perf.addPerformanceAttachment(self,{reviewId,kpiId:id,stageKind:null,fileName:'delivery.txt',mimeType:'text/plain',content:Buffer.from('Verified delivery: 100.12345 units.')});
    await perf.saveAssessmentDraft(self,reviewId,(await view(self)).revision,null,{kind:'results',lines:[{id,actual:999,note:'Private employee explanation'}],remark:'Private employee remark'});
    const sid=await perf.createOnehrCalibration(a,cycleId,{name:'Insight department',companyId:b.companyId,tier:'hod',reviewerUserIds:[peers[0].ctx.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'}),calibrator=peers[0].ctx;
    const before=await perf.getAssessmentInsightSource(mgr,reviewId);expect(before.facts.rows).toEqual([]);expect(before.attachments).toEqual([]);expect(before.facts.remark).toBe('');
    expect((await perf.getAssessmentInsightSource(calibrator,reviewId,sid)).facts.rows).toEqual([]);
    await expect(perf.getAssessmentInsightSource(self,reviewId,sid)).rejects.toThrow(/not assigned/);await expect(perf.getAssessmentInsightSource(peers[1].ctx,reviewId,sid)).rejects.toThrow(/not assigned/);
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:100.12345,note:'Submitted delivery explanation'}],'Submitted delivery remark.');
    let source=await perf.getAssessmentInsightSource(calibrator,reviewId,sid);expect(source.facts.rows[0]).toMatchObject({result:'100.12345 units',target:'100',note:'Submitted delivery explanation',moderation:[]});expect(source.facts.remark).toBe('Submitted delivery remark.');
    expect((await perf.readAssessmentFileTexts(calibrator,reviewId,{contextId:sid})).get(file.id)).toMatchObject({status:'ok',text:'Verified delivery: 100.12345 units.'});expect(readImage).not.toHaveBeenCalled();
    expect(await perf.getAssessmentPerformanceInsight(calibrator,reviewId,sid,{generate:true})).toMatchObject({source:'plain',pending:false,data:{verdict:'well_justified'}});expect(await perf.getAssessmentPerformanceInsight(calibrator,reviewId,sid)).toMatchObject({source:'plain',pending:false});
    await perf.saveAssessmentDraft(mgr,reviewId,(await view()).revision,null,{kind:'moderation',lines:[{id,actual:50,note:'Private manager explanation'}],remark:'Private manager remark'});
    source=await perf.getAssessmentInsightSource(calibrator,reviewId,sid);expect(source.facts.rows[0].moderation).toEqual([]);expect(JSON.stringify(source)).not.toContain('Private manager');
    await perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,50,'Confirmed manager explanation');
    expect((await perf.getAssessmentInsightSource(mgr,reviewId)).facts.rows[0].approvers).toEqual([]);
    source=await perf.getAssessmentInsightSource(calibrator,reviewId,sid);expect(source.facts.rows[0].moderation).toEqual([expect.objectContaining({by:'Assessment manager',from:100.12345,to:50,why:'Confirmed manager explanation'})]);
    await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[]}).where(eq(schema.onehrCalibration.id,sid));
    await expect(perf.getAssessmentInsightSource(calibrator,reviewId,sid)).rejects.toThrow(/not assigned/);await expect(perf.getAssessmentFileTexts(calibrator,reviewId,sid)).rejects.toThrow(/not assigned/);
  });
  it('withdraws colleague feedback tasks when the subject leaves the cycle without granting the rater review access',async()=>{
    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,peers.map(peer=>({employmentId:peer.employmentId,relationship:'peer'})));
    const rater=peers[0].ctx,request=(await perf.onehrAssignments(rater)).feedback.find(f=>f.subject==='Assessment subject')!;
    const card=await perf.getOnehrFeedback(rater,request.id);
    expect(await withTenant(rater,tx=>tx.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId)))).toEqual([]);
    expect((await perf.performanceWorkspace(rater)).some(item=>item.id===request.id)).toBe(true);
    let cycle=(await perf.getOnehrCycle(a,cycleId))!,participation=cycle.participants.find(p=>p.employmentId===subject.employmentId)!;
    await perf.setAssessmentParticipation(a,cycleId,cycle.revision,subject.employmentId,participation.revision,'remove');
    expect((await perf.onehrAssignments(rater)).feedback.some(f=>f.id===request.id)).toBe(false);
    expect((await perf.performanceWorkspace(rater)).some(item=>item.id===request.id)).toBe(false);
    await expect(perf.getOnehrFeedback(rater,request.id)).rejects.toThrow(/removed/);
    await expect(perf.submitOnehrFeedback(rater,request.id,Object.fromEntries(card.statements.map(s=>[s.id,'yes'])),'Observed delivery')).rejects.toThrow(/removed/);
    const [preserved]=await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.requestId,request.id));expect(preserved.submittedAt).toBeNull();expect(preserved.archivedAt).toBeNull();
    cycle=(await perf.getOnehrCycle(a,cycleId))!;participation=cycle.participants.find(p=>p.employmentId===subject.employmentId)!;
    await perf.setAssessmentParticipation(a,cycleId,cycle.revision,subject.employmentId,participation.revision,'add');
    expect((await perf.getOnehrFeedback(rater,request.id)).statements).toEqual(card.statements);
    expect(await withTenant(rater,tx=>tx.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId)))).toEqual([]);
  });

  it('keeps excluded staff available as raters and preserves inputs across HR roster changes',async()=>{
    const newcomer=await hireEmployee(a,{person:{fullName:'Unconfirmed rater',primaryEmail:`${randomUUID()}@assessment.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
    const [numericGrade]=await owner.db.select().from(schema.jobGrade).where(and(eq(schema.jobGrade.tenantId,b.tenantId),eq(schema.jobGrade.code,'12')));
    await owner.db.update(schema.employment).set({gradeId:numericGrade.id}).where(eq(schema.employment.id,newcomer.employmentId));
    const newcomerCtx={...a,userId:await createAppUser(b.tenantId,newcomer.personId,'employee'),personId:newcomer.personId,roles:['employee'] as SessionContext['roles'],grants:undefined};
    const next=await perf.createCycle(a,{name:'Participation boundary',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`,assessmentWorkflow:true});
    const preview=await perf.previewEligibleCount(a,{companyId:b.companyId,assessmentWorkflow:true});
    const opened=await perf.openCycle(a,{cycleId:next.cycleId});expect(opened.reviewsSpawned).toBe(preview.count);
    expect(await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,next.cycleId),eq(schema.performanceReview.employmentId,newcomer.employmentId)))).toHaveLength(0);
    const [target]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,next.cycleId),eq(schema.performanceReview.employmentId,subject.employmentId)));
    await perf.assignOnehrPanel(a,target.id,1,[{employmentId:newcomer.employmentId,relationship:'peer'}]);
    const assignments=await perf.onehrAssignments(newcomerCtx);expect(assignments.reviews.some(r=>r.cycle==='Participation boundary')).toBe(false);expect(assignments.feedback.some(f=>f.subject==='Assessment subject')).toBe(true);
    let cycle=(await perf.getOnehrCycle(a,next.cycleId))!;
    const original=cycle.participants.find(p=>p.employmentId===newcomer.employmentId)!;expect(original).toMatchObject({takingPart:false,reason:'not_confirmed'});
    await expect(perf.setAssessmentParticipation(newcomerCtx,next.cycleId,cycle.revision,newcomer.employmentId,original.revision,'add')).rejects.toThrow(/administrator/);
    await perf.setAssessmentParticipation(a,next.cycleId,cycle.revision,newcomer.employmentId,original.revision,'add');
    cycle=(await perf.getOnehrCycle(a,next.cycleId))!;let participant=cycle.participants.find(p=>p.employmentId===newcomer.employmentId)!;
    const [review]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,next.cycleId),eq(schema.performanceReview.employmentId,newcomer.employmentId)));
    expect((await perf.onehrAssignments(newcomerCtx)).reviews.some(r=>r.id===review.id)).toBe(true);
    const kpi=randomUUID();await owner.db.update(schema.onehrReview).set({selfRemark:'Retain the original working record'}).where(eq(schema.onehrReview.reviewId,review.id));
    await perf.setAssessmentParticipation(a,next.cycleId,cycle.revision,newcomer.employmentId,participant.revision,'remove');
    expect((await perf.onehrAssignments(newcomerCtx)).reviews.some(r=>r.id===review.id)).toBe(false);
    await expect(perf.saveOnehrKpis(newcomerCtx,review.id,1,[{id:kpi,title:'Excluded task',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:null}])).rejects.toThrow(/not participating/);
    expect(await withTenant(newcomerCtx,tx=>tx.select().from(schema.assessmentParticipationSnapshot).where(eq(schema.assessmentParticipationSnapshot.cycleId,next.cycleId)))).toHaveLength(0);
    expect((await perf.getOnehrReview(a,review.id))?.selfRemark).toBe('Retain the original working record');
    const [preserved]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,review.id));expect(preserved.selfRemark).toBe('Retain the original working record');
    cycle=(await perf.getOnehrCycle(a,next.cycleId))!;participant=cycle.participants.find(p=>p.employmentId===newcomer.employmentId)!;
    await perf.setAssessmentParticipation(a,next.cycleId,cycle.revision,newcomer.employmentId,participant.revision,'clear');
    cycle=(await perf.getOnehrCycle(a,next.cycleId))!;expect(cycle.participants.find(p=>p.employmentId===newcomer.employmentId)).toMatchObject({takingPart:false,override:null,reason:'not_confirmed'});
    expect(await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,next.cycleId),eq(schema.performanceReview.employmentId,newcomer.employmentId)))).toHaveLength(1);
  });

  it('retains each reviewer’s own overall remark and releases attributed words only when every KPI is locked',async()=>{
    const matrix=peers[0],ids=[randomUUID(),randomUUID()],scoring={mechanism:'A' as const,method:'more' as const,rates:[0,50,100,150,200] as [number,number,number,number,number]};
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,ids.map((id,i)=>({id,title:`Delivery ${i+1}`,description:'',weightBp:5000,unit:'units',scoring,moderatorEmploymentId:manager.employmentId})));
    await perf.assignAssessmentKpiModerator(a,reviewId,(await view(a)).revision,ids[1],matrix.employmentId);
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,(await view(self)).kpis,true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'');await perf.approveOnehrScorecard(matrix.ctx,reviewId,(await view(matrix.ctx)).revision,true,'');
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,ids.map(id=>({id,actual:100,note:'Delivered the agreed work'})),'Both deliverables met target.');
    const sid=await perf.createOnehrCalibration(a,cycleId,{name:'Attribution scope',companyId:b.companyId,tier:'hod',reviewerUserIds:[peers[1].ctx.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    const save=async(ctx:SessionContext,id:string,remark:string)=>{const current=await view(ctx);await perf.saveAssessmentDraft(ctx,reviewId,current.revision,current.drafts.find(d=>d.kind==='moderation')?.revision??null,{kind:'moderation',lines:[{id,actual:100,note:'Private numeric explanation'}],remark});};
    await save(mgr,ids[0],'Verified the line manager deliverable.');await save(matrix.ctx,ids[1],'Verified the matrix deliverable.');
    expect((await view()).ownReviewerRemark).toBe('Verified the line manager deliverable.');expect((await view(matrix.ctx)).ownReviewerRemark).toBe('Verified the matrix deliverable.');
    expect((await view()).drafts.find(d=>d.kind==='moderation')?.payload).toMatchObject({remark:'Verified the line manager deliverable.'});
    expect((await owner.db.select().from(schema.assessmentDraft).where(eq(schema.assessmentDraft.actorUserId,mgr.userId!)))[0].payload).toMatchObject({remark:''});
    expect((await view(self)).reviewerRemarks).toEqual([]);expect((await view(self)).managerRemark).toBe('');
    const [pendingSharedRow]=await withTenant(self,tx=>tx.select({managerRemark:schema.onehrReview.managerRemark,managerRemarkByUserId:schema.onehrReview.managerRemarkByUserId}).from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId)));expect(pendingSharedRow).toEqual({managerRemark:'',managerRemarkByUserId:null});
    expect((await perf.getAssessmentInsightSource(peers[1].ctx,reviewId,sid)).facts.mgr_remarks).toEqual([]);
    expect(await withTenant(self,tx=>tx.select().from(schema.assessmentReviewerRemark))).toEqual([]);
    await expect(withTenant(matrix.ctx,tx=>tx.insert(schema.assessmentReviewerRemark).values({tenantId:b.tenantId,reviewId,actorUserId:mgr.userId!,actorRole:'line_manager',remark:'Forged author'}))).rejects.toThrow();
    await expect(withTenant(mgr,tx=>tx.update(schema.onehrReview).set({managerRemark:'Overwrite the cache'}).where(eq(schema.onehrReview.reviewId,reviewId)))).rejects.toThrow();
    await perf.submitAssessmentModeration(mgr,reviewId,(await view()).revision,[{id:ids[0],actual:100,note:'Verified delivery'}],'Verified the line manager deliverable.');
    expect((await view(self)).reviewerRemarks).toEqual([]);expect((await perf.getAssessmentInsightSource(peers[1].ctx,reviewId,sid)).facts.mgr_remarks).toEqual([]);
    expect((await perf.performanceWorkspace(mgr)).find(i=>i.id===reviewId&&i.module==='pm')?.state).toBe('done');expect((await perf.performanceWorkspace(matrix.ctx)).find(i=>i.id===reviewId&&i.module==='pm')?.state).toBe('open');
    await expect(withTenant(mgr,tx=>tx.update(schema.assessmentReviewerRemark).set({remark:'Rewritten after confirmation'}).where(eq(schema.assessmentReviewerRemark.actorUserId,mgr.userId!)))).rejects.toThrow();
    const [before]=await owner.db.select().from(schema.assessmentReviewerRemark).where(eq(schema.assessmentReviewerRemark.actorUserId,mgr.userId!));
    await withTenant(mgr,tx=>tx.update(schema.assessmentReviewerRemark).set({actorRole:'approver',updatedAt:new Date(0)}).where(eq(schema.assessmentReviewerRemark.actorUserId,mgr.userId!)));
    const [after]=await owner.db.select().from(schema.assessmentReviewerRemark).where(eq(schema.assessmentReviewerRemark.actorUserId,mgr.userId!));expect(after).toEqual(before);
    await perf.submitAssessmentModeration(matrix.ctx,reviewId,(await view(matrix.ctx)).revision,[{id:ids[1],actual:100,note:'Verified matrix delivery'}],'Verified the matrix deliverable.');
    const publicRemarks=(await view(self)).reviewerRemarks;expect(publicRemarks).toEqual([
      expect.objectContaining({actorUserId:mgr.userId,author:'Assessment manager',role:'Line manager',remark:'Verified the line manager deliverable.'}),
      expect.objectContaining({actorUserId:matrix.ctx.userId,author:'Peer 0',role:'Approver',remark:'Verified the matrix deliverable.'}),
    ]);
    expect((await perf.getAssessmentInsightSource(peers[1].ctx,reviewId,sid)).facts.mgr_remarks).toEqual(publicRemarks.map(({author,remark,role})=>({author,remark,role})));
    const [legacy]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));expect(legacy).toMatchObject({managerRemark:'Verified the line manager deliverable.',managerRemarkByUserId:mgr.userId});
    expect(await withTenant(peers[2].ctx,tx=>tx.select().from(schema.assessmentReviewerRemark))).toEqual([]);
  });
  it('previews curve fit without writes or providers, then preserves human notes and skips stale moves',async()=>{
    await complete();const reviewer=peers[0].ctx,[thin]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,peers[1].employmentId))),sessionId=await perf.createOnehrCalibration(a,cycleId,{name:'Fit preview',companyId:b.companyId,tier:'bu',reviewerUserIds:[reviewer.userId!,mgr.userId!],reviewIds:[reviewId,thin.reviewId],pbtAchievement:100});
    await perf.saveOnehrCalibration(reviewer,sessionId,1,{reviewId,axis:'performance',performance:'OU',potential:null,performanceNote:'My considered observation.',potentialNote:''});
    await perf.saveOnehrCalibration(reviewer,sessionId,2,{reviewId:thin.reviewId,axis:'performance',performance:'OU',potential:null,performanceNote:'Awaiting score.',potentialNote:''});
    const before=await owner.db.select().from(schema.onehrCalibrationEntry).where(eq(schema.onehrCalibrationEntry.sessionId,sessionId)).orderBy(schema.onehrCalibrationEntry.reviewId),events=(await owner.db.select().from(schema.domainEvent)).length;
    const preview=await perf.previewAssessmentCalibrationFit(reviewer,sessionId,'performance',b.companyId);expect(preview.moves).toHaveLength(1);expect(preview.moves.find(m=>m.id===reviewId)).toMatchObject({id:reviewId,from:'OU',to:'AE'});expect(preview.withinAfter).toBe(true);
    expect(await owner.db.select().from(schema.onehrCalibrationEntry).where(eq(schema.onehrCalibrationEntry.sessionId,sessionId)).orderBy(schema.onehrCalibrationEntry.reviewId)).toEqual(before);expect((await owner.db.select().from(schema.domainEvent)).length).toBe(events);expect(generateDraft).not.toHaveBeenCalled();expect(readImage).not.toHaveBeenCalled();
    const reading=await perf.getAssessmentPerformanceInsight(reviewer,reviewId,sessionId,{generate:true});expect(reading.data?.verdict).toBeTruthy();
    expect((await perf.previewAssessmentCalibrationFit(reviewer,sessionId,'performance',b.companyId)).moves.find(m=>m.id===reviewId)!.reasons.some(r=>r.startsWith('AI insight:'))).toBe(true);
    expect((await perf.previewAssessmentCalibrationFit(mgr,sessionId,'performance',b.companyId)).moves.find(m=>m.id===reviewId)!.reasons.some(r=>r.startsWith('AI insight:'))).toBe(false);
    expect(await perf.applyAssessmentCalibrationFit(reviewer,sessionId,'performance',b.companyId,preview.moves)).toMatchObject({applied:[reviewId],skipped:[],revision:4});
    const [after]=await owner.db.select().from(schema.onehrCalibrationEntry).where(and(eq(schema.onehrCalibrationEntry.sessionId,sessionId),eq(schema.onehrCalibrationEntry.reviewId,reviewId)));expect(after).toMatchObject({performance:'AE',performanceNote:'My considered observation.',potential:before.find(e=>e.reviewId===reviewId)!.potential,potentialNote:before.find(e=>e.reviewId===reviewId)!.potentialNote,performanceLockedAt:null,potentialLockedAt:null});
    expect(await perf.applyAssessmentCalibrationFit(reviewer,sessionId,'performance',b.companyId,preview.moves)).toMatchObject({applied:[],skipped:[reviewId],revision:4});
    expect(await owner.db.select().from(schema.onehrResult)).toEqual([]);expect(await owner.db.select().from(schema.payrollInput)).toEqual([]);
    await expect(perf.previewAssessmentCalibrationFit(self,sessionId,'performance',b.companyId)).rejects.toThrow();await expect(perf.applyAssessmentCalibrationFit(self,sessionId,'performance',b.companyId,preview.moves)).rejects.toThrow();
    await expect(perf.previewAssessmentCalibrationFit(reviewer,sessionId,'performance',randomUUID())).rejects.toThrow(/scope/);
    const hod=await perf.createOnehrCalibration(a,cycleId,{name:'No department curve',companyId:b.companyId,tier:'hod',reviewerUserIds:[reviewer.userId!],reviewIds:[reviewId],pbtAchievement:100});await expect(perf.previewAssessmentCalibrationFit(reviewer,hod,'performance',b.companyId)).rejects.toThrow(/no curve/);
    const fresh=(await perf.getOnehrCycle(a,cycleId))!;await perf.updateOnehrWindows(a,cycleId,fresh.revision,{...fresh.policy.windows,pm_buceo:{opensAt:null,closesAt:new Date(Date.now()-60000).toISOString()}},'Close the preview window');await expect(perf.applyAssessmentCalibrationFit(reviewer,sessionId,'performance',b.companyId,preview.moves)).rejects.toThrow(/closed/);
  });
  it('APR-022 on fit Apply: a move without a saved reason is applied with an empty note, never a generated or client-supplied one, and a move the server fit does not make is skipped',async()=>{
    await complete();const reviewer=peers[0].ctx,[thin]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,peers[1].employmentId))),sessionId=await perf.createOnehrCalibration(a,cycleId,{name:'Fit reasons',companyId:b.companyId,tier:'bu',reviewerUserIds:[reviewer.userId!],reviewIds:[reviewId,thin.reviewId],pbtAchievement:100});
    await perf.saveOnehrCalibration(reviewer,sessionId,1,{reviewId,axis:'performance',performance:'OU',potential:null,performanceNote:'Recorded with a reason.',potentialNote:''});
    await perf.saveOnehrCalibration(reviewer,sessionId,2,{reviewId:thin.reviewId,axis:'performance',performance:'OU',potential:null,performanceNote:'Awaiting score.',potentialNote:''});
    // Bands that carry no saved reason (a leader's reason is optional).
    await owner.db.update(schema.onehrCalibrationEntry).set({performanceNote:''}).where(eq(schema.onehrCalibrationEntry.sessionId,sessionId));
    const preview=await perf.previewAssessmentCalibrationFit(reviewer,sessionId,'performance',b.companyId),fit=preview.moves.find(m=>m.id===reviewId)!;
    expect(fit).toMatchObject({from:'OU',to:'AE'});expect(fit.reasons.length).toBeGreaterThan(0);expect(preview.moves.some(m=>m.id===thin.reviewId)).toBe(false);
    // No reason is required (D-P1-23 lapsed): the move keeps the person's own empty note; client text never becomes one.
    // The unscored person's crafted move is not one the server fit makes, so it is skipped.
    expect(await perf.applyAssessmentCalibrationFit(reviewer,sessionId,'performance',b.companyId,[{id:thin.reviewId,from:'OU',to:'AE'},{id:fit.id,from:fit.from,to:fit.to,reasons:['Client supplied wording.']}])).toMatchObject({applied:[reviewId],skipped:[thin.reviewId]});
    const entries=await owner.db.select().from(schema.onehrCalibrationEntry).where(eq(schema.onehrCalibrationEntry.sessionId,sessionId));
    expect(entries.find(e=>e.reviewId===reviewId)).toMatchObject({performance:'AE',performanceNote:''});
    expect(JSON.stringify(entries),'no generated fit note is stored').not.toContain('Distribution fit');
    expect(JSON.stringify(entries),'an AI verdict is never stored as a person’s reason').not.toContain('AI insight');
    expect(entries.find(e=>e.reviewId===thin.reviewId)).toMatchObject({performance:'OU',performanceNote:''});
    expect(JSON.stringify(entries)).not.toContain('Client supplied wording.');
    // A move whose starting band is stale is still skipped.
    expect(await perf.applyAssessmentCalibrationFit(reviewer,sessionId,'performance',b.companyId,[{id:fit.id,from:fit.from,to:fit.to}])).toMatchObject({applied:[],skipped:[reviewId]});
  });
  it('curve fit holds invalid potential and independently checks each axis and revoked cohort access',async()=>{
    await complete();const reviewer=peers[0].ctx,[thin]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,peers[1].employmentId)));
    const [otherThin]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,peers[2].employmentId)));
    const sid=await perf.createOnehrCalibration(a,cycleId,{name:'Potential fit',companyId:b.companyId,tier:'bg',reviewerUserIds:[reviewer.userId!],reviewIds:[reviewId,thin.reviewId,otherThin.reviewId],pbtAchievement:null});
    await perf.saveOnehrCalibration(reviewer,sid,1,{reviewId,axis:'potential',performance:null,potential:'High',performanceNote:'',potentialNote:'Keep this reviewer comment.'});
    await perf.saveOnehrCalibration(reviewer,sid,2,{reviewId:thin.reviewId,axis:'potential',performance:null,potential:'High',performanceNote:'',potentialNote:'A provisional decision without a usable score.'});
    await perf.saveOnehrCalibration(reviewer,sid,3,{reviewId:otherThin.reviewId,axis:'potential',performance:null,potential:'High',performanceNote:'',potentialNote:'Another provisional decision.'});
    const preview=await perf.previewAssessmentCalibrationFit(reviewer,sid,'potential',b.companyId);expect(preview.unscored).toContain('Peer 1');expect(preview.moves.some(m=>m.id===thin.reviewId)).toBe(false);expect(preview.moves.length).toBeGreaterThan(0);expect(JSON.stringify(preview)).not.toMatch(/"(?:peerEmploymentId|answers|requestId|raters)"\s*:/);
    expect(await perf.applyAssessmentCalibrationFit(reviewer,sid,'potential',b.companyId,[{id:thin.reviewId,from:'High',to:'Low'},...preview.moves])).toMatchObject({applied:[reviewId],skipped:[thin.reviewId]});
    const v=await perf.getOnehrCalibration(reviewer,sid);expect(v.rows.find(r=>r.entry.reviewId===reviewId)!.entry.potentialNote).toBe('Keep this reviewer comment.');
    await perf.lockOnehrCalibration(reviewer,sid,v.session.revision,'Reasoned distribution','potential');
    await expect(perf.previewAssessmentCalibrationFit(reviewer,sid,'potential',b.companyId)).rejects.toThrow(/locked/);await expect(perf.applyAssessmentCalibrationFit(reviewer,sid,'potential',b.companyId,preview.moves)).rejects.toThrow(/locked/);
    expect(await perf.previewAssessmentCalibrationFit(reviewer,sid,'performance',b.companyId)).toHaveProperty('moves');
    await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[mgr.userId!]}).where(eq(schema.onehrCalibration.id,sid));await expect(perf.previewAssessmentCalibrationFit(reviewer,sid,'performance',b.companyId)).rejects.toThrow();expect(generateDraft).not.toHaveBeenCalled();
  });
  it('edits the active leadership framework after submission while preserving original answers and renamed comments',async()=>{
    const group={...a,grants:[{role:'hr_admin',companyId:null}]};
    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));
    const request=(await perf.onehrAssignments(peers[0].ctx)).feedback.find(f=>f.subject==='Assessment subject')!,card=await perf.getOnehrFeedback(peers[0].ctx,request.id),originalAnswers=Object.fromEntries(card.statements.map(s=>[s.id,'yes' as const]));
    const oldName=card.statements[0].principle,comment='Observed service follow-through.';
    await perf.submitOnehrFeedback(peers[0].ctx,request.id,originalAnswers,'Consistently observed these behaviours',{[oldName]:comment});
    let cycle=(await perf.getOnehrCycle(a,cycleId))!;const principle=leadershipPrinciples(cycle.policy).find(p=>p.name===oldName)!;
    await expect(perf.updateAssessmentFramework(mgr,cycleId,cycle.revision,{action:'edit_principle',principleId:principle.id,name:'Customer practice',description:''})).rejects.toThrow(/group HR/);
    await perf.updateAssessmentFramework(group,cycleId,cycle.revision,{action:'edit_principle',principleId:principle.id,name:'Customer practice',description:'Observable service outcomes'});
    const renamed=await perf.getOnehrFeedback(peers[0].ctx,request.id);expect(renamed.submitted).toBe(true);expect(renamed.comments).toEqual({'Customer practice':comment});expect(renamed.statements.map(s=>s.id)).toEqual(card.statements.map(s=>s.id));
    await expect(perf.updateAssessmentFramework(group,cycleId,cycle.revision,{action:'remove_behaviour',statementId:card.statements[0].id})).rejects.toThrow(/changed/);
    cycle=(await perf.getOnehrCycle(a,cycleId))!;
    await perf.updateAssessmentFramework(group,cycleId,cycle.revision,{action:'remove_behaviour',statementId:card.statements[0].id});
    expect((await perf.getOnehrFeedback(peers[0].ctx,request.id)).statements.some(s=>s.id===card.statements[0].id)).toBe(false);
    const [stored]=await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.requestId,request.id));expect(stored.answers).toEqual(originalAnswers);expect(stored.principleComments).toEqual({[oldName]:comment});
    cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.updateAssessmentFramework(group,cycleId,cycle.revision,{action:'add_behaviour',principleId:principle.id,tier:0,text:'Checks the result with the customer',future:true});
    const added=await perf.getOnehrFeedback(peers[0].ctx,request.id);expect(added.statements.some(s=>s.text==='Checks the result with the customer')).toBe(true);expect(added.answers).toEqual(originalAnswers);
    const pending=(await perf.onehrAssignments(peers[1].ctx)).feedback.find(f=>f.subject==='Assessment subject')!;
    await expect(perf.submitOnehrFeedback(peers[1].ctx,pending.id,originalAnswers,'A stale form with removed questions')).rejects.toThrow(/every assigned/);
    expect((await perf.getOnehrFeedback(peers[1].ctx,pending.id)).submitted).toBe(false);
    const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'onehr.framework-updated'));expect(events).toHaveLength(3);expect(events[0].payload).toHaveProperty('previous');
    await expect(withTenant(group,tx=>tx.update(schema.onehrReview).set({statements:[]}).where(eq(schema.onehrReview.reviewId,reviewId)))).rejects.toThrow();
  });
  it('keeps finalized framework inputs and published results fixed while updating other unfinished people',async()=>{
    await complete();await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);await perf.releaseOnehrResult(a,reviewId,'feedback',true);
    const [before]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId)),[result]=await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId));
    let cycle=(await perf.getOnehrCycle(a,cycleId))!;const statement=cycle.policy.framework[0].statements[0];
    await perf.updateAssessmentFramework({...a,grants:[{role:'hr_admin',companyId:null}]},cycleId,cycle.revision,{action:'edit_behaviour',statementId:statement.id,text:'Updated current-cycle wording'});
    const [after]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));expect(after.statements).toEqual(before.statements);expect(after.revision).toBe(before.revision);
    expect((await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId)))[0]).toEqual(result);
    const peersNow=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,peers[0].employmentId)));expect(peersNow[0].statements).toEqual(expect.arrayContaining([expect.objectContaining({id:statement.id,text:'Updated current-cycle wording'})]));
    await perf.closeCycle(a,{cycleId});cycle=(await perf.getOnehrCycle(a,cycleId))!;
    await expect(perf.updateAssessmentFramework(a,cycleId,cycle.revision,{action:'remove_behaviour',statementId:statement.id})).rejects.toThrow(/archived/);
  });

  it('ADR-0142 VF-01: a manager who is also a performance partner cannot finalize the review; HR can',async()=>{
    await complete(true,'Verified delivery across the period.');
    // The manager passes performance_review RLS on the manager path, so only the actor check refuses this.
    await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:mgr.userId!,companyId:b.companyId,role:'performance_partner'});
    const partnerMgr:SessionContext={...mgr,roles:['manager','performance_partner'],grants:[{role:'performance_partner',companyId:b.companyId}]};
    await expect(perf.freezeOnehrReview(partnerMgr,reviewId,(await view(a)).revision)).rejects.toThrow(/Only an HR administrator can finalize this assessment/);
    expect(await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId))).toEqual([]);
    const [open]=await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,reviewId));expect(open.closedAt).toBeNull();
    // Non-vacuous: the same complete review freezes for HR.
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    expect(await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId))).toHaveLength(1);
  });
  it('freezes reviewer authorship with the result and rejects changes to the underlying authored record',async()=>{
    await complete(true,'Verified delivery across the period.');
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    const [frozen]=await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId));
    expect(frozen.result).toMatchObject({provenance:{reviewerRemarks:[expect.objectContaining({actorUserId:mgr.userId,author:'Assessment manager',remark:'Verified delivery across the period.'})]}});
    await expect(withTenant(mgr,tx=>tx.update(schema.assessmentReviewerRemark).set({remark:'Rewrite frozen words'}).where(eq(schema.assessmentReviewerRemark.actorUserId,mgr.userId!)))).rejects.toThrow();
  });
  it('runs the complete assessment and releases only explicitly selected frozen components',async()=>{
    await complete();expect((await view()).potential).toBe('High');
    expect((await view(self)).competencies.map(c=>c.self)).toEqual(['no','no']);
    expect((await view(self)).peers).toEqual([]);expect((await view(self)).potential).toBeNull();
    expect(await withTenant(self,tx=>tx.select().from(schema.peerFeedbackRequest).where(eq(schema.peerFeedbackRequest.reviewId,reviewId)))).toEqual([]);
    expect(await withTenant(self,tx=>tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'onehr.panel-assigned')))).toEqual([]);
    expect(await withTenant(self,tx=>tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'peer-feedback-request.created')))).toEqual([]);
    const attachment=await perf.addPerformanceAttachment(self,{reviewId,stageKind:null,fileName:'delivery.txt',mimeType:'text/plain',content:Buffer.from('Verified release evidence.')});
    expect((await perf.getPerformanceAttachment(mgr,attachment.id))?.content.toString()).toBe('Verified release evidence.');
    const frozenId=await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    expect((await view(self)).result).toMatchObject({id:frozenId,performance:null,potential:null,talent:null});
    expect(await withTenant(self,tx=>tx.select().from(schema.onehrResult))).toEqual([]);
    await perf.releaseOnehrResult(a,reviewId,'performance',true);expect((await view(self)).result).toMatchObject({performance:'ME',potential:null,talent:null});
    // WP-E: the per-person panel is the single-step release, as step 'both': leaders and the person together.
    const [both]=await owner.db.select().from(schema.assessmentRelease).where(eq(schema.assessmentRelease.reviewId,reviewId));
    expect(both.performanceLeaderReleasedAt).toBeInstanceOf(Date);expect(both.performanceReleasedAt).toBeInstanceOf(Date);expect(both.potentialLeaderReleasedAt).toBeNull();
    await perf.releaseOnehrResult(a,reviewId,'talent',true);expect((await view(self)).result?.talent).toBe('Star');
    await perf.releaseOnehrResult(a,reviewId,'feedback',true);const own=await view(self);expect(own.feedbackReport).toHaveLength(7);expect(JSON.stringify(own.feedbackReport)).not.toMatch(/employmentId|requestId|count|relationship/);
    await perf.releaseOnehrResult(a,reviewId,'performance',false);expect((await view(self)).result?.performance).toBeNull();
    const [revoked]=await owner.db.select().from(schema.assessmentRelease).where(eq(schema.assessmentRelease.reviewId,reviewId));
    expect([revoked.performanceLeaderReleasedAt,revoked.performanceReleasedAt]).toEqual([null,null]);expect(revoked.talentLeaderReleasedAt).toBeInstanceOf(Date);
    await expect(perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[])).rejects.toThrow(/finalized/);
    await expect(withTenant(a,tx=>tx.update(schema.onehrResult).set({digest:'tampered'}).where(eq(schema.onehrResult.id,frozenId)))) .rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/immutable/)})});
    await expect(perf.configureOnehrCycle(a,cycleId,1,defaultPolicy(framework))).rejects.toThrow(/fixed/);
  });
  it('releases live interim components independently, follows locked calibration, and keeps Rewards frozen-only',async()=>{
    await expect(perf.releaseOnehrResult(a,reviewId,'performance',true)).rejects.toThrow(/no result/);
    await expect(perf.releaseOnehrResult(a,reviewId,'feedback',true)).rejects.toThrow(/valid feedback/);
    await complete(false);
    expect((await view()).potential).toBe('Mid'); // Pending competencies use the 360 alone, never a zero or blocked band.
    expect((await view(self)).result).toMatchObject({interim:true,performance:null,potential:null,talent:null});
    await expect(perf.releaseOnehrResult(mgr,reviewId,'performance',true)).rejects.toThrow(/administrator/);
    await perf.releaseOnehrResult(a,reviewId,'performance',true);
    expect(await view(self)).toMatchObject({finalized:false,result:{interim:true,performance:'ME',potential:null,talent:null}});
    await perf.releaseOnehrResult(a,reviewId,'feedback',true);
    const anonymous=(await view(self)).anonymousFeedback!;
    expect(anonymous.statements.length).toBeGreaterThan(0);
    expect(anonymous.statements.every(s=>s.agreementPct===50)).toBe(true);
    expect(JSON.stringify(anonymous)).not.toMatch(/employmentId|requestId|relationship|submittedAt|score|count/);
    expect(await withTenant(self,tx=>tx.select().from(schema.assessmentRelease))).toEqual([]);
    await expect(withTenant(self,tx=>tx.execute(sql`select app.assessment_working_result(${reviewId}::uuid)`))).rejects.toThrow();
    expect(await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId))).toEqual([]);
    const [bu]=await owner.db.insert(schema.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'INTERIM',name:'Interim source test'}).returning();
    await owner.db.update(schema.assignment).set({businessUnitId:bu.id}).where(eq(schema.assignment.employmentId,subject.employmentId));
    await setCompensation(a,{employmentId:subject.employmentId,basicSalary:5000,effectiveFrom:`${year-2}-01-01`});
    const unitId=await createRewardUnit(a,{name:'No interim import',year,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:todayInKualaLumpur()});
    const reward=await getRewardUnit(a,unitId);expect(reward.rows).toHaveLength(1);expect(reward.rows[0].source.onehr).toBeNull();
    await expect(importOnehrRewardResults(a,unitId,reward.unit.revision)).rejects.toThrow(/No finalized assessment/);
    await perf.releaseOnehrResult(a,reviewId,'potential',true);
    expect((await view(self)).result?.potential).toBe('Mid');
    await perf.submitOnehrCompetencies(mgr,reviewId,(await view()).revision,{'skill-1':{answer:'yes',remark:'Observed delivery'},'skill-2':{answer:'yes',remark:'Observed future skill'}},true);
    expect((await view(self)).result?.potential).toBe('High');
    const sessionId=await perf.createOnehrCalibration(a,cycleId,{name:'Interim department assessment',companyId:b.companyId,tier:'hod',reviewerUserIds:[a.userId!],reviewIds:[reviewId],pbtAchievement:100,mode:'after'});
    let c=await perf.getOnehrCalibration(a,sessionId);
    await perf.saveOnehrCalibration(a,sessionId,c.session.revision,{reviewId,axis:'performance',performance:'AE',potential:null,performanceNote:'Verified wider impact',potentialNote:''});
    expect((await view(self)).result?.performance).toBe('ME'); // A saved department row still needs the scope submission.
    await perf.lockOnehrCalibration(a,sessionId,(await perf.getOnehrCalibration(a,sessionId)).session.revision,'','performance');
    expect((await view(self)).result?.performance).toBe('AE');
    await perf.releaseOnehrResult(a,reviewId,'potential',true);
    await perf.releaseOnehrResult(a,reviewId,'talent',true);
    expect((await view(self)).result).toMatchObject({performance:'AE',potential:'High',talent:'Super Star'});
    c=await perf.getOnehrCalibration(a,sessionId);
    await perf.agreeAssessmentDepartment(a,sessionId,c.session.revision,'potential',[reviewId]);
    await perf.lockOnehrCalibration(a,sessionId,(await perf.getOnehrCalibration(a,sessionId)).session.revision,'','potential');
    const frozenId=await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    expect(await view(self)).toMatchObject({finalized:true,result:{id:frozenId,interim:false,performance:'AE',potential:'High',talent:'Super Star'}});
    await perf.releaseOnehrResult(a,reviewId,'performance',false);
    await perf.releaseOnehrResult(a,reviewId,'feedback',false);
    expect((await view(self)).result).toMatchObject({performance:null,potential:'High',talent:'Super Star'});
    expect((await view(self)).anonymousFeedback).toBeNull();
    const [frozen]=await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId));
    expect(frozen.result).toMatchObject({performance:'AE',potential:'High',talent:'Super Star'});
    expect(frozen.performanceReleasedAt).toBeNull();
  });
  it('summarizes personal records from current manager facts and released history only',async()=>{
    await complete(true,'Private reviewer wording.');vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    vi.mocked(generateDraft).mockImplementation(referenceReply);
    expect(await perf.getAssessmentRecordInsight(self,reviewId,'present')).toMatchObject({pending:true});expect(generateDraft).not.toHaveBeenCalled();
    const current=await perf.getAssessmentRecordInsight(self,reviewId,'present',{generate:true});expect(current).toMatchObject({source:'ai',pending:false});
    const prompt=vi.mocked(generateDraft).mock.calls[0][1].prompt;expect(JSON.parse(prompt)).toMatchObject({purpose:'record_present'});expect(prompt).not.toContain('Meet Expectation');expect(prompt).not.toMatch(/Private reviewer|final potential|talent status|Consistently observed|Peer 0/);
    expect(await perf.getAssessmentRecordInsight(self,reviewId,'present')).toEqual(current);expect(generateDraft).toHaveBeenCalledOnce();
    for(const denied of [mgr,a,peers[0].ctx]){await expect(perf.getAssessmentRecordInsight(denied,reviewId,'present')).rejects.toThrow(/not assigned/);expect((await withTenant(denied,tx=>tx.select().from(schema.assessmentSummary))).filter(r=>r.kind.startsWith('record_'))).toEqual([]);}
    await expect(perf.getAssessmentRecordInsight(self,reviewId,'cycle')).rejects.toThrow(/not available/);
    await perf.releaseOnehrResult(a,reviewId,'performance',true);vi.mocked(generateDraft).mockImplementation(referenceReply);
    const history=await perf.getAssessmentRecordInsight(self,reviewId,'cycle',{generate:true});expect(history).toMatchObject({source:'ai'});const pastPrompt=vi.mocked(generateDraft).mock.calls.at(-1)![1].prompt;
    expect(JSON.parse(pastPrompt)).toMatchObject({purpose:'record_cycle'});expect(pastPrompt).not.toContain('final performance band after calibration');expect(pastPrompt).not.toMatch(/Deliver agreed|Completed outcomes|Observed delivery|potential band|talent status|Private reviewer/);
    await perf.releaseOnehrResult(a,reviewId,'performance',false);
    // The raw actor-owned cache cannot expose a summary of the now withdrawn release either.
    expect((await withTenant(self,tx=>tx.select().from(schema.assessmentSummary))).filter(r=>r.kind==='record_cycle')).toEqual([]);
    await expect(perf.getAssessmentRecordInsight(self,reviewId,'cycle')).rejects.toThrow(/not available/);
    await perf.releaseOnehrResult(a,reviewId,'performance',true);
    expect(await perf.getAssessmentRecordInsight(self,reviewId,'cycle',{generate:true})).toMatchObject({source:'ai'});
    const [stored]=await owner.db.select().from(schema.assessmentSummary).where(and(eq(schema.assessmentSummary.reviewId,reviewId),eq(schema.assessmentSummary.kind,'record_cycle')));expect(stored.visibilityKey).toMatch(/^[a-f0-9]{32}$/);
    await expect(withTenant(mgr,tx=>tx.execute(sql`select app.assessment_record_summary_store(${reviewId}::uuid,'record_cycle',${stored.visibilityKey},${stored.fingerprint},'plain','{"paragraph":"forged"}'::jsonb)`))).rejects.toThrow();
  });
  it('rechecks personal releases and the review assistance switch after generating and uses plain fallbacks',async()=>{
    await complete();await perf.releaseOnehrResult(a,reviewId,'performance',true);const group={...a,grants:[{role:'hr_admin',companyId:null}]};vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    vi.mocked(generateDraft).mockResolvedValue('{"snapshot":"Your potential band is High and you deserve a promotion."}');expect(await perf.getAssessmentRecordInsight(self,reviewId,'cycle',{generate:true})).toMatchObject({source:'plain',data:{paragraph:'After calibration your final performance band was Meet Expectation.'}});
    await perf.setAssessmentAiSwitch(group,'review',false);expect(await perf.getAssessmentRecordInsight(self,reviewId,'present',{generate:true})).toMatchObject({source:'plain'});expect(generateDraft).toHaveBeenCalledOnce();
    await perf.setAssessmentAiSwitch(group,'review',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await perf.setAssessmentAiSwitch(group,'review',false);return referenceReply(cfg,args);});await expect(perf.getAssessmentRecordInsight(self,reviewId,'present',{generate:true})).rejects.toThrow(/record or released information changed/);
    await perf.setAssessmentAiSwitch(group,'review',true);await perf.releaseOnehrResult(a,reviewId,'feedback',true);vi.mocked(generateDraft).mockImplementationOnce(async(cfg,args)=>{await perf.releaseOnehrResult(a,reviewId,'performance',false);return referenceReply(cfg,args);});await expect(perf.getAssessmentRecordInsight(self,reviewId,'cycle',{generate:true})).rejects.toThrow(/not available|record or released information changed/);
    expect((await withTenant(self,tx=>tx.select().from(schema.assessmentSummary))).filter(r=>r.kind==='record_cycle')).toEqual([]);
    const foreign=await seedBase();await setModule(foreign.tenantId,'performance','active');await expect(perf.getAssessmentRecordInsight(await entitledCtx(foreign),reviewId,'cycle')).rejects.toThrow(/not assigned/);
  });
  it('summarizes the released personal trend and invalidates it when an earlier release is withdrawn',async()=>{
    await complete();await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);await perf.releaseOnehrResult(a,reviewId,'performance',true);const prior=reviewId,priorCycle=cycleId,policy=(await perf.getOnehrCycle(a,cycleId))!.policy;
    await owner.db.update(schema.reviewCycle).set({status:'closed'}).where(eq(schema.reviewCycle.id,priorCycle));
    ({cycleId}=await perf.createCycle(a,{name:'Next annual assessment',companyId:b.companyId,periodStart:`${year+1}-01-01`,periodEnd:`${year+1}-12-31`}));await perf.configureOnehrCycle(a,cycleId,null,policy);await perf.openCycle(a,{cycleId});
    const [r]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,subject.employmentId)));reviewId=r.reviewId;await complete();await perf.releaseOnehrResult(a,reviewId,'performance',true);
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);vi.mocked(generateDraft).mockImplementation(referenceReply);
    const trend=await perf.getAssessmentRecordInsight(self,reviewId,'trend',{generate:true});expect(trend).toMatchObject({source:'ai'});const prompt=vi.mocked(generateDraft).mock.calls[0][1].prompt;
    expect(JSON.parse(prompt)).toMatchObject({purpose:'record_trend'});expect(prompt).not.toContain('Native annual assessment');expect(prompt).not.toContain('Next annual assessment');expect(prompt).not.toMatch(/Deliver agreed|potential band|talent status|KPI|Observed delivery/);
    expect(await perf.getAssessmentRecordInsight(self,reviewId,'trend')).toEqual(trend);expect(generateDraft).toHaveBeenCalledOnce();
    await perf.releaseOnehrResult(a,prior,'performance',false);expect(await perf.getAssessmentRecordInsight(self,reviewId,'trend',{generate:true})).toMatchObject({pending:false,data:null});expect(generateDraft).toHaveBeenCalledOnce();
    expect((await withTenant(self,tx=>tx.select().from(schema.assessmentSummary))).filter(r=>r.kind==='record_trend')).toEqual([]);
    await perf.releaseOnehrResult(a,prior,'performance',true);expect(await perf.getAssessmentRecordInsight(self,reviewId,'trend',{generate:true})).toMatchObject({source:'ai'});
  });
  it('separates current manager details from released history and refuses another person’s personal record',async()=>{
    await complete();
    let record=await perf.getAssessmentPersonalRecord(self,reviewId);
    expect(record.history).toEqual([]);expect(record.current).toMatchObject({performance:'ME',allLocked:true});
    expect(record.current).not.toHaveProperty('potential');expect(record.current).not.toHaveProperty('talent');
    await expect(perf.getAssessmentPersonalRecord(mgr,reviewId)).rejects.toThrow(/not assigned/);
    await perf.releaseOnehrResult(a,reviewId,'feedback',true);
    record=await perf.getAssessmentPersonalRecord(self,reviewId);expect(record.history).toEqual([]);expect(record.current?.report).not.toBeNull();
    await perf.releaseOnehrResult(a,reviewId,'performance',true);
    record=await perf.getAssessmentPersonalRecord(self,reviewId,reviewId);
    expect(record.selected).toMatchObject({performance:'ME',potential:null,talent:null});
    expect(record.selected).not.toHaveProperty('kpis');expect(record.selected).not.toHaveProperty('competencies');
    await expect(perf.getAssessmentPersonalRecord(self,reviewId,randomUUID())).rejects.toThrow(/not available/);
    await perf.releaseOnehrResult(a,reviewId,'performance',false);
    await expect(perf.getAssessmentPersonalRecord(self,reviewId,reviewId)).rejects.toThrow(/not available/);
    await owner.db.update(schema.reviewCycle).set({status:'closed'}).where(eq(schema.reviewCycle.id,cycleId));
    record=await perf.getAssessmentPersonalRecord(self,reviewId);
    expect(record.current).toBeNull();expect(record.history).toHaveLength(1);expect(record.selected?.performance).toBeNull();
    expect(await perf.performanceWorkspace(self)).toEqual([]);expect((await perf.onehrAssignments(self)).reviews.find(r=>r.id===reviewId)?.cycleStatus).toBe('closed');
  });
  it('records sign-offs and locked bands, exports only the scoped record, and freezes it at archive',async()=>{
    expect((await perf.getAssessmentRatingRecords(a,cycleId)).rows).toEqual([]);
    await complete();
    const records=await perf.getAssessmentRatingRecords(a,cycleId);
    const recorded=records.rows.find(r=>r.reviewId===reviewId)!;
    expect(recorded).toMatchObject({lastEvent:'f360_submit',frozenAt:null,snapshot:{selfScore:3,selfBand:'ME',weightCovered:10000,weightTotal:10000,managerScore:3,managerBand:'ME',leadershipScore:17.5,leadershipMax:35,submitted:4,valid:true,competencySelf:0,competencyReviewed:2.5,competencyMax:2.5,potentialScore:30,potentialMax:37.5,potential360Pct:50,potentialCompetencyPct:100,potentialBasis:'combined',potential:'High'}});
    const originalName=recorded.snapshot.name;
    expect(await withTenant(self,tx=>tx.select().from(schema.assessmentRatingRecord))).toEqual([]);
    await expect(perf.exportAssessmentRatingRecords(mgr,cycleId)).rejects.toThrow(/administrator/);
    await expect(withTenant(a,tx=>tx.update(schema.assessmentRatingRecord).set({lastEvent:'forged'}).where(eq(schema.assessmentRatingRecord.reviewId,reviewId)))).rejects.toThrow();
    await owner.db.update(schema.person).set({fullName:'Changed after sign-off'}).where(eq(schema.person.id,subject.personId));
    expect((await perf.getAssessmentRatingRecords(a,cycleId)).rows.find(r=>r.reviewId===reviewId)?.snapshot.name).toBe(originalName);
    await perf.captureAssessmentRatingRecords(a,cycleId);
    expect((await perf.getAssessmentRatingRecords(a,cycleId)).rows.find(r=>r.reviewId===reviewId)?.snapshot.name).toBe('Changed after sign-off');
    const sessionId=await perf.createOnehrCalibration(a,cycleId,{name:'Recorded HOD assessment',companyId:b.companyId,tier:'hod',reviewerUserIds:[a.userId!],reviewIds:[reviewId],pbtAchievement:100,mode:'after'});
    const c=await perf.getOnehrCalibration(a,sessionId);
    await perf.saveOnehrCalibration(a,sessionId,c.session.revision,{reviewId,axis:'performance',performance:'AE',potential:null,performanceNote:'Private calibration justification',potentialNote:''});
    expect((await perf.getAssessmentRatingRecords(a,cycleId)).rows.find(r=>r.reviewId===reviewId)?.snapshot).toMatchObject({performance:'ME',tiers:{hod:{performance:null}}});
    await perf.lockOnehrCalibration(a,sessionId,(await perf.getOnehrCalibration(a,sessionId)).session.revision,'','performance');
    const exported=await perf.exportAssessmentRatingRecords(a,cycleId);
    expect(exported.records.find(r=>r.reviewId===reviewId)?.snapshot).toMatchObject({performance:'AE',performanceSource:'hod',tiers:{hod:{performance:'AE',potential:null}}});
    expect(JSON.stringify(exported.records)).not.toContain('Private calibration justification');
    const absent=await perf.exportAssessmentRatingRecords(a,cycleId,{company:'A company outside this scope'});expect(absent.records).toEqual([]);
    await withTenant(a,tx=>tx.update(schema.reviewCycle).set({status:'closed'}).where(eq(schema.reviewCycle.id,cycleId)));
    const frozen=(await perf.getAssessmentRatingRecords(a,cycleId)).rows.find(r=>r.reviewId===reviewId)!;expect(frozen.frozenAt).toBeInstanceOf(Date);
    await owner.db.update(schema.person).set({fullName:'Changed after archive'}).where(eq(schema.person.id,subject.personId));
    await perf.captureAssessmentRatingRecords(a,cycleId);
    expect((await perf.getAssessmentRatingRecords(a,cycleId)).rows.find(r=>r.reviewId===reviewId)).toEqual(frozen);
    await expect(owner.db.update(schema.assessmentRatingRecord).set({lastEvent:'rewrite-frozen'}).where(eq(schema.assessmentRatingRecord.reviewId,reviewId))).rejects.toThrow();
  });
  it('keeps the internal SQL scoring counterpart aligned with every source golden case',async()=>{
    const values=sourceGolden.scoring.map((c,index)=>sql`(${index},${c.actual}::numeric,${JSON.stringify(c.scoring)}::jsonb)`);
    const rows=await owner.db.execute<{id:number;score:string}>(sql`select v.id,app.assessment_kpi_score(v.actual,v.scoring) as score from (values ${sql.join(values,sql`,`)}) v(id,actual,scoring) order by v.id`);
    expect(rows).toHaveLength(sourceGolden.scoring.length);
    for(const row of rows)expect(Number(row.score)).toBeCloseTo(sourceGolden.scoring[row.id].expected,10);
    await expect(withTenant(a,tx=>tx.execute(sql`select app.assessment_kpi_score(1::numeric,'{}'::jsonb)`))).rejects.toThrow();
  });
  it('preserves archived feedback, reopens submitted answers as a draft, and revokes changed reports',async()=>{
    await complete();await perf.releaseOnehrResult(a,reviewId,'feedback',true);
    const [original]=await owner.db.select().from(schema.onehrPanel).where(and(eq(schema.onehrPanel.reviewId,reviewId),eq(schema.onehrPanel.peerEmploymentId,peers[0].employmentId)));
    const before=(await perf.getAssessmentRatingRecords(a,cycleId)).rows.find(r=>r.reviewId===reviewId)!;
    await expect(perf.changeAssessmentPanelState(mgr,reviewId,(await view(mgr)).revision,original.requestId,'archive')).rejects.toThrow(/administrator/);
    await perf.changeAssessmentPanelState(a,reviewId,(await view(a)).revision,original.requestId,'archive','Outside the intended assessment scope');
    expect((await view(self)).anonymousFeedback).toBeNull();expect((await view(self)).peers).toEqual([]);
    let [stored]=await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.requestId,original.requestId));
    expect(stored.answers).toEqual(original.answers);expect(stored.submittedAt).toEqual(original.submittedAt);expect(stored.archivedAt).not.toBeNull();
    expect((await perf.onehrAssignments(peers[0].ctx)).feedback.some(f=>f.id===original.requestId)).toBe(false);
    expect((await perf.getAssessmentRatingRecords(a,cycleId)).rows.find(r=>r.reviewId===reviewId)).toEqual(before); // A stored sign-off is not recomputed on a panel edit.
    await perf.changeAssessmentPanelState(a,reviewId,(await view(a)).revision,original.requestId,'restore');
    expect((await perf.getOnehrFeedback(peers[0].ctx,original.requestId)).submitted).toBe(true);
    await perf.releaseOnehrResult(a,reviewId,'feedback',true);
    await perf.changeAssessmentPanelState(a,reviewId,(await view(a)).revision,original.requestId,'reset');
    const draft=await perf.getOnehrFeedback(peers[0].ctx,original.requestId);
    expect(draft).toMatchObject({submitted:false,answers:original.answers});expect(draft.resetAt).toBeTruthy();
    expect((await view(self)).anonymousFeedback).toBeNull();
    await perf.submitOnehrFeedback(peers[0].ctx,original.requestId,draft.answers!,'Reviewed the prior answers.');
    [stored]=await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.requestId,original.requestId));expect(stored.submittedAt).not.toBeNull();
    expect((await view(self)).anonymousFeedback).toBeNull(); // Resubmission does not silently re-release.
    await perf.releaseOnehrResult(a,reviewId,'feedback',true);expect((await view(self)).anonymousFeedback).not.toBeNull();
    const notices=await withTenant(self,tx=>tx.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,reviewId),eq(schema.domainEvent.eventType,'onehr.result-revoked'))));
    expect(notices).toHaveLength(2);expect(JSON.stringify(notices.map(n=>n.payload))).not.toMatch(/requestId|peerEmploymentId|answers/);
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    await expect(perf.changeAssessmentPanelState(a,reviewId,(await view(a)).revision,original.requestId,'reset')).rejects.toThrow(/finalized/);
  });
  it('preserves the opening company and grade after the native employment changes company',async()=>{
    const sessionId=await perf.createOnehrCalibration(a,cycleId,{name:'Original company cohort',companyId:b.companyId,tier:'bu',reviewerUserIds:[a.userId!],reviewIds:[reviewId],pbtAchievement:100,mode:'after'});
    const [destination]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Destination company'}).returning();
    // Entity transfer changes the existing employment company; it does not create a second employment.
    await owner.db.update(schema.employment).set({companyId:destination.id,gradeId:null}).where(eq(schema.employment.id,subject.employmentId));
    await complete();
    const c=await perf.getOnehrCalibration(a,sessionId);await perf.lockOnehrCalibration(a,sessionId,c.session.revision,'');
    await expect(withTenant(a,tx=>tx.update(schema.onehrReview).set({companyId:destination.id}).where(eq(schema.onehrReview.reviewId,reviewId)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/snapshot is immutable/)})});
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    const [stored]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));
    expect(stored).toMatchObject({companyId:b.companyId,grade:'12'});expect((await view(self)).grade).toBe('12');
  });
  it('audits active deadline changes without allowing assessment rules or frozen inputs to reopen',async()=>{
    const closed={pm_setting:{opensAt:null,closesAt:new Date(Date.now()-60_000).toISOString()}};
    await expect(perf.updateOnehrWindows(self,cycleId,1,closed,'Close setting')).rejects.toThrow(/administrator/);
    await expect(perf.updateOnehrWindows(a,cycleId,1,closed,'')).rejects.toThrow();
    await perf.updateOnehrWindows(a,cycleId,1,closed,'Setting cutoff reached');
    const kpi={id:randomUUID(),title:'A deadline-controlled objective',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId};
    await expect(perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[kpi])).rejects.toThrow(/closed/);
    await expect(perf.updateOnehrWindows(a,cycleId,1,{},'Stale request')).rejects.toThrow(/changed/);
    await perf.updateOnehrWindows(a,cycleId,2,{},'Extend setting for approved correction');
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[kpi]);
    const configured=await perf.getOnehrCycle(a,cycleId);
    await expect(withTenant(a,tx=>tx.update(schema.onehrCycle).set({policy:{...configured!.policy,lowMaxPct:1}}).where(eq(schema.onehrCycle.cycleId,cycleId)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/immutable/)})});
    await complete();await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    const frozen=(await view(a)).result!;await perf.updateOnehrWindows(a,cycleId,3,{},'Reconfirm schedule');
    expect((await view(a)).result?.digest).toBe(frozen.digest);
    await expect(perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[kpi])).rejects.toThrow(/finalized/);
    const history=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,cycleId),eq(schema.domainEvent.eventType,'onehr.windows-updated')));
    expect(history).toHaveLength(3);expect(history.some(e=>(e.payload as {previous?:unknown;reason?:string}).reason==='Extend setting for approved correction')).toBe(true);
    await owner.db.update(schema.reviewCycle).set({status:'closed'}).where(eq(schema.reviewCycle.id,cycleId));
    await expect(perf.updateOnehrWindows(a,cycleId,4,{},'Reopen closed period')).rejects.toThrow(/read-only/);
  });
  it('keeps Group outside BG cutoffs and lets only HR reopen unfinalized calibration in reverse tier order',async()=>{
    await complete();
    await perf.updateOnehrWindows(a,cycleId,1,{tb_bgceo:{opensAt:null,closesAt:new Date(Date.now()-60_000).toISOString()}},'BG cutoff reached');
    const make=(name:string,tier:'bu'|'bg'|'group',mode:'after'|'replace'='after')=>perf.createOnehrCalibration(a,cycleId,{name,companyId:b.companyId,tier,reviewerUserIds:[a.userId!,mgr.userId!],reviewIds:[reviewId],pbtAchievement:100,mode});
    const bu=await make('BU','bu');await perf.lockOnehrCalibration(a,bu,1,'');
    const bg=await make('BG','bg');await expect(perf.lockOnehrCalibration(a,bg,1,'')).rejects.toThrow(/closed/);
    const group=await make('Group','group','replace');
    await perf.saveOnehrCalibration(a,group,1,{reviewId,performance:'ME',potential:'High',performanceNote:'',potentialNote:''});
    await perf.saveAssessmentTalentDecision(a,group,(await perf.getOnehrCalibration(a,group)).session.revision,reviewId,'specialReward',true,'');
    await perf.lockOnehrCalibration(a,group,(await perf.getOnehrCalibration(a,group)).session.revision,'');
    await expect(perf.unlockOnehrCalibration(mgr,group,(await perf.getOnehrCalibration(mgr,group)).session.revision,'Reconsider')).rejects.toThrow(/administrator/);
    await expect(perf.unlockOnehrCalibration(a,bu,(await perf.getOnehrCalibration(a,bu)).session.revision,'Reconsider')).rejects.toThrow(/later calibration tiers/);
    await perf.unlockOnehrCalibration(a,group,(await perf.getOnehrCalibration(a,group)).session.revision,'Correct the group decision','performance',reviewId);
    let reopened=await perf.getOnehrCalibration(a,group);expect(reopened.rows[0].entry).toMatchObject({performanceLockedAt:null,promotion:false,specialReward:true});expect(reopened.rows[0].entry.potentialLockedAt).toBeTruthy();
    await perf.unlockOnehrCalibration(a,bu,(await perf.getOnehrCalibration(a,bu)).session.revision,'Review the underlying BU performance','performance');
    await perf.lockOnehrCalibration(a,bu,(await perf.getOnehrCalibration(a,bu)).session.revision,'','performance');
    await perf.saveOnehrCalibration(a,group,reopened.session.revision,{reviewId,axis:'performance',performance:'AE',potential:null,performanceNote:'Reconsidered verified delivery',potentialNote:''});
    reopened=await perf.getOnehrCalibration(a,group);await perf.lockOnehrCalibration(a,group,reopened.session.revision,'','performance',reviewId);
    await perf.confirmAssessmentTalentList(a,group,(await perf.getOnehrCalibration(a,group)).session.revision,'pip');
    await perf.confirmAssessmentTalentList(a,group,(await perf.getOnehrCalibration(a,group)).session.revision,'promotion');
    await perf.updateOnehrWindows(a,cycleId,2,{tb_bgceo:{opensAt:null,closesAt:null}},'Reopen BG potential before finalization.');
    await perf.lockOnehrCalibration(a,bg,(await perf.getOnehrCalibration(a,bg)).session.revision,'','potential');
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);const frozen=(await view(a)).result!;expect(frozen.performance).toBe('AE');
    await expect(perf.unlockOnehrCalibration(a,group,(await perf.getOnehrCalibration(a,group)).session.revision,'Change a frozen result','performance',reviewId)).rejects.toThrow(/Finalized/);
    expect((await view(a)).result?.digest).toBe(frozen.digest);
    const audit=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,group),eq(schema.domainEvent.eventType,'onehr.calibration-reopened')));expect(audit).toHaveLength(1);expect(audit[0].payload).toMatchObject({reason:'Correct the group decision',axis:'performance'});
    await owner.db.update(schema.reviewCycle).set({status:'closed'}).where(eq(schema.reviewCycle.id,cycleId));
    await expect(perf.lockOnehrCalibration(a,bg,(await perf.getOnehrCalibration(a,bg)).session.revision,'')).rejects.toThrow(/read-only/);
  });
  it('rejects stale submissions, self approvals, legacy bypasses, and cross-tenant requests',async()=>{
    const first=await view(self);await perf.saveOnehrKpis(self,reviewId,first.revision,[],false);
    await expect(perf.saveOnehrKpis(self,reviewId,first.revision,[],false)).rejects.toThrow(/changed/);
    await expect(perf.approveOnehrScorecard(self,reviewId,(await view(self)).revision,true,'')).rejects.toThrow(/not assigned/);
    await expect(perf.submitManagerReview(mgr,{reviewId,managerRating:5,overallRating:5})).rejects.toThrow(/performance and talent/);
    await expect(perf.releaseCycle(a,{cycleId})).rejects.toThrow(/performance and talent/);
    const other=await seedBase();await setModule(other.tenantId,'performance','active');expect(await perf.getOnehrReview(await entitledCtx(other),reviewId)).toBeNull();
    await expect(perf.closeCycle(self,{cycleId})).rejects.toThrow(/admin|not found/);
  });
  it('switches active modules without losing work and archives unfinished reviews without creating reward inputs',async()=>{
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Retain unfinished work',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}]);
    let cycle=(await perf.getOnehrCycle(a,cycleId))!;const original=cycle.policy.modules;
    await expect(perf.updateAssessmentModules(self,cycleId,cycle.revision,{...original,pm:false})).rejects.toThrow(/administrator/);
    await perf.updateAssessmentModules(a,cycleId,cycle.revision,{...original,pm:false});
    expect((await perf.performanceWorkspace(self)).some(i=>i.id===reviewId&&i.module==='pm')).toBe(false);
    expect((await view(self)).kpis[0].title).toBe('Retain unfinished work');
    await expect(perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[])).rejects.toThrow(/disabled/);
    cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.updateAssessmentModules(a,cycleId,cycle.revision,original);
    expect((await perf.performanceWorkspace(self)).some(i=>i.id===reviewId&&i.module==='pm')).toBe(true);
    expect((await view(self)).kpis[0].id).toBe(id);
    await expect(withTenant(a,tx=>tx.update(schema.onehrCycle).set({policy:{...cycle.policy,aBands:[0,1,2,3,10]}}).where(eq(schema.onehrCycle.cycleId,cycleId)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/policy is immutable/)})});
    await perf.closeCycle(a,{cycleId});
    expect((await view(self)).finalized).toBe(true);expect((await view(a)).kpis[0].id).toBe(id);
    expect((await perf.performanceWorkspace(self)).some(i=>i.id===reviewId)).toBe(false);
    expect(await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId))).toEqual([]);
    await expect(perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[])).rejects.toThrow(/not open/);
    await expect(perf.updateAssessmentModules(a,cycleId,(await perf.getOnehrCycle(a,cycleId))!.revision,original)).rejects.toThrow(/active cycle/);
    await expect(withTenant(a,tx=>tx.update(schema.onehrReview).set({selfRemark:'Changed after archive'}).where(eq(schema.onehrReview.reviewId,reviewId)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/archived assessment/)})});
  });
  it('reports scoped HR completion and source-shaped assessor CSV without private drafts or rater answers',async()=>{
    await expect(perf.getAssessmentProgress(self,cycleId)).rejects.toThrow(/administrator/);
    const privateWords='Keep this draft conversation private.';await perf.sendReviewMessage(self,reviewId,'career',null,randomUUID(),privateWords);
    let report=await perf.getAssessmentProgress(a,cycleId,{q:'Assessment subject'});expect(report.rows).toHaveLength(1);expect(report.rows[0].cells.pm).toMatchObject({state:'pending',label:'not_set'});expect(JSON.stringify(report)).not.toContain(privateWords);
    expect((await perf.getAssessmentProgress(a,cycleId,{companyId:randomUUID()})).rows).toEqual([]);
    await complete();report=await perf.getAssessmentProgress(a,cycleId,{q:'Assessment subject'});
    expect(report.rows[0].cells).toMatchObject({pm:{state:'done'},competency:{state:'done'},feedback:{state:'done',completed:4,count:4},calibration:{state:'pending'}});
    expect(JSON.stringify(report)).not.toMatch(/Consistently observed|Observed delivery|Completed outcomes/);
    const sid=await perf.createOnehrCalibration(a,cycleId,{name:'Progress department',companyId:b.companyId,tier:'hod',reviewerUserIds:[a.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    await perf.saveOnehrCalibration(a,sid,(await perf.getOnehrCalibration(a,sid)).session.revision,{reviewId,axis:'potential',performance:null,potential:'High',performanceNote:'',potentialNote:''});
    expect((await perf.getAssessmentProgress(a,cycleId,{q:'Assessment subject',module:'calibration'})).rows[0].cells.calibration?.state).toBe('active');
    await perf.lockOnehrCalibration(a,sid,(await perf.getOnehrCalibration(a,sid)).session.revision,'','potential');
    expect((await perf.getAssessmentProgress(a,cycleId,{q:'Assessment subject',module:'calibration'})).rows[0].cells.calibration?.state).toBe('done');
    await recordLoginSucceeded({tenantId:b.tenantId,userId:peers[0].ctx.userId!});
    const assessors=await perf.getAssessmentAssessorProgress(a,cycleId);expect(assessors).toHaveLength(4);expect(assessors.find(r=>r.employmentId===peers[0].employmentId)).toMatchObject({assigned:1,done:1,remaining:0,state:'done',lastLogin:expect.any(String)});
    const csv=parseCsv(await perf.exportAssessmentAssessorProgress(a,cycleId,{q:'Peer 0',state:'done'}));expect(csv).toHaveLength(2);expect(csv[0]).toEqual(['Employee ID','Name','Email','Business Group','Company','Department','Assigned','Done','Remaining','Status','Last login (MYT)']);expect(csv[1][1]).toBe('Peer 0');expect(csv[1].slice(6,10)).toEqual(['1','1','0','Done']);
    expect((await perf.exportAssessmentProgress(a,cycleId,{q:'Assessment subject',module:'competency',state:'done'}))).not.toMatch(/Observed delivery|Consistently observed|Keep this draft/);
    expect((await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'onehr.assessor-progress-exported')))).toHaveLength(1);
  });

  it('maps leader parts to CAL, keeps axis states independent and gives BG leaders Mine only for pending colleague feedback',async()=>{
    const make=(tier:'hod'|'bu'|'bg'|'group')=>perf.createOnehrCalibration(a,cycleId,{name:`${tier} cohort`,companyId:b.companyId,tier,reviewerUserIds:[mgr.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    const hod=await make('hod'),bu=await make('bu'),group=await make('group');
    let items=await perf.performanceWorkspace(mgr);
    expect(items.filter(i=>i.id===hod)).toHaveLength(2);expect(items.filter(i=>i.id===hod)).toEqual(expect.arrayContaining([expect.objectContaining({module:'cal',axis:'performance',stage:'department_review'}),expect.objectContaining({module:'cal',axis:'potential',stage:'department_potential_review'})]));
    // P1 WP-D: with PM and TM on, the BU CEO also has the Talent Box beside the per-axis calibration parts.
    expect(items.filter(i=>i.id===bu).map(i=>i.axis).sort()).toEqual(['both','performance','potential']);expect(items.filter(i=>i.id===bu&&i.axis==='both')).toMatchObject([{module:'cal',stage:'talent_box'}]);
    // P1 WP-D (C10): the Group Chief's Talent Box follows the performance-only group list.
    expect(items.filter(i=>i.id===group)).toMatchObject([{module:'cal',axis:'performance',stage:'group_calibration'},{module:'cal',axis:'both',stage:'talent_box'}]);
    expect(items.some(i=>i.view==='mine'&&i.kind==='review')).toBe(true);
    const bg=await make('bg');items=await perf.performanceWorkspace(mgr);
    expect(items.filter(i=>i.id===bg)).toMatchObject([{module:'cal',axis:'both',stage:'talent_box'}]);expect(items.some(i=>i.view==='mine')).toBe(false);
    await perf.assignOnehrPanel(a,reviewId,(await view(a)).revision,[{employmentId:manager.employmentId,relationship:'line_manager'}]);
    const pending=(await perf.performanceWorkspace(mgr)).filter(i=>i.view==='mine');expect(pending).toHaveLength(1);expect(pending[0]).toMatchObject({kind:'feedback',state:'open'});
    const card=await perf.getOnehrFeedback(mgr,pending[0].id);await perf.submitOnehrFeedback(mgr,pending[0].id,Object.fromEntries(card.statements.map(s=>[s.id,'no'])),'');
    expect((await perf.performanceWorkspace(mgr)).some(i=>i.view==='mine')).toBe(false);
    // HR's administrative view is not mistaken for a BG CEO designation.
    expect((await perf.performanceWorkspace(a)).filter(i=>i.id===bg)).toHaveLength(1);
  });

  it('switches calibration and guided review independently while retaining confirmed bands and private conversations',async()=>{
    await complete();
    const id=await perf.createOnehrCalibration(a,cycleId,{name:'Department review',companyId:b.companyId,tier:'hod',reviewerUserIds:[a.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    await perf.saveOnehrCalibration(a,id,1,{reviewId,performance:'AE',potential:'High',performanceNote:'Verified broader outcomes',potentialNote:''});
    await perf.lockOnehrCalibration(a,id,(await perf.getOnehrCalibration(a,id)).session.revision,'');
    const before=(await view(a)).result?.performance;expect(before).toBe('AE');
    const message=await perf.sendReviewMessage(self,reviewId,'career',null,randomUUID(),'What do I do next?');
    let cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.updateAssessmentModules(a,cycleId,cycle.revision,{...cycle.policy.modules,calibration:false,review:false});
    await expect(perf.getOnehrCalibration(a,id)).rejects.toThrow(/disabled/);expect((await perf.performanceWorkspace(a)).some(i=>i.id===id)).toBe(false);
    await expect(perf.sendReviewMessage(self,reviewId,'career',message.revision,randomUUID(),'Continue')).rejects.toThrow(/disabled/);
    expect(await withTenant(self,tx=>tx.select().from(schema.assessmentConversation).where(eq(schema.assessmentConversation.reviewId,reviewId)))).toEqual([]);
    expect((await view(a)).result?.performance).toBe(before);
    cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.updateAssessmentModules(a,cycleId,cycle.revision,{...cycle.policy.modules,calibration:true,review:true});
    expect((await perf.getOnehrCalibration(a,id)).rows[0].currentPerformance).toBe('AE');expect(await perf.getReviewConversation(self,reviewId,'career')).toMatchObject({revision:message.revision,messages:message.messages});
  });

  it('previews source bulk panels without lasting writes and leaves scored panels unchanged on top-up',async()=>{
    const events=(await owner.db.select().from(schema.domainEvent)).length;
    await expect(perf.buildAssessmentPanels(self,cycleId,'missing')).rejects.toThrow(/administrator/);
    const preview=await perf.buildAssessmentPanels(a,cycleId,'missing');
    expect(preview.rows.find(r=>r.reviewId===reviewId)).toMatchObject({status:'add',before:0,after:5});
    expect(await owner.db.select().from(schema.onehrPanel)).toEqual([]);expect((await owner.db.select().from(schema.domainEvent)).length).toBe(events);
    expect((await view(a)).revision).toBe(1);
    const applied=await perf.buildAssessmentPanels(a,cycleId,'missing',preview.token);expect(applied.applied).toBe(true);expect((await view(a)).peers.filter(p=>!p.archivedAt)).toHaveLength(5);
    await expect(perf.buildAssessmentPanels(a,cycleId,'missing',preview.token)).rejects.toThrow(/changed/);
    expect((await perf.buildAssessmentPanels(a,cycleId,'missing')).rows.every(r=>!r.add.length)).toBe(true);
    const [another]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,peers[1].employmentId)));
    const row=(await perf.getOnehrReview(a,another.reviewId))!;expect(row.peers).toHaveLength(5);
    for(const member of row.peers.slice(2))await perf.changeAssessmentPanelState(a,another.reviewId,(await perf.getOnehrReview(a,another.reviewId))!.revision,member.requestId,'archive','Prepare an incomplete scored-panel fixture');
    const active=(await perf.getOnehrReview(a,another.reviewId))!.peers.find(p=>!p.archivedAt)!;
    const rater=active.employmentId===manager.employmentId?mgr:peers.find(p=>p.employmentId===active.employmentId)?.ctx??self;
    const card=await perf.getOnehrFeedback(rater,active.requestId);await perf.submitOnehrFeedback(rater,active.requestId,Object.fromEntries(card.statements.map(s=>[s.id,'no'])),'');
    const before=(await perf.getOnehrReview(a,another.reviewId))!.peers;
    const topup=await perf.buildAssessmentPanels(a,cycleId,'topup');expect(topup.rows.find(r=>r.reviewId===another.reviewId)).toMatchObject({status:'started',add:[]});
    await perf.buildAssessmentPanels(a,cycleId,'topup',topup.token);
    expect((await perf.getOnehrReview(a,another.reviewId))!.peers).toEqual(before);
  });
  it('imports panels atomically, preserves submitted answers on relationship edits and restores explicit archived pairings',async()=>{
    const eids=await owner.db.select({id:schema.employment.id,code:schema.employment.employeeCode}).from(schema.employment),code=(id:string)=>{const value=eids.find(e=>e.id===id)?.code;if(!value)throw Error('Missing fixture employee ID');return value;};
    const file=(rows:string[][])=>toCsv([['Subject Employee ID','Assessor Employee ID','Relationship'],...rows]);
    const source=file(peers.map(p=>[code(subject.employmentId),code(p.employmentId),'Peer / Stakeholder']));
    const preview=await perf.importAssessmentPanels(a,cycleId,source,'add');expect(preview.rows).toMatchObject([{count:4,created:4}]);expect(await owner.db.select().from(schema.onehrPanel)).toEqual([]);
    const bad=file([[code(subject.employmentId),code(peers[0].employmentId),'peer'],[code(peers[1].employmentId),code(peers[1].employmentId),'peer']]);
    await expect(perf.importAssessmentPanels(a,cycleId,bad,'add')).rejects.toThrow(/different active assessor/);expect(await owner.db.select().from(schema.onehrPanel)).toEqual([]);
    await perf.importAssessmentPanels(a,cycleId,source,'add',preview.token);
    for(const peer of peers){const req=(await perf.onehrAssignments(peer.ctx)).feedback.find(f=>f.subject==='Assessment subject')!,card=await perf.getOnehrFeedback(peer.ctx,req.id);await perf.submitOnehrFeedback(peer.ctx,req.id,Object.fromEntries(card.statements.map(s=>[s.id,'no'])),'');}
    await perf.releaseOnehrResult(a,reviewId,'feedback',true);
    const request=(await view(a)).peers.find(p=>p.employmentId===peers[0].employmentId)!.requestId;
    const original=await perf.getOnehrFeedback(peers[0].ctx,request),change=file([[code(subject.employmentId),code(peers[0].employmentId),'matrix manager']]);
    const edit=await perf.importAssessmentPanels(a,cycleId,change,'add');expect(edit.rows).toMatchObject([{created:0,updated:1}]);await perf.importAssessmentPanels(a,cycleId,change,'add',edit.token);
    expect((await perf.getOnehrFeedback(peers[0].ctx,request)).answers).toEqual(original.answers);expect((await view(self)).result?.feedbackReleased).toBe(true);
    await expect(perf.importAssessmentPanels(a,cycleId,change,'replace')).rejects.toThrow(/Keep every submitted assessor/);expect((await view(a)).peers).toHaveLength(4);
    await perf.changeAssessmentPanelState(a,reviewId,(await view(a)).revision,request,'archive','Retain the submitted feedback');
    const restore=await perf.importAssessmentPanels(a,cycleId,change,'add');expect(restore.rows).toMatchObject([{restored:1}]);
    expect((await view(a)).peers.find(p=>p.requestId===request)?.archivedAt).not.toBeNull();
    await perf.importAssessmentPanels(a,cycleId,change,'add',restore.token);
    expect(await perf.getOnehrFeedback(peers[0].ctx,request)).toMatchObject({submitted:true,answers:original.answers});
  });

  it('carries catalogue edits into new cycles while retaining existing assignments and independent policy',async()=>{
    const group={...a,grants:[{role:'hr_admin',companyId:null}]};
    const make=async(name:string)=>perf.createCycle(group,{name,companyId:b.companyId,periodStart:`${year+1}-01-01`,periodEnd:`${year+1}-12-31`,assessmentWorkflow:true});
    const old=(await perf.getOnehrCycle(group,cycleId))!,profile=old.policy.profiles[0],assigned=(await view(self)).competencies;
    const {cycleId:alreadyCreated}=await make('Already created snapshot');
    await perf.saveAssessmentCatalogueProfile(group,cycleId,old.revision,profile.id,{name:'Updated Engineering',companyId:profile.companyId,grade:profile.grade,competencies:profile.competencies});
    const {cycleId:nextId}=await make('Inherited catalogue');let next=(await perf.getOnehrCycle(group,nextId))!;
    expect(next.policy.profiles.find(p=>p.id===profile.id)?.name).toBe('Updated Engineering');expect(next.policy.modules.evidence).toBe(false);expect(next.policy.windows).toEqual({});
    expect((await perf.getOnehrCycle(group,alreadyCreated))!.policy.profiles.find(p=>p.id===profile.id)?.name).toBe('Engineering');expect((await view(self)).competencies).toEqual(assigned);
    const otherId=await perf.saveAssessmentCatalogueProfile(group,nextId,next.revision,null,{name:'Future specialist',companyId:b.companyId,grade:'13',competencies:[]});
    const older=(await perf.getOnehrCycle(group,cycleId))!;
    await expect(perf.saveAssessmentCatalogueProfile(group,alreadyCreated,(await perf.getOnehrCycle(group,alreadyCreated))!.revision,profile.id,{name:'Stale overwrite',companyId:profile.companyId,grade:profile.grade,competencies:profile.competencies})).rejects.toThrow(/another cycle/);
    await perf.saveAssessmentCatalogueProfile(group,cycleId,older.revision,profile.id,{name:'Engineering retained with newer addition',companyId:profile.companyId,grade:profile.grade,competencies:profile.competencies});
    const {cycleId:third}=await make('Merged catalogue');expect((await perf.getOnehrCycle(group,third))!.policy.profiles.map(p=>p.id)).toEqual([profile.id,otherId]);
    const active=(await perf.getOnehrCycle(group,cycleId))!,principle=leadershipPrinciples(active.policy)[0];
    await perf.updateAssessmentFramework(group,cycleId,active.revision,{action:'edit_principle',principleId:principle.id,name:'Future customer practice',description:'Observable service outcomes'});
    const {cycleId:fourth}=await make('Inherited leadership framework');expect(leadershipPrinciples((await perf.getOnehrCycle(group,fourth))!.policy).some(p=>p.name==='Future customer practice')).toBe(true);
    expect(leadershipPrinciples((await perf.getOnehrCycle(group,third))!.policy).some(p=>p.name==='Future customer practice')).toBe(false);
    expect(await withTenant(self,tx=>tx.select().from(schema.assessmentCatalogue))).toEqual([]);
    await expect(withTenant(self,tx=>tx.execute(sql`select app.assessment_catalogue_defaults(${b.companyId}::uuid)`))).rejects.toMatchObject({cause:{message:expect.stringMatching(/administrator/)}});
  });
  it('filters group catalogue defaults by company and never carries employee assignments',async()=>{
    const group={...a,grants:[{role:'hr_admin',companyId:null}]},[other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Other catalogue company'}).returning();
    const {cycleId:globalId}=await perf.createCycle(group,{name:'Group catalogue source',companyId:null,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
    const p=defaultPolicy(framework),shared={id:randomUUID(),name:'Shared definition',grade:'12',companyId:null,competencies:[]},privateProfile={...shared,id:randomUUID(),companyId:b.companyId,name:'Company private definition',employmentIds:[subject.employmentId]};p.profiles=[shared,privateProfile];p.careerRoutes=[{fromProfileId:shared.id,toProfileId:privateProfile.id,kind:'hidden'}];
    await perf.configureOnehrCycle(group,globalId,null,p);
    const scopedUser=await createAppUser(b.tenantId,peers[0].ctx.personId!,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:other.id}).where(eq(schema.roleAssignment.appUserId,scopedUser));
    const otherAdmin={...a,userId:scopedUser,personId:peers[0].ctx.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:other.id}]};
    const {cycleId:newId}=await perf.createCycle(otherAdmin,{name:'Other company future cycle',companyId:other.id,periodStart:`${year+1}-01-01`,periodEnd:`${year+1}-12-31`,assessmentWorkflow:true});
    const inherited=(await perf.getOnehrCycle(otherAdmin,newId))!.policy;expect(inherited.profiles).toEqual([shared]);expect(inherited.careerRoutes).toEqual([]);
    await expect(withTenant(otherAdmin,tx=>tx.execute(sql`select app.assessment_catalogue_defaults(${b.companyId}::uuid)`))).rejects.toMatchObject({cause:{message:expect.stringMatching(/administrator/)}});
    const stored=await owner.db.select().from(schema.assessmentCatalogue).where(eq(schema.assessmentCatalogue.scopeKey,'group'));expect(JSON.stringify(stored)).not.toContain(subject.employmentId);
    const foreign=await seedBase();expect(await withTenant(adminCtx(foreign),tx=>tx.select().from(schema.assessmentCatalogue))).toEqual([]);
    await expect(withTenant(group,tx=>tx.update(schema.assessmentCatalogue).set({catalogue:{profiles:[privateProfile],skills:[],careerRoutes:[]}}).where(eq(schema.assessmentCatalogue.scopeKey,'group')))).rejects.toMatchObject({cause:{message:expect.stringMatching(/assignments/)}});
  });
});
