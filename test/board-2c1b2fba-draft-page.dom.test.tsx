vi.mock('../components/derived-organisation-fields',()=>({useDerivedOrganisation:()=>({data:{status:'legacy'},loading:false,failed:false}),DerivedOrganisationFields:()=>null}));
/**
 * BOARD 2c1b2fba — THE DRAFT EMPLOYEE PAGE ALIGNED WITH THE ACTIVE EMPLOYEE RECORD, rendered.
 *
 * What the approved plan promises HR, checked on the screen itself (the server half — what Activate writes
 * and refuses — is proven by the coordinator's DB tests):
 *   §1 a Next button walks Profile → Employment → Bank & Statutory → Payroll → Qualification → Family, and
 *      any tab can still be clicked directly, with nothing typed lost on the way;
 *   §2 Payment Method is REQUIRED: blank keeps Activate off and is named as still needed;
 *   §3 the Monthly Allowance box is gone — a legacy amount is shown read-only, with its note;
 *   §4 a legacy single cost centre is shown as one Cost Center Allocation row at 100%;
 *   §5 Emergency contacts: add, edit, remove, one Primary — and the save payload carries the list;
 *   §6 Qualifications: at most one Highest;
 *   §7 Pay items appear only with Payroll on AND a non-empty ready catalogue.
 *
 * next-intl is given the REAL en.json and throws on an unresolved key, so rendering is also the
 * MISSING_MESSAGE check for every new string on these tabs. jsdom: logic and markup only, no layout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { EmployeeDraftData } from '../lib/employee-draft-schema';
import { personnelFormLabel } from '../lib/personnel-form-contract';
import { personnelCaption } from './helpers/personnel-markup';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const saveDraftAction = vi.fn(async () => ({ id: 'draft-1' }));
const createEmployeeAction = vi.fn(async () => ({ ok: true as const, employmentId: 'emp-1' }));
vi.mock('../app/admin/personnel/new/actions', () => ({
  saveDraftAction: (...a: unknown[]) => saveDraftAction(...(a as [])),
  discardDraftAction: vi.fn(async () => ({ ok: true as const })),
  createEmployeeAction: (...a: unknown[]) => createEmployeeAction(...(a as [])),
  uploadDraftPhotoAction: vi.fn(async () => ({ ok: true as const })),
  removeDraftPhotoAction: vi.fn(async () => ({ ok: true as const })),
}));

const { EmployeeWizard } = await import('../app/admin/personnel/new/wizard');

const en = messages;
const detail = en.people.detail;
const wizard = en.people.wizard;
/** A descriptor's caption as the screen renders it, resolved from the real catalogue. */
const label = (id: string) =>
  personnelFormLabel(id, (key, fallback) => {
    const v = key.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k] : undefined), en);
    return typeof v === 'string' ? v : fallback;
  });

const COMPONENTS = [
  { id: 'pc-1', code: 'TRANSPORT', name: 'Transport Allowance' },
  { id: 'pc-2', code: 'PHONE', name: 'Handphone Allowance' },
];
const OPTIONS = {
  companies: [{ id: 'co-1', label: 'Acme Sdn Bhd' }],
  businessUnits: [],
  departments: [{ id: 'dp-1', label: 'Finance', companies: 'co-1', businessUnitId: '', buCompanies: '' }],
  positions: [],
  costCenters: [
    { id: 'cc-1', label: 'CC1 — HQ', companies: 'co-1' },
    { id: 'cc-2', label: 'CC2 — Plant', companies: 'co-1' },
  ],
  grades: [],
  managers: [],
  nationalityOptions: [],
  profileOptions: { salutation: [], religion: [], race: [] },
  relationshipOptions: [],
  countryOptions: [],
  stateOptions: [],
  emergencyRelationshipOptions: [{ value: 'Spouse', label: 'Spouse' }, { value: 'Parent', label: 'Parent' }],
  qualificationLevelOptions: [{ value: 'Degree', label: 'Degree' }, { value: 'Diploma', label: 'Diploma' }],
};

/** Complete except for what each test leaves out. */
const draftOf = (over: Partial<EmployeeDraftData> = {}, payroll: EmployeeDraftData['payroll'] = {}): EmployeeDraftData => ({
  profile: { fullName: 'Nadia Yusof', primaryEmail: 'nadia@acme.test', employeeCode: 'ABC00100' },
  employment: { companyId: 'co-1', departmentId: 'dp-1', employmentType: 'full_time', hiredOn: '2026-09-10' },
  payroll: { basicSalary: '3000', paymentMethod: 'cash', ...payroll },
  ...over,
});

const wrap = (
  data: EmployeeDraftData = draftOf(),
  opts: { initialTab?: string; payrollOn?: boolean; payComponents?: typeof COMPONENTS } = {},
) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EmployeeWizard
        today="2026-09-10"
        draftId="draft-1"
        reservedEmployeeCode="ABC00100"
        initialData={data}
        initialStep={1}
        initialTab={opts.initialTab}
        {...OPTIONS}
        payrollOn={opts.payrollOn ?? false}
        payrollPolicies={[]}
        payComponents={opts.payComponents ?? []}
      />
    </NextIntlClientProvider>,
  );

const tabStrip = () => screen.getByRole('tablist', { name: wizard.progressLabel });
const openTab = async (name: string) => userEvent.click(within(tabStrip()).getByRole('tab', { name }));
const shownPanel = () => {
  const open = ([...document.querySelectorAll('[data-tabpanel]')] as HTMLElement[]).filter((p) => !p.hidden);
  expect(open, 'exactly one panel is shown at a time').toHaveLength(1);
  return open[0];
};
/** Save, then wait until the save has SETTLED: while it is in flight the wizard deliberately disables every
 *  field (fieldset disabled={busy}) and relabels the button "Saving…", so the next edit must not start sooner. */
const save = async () => {
  const calls = saveDraftAction.mock.calls.length;
  await userEvent.click(screen.getByRole('button', { name: wizard.saveDraft }));
  expect(saveDraftAction.mock.calls.length, 'Save Draft called the save action').toBe(calls + 1);
  await waitFor(() => expect((screen.getByRole('button', { name: wizard.saveDraft }) as HTMLButtonElement).disabled).toBe(false));
};
const savedData = () => (saveDraftAction.mock.calls.at(-1) as unknown as [string, EmployeeDraftData, number])[1];
const activateBtn = () => screen.getByRole('button', { name: wizard.activate }) as HTMLButtonElement;
const outstanding = () => screen.queryByText(wizard.activateNeeds)?.parentElement?.textContent ?? '';

beforeEach(() => {
  saveDraftAction.mockClear();
  createEmployeeAction.mockClear();
});

// ── §1 Next, and free tab switching ──────────────────────────────────────────────────────────────────
describe('§1 Next walks the tabs in the agreed order; every tab stays directly reachable', () => {
  it('Next moves Profile → Employment → Bank & Statutory → Payroll → Qualification → Family, and is absent on Family', async () => {
    wrap();
    const order: string[] = [shownPanel().dataset.tabpanel!];
    for (let i = 0; i < 5; i++) {
      await userEvent.click(within(shownPanel()).getByRole('button', { name: wizard.next }));
      order.push(shownPanel().dataset.tabpanel!);
    }
    expect(order).toEqual(['profile', 'job', 'bankStatutory', 'payroll', 'qualification', 'family']);
    expect(within(shownPanel()).queryByRole('button', { name: wizard.next }), 'no Next on the last tab').toBeNull();
    // Navigation only: nothing was saved and nothing was activated on the way.
    expect(saveDraftAction).not.toHaveBeenCalled();
    expect(createEmployeeAction).not.toHaveBeenCalled();
  });

  it('a tab can be clicked out of order, and values typed survive the switch and reach the save', async () => {
    wrap(draftOf({ employment: { companyId: 'co-1', employmentType: 'full_time', hiredOn: '2026-09-10' } }));
    await openTab(detail.tabs.payroll);
    const amount = within(shownPanel()).getByLabelText(personnelCaption(detail.basicSalaryMyr)) as HTMLInputElement;
    await userEvent.clear(amount);
    await userEvent.type(amount, '4500');
    await openTab(detail.tabs.job);
    await userEvent.selectOptions(within(shownPanel()).getByLabelText(personnelCaption(detail.employmentInfo.department)), 'dp-1');
    await openTab(detail.tabs.qualification);
    await openTab(detail.tabs.payroll);
    expect((within(shownPanel()).getByLabelText(personnelCaption(detail.basicSalaryMyr)) as HTMLInputElement).value).toBe('4500');
    await openTab(detail.tabs.job);
    expect((within(shownPanel()).getByLabelText(personnelCaption(detail.employmentInfo.department)) as HTMLSelectElement).value).toBe('dp-1');
    await save();
    expect(savedData().payroll?.basicSalary).toBe('4500');
    expect(savedData().employment?.departmentId).toBe('dp-1');
  });
});

// ── §2 Payment Method is required ─────────────────────────────────────────────────────────────────────
describe('§2 Payment Method blank keeps Activate off and is named as still needed', () => {
  it('blank → listed under Payroll and Activate disabled; Cash → Activate live', async () => {
    wrap(draftOf({}, { paymentMethod: '' }), { initialTab: 'payroll' });
    expect(activateBtn().disabled).toBe(true);
    expect(outstanding()).toContain(detail.tabs.payroll);
    expect(outstanding()).toContain(detail.paymentMethod);
    const select = shownPanel().querySelector('[data-compensation-card] [data-payment-method] select') as HTMLSelectElement;
    expect(select, 'Payment Method sits inside the Basic Salary card').toBeTruthy();
    expect(select.getAttribute('aria-required')).toBe('true');
    await userEvent.selectOptions(select, 'cash');
    expect(activateBtn().disabled).toBe(false);
    expect(outstanding()).not.toContain(detail.paymentMethod);
  });
});

// ── §3 Monthly Allowance ──────────────────────────────────────────────────────────────────────────────
describe('§3 the Monthly Allowance box is gone; a legacy amount is read-only with a note', () => {
  it('a legacy draft shows its amount read-only, with the move-it-to-a-Pay-item note', () => {
    wrap(draftOf({}, { monthlyAllowance: '400' }), { initialTab: 'payroll' });
    const box = shownPanel().querySelector('[data-legacy-monthly-allowance]') as HTMLInputElement;
    expect(box).toBeTruthy();
    expect(box.value).toBe('400');
    expect(box.readOnly).toBe(true);
    expect(box.disabled).toBe(true);
    expect(within(shownPanel()).getByText(wizard.hints.legacyMonthlyAllowance)).toBeTruthy();
  });

  it('a draft without one (or with zero) shows no Monthly Allowance at all', () => {
    const first = wrap(draftOf(), { initialTab: 'payroll' });
    expect(shownPanel().querySelector('[data-legacy-monthly-allowance]')).toBeNull();
    expect(within(shownPanel()).queryByText(wizard.hints.legacyMonthlyAllowance)).toBeNull();
    first.unmount();
    wrap(draftOf({}, { monthlyAllowance: '0' }), { initialTab: 'payroll' });
    expect(shownPanel().querySelector('[data-legacy-monthly-allowance]')).toBeNull();
  });
});

// ── §4 Cost Center Allocation ────────────────────────────────────────────────────────────────────────
describe('§4 a legacy single cost centre reads as one allocation row at 100%', () => {
  it('shows cc-1 at 100, Total 100.00%, and writes the list only when HR changes it', async () => {
    wrap(draftOf({ employment: { companyId: 'co-1', departmentId: 'dp-1', employmentType: 'full_time', hiredOn: '2026-09-10', costCenterId: 'cc-1' } }), { initialTab: 'job' });
    const card = shownPanel().querySelector('[data-draft-cost-allocations]') as HTMLElement;
    expect(within(card).getByText(en.costAllocations.title)).toBeTruthy();
    const rows = card.querySelectorAll('[data-allocation-row]');
    expect(rows).toHaveLength(1);
    expect((rows[0].querySelector('select') as HTMLSelectElement).value).toBe('cc-1');
    expect((rows[0].querySelector('input') as HTMLInputElement).value).toBe('100');
    expect(card.textContent).toContain('100.00');
    expect(card.textContent).toContain(wizard.hints.costAllocationEffective);
    // Saved untouched: the legacy key stays as it was and no list is invented.
    await save();
    expect(savedData().costAllocations).toBeUndefined();
    expect(savedData().employment?.costCenterId).toBe('cc-1');
    // Changed: the whole list is written, and the legacy key is left alone (the server derives the assignment).
    // Re-read the rows: the save re-renders the card.
    const pct = card.ownerDocument.querySelector('[data-draft-cost-allocations] [data-allocation-row] input') as HTMLInputElement;
    await userEvent.clear(pct);
    await userEvent.type(pct, '60');
    await userEvent.click(within(card).getByRole('button', { name: en.costAllocations.add }));
    const second = card.querySelectorAll('[data-allocation-row]')[1];
    await userEvent.selectOptions(second.querySelector('select') as HTMLSelectElement, 'cc-2');
    await userEvent.type(second.querySelector('input') as HTMLInputElement, '50');
    expect(within(card).getByText(en.costAllocations.errors.total)).toBeTruthy();
    expect(outstanding()).toContain(detail.tabs.job);
    await save();
    expect(savedData().costAllocations?.map((r) => [r.costCenterId, r.percentage])).toEqual([['cc-1', '60'], ['cc-2', '50']]);
    expect(savedData().employment?.costCenterId).toBe('cc-1');
  });
});

// ── §5 Emergency contacts ────────────────────────────────────────────────────────────────────────────
describe('§5 emergency contacts round-trip into the save payload, with one Primary', () => {
  const fill = async (dlg: HTMLElement, name: string, priority: string) => {
    const nameBox = within(dlg).getByLabelText(personnelCaption(label('profile.emergency_contact.fullname')));
    await userEvent.clear(nameBox);
    await userEvent.type(nameBox, name);
    await userEvent.selectOptions(within(dlg).getByLabelText(personnelCaption(label('profile.emergency_contact.priority'))), priority);
  };

  it('add, add a second Primary (the first is demoted), edit, delete', async () => {
    wrap();
    const card = () => shownPanel().querySelector('[data-draft-emergency-contacts]') as HTMLElement;
    expect(within(card()).getByText(wizard.sections.emergencyContact)).toBeTruthy();
    expect(within(card()).getByText(detail.emergency.none)).toBeTruthy();

    await userEvent.click(within(card()).getByRole('button', { name: detail.emergency.add }));
    let dlg = screen.getByRole('dialog');
    await fill(dlg, 'Aminah Yusof', 'primary');
    await userEvent.selectOptions(within(dlg).getByLabelText(personnelCaption(label('profile.emergency_contact.relationship'))), 'Parent');
    await userEvent.type(within(dlg).getByLabelText(personnelCaption(label('profile.emergency_contact.mobilephone'))), '+60121112222');
    await userEvent.click(within(dlg).getByRole('button', { name: detail.emergency.add }));

    await userEvent.click(within(card()).getByRole('button', { name: detail.emergency.add }));
    dlg = screen.getByRole('dialog');
    await fill(dlg, 'Hakim Yusof', 'primary');
    await userEvent.click(within(dlg).getByRole('button', { name: detail.emergency.add }));

    await save();
    expect(savedData().emergencyContacts?.map((c) => [c.fullName, c.priority])).toEqual([
      ['Aminah Yusof', 'secondary'],
      ['Hakim Yusof', 'primary'],
    ]);
    expect(savedData().emergencyContacts?.[0]).toMatchObject({ relationship: 'Parent', mobilePhone: '+60121112222' });

    // Edit the first in place.
    await userEvent.click(within(card()).getAllByRole('button', { name: detail.emergency.edit })[0]);
    dlg = screen.getByRole('dialog');
    await fill(dlg, 'Aminah binti Yusof', 'other');
    await userEvent.click(within(dlg).getByRole('button', { name: detail.emergency.save }));
    // Delete the second, after the inline confirmation.
    await userEvent.click(within(card()).getAllByRole('button', { name: detail.emergency.delete })[1]);
    await userEvent.click(within(card()).getByRole('button', { name: wizard.yes }));
    await save();
    expect(savedData().emergencyContacts?.map((c) => [c.fullName, c.priority])).toEqual([['Aminah binti Yusof', 'other']]);
  });

  it('a contact without a name is listed as still needed under Profile', async () => {
    wrap(draftOf({ emergencyContacts: [{ key: 'a', relationship: 'Spouse', priority: 'other' }] }));
    expect(outstanding()).toContain(detail.tabs.profile);
    expect(activateBtn().disabled).toBe(true);
  });
});

// ── §6 Qualifications ────────────────────────────────────────────────────────────────────────────────
describe('§6 the Qualification tab keeps at most one Highest', () => {
  it('ticking Highest on a second record clears it on the first', async () => {
    wrap(draftOf(), { initialTab: 'qualification' });
    const card = () => shownPanel().querySelector('[data-draft-qualifications]') as HTMLElement;
    expect(within(card()).getByText(wizard.sections.qualification)).toBeTruthy();
    const add = async (level: string, institute: string) => {
      await userEvent.click(within(card()).getByRole('button', { name: detail.qualification.add }));
      const dlg = screen.getByRole('dialog');
      await userEvent.selectOptions(within(dlg).getByLabelText(personnelCaption(label('qualification.academic_and_professional_qualifications.level'))), level);
      await userEvent.type(within(dlg).getByLabelText(personnelCaption(label('qualification.academic_and_professional_qualifications.institute'))), institute);
      await userEvent.click(within(dlg).getByLabelText(label('qualification.academic_and_professional_qualifications.highest')));
      await userEvent.click(within(dlg).getByRole('button', { name: detail.qualification.add }));
    };
    await add('Diploma', 'Politeknik');
    await add('Degree', 'Universiti Malaya');
    // The badge on the record row (the table's column heading reads the same word).
    expect(within(card()).getAllByText(detail.qualification.highestBadge).filter((el) => el.tagName !== 'TH')).toHaveLength(1);
    await save();
    expect(savedData().qualifications?.map((q) => [q.qualification, q.institute, q.isHighest])).toEqual([
      ['Diploma', 'Politeknik', false],
      ['Degree', 'Universiti Malaya', true],
    ]);
  });
});

// ── §7 Pay items ─────────────────────────────────────────────────────────────────────────────────────
describe('§7 Pay items appear only with Payroll on and a ready catalogue', () => {
  const payItems = () => shownPanel().querySelector('[data-draft-pay-items]');
  it('payroll off → hidden, even with a catalogue', () => {
    wrap(draftOf(), { initialTab: 'payroll', payrollOn: false, payComponents: COMPONENTS });
    expect(payItems()).toBeNull();
  });
  it('payroll on but an empty ready catalogue → hidden', () => {
    wrap(draftOf(), { initialTab: 'payroll', payrollOn: true, payComponents: [] });
    expect(payItems()).toBeNull();
  });
  it('payroll on with a catalogue → shown, and an added line starts on the Group Join Date', async () => {
    wrap(draftOf(), { initialTab: 'payroll', payrollOn: true, payComponents: COMPONENTS });
    const card = payItems() as HTMLElement;
    expect(within(card).getByText(wizard.sections.payItems)).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: detail.payComponentAdd }));
    const dlg = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dlg).getByLabelText(personnelCaption(label('payroll.pay_items.componentname'))), 'pc-2');
    await userEvent.type(within(dlg).getByLabelText(personnelCaption(label('payroll.pay_items.amount'))), '100');
    await userEvent.click(within(dlg).getByRole('button', { name: detail.payComponentSave }));
    await save();
    expect(savedData().payItems).toEqual([
      expect.objectContaining({ componentId: 'pc-2', amount: '100', currency: 'MYR', effectiveFrom: '2026-09-10' }),
    ]);
    expect(savedData().payItems?.[0].prorate).toBeUndefined();
  });
});
