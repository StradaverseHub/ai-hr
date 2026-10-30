/** @vitest-environment jsdom */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EmployeeDraftDiscardPanel} from '../components/assistant/employee-draft-discard-panel';
import {EmployeeDraftDiscard as C} from '../lib/assistant-actions/employee-draft-discard-contract';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import viMessages from '../messages/vi.json';import th from '../messages/th.json';import ta from '../messages/ta.json';
const translation=vi.hoisted(()=>({messages:null as unknown}));
vi.mock('next-intl',()=>({useTranslations:(namespace:string)=>(key:string,values?:Record<string,string>)=>{let value=translation.messages;for(const part of (namespace+'.'+key).split('.'))value=(value as Record<string,unknown>)?.[part];return typeof value==='string'?value.replace(/\{(\w+)\}/g,(_,name)=>values?.[name]??'{'+name+'}'):key;},useFormatter:()=>({dateTime:(date:Date)=>date.toISOString()})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
const draftId='92000000-0000-4000-8000-000000000001',companyId='92000000-0000-4000-8000-000000000002',actionId='92000000-0000-4000-8000-000000000003',eventId='92000000-0000-4000-8000-000000000004',other='92000000-0000-4000-8000-000000000005';
const content={action:C.action,contractVersion:1,draftId,companyId,consent:'discard_saved_draft_captured_input'},copy=en.assistant.workspace.employeeDraftDiscard;
const choices={kind:'choices',drafts:[{draftId,companyId,companyName:'Fictional Company',label:'Fictional saved draft',employeeCode:'SAVED-10',supported:true,unsupportedReason:null,route:'/admin/personnel/new'}],truncated:false};
type OutcomeKind='no_reservation'|'unreserved_code'|'released_tip'|'retained_gap';
const outcome=(kind:OutcomeKind)=>({kind,reservedEmployeeCode:kind==='no_reservation'?null:'SAVED-10'});
const prepared=(kind:OutcomeKind='released_tip')=>({kind:'prepared',review:{action:C.action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64),createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),content,review:{draftId,companyId,companyName:'Fictional Company',draftLabel:'Fictional saved draft',scope:'saved_draft_without_any_linked_onboarding_case',capturedInput:'saved_draft_row_deleted_without_application_undo',reservedCodeOutcome:outcome(kind),consequence:'native_saved_draft_deleted_not_employee'}}});
const completed=(kind:OutcomeKind='released_tip')=>({kind:'completed',receipt:{action:C.action,contractVersion:1,actionId,state:'completed',receipt:{kind:'discarded',draftId,companyId,eventId,reservedCodeOutcome:outcome(kind),capturedInput:'saved_draft_row_deleted_without_application_undo',consequence:'native_saved_draft_deleted_not_employee'}}});
const retired={kind:'retired',receipt:{action:C.action,contractVersion:1,actionId,state:'discarded'}};
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}}),fetcher=vi.fn(),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
const text=(template:string)=>template.replace('{code}','SAVED-10');
beforeEach(()=>{translation.messages=en;fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function select(){await screen.findByRole('option',{name:/Fictional saved draft/});await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));fireEvent.change(screen.getByRole('combobox'),{target:{value:draftId}});}
async function prepare(){await select();fireEvent.click(screen.getByLabelText(copy.prepareConsent));fireEvent.submit(screen.getByRole('button',{name:copy.prepare}).closest('form')!);await screen.findByRole('heading',{name:copy.reviewTitle});}
async function confirm(){fireEvent.click(screen.getByLabelText(copy.confirmConsent));fireEvent.click(screen.getByRole('button',{name:copy.confirm}));}

it('requires selected human intent and fresh irreversible consent, then posts only the exact saved subject and digest',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(json(completed()));render(<EmployeeDraftDiscardPanel/>);await select();
 expect((screen.getByRole('button',{name:copy.prepare}) as HTMLButtonElement).disabled).toBe(true);fireEvent.submit(screen.getByRole('button',{name:copy.prepare}).closest('form')!);expect(packets()).toHaveLength(1);
 fireEvent.click(screen.getByLabelText(copy.prepareConsent));fireEvent.submit(screen.getByRole('button',{name:copy.prepare}).closest('form')!);await screen.findByRole('heading',{name:copy.reviewTitle});
 expect(screen.getByText(copy.consequence)).toBeTruthy();expect(screen.getByText('Fictional Company')).toBeTruthy();expect(packets()[1]).toEqual({action:C.action,operation:'prepare',input:content});
 expect((screen.getByRole('button',{name:copy.confirm}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:copy.confirm}));expect(packets()).toHaveLength(2);
 await confirm();await screen.findByRole('heading',{name:copy.done});expect(packets()[2]).toEqual({action:C.action,operation:'confirm',confirmation:{...content,actionId,reviewedDigest:'a'.repeat(64)}});
 expect(screen.getByText(copy.doneNote)).toBeTruthy();expect(fetcher.mock.calls[2][1]).toMatchObject({mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error'});
});

for(const kind of ['no_reservation','unreserved_code','released_tip','retained_gap'] as const)it(`renders the actual ${kind} review and completed outcome without counter inference`,async()=>{
 fetcher.mockResolvedValueOnce(json(prepared(kind))).mockResolvedValueOnce(json(completed(kind)));render(<EmployeeDraftDiscardPanel resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('heading',{name:copy.reviewTitle});expect(screen.getByText(text(copy.outcomes[kind]))).toBeTruthy();await confirm();await screen.findByRole('heading',{name:copy.done});expect(screen.getByText(text(copy.completedOutcomes[kind]))).toBeTruthy();
});

it('retires only the review and never sends the native discard confirmation',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(json(retired));render(<EmployeeDraftDiscardPanel/>);await prepare();expect(screen.getByText(copy.retireNote)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:copy.retire}));await screen.findByText(copy.states.discarded);expect(packets()[2]).toEqual({action:C.action,operation:'retire',confirmation:{action:C.action,contractVersion:1,actionId}});expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(0);
});

it('recovers a lost confirmation from the same review without repeating the command',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockRejectedValueOnce(Error('lost response')).mockResolvedValueOnce(json(completed()));render(<EmployeeDraftDiscardPanel/>);await prepare();await confirm();await screen.findByText(copy.uncertain);expect(screen.queryByRole('button',{name:copy.confirm})).toBeNull();fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('heading',{name:copy.done});expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);expect(packets()[3]).toEqual({action:C.action,operation:'reopen',actionId});
});

it('recovers an unknown preparation via the saved index rather than preparing again',async()=>{
 const times=prepared().review;fetcher.mockResolvedValueOnce(json(choices)).mockRejectedValueOnce(Error('lost preparation')).mockResolvedValueOnce(json({kind:'employee_draft_discard_review_index',reviews:[{action:C.action,contractVersion:1,actionId,state:'awaiting_confirmation',createdAt:times.createdAt,expiresAt:times.expiresAt}]})).mockResolvedValueOnce(json(prepared()));render(<EmployeeDraftDiscardPanel/>);await select();fireEvent.click(screen.getByLabelText(copy.prepareConsent));fireEvent.click(screen.getByRole('button',{name:copy.prepare}));await screen.findByText(copy.uncertainUnknown);expect(screen.queryByRole('button',{name:copy.prepare})).toBeNull();fireEvent.click(screen.getByRole('button',{name:copy.find}));await screen.findByRole('button',{name:copy.reopen});fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('heading',{name:copy.reviewTitle});expect(packets().map(packet=>packet.operation)).toEqual(['choices','prepare','list','reopen']);expect((screen.getByLabelText(copy.confirmConsent) as HTMLInputElement).checked).toBe(false);
});

it('refuses a substituted selected company before displaying review or confirmation',async()=>{
 const wrong=prepared();wrong.review.content={...content,companyId:other};wrong.review.review.companyId=other;fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(wrong));render(<EmployeeDraftDiscardPanel/>);await select();fireEvent.click(screen.getByLabelText(copy.prepareConsent));fireEvent.click(screen.getByRole('button',{name:copy.prepare}));await screen.findByRole('alert');expect(screen.queryByRole('heading',{name:copy.reviewTitle})).toBeNull();expect(screen.queryByRole('button',{name:copy.confirm})).toBeNull();
});

it('hands a selected native refusal back to Personnel without confirming unseen effects',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json({kind:'handoff',reason:'native_discard_refused',route:'/admin/personnel/new'}));render(<EmployeeDraftDiscardPanel/>);await select();fireEvent.click(screen.getByLabelText(copy.prepareConsent));fireEvent.click(screen.getByRole('button',{name:copy.prepare}));await screen.findByText(copy.handoff);expect(screen.queryByRole('button',{name:copy.confirm})).toBeNull();expect(screen.getAllByRole('link',{name:copy.native}).some(link=>link.getAttribute('href')==='/admin/personnel/new?draft='+draftId)).toBe(true);expect(packets().map(packet=>packet.operation)).toEqual(['choices','prepare']);
});

it('offers native handoff for linked onboarding and sends no preparation',async()=>{
 fetcher.mockResolvedValueOnce(json({...choices,drafts:[{...choices.drafts[0],supported:false,unsupportedReason:'linked_onboarding_case'}]}));render(<EmployeeDraftDiscardPanel/>);await select();expect(screen.getByText(copy.onboardingHandoff)).toBeTruthy();expect(screen.queryByRole('button',{name:copy.prepare})).toBeNull();expect(screen.getAllByRole('link',{name:copy.native}).some(link=>link.getAttribute('href')==='/admin/personnel/new?draft='+draftId)).toBe(true);expect(packets()).toHaveLength(1);
});

it('never allows a response that is already expired to inherit stale confirmation consent',async()=>{
 const value=prepared();value.review.createdAt=new Date(Date.now()-120000).toISOString();value.review.expiresAt=new Date(Date.now()-60000).toISOString();fetcher.mockResolvedValueOnce(json(value));render(<EmployeeDraftDiscardPanel resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('heading',{name:copy.reviewTitle});expect(screen.getByText(copy.expired)).toBeTruthy();expect(screen.queryByLabelText(copy.confirmConsent)).toBeNull();expect((screen.getByRole('button',{name:copy.confirm}) as HTMLButtonElement).disabled).toBe(true);
});

it('rechecks expiry at the button action even before a browser timer has run',async()=>{
 fetcher.mockResolvedValueOnce(json(prepared()));render(<EmployeeDraftDiscardPanel resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('heading',{name:copy.reviewTitle});fireEvent.click(screen.getByLabelText(copy.confirmConsent));vi.spyOn(Date,'now').mockReturnValue(Date.now()+120000);fireEvent.click(screen.getByRole('button',{name:copy.confirm}));await screen.findByText(copy.expired);expect(packets().map(packet=>packet.operation)).toEqual(['reopen']);
});

it('cancels an oversized streamed response before parsing or displaying a review',async()=>{
 const cancel=vi.fn();fetcher.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(65537));},cancel}),{headers:{'Content-Type':'application/json'}}));render(<EmployeeDraftDiscardPanel resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('alert');expect(cancel).toHaveBeenCalledTimes(1);expect(screen.queryByRole('heading',{name:copy.reviewTitle})).toBeNull();expect(screen.queryByRole('button',{name:copy.confirm})).toBeNull();
});

it('refuses non-JSON responses and duplicate in-flight confirmations',async()=>{
 let finish:((value:Response)=>void)|undefined;fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));render(<EmployeeDraftDiscardPanel/>);await prepare();fireEvent.click(screen.getByLabelText(copy.confirmConsent));const button=screen.getByRole('button',{name:copy.confirm});fireEvent.click(button);fireEvent.click(button);expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);finish!(new Response('<html>untrusted response</html>',{headers:{'Content-Type':'text/html'}}));await screen.findByRole('alert');expect(screen.queryByRole('heading',{name:copy.done})).toBeNull();
});

for(const [locale,messages]of Object.entries({en,ms,zh,vi:viMessages,th,ta}))it(`renders saved-input consent and native outcome in ${locale}`,async()=>{
 translation.messages=messages;const local=messages.assistant.workspace.employeeDraftDiscard;fetcher.mockResolvedValueOnce(json(prepared('retained_gap')));const view=render(<main className="mx-auto max-w-4xl"><EmployeeDraftDiscardPanel resumeActionId={actionId}/></main>);fireEvent.click(screen.getByRole('button',{name:local.reopen}));await screen.findByRole('heading',{name:local.reviewTitle});expect(screen.getByText(local.consequence)).toBeTruthy();expect(screen.getByLabelText(local.confirmConsent)).toBeTruthy();expect(screen.getByText(text(local.outcomes.retained_gap))).toBeTruthy();expect((screen.getByRole('button',{name:local.confirm}) as HTMLButtonElement).disabled).toBe(true);await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'chat-card-employee-draft-discard','actual saved-draft discard panel; fictional native review outcome; scripted same-origin endpoint; no authenticated server journey');
},30000);
