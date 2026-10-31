import React from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vi from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import {SavedEmailConnectionFields} from '../app/(app)/admin/settings/email/connection-fields';
import {defaultEmailConfig,type EmailConfig} from '../lib/identity/email-model';
const m=messages.identityEmail;
const config:EmailConfig={...defaultEmailConfig,host:'smtp.example.test',from:'hr@example.test',user:'relay-user'};
const app:EmailConfig={...config,host:'smtp.office365.com',port:587,security:'starttls',user:config.from,authentication:'microsoft365',oauth2:{tenantId:crypto.randomUUID(),clientId:crypto.randomUUID()}};
const show=(value=config,allow=true,hasSecret=true)=>render(<NextIntlClientProvider locale="en" messages={messages}><form><SavedEmailConnectionFields config={value} allowMicrosoft365={allow} hasSecret={hasSecret}/></form></NextIntlClientProvider>);
afterEach(cleanup);
describe('saved Microsoft 365 email settings',()=>{
 it.each([['en',messages],['ms',ms],['zh',zh],['vi',vi],['th',th],['ta',ta]] as const)('renders the saved application fields and setup guidance in %s', (locale,catalogue)=>{
  render(<NextIntlClientProvider locale={locale} messages={catalogue}><form><SavedEmailConnectionFields config={app} allowMicrosoft365 hasSecret/></form></NextIntlClientProvider>);
  for(const key of ['tenantId','clientId','clientSecret'] as const)expect(screen.getByLabelText(catalogue.identityEmail[key])).toBeVisible();
  expect(screen.getByText(catalogue.identityEmail.microsoft365Help)).toBeVisible();expect(screen.getByText(catalogue.identityEmail.clientSecretKept)).toBeVisible();
 });
 it('sets the Microsoft endpoint and mandatory STARTTLS, requires a new client secret and never reuses typed passwords across modes',()=>{
  show();fireEvent.change(screen.getByLabelText(m.password),{target:{value:'fictional-password'}});
  fireEvent.change(screen.getByLabelText(m.authentication),{target:{value:'microsoft365'}});
  expect(screen.getByLabelText(m.host)).toHaveValue('smtp.office365.com');expect(screen.getByLabelText(m.host)).toHaveAttribute('readonly');expect(screen.getByLabelText(m.port)).toHaveValue(587);
  expect(screen.getByLabelText(m.security)).toHaveValue('starttls');expect(screen.getByRole('option',{name:m.tlsSecurity})).toBeDisabled();
  expect(screen.getByLabelText(m.clientSecret)).toHaveValue('');expect(screen.getByLabelText(m.clientSecret)).toBeRequired();expect(screen.getByText(m.clientSecretNeeded)).toBeVisible();
  expect(screen.getByLabelText(m.tenantId)).toBeRequired();expect(screen.getByLabelText(m.clientId)).toBeRequired();
  fireEvent.change(screen.getByLabelText(m.clientSecret),{target:{value:'fictional-secret'}});fireEvent.change(screen.getByLabelText(m.authentication),{target:{value:'true'}});expect(screen.getByLabelText(m.password)).toHaveValue('');
 });
 it('shows only public saved fields and withdraws secret retention when the application or mailbox changes',()=>{
  show(app);expect(screen.getByLabelText(m.clientSecret)).toHaveValue('');expect(screen.getByLabelText(m.clientSecret)).not.toBeRequired();expect(screen.getByText(m.clientSecretKept)).toBeVisible();
  fireEvent.change(screen.getByLabelText(m.clientId),{target:{value:crypto.randomUUID()}});expect(screen.getByText(m.clientSecretNeeded)).toBeVisible();expect(screen.getByLabelText(m.clientSecret)).toBeRequired();
  fireEvent.change(screen.getByLabelText(m.clientId),{target:{value:app.oauth2!.clientId}});expect(screen.getByText(m.clientSecretKept)).toBeVisible();
  fireEvent.change(screen.getByLabelText(m.username),{target:{value:'different@example.test'}});expect(screen.getByLabelText(m.clientSecret)).toBeRequired();
 });
 it('hides the application option for unsupported identity providers and pairs password STARTTLS with port 587',()=>{
  show(config,false);expect(screen.queryByRole('option',{name:m.microsoft365Authentication})).toBeNull();fireEvent.change(screen.getByLabelText(m.security),{target:{value:'starttls'}});expect(screen.getByLabelText(m.port)).toHaveValue(587);
 });
});
