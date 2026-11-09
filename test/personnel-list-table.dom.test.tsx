import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {EMPLOYEE_COLUMN_KEYS,type EmployeeColumnKey} from '../lib/employee-columns';
import {PersonnelListTable} from '../app/admin/personnel/list-table';
import {PersonnelExportOptions} from '../app/admin/personnel/export-options';
import {PersonnelAutoFilters} from '../app/admin/personnel/auto-filter';
const controls=vi.hoisted(()=>({save:vi.fn(),refresh:vi.fn(),replace:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:controls.refresh,replace:controls.replace})}));
vi.mock('../app/admin/personnel/column-actions',()=>({saveEmployeeColumnsAction:controls.save}));
afterEach(cleanup);beforeEach(()=>{controls.save.mockReset().mockResolvedValue(undefined);controls.replace.mockReset();controls.refresh.mockReset();});
const labels=Object.fromEntries(EMPLOYEE_COLUMN_KEYS.map(key=>[key,key])) as Record<EmployeeColumnKey,string>;
const make=()=>render(<NextIntlClientProvider locale="en" messages={en}><PersonnelListTable columns={['code','name','joinDate']} allOrder={[...EMPLOYEE_COLUMN_KEYS]} labels={labels} employees={[{employmentId:'fixture',name:'Example employee',status:'active',statusLabel:'Active',employeeCode:'EX-1',text:{joinDate:'2026-01-01'}}]} drafts={[]} parameters={[["companies","fixture-company"],["page","3"],["search","a".repeat(43)]]} empty="No employees"/></NextIntlClientProvider>);
it('separates accessible reorder handles, sorting and private column criteria while preserving row links',async()=>{
 const view=make();expect(screen.getByRole('link',{name:'Example employee'})).toHaveAttribute('href','/admin/personnel/fixture?from=personnel');
 fireEvent.keyDown(screen.getByRole('button',{name:'Move name'}),{key:'ArrowLeft'});
 await waitFor(()=>expect(controls.save).toHaveBeenCalled());expect(controls.save.mock.calls[0][0].selected).toEqual(['name','code','joinDate']);
 expect([...view.container.querySelectorAll('th')].map(node=>node.getAttribute('data-column'))).toEqual(['name','code','joinDate']);
 expect(within(view.container.querySelector('tbody tr')!).getByText('Example employee')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'joinDate'}));expect(controls.replace).toHaveBeenCalledWith(expect.stringContaining('sort=joinDate'),{scroll:false});expect(controls.replace.mock.calls[0][0]).not.toContain('page=');
 const input=screen.getByLabelText('Filter name');fireEvent.change(input,{target:{value:'PRIVATE-FICTIONAL-NAME'}});expect(input).toHaveAttribute('form','personnel-column-filter');expect(view.container.querySelector('#personnel-column-filter')).toHaveAttribute('method','post');expect(view.container.querySelector('#personnel-column-filter')).toHaveAttribute('action','/admin/personnel/search');
});
it('reverts optimistic order and reports a failed preference write',async()=>{
 controls.save.mockRejectedValueOnce(new Error('fixture'));const view=make();fireEvent.keyDown(screen.getByRole('button',{name:'Move name'}),{key:'ArrowLeft'});expect(await screen.findByRole('alert')).toHaveTextContent(en.people.list.controls.saveFailed);expect([...view.container.querySelectorAll('th')].map(node=>node.getAttribute('data-column'))).toEqual(['code','name','joinDate']);
});
it('retains criteria in editable headers while preserving hidden fields and term only in POST bodies',()=>{
 const criteria={term:'PRIVATE-IDENTITY',filters:[{field:'name',operator:'contains' as const,value:'Retained Name'},{field:'employment.orgDivision',operator:'equals' as const,value:'Private Division'}]};
 const view=render(<NextIntlClientProvider locale="en" messages={en}><PersonnelListTable columns={['name']} allOrder={[...EMPLOYEE_COLUMN_KEYS]} labels={labels} employees={[]} drafts={[]} parameters={[]} privateCriteria={criteria} empty="None"/></NextIntlClientProvider>);
 expect(screen.getByLabelText('Filter name')).toHaveValue('Retained Name');
 const form=view.container.querySelector<HTMLFormElement>('#personnel-column-filter')!;
 expect(form.querySelector('input[name="term"]')).toHaveValue('PRIVATE-IDENTITY');expect(form.querySelector('input[name="field.employment.orgDivision"]')).toHaveValue('Private Division');expect(form).toHaveAttribute('action','/admin/personnel/search');
});

// Browser evidence is a separate CI-only operation: this helper cold-compiles full application CSS,
// loads the shipped script fonts and captures two Chrome viewports. Keep interaction cases at 5s;
// use the same bounded browser budget as the existing Personnel capture cases, rather than relaxing them.
it('captures the actual listing controls in desktop and phone viewports',async()=>{
 const view=make();
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','feedback-personnel-column-controls','Approved column-filter and header-reorder listing; real Personnel components with fictional records; no installed acceptance','atelier');
},120000);

it('coalesces typing and sends private filter text only in the request body', async () => {
 const fetchMock = vi.fn().mockResolvedValue(Response.json({ href: '/admin/personnel?search='+'a'.repeat(43)+'&size=50' }));
 vi.stubGlobal('fetch', fetchMock);
 try {
  render(<NextIntlClientProvider locale="en" messages={en}><PersonnelAutoFilters>
    <PersonnelListTable columns={['name']} allOrder={[...EMPLOYEE_COLUMN_KEYS]} labels={labels} employees={[]} drafts={[]} parameters={[]} pageSize="50" empty="None"/>
  </PersonnelAutoFilters></NextIntlClientProvider>);
  const field = screen.getByLabelText('Filter name');
  fireEvent.change(field, { target: { value: 'Fi' } });
  fireEvent.change(field, { target: { value: 'Fictional' } });
  await waitFor(() => expect(controls.replace).toHaveBeenCalledWith('/admin/personnel?search='+'a'.repeat(43)+'&size=50', { scroll: false }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [target, request] = fetchMock.mock.calls[0];
  expect(target).toBe('/admin/personnel/search');
  expect(request.method).toBe('POST');
  expect(request.body.get('field.name')).toBe('Fictional');
  expect(request.body.get('size')).toBe('50');
  expect(request.body.has('page')).toBe(false);
 } finally {
  vi.unstubAllGlobals();
 }
});

it('renders the two distinct Excel download choices', async () => {
 render(<NextIntlClientProvider locale="en" messages={en}>
  <PersonnelExportOptions pageHref="/admin/personnel/export?mode=page&page=1&size=25" allHref="/admin/personnel/export?mode=all" hasPage hasEmployees/>
 </NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button', { name: 'Export' }));
 expect(screen.getByRole('link', { name: 'Export Current Page Information' })).toHaveAttribute('href', expect.stringContaining('mode=page&page=1'));
 expect(screen.getByRole('link', { name: 'Export All Employee Details' })).toHaveAttribute('href', expect.stringContaining('mode=all'));
 await captureAiReviewScreenshots(aiReviewDomHtml(document.body), 'en', 'feedback-personnel-export-choices',
  'Actual Personnel export choice dialog with fictional scoped downloads');
}, 120_000);
