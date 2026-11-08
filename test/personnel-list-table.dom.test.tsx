import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {EMPLOYEE_COLUMN_KEYS,type EmployeeColumnKey} from '../lib/employee-columns';
import {PersonnelListTable} from '../app/admin/personnel/list-table';
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
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','personnel-organisation-results','Approved column-filter and header-reorder listing; real Personnel components with fictional records; no installed acceptance','atelier');
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
