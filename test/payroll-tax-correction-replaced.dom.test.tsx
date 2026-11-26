/**
 * 289634a6 — when a payroll calculation used a newer payroll history import for an earlier month whose saved Income
 * Tax Correction it superseded, the screens SAY so: the reprocess outcome remark names the month instead of the generic
 * "The previous Income Tax Correction was retained.", and Transaction View → History notes it under the PCB figure.
 * Fictional outcome and payslip shapes (the database test test/payroll-history-noncash-correction.test.ts proves the
 * kernel writes them); nothing is recalculated here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => state.locale,
  getTranslations: async (namespace: string) => createTranslator({ locale: state.locale, namespace,
    messages: JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${state.locale}.json`), 'utf8')) }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/payroll/transaction-view',
}));
import { decodeReprocessEmployeeOutcomes, type ReprocessEmployeeOutcome } from '../core/payroll';
import { ReprocessOutcomeRemarks } from '../app/payroll/[batchId]/reprocess/outcomes';
import { HistoryTable } from '../app/payroll/transaction-view/history-table';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalogue = (locale: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${locale}.json`), 'utf8'));
const emp = '33333333-3333-4333-8333-333333333333';
const slipId = '44444444-4444-4444-8444-444444444444';
const historyId = '77777777-7777-4777-8777-777777777777';
const REPLACED_AT = '2026-11-20T03:15:00.000Z'; // 20 Nov 2026 in Kuala Lumpur
const replacedOutcome: ReprocessEmployeeOutcome = {
  employmentId: emp, name: 'Fictional Aina', employeeCode: '0007', status: 'reprocessed', reasonCode: null, classification: 'recalculated',
  resultRetained: false, payslipId: slipId, versionBefore: 1, versionAfter: 2, historyId, at: '2026-11-26T10:00:00.000Z',
  taxCorrectionsReplaced: [{ period: '2026-01', replacedAt: REPLACED_AT }],
};
const plainOutcome: ReprocessEmployeeOutcome = { ...replacedOutcome, taxCorrectionsReplaced: undefined, taxBasisRecalculated: true };

async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ReprocessOutcomeRemarks) return resolve(await (node.type as (props: unknown) => Promise<ReactNode>)(node.props));
  return cloneElement(node, {}, await resolve(node.props.children));
}
const remark = async (outcome: ReprocessEmployeeOutcome) =>
  renderToStaticMarkup(await resolve(<ReprocessOutcomeRemarks outcome={outcome} batchId="22222222-2222-4222-8222-222222222222" />));

describe('289634a6 — reprocess outcome remark', () => {
  it('decodes the superseded months only on a recalculated outcome', () => {
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [replacedOutcome] }, [emp])).toHaveLength(1);
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...replacedOutcome, taxCorrectionsReplaced: [{ period: 'January', replacedAt: null }] }] }, [emp])).toBeNull();
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...replacedOutcome, taxCorrectionsReplaced: [] }] }, [emp])).toBeNull();
  });

  it('says the correction was replaced by the newer import, not that it was retained (en)', async () => {
    state.locale = 'en';
    const out = await remark(replacedOutcome);
    expect(out).toContain('The Income Tax Correction for 2026-01 was replaced by the newer payroll history import; the imported amounts were used.');
    expect(out).not.toContain('was retained');
    // A genuine retained/replayed correction keeps the generic sentence.
    expect(await remark(plainOutcome)).toContain(catalogue('en').payroll.batch.reprocessTaxBasisUpdated);
  });

  it.each(LOCALES)('renders the replaced remark from the %s catalogue', async (locale) => {
    state.locale = locale;
    const words = catalogue(locale).payroll.batch.reprocessTaxCorrectionReplacedByImport.replace('{periods}', '2026-01');
    const out = await remark(replacedOutcome);
    expect(out).not.toContain('MISSING_MESSAGE');
    expect(out).toContain(words.replaceAll('&', '&amp;'));
  });
});

const febSlip: ProcessedPayslipViewRow = {
  id: slipId, employmentId: '00000000-0000-0000-0000-0000000000e1', employeeName: 'Fictional Aina', employeeCode: '0007',
  companyId: '00000000-0000-0000-0000-0000000000c1', company: 'Fictional Sdn Bhd', payPeriod: '2026-02', runType: 'regular', runSeq: 1,
  batchStatus: 'processed', releasedAt: null, version: 2, basic: '5000.00', allowance: '0.00', overtime: '0.00', bonus: '0.00', gross: '5000.00',
  statutory: {
    epfEmployee: 550, socsoEmployee: 0, eisEmployee: 0, pcb: 312.5, epfEmployer: 650, socsoEmployer: 0, eisEmployer: 0, hrdf: 0, socsoSkbbk: 0, lp: 0, zakat: 0,
    taxBasisSupersededCorrections: [{ id: '88888888-8888-4888-8888-888888888888', period: '2026-01', replacedAt: REPLACED_AT }],
  },
  otherDeductions: '0.00', totalDeductions: '862.50', net: '4137.50',
};
const wrap = (node: React.ReactNode, locale: string = 'en') =>
  render(<NextIntlClientProvider locale={locale} messages={catalogue(locale)}>{node}</NextIntlClientProvider>);

describe('289634a6 — Transaction View → History note under PCB', () => {
  it('notes the replaced correction under the PCB figure, with the import date, and names the outcome', async () => {
    wrap(<HistoryTable rows={[febSlip]} hrdfRegisteredCompanyIds={[]} processingOutcomes={{ [slipId]: replacedOutcome }} />);
    // The run remark column names the superseded month instead of a generic success line.
    expect(screen.getByText('The Income Tax Correction for 2026-01 was replaced by the newer payroll history import; the imported amounts were used.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show/i }));
    const note = screen.getByText('Income Tax Correction for 2026-01 replaced by payroll history import on 20 Nov 2026');
    expect(note).toHaveAttribute('data-tax-correction-replaced', '2026-01');
    // It sits directly under the PCB row (the row whose figure links to this payslip's PCB calculation).
    expect(note.previousElementSibling?.querySelector('a[href*="pcb-detail"]')).not.toBeNull();
    expect(within(note.previousElementSibling as HTMLElement).getByText(catalogue('en').me.payslip.pcb)).toBeInTheDocument();
  });

  it('says nothing on an ordinary payslip, and omits the date when none was recorded', async () => {
    const { unmount } = wrap(<HistoryTable rows={[{ ...febSlip, statutory: { ...(febSlip.statutory as Record<string, unknown>), taxBasisSupersededCorrections: undefined } }]} hrdfRegisteredCompanyIds={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.queryByText(/replaced by payroll history import/)).toBeNull();
    unmount();
    wrap(<HistoryTable rows={[{ ...febSlip, statutory: { ...(febSlip.statutory as Record<string, unknown>), taxBasisSupersededCorrections: [{ period: '2026-01', replacedAt: null }] } }]} hrdfRegisteredCompanyIds={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.getByText('Income Tax Correction for 2026-01 replaced by payroll history import')).toBeInTheDocument();
  });

  it.each(LOCALES)('renders the note from the %s catalogue, never a raw key', async (locale) => {
    const t = catalogue(locale).payroll.transactions.view.history;
    wrap(<HistoryTable rows={[febSlip]} hrdfRegisteredCompanyIds={[]} />, locale);
    await userEvent.click(screen.getByRole('button', { name: t.showBreakdown }));
    const note = document.querySelector('[data-tax-correction-replaced="2026-01"]');
    expect(note?.textContent).toBe(t.taxCorrectionReplacedOn.replace('{period}', '2026-01').replace('{date}', '20 Nov 2026'));
    expect(screen.queryByText(/view\.history\./)).toBeNull();
  });
});
