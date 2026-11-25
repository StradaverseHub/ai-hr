/**
 * Board d8dc0a8c / ADR 0183 — the custom PCB controls, rendered. The Income Tax Resident select offers the two
 * custom choices on the Active card and the payroll tax set-up page; choosing one shows exactly one number box
 * posted as `customPcbValue` (RM for a fixed amount, % for a rate), prefilled only with its own saved number.
 * The Create New Employee draft does not offer them. Every locale has the wording.
 */
import {describe, expect, it} from 'vitest';
import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {useState, type ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import {CustomPcbValueField, TaxResidencySelect} from '../components/tax-residency-field';
import {ScopedTaxResidencyField} from '../app/payroll/[batchId]/tax-configuration/[employmentId]/scoped-tax-residency-field';

const d = en.people.detail;
const wrap = (node: ReactNode, messages: typeof en = en, locale = 'en') =>
  render(<NextIntlClientProvider locale={locale} messages={messages}>{node}</NextIntlClientProvider>);
const optionValues = (select: HTMLSelectElement) => [...select.options].map(o => o.value);
const posted = (container: HTMLElement) => [...container.querySelectorAll('input[name="customPcbValue"]')] as HTMLInputElement[];

function ActiveCard(props: {initial: string; savedAmount?: number | null; savedRate?: number | null}) {
  const [value, setValue] = useState(props.initial);
  return <form>
    <TaxResidencySelect mode="form" none={false} value={value} onChange={setValue} />
    <CustomPcbValueField scheme={value} savedAmount={props.savedAmount ?? null} savedRate={props.savedRate ?? null} />
  </form>;
}

describe('custom PCB controls (board d8dc0a8c)', () => {
  it('the Active card offers the two custom choices after the five standard ones; the draft does not', () => {
    const {container, unmount} = wrap(<ActiveCard initial="resident" />);
    expect(optionValues(container.querySelector('select')!)).toEqual(['', 'resident', 'non_resident', 'rep', 'knowledge_worker', 'c_suite', 'custom_fixed', 'custom_rate']);
    expect(screen.getByRole('option', {name: d.taxResidencyCustomFixed})).toBeTruthy();
    unmount();
    const draft = wrap(<TaxResidencySelect mode="controlled" none={false} value="" onChange={() => {}} notSetLabel="—" />);
    expect(optionValues(draft.container.querySelector('select')!)).not.toContain('custom_fixed');
    expect(optionValues(draft.container.querySelector('select')!)).not.toContain('custom_rate');
  });

  it('shows one number box that follows the choice, prefilled only with its own saved number', async () => {
    const {container} = wrap(<ActiveCard initial="custom_fixed" savedAmount={450} />);
    expect(posted(container)).toHaveLength(1);
    expect(screen.getByLabelText(d.customPcbAmountLabel)).toHaveProperty('value', '450.00');
    expect(screen.getByText('RM')).toBeTruthy();
    expect(screen.getByText(d.customPcbAmountHint)).toBeTruthy();
    expect(screen.getByText(d.customPcbTakesEffect)).toBeTruthy();
    await userEvent.selectOptions(container.querySelector('select')!, 'custom_rate');
    const rate = screen.getByLabelText(d.customPcbRateLabel) as HTMLInputElement;
    expect(rate.value).toBe('');
    expect(rate.required).toBe(true);
    expect(screen.getByText('%')).toBeTruthy();
    await userEvent.type(rate, '30');
    expect(posted(container).map(i => i.value)).toEqual(['30']);
    await userEvent.selectOptions(container.querySelector('select')!, 'resident');
    expect(posted(container)).toHaveLength(0);
  });

  it('the payroll tax set-up page posts the same choice and number, and nothing while "Not subject to income tax"', async () => {
    const {container, unmount} = wrap(<form><ScopedTaxResidencyField none={false} defaultScheme="custom_rate" savedAmount={null} savedRate={27.5} /></form>);
    expect((container.querySelector('select[name="taxResidency"]') as HTMLSelectElement).value).toBe('custom_rate');
    expect(posted(container).map(i => i.value)).toEqual(['27.50']);
    await userEvent.selectOptions(container.querySelector('select')!, 'custom_fixed');
    expect(posted(container).map(i => i.value)).toEqual(['']);
    unmount();
    const none = wrap(<form><ScopedTaxResidencyField none defaultScheme="custom_fixed" savedAmount={450} savedRate={null} /></form>);
    expect(posted(none.container)).toHaveLength(0);
    expect((none.container.querySelector('input[name="taxResidency"]') as HTMLInputElement).value).toBe('none');
  });

  it.each(Object.entries({ms, zh, ta, th, vi: vi_}))('%s has every custom PCB caption', (locale, messages) => {
    const m = messages as typeof en;
    wrap(<ActiveCard initial="custom_fixed" savedAmount={450} />, m, locale);
    expect(screen.getByRole('option', {name: m.people.detail.taxResidencyCustomRate})).toBeTruthy();
    expect(screen.getByLabelText(m.people.detail.customPcbAmountLabel)).toBeTruthy();
    for (const key of ['taxResidencyCustomFixed', 'taxResidencyCustomRate', 'customPcbAmountLabel', 'customPcbRateLabel', 'customPcbAmountHint',
      'customPcbRateHint', 'customPcbTakesEffect', 'customPcbCategoryNotUsed'] as const) {
      expect(m.people.detail[key], `${locale} ${key}`).toBeTruthy();
      expect(m.people.detail[key], `${locale} ${key} is translated`).not.toBe(en.people.detail[key]);
    }
  });
});
