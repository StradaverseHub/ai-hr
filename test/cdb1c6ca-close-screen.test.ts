/**
 * cdb1c6ca — Close Batch: the screen half. Where the action is offered, what the confirmation says, and where
 * Yes / No lead. The service half (gates, audit, isolation) is test/cdb1c6ca-close-batch.test.ts.
 *
 * Menu placement and form wiring are SOURCE-SHAPE assertions for the reason the sibling payroll guards give
 * (test/payroll-reset-screen-9f8cd608.test.ts): a menu placement is a string and tsc is indifferent to it.
 * The month/cycle wording and the return path are pure functions and are asserted as values.
 *
 *   A. Close Batch is in the row menu on PROCESSED rows only, gated on a per-COMPANY server read, as a link.
 *   B. The confirmation screen names the month and pay cycle, the company and the payslip count, and offers
 *      Yes (a post) and No (a link — no post at all).
 *   C. The question's month and cycle words: formatPayPeriodMonth / payrollCloseCycleLabel.
 *   D. Yes from the screen lands on the list with the success toast and the row visible; a refusal comes back
 *      to the screen, translated, with the three new reasons mapped.
 *   E. Copy: all six catalogues, the same ICU arguments as English.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { formatPayPeriodMonth } from '../lib/hr-date';
import { payrollCloseCycleLabel } from '../core/payslip-cycle-label';
import { payrollListAfterClose } from '../lib/return-to';

const ROOT = path.resolve(__dirname, '..');
const code = (rel: string) =>
  fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const LIST = code('app/(app)/payroll/page.tsx');
const SCREEN = code('app/(app)/payroll/[batchId]/close/page.tsx');
const RUN = code('app/(app)/payroll/[batchId]/page.tsx');
const ACTIONS = code('app/(app)/payroll/actions.ts');

const menuBody = (() => {
  const open = LIST.indexOf('<PayrollRowActions');
  const close = LIST.indexOf('</PayrollRowActions>');
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return LIST.slice(open, close);
})();

describe('cdb1c6ca · A — Close Batch in the row menu', () => {
  it('is offered on processed rows only, and only where the company grants payroll.close', () => {
    const at = menuBody.indexOf("tb('closeBatch')");
    expect(at, 'Close Batch is not in the row menu').toBeGreaterThan(-1);
    const guard = menuBody.lastIndexOf('{b.status', at);
    expect(menuBody.slice(guard, at)).toMatch(
      /^\{b\.status === 'processed' && closeCompanies\.has\(b\.companyId\) && \(\s*<Link\s+href=\{`\/payroll\/\$\{b\.id\}\/close\?from=\$\{fromQuery\}`\}/,
    );
  });

  it('resolves the permission once per company on the server, for the processed rows rendered', () => {
    expect(LIST).toContain('const closeCompanies = await payrollCloseCompanyIds(');
    expect(LIST).toMatch(/batchPage\.filter\(\(b\) => b\.status === 'processed'\)\.map\(\(b\) => b\.companyId\)/);
    expect(LIST, 'the list must not post a close itself').not.toContain('closeAction');
  });

  it('the screen is a registered route', () => {
    expect(REGISTERED_ROUTES.has('/payroll/[batchId]/close')).toBe(true);
  });
});

describe('cdb1c6ca · B — the confirmation screen', () => {
  it('names month, cycle, company and payslip count before anything can be pressed', () => {
    for (const token of ["tl('colCompany')", "t('summaryPeriod')", "t('summaryCycle')", "t('closeSummaryPayslips')"]) {
      expect(SCREEN).toContain(token);
    }
    expect(SCREEN).toContain("t('closeConfirmTitle', { month, cycle })");
    expect(SCREEN).toContain("t('closeConfirmBody', { n: slips.length })");
    expect(SCREEN).toContain('const month = formatPayPeriodMonth(batch.payPeriod, locale);');
    expect(SCREEN).toContain('payrollCloseCycleLabel(');
  });

  it('Yes posts closeAction for this batch from the close screen; No is a link back, never a post', () => {
    expect(SCREEN).toMatch(/<form action=\{closeAction\}/);
    expect(SCREEN).toContain('<input type="hidden" name="batchId" value={batchId} />');
    expect(SCREEN).toContain('<input type="hidden" name="surface" value="close-screen" />');
    expect(SCREEN).toContain('<input type="hidden" name="from" value={from} />');
    expect(SCREEN).toMatch(/<Link\s+href=\{back\}[\s\S]*?\{t\('closeConfirmNo'\)\}\s*<\/Link>/);
    expect(SCREEN).toMatch(/<Button type="submit"[^>]*>\s*\{t\('closeConfirmYes'\)\}/);
    expect(SCREEN).not.toContain('ConfirmSubmit');
  });

  it('refuses up front, without a Yes button, when it can already tell', () => {
    expect(SCREEN).toContain('payrollCloseCompanyIds(s, [batch.companyId])');
    expect(SCREEN).toContain("t('closePermissionDenied')");
    expect(SCREEN).toContain("batch.status !== 'processed'");
    expect(SCREEN).toContain("t('closeNotProcessed')");
    const refusalReturn = SCREEN.indexOf('if (refusal)');
    expect(refusalReturn).toBeGreaterThan(-1);
    expect(SCREEN.indexOf('<form action={closeAction}')).toBeGreaterThan(refusalReturn);
  });

  it('the run screen asks the same question', () => {
    expect(RUN).toContain("title={t('closeConfirmTitle', { month: closePrompt?.month ?? batch.payPeriod, cycle: closePrompt?.cycle ?? '' })}");
    expect(RUN).toContain("cancelLabel={t('closeConfirmNo')}");
    expect(RUN).toContain('payrollCloseCycleLabel(');
  });
});

describe('cdb1c6ca · C — the month and pay cycle words', () => {
  it('formats a payroll month in the reader’s locale, never sliding into a neighbouring month', () => {
    expect(formatPayPeriodMonth('2026-10', 'en')).toBe('October 2026');
    expect(formatPayPeriodMonth('2026-01', 'en')).toBe('January 2026');
    expect(formatPayPeriodMonth('2026-12', 'en')).toBe('December 2026');
    expect(formatPayPeriodMonth('2026-10', 'ms')).toMatch(/Oktober 2026/);
  });

  it('returns a malformed period unchanged rather than inventing one', () => {
    for (const bad of ['2026-13', '2026-1', 'October', '']) expect(formatPayPeriodMonth(bad, 'en')).toBe(bad);
  });

  it('names the configured cycle, falls back to the run type, and keeps an import’s label', () => {
    expect(payrollCloseCycleLabel({ payrollCycleName: 'Monthly Salary' }, 'Regular')).toBe('Monthly Salary');
    expect(payrollCloseCycleLabel({ payrollCycleName: null }, 'Regular')).toBe('Regular');
    expect(payrollCloseCycleLabel({ payrollCycleName: '   ' }, 'Bonus')).toBe('Bonus');
    expect(
      payrollCloseCycleLabel(
        { historyImportAttemptId: 'x', historyImportCycleName: 'Monthly Salary', payrollCycleName: 'Ignored' },
        'Adjustment',
      ),
    ).toMatch(/^Monthly Salary.*Import/);
  });
});

describe('cdb1c6ca · D — where Yes and a refusal lead', () => {
  it('success from the close screen returns to the list as left, dropping only a filter that would hide Closed', () => {
    expect(payrollListAfterClose('/payroll?year=2026&status=processed&q=ada')).toBe('/payroll?year=2026&q=ada');
    expect(payrollListAfterClose('/payroll?year=2026&status=closed')).toBe('/payroll?year=2026&status=closed');
    expect(payrollListAfterClose('/payroll?year=2026')).toBe('/payroll?year=2026');
    expect(payrollListAfterClose('https://evil.example/payroll')).toBe('/payroll');
    expect(payrollListAfterClose(null)).toBe('/payroll');
  });

  it('closeAction routes the close screen’s result, and maps the three new refusals', () => {
    expect(ACTIONS).toContain("const onCloseScreen = formData.get('surface') === 'close-screen';");
    expect(ACTIONS).toContain("if (onCloseScreen) redirect(withQueryParam(listAfterClose, 'toast', t('closeDone')));");
    expect(ACTIONS).toContain('redirect(`/payroll/${batchId}/close?${q.toString()}`);');
    expect(ACTIONS).toContain("t('closeBlockedReprocessRunning')");
    expect(ACTIONS).toContain("t('closeBlockedPending', { n: e.employees.length, names: named(e.employees) })");
    expect(ACTIONS).toContain("t('closeBlockedReprocessFailed', { n: e.employees.length, names: named(e.employees) })");
    // The success toast is only reached after closeBatch returned — a refusal redirects from the catch.
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function closeAction'));
    expect(fn.indexOf('await closeBatch(s, { batchId });')).toBeLessThan(fn.indexOf("t('closeDone')"));
  });
});

describe('cdb1c6ca · E — copy in all six catalogues', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'];
  const batch = (loc: string) =>
    (JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8')) as {
      payroll: { batch: Record<string, string> };
    }).payroll.batch;
  const args = (v: string) => [...v.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
  const KEYS = [
    'closeConfirmTitle',
    'closeConfirmBody',
    'closeConfirmYes',
    'closeConfirmNo',
    'closeDone',
    'closeBack',
    'closeSummaryPayslips',
    'closeBlockedPending',
    'closeBlockedReprocessRunning',
    'closeBlockedReprocessFailed',
    'closeBlockedAndMore',
  ];

  it.each(KEYS)('payroll.batch.%s exists everywhere with English’s ICU arguments', (key) => {
    const en = batch('en')[key];
    expect(typeof en).toBe('string');
    for (const loc of LOCALES) {
      const v = batch(loc)[key];
      expect(typeof v, `${loc} lacks ${key}`).toBe('string');
      expect(v.trim().length).toBeGreaterThan(0);
      expect(args(v), `${loc}.${key}`).toEqual(args(en));
    }
  });

  it('the English wording is the requested wording', () => {
    const en = batch('en');
    expect(en.closeConfirmTitle).toBe('Are you sure you want to close payroll for {month} and {cycle}?');
    expect(en.closeDone).toBe('Payroll batch closed successfully.');
    expect([en.closeConfirmYes, en.closeConfirmNo]).toEqual(['Yes', 'No']);
  });
});
