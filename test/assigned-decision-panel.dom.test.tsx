/** @vitest-environment jsdom */
/** ADR-0151 wave 1b: the assigned decision panel's browser protocol for claims, attendance and replacement
 * leave. Only an item from the server's choices can be decided, the review shows the server's stored facts,
 * claim approvals carry no note, claim and attendance rejections need one, and a lost confirmation is reopened
 * rather than retried. Authority and effects are proved by the DB tests. */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AssignedDecisionPanel} from '../components/assistant/assigned-decision-panel';
vi.mock('next-intl',()=>({useTranslations:()=>((key:string,values?:Record<string,string>)=>values?`${key}:${Object.values(values).join('|')}`:key),useFormatter:()=>({dateTime:(date:Date)=>date.toISOString().slice(0,10),number:(value:number)=>String(value)})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
vi.mock('../components/ui',()=>({Button:({children,variant:_,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string})=><button {...props}>{children}</button>,inputCls:''}));
import {ASSIGNED_CLAIM_DECISION_ACTION as claimAction,ASSIGNED_ATTENDANCE_DECISION_ACTION as attendanceAction,ASSIGNED_TOIL_DECISION_ACTION as toilAction} from '../lib/assistant-actions/assigned-decision-contract';
const id='50000000-0000-4000-8000-000000000001',employmentId='50000000-0000-4000-8000-000000000002',subjectId='50000000-0000-4000-8000-000000000003',eventId='50000000-0000-4000-8000-000000000004',otherSubject='50000000-0000-4000-8000-000000000005';
const claimItem={employmentId,subjectId,employeeName:'Fictional Ana',employeeCode:'E-1',claimTypeName:'Fictional taxi',itemName:null,incurredOn:'2026-10-27',amount:'1234.50',description:null};
const attendanceItem={employmentId,subjectId,employeeName:'Fictional Ben',employeeCode:null,date:'2026-10-28',overtime:true,proposedCheckIn:null,proposedCheckOut:null,plannedStartTime:'18:00',plannedEndTime:'20:00',requestedOtMinutes:120,reason:'Fictional launch'};
const toilItem={employmentId,subjectId,employeeName:'Fictional Chen',employeeCode:null,submittedOn:'2026-10-20',totalDays:1,totalHours:8,lines:1,reason:null};
const consequences={[claimAction]:'assigned_claim_decided_payment_by_payroll_or_reimbursement',[attendanceAction]:'assigned_attendance_decision_may_remain_pending',[toilAction]:'assigned_toil_decided_credit_minted_on_approval'};
type Action=typeof claimAction|typeof attendanceAction|typeof toilAction;
const stamp=(offset:number)=>new Date(Date.now()+offset).toISOString();
const choices=(item:unknown,truncated=false)=>({kind:'choices',items:[item],truncated});
const prepared=(action:Action,content:Record<string,unknown>,item:unknown)=>({kind:'prepared',review:{action,contractVersion:1,actionId:id,reviewedDigest:'e'.repeat(64),createdAt:stamp(-1000),expiresAt:stamp(60000),content,review:item,consequence:consequences[action]}});
const completed=(action:Action,decision:'approved'|'rejected',recorded:'final'|'level',currentStatus:string)=>({kind:'completed',receipt:{action,contractVersion:1,actionId:id,state:'completed',receipt:{kind:'decided',subjectId,eventId,employmentId,decision,recorded,currentStatus}}});
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),fetcher=vi.fn(),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const prepareButton=()=>screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement;

it('decides a claim from the choices list with no note, showing the stored amount exactly',async()=>{
 const content={action:claimAction,contractVersion:1,employmentId,subjectId,decision:'approved'};
 fetcher.mockResolvedValueOnce(json(choices(claimItem))).mockResolvedValueOnce(json(prepared(claimAction,content,claimItem))).mockResolvedValueOnce(json(completed(claimAction,'approved','final','approved')));
 render(<AssignedDecisionPanel action={claimAction}/>);fireEvent.change(await screen.findByLabelText('claim.item'),{target:{value:subjectId}});
 expect(packets()[0]).toEqual({action:claimAction,operation:'choices'});expect(screen.queryByLabelText('note')).toBeNull();expect(screen.getByText('claimNoNote')).toBeTruthy();
 fireEvent.click(screen.getByLabelText('approve'));expect(prepareButton().disabled).toBe(true);fireEvent.click(screen.getByLabelText('consent'));fireEvent.click(prepareButton());
 await screen.findByRole('heading',{name:'reviewTitle'});expect(packets()[1]).toEqual({action:claimAction,operation:'prepare',input:content});expect('note' in packets()[1].input).toBe(false);
 expect(screen.getByText('1234.50')).toBeTruthy();expect(screen.getByText('claim.consequence')).toBeTruthy();
 const confirmButton=screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement;expect(confirmButton.disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(confirmButton);await screen.findByRole('heading',{name:'done'});
 expect(packets()[2]).toEqual({action:claimAction,operation:'confirm',confirmation:{action:claimAction,contractVersion:1,actionId:id,reviewedDigest:'e'.repeat(64)}});
 expect(screen.getByText('doneFinal')).toBeTruthy();expect(screen.getByText('statuses.approved')).toBeTruthy();
});
it('blocks an attendance rejection until the approver writes a note, then shows a level-only record',async()=>{
 const content={action:attendanceAction,contractVersion:1,employmentId,subjectId,decision:'rejected',note:'Fictional: not planned with me'};
 fetcher.mockResolvedValueOnce(json(choices(attendanceItem))).mockResolvedValueOnce(json(prepared(attendanceAction,content,attendanceItem))).mockResolvedValueOnce(json(completed(attendanceAction,'rejected','level','pending')));
 render(<AssignedDecisionPanel action={attendanceAction}/>);fireEvent.change(await screen.findByLabelText('attendance.item'),{target:{value:subjectId}});
 fireEvent.click(screen.getByLabelText('reject'));fireEvent.click(screen.getByLabelText('consent'));
 expect(prepareButton().disabled).toBe(true);expect(screen.getByText('rejectNoteRequired')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('rejectNote'),{target:{value:'   '}});expect(prepareButton().disabled).toBe(true);
 fireEvent.submit(prepareButton().closest('form')!);expect(fetcher).toHaveBeenCalledTimes(1);
 fireEvent.change(screen.getByLabelText('rejectNote'),{target:{value:'Fictional: not planned with me'}});expect(prepareButton().disabled).toBe(false);fireEvent.click(prepareButton());
 await screen.findByRole('heading',{name:'reviewTitle'});expect(packets()[1]).toEqual({action:attendanceAction,operation:'prepare',input:content});expect(screen.getByText('2h')).toBeTruthy();
 fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(screen.getByRole('button',{name:'confirm'}));await screen.findByRole('heading',{name:'done'});
 expect(screen.getByText('doneLevel')).toBeTruthy();expect(screen.getByText('statuses.pending')).toBeTruthy();
});
it('reopens the same replacement-leave review after a lost confirmation and never confirms twice',async()=>{
 const content={action:toilAction,contractVersion:1,employmentId,subjectId,decision:'approved'};
 fetcher.mockResolvedValueOnce(json(choices(toilItem))).mockResolvedValueOnce(json(prepared(toilAction,content,toilItem))).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(completed(toilAction,'approved','final','approved')));
 render(<AssignedDecisionPanel action={toilAction}/>);fireEvent.change(await screen.findByLabelText('toil.item'),{target:{value:subjectId}});
 fireEvent.click(screen.getByLabelText('approve'));fireEvent.click(screen.getByLabelText('consent'));fireEvent.click(prepareButton());
 await screen.findByRole('heading',{name:'reviewTitle'});expect(packets()[1]).toEqual({action:toilAction,operation:'prepare',input:content});
 fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(screen.getByRole('button',{name:'confirm'}));
 await screen.findByText('uncertain');expect(fetcher).toHaveBeenCalledTimes(3);
 fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'done'});
 expect(packets()[3]).toEqual({action:toilAction,operation:'reopen',actionId:id});expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);
});
it('refuses a prepared review for an item that is not the one chosen',async()=>{
 const content={action:claimAction,contractVersion:1,employmentId,subjectId:otherSubject,decision:'approved'};
 fetcher.mockResolvedValueOnce(json(choices(claimItem))).mockResolvedValueOnce(json(prepared(claimAction,content,{...claimItem,subjectId:otherSubject})));
 render(<AssignedDecisionPanel action={claimAction}/>);fireEvent.change(await screen.findByLabelText('claim.item'),{target:{value:subjectId}});
 fireEvent.click(screen.getByLabelText('approve'));fireEvent.click(screen.getByLabelText('consent'));fireEvent.click(prepareButton());
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('unavailable'));expect(screen.queryByRole('heading',{name:'reviewTitle'})).toBeNull();
});
it('only offers items from the choices list',async()=>{
 fetcher.mockResolvedValueOnce(json(choices(claimItem)));render(<AssignedDecisionPanel action={claimAction}/>);
 const select=await screen.findByLabelText('claim.item') as HTMLSelectElement;expect([...select.options].map(option=>option.value)).toEqual(['',subjectId]);
 fireEvent.change(select,{target:{value:otherSubject}});fireEvent.click(screen.getByLabelText('approve'));fireEvent.click(screen.getByLabelText('consent'));
 expect(prepareButton().disabled).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('shows an empty inbox with the truncation note, and unavailable choices, without a form',async()=>{
 fetcher.mockResolvedValueOnce(json({kind:'choices',items:[],truncated:true}));render(<AssignedDecisionPanel action={toilAction}/>);
 await screen.findByText('toil.none');expect(screen.getByText('truncated')).toBeTruthy();expect(screen.queryByRole('button',{name:'prepare'})).toBeNull();cleanup();
 fetcher.mockReset();fetcher.mockResolvedValueOnce(json({kind:'unavailable'}));render(<AssignedDecisionPanel action={attendanceAction}/>);
 await screen.findByText('choicesUnavailable');expect(screen.queryByRole('button',{name:'prepare'})).toBeNull();
});

it('requires the claimant rejection reason and shows the reviewed reason',async()=>{
 const note='My own rejection explanation',content={action:claimAction,contractVersion:1,employmentId,subjectId,decision:'rejected',note};
 fetcher.mockResolvedValueOnce(json(choices(claimItem))).mockResolvedValueOnce(json(prepared(claimAction,content,claimItem)));
 render(<AssignedDecisionPanel action={claimAction}/>);fireEvent.change(await screen.findByLabelText('claim.item'),{target:{value:subjectId}});fireEvent.click(screen.getByLabelText('reject'));fireEvent.click(screen.getByLabelText('consent'));expect(prepareButton().disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('rejectNote'),{target:{value:note}});fireEvent.click(prepareButton());await screen.findByRole('heading',{name:'reviewTitle'});expect(packets()[1].input.note).toBe(note);expect(screen.getByText(note)).toBeTruthy();
});
