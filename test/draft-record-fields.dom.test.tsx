/**
 * THE FIELDS ITEM a72610af ADDED, ON THE SCREEN — rendered, typed into, and read back out of Save.
 *
 * WHY RENDERING AND NOT GREPPING. test/draft-activation-field-survival.test.ts already proves the other
 * half: every one of these fields has a declared destination and lands in the right column when a draft
 * is activated. What it cannot see is whether any of them is ON THE SCREEN. A field added to the draft
 * type and to the activation path but wired to no control would pass that guard completely — and would
 * be a field HR can never fill in, which is the same "nothing to re-enter" promise broken from the other
 * end. So this file opens the draft and does what an administrator does: types into the new controls on
 * three tabs and presses Save, then reads the payload.
 *
 * IT IS ALSO THE MISSING_MESSAGE CHECK FOR THE SHARED GROUPS. `NextIntlClientProvider` is given the REAL
 * en.json and next-intl throws on an unresolved key rather than painting one, so every label these
 * components borrow from `people.detail.*` is exercised by the act of rendering them. Every new field
 * this item added reads its label from the Personnel record's own key — that is what stops the draft and
 * the record wording the same question differently — and an unresolved one would take the screen down.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: the Issuing Country and Country Code pickers are `Combobox`es
 * with their own popover behaviour, already exercised by the components that have shared them since
 * 35b7af0a group 8; driving them here would be testing the Combobox, not this item. Their presence is
 * asserted; their popover is not.
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

const { EmployeeWizard } = await import('../app/admin/personnel/new/wizard');

const detail = messages.people.detail;

const OPTIONS = {
  companies: [{ id: 'co-1', label: 'Acme Sdn Bhd' }],
  businessUnits: [{ id: 'bu-1', label: 'BU1 — Operations', companies: 'co-1' }],
  departments: [{ id: 'dp-1', label: 'Finance', companies: 'co-1', businessUnitId: 'bu-1', buCompanies: 'co-1' }],
  positions: [{ id: 'ps-1', label: 'Accountant', companies: 'co-1' }],
  costCenters: [{ id: 'cc-1', label: 'CC1 — HQ', companies: 'co-1' }],
  grades: [{ id: 'gr-1', label: 'G3' }],
  managers: [{ id: 'mg-1', label: 'Aisha Rahman (E0001)' }],
  nationalityOptions: [{ value: 'Malaysian', label: 'Malaysian' }],
  profileOptions: {
    salutation: [{ value: 'Puan', label: 'Puan' }],
    religion: [{ value: 'Islam', label: 'Islam' }],
    race: [{ value: 'Malay', label: 'Malay' }],
  },
  relationshipOptions: [{ value: 'spouse', label: 'Spouse' }],
  countryOptions: [{ value: 'Malaysia', label: 'Malaysia' }],
  // da7463b4 — the `state` catalog the Permanent / Correspondence address blocks render.
  stateOptions: [{ value: 'Selangor', label: 'Selangor' }],
};

/** A draft as it arrives after Create, plus the two values page.tsx seeds (item a72610af). */
const freshDraft = (): EmployeeDraftData => ({
  profile: { fullName: 'Nadia Yusof', primaryEmail: 'nadia@acme.test', employeeCode: 'ABC00100' },
  employment: { companyId: 'co-1', employmentType: 'full_time', hiredOn: '2026-09-10' },
});

const wrap = (data: EmployeeDraftData = freshDraft()) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EmployeeWizard
        today="2026-09-10"
        draftId="draft-1"
        reservedEmployeeCode="ABC00100"
        initialData={data}
        initialStep={1}
        {...OPTIONS}
      />
    </NextIntlClientProvider>,
  );

const tabStrip = () => screen.getByRole('navigation', { name: messages.people.wizard.progressLabel });
const openTab = async (name: string) => {
  await userEvent.click(within(tabStrip()).getByRole('tab', { name }));
};
const shownPanel = () => {
  const open = ([...document.querySelectorAll('[data-tabpanel]')] as HTMLElement[]).filter((p) => !p.hidden);
  expect(open, 'exactly one panel is shown at a time').toHaveLength(1);
  return open[0];
};
const field = (label: string) => within(shownPanel()).getByLabelText(label);
/**
 * BY ID, NOT BY LABEL — item da7463b4.
 *
 * The Profile tab now carries the Correspondence block's OWN Mobile / Home phone pair beside the
 * person's own, exactly as the activated record has since bf953339. So TWO fields on this tab are
 * labelled "Home Phone Number" and two "Mobile Phone Number", and `getByLabelText` is ambiguous for
 * both — on this screen and on the record. The id is how the record tells them apart (`perm-` is the
 * person's own, `corr-` the correspondence one) and it is the id the "same as permanent" pairing is
 * declared against, so it is an invariant rather than a position.
 */
const byId = (id: string) => {
  const el = document.getElementById(id);
  expect(el, `no element carries id="${id}"`).toBeTruthy();
  return el as HTMLInputElement;
};
/** The draft as Save posted it — the only thing that ever reaches the server. */
const savedData = () => (saveDraftAction.mock.calls.at(-1) as unknown as [string, EmployeeDraftData, number])[1];
const save = async () => {
  await userEvent.click(screen.getByRole('button', { name: messages.people.wizard.saveDraft }));
};

beforeEach(() => {
  saveDraftAction.mockClear();
});

// ── Profile ───────────────────────────────────────────────────────────────────────────────────────
describe('Profile — the names, the demographics, the contact pair and the passport block', () => {
  it('every one of them is on screen, under the RECORD’s own label', () => {
    wrap();
    // The labels come from `people.detail.*` — the Personnel card's own keys — because these are the
    // Personnel card's own controls. A key that did not resolve would have thrown before this line.
    for (const label of [
      detail.salutation,
      detail.firstName,
      detail.lastName,
      detail.preferredName,
      detail.religion,
      detail.race,
      detail.homePhone,
      detail.personalEmail,
      detail.passportNumber,
      detail.passportIssueDate,
      detail.passportExpiryDate,
      detail.passportIssuingCountry,
      detail.passportIssuingCountryCode,
      detail.passportRemark,
    ]) {
      expect(within(shownPanel()).getAllByLabelText(label).length, label).toBeGreaterThan(0);
    }
    // The block is titled as the record titles it, so the passport reads as its own document.
    expect(within(shownPanel()).getByText(detail.passportInfoTitle)).toBeTruthy();
  });

  it('Salutation offers the TENANT’s catalog, not a hardcoded list', async () => {
    wrap();
    const sel = field(detail.salutation) as HTMLSelectElement;
    // The placeholder plus exactly the one option this fixture's catalog carries. A component that had
    // shipped its own list of honorifics would show more than two.
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'Puan']);
  });

  it('what is typed reaches the draft — name, demographic, contact and passport alike', async () => {
    wrap();
    await userEvent.selectOptions(field(detail.salutation), 'Puan');
    await userEvent.type(field(detail.firstName), 'Nadia');
    await userEvent.type(field(detail.lastName), 'Yusof');
    await userEvent.type(field(detail.preferredName), 'Nad');
    await userEvent.selectOptions(field(detail.religion), 'Islam');
    await userEvent.selectOptions(field(detail.race), 'Malay');
    await userEvent.type(byId('perm-home-phone'), '+60322223333');
    await userEvent.type(field(detail.personalEmail), 'nadia@home.test');
    await userEvent.type(field(detail.passportNumber), 'A1234567');
    await userEvent.type(field(detail.passportRemark), 'Renewed at Putrajaya');
    await save();

    expect(savedData().profile).toMatchObject({
      salutation: 'Puan',
      firstName: 'Nadia',
      lastName: 'Yusof',
      preferredName: 'Nad',
      religion: 'Islam',
      race: 'Malay',
      homePhone: '+60322223333',
      personalEmail: 'nadia@home.test',
      passportNumber: 'A1234567',
      passportRemark: 'Renewed at Putrajaya',
    });
    // …and the name Create asked for is untouched by the group that now surrounds it.
    expect(savedData().profile?.fullName).toBe('Nadia Yusof');
  });

  it('a HALF-TYPED passport is named as outstanding — and a complete one is not', async () => {
    // The all-or-nothing rule, on the tab that owns it. It has to be judged here: `setPassportProfileMY`
    // refuses a partial block, and it only runs AFTER `hireEmployee` has committed, so a refusal there
    // would fail an activation that had already created an employee.
    wrap();
    await userEvent.type(field(detail.passportNumber), 'A1234567');
    expect(
      screen.getByText(messages.people.wizard.activateNeeds).parentElement!.textContent,
      'a passport number with no dates is named',
    ).toContain(messages.people.wizard.fields.passport);

    // Completing the trio clears it. (The expiry/issue boxes are `type="date"`, so they are set
    // directly rather than typed character by character.)
    await userEvent.clear(field(detail.passportIssueDate));
    await userEvent.type(field(detail.passportIssueDate), '2021-04-05');
    await userEvent.type(field(detail.passportExpiryDate), '2031-04-04');
    expect(
      screen.getByText(messages.people.wizard.activateNeeds).parentElement!.textContent,
      'a complete passport is not outstanding',
    ).not.toContain(messages.people.wizard.fields.passport);
  });

  it('NOTHING on this tab is required — an untouched draft is outstanding on none of it', () => {
    // Item 06f0cb8f split creation from completion precisely so details stop blocking creation, and
    // lib/employee-draft-schema.ts says the profile tab carries no required field on purpose. Adding
    // fourteen of them must not quietly reverse that.
    wrap();
    const outstanding = screen.getByText(messages.people.wizard.activateNeeds).parentElement!.textContent!;
    for (const label of [detail.salutation, detail.firstName, detail.religion, detail.homePhone]) {
      expect(outstanding, label).not.toContain(label);
    }
    expect(outstanding).not.toContain(messages.people.wizard.fields.passport);
  });
});

// ── Employment ────────────────────────────────────────────────────────────────────────────────────
describe('Employment — probation, confirmation and the two notice periods', () => {
  it('all four periods and the confirmation date are on screen and reach the draft', async () => {
    wrap();
    await openTab(messages.people.detail.tabs.job);
    for (const label of [
      detail.employmentInfo.probationPeriod,
      detail.employmentInfo.extendedProbationPeriod,
      detail.employmentInfo.confirmationDate,
      detail.employmentInfo.noticeBeforeConfirmation,
      detail.employmentInfo.noticeAfterConfirmation,
    ]) {
      expect(within(shownPanel()).getAllByLabelText(label).length, label).toBeGreaterThan(0);
    }

    // A period is a value AND a unit; both halves are driven, because a control that stored the number
    // and dropped the unit would turn "6 weeks" into "6 months" at Activate.
    const periods = within(shownPanel()).getAllByLabelText(detail.employmentInfo.value);
    const units = within(shownPanel()).getAllByLabelText(detail.employmentInfo.unit);
    expect(periods, 'four value boxes').toHaveLength(4);
    expect(units, 'four unit selects').toHaveLength(4);
    await userEvent.type(periods[0], '3');
    await userEvent.selectOptions(units[1], 'week');
    await userEvent.type(periods[1], '6');
    await userEvent.type(field(detail.employmentInfo.confirmationDate), '2026-12-01');
    await save();

    expect(savedData().employment).toMatchObject({
      probationValue: '3',
      extendedProbationValue: '6',
      extendedProbationUnit: 'week',
      confirmationDate: '2026-12-01',
    });
  });

  it('a confirmation date BEFORE the hire date is named on the tab, not discovered after the hire', async () => {
    // `setEmploymentInfo` throws "Confirmation date cannot be earlier than the hire date." — and it runs
    // after `hireEmployee` has committed. Judged here instead, where a refusal costs nothing.
    wrap();
    await openTab(messages.people.detail.tabs.job);
    await userEvent.type(field(detail.employmentInfo.confirmationDate), '2026-01-01');
    expect(
      screen.getByText(messages.people.wizard.activateNeeds).parentElement!.textContent,
    ).toContain(messages.people.wizard.fields.confirmationDate);
  });

  it('the unit list is the writer’s three, never a fourth this screen invented', async () => {
    wrap();
    await openTab(messages.people.detail.tabs.job);
    const unit = within(shownPanel()).getAllByLabelText(detail.employmentInfo.unit)[0] as HTMLSelectElement;
    expect([...unit.options].map((o) => o.value)).toEqual(['month', 'week', 'day']);
  });
});

// ── Bank & Statutory ──────────────────────────────────────────────────────────────────────────────
describe('Bank & Statutory — the EPF category, the employer-bears switches, the reliefs and the levy', () => {
  it('the EPF category offers the record’s four names and stores the one picked', async () => {
    wrap();
    await openTab(messages.people.detail.tabs.bankStatutory);
    const sel = field(detail.epfMode) as HTMLSelectElement;
    // The lawful KWSP enum has three values and HR never sees it: the NAMES are the model, so they must
    // be the record's own. 'manual_fixed' is deferred (ADR-0046) and is offered on neither screen.
    expect([...sel.options].map((o) => o.textContent)).toEqual([
      detail.epfModeAuto,
      detail.epfModeManualPercentage,
      detail.epfModeSemiAuto,
      detail.epfModeExempt,
    ]);
    await userEvent.selectOptions(sel, 'semi_auto');
    await save();
    expect(savedData().statutory?.epfMode).toBe('semi_auto');
  });

  it('the four employer-bears switches are ticked into the draft as yes/no', async () => {
    wrap();
    await openTab(messages.people.detail.tabs.bankStatutory);
    await userEvent.click(field(detail.employerBearsEpf));
    await userEvent.click(field(detail.employerBearsEis));
    await save();
    // A tick is 'yes'. The two left alone are ABSENT rather than 'no', which the writer reads as the
    // column default — so a draft nobody touched creates the employee it always would have.
    expect(savedData().statutory).toMatchObject({ employerBearsEpf: 'yes', employerBearsEis: 'yes' });
    expect(savedData().statutory?.employerBearsSocso).toBeUndefined();
    expect(savedData().statutory?.employerBearsSkbbk).toBeUndefined();

    // …and un-ticking is an explicit 'no', not a return to absent.
    await userEvent.click(field(detail.employerBearsEpf));
    await save();
    expect(savedData().statutory?.employerBearsEpf).toBe('no');
  });

  it('the two disability reliefs default to No and store what is claimed', async () => {
    wrap();
    await openTab(messages.people.detail.tabs.bankStatutory);
    expect((field(detail.disabledIndividualLabel) as HTMLSelectElement).value, 'nothing claimed by default')
      .toBe('no');
    expect((field(detail.disabledSpouseLabel) as HTMLSelectElement).value).toBe('no');
    await userEvent.selectOptions(field(detail.disabledIndividualLabel), 'yes');
    await save();
    expect(savedData().statutory?.disabledIndividual).toBe('yes');
    // The spouse claim was never touched, so nothing about it is stored — an omission cannot claim a relief.
    expect(savedData().statutory?.disabledSpouse).toBeUndefined();
  });

  it('the child relief mode offers all three and the training levy keeps its blank "follow default"', async () => {
    wrap();
    await openTab(messages.people.detail.tabs.bankStatutory);
    const relief = field(detail.childReliefModeLabel) as HTMLSelectElement;
    expect([...relief.options].map((o) => o.value)).toEqual(['manual', 'auto', 'auto_table']);

    const hrdf = field(detail.subjectToHrdf) as HTMLSelectElement;
    // THE BLANK OPTION IS THE DEFAULT AND IT IS NOT "UNSET": it means follow the company's HRDF
    // registration default. Feedback 57840a6e is what happens when that collapses into an explicit No.
    expect(hrdf.value, 'follows the company default until somebody overrides it').toBe('');
    expect([...hrdf.options].map((o) => o.value)).toEqual(['', 'yes', 'no']);

    await userEvent.selectOptions(relief, 'auto');
    await userEvent.selectOptions(hrdf, 'yes');
    await save();
    expect(savedData().statutory).toMatchObject({ childReliefMode: 'auto', subjectToHrdf: 'yes' });
  });

  it('NOTHING on this tab is required either', async () => {
    wrap();
    await openTab(messages.people.detail.tabs.bankStatutory);
    const outstanding = screen.getByText(messages.people.wizard.activateNeeds).parentElement!.textContent!;
    for (const label of [detail.epfMode, detail.employerBearsEpf, detail.subjectToHrdf]) {
      expect(outstanding, label).not.toContain(label);
    }
  });
});
