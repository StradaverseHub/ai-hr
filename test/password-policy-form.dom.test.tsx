import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
const copies={en,ms,zh,vi:viCopy,ta,th};
type Locale=keyof typeof copies;
import {DEFAULT_PASSWORD_POLICY} from '../lib/password-policy';
vi.mock('../app/admin/security-center/password-policy/actions',()=>({saveFullPasswordPolicy:vi.fn(async()=>({status:'saved'}))}));
import {PasswordPolicyForm} from '../app/admin/security-center/password-policy/policy-form';
afterEach(cleanup);
function show(locale:Locale='en'){render(<NextIntlClientProvider locale={locale} messages={copies[locale]} onError={error=>{throw error;}}><PasswordPolicyForm policy={DEFAULT_PASSWORD_POLICY} revision={0}/></NextIntlClientProvider>);}
describe('complete password policy form',()=>{
 it('starts with the requested new draft and requires a deliberate save',async()=>{
  show();expect((screen.getByLabelText(en.passwordPolicy.full.minLength) as HTMLInputElement).value).toBe('8');
  expect((screen.getByLabelText(en.passwordPolicy.full.maxLength) as HTMLInputElement).value).toBe('32');
  expect((screen.getByLabelText(en.passwordPolicy.full.forceFirstChange) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole('button',{name:en.passwordPolicy.save})).toBeTruthy();
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en','security-password-policy');
 },30_000);
 it('only permits automatic unlock after account lockout and retains optional numeric values',()=>{
  show();const auto=screen.getByLabelText(en.passwordPolicy.full.autoUnlock) as HTMLInputElement;
  expect(auto.disabled).toBe(true);fireEvent.click(screen.getByLabelText(en.passwordPolicy.full.lockoutEnabled));
  expect(auto.disabled).toBe(false);fireEvent.click(auto);expect((screen.getByLabelText(en.passwordPolicy.full.unlockMinutes) as HTMLInputElement).value).toBe('15');
  fireEvent.click(screen.getByLabelText(en.passwordPolicy.full.lockoutEnabled));expect(auto.checked).toBe(false);expect(auto.disabled).toBe(true);
 });
 it.each(Object.keys(copies) as Locale[])('%s renders the saved-policy controls and enabled lockout fields',async locale=>{
  show(locale);const copy=copies[locale].passwordPolicy;
  expect((screen.getByLabelText(copy.full.minLength) as HTMLInputElement).value).toBe('8');
  expect((screen.getByLabelText(copy.full.maxLength) as HTMLInputElement).value).toBe('32');
  expect((screen.getByLabelText(copy.full.forceFirstChange) as HTMLInputElement).checked).toBe(true);
  if(locale!=='en')await captureAiReviewScreenshots(aiReviewDomHtml(document.body),locale,'security-password-policy');
  fireEvent.click(screen.getByLabelText(copy.full.lockoutEnabled));fireEvent.click(screen.getByLabelText(copy.full.autoUnlock));
  expect((screen.getByLabelText(copy.full.unlockMinutes) as HTMLInputElement).value).toBe('15');
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),locale,'security-password-policy-enabled');
 },60_000);
});
