import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
const m=vi.hoisted(()=>({session:vi.fn(),allowed:vi.fn(),guard:vi.fn(),read:vi.fn(),demo:vi.fn()}));
vi.mock('next/navigation',()=>({usePathname:()=>'/admin/settings/email',useSearchParams:()=>new URLSearchParams(),redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key.split('.').reduce((v:any,k)=>v?.[k],messages.identityEmail)??key)}));
vi.mock('../lib/scope',()=>({scopedSession:m.session}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../lib/demo-mode',()=>({demoSwitcherEnabled:m.demo}));
vi.mock('../lib/identity/email-settings',()=>({canConfigureIdentityEmail:m.allowed,requireIdentityEmailAdmin:m.guard,readIdentityEmailSettings:m.read}));
vi.mock('../app/admin/settings/email/actions',()=>({saveEmailDraft:vi.fn(),testEmailDraft:vi.fn(),activateEmailDraft:vi.fn()}));
import Page from '../app/admin/settings/email/page';
import { Sidebar } from '../components/sidebar';
import { defaultEmailConfig, EmailSettingsError } from '../lib/identity/email-model';
const wrap=(node:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
const page=async(query={})=>wrap(await Page({searchParams:Promise.resolve(query)}));
const sidebar=(admin:boolean,operator=false,preview=admin)=>wrap(<Sidebar isAdmin={admin} canApprove={false} canPreviewIdentityEmail={preview} canConfigureIdentityEmail={operator} enabledModules={[]} defaultCollapsed={false}/>);
beforeEach(()=>{
 cleanup();vi.clearAllMocks();m.session.mockResolvedValue({s:{userId:'admin',roles:['hr_admin']}});m.allowed.mockResolvedValue(false);m.demo.mockReturnValue(true);m.guard.mockResolvedValue({actor:{subject:'verified'}});
 m.read.mockResolvedValue({active:{...defaultEmailConfig,host:'live.smtp.example.test',from:'live@example.test',hasPassword:true},draft:null,revision:'a'.repeat(64),testRecipient:'owner@example.test'});
});
describe('SMTP settings discovery and read-only preview',()=>{
 it('lets a demo administrator find Email delivery under System Settings without a paid module',()=>{
  sidebar(true);fireEvent.click(screen.getByRole('button',{name:messages.nav.systemSettings}));
  expect(within(screen.getByRole('navigation',{name:messages.nav.systemSettings})).getByRole('link',{name:messages.nav.identityEmail})).toHaveAttribute('href','/admin/settings/email');
 });
 it('keeps the enrolled installation operator navigation limited to Email delivery',()=>{
  sidebar(false,true);fireEvent.click(screen.getByRole('button',{name:messages.nav.systemSettings}));
  expect(within(screen.getByRole('navigation',{name:messages.nav.systemSettings})).getAllByRole('link').map(a=>a.getAttribute('href'))).toEqual(['/admin/settings/email']);
 });
 it('does not offer system setup to an ordinary employee',()=>{
  sidebar(false);expect(screen.queryByRole('button',{name:messages.nav.systemSettings})).toBeNull();expect(screen.queryByRole('link',{name:messages.nav.identityEmail})).toBeNull();
 });
 it('does not advertise SMTP preview to a partner who only has the broader administration rail',()=>{
  sidebar(true,false,false);const admin=screen.getByRole('button',{name:messages.nav.admin});
  if(admin.getAttribute('aria-expanded')==='false')fireEvent.click(admin);
  fireEvent.click(screen.getByRole('button',{name:messages.nav.systemSettings}));
  expect(within(screen.getByRole('navigation',{name:messages.nav.systemSettings})).queryByRole('link',{name:messages.nav.identityEmail})).toBeNull();
 });
 it.each(['hr_admin','super_admin'])('renders the connection fields for %s without reading live settings or exposing a mail action in the demo',async role=>{
  m.session.mockResolvedValue({s:{userId:'admin',roles:[role]}});
  await page({success:'apply'});expect(screen.getByText(messages.identityEmail.demoSetup)).toBeInTheDocument();
  for(const label of ['host','port','security','authentication','from','fromName','username','password','replyTo'] as const)expect(screen.getByLabelText(messages.identityEmail[label])).toBeDisabled();
  expect(screen.getByLabelText(messages.identityEmail.port)).toHaveValue(465);expect(screen.getByLabelText(messages.identityEmail.password)).toHaveValue('');
  expect(m.read).not.toHaveBeenCalled();expect(m.guard).not.toHaveBeenCalled();expect(document.querySelector('input[name=revision]')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();expect(screen.queryByText(messages.identityEmail.success.apply)).toBeNull();expect(screen.queryByDisplayValue('live.smtp.example.test')).toBeNull();
 });
 it('explains enrollment to a real HR administrator without loading the installation relay',async()=>{
  m.demo.mockReturnValue(false);await page();expect(screen.getByText(messages.identityEmail.restrictedSetup)).toBeInTheDocument();expect(m.read).not.toHaveBeenCalled();
 });
 it('refuses a direct preview URL for an ordinary employee before reading settings',async()=>{
  m.session.mockResolvedValue({s:{userId:'employee',roles:['employee']}});await expect(page()).rejects.toThrow('REDIRECT /');expect(m.read).not.toHaveBeenCalled();
 });
 it('preserves the live form for a verified installation operator without an HR role',async()=>{
  m.session.mockResolvedValue({s:{userId:'operator',roles:['employee']}});m.allowed.mockResolvedValue(true);await page();
  expect(m.guard).toHaveBeenCalled();expect(m.read).toHaveBeenCalledWith({subject:'verified'});expect(screen.getByLabelText(messages.identityEmail.host)).toHaveValue('live.smtp.example.test');
  expect(screen.getByLabelText(messages.identityEmail.host)).not.toBeDisabled();expect(screen.getByLabelText(messages.identityEmail.password)).toHaveValue('');expect(screen.getByRole('button',{name:messages.identityEmail.saveDraft})).toBeInTheDocument();
 });
 it('shows a real service failure without presenting the preview as live settings',async()=>{
  m.allowed.mockResolvedValue(true);m.read.mockRejectedValue(new EmailSettingsError('unavailable'));await page();expect(screen.getByText(messages.identityEmail.errors.unavailable)).toBeInTheDocument();expect(screen.queryByLabelText(messages.identityEmail.host)).toBeNull();
 });
});
