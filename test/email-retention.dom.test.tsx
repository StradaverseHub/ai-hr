import React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vietnamese from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
vi.mock('../app/(app)/admin/settings/email/actions',()=>({saveEmailRetention:vi.fn()}));
import {EmailRetentionForm} from '../app/(app)/admin/settings/email/retention-form';
const show=(days:number|null=null)=>render(<NextIntlClientProvider locale="en" messages={messages}><EmailRetentionForm policy={{days,revision:2,lastRunAt:null,lastDeleted:0}}/></NextIntlClientProvider>);
afterEach(cleanup);
describe('delivery history retention controls',()=>{
 it('keeps deletion disabled by default and requires acknowledgement when a finite period is selected',()=>{
  show();const m=messages.accountEmail;expect(screen.getByLabelText(m.retentionPeriod)).toHaveValue('never');expect(screen.queryByRole('checkbox')).toBeNull();expect(screen.queryByRole('spinbutton')).toBeNull();
  fireEvent.change(screen.getByLabelText(m.retentionPeriod),{target:{value:'days'}});
  expect(screen.getByLabelText(m.retentionDays)).toHaveValue(90);expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('checkbox')).toBeRequired();
  expect(screen.getByRole('spinbutton')).toHaveAttribute('min','1');expect(screen.getByRole('spinbutton')).toHaveAttribute('max','3650');
  fireEvent.change(screen.getByLabelText(m.retentionPeriod),{target:{value:'never'}});expect(screen.queryByRole('checkbox')).toBeNull();
 });
 it.each([['en',messages],['ms',ms],['zh',zh],['vi',vietnamese],['th',th],['ta',ta]] as const)('shows the saved period and permanent deletion scope in %s',(locale,catalogue)=>{
  render(<NextIntlClientProvider locale={locale} messages={catalogue}><EmailRetentionForm policy={{days:30,revision:7,lastRunAt:null,lastDeleted:0}}/></NextIntlClientProvider>);
  expect(screen.getByLabelText(catalogue.accountEmail.retentionDays)).toHaveValue(30);expect(screen.getByText(catalogue.accountEmail.retentionHelp)).toBeVisible();expect(screen.getByRole('checkbox',{name:catalogue.accountEmail.retentionAcknowledge})).not.toBeChecked();
 });
});
