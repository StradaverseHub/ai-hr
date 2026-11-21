/** AI v2 W6, "AI where the work is": the approver recommendation on /approvals and on the single leave request
 * review page, rendered from fictional owner fixtures.
 *
 * The owners are replaced by fixtures that behave like them on the property under test: the worker gate answers
 * on or off; the approvals owner (pendingLeaveTaskMetadata) answers only the requests assigned to the caller; the
 * recommender answers with four checks in its own shape, including the internal rule-version references the
 * screen must turn into labels. The view mapping (app/assistant/centre/recommendation.ts) and the components
 * are real, and expected text is written out literally from the English catalogue. The decision path is the
 * real server action module with its decide services replaced, so the follow-up is observed where it is made. */
import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre} from './helpers/ai-centre-messages';
import {resolveServerTree} from './helpers/server-tree';
import aiCentreEn from '../messages/ai-centre/en.json';
import {RECOMMENDATION_VERDICTS} from '../core/semantic-model/entities-recommend';

const fx=vi.hoisted(()=>({gate:true,assigned:{} as Record<string,string[]>,recommend:vi.fn(),follow:vi.fn(),decideLeave:vi.fn(),decideLeaveDate:vi.fn(),decideLeaveDates:vi.fn(),redirects:[] as string[]}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');
 const {enWithAiCentre:messages}=await import('./helpers/ai-centre-messages');
 return {getTranslations:async(namespace?:string)=>createTranslator({locale:'en',messages:messages as never,namespace:namespace as never}),getLocale:async()=>'en'};
});
vi.mock('@/core/agent-registry/controls',()=>({workerRunGate:async()=>({run:fx.gate,reasons:fx.gate?[]:['switched_off']})}));
// The approvals owner: only the requests assigned to this login.
vi.mock('@/packs/leave/service',()=>({pendingLeaveTaskMetadata:async(s:{userId:string})=>(fx.assigned[s.userId]??[]).map(id=>({id}))}));
vi.mock('@/core/recommenders/leave-decision',()=>({RECOMMENDER_WORKER:'approver_recommendation',
 recommendLeaveDecision:(...args:unknown[])=>fx.recommend(...args),recordRecommendationDecision:(...args:unknown[])=>fx.follow(...args)}));
// The decision path's own collaborators (app/approvals/actions.ts), so the action module itself runs.
vi.mock('next/cache',()=>({revalidatePath:()=>undefined}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{fx.redirects.push(url);throw Object.assign(Error('NEXT_REDIRECT'),{digest:'NEXT_REDIRECT;'+url});},notFound:()=>{throw Error('NOT_FOUND');},useRouter:()=>({push:()=>undefined,refresh:()=>undefined}),usePathname:()=>'/approvals',useSearchParams:()=>new URLSearchParams()}));
vi.mock('@/lib/session',()=>({getSession:async()=>MANAGER}));
vi.mock('@/lib/scope',()=>({scopedSession:async()=>({s:MANAGER,scopeIds:['co-a']})}));
vi.mock('@/lib/authz-model',()=>({isAdmin:()=>false}));
vi.mock('@/core/entitlements',()=>({isModuleEnabledOrFalse:()=>false}));
vi.mock('@/packs/rewards/service',()=>({pendingRewardReviews:async()=>[]}));
vi.mock('@/packs/attendance/service',()=>({hasPendingAttendanceParticipantAssignment:async()=>false}));
vi.mock('@/core/approvals-inbox',()=>({listPendingTasks:async()=>[]}));
vi.mock('@/core/leave',()=>({decideLeave:(...args:unknown[])=>fx.decideLeave(...args),decideLeaveDate:(...args:unknown[])=>fx.decideLeaveDate(...args),decideLeaveDates:(...args:unknown[])=>fx.decideLeaveDates(...args),decideLeaveCancellation:vi.fn()}));
vi.mock('@/app/me/actions',()=>({localizeLeaveError:async(e:unknown)=>(e as Error).message}));
vi.mock('@/core/attendance',()=>({decideAttendanceCorrection:vi.fn(),MissingAttendanceRejectReasonError:class extends Error{}}));
vi.mock('@/core/profile',()=>({decideProfileChange:vi.fn()}));
vi.mock('@/core/claims',()=>({decideClaim:vi.fn(),ClaimError:class extends Error{}}));
vi.mock('@/core/offboarding',()=>({decideResignation:vi.fn()}));
vi.mock('@/core/employment-review',()=>({decideReview:vi.fn(),submitManagerEvaluation:vi.fn()}));
vi.mock('@/core/read',()=>({myEmployment:async()=>({employmentId:'emp-manager'})}));
vi.mock('@/lib/attendance-workflow-error-message',()=>({attendanceWorkflowErrorMessage:async()=>''}));
vi.mock('@/lib/attendance-workflow-v3',()=>({AttendanceLevelError:class extends Error{}}));
vi.mock('@/lib/public-error',()=>({publicErrorMessage:(e:unknown)=>(e as Error).message}));

import {LeaveRecommendationRow,PassingFilter,RECOMMEND_ON_OPEN,passingIds,readApprovalRecommendations} from '../app/approvals/leave-recommendations';
import {LeaveDecideControls} from '../app/approvals/leave-decide-controls';
import {BulkRowCheckbox,BulkSelectionProvider} from '../app/approvals/bulk-selection';
import {approveLeaveAction,bulkDecideAction,decideLeaveDateAction,decideLeaveDatesAction} from '../app/approvals/actions';
import {LeaveDateBreakdown} from '../app/approvals/leave-date-breakdown';

const ctx=(userId:string,roles:string[])=>({tenantId:'fictional-tenant',userId,personId:'person-'+userId,roles,grants:[]}) as never;
const MANAGER=ctx('login-manager',['manager']);
const ADMIN=ctx('login-admin',['admin']);
// Fictional leave request ids (the view and the bulk parser accept UUIDs only).
const LR_PASS='6a1e2b30-1111-4c4c-8d8d-000000000001',LR_REVIEW='6a1e2b30-1111-4c4c-8d8d-000000000002',LR_FOREIGN='6a1e2b30-1111-4c4c-8d8d-000000000003';
const RECORD_PASS='9f00aa00-2222-4b4b-9e9e-000000000001',RECORD_REVIEW='9f00aa00-2222-4b4b-9e9e-000000000002';
const POLICY='leave_type:5d1c0a2e-3333-4f4f-8a8a-000000000009@v3',RECOMMENDER='leave_decision_recommender:v1';
type Result='pass'|'fail'|'unusual'|'missing';
const check=(name:string,result:Result,version:string,blocking=false)=>({check:name,owner:'fixture',ruleVersion:version,result,blocking});
// The recommender's own shape: four checks, each with its rule version; the verdict from the checks.
function recommenderFixture(){
 fx.recommend.mockImplementation(async(_s:unknown,input:{leaveRequestId:string})=>{
  const review=input.leaveRequestId===LR_REVIEW;
  const checks=[check('balance_covers','pass',POLICY),check('own_overlap',review?'fail':'pass',RECOMMENDER,review),check('team_coverage',review?'unusual':'pass',RECOMMENDER),check('policy_limits','pass',POLICY)];
  return {kind:'recommendation',recommendation:{kind:'teras.recommendation',version:1,action:'approvals.leave.decide',verdict:review?'needs_review':'recommend_approve',checks,
   failedRules:checks.filter(c=>c.result==='fail').map(c=>({check:c.check,blocking:c.blocking,ruleVersion:c.ruleVersion})),recommenderVersion:RECOMMENDER,recordId:review?RECORD_REVIEW:RECORD_PASS}};
 });
}
const wrap=(node:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
async function showRows(session:never,ids:string[]){
 const recommendations=await readApprovalRecommendations(session,ids);
 const tree=await resolveServerTree(<table><tbody>{ids.map(id=><LeaveRecommendationRow key={id} leaveRequestId={id} recommendations={recommendations} columns={8}/>)}</tbody></table>);
 return {recommendations,view:wrap(tree)};
}

beforeEach(()=>{fx.gate=true;fx.assigned={'login-manager':[LR_PASS,LR_REVIEW]};fx.recommend.mockReset();fx.follow.mockReset();fx.decideLeave.mockReset();fx.decideLeaveDate.mockReset();fx.decideLeaveDates.mockReset();fx.redirects=[];recommenderFixture();});
afterEach(()=>cleanup());

describe('the recommendation on the approval pages',()=>{
 it('shows the assigned approver the verdict, all four checks with their versions, and how it was prepared',async()=>{
  const {view}=await showRows(MANAGER,[LR_PASS,LR_REVIEW]);
  const pass=view.container.querySelector(`[data-recommendation-row="${LR_PASS}"] [data-recommendation]`)!;
  expect(pass.getAttribute('data-recommendation')).toBe('recommend_approve');
  expect(within(pass as HTMLElement).getByText('Recommend approve: every check passed')).toBeInTheDocument();
  expect([...pass.querySelectorAll('[data-check]')].map(row=>`${row.getAttribute('data-check')}:${row.getAttribute('data-result')}`))
   .toEqual(['balance_covers:pass','own_overlap:pass','team_coverage:pass','policy_limits:pass']);
  expect(pass.textContent).toContain('The balance covers the days requested.');
  expect(pass.textContent).toContain('No other leave of the applicant overlaps these dates.');
  expect(pass.textContent).toContain('Nobody else you can see is away on these dates.');
  expect(pass.textContent).toContain("The leave type's document and date rules are met.");
  // The versions as labels, never the internal references.
  expect(within(pass as HTMLElement).getAllByText('Leave type rules, version 3')).toHaveLength(2);
  expect(within(pass as HTMLElement).getAllByText('Recommendation checks, version 1')).toHaveLength(2);
  expect(pass.textContent).not.toContain('5d1c0a2e');expect(pass.textContent).not.toContain('leave_decision_recommender');
  expect(pass.textContent).toContain('This is advice. You decide with Approve or Reject.');
  const prepared=pass.querySelector('[data-recommendation-prepared]')!;
  expect(prepared.querySelector('summary')!.textContent).toBe('How this was prepared');
  expect([...prepared.querySelectorAll('dt')].map(term=>term.textContent)).toEqual(['Authority','What was read','AI model\'s part','Your decision','Record']);
  expect(prepared.textContent).toContain('You are the assigned approver');
  expect(prepared.textContent).toContain('Kept as an outcome record. When you decide, whether you followed the recommendation is added to it.');

  const review=view.container.querySelector(`[data-recommendation-row="${LR_REVIEW}"] [data-recommendation]`)!;
  expect(review.getAttribute('data-recommendation')).toBe('needs_review');
  expect(review.textContent).toContain('Needs your review');
  expect(review.textContent).toContain('The applicant already has approved leave on some of these dates.');
  expect(review.textContent).toContain('A leave rule would refuse this request as it stands.');
  expect(review.textContent).toContain('Others you can see are away on some of these dates.');
  // The row spans the whole leave table.
  expect(view.container.querySelector(`[data-recommendation-row="${LR_PASS}"] td`)!.getAttribute('colspan')).toBe('8');
  expect(fx.recommend.mock.calls.map(call=>(call[1] as {leaveRequestId:string}).leaveRequestId)).toEqual([LR_PASS,LR_REVIEW]);
 });

 it('shows nothing, and runs nothing, for a request the viewer is not the assigned approver of',async()=>{
  // An administrator who can read the rows but is assigned none of them.
  const {view,recommendations}=await showRows(ADMIN,[LR_PASS,LR_REVIEW]);
  expect(recommendations.active).toBe(false);
  expect(view.container.querySelector('[data-recommendation]')).toBeNull();
  expect(fx.recommend).not.toHaveBeenCalled();
  cleanup();
  // The manager sees their own two, never the one assigned elsewhere on the same page.
  const mixed=await showRows(MANAGER,[LR_PASS,LR_FOREIGN]);
  expect(mixed.view.container.querySelectorAll('[data-recommendation]')).toHaveLength(1);
  expect(mixed.view.container.querySelector(`[data-recommendation-row="${LR_FOREIGN}"]`)).toBeNull();
  expect(fx.recommend.mock.calls.map(call=>(call[1] as {leaveRequestId:string}).leaveRequestId)).toEqual([LR_PASS]);
 });

 it('shows none while the worker is switched off, and never asks the recommender',async()=>{
  fx.gate=false;
  const {view,recommendations}=await showRows(MANAGER,[LR_PASS,LR_REVIEW]);
  expect(recommendations.active).toBe(false);
  expect(view.container.querySelector('[data-recommendation]')).toBeNull();
  expect(view.container.querySelector('[data-recommendation-loader]')).toBeNull();
  expect(fx.recommend).not.toHaveBeenCalled();
 });

 it('shows nothing when the recommender itself refuses between the gate and the run',async()=>{
  fx.recommend.mockResolvedValue({kind:'unavailable',reason:'stopped'});
  const {view}=await showRows(MANAGER,[LR_PASS]);
  expect(view.container.querySelector('[data-recommendation]')).toBeNull();
 });

 it('has no reject verdict anywhere: two verdicts in the model, the catalogue and the screen',async()=>{
  expect([...RECOMMENDATION_VERDICTS].sort()).toEqual(['needs_review','recommend_approve']);
  expect(Object.keys(aiCentreEn.aiCentre.recommendation.verdict).sort()).toEqual(['needs_review','recommend_approve']);
  const {view}=await showRows(MANAGER,[LR_PASS,LR_REVIEW]);
  const shown=[...view.container.querySelectorAll('[data-recommendation]')].map(el=>el.getAttribute('data-recommendation'));
  expect(shown).toEqual(['recommend_approve','needs_review']);
  expect(view.container.textContent).not.toMatch(/recommend(?:ed)? reject/i);
  expect(view.container.textContent).not.toMatch(/reject_|recommend_reject/);
 });

 it('runs at most the cap on one page open; a row past it offers its own review page',async()=>{
  const ids=Array.from({length:RECOMMEND_ON_OPEN+2},(_,i)=>`6a1e2b30-1111-4c4c-8d8d-${String(100+i).padStart(12,'0')}`);
  fx.assigned={'login-manager':ids};
  const {view}=await showRows(MANAGER,ids);
  expect(fx.recommend).toHaveBeenCalledTimes(RECOMMEND_ON_OPEN);
  expect(view.container.querySelectorAll('[data-recommendation]')).toHaveLength(RECOMMEND_ON_OPEN);
  const links=[...view.container.querySelectorAll('a[data-recommendation-loader]')];
  expect(links.map(link=>link.textContent)).toEqual(['Show the recommendation','Show the recommendation']);
  expect(links[0].getAttribute('href')).toBe(`/approvals?category=leave&task=leave&requestId=${ids[RECOMMEND_ON_OPEN]}#approvals-leave--${ids[RECOMMEND_ON_OPEN]}`);
 });
});

describe('"Passes every check"',()=>{
 it('counts only recommend_approve, and is offered only with several leave requests and one that passes',async()=>{
  const recommendations=await readApprovalRecommendations(MANAGER,[LR_PASS,LR_REVIEW]);
  expect([...passingIds(recommendations)]).toEqual([LR_PASS]);
  const href={all:'/approvals?category=leave#approvals-leave',passing:'/approvals?category=leave&leaveFilter=passing#approvals-leave'};
  let view=wrap(await resolveServerTree(<PassingFilter href={href} active={false} count={1} total={2}/>));
  const link=screen.getByRole('link',{name:'Passes every check (1)'});
  expect(link.getAttribute('href')).toBe(href.passing);
  expect(screen.getByRole('link',{name:'All leave requests'})).toHaveAttribute('aria-current','page');
  expect(view.container.textContent).not.toContain('Nothing is approved automatically.');
  cleanup();
  view=wrap(await resolveServerTree(<PassingFilter href={href} active count={1} total={2}/>));
  expect(screen.getByRole('link',{name:'Passes every check (1)'})).toHaveAttribute('aria-current','page');
  expect(view.container.textContent).toContain('Showing only requests that pass every check. Select them, then approve or reject them with a confirmation. Nothing is approved automatically.');
  cleanup();
  view=wrap(await resolveServerTree(<PassingFilter href={href} active={false} count={1} total={1}/>));
  expect(view.container.querySelector('[data-recommendation-filter]')).toBeNull();
  cleanup();
  view=wrap(await resolveServerTree(<PassingFilter href={href} active={false} count={0} total={5}/>));
  expect(view.container.querySelector('[data-recommendation-filter]')).toBeNull();
 });

 it('selects nothing by itself; the approver selects, and the bulk decision confirms before posting each request with its record',async()=>{
  const rows=[{id:LR_PASS,type:'leave' as const,category:'leave' as const,recommendationRecordId:RECORD_PASS}];
  wrap(<BulkSelectionProvider rows={rows} sort="" category="leave"><BulkRowCheckbox id={LR_PASS} type="leave"/></BulkSelectionProvider>);
  // Nothing is selected on arrival, so there is no bar to approve from.
  expect(screen.queryByRole('button',{name:'Approve selected'})).toBeNull();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button',{name:'Approve selected'}));
  // The confirmation, with the item it will post: the request and its recommendation's record.
  const dialog=screen.getByRole('dialog');
  const items=JSON.parse((dialog.querySelector('input[name="items"]') as HTMLInputElement).value);
  expect(items).toEqual([{type:'leave',id:LR_PASS,recommendationRecordId:RECORD_PASS}]);
 });
});

describe('the decision the approver makes beside it',()=>{
 const form=(fields:Record<string,string>)=>{const data=new FormData();for(const [k,v] of Object.entries(fields))data.set(k,v);return data;};
 it('seals only a final approval, not an intermediate approval step',async()=>{
  fx.decideLeave.mockResolvedValueOnce({status:'pending'}).mockResolvedValueOnce({status:'approved'});
  const request=form({id:LR_PASS,decision:'approved'});
  await expect(approveLeaveAction(request)).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.redirects.at(-1)).toBe('/approvals?toast=Approval+stage+recorded');
  await expect(approveLeaveAction(request)).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.redirects.at(-1)).toBe('/approvals?toast=Leave+approved&approvalSeal=1');
 });
 it('posts the record with each decision control',()=>{
  const view=wrap(<LeaveDecideControls id={LR_PASS} labels={{approve:'Approve',reject:'Reject',rejectReason:'Reason'}} nav={{category:'leave',sort:''}} recommendationRecordId={RECORD_PASS}/>);
  expect([...view.container.querySelectorAll('input[name="recommendationRecordId"]')].map(input=>(input as HTMLInputElement).value)).toEqual([RECORD_PASS]);
  fireEvent.click(screen.getByRole('button',{name:'Reject'}));
  expect([...view.container.querySelectorAll('input[name="recommendationRecordId"]')].map(input=>(input as HTMLInputElement).value)).toEqual([RECORD_PASS,RECORD_PASS]);
  cleanup();
  const without=wrap(<LeaveDecideControls id={LR_PASS} labels={{approve:'Approve',reject:'Reject',rejectReason:'Reason'}} nav={{category:'leave',sort:''}}/>);
  expect(without.container.querySelector('input[name="recommendationRecordId"]')).toBeNull();
 });

 it('appends the agreement follow-up after the decision commits, and not when it fails',async()=>{
  const order:string[]=[];
  fx.decideLeave.mockImplementation(async()=>{order.push('decide');});
  fx.follow.mockImplementation(async()=>{order.push('follow');return {id:'followup-1'};});
  await expect(approveLeaveAction(form({id:LR_PASS,decision:'approved',recommendationRecordId:RECORD_PASS,category:'leave',sort:''}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.decideLeave).toHaveBeenCalledWith(MANAGER,{leaveRequestId:LR_PASS,decision:'approved',rejectReason:undefined});
  expect(fx.follow).toHaveBeenCalledWith(MANAGER,{recordId:RECORD_PASS,decision:'approved'});
  expect(order).toEqual(['decide','follow']);
  expect(fx.redirects[fx.redirects.length-1]).toBe('/approvals?category=leave&toast=Leave+approved');

  // A disagreement is the same follow-up with the native decision; the recommender records it as not followed.
  fx.follow.mockClear();
  await expect(approveLeaveAction(form({id:LR_PASS,decision:'rejected',rejectReason:'Fictional clash',recommendationRecordId:RECORD_PASS}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.follow).toHaveBeenCalledWith(MANAGER,{recordId:RECORD_PASS,decision:'rejected'});

  // The decision failed: no follow-up.
  fx.follow.mockClear();fx.decideLeave.mockRejectedValue(Error('Fixture: not your step'));
  await expect(approveLeaveAction(form({id:LR_PASS,decision:'approved',recommendationRecordId:RECORD_PASS}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.follow).not.toHaveBeenCalled();
  expect(fx.redirects[fx.redirects.length-1]).toContain('error=Fixture');
 });

 it('never fails a committed decision because the follow-up could not be written, and ignores a malformed record id',async()=>{
  fx.decideLeave.mockResolvedValue(undefined);
  fx.follow.mockRejectedValue(Error('Fixture record outage'));
  await expect(approveLeaveAction(form({id:LR_PASS,decision:'approved',recommendationRecordId:RECORD_PASS}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.redirects[fx.redirects.length-1]).toBe('/approvals?toast=Leave+approved');
  fx.follow.mockReset();
  await expect(approveLeaveAction(form({id:LR_PASS,decision:'approved',recommendationRecordId:'not-a-record'}))).rejects.toThrow('NEXT_REDIRECT');
  await expect(approveLeaveAction(form({id:LR_PASS,decision:'approved'}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.follow).not.toHaveBeenCalled();
 });

 it('records the follow-up for each leave request a bulk decision committed, through decideLeave one by one',async()=>{
  fx.decideLeave.mockImplementation(async(_s:unknown,p:{leaveRequestId:string})=>{if(p.leaveRequestId===LR_REVIEW)throw Error('Fixture: already decided');});
  fx.follow.mockResolvedValue({id:'followup-1'});
  const items=[{type:'leave',id:LR_PASS,recommendationRecordId:RECORD_PASS},{type:'leave',id:LR_REVIEW,recommendationRecordId:RECORD_REVIEW},{type:'claim',id:'claim-1',recommendationRecordId:RECORD_PASS}];
  await expect(bulkDecideAction(form({items:JSON.stringify(items),decision:'approved',category:'leave',sort:''}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.decideLeave.mock.calls.map(call=>(call[1] as {leaveRequestId:string}).leaveRequestId)).toEqual([LR_PASS,LR_REVIEW]);
  // Only the committed leave decision appends; the skipped one and the claim never do.
  expect(fx.follow.mock.calls).toEqual([[MANAGER,{recordId:RECORD_PASS,decision:'approved'}]]);
 });
});

describe('the per-date decision (slice 3 follow-up)',()=>{
 const form=(fields:Record<string,string>)=>{const data=new FormData();for(const [k,v] of Object.entries(fields))data.set(k,v);return data;};
 const LABELS={viewDateBreakdown:'Review dates',dateBreakdown:'Dates',dateColumn:'Date',dayColumn:'Day',daysColumn:'Days',decisionColumn:'Decision',reasonColumn:'Reason',
  approve:'Approve',reject:'Reject',rejectReason:'Reason',submitDecisions:'Submit decisions',statusPending:'Pending',statusApproved:'Approved',statusRejected:'Rejected',employeeRemark:'Remark',closeDialog:'Close'};
 const DATES=[{id:'d1',leaveDate:'2026-11-10',days:'1',status:'pending',rejectReason:null},{id:'d2',leaveDate:'2026-11-11',days:'1',status:'pending',rejectReason:null}];
 it('the date breakdown posts the recommendation\'s record with its one batch submit, and nothing without one',()=>{
  wrap(<LeaveDateBreakdown requestId={LR_PASS} dates={DATES} locale="en" labels={LABELS} nav={{category:'leave',sort:''}} recommendationRecordId={RECORD_PASS}/>);
  fireEvent.click(screen.getByRole('button',{name:'Review dates'}));
  const submit=screen.getByRole('button',{name:'Submit decisions'}).closest('form')!;
  expect([...submit.querySelectorAll('input[name="recommendationRecordId"]')].map(input=>(input as HTMLInputElement).value)).toEqual([RECORD_PASS]);
  expect((submit.querySelector('input[name="id"]') as HTMLInputElement).value).toBe(LR_PASS);
  cleanup();
  wrap(<LeaveDateBreakdown requestId={LR_PASS} dates={DATES} locale="en" labels={LABELS}/>);
  fireEvent.click(screen.getByRole('button',{name:'Review dates'}));
  expect(screen.getByRole('button',{name:'Submit decisions'}).closest('form')!.querySelector('input[name="recommendationRecordId"]')).toBeNull();
 });
 it('appends the follow-up with the leave engine\'s final outcome once every date is decided, after the decision commits',async()=>{
  const order:string[]=[];
  fx.decideLeaveDates.mockImplementation(async()=>{order.push('decide');return {status:'approved'};});
  fx.follow.mockImplementation(async()=>{order.push('follow');return {id:'followup-1'};});
  // A mixed outcome: one date approved, one rejected; the engine finalizes the request as approved.
  const decisions=JSON.stringify([{leaveDate:'2026-11-10',decision:'approved'},{leaveDate:'2026-11-11',decision:'rejected',rejectReason:'Fictional clash'}]);
  await expect(decideLeaveDatesAction(form({id:LR_PASS,decisions,recommendationRecordId:RECORD_PASS,category:'leave',sort:''}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.decideLeaveDates).toHaveBeenCalledWith(MANAGER,{leaveRequestId:LR_PASS,decisions:[{leaveDate:'2026-11-10',decision:'approved',rejectReason:undefined},{leaveDate:'2026-11-11',decision:'rejected',rejectReason:'Fictional clash'}],deciderEmploymentId:'emp-manager'});
  expect(fx.follow.mock.calls).toEqual([[MANAGER,{recordId:RECORD_PASS,decision:'approved'}]]);
  expect(order).toEqual(['decide','follow']);
  // Every date rejected: the request is rejected, and that is the decision recorded.
  fx.follow.mockClear();fx.decideLeaveDates.mockResolvedValueOnce({status:'rejected'});
  await expect(decideLeaveDatesAction(form({id:LR_PASS,decisions,recommendationRecordId:RECORD_PASS}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.follow.mock.calls).toEqual([[MANAGER,{recordId:RECORD_PASS,decision:'rejected'}]]);
 });
 it('records nothing while dates are still pending, when the decision fails, or without a record; the single-date action the same',async()=>{
  fx.follow.mockResolvedValue({id:'followup-1'});
  const decisions=JSON.stringify([{leaveDate:'2026-11-10',decision:'approved'}]);
  fx.decideLeaveDates.mockResolvedValueOnce({status:'pending'});
  await expect(decideLeaveDatesAction(form({id:LR_PASS,decisions,recommendationRecordId:RECORD_PASS}))).rejects.toThrow('NEXT_REDIRECT');
  fx.decideLeaveDates.mockRejectedValueOnce(Error('Fixture: already decided'));
  await expect(decideLeaveDatesAction(form({id:LR_PASS,decisions,recommendationRecordId:RECORD_PASS}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.redirects[fx.redirects.length-1]).toContain('error=Fixture');
  fx.decideLeaveDates.mockResolvedValueOnce({status:'approved'});
  await expect(decideLeaveDatesAction(form({id:LR_PASS,decisions}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.follow).not.toHaveBeenCalled();
  // The single-date action: the last pending date decided finalizes the request and records the follow-up.
  fx.decideLeaveDate.mockResolvedValueOnce({status:'pending'}).mockResolvedValueOnce({status:'approved'});
  await expect(decideLeaveDateAction(form({id:LR_PASS,leaveDate:'2026-11-10',decision:'approved',recommendationRecordId:RECORD_PASS}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.follow).not.toHaveBeenCalled();
  await expect(decideLeaveDateAction(form({id:LR_PASS,leaveDate:'2026-11-11',decision:'approved',recommendationRecordId:RECORD_PASS}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.follow.mock.calls).toEqual([[MANAGER,{recordId:RECORD_PASS,decision:'approved'}]]);
  // A follow-up that cannot be written never fails the committed decision.
  fx.follow.mockReset();fx.follow.mockRejectedValue(Error('Fixture record outage'));fx.decideLeaveDates.mockResolvedValueOnce({status:'approved'});
  await expect(decideLeaveDatesAction(form({id:LR_PASS,decisions,recommendationRecordId:RECORD_PASS}))).rejects.toThrow('NEXT_REDIRECT');
  expect(fx.redirects[fx.redirects.length-1]).toBe('/approvals?toast=Leave+decided&approvalSeal=1');
 });
});
