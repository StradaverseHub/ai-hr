import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import en from '../messages/en.json';
import type {AccountEmailDeliveryView} from '../lib/account-email-model';
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>((key:string)=>key.split('.').reduce((value:any,part)=>value?.[part],en.accountEmail)??key)}));
vi.mock('../app/(app)/admin/settings/notifications/actions',()=>({retryAccountEmailAction:vi.fn()}));
import {AccountEmailDeliveries} from '../components/account-email-deliveries';
const item=(kind:'invitation'|'recovery',canRetry=true):AccountEmailDeliveryView=>({id:kind+'-delivery',kind,email:kind+'@example.test',status:'failed',attempts:1,error:'relayUnavailable',createdAt:new Date('2026-10-15T01:00:00Z'),canRetry});
beforeEach(()=>{cleanup();vi.stubEnv('AUTH_PROVIDER','internal');});afterEach(()=>vi.unstubAllEnvs());
describe('account email failure log',()=>{
 it('does not invent an original message for an external identity provider',async()=>{
  vi.stubEnv('AUTH_PROVIDER','keycloak');render(await AccountEmailDeliveries({items:[item('invitation')],returnTo:'/admin/settings/email'}));
  fireEvent.click(screen.getByText(en.accountEmail.viewEmail,{selector:'summary'}));expect(screen.getByText(en.accountEmail.providerManagedPreview)).toBeVisible();expect(screen.queryByText(/\[Activation link hidden\]/)).toBeNull();
 });
 it('shows a table in Malaysia time, a token-free preview and an explicit resend confirmation for sent emails',async()=>{
  render(await AccountEmailDeliveries({items:[{...item('invitation'),status:'sent',error:null}],returnTo:'/admin/settings/email',history:{hasMore:true,nextCursor:'opaque-page'}}));
  expect(screen.getByRole('table')).toBeTruthy();const instant=document.querySelector('time')!;expect(instant).toHaveAttribute('dateTime','2026-10-15T01:00:00.000Z');expect(instant.textContent).toContain('09:00 MYT');
  fireEvent.click(screen.getByText(en.accountEmail.viewEmail,{selector:'summary'}));expect(screen.getByText(en.accountEmail.previewHelp)).toBeVisible();expect(screen.getByText(/\[Activation link hidden\]/)).toBeVisible();
  const resend=screen.getByRole('button',{name:en.accountEmail.resend}).closest('details')!;expect(resend).not.toHaveAttribute('open');fireEvent.click(screen.getByText(en.accountEmail.resend,{selector:'summary'}));expect(resend).toHaveAttribute('open');
  expect((screen.getByRole('checkbox',{name:en.accountEmail.invitationAck}) as HTMLInputElement).required).toBe(true);
  expect(screen.getByRole('link',{name:en.accountEmail.older})).toHaveAttribute('href','/admin/settings/email?before=opaque-page');
 });
 it('shows failed invitations with explicit reissue acknowledgement and no authentication link',async()=>{
  render(await AccountEmailDeliveries({items:[item('invitation')],returnTo:'/admin/settings/notifications'}));
  expect(screen.getByText(en.accountEmail.statuses.failed)).toBeTruthy();expect(screen.getByText(en.accountEmail.errors.relayUnavailable)).toBeTruthy();
  fireEvent.click(screen.getByText(en.accountEmail.reissue,{selector:'summary'}));expect(screen.getByRole('button',{name:en.accountEmail.reissue})).toBeTruthy();
  const acknowledgement=screen.getByRole('checkbox',{name:en.accountEmail.invitationAck}) as HTMLInputElement;expect(acknowledgement.required).toBe(true);expect(acknowledgement.checked).toBe(false);
  expect(document.querySelector('a[href*="token"],input[name="token"],input[name="password"],input[name="email"]')).toBeNull();
  expect((document.querySelector('input[name="deliveryId"]') as HTMLInputElement).value).toBe('invitation-delivery');
 });
 it('uses the operator page for recovery retries and hides actions for replaced or ineligible jobs',async()=>{
  render(await AccountEmailDeliveries({items:[item('recovery'),item('invitation',false)],returnTo:'/admin/settings/email'}));
  fireEvent.click(screen.getByText(en.accountEmail.retryRecovery,{selector:'summary'}));expect(screen.getByRole('button',{name:en.accountEmail.retryRecovery})).toBeTruthy();expect(screen.queryByRole('button',{name:en.accountEmail.reissue})).toBeNull();
  expect((document.querySelector('input[name="returnTo"]') as HTMLInputElement).value).toBe('/admin/settings/email');
  expect((screen.getByRole('checkbox',{name:en.accountEmail.recoveryAck}) as HTMLInputElement).required).toBe(true);
 });
 it('has an honest empty state and does not promise automatic replay after SMTP setup',async()=>{
  render(await AccountEmailDeliveries({items:[],returnTo:'/admin/settings/notifications'}));expect(screen.getByText(en.accountEmail.empty)).toBeTruthy();expect(screen.getByText(en.accountEmail.help)).toBeTruthy();expect(screen.queryByRole('button')).toBeNull();
 });
});
