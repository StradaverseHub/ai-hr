import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {render,screen,waitFor,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {useState,useCallback} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {useBulkEmployeeVocabulary} from '../components/use-bulk-employee-vocabulary';
import {BulkEmployeePopover} from '../components/bulk-employee-popover';
import {AdjustmentForm} from '../components/leave/adjustment-form';
import {NoticeForm,type NoticeFormLabels} from '../components/notice/notice-form';
import {GenerateForm} from '../components/leave/generate-form';
import {matchesEmployeeSearch} from '../lib/employee-search';
import {resolveEmploymentSelection} from '../lib/employment-selection';
import type {LeaveGenerationResult} from '../core/leave-generation';
const rows=Array.from({length:1000},(_,i)=>({id:'11111111-1111-4111-8111-'+String(i).padStart(12,'0'),name:'Fictional employee '+String(i).padStart(4,'0'),employeeCode:'P-'+String(i).padStart(4,'0')}));
let requests:Record<string,unknown>[]=[],failNext=false;
const fakeFetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
 const input=JSON.parse(String(init?.body));requests.push(input);
 if(failNext){failNext=false;return new Response('{}',{status:503});}
 if(input.operation==='resolve')return Response.json({selection:resolveEmploymentSelection(input.picked,input.raw,rows),rows:rows.filter(row=>input.picked.includes(row.id)).slice(0,25)});
 const matches=rows.filter(row=>matchesEmployeeSearch(row,input.query));
 return Response.json({query:input.query,offset:input.offset,rows:matches.slice(input.offset,input.offset+25),total:matches.length,...(input.operation==='all'?{ids:matches.map(row=>row.id)}:{})});
});
beforeEach(()=>{requests=[];failNext=false;vi.stubGlobal('fetch',fakeFetch);fakeFetch.mockClear();window.localStorage.clear();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function Picker(){const [selected,setSelected]=useState(new Set<string>());const receive=useCallback(()=>{},[]);return <NextIntlClientProvider locale="en" messages={messages}><form data-testid="bulk-form"><BulkEmployeePopover name="employmentIds" label="Employees" allLabel="Choose people" options={[]} selected={selected} onChange={setSelected} onRows={receive} searchPlaceholder="Search employees" selectAllLabel="Select all" clearAllLabel="Clear all" selectedCount={count=>`${count} selected`}/></form></NextIntlClientProvider>;}
it('renders 25 labels, retains off-page picks, and submits the exact complete Select All set',async()=>{
 const user=userEvent.setup();render(<Picker/>);await user.click(screen.getByRole('button',{name:'Employees'}));
 await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(25));
 await user.click(screen.getAllByRole('checkbox')[0]);
 await user.click(screen.getByRole('button',{name:messages.employeePanel.nextPage}));
 await waitFor(()=>expect(screen.getByText(/Fictional employee 0025/)).toBeTruthy());
 await user.click(screen.getAllByRole('checkbox')[0]);
 expect(new FormData(screen.getByTestId('bulk-form') as HTMLFormElement).getAll('employmentIds')).toEqual([rows[0].id,rows[25].id]);
 await user.click(screen.getByRole('button',{name:'Select all'}));
 await waitFor(()=>expect(new FormData(screen.getByTestId('bulk-form') as HTMLFormElement).getAll('employmentIds')).toHaveLength(1000));
 const submitted=new FormData(screen.getByTestId('bulk-form') as HTMLFormElement).getAll('employmentIds');expect(new Set(submitted)).toEqual(new Set(rows.map(row=>row.id)));
 expect(screen.getAllByRole('checkbox')).toHaveLength(25);expect(requests.some(input=>input.operation==='all')).toBe(true);
});
it('clears the complete filtered cohort and preserves selections outside that filter',async()=>{
 const user=userEvent.setup();render(<Picker/>);await user.click(screen.getByRole('button',{name:'Employees'}));await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(25));
 await user.click(screen.getByRole('button',{name:'Select all'}));await waitFor(()=>expect(new FormData(screen.getByTestId('bulk-form') as HTMLFormElement).getAll('employmentIds')).toHaveLength(1000));
 await user.type(screen.getByPlaceholderText('Search employees'),'P00');await waitFor(()=>expect(requests.some(input=>input.operation==='page'&&input.query==='P00')).toBe(true));
 await user.click(screen.getByRole('button',{name:'Clear all'}));
 await waitFor(()=>expect(new FormData(screen.getByTestId('bulk-form') as HTMLFormElement).getAll('employmentIds')).toHaveLength(900));
 expect(new Set(new FormData(screen.getByTestId('bulk-form') as HTMLFormElement).getAll('employmentIds'))).toEqual(new Set(rows.slice(100).map(row=>row.id)));
});
it('keeps a failed page unselectable until a successful explicit retry',async()=>{
 const user=userEvent.setup();failNext=true;render(<Picker/>);await user.click(screen.getByRole('button',{name:'Employees'}));await screen.findByRole('alert');
 expect((screen.getByRole('button',{name:'Select all'}) as HTMLButtonElement).disabled).toBe(true);
 await user.click(screen.getByRole('button',{name:messages.employeePanel.retry}));await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(25));
});
it('discards a late complete-selection response after the operator changes search',async()=>{
 const user=userEvent.setup();render(<Picker/>);await user.click(screen.getByRole('button',{name:'Employees'}));await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(25));
 let finish:(response:Response)=>void=()=>{};
 fakeFetch.mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));
 await user.click(screen.getByRole('button',{name:'Select all'}));await user.type(screen.getByPlaceholderText('Search employees'),'0999');
 finish(Response.json({query:'',offset:0,rows:rows.slice(0,25),total:1000,ids:rows.map(row=>row.id)}));
 await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(1));
 expect(new FormData(screen.getByTestId('bulk-form') as HTMLFormElement).getAll('employmentIds')).toEqual([]);
});
it('the actual Generate wizard resolves a pasted code on the server before previewing the exact submitted IDs',async()=>{
 const user=userEvent.setup(),payloads:{employmentIds:string[]}[]=[];
 const preview=vi.fn(async(input:{employmentIds:string[]})=>{payloads.push(input);return {year:2026,employeesSelected:input.employmentIds.length,employeesReached:input.employmentIds.length,employeesPassed:input.employmentIds.length,employeesFailed:0,granted:input.employmentIds.length,skipped:0,forfeits:0,lines:[],decidedBy:[],accrual:null} as LeaveGenerationResult;});
 render(<NextIntlClientProvider locale="en" messages={messages}><GenerateForm action={()=>{}} previewAction={preview} years={[2026]} defaultYear={2026} leaveTypes={[{value:'lt',label:'Annual Leave'}]} criteriaSections={[]} employees={[]} remoteEmployees/></NextIntlClientProvider>);
 const t=messages.admin.leave;await user.click(screen.getByRole('button',{name:t.generateStepWho}));await user.click(screen.getByRole('radio',{name:t.adjustmentsByIndividual}));
 const paste=document.querySelector('textarea[name="employmentIdsRaw"]') as HTMLTextAreaElement;
 await user.type(paste,'P 0999');await waitFor(()=>expect(payloads.at(-1)?.employmentIds).toEqual([rows[999].id]));
 const form=paste.form!;expect(new FormData(form).get('employmentIdsRaw')).toBe('P 0999');
 expect(requests.some(input=>input.operation==='resolve'&&input.raw==='P 0999')).toBe(true);
});

it('never re-enables a cached A page after A→B→A or close/reopen failure',async()=>{
 const user=userEvent.setup();render(<Picker/>);await user.click(screen.getByRole('button',{name:'Employees'}));await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(25));
 const search=screen.getByPlaceholderText('Search employees');await user.type(search,'0999');await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(1));
 failNext=true;await user.clear(search);await screen.findByRole('alert');expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
 await user.click(screen.getByRole('button',{name:messages.employeePanel.retry}));await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(25));
 await user.click(screen.getByRole('button',{name:'Employees'}));failNext=true;await user.click(screen.getByRole('button',{name:'Employees'}));await screen.findByRole('alert');expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
});
it('aborts an abandoned complete-selection request immediately on replacement',async()=>{
 const user=userEvent.setup();render(<Picker/>);await user.click(screen.getByRole('button',{name:'Employees'}));await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(25));
 let signal:AbortSignal|undefined;let finish:(value:Response)=>void=()=>{};
 fakeFetch.mockImplementationOnce(async(_url,init)=>{signal=init?.signal as AbortSignal;return new Promise<Response>(resolve=>{finish=resolve;});});
 await user.click(screen.getByRole('button',{name:'Select all'}));expect(signal?.aborted).toBe(false);
 await user.type(screen.getByPlaceholderText('Search employees'),'0999');expect(signal?.aborted).toBe(true);
 finish(Response.json({query:'',offset:0,rows:rows.slice(0,25),total:1000,ids:rows.map(row=>row.id)}));await waitFor(()=>expect(screen.getAllByRole('checkbox')).toHaveLength(1));
 expect(new FormData(screen.getByTestId('bulk-form') as HTMLFormElement).getAll('employmentIds')).toEqual([]);
});

const N=messages.notices;
const noticeLabels: NoticeFormLabels = {
  popupUntilRevisionAcknowledged:'Until the current version is acknowledged or expires',
  attachmentLocale:'en',
  attachments:{title:'Attachments',help:'Up to5files,10MiB each',choose:'Choose file',add:'Add file',pending:'Uploading',remove:'Remove',saveFirst:'Save a draft first',saveHint:'Save to include files',file:'Check file',tooLarge:'Too large',changed:'Reload changed notice',limit:'Five files maximum',unavailable:'Unavailable',failed:'Upload failed'},
  category:'Category',summary:'Summary',pinned:'Pin notice',requiresAcknowledgement:'Require acknowledgement',acknowledgementHelp:'Each changed content version needs its own explicit acknowledgement.',
  authoringCompany:N.authoringCompany,chooseAuthoringCompany:N.chooseAuthoringCompany,groupAuthoring:N.groupAuthoring,authoringCompanyHelp:N.authoringCompanyHelp,noAuthoringScope:N.noAuthoringScope,
  sectionBasics: N.sectionBasics,
  sectionContent: N.sectionContent,
  sectionAudience: N.sectionAudience,
  sectionDelivery: N.sectionDelivery,
  fTitle: N.fTitle,
  fStartOn: N.fStartOn,
  fEndOn: N.fEndOn,
  fShowEndDate: N.fShowEndDate,
  fBody: N.fBody,
  fBodyHelp: N.fBodyHelp,
  write: N.write,
  preview: N.preview,
  previewEmpty: N.previewEmpty,
  byCriteria: N.byCriteria,
  byIndividual: N.byIndividual,
  companies: N.fCompanies,
  departments: N.fDepartments,
  employmentTypes: N.fEmploymentTypes,
  employeePicker: N.fEmployeePicker,
  employeeNoneChosen: N.fEmployeeNoneChosen,
  employeeSearch: N.fEmployeeSearch,
  employeeNoMatchTemplate: N.fEmployeeNoMatch,
  employeeNonePicked: N.fEmployeeNonePicked,
  employeeSelectedCountTemplate: N.fEmployeeSelectedCount,
  employeeSelectAll: N.fEmployeeSelectAll,
  employeeClearAll: N.fEmployeeClearAll,
  employeeRemoveTemplate: N.fEmployeeRemove,
  pasteAlternative: N.fPasteAlternative,
  pasteAlternativeHelp: N.fPasteAlternativeHelp,
  pasteUnmatchedTemplate: N.fPasteUnmatched,
  everyoneWarning: N.everyoneWarning,
  targetingFrozen: N.targetingFrozen,
  fNotify: N.fNotify,
  fNotifyHelp: N.fNotifyHelp,
  fPopup: N.fPopup,
  fPopupFrequency: N.fPopupFrequency,
  popupOnce: N.popupOnce,
  popupUntilAcknowledged: N.popupUntilAcknowledged,
  submit: N.saveDraft,
};

it('the actual Adjustments wizard previews the same picked/raw merge after server resolution',async()=>{
 const user=userEvent.setup(),payloads:{employmentIds:string[]}[]=[];
 const preview=vi.fn(async(input:{employmentIds:string[]})=>{payloads.push(input);return {employees:input.employmentIds.length,targeted:input.employmentIds.length,willWrite:0,issues:[]};});
 render(<NextIntlClientProvider locale="en" messages={messages}><AdjustmentForm action={()=>{}} previewAction={preview} today="2026-08-05" leaveTypes={[{value:'lt',label:'Annual Leave'}]} criteriaSections={[]} employees={[]} remoteEmployees/></NextIntlClientProvider>);
 const t=messages.admin.leave;await user.click(screen.getByRole('button',{name:t.adjustmentsStepWho}));await user.click(screen.getByRole('radio',{name:t.adjustmentsByIndividual}));
 const paste=document.querySelector('textarea[name="employmentIdsRaw"]') as HTMLTextAreaElement;
 await user.type(paste,'P 0999');await waitFor(()=>expect(payloads.at(-1)?.employmentIds).toEqual([rows[999].id]));
 expect(new FormData(paste.form!).get('employmentIdsRaw')).toBe('P 0999');
});
it('a reopened Notice retains1000 known IDs with25 labels and keeps unknown stored tokens in its submitted paste field',async()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><NoticeForm action={()=>{}} authoring={{groupAllowed:true,companies:[{value:'c1',label:'Acme'}],owner:null}}
  values={{title:'Fictional notice',body:'Fictional content',startOn:'2026-08-05',endOn:'2026-12-31',showEndDate:true,targetMode:'individual',criteria:{},employmentIds:[...rows.map(row=>row.id),'BAD'],notifyOnPublish:false,popupEnabled:false,popupFrequency:'once'}}
  companies={[]} departments={[]} employmentTypes={[]} orgCriteria={[]} employees={rows.slice(0,25)} knownEmployeeIds={rows.map(row=>row.id)} remoteEmployees targetingFrozen={false} labels={noticeLabels}/></NextIntlClientProvider>);
 const paste=document.querySelector('textarea[name="employmentIdsRaw"]') as HTMLTextAreaElement;
 await waitFor(()=>expect(requests.some(input=>input.operation==='resolve'&&input.raw==='BAD'&&(input.picked as string[]).length===1000)).toBe(true));
 const fd=new FormData(paste.form!);expect(new Set(fd.getAll('employmentIds'))).toEqual(new Set(rows.map(row=>row.id)));expect(fd.get('employmentIdsRaw')).toBe('BAD');
 expect(screen.queryAllByText(/Fictional employee/).length).toBeLessThanOrEqual(25);
});

function Vocabulary(){const [raw,setRaw]=useState('P0000');const [picked]=useState(new Set<string>());const value=useBulkEmployeeVocabulary(true,[],picked,raw);return <div><input aria-label="References" value={raw} onChange={event=>setRaw(event.target.value)}/><button type="button" disabled={value.pending}>Confirm references</button>{value.failed&&<p role="alert">Resolution failed</p>}</div>;}
it('reference resolution A→B→A cannot reactivate cached confirmation while the fresh read fails',async()=>{
 const user=userEvent.setup();render(<Vocabulary/>);const confirm=screen.getByRole('button',{name:'Confirm references'}) as HTMLButtonElement;await waitFor(()=>expect(confirm.disabled).toBe(false));
 let started=false,finish:(value:Response)=>void=()=>{};
 fakeFetch.mockImplementationOnce(async()=>{started=true;return new Promise<Response>(resolve=>{finish=resolve;});});
 const input=screen.getByRole('textbox',{name:'References'});await user.clear(input);await user.type(input,'P0001');await waitFor(()=>expect(started).toBe(true));
 await user.clear(input);await user.type(input,'P0000');expect(confirm.disabled).toBe(true);failNext=true;
 await screen.findByRole('alert');expect(confirm.disabled).toBe(true);
 finish(Response.json({selection:{ids:[rows[1].id],unmatched:[]},rows:[]}));expect(confirm.disabled).toBe(true);
});
