import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
vi.mock('../app/admin/personnel/[employmentId]/actions',()=>({correctHireDetailsAction:vi.fn(async()=>{}),saveMovementPageAction:vi.fn(async()=>null)}));
vi.mock('../components/derived-organisation-fields',()=>({useDerivedOrganisation:()=>({data:{status:'legacy',managed:false},loading:false}),DerivedOrganisationFields:()=>null}));
import {HireCorrectionForm} from '../app/admin/personnel/[employmentId]/hire-correction-form';
afterEach(cleanup);
function mount(){return render(<NextIntlClientProvider locale="en" messages={messages}><HireCorrectionForm employmentId="fictional" heading="Hired · 1 January 2026" fields={[]} readOnly={[]} cancelHref="/history" information={[
 {field:'companyId',label:'Company',value:'original',display:'Fictional Original Company',type:'select',required:true,options:[{id:'original',name:'Fictional Original Company'},{id:'corrected',name:'Fictional Corrected Company'}]},
 {field:'hiredOn',label:'Group Join Date',value:'2026-01-01',display:'1 January 2026',type:'date',required:true},
 {field:'employmentType',label:'Employment Type',value:'full_time',display:'Full time',type:'select',required:true,options:[{id:'full_time',name:'Full time'},{id:'contract',name:'Contract'}]},
 ]}/></NextIntlClientProvider>);}
describe('Correct Hire employment information controls',()=>{
 it('posts only explicitly changed original-hire fields with the shared before/after headings',()=>{
  const {container}=mount(),form=container.querySelector('form')!;
  expect(new FormData(form).get('hireInformation_companyId')).toBeNull();
  expect(new FormData(form).has('companyId')).toBe(false);
  expect(container.querySelector('#hire-information-companyId')).toHaveAccessibleName('Company');
  expect(screen.getByText('Before Changes')).toBeInTheDocument();expect(screen.getByText('After Changes')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Company'),{target:{value:'corrected'}});
  const data=new FormData(form);expect(data.get('hireInformation_companyId')).toBe('corrected');expect(data.get('hireInformation_hiredOn')).toBeNull();
  expect(screen.getByRole('button',{name:messages.people.detail.movement.hireCorrection.review})).toBeDisabled();
  fireEvent.change(container.querySelector('textarea')!,{target:{value:'Fictional original company was keyed incorrectly'}});
  expect(screen.getByRole('button',{name:messages.people.detail.movement.hireCorrection.review})).toBeEnabled();
  expect(screen.queryByRole('checkbox')).toBeNull();
 });
 it('keeps value/unit changes together under explicit original-hire field names',()=>{
  const {container}=render(<NextIntlClientProvider locale="en" messages={messages}><HireCorrectionForm employmentId="fictional" heading="Hired" fields={[]} readOnly={[]} cancelHref="/history" information={[
   {field:'probationValue',label:'Probation value',value:'3',display:'3',type:'number'},
   {field:'probationUnit',label:'Probation unit',value:'month',display:'Month',type:'select',options:[{id:'month',name:'Month'},{id:'week',name:'Week'}]},
  ]}/></NextIntlClientProvider>);
  fireEvent.change(container.querySelector('input[data-personnel-field="employment.employment_dates_and_service.probationvalue"]')!,{target:{value:'4'}});fireEvent.change(container.querySelector('select[data-personnel-field="employment.employment_dates_and_service.probationunit"]')!,{target:{value:'week'}});
  const data=new FormData(container.querySelector('form')!);expect(data.get('hireInformation_probationValue')).toBe('4');expect(data.get('hireInformation_probationUnit')).toBe('week');
 });
 it('offers the contract end date when the corrected original type changes to Contract',()=>{
  const {container}=mount();fireEvent.change(screen.getByLabelText('Employment Type'),{target:{value:'contract'}});
  const date=container.querySelector('input[data-personnel-field="employment.employment_dates_and_service.contractenddate"]');
  expect(date).not.toBeNull();fireEvent.change(date!,{target:{value:'2026-12-31'}});
  const data=new FormData(container.querySelector('form')!);expect(data.get('hireInformation_employmentType')).toBe('contract');expect(data.get('contractEndDate')).toBe('2026-12-31');
 });
});
