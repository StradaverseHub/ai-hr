/**
 * THE DRAFT RECORD, RENDERED — item 759dfc7d, work item 2.
 *
 * WHY RENDERING AND NOT GREPPING. test/draft-record-tabs.test.ts pins the vocabulary: which tabs a draft
 * gets, and that every label it borrows is the activated record's own word in all six locales. None of
 * that answers the reporter's actual sentence, which is behavioural — "one employee screen to learn
 * instead of two", filled in "over several days". So this file opens the screen and does what an
 * administrator does: reads the tab strip, types into one tab, moves to another, comes back, and saves
 * with the record deliberately half-empty.
 *
 * THE THREE FAULTS IT IS WRITTEN AGAINST, each of which passes tsc, the suite and a 200:
 *   1. A tab that renders but is EMPTY, because a panel was wired to the wrong key. The tab strip would
 *      still read correctly and every string assertion would still pass.
 *   2. A value LOST ON A TAB SWITCH. The shell keeps hidden panels mounted for exactly this reason; a
 *      panel that unmounted instead would lose a half-typed address every time HR looked at Payroll,
 *      which is the "do not require the administrator to re-enter the information" failure in miniature.
 *   3. SAVE STARTING TO VALIDATE. A draft that refuses to save until it is complete is not a draft, and
 *      that regression is invisible until somebody with half a record presses the button.
 *
 * IT IS ALSO THE MISSING_MESSAGE CHECK. `NextIntlClientProvider` is given the REAL en.json, and next-intl
 * throws on an unresolved key rather than painting one, so every literal key this screen uses is
 * exercised by the act of rendering it (the class of fault a 200 never catches).
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

/** The three server actions the screen calls. Recorded, not executed — this file is about the screen. */
const saveDraftAction = vi.fn(async () => ({ id: 'draft-1' }));
const discardDraftAction = vi.fn(async () => {});
const createEmployeeAction = vi.fn(async () => ({ employmentId: 'emp-1' }));
vi.mock('../app/admin/personnel/new/actions', () => ({
  saveDraftAction: (...a: unknown[]) => saveDraftAction(...(a as [])),
  discardDraftAction: (...a: unknown[]) => discardDraftAction(...(a as [])),
  createEmployeeAction: (...a: unknown[]) => createEmployeeAction(...(a as [])),
}));

const { EmployeeWizard } = await import('../app/admin/personnel/new/wizard');

const OPTIONS = {
  companies: [{ id: 'co-1', label: 'Acme Sdn Bhd' }],
  businessUnits: [{ id: 'bu-1', label: 'BU1 — Operations', companies: 'co-1' }],
  departments: [{ id: 'dp-1', label: 'Finance', companies: 'co-1', businessUnitId: 'bu-1', buCompanies: 'co-1' }],
  positions: [{ id: 'ps-1', label: 'Accountant', companies: 'co-1' }],
  costCenters: [{ id: 'cc-1', label: 'CC1 — HQ', companies: 'co-1' }],
  grades: [{ id: 'gr-1', label: 'G3' }],
  managers: [{ id: 'mg-1', label: 'Aisha Rahman (E0001)' }],
  nationalityOptions: [{ value: 'Malaysian', label: 'Malaysian' }],
  relationshipOptions: [
    { value: 'spouse', label: 'Spouse' },
    { value: 'child', label: 'Child' },
  ],
  countryOptions: [{ value: 'Malaysia', label: 'Malaysia' }],
};

/** A draft as it really arrives after Create: a company, a name, an e-mail, a held ID, nothing else. */
const freshDraft = (): EmployeeDraftData => ({
  profile: { fullName: 'Nadia Yusof', primaryEmail: 'nadia@acme.test', employeeCode: 'ABC00100' },
  employment: { companyId: 'co-1' },
});

const wrap = (data: EmployeeDraftData = freshDraft(), initialStep = 1) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EmployeeWizard
        today="2026-09-10"
        draftId="draft-1"
        reservedEmployeeCode="ABC00100"
        initialData={data}
        initialStep={initialStep}
        {...OPTIONS}
      />
    </NextIntlClientProvider>,
  );

/** The tab strip, by its accessible name — the shell labels the nav with `people.wizard.progressLabel`. */
const tabStrip = () => screen.getByRole('navigation', { name: messages.people.wizard.progressLabel });
const tabNames = () => within(tabStrip()).getAllByRole('tab').map((b) => b.textContent);
const openTab = async (name: string) => {
  await userEvent.click(within(tabStrip()).getByRole('tab', { name }));
};
/** The panel currently on screen. Hidden panels stay MOUNTED, so "visible" is the whole question. */
const shownPanel = () => {
  const panels = [...document.querySelectorAll('[data-tabpanel]')] as HTMLElement[];
  const open = panels.filter((p) => !p.hidden);
  expect(open, 'exactly one panel is shown at a time').toHaveLength(1);
  return open[0];
};

beforeEach(() => {
  saveDraftAction.mockClear();
  discardDraftAction.mockClear();
  createEmployeeAction.mockClear();
});

// ── the tab strip ─────────────────────────────────────────────────────────────────────────────────
describe('the draft opens on the SAME tabs an activated employee opens', () => {
  it('shows exactly the five tabs, named as the record names them', () => {
    wrap();
    const t = messages.people.detail.tabs;
    expect(tabNames()).toEqual([t.profile, t.job, t.bankStatutory, t.payroll, t.family]);
  });

  it('does NOT show the six tabs a draft is not entitled to', () => {
    wrap();
    const t = messages.people.detail.tabs;
    // Four describe things that have happened to an employment and a draft has none; Qualification and
    // Others follow activation by the plan's own choice. Absent, not empty — an empty "Leave" tab would
    // still be a promise that leave exists on a record with no employment.
    for (const absent of [t.careerMovement, t.attendance, t.leave, t.documents, t.qualification, t.others]) {
      expect(within(tabStrip()).queryByRole('tab', { name: absent }), absent).toBeNull();
    }
  });

  it('there is no step strip, no Back and no Next left behind', () => {
    wrap();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    // The old form numbered its steps 1..5 in the strip; the tabs carry names only.
    expect(tabStrip().textContent).not.toMatch(/[1-5]/);
  });

  it('reopens on the tab the draft was left on, including the RETIRED step number 5', () => {
    // 5 was the Review step of a form that no longer exists and is sitting on production rows. It must
    // reopen where that cohort has been reopening — Payroll — and not slide onto whatever inherited it.
    const parked = wrap(freshDraft(), 5);
    expect(shownPanel().dataset.tabpanel, 'a draft parked on the retired step 5').toBe('payroll');
    parked.unmount();

    // And every live number still reopens its own tab: 2 is Employment, 6 is Family.
    const onJob = wrap(freshDraft(), 2);
    expect(shownPanel().dataset.tabpanel).toBe('job');
    onJob.unmount();
    wrap(freshDraft(), 6);
    expect(shownPanel().dataset.tabpanel).toBe('family');
  });
});

// ── the cards inside ──────────────────────────────────────────────────────────────────────────────
describe('each tab carries the record\'s own section names and the draft\'s own fields', () => {
  it('every tab has content — none is an empty panel', async () => {
    wrap();
    const t = messages.people.detail.tabs;
    const empty = messages.people.detail.tabs.empty;
    for (const name of [t.profile, t.job, t.bankStatutory, t.payroll, t.family]) {
      await openTab(name);
      expect(shownPanel().textContent, `${name} panel`).not.toContain(empty);
      expect(shownPanel().textContent?.trim().length, `${name} panel`).toBeGreaterThan(40);
    }
  });

  it('Profile carries Personal details and Contact & address, with the fields that were on the step', async () => {
    wrap();
    const panel = shownPanel();
    expect(panel.textContent).toContain(messages.people.detail.personalDetails);
    expect(panel.textContent).toContain(messages.people.detail.contactAddressTitle);
    // The identity group, the DOB group and the gender/marital group are the RECORD'S components, so
    // finding their labels here is finding the record's own fields on a draft.
    expect(within(panel).getByDisplayValue('Nadia Yusof')).toBeTruthy();
    expect(within(panel).getByDisplayValue('nadia@acme.test')).toBeTruthy();
  });

  it('Bank & Statutory splits into the record\'s three cards rather than one flat grid', async () => {
    wrap();
    await openTab(messages.people.detail.tabs.bankStatutory);
    const text = shownPanel().textContent ?? '';
    expect(text).toContain(messages.people.detail.bankCardTitle);
    expect(text).toContain(messages.people.detail.statutoryMalaysia);
    expect(text).toContain(messages.people.detail.identityTaxCardTitle);
  });

  it('Employment splits into Organisation and Employment Dates, as the record does', async () => {
    wrap();
    await openTab(messages.people.detail.tabs.job);
    const text = shownPanel().textContent ?? '';
    expect(text).toContain(messages.people.detail.employmentInfo.orgGroup);
    expect(text).toContain(messages.people.detail.employmentInfo.datesGroup);
  });

  it('Family is the register it is on the record — its own card, its own Add', async () => {
    wrap();
    await openTab(messages.people.detail.tabs.family);
    const text = shownPanel().textContent ?? '';
    expect(text).toContain(messages.people.detail.family.title);
    expect(within(shownPanel()).getByRole('button', { name: messages.people.detail.family.add })).toBeTruthy();
  });
});

// ── what makes it a draft ─────────────────────────────────────────────────────────────────────────
describe('it is still a draft: nothing is lost, nothing is demanded', () => {
  it('a value typed on one tab is still there after visiting another and coming back', async () => {
    // THE FAULT: hidden panels unmounting. HR types a phone number, checks the salary on Payroll, comes
    // back, and the phone number is gone — "re-enter the information", which is the whole complaint.
    wrap();
    // Profile: a phone number, on the Contact & address card.
    await userEvent.type(within(shownPanel()).getByLabelText(messages.people.wizard.fields.phone), '+60123456789');

    // Employment: a department, three tabs away.
    await openTab(messages.people.detail.tabs.job);
    await userEvent.selectOptions(
      within(shownPanel()).getByLabelText(messages.people.wizard.fields.department),
      'dp-1',
    );

    // Payroll: a salary.
    await openTab(messages.people.detail.tabs.payroll);
    await userEvent.type(within(shownPanel()).getByLabelText(messages.people.wizard.fields.basicSalary), '5200');

    // …and every one of them is still there on the way back. Nothing was saved in between: this is the
    // in-progress record surviving navigation, which is what "fill it in over several days" needs first.
    await openTab(messages.people.detail.tabs.profile);
    expect((within(shownPanel()).getByLabelText(messages.people.wizard.fields.phone) as HTMLInputElement).value)
      .toBe('+60123456789');
    await openTab(messages.people.detail.tabs.job);
    expect((within(shownPanel()).getByLabelText(messages.people.wizard.fields.department) as HTMLSelectElement).value)
      .toBe('dp-1');
    await openTab(messages.people.detail.tabs.payroll);
    expect((within(shownPanel()).getByLabelText(messages.people.wizard.fields.basicSalary) as HTMLInputElement).value)
      .toBe('5200');

    // And the save that follows carries all three — the point of keeping them.
    await userEvent.click(screen.getByRole('button', { name: messages.people.wizard.saveDraft }));
    const [, data] = saveDraftAction.mock.calls[0] as unknown as [string, EmployeeDraftData, number];
    expect(data.profile?.phone).toBe('+60123456789');
    expect(data.employment?.departmentId).toBe('dp-1');
    expect(data.payroll?.basicSalary).toBe('5200');
  });

  it('SAVE works with the record deliberately half-empty, and sends the tab it was pressed on', async () => {
    // The draft below is missing department, employment type, join date AND salary — everything Activate
    // needs. Save must still write it, because that is the difference between a draft and a form.
    wrap();
    await openTab(messages.people.detail.tabs.bankStatutory);
    await userEvent.click(screen.getByRole('button', { name: messages.people.wizard.saveDraft }));
    expect(saveDraftAction).toHaveBeenCalledTimes(1);
    const [id, data, step] = saveDraftAction.mock.calls[0] as unknown as [string, EmployeeDraftData, number];
    expect(id).toBe('draft-1');
    expect(data.profile?.fullName).toBe('Nadia Yusof');
    // 3 is Bank & Statutory's stored number, unchanged from the five-step form — so this draft reopens
    // on the tab it was saved from, and the numbers already on production rows still mean what they did.
    expect(step).toBe(3);
  });

  it('ACTIVATE is refused while anything is outstanding, and the screen NAMES what by tab', async () => {
    wrap();
    const activate = screen.getByRole('button', { name: messages.people.wizard.activate });
    expect(activate.hasAttribute('disabled')).toBe(true);
    // "Activate still needs: Employment — Department, Employment type, Join date · Payroll — Basic salary"
    const outstanding = screen.getByText(messages.people.wizard.activateNeeds).parentElement as HTMLElement;
    expect(outstanding.textContent).toContain(messages.people.detail.tabs.job);
    expect(outstanding.textContent).toContain(messages.people.detail.tabs.payroll);
    expect(outstanding.textContent).toContain(messages.people.wizard.fields.department);
    expect(outstanding.textContent).toContain(messages.people.wizard.fields.basicSalary);
    // …and the name of the missing thing is the way to reach it.
    await userEvent.click(within(outstanding).getByRole('button', { name: messages.people.detail.tabs.job }));
    expect(shownPanel().dataset.tabpanel).toBe('job');
    expect(createEmployeeAction).not.toHaveBeenCalled();
  });

  it('the status is a LABEL on the record — "Draft — pending activation" beside the held ID', () => {
    wrap();
    expect(screen.getByText(messages.people.wizard.draftStatus)).toBeTruthy();
    // On the same header card as the reserved Employee ID, not floating somewhere else on the page.
    const header = screen.getByText(messages.people.wizard.draftStatus).closest('div');
    expect(header?.textContent).toContain('ABC00100');
  });

  it('the company and the reserved Employee ID are shown, and neither is editable', () => {
    wrap();
    expect(screen.getByText('Acme Sdn Bhd')).toBeTruthy();
    expect(screen.getByText('ABC00100')).toBeTruthy();
    // No control anywhere on the screen holds either value — the server pins both, and the screen must
    // not present a box that looks as though it could move them.
    expect(screen.queryByDisplayValue('ABC00100')).toBeNull();
    expect(screen.queryByDisplayValue('Acme Sdn Bhd')).toBeNull();
  });
});
