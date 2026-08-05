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

  it('renders the statutory card + dedicated bank card as the bankStatutory panel', () => {
    // Item ef720d3a split the salary-payment bank fields into their own Bank Information card (bankCard)
    // rendered on this tab alongside the statutory card.
    const start = PAGE.indexOf('bankStatutory: (');
    expect(start).toBeGreaterThan(-1);
    const end = PAGE.indexOf('),', start);
    const panel = PAGE.slice(start, end);
    expect(panel.includes('{bankCard}')).toBe(true);
    expect(panel.includes('{statutoryCard}')).toBe(true);
  });

  it('relocates the card OUT of the Payroll tab (Payroll no longer renders it)', () => {
    // The statutory card renders only in the bankStatutory panel — the payroll fragment must not reference it.
    const start = PAGE.indexOf('payroll: (');
    const end = PAGE.indexOf('),', start);
    const payrollPanel = PAGE.slice(start, end);
    expect(payrollPanel.includes('{statutoryCard}')).toBe(false);
    // The payroll panel still renders its own cards (relocation only removed the statutory one).
    expect(payrollPanel.includes('{payComponentsCard}')).toBe(true);
    expect(payrollPanel.includes('{compensationCard}')).toBe(true);
  });

  it('preserves the statutory card as a single full-overwrite <form>, with bank fields on their own card', () => {
    // The const definition is untouched: one form, one action binding, and the statutory inputs.
    expect(PAGE.includes('const statutoryCard = admin ?')).toBe(true);
    expect(PAGE.includes('<form action={setStatutoryAction}')).toBe(true);
    // Item ef720d3a — salary-payment (bank) fields now live on the dedicated Bank Information card (its own
    // partial setBankAction), no longer inside the statutory form. bankCard is wired with setBankAction.
    expect(PAGE.includes('const bankCard = admin ?')).toBe(true);
    expect(PAGE.includes('action={setBankAction}')).toBe(true);
    // Malaysia statutory inputs that must remain mounted inside the statutory form. Item 8b5334db — taxNumber
    // moved to the dedicated Identification & Tax card (setTaxAction) and icNumber to its own Profile-tab form
    // (setIcAction); both still exist on the page (icNumber here, taxNumber in identity-tax-card.tsx). epfNumber
    // + socsoNumber stay in the statutory form.
    //
    // WHY THIS GUARD EXISTS, restated because 35b7af0a group 4 moved one of the two: setStatutoryAction is a
    // FULL-ROW OVERWRITE, so a named input that stops being mounted does not merely disappear — it silently
    // wipes the stored column on the next save. What must hold is that the input is EMITTED INSIDE that form,
    // not that its markup is literally in this file. socsoNumber is still inline; epfNumber (with
    // epfCitizenship) is now rendered by components/epf-registration-fields.tsx in its uncontrolled `form`
    // mode, from inside the same <form>.
    expect(PAGE.includes('name="socsoNumber"'), 'missing statutory input socsoNumber').toBe(true);
    const formStart = PAGE.indexOf('<form action={setStatutoryAction}');
    const formEnd = PAGE.indexOf('</form>', formStart);
    const statutoryForm = PAGE.slice(formStart, formEnd);
    expect(formStart).toBeGreaterThan(-1);
    expect(statutoryForm.includes('<EpfRegistrationFields'), 'EPF group left the statutory form').toBe(true);
    expect(statutoryForm.includes('mode="form"'), 'EPF group must stay uncontrolled + named here').toBe(true);
    const EPF = fs.readFileSync(path.resolve(__dirname, '../components/epf-registration-fields.tsx'), 'utf8');
    for (const field of ['epfNumber', 'epfCitizenship']) {
      expect(EPF.includes(`name: '${field}'`), `missing statutory input ${field}`).toBe(true);
    }
    // Item e3ce0d4d — the IC input moved into the nationality-conditional IdentityFields client
    // component; the Profile tab wires it via setIcAction={setIcAction}. taxNumber remains on the
    // Identification & Tax card component (setTaxAction still bound on the page).
    expect(PAGE.includes('setIcAction={setIcAction}')).toBe(true);
    const IDENTITY = fs.readFileSync(path.resolve(__dirname, '../components/personnel-identity.tsx'), 'utf8');
    expect(IDENTITY.includes('name="icNumber"')).toBe(true);
    expect(IDENTITY.includes('action={setIcAction}')).toBe(true);
    expect(PAGE.includes('action={setTaxAction}')).toBe(true);
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
