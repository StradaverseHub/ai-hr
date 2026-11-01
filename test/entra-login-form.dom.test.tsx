import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()})}));
vi.mock('next/image',()=>({default:(props:Record<string,unknown>)=><img {...props}/>}));
import {InternalAuthForm} from '../app/login/internal-form';
afterEach(cleanup);
describe('Microsoft login choice',()=>{
 it('uses the entered organization without sending local passwords to a query string',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><InternalAuthForm organization="acme" returnTo="/me"/></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.internalAuth.organization),{target:{value:'second-company'}});
  fireEvent.change(screen.getByLabelText(en.internalAuth.password),{target:{value:'private-local-password'}});
  const button=screen.getByRole('button',{name:en.entra.microsoft}),form=button.closest('form')!;
  expect(form).toHaveAttribute('action','/login/entra/start');expect(form).toHaveAttribute('method','get');
  expect(Object.fromEntries(new FormData(form))).toEqual({organization:'second-company',returnTo:'/me'});
 });
 it('shows a recoverable Microsoft failure while preserving the normal login controls',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><InternalAuthForm organization="acme" entraError/></NextIntlClientProvider>);
  expect(screen.getByRole('alert')).toHaveTextContent(en.entra.loginError);expect(screen.getByLabelText(en.internalAuth.password)).toBeEnabled();
 });
});
