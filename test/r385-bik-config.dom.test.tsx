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
  it('all precise benefit messages retain the pay-code context in every catalogue', () => {
    for (const catalogue of Object.values(catalogues)) for (const key of ['errorUnsupportedTaxable', 'errorBenefit_classification_conflict', 'errorBenefit_unsupported_kind', 'errorBenefit_normal_remuneration_required'] as const) {
      expect(catalogue.payComponents[key]).toContain('{code}');
    }
  });
});
