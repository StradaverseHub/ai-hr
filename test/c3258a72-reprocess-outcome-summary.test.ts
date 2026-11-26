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
import { ReprocessOutcomePanel, ReprocessOutcomeRemarks, ReprocessOutcomeStatus } from '../app/payroll/[batchId]/reprocess/outcomes';

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

/** The value a totals tile shows under its label (rendered `<dt>label</dt><dd …>value</dd>`), or null. */
function tile(html: string, label: string): string | null {
  const escaped = label.replaceAll('&', '&amp;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`<dt[^>]*>${escaped}</dt><dd[^>]*>([^<]*)</dd>`))?.[1] ?? null;
}
const render = async (outcomes: ReprocessEmployeeOutcome[], taxReviewHref: string | null = null, stopped = false) => renderToStaticMarkup(
  (await resolve(
    await ReprocessOutcomePanel({
      outcomes, history: [], slips: [], run, currency: 'MYR', batchId: run.companyId,
      jobId: '66666666-6666-4666-8666-666666666666', selected: outcomes.length, stopped, taxReviewHref,
    }),
  )) as Parameters<typeof renderToStaticMarkup>[0],
);

describe('c3258a72 / a1a80747 · the outcome totals count Skipped apart from Reprocessed and Failed', () => {
  it.each(['en', 'ms', 'ta', 'th', 'vi', 'zh'])('Selected / Reprocessed / Skipped / Failed, and a completed skip with its reason, in %s', async (locale) => {
    state.locale = locale;
    const outcomes = [done, skipped, { ...skipped, employmentId: '55555555-5555-4555-8555-555555555555' }, failed];
    const html = await render(outcomes);
    const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${locale}.json`), 'utf8')).payroll.batch;
    const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8')).payroll.batch;
    expect([tile(html, msg.reprocessTotalSelected), tile(html, msg.reprocessTotalReprocessed), tile(html, msg.reprocessTotalSkipped),
      tile(html, msg.reprocessTotalFailed)]).toEqual(['4', '1', '2', '1']);
    // Translated, not an English fallback.
    if (locale !== 'en') expect(msg.reprocessTotalReprocessed).not.toBe(en.reprocessTotalReprocessed);
    // Each skipped row shows the Skipped status and its completed reason.
    expect(html.split(msg.reprocessOutcomeStatus.skipped).length - 1).toBeGreaterThanOrEqual(2);
    expect(html).toContain(msg.reprocessNothingPayableShort.replaceAll('&', '&amp;'));
    expect(html).not.toContain('MISSING_MESSAGE');
  });

  it('a run stopped at an employee counts that employee as Failed', async () => {
    state.locale = 'en';
    const html = renderToStaticMarkup((await resolve(await ReprocessOutcomePanel({
      outcomes: [done], history: [], slips: [], run, currency: 'MYR', batchId: run.companyId, jobId: '66666666-6666-4666-8666-666666666666',
      selected: 3, stopped: true, stoppedEmployee: { employmentId: failed.employmentId, name: 'Stopped person', employeeCode: null },
    }))) as Parameters<typeof renderToStaticMarkup>[0]);
    expect([tile(html, 'Selected'), tile(html, 'Reprocessed'), tile(html, 'Skipped'), tile(html, 'Failed')]).toEqual(['3', '1', '0', '1']);
  });
});

/**
 * a1a80747 — the job's own tax readiness check holds an employee for income tax recalculation. The results show them
 * as Skipped with that reason, the readiness explanation, and a link to Income Tax Recalculation for a viewer who
 * holds payroll.tax-basis.view (the page passes null otherwise: the reason, no link).
 */
describe('a1a80747 · an employee held for income tax recalculation is a skipped outcome with its reason', () => {
  const href = '/payroll/income-tax-recalculation?company=22222222-2222-4222-8222-222222222222&year=2026&month=7';
  const held = row('77777777-7777-4777-8777-777777777777', { status: 'skipped', reasonCode: 'TAX_RECALC_REQUIRED', name: 'Held employee',
    resultRetained: true, payslipId: '88888888-8888-4888-8888-888888888888', versionBefore: 1, versionAfter: 1,
    validationDetails: [{ gap: 'Imported wage inputs require review for 2026-01.' }] });
  const running = row('99999999-9999-4999-8999-999999999999', { status: 'skipped', reasonCode: 'TAX_RECALC_IN_PROGRESS', name: 'Running employee' });

  it.each(['en', 'ms', 'ta', 'th', 'vi', 'zh'])('one tax-held, one nothing-payable, one failed and one reprocessed, in %s', async (locale) => {
    state.locale = locale;
    const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${locale}.json`), 'utf8')).payroll.batch;
    const html = await render([done, held, skipped, failed], href);
    expect([tile(html, msg.reprocessTotalSelected), tile(html, msg.reprocessTotalReprocessed), tile(html, msg.reprocessTotalSkipped),
      tile(html, msg.reprocessTotalFailed)]).toEqual(['4', '1', '2', '1']);
    expect(html).toContain(msg.reprocessTaxRecalcRequired.replaceAll('&', '&amp;'));
    expect(html).toContain('Imported wage inputs require review for 2026-01.');
    expect(html).toContain(msg.reprocessTaxRecalcNext.replaceAll('&', '&amp;'));
    expect(html).toContain(`href="${href.replaceAll('&', '&amp;')}"`);
    expect(html).toContain(msg.reprocessOpenTaxReview.replaceAll('&', '&amp;'));
    // The nothing-payable row keeps its own completed sentence; the held row is not described as nothing payable.
    expect(html.split(msg.reprocessNothingPayableShort.replaceAll('&', '&amp;')).length - 1).toBe(1);
    expect(html).not.toContain('MISSING_MESSAGE');
  });

  it('without payroll.tax-basis.view the reason is shown and the link is not', async () => {
    state.locale = 'en';
    const html = await render([held, running]);
    expect(html).toContain('Skipped – income tax recalculation required');
    expect(html).toContain('Skipped – income tax recalculation in progress');
    expect(html).toContain('Imported wage inputs require review for 2026-01.');
    expect(html).not.toContain('income-tax-recalculation');
    expect(html).not.toContain('Open Income Tax Recalculation');
    expect([tile(html, 'Skipped'), tile(html, 'Failed')]).toEqual(['2', '0']);
  });
});
