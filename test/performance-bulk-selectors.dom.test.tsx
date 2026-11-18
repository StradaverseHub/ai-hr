import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {render,screen,waitFor,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {useState,useCallback} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {BulkEmployeePopover} from '../components/bulk-employee-popover';
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
