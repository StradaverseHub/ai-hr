import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import enBase from '../messages/en.json';
import enEditorial from '../messages/login-editorial/en.json';
const en = { ...enBase, loginEditorial: enEditorial };
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()})}));
vi.mock('next/image',()=>({default:(props:Record<string,unknown>)=><img {...props}/>}));
import {InternalAuthForm} from '../app/login/internal-form';
afterEach(cleanup);
describe('Microsoft login choice',()=>{
 it('uses the entered organization without sending local passwords to a query string',()=>{
  render(<NextIntlClientProvider locale="en" messages={enBase}><InternalAuthForm organization="acme" returnTo="/me"/></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.loginEditorial.workspaceLabel),{target:{value:'second-company'}});
  fireEvent.click(screen.getByRole('button',{name:en.loginEditorial.continueLabel}));
  fireEvent.change(screen.getByLabelText(en.internalAuth.password),{target:{value:'private-local-password'}});
  const button=screen.getByRole('button',{name:en.internalAuth.microsoft}),form=button.closest('form')!;
  expect(form).toHaveAttribute('action','/login/entra/start');expect(form).toHaveAttribute('method','get');
  expect(Object.fromEntries(new FormData(form))).toEqual({organization:'second-company',returnTo:'/me'});
 });
 it('shows a recoverable Microsoft failure while preserving the normal login controls',()=>{
  render(<NextIntlClientProvider locale="en" messages={enBase}><InternalAuthForm organization="acme" entraError/></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button',{name:en.loginEditorial.continueLabel}));
  expect(screen.getByRole('alert')).toHaveTextContent(en.internalAuth.microsoftError);expect(screen.getByLabelText(en.internalAuth.password)).toBeEnabled();
 });
});
