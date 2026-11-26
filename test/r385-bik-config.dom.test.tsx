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
    for (const catalogue of Object.values(catalogues)) for (const key of ['errorUnsupportedTaxable', 'errorBenefit_classification_conflict', 'errorBenefit_unsupported_kind', 'errorBenefit_epf_bonus_not_allowed', 'errorBenefit_normal_remuneration_required', 'errorBenefit_remuneration_type_not_supported'] as const) {
      expect(catalogue.payComponents[key]).toContain('{code}');
    }
  });
  it('8edeef41: the Remuneration Type messages no longer mention EPF Bonus 2012; the EPF Bonus messages do, in every catalogue', () => {
    for (const catalogue of Object.values(catalogues)) {
      const c = catalogue.payComponents, p = catalogue.payroll.process;
      // The retired Normal-only reason stays decodable; the new Normal-or-Additional reason replaces it.
      for (const text of [c.errorBenefit_normal_remuneration_required, c.importIssue_normal_remuneration_required, p.nonCash_normal_remuneration_required, p.reason.NON_CASH_NORMAL_REMUNERATION_REQUIRED,
        c.errorBenefit_remuneration_type_not_supported, c.importIssue_remuneration_type_not_supported, p.nonCash_remuneration_type_not_supported, p.reason.NON_CASH_REMUNERATION_TYPE_NOT_SUPPORTED]) {
        expect(text).toBeTruthy(); expect(text).not.toMatch(/2012|EPF/);
      }
      for (const text of [c.errorBenefit_epf_bonus_not_allowed, c.importIssue_epf_bonus_not_allowed, p.nonCash_epf_bonus_not_allowed, p.reason.NON_CASH_EPF_BONUS_NOT_ALLOWED]) {
        expect(text).toContain('EPF Bonus 2012');
      }
      for (const text of [c.benefitNormalNote, c.benefitAdditionalNote]) { expect(text).toBeTruthy(); expect(text).not.toContain('2012'); }
      expect(c.benefitEpfBonusNote).toContain('EPF Bonus 2012');
      expect(c).not.toHaveProperty('benefitNormalLockedNote');
    }
    expect(en.payComponents.benefitAdditionalNote).toBe('Additional: PCB uses the additional-remuneration formula for the month it is paid. No EPF is deducted on a benefit.');
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

const remRadios = (form: HTMLFormElement) => Array.from(form.querySelectorAll<HTMLInputElement>('input[type="radio"][name="pcbRemunerationType"]'));
const radio = (form: HTMLFormElement, value: string) => remRadios(form).find(el => el.value === value)!;

describe('8edeef41 (owner decision 2026-11-25) BIK/VOLA subject to PCB choose Normal or Additional', () => {
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('the reporter\'s BKBOP saved as Additional reopens on Additional, both choices are selectable and post, in %s', locale => {
    const errors: unknown[] = [];
    const { container } = render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error => errors.push(error)}>
      <PayItemForm editing kind="non_payable" displayCategory="bik" remType="additional" exemption="PCB_TAXABLE" />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    const c = catalogues[locale].payComponents;
    // Exactly two choices for a benefit, no Optional Deduction and no select for the type.
    expect(remRadios(form).map(r => r.value)).toEqual(['normal', 'additional']);
    expect(remSelect(form)).toBeUndefined();
    expect(radio(form, 'additional').checked).toBe(true); expect(radio(form, 'normal').checked).toBe(false);
    expect(screen.getByText(c.benefitAdditionalNote)).toBeTruthy();
    expect(screen.queryByText(c.benefitNormalNote)).toBeNull();
    expect(screen.getByRole('radiogroup').closest('fieldset')!.getAttribute('aria-describedby')).toBeTruthy();
    expect(form.checkValidity()).toBe(true);
    let posted = new FormData(form);
    expect(posted.getAll('pcbRemunerationType')).toEqual(['additional']);
    expect(posted.get('pcbExemptionCode')).toBe('PCB_TAXABLE');
    expect(posted.get('includedInPcb')).toBe('on'); expect(posted.get('kind')).toBe('non_payable'); expect(posted.get('displayCategory')).toBe('bik');
    expect(posted.get('includedInEpf')).toBeNull(); expect(posted.get('epfBonus2012')).toBeNull();
    expect(posted.get('includedInSocsoEis')).toBeNull(); expect(posted.get('includedInHrdfBase')).toBeNull();
    // Normal is selectable and posts Normal with the exemption kept.
    fireEvent.click(radio(form, 'normal'));
    posted = new FormData(form);
    expect(posted.getAll('pcbRemunerationType')).toEqual(['normal']); expect(posted.get('pcbExemptionCode')).toBe('PCB_TAXABLE');
    expect(screen.getByText(c.benefitNormalNote)).toBeTruthy(); expect(screen.queryByText(c.benefitAdditionalNote)).toBeNull();
    // …and back to Additional.
    fireEvent.click(radio(form, 'additional'));
    expect(new FormData(form).getAll('pcbRemunerationType')).toEqual(['additional']);
    // No EPF Bonus 2012 explanation while that box is not ticked.
    expect(screen.queryByText(c.benefitEpfBonusNote)).toBeNull();
    expect(errors).toEqual([]);
  });

  it('a saved Normal item reopens on Normal; a new benefit defaults to Normal', () => {
    for (const remType of ['normal', null] as const) {
      const { container, unmount } = render(<NextIntlClientProvider locale="en" messages={en}>
        <PayItemForm kind="non_payable" displayCategory="vola" eaFormLine="EA_B4" remType={remType} exemption="PCB_TAXABLE" />
      </NextIntlClientProvider>);
      const form = container.querySelector('form')!;
      expect(radio(form, 'normal').checked).toBe(true); expect(radio(form, 'additional').checked).toBe(false);
      expect(new FormData(form).getAll('pcbRemunerationType')).toEqual(['normal']);
      expect(screen.getByText(en.payComponents.benefitNormalNote)).toBeTruthy();
      unmount();
    }
  });

  it('changing Payroll Category never changes the chosen type; leaving the benefit shows the full list again', () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <PayItemForm kind="non_payable" displayCategory="vola" eaFormLine="EA_B4" remType="normal" exemption="PCB_TAXABLE" />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    fireEvent.click(radio(form, 'additional'));
    fireEvent.change(form.querySelector('select[name="displayCategory"]')!, { target: { value: 'bik' } });
    fireEvent.change(form.querySelector('select[name="eaFormLine"]')!, { target: { value: 'EA_B3' } });
    expect(radio(form, 'additional').checked).toBe(true);
    expect(new FormData(form).getAll('pcbRemunerationType')).toEqual(['additional']);
    // Not a benefit any more: the ordinary select returns with the same saved choice.
    fireEvent.change(form.querySelector('select[name="displayCategory"]')!, { target: { value: '' } });
    fireEvent.change(form.querySelector('select[name="eaFormLine"]')!, { target: { value: '' } });
    expect(remRadios(form)).toEqual([]);
    expect(remSelect(form).value).toBe('additional');
    expect(Array.from(remSelect(form).options).map(o => o.value)).toEqual(['', 'normal', 'additional', 'optional_deduction']);
    fireEvent.change(form.querySelector('select[name="displayCategory"]')!, { target: { value: 'bik' } });
    expect(radio(form, 'additional').checked).toBe(true);
  });

  it('a cash item (not Non-Payable) keeps the full select; switching Category to Non-Payable offers the two choices; PCB unticked posts none', () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <PayItemForm kind="allowance" displayCategory="bik" remType="additional" exemption="PCB_TAXABLE" />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    expect(remSelect(form).disabled).toBe(false); expect(new FormData(form).get('pcbRemunerationType')).toBe('additional');
    fireEvent.change(form.querySelector('select[name="kind"]')!, { target: { value: 'non_payable' } });
    expect(remRadios(form).map(r => r.value)).toEqual(['normal', 'additional']);
    expect(new FormData(form).getAll('pcbRemunerationType')).toEqual(['additional']);
    fireEvent.click(form.querySelector<HTMLInputElement>('[name="includedInPcb"]')!);
    expect(new FormData(form).get('pcbRemunerationType')).toBeNull();
    expect(screen.queryByText(en.payComponents.benefitAdditionalNote)).toBeNull();
  });

  it('an older optional-deduction item opens on Normal and asks for a valid exemption before Save', () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <PayItemForm editing kind="non_payable" displayCategory="bik" remType="optional_deduction" exemption="LP_VOLUNTARY_EPF" />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    const exemption = form.querySelector<HTMLSelectElement>('[name="pcbExemptionCode"]')!;
    expect(radio(form, 'normal').checked).toBe(true); expect(exemption.value).toBe('');
    expect(Array.from(exemption.options).map(o => o.value)).toContain('PCB_TAXABLE');
    expect(form.checkValidity()).toBe(false);
    fireEvent.change(exemption, { target: { value: 'PCB_TAXABLE' } });
    expect(form.checkValidity()).toBe(true);
    expect(new FormData(form).getAll('pcbRemunerationType')).toEqual(['normal']);
    expect(new FormData(form).get('pcbExemptionCode')).toBe('PCB_TAXABLE');
  });

  it('the EPF Bonus 2012 explanation appears only while EPF Bonus 2012 is ticked on a taxable benefit', () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <PayItemForm kind="non_payable" displayCategory="bik" remType="additional" exemption="PCB_TAXABLE" />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    const note = () => screen.queryByText(en.payComponents.benefitEpfBonusNote);
    expect(note()).toBeNull();
    fireEvent.click(form.querySelector<HTMLInputElement>('[name="includedInEpf"]')!);
    expect(note()).toBeNull();
    fireEvent.click(form.querySelector<HTMLInputElement>('[name="epfBonus2012"]')!);
    expect(note()).toBeTruthy();
    // Not a taxable benefit: no explanation.
    fireEvent.click(form.querySelector<HTMLInputElement>('[name="includedInPcb"]')!);
    expect(note()).toBeNull();
    fireEvent.click(form.querySelector<HTMLInputElement>('[name="includedInPcb"]')!);
    expect(note()).toBeTruthy();
    fireEvent.click(form.querySelector<HTMLInputElement>('[name="epfBonus2012"]')!);
    expect(note()).toBeNull();
  });

  it('an untouched legacy blank pair keeps its preservation; a statutory edit then offers the benefit choice on Normal', () => {
    const { container } = render(<NextIntlClientProvider locale="en" messages={en}>
      <PayItemForm editing kind="non_payable" displayCategory="bik" remType={null} exemption={null} />
    </NextIntlClientProvider>);
    const form = container.querySelector('form')!;
    expect(remSelect(form).disabled).toBe(false); expect(form.checkValidity()).toBe(true);
    expect(new FormData(form).get('pcbRemunerationType')).toBe('');
    fireEvent.click(form.querySelector<HTMLInputElement>('[name="includedInEpf"]')!);
    expect(radio(form, 'normal').checked).toBe(true); expect(form.checkValidity()).toBe(false);
    expect(new FormData(form).getAll('pcbRemunerationType')).toEqual(['normal']);
  });
});
