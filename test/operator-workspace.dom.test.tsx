import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {OperatorShell} from '../components/operator-shell';
import {CustomerCreateForm,CustomerModuleForm,CustomerNameForm} from '../app/(app)/operator/customer-forms';
import type {ReactNode} from 'react';
vi.mock('next/navigation',()=>({usePathname:()=>'/operator'}));
vi.mock('../components/language-switcher',()=>({LanguageSwitcher:()=>null}));
vi.mock('../components/theme-toggle',()=>({ThemeToggle:()=>null}));
vi.mock('../components/logout-button',()=>({LogoutButton:()=> <button>Log out</button>}));
vi.mock('../app/(app)/operator/actions',()=>({submitCustomerAction:vi.fn(),renameCustomerAction:vi.fn(),changeCustomerModuleAction:vi.fn()}));
afterEach(cleanup);
const show=(node:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages} onError={e=>{throw e;}}>{node}</NextIntlClientProvider>);
const modules=[{code:'payroll',name:'Payroll',description:'Payroll processing.',dependsOn:['employees'],billable:true},
 {code:'multi_cycle_payroll',name:'Multi-Cycle Payroll',description:'Multiple cycles.',dependsOn:['payroll'],billable:true}];
describe('operator tasks and controls',()=>{
 it('offers only installation navigation and logout, with no employee destinations',()=>{
  show(<OperatorShell name="Test Operator"><p>Customer content</p></OperatorShell>);
  const nav=screen.getByRole('navigation',{name:'Operator workspace'});
  expect(within(nav).getAllByRole('link').map(a=>a.textContent)).toEqual(['Customers','Provisioning','Operator guide']);
  expect(within(nav).getByRole('link',{name:'Customers'})).toHaveAttribute('href','/operator');
  for(const name of ['Dashboard','My HR','My workspace','Payroll','Company'])expect(within(nav).queryByRole('link',{name})).toBeNull();
  expect(screen.getByRole('button',{name:'Log out'})).toBeTruthy();
 });
 it('captures the organization code and keeps the catalog defaults in the submitted form',()=>{
  show(<CustomerCreateForm internalAuth countries={['MY']} modules={modules} defaults={['payroll']} coreNames="Employees, Leave"/>);
  const code=screen.getByRole('textbox',{name:/Organization code/});expect(code).toHaveAttribute('name','organizationCode');expect(code).toBeRequired();
  expect(code).toHaveAttribute('pattern','[a-z0-9][a-z0-9-]{1,63}');
  expect(screen.getByRole('checkbox',{name:/Payroll Payroll processing/})).toBeChecked();
  expect(screen.getByRole('checkbox',{name:/Multi-Cycle Payroll/})).not.toBeChecked();
  fireEvent.change(code,{target:{value:'customer-code'}});
  const form=code.closest('form')!;const data=new FormData(form);
  expect(data.get('organizationCode')).toBe('customer-code');expect(data.getAll('modules')).toEqual(['payroll']);
 });
 it('does not introduce an internal login namespace into other authentication providers',()=>{
  show(<CustomerCreateForm internalAuth={false} countries={['MY']} modules={modules} defaults={[]} coreNames="Employees"/>);
  expect(screen.queryByRole('textbox',{name:/Organization code/})).toBeNull();
 });
 it('edits the customer name without an editable organization field',()=>{
  show(<CustomerNameForm tenantId="test" name="Existing customer"/>);
  expect(screen.getByRole('textbox',{name:'Customer name'})).toHaveValue('Existing customer');
  expect(screen.queryByRole('textbox',{name:/Organization/})).toBeNull();
 });
 it('explains missing dependencies and refuses to offer an unusable activation',()=>{
  show(<CustomerModuleForm tenantId="test" modules={modules} grants={[]} blockers={{}} busy={false}/>);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'multi_cycle_payroll'}});
  expect(screen.getByRole('alert')).toHaveTextContent('Enable these required modules first: Payroll.');
  expect(screen.getByRole('button',{name:'Enable module'})).toBeDisabled();
 });
 it('requires the purchase reference and preserves customer data when disabling',()=>{
  const {unmount}=show(<CustomerModuleForm tenantId="test" modules={modules} grants={[]} blockers={{}} busy={false}/>);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'payroll'}});
  expect(screen.getByRole('textbox',{name:/Purchase or agreement reference/})).toBeRequired();unmount();
  show(<CustomerModuleForm tenantId="test" modules={modules} grants={[{code:'payroll',status:'active',companyId:null}]}
   blockers={{payroll:[{kind:'draft_payroll_batch',count:2,detail:'2 payroll batches are still in draft.'}]}} busy={false}/>);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'payroll'}});
  expect(screen.getByText(/preserves its data and existing obligations/)).toBeTruthy();
  expect(screen.getByRole('textbox',{name:/2 payroll batches/})).toBeRequired();
 });
 it('clears the previous module controls when a successful action resets the form',()=>{
  show(<CustomerModuleForm tenantId="test" modules={modules} grants={[]} blockers={{}} busy={false}/>);
  const select=screen.getByRole('combobox');fireEvent.change(select,{target:{value:'payroll'}});
  expect(screen.getByRole('textbox',{name:/Purchase or agreement reference/})).toBeTruthy();
  fireEvent.reset(select.closest('form')!);
  expect(select).toHaveValue('');
  expect(screen.queryByRole('textbox',{name:/Purchase or agreement reference/})).toBeNull();
  expect(screen.queryByRole('button',{name:'Enable module'})).toBeNull();
 });
 it('prevents another submission while a module change is pending',()=>{
  show(<CustomerModuleForm tenantId="test" modules={modules} grants={[]} blockers={{}} busy/>);
  expect(screen.getByRole('combobox')).toBeDisabled();expect(screen.getByRole('status')).toHaveTextContent(/in progress/);
 });
});
