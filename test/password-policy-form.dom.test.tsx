import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {DEFAULT_PASSWORD_POLICY} from '../lib/password-policy';
vi.mock('../app/admin/security-center/password-policy/actions',()=>({saveFullPasswordPolicy:vi.fn(async()=>({status:'saved'}))}));
import {PasswordPolicyForm} from '../app/admin/security-center/password-policy/policy-form';
afterEach(cleanup);
function show(){render(<NextIntlClientProvider locale="en" messages={en}><PasswordPolicyForm policy={DEFAULT_PASSWORD_POLICY} revision={0}/></NextIntlClientProvider>);}
describe('complete password policy form',()=>{
 it('starts with the requested new draft and requires a deliberate save',()=>{
  show();expect((screen.getByLabelText(en.passwordPolicy.full.minLength) as HTMLInputElement).value).toBe('8');
  expect((screen.getByLabelText(en.passwordPolicy.full.maxLength) as HTMLInputElement).value).toBe('32');
  expect((screen.getByLabelText(en.passwordPolicy.full.forceFirstChange) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole('button',{name:en.passwordPolicy.save})).toBeTruthy();
 });
 it('only permits automatic unlock after account lockout and retains optional numeric values',()=>{
  show();const auto=screen.getByLabelText(en.passwordPolicy.full.autoUnlock) as HTMLInputElement;
  expect(auto.disabled).toBe(true);fireEvent.click(screen.getByLabelText(en.passwordPolicy.full.lockoutEnabled));
  expect(auto.disabled).toBe(false);fireEvent.click(auto);expect((screen.getByLabelText(en.passwordPolicy.full.unlockMinutes) as HTMLInputElement).value).toBe('15');
  fireEvent.click(screen.getByLabelText(en.passwordPolicy.full.lockoutEnabled));expect(auto.checked).toBe(false);expect(auto.disabled).toBe(true);
 });
});
