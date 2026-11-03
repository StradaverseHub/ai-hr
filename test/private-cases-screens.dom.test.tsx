/** @vitest-environment jsdom */
/** AI v2 Phase 1 W11 — the rendered screens of the protected case route (ADR-0173), in each role they serve, with the
 * real English catalogue: the AI Centre's routed reply (employee), the person's own cases and the intake form (author),
 * the queue and one case (handler, and a login that handles none), and the designation screen (company and group HR
 * administrators), plus the entry cards on My Profile and Data privacy. The owner service is stubbed with fictional
 * results here; its access rules are proved on the database by test/private-cases.test.ts. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {createFormatter,createTranslator} from 'next-intl';
import {enWithAiCentre} from './helpers/ai-centre-messages';

const svc=vi.hoisted(()=>({intake:vi.fn(),listOwn:vi.fn(),readOwn:vi.fn(),handles:vi.fn(),listHandled:vi.fn(),readHandled:vi.fn(),admin:vi.fn(),session:{current:{} as Record<string,unknown>}}));
vi.mock('next/link',()=>({default:({children,prefetch:_prefetch,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('NOT_FOUND');},redirect:(url:string)=>{throw new Error('REDIRECT:'+url);},usePathname:()=>'/me/cases',
 useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async(namespace:any)=>createTranslator({locale:'en',messages:enWithAiCentre as never,namespace}),
 getFormatter:async()=>createFormatter({locale:'en',timeZone:'Asia/Kuala_Lumpur'})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:svc.session.current,scopeIds:[],allowedCount:1})}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>svc.session.current}));
vi.mock('../core/private-cases',()=>{
 class PrivateCaseError extends Error{constructor(readonly code:string){super('Private case: '+code);}}
 return{PRIVATE_CASE_CATEGORIES:['grievance','harassment','safety','other'],PRIVATE_CASE_LIMITS:{textChars:8000,noteChars:4000,cases:100,excluded:50},PrivateCaseError,
  privateCaseIntake:svc.intake,listOwnPrivateCases:svc.listOwn,readOwnPrivateCase:svc.readOwn,handlesPrivateCases:svc.handles,listHandledPrivateCases:svc.listHandled,
  readHandledPrivateCase:svc.readHandled,caseHandlerAdmin:svc.admin};
});
// The chat cards' own server actions, as in test/ai-centre-inline-proposal-actions.dom.test.tsx: no routed reply carries a card.
vi.mock('../app/assistant/leave-apply-proposal-actions',()=>({confirmLeaveApplyProposalAction:vi.fn(),editLeaveApplyProposalAction:vi.fn()}));
vi.mock('../app/assistant/attendance-request-proposal-actions',()=>({confirmAttendanceRequestProposalAction:vi.fn(),editAttendanceRequestProposalAction:vi.fn()}));
vi.mock('../app/assistant/own-change-proposal-actions',()=>({confirmOwnChangeProposalAction:vi.fn(),editOwnChangeProposalAction:vi.fn()}));
vi.mock('../app/me/cases/actions',()=>({openPrivateCaseAction:vi.fn()}));
vi.mock('../app/cases/actions',()=>({setPrivateCaseStatusAction:vi.fn(),addPrivateCaseNoteAction:vi.fn()}));
vi.mock('../app/admin/privacy/case-handlers/actions',()=>({designateCaseHandlerAction:vi.fn(),revokeCaseHandlerAction:vi.fn()}));
import {PrivateCaseError} from '../core/private-cases';
import {ConversationReply} from '../components/ai-centre/conversation-reply';
import {PrivateCaseEntryCard,PrivateCaseHandlersCard} from '../components/private-cases/entry-cards';
import MyPrivateCasesPage from '../app/me/cases/page';
import NewPrivateCasePage from '../app/me/cases/new/page';
import MyPrivateCasePage from '../app/me/cases/[caseId]/page';
import HandledPrivateCasesPage from '../app/cases/page';
import HandledPrivateCasePage from '../app/cases/[caseId]/page';
import CaseHandlersPage from '../app/admin/privacy/case-handlers/page';

const COMPANY='00000000-0000-4000-8000-00000000c0aa',CASE='00000000-0000-4000-8000-0000000ca5e1',HANDLER='00000000-0000-4000-8000-0000000000e1';
const employee={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',roles:['employee'],grants:[{role:'employee',companyId:null}]};
const companyAdmin={...employee,userId:'00000000-0000-4000-8000-0000000000ad',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:COMPANY}]};
const groupAdmin={...employee,userId:'00000000-0000-4000-8000-0000000000ga',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
const OPENED=new Date('2026-11-02T02:00:00Z'),CHANGED=new Date('2026-11-03T03:30:00Z');
const GROUP_ADMIN='00000000-0000-4000-8000-0000000000e2';
const intake=(over:Record<string,unknown>={})=>({companies:[{id:COMPANY,name:'Fictional Sdn Bhd'}],companyId:COMPANY,
 readers:[{userId:HANDLER,name:'Fictional Handler Aminah',kind:'handler'},{userId:GROUP_ADMIN,name:'Fictional Group Administrator Lim',kind:'group_admin'}],storable:true,...over});
const turn=(over:Record<string,unknown>={})=>({turnId:'turn-case',reply:'For this, please contact your HR team directly.',mode:null,slot:null,suggestion:null,proposals:[],reads:[],
 sensitive:true,refused:false,crisis:false,fallback:false,caseRoute:'/me/cases/new',continuation:'tc1.fixture',trace:{} as never,modelTurn:[],...over}) as never;
const handled=(over:Record<string,unknown>={})=>({id:CASE,category:'harassment',status:'received',companyName:'Fictional Sdn Bhd',route:'handlers',openedAt:OPENED,statusChangedAt:OPENED,
 erasureRequested:false,author:'Fictional Author Farid',version:1,text:'Fictional text: comments about my appearance in the team chat.',next:['in_review','closed'],
 notes:[{id:'n1',author:'Fictional Handler Aminah',own:true,at:CHANGED,text:'Fictional note: spoke to the author.'}],
 audit:[{kind:'created',actor:'Fictional Author Farid',own:false,at:OPENED,from:null,to:null},{kind:'read',actor:'Fictional Handler Aminah',own:true,at:CHANGED,from:null,to:null}],...over});

beforeEach(()=>{vi.clearAllMocks();svc.session.current=employee;svc.intake.mockResolvedValue(intake());svc.listOwn.mockResolvedValue([]);svc.handles.mockResolvedValue(false);svc.listHandled.mockResolvedValue([]);});
afterEach(cleanup);

describe('the AI Centre reply (employee)',()=>{
 it('offers "Start a private case with HR" on a routed reply where the route is set up, linking to the form only',async()=>{
  render(await ConversationReply({turn:turn()}));
  const note=screen.getByRole('note');
  expect(note.getAttribute('data-teras-route')).toBe('hr_contact');
  const link=within(note).getByRole('link',{name:'Start a private case with HR'});
  expect(link.getAttribute('href')).toBe('/me/cases/new');
  expect(note.textContent).toContain('Sent to your HR team');
 });
 it('leads a crisis with emergency help, and the case link follows it',async()=>{
  render(await ConversationReply({turn:turn({crisis:true,reply:'If you are in danger or thinking about harming yourself, please contact emergency services now (999 in Malaysia).'})}));
  const note=screen.getByRole('note');expect(note.getAttribute('data-teras-route')).toBe('crisis');
  const help=within(note).getByText('If you are in danger, contact emergency services now.'),link=within(note).getByRole('link',{name:'Start a private case with HR'});
  expect(help.compareDocumentPosition(link)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 });
 it('shows no case link where the route is not set up, nor on an ordinary reply',async()=>{
  render(await ConversationReply({turn:turn({caseRoute:null})}));
  expect(screen.queryByRole('link',{name:'Start a private case with HR'})).toBeNull();expect(screen.getByRole('note')).toBeTruthy();
  cleanup();
  render(await ConversationReply({turn:turn({sensitive:false,caseRoute:null,reply:'Public holidays are listed under Leave.'})}));
  expect(screen.queryByRole('note')).toBeNull();expect(document.querySelector('[data-teras-case-route]')).toBeNull();
 });
});

describe('the person\'s own cases (author)',()=>{
 it('lists their cases without text and offers Start where the route is set up',async()=>{
  svc.listOwn.mockResolvedValue([{id:CASE,category:'grievance',status:'in_review',companyName:'Fictional Sdn Bhd',openedAt:OPENED,statusChangedAt:CHANGED,reachable:true}]);
  render(await MyPrivateCasesPage());
  expect(screen.getByRole('heading',{name:'Private cases with HR'})).toBeTruthy();
  expect(screen.getByRole('link',{name:'Start a private case'}).getAttribute('href')).toBe('/me/cases/new');
  expect(screen.getByText('Grievance')).toBeTruthy();expect(screen.getByText('In review')).toBeTruthy();
  expect(screen.getByRole('link',{name:'View'}).getAttribute('href')).toBe('/me/cases/'+CASE);
  expect(screen.queryByRole('link',{name:'Cases you handle'})).toBeNull();
  expect(svc.listOwn).toHaveBeenCalledExactlyOnceWith(employee);
  expect(screen.queryByText('Nobody can read it yet')).toBeNull();
 });
 it('marks a case nobody may read in the list',async()=>{
  svc.listOwn.mockResolvedValue([{id:CASE,category:'grievance',status:'received',companyName:'Fictional Sdn Bhd',openedAt:OPENED,statusChangedAt:OPENED,reachable:false}]);
  render(await MyPrivateCasesPage());
  expect(screen.getByText('Nobody can read it yet')).toBeTruthy();
 });
 it('says the route is not set up, with no Start, when no company of theirs has a handler; a handler also sees their queue link',async()=>{
  svc.intake.mockResolvedValue(intake({companies:[],companyId:null,handlers:[]}));svc.handles.mockResolvedValue(true);
  render(await MyPrivateCasesPage());
  expect(screen.queryByRole('link',{name:'Start a private case'})).toBeNull();
  expect(screen.getByRole('note').textContent).toBe('Private cases are not set up for your company yet. Please contact your HR team directly.');
  expect(screen.getByText('You have not opened a private case.')).toBeTruthy();
  expect(screen.getByRole('link',{name:'Cases you handle'}).getAttribute('href')).toBe('/cases');
 });
 it('the form: a category, the text, the named handlers to leave out, the group administrator, and one explicit Send',async()=>{
  render(await NewPrivateCasePage({searchParams:Promise.resolve({})}));
  expect(screen.getAllByRole('radio').map(radio=>(radio as HTMLInputElement).value)).toEqual(['grievance','harassment','safety','other']);
  const text=screen.getByRole('textbox',{name:'What happened'}) as HTMLTextAreaElement;expect(text.required).toBe(true);expect(text.maxLength).toBe(8000);
  // Everyone who could read it can be left out: the handler and the group administrator alike.
  const exclude=screen.getByRole('checkbox',{name:'Do not send it to Fictional Handler Aminah (case handler)'}) as HTMLInputElement;
  expect(exclude.name).toBe('excludedUserIds');expect(exclude.value).toBe(HANDLER);expect(exclude.checked).toBe(false);
  const excludeAdmin=screen.getByRole('checkbox',{name:'Do not send it to Fictional Group Administrator Lim (group administrator)'}) as HTMLInputElement;
  expect(excludeAdmin.name).toBe('excludedUserIds');expect(excludeAdmin.value).toBe(GROUP_ADMIN);
  expect((screen.getByRole('checkbox',{name:'Send it to the group administrator instead of the case handlers'}) as HTMLInputElement).value).toBe('group_admin');
  expect(document.querySelector<HTMLInputElement>('input[name="companyId"]')!.value).toBe(COMPANY);
  expect(screen.getAllByRole('button').map(button=>button.textContent)).toEqual(['Send to HR']);
  expect(screen.getByText(/the AI Centre do not\.$/)).toBeTruthy();
 });
 it('the form explains a refusal, and is not offered where the route is not set up',async()=>{
  render(await NewPrivateCasePage({searchParams:Promise.resolve({error:'invalid'})}));
  expect(screen.getByRole('alert').textContent).toBe('Check the form: choose what it is about and write what happened.');
  cleanup();svc.intake.mockResolvedValue(intake({companies:[],companyId:null,handlers:[]}));
  render(await NewPrivateCasePage({searchParams:Promise.resolve({})}));
  expect(screen.queryByRole('button',{name:'Send to HR'})).toBeNull();expect(screen.getByRole('note')).toBeTruthy();
 });
 it('one own case: what they wrote and its status steps, never notes or readers; another case is not found',async()=>{
  svc.readOwn.mockResolvedValue({id:CASE,category:'safety',status:'in_review',companyName:'Fictional Sdn Bhd',openedAt:OPENED,text:'Fictional text: the fire exit is blocked.',reachable:true,
   history:[{status:'received',at:OPENED},{status:'in_review',at:CHANGED}]});
  render(await MyPrivateCasePage({params:Promise.resolve({caseId:CASE}),searchParams:Promise.resolve({notice:'sent'})}));
  expect(screen.getByRole('status').textContent).toBe('Your case was sent to HR.');
  expect(document.querySelector('[data-private-case-text]')!.textContent).toBe('Fictional text: the fire exit is blocked.');
  expect(screen.getAllByRole('listitem').map(item=>item.textContent?.split(',')[0])).toEqual(['Received','In review']);
  expect(screen.queryByText(/note/i)).toBeNull();expect(screen.queryByText(/Read by/)).toBeNull();
  expect(document.querySelector('[data-private-case-no-reader]')).toBeNull();
  svc.readOwn.mockRejectedValue(new PrivateCaseError('not_found'));
  await expect(MyPrivateCasePage({params:Promise.resolve({caseId:CASE}),searchParams:Promise.resolve({})})).rejects.toThrow('NOT_FOUND');
 });
 it('tells the author plainly when nobody may read their case, naming the external channel placeholder, instead of "sent"',async()=>{
  svc.readOwn.mockResolvedValue({id:CASE,category:'harassment',status:'received',companyName:'Fictional Sdn Bhd',openedAt:OPENED,text:'Fictional text.',reachable:false,
   history:[{status:'received',at:OPENED}]});
  render(await MyPrivateCasePage({params:Promise.resolve({caseId:CASE}),searchParams:Promise.resolve({notice:'sent'})}));
  expect(screen.getByRole('alert').textContent).toBe('No eligible reader is configured for this company, so nobody can read this case yet. Please contact [the company’s designated external channel, for example an ethics line].');
  expect(screen.queryByText('Your case was sent to HR.')).toBeNull();
 });
});

describe('handling (case handler, and a login that handles none)',()=>{
 it('a login that handles no case sees no queue and nothing is listed',async()=>{
  render(await HandledPrivateCasesPage({searchParams:Promise.resolve({})}));
  expect(screen.getByRole('note').textContent).toBe('You do not handle private cases.');
  expect(svc.listHandled).not.toHaveBeenCalled();
 });
 it('a handler\'s queue: category, company, date, status and the erasure mark, without text or author',async()=>{
  svc.handles.mockResolvedValue(true);
  svc.listHandled.mockResolvedValue([{id:CASE,category:'harassment',status:'received',companyName:'Fictional Sdn Bhd',route:'group_admin',openedAt:OPENED,statusChangedAt:OPENED,erasureRequested:true}]);
  render(await HandledPrivateCasesPage({searchParams:Promise.resolve({notice:'erased'})}));
  expect(screen.getByRole('status').textContent).toBe('The case was closed and deleted, as its author’s erasure request required.');
  expect(screen.getByText('Harassment')).toBeTruthy();expect(screen.getByText('Sent to the group administrator')).toBeTruthy();
  expect(screen.getByText('Its author asked for their data to be erased: this case will be deleted when it is closed.')).toBeTruthy();
  expect(screen.getByRole('link',{name:'Open'}).getAttribute('href')).toBe('/cases/'+CASE);
  expect(document.body.textContent).not.toContain('Fictional Author');
 });
 it('one case: the author, the text, the next steps, the notes and the record; a closed case offers neither steps nor a note',async()=>{
  svc.readHandled.mockResolvedValue(handled());
  render(await HandledPrivateCasePage({params:Promise.resolve({caseId:CASE}),searchParams:Promise.resolve({})}));
  expect(screen.getByText('Fictional Author Farid')).toBeTruthy();
  expect(document.querySelector('[data-private-case-text]')!.textContent).toBe('Fictional text: comments about my appearance in the team chat.');
  expect(screen.getByRole('button',{name:'Mark as In review'})).toBeTruthy();expect(screen.getByRole('button',{name:'Mark as Closed'})).toBeTruthy();
  const statusForms=[...document.querySelectorAll('form')].filter(form=>form.querySelector('input[name="status"]'));
  expect(statusForms.map(form=>[form.querySelector<HTMLInputElement>('input[name="expected"]')!.value,form.querySelector<HTMLInputElement>('input[name="status"]')!.value])).toEqual([['received','in_review'],['received','closed']]);
  expect(screen.getByText('Fictional note: spoke to the author.')).toBeTruthy();
  expect(screen.getByRole('textbox',{name:'Note'})).toBeTruthy();
  expect(screen.getByText('Opened by Fictional Author Farid')).toBeTruthy();expect(screen.getByText('Read by You')).toBeTruthy();
  cleanup();
  svc.readHandled.mockResolvedValue(handled({status:'closed',next:[]}));
  render(await HandledPrivateCasePage({params:Promise.resolve({caseId:CASE}),searchParams:Promise.resolve({error:'conflict'})}));
  expect(screen.queryByRole('button',{name:/Mark as/})).toBeNull();expect(screen.queryByRole('textbox',{name:'Note'})).toBeNull();
  expect(screen.getByText('This case is closed, so notes can no longer be added.')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe('This changed since you opened it. Please check it again.');
  svc.readHandled.mockRejectedValue(new PrivateCaseError('not_found'));
  await expect(HandledPrivateCasePage({params:Promise.resolve({caseId:CASE}),searchParams:Promise.resolve({})})).rejects.toThrow('NOT_FOUND');
 });
});

describe('designation (company and group HR administrators)',()=>{
 const admin=(over:Record<string,unknown>={})=>({companies:[{id:COMPANY,name:'Fictional Sdn Bhd'}],companyId:COMPANY,
  grants:[{id:'g1',userId:HANDLER,name:'Fictional Handler Aminah',grantedAt:OPENED,revokedAt:null},{id:'g0',userId:'u0',name:null,grantedAt:OPENED,revokedAt:CHANGED}],
  candidates:[{userId:'u2',name:'Fictional Candidate Wei'},{userId:'u3',name:null}],...over});
 it('a company HR administrator: current handlers to remove, people to add, earlier handlers, and why they cannot add themself',async()=>{
  svc.session.current=companyAdmin;svc.admin.mockResolvedValue(admin());
  render(await CaseHandlersPage({searchParams:Promise.resolve({notice:'added'})}));
  expect(screen.getByRole('status').textContent).toBe('Handler added.');
  expect(screen.getByText('Fictional Handler Aminah')).toBeTruthy();expect(screen.getByRole('button',{name:'Remove'})).toBeTruthy();
  expect(document.querySelector<HTMLInputElement>('input[name="handlerId"]')!.value).toBe('g1');
  const options=[...document.querySelector<HTMLSelectElement>('select[name="appUserId"]')!.options].map(option=>option.textContent);
  expect(options).toEqual(['—','Fictional Candidate Wei','Login without an employee record']);
  expect(screen.getByText('Earlier handlers')).toBeTruthy();
  expect(screen.getByText('You cannot name yourself a handler. A group administrator, or another administrator of the company, designates you.')).toBeTruthy();
  expect(svc.admin).toHaveBeenCalledExactlyOnceWith(companyAdmin,undefined);
 });
 it('a group administrator: the same no-self rule, and a company to choose',async()=>{
  svc.session.current=groupAdmin;svc.admin.mockResolvedValue(admin({companies:[{id:COMPANY,name:'Fictional Sdn Bhd'},{id:'c2',name:'Fictional Two Bhd'}]}));
  render(await CaseHandlersPage({searchParams:Promise.resolve({companyId:COMPANY})}));
  expect(screen.getByText('You cannot name yourself a handler. A group administrator, or another administrator of the company, designates you.')).toBeTruthy();
  const company=document.querySelector<HTMLSelectElement>('select[name="companyId"]')!;
  expect([...company.options].map(option=>option.textContent)).toEqual(['Fictional Sdn Bhd','Fictional Two Bhd']);expect(company.value).toBe(COMPANY);
 });
});

describe('entry cards',()=>{
 it('My Profile links to the person\'s own cases; Data privacy links to the designation screen',async()=>{
  render(await PrivateCaseEntryCard());
  expect(screen.getByRole('link',{name:'Private cases'}).getAttribute('href')).toBe('/me/cases');
  expect(screen.getByText(/The AI Centre never reads it\./)).toBeTruthy();
  cleanup();
  render(await PrivateCaseHandlersCard());
  expect(screen.getByRole('link',{name:'Manage case handlers'}).getAttribute('href')).toBe('/admin/privacy/case-handlers');
 });
});
