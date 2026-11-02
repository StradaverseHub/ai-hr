import {enrollOnehrReviewTaskEmailTx} from '../packs/performance/onehr/review-task-email-source';
import {withOnehrWorkerSource,createOnehrWorkerAccess} from '../packs/performance/onehr/worker-source';
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
import {assessmentDevelopmentContext} from '../packs/performance/onehr/development-suggestion-service';
import { defaultPolicy, scorecard, type KPI } from '../packs/performance/onehr/model';
import {assessmentReminderWork,type ReminderWorkGraph} from '../packs/performance/onehr/reminder-work';
import framework from '../packs/performance/onehr/framework.json';
import sourceGolden from './fixtures/onehr/source-golden.json';
import { createRewardUnit, getRewardUnit, importOnehrRewardResults } from '../packs/rewards/service';
import { adminCtx, closeAll, createAppUser, entitledCtx, harnessSnapshot, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { switchOnPerformanceAi } from './performance-ai-switches-fixture';
import { saveNotificationEmailPolicy,saveNotificationEmailPreferences,retryNotificationEmail } from '../core/notification-email';
import { deliverNotificationEmails,type NotificationEmailTransport } from '../core/notification-email-delivery';
import { dispatchNotifications,dispatchNotificationsFromSweep,notificationStillTargets } from '../core/notifications';
import { appendEvent,actorOf } from '../db/events';
import { todayInKualaLumpur } from '../lib/hr-date';

vi.mock('../lib/ai',async importActual=>({...await importActual<typeof import('../lib/ai')>(),generateDraft:vi.fn(),readImage:vi.fn()}));
vi.mock('../core/ai-config',async importActual=>({...await importActual<typeof import('../core/ai-config')>(),resolveActiveAiConfig:vi.fn()}));
import { generateDraft,readImage } from '../lib/ai';
import { resolveActiveAiConfig } from '../core/ai-config';
import {installSyntheticSpendCapability} from './ai-spend-fixture';
// Issued snapshots are process-private capabilities; raw provider/key lookalikes are invalid.
async function issuedFixtureConfig(...args:Parameters<typeof resolveActiveAiConfig>){return (await vi.importActual<typeof import('../core/ai-config')>('../core/ai-config')).resolveActiveAiConfig(...args);}
import {createOnehrServiceFixtures,restrictedReminderMailOwner,year} from './onehr-service-fixture';
describe('Native performance workflow and Rewards boundary with real RLS',()=>{
  let b:Base,a:SessionContext,subject:{employmentId:string;personId:string},manager:{employmentId:string;personId:string},self:SessionContext,mgr:SessionContext,cycleId:string,reviewId:string;
  let peers:{employmentId:string;ctx:SessionContext}[];
const {hire,view,editableDraftKpi,complete,reviewerPlan}=createOnehrServiceFixtures({get b(){return b;},get a(){return a;},get subject(){return subject;},get manager(){return manager;},get self(){return self;},get mgr(){return mgr;},get cycleId(){return cycleId;},get reviewId(){return reviewId;},get peers(){return peers;}});

  // Explicitly selected provider-positive cases only; native source/permission owners remain real.
  let syntheticSpend:Awaited<ReturnType<typeof installSyntheticSpendCapability>>|undefined;
  async function prepareMockedSpend(feature:'performance_assistant'|'performance_review'){
    expect(vi.isMockFunction(generateDraft)).toBe(true);
    const configuration=await withTenant(a,tx=>issuedFixtureConfig(tx,a,feature));if(!configuration)throw Error('Missing actual issued fixture configuration');
    syntheticSpend=await installSyntheticSpendCapability(a,{provider:configuration.provider,model:configuration.model});
  }
  afterEach(()=>{syntheticSpend?.restore();syntheticSpend=undefined;vi.unstubAllEnvs();});
  beforeEach(async()=>{
    vi.stubEnv('OPENAI_API_KEY','fictional-unit-transport-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
    vi.mocked(readImage).mockReset().mockResolvedValue('Verified 15.9 units.');vi.mocked(generateDraft).mockReset().mockResolvedValue('{"items":[0]}');vi.mocked(resolveActiveAiConfig).mockReset().mockResolvedValue(null);
    await resetDb();b=await seedBase();a=adminCtx(b);await setModule(b.tenantId,'performance','active');await switchOnPerformanceAi(b.tenantId);await setModule(b.tenantId,'rewards','active');a=await entitledCtx(b);
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
  it('qualifies the private scalar scorecard owner against ordered A/B preview math and actual stored source',async()=>{
    const [policyRow]=await owner.db.select().from(schema.onehrCycle).where(eq(schema.onehrCycle.cycleId,cycleId));
    const policy:ReturnType<typeof defaultPolicy>={...defaultPolicy(framework),bBands:[{companyId:b.companyId,variant:'base' as const,minima:[0,70,90,110,130]}]};
    const make=(actual:number,scoring:KPI['scoring'],weightBp=10000):KPI=>({id:randomUUID(),title:'Fictional math oracle',description:'',weightBp,unit:'units',scoring,moderatorEmploymentId:manager.employmentId,setting:'approved',settingRemark:'',actual,note:'',approvedActual:actual,moderationRemark:'',locked:true});
    const cases:KPI[][]=[[],[make(1,{mechanism:'A',method:'more',rates:[0,1,2,3,4]},0)]];
    for(const method of ['more','less'] as const){
      const scoring:KPI['scoring']={mechanism:'A',method,rates:method==='more'?[0,1,2,3,4]:[4,3,2,1,0]};
      for(const actual of [-1,0,1-Number.EPSILON,1,1+Number.EPSILON,2,3,4,5])cases.push([make(actual,scoring)],[make(actual,scoring,3333),make(4-actual,scoring,6667)]);
      for(const variant of ['base','excellence'] as const)for(const multiple of [0,25,100,10000])for(const actual of [-10,0,50,50+Number.EPSILON*50,100,150,200])cases.push([make(actual,{mechanism:'B',method,variant,threshold:50,target:100,multiple,excellence:150})]);
    }
    for(const kpis of cases.slice(2,8)){cases.push(kpis.map(k=>({...k,locked:false})),kpis.map(k=>({...k,actual:null})));}
    const rows=await owner.db.execute<{position:number;value:{score:number|null;band:string|null;scoreText:string|null}}>(sql`select item.position::integer as position,app.financial_onehr_scorecard(item.kpis,${JSON.stringify(policy)}::jsonb,${b.companyId}::uuid,false) as value from jsonb_array_elements(${JSON.stringify(cases)}::jsonb) with ordinality item(kpis,position)`);
    const assertScalar=(value:{score:number|null;band:string|null;scoreText:string|null},expected:ReturnType<typeof scorecard>)=>{expect(Object.keys(value).sort()).toEqual(['band','score','scoreText']);expect({score:value.score,band:value.band}).toEqual(JSON.parse(JSON.stringify(expected)));if(expected.score===null)expect(value.scoreText).toBeNull();else if(Number.isNaN(expected.score))expect(value.scoreText).toBe('NaN');else expect(Number(value.scoreText)).toBe(expected.score===0?0:expected.score);};
    expect(rows).toHaveLength(cases.length);for(const row of rows)assertScalar(row.value,scorecard(cases[row.position-1],policy,b.companyId,false));
    const managerRows=await owner.db.execute<{position:number;value:{score:number|null;band:string|null;scoreText:string|null}}>(sql`select item.position::integer as position,app.financial_onehr_scorecard(item.kpis,${JSON.stringify(policy)}::jsonb,${b.companyId}::uuid,true) as value from jsonb_array_elements(${JSON.stringify(cases)}::jsonb) with ordinality item(kpis,position)`);
    for(const row of managerRows)assertScalar(row.value,scorecard(cases[row.position-1],policy,b.companyId,true));
    await complete();const [stored]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));expect((stored.kpis as KPI[]).length).toBeGreaterThan(0);
    for(const manager of [false,true]){const [actual]=await owner.db.execute<{value:{score:number|null;band:string|null;scoreText:string|null}}>(sql`select app.financial_onehr_scorecard(${JSON.stringify(stored.kpis)}::jsonb,${JSON.stringify(policyRow.policy)}::jsonb,${stored.companyId}::uuid,${manager}::boolean) as value`);assertScalar(actual.value,scorecard(stored.kpis as KPI[],policyRow.policy as ReturnType<typeof defaultPolicy>,stored.companyId,manager));}
    const [privilege]=await owner.db.execute<{allowed:boolean}>(sql`select has_function_privilege('ai_hr_app','app.financial_onehr_scorecard(jsonb,jsonb,uuid,boolean)','EXECUTE') as allowed`);expect(privilege.allowed).toBe(false);
  });

  it('preserves the original stored-service overflow, zero-weight refusal and underflow boundary outcomes before scalar cutover',async()=>{
    for(const fixture of [{name:'overflow',target:1e-308,actual:1e308,multiple:100},{name:'nan',target:1e-308,actual:1e308,multiple:0},{name:'underflow',target:1e308,actual:1e-308,multiple:100}]){
      const {cycleId:actualCycle}=await perf.createCycle(a,{name:'Fictional original scalar '+fixture.name,companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
      const policy=defaultPolicy(framework);policy.bBands=[{companyId:b.companyId,variant:'base',minima:[0,70,90,110,130]}];await perf.configureOnehrCycle(a,actualCycle,null,policy);await perf.openCycle(a,{cycleId:actualCycle});
      const [header]=await owner.db.select({id:schema.performanceReview.id}).from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,actualCycle),eq(schema.performanceReview.employmentId,subject.employmentId)));expect(header).toBeDefined();
      const revision=async()=>{const [row]=await owner.db.select({revision:schema.onehrReview.revision}).from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,header.id));return row.revision;};
      const id=randomUUID(),input={id,title:'Native '+fixture.name,description:'Fictional source boundary',weightBp:10000,unit:'units',scoring:{mechanism:'B' as const,method:'more' as const,variant:'base' as const,threshold:0,target:fixture.target,multiple:fixture.multiple,excellence:null},moderatorEmploymentId:manager.employmentId};
      if(fixture.name==='underflow'){
        await perf.saveOnehrKpis(self,header.id,await revision(),[{...input,weightBp:0}]);const [draft]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,header.id));
        await expect(perf.saveOnehrKpis(self,header.id,draft.revision,[{...input,weightBp:0}],true)).rejects.toThrow(/weights must total/);expect(await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,header.id))).toEqual([draft]);
      }
      await perf.saveOnehrKpis(self,header.id,await revision(),[input],true);await perf.approveOnehrScorecard(mgr,header.id,await revision(),true,'Source thresholds verified');
      await perf.submitOnehrResults(self,header.id,await revision(),[{id,actual:fixture.actual,note:'Actual native boundary input'}],'Actual employee source reflection.');
      const [before]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,header.id));const oldEvents=await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,header.id)).orderBy(schema.domainEvent.id);
      const native=scorecard((before.kpis as KPI[]).map(k=>({...k,approvedActual:fixture.actual,locked:true})),policy,b.companyId,true);
      const proposed=(before.kpis as KPI[]).map(k=>({...k,approvedActual:fixture.actual,locked:true}));
      const [scalar]=await owner.db.execute<{value:{score:number|null;band:string|null;scoreText:string}}>(sql`select app.financial_onehr_scorecard(${JSON.stringify(proposed)}::jsonb,${JSON.stringify(policy)}::jsonb,${b.companyId}::uuid,true) as value`);expect({score:scalar.value.score,band:scalar.value.band}).toEqual(JSON.parse(JSON.stringify(native)));expect(scalar.value.scoreText).not.toBeNull();
      const scalarStorage=()=>owner.db.execute<{value:string}>(sql`select (${scalar.value.scoreText}::text)::numeric(20,8)::text as value`);
      const mutate=()=>withTenant(mgr,tx=>perf.moderateOnehrKpiTx(tx,mgr,header.id,before.revision,id,fixture.actual,'',true));
      if(fixture.name==='overflow'){
        expect(native.score).toBe(Infinity);expect(native.band).toBe('OU');await expect(scalarStorage()).rejects.toThrow();await expect(mutate()).rejects.toThrow();expect(await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,header.id))).toEqual([before]);expect(await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,header.id)).orderBy(schema.domainEvent.id)).toEqual(oldEvents);
      }else{
        if(fixture.name==='nan'){expect(Number.isNaN(native.score)).toBe(true);expect(native.band).toBeNull();}else expect(native).toEqual({score:0,band:'UA'});
        await mutate();const [after]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,header.id));expect(after.revision).toBe(before.revision+1);expect(after.managerPerformance).toBe(native.band);if(fixture.name==='nan')expect(after.managerScore).toBe('NaN');else expect(Number(after.managerScore)).toBe(0);const [storedScalar]=await scalarStorage();expect(storedScalar.value).toBe(after.managerScore);
      }
    }
  });

  it('binds administrative KPI reassignment to actual source and candidate data ceilings',async()=>{
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Untouched administrative assignment',description:'Native source',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}]);
    const [before]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));await perf.assignAssessmentKpiModerator(a,reviewId,before.revision,id,peers[0].employmentId);
    const [after]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));const original=(before.kpis as KPI[])[0],changed=(after.kpis as KPI[])[0];
    expect(changed).toEqual({...original,moderatorEmploymentId:peers[0].employmentId,moderatorSource:'matrix',approvalChain:[{employmentId:peers[0].employmentId,actual:null,remark:'',at:null}]});expect(after).toEqual({...before,kpis:[changed],revision:before.revision+1});
    const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,reviewId),eq(schema.domainEvent.eventType,'onehr.kpi-moderator-assigned')));expect(events).toHaveLength(1);expect(events[0]).toMatchObject({actorType:'user',actorId:a.userId,payload:{kpiId:id,previous:manager.employmentId,moderatorEmploymentId:peers[0].employmentId}});
    await expect(withTenant(a,async tx=>{await tx.execute(sql`select set_config('app.agent_principal_id','invalid-agent',true)`);await tx.execute(sql`select app.onehr_kpi_moderator_assign(${reviewId}::uuid,${after.revision}::integer,${id}::uuid,${manager.employmentId}::uuid)`);})).rejects.toMatchObject({cause:expect.objectContaining({code:'42501',message:expect.stringMatching(/OneHR administration actor unavailable/)})});
    const hidden=await hireEmployee(a,{person:{fullName:'Fictional other-department candidate',primaryEmail:`fictional-moderator-${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
    const profile=randomUUID(),revision=randomUUID(),rules={legacyCompany:false,predicates:[{field:'department',values:[b.deptA]}]};
    await owner.client`insert into data_permission_profile(id,tenant_id,name) values(${profile},${b.tenantId},${'Fictional administrative candidate ceiling '+profile})`;
    await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by) values(${revision},${b.tenantId},${profile},${JSON.stringify(rules)}::text::jsonb,${a.userId!})`;
    await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${profile}`;
    await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by) values(${b.tenantId},${a.userId!},${profile},${a.userId!})`;
    const [source]=await withTenant(a,tx=>tx.execute<{edit:boolean;subject:boolean;candidate:boolean}>(sql`select app.onehr_review_administration_edit(${reviewId}::uuid) as edit,app.data_permission_matches(${subject.employmentId}::uuid) as subject,app.data_permission_matches(${hidden.employmentId}::uuid) as candidate`));expect(source).toEqual({edit:true,subject:true,candidate:false});
    await expect(perf.assignAssessmentKpiModerator(a,reviewId,after.revision,id,hidden.employmentId)).rejects.toThrow(/within your scope/);
    const excludedRevision=randomUUID();await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by) values(${excludedRevision},${b.tenantId},${profile},${JSON.stringify({...rules,predicates:[{field:'department',values:[b.deptB]}]})}::text::jsonb,${a.userId!})`;await owner.client`update data_permission_profile set active_revision_id=${excludedRevision} where id=${profile}`;
    const [excluded]=await withTenant(a,tx=>tx.execute<{edit:boolean}>(sql`select app.onehr_review_administration_edit(${reviewId}::uuid) as edit`));expect(excluded.edit).toBe(false);await expect(perf.assignAssessmentKpiModerator(a,reviewId,after.revision,id,hidden.employmentId)).rejects.toThrow(/administrative data unavailable/);
    expect(await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId))).toEqual([after]);expect(await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,reviewId),eq(schema.domainEvent.eventType,'onehr.kpi-moderator-assigned')))).toEqual([{id:events[0].id}]);
  });

  it('approves only the actual assigned setting lines against the full private scorecard source',async()=>{
    const first=randomUUID(),second=randomUUID();
    for(const peer of peers.slice(0,2))await setReportingLine(a,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:peer.employmentId,lineType:'functional',validFrom:`${year}-01-01`});
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[first,second].map((id,index)=>({id,title:index?'Other approver private target':'My assigned objective',description:index?'Unassigned narrative must remain private':'Assigned narrative',weightBp:5000,unit:'units',scoring:{mechanism:'A' as const,method:'more' as const,rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId})));
    // The native HR owner assigns matrix moderators; employee submission preserves that source.
    for(const [index,kpiId] of [first,second].entries())await perf.assignAssessmentKpiModerator(a,reviewId,(await view(a)).revision,kpiId,peers[index].employmentId);
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,(await view(self)).kpis,true);
    const [before]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));
    const profile=randomUUID(),revision=randomUUID(),rules={legacyCompany:false,predicates:[{field:'department',values:[b.deptB]}]};
    await owner.client`insert into data_permission_profile(id,tenant_id,name) values(${profile},${b.tenantId},${'Fictional scorecard approver '+profile})`;
    await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by) values(${revision},${b.tenantId},${profile},${JSON.stringify(rules)}::text::jsonb,${a.userId!})`;
    await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${profile}`;
    await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by) values(${b.tenantId},${peers[0].ctx.userId!},${profile},${a.userId!})`;
    const assigned=await perf.getOnehrReviewForPurpose(peers[0].ctx,reviewId,'task');expect(assigned).not.toBeNull();expect(assigned!.kpis.map(k=>k.id)).toEqual([first]);expect(JSON.stringify(assigned)).not.toContain('Unassigned narrative must remain private');
    expect(await withTenant(peers[0].ctx,tx=>tx.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId)))).toEqual([]);
    await perf.approveOnehrScorecard(peers[0].ctx,reviewId,before.revision,true,'Assigned target approved');
    const [after]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));const oldKpis=before.kpis as Record<string,unknown>[],kpis=after.kpis as Record<string,unknown>[];
    expect(after.revision).toBe(before.revision+1);expect(kpis[1]).toEqual(oldKpis[1]);expect(kpis[0]).toMatchObject({...oldKpis[0],setting:'approved',settingRemark:'Assigned target approved',settingApprovals:[{employmentId:peers[0].employmentId,action:'approved',remark:'Assigned target approved',at:expect.any(String)}]});
    const approval=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,reviewId),eq(schema.domainEvent.eventType,'onehr.scorecard-approved')));expect(approval).toHaveLength(1);expect(approval[0]).toMatchObject({actorType:'user',actorId:peers[0].ctx.userId,subjectEmploymentId:subject.employmentId,payload:{reason:'Assigned target approved',kpiIds:[first]}});
    expect((await perf.getOnehrReviewForPurpose(peers[0].ctx,reviewId,'task'))!.kpis.map(k=>k.id)).toEqual([first]);
    await expect(perf.approveOnehrScorecard(peers[0].ctx,reviewId,after.revision,true,'Borrowed second line')).rejects.toThrow(/awaiting your turn/);
    expect(await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId))).toEqual([after]);
    await perf.approveOnehrScorecard(peers[1].ctx,reviewId,after.revision,true,'Other assigned target approved');expect((await view(self)).kpis.every(k=>k.setting==='approved')).toBe(true);
  });

  it('revokes relationship-based matrix access with the edge and explicit access with HR reassignment',async()=>{
    const matrix=peers[0];
    await setReportingLine(a,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:matrix.employmentId,lineType:'functional',validFrom:`${year}-01-01`});
    const id=randomUUID();
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Relationship-based objective',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}],false);
    // Persisted relationship-based assignments predate explicit HR matrix pins.
    const legacy=(await view(a)).kpis.map(k=>({...k,moderatorEmploymentId:matrix.employmentId,moderatorSource:'line' as const,approvalChain:[{employmentId:matrix.employmentId,actual:null,remark:'',at:null}]}));
    await owner.db.update(schema.onehrReview).set({kpis:legacy}).where(eq(schema.onehrReview.reviewId,reviewId));
    expect((await view(matrix.ctx)).kpis.map(k=>k.id)).toEqual([id]);
    await owner.db.update(schema.reportingLine).set({validTo:`${year}-01-01`}).where(and(eq(schema.reportingLine.managerEmploymentId,matrix.employmentId),eq(schema.reportingLine.lineType,'functional')));
    expect(await perf.getOnehrReview(matrix.ctx,reviewId)).toBeNull();
    await perf.assignAssessmentKpiModerator(a,reviewId,(await view(a)).revision,id,matrix.employmentId);
    expect((await view(matrix.ctx)).kpis.map(k=>k.id)).toEqual([id]);
    await perf.assignAssessmentKpiModerator(a,reviewId,(await view(a)).revision,id,manager.employmentId);
    expect(await perf.getOnehrReview(matrix.ctx,reviewId)).toBeNull();
  });
  it('allows a reviewer to decline and a manager to replace an unsubmitted panel member',async()=>{
    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));
    const request=(await perf.onehrAssignments(peers[0].ctx)).feedback[0];await perf.declineOnehrFeedback(peers[0].ctx,request.id);
    expect((await perf.onehrAssignments(peers[0].ctx)).feedback).toEqual([]);await expect(perf.getOnehrFeedback(peers[0].ctx,request.id)).rejects.toThrow(/removed/);
    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,[{employmentId:manager.employmentId,relationship:'line_manager'},...peers.slice(1).map(p=>({employmentId:p.employmentId,relationship:'peer'}))]);
    expect((await perf.onehrAssignments(mgr)).feedback.some(r=>r.subject==='Assessment subject')).toBe(true);
  });
  it('keeps a standing reviewer verdict with an audit trail and protects shared evidence words',async()=>{
    const id=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Delivered the release.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]});
    await expect(perf.respondOnehrEvidence(self,id,'endorse','Own endorsement')).rejects.toThrow(/another author/);
    await perf.respondOnehrEvidence(mgr,id,'endorse','Verified delivery');await perf.respondOnehrEvidence(mgr,id,'dispute','A correction is needed');
    expect((await view(self)).evidence[0].responses.map(r=>r.stance)).toEqual(['dispute']);
    await expect(withTenant(self,tx=>tx.update(schema.onehrEvidence).set({responses:[]}).where(eq(schema.onehrEvidence.id,id)))) .rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/standing evidence response/)})});
    await complete();await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    const [f]=await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId));expect((f.result as {provenance:{evidence:unknown[]}}).provenance.evidence).toHaveLength(0);
    const [panel]=await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.reviewId,reviewId));
    await expect(withTenant(a,tx=>tx.update(schema.onehrPanel).set({remark:'Restate frozen evidence'}).where(eq(schema.onehrPanel.requestId,panel.requestId)))) .rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/immutable/)})});
  });

  it('caches file contents under native attachment visibility and never reads images from an ordinary cached chat query',async()=>{
    const evidenceId=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Prepared the delivery record.',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]});
    const file=await perf.addPerformanceAttachment(self,{reviewId,evidenceId,stageKind:null,fileName:'delivery.txt',mimeType:'text/plain',content:Buffer.from('Verified delivery 15.9 million units.')});
    expect((await perf.getAssessmentFileTexts(self,reviewId)).size).toBe(0);
    expect((await perf.readAssessmentFileTexts(self,reviewId)).get(file.id)).toMatchObject({status:'ok',text:'Verified delivery 15.9 million units.',method:'local'});
    expect((await perf.getAssessmentFileTexts(self,reviewId)).get(file.id)?.status).toBe('ok');
    expect((await perf.getAssessmentFileTexts(mgr,reviewId)).size).toBe(0);expect(await withTenant(mgr,tx=>tx.select().from(schema.assessmentFileText))).toEqual([]);
    const other=await seedBase();expect(await withTenant(adminCtx(other),tx=>tx.select().from(schema.assessmentFileText))).toEqual([]);
    await perf.changeOnehrEvidenceState(self,evidenceId,'shared');expect((await perf.getAssessmentFileTexts(mgr,reviewId)).get(file.id)?.text).toContain('15.9');
    await perf.changeOnehrEvidenceState(self,evidenceId,'retracted');expect((await perf.getAssessmentFileTexts(mgr,reviewId)).size).toBe(0);expect((await perf.getAssessmentFileTexts(self,reviewId)).size).toBe(0);expect(await perf.getPerformanceAttachment(mgr,file.id)).not.toBeNull();
    const imageEvidence=await perf.addOnehrEvidence(self,reviewId,{kind:'recognition',body:'Prepared image proof.',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]});
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8R0AAAAASUVORK5CYII=','base64'),image=await perf.addPerformanceAttachment(self,{reviewId,evidenceId:imageEvidence,stageKind:null,fileName:'proof.png',mimeType:'image/png',content:png});
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    expect((await perf.readAssessmentFileTexts(self,reviewId)).get(image.id)?.status).toBe('unread');expect(readImage).not.toHaveBeenCalled();
    expect((await perf.readAssessmentFileTexts(self,reviewId,{allowImages:true})).get(image.id)).toMatchObject({status:'ok',method:'vision',text:'Verified 15.9 units.'});expect(readImage).toHaveBeenCalledOnce();
    const [transcription]=await owner.db.select().from(schema.agentProposal).where(eq(schema.agentProposal.proposalType,'performance_file_transcription'));expect(transcription.proposal).toMatchObject({status:'ok'});expect(JSON.stringify(transcription)).not.toMatch(/Verified 15.9|iVBORw0|fixture-local-only/);
    await perf.readAssessmentFileTexts(self,reviewId,{allowImages:true});expect(readImage).toHaveBeenCalledOnce();
    expect(await owner.db.select().from(schema.assessmentFileText)).toHaveLength(2);
    await expect(withTenant(self,tx=>tx.update(schema.assessmentFileText).set({contentHash:'0'.repeat(64)}).where(eq(schema.assessmentFileText.attachmentId,file.id)))).rejects.toMatchObject({cause:expect.objectContaining({code:'P0001'})});
  });

  it('bounds image reads to four concurrent and eight per summary, and rechecks retraction after provider work',async()=>{
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8R0AAAAASUVORK5CYII=','base64'),files:string[]=[];
    for(let entry=0;entry<3;entry++){
      const evidenceId=await perf.addOnehrEvidence(self,reviewId,{kind:'recognition',body:'Prepared visible image proof.',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]});
      for(let file=0;file<4;file++)files.push((await perf.addPerformanceAttachment(self,{reviewId,evidenceId,stageKind:null,fileName:`proof-${entry}-${file}.png`,mimeType:'image/png',content:png})).id);
    }
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    // Per-image fresh source checks run in serialized database phases before each provider call, so a fixed
    // 10ms provider sleep no longer overlaps them. Hold the first provider read (bounded) until a second worker
    // genuinely enters: a serial implementation never reaches max>1 and still fails below.
    let active=0,max=0;vi.mocked(readImage).mockImplementation(async()=>{active++;max=Math.max(max,active);for(let n=0;n<300&&max<2;n++)await new Promise(resolve=>setTimeout(resolve,10));await new Promise(resolve=>setTimeout(resolve,10));active--;return 'Verified 15.9 units.';});
    const texts=await perf.readAssessmentFileTexts(self,reviewId,{allowImages:true});expect(max).toBeLessThanOrEqual(4);expect(max).toBeGreaterThan(1);expect(readImage).toHaveBeenCalledTimes(8);expect([...texts.values()].filter(t=>t.status==='ok')).toHaveLength(8);expect([...texts.values()].filter(t=>t.status==='unread')).toHaveLength(4);
    const visibleEvidence=await perf.addOnehrEvidence(self,reviewId,{kind:'recognition',body:'Shared image proof.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]}),file=await perf.addPerformanceAttachment(self,{reviewId,evidenceId:visibleEvidence,stageKind:null,fileName:'shared.png',mimeType:'image/png',content:png});
    vi.mocked(readImage).mockImplementation(async()=>{await perf.changeOnehrEvidenceState(self,visibleEvidence,'retracted');return 'Retracted confidential file words.';});
    expect((await perf.readAssessmentFileTexts(mgr,reviewId,{allowImages:true})).has(file.id)).toBe(false);expect(await owner.db.select().from(schema.assessmentFileText).where(eq(schema.assessmentFileText.attachmentId,file.id))).toEqual([]);
  });

  it('excludes superseded file claims from current AI context while retaining proof captured at confirmation',async()=>{
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Verified delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,50,100,150,200]},moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'');
    const file=await perf.addPerformanceAttachment(self,{reviewId,kpiId:id,stageKind:null,fileName:'proof.txt',mimeType:'text/plain',content:Buffer.from('Verified 100 delivered units.')}),entry=(await view(self)).evidence.find(e=>e.files.some(f=>f.id===file.id))!;
    await perf.readAssessmentFileTexts(mgr,reviewId);expect((await perf.getAssessmentFileTexts(mgr,reviewId)).has(file.id)).toBe(true);
    const correction=await perf.addOnehrEvidence(self,reviewId,{kind:'recognition',body:'Corrected delivery context.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:entry.id,links:[]});
    expect((await perf.getAssessmentFileTexts(mgr,reviewId)).has(file.id)).toBe(false);expect(await perf.getPerformanceAttachment(mgr,file.id)).not.toBeNull();
    await perf.changeOnehrEvidenceState(self,correction,'retracted');
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:100,note:'Delivery completed.'}],'Completed the agreed delivery.');await perf.changeOnehrEvidenceState(self,entry.id,'retracted');
    expect((await perf.getAssessmentFileTexts(mgr,reviewId)).get(file.id)?.text).toContain('100 delivered units');
  });

  it('grounds draft passages in authorized file contents and drops a selection if its file is retracted during generation',async()=>{
    const evidenceId=await perf.addOnehrEvidence(self,reviewId,{kind:'recognition',body:'Delivery record.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]});
    await perf.addPerformanceAttachment(self,{reviewId,evidenceId,stageKind:null,fileName:'claim-9999.txt',mimeType:'text/plain',content:Buffer.from('Verified delivery 15.9 million units. Contact proof@example.test.')});
    const privateId=await perf.addOnehrEvidence(self,reviewId,{kind:'recognition',body:'Private record.',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]});await perf.addPerformanceAttachment(self,{reviewId,evidenceId:privateId,stageKind:null,fileName:'private.txt',mimeType:'text/plain',content:Buffer.from('Private 777777 units.')});
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    vi.mocked(generateDraft).mockImplementationOnce(async(_cfg,args)=>{const facts=JSON.parse(args.prompt).passages as {index:number;kind:string;lengthBand:string}[];expect(args.prompt).not.toContain('Private 777777');expect(args.prompt).not.toContain('claim-9999');expect(args.prompt).not.toContain('proof@example.test');expect(facts.length).toBeGreaterThanOrEqual(3);expect(args.prompt).not.toContain('15.9 million');const file=facts.at(-2)!;return JSON.stringify({items:[file.index]});});
    expect(await perf.draftOnehrNarrative(mgr,reviewId,'Prepare a draft.')).toBe('Verified delivery 15.9 million units.');expect(readImage).not.toHaveBeenCalled();
    vi.mocked(generateDraft).mockImplementationOnce(async(_cfg,args)=>{const facts=JSON.parse(args.prompt).passages as {index:number;kind:string;lengthBand:string}[],file=facts.at(-2)!;await perf.changeOnehrEvidenceState(self,evidenceId,'retracted');return JSON.stringify({items:[file.index]});});
    expect(await perf.draftOnehrNarrative(mgr,reviewId,'Prepare a draft.')).toBe('');
  });

  it('keeps draft evidence files private, serializes the four-file cap, and removes only author-owned proof',async()=>{
    const evidenceId=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Prepared the delivery record.',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]});
    const upload=(name:string,ctx:SessionContext=self)=>perf.addPerformanceAttachment(ctx,{reviewId,evidenceId,stageKind:null,fileName:name,mimeType:'text/plain',content:Buffer.from('Supporting proof')});
    const first=await upload('first.txt');await upload('second.txt');await upload('third.txt');
    const concurrent=await Promise.allSettled([upload('fourth.txt'),upload('fifth.txt')]);expect(concurrent.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await view(self)).evidence.find(e=>e.id===evidenceId)?.files).toHaveLength(4);
    expect((await perf.getPerformanceAttachment(self,first.id))?.content.toString()).toBe('Supporting proof');
    for(const ctx of [mgr,a,peers[0].ctx])expect(await perf.getPerformanceAttachment(ctx,first.id)).toBeNull();
    await expect(upload('manager.txt',mgr)).rejects.toThrow();
    await expect(upload('unsupported.svg')).rejects.toThrow(/PDF/);
    await expect(perf.removeAssessmentEvidenceFile(mgr,reviewId,first.id)).rejects.toThrow();
    await perf.removeAssessmentEvidenceFile(self,reviewId,first.id);expect(await perf.getPerformanceAttachment(self,first.id)).toBeNull();
    const replacement=await upload('replacement.txt');
    await expect(withTenant(self,tx=>tx.update(schema.performanceAttachment).set({content:Buffer.from('Rewritten file')}).where(eq(schema.performanceAttachment.id,replacement.id)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/immutable/)})});
    await perf.changeOnehrEvidenceState(self,evidenceId,'shared');
    expect(await perf.getPerformanceAttachment(mgr,replacement.id)).not.toBeNull();expect(await perf.getPerformanceAttachment(a,replacement.id)).toBeNull();
  });
  it('attaches direct KPI proof through a shared file-only entry and locks removal at result confirmation',async()=>{
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Verified delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,50,100,150,200]},moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'');
    const submit=async()=>perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:150,note:'Delivered above the agreed target.'}],'Verified delivery.');
    await expect(submit()).rejects.toThrow(/supporting file/);
    const upload=()=>perf.addPerformanceAttachment(self,{reviewId,kpiId:id,stageKind:null,fileName:'proof.txt',mimeType:'text/plain',content:Buffer.from('Verified outcomes')});
    const first=await upload();let own=await view(self);const entry=own.evidence.find(e=>e.files.some(f=>f.id===first.id))!;
    expect(entry).toMatchObject({kind:'recognition',body:'',state:'shared',details:{fileOnly:true}});expect(own.attachmentLinks).toEqual([expect.objectContaining({attachmentId:first.id,kpiId:id})]);
    expect(await perf.getPerformanceAttachment(a,first.id)).not.toBeNull();expect(await perf.getPerformanceAttachment(peers[0].ctx,first.id)).toBeNull();
    await perf.removeAssessmentEvidenceFile(self,reviewId,first.id);expect((await view(self)).attachmentLinks).toEqual([]);await expect(submit()).rejects.toThrow(/supporting file/);
    const kept=await upload();await submit();own=await view(self);expect(own.evidence.find(e=>e.id===entry.id)?.files[0].canRemove).toBe(false);
    await expect(perf.removeAssessmentEvidenceFile(self,reviewId,kept.id)).rejects.toThrow();expect(await perf.getPerformanceAttachment(mgr,kept.id)).not.toBeNull();
    await perf.addPerformanceAttachment(self,{reviewId,evidenceId:entry.id,stageKind:null,fileName:'additional.txt',mimeType:'text/plain',content:Buffer.from('Additional proof, words unchanged')});
    expect((await view(self)).evidence.find(e=>e.id===entry.id)?.files).toHaveLength(2);
    await perf.linkAssessmentEvidence(self,reviewId,entry.id,(await view(self)).evidence.find(e=>e.id===entry.id)!.revision,{kind:'kpi',id},false);
    expect((await view(self)).attachmentLinks).toEqual([expect.objectContaining({attachmentId:kept.id,kpiId:id})]);
    expect(await perf.getPerformanceAttachment(a,kept.id)).not.toBeNull();
    await expect(perf.removeAssessmentEvidenceFile(self,reviewId,kept.id)).rejects.toThrow();
    await expect(withTenant(self,tx=>tx.update(schema.onehrReview).set({submittedProof:[]}).where(eq(schema.onehrReview.reviewId,reviewId)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/proof is immutable/)})});
    await expect(upload()).rejects.toThrow(/locked/);
  });
  it('retains the native ten-MB file contract for classic reviews',async()=>{
    const legacy=await perf.createCycle(a,{name:'Classic review',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`,assessmentWorkflow:false});await perf.openCycle(a,{cycleId:legacy.cycleId});
    const [review]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,legacy.cycleId),eq(schema.performanceReview.employmentId,subject.employmentId)));
    const file=await perf.addPerformanceAttachment(self,{reviewId:review.id,stageKind:null,fileName:'native-attachment.bin',mimeType:'application/octet-stream',content:Buffer.alloc(3*1024*1024,1)});
    expect((await perf.getPerformanceAttachment(a,file.id))?.content.length).toBe(3*1024*1024);
  });
  it('edits evidence drafts without clearing absent slots and updates links and citations without rewriting shared words',async()=>{
    const id=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Delivered the programme.',occurredOn:todayInKualaLumpur(),title:'Programme',impact:'Reduced manual steps',who:'Operations',precision:'month',metricValue:25,metricUnit:'hours',state:'draft',supersedesId:null,links:[]});
    let entry=(await view(self)).evidence.find(e=>e.id===id)!;
    await perf.editAssessmentEvidence(self,id,entry.revision,{body:'Delivered the improved programme.'});
    entry=(await view(self)).evidence.find(e=>e.id===id)!;expect(entry).toMatchObject({body:'Delivered the improved programme.',details:{title:'Programme',impact:'Reduced manual steps',precision:'month',metricValue:25,metricUnit:'hours'}});
    await expect(perf.editAssessmentEvidence(mgr,id,entry.revision,{body:'Manager rewrite'})).rejects.toThrow();
    await expect(perf.editAssessmentEvidence(self,id,entry.revision-1,{body:'Stale edit'})).rejects.toThrow(/changed/);
    await perf.changeOnehrEvidenceState(self,id,'shared');entry=(await view(self)).evidence.find(e=>e.id===id)!;
    await expect(perf.editAssessmentEvidence(self,id,entry.revision,{body:'Rewrite shared words'})).rejects.toThrow(/Shared evidence/);
    expect((await view(a)).evidence.some(e=>e.id===id)).toBe(false); // HR is not an audience for unlinked personal evidence.
    await complete();const kpi=(await view(self)).kpis[0];
    await perf.linkAssessmentEvidence(self,reviewId,id,entry.revision,{kind:'kpi',id:kpi.id});entry=(await view(self)).evidence.find(e=>e.id===id)!;
    expect((await view(a)).evidence.some(e=>e.id===id)).toBe(true);
    await perf.citeAssessmentEvidence(mgr,reviewId,id,entry.revision,'supports','moderation');entry=(await view(self)).evidence.find(e=>e.id===id)!;
    await perf.citeAssessmentEvidence(mgr,reviewId,id,entry.revision,'qualifies','moderation');entry=(await view(self)).evidence.find(e=>e.id===id)!;
    expect(entry.citations).toHaveLength(1);expect(entry.citations[0]).toMatchObject({stance:'qualifies',decisionKind:'moderation',userId:mgr.userId});
    await perf.linkAssessmentEvidence(self,reviewId,id,entry.revision,{kind:'kpi',id:kpi.id},false);
    expect((await view(self)).evidence.find(e=>e.id===id)?.body).toBe('Delivered the improved programme.');
    expect((await view(a)).evidence.some(e=>e.id===id)).toBe(false);
    const managerId=await perf.addOnehrEvidence(mgr,reviewId,{kind:'learning',body:'Observed the employee coaching a colleague.',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]});
    expect((await view(self)).evidence.find(e=>e.id===managerId)?.state).toBe('shared');
    await expect(perf.addOnehrEvidence(self,reviewId,{kind:'learning',body:'Rewrite a manager observation.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:managerId,links:[]})).rejects.toThrow(/own shared evidence/);
  });
  it('routes native feedback tasks and released-result updates without disclosing assessment content',async()=>{
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);
    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));
    await dispatchNotifications(a);
    let notices=await owner.db.select().from(schema.notification);expect(notices.filter(n=>n.kind==='performance.feedback-request')).toHaveLength(4);
    expect(new Set(notices.filter(n=>n.kind==='performance.feedback-request').map(n=>n.recipientEmploymentId))).toEqual(new Set(peers.map(p=>p.employmentId)));
    await complete();await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);await perf.releaseOnehrResult(a,reviewId,'performance',true);await dispatchNotifications(a);
    notices=await owner.db.select().from(schema.notification);
    // WP-E (source rule: one notice per leader with a count, one per person naming what is ready, never a band,
    // nothing on revoke). The subject's two update notices are the earlier scorecard approval (complete()) and ONE
    // release notice for this release action; the per-person panel releases both steps at once, so the line
    // manager it reached gets ONE count-only notice. Each notice is identified by its source event.
    const sourceOf=new Map((await owner.db.select({id:schema.domainEvent.id,type:schema.domainEvent.eventType}).from(schema.domainEvent)).map(e=>[e.id,e.type]));
    const updates=notices.filter(n=>n.kind==='performance.update').map(n=>({recipient:n.recipientEmploymentId,source:sourceOf.get(n.sourceEventId??''),title:n.title,body:n.body,linkPath:n.linkPath}));
    expect(updates.filter(u=>u.recipient===subject.employmentId).map(u=>u.source).sort()).toEqual(['onehr.results-to-person','onehr.scorecard-approved']);
    expect(updates.filter(u=>u.source==='onehr.results-to-person')).toEqual([{recipient:subject.employmentId,source:'onehr.results-to-person',title:'Your results are released',body:'HR has released your performance band to you. Open your performance record to see them.',linkPath:'/me/performance'}]);
    expect(updates.filter(u=>u.recipient===manager.employmentId)).toEqual([{recipient:manager.employmentId,source:'onehr.results-to-leader',title:'Results released to you',body:'HR has released the results of 1 person you lead to you. They can see their own results as well. Open What you led to see them.',linkPath:'/performance/led'}]);
    expect(updates.filter(u=>u.source==='onehr.results-to-leader'||u.source==='onehr.results-to-person')).toHaveLength(2);
    expect(notices.map(n=>`${n.title} ${n.body}`).join(' ')).not.toMatch(/Assessment subject|ME|High|Star|5000/);
    // A revoke announces nothing.
    await perf.releaseOnehrResult(a,reviewId,'performance',false);await dispatchNotifications(a);
    expect(await owner.db.select().from(schema.notification)).toHaveLength(notices.length);
  });
  it('rejects AI access before contacting a provider or recording a proposal',async()=>{
    await expect(perf.draftOnehrNarrative(peers[0].ctx,reviewId,'Invent a pay award')).rejects.toThrow(/Only the employee/);
    expect(await owner.db.select().from(schema.agentProposal)).toEqual([]);
  });

  it('retains unfinished KPI numbers and refuses both service and direct SQL proposals until complete',async()=>{
    const [missingMultiple]=await owner.db.execute<{score:string}>(sql`select app.assessment_kpi_score(150,${JSON.stringify({mechanism:'B',method:'more',variant:'base',threshold:0,target:100,multiple:null,excellence:null})}::jsonb)::text as score`);expect(Number(missingMultiple.score)).toBe(100);
    const id=randomUUID(),initial=(await view(self)).revision,input={id,title:'Draft quality',description:'',weightBp:0,unit:'units',scoring:{mechanism:'A',method:'more',target:null,rates:[null,50,null,150,null]},moderatorEmploymentId:manager.employmentId};
    expect(await perf.saveOnehrKpis(self,reviewId,initial,[input])).toBe(initial+1);
    let current=await view(self);expect(current.kpis[0]).toMatchObject({weightBp:0,setting:'draft',scoring:{rates:[null,50,null,150,null]}});
    await expect(perf.saveOnehrKpis(self,reviewId,current.revision,[{...input,weightBp:10000}],true)).rejects.toThrow(/target numbers/);
    await expect(withTenant(self,tx=>tx.update(schema.onehrReview).set({kpis:[{...current.kpis[0],weightBp:10000,setting:'proposed'}]}).where(eq(schema.onehrReview.reviewId,reviewId)))).rejects.toMatchObject({cause:expect.objectContaining({code:'P0001',message:expect.stringMatching(/target numbers/)})});
    expect((await view(self)).kpis[0].scoring).toEqual(current.kpis[0].scoring);
    await expect(perf.saveOnehrKpis(self,reviewId,current.revision,[input,{...input,id:randomUUID()}])).rejects.toThrow(/title can appear only once/);
    await expect(perf.saveOnehrKpis(self,reviewId,initial,[input])).rejects.toThrow(/changed/);
    await perf.saveOnehrKpis(self,reviewId,current.revision,[{...input,weightBp:10000,scoring:{...input.scoring,rates:[0,50,100,150,200]}}],true);
    expect((await view(self)).kpis[0].setting).toBe('proposed');
    await perf.approveOnehrScorecard(mgr,reviewId,(await view(mgr)).revision,true,'Ready targets');expect((await view(self)).kpis[0].setting).toBe('approved');
  });

  it('imports partial library rows and defaults a matching KPI from the employee’s preceding target ladder',async()=>{
    const {cycleId:old}=await perf.createCycle(a,{name:'Earlier target basis',companyId:b.companyId,periodStart:`${year-1}-01-01`,periodEnd:`${year-1}-12-31`});
    const policy=defaultPolicy(framework);policy.modules={pm:true,tm:false,idp:false,evidence:false};await perf.configureOnehrCycle(a,old,null,policy);await perf.openCycle(a,{cycleId:old});
    const [prior]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,old),eq(schema.performanceReview.employmentId,subject.employmentId))),oldView=await perf.getOnehrReview(self,prior.id);
    const id=randomUUID();await perf.saveOnehrKpis(self,prior.id,oldView!.revision,[{id,title:'Historic service quality',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',target:40,rates:[10,20,30,40,50]},moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,prior.id,(await perf.getOnehrReview(mgr,prior.id))!.revision,true,'Agreed targets');
    await perf.submitOnehrResults(self,prior.id,(await perf.getOnehrReview(self,prior.id))!.revision,[{id,actual:999,note:'Actual is not the next target basis'}],'Delivered the observed service outcomes.');
    const [co]=await owner.db.select().from(schema.company).where(eq(schema.company.id,b.companyId));
    const definitions=[{'Company':co.legalName,'KPI':'Historic service quality','Method':'more','Target':'200','Weightage Default':'100','Rate 1':'160','Rate 2':'180','Rate 3':'200','Rate 4':'220','Rate 5':'240','Spread Rate 1':'80','Spread Rate 2':'90','Spread Rate 3':'100','Spread Rate 4':'110','Spread Rate 5':'120'},{'Company':co.legalName,'KPI':'Unfinished library target','Method':'more'}];
    const csv=toCsv([kpiLibraryImportHeaders,...definitions.map(r=>kpiLibraryImportHeaders.map(h=>(r as Record<string,string>)[h]??''))]),preview=await perf.importAssessmentKpis(a,cycleId,csv,'library');
    expect(await owner.db.select().from(schema.performanceKpiLibrary)).toEqual([]);await perf.importAssessmentKpis(a,cycleId,csv,'library',preview.token);
    let own=await view(self);const choice=own.kpiLibrary.find(k=>k.title==='Historic service quality')!,unfinished=own.kpiLibrary.find(k=>k.title==='Unfinished library target')!;
    expect(choice).toMatchObject({numberSource:'history',defaultScoring:{target:40,rates:[10,20,30,40,50]}});expect(unfinished.defaultScoring).toMatchObject({rates:[null,null,null,null,null]});
    await perf.saveOnehrKpis(self,reviewId,own.revision,[{id:randomUUID(),libraryId:choice.id,title:choice.title,description:choice.description,weightBp:10000,unit:choice.unit,scoring:choice.defaultScoring,moderatorEmploymentId:manager.employmentId}]);
    own=await view(self);expect(own.kpis[0]).toMatchObject({numberSource:'history',scoring:{target:40,rates:[10,20,30,40,50]}});expect(own.kpis[0].actual).toBeNull();
    await expect(perf.importAssessmentKpis(a,cycleId,csv,'library',preview.token)).rejects.toThrow(/changed/);
  });

  it('creates eligible AI starter drafts with atomic daily quotas and leaves human proposal untouched',async()=>{
    const [library]=await owner.db.insert(schema.performanceKpiLibrary).values({tenantId:b.tenantId,companyId:b.companyId,name:'Starter delivery',template:{title:'Starter delivery',description:'Governed wording',category:'Delivery',unit:'units',weightBp:10000,scoring:{mechanism:'A',method:'more',target:100,rates:[80,90,100,110,120]},spread:{rate:[80,90,100,110,120]}}}).returning();
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    vi.mocked(generateDraft).mockResolvedValue('{"items":[0]}');
    const request=randomUUID(),first=await perf.sendReviewMessage(self,reviewId,'setting',null,request,'Suggest a starter scorecard','starter');
    expect(first).toMatchObject({draftUpdated:true,settingQuota:{remaining:4,limit:5}});
    let own=await view(self);expect(own.kpis).toHaveLength(1);expect(own.kpis[0]).toMatchObject({title:'Starter delivery',description:'Governed wording',weightBp:10000,numberSource:'spread',scoring:{target:100,rates:[80,90,100,110,120]},setting:'draft',actual:null,locked:false});
    expect(await perf.sendReviewMessage(self,reviewId,'setting',null,request,'Suggest a starter scorecard','starter')).toEqual(first);expect(generateDraft).toHaveBeenCalledOnce();const outbound=vi.mocked(generateDraft).mock.calls[0][1].prompt;for(const secret of [library.id,'Starter delivery','Governed wording','250'])expect(outbound).not.toContain(secret);
    await expect(perf.sendReviewMessage(self,reviewId,'setting',0,randomUUID(),'Suggest a starter scorecard','starter')).rejects.toThrow(/conversation changed/);
    expect(await owner.db.select().from(schema.assessmentAiUse)).toHaveLength(1);expect((await view(self)).revision).toBe(own.revision);
    expect(await withTenant(mgr,tx=>tx.select().from(schema.assessmentAiUse))).toEqual([]);
    const otherTenant=await seedBase();expect(await withTenant(adminCtx(otherTenant),tx=>tx.select().from(schema.assessmentAiUse))).toEqual([]);
    await expect(perf.sendReviewMessage(mgr,reviewId,'setting',null,randomUUID(),'Suggest a starter scorecard','starter')).rejects.toThrow(/unavailable/);
    vi.mocked(generateDraft).mockRejectedValue(new Error('Provider unavailable'));
    await expect(perf.sendReviewMessage(self,reviewId,'setting',first.revision,randomUUID(),'Suggest a starter scorecard','starter')).rejects.toThrow(/usable scorecard/);expect(await owner.db.select().from(schema.assessmentAiUse)).toHaveLength(1);
    vi.mocked(generateDraft).mockResolvedValue('{"items":[0]}');
    let conversation=first;for(let i=0;i<3;i++)conversation=await perf.sendReviewMessage(self,reviewId,'setting',conversation.revision,randomUUID(),'Suggest a starter scorecard','starter');
    // Two concurrent final-slot requests cannot both consume the last daily use.
    const results=await Promise.allSettled([0,1].map(()=>perf.sendReviewMessage(self,reviewId,'setting',conversation.revision,randomUUID(),'Suggest a starter scorecard','starter')));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await owner.db.select().from(schema.assessmentAiUse)).toHaveLength(5);
    conversation=await perf.getReviewConversation(self,reviewId,'setting') as typeof conversation;
    expect(conversation).toMatchObject({settingQuota:{remaining:0,limit:5}});
    const calls=vi.mocked(generateDraft).mock.calls.length;await expect(perf.sendReviewMessage(self,reviewId,'setting',conversation.revision,randomUUID(),'Suggest a starter scorecard','starter')).rejects.toThrow(/midnight Malaysia/);expect(generateDraft).toHaveBeenCalledTimes(calls);
    own=await view(self);await perf.saveOnehrKpis(self,reviewId,own.revision,own.kpis,true);expect((await view(self)).kpis[0].setting).toBe('proposed');
    await expect(perf.sendReviewMessage(self,reviewId,'setting',conversation.revision,randomUUID(),'Suggest a starter scorecard','starter')).rejects.toThrow(/unavailable/);
  });

  it('refuses an invented protected starter reference without charging quota or writing a scorecard',async()=>{
    await owner.db.insert(schema.performanceKpiLibrary).values({tenantId:b.tenantId,companyId:b.companyId,name:'Only eligible starter',template:{title:'Only eligible starter',description:'Native governed definition',category:'Delivery',unit:'units',weightBp:10000,scoring:{mechanism:'A',method:'more',target:100,rates:[80,90,100,110,120]},spread:{rate:[80,90,100,110,120]}}});
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);vi.mocked(generateDraft).mockResolvedValue('{"items":[999]}');
    await expect(perf.sendReviewMessage(self,reviewId,'setting',null,randomUUID(),'Suggest a starter scorecard','starter')).rejects.toThrow(/usable scorecard/);
    expect(generateDraft).toHaveBeenCalledOnce();expect((await view(self)).kpis).toEqual([]);expect(await owner.db.select().from(schema.assessmentAiUse)).toEqual([]);expect((await owner.db.select().from(schema.agentProposal)).some(row=>row.adjudication==='rejected')).toBe(true);
  });

  it('edits KPI setup from chat through the form writer and rolls back when conversation revision is stale',async()=>{
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,50,100,150,200]},moderatorEmploymentId:manager.employmentId}]);
    await prepareMockedSpend('performance_assistant');vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    const text='Set Delivery weight to 35',request=randomUUID();vi.mocked(generateDraft).mockResolvedValue('{"items":[0]}');
    const first=await perf.sendReviewMessage(self,reviewId,'setting',null,request,text);
    expect(first.draftUpdated).toBe(true);expect((await view(self)).kpis[0]).toMatchObject({weightBp:3500,setting:'draft',actual:null,locked:false});
    expect(await perf.sendReviewMessage(self,reviewId,'setting',null,request,text)).toEqual(first);expect(generateDraft).toHaveBeenCalledOnce();
    await expect(perf.sendReviewMessage(self,reviewId,'setting',0,randomUUID(),'Set Delivery weight to 60')).rejects.toThrow(/conversation changed/);
    expect((await view(self)).kpis[0].weightBp).toBe(3500);
    await expect(perf.sendReviewMessage(mgr,reviewId,'setting',null,randomUUID(),text)).resolves.toMatchObject({draftUpdated:false});
    expect((await view(self)).kpis[0].weightBp).toBe(3500);
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{...(await view(self)).kpis[0],weightBp:10000}],true);
    const calls=vi.mocked(generateDraft).mock.calls.length;
    expect(await perf.sendReviewMessage(self,reviewId,'setting',first.revision,randomUUID(),text)).toMatchObject({draftUpdated:false});expect(generateDraft).toHaveBeenCalledTimes(calls);
    expect((await view(self)).kpis[0].setting).toBe('proposed');
  });

  it('saves career words and draft goals atomically, preserves the shared plan snapshot and degrades on provider failure',async()=>{
    await prepareMockedSpend('performance_assistant');vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    const span=(text:string,value:string)=>({start:text.indexOf(value),end:text.indexOf(value)+value.length});
    const text='Aspiration: Lead operations. Goal: Facilitation. On the job: Run a workshop.';
    vi.mocked(generateDraft).mockResolvedValue('{"items":[0,1]}');
    const request=randomUUID(),first=await perf.sendReviewMessage(self,reviewId,'career',null,request,text);
    expect(first.draftUpdated).toBe(true);let own=await view(self),plan=own.plans[0];
    expect(own.careerProfile?.career.aspirationNow).toBe('Lead operations.');expect(plan).toMatchObject({status:'draft',goals:[{area:'Facilitation',onJob:'Run a workshop.',dueOn:''}]});
    expect((await view(mgr)).plans).toEqual([]);expect((await perf.getReviewConversation(mgr,reviewId,'career')).messages).toEqual([]);
    expect(await perf.sendReviewMessage(self,reviewId,'career',null,request,text)).toEqual(first);expect(generateDraft).toHaveBeenCalledOnce();
    await expect(perf.sendReviewMessage(self,reviewId,'career',0,randomUUID(),text)).rejects.toThrow(/conversation changed/);
    expect((await view(self)).plans[0].revision).toBe(plan.revision);
    const career={...own.careerProfile!.career,mobility:'role_in_unit'};
    await perf.saveOnehrPlan(self,reviewId,plan.revision,{career,careerRevision:own.careerProfile!.revision,goals:plan.goals},true);
    own=await view(self);plan=own.plans[0];const changed='Strengths: Patient facilitation.';
    vi.mocked(generateDraft).mockResolvedValue(JSON.stringify({commands:[{action:'career_field',field:'strengths',value:span(changed,'Patient facilitation.')}]}));
    const updated=await perf.sendReviewMessage(self,reviewId,'career',first.revision,randomUUID(),changed);expect(updated.draftUpdated).toBe(false);
    own=await view(self);expect(own.careerProfile?.career.strengths??'').toBe('');expect(own.plans[0].career).toEqual(plan.career);expect(own.plans[0].status).toBe('shared');
    vi.mocked(generateDraft).mockResolvedValue(JSON.stringify({commands:[{action:'remove_goal',id:plan.goals[0].id,target:span('Remove Facilitation','Facilitation')}]}));
    const refused=await perf.sendReviewMessage(self,reviewId,'career',updated.revision,randomUUID(),'Remove Facilitation');expect(refused.draftUpdated).toBe(false);expect((await view(self)).plans[0].goals).toEqual(plan.goals);
    vi.mocked(generateDraft).mockRejectedValue(new Error('Provider unavailable'));
    const fallback=await perf.sendReviewMessage(self,reviewId,'career',refused.revision,randomUUID(),'Help with my plan');expect(fallback.draftUpdated).toBe(false);expect(fallback.messages.find(m=>m.role==='assistant'&&m.kind==='guide')?.kind).toBe('guide');
    expect((await view(self)).careerProfile?.career.strengths??'').toBe('');
  });

  it('logs explicit evidence through chat exactly once and rolls back on a stale conversation',async()=>{
    await prepareMockedSpend('performance_assistant');vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    const text='Log evidence: I resolved the deployment issue with the team.',body='I resolved the deployment issue with the team.';
    vi.mocked(generateDraft).mockResolvedValue('{"items":[0]}');
    const request=randomUUID(),first=await perf.sendReviewMessage(self,reviewId,'evidence',null,request,text);
    expect(first.draftUpdated).toBe(true);expect((await view(self)).evidence).toMatchObject([{body,state:'shared',kind:'recognition'}]);
    expect((await view(mgr)).evidence).toMatchObject([{body}]);
    expect(await perf.sendReviewMessage(self,reviewId,'evidence',null,request,text)).toEqual(first);expect((await view(self)).evidence).toHaveLength(1);
    await expect(perf.sendReviewMessage(self,reviewId,'evidence',0,randomUUID(),text)).rejects.toThrow(/conversation changed/);expect((await view(self)).evidence).toHaveLength(1);
    expect((await perf.sendReviewMessage(mgr,reviewId,'evidence',null,randomUUID(),text)).draftUpdated).toBe(false);expect((await view(self)).evidence).toHaveLength(1);
    vi.mocked(generateDraft).mockRejectedValue(new Error('Provider unavailable'));expect((await perf.sendReviewMessage(self,reviewId,'evidence',first.revision,randomUUID(),'Help me record evidence')).draftUpdated).toBe(false);
  });

  it('keeps colleague feedback conversations private, request-scoped and separate from human submission',async()=>{
    await perf.assignOnehrPanel(a,reviewId,(await view(a)).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})),'administration');
    const request=(await perf.onehrAssignments(peers[0].ctx)).feedback.find(f=>f.subject==='Assessment subject')!,card=await perf.getOnehrFeedback(peers[0].ctx,request.id),statement=card.statements[0],principle=statement.principle;
    const text=`Record ${statement.text} as yes. ${principle} comment: Clear follow-through.`,span=(value:string)=>({start:text.indexOf(value),end:text.indexOf(value)+value.length});
    await prepareMockedSpend('performance_assistant');vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    vi.mocked(generateDraft).mockResolvedValue('{"items":[0,1]}');
    const messageId=randomUUID(),reply=await perf.sendFeedbackMessage(peers[0].ctx,reviewId,request.id,null,messageId,text);
    expect(reply.draftUpdated).toBe(true);let saved=await perf.getOnehrFeedback(peers[0].ctx,request.id);
    expect(saved).toMatchObject({submitted:false,answers:null,draft:{payload:{kind:'feedback',answers:{[statement.id]:'yes'},comments:{[principle]:'Clear follow-through.'}}}});
    expect(await perf.sendFeedbackMessage(peers[0].ctx,reviewId,request.id,null,messageId,text)).toEqual(reply);expect(generateDraft).toHaveBeenCalledOnce();
    await expect(perf.sendFeedbackMessage(peers[0].ctx,reviewId,request.id,0,randomUUID(),text)).rejects.toThrow(/conversation changed/);
    expect((await perf.getOnehrFeedback(peers[0].ctx,request.id)).draft?.revision).toBe(1);
    for(const ctx of [self,mgr,a,peers[1].ctx]){
      await expect(perf.getFeedbackConversation(ctx,reviewId,request.id)).rejects.toThrow();
      expect(await withTenant(ctx,tx=>tx.select().from(schema.assessmentConversation).where(eq(schema.assessmentConversation.contextId,request.id)))).toEqual([]);
    }
    const [another]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,peers[1].employmentId)));
    await perf.assignOnehrPanel(a,another.reviewId,another.revision,[peers[0],peers[2],peers[3],{employmentId:manager.employmentId}].map(p=>({employmentId:p.employmentId,relationship:'peer'})),'administration');
    const other=(await perf.onehrAssignments(peers[0].ctx)).feedback.find(f=>f.subject==='Peer 1')!;
    await expect(perf.sendFeedbackMessage(peers[0].ctx,reviewId,other.id,null,randomUUID(),text)).rejects.toThrow(/another assessment/);
    expect((await perf.getFeedbackConversation(peers[0].ctx,another.reviewId,other.id)).messages).toEqual([]);
    let cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.updateAssessmentModules(a,cycleId,cycle.revision,{...cycle.policy.modules,review:false});
    expect((await perf.getOnehrFeedback(peers[0].ctx,request.id)).guidedReview).toBe(false);
    await expect(perf.getFeedbackConversation(peers[0].ctx,reviewId,request.id)).rejects.toThrow(/disabled/);
    cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.updateAssessmentModules(a,cycleId,cycle.revision,{...cycle.policy.modules,review:true,tm:false});
    expect((await perf.onehrAssignments(peers[0].ctx)).feedback).toEqual([]);await expect(perf.getOnehrFeedback(peers[0].ctx,request.id)).rejects.toThrow(/not found/);
    cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.updateAssessmentModules(a,cycleId,cycle.revision,{...cycle.policy.modules,tm:true});
    saved=await perf.getOnehrFeedback(peers[0].ctx,request.id);expect(saved.draft?.payload).toMatchObject({answers:{[statement.id]:'yes'}});
    expect(await perf.getFeedbackConversation(peers[0].ctx,reviewId,request.id)).toMatchObject({revision:reply.revision,messages:reply.messages});
  });

  it('lets chat update only an actor-private draft, atomically and idempotently',async()=>{
    await perf.setAssessmentAiSwitch({...a,grants:[{role:'hr_admin',companyId:null}]},'pm',false);
    const id=randomUUID();
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,50,100,150,200]},moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'Agreed');
    await prepareMockedSpend('performance_assistant');vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    const text='Record Delivery at 100',request=randomUUID(),proposal='{"items":[0]}';
    vi.mocked(generateDraft).mockResolvedValue(proposal);
    const result=await perf.sendReviewMessage(self,reviewId,'results',null,request,text);
    expect(result).toMatchObject({draftUpdated:true,messages:[{role:'user',text},{role:'assistant',kind:'update'}]});
    const current=await view(self);expect(current.drafts.find(d=>d.kind==='results')?.payload).toMatchObject({lines:[{id,actual:100}]});
    expect((await perf.getAssessmentPersonalRecord(self,reviewId)).current?.kpis.find(k=>k.id===id)).toMatchObject({actual:100,approvedActual:null,band:null});
    expect(current.resultsSubmitted).toBe(false);expect(current.kpis[0].actual).toBeNull();expect(current.managerPerformance).toBeNull();
    expect((await view(mgr)).drafts).toEqual([]);expect(await owner.db.select().from(schema.payrollInput)).toHaveLength(0);
    expect(await perf.sendReviewMessage(self,reviewId,'results',null,request,text)).toEqual(result);expect(generateDraft).toHaveBeenCalledOnce();
    const [ledger]=await owner.db.select().from(schema.agentProposal);expect(ledger.proposalType).toBe('performance_draft_command');expect(JSON.stringify(ledger.proposal)).not.toContain(text);
    vi.mocked(generateDraft).mockResolvedValue(JSON.stringify({commands:[{action:'kpi_result',id,target:{start:7,end:15},actual:{start:19,end:22},approved:true}]}));
    const rejected=await perf.sendReviewMessage(self,reviewId,'results',result.revision,randomUUID(),text);expect(rejected.draftUpdated).toBe(false);expect((await view(self)).drafts.find(d=>d.kind==='results')?.revision).toBe(1);expect((await owner.db.select().from(schema.agentProposal)).some(row=>row.adjudication==='rejected')).toBe(true);
    const conversation=await perf.getReviewConversation(self,reviewId,'results');
    vi.mocked(generateDraft).mockResolvedValue(JSON.stringify({commands:[{action:'overall_remark',text:{start:0,end:5}}]}));
    await expect(perf.sendReviewMessage(self,reviewId,'results',0,randomUUID(),'Ready to review.')).rejects.toThrow(/conversation changed/);
    expect((await view(self)).drafts.find(d=>d.kind==='results')?.revision).toBe(1);expect(await perf.getReviewConversation(self,reviewId,'results')).toEqual(conversation);
    await expect(perf.sendReviewMessage(peers[0].ctx,reviewId,'results',null,randomUUID(),text)).rejects.toThrow();
  });

  it('drafts only from authorized current evidence and records indices without evidence text',async()=>{
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Private evidence must stay private.',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]});
    const old=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Outdated milestone claim.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]});
    await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Corrected milestone evidence.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:old,links:[]});
    const before=await view(mgr);expect(await perf.draftOnehrNarrative(mgr,reviewId,'Verified delivery.')).toBe('Verified delivery.');
    const prompt=vi.mocked(generateDraft).mock.calls[0][1].prompt;expect((await view(mgr)).evidence.some(e=>e.body==='Corrected milestone evidence.'&&e.state==='shared')).toBe(true);expect(prompt).not.toContain('Corrected milestone evidence.');expect(prompt).not.toMatch(/Private evidence|Outdated milestone/);
    expect((await view(mgr)).revision).toBe(before.revision);expect(await owner.db.select().from(schema.payrollInput)).toEqual([]);
    const [proposal]=await owner.db.select().from(schema.agentProposal);expect(proposal).toMatchObject({proposalType:'onehr_narrative',proposal:{items:[0]},adjudication:'accepted',decision:null});expect(JSON.stringify(proposal)).not.toContain('Verified delivery.');
  });
  it('silently discards a draft if evidence is retracted while the provider runs',async()=>{
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    const id=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Evidence about delivery.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]});
    vi.mocked(generateDraft).mockImplementationOnce(async()=>{await perf.changeOnehrEvidenceState(self,id,'retracted');return '{"items":[1]}';});
    expect(await perf.draftOnehrNarrative(mgr,reviewId,'Prepare a draft.')).toBe('');
    const [proposal]=await owner.db.select().from(schema.agentProposal);expect(proposal).toMatchObject({adjudication:'rejected',decision:null});
  });

  it('suggests development goals only from released own feedback and applies kept goals as an unshared draft',async()=>{
    await complete();vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    expect(await perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID())).toMatchObject({empty:true,goals:[],remaining:5});expect(generateDraft).not.toHaveBeenCalled();
    await perf.releaseOnehrResult(a,reviewId,'feedback',true);
    const native=await assessmentDevelopmentContext(self,reviewId),expected=native.gaps.pool[0];expect(expected).toMatchObject({id:'lp:0',kind:'leadership'});
    vi.mocked(generateDraft).mockResolvedValueOnce('{"items":[0,999]}');await expect(perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID())).rejects.toThrow(/No usable goal/);expect(await owner.db.select().from(schema.assessmentAiUse)).toEqual([]);
    vi.mocked(generateDraft).mockResolvedValue('{"items":[0]}');
    const result=await perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID());expect(result).toMatchObject({empty:false,remaining:4,goals:[{area:expected.label,itemIds:['lp:0']}]});expect(result.goals).toHaveLength(1);expect((await view(self)).plans).toEqual([]);
    const prompt=vi.mocked(generateDraft).mock.calls[0][1].prompt;for(const peer of peers)expect(prompt).not.toContain(peer.employmentId);expect(prompt).not.toContain('Peer 0');
    const career={aspiration:'Develop practical facilitation',mobility:'stay',mobilityNote:'',targetProfileId:null},manual={id:randomUUID(),area:'My existing goal',dueOn:'',onJob:'Own practical assignment',fromOthers:'',formalLearning:'',status:'not_started'};
    await perf.setAssessmentAiSwitch({...a,grants:[{role:'hr_admin',companyId:null}]},'idp',false);
    await expect(perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID())).rejects.toThrow(/unavailable/);
    await perf.applyAssessmentDevelopmentGoals(self,reviewId,null,{careerRevision:null,career,goals:[manual]},result.goals,result.sourceDigest);
    const plan=(await view(self)).plans[0];expect(plan.status).toBe('draft');expect(plan.goals.map(g=>g.area)).toEqual(['My existing goal',expected.label]);expect(plan.goals[1]).toMatchObject({dueOn:'',managerComment:'',status:'not_started'});
    expect((await view(mgr)).plans).toEqual([]);expect((await owner.db.select().from(schema.assessmentAiUse))).toHaveLength(1);
    await expect(perf.suggestAssessmentDevelopmentGoals(mgr,reviewId,randomUUID())).rejects.toThrow(/only for your/);
    expect((await withTenant(mgr,tx=>tx.execute<{value:unknown}>(sql`select app.assessment_development_feedback(${reviewId}::uuid) as value`)))[0].value).toBeNull();
  });
  it('limits successful development suggestion runs to five per Malaysia day and never charges malformed proposals',async()=>{
    await complete();await perf.releaseOnehrResult(a,reviewId,'feedback',true);vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    vi.mocked(generateDraft).mockResolvedValueOnce('not JSON');await expect(perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID())).rejects.toThrow(/No usable goal/);expect(await owner.db.select().from(schema.assessmentAiUse)).toEqual([]);
    vi.mocked(generateDraft).mockResolvedValue('{"items":[0]}');
    for(let i=0;i<5;i++)expect((await perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID())).remaining).toBe(4-i);
    await expect(perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID())).rejects.toThrow(/All 5 development/);expect(generateDraft).toHaveBeenCalledTimes(6);expect((await view(self)).plans).toEqual([]);expect((await view(self)).developmentQuota).toMatchObject({remaining:0,limit:5});
  });
  it('discards development proposals when their released feedback is withdrawn and refuses stale keep/drop actions',async()=>{
    await complete();await perf.releaseOnehrResult(a,reviewId,'feedback',true);vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    const response='{"items":[0]}';
    vi.mocked(generateDraft).mockImplementationOnce(async()=>{await perf.releaseOnehrResult(a,reviewId,'feedback',false);return response;});
    await expect(perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID())).rejects.toThrow(/assessment or plan changed/);expect(await owner.db.select().from(schema.assessmentAiUse)).toEqual([]);
    await perf.releaseOnehrResult(a,reviewId,'feedback',true);vi.mocked(generateDraft).mockResolvedValue(response);const result=await perf.suggestAssessmentDevelopmentGoals(self,reviewId,randomUUID());
    await perf.releaseOnehrResult(a,reviewId,'feedback',false);
    await expect(perf.applyAssessmentDevelopmentGoals(self,reviewId,null,{careerRevision:null,career:{aspiration:'Develop delivery',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[]},result.goals,result.sourceDigest)).rejects.toThrow(/released feedback or reviewed competencies changed/);expect((await view(self)).plans).toEqual([]);
  });
  it('previews a whole career plan from weak KPIs, preserves human choices and saves only explicitly kept draft content',async()=>{
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Delivery reliability',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,10,20,30,40]},moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view(mgr)).revision,true,'Agreed targets');
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:0,note:'The agreed delivery needs improvement. Contact practice.owner@example.test.'}],'Review the delivery gaps.');
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    vi.mocked(generateDraft).mockResolvedValue('{"items":[0]}');
    const result=await perf.suggestAssessmentCareerPlan(self,reviewId,randomUUID(),{aspirationLong:'I aim to deepen my delivery practice.'});expect(result).toMatchObject({remaining:4,goals:[{area:'Delivery reliability',onJob:'Practise this development area in an appropriate work activity and record your learning.'}],aspirationLong:'I aim to deepen my delivery practice.'});
    expect(generateDraft).toHaveBeenCalledTimes(2);expect(vi.mocked(generateDraft).mock.calls.map(([,request])=>request.prompt).join(' ')).not.toContain('practice.owner@example.test');expect((await view(self)).plans).toEqual([]);expect((await view(self)).careerProfile).toBeNull();expect((await view(self)).careerDraftQuota?.remaining).toBe(4);
    const career={aspiration:'My chosen direction',aspirationLong:'',mobility:null,mobilityNote:'My own travel preference',targetProfileId:null},manual={id:randomUUID(),area:'My manual goal',dueOn:`${year+1}-06-01`,onJob:'My own action',fromOthers:'',formalLearning:'',status:'not_started'};
    await expect(perf.applyAssessmentCareerPlan(self,reviewId,null,{careerRevision:null,career,goals:[manual]},[{...result.goals[0],area:'Invented goal'}],result.aspirationLong,result.sourceDigest)).rejects.toThrow(/available development gaps/);
    await perf.setAssessmentAiSwitch({...a,grants:[{role:'hr_admin',companyId:null}]},'idp',false);
    await perf.applyAssessmentCareerPlan(self,reviewId,null,{careerRevision:null,career,goals:[manual]},result.goals,result.aspirationLong,result.sourceDigest);
    const v=await view(self);expect(v.plans[0]).toMatchObject({status:'draft',career:{aspiration:'My chosen direction',aspirationLong:result.aspirationLong,mobility:null,mobilityNote:'My own travel preference',targetProfileId:null}});
    expect(v.plans[0].goals.map(g=>g.area)).toEqual(['My manual goal','Delivery reliability']);expect(v.plans[0].goals[0].dueOn).toBe(manual.dueOn);expect(v.plans[0].goals[1].dueOn).toBe('');expect((await view(mgr)).plans).toEqual([]);
    expect(await owner.db.select().from(schema.payrollInput)).toEqual([]);expect((await owner.db.select().from(schema.assessmentAiUse)).map(r=>r.fieldKey)).toEqual([`career_draft:${cycleId}`]);
    await expect(perf.suggestAssessmentCareerPlan(mgr,reviewId,randomUUID())).rejects.toThrow(/only for your/);
  });
  it('counts partial whole-plan drafts independently and refuses stale assessment or career changes',async()=>{
    await complete();await perf.releaseOnehrResult(a,reviewId,'feedback',true);vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    // A profile-only success still counts; a malformed action response does not invent generic goals.
    vi.mocked(generateDraft).mockImplementation(async(_cfg,request)=>JSON.parse(request.prompt).passages.some((p:{kind:string})=>p.kind==='authored')?'{"items":[0]}':'not JSON');
    const request=randomUUID(),first=await perf.suggestAssessmentCareerPlan(self,reviewId,request,{aspirationLong:'Grow my practice'});expect(first).toMatchObject({goals:[],aspirationLong:'Grow my practice',remaining:4});
    await expect(perf.suggestAssessmentCareerPlan(self,reviewId,request,{aspirationLong:'Grow my practice'})).rejects.toThrow(/already completed/);expect(generateDraft).toHaveBeenCalledTimes(2);
    for(let i=0;i<4;i++)expect((await perf.suggestAssessmentCareerPlan(self,reviewId,randomUUID(),{aspirationLong:'Grow my practice'})).remaining).toBe(3-i);
    await expect(perf.suggestAssessmentCareerPlan(self,reviewId,randomUUID(),{aspirationLong:'Grow my practice'})).rejects.toThrow(/All 5 career plan/);
    expect((await view(self)).developmentQuota?.remaining).toBe(5);
    const career={aspiration:'My own direction',aspirationLong:'My own longer-term words',mobility:'stay',mobilityNote:'',targetProfileId:null};
    await perf.saveAssessmentCareerProfile(self,reviewId,null,career);
    await expect(perf.applyAssessmentCareerPlan(self,reviewId,null,{careerRevision:1,career,goals:[]},[],first.aspirationLong,first.sourceDigest)).rejects.toThrow(/changed/);
    expect((await view(self)).careerProfile?.career.aspirationLong).toBe('My own longer-term words');expect((await view(self)).plans).toEqual([]);
  });
  it('rejects an in-flight whole-plan draft after evidence release is withdrawn without charging quota',async()=>{
    await complete();await perf.releaseOnehrResult(a,reviewId,'feedback',true);vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    vi.mocked(generateDraft).mockImplementation(async(_cfg,request)=>{await perf.releaseOnehrResult(a,reviewId,'feedback',false);return '{"items":[0]}';});
    await expect(perf.suggestAssessmentCareerPlan(self,reviewId,randomUUID())).rejects.toThrow(/changed/);expect(await owner.db.select().from(schema.assessmentAiUse)).toEqual([]);expect((await view(self)).plans).toEqual([]);
  });

  it('previews one scoped employee reminder without delivery and saves wording independently of the schedule',async()=>{
    const group={...a,grants:[{role:'hr_admin',companyId:null}]},[employee]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,subject.employmentId));
    await perf.saveAssessmentReminderWords(group,{subject:'{first_name}: {count} {things} waiting — {cycle}',opening:'Hello {first_name}, please review your open work.'});
    await perf.saveAssessmentReminderRules(group,{enabled:true,everyDays:7});
    const configured=await perf.getAssessmentReminders(group,cycleId);expect(configured.words?.subject).toContain('{first_name}');expect(configured.rules.everyDays).toBe(7);
    const preview=await perf.previewAssessmentReminder(group,cycleId,employee.employeeCode!);
    expect(preview).toMatchObject({employee:'Assessment subject',eligible:false,mail:{tasks:[{key:'own_competency',count:1}],words:{subject:'Assessment: 1 thing is waiting — Native annual assessment',opening:'Hello Assessment, please review your open work.'}}});
    expect(await owner.db.select().from(schema.assessmentReminderRun)).toEqual([]);expect(await owner.db.select().from(schema.notificationDelivery)).toEqual([]);
    await expect(perf.previewAssessmentReminder(self,cycleId,employee.employeeCode!)).rejects.toThrow(/administrator/);
    await expect(perf.previewAssessmentReminder(group,cycleId,'unknown-employee')).rejects.toThrow(/No employee/);
    await expect(perf.saveAssessmentReminderWords({...group,grants:[{role:'hr_admin',companyId:b.companyId}]},{subject:'Other',opening:'Other'})).rejects.toThrow(/group HR/);
    await perf.saveAssessmentReminderWords(group,null);expect((await perf.getAssessmentReminders(group,cycleId)).words).toBeNull();expect((await perf.getAssessmentReminders(group,cycleId)).rules.everyDays).toBe(7);
    await owner.db.update(schema.onehrReview).set({competencyStatus:'reviewed'}).where(eq(schema.onehrReview.reviewId,reviewId));expect((await perf.previewAssessmentReminder(group,cycleId,employee.employeeCode!)).mail.tasks).toEqual([]);
  });

  it('prepares reminders without SMTP, lets assessment work finish, and skips obsolete work on an explicit retry',async()=>{
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);self={...self,entitlements:a.entitlements};
    const issuer='https://hr.test/identity/realms/ai-hr',subjectId=randomUUID(),[person]=await owner.db.select().from(schema.person).where(eq(schema.person.id,subject.personId));
    await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:subjectId,appUserId:self.userId!});
    await saveNotificationEmailPolicy(a,['performance']);await saveNotificationEmailPreferences(self,subject.employmentId,['performance'],'en',{issuer,subject:subjectId,email:person.primaryEmail,emailVerified:true});
    expect(await perf.queueAssessmentReminders(a,cycleId,'manual')).toMatchObject({queued:1});await dispatchNotifications(a);
    const [delivery]=await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.kind,'performance.reminder'));
    const offline=async<T>():Promise<T>=>({version:1,ready:false,assessmentReminders:true,assessmentReminderWords:true} as T);
    expect(await deliverNotificationEmails(a,offline)).toMatchObject({attempted:1,unavailable:true});
    expect((await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.id,delivery.id)))[0]).toMatchObject({status:'failed',lastError:'relayUnavailable',startedAt:null});
    const [draft]=await owner.db.select().from(schema.assessmentReminderRecipient).where(eq(schema.assessmentReminderRecipient.sourceEventId,delivery.sourceEventId!));
    expect(draft.tasks).toEqual([expect.objectContaining({key:'own_competency',count:1})]);
    await perf.submitOnehrCompetencies(self,reviewId,(await view(self)).revision,{'skill-1':{answer:'no',remark:''},'skill-2':{answer:'no',remark:''}},false,'I have completed my self-assessment.');
    expect((await view(self)).competencyStatus).toBe('submitted');
    await retryNotificationEmail(a,delivery.id,true);
    const onlineCalls=vi.fn();
    const online:NotificationEmailTransport=async<T>(request:NotificationEmailRequest)=>{onlineCalls(request);return {version:1,ready:true,assessmentReminders:true,assessmentReminderWords:true} as T;};
    expect(await deliverNotificationEmails(a,online)).toMatchObject({attempted:0,skipped:1});expect(onlineCalls).toHaveBeenCalledTimes(1);
    expect((await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.id,delivery.id)))[0]).toMatchObject({status:'skipped',lastError:'notEligible'});
  });

  it('queues unified reminders only after consent, previews without mail, and observes the 20-hour sent cooldown',async()=>{
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);self={...self,entitlements:a.entitlements};
    expect((await perf.getAssessmentReminders(a,cycleId)).rules.enabled).toBe(false);
    await expect(perf.queueAssessmentReminders(self,cycleId,'manual')).rejects.toThrow(/administrator/);
    await expect(perf.saveAssessmentReminderRules({...a,grants:[{role:'hr_admin',companyId:b.companyId}]},{enabled:true})).rejects.toThrow(/group HR/);
    await expect(perf.saveAssessmentReminderRules({...a,grants:[{role:'hr_admin',companyId:null}]},{enabled:true,everyDays:31})).rejects.toThrow();
    await perf.saveAssessmentReminderRules({...a,grants:[{role:'hr_admin',companyId:null}]},{enabled:true,onOpen:true,daysBefore:[7,3,1],everyDays:0,sendTime:'09:00'});
    expect((await perf.getAssessmentReminders(a,cycleId)).rules.enabled).toBe(true);
    const before=await perf.queueAssessmentReminders(a,cycleId,'manual');expect(before.queued).toBe(0);expect(before.skipped).toBeGreaterThan(0);
    const issuer='https://hr.test/identity/realms/ai-hr',subjectId=randomUUID(),[person]=await owner.db.select().from(schema.person).where(eq(schema.person.id,subject.personId));
    await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:subjectId,appUserId:self.userId!});
    await saveNotificationEmailPolicy(a,['performance']);await saveNotificationEmailPreferences(self,subject.employmentId,['performance'],'en',{issuer,subject:subjectId,email:person.primaryEmail,emailVerified:true});
    const dry=await perf.queueAssessmentReminders(a,cycleId,'dry');expect(dry.dry).toBe(1);expect(dry.queued).toBe(0);expect(await owner.db.select().from(schema.notificationDelivery)).toEqual([]);
    const queued=await perf.queueAssessmentReminders(a,cycleId,'manual');expect(queued.queued).toBe(1);
    await dispatchNotifications(a);const [delivery]=await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.kind,'performance.reminder'));expect(delivery.recipientUserId).toBe(self.userId);
    expect((await perf.queueAssessmentReminders(a,cycleId,'manual')).queued).toBe(0);
    const old=async<T>(request:unknown):Promise<T>=>({version:1,ready:true} as T);
    expect(await deliverNotificationEmails(a,old)).toMatchObject({attempted:0,unavailable:true});
    const oldSummaryWorker=async<T>():Promise<T>=>({version:1,ready:true,assessmentReminders:true} as T);expect(await deliverNotificationEmails(a,oldSummaryWorker)).toMatchObject({attempted:0,unavailable:true});
    const checked=await withTenant({...a,userId:undefined,personId:undefined},tx=>perf.assessmentReminderRecipientsTx(tx,queued.runId!));expect(checked).toEqual([]);
    await owner.db.update(schema.notificationDelivery).set({status:'sent',sentAt:new Date()}).where(eq(schema.notificationDelivery.id,delivery.id));
    expect((await perf.queueAssessmentReminders(a,cycleId,'manual')).queued).toBe(0);
    await owner.db.update(schema.notificationDelivery).set({sentAt:new Date(Date.now()-21*3600000)}).where(eq(schema.notificationDelivery.id,delivery.id));
    expect((await perf.queueAssessmentReminders(a,cycleId,'manual')).queued).toBe(1);
    expect((await perf.getAssessmentReminders(a,cycleId)).runs.some(r=>r.sent===1)).toBe(true);
  });

  it('applies reminder limits to eligible attempts after skipped accounts and refreshes cached tasks within one dispatcher transaction',async()=>{
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);await saveNotificationEmailPolicy(a,['performance']);
    const issuer='https://hr.test/identity/realms/ai-hr';
    const candidates=[{ctx:self,employmentId:subject.employmentId},{ctx:mgr,employmentId:manager.employmentId},...peers].sort((x,y)=>x.ctx.userId!.localeCompare(y.ctx.userId!));
    const eligible=candidates.slice(-2);
    for(const actor of eligible){
      const subjectId=randomUUID(),[person]=await owner.db.select().from(schema.person).where(eq(schema.person.id,actor.ctx.personId!));
      await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:subjectId,appUserId:actor.ctx.userId!});
      await saveNotificationEmailPreferences({...actor.ctx,entitlements:a.entitlements},actor.employmentId,['performance'],'en',{issuer,subject:subjectId,email:person.primaryEmail,emailVerified:true});
    }
    const limited=await perf.queueAssessmentReminders(a,cycleId,'dry',1);expect(limited.dry).toBe(1);expect(limited.skipped).toBeGreaterThan(0);
    expect((await perf.queueAssessmentReminders(a,cycleId,'dry',0)).dry).toBe(2);
    const queued=await perf.queueAssessmentReminders(a,cycleId,'manual',1);expect(queued.queued).toBe(1);
    const [recipient]=await owner.db.select().from(schema.assessmentReminderRecipient).where(and(eq(schema.assessmentReminderRecipient.runId,queued.runId!),eq(schema.assessmentReminderRecipient.outcome,'queued')));
    expect(recipient.userId).toBe(eligible[0].ctx.userId);
    const [unassigned]=await withTenant(eligible[0].ctx,tx=>tx.execute<{source:unknown;changed:boolean}>(sql`select app.onehr_reminder_dispatch_source(${recipient.id}::uuid) as source,app.onehr_reminder_dispatch_update(${recipient.id}::uuid,'{}'::jsonb,'changed','[]'::jsonb,null::jsonb,null::timestamptz,null::bigint,null::bigint) as changed`));expect(unassigned).toEqual({source:null,changed:false});
    const system={...a,userId:undefined,personId:undefined};
    await withOnehrWorkerSource(system,owner,{kind:'recipient',id:recipient.id},async tx=>{
      const [source]=await tx.execute<{dispatcher:boolean;run:boolean;recipient:boolean;actor:boolean;route:boolean;port:boolean}>(sql`select app.assessment_dispatcher_scope() as dispatcher,exists(select 1 from performance_assessment_reminder_run where id=${queued.runId!}::uuid) as run,exists(select 1 from performance_assessment_reminder_recipient where id=${recipient.id}::uuid) as recipient,coalesce((app.assessment_pending_work(${cycleId}::uuid)->'actors') @> ${JSON.stringify([{userId:eligible[0].ctx.userId}])}::jsonb,false) as actor,exists(select 1 from app.assessment_reminder_mail_routes(${cycleId}::uuid) where user_id=${eligible[0].ctx.userId!}::uuid and employment_id=${eligible[0].employmentId}::uuid) as route,app.onehr_reminder_dispatch_source(${recipient.id}::uuid) is not null as port`);
      expect(source).toEqual({dispatcher:false,run:false,recipient:false,actor:true,route:true,port:true});
      const resolved=await perf.assessmentReminderRecipientsTx(tx,recipient.id);
      const [delivery]=await tx.execute<{outcome:string|null}>(sql`select app.onehr_reminder_dispatch_source(${recipient.id}::uuid)->'recipient'->>'outcome' as outcome`);expect(delivery?.outcome).toBe('queued');
      expect(resolved).toEqual([eligible[0].employmentId]);
      // A real committed workflow change invalidates the transaction-local projection.
      await owner.db.update(schema.onehrReview).set({competencyStatus:'reviewed'}).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,eligible[0].employmentId)));
      expect(await perf.assessmentReminderRecipientsTx(tx,recipient.id)).toEqual([]);
    });
    expect((await owner.db.select().from(schema.assessmentReminderRecipient).where(eq(schema.assessmentReminderRecipient.id,recipient.id)))[0].outcome).toBe('noPendingWork');
  });

  it('claims automatic reminder days once and isolates company-only notification dispatch from other categories',async()=>{
    const system={...a,userId:undefined,personId:undefined};
    await expect(perf.queueAssessmentReminders(system,cycleId,'automatic')).rejects.toThrow('authenticated OneHR worker connection');
    expect((await perf.queueAssessmentReminders(system,cycleId,'automatic',0,owner)).duplicate).toBe(false);expect(await owner.db.select().from(schema.assessmentReminderRun)).toEqual([]);
    const [config]=await owner.db.select().from(schema.onehrCycle).where(eq(schema.onehrCycle.cycleId,cycleId)),policy=defaultPolicy(framework),now=new Date();
    await owner.db.update(schema.onehrCycle).set({policy:{...config.policy as typeof policy,windows:{tc_self:{opensAt:new Date(now.getTime()-60000).toISOString(),closesAt:new Date(now.getTime()+86400000).toISOString()}}}}).where(eq(schema.onehrCycle.cycleId,cycleId));
    await perf.saveAssessmentReminderRules({...a,grants:[{role:'hr_admin',companyId:null}]},{enabled:true,sendTime:'00:00'});
    const first=await perf.queueAssessmentReminders(system,cycleId,'automatic',0,owner);expect(first.duplicate).toBe(false);expect((await perf.queueAssessmentReminders(system,cycleId,'automatic',0,owner)).duplicate).toBe(true);
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);self={...self,entitlements:a.entitlements};
    const issuer='https://hr.test/identity/realms/ai-hr',subjectId=randomUUID(),[person]=await owner.db.select().from(schema.person).where(eq(schema.person.id,subject.personId));
    await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:subjectId,appUserId:self.userId!});await saveNotificationEmailPolicy(a,['performance']);await saveNotificationEmailPreferences(self,subject.employmentId,['performance'],'en',{issuer,subject:subjectId,email:person.primaryEmail,emailVerified:true});
    await owner.db.update(schema.tenantModule).set({status:'disabled'}).where(and(eq(schema.tenantModule.tenantId,b.tenantId),eq(schema.tenantModule.moduleCode,'notifications')));
    await owner.db.insert(schema.tenantModule).values({tenantId:b.tenantId,moduleCode:'notifications',companyId:b.companyId,status:'active'});const scoped={...await entitledCtx(b),userId:undefined,personId:undefined};
    expect((await perf.queueAssessmentReminders(a,cycleId,'manual')).queued).toBe(1);
    await withTenant(a,tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'test',aggregateId:randomUUID(),eventType:'leave-request.approved',subjectEmploymentId:subject.employmentId,actor:actorOf(a)}));
    expect((await dispatchNotificationsFromSweep(scoped,owner)).created).toBe(1);expect((await owner.db.select().from(schema.notification)).map(n=>n.kind)).toEqual(['performance.reminder']);
    const [cursor]=await owner.db.select().from(schema.notificationCursor);expect(cursor.lastSequence).toBeNull();expect(cursor.assessmentLastSequence).toBeGreaterThan(0);
    await setModule(b.tenantId,'notifications','active');await dispatchNotifications(await entitledCtx(b));
    expect((await owner.db.select().from(schema.notification)).map(n=>n.kind).sort()).toEqual(['leave.approved','performance.reminder']);
  });

  it('prepares a bounded reminder through the actual dispatcher and rejects changed work before private SMTP starts',async()=>{
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);self={...self,entitlements:a.entitlements};
    const issuer='https://hr.test/identity/realms/ai-hr',subjectId=randomUUID(),[person]=await owner.db.select().from(schema.person).where(eq(schema.person.id,subject.personId));
    await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:subjectId,appUserId:self.userId!});await saveNotificationEmailPolicy(a,['performance']);
    await saveNotificationEmailPreferences(self,subject.employmentId,['performance'],'en',{issuer,subject:subjectId,email:person.primaryEmail,emailVerified:true});
    await perf.saveAssessmentReminderWords({...a,grants:[{role:'hr_admin',companyId:null}]},{subject:'{first_name}: review {cycle}',opening:'Please complete {count} task groups.'});
    const queued=await perf.queueAssessmentReminders(a,cycleId,'manual');expect(queued.queued).toBe(1);const system={...a,userId:undefined,personId:undefined};await dispatchNotificationsFromSweep(system,owner);
    const [recipient]=await owner.db.select().from(schema.assessmentReminderRecipient).where(and(eq(schema.assessmentReminderRecipient.runId,queued.runId!),eq(schema.assessmentReminderRecipient.userId,self.userId!)));
    const [forged]=await withTenant(system,tx=>tx.execute<{scope:boolean;source:unknown;graph:unknown;access:unknown;notice:unknown}>(sql`select app.assessment_dispatcher_scope() as scope,app.onehr_reminder_dispatch_source(${recipient.id}::uuid) as source,app.assessment_pending_work(${cycleId}::uuid) as graph,app.onehr_review_task_recipient_access(${cycleId}::uuid,null::uuid) as access,app.onehr_review_notice_source(${reviewId}::uuid) as notice`));
    expect(forged).toEqual({scope:false,source:null,graph:null,access:{},notice:null});
    await expect(withTenant(system,tx=>tx.execute(sql`select app.financial_onehr_worker_enroll('recipient',${recipient.id}::uuid)`))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
    await expect(withOnehrWorkerSource(system,{withTenant},{kind:'recipient',id:recipient.id},async()=>true)).rejects.toThrow('explicit privileged database connection');
    const [beforeAgent]=await owner.db.select().from(schema.assessmentReminderRecipient).where(eq(schema.assessmentReminderRecipient.id,recipient.id));
    let agentCode:string|undefined,agentMessage='';try{await withTenant(a,async tx=>{
      const [actual]=await tx.execute<{source:unknown}>(sql`select app.onehr_reminder_dispatch_source(${recipient.id}::uuid) as source`);expect(actual.source).not.toBeNull();
      await tx.execute(sql`select set_config('app.agent_principal_id','invalid-agent-marker',true)`);
      await tx.execute(sql`select app.onehr_reminder_dispatch_update(${recipient.id}::uuid,${JSON.stringify(actual.source)}::jsonb,'noPendingWork','[]'::jsonb,null::jsonb,null::timestamptz,null::bigint,null::bigint)`);
    });}catch(error){let cause:unknown=error;while(cause&&typeof cause==='object'){const row=cause as {code?:string;message?:string;cause?:unknown};agentCode=row.code??agentCode;agentMessage+=' '+(row.message??'');cause=row.cause;}}
    expect(agentCode).toBe('42501');expect(agentMessage).toContain('OneHR worker principal unavailable');expect(await owner.db.select().from(schema.assessmentReminderRecipient).where(eq(schema.assessmentReminderRecipient.id,recipient.id))).toEqual([beforeAgent]);
    const actualWorker=await createOnehrWorkerAccess(system,owner);
    expect(await actualWorker.withEvent(recipient.sourceEventId!,tx=>perf.assessmentReminderRecipientsTx(tx,recipient.id))).toEqual([subject.employmentId]);
    await expect(deliverNotificationEmails(system,async<T>()=>({version:1,ready:false} as T),{onehrSweep:{tenantId:system.tenantId,withEvent:actualWorker.withEvent}})).rejects.toThrow('does not match');
    expect(await withOnehrWorkerSource(system,owner,{kind:'recipient',id:recipient.id},tx=>perf.assessmentReminderRecipientsTx(tx,recipient.id))).toEqual([subject.employmentId]);
    const projected=await owner.db.select({id:schema.notification.id}).from(schema.notification).where(and(eq(schema.notification.sourceEventId,recipient.sourceEventId!),eq(schema.notification.kind,'performance.reminder')));expect(projected).toHaveLength(1);
    const [delivery]=await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.sourceEventId,recipient.sourceEventId!)),token=randomUUID();expect(delivery).toBeTruthy();
    await owner.db.update(schema.notificationDelivery).set({leaseToken:token,leaseUntil:new Date(Date.now()+60000)}).where(eq(schema.notificationDelivery.id,delivery.id));
    await restrictedReminderMailOwner(async role=>{
      await owner.client.begin(async tx=>{
        await tx.unsafe(`SET LOCAL ROLE "${role}"`);
        expect((await tx`select (select count(*)::int from notification_delivery where id=${delivery.id}::uuid) as delivery,(select count(*)::int from performance_assessment_reminder_run) as runs,(select count(*)::int from performance_assessment_reminder_recipient) as recipients`)[0]).toEqual({delivery:1,runs:0,recipients:0});
      });
      const [payload]=await owner.db.execute<{value:{tasks:{key:string}[];words:{subject:string;opening:string}}}>(sql`select identity_email.assessment_tasks(${delivery.id}::uuid,${token}::uuid,${issuer}) as value`);
      expect(payload.value).not.toBeNull();
      expect((await owner.client`select app.current_tenant_id() as tenant,app.current_user_id() as actor,app.is_group_admin() as elevated`)[0]).toEqual({tenant:null,actor:null,elevated:false});
      expect(payload.value.tasks).toEqual([{key:'own_competency',count:1,closesAt:null}]);expect(payload.value.words).toEqual({subject:'Assessment: review Native annual assessment',opening:'Please complete 1 task groups.'});
      for(const [id,nonce,who] of [[delivery.id,randomUUID(),issuer],[randomUUID(),token,issuer],[delivery.id,token,'https://foreign.fixture.test']])expect((await owner.client`select identity_email.assessment_tasks(${id}::uuid,${nonce}::uuid,${who}) as value`)[0].value).toBeNull();
      expect((await owner.client`select * from identity_email.delivery_summary(${delivery.id}::uuid,${token}::uuid,${issuer})`)[0]).toMatchObject({required:true,summary:payload.value});
      await owner.client.begin(async tx=>{
        const foreign=randomUUID(),actor=randomUUID(),grants=JSON.stringify([{role:'employee',companyId:randomUUID()}]);
        await tx`select set_config('app.tenant_id',${foreign},true),set_config('app.user_id',${actor},true),set_config('app.roles','employee',true),set_config('app.grants',${grants},true)`;
        expect((await tx`select identity_email.assessment_tasks(${delivery.id}::uuid,${token}::uuid,${issuer}) as value`)[0].value).toEqual(payload.value);
        expect((await tx`select identity_email.assessment_tasks(${delivery.id}::uuid,${randomUUID()}::uuid,${issuer}) as value`)[0].value).toBeNull();
      const [prepared]=await tx`select tasks from performance_assessment_reminder_recipient where id=${recipient.id}::uuid`;
      await tx`update performance_assessment_reminder_recipient set tasks=jsonb_set(tasks,'{0,closesAt}',to_jsonb('not-a-timestamp'::text)) where id=${recipient.id}::uuid`;
      // Exercise an actual payload-query exception after context was established. The caught
      // statement rolls back through the helper and savepoint, retaining the caller's scope.
      await expect(tx.savepoint(async sp=>{await sp`select identity_email.assessment_tasks(${delivery.id}::uuid,${token}::uuid,${issuer})`;})).rejects.toMatchObject({code:'22007'});
      expect((await tx`select current_setting('app.tenant_id') as tenant,current_setting('app.user_id') as actor,current_setting('app.roles') as roles,current_setting('app.grants') as grants`)[0]).toEqual({tenant:foreign,actor,roles:'employee',grants});
      await tx`update performance_assessment_reminder_recipient set tasks=${JSON.stringify(prepared.tasks)}::jsonb where id=${recipient.id}::uuid`;
      });
      const rollback=Error('Rollback the private start acceptance fixture');
      await expect(owner.client.begin(async tx=>{
        const [target]=await tx`select * from identity_email.delivery_target(${delivery.id}::uuid,${token}::uuid,${issuer})`;
        expect((await tx`select identity_email.start_delivery(${delivery.id}::uuid,${token}::uuid,${issuer},${JSON.stringify(target)}::jsonb) as started`)[0].started).toBe(true);
        throw rollback;
      })).rejects.toBe(rollback);
      await perf.saveAssessmentReminderWords({...a,grants:[{role:'hr_admin',companyId:null}]},{subject:'Changed reminder',opening:'Updated opening'});
      expect((await owner.db.execute<{value:unknown}>(sql`select identity_email.assessment_tasks(${delivery.id}::uuid,${token}::uuid,${issuer}) as value`))[0].value).toBeNull();
      expect(await withOnehrWorkerSource(system,owner,{kind:'recipient',id:recipient.id},tx=>perf.assessmentReminderRecipientsTx(tx,recipient.id))).toEqual([subject.employmentId]);
      expect((await owner.db.execute<{value:{words:{subject:string}}}>(sql`select identity_email.assessment_tasks(${delivery.id}::uuid,${token}::uuid,${issuer}) as value`))[0].value.words.subject).toBe('Changed reminder');
      await expect(withTenant(self,tx=>tx.select().from(schema.assessmentReminderRecipient))).resolves.toEqual([]);
      expect((await owner.db.execute<{allowed:boolean}>(sql`select has_function_privilege('ai_hr_app','identity_email.assessment_tasks(uuid,uuid,text)','EXECUTE') as allowed`))[0].allowed).toBe(false);
      await expect(withTenant(a,tx=>tx.execute(sql`select identity_email.assessment_tasks(${delivery.id}::uuid,${token}::uuid,${issuer})`))).rejects.toThrow();
      const [target]=await owner.db.execute(sql`select * from identity_email.delivery_target(${delivery.id}::uuid,${token}::uuid,${issuer})`);
      await owner.db.update(schema.onehrReview).set({competencyStatus:'reviewed'}).where(eq(schema.onehrReview.reviewId,reviewId));
      expect((await owner.db.execute<{value:unknown}>(sql`select identity_email.assessment_tasks(${delivery.id}::uuid,${token}::uuid,${issuer}) as value`))[0].value).toBeNull();
      expect((await owner.db.execute<{started:boolean}>(sql`select identity_email.start_delivery(${delivery.id}::uuid,${token}::uuid,${issuer},${JSON.stringify(target)}::jsonb) as started`))[0].started).toBe(false);
      expect((await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.id,delivery.id)))[0].startedAt).toBeNull();
      expect(await withOnehrWorkerSource(system,owner,{kind:'recipient',id:recipient.id},tx=>perf.assessmentReminderRecipientsTx(tx,recipient.id))).toEqual([]);
    });
  });

  it('batches current pending metadata for authorized dispatchers without review text, amounts or peer answers',async()=>{
    const id=randomUUID(),privateTitle='Routing must omit this KPI title',privateRemark='Routing must omit this submitted remark',privateAmount=12345678;
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:privateTitle,description:'Private KPI description',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,20000000,30000000,40000000,50000000]},moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view(mgr)).revision,true,'Approved private review text');
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:privateAmount,note:'Private submitted evidence'}],privateRemark);
    await perf.assignOnehrPanel(mgr,reviewId,(await view(mgr)).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));
    const read=(ctx:SessionContext,id=cycleId)=>{const reader=async(tx:import('../db/client').Tx)=>(await tx.execute<{value:unknown}>(sql`select app.assessment_pending_work(${id}::uuid) as value`))[0].value;return ctx.userId?withTenant(ctx,reader):withOnehrWorkerSource(ctx,owner,{kind:'cycle',id},reader);};
    const human=await read(a),system=await read({...a,userId:undefined,personId:undefined});expect(system).toEqual(human);
    const data=system as {actors:{userId:string}[];reviews:{id:string;facts:{resultsSubmitted:boolean;kpis:{moderatorEmploymentId:string}[]}}[];panels:{employmentId:string}[]};
    expect(data.actors.some(actor=>actor.userId===self.userId)).toBe(true);expect(data.actors.some(actor=>actor.userId===mgr.userId)).toBe(true);
    expect(data.reviews.find(r=>r.id===reviewId)).toMatchObject({facts:{resultsSubmitted:true,kpis:[{moderatorEmploymentId:manager.employmentId}]}});
    expect(data.panels.map(p=>p.employmentId).sort()).toEqual(peers.map(p=>p.employmentId).sort());
    const text=JSON.stringify(data);for(const privateValue of [privateTitle,privateRemark,String(privateAmount),'Private submitted evidence','Private KPI description','Approved private review text'])expect(text).not.toContain(privateValue);
    const pendingGraph=system as ReminderWorkGraph;expect(pendingGraph.reviews.find(r=>r.id===reviewId)?.facts).toMatchObject({managerPerformance:null,managerComplete:false});
    await perf.moderateOnehrKpi(mgr,reviewId,(await view(mgr)).revision,id,privateAmount,'');await perf.confirmOnehrPerformance(mgr,reviewId,(await view(mgr)).revision,'UA','');
    const [confirmed]=await owner.db.select({band:schema.onehrReview.managerPerformance}).from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));expect(confirmed.band).toBe('UA');
    const completed=await read({...a,userId:undefined,personId:undefined}) as ReminderWorkGraph;expect(completed.reviews.find(r=>r.id===reviewId)?.facts).toMatchObject({managerPerformance:null,managerComplete:true});expect(JSON.stringify(completed)).not.toContain('"UA"');
    const nativeRows=await owner.db.select({id:schema.onehrReview.reviewId,band:schema.onehrReview.managerPerformance}).from(schema.onehrReview).where(eq(schema.onehrReview.cycleId,cycleId)),nativeBands=new Map(nativeRows.map(r=>[r.id,r.band]));
    const originalShape:ReminderWorkGraph={...completed,reviews:completed.reviews.map(r=>({...r,facts:{...r.facts,managerComplete:undefined,managerPerformance:(nativeBands.get(r.id)??null) as typeof r.facts.managerPerformance}}))};
    const now=new Date(),companies=new Set([b.companyId]),work=assessmentReminderWork(completed,companies,now);expect(work.length).toBeGreaterThan(0);expect(assessmentReminderWork(originalShape,companies,now)).toEqual(work);

    expect(await read(self)).toBeNull();expect(await read(peers[0].ctx)).toBeNull();expect(await read(a,randomUUID())).toBeNull();
    await expect(withTenant(a,tx=>tx.execute(sql`select app.assessment_admin_for(${self.userId}::uuid,${b.companyId}::uuid)`))).rejects.toThrow();
    let cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.setAssessmentParticipation(a,cycleId,cycle.revision,subject.employmentId,cycle.participants.find(p=>p.employmentId===subject.employmentId)!.revision,'remove');
    const withdrawn=await read({...a,userId:undefined,personId:undefined}) as typeof data;expect(withdrawn.reviews.some(r=>r.id===reviewId)).toBe(false);expect(withdrawn.panels).toEqual([]);
  });

  it('queues review-task email through the actual sweep from canonical live entitlements and native pending work',async()=>{
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);mgr={...mgr,entitlements:a.entitlements};
    const issuer='https://hr.test/identity/realms/ai-hr',identitySubject=randomUUID();
    const [person]=await owner.db.select().from(schema.person).where(eq(schema.person.id,manager.personId));
    await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:identitySubject,appUserId:mgr.userId!});
    await saveNotificationEmailPolicy(a,['performance']);await saveNotificationEmailPreferences(mgr,manager.employmentId,['performance'],'en',{issuer,subject:identitySubject,email:person.primaryEmail,emailVerified:true});
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Native worker task source',description:'Private description never appears in custody',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}],true);
    const [event]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,reviewId),eq(schema.domainEvent.eventType,'onehr.kpi-approval-needed')));expect(event).toBeDefined();
    const system={...a,userId:undefined,personId:undefined};
    // The unchanged native TS workspace derivation independently names this pending recipient.
    expect(await withOnehrWorkerSource(system,owner,{kind:'event',id:event.id},tx=>perf.assessmentReviewTaskRecipientsTx(tx,reviewId,'setting'))).toEqual([manager.employmentId]);
    await dispatchNotificationsFromSweep(system,owner);
    const [notice]=await owner.db.select().from(schema.notification).where(and(eq(schema.notification.sourceEventId,event.id),eq(schema.notification.recipientEmploymentId,manager.employmentId),eq(schema.notification.kind,'performance.review-task')));expect(notice).toBeDefined();
    const [delivery]=await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.notificationId,notice.id));
    expect(delivery).toMatchObject({recipientUserId:mgr.userId,sourceEventId:event.id,kind:'performance.review-task',category:'performance',status:'pending'});
    await dispatchNotificationsFromSweep(system,owner);
    expect(await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.sourceEventId,event.id))).toEqual([delivery]);
    const enqueue=(tx:import('../db/client').Tx,sequence=event.sequence)=>tx.execute<{created:number}>(sql`select app.onehr_review_task_email_enqueue(${notice.id}::uuid,${sequence}::bigint) as created`);
    expect((await withTenant(system,enqueue))[0].created).toBe(0);
    await expect(withTenant(system,tx=>tx.execute(sql`select app.financial_onehr_task_email_enroll(${event.id}::uuid,${manager.employmentId}::uuid,'{}'::jsonb)`))).rejects.toThrow();
    const prepare=()=>withOnehrWorkerSource(system,owner,{kind:'event',id:event.id},tx=>enrollOnehrReviewTaskEmailTx(tx,event.id),{downgrade:false});
    vi.stubEnv('MODULE_KILL','performance');expect(await prepare()).toEqual([]);vi.stubEnv('MODULE_KILL','notifications');expect(await prepare()).toEqual([]);vi.stubEnv('MODULE_KILL','');
    await setModule(b.tenantId,'performance','disabled');expect(await prepare()).toEqual([]);await setModule(b.tenantId,'performance','active');
    await setModule(b.tenantId,'notifications','disabled');expect(await prepare()).toEqual([]);await setModule(b.tenantId,'notifications','active');
    // Company-only grants are decided by the same canonical TS owner, never a SQL mirror.
    await setModule(b.tenantId,'performance',null);await setModule(b.tenantId,'performance','active',b.companyId);
    await setModule(b.tenantId,'notifications',null);await setModule(b.tenantId,'notifications','active',b.companyId);
    expect(await prepare()).toEqual([manager.employmentId]);
    await withOnehrWorkerSource(system,owner,{kind:'event',id:event.id},async tx=>{
      expect(await enrollOnehrReviewTaskEmailTx(tx,event.id)).toEqual([manager.employmentId]);
      const [proof]=await tx.execute<{review_company_id:string;recipient_company_id:string;entitlement_snapshot:unknown}>(sql`select review_company_id,recipient_company_id,entitlement_snapshot from app.financial_onehr_task_email_source where transaction_id=pg_current_xact_id() and event_id=${event.id}::uuid`);
      expect(proof).toMatchObject({review_company_id:b.companyId,recipient_company_id:b.companyId});expect(JSON.stringify(proof.entitlement_snapshot)).not.toContain('Private description');
      await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);expect((await enqueue(tx,event.sequence+1))[0].created).toBe(0);expect((await enqueue(tx))[0].created).toBe(0);
    },{downgrade:false});
    await perf.approveOnehrScorecard(mgr,reviewId,(await view(mgr)).revision,true,'Actual pending source completed');expect(await prepare()).toEqual([]);

    // A sweep started with the earlier enabled session must use the current license for email.
    await setModule(b.tenantId,'performance','active');
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Delivered'}],'Completed delivery.');
    const [resultsEvent]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,reviewId),eq(schema.domainEvent.eventType,'onehr.results-submitted')));
    expect(resultsEvent).toBeDefined();
    await setModule(b.tenantId,'notifications','disabled');
    await setModule(b.tenantId,'notifications',null,b.companyId);
    await dispatchNotificationsFromSweep(system,owner);
    const [resultsNotice]=await owner.db.select().from(schema.notification).where(and(eq(schema.notification.sourceEventId,resultsEvent.id),eq(schema.notification.kind,'performance.review-task')));
    expect(resultsNotice).toMatchObject({recipientEmploymentId:manager.employmentId});
    expect(await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.sourceEventId,resultsEvent.id))).toEqual([]);
    const [privateAccess]=await owner.db.execute<{allowed:boolean}>(sql`select has_function_privilege('ai_hr_app','app.financial_onehr_task_email_candidates(uuid)','EXECUTE') or has_table_privilege('ai_hr_app','app.financial_onehr_task_email_source','SELECT') as allowed`);expect(privateAccess.allowed).toBe(false);
  });

  it('reauthorizes delayed review notices from current work instead of event recipient lists',async()=>{
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);
    const matrix=peers[0],outsider=peers[1],id=randomUUID();
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Current assignment',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}]);
    await perf.assignAssessmentKpiModerator(a,reviewId,(await view(a)).revision,id,matrix.employmentId);
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,(await view(self)).kpis,true);
    const read=(task:'setting'|'results'|'competencies'|'plan')=>withTenant(a,tx=>perf.assessmentReviewTaskRecipientsTx(tx,reviewId,task));
    expect(await read('setting')).toEqual([matrix.employmentId]);expect(await read('results')).toEqual([]);
    const system={...a,userId:undefined,personId:undefined};const [actualNotice]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,reviewId),eq(schema.domainEvent.eventType,'onehr.kpi-approval-needed')));expect(actualNotice).toBeDefined();
    expect(await withOnehrWorkerSource(system,owner,{kind:'event',id:actualNotice.id},tx=>perf.assessmentReviewTaskRecipientsTx(tx,reviewId,'setting'))).toEqual([matrix.employmentId]);
    const [notice]=await withOnehrWorkerSource(system,owner,{kind:'event',id:actualNotice.id},tx=>tx.execute<{source:{facts:{managerPerformance:null;managerComplete:boolean;kpis:Record<string,unknown>[]}}}>(sql`select app.onehr_review_notice_source(${reviewId}::uuid) as source`));expect(notice.source).not.toBeNull();expect(notice.source.facts.managerPerformance).toBeNull();expect(Object.keys(notice.source.facts.kpis[0]).sort()).toEqual(['hrOwned','setting','locked','moderatorEmploymentId','checkIn','approvalChain','settingApprovals'].sort());expect(JSON.stringify(notice.source)).not.toContain('Current assignment');
    const [phase]=await owner.db.execute<{pending:boolean}>(sql`select app.financial_onehr_review_task_pending(${JSON.stringify(notice.source)}::jsonb,${matrix.employmentId}::uuid,'setting',now()) as pending`);expect(phase.pending).toBe(true);
    expect(await withTenant(system,tx=>tx.update(schema.onehrReview).set({selfRemark:'No human decision may come from this dispatcher.'}).where(eq(schema.onehrReview.reviewId,reviewId)).returning())).toEqual([]);
    await withTenant(a,tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'onehr',aggregateId:reviewId,eventType:'onehr.kpi-approval-needed',actor:actorOf(a),payload:{phase:'setting',employmentIds:[outsider.employmentId]}}));
    await dispatchNotifications(a);
    const notices=await owner.db.select().from(schema.notification).where(eq(schema.notification.kind,'performance.review-task'));
    expect(notices.length).toBeGreaterThan(0);expect(notices.every(n=>n.recipientEmploymentId===matrix.employmentId)).toBe(true);
    await perf.approveOnehrScorecard(matrix.ctx,reviewId,(await view(matrix.ctx)).revision,true,'Targets verified');
    expect(await read('setting')).toEqual([]);
    for(const event of await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'onehr.kpi-approval-needed')))expect(await withTenant(a,tx=>notificationStillTargets(tx,event.id,'performance.review-task','performance',matrix.employmentId))).toBe(false);
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Delivered'}],'Completed delivery.');
    expect(await read('results')).toEqual([matrix.employmentId]);
    await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,matrix.ctx.userId!));expect(await read('results')).toEqual([]);
    await owner.db.update(schema.appUser).set({archivedAt:null}).where(eq(schema.appUser.id,matrix.ctx.userId!));
    await setModule(b.tenantId,'performance','disabled');expect(await read('results')).toEqual([]);await setModule(b.tenantId,'performance','active');
    let cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.updateOnehrWindows(a,cycleId,cycle.revision,{pm_approve:{opensAt:null,closesAt:new Date(Date.now()-60_000).toISOString()}},'Review window closed.');
    expect(await read('results')).toEqual([]);
    cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.updateOnehrWindows(a,cycleId,cycle.revision,{},'Review window reopened.');
    expect(await read('results')).toEqual([matrix.employmentId]);
    cycle=(await perf.getOnehrCycle(a,cycleId))!;await perf.setAssessmentParticipation(a,cycleId,cycle.revision,subject.employmentId,cycle.participants.find(p=>p.employmentId===subject.employmentId)!.revision,'remove');
    expect(await read('results')).toEqual([]);
  });
  it('uses exactly one HR-assigned moderator and sends that person the task',async()=>{
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);
    const matrix=peers[0],id=randomUUID();
    const kpi={id,title:'Matrix delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId};
    await expect(perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{...kpi,approverEmploymentIds:[matrix.employmentId,manager.employmentId]}])).rejects.toThrow();
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[kpi]);
    await expect(perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{...kpi,moderatorEmploymentId:matrix.employmentId}])).rejects.toThrow(/HR assigns/);
    await perf.assignAssessmentKpiModerator(a,reviewId,(await view(a)).revision,id,matrix.employmentId);
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,(await view(self)).kpis,true);
    await expect(perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'')).rejects.toThrow();
    await dispatchNotifications(a);
    const notifications=await owner.db.select().from(schema.notification);
    expect(notifications.some(n=>n.kind==='performance.review-task'&&n.recipientEmploymentId===matrix.employmentId)).toBe(true);
    await perf.approveOnehrScorecard(matrix.ctx,reviewId,(await view(matrix.ctx)).revision,true,'Targets verified');
    expect((await view(self)).kpis[0].setting).toBe('approved');
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Delivered'}],'Completed agreed delivery.');
    await expect(perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,2,'')).rejects.toThrow();
    await perf.submitAssessmentModeration(matrix.ctx,reviewId,(await view(matrix.ctx)).revision,[{id,actual:3,note:'Verified additional delivery'}],'Verified delivery above the agreed expectation.');
    expect((await view()).kpis[0]).toMatchObject({locked:true,approvedActual:3});
    expect((await view()).managerPerformance).toBe('AE');
  });

  it('grounds IDP fit in shared plans and the owners private competency and KPI drafts only',async()=>{
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Service delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'');await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Completed delivery.'}],'Completed delivery.');
    const input={career:{aspiration:'Become a regional manager',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:randomUUID(),area:'Current skill',dueOn:'',onJob:'Practise current skill in service work',fromOthers:'',formalLearning:'',status:'not_started'}]};
    await perf.saveOnehrPlan(self,reviewId,null,input);
    expect(await perf.getAssessmentIdpFit(mgr,reviewId,{generate:true})).toMatchObject({status:'none',data:null});expect(generateDraft).not.toHaveBeenCalled();
    await perf.saveOnehrPlan(self,reviewId,(await view(self)).plans[0].revision,{...input,careerRevision:(await view(self)).careerProfile!.revision},true);
    await perf.submitOnehrCompetencies(self,reviewId,(await view(self)).revision,{'skill-1':{answer:'yes',remark:'Observed actual delivery every week.'},'skill-2':{answer:'yes',remark:''}},false,'Delivered the service work.');
    await perf.saveAssessmentDraft(mgr,reviewId,(await view()).revision,null,{kind:'competency_manager',answers:{'skill-1':{answer:'no',remark:'PRIVATE_ITEM_CANARY'},'skill-2':{answer:'no',remark:''}},remark:'PRIVATE_REFLECTION_CANARY'});
    await perf.saveAssessmentDraft(mgr,reviewId,(await view()).revision,null,{kind:'moderation',lines:[{id,actual:1,note:'PRIVATE_MODERATION_CANARY'}],remark:'PRIVATE_PM_REMARK_CANARY'});
    expect(await perf.getAssessmentIdpFit(mgr,reviewId)).toMatchObject({pending:true,data:null});
    const result=await perf.getAssessmentIdpFit(mgr,reviewId,{generate:true});expect(result).toMatchObject({source:'plain',data:{verdict:'not_yet'}});expect(result.data?.scores).toContain('Below Expectation');expect(result.data?.scores).toContain('your review Low');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');expect((await perf.getAssessmentIdpFit(mgr,reviewId)).data).toEqual(result.data);expect((await view()).competencyStatus).toBe('submitted');expect((await view()).kpis[0].locked).toBe(false);
    for(const other of [self,peers[1].ctx,{...mgr,tenantId:randomUUID()}])await expect(perf.getAssessmentIdpFit(other,reviewId,{generate:true})).rejects.toThrow();
    expect(await withTenant(self,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);
  });

  it('keeps another IDP approver on saved facts and refuses stale owner access during generation',async()=>{
    const matrix=peers[0],id=randomUUID(),second=randomUUID();
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[id,second].map((key,i)=>({id:key,title:i?'Matrix delivery':'Service delivery',description:'',weightBp:5000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId})));
    await perf.assignAssessmentKpiModerator(a,reviewId,(await view(a)).revision,second,matrix.employmentId);await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,(await view(self)).kpis,true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'');await perf.approveOnehrScorecard(matrix.ctx,reviewId,(await view(matrix.ctx)).revision,true,'');await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:''},{id:second,actual:2,note:''}],'Completed work.');
    await perf.saveOnehrPlan(self,reviewId,null,{career:{aspiration:'Become a regional manager',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:randomUUID(),area:'Current skill',dueOn:'',onJob:'Practise the current skill',fromOthers:'',formalLearning:'',status:'not_started'}]},true);
    await perf.saveAssessmentDraft(mgr,reviewId,(await view()).revision,null,{kind:'moderation',lines:[{id,actual:1,note:'PRIVATE_DRAFT_CANARY'}],remark:'PRIVATE_REMARK_CANARY'});
    const own=await perf.getAssessmentIdpFit(mgr,reviewId,{generate:true}),other=await perf.getAssessmentIdpFit(matrix.ctx,reviewId,{generate:true});
    expect(own.data?.verdict).toBe('not_yet');expect(other).toMatchObject({canGenerate:false,source:'plain',pending:false});expect(other.data?.scores).toContain("line manager's moderation Meet Expectation");expect(JSON.stringify(other)).not.toContain('PRIVATE_');expect(other.data?.scores).not.toContain('Competency');
    expect(await withTenant(matrix.ctx,tx=>tx.select().from(schema.assessmentSummary))).toEqual([]);expect(generateDraft).not.toHaveBeenCalled();
    vi.mocked(resolveActiveAiConfig).mockImplementation(issuedFixtureConfig);
    vi.mocked(generateDraft).mockImplementationOnce(async()=>{await perf.setAssessmentAiSwitch({...a,grants:[{role:'hr_admin',companyId:null}]},'idp',false);return '{}';});
    await expect(perf.getAssessmentIdpFit(mgr,reviewId,{generate:true})).rejects.toThrow(/facts or access changed/);
    expect((await owner.db.select().from(schema.assessmentSummary)).filter(r=>r.kind==='idp')).toHaveLength(1);
  });

  it('keeps profile assignment rosters out of every review projection while HR configuration retains them',async()=>{
    const cycle=(await perf.getOnehrCycle(a,cycleId))!,policy=cycle.policy,targetId=randomUUID(),current=policy.profiles[0];
    const competencies=current.competencies.map((c,index)=>({...c,skillTitle:'Service',skillLevel:index+1}));
    policy.profiles=[{...current,employmentIds:[subject.employmentId,peers[0].employmentId],competencies},{...current,id:targetId,name:'Advanced service',grade:'13',employmentIds:[peers[1].employmentId],competencies:competencies.map(c=>({...c,skillLevel:(c.skillLevel??1)+1}))}];
    await owner.db.update(schema.onehrCycle).set({policy}).where(eq(schema.onehrCycle.cycleId,cycleId));
    await perf.saveOnehrPlan(self,reviewId,null,{career:{aspiration:'Grow service skills',mobility:'stay',mobilityNote:'',targetProfileId:targetId},goals:[]});
    for(const ctx of [self,mgr,a]){
      const visible=await view(ctx);expect(visible.profile?.id).toBe(current.id);expect(visible.careerRoutes.length).toBeGreaterThan(0);expect(visible.careerDirections.length).toBeGreaterThan(0);expect(visible.careerTargetGap?.profile.id).toBe(targetId);
      for(const profile of [...visible.policy.profiles,...visible.careerRoutes.map(r=>r.profile),...visible.careerDirections,visible.careerTargetGap!.profile,visible.profile!])expect(profile).not.toHaveProperty('employmentIds');
    }
    expect((await perf.getOnehrCycle(a,cycleId))!.policy.profiles.map(p=>p.employmentIds)).toEqual([[subject.employmentId,peers[0].employmentId],[peers[1].employmentId]]);
  });
});
