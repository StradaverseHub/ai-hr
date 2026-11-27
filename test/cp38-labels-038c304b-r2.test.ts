/**
 * Board 038c304b revision 2 (card 5084d02e revision 2) — the CP38 wording, without a database:
 *  - "Effective from" is "Start Date" and "Effective to" is "End Date (Last Date to Pay)" wherever CP38 shows them:
 *    the CP38 Deduction page (Add, Edit, list columns, change history, help and error messages — one key each,
 *    payroll.transactions.cp38.*) and the employee's Payroll tab (people.detail.cp38From / cp38To, which its form
 *    labels, View and table headings read through the Personnel field registry), in all six locales, with the two
 *    screens using the same words in each locale and no old term left in the renamed messages;
 *  - the new pop-up and export words exist in every locale, and the export's columns are in the approved order;
 *  - the screens read those keys: the list's Start Date / End Date columns, the Payroll tab's table headings and form
 *    labels, and the Payroll tab's Cancel inside its CP38 form (only there — the shared FamilyFormDialog is unchanged).
 * Field names, month semantics and calculations are untouched (core/cp38.ts is covered by its own tests).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { personnelField } from '../lib/personnel-field-registry';

const ROOT = resolve(__dirname, '..');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
type Dict = Record<string, unknown>;
const catalogue = (locale: string) => JSON.parse(readFileSync(resolve(ROOT, `messages/${locale}.json`), 'utf8')) as Dict;
const at = (d: Dict, path: string) => path.split('.').reduce<unknown>((o, k) => (o as Dict | undefined)?.[k], d);
const src = (file: string) => readFileSync(resolve(ROOT, file), 'utf8');

/** The terms each locale used before revision 2 for "Effective from" / "Effective to". */
const OLD: Record<(typeof LOCALES)[number], string[]> = {
  en: ['Effective from', 'Effective to'],
  ms: ['Berkuat kuasa'],
  zh: ['生效起始', '生效截止', '生效结束'],
  ta: ['நடைமுறைக்கு வரும் தேதி', 'நடைமுறை முடிவு', 'அமலுக்கு வரும் தேதி', 'அமல் முடியும் தேதி'],
  th: ['มีผลตั้งแต่', 'มีผลถึง'],
  vi: ['Hiệu lực từ', 'Hiệu lực đến'],
};
const RENAMED = ['from', 'to', 'hint', 'lastMonthHint', 'error.lastMonthNeedsEnd', 'error.backwards'];
const NEW_KEYS = [
  'cancel', 'discardTitle', 'keepEditing', 'discard', 'export', 'exportSheet',
  'exportColumns.employeeId', 'exportColumns.employeeName', 'exportColumns.company', 'exportColumns.ref', 'exportColumns.amount',
  'exportColumns.startDate', 'exportColumns.endDate', 'exportColumns.lastMonthAmount', 'exportColumns.status', 'exportColumns.remarks',
];

describe('038c304b rev 2 — CP38 Start Date / End Date (Last Date to Pay)', () => {
  it('English reads Start Date and End Date (Last Date to Pay) on both screens, and in the help and errors', () => {
    const en = catalogue('en');
    const c = (k: string) => at(en, `payroll.transactions.cp38.${k}`);
    expect([c('from'), c('to')]).toEqual(['Start Date', 'End Date (Last Date to Pay)']);
    expect([at(en, 'people.detail.cp38From'), at(en, 'people.detail.cp38To')]).toEqual(['Start Date', 'End Date (Last Date to Pay)']);
    expect(c('hint')).toContain('End Date (Last Date to Pay) is the last month deducted');
    expect(c('lastMonthHint')).toContain('End Date (Last Date to Pay)');
    expect(c('error.lastMonthNeedsEnd')).toBe('A last month amount needs an End Date (Last Date to Pay).');
    expect(c('error.backwards')).toBe('End Date (Last Date to Pay) cannot be before Start Date.');
    expect([c('cancel'), c('discardTitle'), c('keepEditing'), c('discard'), c('export')])
      .toEqual(['Cancel', 'Discard your changes?', 'Keep editing', 'Discard', 'Export to Excel']);
    expect(NEW_KEYS.filter((k) => k.startsWith('exportColumns.')).map((k) => c(k))).toEqual([
      'Employee ID', 'Employee Name', 'Company', 'CP38 Reference No.', 'Deduction Amount (RM)', 'Start Date',
      'End Date (Last Date to Pay)', 'Last Month Amount (RM)', 'Status', 'Remarks',
    ]);
  });

  it.each(LOCALES)('%s: both screens use the same words, every new key is translated, and no old term remains', (locale) => {
    const d = catalogue(locale);
    const c = (k: string) => at(d, `payroll.transactions.cp38.${k}`);
    expect(at(d, 'people.detail.cp38From')).toBe(c('from'));
    expect(at(d, 'people.detail.cp38To')).toBe(c('to'));
    expect(c('exportColumns.startDate')).toBe(c('from'));
    expect(c('exportColumns.endDate')).toBe(c('to'));
    // The parenthesis is kept: "End Date (Last Date to Pay)" in every language.
    expect(String(c('to'))).toMatch(/[(（].+[)）]/);
    for (const k of NEW_KEYS) expect(typeof c(k) === 'string' && (c(k) as string).length > 0, `${locale} ${k}`).toBe(true);
    for (const k of RENAMED) {
      for (const old of OLD[locale]) expect(String(c(k)), `${locale} ${k}`).not.toContain(old);
    }
    for (const old of OLD[locale]) {
      expect(String(at(d, 'people.detail.cp38From'))).not.toContain(old);
      expect(String(at(d, 'people.detail.cp38To'))).not.toContain(old);
    }
    if (locale !== 'en') expect(c('to')).not.toBe(at(catalogue('en'), 'payroll.transactions.cp38.to'));
  });

  it('the Personnel field registry names the two CP38 fields the same way (English fallback and reports)', () => {
    expect(personnelField('payroll.cp38_deduction.validfrom')).toMatchObject({ label: 'Start Date', labelKey: 'people.detail.cp38From', ownerField: 'validFrom' });
    expect(personnelField('payroll.cp38_deduction.validto')).toMatchObject({ label: 'End Date (Last Date to Pay)', labelKey: 'people.detail.cp38To', ownerField: 'validTo' });
  });

  it('the screens read those keys', () => {
    const page = src('app/payroll/transactions/cp38/page.tsx');
    // List columns, the pop-up's fields and the change history's field names.
    expect(page).toMatch(/<th[^>]*>\{t\('from'\)\}<\/th>/);
    expect(page).toMatch(/<th[^>]*>\{t\('to'\)\}<\/th>/);
    expect(page).toContain("validFrom: t('from'), validTo: t('to')");
    expect(page).toContain("from: t('from'), to: t('to')");
    expect(page).toContain("cancel: t('cancel'), discard: { title: t('discardTitle'), keep: t('keepEditing'), discard: t('discard') }");
    expect(page).toContain("{t('export')}");
    const tab = src('app/admin/personnel/[employmentId]/page.tsx');
    expect(tab).toContain("{t('cp38From')}</th>");
    expect(tab).toContain("{t('cp38To')}</th>");
    expect(tab).toContain("validFrom: tCp38('from'), validTo: tCp38('to')");
    expect(tab).toContain("label={personnelLabel('payroll.cp38_deduction.validfrom')}");
    expect(tab).toContain("label={personnelLabel('payroll.cp38_deduction.validto')}");
    // Cancel beside Save in the Payroll tab's CP38 form, once (Add and Edit share the form).
    const form = tab.slice(tab.indexOf('const cp38DialogForm'), tab.indexOf('const cp38ViewBody'));
    expect(form.length).toBeGreaterThan(0);
    expect(form).toContain("<Cp38DialogCancel label={tCp38('cancel')} />");
    expect(tab.split('<Cp38DialogCancel').length - 1).toBe(1);
    // The shared Family-tab shell is unchanged: it already has its X, and no Cancel of its own.
    expect(src('components/family-form-dialog.tsx')).not.toContain('Cp38');
  });
});
