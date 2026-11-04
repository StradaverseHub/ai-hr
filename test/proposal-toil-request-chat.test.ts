/** AI v2 W2 slice 2 — a Leave Credit request (time off in lieu) prepared in chat, on fictional data, over the real
 * owners (owner decision, 3 November 2026: "Employee ticks consent on card").
 *
 * The chat preparer asks one question when something is missing; the TOIL review custody runs the leave service's own
 * preparation and saves a sealed review; the signed proposal shows the leave service's own credit; Confirm submits only
 * on an explicit Confirm through the owner service, which re-checks everything. For a First Schedule employee the
 * agreement is only ever the person's own posted tick: Confirm without it refuses and writes nothing, the card's own
 * review can never be confirmed (not even through the TOIL review page's own confirm), the model's details cannot give
 * it, and a proposal cannot carry it. Tampered, expired and someone else's cards are refused; Edit opens the Leave Credit
 * form prefilled. Next request cookies/locale/cache are framework seams; identity SQL, custody, RLS and the leave
 * service's effects are real. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined,locale:'en'}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>browser.locale}));
vi.mock('next/cache',()=>({revalidatePath:()=>undefined}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
import * as schema from '../db/schema';
import {getBrowserCommandSession} from '../lib/session';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createShift,assignDefaultShift,setRestDay} from '../core/roster';
import {setToilPolicy} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {issueProposal,verifyProposal,type Proposal} from '../core/proposals/proposal';
import {prepareChatToilRequestProposal} from '../core/proposals/toil-request';
import {prepareSuggestedProposal} from '../core/proposals/suggested';
import {confirmToilRequestProposal} from '../core/assistant-actions/toil-request-proposal-confirm';
import {confirmToilRequestReview,reopenToilRequestReview} from '../core/assistant-actions/toil-request-review-store';
import {confirmToilRequestProposalAction,editToilRequestProposalAction} from '../app/assistant/toil-request-proposal-actions';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={uid:string;employmentId:string;personId:string};
let base:Base,worker:Person,colleague:Person,restDay:string;
/** The first Sunday of last month: a past date on the HR date owner's calendar, made a rest day on the roster below. */
function lastMonthSunday(){const [y,m]=todayInKualaLumpur().split('-').map(Number),prefix=new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,7);
 for(let d=1;d<=7;d++){const date=prefix+'-'+String(d).padStart(2,'0');if(new Date(date+'T00:00:00Z').getUTCDay()===0)return date;}throw Error('Fictional date unavailable');}
const policy=(extra={})=>({companyId:base.companyId,enabled:true,accrualBasis:'hours_worked' as const,expiryDays:90,onExpiry:'convert_to_pay' as const,allowFirstScheduleEligible:false,
 autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,extendedHoursEnabled:true,...extra});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
async function hire(name:string,basicSalary:number,shiftId:string):Promise<Person>{
 const admin=adminCtx(base);
 const hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 // Monthly wages decide the First Schedule (at or below the pack's overtime wage ceiling): the leave service reads them.
 await setCompensation(admin,{employmentId:hired.employmentId,basicSalary,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
 await assignDefaultShift(admin,{employmentId:hired.employmentId,shiftId});await setRestDay(admin,{employmentId:hired.employmentId,shiftDate:restDay});
 const uid=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(admin,{appUserId:uid});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-toil-chat-custody-key-12345678');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');await setModule(base.tenantId,'toil','active');
 restDay=lastMonthSunday();
 const admin=adminCtx(base);await setToilPolicy(admin,policy());
 const shiftId=(await createShift(admin,{companyId:base.companyId,name:'Fictional chat shift',code:'FIC-'+randomUUID().slice(0,8),startTime:'09:00:00',endTime:'18:00:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5],offPattern:[6]})).id;
 // Above the First Schedule ceiling: no agreement is needed. The colleague is within it.
 worker=await hire('Fictional Leave Credit Worker',8000,shiftId);colleague=await hire('Fictional First Schedule Colleague',1000,shiftId);
 browser.selected=worker.uid;browser.locale='en';vi.stubEnv('DEV_USER_ID',base.adminUserId);
});
const caller=()=>getBrowserCommandSession();
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const requests=()=>owner.db.select().from(schema.replacementLeaveRequest).where(eq(schema.replacementLeaveRequest.tenantId,base.tenantId)).orderBy(schema.replacementLeaveRequest.createdAt);
const credits=()=>owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.tenantId,base.tenantId));
async function reviewState(id:string){const [row]=await owner.db.execute<{state:string}>(sql`select state from app.assistant_own_leave_review where id=${id}::uuid`);return row?.state;}
const WORDS=()=>`I worked on ${restDay} from 8am to 4pm for the stock take, can I get replacement leave for it?`;
const details=(extra:Record<string,unknown>={})=>({workedDate:restDay,claimStart:'08:00',claimEnd:'16:00',reason:'stock take',...extra});
async function card(extra:Record<string,unknown>={}):Promise<Proposal>{
 const outcome=await prepareChatToilRequestProposal(await caller(),details(extra),WORDS());
 if(outcome?.kind!=='proposal')throw Error('Fictional Leave Credit was not prepared: '+JSON.stringify(outcome));
 return outcome.proposal;
}

describe('a Leave Credit request from chat, outside the First Schedule',()=>{
 it('asks one question when the date, a time or the person\'s own reason is missing, and saves nothing',async()=>{
  const ctx=await caller(),future=todayInKualaLumpur(new Date(Date.now()+3*86400000));
  expect(await prepareChatToilRequestProposal(ctx,details({reason:undefined}),WORDS())).toMatchObject({kind:'ask',missing:['reason']});
  // A reason the person did not say is not theirs.
  expect(await prepareChatToilRequestProposal(ctx,details({reason:'urgent client visit'}),WORDS())).toMatchObject({kind:'ask',missing:['reason']});
  expect(await prepareChatToilRequestProposal(ctx,details({claimEnd:'08:00'}),WORDS())).toMatchObject({kind:'ask',missing:['claimEnd']});
  expect(await prepareChatToilRequestProposal(ctx,details({workedDate:future}),WORDS())).toMatchObject({kind:'ask',missing:['workedDate']});
  // The dispatcher the harness calls agrees.
  expect(await prepareSuggestedProposal(ctx,'toil.replacement.request',{workedDate:restDay},WORDS())).toMatchObject({kind:'ask',missing:['claimStart','claimEnd','reason']});
  const [{count}]=await owner.db.execute<{count:number}>(sql`select count(*)::int as count from app.assistant_own_leave_review where tenant_id=${base.tenantId}::uuid`);
  expect(count).toBe(0);
  expect(await requests()).toHaveLength(0);
 });

 it('shows the leave service\'s own credit and submits only on Confirm, for the existing approval, crediting nothing',async()=>{
  const proposal=await card();
  // 08:00 to 16:00 on a rest day is eight hours: one day, the owner's published rule ("8 hours of eligible work = 1.0 day").
  expect(proposal.body).toMatchObject({what:{action:'toil.replacement.request',selectors:{workedDate:restDay,dayType:'rest_day',claimStart:'08:00',claimEnd:'16:00'}},
   forWhom:{subject:'own_employment',subjectId:worker.employmentId},authority:{kind:'person',userId:worker.uid,personId:worker.personId},
   review:{route:'/assistant/toil'},facts:{startDate:restDay,endDate:restDay,plannedStart:'08:00',plannedEnd:'16:00',creditDays:1,outcome:'submitted_not_approved'}});
  expect(proposal.body.what.selectors).not.toHaveProperty('firstScheduleAgreement');
  expect(verifyProposal(proposal,await caller(),new Date()).ok).toBe(true);
  // The reason stays in the sealed review; nothing is submitted yet.
  expect(JSON.stringify(proposal)).not.toMatch(/stock take/);
  expect(await reviewState(proposal.body.review.reference)).toBe('awaiting_confirmation');
  for(const confirm of [undefined,false,'true',1])expect(await confirmToilRequestProposal(await caller(),{proposal,confirm})).toEqual({kind:'refused',reason:'not_confirmed'});
  expect(await requests()).toHaveLength(0);

  // No agreement is needed; one posted anyway changes nothing and is not recorded.
  const submitted=await confirmToilRequestProposalAction({proposal,confirm:true,firstScheduleConsent:true});
  if(submitted.kind!=='submitted')throw Error('Fictional confirmation refused: '+JSON.stringify(submitted));
  const [row]=await requests();
  expect({id:row.id,employment:row.employmentId,status:row.status,days:row.totalDays,reason:row.reason,consent:row.firstScheduleConsent})
   .toEqual({id:submitted.requestId,employment:worker.employmentId,status:'pending',days:'1.00',reason:'stock take',consent:null});
  // A request for the existing approval: nothing is credited until a manager approves it.
  expect(await credits()).toHaveLength(0);
  // Confirming again replays the same receipt; no second request.
  expect(await confirmToilRequestProposal(await caller(),{proposal,confirm:true})).toEqual(submitted);
  expect(await requests()).toHaveLength(1);
 });

 it('two Confirms of one card at the same moment write one request, and a later press answers with that same request',async()=>{
  const proposal=await card(),session=await caller();
  const both=await Promise.all([1,2].map(()=>confirmToilRequestProposal(session,{proposal,confirm:true})));
  expect(await requests()).toHaveLength(1);
  const [row]=await requests();
  // Either both answer with the one request, or one is refused: never a second request.
  for(const result of both)if(result.kind==='submitted')expect(result.requestId).toBe(row.id);
  expect(both.some(result=>result.kind==='submitted'),JSON.stringify(both)).toBe(true);
  expect(await confirmToilRequestProposal(session,{proposal,confirm:true})).toEqual({kind:'submitted',action:'toil.replacement.request',requestId:row.id});
  expect(await requests()).toHaveLength(1);
 });

 it('refuses a tampered, expired or someone else\'s card, and submits nothing',async()=>{
  const proposal=await card();
  const forged=clone(proposal);forged.body.facts!.creditDays=3;
  expect(await confirmToilRequestProposal(await caller(),{proposal:forged,confirm:true})).toEqual({kind:'refused',reason:'signature'});
  expect(await confirmToilRequestProposal(await caller(),{proposal,confirm:true},new Date(Date.parse(proposal.body.expiresAt)))).toEqual({kind:'refused',reason:'expired'});
  browser.selected=colleague.uid;
  expect(await confirmToilRequestProposalAction({proposal,confirm:true,firstScheduleConsent:true})).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await editToilRequestProposalAction({proposal})).toEqual({ok:false,reason:'authority_mismatch'});
  // Correctly signed for the colleague's own login, but pointing at the worker's review and employment: the custody
  // binding refuses the confirmation and Edit refuses the employment.
  const foreign=issueProposal({...clone(proposal.body),authority:{kind:'person',tenantId:base.tenantId,userId:colleague.uid,personId:colleague.personId}} as never);
  expect(await confirmToilRequestProposalAction({proposal:foreign,confirm:true,firstScheduleConsent:true})).toEqual({kind:'refused',reason:'unavailable'});
  expect(await editToilRequestProposalAction({proposal:foreign})).toEqual({ok:false,reason:'unavailable'});
  // A card that claims a bigger credit than the leave service counted, re-signed: the sealed review decides.
  browser.selected=worker.uid;
  const inflated=issueProposal({...clone(proposal.body),facts:{...proposal.body.facts,creditDays:2}} as never);
  expect(await confirmToilRequestProposal(await caller(),{proposal:inflated,confirm:true})).toEqual({kind:'refused',reason:'changed'});
  expect(await requests()).toHaveLength(0);
 });

 it('Edit opens the Leave Credit form on My Leave with the date and window, and no reason or agreement',async()=>{
  const proposal=await card();
  const edit=await editToilRequestProposalAction({proposal});
  expect(edit).toEqual({ok:true,href:`/leave?credit=1&creditDate=${restDay}&creditStart=08%3A00&creditEnd=16%3A00`});
  expect(JSON.stringify(edit)).not.toMatch(/stock|consent|agree/i);
  expect(await requests()).toHaveLength(0);
 });
});

describe('a Leave Credit request from chat, within the First Schedule',()=>{
 beforeEach(async()=>{await setToilPolicy(adminCtx(base),policy({allowFirstScheduleEligible:true}));browser.selected=colleague.uid;});

 it('prepares nothing when the company does not allow First Schedule employees to bank replacement leave',async()=>{
  await setToilPolicy(adminCtx(base),policy({allowFirstScheduleEligible:false}));
  expect(await prepareChatToilRequestProposal(await caller(),details(),WORDS())).toBeNull();
 });

 it('asks for the agreement on the card, refuses Confirm without the person\'s own tick, and submits with it',async()=>{
  const proposal=await card();
  expect(proposal.body.what.selectors).toMatchObject({workedDate:restDay,firstScheduleAgreement:'required'});
  expect(proposal.body.facts).toMatchObject({creditDays:1});
  // The proposal says the agreement is asked for; it never carries one.
  expect(JSON.stringify(proposal.body)).not.toMatch(/firstScheduleConsent/);
  // The card's sealed review records no agreement.
  const held=await reopenToilRequestReview(await caller(),proposal.body.review.reference);
  if(held.kind!=='prepared')throw Error('Fictional review not pending');
  expect({consent:held.review.content.firstScheduleConsent,pending:held.review.content.firstScheduleConsentPending,reviewed:held.review.review.firstScheduleConsent})
   .toEqual({consent:false,pending:true,reviewed:false});

  for(const tick of [undefined,false,'true','on',1])
   expect(await confirmToilRequestProposalAction({proposal,confirm:true,firstScheduleConsent:tick})).toEqual({kind:'refused',reason:'consent_required'});
  expect(await requests()).toHaveLength(0);

  const submitted=await confirmToilRequestProposalAction({proposal,confirm:true,firstScheduleConsent:true});
  if(submitted.kind!=='submitted')throw Error('Fictional confirmation refused: '+JSON.stringify(submitted));
  const [row]=await requests();
  expect({id:row.id,employment:row.employmentId,status:row.status,days:row.totalDays,consent:row.firstScheduleConsent})
   .toEqual({id:submitted.requestId,employment:colleague.employmentId,status:'pending',days:'1.00',consent:true});
  expect(await credits()).toHaveLength(0);
  // The card's own review, which recorded no agreement, is retired rather than left waiting.
  expect(await reviewState(proposal.body.review.reference)).toBe('discarded');
  expect(await confirmToilRequestProposalAction({proposal,confirm:true,firstScheduleConsent:true})).toEqual({kind:'refused',reason:'retired'});
  expect(await requests()).toHaveLength(1);
 });

 it('two Confirms of one card at the same moment write one request: the leave owner\'s per-employment lock and its reviewed sources refuse the other',async()=>{
  const proposal=await card(),session=await caller();
  const both=await Promise.all([1,2].map(()=>confirmToilRequestProposal(session,{proposal,confirm:true,firstScheduleConsent:true})));
  const submitted=both.filter(result=>result.kind==='submitted');
  expect(submitted,JSON.stringify(both)).toHaveLength(1);
  const [row]=await requests();
  expect(await requests()).toHaveLength(1);expect(row.id).toBe(submitted[0].kind==='submitted'?submitted[0].requestId:'');
  // A third press, later, writes nothing either.
  expect(await confirmToilRequestProposal(session,{proposal,confirm:true,firstScheduleConsent:true})).toMatchObject({kind:'refused'});
  expect(await requests()).toHaveLength(1);
 });

 it('can never be confirmed without the tick: not through the TOIL review page\'s own confirm, not from the model\'s details',async()=>{
  // The model sends an agreement in its details: it is ignored, and the review still awaits the person's own.
  const proposal=await card({firstScheduleConsent:'true',consent:'yes',firstScheduleConsentPending:'false'});
  expect(proposal.body.what.selectors.firstScheduleAgreement).toBe('required');
  const held=await reopenToilRequestReview(await caller(),proposal.body.review.reference);
  if(held.kind!=='prepared')throw Error('Fictional review not pending');
  expect(held.review.content).toMatchObject({firstScheduleConsent:false,firstScheduleConsentPending:true});
  // The review page's own confirm, with the right handle and digest, still writes nothing: the leave service refuses it.
  await expect(confirmToilRequestReview(await caller(),{action:'toil.replacement.request',contractVersion:1,actionId:held.review.actionId,reviewedDigest:held.review.reviewedDigest})).rejects.toThrow();
  expect(await confirmToilRequestProposal(await caller(),{proposal,confirm:true})).toEqual({kind:'refused',reason:'consent_required'});
  expect(await requests()).toHaveLength(0);
 });

 it('cannot carry the agreement in a proposal: the schema refuses it, and a re-signed card without the request is refused',async()=>{
  const proposal=await card();
  // The closed fact vocabulary has no agreement, so no preparer can sign one.
  expect(()=>issueProposal({...clone(proposal.body),facts:{...proposal.body.facts,firstScheduleConsent:true}} as never)).toThrow();
  // A card signed without the agreement request (as a non-First-Schedule card) is refused: the sealed review decides.
  const {firstScheduleAgreement:_dropped,...selectors}=proposal.body.what.selectors;void _dropped;
  const unasked=issueProposal({...clone(proposal.body),what:{...proposal.body.what,selectors}} as never);
  expect(await confirmToilRequestProposal(await caller(),{proposal:unasked,confirm:true})).toEqual({kind:'refused',reason:'changed'});
  // A selector that claims the agreement was given is just a tampered card.
  const forged=clone(proposal);forged.body.what.selectors.firstScheduleAgreement='given';
  expect(await confirmToilRequestProposal(await caller(),{proposal:forged,confirm:true})).toEqual({kind:'refused',reason:'signature'});
  expect(await requests()).toHaveLength(0);
 });

 it('Edit opens the form with the agreement box for the person to tick, never ticked from the link',async()=>{
  const proposal=await card();
  const edit=await editToilRequestProposalAction({proposal});
  expect(edit).toEqual({ok:true,href:`/leave?credit=1&creditDate=${restDay}&creditStart=08%3A00&creditEnd=16%3A00`});
  expect(JSON.stringify(edit)).not.toMatch(/consent|agree/i);
 });
});
