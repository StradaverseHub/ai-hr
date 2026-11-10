/**
 * eaa7697c — the visible "Search employee ID or name…" box beside Filter on the Personnel listing.
 * It is another input for the listing's ONE private term (same route, same token, same controller), so
 * these cases pin what it posts, that clearing it keeps every other filter, and that it never puts the
 * typed word anywhere but a POST body.
 */
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {EMPLOYEE_COLUMN_KEYS,type EmployeeColumnKey} from '../lib/employee-columns';
import type {PersonnelPrivateCriteria} from '../lib/personnel-list-controls';
import {PageHeader} from '../components/ui';
import {PersonnelListSearch} from '../app/admin/personnel/list-search';
import {PersonnelListTable} from '../app/admin/personnel/list-table';
import {PersonnelOrganisationFilters} from '../app/admin/personnel/organisation-filters';
import {PersonnelAutoFilters} from '../app/admin/personnel/auto-filter';

const controls=vi.hoisted(()=>({refresh:vi.fn(),replace:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:controls.refresh,replace:controls.replace,push:vi.fn()})}));
vi.mock('../app/admin/personnel/column-actions',()=>({saveEmployeeColumnsAction:vi.fn()}));
const token='a'.repeat(43);
let fetchMock:ReturnType<typeof vi.fn>;
beforeEach(()=>{controls.replace.mockReset();controls.refresh.mockReset();fetchMock=vi.fn().mockResolvedValue(Response.json({href:'/admin/personnel?search='+token+'&size=50'}));vi.stubGlobal('fetch',fetchMock);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

// Ordinary filters as personnelQueryParams emits them, plus the values that must NEVER be re-posted.
const parameters:[string,string][]=[['sort','joinDate'],['direction','desc'],['companies','fixture-company'],['bucket','active'],['q','legacy-literal'],['search',token],['page','3']];
const criteria:PersonnelPrivateCriteria={term:'',filters:[{field:'name',operator:'contains',value:'Fictional Column Name'},{field:'employment.orgDivision',operator:'equals',value:'Fictional Division'}]};
const box=()=>screen.getByRole('searchbox',{name:en.people.switcher.ariaLabel});
const mount=(privateCriteria:PersonnelPrivateCriteria=criteria)=>render(<NextIntlClientProvider locale="en" messages={en}><PersonnelAutoFilters><PersonnelListSearch pageSize="50" parameters={parameters} privateCriteria={privateCriteria}/></PersonnelAutoFilters></NextIntlClientProvider>);

it('shows the profile switcher wording and narrows the list a moment after typing, with no Search button',async()=>{
 const view=mount();
 expect(box()).toHaveAttribute('placeholder',en.people.switcher.placeholder);
 expect(box()).toHaveAttribute('type','search');expect(box()).not.toBeRequired();
 expect(view.container.querySelector('button')).toBeNull();
 fireEvent.change(box(),{target:{value:'EM'}});
 fireEvent.change(box(),{target:{value:'emp0008'}});
 expect(fetchMock).not.toHaveBeenCalled();
 await waitFor(()=>expect(controls.replace).toHaveBeenCalledWith('/admin/personnel?search='+token+'&size=50',{scroll:false}));
 expect(fetchMock).toHaveBeenCalledTimes(1);
 const [target,request]=fetchMock.mock.calls[0];
 expect(target).toBe('/admin/personnel/search');expect(request.method).toBe('POST');
 const body=request.body as URLSearchParams;
 expect(body.getAll('term')).toEqual(['emp0008']);
 // Ordinary filters, sort and page size travel; the legacy literal q, the old token and the page do not.
 expect(body.get('size')).toBe('50');expect(body.get('sort')).toBe('joinDate');expect(body.get('direction')).toBe('desc');
 expect(body.get('companies')).toBe('fixture-company');expect(body.get('bucket')).toBe('active');
 expect(body.has('q')).toBe(false);expect(body.has('search')).toBe(false);expect(body.has('page')).toBe(false);
 // Column and Employment criteria are re-posted, because the route replaces the complete criteria.
 expect(body.get('field.name')).toBe('Fictional Column Name');expect(body.get('operator.name')).toBe('contains');
 expect(body.get('field.employment.orgDivision')).toBe('Fictional Division');expect(body.get('operator.employment.orgDivision')).toBe('equals');
});

it('clearing the box posts an empty term and keeps every other criterion',async()=>{
 mount({...criteria,term:'john'});
 expect(box()).toHaveValue('john');
 fireEvent.change(box(),{target:{value:''}});
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
 const body=fetchMock.mock.calls[0][1].body as URLSearchParams;
 expect(body.getAll('term')).toEqual(['']);
 expect(body.get('field.name')).toBe('Fictional Column Name');expect(body.get('companies')).toBe('fixture-company');expect(body.get('bucket')).toBe('active');
});

it('pressing Enter applies at once without a full-page form post',async()=>{
 mount();
 fireEvent.change(box(),{target:{value:'Tan'}});
 const event=new Event('submit',{bubbles:true,cancelable:true});box().form!.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(true);
 await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
 expect((fetchMock.mock.calls[0][1].body as URLSearchParams).get('term')).toBe('Tan');
});

it('shows the shared busy/retry feedback for its own form when the search cannot be read',async()=>{
 fetchMock.mockResolvedValueOnce(new Response('busy',{status:503}));
 mount();
 fireEvent.change(box(),{target:{value:'Fictional'}});
 const alert=await screen.findByRole('alert');
 expect(alert).toHaveTextContent(en.personnelOrganisationFilters.readBusy);
 expect(controls.replace).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:en.personnelOrganisationFilters.retryRead}));
 await waitFor(()=>expect(controls.replace).toHaveBeenCalledTimes(1));
 expect((fetchMock.mock.calls[1][1].body as URLSearchParams).get('term')).toBe('Fictional');
});

it('keeps focus and the typed word when the applied criteria arrive, and follows a term changed elsewhere',()=>{
 const view=mount();
 const input=box();input.focus();
 fireEvent.change(input,{target:{value:'still typing'}});
 const wrap=(c:PersonnelPrivateCriteria)=><NextIntlClientProvider locale="en" messages={en}><PersonnelAutoFilters><PersonnelListSearch pageSize="50" parameters={parameters} privateCriteria={c}/></PersonnelAutoFilters></NextIntlClientProvider>;
 view.rerender(wrap({...criteria,term:'still typ'}));
 expect(box()).toBe(input);expect(document.activeElement).toBe(input);expect(input).toHaveValue('still typing');
 input.blur();
 // The Filter dialog or a removed chip changed the same term: the visible box follows it.
 view.rerender(wrap({...criteria,term:'changed in Filter'}));
 expect(box()).toHaveValue('changed in Filter');
 view.rerender(wrap({...criteria,term:''}));
 expect(box()).toHaveValue('');
});

it('keeps the term only in the visible field, never as a hidden duplicate or in a link',()=>{
 const view=mount({...criteria,term:'PRIVATE-FICTIONAL-TERM'});
 const form=view.container.querySelector<HTMLFormElement>('#personnel-list-search')!;
 expect(form).toHaveAttribute('method','post');expect(form).toHaveAttribute('action','/admin/personnel/search');
 expect(form.querySelectorAll('input[name="term"]')).toHaveLength(1);
 expect([...view.container.querySelectorAll('a')].map(a=>a.getAttribute('href')).join(' ')).not.toContain('PRIVATE-FICTIONAL-TERM');
});

// Browser evidence is a CI-only operation (two Chrome viewports; the helper fails on page-level overflow).
it('captures the listing header with the box beside Filter at desktop and phone widths',async()=>{
 const labels={...Object.fromEntries(EMPLOYEE_COLUMN_KEYS.map(key=>[key,key])),code:en.people.list.colCode,name:en.people.list.colName} as Record<EmployeeColumnKey,string>;
 const filterLabels={filter:'Filter',apply:'Apply',clearAll:'Clear all',activeCount:'1'};
 const view=render(<NextIntlClientProvider locale="en" messages={en}><PersonnelAutoFilters><div className="mx-auto max-w-[100rem] space-y-6">
  <PageHeader title={en.people.list.adminTitle} actions={<div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
   <PersonnelListSearch pageSize="50" parameters={parameters} privateCriteria={{term:'john',filters:[]}}/>
   <PersonnelOrganisationFilters fields={[]} values={{}} companies={[]} labels={filterLabels} companySearchLabel="Companies" dataTour="people-search"/>
   <button type="button" className="min-h-11 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">Create new employee</button>
   <button type="button" className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm font-medium">Import employees</button>
   <button type="button" className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm font-medium">Export</button>
  </div>}/>
  <div className="rounded-xl border border-border bg-card"><PersonnelListTable columns={['code','name']} allOrder={[...EMPLOYEE_COLUMN_KEYS]} labels={labels} employees={[{employmentId:'fixture-1',name:'John Tan',status:'active',statusLabel:'Active',employeeCode:'EMP-0007',text:{}},{employmentId:'fixture-2',name:'Johnny Lim',status:'active',statusLabel:'Active',employeeCode:'EMP-0031',text:{}}]} drafts={[]} parameters={parameters} pageSize="50" privateCriteria={{term:'john',filters:[]}} empty="None"/></div>
 </div></PersonnelAutoFilters></NextIntlClientProvider>);
 expect(box()).toHaveValue('john');
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','feedback-personnel-list-search','Approved eaa7697c listing search box beside Filter; real Personnel components with fictional records; no installed acceptance','atelier');
},120000);
