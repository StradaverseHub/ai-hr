/**
 * c3258a72 — after a reprocess, a Skipped employee is a COMPLETED outcome with its reason, counted apart
 * from Reprocessed and from Configuration incomplete. Rendered through the real catalogues in all six
 * locales (same server-component harness as test/r382-reprocess-presentation.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ReprocessEmployeeOutcome } from '../packs/payroll/service';
const state = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => state.locale,
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: state.locale,
      namespace,
      messages: JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${state.locale}.json`), 'utf8')),
    }),
}));
import { ReprocessOutcomePanel, ReprocessOutcomeRemarks, ReprocessOutcomeStatus } from '../app/(app)/payroll/[batchId]/reprocess/outcomes';

const run = { companyId: '22222222-2222-4222-8222-222222222222', payPeriod: '2026-07', runType: 'regular' };
const at = '2026-07-31T10:00:00.000Z';
const row = (employmentId: string, over: Partial<ReprocessEmployeeOutcome>): ReprocessEmployeeOutcome => ({
  employmentId, name: `Synthetic ${employmentId.slice(0, 4)}`, employeeCode: null, status: 'reprocessed', reasonCode: null,
  resultRetained: false, payslipId: null, versionBefore: null, versionAfter: null, historyId: null, at, ...over,
});
const skipped = row('11111111-1111-4111-8111-111111111111', { status: 'skipped', reasonCode: 'NOTHING_PAYABLE' });
const done = row('33333333-3333-4333-8333-333333333333', { status: 'reprocessed' });
const failed = row('44444444-4444-4444-8444-444444444444', { status: 'validation_failed', reasonCode: 'PAYROLL_CONFIGURATION_INCOMPLETE' });

async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ReprocessOutcomeStatus || node.type === ReprocessOutcomeRemarks)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return resolve(await (node.type as (props: any) => Promise<ReactNode>)(node.props));
  return cloneElement(node, {}, await resolve(node.props.children));
}

describe('c3258a72 · the outcome summary labels Skipped as completed', () => {
  it.each(['en', 'ms', 'ta', 'th', 'vi', 'zh'])('counts each outcome apart and names Skipped as completed in %s', async (locale) => {
    state.locale = locale;
    const outcomes = [done, skipped, { ...skipped, employmentId: '55555555-5555-4555-8555-555555555555' }, failed];
    const html = renderToStaticMarkup(
      (await resolve(
        await ReprocessOutcomePanel({
          outcomes, history: [], slips: [], run, currency: 'MYR', batchId: run.companyId,
          jobId: '66666666-6666-4666-8666-666666666666', selected: outcomes.length, stopped: false,
        }),
      )) as Parameters<typeof renderToStaticMarkup>[0],
    );
    const messages = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${locale}.json`), 'utf8'));
    const msg = messages.payroll.batch;
    const summary = createTranslator({ locale, namespace: 'payroll.batch', messages })(
      'reprocessOutcomeSummary' as never, { selected: 4, succeeded: 1, skipped: 2, failed: 1 } as never,
    ) as string;
    expect(html).toContain(summary.replaceAll('&', '&amp;'));
    // Every locale says the skip is COMPLETED, in the same sentence as its count — not an English fallback.
    const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8')).payroll.batch;
    if (locale !== 'en') expect(msg.reprocessOutcomeSummary).not.toBe(en.reprocessOutcomeSummary);
    expect(msg.reprocessOutcomeSummary).toMatch(/\{skipped\}\s*[（(]/);
    // Each skipped row shows the Skipped status and its reason.
    expect(html.split(msg.reprocessOutcomeStatus.skipped).length - 1).toBeGreaterThanOrEqual(2);
    expect(html).toContain(msg.reprocessNothingPayableShort.replaceAll('&', '&amp;'));
    expect(html).not.toContain('MISSING_MESSAGE');
  });

  it('en: Skipped is labelled a completed outcome, distinct from Reprocessed and Configuration incomplete', async () => {
    const messages = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8'));
    const s = createTranslator({ locale: 'en', namespace: 'payroll.batch', messages })(
      'reprocessOutcomeSummary' as never, { selected: 4, succeeded: 1, skipped: 2, failed: 1 } as never,
    ) as string;
    expect(s).toContain('Reprocessed: 1');
    expect(s).toContain('Skipped: 2 (completed — nothing payable)');
    expect(s).toContain('Configuration incomplete: 1');
  });
});
