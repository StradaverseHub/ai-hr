/**
 * THE DRAFT'S FAMILY FORM, RENDERED — item 759dfc7d, work item 1.
 *
 * WHY RENDERING AND NOT GREPPING. The reporter's requirement for this tab is behavioural: "the same
 * Add / Edit / View / Delete functions as the Active Employee record", and "the same fields". A source
 * grep cannot answer either — a field declared on the type but never given a control is invisible to
 * `test/employee-draft-family.test.ts` §2 (which pins the DATA contract) and would still lose everything
 * HR could not type. So this file opens the dialog and reads what an administrator can actually see.
 *
 * IT IS ALSO THE MISSING_MESSAGE CHECK. `NextIntlClientProvider` is given the REAL en.json here, and
 * next-intl throws on an unresolved key rather than painting one — so every literal key this component
 * uses is exercised by the act of rendering it. That is the class of fault a 200 from a server never
 * catches (a Family step whose labels all read `people.detail.family.cancel`).
 *
 * Scope note, inherited from the other .dom tests: jsdom applies no CSS and computes no layout, so this
 * catches rendering and interaction logic, not a visual regression.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import { DraftFamilyStep } from '../app/admin/personnel/new/family-step';
import type { EmployeeDraftFamilyMember } from '../lib/employee-draft-schema';

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const SPOUSE: EmployeeDraftFamilyMember = {
  key: 's',
  fullName: 'Farah Aziz',
  relationship: 'spouse',
  dateOfBirth: '1992-03-14',
  gender: 'female',
  icOrPassport: '920314-10-5566',
  isBeneficiary: true,
  phone: '+60 12-345 6789',
  remarks: 'Primary beneficiary',
  passportNumber: 'A12345678',
  residentialAddress: '18 Jalan Damai',
  marriageDate: '2016-08-20',
  marriageStatus: 'married',
  spouseWorking: true,
  occupation: 'Architect',
  companyName: 'Rekabina Sdn Bhd',
  employerAddress: 'Menara Rekabina',
};

const CHILD: EmployeeDraftFamilyMember = {
  key: 'c',
  fullName: 'Iman Nadia',
  relationship: 'child',
  dateOfBirth: '2009-11-02',
  gender: 'undisclosed',
  icOrPassport: '091102-14-0099',
  phone: '+60 11-222 3333',
  remarks: 'Boarding',
  schoolName: 'SMK Bandar Baru',
  studyLevel: 'Form 5',
  studyCountry: 'Malaysia',
  isStudent: true,
  childReliefCategory: 'study_tertiary',
  childTaxRelief: true,
  childReliefPercentage: '50',
};

const REL_OPTIONS = [
  { value: 'spouse', label: 'Spouse' },
  { value: 'child', label: 'Child' },
  { value: 'parent', label: 'Parent' },
  { value: 'sibling', label: 'Sibling' },
  { value: 'other', label: 'Other' },
];
const COUNTRY_OPTIONS = [{ value: 'Malaysia', label: 'Malaysia' }];

type Opts = { relationshipOptions?: { value: string; label: string }[]; countryOptions?: { value: string; label: string }[] };
const mount = (members: EmployeeDraftFamilyMember[], o: Opts = {}) => {
  const onChange = vi.fn();
  const r = wrap(
    <DraftFamilyStep
      members={members}
      onChange={onChange}
      relationshipOptions={o.relationshipOptions ?? REL_OPTIONS}
      countryOptions={o.countryOptions ?? COUNTRY_OPTIONS}
    />,
  );
  return { onChange, ...r };
};

/**
 * THE CATALOG AS MIGRATION 0305 ACTUALLY SEEDED IT on every tenant that existed before the
 * dependentRelationship category did: `SELECT t.id, d.category, d.value, d.value, d.sort_order` — the
 * LABEL IS THE LOWERCASE VALUE. That seeding is safe only because both Family screens render the
 * built-ins from static i18n labels, so it is the fixture these tests must use; hand-written pretty
 * labels ('Spouse', 'Child') would hide the very fault this catalog causes.
 */
const SEEDED_0305 = ['spouse', 'child', 'parent', 'sibling', 'other'].map((v) => ({ value: v, label: v }));
const REL = messages.people.detail.family.rel;

/** Every value currently held by a control inside the open dialog — what HR can see and change. */
const dialogValues = () => {
  const dlg = screen.getByRole('dialog');
  const out: string[] = [];
  for (const el of dlg.querySelectorAll('input, select, textarea')) {
    const c = el as HTMLInputElement;
    out.push(c.type === 'checkbox' ? String(c.checked) : c.value);
  }
  return out;
};

describe('the draft Family step renders the same record the Personnel Family tab does', () => {
  it('lists what has been entered, and says so plainly when nothing has', async () => {
    mount([]);
    expect(screen.getByText(messages.people.detail.family.none)).toBeTruthy();
    // The card is titled with the Personnel screen's OWN heading, not a wizard-specific one — the
    // reporter asked for the same section names, and reusing the string is how they cannot drift.
    expect(screen.getByText(messages.people.detail.family.title)).toBeTruthy();
  });

  it('a spouse opens with every spouse field populated, and no child-only field in sight', async () => {
    // THE DEFECT THIS PINS: a field carried in the blob and asserted by the data test, but with no control
    // on the form. HR cannot enter it, so it is always empty, and every data assertion still passes.
    mount([SPOUSE]);
    await userEvent.click(screen.getByRole('button', { name: messages.people.detail.family.edit }));
    const values = dialogValues();
    for (const v of [
      'Farah Aziz',
      '1992-03-14',
      'female',
      '920314-10-5566',
      '+60 12-345 6789',
      'Primary beneficiary',
      'A12345678',
      '18 Jalan Damai',
      '2016-08-20',
      'married',
      'Architect',
      'Rekabina Sdn Bhd',
      'Menara Rekabina',
    ]) {
      expect(values, `spouse value ${v}`).toContain(v);
    }
    // Beneficiary and "currently working" are ticked; the spouse panel carries both.
    expect(values.filter((v) => v === 'true').length).toBeGreaterThanOrEqual(2);
    const dlg = screen.getByRole('dialog');
    // Child-only sections must NOT be rendered for a spouse — the same gating the writer applies to the
    // columns (`extraColumnsForAdd`), so what is on screen matches what would be stored.
    expect(within(dlg).queryByText(messages.people.detail.family.sectionEducation)).toBeNull();
    expect(within(dlg).queryByText(messages.people.detail.family.schoolName)).toBeNull();
  });

  it('a child opens with the three fieldsets, its relief detail, and no spouse-only field', async () => {
    mount([CHILD]);
    await userEvent.click(screen.getByRole('button', { name: messages.people.detail.family.edit }));
    const dlg = screen.getByRole('dialog');
    for (const section of [
      messages.people.detail.family.sectionPersonal,
      messages.people.detail.family.sectionEducation,
      messages.people.detail.family.sectionTaxRelief,
    ]) {
      expect(within(dlg).getByText(section), section).toBeTruthy();
    }
    const values = dialogValues();
    for (const v of ['Iman Nadia', '2009-11-02', 'SMK Bandar Baru', 'Form 5', 'Malaysia', 'study_tertiary', '50']) {
      expect(values, `child value ${v}`).toContain(v);
    }
    // Age is derived read-only from the date of birth, exactly as the Personnel dialog derives it.
    expect(within(dlg).getByText(messages.people.detail.family.childAge)).toBeTruthy();
    expect(within(dlg).queryByText(messages.people.detail.family.marriageStatusLabel)).toBeNull();
    expect(within(dlg).queryByText(messages.people.detail.family.currentlyWorking)).toBeNull();
  });

  it('ADD: nothing is asked until a relationship is chosen, then the matching panel appears', async () => {
    const { onChange } = mount([]);
    await userEvent.click(screen.getByRole('button', { name: messages.people.detail.family.add }));
    const dlg = screen.getByRole('dialog');
    // The relationship is the first and, until answered, the ONLY question — the flow the request asked
    // for and the one the Personnel dialog already uses.
    expect(within(dlg).queryByText(messages.people.detail.family.name)).toBeNull();
    await userEvent.selectOptions(within(dlg).getByRole('combobox'), 'parent');
    await userEvent.type(within(dlg).getByLabelText(messages.people.detail.family.name), 'Zainab Ismail');
    await userEvent.click(within(dlg).getByRole('button', { name: messages.people.detail.family.add }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [EmployeeDraftFamilyMember[]];
    expect(next).toHaveLength(1);
    expect(next[0].fullName).toBe('Zainab Ismail');
    expect(next[0].relationship).toBe('parent');
  });

  it('EDIT changes the member in place rather than adding a second one', async () => {
    const { onChange } = mount([SPOUSE, CHILD]);
    // Rows are sorted spouse-first, so the first Edit button is the spouse's.
    await userEvent.click(screen.getAllByRole('button', { name: messages.people.detail.family.edit })[0]);
    const dlg = screen.getByRole('dialog');
    const occupation = within(dlg).getByLabelText(messages.people.detail.family.occupation);
    await userEvent.clear(occupation);
    await userEvent.type(occupation, 'Lecturer');
    await userEvent.click(within(dlg).getByRole('button', { name: messages.people.detail.family.save }));
    const [next] = onChange.mock.calls[0] as [EmployeeDraftFamilyMember[]];
    expect(next).toHaveLength(2);
    expect(next[0].occupation).toBe('Lecturer');
    // The OTHER member is untouched — the display sort must not decide which row is written.
    expect(next[1]).toEqual(CHILD);
  });

  it('DELETE asks first, and removes only the row it was pressed on', async () => {
    const { onChange } = mount([SPOUSE, CHILD]);
    await userEvent.click(screen.getAllByRole('button', { name: messages.people.detail.family.delete })[0]);
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: messages.people.detail.family.yes }));
    const [next] = onChange.mock.calls[0] as [EmployeeDraftFamilyMember[]];
    expect(next).toEqual([CHILD]);
  });

  it('VIEW is read-only: every control disabled and no way to save from it', async () => {
    mount([SPOUSE]);
    await userEvent.click(screen.getByRole('button', { name: messages.people.detail.family.view }));
    const dlg = screen.getByRole('dialog');
    for (const el of dlg.querySelectorAll('input, select, textarea')) {
      expect((el as HTMLInputElement).disabled, `${(el as HTMLInputElement).value} enabled in View`).toBe(true);
    }
    expect(within(dlg).queryByRole('button', { name: messages.people.detail.family.save })).toBeNull();
  });

  it('the relationship dropdown is labelled in the viewer\'s language, not with the raw catalog value', async () => {
    // THE DEFECT THIS PINS. Passing the catalog's `label` straight into the dropdown listed a lowercase,
    // untranslated "spouse / child / parent / sibling / other" on every tenant migration 0305 seeded —
    // in all six locales — while the table cell one line above, and the Personnel Family tab this step
    // mirrors, both read the localised built-in label. Same rule as `activeRelationshipOptions` there: a
    // BUILT-IN value keeps its static i18n label whatever the catalog row says.
    mount([], { relationshipOptions: SEEDED_0305 });
    await userEvent.click(screen.getByRole('button', { name: messages.people.detail.family.add }));
    const select = within(screen.getByRole('dialog')).getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      messages.people.detail.family.relationshipPlaceholder,
      REL.spouse,
      REL.child,
      REL.parent,
      REL.sibling,
      REL.other,
    ]);
    // The VALUES are untouched — this is a labelling rule, and the value is what Activate stores.
    expect([...select.options].map((o) => o.value)).toEqual(['', 'spouse', 'child', 'parent', 'sibling', 'other']);
  });

  it('the table cell and the dropdown one click away cannot disagree about the same member', async () => {
    // The contradiction the raw label produced, stated as the reporter would meet it: the row reads
    // "Spouse" and opening it to edit reads "spouse".
    mount([SPOUSE], { relationshipOptions: SEEDED_0305 });
    expect(screen.getByRole('cell', { name: REL.spouse })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: messages.people.detail.family.edit }));
    const select = within(screen.getByRole('dialog')).getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(select.value).toBe('spouse');
    expect(select.selectedOptions[0].textContent).toBe(REL.spouse);
  });

  it('a CUSTOM relationship the tenant added is still labelled from the catalog — only built-ins are i18n', async () => {
    // The other half of the rule: the catalog is not ignored, it is deferred to for everything the six
    // locales cannot know about.
    mount([], { relationshipOptions: [...SEEDED_0305, { value: 'guardian', label: 'Legal Guardian' }] });
    await userEvent.click(screen.getByRole('button', { name: messages.people.detail.family.add }));
    const select = within(screen.getByRole('dialog')).getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toContain('Legal Guardian');
    expect([...select.options].map((o) => o.textContent)).toContain(REL.spouse);
  });

  it('a stored study country the catalog no longer offers still renders, marked as an existing value', async () => {
    // THE DEFECT THIS PINS. `countryOptions` is loaded active-only, so deactivating a country in System
    // Labels made a child's stored study country match nothing and the select collapse to the
    // placeholder — the screen reading "not set" while the blob still held the value and Activate still
    // wrote it. Same legacy tolerance `ProfileOptionSelect` gives the Personnel dialog, suffix included.
    const { onChange } = mount([{ ...CHILD, studyCountry: 'Brunei' }], {
      countryOptions: [{ value: 'Malaysia', label: 'Malaysia' }],
    });
    await userEvent.click(screen.getByRole('button', { name: messages.people.detail.family.edit }));
    const dlg = screen.getByRole('dialog');
    const select = within(dlg).getByLabelText(messages.people.detail.family.studyCountry) as HTMLSelectElement;
    expect(select.value).toBe('Brunei');
    expect(select.selectedOptions[0].textContent).toBe(`Brunei ${messages.people.detail.optionLegacySuffix}`);
    // …and it must SURVIVE a save from that dialog rather than being silently blanked.
    await userEvent.click(within(dlg).getByRole('button', { name: messages.people.detail.family.save }));
    const [next] = onChange.mock.calls[0] as [EmployeeDraftFamilyMember[]];
    expect(next[0].studyCountry).toBe('Brunei');
  });

  it('a stored relationship the catalog no longer offers still renders and still re-saves', async () => {
    // Legacy tolerance, matching `relationshipOptionsFor` on the Personnel dialog: deactivating a catalog
    // option hides it from NEW picks, it does not strand a record that already uses it.
    const { onChange } = mount([{ key: 'x', fullName: 'Aunt May', relationship: 'guardian' }]);
    await userEvent.click(screen.getByRole('button', { name: messages.people.detail.family.edit }));
    const dlg = screen.getByRole('dialog');
    expect((within(dlg).getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('guardian');
    await userEvent.click(within(dlg).getByRole('button', { name: messages.people.detail.family.save }));
    const [next] = onChange.mock.calls[0] as [EmployeeDraftFamilyMember[]];
    expect(next[0].relationship).toBe('guardian');
  });
});
