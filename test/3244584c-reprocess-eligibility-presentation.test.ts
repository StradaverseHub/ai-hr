/**
 * 3244584c — the outcome table names an exclusion with its reason and date, says what happened to the old
 * result, and a stopped job names its run-level blocker instead of the generic line. Pure: the recorded
 * outcome shapes are decoded and rendered, nothing is recalculated.
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
import {
  BatchNotResettableError,
  PayrollPermissionDeniedError,
  PayrollReprocessStoppedError,
  ReprocessRunBlockedError,
  decodeReprocessEmployeeOutcomes,
  reprocessRunErrorCode,
  type ReprocessEmployeeOutcome,
} from '../core/payroll';
import {
  ReprocessOutcomePanel,
  ReprocessOutcomeRemarks,
  ReprocessOutcomeStatus,
  reprocessStoppedMessageKey,
} from '../app/(app)/payroll/[batchId]/reprocess/outcomes';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'];
const msgs = (locale: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${locale}.json`), 'utf8')).payroll.batch;
const run = { companyId: '22222222-2222-4222-8222-222222222222', payPeriod: '2026-10', runType: 'regular' };
const emp = '33333333-3333-4333-8333-333333333333';
const emp2 = '66666666-6666-4666-8666-666666666666';
const slipId = '44444444-4444-4444-8444-444444444444';
const historyId = '77777777-7777-4777-8777-777777777777';
const jobId = '55555555-5555-4555-8555-555555555555';
const excluded: ReprocessEmployeeOutcome = {
  employmentId: emp, name: 'Late Resignation', employeeCode: 'E001', status: 'excluded', reasonCode: 'RESIGNED_BEFORE_PERIOD',
  validationCode: 'employment_not_in_period', validationDetails: [{ gap: 'RESIGNED_BEFORE_PERIOD', date: '2026-08-15' }],
  resultRetained: false, payslipId: null, versionBefore: 1, versionAfter: null, historyId, at: '2026-10-31T10:00:00.000Z',
};
const notEligible: ReprocessEmployeeOutcome = {
  ...excluded, employmentId: emp2, name: 'Kept Result', status: 'not_eligible', reasonCode: 'JOINED_AFTER_PERIOD',
  validationDetails: [{ gap: 'JOINED_AFTER_PERIOD', date: '2026-11-03' }],
  resultRetained: true, payslipId: slipId, versionBefore: 1, versionAfter: 1, historyId: null,
};

async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ReprocessOutcomeStatus || node.type === ReprocessOutcomeRemarks)
    return resolve(await (node.type as (props: unknown) => Promise<ReactNode>)(node.props));
  return cloneElement(node, {}, await resolve(node.props.children));
}
async function html(outcomes: ReprocessEmployeeOutcome[], stopped = false, stoppedCode: string | null = null) {
  return renderToStaticMarkup(await resolve(await ReprocessOutcomePanel({
    outcomes, history: [], slips: [{ id: slipId, employmentId: emp2, version: 1 }], run, currency: 'MYR',
    batchId: run.companyId, jobId, selected: outcomes.length, stopped, stoppedCode,
  })));
}
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('“', '“');

describe('3244584c exclusion outcomes and run-level stop reasons', () => {
  it('decodes the two new statuses and refuses inconsistent shapes', () => {
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [excluded, notEligible] }, [emp, emp2])).toHaveLength(2);
    // An exclusion with no payslip found to remove is valid; one claiming a retained result is not.
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...excluded, historyId: null, versionBefore: null }] }, [emp])).toHaveLength(1);
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...excluded, resultRetained: true }] }, [emp])).toBeNull();
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...excluded, payslipId: slipId }] }, [emp])).toBeNull();
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...excluded, reasonCode: 'NOTHING_PAYABLE' }] }, [emp])).toBeNull();
    expect(decodeReprocessEmployeeOutcomes({ outcomes: [{ ...notEligible, historyId }] }, [emp2])).toBeNull();
  });

  it('maps each run-level refusal to its code and keeps REPROCESS_STOPPED for the unexpected', () => {
    expect(reprocessRunErrorCode(new ReprocessRunBlockedError('PERIOD_CLOSED', 'closed'))).toBe('PERIOD_CLOSED');
    expect(reprocessRunErrorCode(new ReprocessRunBlockedError('SUPERSEDED', 'superseded'))).toBe('SUPERSEDED');
    expect(reprocessRunErrorCode(new BatchNotResettableError())).toBe('BATCH_NOT_PROCESSED');
    expect(reprocessRunErrorCode(new PayrollPermissionDeniedError('payroll.reprocess.selective'))).toBe('PERMISSION_DENIED');
    expect(reprocessRunErrorCode(new Error('private database SQL failure'))).toBe('REPROCESS_STOPPED');
    expect(new PayrollReprocessStoppedError(jobId, new ReprocessRunBlockedError('PERIOD_CLOSED', 'closed')).code).toBe('PERIOD_CLOSED');
    expect(reprocessStoppedMessageKey('PERIOD_CLOSED')).toBe('reprocessStopped_PERIOD_CLOSED');
    expect(reprocessStoppedMessageKey('REPROCESS_STOPPED')).toBe('reprocessStoppedPartial');
    expect(reprocessStoppedMessageKey(null)).toBe('reprocessStoppedPartial');
  });

  it.each(LOCALES)('renders the exclusion reason with its date and the retained-result explanation in %s', async (locale) => {
    state.locale = locale;
    const m = msgs(locale);
    const out = await html([excluded, notEligible]);
    expect(out).not.toContain('MISSING_MESSAGE');
    expect(out).toContain(m.reprocessOutcomeStatus.excluded);
    expect(out).toContain(m.reprocessOutcomeStatus.not_eligible);
    expect(out).toContain('15 Aug 2026');
    expect(out).toContain('03 Nov 2026');
    expect(out).toContain(esc(m.reprocessExcludedRemoved));
    expect(out).toContain(esc(m.reprocessNotEligibleRemovalOff));
    // not_eligible carries its own retained sentence instead of the generic one.
    expect(out).not.toContain(esc(m.reprocessPreviousResultRetained));
    expect(out).not.toContain(esc(m.reprocessStoppedPartial));
  });

  it.each(LOCALES)('a stopped job names the blocker instead of the generic line in %s', async (locale) => {
    state.locale = locale;
    const m = msgs(locale);
    for (const code of ['BATCH_NOT_PROCESSED', 'PERIOD_CLOSED', 'PERMISSION_DENIED', 'SUPERSEDED']) {
      const out = await html([excluded], true, code);
      expect(out).toContain(esc(m[`reprocessStopped_${code}`]));
      expect(out).not.toContain(esc(m.reprocessStoppedPartial));
    }
    expect(await html([excluded], true, 'REPROCESS_STOPPED')).toContain(esc(m.reprocessStoppedPartial));
  });

  it.each(LOCALES)('every new key exists in %s with the same placeholders as English', (locale) => {
    const en = msgs('en');
    const m = msgs(locale);
    const keys = Object.keys(en).filter((k) => k.startsWith('reprocessExclusion_') || k.startsWith('reprocessStopped_')
      || ['reprocessExcludedRemoved', 'reprocessNotEligibleRemovalOff', 'reprocessNotEligibleLastOnRun',
        'reprocessOutcomeExclusionSummary', 'recalcChangeLine'].includes(k));
    expect(keys.length).toBeGreaterThan(10);
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    for (const k of keys) {
      expect(typeof m[k], k).toBe('string');
      expect(ph(m[k]), k).toEqual(ph(en[k]));
    }
    expect(Object.keys(m.recalcChangeCategory).sort()).toEqual(['compensation', 'hire_date', 'statutory', 'termination', 'transfer']);
  });
});
