/**
 * Board d9ded29c — Recalculate Income Tax Value preview: the month's taxable income, the year-to-date figure and the
 * employee totals say how much is benefits in kind, and each Pay Item shows its taxable and exempt parts side by side.
 * The service calculates every figure; this surface only formats them. Fictional values from the reporter's January.
 */
import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import {TaxBasisResults} from '../app/payroll/income-tax-recalculation/results';
import type {TaxBasisEmployee, TaxBasisMonth} from '../lib/payroll-tax-basis';

const catalogs = {en, ms, zh, ta, th, vi};
const items = [
  {code: 'BKCAR', name: 'BENEFIT-IN-KIND CAR', amount: 2083.33, previousTreatment: 'Non-cash BIK · Taxable', latestTreatment: 'Non-cash BIK · Taxable', taxable: 2083.33, exempt: 0},
  {code: 'BKDRV', name: 'BENEFIT-IN-KIND DRIVER', amount: 600, previousTreatment: 'Non-cash BIK · Taxable', latestTreatment: 'Non-cash BIK · Taxable', taxable: 600, exempt: 0},
  {code: 'BASIC', name: 'Basic salary', amount: 90000, previousTreatment: 'Taxable · normal', latestTreatment: 'Taxable · normal', taxable: 90000, exempt: 0},
];
const month: TaxBasisMonth = {payslipId: 'fictional-jan', period: '2026-01', sourceHash: 'fictional', beforeTaxable: 92683.33, taxable: 92683.33, difference: 0,
  beforeExempt: 0, exempt: 0, ytdTaxable: 92683.33, ytdExempt: 0, benefits: 2683.33, beforeBenefits: 2683.33, ytdBenefits: 2683.33, items,
  basis: {version: 1, pcb: 90000, exemptionUsed: {}, items, rulesHash: 'fictional'}};
const employee: TaxBasisEmployee = {id: 'fictional-bd', employeeNo: 'F0098', name: 'Sample employee', status: 'unchanged', reason: null, recordCount: 1,
  beforeTaxable: 92683.33, taxable: 92683.33, difference: 0, beforeExempt: 0, exempt: 0, benefits: 2683.33, beforeBenefits: 2683.33, months: [month]};
const cashOnly: TaxBasisEmployee = {...employee, id: 'fictional-cash', employeeNo: 'F0099', benefits: 0, beforeBenefits: 0,
  months: [{...month, payslipId: 'fictional-cash-jan', beforeTaxable: 90000, taxable: 90000, ytdTaxable: 90000, benefits: 0, beforeBenefits: 0, ytdBenefits: 0, items: [items[2]]}]};
afterEach(cleanup);
const show = (locale: keyof typeof catalogs, list = [employee]) =>
  render(<NextIntlClientProvider locale={locale} messages={catalogs[locale]}><TaxBasisResults employees={list}/></NextIntlClientProvider>);
const fill = (template: string, amount: RegExp) => new RegExp(template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{amount\\}', amount.source));

describe('benefit split on the recalculation preview', () => {
  it('shows the cash and benefit split under the month, year-to-date and totals, and no negative difference', () => {
    show('en');
    const details = screen.getByText(/F0098 · Sample employee/).closest('details')!;
    fireEvent.click(details.querySelector('summary')!);
    const table = within(details).getByRole('table', {name: en.payrollTaxBasis.monthlyValues});
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent(fill(en.payrollTaxBasis.cashPaySplit, /MYR\s?90,000\.00/));
    expect(row).toHaveTextContent(fill(en.payrollTaxBasis.benefitsSplit, /MYR\s?2,683\.33/));
    expect(within(row).getAllByText(fill(en.payrollTaxBasis.includesBenefits, /MYR\s?2,683\.33/))).toHaveLength(2); // existing and year-to-date
    expect(row).not.toHaveTextContent(/-\s?MYR|MYR\s?-/);
    const bkcar = within(row).getByText('BKCAR · BENEFIT-IN-KIND CAR').closest('div')!;
    expect(bkcar).toHaveTextContent(en.payrollTaxBasis.noncashPcbWages);
    expect(bkcar).toHaveTextContent(/2,083\.33/);
    expect(bkcar).toHaveTextContent(en.payrollTaxBasis.afterExempt);
    expect(within(details).getAllByText(fill(en.payrollTaxBasis.includesBenefits, /MYR\s?2,683\.33/)).length).toBeGreaterThanOrEqual(3);
  });
  it('adds nothing for an employee without benefits', () => {
    show('en', [cashOnly]);
    const details = screen.getByText(/F0099 · Sample employee/).closest('details')!;
    fireEvent.click(details.querySelector('summary')!);
    expect(details).not.toHaveTextContent(/benefits in kind/);
  });
  it.each(Object.keys(catalogs) as (keyof typeof catalogs)[])('renders the split in %s without a raw key', locale => {
    const {container} = show(locale);
    for (const key of ['includesBenefits', 'cashPaySplit', 'benefitsSplit'] as const) {
      expect(catalogs[locale].payrollTaxBasis[key]).toContain('{amount}');
      expect(container.textContent).not.toContain(`payrollTaxBasis.${key}`);
    }
    expect(container.textContent).toContain(catalogs[locale].payrollTaxBasis.benefitsSplit.split('{amount}')[0].trim() || catalogs[locale].payrollTaxBasis.benefitsSplit.split('{amount}')[1].trim());
  });
});
