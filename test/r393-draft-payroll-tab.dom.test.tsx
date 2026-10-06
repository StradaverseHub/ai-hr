/**
 * r393 — item 685d2380 STEP 2, the draft's Payroll tab ON THE SCREEN, and the Personnel record's two
 * controls unchanged.
 *
 * test/r393-draft-payroll-tab.test.ts proves what lands at Activate and what is refused before anything is
 * created. This file proves what HR SEES:
 *   §1 both new fields render in all six locales under the record's own words, with ZERO next-intl errors
 *      (every MISSING_MESSAGE / FORMATTING_ERROR is collected through `onError` and asserted empty);
 *   §2 Payroll switched off → the Payroll Policy card is absent, Payment Method still present;
 *   §3 the controls write the draft's keys, and Bank Transfer with no bank holds Activate back by name;
 *   §4 FORM-MODE PARITY: the shared field groups, rendered the way the Personnel record renders them,
 *      produce the record's markup from BEFORE the extraction, byte for byte. The "before" JSX is copied
 *      verbatim below from app/admin/personnel/[employmentId]/page.tsx at main@0b4df304, so a change to the
 *      record's control made through the shared component fails here instead of drifting silently.
 *
 * jsdom applies no CSS and computes no layout: rendering and interaction logic only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NextIntlClientProvider, useTranslations, type IntlError } from 'next-intl';
import type { ReactNode } from 'react';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import type { EmployeeDraftData } from '../lib/employee-draft-schema';
import { PAYMENT_METHODS } from '../lib/payment-methods';
import { Field, inputCls } from '../components/ui';
import { PaymentMethodField } from '../components/payment-method-field';
import { PayrollPolicyField } from '../components/payroll-policy-field';
import { todayInKualaLumpur } from '../lib/hr-date';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const saveDraftAction = vi.fn(async () => ({ id: 'draft-1' }));
vi.mock('../app/admin/personnel/new/actions', () => ({
  saveDraftAction: (...a: unknown[]) => saveDraftAction(...(a as [])),
  discardDraftAction: vi.fn(async () => {}),
  createEmployeeAction: vi.fn(async () => ({ employmentId: 'emp-1' })),
}));

const { EmployeeWizard } = await import('../app/admin/personnel/new/wizard');

const root = fileURLToPath(new URL('..', import.meta.url));
const LOCALES = { en, ms, zh, ta, th, vi: vi_ } as const;
type Msgs = typeof en;

const POLICIES = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Monthly Staff' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Sales Commission' },
];

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

const draftOf = (
  payroll: EmployeeDraftData['payroll'] = {},
  statutory: EmployeeDraftData['statutory'] = {},
): EmployeeDraftData => ({
  profile: { fullName: 'Nadia Yusof', primaryEmail: 'nadia@acme.test', employeeCode: 'ABC00100' },
  employment: { companyId: 'co-1', departmentId: 'dp-1', employmentType: 'full_time', hiredOn: today },
  statutory,
  payroll: { basicSalary: '3000', ...payroll },
});

let intlErrors: IntlError[] = [];
const wrap = (
  data: EmployeeDraftData,
  opts: { messages?: Msgs; locale?: string; payrollOn?: boolean; policies?: typeof POLICIES } = {},
) =>
  render(
    <NextIntlClientProvider
      locale={opts.locale ?? 'en'}
      messages={opts.messages ?? en}
      onError={(e) => intlErrors.push(e)}
    >
      <EmployeeWizard
        today={today}
        draftId="draft-1"
        reservedEmployeeCode="ABC00100"
        initialData={data}
        initialStep={4}
        initialTab="payroll"
        {...OPTIONS}
        payrollOn={opts.payrollOn ?? true}
        payrollPolicies={opts.policies ?? POLICIES}
      />
    </NextIntlClientProvider>,
  );

const shownPanel = () => {
  const open = ([...document.querySelectorAll('[data-tabpanel]')] as HTMLElement[]).filter((p) => !p.hidden);
  expect(open, 'exactly one panel is shown at a time').toHaveLength(1);
  return open[0];
};
const paymentSelect = () => shownPanel().querySelector('[data-payment-method] select') as HTMLSelectElement | null;
const policySelect = () => shownPanel().querySelector('[data-payroll-policy] select') as HTMLSelectElement | null;
const savedData = () => (saveDraftAction.mock.calls.at(-1) as unknown as [string, EmployeeDraftData, number])[1];
const optionTexts = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.textContent);

beforeEach(() => {
  saveDraftAction.mockClear();
  intlErrors = [];
});

// ── §1 six locales ───────────────────────────────────────────────────────────────────────────────────
describe('§1 both fields render in all six locales, with zero missing messages', () => {
  for (const [loc, msgs] of Object.entries(LOCALES)) {
    it(`${loc}: Payment Method and Payroll Policy under the record's own words`, () => {
      const m = msgs as Msgs;
      const { unmount } = wrap(draftOf(), { messages: m, locale: loc });
      const panel = within(shownPanel());
      // The two new cards carry the record's headings.
      expect(panel.getByText(m.people.wizard.sections.payMethodGroup), `${loc} sections.payMethodGroup`).toBeTruthy();
      expect(m.people.wizard.sections.payMethodGroup).toBe(m.people.detail.payMethodGroup);
      expect(panel.getByText(m.people.wizard.sections.payrollPolicy), `${loc} sections.payrollPolicy`).toBeTruthy();
      expect(m.people.wizard.sections.payrollPolicy).toBe(m.payrollPolicy.assignTitle);
      // Payment Method: the record's caption and the record's four answers, in order.
      expect(panel.getByText(m.people.detail.paymentMethod), `${loc} paymentMethod caption`).toBeTruthy();
      const pay = paymentSelect();
      expect(pay, `${loc} payment method select`).toBeTruthy();
      expect(optionTexts(pay!)).toEqual([
        m.people.detail.paymentMethodNotSet,
        m.people.detail.paymentMethod_bank_transfer,
        m.people.detail.paymentMethod_cheque,
        m.people.detail.paymentMethod_cash,
      ]);
      expect([...pay!.options].map((o) => o.value)).toEqual(['', ...PAYMENT_METHODS]);
      expect(panel.getByText(m.people.wizard.hints.paymentMethodBankTransfer), `${loc} bank hint`).toBeTruthy();
      // Payroll Policy: Monthly default first, then the company's policies.
      expect(panel.getByText(m.payrollPolicy.assignLabel), `${loc} assignLabel`).toBeTruthy();
      expect(optionTexts(policySelect()!)).toEqual([m.payrollPolicy.assignNone, 'Monthly Staff', 'Sales Commission']);
      expect(panel.getByText(m.payrollPolicy.assignHint), `${loc} assignHint`).toBeTruthy();
      expect(intlErrors.map((e) => `${e.code}: ${e.message}`), `${loc} next-intl errors`).toEqual([]);
      unmount();
    });

    it(`${loc}: Bank Transfer with no bank names the gap above Activate, with zero missing messages`, () => {
      const m = msgs as Msgs;
      const { unmount } = wrap(draftOf({ paymentMethod: 'bank_transfer' }), { messages: m, locale: loc });
      expect(screen.getByText(m.people.wizard.fields.paymentMethodBank, { exact: false }), `${loc} fields.paymentMethodBank`)
        .toBeTruthy();
      // A stale policy id is shown as unavailable rather than silently as the default.
      unmount();
      wrap(draftOf({ payrollPolicyId: '33333333-3333-4333-8333-333333333333' }), { messages: m, locale: loc });
      expect(optionTexts(policySelect()!)).toContain(m.payrollPolicy.assignUnavailable);
      expect(intlErrors.map((e) => `${e.code}: ${e.message}`), `${loc} next-intl errors`).toEqual([]);
    });
  }
});

// ── §2 Payroll switched off ─────────────────────────────────────────────────────────────────────────
describe('§2 the Payroll Policy picker appears only where Payroll is switched on', () => {
  it('payroll off: no policy card, no policy select; Payment Method still there', () => {
    wrap(draftOf({ payrollPolicyId: POLICIES[0].id }), { payrollOn: false, policies: [] });
    const panel = within(shownPanel());
    expect(panel.queryByText(en.people.wizard.sections.payrollPolicy), 'policy card heading').toBeNull();
    expect(panel.queryByText(en.payrollPolicy.assignLabel), 'policy caption').toBeNull();
    expect(policySelect(), 'policy select').toBeNull();
    expect(paymentSelect(), 'payment method select').toBeTruthy();
  });
});

// ── §3 the controls write the draft ─────────────────────────────────────────────────────────────────
describe('§3 the controls write the draft, and Bank Transfer without a bank holds Activate back', () => {
  it('a pick on each control is written to data.payroll.paymentMethod / payrollPolicyId', async () => {
    wrap(draftOf());
    expect(paymentSelect()!.value, 'opens on Not specified').toBe('');
    expect(policySelect()!.value, 'opens on the Monthly default').toBe('');
    await userEvent.selectOptions(paymentSelect()!, 'cheque');
    await userEvent.selectOptions(policySelect()!, POLICIES[1].id);
    await userEvent.click(screen.getByRole('button', { name: en.people.wizard.saveDraft }));
    expect(savedData().payroll?.paymentMethod, 'data.payroll.paymentMethod').toBe('cheque');
    expect(savedData().payroll?.payrollPolicyId, 'data.payroll.payrollPolicyId').toBe(POLICIES[1].id);
  });

  it('a stored pick is shown, not reset', () => {
    wrap(draftOf({ paymentMethod: 'cash', payrollPolicyId: POLICIES[0].id }));
    expect(paymentSelect()!.value).toBe('cash');
    expect(policySelect()!.value).toBe(POLICIES[0].id);
  });

  it('choosing Bank Transfer with no bank lists it as still needed and disables Activate; a bank clears it', async () => {
    const activate = () => screen.getByRole('button', { name: en.people.wizard.activate }) as HTMLButtonElement;
    const { unmount } = wrap(draftOf());
    expect(activate().disabled, 'a complete draft can be activated').toBe(false);
    await userEvent.selectOptions(paymentSelect()!, 'bank_transfer');
    expect(screen.getByText(en.people.wizard.fields.paymentMethodBank, { exact: false })).toBeTruthy();
    expect(activate().disabled, 'Activate held back').toBe(true);
    unmount();
    wrap(draftOf({ paymentMethod: 'bank_transfer' }, { bankName: 'Maybank', bankAccountNo: '5123' }));
    expect(screen.queryByText(en.people.wizard.fields.paymentMethodBank, { exact: false })).toBeNull();
    expect(activate().disabled).toBe(false);
  });

  it('controlled mode posts nothing by itself — no `name` on either select', () => {
    wrap(draftOf());
    expect(paymentSelect()!.getAttribute('name')).toBeNull();
    expect(policySelect()!.getAttribute('name')).toBeNull();
  });
});

// ── §4 form-mode parity with the record ─────────────────────────────────────────────────────────────
/** The record's Payment Method markup BEFORE r393, verbatim from page.tsx (inside its <form>). */
function BeforePaymentMethod({ paymentMethod, terminatedOn }: { paymentMethod: string | null; terminatedOn: string | null }) {
  const t = useTranslations('people.detail');
  return (
    <>
      <span className="text-xs font-medium text-muted-foreground">{t('paymentMethod')}</span>
      <div className="flex gap-2">
        <select
          name="paymentMethod"
          defaultValue={paymentMethod ?? ''}
          disabled={!!terminatedOn}
          className={inputCls}
        >
          <option value="">{t('paymentMethodNotSet')}</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`paymentMethod_${m}` as 'paymentMethod_bank_transfer')}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
/** The record's Payroll Policy markup BEFORE r393, verbatim from page.tsx (inside its <form>). */
function BeforePolicy({ payrollPolicyId, assignablePolicies }: { payrollPolicyId: string | null; assignablePolicies: typeof POLICIES }) {
  const tp = useTranslations('payrollPolicy');
  return (
    <Field label={tp('assignLabel')}>
      <select name="policyId" defaultValue={payrollPolicyId ?? ''} className={inputCls}>
        <option value="">{tp('assignNone')}</option>
        {assignablePolicies.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </Field>
  );
}

describe('§4 the Personnel record renders byte-identically through the shared field groups (form mode)', () => {
  const html = (node: ReactNode, messages: Msgs = en, locale = 'en') =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={messages}>
        {node}
      </NextIntlClientProvider>,
    );

  for (const [loc, msgs] of Object.entries(LOCALES)) {
    it(`${loc}: Payment Method — every stored value, active and terminated`, () => {
      for (const paymentMethod of [null, '', ...PAYMENT_METHODS]) {
        for (const terminatedOn of [null, '2026-01-31']) {
          const before = html(<BeforePaymentMethod paymentMethod={paymentMethod} terminatedOn={terminatedOn} />, msgs as Msgs, loc);
          const after = html(
            <PaymentMethodField mode="form" defaultValue={paymentMethod} disabled={!!terminatedOn} />,
            msgs as Msgs,
            loc,
          );
          expect(before.length, 'the before-markup rendered something').toBeGreaterThan(200);
          expect(after, `${loc} paymentMethod=${paymentMethod} terminated=${!!terminatedOn}`).toBe(before);
        }
      }
    });

    it(`${loc}: Payroll Policy — no policy, a listed one, an unlisted one, an empty list`, () => {
      for (const assignablePolicies of [POLICIES, []]) {
        for (const payrollPolicyId of [null, POLICIES[0].id, '99999999-9999-4999-8999-999999999999']) {
          const before = html(<BeforePolicy payrollPolicyId={payrollPolicyId} assignablePolicies={assignablePolicies} />, msgs as Msgs, loc);
          const after = html(
            <PayrollPolicyField mode="form" defaultValue={payrollPolicyId} policies={assignablePolicies} />,
            msgs as Msgs,
            loc,
          );
          expect(before.length, 'the before-markup rendered something').toBeGreaterThan(100);
          expect(after, `${loc} policy=${payrollPolicyId} n=${assignablePolicies.length}`).toBe(before);
        }
      }
    });
  }

  it('the record\'s page renders the shared groups in form mode, with the arguments it used to inline', () => {
    const page = readFileSync(root + 'app/admin/personnel/[employmentId]/page.tsx', 'utf8');
    expect(page).toContain('<PaymentMethodField mode="form" defaultValue={emp.paymentMethod} disabled={!!emp.terminatedOn} />');
    expect(page).toContain('<PayrollPolicyField mode="form" defaultValue={emp.payrollPolicyId} policies={assignablePolicies} />');
    // …and no second copy of either select survives beside them.
    expect(page).not.toContain('name="paymentMethod"');
    expect(page).not.toContain('name="policyId"');
  });
});
