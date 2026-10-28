/** @vitest-environment jsdom */
/** ADR-0151 (amendment 2026-10-29): the HR-prepared panel's browser protocol. HR searches and picks an employee
 * from the server's list, types the days/date/reason (or the destination) themselves, sees the server's stored
 * facts, and a lost confirmation is reopened rather than retried. Authority and effects are proved by the DB tests. */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {HrPreparedPanel} from '../components/assistant/hr-prepared-panel';
vi.mock('next-intl',()=>({useTranslations:()=>((key:string,values?:Record<string,string>)=>values?`${key}:${Object.values(values).join('|')}`:key),useFormatter:()=>({dateTime:(date:Date)=>date.toISOString().slice(0,10),number:(value:number)=>String(value)})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
vi.mock('../components/ui',()=>({Button:({children,variant:_,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string})=><button {...props}>{children}</button>,inputCls:''}));
import {HR_LEAVE_ADJUSTMENT_ACTION as leaveAction,HR_MOVEMENT_TRANSFER_ACTION as movementAction} from '../lib/assistant-actions/hr-prepared-contract';
const id='60000000-0000-4000-8000-000000000001',employmentId='60000000-0000-4000-8000-000000000002',typeId='60000000-0000-4000-8000-000000000003',eventId='60000000-0000-4000-8000-000000000004',deptId='60000000-0000-4000-8000-000000000005',batchId='60000000-0000-4000-8000-000000000006';
const person={employmentId,employeeName:'Fictional Dana',employeeCode:'E-7',companyName:'Fictional Sdn Bhd'};
const stamp=(offset:number)=>new Date(Date.now()+offset).toISOString();
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),fetcher=vi.fn(),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const prepareButton=()=>screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement;
const leaveChoices={kind:'choices',employees:[person],truncated:false,leaveTypes:[{id:typeId,name:'Fictional Annual'}]};
const leaveContent={action:leaveAction,contractVersion:1,employmentId,subjectId:employmentId,leaveTypeId:typeId,direction:'deduct',days:'1.5',effectiveOn:'2026-10-29',reason:'Fictional over-credited carry-forward'};
const leaveItem={...person,subjectId:employmentId,leaveTypeName:'Fictional Annual',signedDays:'-1.50',effectiveOn:'2026-10-29',reason:'Fictional over-credited carry-forward'};
const leavePrepared={kind:'prepared',review:{action:leaveAction,contractVersion:1,actionId:id,reviewedDigest:'e'.repeat(64),createdAt:stamp(-1000),expiresAt:stamp(60000),content:leaveContent,review:leaveItem,consequence:'hr_leave_adjustment_balance_changes_from_effective_date'}};
const leaveDone={kind:'completed',receipt:{action:leaveAction,contractVersion:1,actionId:id,state:'completed',receipt:{kind:'adjusted',subjectId:employmentId,eventId,employmentId,batchId,written:1}}};
/** The employee list arrives from the first choices POST; nothing can be chosen before it. */
const loaded=()=>screen.findByRole('option',{name:/^employeeValue:Fictional Dana/});
async function fillLeave(){
 await loaded();await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));
 fireEvent.change(screen.getByLabelText('employee'),{target:{value:employmentId}});
 fireEvent.change(screen.getByLabelText('leaveType'),{target:{value:typeId}});fireEvent.click(screen.getByLabelText('directions.deduct'));
 fireEvent.change(screen.getByLabelText('days'),{target:{value:'1.5'}});fireEvent.change(screen.getByLabelText('effectiveOn'),{target:{value:'2026-10-29'}});
 fireEvent.change(screen.getByLabelText('reason'),{target:{value:'Fictional over-credited carry-forward'}});
}

it('prepares a leave deduction from HR\'s own inputs and shows the stored signed days exactly',async()=>{
 fetcher.mockResolvedValueOnce(json(leaveChoices)).mockResolvedValueOnce(json(leavePrepared)).mockResolvedValueOnce(json(leaveDone));
 render(<HrPreparedPanel action={leaveAction}/>);await fillLeave();
 expect(packets()[0]).toEqual({action:leaveAction,operation:'choices',selection:{query:''}});
 expect(prepareButton().disabled).toBe(true);fireEvent.click(screen.getByLabelText('consent'));fireEvent.click(prepareButton());
 await screen.findByRole('heading',{name:'reviewTitle'});expect(packets()[1]).toEqual({action:leaveAction,operation:'prepare',input:leaveContent});
 expect(screen.getByText('-1.50')).toBeTruthy();expect(screen.getByText('leave.consequence')).toBeTruthy();
 const confirmButton=screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement;expect(confirmButton.disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(confirmButton);await screen.findByRole('heading',{name:'done'});
 expect(packets()[2]).toEqual({action:leaveAction,operation:'confirm',confirmation:{action:leaveAction,contractVersion:1,actionId:id,reviewedDigest:'e'.repeat(64)}});
 expect(screen.getByText('doneLeave')).toBeTruthy();
});
it('blocks a quarter day, a blank reason and an employee outside the search results',async()=>{
 fetcher.mockResolvedValueOnce(json(leaveChoices));render(<HrPreparedPanel action={leaveAction}/>);await fillLeave();fireEvent.click(screen.getByLabelText('consent'));
 fireEvent.change(screen.getByLabelText('days'),{target:{value:'0.25'}});expect(prepareButton().disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('days'),{target:{value:'1'}});fireEvent.change(screen.getByLabelText('reason'),{target:{value:'   '}});expect(prepareButton().disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('reason'),{target:{value:'Fictional'}});fireEvent.change(screen.getByLabelText('employee'),{target:{value:'60000000-0000-4000-8000-0000000000ff'}});
 expect(prepareButton().disabled).toBe(true);fireEvent.submit(prepareButton().closest('form')!);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('searches with the typed query and loads the chosen employee\'s destinations for a movement',async()=>{
 const options={kind:'choices',employees:[person],truncated:false,departments:[{id:deptId,name:'Fictional Finance'}],positions:[],businessUnits:[],locations:[]};
 fetcher.mockResolvedValueOnce(json({...options,departments:[]})).mockResolvedValueOnce(json({...options,departments:[]})).mockResolvedValueOnce(json(options));
 render(<HrPreparedPanel action={movementAction}/>);await loaded();await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));
 fireEvent.change(screen.getByLabelText('search'),{target:{value:'Dana'}});fireEvent.click(screen.getByRole('button',{name:'searchButton'}));
 await waitFor(()=>expect(packets()[1]).toEqual({action:movementAction,operation:'choices',selection:{query:'Dana'}}));
 await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));fireEvent.change(screen.getByLabelText('employee'),{target:{value:employmentId}});
 await waitFor(()=>expect(packets()[2]).toEqual({action:movementAction,operation:'choices',selection:{query:'Dana',employmentId}}));
 await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));fireEvent.click(await screen.findByLabelText('kinds.transfer'));fireEvent.change(screen.getByLabelText('effectiveDate'),{target:{value:'2026-11-01'}});fireEvent.click(screen.getByLabelText('consent'));
 // Nothing changes yet: at least one destination is required.
 expect(prepareButton().disabled).toBe(true);
 fireEvent.change(await screen.findByLabelText('department'),{target:{value:deptId}});fireEvent.click(screen.getByLabelText('consent'));
 expect(prepareButton().disabled).toBe(false);
});
it('reopens the same leave review after a lost confirmation and never confirms twice',async()=>{
 fetcher.mockResolvedValueOnce(json(leaveChoices)).mockResolvedValueOnce(json(leavePrepared)).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(leaveDone));
 render(<HrPreparedPanel action={leaveAction}/>);await fillLeave();fireEvent.click(screen.getByLabelText('consent'));fireEvent.click(prepareButton());
 await screen.findByRole('heading',{name:'reviewTitle'});fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(screen.getByRole('button',{name:'confirm'}));
 await screen.findByText('uncertain');fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'done'});
 expect(packets()[3]).toEqual({action:leaveAction,operation:'reopen',actionId:id});expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);
});
it('refuses a prepared review for another employee than the one chosen',async()=>{
 const other='60000000-0000-4000-8000-0000000000aa';
 fetcher.mockResolvedValueOnce(json(leaveChoices)).mockResolvedValueOnce(json({...leavePrepared,review:{...leavePrepared.review,content:{...leaveContent,employmentId:other,subjectId:other},review:{...leaveItem,employmentId:other,subjectId:other}}}));
 render(<HrPreparedPanel action={leaveAction}/>);await fillLeave();fireEvent.click(screen.getByLabelText('consent'));fireEvent.click(prepareButton());
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('unavailable'));expect(screen.queryByRole('heading',{name:'reviewTitle'})).toBeNull();
});
