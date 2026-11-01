/** REVIEW (security-surface) — who picks the leave request an approval proposal is prepared for.
 * Written as test/review/review-suggested-decide-choice.test.ts. Database test on fictional data, fixture copied from
 * test/proposal-leave-decide-roundtrip.test.ts.
 * core/proposals/suggested.ts says the preparer "never picks one" with several pending: the person answers with a
 * number. In code, the number (`details.request`) and the date (`details.startDate`) are MODEL arguments; the only
 * check on the person's words is asksToApprove(), which looks for the word "approve". So with several pending and a
 * person who never named one, a model (or text steering it) can choose which applicant's review is prepared. The
 * native gate still limits it to requests assigned to the caller, and the person still confirms on the review page:
 * no authority is gained, but the ADR-0170 §3.15 "the person chooses" rule is not enforced by code. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined}));
vi.mock('server-only',()=>({}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(key:string)=>key==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
vi.mock('../../lib/workos',()=>({currentWorkosSession:async()=>null}));
vi.mock('../../lib/real-auth',()=>({appOrigin:()=>'https://fixture.test'}));
import * as schema from '../../db/schema';
import {getSession} from '../../lib/session';
import {grantAssistant} from '../../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../../core/org';
import {requestLeave} from '../../packs/leave/service';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {asksToApprove,prepareSuggestedProposal} from '../../core/proposals/suggested';
import {HARNESS_TEST_ONLY,runTurn} from '../../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../../core/harness/memory';
import {scriptedModel} from '../harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from '../harness';

type Hired={uid:string;employmentId:string;personId:string};
let base:Base,manager:Hired,firstId:string,secondId:string,laterDate:string;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
async function hire(name:string):Promise<Hired>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const uid=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(adminCtx(base),{appUserId:uid});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
const login=(who:Hired)=>{browser.selected=who.uid;vi.stubEnv('DEV_USER_ID',who.uid);return getSession();};
const nextWorkday=(from:string)=>{const day=new Date(from+'T00:00:00Z');do{day.setUTCDate(day.getUTCDate()+1);}while([0,6].includes(day.getUTCDay()));return day.toISOString().slice(0,10);};
beforeEach(async()=>{
 vi.stubEnv('NODE_ENV','development');vi.stubEnv('REAL_AUTH','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-review-choice-key-123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-review-proposal-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 const first=await hire('Fictional Choice Applicant One'),second=await hire('Fictional Choice Applicant Two');manager=await hire('Fictional Choice Manager');
 for(const who of [first,second])await setReportingLine(adminCtx(base),{subordinateEmploymentId:who.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const date=nextWorkday(todayInKualaLumpur());laterDate=nextWorkday(date);
 firstId=(await requestLeave(await login(first),{employmentId:first.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional reason one'})).leaveRequestId;
 secondId=(await requestLeave(await login(second),{employmentId:second.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:laterDate,endDate:laterDate,durationType:'full_day',reason:'Fictional reason two'})).leaveRequestId;
});

describe('the person, not the model, chooses which request is prepared',()=>{
 const words='Please approve the leave request waiting for me.';
 it('REVIEW medium: a request number the person never said prepares nothing',async()=>{
  const me=await login(manager);
  const outcome=await prepareSuggestedProposal(me,'approvals.leave.decide',{request:'2'},words);
  expect(outcome?.kind).not.toBe('proposal');
 });
 it('REVIEW medium: a start date the person never said prepares nothing',async()=>{
  const me=await login(manager);
  const outcome=await prepareSuggestedProposal(me,'approvals.leave.decide',{startDate:laterDate},words);
  expect(outcome?.kind).not.toBe('proposal');
 });
 it('REVIEW medium: through the harness, a model that picks a number itself gets no proposal',async()=>{
  const me=await login(manager);
  const model=scriptedModel([{calls:[{name:'suggest_action',args:{action:'approvals.leave.decide',details:{request:'2'}}}]},{final:{reply:'Open the review page to confirm.',mode:'propose'}}]);
  const turn=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:me,conversationId:randomUUID(),question:words,scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  expect(turn.proposals).toEqual([]);
 });
 it('REVIEW low: "do not approve" is not read as asking to approve',()=>{
  expect(asksToApprove('Do not approve anything yet, just list them.')).toBe(false);
 });
});

describe('REVIEW pass: the native gate still bounds the choice',()=>{
 it('REVIEW pass: a number the person said prepares exactly that request, for the assigned approver only',async()=>{
  const me=await login(manager);
  const chosen=await prepareSuggestedProposal(me,'approvals.leave.decide',{request:'2'},'Approve number 2.');
  if(chosen?.kind!=='proposal')throw Error('The chosen request was not prepared.');
  expect(chosen.proposal.body).toMatchObject({forWhom:{subjectId:secondId}});
  const outsider=await hire('Fictional Unassigned Approver');
  expect(await prepareSuggestedProposal(await login(outsider),'approvals.leave.decide',{request:'1'},'Approve number 1.')).toBeNull();
  expect(firstId).not.toBe(secondId);
 },60000);
});
