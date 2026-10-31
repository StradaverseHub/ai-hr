import React from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import {PendingMoneyStatus,PendingOvertimeCashAmount,PendingOvertimeCashDetails} from '../app/(app)/payroll/[batchId]/pending-overtime';
import type {PendingOvertimeCashEvidence} from '../packs/payroll/service';
const catalogues={en,ms,zh,ta,th,vi};
afterEach(cleanup);
describe('pending formula cash review cannot claim empty success on a refusal',()=>{
 it.each(Object.entries(catalogues))('shows actionable incomplete review instead of basic-only copy in %s',(locale,messages)=>{
  render(<NextIntlClientProvider locale={locale} messages={messages}><PendingMoneyStatus hasLines={false} review={{status:'unavailable',code:'stale'}}/></NextIntlClientProvider>);
  expect(screen.getByRole('alert')).toHaveTextContent(messages.payroll.batch.pendingMoney.formulaUnavailable);
  expect(screen.getByRole('alert')).toHaveTextContent(messages.overtimePatterns.errors.stale);
  expect(screen.getByRole('link',{name:messages.overtimePatterns.title})).toHaveAttribute('href','/admin/attendance/settings/overtime-patterns');
  expect(screen.queryByText(messages.payroll.batch.pendingMoney.empty)).toBeNull();
 });
 it('shows recorded-contribution semantics for formula lines and preserves the genuinely empty state',()=>{
  const {rerender}=render(<NextIntlClientProvider locale="en" messages={en}><PendingMoneyStatus hasLines={true} review={{status:'available',lineCount:1}}/></NextIntlClientProvider>);
  expect(screen.getByText(en.payroll.batch.pendingMoney.formulaRecordedHint)).toBeVisible();expect(screen.queryByText(en.payroll.batch.pendingMoney.empty)).toBeNull();
  rerender(<NextIntlClientProvider locale="en" messages={en}><PendingMoneyStatus hasLines={false} review={{status:'available',lineCount:0}}/></NextIntlClientProvider>);
  expect(screen.getByText(en.payroll.batch.pendingMoney.empty)).toBeVisible();expect(screen.queryByRole('alert')).toBeNull();
 });
 it('retains exact immutable IDs and decimal money instead of presenting a final payslip computation',()=>{
  const evidence:PendingOvertimeCashEvidence={sourceId:'source-exact',calculationId:'calculation-exact',sourceRevision:7,settlementId:'settlement-exact',lineId:'line-exact',earningItemId:'item-exact',date:'2026-10-15',currency:'MYR',minorScale:2,amountMinorUnits:'9150'};
  render(<NextIntlClientProvider locale="en" messages={en}><PendingOvertimeCashAmount evidence={evidence}/><PendingOvertimeCashDetails evidence={evidence}/></NextIntlClientProvider>);
  expect(screen.getByText('MYR 91.50')).toBeVisible();expect(screen.getByText(en.overtimePatterns.recordedCalculation+' · 2026-10-15')).toBeVisible();
  for(const id of [evidence.sourceId,evidence.settlementId,evidence.lineId,evidence.earningItemId])expect(screen.getByText(id)).toBeInTheDocument();
  expect(screen.getByText(en.overtimePatterns.calculationReference.replace('{id}',evidence.calculationId).replace('{revision}','7'))).toBeInTheDocument();
 });
});
