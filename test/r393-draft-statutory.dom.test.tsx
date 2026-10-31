import { personnelMarkupContract, personnelCaption } from './helpers/personnel-markup';
/**
 * r393 — item 685d2380 STEP 3b, the draft's Statutory (Malaysia) section ON THE SCREEN, and the Active
 * profile's EPF election and Income Tax Resident select unchanged.
 *
 * test/r393-draft-statutory.test.ts proves what lands at Activate and what is refused before anything is
 * created. This file proves what HR SEES:
 *   §1 all six locales: the draft's Bank & Statutory tab shows the Active record's THREE sections (EPF
 *      contribution, SOCSO & EIS information, Income Tax (PCB)) plus an Others Statutory card holding the
 *      training levy, under the record's own words, with the full EPF category list, the full income tax
 *      residency list, Subject to SKBBK and Employer bears tax contribution — and ZERO next-intl errors
 *      (every MISSING_MESSAGE / FORMATTING_ERROR is collected through `onError` and asserted empty);
 *   §2 the EPF boxes appear per category exactly as on the record, carry no `name` (nothing posts by itself),
 *      and write the draft's keys as the strings typed — a cleared box is '' (blank), never 0;
 *   §3 a refused election or residency is named on the still-needed list and holds Activate back;
 *   §4 a pre-r393 draft's Yes/No "Tax resident" shows as its mapped-forward choice;
 *   §5 FORM-MODE PARITY: the Active EPF election and Income Tax Resident select, rendered through the shared
 *      components, retain the independently declared form contract in six locales, including approved manual-rate
 *      requirements and mobile hint layout. The expected JSX below retains all native constraints.
 *
 * jsdom applies no CSS and computes no layout: rendering and interaction logic only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { useState, type ReactNode } from 'react';
import { NextIntlClientProvider, useTranslations, type IntlError } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import type { EmployeeDraftData } from '../lib/employee-draft-schema';
import { EpfElection } from '../components/epf-election';
import { TaxResidencySelect } from '../components/tax-residency-field';
import { todayInKualaLumpur } from '../lib/hr-date';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const saveDraftAction = vi.fn(async () => ({ id: 'draft-1' }));
vi.mock('../app/(app)/admin/personnel/new/actions', () => ({
  saveDraftAction: (...a: unknown[]) => saveDraftAction(...(a as [])),
  discardDraftAction: vi.fn(async () => ({ok:true as const})),
  createEmployeeAction: vi.fn(async () => ({ ok:true as const, employmentId: 'emp-1' })),
}));

const { EmployeeWizard } = await import('../app/(app)/admin/personnel/new/wizard');

const LOCALES = { en, ms, zh, ta, th, vi: vi_ } as const;
type Msgs = typeof en;

const OPTIONS = {
  companies: [{ id: 'co-1', label: 'Acme Sdn Bhd' }],
  businessUnits: [],
  departments: [{ id: 'dp-1', label: 'Finance', companies: 'co-1', businessUnitId: '', buCompanies: '' }],
  positions: [],
  costCenters: [],
  grades: [],
  managers: [],
  nationalityOptions: [],
  profileOptions: { salutation: [], religion: [], race: [] },
  relationshipOptions: [],
  countryOptions: [],
  stateOptions: [],
};

const today = todayInKualaLumpur();

const draftOf = (statutory: EmployeeDraftData['statutory'] = {}): EmployeeDraftData => ({
  profile: { fullName: 'Nadia Yusof', primaryEmail: 'nadia@acme.test', employeeCode: 'ABC00100' },
  employment: { companyId: 'co-1', departmentId: 'dp-1', employmentType: 'full_time', hiredOn: today },
  statutory,
  payroll: { basicSalary: '3000' },
});

let intlErrors: IntlError[] = [];
const wrap = (data: EmployeeDraftData, opts: { messages?: Msgs; locale?: string } = {}) =>
  render(
    <NextIntlClientProvider locale={opts.locale ?? 'en'} messages={opts.messages ?? en} onError={(e) => intlErrors.push(e)}>
      <EmployeeWizard
        today={today}
        draftId="draft-1"
        reservedEmployeeCode="ABC00100"
        initialData={data}
        initialStep={3}
        initialTab="bankStatutory"
        {...OPTIONS}
        payrollOn={false}
        payrollPolicies={[]}
      />
    </NextIntlClientProvider>,
  );

const shownPanel = () => {
  const open = ([...document.querySelectorAll('[data-tabpanel]')] as HTMLElement[]).filter((p) => !p.hidden);
  expect(open, 'exactly one panel is shown at a time').toHaveLength(1);
  return open[0];
};
const section = (key: string) => shownPanel().querySelector(`[data-draft-section="${key}"]`) as HTMLElement | null;
const savedData = () => (saveDraftAction.mock.calls.at(-1) as unknown as [string, EmployeeDraftData, number])[1];
const save = async () => {
  const button = screen.getByRole('button', { name: en.people.wizard.saveDraft });
  await userEvent.click(button);
  // The Draft mutation guard disables the whole editor until Save's transition has settled.
  // An awaited click is not the completion of that async transition.
  await waitFor(() => expect(button).toBeEnabled());
};
/** The still-needed list's line for the Bank & Statutory tab, or null when the tab owes nothing. */
const bankStatutoryNeeds = (m: Msgs) =>
  ([...document.querySelectorAll('li')] as HTMLElement[]).find((li) =>
    li.querySelector('button')?.textContent === m.people.wizard.tabs.bankStatutory,
  ) ?? null;
const activate = () => screen.getByRole('button', { name: en.people.wizard.activate }) as HTMLButtonElement;
const optionTexts = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.textContent);

beforeEach(() => {
  saveDraftAction.mockClear();
  intlErrors = [];
});

// ── §1 six locales ───────────────────────────────────────────────────────────────────────────────────
describe('§1 the three Active sections and Others Statutory, in all six locales, with zero missing messages', () => {
  for (const [loc, msgs] of Object.entries(LOCALES)) {
    it(`${loc}: sections, legends and the full choice lists in the record's words`, () => {
      const m = msgs as Msgs;
      const d = m.people.detail;
      wrap(draftOf(), { messages: m, locale: loc });
      const epf = section('epf');
      const socso = section('socsoEis');
      const tax = section('incomeTax');
      const others = section('othersStatutory');
      expect(epf, `${loc} EPF contribution section`).toBeTruthy();
      expect(socso, `${loc} SOCSO & EIS section`).toBeTruthy();
      expect(tax, `${loc} Income Tax (PCB) section`).toBeTruthy();
      expect(others, `${loc} Others Statutory card`).toBeTruthy();
      expect(epf!.querySelector('legend')!.textContent, `${loc} epfContribTitle`).toBe(d.epfContribTitle);
      expect(socso!.querySelector('legend')!.textContent, `${loc} socsoEisCardTitle`).toBe(d.socsoEisCardTitle);
      expect(within(tax!).getByText(d.incomeTaxPcbSection), `${loc} incomeTaxPcbSection`).toBeTruthy();
      expect(within(shownPanel()).getByText(d.othersStatutoryTitle), `${loc} othersStatutoryTitle`).toBeTruthy();
      // The three sections are in ONE Statutory (Malaysia) card, in the record's order.
      const card = epf!.parentElement!;
      expect([...card.querySelectorAll('[data-draft-section]')].map((n) => n.getAttribute('data-draft-section')), `${loc} order`).toEqual([
        'epf',
        'socsoEis',
        'incomeTax',
      ]);
      // The HRDF choice moved OUT of the tax fields into Others Statutory.
      expect(within(others!).getByLabelText(d.subjectToHrdf), `${loc} HRDF in Others Statutory`).toBeTruthy();
      expect(within(tax!).queryByLabelText(d.subjectToHrdf), `${loc} no HRDF under Income Tax`).toBeNull();
      // EPF: the FULL category list (seven), in the record's words.
      const cat = within(epf!).getByLabelText(d.epfMode) as HTMLSelectElement;
      expect(optionTexts(cat), `${loc} EPF categories`).toEqual([
        d.epfModeAuto,
        d.epfModeManualPercentage,
        d.epfModeVoluntaryPercentage,
        d.epfModeSemiAuto,
        d.epfModeManualEmployeeAmount,
        d.epfModeManualEmployerAmount,
        d.epfModeManualBothAmount,
        d.epfModeExempt,
      ]);
      expect(within(epf!).getByLabelText(d.employerBearsEpf), `${loc} employer bears EPF in the EPF section`).toBeTruthy();
      // SOCSO & EIS: Subject to SKBBK and the three employer-bears switches.
      const skbbk = within(socso!).getByLabelText(d.subjectToSkbbk) as HTMLInputElement;
      expect(skbbk.checked, `${loc} SKBBK opens off`).toBe(false);
      for (const k of ['employerBearsSocso', 'employerBearsEis', 'employerBearsSkbbk'] as const)
        expect(within(socso!).getByLabelText(d[k]), `${loc} ${k}`).toBeTruthy();
      // Income Tax (PCB): the FULL residency list and Employer bears tax contribution.
      const res = within(tax!).getByLabelText(d.incomeTaxResident) as HTMLSelectElement;
      expect(optionTexts(res), `${loc} residency choices`).toEqual([
        m.people.wizard.notSet,
        d.taxResidencyResident,
        d.taxResidencyNonResident,
        d.taxResidencyRep,
        d.taxResidencyKnowledgeWorker,
        d.taxResidencyCSuite,
      ]);
      expect((within(tax!).getByLabelText(d.employerBearsTax) as HTMLInputElement).checked, `${loc} employerBearsTax off`).toBe(false);
      // The still-needed labels for the new names ARE the record's labels.
      const f = m.people.wizard.fields;
      expect([f.epfEmployeeRate, f.epfEmployerRate, f.epfEmployeeAmount, f.epfEmployerAmount, f.epfManualReason, f.taxResidency]).toEqual([
        d.epfEmployeeRate,
        d.epfEmployerRate,
        d.epfEmployeeAmount,
        d.epfEmployerAmount,
        d.epfManualReason,
        d.incomeTaxResident,
      ]);
      expect(bankStatutoryNeeds(m), `${loc} nothing owed`).toBeNull();
      expect(intlErrors.map((e) => `${e.code}: ${e.message}`), `${loc} next-intl errors`).toEqual([]);
    });
  }
});

// ── §2 the EPF boxes per category ───────────────────────────────────────────────────────────────────
describe('§2 the EPF boxes appear per category, post nothing, and keep the strings typed', () => {
  const d = en.people.detail;
  const BOXES = {
    epfEmployeeRate: d.epfEmployeeRate,
    epfEmployerRate: d.epfEmployerRate,
    epfEmployeeAmount: d.epfEmployeeAmount,
    epfEmployerAmount: d.epfEmployerAmount,
    epfManualReason: d.epfManualReason,
  } as const;
  const EXPECT: Record<string, (keyof typeof BOXES)[]> = {
    auto: [],
    manual_percentage: ['epfEmployeeRate', 'epfEmployerRate'],
    voluntary_percentage: ['epfEmployeeRate', 'epfEmployerRate'],
    semi_auto: ['epfEmployeeRate'],
    manual_employee_amount: ['epfEmployeeAmount', 'epfManualReason'],
    manual_employer_amount: ['epfEmployerAmount', 'epfManualReason'],
    manual_both_amount: ['epfEmployeeAmount', 'epfEmployerAmount', 'epfManualReason'],
    none: [],
  };

  it('choosing each category shows exactly the record card’s boxes for it, none with a `name`', async () => {
    wrap(draftOf());
    const epf = () => within(section('epf')!);
    for (const [cat, boxes] of Object.entries(EXPECT)) {
      await userEvent.selectOptions(epf().getByLabelText(d.epfMode), cat);
      // b6dbadc5 — Top-up's two rate boxes carry their own "Top-up … Rate %" captions.
      const caption = (k: keyof typeof BOXES) =>
        cat === 'voluntary_percentage' && k === 'epfEmployeeRate' ? d.epfTopupEmployeeRate
          : cat === 'voluntary_percentage' && k === 'epfEmployerRate' ? d.epfTopupEmployerRate : BOXES[k];
      const shown = (Object.keys(BOXES) as (keyof typeof BOXES)[]).filter((k) => epf().queryByLabelText(personnelCaption(caption(k))) !== null);
      expect(shown, `${cat}: boxes shown`).toEqual(boxes);
      for (const el of section('epf')!.querySelectorAll('input, select')) expect(el.getAttribute('name'), `${cat}: no name`).toBeNull();
    }
  });

  it('typing writes the raw strings; a cleared box is saved as blank, not 0', async () => {
    wrap(draftOf());
    const epf = () => within(section('epf')!);
    await userEvent.selectOptions(epf().getByLabelText(d.epfMode), 'manual_percentage');
    await userEvent.type(epf().getByLabelText(personnelCaption(d.epfEmployeeRate)), '14.5');
    await userEvent.type(epf().getByLabelText(personnelCaption(d.epfEmployerRate)), '16');
    await save();
    let s = savedData().statutory!;
    expect(s.epfMode, 'data.statutory.epfMode').toBe('manual_percentage');
    expect(s.epfEmployeeRate, 'data.statutory.epfEmployeeRate — percent as typed').toBe('14.5');
    expect(s.epfEmployerRate, 'data.statutory.epfEmployerRate').toBe('16');
    const employerRate = epf().getByLabelText(personnelCaption(d.epfEmployerRate)) as HTMLInputElement;
    expect(employerRate.type).toBe('number');
    expect(employerRate.readOnly).toBe(false);
    expect(employerRate).toBeEnabled();
    await userEvent.clear(employerRate);
    await userEvent.selectOptions(epf().getByLabelText(d.epfMode), 'manual_both_amount');
    await userEvent.type(epf().getByLabelText(d.epfEmployeeAmount), '450.75');
    await userEvent.type(epf().getByLabelText(d.epfManualReason), 'Pre-1998 member');
    await save();
    s = savedData().statutory!;
    expect(s.epfMode).toBe('manual_both_amount');
    expect(s.epfEmployerRate, 'the cleared rate box is blank').toBe('');
    expect(s.epfEmployeeAmount, 'data.statutory.epfEmployeeAmount — ringgit as typed').toBe('450.75');
    expect(s.epfEmployerAmount, 'an untouched amount box is not written').toBeUndefined();
    expect(s.epfManualReason).toBe('Pre-1998 member');
  });

  it('SKBBK, employer bears tax and the residency write their keys', async () => {
    wrap(draftOf());
    await userEvent.click(within(section('socsoEis')!).getByLabelText(d.subjectToSkbbk));
    await userEvent.click(within(section('incomeTax')!).getByLabelText(d.employerBearsTax));
    await userEvent.selectOptions(within(section('incomeTax')!).getByLabelText(d.incomeTaxResident), 'knowledge_worker');
    await save();
    const s = savedData().statutory!;
    expect(s.subjectToSkbbk, 'data.statutory.subjectToSkbbk').toBe('yes');
    expect(s.employerBearsTax, 'data.statutory.employerBearsTax').toBe('yes');
    expect(s.taxResidency, 'data.statutory.taxResidency').toBe('knowledge_worker');
  });
});

// ── §3 refusals named on the tab ────────────────────────────────────────────────────────────────────
describe('§3 what Activate would refuse is named on the still-needed list and holds Activate back', () => {
  const d = en.people.detail;
  const f = en.people.wizard.fields;

  it('a below-floor Semi-Auto rate names the Employee rate box; fixing it releases Activate', async () => {
    wrap(draftOf({ epfMode: 'semi_auto', epfEmployeeRate: '' }));
    await userEvent.type(within(section('epf')!).getByLabelText(personnelCaption(d.epfEmployeeRate)), '10');
    expect(bankStatutoryNeeds(en)?.textContent ?? '', 'still needed').toContain(f.epfEmployeeRate);
    expect(activate().disabled, 'Activate held back').toBe(true);
    await userEvent.clear(within(section('epf')!).getByLabelText(personnelCaption(d.epfEmployeeRate)));
    await userEvent.type(within(section('epf')!).getByLabelText(personnelCaption(d.epfEmployeeRate)), '12');
    expect(bankStatutoryNeeds(en), 'nothing owed').toBeNull();
    expect(activate().disabled).toBe(false);
  });

  it('b6dbadc5: a Top-up above the 100% cap names the Employee rate box; a 1% top-up releases Activate', async () => {
    wrap(draftOf({ epfMode: 'voluntary_percentage' }));
    expect(activate().disabled, 'blank top-ups add nothing').toBe(false);
    const box = () => within(section('epf')!).getByLabelText(personnelCaption(d.epfTopupEmployeeRate));
    await userEvent.type(box(), '90');
    expect(bankStatutoryNeeds(en)?.textContent ?? '', 'still needed').toContain(f.epfEmployeeRate);
    expect(activate().disabled, 'Activate held back').toBe(true);
    await userEvent.clear(box());
    await userEvent.type(box(), '1');
    expect(bankStatutoryNeeds(en), 'nothing owed').toBeNull();
    expect(activate().disabled).toBe(false);
  });

  it('a manual amount category with no reason names the reason box', () => {
    wrap(draftOf({ epfMode: 'manual_employee_amount', epfEmployeeAmount: '500' }));
    expect(bankStatutoryNeeds(en)?.textContent ?? '').toContain(f.epfManualReason);
    expect(activate().disabled).toBe(true);
  });

  it('Position C-Suites with a citizen EPF citizenship names Income Tax Resident', () => {
    wrap(draftOf({ taxResidency: 'c_suite' }));
    expect(bankStatutoryNeeds(en)?.textContent ?? '').toContain(f.taxResidency);
    expect(activate().disabled).toBe(true);
  });
});

// ── §4 legacy isResident ─────────────────────────────────────────────────────────────────────────────
describe('§4 a pre-r393 draft shows its Yes/No "Tax resident" as the mapped-forward choice', () => {
  const d = en.people.detail;
  it("isResident 'no' shows Non-Resident; 'yes' shows Resident; an explicit taxResidency wins", () => {
    const res = () => within(section('incomeTax')!).getByLabelText(d.incomeTaxResident) as HTMLSelectElement;
    const one = wrap(draftOf({ isResident: 'no' }));
    expect(res().value).toBe('non_resident');
    one.unmount();
    const two = wrap(draftOf({ isResident: 'yes' }));
    expect(res().value).toBe('resident');
    two.unmount();
    wrap(draftOf({ isResident: 'no', taxResidency: 'rep' }));
    expect(res().value).toBe('rep');
  });
  it('"Not subject to income tax" disables the select and shows that instead', () => {
    wrap(draftOf({ taxCategory: 'none', taxResidency: 'rep' }));
    const res = within(section('incomeTax')!).getByLabelText(d.incomeTaxResident) as HTMLSelectElement;
    expect(res.disabled).toBe(true);
    expect(res.value).toBe('none');
  });
});

// ── §5 form-mode parity with the Active card ────────────────────────────────────────────────────────
// Independent retained form contract from before extraction, with the approved distinct manual-rate
// category, required native manual controls and full-width mobile hint applied explicitly below.
// The comparison helper still preserves all constraints, values, options and layout classes.
const beforeInputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';
function BeforeField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
type BeforeUiMode =
  | 'auto'
  | 'manual_percentage'
  | 'voluntary_percentage'
  | 'semi_auto'
  | 'manual_fixed'
  | 'manual_employee_amount'
  | 'manual_employer_amount'
  | 'manual_both_amount'
  | 'none';
const BEFORE_AMOUNT_MODES = {
  manual_employee_amount: { employee: true, employer: false },
  manual_employer_amount: { employee: false, employer: true },
  manual_both_amount: { employee: true, employer: true },
} as const;
const beforeIsAmountMode = (m: BeforeUiMode): m is keyof typeof BEFORE_AMOUNT_MODES => m in BEFORE_AMOUNT_MODES;
function beforeUiModeFrom(
  mode: string | null,
  employeeRate: number | null,
  employerRate: number | null,
  employeeAmount: number | null,
  employerAmount: number | null,
): BeforeUiMode {
  if (mode === 'manual_percentage') return 'manual_percentage';
  if (mode === 'topup_percentage') return 'voluntary_percentage';
  if (mode === 'exempt') return 'none';
  if (mode === 'voluntary_excess') {
    return employeeRate != null && employerRate == null ? 'semi_auto' : 'voluntary_percentage';
  }
  if (mode === 'manual_amount') {
    if (employeeAmount != null && employerAmount != null) return 'manual_both_amount';
    if (employeeAmount != null) return 'manual_employee_amount';
    if (employerAmount != null) return 'manual_employer_amount';
  }
  return 'auto';
}
type EpfProps = {
  mode: string | null;
  employeeRate: number | null;
  employerRate: number | null;
  employeeAmount: number | null;
  employerAmount: number | null;
  manualReason: string | null;
};
function BeforeEpfElection({ mode, employeeRate, employerRate, employeeAmount, employerAmount, manualReason }: EpfProps) {
  const t = useTranslations('people.detail');
  const [m, setM] = useState<BeforeUiMode>(beforeUiModeFrom(mode, employeeRate, employerRate, employeeAmount, employerAmount));
  const showEmployeeRate = m === 'manual_percentage' || m === 'voluntary_percentage' || m === 'semi_auto';
  const showEmployerRate = m === 'manual_percentage' || m === 'voluntary_percentage';
  // b6dbadc5 — Top-up boxes are increments (0 up to 100% less the highest statutory rate) under their own
  // captions; an unconverted legacy total-rate row keeps 0–100 and says why it shows full rates.
  const topup = m === 'voluntary_percentage';
  const legacy = topup && mode === 'voluntary_excess' && employerRate != null;
  const min = (manual: number) => (m === 'manual_percentage' ? 1 : topup ? 0 : manual);
  const max = (cap: string) => (topup && !legacy ? cap : '100');
  const amounts = beforeIsAmountMode(m) ? BEFORE_AMOUNT_MODES[m] : null;
  return (
    <>
      <BeforeField label={t('epfMode')}>
        <select name="epfMode" value={m} onChange={(e) => setM(e.target.value as BeforeUiMode)} className={beforeInputCls}>
          <option value="auto">{t('epfModeAuto')}</option>
          <option value="manual_percentage">{t('epfModeManualPercentage')}</option>
          <option value="voluntary_percentage">{t('epfModeVoluntaryPercentage')}</option>
          <option value="semi_auto">{t('epfModeSemiAuto')}</option>
          <option value="manual_employee_amount">{t('epfModeManualEmployeeAmount')}</option>
          <option value="manual_employer_amount">{t('epfModeManualEmployerAmount')}</option>
          <option value="manual_both_amount">{t('epfModeManualBothAmount')}</option>
          <option value="none">{t('epfModeExempt')}</option>
        </select>
      </BeforeField>
      {(showEmployeeRate || showEmployerRate) && (
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          {showEmployeeRate && (
            <BeforeField label={t(topup ? 'epfTopupEmployeeRate' : 'epfEmployeeRate')}>
              <input name="epfEmployeeRate" aria-invalid="false" type="number" min={min(11)} max={max('89')} step="0.01" required={m === 'manual_percentage'} defaultValue={employeeRate ?? ''} placeholder={topup ? '0' : '11'} className={beforeInputCls} />
            </BeforeField>
          )}
          {showEmployerRate && (
            <BeforeField label={t(topup ? 'epfTopupEmployerRate' : 'epfEmployerRate')}>
              <input name="epfEmployerRate" aria-invalid="false" type="number" min={min(12)} max={max('87')} step="0.01" required={m === 'manual_percentage'} defaultValue={employerRate ?? ''} placeholder={topup ? '0' : '13'} className={beforeInputCls} />
            </BeforeField>
          )}
          {m === 'semi_auto' ? (
            <p className="col-span-2 text-xs text-muted-foreground">{t('epfSemiAutoHint')}</p>
          ) : (
            <p className="col-span-2 text-xs text-muted-foreground">{t(m === 'manual_percentage' ? 'epfManualPercentageHint' : legacy ? 'epfTopupLegacyHint' : 'epfVoluntaryHint')}</p>
          )}
        </div>
      )}
      {amounts && (
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          {amounts.employee && (
            <BeforeField label={t('epfEmployeeAmount')}>
              <input name="epfEmployeeAmount" type="number" min="0" step="0.01" required defaultValue={employeeAmount ?? ''} placeholder="0.00" className={beforeInputCls} />
            </BeforeField>
          )}
          {amounts.employer && (
            <BeforeField label={t('epfEmployerAmount')}>
              <input name="epfEmployerAmount" type="number" min="0" step="0.01" required defaultValue={employerAmount ?? ''} placeholder="0.00" className={beforeInputCls} />
            </BeforeField>
          )}
          <BeforeField label={t('epfManualReason')}>
            <input name="epfManualReason" type="text" maxLength={500} required defaultValue={manualReason ?? ''} className={beforeInputCls} />
          </BeforeField>
          <p className="col-span-2 text-xs text-muted-foreground">{t('epfManualAmountHint')}</p>
        </div>
      )}
    </>
  );
}
function BeforeResidencySelect({ none, taxResidency }: { none: boolean; taxResidency: string }) {
  const t = useTranslations('people.detail');
  const [value, setValue] = useState(taxResidency);
  return (
    <select id="income-tax-resident" aria-label={t('incomeTaxResident')} name="taxResidency" value={none?'none':value} onChange={e=>setValue(e.target.value)} disabled={none} required={!none} className={beforeInputCls}>
      {none&&<option value="none">{t('taxCategoryNone')}</option>}
      <option value="" disabled>{t('taxSelectionChoose')}</option>
      <option value="resident">{t('taxResidencyResident')}</option>
      <option value="non_resident">{t('taxResidencyNonResident')}</option>
      <option value="rep">{t('taxResidencyRep')}</option>
      <option value="knowledge_worker">{t('taxResidencyKnowledgeWorker')}</option>
      <option value="c_suite">{t('taxResidencyCSuite')}</option>
    </select>
  );
}
function AfterResidencySelect({ none, taxResidency }: { none: boolean; taxResidency: string }) {
  const [value, setValue] = useState(taxResidency);
  return <TaxResidencySelect mode="form" none={none} value={value} onChange={setValue} />;
}

describe('§5 the Active EPF election and Income Tax Resident select retain the form contract (form mode)', () => {
  const html = (node: ReactNode, messages: Msgs, locale: string) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={messages}>
        {node}
      </NextIntlClientProvider>,
    );
  // One stored row per category the card can derive, plus a reason with characters that need escaping.
  const EPF_CASES: EpfProps[] = [
    { mode: null, employeeRate: null, employerRate: null, employeeAmount: null, employerAmount: null, manualReason: null },
    { mode: 'auto', employeeRate: null, employerRate: null, employeeAmount: null, employerAmount: null, manualReason: null },
    { mode: 'manual_percentage', employeeRate: 5.5, employerRate: 6.5, employeeAmount: null, employerAmount: null, manualReason: null },
    { mode: 'voluntary_excess', employeeRate: 14.5, employerRate: 16, employeeAmount: null, employerAmount: null, manualReason: null },
    // b6dbadc5 — the additive Top-up mode, both sides and one side blank.
    { mode: 'topup_percentage', employeeRate: 1, employerRate: 1, employeeAmount: null, employerAmount: null, manualReason: null },
    { mode: 'topup_percentage', employeeRate: null, employerRate: 2, employeeAmount: null, employerAmount: null, manualReason: null },
    { mode: 'voluntary_excess', employeeRate: 20, employerRate: null, employeeAmount: null, employerAmount: null, manualReason: null },
    { mode: 'voluntary_excess', employeeRate: null, employerRate: null, employeeAmount: null, employerAmount: null, manualReason: null },
    { mode: 'manual_amount', employeeRate: null, employerRate: null, employeeAmount: 450.5, employerAmount: null, manualReason: 'Pre-1998 "member" & co' },
    { mode: 'manual_amount', employeeRate: null, employerRate: null, employeeAmount: null, employerAmount: 612, manualReason: 'Agreed' },
    { mode: 'manual_amount', employeeRate: null, employerRate: null, employeeAmount: 300, employerAmount: 390.25, manualReason: 'Both' },
    { mode: 'exempt', employeeRate: null, employerRate: null, employeeAmount: null, employerAmount: null, manualReason: null },
  ];
  for (const [loc, msgs] of Object.entries(LOCALES)) {
    it(`${loc}: EpfElection, every derivable category`, () => {
      for (const p of EPF_CASES) {
        const before = html(<BeforeEpfElection {...p} />, msgs as Msgs, loc);
        const after = html(<EpfElection {...p} />, msgs as Msgs, loc);
        expect(before.length, 'the before-markup rendered something').toBeGreaterThan(300);
        expect(personnelMarkupContract(after), `${loc} ${JSON.stringify(p)}`).toBe(personnelMarkupContract(before));
      }
    });
    it(`${loc}: Income Tax Resident, every choice, with and without "Not subject to income tax"`, () => {
      for (const none of [false, true])
        for (const taxResidency of ['', 'resident', 'non_resident', 'rep', 'knowledge_worker', 'c_suite']) {
          const before = html(<BeforeResidencySelect none={none} taxResidency={taxResidency} />, msgs as Msgs, loc);
          const after = html(<AfterResidencySelect none={none} taxResidency={taxResidency} />, msgs as Msgs, loc);
          expect(before.length).toBeGreaterThan(200);
          expect(personnelMarkupContract(after), `${loc} none=${none} ${taxResidency}`).toBe(personnelMarkupContract(before));
        }
    });
  }

  it('the Active EPF card still switches category in place and its boxes post their names', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <EpfElection mode="auto" employeeRate={null} employerRate={null} employeeAmount={null} employerAmount={null} manualReason={null} />
      </NextIntlClientProvider>,
    );
    const d = en.people.detail;
    expect((screen.getByLabelText(d.epfMode) as HTMLSelectElement).getAttribute('name')).toBe('epfMode');
    await userEvent.selectOptions(screen.getByLabelText(d.epfMode), 'manual_employer_amount');
    expect(screen.getByLabelText(personnelCaption(d.epfEmployerAmount)).getAttribute('name')).toBe('epfEmployerAmount');
    expect(screen.getByLabelText(personnelCaption(d.epfManualReason)).getAttribute('name')).toBe('epfManualReason');
    expect(screen.queryByLabelText(d.epfEmployeeAmount)).toBeNull();
  });
});
