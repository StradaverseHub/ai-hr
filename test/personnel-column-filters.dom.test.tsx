/**
 * aa045103 — the Personnel list's header filters. Choice columns are multi-select popovers (find a value,
 * Select all, Clear selection, Apply and Clear) and date columns take From/To. Both write the ORDINARY params
 * the Filter dialog owns, keep every other param, drop `page`, and replace the URL without a page load.
 * Text columns keep the private type-to-filter box. The empty list offers Clear filters.
 */
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {EMPLOYEE_COLUMN_KEYS,type EmployeeColumnKey} from '../lib/employee-columns';
import {PersonnelListTable,type PersonnelChoiceFilterProps,type PersonnelDateFilterProps} from '../app/admin/personnel/list-table';
import {PersonnelAutoFilters} from '../app/admin/personnel/auto-filter';
import {personnelFilterHref} from '../lib/personnel-list-controls';

const controls=vi.hoisted(()=>({replace:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:controls.refresh,replace:controls.replace,push:vi.fn()})}));
vi.mock('../app/admin/personnel/column-actions',()=>({saveEmployeeColumnsAction:vi.fn()}));
beforeEach(()=>{controls.replace.mockReset();vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

const c=en.people.list.controls;
const token='b'.repeat(43);
const [finance,hr,it_,ops]=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
const parameters:[string,string][]=[['sort','name'],['direction','desc'],['companies','fixture-company-a,fixture-company-b'],['search',token],['page','4']];
const labels={...Object.fromEntries(EMPLOYEE_COLUMN_KEYS.map(key=>[key,key])),code:'Employee ID',name:'Name',department:'Department',status:'Status',joinDate:'Join date',company:'Company'} as Record<EmployeeColumnKey,string>;
const department=(selected:string[]=[]):PersonnelChoiceFilterProps=>({param:'dept',selected,blankLabel:c.blank,
 options:[{value:finance,label:'Finance'},{value:hr,label:'Human Resources'},{value:it_,label:'Information Technology'},{value:ops,label:'Operations'}]});
const status:PersonnelChoiceFilterProps={param:'bucket',selected:[],options:[{value:'active',label:'Active'},{value:'probation',label:'Probation'},{value:'draft',label:'Draft'}]};
const joinDate=(applied:{from?:string;to?:string}={}):PersonnelDateFilterProps=>({params:['joinedFrom','joinedTo'],applied});
const employees=[{employmentId:'fixture-1',name:'Fictional Tan',status:'active' as const,statusLabel:'Active',employeeCode:'EMP-0001',text:{code:'EMP-0001',name:'Fictional Tan',department:'Finance',status:'Active',joinDate:'2022-01-03'}}];
const table=(props:{dept?:string[];join?:{from?:string;to?:string};rows?:typeof employees;emptyClearHref?:string}={})=>
 <NextIntlClientProvider locale="en" messages={en}><PersonnelAutoFilters><PersonnelListTable pageSize="50" columns={['code','name','department','status','joinDate']} allOrder={[...EMPLOYEE_COLUMN_KEYS]}
  labels={labels} employees={props.rows??employees} drafts={[]} parameters={parameters} empty={en.people.list.emptyFiltered} emptyClearHref={props.emptyClearHref}
  choiceFilters={{department:department(props.dept),status}} dateFilters={{joinDate:joinDate(props.join)}}
  privateCriteria={{term:'',filters:[{field:'name',operator:'contains',value:'Fictional'},{field:'department',operator:'equals',value:finance}]}}/></PersonnelAutoFilters></NextIntlClientProvider>;
const trigger=(name:string)=>screen.getByRole('button',{name:c.filterColumn.replace('{name}',name)});
const panel=(name:string)=>screen.getByRole('dialog',{name:c.filterColumn.replace('{name}',name)});
const lastHref=()=>new URL(controls.replace.mock.calls.at(-1)![0] as string,'https://fixture.invalid');

it('ticks several values, finds a value, and applies them as one ordinary param on page one without a reload',()=>{
 render(table());
 expect(trigger('Department')).toHaveTextContent(c.choiceAll);expect(trigger('Department')).toHaveAttribute('aria-expanded','false');
 fireEvent.click(trigger('Department'));
 const dialog=panel('Department');
 expect(trigger('Department')).toHaveAttribute('aria-expanded','true');
 // Blank / unassigned stays available as the last option.
 expect(within(dialog).getAllByRole('checkbox').map(box=>box.closest('label')!.textContent)).toEqual(['Finance','Human Resources','Information Technology','Operations',c.blank]);
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'Finance'}));
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'Human Resources'}));
 fireEvent.change(within(dialog).getByRole('searchbox',{name:c.findOption.replace('{name}','Department')}),{target:{value:'tech'}});
 expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'Information Technology'}));
 expect(controls.replace).not.toHaveBeenCalled(); // staged until Apply
 fireEvent.click(within(dialog).getByRole('button',{name:c.applyChoice}));
 expect(controls.replace).toHaveBeenCalledTimes(1);expect(controls.replace.mock.calls[0][1]).toEqual({scroll:false});
 const href=lastHref();
 expect(href.pathname).toBe('/admin/personnel');
 expect(href.searchParams.get('dept')).toBe([finance,hr,it_].join(','));
 // Every other ordinary param, the private result and the size stay; the page resets.
 expect(href.searchParams.get('companies')).toBe('fixture-company-a,fixture-company-b');expect(href.searchParams.get('search')).toBe(token);
 expect(href.searchParams.get('sort')).toBe('name');expect(href.searchParams.get('direction')).toBe('desc');expect(href.searchParams.get('size')).toBe('50');
 expect(href.searchParams.has('page')).toBe(false);
 expect(screen.queryByRole('dialog')).toBeNull();
});

it('Select all ticks the values found, Clear selection unticks, Clear removes the filter, and closing discards a staged change',()=>{
 render(table({dept:[finance]}));
 expect(trigger('Department')).toHaveTextContent('Finance');
 fireEvent.click(trigger('Department'));
 let dialog=panel('Department');
 expect(within(dialog).getByRole('checkbox',{name:'Finance'})).toBeChecked();
 fireEvent.click(within(dialog).getByRole('button',{name:c.selectAllOptions}));
 expect(within(dialog).getAllByRole('checkbox').every(box=>(box as HTMLInputElement).checked)).toBe(true);
 fireEvent.click(within(dialog).getByRole('button',{name:c.clearSelection}));
 expect(within(dialog).getAllByRole('checkbox').some(box=>(box as HTMLInputElement).checked)).toBe(false);
 // Escape closes without applying; reopening shows the applied value again.
 fireEvent.keyDown(window,{key:'Escape'});
 expect(screen.queryByRole('dialog')).toBeNull();expect(controls.replace).not.toHaveBeenCalled();
 fireEvent.click(trigger('Department'));dialog=panel('Department');
 expect(within(dialog).getByRole('checkbox',{name:'Finance'})).toBeChecked();
 fireEvent.click(within(dialog).getByRole('checkbox',{name:c.blank}));
 fireEvent.click(within(dialog).getByRole('button',{name:c.applyChoice}));
 expect(lastHref().searchParams.get('dept')).toBe(finance+',__blank');
 fireEvent.click(trigger('Department'));
 fireEvent.click(within(panel('Department')).getByRole('button',{name:c.clearChoice}));
 expect(lastHref().searchParams.has('dept')).toBe(false);expect(lastHref().searchParams.get('companies')).toBe('fixture-company-a,fixture-company-b');
});

it('follows a value removed elsewhere (a chip or the Filter dialog) because both read the same URL',()=>{
 const view=render(table({dept:[finance,hr,it_,ops]}));
 expect(trigger('Department')).toHaveTextContent(c.choiceSelected.replace('{count}','4'));
 view.rerender(table({dept:[finance,hr]}));
 expect(trigger('Department')).toHaveTextContent('Finance, Human Resources');
 fireEvent.click(trigger('Department'));
 expect(within(panel('Department')).getByRole('checkbox',{name:'Information Technology'})).not.toBeChecked();
 view.rerender(table({dept:[]}));
 expect(trigger('Department')).toHaveTextContent(c.choiceAll);
});

it('date columns apply an inclusive From/To range and refuse a reversed one',()=>{
 render(table({join:{from:'2022-01-01'}}));
 expect(trigger('Join date')).toHaveTextContent('2022-01-01 – …');
 fireEvent.click(trigger('Join date'));
 const dialog=panel('Join date');
 const from=within(dialog).getByLabelText(c.dateFromLabel.replace('{name}','Join date')),to=within(dialog).getByLabelText(c.dateToLabel.replace('{name}','Join date'));
 expect(from).toHaveValue('2022-01-01');
 fireEvent.change(to,{target:{value:'2021-12-31'}});
 expect(within(dialog).getByRole('button',{name:c.applyChoice})).toBeDisabled();
 fireEvent.change(to,{target:{value:'2023-06-30'}});
 fireEvent.click(within(dialog).getByRole('button',{name:c.applyChoice}));
 const href=lastHref();
 expect(href.searchParams.get('joinedFrom')).toBe('2022-01-01');expect(href.searchParams.get('joinedTo')).toBe('2023-06-30');
 expect(href.searchParams.has('page')).toBe(false);
});

it('keeps free-text columns on the private type-to-filter box and re-posts other private criteria',()=>{
 const view=render(table());
 const form=view.container.querySelector<HTMLFormElement>('#personnel-column-filter')!;
 // Name is free text: a visible private box. Department/Status/Join date are header filters, not private fields.
 expect(screen.getByRole('textbox',{name:c.filterColumn.replace('{name}','Name')})).toHaveValue('Fictional');
 expect(view.container.querySelector('input[name="field.department"][type="text"],select[name="field.department"]')).toBeNull();
 expect(view.container.querySelector('input[name="field.joinDate"]')).toBeNull();
 // An existing private Department criterion (an older token) still travels, so a text change does not drop it.
 expect(form.querySelector<HTMLInputElement>('input[type="hidden"][name="field.department"]')?.value).toBe(finance);
 expect(form.querySelectorAll('input[name="operator.department"]')).toHaveLength(1);
});

it('says when nothing matches and offers Clear filters',()=>{
 render(table({rows:[],emptyClearHref:'/admin/personnel'}));
 expect(screen.getByText(en.people.list.emptyFiltered)).toHaveAttribute('role','status');
 const cell=screen.getByText(en.people.list.emptyFiltered).closest('td')!;
 expect(within(cell).getByRole('link',{name:c.clear})).toHaveAttribute('href','/admin/personnel');
});

it('builds the next URL from the current params, dropping the page and keeping the size',()=>{
 expect(personnelFilterHref([['dept','a'],['page','3'],['size','25'],['q','x']],{dept:['b','c',' b ']},'100')).toBe('/admin/personnel?q=x&dept=b%2Cc&size=100');
 expect(personnelFilterHref([['joinedFrom','2020-01-01']],{joinedFrom:[''],joinedTo:['']})).toBe('/admin/personnel');
});

// Browser evidence is a CI-only operation (two Chrome viewports; the helper fails on page-level overflow).
it('captures the header with the Department multi-select open',async()=>{
 render(table({dept:[finance,hr,it_]}));
 fireEvent.click(trigger('Department'));
 expect(panel('Department')).toBeInTheDocument();
 await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en','feedback-personnel-column-filters','Approved aa045103 header multi-select filter; real Personnel components with fictional records; no installed acceptance','atelier');
},120000);
