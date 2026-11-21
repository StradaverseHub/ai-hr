/**
 * 792053e5 — the reprocess outcome says which Pay Item an updated formula re-priced (count, hours, old and new
 * amounts), and a formula that could not price a transaction is a named Configuration incomplete outcome with the
 * Pay Item, dates, reason, links and the previous-result notice. Pure: recorded outcome shapes are decoded and
 * rendered in every locale; nothing is recalculated. Fictional data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => state.locale,
  getTranslations: async (namespace: string) => createTranslator({ locale: state.locale, namespace,
    messages: JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${state.locale}.json`), 'utf8')) }),
}));
import { decodeReprocessEmployeeOutcomes, type ReprocessEmployeeOutcome } from '../core/payroll';
import { ReprocessOutcomePanel, ReprocessOutcomeRemarks, ReprocessOutcomeStatus } from '../app/payroll/[batchId]/reprocess/outcomes';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'];
const run = { companyId: '22222222-2222-4222-8222-222222222222', payPeriod: '2026-10', runType: 'regular' };
const emp = '33333333-3333-4333-8333-333333333333', emp2 = '66666666-6666-4666-8666-666666666666';
const slipId = '44444444-4444-4444-8444-444444444444', slip2 = '88888888-8888-4888-8888-888888888888';
const historyId = '77777777-7777-4777-8777-777777777777', jobId = '55555555-5555-4555-8555-555555555555';
const componentId = '99999999-9999-4999-8999-999999999999';
const repriced: ReprocessEmployeeOutcome = {
  employmentId: emp, name: 'Daniel Wong', employeeCode: 'HT-1042', status: 'reprocessed', reasonCode: null, resultRetained: false,
  payslipId: slipId, versionBefore: 1, versionAfter: 2, historyId, at: '2026-11-11T01:18:00.000Z', classification: 'recalculated',
  repricedItems: [{ componentId, code: 'OT15', name: 'Overtime 1.5x', count: 3, quantity: 6, unit: 'hours', before: 97.5, after: 112.5 }],
};
const failed: ReprocessEmployeeOutcome = {
  employmentId: emp2, name: 'Mei Ling Tan', employeeCode: 'HT-1071', status: 'validation_failed', reasonCode: 'PAY_ITEM_FORMULA_FAILED',
  validationCode: 'pay_item_formula_failed', resultRetained: true, payslipId: slip2, versionBefore: 1, versionAfter: 1, historyId: null,
  at: '2026-11-11T01:18:00.000Z',
  formulaFailure: { componentId, code: 'NSA', name: 'Night Shift Allowance', dates: ['2026-10-14', '2026-10-21'], reason: 'zero_divisor', detail: null },
};

async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ReprocessOutcomeStatus || node.type === ReprocessOutcomeRemarks)
    return resolve(await (node.type as (props: unknown) => Promise<ReactNode>)(node.props));
  return cloneElement(node, {}, await resolve(node.props.children));
}
const html = async (outcomes: ReprocessEmployeeOutcome[]) => renderToStaticMarkup(await resolve(await ReprocessOutcomePanel({
  outcomes, history: [], slips: [{ id: slipId, employmentId: emp, version: 2 }, { id: slip2, employmentId: emp2, version: 1 }], run, currency: 'MYR',
  batchId: run.companyId, jobId, selected: outcomes.length, stopped: false,
})));

describe('792053e5 reprocess outcome remarks for updated Pay Item formulas', () => {
  it('decodes both shapes and refuses inconsistent ones', () => {
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [repriced, failed] }, [emp, emp2])).toHaveLength(2);
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...failed, formulaFailure: undefined }] }, [emp2])).toBeNull();
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...repriced, formulaFailure: failed.formulaFailure }] }, [emp])).toBeNull();
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...failed, repricedItems: repriced.repricedItems }] }, [emp2])).toBeNull();
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...repriced, repricedItems: [{ ...repriced.repricedItems![0], after: Number.NaN }] }] }, [emp])).toBeNull();
  });

  it('renders the re-priced item, the named failure, its links and the previous-result notice (English)', async () => {
    state.locale = 'en';
    const out = await html([repriced, failed]);
    expect(out).toContain('Overtime 1.5x, recalculated with the updated formula');
    expect(out).toMatch(/3 transactions, 6\.00 hours: MYR\s?97\.50 → MYR\s?112\.50/);
    expect(out).toContain('Night Shift Allowance (NSA): the updated formula could not calculate 2 transactions (');
    expect(out).toContain('The formula divides by zero for these inputs.');
    expect(out).toContain('Previous payroll result retained; the figures shown are from that saved result.');
    expect(out).toContain('href="/admin/pay-components/NSA"');
    expect(out).toContain('href="/payroll/transactions/individual"');
    expect(out).toContain('Configuration incomplete');
    expect(out).toContain('role="alert"');
  });

  it('every locale has every new message (no raw keys rendered)', async () => {
    for (const locale of LOCALES) {
      state.locale = locale;
      const out = await html([repriced, { ...failed, formulaFailure: { ...failed.formulaFailure!, reason: 'input_missing' } }]);
      expect(out, locale).not.toMatch(/reprocessPayItem|reprocessOpen|payroll\.batch\./);
      expect(out, locale).toContain('Overtime 1.5x');
      expect(out, locale).toContain('NSA');
    }
  });
});
