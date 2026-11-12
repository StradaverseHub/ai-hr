/**
 * eaa7697c — the visible "Search employee ID or name…" box beside Filter on the Personnel listing.
 * It is another input for the listing's ONE private term (same route, same token, same controller), so
 * these cases pin what it posts, that clearing it keeps every other filter, and that it never puts the
 * typed word anywhere but a POST body. aa045103 adds the suggestion dropdown (the switcher's bounded reader):
 * keyboard, abort on retype, empty and refused lookups, and picking a person.
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
// Fictional people as the switcher reader returns them (GET /api/personnel/search).
const suggestions=[
 {employmentId:'fixture-1',name:'John Tan Wei Ming',employeeCode:'EMP-0001',company:'Fictional Alpha Sdn Bhd',department:'Finance'},
 {employmentId:'fixture-2',name:'Johnny Lim',employeeCode:'EMP-0214',company:'Fictional Alpha Sdn Bhd',department:'HR'},
 {employmentId:'fixture-3',name:'Siti Johari',employeeCode:'EMP-0388',company:'Fictional Beta Pte Ltd',department:null},
];
let fetchMock:ReturnType<typeof vi.fn>;
let lookup:(url:string,init?:RequestInit)=>Promise<Response>;
const posts=()=>fetchMock.mock.calls.filter(([url])=>url==='/admin/personnel/search');
const lookups=()=>fetchMock.mock.calls.filter(([url])=>String(url).startsWith('/api/personnel/search'));
beforeEach(()=>{
 controls.replace.mockReset();controls.refresh.mockReset();
 lookup=async()=>Response.json({rows:suggestions});
 fetchMock=vi.fn((url:string,init?:RequestInit)=>String(url).startsWith('/api/personnel/search')?lookup(url,init):Promise.resolve(Response.json({href:'/admin/personnel?search='+token+'&size=50'})));
 vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

// Ordinary filters as personnelQueryParams emits them, plus the values that must NEVER be re-posted.
const parameters:[string,string][]=[['sort','joinDate'],['direction','desc'],['companies','fixture-company'],['bucket','active'],['q','legacy-literal'],['search',token],['page','3']];
const criteria:PersonnelPrivateCriteria={term:'',filters:[{field:'name',operator:'contains',value:'Fictional Column Name'},{field:'employment.orgDivision',operator:'equals',value:'Fictional Division'}]};
const box=()=>screen.getByRole('combobox',{name:en.people.switcher.ariaLabel});
const mount=(privateCriteria:PersonnelPrivateCriteria=criteria)=>render(<NextIntlClientProvider locale="en" messages={en}><PersonnelAutoFilters><PersonnelListSearch pageSize="50" parameters={parameters} privateCriteria={privateCriteria}/></PersonnelAutoFilters></NextIntlClientProvider>);
const expectCompleteCriteria=(body:URLSearchParams)=>{
 // Ordinary filters, sort and page size travel; the legacy literal q, the old token and the page do not.
 expect(body.get('size')).toBe('50');expect(body.get('sort')).toBe('joinDate');expect(body.get('direction')).toBe('desc');
 expect(body.get('companies')).toBe('fixture-company');expect(body.get('bucket')).toBe('active');
 expect(body.has('q')).toBe(false);expect(body.has('search')).toBe(false);expect(body.has('page')).toBe(false);
 // Column and Employment criteria are re-posted, because the route replaces the complete criteria.
 expect(body.get('field.name')).toBe('Fictional Column Name');expect(body.get('operator.name')).toBe('contains');
 expect(body.get('field.employment.orgDivision')).toBe('Fictional Division');expect(body.get('operator.employment.orgDivision')).toBe('equals');
};

it('offers matching people in a dropdown while typing, through the switcher reader, without narrowing the list per keystroke',async()=>{
 const view=mount();
 expect(box()).toHaveAttribute('placeholder',en.people.switcher.placeholder);
 expect(box()).toHaveAttribute('type','search');expect(box()).not.toBeRequired();
 expect(view.container.querySelector('button')).toBeNull();
 fireEvent.change(box(),{target:{value:'Jo'}});
 fireEvent.change(box(),{target:{value:'john'}});
 const list=await screen.findByRole('listbox',{name:en.people.switcher.resultsLabel});
 await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(4));
 expect(box()).toHaveAttribute('aria-expanded','true');expect(box()).toHaveAttribute('aria-controls',list.id);
 // Debounced: one bounded read for the last word only; nothing was posted and the list was not replaced.
 expect(lookups().map(([url])=>url)).toEqual(['/api/personnel/search?q=john']);
 expect(posts()).toHaveLength(0);expect(controls.replace).not.toHaveBeenCalled();
 const options=screen.getAllByRole('option');
 expect(options[0]).toHaveTextContent('John Tan Wei Ming');expect(options[0]).toHaveTextContent('EMP-0001 · Finance');
 expect(options[2]).toHaveTextContent('EMP-0388');expect(options[2]).not.toHaveTextContent('null');
 expect(options[3]).toHaveTextContent('Show all 3 matches in the list (Enter)');
});

it('picking a person narrows the list to that Employee ID through the private POST, with the complete criteria',async()=>{
 mount();
 fireEvent.change(box(),{target:{value:'john'}});
 await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(4));
 fireEvent.click(screen.getAllByRole('option')[1]);
 await waitFor(()=>expect(controls.replace).toHaveBeenCalledWith('/admin/personnel?search='+token+'&size=50',{scroll:false}));
 expect(posts()).toHaveLength(1);
 const [,request]=posts()[0];
 expect(request.method).toBe('POST');
 const body=request.body as URLSearchParams;
 expect(body.getAll('term')).toEqual(['EMP-0214']);
 expectCompleteCriteria(body);
 expect(box()).toHaveValue('EMP-0214');expect(screen.queryByRole('listbox')).toBeNull();
});

it('works from the keyboard: arrows move the active option, Enter picks it, Escape closes',async()=>{
 mount();
 const input=box();input.focus();
 fireEvent.change(input,{target:{value:'john'}});
 await screen.findAllByRole('option');await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(4));
 expect(input).not.toHaveAttribute('aria-activedescendant');
 fireEvent.keyDown(input,{key:'ArrowDown'});
 const first=screen.getAllByRole('option')[0];
 expect(input).toHaveAttribute('aria-activedescendant',first.id);expect(first).toHaveAttribute('aria-selected','true');
 fireEvent.keyDown(input,{key:'ArrowUp'});
 expect(input).toHaveAttribute('aria-activedescendant',screen.getAllByRole('option')[3].id); // wraps to "Show all"
 fireEvent.keyDown(input,{key:'Escape'});
 expect(screen.queryByRole('listbox')).toBeNull();expect(posts()).toHaveLength(0);
 fireEvent.keyDown(input,{key:'ArrowDown'});fireEvent.keyDown(input,{key:'ArrowDown'});
 fireEvent.keyDown(input,{key:'Enter'});
 await waitFor(()=>expect(posts()).toHaveLength(1));
 expect((posts()[0][1].body as URLSearchParams).get('term')).toBe('EMP-0214');
});

it('aborts the older lookup when the word changes and shows the refusal and empty states',async()=>{
 const signals:AbortSignal[]=[];
 lookup=(url,init)=>{signals.push(init!.signal!);return new Promise<Response>((resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));if(url.endsWith('q=zzz'))resolve(Response.json({rows:[]}));});};
 mount();
 fireEvent.change(box(),{target:{value:'john'}});
 await waitFor(()=>expect(signals).toHaveLength(1));
 fireEvent.change(box(),{target:{value:'zzz'}});
 expect(signals[0].aborted).toBe(true);
 expect(await screen.findByText(en.people.switcher.noMatches)).toBeInTheDocument();
 expect(screen.getByRole('option')).toHaveTextContent(en.people.switcher.showAllMore);
 lookup=async()=>Response.json({error:'forbidden'},{status:403});
 fireEvent.change(box(),{target:{value:'refused'}});
 expect(await screen.findByText(en.people.switcher.loadFailed)).toBeInTheDocument();
 // A refused lookup never invents rows and never posts a search.
 expect(screen.getAllByRole('option')).toHaveLength(1);expect(posts()).toHaveLength(0);
});

it('clearing the box posts an empty term and keeps every other criterion',async()=>{
 mount({...criteria,term:'john'});
 expect(box()).toHaveValue('john');
 fireEvent.change(box(),{target:{value:''}});
 await waitFor(()=>expect(posts()).toHaveLength(1));
 const body=posts()[0][1].body as URLSearchParams;
 expect(body.getAll('term')).toEqual(['']);
 expect(body.get('field.name')).toBe('Fictional Column Name');expect(body.get('companies')).toBe('fixture-company');expect(body.get('bucket')).toBe('active');
});

it('pressing Enter applies the typed words at once without a full-page form post',async()=>{
 mount();
 fireEvent.change(box(),{target:{value:'Tan'}});
 const event=new Event('submit',{bubbles:true,cancelable:true});(box() as HTMLInputElement).form!.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(true);
 await waitFor(()=>expect(posts()).toHaveLength(1));
 const body=posts()[0][1].body as URLSearchParams;
 expect(body.get('term')).toBe('Tan');expectCompleteCriteria(body);
});

it('shows the shared busy/retry feedback for its own form when the search cannot be read',async()=>{
 fetchMock.mockImplementation((url:string,init?:RequestInit)=>String(url).startsWith('/api/personnel/search')?lookup(url,init):Promise.resolve(new Response('busy',{status:503})));
 mount();
 fireEvent.change(box(),{target:{value:'Fictional'}});
 fireEvent.submit((box() as HTMLInputElement).form!);
 const alert=await screen.findByRole('alert');
 // The release's shared Personnel filter feedback says the filters could not be applied, never "busy".
 expect(alert).toHaveTextContent(en.personnelOrganisationFilters.applyFailed);
 expect(controls.replace).not.toHaveBeenCalled();
 fetchMock.mockImplementation((url:string,init?:RequestInit)=>String(url).startsWith('/api/personnel/search')?lookup(url,init):Promise.resolve(Response.json({href:'/admin/personnel?search='+token})));
 fireEvent.click(screen.getByRole('button',{name:en.personnelOrganisationFilters.retryRead}));
 await waitFor(()=>expect(controls.replace).toHaveBeenCalledTimes(1));
 expect((posts()[1][1].body as URLSearchParams).get('term')).toBe('Fictional');
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
 // aa045103: capture with the suggestion dropdown open over the list, as the reporter will see it.
 box().focus();fireEvent.change(box(),{target:{value:'John'}});
 await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(4));
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','feedback-personnel-list-search','Approved eaa7697c listing search box beside Filter; real Personnel components with fictional records; no installed acceptance','atelier');
},120000);
