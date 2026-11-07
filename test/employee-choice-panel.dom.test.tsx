import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {EmployeeScopePanel} from '../components/collapsible-employee-panel';
import type {EmployeeChoice,EmployeeChoicePage} from '../lib/employee-choice';
const push=vi.fn();vi.mock('next/navigation',()=>({useRouter:()=>({push})}));
const row=(n:number):EmployeeChoice=>({employmentId:'e'+n,name:'Employee '+n,employeeCode:'CODE'+n,company:'Company A',companyId:'co-a',department:'Operations',departmentId:'dept-a',businessUnit:'HQ',businessUnitId:'bu-a',status:'active'});
function page(offset=0,query=''):EmployeeChoicePage{return{contextId:'native-snapshot',rows:[row(offset+1)],selected:row(99),total:50,offset,limit:25,
 filters:{query,companyId:'',businessUnitId:'',departmentId:'',status:''},labelMode:'names',companyOptions:[{id:'co-a',name:'Company A'}],businessUnitOptions:[{id:'bu-a',name:'HQ'}],departmentOptions:[{id:'dept-a',name:'Operations'}],allDepartmentOptions:[{id:'dept-a',name:'Operations'}]};}
const mount=(initial=page())=>render(<NextIntlClientProvider locale="en" messages={messages}><EmployeeScopePanel remote={{initial}} selectedId="e99" basePath="/attendance/individual" selectParam="emp" preserve={{from:'2026-07-01',to:'2026-07-31'}}/></NextIntlClientProvider>);
beforeEach(()=>{push.mockClear();window.history.replaceState(null,'','/attendance/individual');});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
it('renders native pages and navigates with the existing selection/filter contract without a whole population',async()=>{
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>page(25)});vi.stubGlobal('fetch',fetcher);mount();
 expect(screen.getByText('Employee 1')).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Next'}));
 await screen.findByText('Employee 26');expect(fetcher).toHaveBeenCalledOnce();
 const [url,request]=fetcher.mock.calls[0];expect(url).toBe('/api/employee-choices');expect(request.method).toBe('POST');
 expect(JSON.parse(request.body)).toMatchObject({offset:25,selectedId:'e99'});
 fireEvent.click(screen.getByRole('button',{name:/Employee 26/}));
 const destination=new URL(push.mock.calls[0][0],'https://fixture.invalid');expect(destination.searchParams.get('emp')).toBe('e26');expect(destination.searchParams.get('from')).toBe('2026-07-01');
 expect(destination.searchParams.has('query')).toBe(false);expect(destination.searchParams.has('pickerQ')).toBe(false);
});
it('retains an explicitly supplied initial page and private search without a duplicate request',()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);mount(page(25,'needle'));
 expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('needle');
 expect(screen.getByText('Employee 26')).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();
 expect(window.location.search).toBe('');
});
it('debounces search in a POST body, aborts superseded work and ignores late results',async()=>{
 const reads:{resolve:(value:unknown)=>void;signal:AbortSignal;body:string}[]=[];
 vi.stubGlobal('fetch',vi.fn((_url:string,request:RequestInit)=>new Promise(resolve=>reads.push({resolve,signal:request.signal!,body:String(request.body)}))));
 mount();const input=screen.getByRole('searchbox');fireEvent.change(input,{target:{value:'PRIVATE ALPHA'}});
 await waitFor(()=>expect(reads).toHaveLength(1));
 expect(window.location.search).toBe('');expect(JSON.parse(reads[0].body).query).toBe('PRIVATE ALPHA');
 fireEvent.change(input,{target:{value:'PRIVATE BETA'}});await waitFor(()=>expect(reads).toHaveLength(2));expect(reads[0].signal.aborted).toBe(true);
 const second=page(0,'PRIVATE BETA');second.rows=[{...row(2),name:'Fresh result'}];
 await act(async()=>reads[1].resolve({ok:true,json:async()=>second}));await screen.findByText('Fresh result');
 const first=page(0,'PRIVATE ALPHA');first.rows=[{...row(1),name:'Stale result'}];
 await act(async()=>reads[0].resolve({ok:true,json:async()=>first}));expect(screen.queryByText('Stale result')).toBeNull();expect(screen.getByText('Fresh result')).toBeTruthy();
});
it('shows a retryable read failure rather than a false empty list',async()=>{
 const fetcher=vi.fn().mockRejectedValueOnce(Error('PRIVATE_DRIVER_ERROR')).mockResolvedValueOnce({ok:true,json:async()=>page(0,'needle')});vi.stubGlobal('fetch',fetcher);mount();
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'needle'}});
 expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('No employees match your filters.')).toBeNull();expect(document.body.textContent).not.toContain('PRIVATE_DRIVER_ERROR');
 fireEvent.click(screen.getByRole('button',{name:'Retry'}));await screen.findByText('Employee 1');expect(fetcher).toHaveBeenCalledTimes(2);
});
