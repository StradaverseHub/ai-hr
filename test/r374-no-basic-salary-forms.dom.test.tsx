/**
 * r374 (item 7dbaf677) — THE TWO SALARY FORMS, ON SCREEN. A KEY IS NOT A SCREEN (CLAUDE.md §8).
 *
 * The node suite beside this one proves the RULE and reads the markup from source. Neither can see
 * whether the conditional half is actually wired: the asterisk on Remarks, the asterisks on Pay Mode and
 * Payment Term, the hint, and — the one that matters most to the reporter — whether **Activate** really
 * lets go once the reason is typed. A `markRequired` prop passed to a component that ignores it, or a
 * hint rendered on a tab nobody can reach, passes tsc, the suite, `next build` and every source grep.
 *
 * SO THIS FILE DOES WHAT HR DOES: it opens the draft at the Payroll tab, clears the amount, looks at what
 * appeared, types the reason, and watches the button come alive. Then it opens the Personnel screen's
 * salary EDIT dialog and clears the amount there, which is the half the item's first plan never named.
 *
 * `NextIntlClientProvider` is given the REAL en.json and next-intl THROWS on an unresolved key rather
 * than painting one, so every new string is a MISSING_MESSAGE check by the act of rendering it.
 *
 * Scope note, inherited from the other .dom tests: jsdom applies no CSS and computes no layout, so this
 * catches rendering and interaction logic, not a visual regression, and it is not a substitute for the
 * dev-server render check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { EmployeeDraftData } from '../lib/employee-draft-schema';
import { SalaryHistoryTable, type SalaryRowView } from '../components/salary-history-table';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const saveDraftAction = vi.fn(async () => ({ id: 'draft-1' }));
const discardDraftAction = vi.fn(async () => {});
const createEmployeeAction = vi.fn(async () => ({ employmentId: 'emp-1' }));
vi.mock('../app/admin/personnel/new/actions', () => ({
  saveDraftAction: (...a: unknown[]) => saveDraftAction(...(a as [])),
  discardDraftAction: (...a: unknown[]) => discardDraftAction(...(a as [])),
  createEmployeeAction: (...a: unknown[]) => createEmployeeAction(...(a as [])),
}));

// The compensation server actions — a 'use server' module that reaches Postgres on import. Their
// behaviour is proved against a real database in the node suite beside this file.
vi.mock('../app/admin/personnel/[employmentId]/actions', () => ({
  editCompensationAction: vi.fn(),
  supersedeCompensationAction: vi.fn(),
}));

const { EmployeeWizard } = await import('../app/admin/personnel/new/wizard');

const wizard = messages.people.wizard;
const detail = messages.people.detail;

const OPTIONS = {
  companies: [{ id: 'co-1', label: 'Acme Sdn Bhd' }],
  businessUnits: [{ id: 'bu-1', label: 'BU1 — Operations', companies: 'co-1' }],
  departments: [{ id: 'dp-1', label: 'Finance', companies: 'co-1', businessUnitId: 'bu-1', buCompanies: 'co-1' }],
  positions: [{ id: 'ps-1', label: 'Director', companies: 'co-1' }],
  costCenters: [{ id: 'cc-1', label: 'CC1 — HQ', companies: 'co-1' }],
  grades: [{ id: 'gr-1', label: 'G9' }],
  managers: [{ id: 'mg-1', label: 'Aisha Rahman (E0001)' }],
  nationalityOptions: [{ value: 'Malaysian', label: 'Malaysian' }],
  profileOptions: {
    salutation: [{ value: 'Datuk', label: 'Datuk' }],
    religion: [{ value: 'Islam', label: 'Islam' }],
    race: [{ value: 'Malay', label: 'Malay' }],
  },
  relationshipOptions: [{ value: 'spouse', label: 'Spouse' }],
  countryOptions: [{ value: 'Malaysia', label: 'Malaysia' }],
  stateOptions: [{ value: 'Selangor', label: 'Selangor' }],
};

/**
 * A draft that is COMPLETE EXCEPT FOR THE PAYROLL TAB. Every other tab's rule is satisfied, so the
 * Activate button's state is a statement about the salary box alone — which is the whole question.
 */
const nearlyDone = (payroll: EmployeeDraftData['payroll'] = {}): EmployeeDraftData => ({
  profile: { fullName: 'Datuk Rahim', primaryEmail: 'rahim@acme.test', employeeCode: 'ABC00100' },
  employment: { companyId: 'co-1', departmentId: 'dp-1', employmentType: 'full_time', hiredOn: '2026-09-10' },
  payroll,
});

const wrap = (data: EmployeeDraftData) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EmployeeWizard
        today="2026-09-10"
        draftId="draft-1"
        reservedEmployeeCode="ABC00100"
        initialData={data}
        /* 4 is the Payroll tab's stored step number (employee-draft-schema DRAFT_TABS), so the screen
           opens on the tab under test rather than needing a click to reach it. */
        initialStep={4}
        {...OPTIONS}
      />
    </NextIntlClientProvider>,
  );

const shownPanel = () => {
  const open = ([...document.querySelectorAll('[data-tabpanel]')] as HTMLElement[]).filter((p) => !p.hidden);
  expect(open, 'exactly one panel is shown at a time').toHaveLength(1);
  return open[0];
};
/**
 * A control on the open tab, found by the START of its label.
 *
 * ANCHORED AT THE START RATHER THAN MATCHED WHOLE, because the required asterisk this round adds lives
 * INSIDE the label's text span — so the accessible name of a starred field is "Remarks*" and an exact
 * match stops finding it the moment the feature works. That is not a reason to loosen the query to a
 * substring: `^` keeps "Remarks" from matching some other field that merely ends in it.
 */
const field = (label: string) => {
  const re = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return within(shownPanel()).getByLabelText(re) as HTMLInputElement;
};
const activateBtn = () => screen.getByRole('button', { name: wizard.activate }) as HTMLButtonElement;
/** The whole "Activate still needs:" box — the heading's PARENT, which is what holds the list. */
const outstandingBox = () => {
  const heading = screen.getByText(wizard.activateNeeds).closest('div');
  expect(heading, 'the outstanding heading is not in a div').toBeTruthy();
  const box = heading!.parentElement;
  expect(box, 'the outstanding heading has no containing box').toBeTruthy();
  expect(box!.querySelector('ul'), 'the outstanding box holds no list').toBeTruthy();
  return box as HTMLElement;
};

/** The `<span>` holding a control's label text — where the required asterisk is drawn. */
const labelTextOf = (control: HTMLElement): HTMLElement => {
  const wrapper = control.closest('label');
  expect(wrapper, 'the control is not inside a <label>').toBeTruthy();
  const span = wrapper!.querySelector('span');
  expect(span, 'the label carries no text span').toBeTruthy();
  return span as HTMLElement;
};
const starred = (control: HTMLElement) =>
  labelTextOf(control).querySelectorAll(`[aria-label="${wizard.requiredField}"]`).length > 0;

beforeEach(() => {
  saveDraftAction.mockClear();
});

describe('the Create New Employee Payroll tab', () => {
  it('opens on Payroll, and the amount box no longer has a floor above zero', () => {
    wrap(nearlyDone({ basicSalary: '5200' }));
    expect(within(shownPanel()).getByText(wizard.sections.compensation)).toBeTruthy();
    const amount = field(wizard.fields.basicSalary);
    // `min="0.01"` was the only such floor on a basic salary in the tree, and it is what held Activate
    // off until somebody invented a figure for a Director paid quarterly fees.
    expect(amount.getAttribute('min')).toBe('0');
    expect(amount.required).toBe(false);
    expect(amount.placeholder).toBe(wizard.fields.basicSalaryBlankPlaceholder);
  });

  it('with an amount typed, NOTHING is asked for and Activate is live — the unchanged case', () => {
    wrap(nearlyDone({ basicSalary: '5200' }));
    expect(starred(field(wizard.fields.remarks)), 'Remarks must not be starred for a paid employee').toBe(
      false,
    );
    expect(within(shownPanel()).queryByText(wizard.hints.noBasicSalary)).toBeNull();
    expect(activateBtn().disabled).toBe(false);
    // Pay Mode and Payment Term carry no asterisk either: nothing new is asked of HR here.
    expect(starred(field(detail.payMode))).toBe(false);
    expect(starred(field(detail.paymentTerm))).toBe(false);
  });

  it('CLEARING the amount asks for the reason, in place, and names Pay Mode and Payment Term', async () => {
    const user = userEvent.setup();
    wrap(nearlyDone({ basicSalary: '5200' }));
    await user.clear(field(wizard.fields.basicSalary));

    // The reporter's own sentence, on the tab, the moment the box goes empty — not after a refused save.
    expect(within(shownPanel()).getByText(wizard.hints.noBasicSalary)).toBeTruthy();
    expect(starred(field(wizard.fields.remarks)), 'Remarks must be starred').toBe(true);
    expect(field(wizard.fields.remarks).placeholder).toBe(wizard.fields.remarksNoBasicPlaceholder);
    // Requirement 3 named these two as well. They are marked, and ONLY marked: both are <select>s that
    // always carry a value, so a presence rule on them would refuse a draft that looks complete.
    expect(starred(field(detail.payMode)), 'Pay Mode must be starred').toBe(true);
    expect(starred(field(detail.paymentTerm)), 'Payment Term must be starred').toBe(true);
    expect((field(detail.payMode) as unknown as HTMLSelectElement).value).toBe('monthly');
  });

  it('a typed ZERO is treated as "no basic salary", not as an amount', async () => {
    const user = userEvent.setup();
    wrap(nearlyDone({ basicSalary: '' }));
    await user.type(field(wizard.fields.basicSalary), '0');
    expect(field(wizard.fields.basicSalary).value).toBe('0');
    expect(within(shownPanel()).getByText(wizard.hints.noBasicSalary)).toBeTruthy();
    expect(starred(field(wizard.fields.remarks))).toBe(true);
  });

  it('ACTIVATE: blocked while the reason is missing, LIVE the moment it is typed', async () => {
    const user = userEvent.setup();
    wrap(nearlyDone({ basicSalary: '' }));

    // This is the reporter's complaint, reproduced: the button is off. What is DIFFERENT is why — the
    // outstanding list now names Remarks, not an amount, and names the tab it lives on.
    expect(activateBtn().disabled).toBe(true);
    const needs = outstandingBox();
    expect(needs.textContent).toContain(wizard.tabs.payroll);
    expect(needs.textContent).toContain(wizard.fields.remarks);
    expect(needs.textContent, 'the amount is no longer outstanding').not.toContain(
      wizard.fields.basicSalary,
    );

    await user.type(field(wizard.fields.remarks), "Paid by quarterly director's fees");
    expect(activateBtn().disabled, 'Activate must let go once the reason is given').toBe(false);
    // …and the hint and the asterisk stay, because the rule has not stopped applying.
    expect(within(shownPanel()).getByText(wizard.hints.noBasicSalary)).toBeTruthy();
    expect(starred(field(wizard.fields.remarks))).toBe(true);

    // And it really does activate — the draft that reaches the server carries the blank amount and the
    // reason, which is the pair `completeEmployeeDraft` re-judges before it creates anything.
    await user.click(activateBtn());
    expect(createEmployeeAction).toHaveBeenCalled();
    const sent = createEmployeeAction.mock.calls.at(-1) as unknown as [string, EmployeeDraftData, number];
    expect(sent[1].payroll?.basicSalary ?? '').toBe('');
    expect(sent[1].payroll?.remarks).toBe("Paid by quarterly director's fees");
  });

  it('a NEGATIVE amount keeps Activate off, and asks for the AMOUNT rather than a reason', async () => {
    const user = userEvent.setup();
    wrap(nearlyDone({ basicSalary: '', remarks: 'anything at all' }));
    // Typed through the box so this is the screen's own reading, not a hand-built draft.
    await user.type(field(wizard.fields.basicSalary), '-100');
    expect(field(wizard.fields.basicSalary).value).toBe('-100');
    expect(activateBtn().disabled, 'a negative wage is never legitimate').toBe(true);
    const needs = outstandingBox();
    expect(needs.textContent).toContain(wizard.fields.basicSalary);
    // The no-basic affordances must NOT appear: this is a wrong amount, not an absent one, and a remark
    // is no answer to it.
    expect(within(shownPanel()).queryByText(wizard.hints.noBasicSalary)).toBeNull();
    expect(starred(field(wizard.fields.remarks))).toBe(false);
  });
});

describe("the Personnel screen's salary EDIT dialog — the half the first plan never named", () => {
  const row = (over: Partial<SalaryRowView> & { id: string }): SalaryRowView => ({
    employmentId: 'emp-1',
    effectiveDate: '2026-01-01',
    currency: 'MYR',
    basic: 2500,
    previous: null,
    incrementAmount: null,
    incrementPct: null,
    status: 'active',
    payMode: 'monthly',
    paymentTerm: 'monthly',
    rateAmount: null,
    remarks: 'Annual review',
    editable: true,
    deletable: true,
    ...over,
  });

  const mount = () =>
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <SalaryHistoryTable rows={[row({ id: 's1' })]} />
      </NextIntlClientProvider>,
    );

  it('the amount can be CLEARED — it no longer refuses to submit an empty box', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: detail.salaryEdit }));
    const dialog = await screen.findByRole('dialog');
    const amount = within(dialog).getByDisplayValue('2500') as HTMLInputElement;
    expect(amount.name).toBe('basicSalary');
    expect(amount.required, '`required` here meant a zero was typeable but a blank was not').toBe(false);
    expect(amount.getAttribute('min')).toBe('0');

    await user.clear(amount);
    expect(amount.value).toBe('');
    // IT STILL POSTS. That is what makes a blank from this form a DELIBERATE clear rather than an absent
    // field, which is the only reason `editCompensationAction` may read the key's presence (node §2).
    const form = amount.closest('form');
    expect(form, 'the cleared input must still be inside the posting form').toBeTruthy();
    expect(new FormData(form as HTMLFormElement).has('basicSalary')).toBe(true);
    expect(new FormData(form as HTMLFormElement).get('basicSalary')).toBe('');
    // The Remarks box it posts beside — where the reason goes when the amount is cleared.
    expect(new FormData(form as HTMLFormElement).has('remarks')).toBe(true);
  });
});
