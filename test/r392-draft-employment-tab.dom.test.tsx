/**
 * r392 — item 685d2380 STEP 1, the draft's Employment tab ON THE SCREEN.
 *
 * test/r392-draft-employment-tab.test.ts proves which end date lands at Activate. This file proves what HR
 * SEES: the relabelled fields in all six locales, the Direct Superior search box narrowing to one person
 * and writing the stored key, the end-date box present for Contract and Intern only (under each type's own
 * name), and the read-only "Probation ends on" line for Full-Time showing the date
 * `draftProvisionalEndOn` computes — the same function `completeEmployeeDraft` calls.
 *
 * `NextIntlClientProvider` is given each REAL locale catalogue, and next-intl reports an unresolved key
 * rather than painting the text we look for, so a missing translation fails the label lookups below.
 *
 * jsdom applies no CSS and computes no layout: rendering and interaction logic only, not a visual check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import type { EmployeeDraftData } from '../lib/employee-draft-schema';
import { addEmploymentPeriod } from '../lib/employment-period';
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
  // The label shape page.tsx now builds: CODE – name, the Personnel record's Direct Superior label.
  managers: [
    { id: 'mg-1', label: 'E0001 – Aisha Rahman' },
    { id: 'mg-2', label: 'E0002 – Bala Krishnan' },
    { id: 'mg-3', label: 'E0013 – Aisha Tan' },
  ],
  nationalityOptions: [],
  profileOptions: { salutation: [], religion: [], race: [] },
  relationshipOptions: [],
  countryOptions: [],
  stateOptions: [],
};

const today = todayInKualaLumpur();

const draftOf = (employment: NonNullable<EmployeeDraftData['employment']>): EmployeeDraftData => ({
  profile: { fullName: 'Nadia Yusof', primaryEmail: 'nadia@acme.test', employeeCode: 'ABC00100' },
  employment: { companyId: 'co-1', departmentId: 'dp-1', hiredOn: today, ...employment },
});

const wrap = (data: EmployeeDraftData, messages: Msgs = en, locale = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <EmployeeWizard
        today={today}
        draftId="draft-1"
        reservedEmployeeCode="ABC00100"
        initialData={data}
        initialStep={2}
        initialTab="job"
        {...OPTIONS}
      />
    </NextIntlClientProvider>,
  );

const shownPanel = () => {
  const open = ([...document.querySelectorAll('[data-tabpanel]')] as HTMLElement[]).filter((p) => !p.hidden);
  expect(open, 'exactly one panel is shown at a time').toHaveLength(1);
  return open[0];
};
/** The control under a `Field` label. BY THE LABEL'S OWN CAPTION, not `getByLabelText`: a Field's <label>
 *  wraps its hint and a select's options too, so its full text is never just the caption. */
const control = (caption: string) => {
  const span = [...shownPanel().querySelectorAll('label > span')].find((el) => el.textContent === caption);
  return (span?.closest('label')?.querySelector('input, select') ?? null) as HTMLInputElement | HTMLSelectElement | null;
};
const savedData = () => (saveDraftAction.mock.calls.at(-1) as unknown as [string, EmployeeDraftData, number])[1];

beforeEach(() => {
  saveDraftAction.mockClear();
});

describe('the relabelled fields, in all six locales', () => {
  for (const [loc, msgs] of Object.entries(LOCALES)) {
    it(`${loc}: Group Join Date (with its Join Date hint) and Direct Superior render under the record's words`, () => {
      const { unmount } = wrap(draftOf({ employmentType: 'full_time', probationValue: '3', probationUnit: 'month' }), msgs as Msgs, loc);
      const w = (msgs as Msgs).people.wizard;
      const panel = within(shownPanel());
      expect(panel.getByText(w.fields.groupJoinDate), `${loc} fields.groupJoinDate`).toBeTruthy();
      expect(panel.getByText(w.hints.groupJoinDate), `${loc} hints.groupJoinDate`).toBeTruthy();
      expect(panel.getByText(w.fields.directSuperior), `${loc} fields.directSuperior`).toBeTruthy();
      // The draft says what the record says.
      expect(w.fields.groupJoinDate, `${loc} matches people.detail`).toBe((msgs as Msgs).people.detail.employmentInfo.groupJoinDate);
      expect(w.fields.directSuperior, `${loc} matches people.detail`).toBe((msgs as Msgs).people.detail.directSuperiorLabel);
      // The retired wording is not on the tab.
      expect(panel.queryByText(en.people.wizard.fields.hiredOn), `${loc} no retired hiredOn`).toBeNull();
      unmount();
    });
  }
});

describe('Direct Superior is a search box', () => {
  it('typing an Employee ID narrows the list to the one match, and the pick is written to the stored key', async () => {
    wrap(draftOf({ employmentType: 'full_time' }));
    const panel = within(shownPanel());
    await userEvent.click(panel.getByText(en.people.wizard.directSuperiorNone));
    await userEvent.type(panel.getByPlaceholderText(en.people.wizard.directSuperiorSearch), 'E0002');
    const matches = within(panel.getByRole('listbox'))
      .getAllByRole('option')
      .filter((o) => o.textContent !== en.people.wizard.directSuperiorNone);
    expect(matches.map((o) => o.textContent), 'search narrows to one match').toEqual(['E0002 – Bala Krishnan']);
    await userEvent.pointer({ keys: '[MouseLeft>]', target: matches[0] });
    await userEvent.click(screen.getByRole('button', { name: en.people.wizard.saveDraft }));
    expect(savedData().employment?.reportingManagerEmploymentId, 'data.employment.reportingManagerEmploymentId').toBe('mg-2');
  });

  it('part of a name narrows too', async () => {
    wrap(draftOf({ employmentType: 'full_time' }));
    const panel = within(shownPanel());
    await userEvent.click(panel.getByText(en.people.wizard.directSuperiorNone));
    await userEvent.type(panel.getByPlaceholderText(en.people.wizard.directSuperiorSearch), 'aisha');
    const matches = within(panel.getByRole('listbox'))
      .getAllByRole('option')
      .filter((o) => o.textContent !== en.people.wizard.directSuperiorNone);
    expect(matches.map((o) => o.textContent)).toEqual(['E0001 – Aisha Rahman', 'E0013 – Aisha Tan']);
  });

  it('posts nothing by itself — controlled mode renders no hidden input', () => {
    wrap(draftOf({ employmentType: 'full_time', reportingManagerEmploymentId: 'mg-1' }));
    expect(shownPanel().querySelector('input[type="hidden"]'), 'no hidden input on the Employment tab').toBeNull();
    expect(within(shownPanel()).getByText('E0001 – Aisha Rahman'), 'the stored pick is shown').toBeTruthy();
  });
});

describe('the end-date box follows the Employment Type', () => {
  const w = en.people.wizard;
  it('absent for full_time and part_time', () => {
    for (const employmentType of ['full_time', 'part_time']) {
      const { unmount } = wrap(draftOf({ employmentType }));
      const panel = within(shownPanel());
      expect(panel.queryByText(w.fields.contractEndDate), `${employmentType} contract box`).toBeNull();
      expect(panel.queryByText(w.fields.internshipEndDate), `${employmentType} internship box`).toBeNull();
      expect(panel.queryByText(w.fields.provisionalEndOn), `${employmentType} provisional box`).toBeNull();
      unmount();
    }
  });

  it('present for contract as "Contract End Date" and intern as "Internship End Date", and typing reaches the draft', async () => {
    const { unmount } = wrap(draftOf({ employmentType: 'contract' }));
    const box = control(w.fields.contractEndDate) as HTMLInputElement;
    expect(box, 'contract box').toBeTruthy();
    expect(box.type).toBe('date');
    expect(w.fields.contractEndDate).toBe('Contract End Date');
    const end = addEmploymentPeriod(today, '12', 'month')!;
    await userEvent.type(box, end);
    await userEvent.click(screen.getByRole('button', { name: w.saveDraft }));
    expect(savedData().employment?.provisionalEndOn, 'contract box writes provisionalEndOn').toBe(end);
    unmount();

    wrap(draftOf({ employmentType: 'intern' }));
    expect(control(w.fields.internshipEndDate), 'intern box').toBeTruthy();
    expect(w.fields.internshipEndDate).toBe('Internship End Date');
  });

  it('switching Full-Time → Contract on screen brings the box in', async () => {
    wrap(draftOf({ employmentType: 'full_time' }));
    expect(control(w.fields.contractEndDate), 'no box for full_time').toBeNull();
    await userEvent.selectOptions(control(w.fields.employmentType)!, 'contract');
    expect(control(w.fields.contractEndDate), 'box appears for contract').toBeTruthy();
  });
});

describe('Full-Time shows when probation ends, worked out from the Probation Period', () => {
  const w = en.people.wizard;
  const line = () => shownPanel().querySelector('[data-probation-ends]')?.textContent ?? null;

  it('the line shows Group Join Date + the period, and follows an edit of the period', async () => {
    wrap(draftOf({ employmentType: 'full_time', probationValue: '6', probationUnit: 'month' }));
    const sixMonths = addEmploymentPeriod(today, '6', 'month')!;
    expect(line(), 'probation line shows the derived date').toBe(w.probationEndsOn.replace('{date}', sixMonths));

    const value = within(shownPanel()).getAllByLabelText(en.people.detail.employmentInfo.value)[0] as HTMLInputElement;
    await userEvent.clear(value);
    await userEvent.type(value, '2');
    const unit = within(shownPanel()).getAllByLabelText(en.people.detail.employmentInfo.unit)[0] as HTMLSelectElement;
    await userEvent.selectOptions(unit, 'week');
    expect(line(), 'and recomputes on edit').toBe(w.probationEndsOn.replace('{date}', addEmploymentPeriod(today, '2', 'week')!));
  });

  it('a legacy draft with no period shows the stored date and says where it came from', () => {
    const stored = addEmploymentPeriod(today, '3', 'month')!;
    wrap(draftOf({ employmentType: 'full_time', provisionalEndOn: stored }));
    expect(line()).toBe(w.probationEndsOnStored.replace('{date}', stored));
  });

  it('no period and no stored date: the line says so; and no line at all for other types', () => {
    const { unmount } = wrap(draftOf({ employmentType: 'full_time', probationValue: '' }));
    expect(line()).toBe(w.probationEndsNone);
    unmount();
    for (const employmentType of ['part_time', 'contract', 'intern']) {
      const r = wrap(draftOf({ employmentType, probationValue: '3', probationUnit: 'month' }));
      expect(line(), `${employmentType} has no probation line`).toBeNull();
      r.unmount();
    }
  });
});

describe('the outstanding list uses the new words', () => {
  it('a blank Group Join Date is listed as "Group Join Date", never the retired key', () => {
    wrap(draftOf({ employmentType: 'full_time', hiredOn: '' }));
    // The outstanding list itself, not the page — the tab's own field label also reads "Group Join Date".
    const list = screen.getByText(en.people.wizard.activateNeeds).parentElement!.textContent ?? '';
    expect(list, 'outstanding list label').toContain(`${en.people.detail.tabs.job} — ${en.people.wizard.fields.groupJoinDate}`);
    expect(document.body.textContent, 'no retired text reaches HR').not.toContain('[retired r392');
  });
});
