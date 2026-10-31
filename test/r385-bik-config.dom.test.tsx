import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StatutoryConfig } from '../app/(app)/admin/pay-components/statutory-config';
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
    for (const catalogue of Object.values(catalogues)) for (const key of ['errorUnsupportedTaxable', 'errorBenefit_classification_conflict', 'errorBenefit_unsupported_kind', 'errorBenefit_normal_remuneration_required'] as const) {
      expect(catalogue.payComponents[key]).toContain('{code}');
    }
  });
});
