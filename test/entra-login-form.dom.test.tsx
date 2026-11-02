import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()})}));
vi.mock('next/image',()=>({default:(props:Record<string,unknown>)=><img {...props}/>}));
import {InternalAuthForm} from '../app/login/internal-form';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const show=(props:Record<string,unknown>={})=>render(<NextIntlClientProvider locale="en" messages={en}><InternalAuthForm organization="acme" returnTo="/me" {...props}/></NextIntlClientProvider>);
describe('Microsoft login choice',()=>{
 it('shows only an enabled organization and never sends local passwords in discovery or the Microsoft form',async()=>{
  const fetcher=vi.fn().mockImplementation(async()=>Response.json({microsoft:true}));vi.stubGlobal('fetch',fetcher);show();
  expect(screen.queryByRole('button',{name:en.internalAuth.microsoft})).not.toBeInTheDocument();
  await screen.findByRole('button',{name:en.internalAuth.microsoft});
  fireEvent.change(screen.getByLabelText(en.internalAuth.organization),{target:{value:'second-company'}});
  expect(screen.queryByRole('button',{name:en.internalAuth.microsoft})).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(en.internalAuth.password),{target:{value:'private-local-password'}});
  const button=await screen.findByRole('button',{name:en.internalAuth.microsoft}),form=button.closest('form')!;
  expect(form).toHaveAttribute('action','/login/entra/start');expect(form).toHaveAttribute('method','get');
  expect(Object.fromEntries(new FormData(form))).toEqual({organization:'second-company',returnTo:'/me'});
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/login/entra/options?organization=second-company');
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain('private-local-password');
 });
 it.each([false,undefined,'true'])('hides disabled, unconfigured or malformed availability (%s)',async flag=>{
  const fetcher=vi.fn().mockImplementation(async()=>Response.json({microsoft:flag}));vi.stubGlobal('fetch',fetcher);show();
  await waitFor(()=>expect(fetcher).toHaveBeenCalled());
  expect(screen.queryByRole('button',{name:en.internalAuth.microsoft})).not.toBeInTheDocument();
  expect(screen.getByLabelText(en.internalAuth.password)).toBeEnabled();
 });
 it('keeps Microsoft hidden on lookup failure while preserving local login and the recoverable error',async()=>{
  const fetcher=vi.fn().mockRejectedValue(new Error('Offline'));vi.stubGlobal('fetch',fetcher);show({entraError:true});
  await waitFor(()=>expect(fetcher).toHaveBeenCalled());
  expect(screen.queryByRole('button',{name:en.internalAuth.microsoft})).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(en.internalAuth.microsoftError);expect(screen.getByLabelText(en.internalAuth.password)).toBeEnabled();
 });
});
