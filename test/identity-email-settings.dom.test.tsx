import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
const m=vi.hoisted(()=>({session:vi.fn(),allowed:vi.fn(),guard:vi.fn(),read:vi.fn(),demo:vi.fn(),accounts:vi.fn(),project:vi.fn(),log:vi.fn(()=>null),test:vi.fn(),retention:vi.fn()}));
vi.mock('next/navigation',()=>({usePathname:()=>'/admin/settings/email',useSearchParams:()=>new URLSearchParams(),redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:'identityEmail'|'accountEmail')=>((key:string)=>key.split('.').reduce((v:any,k)=>v?.[k],messages[namespace])??key)}));
vi.mock('../core/account-email',()=>({readAccountEmailHistory:m.accounts}));
vi.mock('../core/account-email-retention',()=>({readAccountEmailRetention:m.retention}));
vi.mock('../lib/internal-auth/account-email-view',()=>({withInternalRecoveryLabels:m.project}));
vi.mock('../components/account-email-deliveries',()=>({AccountEmailDeliveries:m.log}));
vi.mock('../lib/scope',()=>({scopedSession:m.session}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../lib/demo-mode',()=>({demoSwitcherEnabled:m.demo}));
vi.mock('../lib/identity/email-settings',()=>({canConfigureIdentityEmail:m.allowed,requireIdentityEmailAdmin:m.guard,readIdentityEmailSettings:m.read}));
vi.mock('../app/admin/settings/email/actions',()=>({saveEmailDraft:vi.fn(),testEmailDraft:vi.fn(),activateEmailDraft:vi.fn()}));
vi.mock('../app/admin/settings/email/demo-actions',()=>({testDemoSmtpConnection:m.test}));
import Page from '../app/admin/settings/email/page';
import { Sidebar } from '../components/sidebar';
import { defaultEmailConfig, EmailSettingsError } from '../lib/identity/email-model';
const wrap=(node:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
const page=async(query={})=>wrap(await Page({searchParams:Promise.resolve(query)}));
const sidebar=(admin:boolean,operator=false,preview=admin)=>wrap(<Sidebar isAdmin={admin} canApprove={false} canPreviewIdentityEmail={preview} canConfigureIdentityEmail={operator} enabledModules={[]} defaultCollapsed={false}/>);
function openSystemSettings() {
 const section=document.querySelector<HTMLButtonElement>('button[aria-controls="nav-section-systemConfiguration"]');
 if(section?.getAttribute('aria-expanded')==='false')fireEvent.click(section);
 const triggers=screen.getAllByRole('button',{name:messages.nav.systemConfiguration}).filter(button=>button.hasAttribute('aria-controls')&&button.getAttribute('aria-controls')!=='nav-section-systemConfiguration');
 expect(triggers).toHaveLength(1);const trigger=triggers[0];
 if(trigger.getAttribute('aria-expanded')!=='true')fireEvent.click(trigger);
 const panel=document.getElementById(trigger.getAttribute('aria-controls')!);expect(panel).not.toBeNull();
 return panel!;
}
beforeEach(()=>{
 cleanup();vi.clearAllMocks();m.session.mockResolvedValue({s:{userId:'admin',roles:['hr_admin']}});m.allowed.mockResolvedValue(false);m.demo.mockReturnValue(true);m.accounts.mockResolvedValue({items:[],hasMore:false,nextCursor:undefined});m.retention.mockResolvedValue(null);m.guard.mockResolvedValue({session:{userId:'operator'},actor:{subject:'verified'}});
 m.test.mockResolvedValue({status:'success',authenticated:true});
 m.project.mockImplementation(async(_session,_actor,items)=>items);
 m.read.mockResolvedValue({active:{...defaultEmailConfig,host:'live.smtp.example.test',from:'live@example.test',hasPassword:true},draft:null,revision:'a'.repeat(64),testRecipient:'owner@example.test'});
});
describe('SMTP settings discovery and temporary demo testing',()=>{
 it('lets a demo administrator find Email delivery under System Configuration without a paid module',()=>{
  sidebar(true);const panel=openSystemSettings();
  expect(within(panel).getByRole('link',{name:messages.nav.identityEmail})).toHaveAttribute('href','/admin/settings/email');
 });
 it('keeps the enrolled installation operator navigation limited to Email delivery',()=>{
  sidebar(false,true);const panel=openSystemSettings();
  expect(within(panel).getAllByRole('link').map(a=>a.getAttribute('href'))).toEqual(['/admin/settings/email']);
 });
 it('does not offer system setup to an ordinary employee',()=>{
  sidebar(false);expect(screen.queryByRole('button',{name:messages.nav.systemConfiguration})).toBeNull();expect(screen.queryByRole('link',{name:messages.nav.identityEmail})).toBeNull();
 });
 it('does not advertise SMTP preview to a partner who only has the broader administration rail',()=>{
  sidebar(true,false,false);
  const panel=openSystemSettings();
  expect(within(panel).queryByRole('link',{name:messages.nav.identityEmail})).toBeNull();
 });
 it.each(['hr_admin','super_admin'])('allows %s to edit temporary connection fields without reading or saving live settings',async role=>{
  m.session.mockResolvedValue({s:{userId:'admin',roles:[role]}});
  await page({success:'apply'});expect(screen.getByText(messages.identityEmail.demoSetup)).toBeInTheDocument();
  for(const label of ['host','port','security','authentication','from','fromName','username','password','replyTo'] as const)expect(screen.getByLabelText(messages.identityEmail[label])).toBeEnabled();
  expect(screen.getByLabelText(messages.identityEmail.port)).toHaveValue(465);expect(screen.getByLabelText(messages.identityEmail.password)).toHaveValue('');
  expect(m.read).not.toHaveBeenCalled();expect(m.guard).not.toHaveBeenCalled();expect(document.querySelector('input[name=revision]')).toBeNull();
  expect(screen.getByRole('button',{name:messages.identityEmail.testConnection})).toBeEnabled();expect(screen.queryByRole('button',{name:messages.identityEmail.saveDraft})).toBeNull();expect(screen.queryByText(messages.identityEmail.success.apply)).toBeNull();expect(screen.queryByDisplayValue('live.smtp.example.test')).toBeNull();
 });
 it('keeps passwords out of native submission URLs before JavaScript handles the form',async()=>{
  await page();const form=screen.getByLabelText(messages.identityEmail.password).closest('form')!;
  expect(form).toHaveAttribute('method','post');
 });
 it('tests the edited values, freezes the request and clears only the password, then invalidates success on edits',async()=>{
  let finish!:(result:any)=>void;m.test.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));await page();
  const field=(key:string)=>screen.getByLabelText((messages.identityEmail as any)[key]) as HTMLInputElement;
  fireEvent.change(field('host'),{target:{value:'smtp.synthetic.example'}});fireEvent.change(field('username'),{target:{value:'synthetic-user'}});fireEvent.change(field('password'),{target:{value:'synthetic-secret'}});
  fireEvent.submit(field('host').closest('form')!);await waitFor(()=>expect(m.test).toHaveBeenCalledOnce());
  expect(field('host')).toBeDisabled();expect(screen.getByRole('button',{name:messages.identityEmail.testingConnection})).toBeDisabled();
  const data=m.test.mock.calls[0][0] as FormData;expect(data.get('host')).toBe('smtp.synthetic.example');expect(data.get('password')).toBe('synthetic-secret');
  finish({status:'success',authenticated:true});await waitFor(()=>expect(screen.getByText(messages.identityEmail.demoAuthenticated)).toBeVisible());
  expect(field('host')).toHaveValue('smtp.synthetic.example');expect(field('password')).toHaveValue('');expect(data.has('password')).toBe(false);
  fireEvent.change(field('host'),{target:{value:'different.example'}});expect(screen.queryByText(messages.identityEmail.demoAuthenticated)).toBeNull();
 });
 it('matches STARTTLS to port 587 and retains non-secret values after a failed test',async()=>{
  m.test.mockResolvedValue({status:'error',code:'authenticationFailed'});await page();
  const host=screen.getByLabelText(messages.identityEmail.host),password=screen.getByLabelText(messages.identityEmail.password);
  fireEvent.change(screen.getByLabelText(messages.identityEmail.security),{target:{value:'starttls'}});expect(screen.getByLabelText(messages.identityEmail.port)).toHaveValue(587);
  fireEvent.change(host,{target:{value:'smtp.synthetic.example'}});fireEvent.change(password,{target:{value:'synthetic-secret'}});fireEvent.submit(host.closest('form')!);
  await waitFor(()=>expect(screen.getByText(messages.identityEmail.demoErrors.authenticationFailed)).toBeVisible());expect(host).toHaveValue('smtp.synthetic.example');expect(password).toHaveValue('');// The label is "Testing connection…" until the pending state clears, which can land a tick AFTER the
  // error renders; under load that gap is real (failed 2 of 3 full gates on 2026-10-20). Wait for it.
  expect(await screen.findByRole('button',{name:messages.identityEmail.testConnection})).toBeEnabled();
 });
 it('explains enrollment to a real HR administrator without loading the installation relay',async()=>{
  m.demo.mockReturnValue(false);await page();expect(screen.getByText(messages.identityEmail.restrictedSetup)).toBeInTheDocument();expect(m.read).not.toHaveBeenCalled();expect(screen.getByLabelText(messages.identityEmail.host)).toBeDisabled();expect(screen.queryByRole('button',{name:messages.identityEmail.testConnection})).toBeNull();
 });
 it('refuses a direct preview URL for an ordinary employee before reading settings',async()=>{
  m.session.mockResolvedValue({s:{userId:'employee',roles:['employee']}});await expect(page()).rejects.toThrow('REDIRECT /');expect(m.read).not.toHaveBeenCalled();
 });
 it('preserves the live form for a verified installation operator without an HR role',async()=>{
  m.session.mockResolvedValue({s:{userId:'operator',roles:['employee']}});m.allowed.mockResolvedValue(true);await page();
  expect(m.guard).toHaveBeenCalled();expect(m.read).toHaveBeenCalledWith({subject:'verified'},undefined);expect(screen.getByLabelText(messages.identityEmail.host)).toHaveValue('live.smtp.example.test');
  expect(screen.getByLabelText(messages.identityEmail.host)).not.toBeDisabled();expect(screen.getByLabelText(messages.identityEmail.password)).toHaveValue('');expect(screen.getByRole('button',{name:messages.identityEmail.saveDraft})).toBeInTheDocument();
  expect(m.accounts).toHaveBeenLastCalledWith({userId:'operator'},{subject:'verified'},{});
  expect(m.project).toHaveBeenLastCalledWith({userId:'operator'},{subject:'verified'},[]);
 });
 it('keeps account retry feedback and the scoped invitation log alongside the temporary SMTP form',async()=>{
  const items=[{id:'held-invitation'}];m.accounts.mockResolvedValue({items,hasMore:false,nextCursor:undefined});
  await page({accountRetry:'1',success:'apply'});
  expect(screen.getByText(messages.accountEmail.retryProcessed)).toBeVisible();
  expect(screen.getByRole('button',{name:messages.identityEmail.testConnection})).toBeEnabled();
  expect(screen.queryByText(messages.identityEmail.success.apply)).toBeNull();
  expect(m.accounts).toHaveBeenCalledExactlyOnceWith({userId:'admin',roles:['hr_admin']},undefined,{});
  expect(m.log).toHaveBeenCalledWith(expect.objectContaining({items,returnTo:'/admin/settings/email'}),undefined);
  expect(m.guard).not.toHaveBeenCalled();expect(m.read).not.toHaveBeenCalled();
 });
 it('shows account retry failure without presenting SMTP activation or hiding its form',async()=>{
  await page({error:'account-retry'});
  expect(screen.getByText(messages.accountEmail.retryError)).toBeVisible();
  expect(screen.getByLabelText(messages.identityEmail.host)).toBeEnabled();
 });
 it('shows a real service failure without presenting the preview as live settings',async()=>{
  m.allowed.mockResolvedValue(true);m.read.mockRejectedValue(new EmailSettingsError('unavailable'));await page();expect(screen.getByText(messages.identityEmail.errors.unavailable)).toBeInTheDocument();expect(screen.queryByLabelText(messages.identityEmail.host)).toBeNull();
 });
});
it('shows confirmed profile addresses and keeps installation-default activation as the explicit default',async()=>{
 m.allowed.mockResolvedValue(true);const config={...defaultEmailConfig,host:'smtp.fixture.test',from:'default@fixture.test'};
 m.read.mockResolvedValue({supportsLifecycleSenders:true,lifecycleSenders:[{profile:'hr',from:'confirmed-hr@fixture.test',connectionId:'fixture',appliedAt:'2026-10-29T00:00:00Z',hasUnappliedChanges:true},{profile:'onboarding',from:config.from,hasUnappliedChanges:false},{profile:'noreply',from:config.from,hasUnappliedChanges:false}],active:config,connections:[],selectedConnectionId:'fixture',selectedConnectionName:'Fictional sender',draft:{id:'version',config,hasPassword:false,testedAt:'2026-10-29T00:00:00Z'},revision:'revision',testRecipient:'operator@fixture.test'});
 await page({connection:'fixture',success:'sender'});
 expect(screen.getByText(messages.identityEmail.lifecycleSenderTitle)).toBeVisible();expect(screen.getByText(/confirmed-hr@fixture.test/)).toBeVisible();expect(screen.getByText(messages.identityEmail.senderPending)).toBeVisible();
 const target=screen.getByLabelText(messages.identityEmail.applyTarget);expect(target).toHaveValue('');expect(within(target).getAllByRole('option').map(option=>option.getAttribute('value'))).toEqual(['','onboarding','hr','noreply']);fireEvent.change(target,{target:{value:'hr'}});expect(target).toHaveValue('hr');
 expect(screen.getByLabelText(messages.identityEmail.received)).toBeRequired();expect(screen.getByText(messages.identityEmail.success.sender)).toBeVisible();expect(screen.queryByText(messages.identityEmail.success.apply)).not.toBeInTheDocument();
});
