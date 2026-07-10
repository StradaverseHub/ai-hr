/**
 * Bank & Statutory tab (feedback 40ef71a0) — the Personnel (Admin) employee-detail page must expose a
 * dedicated "Bank & Statutory" tab that surfaces the existing Statutory (Malaysia) card (EPF / SOCSO /
 * EIS / PCB plus the Group-4 salary-payment bank fields), relocated WHOLE out of the Payroll tab. The
 * card is a single full-row-overwrite <form action={setStatutoryAction}>, so the relocation must move the
 * render reference only — the const definition and every mounted input stay byte-identical, and the
 * Payroll tab must no longer render it.
 *
 * A source-static test (precedent: test/me-tabs.test.ts, test/ea-pdf-i18n-keys.test.ts) is the cheapest
 * guard against a future refactor silently un-relocating the card or dropping the new tab. It also pins
 * the i18n label present in all six locales so tab navigation never renders a raw key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE = fs.readFileSync(
  path.resolve(__dirname, '../app/admin/personnel/[employmentId]/page.tsx'),
  'utf8',
);
const TABS = fs.readFileSync(path.resolve(__dirname, '../components/personnel-tabs.tsx'), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('Personnel — Bank & Statutory tab (40ef71a0)', () => {
  it('registers the bankStatutory tab in the tab strip', () => {
    expect(PAGE.includes("{ key: 'bankStatutory', label: t('tabs.bankStatutory') }")).toBe(true);
    // The union type the tab array is annotated with must include the key too.
    expect(PAGE.includes("'bankStatutory'")).toBe(true);
  });

  it('mirrors the new key in the ClientTabs PersonnelTabKey union', () => {
    expect(TABS.includes("'bankStatutory'")).toBe(true);
  });

  it('renders the statutory card as the bankStatutory panel', () => {
    expect(PAGE.includes('bankStatutory: statutoryCard')).toBe(true);
  });

  it('relocates the card OUT of the Payroll tab (Payroll no longer renders it)', () => {
    // Before the relocation the payroll fragment rendered {statutoryCard}; after it, that JSX reference is
    // gone entirely (the card is referenced by name in the bankStatutory panel instead). Its absence proves
    // the Payroll tab no longer shows the statutory/bank form.
    expect(PAGE.includes('{statutoryCard}')).toBe(false);
    // The payroll panel still renders its own cards (relocation only removed the statutory one).
    expect(PAGE.includes('{payComponentsCard}')).toBe(true);
    expect(PAGE.includes('{compensationCard}')).toBe(true);
  });

  it('preserves the statutory card as a single full-overwrite <form> with its action + bank fields', () => {
    // The const definition is untouched: one form, one action binding, and the bank + statutory inputs.
    expect(PAGE.includes('const statutoryCard = admin ?')).toBe(true);
    expect(PAGE.includes('<form action={setStatutoryAction}')).toBe(true);
    // Salary-payment (bank) inputs that must remain mounted inside the single form.
    expect(PAGE.includes('name="bankName"')).toBe(true);
    expect(PAGE.includes('name="bankAccountNo"')).toBe(true);
    // Malaysia statutory inputs that must remain mounted inside the same form.
    for (const field of ['epfNumber', 'socsoNumber', 'taxNumber', 'icNumber']) {
      expect(PAGE.includes(`name="${field}"`), `missing statutory input ${field}`).toBe(true);
    }
  });

  it('has the tabs.bankStatutory label in all six locales (no raw key at runtime)', () => {
    for (const loc of LOCALES) {
      const msg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'),
      );
      const label = msg?.people?.detail?.tabs?.bankStatutory;
      expect(typeof label, `messages/${loc}.json missing people.detail.tabs.bankStatutory`).toBe(
        'string',
      );
      expect(label.length, `messages/${loc}.json bankStatutory label is empty`).toBeGreaterThan(0);
    }
  });
});
