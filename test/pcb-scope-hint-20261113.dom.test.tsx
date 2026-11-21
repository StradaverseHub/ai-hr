/**
 * Owner decisions A/B (2026-11-13) — the Pay Item form says plainly that Remuneration Type and Exemption Type
 * are PCB (income tax) only, and that the EPF, EPF Bonus 2012 and SOCSO/EIS ticks alone decide EPF, SOCSO,
 * EIS and SKBBK. Rendered in all six locales with no missing message.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

describe('Pay Item PCB configuration: scope of Remuneration Type and Exemption Type', () => {
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('shows the PCB-only hint when PCB is ticked, with no missing messages, in %s', (locale) => {
    const errors: unknown[] = [];
    const messages = catalogues[locale];
    render(<NextIntlClientProvider locale={locale} messages={messages} onError={(error) => errors.push(error)}>
      <form><StatutoryConfig includedInEpf={true} epfBonus2012={false} includedInSocsoEis={true} includedInPcb={true} includedInHrdfBase={false} pcbRemunerationType="additional" pcbExemptionCode="PCB_PERQUISITE" /></form>
    </NextIntlClientProvider>);
    expect(screen.getByText(messages.payComponents.pcbScopeHint)).toBeTruthy();
    expect(errors).toEqual([]);
  });

  it('is not shown when PCB is not ticked (there is no PCB classification to explain)', () => {
    render(<NextIntlClientProvider locale="en" messages={en}>
      <form><StatutoryConfig includedInEpf={true} epfBonus2012={false} includedInSocsoEis={true} includedInPcb={false} includedInHrdfBase={false} pcbRemunerationType={null} pcbExemptionCode={null} /></form>
    </NextIntlClientProvider>);
    expect(screen.queryByText(en.payComponents.pcbScopeHint)).toBeNull();
  });

  it('the English copy states the implemented rule', () => {
    const p = en.payComponents;
    expect(p.pcbScopeHint).toMatch(/PCB \(income tax\) only/);
    expect(p.pcbScopeHint).toMatch(/EPF, SOCSO, EIS and SKBBK are decided by the EPF, EPF Bonus 2012 and SOCSO\/EIS ticks alone/);
    expect(p.pcbScopeHint).toMatch(/Only EPF Bonus 2012 puts this pay code's money on the EPF bonus stream/);
    expect(p.remunerationTypeTip).toMatch(/^Used for PCB \(income tax\) only/);
    expect(p.exemptionTypeTip).toMatch(/^Used for PCB \(income tax\) only/);
    expect(p.exemptionTypeTip).toMatch(/still count the whole amount/);
    expect(p.epfBonus2012Tip).toMatch(/only setting that puts money on the EPF bonus stream/);
  });
});
