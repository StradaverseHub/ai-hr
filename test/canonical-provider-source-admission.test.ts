/** Authored UNRUN: actual app-role source replay/admission/settlement. Only transport is mocked.
 * Fictional stored rows are not production payroll calculation or benchmark proof. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi,type MockInstance} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as governance from '../core/ai-governance';
import * as assistantReads from '../core/assistant-read-session';
import {submitFeedback,generateFeedbackPlan,cancelFeedback} from '../core/feedback';
import {cancelClaim,updateClaimType,deleteClaimDraft,saveClaimDraft} from '../core/claims';
import {askAssistant} from '../core/assistant';
import * as schema from '../db/schema';
import * as ai from '../lib/ai';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../core/org';
import {createCycle,openCycle,submitSelfReview,submitManagerReview,draftManagerReview} from '../core/performance';
import {narrateVerdict} from '../core/payroll-anomaly-narrate';
import {triagePendingClaims} from '../core/input-triage';
import {proposeHypotheses} from '../core/payroll-hypothesis';
import {evaluateBatchAnomalies} from '../core/payroll-anomaly';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,a:SessionContext,beforeAdmission:(()=>Promise<void>)|undefined,afterSourceReplay:((tx:Tx)=>Promise<void>)|undefined,alterInput=false,transport:MockInstance<typeof openaiAdapter.generate>;
const PRIOR='2026-04',PERIOD='2026-05',PEERS=12;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{await resetDb();b=await seedBase();for(const code of ['assistant','performance','payroll','claims'])await setModule(b.tenantId,code,'active');a={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(a,{appUserId:b.adminUserId});vi.stubEnv('OPENAI_API_KEY','fictional-source-boundary-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
 // Every main Assistant question seals its strategy-use marker with the operator secret that the customer
 // environment check requires (deploy/check-customer-env.mjs); without it the marker fails closed.
 vi.stubEnv('AI_CONFIG_SECRET','fictional-source-admission-marker-secret');beforeAdmission=undefined;afterSourceReplay=undefined;alterInput=false;
 // Composed admission checks run inner-first. The Assistant composes its per-turn source replay OVER the
 // strategy-marker recheck, so the tail must follow only the OUTERMOST check of a chain (the source
 // replay), never an inner one that a later check still wraps. Single-check chains are unchanged.
 const issue=governance.withAiAdmissionCheck,spied=new WeakSet<object>(),wrapped=new WeakSet<object>();
 vi.spyOn(governance,'withAiAdmissionCheck').mockImplementation((config,feature,check)=>{if(spied.has(config))wrapped.add(config);let self:object|undefined;
  const issued=issue(config,feature,async(tx,request)=>{await check(tx,request);if(self&&wrapped.has(self))return;const tail=afterSourceReplay;afterSourceReplay=undefined;if(tail)await tail(tx);});
  self=issued;spied.add(issued);return issued;});
 const original=ai.generateDraft;vi.spyOn(ai,'generateDraft').mockImplementation(async(cfg,args)=>{const hook=beforeAdmission;beforeAdmission=undefined;if(hook)await hook();return original(cfg,alterInput?{...args,prompt:args.prompt+' CHANGED'}:args);});
 transport=vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return args.system.includes('recorded field references')?'{"fields":["delta"]}':args.system.includes('claim description is insufficient')?'{"requestDetail":true}':args.system.includes('native-adjudicated payroll hypothesis')?'{"claim":"nothing_notable","evidence":[]}':args.system.includes('implementation-plan outline')?'{"steps":["reproduce","change","verify","review"]}':'{"items":[0]}';});
});
const runs=()=>owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,b.tenantId));
async function makeEmp(name: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name}_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({
      tenantId: b.tenantId,
      personId: p.id,
      companyId: b.companyId,
      hiredOn: '2020-01-01',
      paymentMethod: 'bank_transfer',
    })
    .returning({ id: schema.employment.id });
  // A complete statutory profile, so `missing-bank-profile` and `missing-tax-profile` stay silent and
  // the verdict really is an AUTO-CLEAR rather than a flag this layer would then skip.
  await owner.db.insert(schema.employeeStatutoryMy).values({
    tenantId: b.tenantId,
    personId: p.id,
    bankName: 'Maybank',
    bankAccountNo: '1234567890',
  });
  return e.id;
}

async function makeBatch(period: string) {
  const [pp] = await owner.db
    .insert(schema.payPeriod)
    .values({ tenantId: b.tenantId, companyId: b.companyId, period, status: 'open' })
    .returning({ id: schema.payPeriod.id });
  const [batch] = await owner.db
    .insert(schema.payrollBatch)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      payPeriodId: pp.id,
      payPeriod: period,
      batchDate: `${period}-28`,
      status: 'processed',
    })
    .returning({ id: schema.payrollBatch.id });
  return batch.id;
}

/**
 * One clean payslip, scaled by `k` from a 5,000 baseline.
 *
 * EVERY COMPONENT SCALES TOGETHER, deliberately. If deductions or the statutory blob held still while
 * gross moved, their SHARES would move too and the odd one out would become material on four features
 * instead of one — the test would still pass and would no longer be testing what it says it tests.
 */
async function addPayslip(batchId: string, employmentId: string, period: string, k: number) {
  const days = period === PRIOR ? '30.00' : '31.00';
  await owner.db.insert(schema.attendance).values({
    tenantId: b.tenantId,
    employmentId,
    attendanceDate: `${period}-04`,
    workedMinutes: 480,
  });
  const m = (n: number) => (n * k).toFixed(2);
  await owner.db.insert(schema.payslip).values({
    tenantId: b.tenantId,
    batchId,
    employmentId,
    basicSalary: m(5000),
    grossPay: m(5000),
    totalDeductions: m(800),
    netPay: m(4200),
    employerCost: m(5700),
    daysWorked: days,
    statutory: { epfEmployee: 550 * k, socsoEmployee: 24.75 * k, eisEmployee: 9.9 * k, pcb: 215 * k },
  });
}

/** The run this whole layer exists for: everybody up 6%, one person flat, and no rule says anything. */
async function seedRun(): Promise<{ batchId: string; oddId: string; peerId: string }> {
  const prior = await makeBatch(PRIOR);
  const current = await makeBatch(PERIOD);
  const ids: string[] = [];
  for (let i = 0; i < PEERS; i++) ids.push(await makeEmp(`peer${i}`));
  const oddId = await makeEmp('odd');
  for (const id of ids) {
    await addPayslip(prior, id, PRIOR, 1);
    await addPayslip(current, id, PERIOD, 1.06);
  }
  await addPayslip(prior, oddId, PRIOR, 1);
  await addPayslip(current, oddId, PERIOD, 1);
  return { batchId: current, oddId, peerId: ids[0] };
}

async function performanceFixture(){const year=todayInKualaLumpur().slice(0,4),hire=(name:string)=>hireEmployee(a,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:String(Number(year)-1)+'-01-01'}),manager=await hire('Fictional Manager'),subject=await hire('Fictional Employee'),other=await hire('Fictional Other Manager');await setReportingLine(a,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:String(Number(year)-1)+'-01-01'});const userId=await createAppUser(b.tenantId,manager.personId,'manager');await grantAssistant(a,{appUserId:userId});const ctx:SessionContext={...await entitledCtx(b,['manager']),userId,personId:manager.personId,roles:['manager'],grants:[{role:'manager',companyId:null}]};const {cycleId}=await createCycle(a,{name:'Fictional current cycle',periodStart:year+'-01-01',periodEnd:year+'-12-31'});await openCycle(a,{cycleId});const [review]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,subject.employmentId)));await submitSelfReview(a,{reviewId:review.id,selfRating:4,selfComments:'PRIVATE current employee evidence jane@fixture.test',goalsSummary:'Actual fictional source summary'});return{ctx,reviewId:review.id,cycleId,subject,other};}
async function narrationFixture(){const employmentId=await makeEmp('Fictional narrator subject'),batchId=await makeBatch(PERIOD),[v]=await owner.db.insert(schema.payrollAnomalyVerdict).values({tenantId:b.tenantId,batchId,employmentId,disposition:'review'}).returning(),[finding]=await owner.db.insert(schema.payrollAnomalyFinding).values({tenantId:b.tenantId,verdictId:v.id,detectorId:'net-swing',severity:'review',facts:{delta:820,hours:14},suggestedAction:'anomaly.review'}).returning();return{verdictId:v.id,findingId:finding.id};}
async function claimFixture(){await setSetting(b.tenantId,'claims.input_triage_enabled',true);a={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};const employmentId=await makeEmp('Fictional claim source'),[type]=await owner.db.insert(schema.claimType).values({tenantId:b.tenantId,code:'FICTIONAL',name:'Fictional transport jane@fixture.test'}).returning(),[claim]=await owner.db.insert(schema.claimRequest).values({tenantId:b.tenantId,employmentId,claimTypeId:type.id,amount:'312.50',incurredOn:todayInKualaLumpur(),description:'expenses',status:'pending'}).returning();return claim;}
async function hypothesisFixture(){await setSetting(b.tenantId,'payroll.anomaly_hypotheses_enabled',true);a={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};const f=await seedRun();await evaluateBatchAnomalies(a,{batchId:f.batchId});return f;}
describe('standard Performance actual-source admission',()=>{
 it('reaches exactly one real governed reservation and mocked transport without mutating native review',async()=>{const f=await performanceFixture(),[before]=await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,f.reviewId));const out=await draftManagerReview(f.ctx,{reviewId:f.reviewId});expect(out.draft).toContain('Employee self-assessment:');expect(transport).toHaveBeenCalledOnce();const [after]=await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,f.reviewId));expect(after).toEqual(before);expect(await runs()).toMatchObject([{state:'completed',actualTokens:0}]);expect(vi.mocked(openaiAdapter.generate).mock.calls[0][1].prompt).not.toContain('jane@fixture.test');});
 it.each(['manager','source','closed','input'] as const)('refuses %s drift after gathering but before reservation and never reaches transport',async kind=>{const f=await performanceFixture();if(kind==='input')alterInput=true;else beforeAdmission=async()=>{if(kind==='manager')await setReportingLine(a,{subordinateEmploymentId:f.subject.employmentId,managerEmploymentId:f.other.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});else if(kind==='source')await owner.db.update(schema.performanceReview).set({selfComments:'Changed canonical private evidence'}).where(eq(schema.performanceReview.id,f.reviewId));else await owner.db.update(schema.reviewCycle).set({status:'closed'}).where(eq(schema.reviewCycle.id,f.cycleId));};await expect(draftManagerReview(f.ctx,{reviewId:f.reviewId})).rejects.toThrow();expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it('does not return or audit a stale model draft after native source changed during transport',async()=>{const f=await performanceFixture();vi.mocked(openaiAdapter.generate).mockImplementationOnce(async()=>{await owner.db.update(schema.performanceReview).set({selfComments:'Changed after admitted provider read'}).where(eq(schema.performanceReview.id,f.reviewId));return'{"items":[0]}';});await expect(draftManagerReview(f.ctx,{reviewId:f.reviewId})).rejects.toThrow();expect(transport).toHaveBeenCalledOnce();expect(await runs()).toMatchObject([{state:'completed'}]);const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,f.reviewId),eq(schema.domainEvent.eventType,'performance-review.ai-draft-generated')));expect(events).toEqual([]);});
});
describe('Payroll narration actual-source admission',()=>{
 it('positive current facts reach one governed call and only native narrative column is changed',async()=>{const f=await narrationFixture();expect(await narrateVerdict(a,{verdictId:f.verdictId})).toMatchObject({narrated:1,rejected:0});expect(transport).toHaveBeenCalledOnce();const [row]=await owner.db.select().from(schema.payrollAnomalyFinding).where(eq(schema.payrollAnomalyFinding.id,f.findingId));expect(row).toMatchObject({facts:{delta:820,hours:14},narrative:'Recorded delta: 820.'});expect(await runs()).toMatchObject([{state:'completed'}]);});
 it.each(['facts','superseded','input'] as const)('refuses %s drift before provider disclosure without reservation or native narrative',async kind=>{const f=await narrationFixture();if(kind==='input')alterInput=true;else beforeAdmission=async()=>{if(kind==='facts')await owner.db.update(schema.payrollAnomalyFinding).set({facts:{delta:999,hours:14}}).where(eq(schema.payrollAnomalyFinding.id,f.findingId));else await owner.db.update(schema.payrollAnomalyVerdict).set({supersededAt:new Date()}).where(eq(schema.payrollAnomalyVerdict.id,f.verdictId));};expect(await narrateVerdict(a,{verdictId:f.verdictId})).toMatchObject({narrated:0});expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it('stale result cannot write a narrative after current native facts changed during mocked transport',async()=>{const f=await narrationFixture();vi.mocked(openaiAdapter.generate).mockImplementationOnce(async()=>{await owner.db.update(schema.payrollAnomalyFinding).set({facts:{delta:999,hours:14}}).where(eq(schema.payrollAnomalyFinding.id,f.findingId));return'{"fields":["delta"]}';});await expect(narrateVerdict(a,{verdictId:f.verdictId})).rejects.toThrow();const [row]=await owner.db.select().from(schema.payrollAnomalyFinding).where(eq(schema.payrollAnomalyFinding.id,f.findingId));expect(row.narrative).toBeNull();expect(transport).toHaveBeenCalledOnce();expect(await runs()).toHaveLength(1);});
});
describe('pending Claims actual-source admission',()=>{
 it('positive exact pending claim requests missing detail in one governed call without exposing identifiers, approving or altering money',async()=>{const claim=await claimFixture(),out=await triagePendingClaims(a);expect(out).toMatchObject({asked:1,queried:1,cleared:0});expect(transport).toHaveBeenCalledOnce();expect(vi.mocked(openaiAdapter.generate).mock.calls[0][1].prompt).not.toContain('jane@fixture.test');const [after]=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claim.id));expect(after).toEqual(claim);expect(await runs()).toMatchObject([{state:'completed'}]);});
 it.each(['status','source','setting','input'] as const)('refuses %s drift before provider without writing a question or creating a reservation',async kind=>{const claim=await claimFixture();if(kind==='input')alterInput=true;else beforeAdmission=async()=>{if(kind==='status')await owner.db.update(schema.claimRequest).set({status:'cancelled'}).where(eq(schema.claimRequest.id,claim.id));else if(kind==='source')await owner.db.update(schema.claimRequest).set({description:'Changed private claim evidence'}).where(eq(schema.claimRequest.id,claim.id));else await setSetting(b.tenantId,'claims.input_triage_enabled',false);};expect(await triagePendingClaims(a)).toMatchObject({asked:0,queried:0});expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,claim.id),eq(schema.domainEvent.eventType,'claim-request.triage-queried')));expect(events).toEqual([]);});
});
describe('Payroll hypothesis canonical cohort/source admission',()=>{
 it('nonvacuous native peer/outlier cohort reaches provider with only canonical dimensionless features',async()=>{const f=await hypothesisFixture(),out=await proposeHypotheses(a,{batchId:f.batchId});expect(out.asked).toBeGreaterThan(0);expect(out.declined).toBeGreaterThan(0);expect(transport.mock.calls.length).toBe(out.asked);for(const call of vi.mocked(openaiAdapter.generate).mock.calls){const payload=JSON.parse(call[1].prompt) as {candidates:{claim:string;evidence:string[]}[]};expect(payload.candidates.length).toBeGreaterThan(0);expect(payload.candidates.every(candidate=>candidate.evidence.length>0)).toBe(true);expect(call[1].prompt).not.toMatch(/\d|netChangePctZ\s*:/);expect(call[1].prompt).not.toMatch(/bankAccount|1234567890|Fictional|employmentId|personId|Maybank/);}expect((await runs()).length).toBe(out.asked);});
 it.each(['cohort','verdict','setting','input'] as const)('refuses %s drift between canonical cohort gathering and each actual admission',async kind=>{const f=await hypothesisFixture();if(kind==='input')alterInput=true;else beforeAdmission=async()=>{if(kind==='cohort')await owner.db.update(schema.payslip).set({netPay:'1.00'}).where(and(eq(schema.payslip.batchId,f.batchId),eq(schema.payslip.employmentId,f.oddId)));else if(kind==='verdict')await owner.db.update(schema.payrollAnomalyVerdict).set({supersededAt:new Date()}).where(and(eq(schema.payrollAnomalyVerdict.batchId,f.batchId),eq(schema.payrollAnomalyVerdict.employmentId,f.oddId)));else await setSetting(b.tenantId,'payroll.anomaly_hypotheses_enabled',false);};const out=await proposeHypotheses(a,{batchId:f.batchId});expect(out.asked).toBe(0);expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it('preserves historical SYSTEM deterministic/no-provider reads without inventing a USER provider carrier',async()=>{const f=await hypothesisFixture(),system={...a,userId:undefined,personId:undefined};const out=await proposeHypotheses(system,{batchId:f.batchId});expect(out.notConfigured).toBe(true);expect(out.asked).toBe(0);expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
});

describe('each later dispatch and original native SYSTEM behavior',()=>{
 it('replays Payroll finding facts before EACH call and cannot store the earlier model prose after a later source changed',async()=>{const f=await narrationFixture();await owner.db.insert(schema.payrollAnomalyFinding).values({tenantId:b.tenantId,verdictId:f.verdictId,detectorId:'net-swing',severity:'review',facts:{delta:821,hours:14},suggestedAction:'anomaly.review'});vi.mocked(openaiAdapter.generate).mockImplementationOnce(async(_cfg,args)=>{const payload=JSON.parse(args.prompt) as {fields:string[]};if(!payload.fields.includes('delta'))throw Error('Missing actual native source field');expect(args.prompt).not.toMatch(/820|821|999/);await owner.db.update(schema.payrollAnomalyFinding).set({facts:{delta:999,hours:14}}).where(eq(schema.payrollAnomalyFinding.verdictId,f.verdictId));return'{"fields":["delta"]}';});await expect(narrateVerdict(a,{verdictId:f.verdictId})).rejects.toThrow();expect(transport).toHaveBeenCalledOnce();expect(await runs()).toHaveLength(1);const rows=await owner.db.select().from(schema.payrollAnomalyFinding).where(eq(schema.payrollAnomalyFinding.verdictId,f.verdictId));expect(rows).toHaveLength(2);expect(rows.map(row=>row.narrative)).toEqual([null,null]);});
 it('rechecks the next actual pending claim rather than admitting every row from the original gathered list',async()=>{const claim=await claimFixture();await owner.db.insert(schema.claimRequest).values({tenantId:b.tenantId,employmentId:claim.employmentId,claimTypeId:claim.claimTypeId,amount:'42.00',incurredOn:todayInKualaLumpur(),description:'expenses',status:'pending'});vi.mocked(openaiAdapter.generate).mockImplementationOnce(async()=>{await owner.db.update(schema.claimRequest).set({status:'cancelled'}).where(eq(schema.claimRequest.id,claim.id));return'{"requestDetail":true}';});const out=await triagePendingClaims(a);expect(out.asked).toBe(1);expect(transport).toHaveBeenCalledOnce();expect(await runs()).toHaveLength(1);});
 it('retains native SYSTEM claim/no-provider behavior but does not fabricate a USER or dispatch to the fake-key transport',async()=>{await claimFixture();const system={...a,userId:undefined,personId:undefined},out=await triagePendingClaims(system);expect(out).toMatchObject({notConfigured:true,asked:0,queried:0});expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
});

/** Actual cross-connection callback-tail ownership, not a changed cached hash. */
async function observedBlocked(holder:number,writer:Promise<unknown>){
 const observe=(async()=>{for(let i=0;i<60;i++){const [row]=await owner.client`select exists(select 1 from pg_stat_activity a where ${holder}=any(pg_blocking_pids(a.pid))) as blocked`;if(row.blocked===true)return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Native writer did not expose the expected actual blocking relationship');})();
 await Promise.race([observe,writer.then(()=>{throw Error('Native writer committed before admission released source ownership');})]);
}
describe('exact native source ownership at callback tail',()=>{
 it('keeps Feedback withdrawal behind the exact planning-source row until admission commits',async()=>{
  await setSetting(b.tenantId,'feedback.ai_planning_enabled',true);a={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};const {id}=await submitFeedback(a,{category:'issue',title:'Fictional private workflow feedback',description:'A fictional source description for a human plan.'});let withdrawal:Promise<void>|undefined;
  afterSourceReplay=async tx=>{const [holder]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);withdrawal=cancelFeedback(a,{feedbackId:id});await observedBlocked(holder.pid,withdrawal);expect((await owner.db.select().from(schema.feedbackRequest).where(eq(schema.feedbackRequest.id,id)))[0].status).toBe('open');expect(transport).not.toHaveBeenCalled();};
  try{await Promise.allSettled([generateFeedbackPlan(a,{feedbackId:id})]);}finally{await withdrawal;}expect(transport).toHaveBeenCalledOnce();expect((await owner.db.select().from(schema.feedbackRequest).where(eq(schema.feedbackRequest.id,id)))[0].status).toBe('cancelled');
 });
 it.each(['cancel','type'] as const)('holds actual triage %s source against its native writer through admission',async kind=>{
  const claim=await claimFixture(),[type]=await owner.db.select().from(schema.claimType).where(eq(schema.claimType.id,claim.claimTypeId));let writer:Promise<void>|undefined;
  afterSourceReplay=async tx=>{const [holder]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);writer=kind==='cancel'?cancelClaim(a,claim.id):updateClaimType(a,{id:type.id,name:'Changed canonical type label',requiresReceipt:type.requiresReceipt,defaultTaxable:type.defaultTaxable});await observedBlocked(holder.pid,writer);expect(transport).not.toHaveBeenCalled();expect((await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claim.id)))[0].status).toBe('pending');};
  try{await Promise.allSettled([triagePendingClaims(a)]);}finally{await writer;}expect(transport).toHaveBeenCalledOnce();if(kind==='cancel')expect((await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claim.id)))[0].status).toBe('cancelled');else expect((await owner.db.select().from(schema.claimType).where(eq(schema.claimType.id,type.id)))[0].name).toBe('Changed canonical type label');
 });
 it('prevents actual standard manager-review writes at callback tail, then permits native submission after admission',async()=>{
  const f=await performanceFixture(),[before]=await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,f.reviewId)),submission={reviewId:f.reviewId,managerRating:4,overallRating:4,managerComments:'Actual fictional native manager decision.'};
  afterSourceReplay=async()=>{await expect(submitManagerReview(f.ctx,submission)).rejects.toThrow();expect((await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,f.reviewId)))[0]).toEqual(before);};
  await draftManagerReview(f.ctx,{reviewId:f.reviewId});expect(transport).toHaveBeenCalledOnce();await submitManagerReview(f.ctx,submission);expect((await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,f.reviewId)))[0].managerComments).toBe(submission.managerComments);
 });
 it('protects the Assistant own-claim list against native deletion and insertion phantoms without granting other claims',async()=>{
  const employmentId=await makeEmp('Actual fictional claim-list owner'),[employment]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employmentId)),userId=await createAppUser(b.tenantId,employment.personId,'employee');await grantAssistant(a,{appUserId:userId});const self:SessionContext={...await entitledCtx(b,['employee']),userId,personId:employment.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]},[type]=await owner.db.insert(schema.claimType).values({tenantId:b.tenantId,code:'SOURCE_LIST',name:'Fictional own claim type'}).returning(),input={employmentId,claimTypeId:type.id,amount:12,incurredOn:todayInKualaLumpur(),description:'Fictional own draft.'},draft=await saveClaimDraft(self,input);
  const chat=vi.spyOn(openaiAdapter,'converse').mockResolvedValue({text:'{"version":1,"mode":"answer","blocks":[{"kind":"fact","read":0,"card":0,"fact":0}]}',stop:'end',toolCalls:[],usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0},usageReported:true});
  // Source preparation and provider admission both replay the native list. Observe its REAL reader
  // only inside the actual conversation admission, independent of derived config/check identities.
  let admitting=false,tailReads=0;const originalConverse=ai.converse,originalRead=assistantReads.withAssistantAdmissionReadsTx;
  vi.spyOn(ai,'converse').mockImplementation(async(configuration,args)=>{admitting=true;try{return await originalConverse(configuration,args);}finally{admitting=false;}});
  const checkNativeRead:typeof originalRead=async(context,tx,consume)=>{
   const result=await originalRead(context,tx,consume);
   if(admitting){tailReads++;expect(tailReads).toBe(1);expect(result).toBe(true);expect(chat).not.toHaveBeenCalled();
    // The caller's actual admission transaction still owns native list row/phantom protections.
    await expect(deleteClaimDraft(self,draft.id)).rejects.toThrow();await expect(saveClaimDraft(self,input)).rejects.toThrow();
    expect(await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.employmentId,employmentId))).toHaveLength(1);
   }
   return result;
  };
  vi.spyOn(assistantReads,'withAssistantAdmissionReadsTx').mockImplementation(checkNativeRead);
  await askAssistant(self,{question:'show my claims'});expect(tailReads).toBe(1);expect(chat).toHaveBeenCalledOnce();expect(chat.mock.calls[0][1].tools).toEqual([]);expect(chat.mock.calls[0][1].cacheKey).toBeUndefined();expect(JSON.stringify(chat.mock.calls[0][1].turns)).not.toMatch(/Fictional own draft\.|show my claims/);await deleteClaimDraft(self,draft.id);const replacement=await saveClaimDraft(self,input);expect(replacement.id).not.toBe(draft.id);
 });
});

describe('ordinary authorized triage caller retains app-role locking access',()=>{
 it('owns type/item/request through existing grants and USING policies without gaining catalogue write permission',async()=>{
  const claim=await claimFixture(),[employment]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,claim.employmentId)),userId=await createAppUser(b.tenantId,employment.personId,'employee'),[item]=await owner.db.insert(schema.claimItem).values({tenantId:b.tenantId,claimTypeId:claim.claimTypeId,code:'fixture_self',name:'Fictional ordinary-caller item'}).returning();
  await owner.db.update(schema.claimRequest).set({claimItemId:item.id}).where(eq(schema.claimRequest.id,claim.id));const self:SessionContext={...await entitledCtx(b,['employee']),userId,personId:employment.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const [privileges]=await withTenant(self,tx=>tx.execute<{role:string;type_update:boolean;item_update:boolean;request_update:boolean}>(sql`select current_user as role,has_table_privilege(current_user,'public.claim_type','UPDATE') as type_update,has_table_privilege(current_user,'public.claim_item','UPDATE') as item_update,has_table_privilege(current_user,'public.claim_request','UPDATE') as request_update`));expect(privileges).toEqual({role:'ai_hr_app',type_update:true,item_update:true,request_update:true});
  expect(await triagePendingClaims(self)).toMatchObject({asked:1,queried:1,cleared:0});expect(transport).toHaveBeenCalledOnce();expect(await runs()).toMatchObject([{userId,state:'completed'}]);
  const [type]=await owner.db.select().from(schema.claimType).where(eq(schema.claimType.id,claim.claimTypeId));await expect(updateClaimType(self,{id:type.id,name:'Forbidden ordinary-caller rename',defaultTaxable:type.defaultTaxable,requiresReceipt:type.requiresReceipt})).rejects.toThrow();expect((await owner.db.select().from(schema.claimType).where(eq(schema.claimType.id,type.id)))[0]).toEqual(type);
 });
});
