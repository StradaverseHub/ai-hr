import {useState} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import {SystemLabelHeadChoice} from '../components/system-label-head-choice';
import {isLabelHeadChoicePage,type LabelHeadChoice,type LabelHeadChoicePage} from '../lib/system-label-head-choice';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
const companyId='00000000-0000-0000-0000-000000000001',otherCompany='00000000-0000-0000-0000-000000000002';
const id=(n:number)=>'00000001-0000-0000-0000-'+String(n).padStart(12,'0');
const row=(n:number,company=companyId):LabelHeadChoice=>({employmentId:id(n),companyId:company,employeeCode:'HEAD'+String(n).padStart(5,'0'),name:'Fictional head '+n});
const selected=row(5001);
function page(query='',offset=0,selectedId:string|null=selected.employmentId,company=companyId):LabelHeadChoicePage{
 return {companyId:company,query:query.trim(),offset,limit:25,total:5001,rows:Array.from({length:25},(_,i)=>row(offset+i+1,company)),selected:selectedId?{...row(Number(selectedId.slice(-12)),company),employmentId:selectedId}:null};
}
function mount(onChange=vi.fn(),value:string|null=selected.employmentId,company=companyId){
 function Editor(){const [current,setCurrent]=useState(value);return <form><input name="labelName" defaultValue="Unsubmitted label draft"/><SystemLabelHeadChoice companyId={company} value={current} label="Head" noneLabel="None" unavailableLabel="Head unavailable" selectedLabel="Retained ended head (HEAD05001)" onChange={next=>{onChange(next);setCurrent(next);}}/></form>;}
 return render(<NextIntlClientProvider locale="en" messages={en}><Editor/></NextIntlClientProvider>);
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('renders None and its exact retained head without eagerly reading the workforce or altering the draft',()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const change=vi.fn(),{container}=mount(change);
 expect(screen.getByRole('combobox',{name:'Head'})).toHaveValue(selected.employmentId);expect(screen.getAllByRole('option')).toHaveLength(2);
 expect(screen.getByRole('option',{name:'Retained ended head (HEAD05001)'})).toBeInTheDocument();expect(fetch).not.toHaveBeenCalled();expect(change).not.toHaveBeenCalled();
 const form=new FormData(container.querySelector('form')!);expect(form.get('headEmploymentId')).toBe(selected.employmentId);expect(form.get('labelName')).toBe('Unsubmitted label draft');expect(form.has('query')).toBe(false);
});
it('browses25pluspin, searches by POST, retains the controlled selection and sends None as null',async()=>{
 const fetch=vi.fn(async(_url:unknown,init:RequestInit)=>{const p=JSON.parse(String(init.body));return {ok:true,json:async()=>page(p.query,p.offset,p.selectedId??null,p.companyId)};});vi.stubGlobal('fetch',fetch);
 const change=vi.fn(),{container}=mount(change),user=userEvent.setup();await user.click(screen.getByText('Search employee',{selector:'summary'}));
 await screen.findByRole('option',{name:'Fictional head 1 (HEAD00001)'});expect(screen.getAllByRole('option')).toHaveLength(27);
 expect(fetch.mock.calls[0][0]).toBe('/admin/settings/system-labels/head-choices');expect(fetch.mock.calls[0][1]).toMatchObject({method:'POST',cache:'no-store',credentials:'same-origin'});
 await user.click(screen.getByRole('button',{name:'Next'}));await screen.findByRole('option',{name:'Fictional head 26 (HEAD00026)'});expect(screen.getAllByRole('option')).toHaveLength(27);
 await user.selectOptions(screen.getByRole('combobox',{name:'Head'}),id(26));await waitFor(()=>expect(change).toHaveBeenLastCalledWith(id(26)));
 expect(new FormData(container.querySelector('form')!).get('headEmploymentId')).toBe(id(26));
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'PRIVATE employee query'}});
 await waitFor(()=>expect(fetch.mock.calls.some(([,init])=>JSON.parse(String(init.body)).query==='PRIVATE employee query')).toBe(true));
 expect(fetch.mock.calls.every(([url])=>!String(url).includes('PRIVATE')&&!String(url).includes(id(26)))).toBe(true);
 expect(container.querySelector('input[type="search"]')).not.toHaveAttribute('name');
 await user.selectOptions(screen.getByRole('combobox',{name:'Head'}),'');expect(change).toHaveBeenLastCalledWith(null);
});
it('rejects wrong-scope data, preserves the retained ID as unavailable and recovers on explicit retry',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({...page(),companyId:otherCompany})}).mockResolvedValueOnce({ok:true,json:async()=>({...page(),selected:null})});vi.stubGlobal('fetch',fetch);
 const change=vi.fn();mount(change);await userEvent.setup().click(screen.getByText('Search employee',{selector:'summary'}));
 await screen.findByRole('alert');expect(screen.getByRole('combobox',{name:'Head'})).toHaveValue(selected.employmentId);expect(change).not.toHaveBeenCalled();
 await userEvent.setup().click(screen.getByRole('button',{name:'Retry'}));await screen.findByRole('option',{name:'Head unavailable'});expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByRole('combobox',{name:'Head'})).toHaveValue(selected.employmentId);
});
it('aborts stale searches and does not replace current results when their old response arrives later',async()=>{
 let resolveOld!:(value:unknown)=>void;const old=new Promise<unknown>(r=>{resolveOld=r;});
 const fetch=vi.fn(async(_url:unknown,init:RequestInit)=>{const p=JSON.parse(String(init.body));return {ok:true,json:async()=>p.query==='old'?old:{...page(p.query,p.offset,p.selectedId),rows:[row(p.query==='new'?81:1)]}};});vi.stubGlobal('fetch',fetch);
 mount();await userEvent.setup().click(screen.getByText('Search employee',{selector:'summary'}));await screen.findByRole('option',{name:'Fictional head 1 (HEAD00001)'});
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'old'}});await waitFor(()=>expect(fetch.mock.calls.some(([,init])=>JSON.parse(String(init.body)).query==='old')).toBe(true));
 const oldCall=fetch.mock.calls.find(([,init])=>JSON.parse(String(init.body)).query==='old')!;
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'new'}});await screen.findByRole('option',{name:'Fictional head 81 (HEAD00081)'});expect(oldCall[1].signal?.aborted).toBe(true);
 await act(async()=>{resolveOld({...page('old'),rows:[row(99)]});await old;});expect(screen.queryByRole('option',{name:'Fictional head 99 (HEAD00099)'})).toBeNull();
 expect(screen.getAllByRole('option')).toHaveLength(3);
});
it('rejects duplicate or foreign-company response rows instead of accepting an ambiguous page',()=>{
 expect(isLabelHeadChoicePage({...page(),rows:[row(1),row(1)]})).toBe(false);
 expect(isLabelHeadChoicePage({...page(),rows:[row(1,otherCompany)]})).toBe(false);
 expect(isLabelHeadChoicePage(page())).toBe(true);
});
it.each([['en',en],['ms',ms],['ta',ta],['th',th],['vi',viMessages],['zh',zh]] as const)('retains useful current/None markup before hydration in%s', (locale,messages)=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 const html=renderToStaticMarkup(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}><SystemLabelHeadChoice companyId={companyId} value={selected.employmentId} label={messages.admin.organization.fieldHead} noneLabel={messages.admin.organization.headNone} unavailableLabel={messages.admin.systemLabels.headUnavailable} selectedLabel="Retained ended head" onChange={()=>{}}/></NextIntlClientProvider>);
 expect(html).toContain('Retained ended head');expect(html).toContain('name="headEmploymentId"');expect(html.match(/<option/g)).toHaveLength(2);expect(html).not.toContain('MISSING_MESSAGE');expect(fetch).not.toHaveBeenCalled();
});
