/** @vitest-environment jsdom */
/** ADR-0151 wave 1: the leave change panel's browser protocol. Explicit choice, explicit mode, two human
 * confirmations, only changed text sent, and a lost confirmation is reopened rather than retried. */
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {OwnLeaveChangePanel} from '../components/assistant/own-leave-change-panel';
vi.mock('next-intl',()=>({useTranslations:()=>((key:string,values?:Record<string,string>)=>values?`${key}:${Object.values(values).join('|')}`:key),useFormatter:()=>({dateTime:(date:Date)=>date.toISOString().slice(0,10),number:(value:number)=>String(value)})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
vi.mock('../components/ui',()=>({Button:({children,variant:_,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string})=><button {...props}>{children}</button>,inputCls:''}));
import {OWN_LEAVE_CANCELLATION_ACTION as cancelAction,OWN_LEAVE_EDIT_ACTION as editAction} from '../lib/assistant-actions/own-leave-change-contract';
const id='30000000-0000-4000-8000-000000000001',employmentId='30000000-0000-4000-8000-000000000002',leaveRequestId='30000000-0000-4000-8000-000000000003',eventId='30000000-0000-4000-8000-000000000004';
const pending={employmentId,leaveRequestId,leaveTypeName:'Fictional annual',startDate:'2026-11-02',endDate:'2026-11-02',days:1,reason:'Fictional trip',employeeRemark:null};
const choices={kind:'choices' as const,truncated:false,requests:[pending]};
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),fetcher=vi.fn(),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
const stamp=(offset:number)=>new Date(Date.now()+offset).toISOString();
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('cancels only after choosing the request, the mode and two confirmations',async()=>{
 const content={action:cancelAction,contractVersion:1,employmentId,leaveRequestId,cancel:true};
 fetcher.mockResolvedValueOnce(json({kind:'prepared',review:{action:cancelAction,contractVersion:1,actionId:id,reviewedDigest:'c'.repeat(64),createdAt:stamp(-1000),expiresAt:stamp(60000),content,review:pending,consequence:'pending_leave_withdrawn'}}))
  .mockResolvedValueOnce(json({kind:'completed',receipt:{action:cancelAction,contractVersion:1,actionId:id,state:'completed',receipt:{kind:'cancelled',leaveRequestId,eventId,employmentId,currentStatus:'cancelled'}}}));
 render(<OwnLeaveChangePanel choices={choices}/>);fireEvent.change(screen.getByLabelText('choose'),{target:{value:leaveRequestId}});
 expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByLabelText('cancelConsent'));fireEvent.click(screen.getByRole('button',{name:'prepare'}));
 await screen.findByRole('heading',{name:'cancelReviewTitle'});expect(packets()[0]).toEqual({action:cancelAction,operation:'prepare',input:content});
 expect((screen.getByRole('button',{name:'cancelConfirm'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByLabelText('cancelConfirmConsent'));fireEvent.click(screen.getByRole('button',{name:'cancelConfirm'}));
 await screen.findByRole('heading',{name:'cancelDone'});expect(packets()[1]).toEqual({action:cancelAction,operation:'confirm',confirmation:{action:cancelAction,contractVersion:1,actionId:id,reviewedDigest:'c'.repeat(64)}});
});
it('sends only the dates and text the person changed for an edit, and reopens after a lost confirmation',async()=>{
 const content={action:editAction,contractVersion:1,employmentId,leaveRequestId,startDate:'2026-11-03',endDate:'2026-11-04'};
 const review={before:pending,after:{startDate:'2026-11-03',endDate:'2026-11-04',days:2,reason:'Fictional trip',employeeRemark:null}};
 fetcher.mockResolvedValueOnce(json({kind:'prepared',review:{action:editAction,contractVersion:1,actionId:id,reviewedDigest:'d'.repeat(64),createdAt:stamp(-1000),expiresAt:stamp(60000),content,review,consequence:'pending_leave_edited_still_pending'}}))
  .mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json({kind:'completed',receipt:{action:editAction,contractVersion:1,actionId:id,state:'completed',receipt:{kind:'edited',leaveRequestId,eventId,employmentId,days:2,currentStatus:'pending'}}}));
 render(<OwnLeaveChangePanel choices={choices}/>);fireEvent.change(screen.getByLabelText('choose'),{target:{value:leaveRequestId}});fireEvent.click(screen.getByLabelText('modeEdit'));
 fireEvent.click(screen.getByLabelText('editConsent'));expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('startDate'),{target:{value:'2026-11-03'}});fireEvent.change(screen.getByLabelText('endDate'),{target:{value:'2026-11-04'}});fireEvent.click(screen.getByRole('button',{name:'prepare'}));
 await screen.findByRole('heading',{name:'editReviewTitle'});expect(packets()[0]).toEqual({action:editAction,operation:'prepare',input:content});
 fireEvent.click(screen.getByLabelText('editConfirmConsent'));fireEvent.click(screen.getByRole('button',{name:'editConfirm'}));await screen.findByText('uncertain');
 fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'editDone'});
 expect(packets()[2]).toEqual({action:editAction,operation:'reopen',actionId:id});expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);
});
