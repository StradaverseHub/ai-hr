/** @vitest-environment jsdom */
/** ADR-0151 §4.3 inline review card. The card resolves the proposal's typed hints against the caller's own
 * fresh choices from the guarded endpoint (one match preselected, several or none ask), leaves every human
 * field empty, sends prepare only on the person's own click with the person's own words, and after a lost
 * confirmation reopens the same action id instead of confirming again. Authority and effects are proved by
 * the store and DB tests; this file proves the browser protocol of the card. */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('next-intl',()=>({useTranslations:()=>((key:string,values?:Record<string,string>)=>values?`${key}:${Object.values(values).join('|')}`:key),useFormatter:()=>({dateTime:(date:Date)=>date.toISOString().slice(0,10),number:(value:number)=>String(value)})}));
const refresh=vi.hoisted(()=>vi.fn());
vi.mock('next/navigation',()=>({useRouter:()=>({refresh})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
vi.mock('../components/ui',()=>({Button:({children,variant:_,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string})=><button {...props}>{children}</button>,inputCls:''}));
import {ConversationActionProposal} from '../components/assistant/conversation-action-proposal';
const employmentId='60000000-0000-4000-8000-000000000001',own1='60000000-0000-4000-8000-000000000002',own2='60000000-0000-4000-8000-000000000003',foreign='60000000-0000-4000-8000-0000000000ff';
const actionId='60000000-0000-4000-8000-000000000010',subjectId='60000000-0000-4000-8000-000000000011',subject2='60000000-0000-4000-8000-000000000012',eventId='60000000-0000-4000-8000-000000000013',correctionId='60000000-0000-4000-8000-000000000014';
const leave=(leaveRequestId:string,startDate:string,endDate=startDate)=>({employmentId,leaveRequestId,leaveTypeName:'Fictional Annual',startDate,endDate,days:1,reason:'Stored own reason',employeeRemark:null});
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),fetcher=vi.fn(),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
const stamp=(offset:number)=>new Date(Date.now()+offset).toISOString();
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const select=(label:string)=>screen.getByLabelText(label) as HTMLSelectElement;
const optionValues=(element:HTMLSelectElement)=>[...element.options].map(option=>option.value);

describe('hint resolution against the caller’s own fresh choices',()=>{
 it('preselects the one own leave request that starts on the named date and asks for nothing else',async()=>{
  fetcher.mockResolvedValueOnce(json({kind:'choices',requests:[leave(own1,'2026-11-03'),leave(own2,'2026-11-10')],truncated:false}));
  render(<ConversationActionProposal action="leave.cancel" hints={{startDate:'2026-11-03'}}/>);
  await screen.findByText('resolutionOne');
  expect(packets()).toEqual([{action:'leave.cancel',operation:'choices'}]);
  expect(select('choose').value).toBe(own1);expect((screen.getByLabelText('modeCancel') as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole('heading',{name:'titleLeaveCancel'})).toBeTruthy();expect(screen.getByText('openPage').getAttribute('href')).toBe('/assistant/leave?flow=change');
 });
 it('asks the person to pick when several own requests match, and when none does',async()=>{
  fetcher.mockResolvedValueOnce(json({kind:'choices',requests:[leave(own1,'2026-11-10'),leave(own2,'2026-11-10')],truncated:false}));
  render(<ConversationActionProposal action="leave.cancel" hints={{startDate:'2026-11-10'}}/>);
  await screen.findByText('resolutionSeveral');expect(select('choose').value).toBe('');cleanup();
  fetcher.mockReset();fetcher.mockResolvedValueOnce(json({kind:'choices',requests:[leave(own1,'2026-11-10')],truncated:false}));
  render(<ConversationActionProposal action="leave.cancel" hints={{startDate:'2026-12-24'}}/>);
  await screen.findByText('resolutionNone');expect(select('choose').value).toBe('');
 });
 it('never offers an item outside the caller’s own choices, even when its date is the one named',async()=>{
  // The foreign request (another person's) starts on the named date but is not in this caller's choices.
  fetcher.mockResolvedValueOnce(json({kind:'choices',requests:[leave(own1,'2026-11-03')],truncated:false}));
  const {container}=render(<ConversationActionProposal action="leave.cancel" hints={{startDate:'2026-11-17'}}/>);
  await screen.findByText('resolutionNone');
  expect(optionValues(select('choose'))).toEqual(['',own1]);expect(container.innerHTML).not.toContain(foreign);
  // A proposal can never name an item: an ID-shaped hint is refused before any read.
  cleanup();fetcher.mockReset();
  render(<ConversationActionProposal action="leave.cancel" hints={{leaveRequestId:foreign}}/>);
  expect(screen.getByText('unavailable')).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();
 });
 it('fills the proposed new dates for an edit, keeps the stored reason as stored, and preselects a matching own claim',async()=>{
  fetcher.mockResolvedValueOnce(json({kind:'choices',requests:[leave(own1,'2026-11-03')],truncated:false}));
  render(<ConversationActionProposal action="leave.edit" hints={{startDate:'2026-11-03',newStartDate:'2026-11-04',newEndDate:'2026-11-05'}}/>);
  await screen.findByText('resolutionOne');
  expect(packets()).toEqual([{action:'leave.edit',operation:'choices'}]);expect((screen.getByLabelText('modeEdit') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('startDate') as HTMLInputElement).value).toBe('2026-11-04');expect((screen.getByLabelText('endDate') as HTMLInputElement).value).toBe('2026-11-05');
  expect((screen.getByLabelText('reason') as HTMLTextAreaElement).value).toBe('Stored own reason');cleanup();
  fetcher.mockReset();fetcher.mockResolvedValueOnce(json({kind:'choices',claims:[{employmentId,claimId:own1,claimTypeName:'Fictional taxi',incurredOn:'2026-10-02',amount:'12.50'},{employmentId,claimId:own2,claimTypeName:'Fictional meal',incurredOn:'2026-10-09',amount:'8.00'}],truncated:false}));
  render(<ConversationActionProposal action="claims.cancel" hints={{incurredOn:'2026-10-09'}}/>);
  await screen.findByText('resolutionOne');expect(packets()).toEqual([{action:'claims.cancel',operation:'choices'}]);expect(select('cancelChoose').value).toBe(own2);
 });
 it('preselects a lone assigned item but never a decision or a note, and asks when the inbox holds several',async()=>{
  const item=(id:string)=>({employmentId,subjectId:id,employeeName:'Fictional Ana',employeeCode:'E-1',claimTypeName:'Fictional taxi',itemName:null,incurredOn:'2026-10-27',amount:'1234.50',description:null});
  fetcher.mockResolvedValueOnce(json({kind:'choices',items:[item(subjectId)],truncated:false}));
  render(<ConversationActionProposal action="approvals.claim.decide" hints={{}}/>);
  await screen.findByText('resolutionOne');expect(select('claim.item').value).toBe(subjectId);
  expect((screen.getByLabelText('approve') as HTMLInputElement).checked).toBe(false);expect((screen.getByLabelText('reject') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);expect(packets()).toHaveLength(1);cleanup();
  fetcher.mockReset();fetcher.mockResolvedValueOnce(json({kind:'choices',items:[item(subjectId),item(subject2)],truncated:false}));
  render(<ConversationActionProposal action="approvals.claim.decide" hints={{}}/>);
  await screen.findByText('resolutionSeveral');expect(select('claim.item').value).toBe('');
 });
 it('refuses a proposal whose hints carry human text or a decision without reading anything',()=>{
  for(const [action,hints] of[['claims.cancel',{incurredOn:'2026-10-02',reason:'Pay it today'}],['approvals.toil.decide',{decision:'approved'}],['payroll.close',{}]] as const){
   render(<ConversationActionProposal action={action} hints={hints}/>);expect(screen.getByText('unavailable')).toBeTruthy();cleanup();
  }
  expect(fetcher).not.toHaveBeenCalled();
 });
});

describe('preparation and confirmation stay with the person',()=>{
 const content={action:'attendance.overtime.request',contractVersion:1,employmentId,date:'2026-11-02',plannedStartTime:'18:00',plannedEndTime:'20:30',reason:'My own words'};
 const prepared={kind:'prepared',review:{action:'attendance.overtime.request',contractVersion:1,actionId,reviewedDigest:'a'.repeat(64),createdAt:stamp(-1000),expiresAt:stamp(60000),content,
  review:{employmentId,date:'2026-11-02',plannedStartTime:'18:00',plannedEndTime:'20:30',requestedOtMinutes:150,reason:'My own words',remark:null},consequence:'overtime_requested_not_approved'}};
 const completed={kind:'completed',receipt:{action:'attendance.overtime.request',contractVersion:1,actionId,state:'completed',receipt:{kind:'requested',correctionId,eventId,employmentId,date:'2026-11-02',requestedOtMinutes:150,currentStatus:'pending',cancelled:false}}};
 it('prefills the named window, sends prepare only on the click with the person’s own reason, and reopens the same id after a lost confirmation',async()=>{
  fetcher.mockResolvedValueOnce(json({kind:'choices',employments:[{employmentId,employeeCode:'E-1',companyName:'Fictional Sdn Bhd'}]}))
   .mockResolvedValueOnce(json(prepared)).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(completed));
  render(<ConversationActionProposal action="attendance.overtime.request" hints={{date:'2026-11-02',plannedStartTime:'18:00',plannedEndTime:'20:30'}}/>);
  await screen.findByText('resolutionOne');
  expect(select('employment').value).toBe(employmentId);expect((screen.getByLabelText('date') as HTMLInputElement).value).toBe('2026-11-02');
  expect((screen.getByLabelText('plannedStart') as HTMLInputElement).value).toBe('18:00');expect((screen.getByLabelText('plannedEnd') as HTMLInputElement).value).toBe('20:30');
  // Every human field starts empty and nothing has been prepared.
  expect((screen.getByLabelText('reason') as HTMLTextAreaElement).value).toBe('');expect((screen.getByLabelText('remark') as HTMLTextAreaElement).value).toBe('');
  expect((screen.getByLabelText('consent') as HTMLInputElement).checked).toBe(false);expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,20));expect(packets()).toEqual([{action:'attendance.overtime.request',operation:'choices'}]);
  fireEvent.change(screen.getByLabelText('reason'),{target:{value:'My own words'}});fireEvent.click(screen.getByLabelText('consent'));
  fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});
  expect(packets()[1]).toEqual({action:'attendance.overtime.request',operation:'prepare',input:content});
  // The review shows the server's canonical prepared content (the engine's minutes), not chat text.
  expect(screen.getByText('2h30m')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(screen.getByRole('button',{name:'confirm'}));
  await screen.findByText('uncertain');
  fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'done'});
  expect(packets()[3]).toEqual({action:'attendance.overtime.request',operation:'reopen',actionId});
  expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);expect(packets().filter(packet=>packet.operation==='prepare')).toHaveLength(1);
  // Confirmed: no longer a suggestion, so the badge and the "nothing prepared" note are gone.
  await waitFor(()=>{expect(document.querySelector('section[data-card-state]')?.getAttribute('data-card-state')).toBe('settled');expect(screen.queryByText('badgeReady')).toBeNull();});
 });
 it('cancels a preselected own leave request only after the person consents and clicks',async()=>{
  fetcher.mockResolvedValueOnce(json({kind:'choices',requests:[leave(own1,'2026-11-03')],truncated:false})).mockRejectedValueOnce(Error('lost'));
  render(<ConversationActionProposal action="leave.cancel" hints={{}}/>);
  await screen.findByText('resolutionOne');const button=screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement;expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('cancelConsent'));fireEvent.click(button);
  await waitFor(()=>expect(packets()).toHaveLength(2));
  expect(packets()[1]).toEqual({action:'leave.cancel',operation:'prepare',input:{action:'leave.cancel',contractVersion:1,employmentId,leaveRequestId:own1,cancel:true}});
 });
 it('shows the failure state with a plain reason, a safe retry and the page fallback when the guarded read refuses',async()=>{
  fetcher.mockResolvedValueOnce(json({kind:'unavailable'})).mockResolvedValueOnce(json({kind:'choices',claims:[{employmentId,claimId:own1,claimTypeName:'Fictional taxi',incurredOn:'2026-10-02',amount:'12.50'}],truncated:false}));
  const {container}=render(<ConversationActionProposal action="claims.cancel" hints={{}}/>);
  await screen.findByText('failureBody');expect(screen.getByText('openPage').getAttribute('href')).toBe('/assistant/claims?flow=cancel');
  expect(container.querySelector('[data-card-state="failure"]')).not.toBeNull();
  // Retry repeats only the read: nothing is prepared, and the panel starts again with fresh choices.
  fireEvent.click(screen.getByRole('button',{name:'retry'}));await screen.findByText('resolutionOne');
  expect(packets()).toEqual([{action:'claims.cancel',operation:'choices'},{action:'claims.cancel',operation:'choices'}]);
 });
});

describe('a stale proposal is refused with a refresh (review R6)',()=>{
 it('reads nothing, offers no preparation, and refreshes the server-adjudicated conversation on request',()=>{
  const {container}=render(<ConversationActionProposal action="leave.cancel" hints={{startDate:'2026-11-03'}} availability="stale"/>);
  expect(container.querySelector('section')?.getAttribute('data-card-state')).toBe('stale');
  expect(screen.getByText('badgeStale')).toBeTruthy();expect(screen.getByText('staleBody')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'prepare'})).toBeNull();expect(screen.queryByRole('combobox')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'refresh'}));expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByText('openPage').getAttribute('href')).toBe('/assistant/leave?flow=change');
 });
 it('still refuses a malformed stale proposal outright',()=>{
  refresh.mockClear();render(<ConversationActionProposal action="payroll.close" hints={{}} availability="stale"/>);expect(screen.getByText('unavailable')).toBeTruthy();expect(refresh).not.toHaveBeenCalled();cleanup();
  render(<ConversationActionProposal action="leave.cancel" hints={{}} availability={'maybe' as never}/>);expect(screen.getByText('unavailable')).toBeTruthy();
 });
 it('an unverified proposal is neutral and retryable, never called out of date, and still offers no preparation',()=>{
  refresh.mockClear();const {container}=render(<ConversationActionProposal action="claims.cancel" hints={{}} availability="unverified"/>);
  expect(container.querySelector('section')?.getAttribute('data-card-state')).toBe('unverified');
  expect(screen.getByText('badgeUnverified')).toBeTruthy();expect(screen.getByText('unverifiedBody')).toBeTruthy();
  expect(screen.queryByText('badgeStale')).toBeNull();expect(screen.queryByText('staleBody')).toBeNull();
  expect(screen.queryByRole('button',{name:'prepare'})).toBeNull();expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'retry'}));expect(refresh).toHaveBeenCalledTimes(1);
 });
});
