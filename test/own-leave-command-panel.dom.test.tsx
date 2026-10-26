/** Complete unmounted panel interactions/protocol cases, authored UNRUN. Fetch is mocked only;
 * no route, provider, browser app, fixture, storage or effect execution is mounted by these cases. */
import {randomUUID} from 'node:crypto';
import type {ComponentProps} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {OwnLeaveCommandPanel,readOwnLeaveCommandResponse,type OwnLeaveCommandMessages} from '../components/assistant/own-leave-command-panel';
vi.mock('next/link',()=>({default:({children,...props}:ComponentProps<'a'>)=><a {...props}>{children}</a>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
const employmentId=randomUUID(),leaveTypeId=randomUUID();
const messages:OwnLeaveCommandMessages={employment:'Employment',leaveType:'Leave type',chooseEmployment:'Choose employment',chooseLeaveType:'Choose leave type',date:'Leave date',reason:'Your reason',remark:'Your remark',prepare:'Prepare review',preparing:'Preparing review',confirm:'Confirm submission',confirming:'Submitting request',discard:'Discard review',discarding:'Discarding review',checking:'Checking the same action',reopen:'Check submission',explanation:'Select your own leave details.',confirmNote:'Review these details before submitting.',uncertain:'The result is uncertain. Check this same action.',prepareUncertain:'The preparation result is uncertain. Do not create another action.',submitted:'Request submitted',submittedNote:'Submitted for approval. This is not an approval.',discarded:'Review discarded',expired:'This review expired.',refused:'This review is unavailable.',unavailable:'That door is closed for now. Try the normal leave page.',invalidSelection:'Choose your own employment, leave type and date.',needsRemark:'Add your own remark before preparing this review.',openRequests:'Open leave requests',findReviews:'Find my saved reviews',findingReviews:'Finding saved reviews',savedReviews:'Saved reviews',noSavedReviews:'No saved reviews were found.',openSavedReview:'Open saved review',indexLimitNote:'Up to 25 recent reviews from the last 30 days.',savedPending:'Awaiting your confirmation',savedCompleted:'Submission recorded',savedDiscarded:'Discarded',savedExpired:'Expired',savedRefused:'Unavailable',savedCreated:'Created',savedExpires:'Review expires'};
function review(){const now=Date.now();return{actionId:randomUUID(),contractVersion:1 as const,reviewedDigest:'a'.repeat(64),createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+600000).toISOString(),companyName:'Fictional company',employeeCode:'FICT-1',leaveTypeName:'Annual',date:'2026-12-15',durationType:'full_day' as const,deductionDays:1,availableBalance:null,estimatedAvailableAfter:null,holidayWarnings:[],approvalRouting:'unknown' as const,humanText:{reason:'<img src=x onerror=alert(1)> Exact human reason',employeeRemark:'Exact human remark'}};}
const response=(value:unknown)=>Response.json(value);
function show(resumeActionId?:string){return render(<NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur"><OwnLeaveCommandPanel messages={messages} employments={[{id:employmentId,label:'My fictional employment',leaveTypes:[{id:leaveTypeId,label:'My annual leave'}]}]} resumeActionId={resumeActionId}/></NextIntlClientProvider>);}
function fill(){fireEvent.change(screen.getByLabelText(messages.employment),{target:{value:employmentId}});fireEvent.change(screen.getByLabelText(messages.leaveType),{target:{value:leaveTypeId}});fireEvent.change(screen.getByLabelText(messages.date),{target:{value:'2026-12-15'}});fireEvent.change(screen.getByLabelText(messages.reason),{target:{value:'Exact human reason'}});fireEvent.change(screen.getByLabelText(messages.remark),{target:{value:'Exact human remark'}});}
function body(fetchMock:ReturnType<typeof vi.fn>,index:number){return JSON.parse(fetchMock.mock.calls[index][1].body as string);}
const confirmation=(r:ReturnType<typeof review>)=>({actionId:r.actionId,contractVersion:1,reviewedDigest:r.reviewedDigest});
const completed=(r:ReturnType<typeof review>)=>({kind:'completed',receipt:{actionId:r.actionId,contractVersion:1,state:'completed',leaveRequestId:randomUUID(),submissionEventId:randomUUID()}});
async function prepare(fetchMock:ReturnType<typeof vi.fn>,r=review()){fetchMock.mockResolvedValueOnce(response({kind:'prepared',review:r}));fill();fireEvent.click(screen.getByRole('button',{name:messages.prepare}));await screen.findByRole('button',{name:messages.confirm});return r;}

describe('human own-leave command panel',()=>{
 it('requires explicit human selection and posts a fixed same-origin preparation, then confirms only once with the confirmation-only contract',async()=>{
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);const view=show();expect(fetchMock).not.toHaveBeenCalled();
  expect((screen.getByLabelText(messages.employment) as HTMLSelectElement).value).toBe('');
  const r=await prepare(fetchMock);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/assistant/own-leave');expect(fetchMock.mock.calls[0][1]).toMatchObject({method:'POST',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'}});
  expect(body(fetchMock,0)).toEqual({operation:'prepare',nomination:{action:'leave.apply',contractVersion:1,employmentId,leaveTypeId,date:'2026-12-15',durationType:'full_day'},selection:{employmentId,leaveTypeId},humanText:{reason:'Exact human reason',employeeRemark:'Exact human remark'}});
  expect(view.container.querySelector('img')).toBeNull();expect(view.container.textContent).toContain(r.humanText.reason);expect(fetchMock).toHaveBeenCalledTimes(1);
  let resolve!:(value:Response)=>void;fetchMock.mockImplementationOnce(()=>new Promise<Response>(yes=>{resolve=yes;}));
  const button=screen.getByRole('button',{name:messages.confirm});fireEvent.click(button);fireEvent.click(button);expect(fetchMock).toHaveBeenCalledTimes(2);expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(body(fetchMock,1)).toEqual({operation:'confirm',confirmation:confirmation(r)});
  resolve(response(completed(r)));await screen.findByText(messages.submitted);expect(screen.getByText(messages.submittedNote)).toBeTruthy();
  expect(view.container.textContent).not.toContain(r.humanText.reason);expect(view.container.querySelector('textarea')).toBeNull();expect(screen.queryByRole('button',{name:messages.confirm})).toBeNull();
 });
 it('handles a lost confirmation response by reopening only the SAME action after an explicit click',async()=>{
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);show();const r=await prepare(fetchMock);
  fetchMock.mockRejectedValueOnce(Error('PRIVATE_SQL_AND_HUMAN_TEXT_SENTINEL'));fireEvent.click(screen.getByRole('button',{name:messages.confirm}));
  await screen.findByRole('button',{name:messages.reopen});expect(fetchMock).toHaveBeenCalledTimes(2);expect(screen.queryByRole('button',{name:messages.confirm})).toBeNull();expect(screen.queryByRole('button',{name:messages.prepare})).toBeNull();expect(document.body.textContent).not.toContain('PRIVATE_SQL');expect(document.body.textContent).not.toContain(r.humanText.reason);
  fetchMock.mockResolvedValueOnce(response(completed(r)));fireEvent.click(screen.getByRole('button',{name:messages.reopen}));await screen.findByText(messages.submitted);
  expect(body(fetchMock,2)).toEqual({operation:'reopen',actionId:r.actionId});expect(fetchMock).toHaveBeenCalledTimes(3);
 });
 it('reopens a still-pending saved review without auto-confirming and discards only after the human asks',async()=>{
  const r=review(),fetchMock=vi.fn().mockResolvedValueOnce(response({kind:'prepared',review:r}));vi.stubGlobal('fetch',fetchMock);const view=show(r.actionId);expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:messages.reopen}));await screen.findByRole('button',{name:messages.confirm});expect(fetchMock).toHaveBeenCalledTimes(1);expect(body(fetchMock,0)).toEqual({operation:'reopen',actionId:r.actionId});
  fetchMock.mockResolvedValueOnce(response({kind:'retired',receipt:{actionId:r.actionId,contractVersion:1,state:'discarded'}}));fireEvent.click(screen.getByRole('button',{name:messages.discard}));await screen.findByText(messages.discarded);
  expect(body(fetchMock,1)).toEqual({operation:'discard',confirmation:confirmation(r)});expect(view.container.textContent).not.toContain(r.humanText.reason);
 });
 it('does not accept another action receipt, echo server details, or create a new action after ambiguous preparation',async()=>{
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);show();const r=await prepare(fetchMock);
  fetchMock.mockResolvedValueOnce(response(completed(review())));fireEvent.click(screen.getByRole('button',{name:messages.confirm}));await screen.findByRole('button',{name:messages.reopen});expect(fetchMock).toHaveBeenCalledTimes(2);expect(screen.queryByText(messages.submitted)).toBeNull();
  cleanup();fetchMock.mockReset().mockRejectedValueOnce(Error('PRIVATE_PREPARE_SENTINEL'));show();fill();fireEvent.click(screen.getByRole('button',{name:messages.prepare}));await screen.findByText(messages.prepareUncertain);
  expect(fetchMock).toHaveBeenCalledTimes(1);expect(screen.getAllByRole('button')).toHaveLength(1);expect(screen.getByRole('button',{name:messages.findReviews})).toBeTruthy();expect(document.body.textContent).not.toContain('PRIVATE_PREPARE');expect(document.body.textContent).not.toContain(r.humanText.reason);
 });
 it('recovers lost preparation through explicit metadata discovery then explicit reopen, never creating or confirming automatically',async()=>{
  const fetchMock=vi.fn().mockRejectedValueOnce(Error('Lost preparation response'));vi.stubGlobal('fetch',fetchMock);show();fill();fireEvent.click(screen.getByRole('button',{name:messages.prepare}));await screen.findByText(messages.prepareUncertain);
  const r=review(),entry={actionId:r.actionId,state:'awaiting_confirmation',createdAt:r.createdAt,expiresAt:r.expiresAt};
  fetchMock.mockResolvedValueOnce(response({kind:'review_index',reviews:[entry]}));fireEvent.click(screen.getByRole('button',{name:messages.findReviews}));await screen.findByRole('heading',{name:messages.savedReviews});
  expect(fetchMock).toHaveBeenCalledTimes(2);expect(body(fetchMock,1)).toEqual({operation:'list'});expect(document.body.textContent).not.toContain(r.humanText.reason);expect(screen.queryByRole('button',{name:messages.confirm})).toBeNull();
  fetchMock.mockResolvedValueOnce(response({kind:'prepared',review:r}));fireEvent.click(screen.getByRole('button',{name:new RegExp('^'+messages.openSavedReview)}));await screen.findByRole('button',{name:messages.confirm});
  expect(body(fetchMock,2)).toEqual({operation:'reopen',actionId:r.actionId});expect(fetchMock).toHaveBeenCalledTimes(3);expect(document.body.textContent).toContain(r.humanText.reason);
 });
 it('keeps known submission uncertainty bound to the same action even when other saved metadata is discovered',async()=>{
  const r=review(),other=review(),fetchMock=vi.fn().mockResolvedValueOnce(response({kind:'review_index',reviews:[{actionId:r.actionId,state:'awaiting_confirmation',createdAt:r.createdAt,expiresAt:r.expiresAt},{actionId:other.actionId,state:'completed',createdAt:other.createdAt,expiresAt:other.expiresAt}]}));vi.stubGlobal('fetch',fetchMock);show(r.actionId);
  fireEvent.click(screen.getByRole('button',{name:messages.findReviews}));await screen.findByRole('heading',{name:messages.savedReviews});
  expect((screen.getByRole('button',{name:new RegExp(messages.openSavedReview+': '+messages.savedCompleted)}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button',{name:new RegExp(messages.openSavedReview+': '+messages.savedPending)}) as HTMLButtonElement).disabled).toBe(false);expect(fetchMock).toHaveBeenCalledTimes(1);expect(screen.queryByRole('button',{name:messages.prepare})).toBeNull();
 });
 it('preserves authored text after a definitive needs-remark refusal and never substitutes model text',async()=>{
  const fetchMock=vi.fn().mockResolvedValueOnce(response({kind:'needs_employee_remark'}));vi.stubGlobal('fetch',fetchMock);show();fill();fireEvent.click(screen.getByRole('button',{name:messages.prepare}));await screen.findByText(messages.needsRemark);
  expect((screen.getByLabelText(messages.reason) as HTMLTextAreaElement).value).toBe('Exact human reason');expect(fetchMock).toHaveBeenCalledTimes(1);expect(screen.getByRole('link',{name:en.ownLeaveReview.openForm}).getAttribute('href')).toBe('/leave?apply=1');
 });
 it('disables stale expired reviews, keeps explicit discard available, and accepts no malformed resume selector',async()=>{
  const r=review();r.createdAt=new Date(Date.now()-120000).toISOString();r.expiresAt=new Date(Date.now()-60000).toISOString();const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);show();await prepare(fetchMock,r);
  await waitFor(()=>expect((screen.getByRole('button',{name:messages.confirm}) as HTMLButtonElement).disabled).toBe(true));expect((screen.getByRole('button',{name:messages.discard}) as HTMLButtonElement).disabled).toBe(false);
  cleanup();show('PRIVATE_MALFORMED_SELECTOR');expect(screen.getAllByRole('button')).toHaveLength(1);expect(screen.getByRole('button',{name:messages.findReviews})).toBeTruthy();expect(document.body.textContent).not.toContain('PRIVATE_MALFORMED_SELECTOR');
 });
});

describe('bounded own-leave browser response protocol',()=>{
 it('parses only public strict fields and refuses foreign action bindings',async()=>{
  const r=review();expect(await readOwnLeaveCommandResponse(response({kind:'prepared',review:r}),r.actionId)).toEqual({kind:'prepared',review:r});
  await expect(readOwnLeaveCommandResponse(response(completed(r)),randomUUID())).rejects.toThrow('response unavailable');
  await expect(readOwnLeaveCommandResponse(response({kind:'prepared',review:{...r,hiddenBalance:10}}),r.actionId)).rejects.toThrow('response unavailable');
  await expect(readOwnLeaveCommandResponse(response({kind:'unavailable'}),r.actionId)).rejects.toThrow('response unavailable');
 });
 it('accepts only bounded strict metadata indexes, rejecting duplicates, source data, digest fields and unknown states',async()=>{
  const r=review(),entry={actionId:r.actionId,state:'awaiting_confirmation',createdAt:r.createdAt,expiresAt:r.expiresAt};
  expect(await readOwnLeaveCommandResponse(response({kind:'review_index',reviews:[entry]}))).toEqual({kind:'review_index',reviews:[entry]});
  for(const rows of [[entry,entry],[{...entry,reviewedDigest:r.reviewedDigest}],[{...entry,employmentId}],[{...entry,state:'approved'}],Array.from({length:26},()=>({...entry,actionId:randomUUID()}))])await expect(readOwnLeaveCommandResponse(response({kind:'review_index',reviews:rows}))).rejects.toThrow('response unavailable');
 });
 it('refuses non-success/non-JSON/malformed UTF-8 and excessive body declarations without echoing bodies',async()=>{
  for(const r of [new Response('PRIVATE_INTERNAL_ERROR',{status:403}),new Response('PRIVATE_INTERNAL_ERROR',{headers:{'content-type':'text/plain'}}),new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'32769'}})])await expect(readOwnLeaveCommandResponse(r)).rejects.toThrow('response unavailable');
 });
 it('cancels an oversized streaming body and refuses truncated/malformed JSON',async()=>{
  const cancel=vi.fn();const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(32769));},cancel});
  await expect(readOwnLeaveCommandResponse(new Response(stream,{headers:{'content-type':'application/json'}}))).rejects.toThrow('response unavailable');expect(cancel).toHaveBeenCalledTimes(1);
  await expect(readOwnLeaveCommandResponse(new Response('{',{headers:{'content-type':'application/json'}}))).rejects.toThrow('response unavailable');
 });
});
