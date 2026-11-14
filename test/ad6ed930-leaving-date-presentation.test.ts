/**
 * ad6ed930 — how a transaction dated after the employee's last day is TOLD, everywhere it is told.
 *
 *   • The reprocess outcome remark names the leaving date and the way forward ("This employee left on 29 Oct 2026.
 *     Choose an effective date on or before that day.") instead of the Pay Items hint, and does not link to the Pay
 *     Item. A genuine formula failure keeps its existing remark and link (restated, unchanged).
 *   • The whole-run processing message (PayItemFormulaRepriceError) says the same, without "Correct the formula".
 *   • Every new message exists in all six locales with its placeholders (non-English copy awaits native review).
 *   • payrollLeavingDate mirrors payrollEmploymentEnd's least() over the three columns, NULLs ignored.
 * Pure: recorded outcome shapes are decoded and rendered; nothing is recalculated. Fictional data.
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
import { ReprocessOutcomeRemarks } from '../app/payroll/[batchId]/reprocess/outcomes';
import { PayItemFormulaRepriceError } from '../packs/payroll/individual-calculation';
import { payrollLeavingDate } from '../lib/payroll-leaving-date';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const emp = '33333333-3333-4333-8333-333333333333', slipId = '44444444-4444-4444-8444-444444444444';
const componentId = '99999999-9999-4999-8999-999999999999';
const afterLeaving: ReprocessEmployeeOutcome = {
  employmentId: emp, name: 'Fictional Leaver', employeeCode: 'ZX-0001', status: 'validation_failed', reasonCode: 'PAY_ITEM_FORMULA_FAILED',
  validationCode: 'pay_item_formula_failed', resultRetained: true, payslipId: slipId, versionBefore: 1, versionAfter: 1, historyId: null,
  at: '2026-11-13T01:18:00.000Z',
  formulaFailure: { componentId, code: 'ONOR', name: 'NORMAL OT', dates: ['2026-10-31'], reason: 'after_leaving_date', detail: null, leftOn: '2026-10-29' },
};
const formulaFault: ReprocessEmployeeOutcome = {
  ...afterLeaving,
  formulaFailure: { componentId, code: 'ONOR', name: 'NORMAL OT', dates: ['2026-10-14'], reason: 'formula_failed', detail: null },
};

async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  return cloneElement(node, {}, await resolve(node.props.children));
}
const remarks = async (outcome: ReprocessEmployeeOutcome) =>
  renderToStaticMarkup(await resolve(await ReprocessOutcomeRemarks({ outcome, batchId: '22222222-2222-4222-8222-222222222222', currency: 'MYR' })));

describe('ad6ed930 · the reprocess remark for a transaction dated after the last day', () => {
  it('decodes the recorded shape with its leaving date', () => {
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [afterLeaving] }, [emp])).toEqual([afterLeaving]);
  });

  it('names the leaving date and the way forward, and does not send HR to Payroll Items', async () => {
    state.locale = 'en';
    const out = await remarks(afterLeaving);
    expect(out).toContain('This employee left on 29 Oct 2026. Choose an effective date on or before that day.');
    expect(out).toContain('NORMAL OT (ONOR): 1 transaction is dated after the employee’s last day (31 Oct 2026).');
    expect(out).not.toContain('Correct the formula');
    expect(out).not.toContain('could not calculate');
    expect(out).not.toContain('href="/admin/pay-components/ONOR"');
    expect(out).toContain('href="/payroll/transactions/individual"');
  });

  it('a genuine formula failure keeps its existing remark and Pay Item link (unchanged behaviour)', async () => {
    state.locale = 'en';
    const out = await remarks(formulaFault);
    expect(out).toContain('The updated Pay Item formula could not calculate this employee’s transactions.');
    expect(out).toContain('NORMAL OT (ONOR): the updated formula could not calculate 1 transaction (');
    expect(out).toContain('href="/admin/pay-components/ONOR"');
    expect(out).not.toContain('left on');
  });

  it('renders in every locale with no raw keys', async () => {
    for (const locale of LOCALES) {
      state.locale = locale;
      const out = await remarks(afterLeaving);
      expect(out, locale).not.toMatch(/reprocessPayItem|payroll\.batch\./);
      expect(out, locale).toContain('ONOR');
    }
  });
});

describe('ad6ed930 · messages and the whole-run processing text', () => {
  it('the processing error names the leaving date without blaming the formula', () => {
    const e = new PayItemFormulaRepriceError(emp, componentId, 'ONOR', 'NORMAL OT', ['2026-10-31'], 'after_leaving_date', null, '2026-10-29');
    expect(e.message).toBe('NORMAL OT (ONOR): 1 transaction is dated after this employee\'s last day (2026-10-31). This employee left on 2026-10-29. Choose an effective date on or before that day.');
    const f = new PayItemFormulaRepriceError(emp, componentId, 'ONOR', 'NORMAL OT', ['2026-10-14'], 'formula_failed', null);
    expect(f.message).toMatch(/the updated formula could not calculate 1 transaction \(2026-10-14\)\. The formula could not be calculated for these inputs\. Correct the formula/);
  });

  it('every new key exists in all six locales with its placeholders', () => {
    const ind: Record<string, string[]> = {
      txnAfterLeavingDate: ['{date}'], leaverLeftOn: ['{date}'], leaverMonthHint: [], leaverDateHint: ['{date}'], leaverInfo: ['{date}'],
    };
    const batch: Record<string, string[]> = {
      reprocessPayItemAfterLeavingDate: ['{date}'], reprocessPayItemDatedAfterLeaving: ['{name}', '{code}', '{dates}', '{count'],
    };
    for (const loc of LOCALES) {
      const m = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      for (const [k, holes] of Object.entries(ind)) {
        const v = String(m.payroll.transactions.individual[k] ?? '');
        expect(v.trim().length, `${loc} ${k}`).toBeGreaterThan(0);
        for (const h of holes) expect(v, `${loc} ${k}`).toContain(h);
      }
      for (const [k, holes] of Object.entries(batch)) {
        const v = String(m.payroll.batch[k] ?? '');
        expect(v.trim().length, `${loc} ${k}`).toBeGreaterThan(0);
        for (const h of holes) expect(v, `${loc} ${k}`).toContain(h);
      }
    }
  });

  it('payrollLeavingDate is the earliest of the three dates, NULLs ignored', () => {
    expect(payrollLeavingDate({ terminatedOn: null, resignationDate: null, lastWorkingDate: null })).toBeNull();
    expect(payrollLeavingDate({ terminatedOn: '2026-10-31', resignationDate: null, lastWorkingDate: '2026-10-29' })).toBe('2026-10-29');
    expect(payrollLeavingDate({ terminatedOn: '2026-10-29', resignationDate: '2026-11-15', lastWorkingDate: null })).toBe('2026-10-29');
    expect(payrollLeavingDate({ resignationDate: '2026-12-01' })).toBe('2026-12-01');
  });
});
