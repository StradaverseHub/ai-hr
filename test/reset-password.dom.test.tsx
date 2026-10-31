import {beforeEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import en from '../messages/en.json';
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key.split('.').reduce((value:any,part)=>value?.[part],en.auth)??key)}));
vi.mock('../app/auth-actions',()=>({requestPasswordResetAction:vi.fn()}));
import ResetPasswordPage from '../app/(auth)/reset-password/page';
beforeEach(cleanup);
describe('public recovery request without SMTP',()=>{
 it('keeps an application request form available without provider configuration',async()=>{
  render(await ResetPasswordPage({searchParams:Promise.resolve({})}));
  const input=screen.getByLabelText(en.auth.reset.emailLabel) as HTMLInputElement;expect(input.type).toBe('email');expect(input.required).toBe(true);
  expect(screen.getByRole('button',{name:en.auth.reset.submit})).toBeTruthy();
 });
 it('shows the same conditional confirmation without exposing account or delivery status',async()=>{
  render(await ResetPasswordPage({searchParams:Promise.resolve({sent:'1'})}));
  expect(screen.getByText(en.auth.reset.sent)).toBeTruthy();expect(screen.queryByRole('button')).toBeNull();expect(screen.queryByRole('textbox')).toBeNull();
 });
});
