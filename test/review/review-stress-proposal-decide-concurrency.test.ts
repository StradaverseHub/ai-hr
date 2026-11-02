/** REVIEW (stress and concurrency) — a leave decide proposal confirmed concurrently, and raced against the
 * existing Approvals page decision. Written as if at test/review/proposal-decide-concurrency.test.ts.
 *
 * Expected to PASS on current code (coverage): single use is not app-level. The proposal never applies anything
 * (core/proposals/leave-decide.ts); its confirm packet goes to the existing review custody
 * (core/assistant-actions/leave-decision-review-store.ts -> generic-review-custody.ts confirm), whose native
 * source takes FOR UPDATE NOWAIT on the leave_request and its steps and re-nominates under the lock
 * (core/leave.ts:6114-6141), and whose digest binds the request/step xmin (core/leave.ts:6149-6159). The
 * Approvals page path (decideLeave, core/leave.ts:6014, FOR UPDATE at 6038) waits on the same row lock.
 * Mocks mirror test/proposal-leave-decide-roundtrip.test.ts; identity SQL, custody, RLS and effects are real. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,inArray} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined}));
vi.mock('server-only',()=>({}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(key:string)=>key==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
vi.mock('../../lib/workos',()=>({currentWorkosSession:async()=>null}));
vi.mock('../../lib/real-auth',()=>({appOrigin:()=>'https://fixture.test'}));
import * as schema from '../../db/schema';
import {handleConfiguredModuleActionBrowserCommand} from '../../core/assistant-actions/module-action-server';
import {getSession} from '../../lib/session';
import {grantAssistant} from '../../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../../core/org';
import {decideLeave,requestLeave} from '../../packs/leave/service';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {leaveDecideReviewPackets,prepareLeaveDecideProposal} from '../../core/proposals/leave-decide';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from '../harness';

type Hired={uid:string;employmentId:string;personId:string};
let base:Base,applicant:Hired,manager:Hired,requestId:string;
const DECISION_EVENTS=['leave-request.approved','leave-request.rejected','leave-request.step.approved'];
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
async function hire(name:string,role:'employee'|'manager'|'hr_admin'='employee'):Promise<Hired>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const uid=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(adminCtx(base),{appUserId:uid});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
const login=(who:Hired)=>{browser.selected=who.uid;vi.stubEnv('DEV_USER_ID',who.uid);return getSession();};
async function post(packet:unknown){const response=await handleConfiguredModuleActionBrowserCommand(new Request('https://fixture.test/api/assistant/module-actions',
 {method:'POST',headers:{origin:'https://fixture.test','content-type':'application/json'},body:JSON.stringify(packet)}));return{status:response.status,body:await response.json() as Record<string,unknown>};}
const decisionEvents=()=>owner.db.select({id:schema.domainEvent.id,eventType:schema.domainEvent.eventType}).from(schema.domainEvent)
 .where(and(eq(schema.domainEvent.tenantId,base.tenantId),eq(schema.domainEvent.aggregateId,requestId),inArray(schema.domainEvent.eventType,DECISION_EVENTS)));
async function currentStep(){const [step]=await owner.db.select({id:schema.leaveApprovalStep.id}).from(schema.leaveApprovalStep).where(eq(schema.leaveApprovalStep.leaveRequestId,requestId)).orderBy(schema.leaveApprovalStep.stepIndex);return step?.id??null;}
async function packets(){
 const proposal=await prepareLeaveDecideProposal(await getSession(),{leaveRequestId:requestId,currentStepId:await currentStep(),decision:'approved',rejectReason:null});
 if(proposal.kind!=='proposal')throw Error('Fictional fixture did not prepare a proposal.');
 const built=leaveDecideReviewPackets(proposal.proposal,await getSession(),new Date());if(!built.ok)throw Error('packets refused: '+built.reason);
 return built.packets;
}

beforeEach(async()=>{
 vi.stubEnv('NODE_ENV','development');vi.stubEnv('REAL_AUTH','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-leave-decide-proposal-key-123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 applicant=await hire('Fictional Race Applicant');manager=await hire('Fictional Race Manager');
 await setReportingLine(adminCtx(base),{subordinateEmploymentId:applicant.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));const date=next.toISOString().slice(0,10);
 requestId=(await requestLeave(await login(applicant),{employmentId:applicant.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional race reason'})).leaveRequestId;
 await login(manager);
});

describe('decide proposal under concurrency',()=>{
 it('REVIEW pass: 8 concurrent confirms of one decide proposal record exactly one decision',async()=>{
  const p=await packets();
  const results=await Promise.all(Array.from({length:8},()=>post(p.confirm)));
  // Each attempt either completed (the first, or a replay of its receipt) or was refused; none applied twice.
  // (The refusal status code is the review command's own; only "not completed twice" is asserted.)
  expect(results.filter(result=>result.status===200&&result.body.kind==='completed').length).toBeGreaterThanOrEqual(1);
  expect(await decisionEvents()).toHaveLength(1);
  // A later confirm replays the same receipt.
  const again=await post(p.confirm);
  expect(again.status).toBe(200);expect(await decisionEvents()).toHaveLength(1);
 },60_000);

 it('REVIEW pass: a proposal confirm raced against the Approvals page decision applies one decision only',async()=>{
  const p=await packets();
  const session=await getSession();
  const [card,page]=await Promise.allSettled([post(p.confirm),decideLeave(session,{leaveRequestId:requestId,decision:'approved'})]);
  // Whichever lost refuses (stale step, changed review, or lock not available); exactly one decision exists.
  expect([card.status,page.status]).toContain('fulfilled');
  expect(await decisionEvents()).toHaveLength(1);
  // The fixture's chain may have more than one step, so the request can stay pending after one step decision
  // (first CI run 41342629736); what matters is that the first step was decided exactly once.
  const steps=await owner.db.select({status:schema.leaveApprovalStep.status}).from(schema.leaveApprovalStep).where(eq(schema.leaveApprovalStep.leaveRequestId,requestId)).orderBy(schema.leaveApprovalStep.stepIndex);
  expect(steps[0]?.status).toBe('approved');
 },60_000);

 it('REVIEW pass: a proposal confirmed after the Approvals page already decided is refused and adds nothing',async()=>{
  const p=await packets();
  await decideLeave(await getSession(),{leaveRequestId:requestId,decision:'approved'});
  const late=await post(p.confirm);
  expect(late.status===200&&late.body.kind==='completed').toBe(false);
  expect(await decisionEvents()).toHaveLength(1);
 },60_000);
});
