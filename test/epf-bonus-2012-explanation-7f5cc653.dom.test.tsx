/**
 * Item 7f5cc653 — the EPF statutory explanation SCREEN, rendered, in English and Malay.
 *
 * The real `StatutoryDetailView` (the one display Transaction View › Statutory Explanation and the Statutory
 * Detail screen both mount), fed a payslip blob built by the real pack call and the real kernel line builder,
 * through the real `explainStatutory` reader, with the real message catalogues. Fixtures are fictional:
 * Basic 4,200 + Car Allowance 500 (normal EPF) + Sales Commission 1,786.83 (EPF Bonus 2012).
 *
 * Expected text is literal and hand-computed:
 *   employer 6,486.83 × 13% = 843.2879 → 843.29 to the sen, rounded up to 844.00
 *   employee row 6,400.01 – 6,500.00 → 11% × 6,500 = 715.00
 */
import { render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json';
import ms from '../messages/ms.json';

const { current } = vi.hoisted(() => ({ current: { locale: 'en' as 'en' | 'ms' } }));
const CATALOGUES = { en, ms } as const;
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (namespace: string) =>
    createTranslator({ locale: current.locale, messages: CATALOGUES[current.locale], namespace: namespace as never })),
  getLocale: vi.fn(async () => current.locale),
}));

import { StatutoryDetailView, type StatutoryDetailContext } from '../app/payroll/statutory-detail/statutory-detail-view';
import { statutory } from '../localization/my/payroll';
import { buildStatutoryTraceLines } from '../core/statutory-trace';
import { explainStatutory } from '../core/statutory-explain';
import { STATUTORY_TRACE_AMOUNT_KEYS } from '../core/statutory-trace-explain';

function employeeAExplanation() {
  const r = statutory(4700, undefined, 1786.83, 0, undefined, {
    epfAge: 35, epfCitizenship: 'citizen', epfWageMonth: '2026-11', trace: {},
  });
  const t0 = r.statutoryTrace!;
  const items = buildStatutoryTraceLines({
    basic: 4200,
    lines: [
      { code: 'CAR', name: 'Car Allowance', buckets: [{ bucket: 'wage', amount: 500 }], epf: true, socso: true },
      { code: 'COMM', name: 'Sales Commission', buckets: [{ bucket: 'bonus', amount: 1786.83 }], epf: true, socso: true },
    ],
    bonus2012Codes: new Set(['COMM']), ownOvertimeCharged: true, unpaid: 0,
    totals: { epfNormal: t0.epf.normalWage, epfBonus: t0.epf.bonusWage, socsoEis: t0.socso.wage },
  });
  const thisRun = Object.fromEntries(STATUTORY_TRACE_AMOUNT_KEYS.map((k) => [k, r[k]]));
  const blob = {
    ...r,
    bases: { epf: 4700, epfAdditional: 1786.83, socsoEis: t0.socso.wage, pcb: 6486.83, hrdf: 0 },
    statutoryTrace: { ...t0, items, run: { kind: 'single', own: { epfAdditional: 1786.83, socsoWageExtra: 0 }, thisRun } },
  };
  const explanation = explainStatutory(blob, 'regular');
  expect(explanation.traceStatus, 'the fixture must reconcile, or the screen shows no trace at all').toBe('recorded');
  return explanation;
}

const CTX: StatutoryDetailContext = {
  payslipId: '00000000-0000-4000-8000-00000000f5c6',
  employeeCode: 'FX-001',
  employeeName: 'Fictional Employee A',
  company: 'Fictional Sdn Bhd',
  periodLabel: 'November 2026',
  payPeriod: '2026-11',
  runType: 'regular',
  runSeq: 1,
  currency: 'MYR',
};

/** The value cell beside a label: Row renders `<span>label</span><span>value</span>`. */
function valueBeside(trace: HTMLElement, label: string): string {
  const cell = within(trace).getByText(label, { exact: true });
  return cell.nextElementSibling?.textContent ?? '';
}

describe('7f5cc653 — the EPF explanation shows how the employer rate was decided', () => {
  it.each([
    ['en', {
      normal: 'Normal EPF wages (excluding EPF Bonus 2012)', bonus: 'EPF Bonus 2012 wages', total: 'Total EPF wages',
      rate: 'Employer rate decided on normal wages', rateValue: 'MYR 4,700.00 is MYR 5,000.00 or below, so 13%',
      employer: 'Employer contribution', employerValue: 'MYR 6,486.83 × 13% = MYR 843.29, rounded up to MYR 844.00',
      employee: 'Employee contribution (table range)', employeeValue: 'MYR 6,400.01 – MYR 6,500.00, so MYR 715.00',
      monthEmployer: 'Employer EPF for the month', monthEmployee: 'Employee EPF for the month',
      rowEmployer: 'Employer contribution for this range',
    }],
    ['ms', {
      normal: 'Upah KWSP biasa (tidak termasuk Bonus KWSP 2012)', bonus: 'Upah Bonus KWSP 2012', total: 'Jumlah upah KWSP',
      rate: 'Kadar majikan ditentukan atas upah biasa', rateValue: 'MYR 4,700.00 adalah MYR 5,000.00 atau kurang, maka 13%',
      employer: 'Caruman majikan', employerValue: 'MYR 6,486.83 × 13% = MYR 843.29, dibundarkan ke atas kepada MYR 844.00',
      employee: 'Caruman pekerja (julat jadual)', employeeValue: 'MYR 6,400.01 – MYR 6,500.00, maka MYR 715.00',
      monthEmployer: ms.payroll.statutoryDetail.traceMonthEmployer, monthEmployee: ms.payroll.statutoryDetail.traceMonthEmployee,
      rowEmployer: ms.payroll.statutoryDetail.traceEpfRowEmployer,
    }],
  ] as const)('%s', async (locale, L) => {
    current.locale = locale;
    const element = await StatutoryDetailView({ ctx: CTX, explanation: employeeAExplanation() });
    render(element);
    const traceTitle = CATALOGUES[locale].payroll.statutoryDetail.traceTitle;
    // The EPF trace block is the first one on the screen (EPF, then SOCSO, SKBBK, EIS).
    const epfTrace = screen.getAllByLabelText(traceTitle)[0];
    expect(valueBeside(epfTrace, L.normal)).toBe('MYR 4,700.00');
    expect(valueBeside(epfTrace, L.bonus)).toBe('MYR 1,786.83');
    expect(valueBeside(epfTrace, L.total)).toBe('MYR 6,486.83');
    expect(valueBeside(epfTrace, L.rate)).toBe(L.rateValue);
    expect(valueBeside(epfTrace, L.employer)).toBe(L.employerValue);
    expect(valueBeside(epfTrace, L.employee)).toBe(L.employeeValue);
    expect(valueBeside(epfTrace, L.monthEmployer)).toBe('MYR 844.00');
    expect(valueBeside(epfTrace, L.monthEmployee)).toBe('MYR 715.00');
    // The 12% row figure (MYR 780.00) never applied, so neither its label nor its amount is on the card.
    expect(within(epfTrace).queryByText(L.rowEmployer, { exact: true })).toBeNull();
    expect(epfTrace.textContent).not.toContain('780.00');
    // No message key leaked as text.
    expect(epfTrace.textContent).not.toMatch(/traceEpfBonusRule/);
  });
});
