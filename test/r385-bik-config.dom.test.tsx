import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StatutoryConfig } from '../app/admin/pay-components/statutory-config';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
const catalogues = { en, ms, zh, ta, th, vi };
afterEach(cleanup);
describe('r385 real statutory form payload and six-locale explanation', () => {
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('submits Normal and PCB_TAXABLE with no missing messages in %s', locale => {
    const errors: unknown[] = [];
    const { container } = render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error => errors.push(error)}>
      <form><StatutoryConfig includedInEpf={false} epfBonus2012={false} includedInSocsoEis={false} includedInPcb={true} includedInHrdfBase={false} pcbRemunerationType="normal" pcbExemptionCode="PCB_TAXABLE" /></form>
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    const submitted = new FormData(form);
    expect(submitted.get('pcbRemunerationType')).toBe('normal');
    expect(submitted.get('pcbExemptionCode')).toBe('PCB_TAXABLE');
    expect(submitted.get('includedInPcb')).toBe('on');
    expect(screen.getByText(catalogues[locale].payComponents.benefitRemunerationHint)).toBeTruthy();
    const rem = form.querySelector<HTMLSelectElement>('[name="pcbRemunerationType"]')!;
    expect(Array.from(rem.options).map(option => option.value)).toEqual(['', 'normal', 'additional', 'optional_deduction']);
    fireEvent.change(rem, { target: { value: 'additional' } });
    expect(new FormData(form).get('pcbExemptionCode')).toBe('PCB_TAXABLE');
    fireEvent.change(rem, { target: { value: 'optional_deduction' } });
    expect(new FormData(form).get('pcbExemptionCode')).toBe('');
    expect(errors).toEqual([]);
  });
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('allows an untouched legacy NULL pair for a description-only edit in %s, then requires actual statutory edits', locale => {
    const { container } = render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}>
      <form><textarea name="description" defaultValue="" /><StatutoryConfig editing includedInEpf={true} epfBonus2012={false} includedInSocsoEis={true} includedInPcb={true} includedInHrdfBase={false} pcbRemunerationType={null} pcbExemptionCode={null} /></form>
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    const rem = form.querySelector<HTMLSelectElement>('[name="pcbRemunerationType"]')!;
    const exemption = form.querySelector<HTMLSelectElement>('[name="pcbExemptionCode"]')!;
    fireEvent.change(form.querySelector('textarea')!, { target: { value: 'Fictional description only' } });
    expect(form.checkValidity()).toBe(true);
    const untouched = new FormData(form);
    expect(untouched.get('description')).toBe('Fictional description only');
    expect(untouched.get('pcbRemunerationType')).toBe('');
    expect(untouched.get('pcbExemptionCode')).toBeNull(); // disabled blank selector; no invented choice
    expect(untouched.get('includedInPcb')).toBe('on');
    fireEvent.change(rem, { target: { value: 'normal' } });
    expect(form.checkValidity()).toBe(false);
    expect(exemption.required).toBe(true);
    fireEvent.change(exemption, { target: { value: 'PCB_TAXABLE' } });
    expect(form.checkValidity()).toBe(true);
    expect(new FormData(form).get('pcbExemptionCode')).toBe('PCB_TAXABLE');
  });
  it.each([false, undefined])('new/copy forms never inherit legacy NULL-pair preservation (editing=%s)', editing => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <form><StatutoryConfig editing={editing} includedInEpf={true} epfBonus2012={false} includedInSocsoEis={true} includedInPcb={true} includedInHrdfBase={false} pcbRemunerationType={null} pcbExemptionCode={null} /></form>
    </NextIntlClientProvider>);
    expect(container.querySelector('form')!.checkValidity()).toBe(false);
  });
  it('a statutory flag edit cannot keep the legacy blank-pair browser exemption', () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <form><StatutoryConfig editing includedInEpf={true} epfBonus2012={false} includedInSocsoEis={true} includedInPcb={true} includedInHrdfBase={false} pcbRemunerationType={null} pcbExemptionCode={null} /></form>
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    expect(form.checkValidity()).toBe(true);
    fireEvent.click(form.querySelector<HTMLInputElement>('[name="includedInEpf"]')!);
    expect(form.checkValidity()).toBe(false);
  });
  it('all precise benefit messages retain the pay-code context in every catalogue', () => {
    for (const catalogue of Object.values(catalogues)) for (const key of ['errorUnsupportedTaxable', 'errorBenefit_classification_conflict', 'errorBenefit_unsupported_kind', 'errorBenefit_epf_bonus_not_allowed', 'errorBenefit_normal_remuneration_required'] as const) {
      expect(catalogue.payComponents[key]).toContain('{code}');
    }
  });
  it('8edeef41: the Remuneration Type messages no longer mention EPF Bonus 2012; the EPF Bonus messages do, in every catalogue', () => {
    for (const catalogue of Object.values(catalogues)) {
      const c = catalogue.payComponents, p = catalogue.payroll.process;
      for (const text of [c.errorBenefit_normal_remuneration_required, c.importIssue_normal_remuneration_required, p.nonCash_normal_remuneration_required, p.reason.NON_CASH_NORMAL_REMUNERATION_REQUIRED]) {
        expect(text).toBeTruthy(); expect(text).not.toMatch(/2012|EPF/);
      }
      for (const text of [c.errorBenefit_epf_bonus_not_allowed, c.importIssue_epf_bonus_not_allowed, p.nonCash_epf_bonus_not_allowed, p.reason.NON_CASH_EPF_BONUS_NOT_ALLOWED]) {
        expect(text).toContain('EPF Bonus 2012');
      }
      expect(c.benefitNormalLockedNote).toBeTruthy();
    }
    expect(en.payComponents.benefitNormalLockedNote).toBe('BIK and living accommodation are taxed as normal remuneration in the monthly tax deduction.');
  });
});

/** The enclosing Pay Item form's identity selects (server-rendered in component-form.tsx) around the real island. */
function PayItemForm(p: { kind: string; displayCategory: string; eaFormLine?: string; remType: 'normal' | 'additional' | 'optional_deduction' | null; exemption: string | null; editing?: boolean; pcb?: boolean }) {
  return <form>
    <select name="kind" defaultValue={p.kind}>{['allowance', 'deduction', 'contribution', 'non_payable'].map(k => <option key={k} value={k}>{k}</option>)}</select>
    <select name="displayCategory" defaultValue={p.displayCategory}>{['', 'allowance', 'bik', 'vola'].map(k => <option key={k} value={k}>{k}</option>)}</select>
    <StatutoryConfig editing={p.editing} includedInEpf={false} epfBonus2012={false} includedInSocsoEis={false} includedInPcb={p.pcb ?? true} includedInHrdfBase={false}
      pcbRemunerationType={p.remType} pcbExemptionCode={p.exemption} kind={p.kind} displayCategory={p.displayCategory} eaFormLine={p.eaFormLine ?? ''} />
    <select name="eaFormLine" defaultValue={p.eaFormLine ?? ''}>{['', 'EA_B3', 'EA_B4'].map(k => <option key={k} value={k}>{k}</option>)}</select>
  </form>;
}
const remSelect = (form: HTMLFormElement) => Array.from(form.querySelectorAll('select')).find(el => el.querySelector('option[value="additional"]'))!;

describe('8edeef41 BIK/VOLA subject to PCB lock Remuneration Type to Normal before Save', () => {
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('the reporter\'s BKBOP saved as Additional opens locked to Normal and posts Normal with its other settings in %s', locale => {
    const errors: unknown[] = [];
    const { container } = render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error => errors.push(error)}>
      <PayItemForm editing kind="non_payable" displayCategory="bik" remType="additional" exemption="PCB_TAXABLE" />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    const rem = remSelect(form);
    expect(rem.disabled).toBe(true); expect(rem.value).toBe('normal'); expect(rem.name).toBe('');
    expect(screen.getByText(catalogues[locale].payComponents.benefitNormalLockedNote)).toBeTruthy();
    expect(rem.getAttribute('aria-describedby')).toBeTruthy();
    expect(form.checkValidity()).toBe(true);
    const posted = new FormData(form);
    expect(posted.getAll('pcbRemunerationType')).toEqual(['normal']);
    expect(posted.get('pcbExemptionCode')).toBe('PCB_TAXABLE');
    expect(posted.get('includedInPcb')).toBe('on'); expect(posted.get('kind')).toBe('non_payable'); expect(posted.get('displayCategory')).toBe('bik');
    expect(posted.get('includedInEpf')).toBeNull(); expect(posted.get('epfBonus2012')).toBeNull();
    expect(posted.get('includedInSocsoEis')).toBeNull(); expect(posted.get('includedInHrdfBase')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('VOLA locks too; changing Payroll Category away releases the field, and back locks it again', () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <PayItemForm kind="non_payable" displayCategory="vola" eaFormLine="EA_B4" remType="normal" exemption="PCB_TAXABLE" />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    expect(remSelect(form).disabled).toBe(true);
    fireEvent.change(form.querySelector('select[name="displayCategory"]')!, { target: { value: '' } });
    fireEvent.change(form.querySelector('select[name="eaFormLine"]')!, { target: { value: '' } });
    expect(remSelect(form).disabled).toBe(false); expect(remSelect(form).name).toBe('pcbRemunerationType');
    expect(screen.queryByText(en.payComponents.benefitNormalLockedNote)).toBeNull();
    fireEvent.change(remSelect(form), { target: { value: 'additional' } });
    expect(new FormData(form).get('pcbRemunerationType')).toBe('additional');
    fireEvent.change(form.querySelector('select[name="displayCategory"]')!, { target: { value: 'bik' } });
    expect(remSelect(form).disabled).toBe(true); expect(new FormData(form).getAll('pcbRemunerationType')).toEqual(['normal']);
  });

  it('a cash item (not Non-Payable) or PCB unticked is not locked; switching Category to Non-Payable locks', () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <PayItemForm kind="allowance" displayCategory="bik" remType="additional" exemption="PCB_TAXABLE" />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    expect(remSelect(form).disabled).toBe(false); expect(new FormData(form).get('pcbRemunerationType')).toBe('additional');
    fireEvent.change(form.querySelector('select[name="kind"]')!, { target: { value: 'non_payable' } });
    expect(remSelect(form).disabled).toBe(true); expect(new FormData(form).getAll('pcbRemunerationType')).toEqual(['normal']);
    fireEvent.click(form.querySelector<HTMLInputElement>('[name="includedInPcb"]')!);
    expect(new FormData(form).get('pcbRemunerationType')).toBeNull();
    expect(screen.queryByText(en.payComponents.benefitNormalLockedNote)).toBeNull();
  });

  it('an older optional-deduction item opens locked to Normal and asks for a valid exemption before Save', () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <PayItemForm editing kind="non_payable" displayCategory="bik" remType="optional_deduction" exemption="LP_VOLUNTARY_EPF" />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    const exemption = form.querySelector<HTMLSelectElement>('[name="pcbExemptionCode"]')!;
    expect(remSelect(form).value).toBe('normal'); expect(exemption.value).toBe('');
    expect(Array.from(exemption.options).map(o => o.value)).toContain('PCB_TAXABLE');
    expect(form.checkValidity()).toBe(false);
    fireEvent.change(exemption, { target: { value: 'PCB_TAXABLE' } });
    expect(form.checkValidity()).toBe(true);
    expect(new FormData(form).getAll('pcbRemunerationType')).toEqual(['normal']);
    expect(new FormData(form).get('pcbExemptionCode')).toBe('PCB_TAXABLE');
  });

  it('an untouched legacy blank pair keeps its preservation; a statutory edit then applies the lock', () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <PayItemForm editing kind="non_payable" displayCategory="bik" remType={null} exemption={null} />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    expect(remSelect(form).disabled).toBe(false); expect(form.checkValidity()).toBe(true);
    expect(new FormData(form).get('pcbRemunerationType')).toBe('');
    fireEvent.click(form.querySelector<HTMLInputElement>('[name="includedInEpf"]')!);
    expect(remSelect(form).disabled).toBe(true); expect(form.checkValidity()).toBe(false);
    expect(new FormData(form).getAll('pcbRemunerationType')).toEqual(['normal']);
  });
});
