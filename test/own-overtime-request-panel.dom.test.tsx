/** @vitest-environment jsdom */
/** ADR-0151 wave 1b: the own overtime request panel's browser protocol. Choices come from the guarded POST,
 * the person's own window and words are sent, the engine's minutes are shown from the server review, two
 * human confirmations are needed, and a lost confirmation is reopened rather than retried. */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {OwnOvertimeRequestPanel} from '../components/assistant/own-overtime-request-panel';
vi.mock('next-intl',()=>({useTranslations:()=>((key:string,values?:Record<string,string>)=>values?`${key}:${Object.values(values).join('|')}`:key),useFormatter:()=>({dateTime:(date:Date)=>date.toISOString().slice(0,10),number:(value:number)=>String(value)})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
vi.mock('../components/ui',()=>({Button:({children,variant:_,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string})=><button {...props}>{children}</button>,inputCls:''}));
import {OWN_OVERTIME_REQUEST_ACTION as action} from '../lib/assistant-actions/own-overtime-request-contract';
const id='40000000-0000-4000-8000-000000000001',employmentId='40000000-0000-4000-8000-000000000002',correctionId='40000000-0000-4000-8000-000000000003',eventId='40000000-0000-4000-8000-000000000004';
const choices={kind:'choices',employments:[{employmentId,employeeCode:'E-1',companyName:'Fictional Sdn Bhd'}]};
const stamp=(offset:number)=>new Date(Date.now()+offset).toISOString();
const content=(start='18:00',end='20:30')=>({action,contractVersion:1,employmentId,date:'2026-11-02',plannedStartTime:start,plannedEndTime:end,reason:'Fictional release night'});
const prepared=(start='18:00',end='20:30',minutes=150)=>({kind:'prepared',review:{action,contractVersion:1,actionId:id,reviewedDigest:'a'.repeat(64),createdAt:stamp(-1000),expiresAt:stamp(60000),content:content(start,end),
 review:{employmentId,date:'2026-11-02',plannedStartTime:start,plannedEndTime:end,requestedOtMinutes:minutes,reason:'Fictional release night',remark:null},consequence:'overtime_requested_not_approved'}});
const completed=()=>({kind:'completed',receipt:{action,contractVersion:1,actionId:id,state:'completed',receipt:{kind:'requested',correctionId,eventId,employmentId,date:'2026-11-02',requestedOtMinutes:150,currentStatus:'pending',cancelled:false}}});
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),fetcher=vi.fn(),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function fill(start='18:00',end='20:30'){
 fireEvent.change(await screen.findByLabelText('employment'),{target:{value:employmentId}});fireEvent.change(screen.getByLabelText('date'),{target:{value:'2026-11-02'}});
 fireEvent.change(screen.getByLabelText('plannedStart'),{target:{value:start}});fireEvent.change(screen.getByLabelText('plannedEnd'),{target:{value:end}});
 expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('reason'),{target:{value:'Fictional release night'}});fireEvent.click(screen.getByLabelText('consent'));
}

it('loads choices through the guarded POST, sends only the person’s own values and confirms after a second step',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(json(completed()));
 render(<OwnOvertimeRequestPanel/>);await fill();expect(packets()[0]).toEqual({action,operation:'choices'});
 fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});
 // A blank remark is left out rather than sent as text the person never wrote.
 expect(packets()[1]).toEqual({action,operation:'prepare',input:content()});
 expect(screen.getByText('2h30m')).toBeTruthy();expect(screen.getByText('consequence')).toBeTruthy();
 const confirmButton=screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement;expect(confirmButton.disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(confirmButton);await screen.findByRole('heading',{name:'done'});
 expect(packets()[2]).toEqual({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId:id,reviewedDigest:'a'.repeat(64)}});
 expect(screen.getByText('statuses.pending')).toBeTruthy();
});
it('shows the engine’s minutes for a window that ends the next day',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared('22:00','02:00',240)));
 render(<OwnOvertimeRequestPanel/>);await fill('22:00','02:00');fireEvent.click(screen.getByRole('button',{name:'prepare'}));
 await screen.findByRole('heading',{name:'reviewTitle'});expect(screen.getByText('4h')).toBeTruthy();expect(screen.getByText(/nextDay/)).toBeTruthy();
});
it('reopens the same review after a lost confirmation and never sends a second confirmation',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(completed()));
 render(<OwnOvertimeRequestPanel/>);await fill();fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});
 fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(screen.getByRole('button',{name:'confirm'}));
 await screen.findByText('uncertain');expect(fetcher).toHaveBeenCalledTimes(3);
 fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'done'});
 expect(packets()[3]).toEqual({action,operation:'reopen',actionId:id});expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);
});
it('shows a refused saved review as closed without offering a confirmation',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json({kind:'retired',receipt:{action,contractVersion:1,actionId:id,state:'refused'}}));
 render(<OwnOvertimeRequestPanel resumeActionId={id}/>);await screen.findByText('uncertain');
 fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByText('retired');
 expect(packets()[1]).toEqual({action,operation:'reopen',actionId:id});expect(screen.getByText(/states\.refused/)).toBeTruthy();expect(screen.queryByRole('button',{name:'confirm'})).toBeNull();
});
it('renders unavailable choices without a form and refuses a review for a different window',async()=>{
 fetcher.mockResolvedValueOnce(json({kind:'unavailable'}));render(<OwnOvertimeRequestPanel/>);
 await screen.findByText('choicesUnavailable');expect(screen.queryByLabelText('employment')).toBeNull();cleanup();
 fetcher.mockReset();fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared('19:00','20:30',90)));
 render(<OwnOvertimeRequestPanel/>);await fill();fireEvent.click(screen.getByRole('button',{name:'prepare'}));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('unavailable'));expect(screen.queryByRole('heading',{name:'reviewTitle'})).toBeNull();
});
it('keeps the request blocked while the start and end are the same time',async()=>{
 fetcher.mockResolvedValueOnce(json(choices));render(<OwnOvertimeRequestPanel/>);await fill('18:00','18:00');
 expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText('sameTime')).toBeTruthy();expect(fetcher).toHaveBeenCalledTimes(1);
});
