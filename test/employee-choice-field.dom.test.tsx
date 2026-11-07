import {afterEach, describe, expect, it, vi} from 'vitest';
import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {EmployeeChoiceField} from '../components/employee-choice-field';
import type {EmployeeChoicePage} from '../lib/employee-choice';

const selected={employmentId:'deep-selected',name:'Selected outside the first page'};
function page(query='',offset=0):EmployeeChoicePage {
  return {contextId:'request-snapshot',rows:Array.from({length:25},(_,i)=>({employmentId:'employee-'+(offset+i),name:'Employee '+(offset+i),employeeCode:null,
    company:'Fictional company',companyId:'company',department:null,departmentId:null,businessUnit:null,businessUnitId:null,status:'active'})),
    selected:{...selected,employeeCode:null,company:'Fictional company',companyId:'company',department:null,departmentId:null,businessUnit:null,businessUnitId:null,status:'ended'},
    total:50000,offset,limit:25,filters:{query,companyId:'',departmentId:'',businessUnitId:'',status:''},labelMode:'names',
    companyOptions:[],departmentOptions:[],businessUnitOptions:[],allDepartmentOptions:[]};
}
function mount(){
  return render(<NextIntlClientProvider locale="en" messages={messages}><form>
    <input name="departmentId" defaultValue="reviewed-department" />
    <input name="from" defaultValue="2026-01-01" />
    <EmployeeChoiceField name="managerEmploymentId" label="Manager" allLabel="All managers" selectedId={selected.employmentId} selected={selected} />
  </form></NextIntlClientProvider>);
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('demand-loaded employee form field',()=>{
  it('keeps the independently selected employee in the submitted form without an initial workforce request',()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    const {container}=mount();
    const data=new FormData(container.querySelector('form')!);
    expect(data.get('managerEmploymentId')).toBe(selected.employmentId);
    expect(data.get('departmentId')).toBe('reviewed-department');
    expect(data.get('from')).toBe('2026-01-01');
    expect(screen.getByText('Manager: '+selected.name)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('loads only when opened, keeps 25 results plus the deep selection, and submits only when the choice changes',async()=>{
    const fetch=vi.fn(async(_url:string,init:RequestInit)=>{const input=JSON.parse(String(init.body));return Response.json(page(input.query,input.offset));});
    vi.stubGlobal('fetch',fetch);
    const submit=vi.spyOn(HTMLFormElement.prototype,'requestSubmit').mockImplementation(()=>{});
    const user=userEvent.setup();mount();
    await user.click(screen.getByText('Manager: '+selected.name));
    await screen.findByRole('option',{name:'Employee 0'});
    expect(screen.getAllByRole('option')).toHaveLength(27);
    const init=fetch.mock.calls[0][1];
    expect(init.method).toBe('POST');expect(init.cache).toBe('no-store');
    expect(JSON.parse(String(init.body))).toMatchObject({limit:25,offset:0,selectedId:selected.employmentId});
    await user.type(screen.getByRole('searchbox'),'deep');
    await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
    expect(submit).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toMatchObject({query:'deep',offset:0});
    await screen.findByRole('option',{name:'Employee 0'});
    await user.click(screen.getByRole('button',{name:'Next'}));
    await screen.findByRole('option',{name:'Employee 25'});
    expect(screen.getByText('26–50 of 50,000')).toBeInTheDocument();
    expect(screen.getByRole('option',{name:selected.name})).toHaveValue(selected.employmentId);
    await user.selectOptions(screen.getByRole('combobox',{name:'Manager'}),'employee-25');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(new FormData(screen.getByRole('combobox').closest('form')!).get('managerEmploymentId')).toBe('employee-25');
  });
  it('shows a failed lookup as a failure, retries explicitly and never replaces it with an empty population',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(Response.json(page()));
    vi.stubGlobal('fetch',fetch);const user=userEvent.setup();mount();
    await user.click(screen.getByText('Manager: '+selected.name));
    expect(await screen.findByRole('alert')).toHaveTextContent('Employees could not be loaded');
    expect(screen.queryByText('No employees match your filters.')).not.toBeInTheDocument();
    expect(screen.queryByRole('option',{name:'Employee 0'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Retry'}));
    await screen.findByRole('option',{name:'Employee 0'});
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('aborts a closed lookup and refuses a mismatched or oversized reply',async()=>{
    let requestSignal:AbortSignal|undefined;
    const fetch=vi.fn(async(_url:string,init:RequestInit)=>{
      requestSignal=init.signal as AbortSignal;
      return new Promise<Response>(()=>{});
    });
    vi.stubGlobal('fetch',fetch);const user=userEvent.setup();mount();
    const summary=screen.getByText('Manager: '+selected.name);
    await user.click(summary);await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
    await user.click(summary);await waitFor(()=>expect(requestSignal?.aborted).toBe(true));
    const invalid=page();invalid.filters.query='a different request';
    fetch.mockImplementation(async()=>Response.json(invalid));
    await user.click(summary);
    expect(await screen.findByRole('alert')).toHaveTextContent('Employees could not be loaded');
    const oversized=page();oversized.rows=[...oversized.rows,...oversized.rows];
    fetch.mockImplementation(async()=>Response.json(oversized));
    await user.click(screen.getByRole('button',{name:'Retry'}));
    await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(3));
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });
});
