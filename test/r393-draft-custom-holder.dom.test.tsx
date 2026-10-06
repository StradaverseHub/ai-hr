/**
 * r393 — item 685d2380 STEP 3a, the draft's custom payment holder ON THE SCREEN, and the Active profile's
 * Bank Information card unchanged.
 *
 * test/r393-draft-custom-holder.test.ts proves what lands at Activate and what is refused before anything is
 * created. This file proves what HR SEES:
 *   §1 the two ticks render on the draft's Bank & Statutory tab in all six locales under the Active card's
 *      own words, with ZERO next-intl errors (every MISSING_MESSAGE / FORMATTING_ERROR is collected through
 *      `onError` and asserted empty), and a ticked blank box is named on the still-needed list;
 *   §2 ticking opens the box, typing writes the draft's keys, un-ticking closes it; Activate is held back
 *      while a ticked box is blank; controlled mode posts nothing by itself;
 *   §3 FORM-MODE PARITY: the Active Bank Information card, rendered through the shared group, produces the
 *      card's markup from BEFORE the extraction, byte for byte. The "before" JSX is copied verbatim below
 *      from components/bank-info-card.tsx at build/r393-statutory@6c9b3f5c, so a change to the Active
 *      card made through the shared component fails here instead of drifting silently.
 *
 * jsdom applies no CSS and computes no layout: rendering and interaction logic only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
import { BankAccountFields } from '../components/bank-account-fields';
import { BankInfoCard, type BankInfoDefaults } from '../components/bank-info-card';
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
const holder = () => shownPanel().querySelector('[data-custom-holder]') as HTMLElement | null;
const tickBox = (label: string) => within(holder()!).getByLabelText(label) as HTMLInputElement;
const valueBox = (label: string) => within(holder()!).queryByLabelText(label) as HTMLInputElement | null;
const savedData = () => (saveDraftAction.mock.calls.at(-1) as unknown as [string, EmployeeDraftData, number])[1];
/** The still-needed list's line for the Bank & Statutory tab, or null when the tab owes nothing. */
const bankStatutoryNeeds = (m: Msgs) =>
  ([...document.querySelectorAll('li')] as HTMLElement[]).find((li) =>
    li.querySelector('button')?.textContent === m.people.wizard.tabs.bankStatutory,
  ) ?? null;
const activate = () => screen.getByRole('button', { name: en.people.wizard.activate }) as HTMLButtonElement;

beforeEach(() => {
  saveDraftAction.mockClear();
  intlErrors = [];
});

// ── §1 six locales ───────────────────────────────────────────────────────────────────────────────────
describe('§1 the custom holder ticks render on the draft in all six locales, with zero missing messages', () => {
  for (const [loc, msgs] of Object.entries(LOCALES)) {
    it(`${loc}: the Active card's words, and a ticked blank box named as still needed`, () => {
      const m = msgs as Msgs;
      const d = m.people.detail;
      const { unmount } = wrap(draftOf(), { messages: m, locale: loc });
      expect(holder(), `${loc} the holder group is on the Bank & Statutory tab`).toBeTruthy();
      const h = within(holder()!);
      expect(h.getByText(d.customHolderTitle), `${loc} customHolderTitle`).toBeTruthy();
      expect(h.getByText(d.customHolderHint), `${loc} customHolderHint`).toBeTruthy();
      expect(tickBox(d.enableCustomHolderName).checked, `${loc} name tick opens off`).toBe(false);
      expect(tickBox(d.enableCustomHolderId).checked, `${loc} id tick opens off`).toBe(false);
      expect(valueBox(d.customHolderName), `${loc} no name box while un-ticked`).toBeNull();
      expect(bankStatutoryNeeds(m), `${loc} nothing owed on the tab`).toBeNull();
      unmount();

      wrap(draftOf({ enableCustomHolderName: 'yes', enableCustomHolderId: 'yes', customHolderId: 'A1' }), {
        messages: m,
        locale: loc,
      });
      expect(valueBox(d.customHolderName), `${loc} the ticked name box is open`).toBeTruthy();
      expect(valueBox(d.customHolderId)!.value, `${loc} the stored id is shown`).toBe('A1');
      const line = bankStatutoryNeeds(m);
      expect(line, `${loc} the tab is on the still-needed list`).toBeTruthy();
      expect(line!.textContent, `${loc} fields.customHolderName`).toContain(m.people.wizard.fields.customHolderName);
      expect(line!.textContent, `${loc} the filled id is not owed`).not.toContain(m.people.wizard.fields.customHolderId);
      // The still-needed label IS the Active card's own label for the box.
      expect(m.people.wizard.fields.customHolderName).toBe(d.customHolderName);
      expect(m.people.wizard.fields.customHolderId).toBe(d.customHolderId);
      expect(intlErrors.map((e) => `${e.code}: ${e.message}`), `${loc} next-intl errors`).toEqual([]);
    });
  }
});

// ── §2 the controls write the draft ─────────────────────────────────────────────────────────────────
describe('§2 ticking opens the box and the draft keeps what was typed', () => {
  const d = en.people.detail;

  it('tick → box opens → type → Save writes the four keys; un-tick closes the box', async () => {
    wrap(draftOf({ bankName: 'Maybank', bankAccountNo: '5123' }));
    expect(valueBox(d.customHolderName)).toBeNull();
    await userEvent.click(tickBox(d.enableCustomHolderName));
    expect(valueBox(d.customHolderName), 'ticking opens the name box').toBeTruthy();
    await userEvent.type(valueBox(d.customHolderName)!, 'Siti Spouse');
    await userEvent.click(tickBox(d.enableCustomHolderId));
    await userEvent.type(valueBox(d.customHolderId)!, '910202025050');
    await userEvent.click(screen.getByRole('button', { name: en.people.wizard.saveDraft }));
    const s = savedData().statutory!;
    expect(s.enableCustomHolderName, 'data.statutory.enableCustomHolderName').toBe('yes');
    expect(s.customHolderName, 'data.statutory.customHolderName').toBe('Siti Spouse');
    expect(s.enableCustomHolderId, 'data.statutory.enableCustomHolderId').toBe('yes');
    expect(s.customHolderId, 'data.statutory.customHolderId').toBe('910202025050');
    await userEvent.click(tickBox(d.enableCustomHolderId));
    expect(valueBox(d.customHolderId), 'un-ticking closes the box').toBeNull();
    await userEvent.click(screen.getByRole('button', { name: en.people.wizard.saveDraft }));
    expect(savedData().statutory!.enableCustomHolderId, 'the un-tick is stored').toBe('no');
  });

  it('a ticked blank box holds Activate back by name; filling it releases it', async () => {
    wrap(draftOf());
    expect(activate().disabled, 'a complete draft can be activated').toBe(false);
    await userEvent.click(tickBox(d.enableCustomHolderName));
    expect(bankStatutoryNeeds(en)?.textContent ?? '', 'still needed').toContain(en.people.wizard.fields.customHolderName);
    expect(activate().disabled, 'Activate held back').toBe(true);
    await userEvent.type(valueBox(d.customHolderName)!, 'Siti');
    expect(bankStatutoryNeeds(en), 'nothing owed once filled').toBeNull();
    expect(activate().disabled).toBe(false);
  });

  it('controlled mode posts nothing by itself — no `name` on any of the four inputs', () => {
    wrap(draftOf({ enableCustomHolderName: 'yes', enableCustomHolderId: 'yes' }));
    for (const el of holder()!.querySelectorAll('input')) expect(el.getAttribute('name')).toBeNull();
    expect(holder()!.querySelectorAll('input')).toHaveLength(4);
  });
});

// ── §3 form-mode parity with the Active card ────────────────────────────────────────────────────────
// Verbatim from components/bank-info-card.tsx BEFORE r393 step 3a (comments dropped; markup unchanged).
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
function BeforeBankInfoCard({
  action,
  employmentId,
  personId,
  defaults,
}: {
  action: (formData: FormData) => void | Promise<void>;
  employmentId: string;
  personId: string;
  defaults: BankInfoDefaults;
}) {
  const t = useTranslations('people.detail');
  const [enableName, setEnableName] = useState(defaults.enableCustomHolderName);
  const [enableId, setEnableId] = useState(defaults.enableCustomHolderId);
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{t('bankCardTitle')}</h3>
      </div>
      <form action={action} data-save-section="bank" className="flex flex-col gap-6 p-4">
        <input type="hidden" name="employmentId" value={employmentId} />
        <input type="hidden" name="personId" value={personId} />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('bankGroupEmployee')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <BankAccountFields
              mode="form"
              bankName={defaults.bankName}
              bankAccountNo={defaults.bankAccountNo}
            />
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <legend className="-ml-1 rounded-md bg-card px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground">
            {t('customHolderTitle')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('customHolderHint')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="enableCustomHolderName"
                  checked={enableName}
                  onChange={(e) => setEnableName(e.target.checked)}
                  className="size-4 rounded"
                />
                {t('enableCustomHolderName')}
              </label>
              {enableName && (
                <BeforeField label={t('customHolderName')}>
                  <input
                    name="customHolderName"
                    required
                    defaultValue={defaults.customHolderName ?? ''}
                    className={beforeInputCls}
                  />
                </BeforeField>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="enableCustomHolderId"
                  checked={enableId}
                  onChange={(e) => setEnableId(e.target.checked)}
                  className="size-4 rounded"
                />
                {t('enableCustomHolderId')}
              </label>
              {enableId && (
                <BeforeField label={t('customHolderId')}>
                  <input
                    name="customHolderId"
                    required
                    defaultValue={defaults.customHolderId ?? ''}
                    className={beforeInputCls}
                  />
                </BeforeField>
              )}
            </div>
          </div>
        </fieldset>

      </form>
    </div>
  );
}

describe('§3 the Active Bank Information card renders byte-identically through the shared group (form mode)', () => {
  const action = async () => {};
  const html = (node: ReactNode, messages: Msgs, locale: string) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={messages}>
        {node}
      </NextIntlClientProvider>,
    );
  const CASES: BankInfoDefaults[] = [];
  for (const enableCustomHolderName of [false, true])
    for (const enableCustomHolderId of [false, true])
      for (const filled of [false, true])
        CASES.push({
          bankName: filled ? 'Maybank' : null,
          bankAccountNo: filled ? '512345678901' : null,
          enableCustomHolderName,
          customHolderName: filled ? 'Siti "Spouse" & Co' : null,
          enableCustomHolderId,
          customHolderId: filled ? '910202025050' : null,
        });

  for (const [loc, msgs] of Object.entries(LOCALES)) {
    it(`${loc}: every tick combination, filled and empty`, () => {
      for (const defaults of CASES) {
        const props = { action, employmentId: 'emp-1', personId: 'per-1', defaults };
        const before = html(<BeforeBankInfoCard {...props} />, msgs as Msgs, loc);
        const after = html(<BankInfoCard {...props} />, msgs as Msgs, loc);
        expect(before.length, 'the before-markup rendered something').toBeGreaterThan(1000);
        expect(after, `${loc} ${JSON.stringify(defaults)}`).toBe(before);
      }
    });
  }

  it('the Active card still lets a tick open its box (form mode keeps its own state)', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <BankInfoCard
          action={action}
          employmentId="emp-1"
          personId="per-1"
          defaults={{
            bankName: null,
            bankAccountNo: null,
            enableCustomHolderName: false,
            customHolderName: null,
            enableCustomHolderId: false,
            customHolderId: null,
          }}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByLabelText(en.people.detail.customHolderName)).toBeNull();
    await userEvent.click(screen.getByLabelText(en.people.detail.enableCustomHolderName));
    const box = screen.getByLabelText(en.people.detail.customHolderName) as HTMLInputElement;
    expect(box.getAttribute('name'), 'the form-mode box posts its name').toBe('customHolderName');
    expect(box.required).toBe(true);
  });
});
