/** Authored UNRUN: actual app-role source replay/admission/settlement. Only transport is mocked.
 * Fictional stored rows are not production payroll calculation or benchmark proof. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi,type MockInstance} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as ai from '../lib/ai';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../core/org';
import {createCycle,openCycle,submitSelfReview,draftManagerReview} from '../core/performance';
import {narrateVerdict} from '../core/payroll-anomaly-narrate';
import {triagePendingClaims} from '../core/input-triage';
import {proposeHypotheses} from '../core/payroll-hypothesis';
import {evaluateBatchAnomalies} from '../core/payroll-anomaly';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,a:SessionContext,beforeAdmission:(()=>Promise<void>)|undefined,alterInput=false,transport:MockInstance<typeof openaiAdapter.generate>;
const PRIOR='2026-04',PERIOD='2026-05',PEERS=12;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{await resetDb();b=await seedBase();for(const code of ['assistant','performance','payroll','claims'])await setModule(b.tenantId,code,'active');a={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(a,{appUserId:b.adminUserId});vi.stubEnv('OPENAI_API_KEY','fictional-source-boundary-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');beforeAdmission=undefined;alterInput=false;
 const original=ai.generateDraft;vi.spyOn(ai,'generateDraft').mockImplementation(async(cfg,args)=>{const hook=beforeAdmission;beforeAdmission=undefined;if(hook)await hook();return original(cfg,alterInput?{...args,prompt:args.prompt+' CHANGED'}:args);});
 transport=vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});return args.prompt.startsWith('Check:')?'The difference is 820.':args.prompt.startsWith('Claim type:')?'{"verdict":"ok"}':args.prompt.startsWith('colleagues on this run:')?'{"claim":"nothing_notable","evidence":[]}':'A fictional editable manager draft.';});
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
async function narrationFixture(){const employmentId=await makeEmp('Fictional narrator subject'),batchId=await makeBatch(PERIOD),[v]=await owner.db.insert(schema.payrollAnomalyVerdict).values({tenantId:b.tenantId,batchId,employmentId,disposition:'review'}).returning(),[finding]=await owner.db.insert(schema.payrollAnomalyFinding).values({tenantId:b.tenantId,verdictId:v.id,detectorId:'ot-spike',severity:'review',facts:{delta:820,hours:14},suggestedAction:'anomaly.review'}).returning();return{verdictId:v.id,findingId:finding.id};}
async function claimFixture(){await setSetting(b.tenantId,'claims.input_triage_enabled',true);a={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};const employmentId=await makeEmp('Fictional claim source'),[type]=await owner.db.insert(schema.claimType).values({tenantId:b.tenantId,code:'FICTIONAL',name:'Fictional transport'}).returning(),[claim]=await owner.db.insert(schema.claimRequest).values({tenantId:b.tenantId,employmentId,claimTypeId:type.id,amount:'312.50',incurredOn:todayInKualaLumpur(),description:'Fictional canonical receipt description jane@fixture.test',status:'pending'}).returning();return claim;}
async function hypothesisFixture(){await setSetting(b.tenantId,'payroll.anomaly_hypotheses_enabled',true);a={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};const f=await seedRun();await evaluateBatchAnomalies(a,{batchId:f.batchId});return f;}
describe('standard Performance actual-source admission',()=>{
 it('reaches exactly one real governed reservation and mocked transport without mutating native review',async()=>{const f=await performanceFixture(),[before]=await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,f.reviewId));const out=await draftManagerReview(f.ctx,{reviewId:f.reviewId});expect(out.draft).toBe('A fictional editable manager draft.');expect(transport).toHaveBeenCalledOnce();const [after]=await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id,f.reviewId));expect(after).toEqual(before);expect(await runs()).toMatchObject([{state:'completed',actualTokens:0}]);expect(vi.mocked(openaiAdapter.generate).mock.calls[0][1].prompt).not.toContain('jane@fixture.test');});
 it.each(['manager','source','closed','input'] as const)('refuses %s drift after gathering but before reservation and never reaches transport',async kind=>{const f=await performanceFixture();if(kind==='input')alterInput=true;else beforeAdmission=async()=>{if(kind==='manager')await setReportingLine(a,{subordinateEmploymentId:f.subject.employmentId,managerEmploymentId:f.other.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});else if(kind==='source')await owner.db.update(schema.performanceReview).set({selfComments:'Changed canonical private evidence'}).where(eq(schema.performanceReview.id,f.reviewId));else await owner.db.update(schema.reviewCycle).set({status:'closed'}).where(eq(schema.reviewCycle.id,f.cycleId));};await expect(draftManagerReview(f.ctx,{reviewId:f.reviewId})).rejects.toThrow();expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it('does not return or audit a stale model draft after native source changed during transport',async()=>{const f=await performanceFixture();vi.mocked(openaiAdapter.generate).mockImplementationOnce(async()=>{await owner.db.update(schema.performanceReview).set({selfComments:'Changed after admitted provider read'}).where(eq(schema.performanceReview.id,f.reviewId));return'Fictional stale model draft';});await expect(draftManagerReview(f.ctx,{reviewId:f.reviewId})).rejects.toThrow();expect(transport).toHaveBeenCalledOnce();expect(await runs()).toMatchObject([{state:'completed'}]);const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,f.reviewId),eq(schema.domainEvent.eventType,'performance-review.ai-draft-generated')));expect(events).toEqual([]);});
});
describe('Payroll narration actual-source admission',()=>{
 it('positive current facts reach one governed call and only native narrative column is changed',async()=>{const f=await narrationFixture();expect(await narrateVerdict(a,{verdictId:f.verdictId})).toMatchObject({narrated:1,rejected:0});expect(transport).toHaveBeenCalledOnce();const [row]=await owner.db.select().from(schema.payrollAnomalyFinding).where(eq(schema.payrollAnomalyFinding.id,f.findingId));expect(row).toMatchObject({facts:{delta:820,hours:14},narrative:'The difference is 820.'});expect(await runs()).toMatchObject([{state:'completed'}]);});
 it.each(['facts','superseded','input'] as const)('refuses %s drift before provider disclosure without reservation or native narrative',async kind=>{const f=await narrationFixture();if(kind==='input')alterInput=true;else beforeAdmission=async()=>{if(kind==='facts')await owner.db.update(schema.payrollAnomalyFinding).set({facts:{delta:999,hours:14}}).where(eq(schema.payrollAnomalyFinding.id,f.findingId));else await owner.db.update(schema.payrollAnomalyVerdict).set({supersededAt:new Date()}).where(eq(schema.payrollAnomalyVerdict.id,f.verdictId));};expect(await narrateVerdict(a,{verdictId:f.verdictId})).toMatchObject({narrated:0});expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it('stale result cannot write a narrative after current native facts changed during mocked transport',async()=>{const f=await narrationFixture();vi.mocked(openaiAdapter.generate).mockImplementationOnce(async()=>{await owner.db.update(schema.payrollAnomalyFinding).set({facts:{delta:999,hours:14}}).where(eq(schema.payrollAnomalyFinding.id,f.findingId));return'The difference is 820.';});await expect(narrateVerdict(a,{verdictId:f.verdictId})).rejects.toThrow();const [row]=await owner.db.select().from(schema.payrollAnomalyFinding).where(eq(schema.payrollAnomalyFinding.id,f.findingId));expect(row.narrative).toBeNull();expect(transport).toHaveBeenCalledOnce();expect(await runs()).toHaveLength(1);});
});
describe('pending Claims actual-source admission',()=>{
 it('positive exact pending claim uses one governed call, redacts direct identifiers and cannot approve or alter money',async()=>{const claim=await claimFixture(),out=await triagePendingClaims(a);expect(out).toMatchObject({asked:1,cleared:1});expect(transport).toHaveBeenCalledOnce();expect(vi.mocked(openaiAdapter.generate).mock.calls[0][1].prompt).not.toContain('jane@fixture.test');const [after]=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claim.id));expect(after).toEqual(claim);expect(await runs()).toMatchObject([{state:'completed'}]);});
 it.each(['status','source','setting','input'] as const)('refuses %s drift before provider without writing a question or creating a reservation',async kind=>{const claim=await claimFixture();if(kind==='input')alterInput=true;else beforeAdmission=async()=>{if(kind==='status')await owner.db.update(schema.claimRequest).set({status:'cancelled'}).where(eq(schema.claimRequest.id,claim.id));else if(kind==='source')await owner.db.update(schema.claimRequest).set({description:'Changed private claim evidence'}).where(eq(schema.claimRequest.id,claim.id));else await setSetting(b.tenantId,'claims.input_triage_enabled',false);};expect(await triagePendingClaims(a)).toMatchObject({asked:0,queried:0});expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,claim.id),eq(schema.domainEvent.eventType,'claim-request.triage-queried')));expect(events).toEqual([]);});
});
describe('Payroll hypothesis canonical cohort/source admission',()=>{
 it('nonvacuous native peer/outlier cohort reaches provider with only canonical dimensionless features',async()=>{const f=await hypothesisFixture(),out=await proposeHypotheses(a,{batchId:f.batchId});expect(out.asked).toBeGreaterThan(0);expect(out.declined).toBeGreaterThan(0);expect(transport.mock.calls.length).toBe(out.asked);for(const call of vi.mocked(openaiAdapter.generate).mock.calls){expect(call[1].prompt).toContain('colleagues on this run:');expect(call[1].prompt).not.toMatch(/bankAccount|1234567890|Fictional|employmentId|personId|Maybank/);}expect((await runs()).length).toBe(out.asked);});
 it.each(['cohort','verdict','setting','input'] as const)('refuses %s drift between canonical cohort gathering and each actual admission',async kind=>{const f=await hypothesisFixture();if(kind==='input')alterInput=true;else beforeAdmission=async()=>{if(kind==='cohort')await owner.db.update(schema.payslip).set({netPay:'1.00'}).where(and(eq(schema.payslip.batchId,f.batchId),eq(schema.payslip.employmentId,f.oddId)));else if(kind==='verdict')await owner.db.update(schema.payrollAnomalyVerdict).set({supersededAt:new Date()}).where(and(eq(schema.payrollAnomalyVerdict.batchId,f.batchId),eq(schema.payrollAnomalyVerdict.employmentId,f.oddId)));else await setSetting(b.tenantId,'payroll.anomaly_hypotheses_enabled',false);};const out=await proposeHypotheses(a,{batchId:f.batchId});expect(out.asked).toBe(0);expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
 it('preserves historical SYSTEM deterministic/no-provider reads without inventing a USER provider carrier',async()=>{const f=await hypothesisFixture(),system={...a,userId:undefined,personId:undefined};const out=await proposeHypotheses(system,{batchId:f.batchId});expect(out.notConfigured).toBe(true);expect(out.asked).toBe(0);expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
});

describe('each later dispatch and original native SYSTEM behavior',()=>{
 it('replays Payroll finding facts before EACH call and cannot store the earlier model prose after a later source changed',async()=>{const f=await narrationFixture();await owner.db.insert(schema.payrollAnomalyFinding).values({tenantId:b.tenantId,verdictId:f.verdictId,detectorId:'ot-spike',severity:'review',facts:{delta:821,hours:14},suggestedAction:'anomaly.review'});vi.mocked(openaiAdapter.generate).mockImplementationOnce(async(_cfg,args)=>{const delta=args.prompt.match(/delta: (\d+)/)?.[1];if(!delta)throw Error('Missing actual native source');await owner.db.update(schema.payrollAnomalyFinding).set({facts:{delta:999,hours:14}}).where(eq(schema.payrollAnomalyFinding.verdictId,f.verdictId));return'The difference is '+delta+'.';});await expect(narrateVerdict(a,{verdictId:f.verdictId})).rejects.toThrow();expect(transport).toHaveBeenCalledOnce();expect(await runs()).toHaveLength(1);const rows=await owner.db.select().from(schema.payrollAnomalyFinding).where(eq(schema.payrollAnomalyFinding.verdictId,f.verdictId));expect(rows).toHaveLength(2);expect(rows.map(row=>row.narrative)).toEqual([null,null]);});
 it('rechecks the next actual pending claim rather than admitting every row from the original gathered list',async()=>{const claim=await claimFixture();await owner.db.insert(schema.claimRequest).values({tenantId:b.tenantId,employmentId:claim.employmentId,claimTypeId:claim.claimTypeId,amount:'42.00',incurredOn:todayInKualaLumpur(),description:'Fictional second actual claim',status:'pending'});vi.mocked(openaiAdapter.generate).mockImplementationOnce(async()=>{await owner.db.update(schema.claimRequest).set({status:'cancelled'}).where(eq(schema.claimRequest.id,claim.id));return'{"verdict":"ok"}';});const out=await triagePendingClaims(a);expect(out.asked).toBe(1);expect(transport).toHaveBeenCalledOnce();expect(await runs()).toHaveLength(1);});
 it('retains native SYSTEM claim/no-provider behavior but does not fabricate a USER or dispatch to the fake-key transport',async()=>{await claimFixture();const system={...a,userId:undefined,personId:undefined},out=await triagePendingClaims(system);expect(out).toMatchObject({notConfigured:true,asked:0,queried:0});expect(transport).not.toHaveBeenCalled();expect(await runs()).toEqual([]);});
});
