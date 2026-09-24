/**
 * ITEM da7463b4, ON THE SCREEN — the Create New Employee draft's Profile tab, rendered and typed into.
 *
 * The sibling node file pins the rules, the pairing and the database. NONE OF THAT IS WHAT THE REPORTER
 * LOOKED AT. Their complaint is about a screen: an NRIC typed into the draft left the Date of Birth blank
 * and the Age reading "Not Available", and there was nowhere on it to put an address at all. Both of
 * those pass tsc, pass the suite and return a 200, so they are only visible by rendering the thing and
 * doing what an administrator does.
 *
 * WHAT MAKES THE ASSERTIONS NON-VACUOUS. The Age is not a field and has no value to read — it is a `<p>`
 * rendered from the Date of Birth by `completedYearsAt`. So "the NRIC filled the Age" is asserted as the
 * YEAR COUNT appearing on screen, which is false unless the derivation ran, the state updated, and
 * BirthDateFields recomputed. A test that only read the date input back would pass on a build where the
 * Age never refreshed, which is the half of the complaint that was actually visible to the reporter.
 *
 * IT IS ALSO A MISSING_MESSAGE CHECK. `NextIntlClientProvider` is given the REAL en.json and next-intl
 * throws on an unresolved key rather than painting one, so every literal key these components use is
 * exercised by rendering — including the `people.detail` keys the draft now borrows through the shared
 * components. (Coverage in the other five locales is asserted on the raw files in the node file, because
 * i18n/request.ts deep-merges over English and a clean render proves nothing about them.)
 *
 * Scope note, inherited from the other .dom tests: jsdom applies no CSS and computes no layout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { EmployeeDraftData } from '../lib/employee-draft-schema';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

// TYPED ARGUMENTS on purpose: the assertions below read what the screen SENT, which is the only way to
// prove that a value is stored rather than merely displayed. An untyped `vi.fn(async () => …)` records
// calls as `[]` and tsc refuses to index them.
const saveDraftAction = vi.fn(async (_id: string | undefined, _data: EmployeeDraftData, _step: number) => ({ id: 'draft-1' }));
const discardDraftAction = vi.fn(async () => {});
const createEmployeeAction = vi.fn(async () => ({ employmentId: 'emp-1' }));
vi.mock('../app/admin/personnel/new/actions', () => ({
  saveDraftAction: (...a: unknown[]) => saveDraftAction(...(a as Parameters<typeof saveDraftAction>)),
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
  nationalityOptions: [
    { value: 'Malaysian', label: 'Malaysian' },
    { value: 'Indonesian', label: 'Indonesian' },
  ],
  profileOptions: {
    salutation: [{ value: 'Mr', label: 'Mr' }],
    religion: [{ value: 'Islam', label: 'Islam' }],
    race: [{ value: 'Malay', label: 'Malay' }],
  },
  relationshipOptions: [{ value: 'spouse', label: 'Spouse' }],
  countryOptions: [{ value: 'Malaysia', label: 'Malaysia' }],
  stateOptions: [
    { value: 'Selangor', label: 'Selangor' },
    { value: 'Perak', label: 'Perak' },
  ],
};

/** A real MyKad, the date it means, and the age that date reaches by `today` below. */
const IC_A = '900101011234';
const IC_B = '850615085678';
/** Twelve digits whose first six are month 13 — derives nothing, refuses nothing. */
const IC_UNREAL = '991301011234';
/** Fixed, so no assertion here depends on the day the suite runs (CLAUDE.md §8: derive, never hardcode a
 *  future date — this is the clock the component is GIVEN, which is the seam that makes that possible). */
const TODAY = '2026-01-01';

const draftWith = (profile: Partial<NonNullable<EmployeeDraftData['profile']>>): EmployeeDraftData => ({
  profile: { fullName: 'Nadia Yusof', primaryEmail: 'nadia@acme.test', employeeCode: 'ABC00100', nationality: 'Malaysian', ...profile },
  employment: { companyId: 'co-1' },
});

function open(data: EmployeeDraftData) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">
      <EmployeeWizard
        today={TODAY}
        draftId="draft-1"
        reservedEmployeeCode="ABC00100"
        initialData={data}
        initialStep={1}
        initialTab="profile"
        {...OPTIONS}
      />
    </NextIntlClientProvider>,
  );
}

/** The Date of Birth input — the only `type="date"` on the Profile tab. */
const dobInput = () => document.querySelector('input[type="date"]') as HTMLInputElement;
const icInput = () => screen.getByLabelText('Identity No (NRIC)') as HTMLInputElement;
const byId = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;

describe('da7463b4 — the draft Profile tab, rendered', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(a) a valid Malaysian NRIC fills the Date of Birth AND the Age', async () => {
    const user = userEvent.setup();
    open(draftWith({}));
    // Before: no date, and the Age is the record's own "Not Available" fallback.
    expect(dobInput().value).toBe('');
    expect(screen.getByText('Not Available')).toBeTruthy();

    await user.type(icInput(), IC_A);

    expect(dobInput().value, 'the NRIC did not fill the date of birth').toBe('1990-01-01');
    // THE ASSERTION THAT MATTERS. The reporter sees the Age, not the derivation; "36 Years" can only
    // appear if the derived date reached the draft's state and BirthDateFields recomputed from it.
    expect(screen.getByText('36 Years'), 'the Age did not follow the derived date of birth').toBeTruthy();
  });

  it('(a2) REOPENING a draft that already carries an NRIC fills the Date of Birth and Age too', () => {
    // FOUND BY THE RENDER CHECK, NOT BY A TEST, and it is the case that matters most: a draft is filled in
    // over several days, so the common state is one REOPENED with an NRIC already on it — typed last week,
    // or saved by a build that had no autofill at all. Deriving only on a keystroke would leave every one
    // of those drafts reading "Not Available" for ever, which is the reporter's sentence verbatim. The
    // activated record has always derived on mount (components/ic-dob-autofill.tsx); the draft now does
    // too, so the two agree on a reopened record and not only on a freshly typed one.
    open(draftWith({ icNumber: IC_A }));
    expect(dobInput().value, 'a stored NRIC did not fill the date of birth on open').toBe('1990-01-01');
    expect(screen.getByText('36 Years')).toBeTruthy();
  });

  it('(a3) …but a stored hand-typed Date of Birth still wins over the stored NRIC', () => {
    // The mount derivation goes through the same `nextAutofilledDob` guard as a keystroke, so opening a
    // draft can never rewrite a date somebody typed into it.
    open(draftWith({ icNumber: IC_A, dateOfBirth: '1979-12-31' }));
    expect(dobInput().value).toBe('1979-12-31');
  });

  it('(b) an INCOMPLETE or UNREAL NRIC fills nothing, and blocks nothing', async () => {
    const user = userEvent.setup();
    open(draftWith({}));

    await user.type(icInput(), '9001');
    expect(dobInput().value, 'a half-typed NRIC filled a date').toBe('');
    // …and it does not nag: the "not a real date" note belongs to a COMPLETE number.
    expect(screen.queryByText(/first six digits/), 'nagged about an incomplete number').toBeNull();

    await user.clear(icInput());
    await user.type(icInput(), IC_UNREAL);
    expect(dobInput().value, 'an unreal NRIC filled a date').toBe('');
    expect(screen.getByText(/first six digits/), 'the unreal date was not named').toBeTruthy();
    expect(screen.getByText('Not Available'), 'the Age should still be unknown').toBeTruthy();

    // AND IT DOES NOT BLOCK. Save Draft is the act the reporter's "must not block" is about, and a draft
    // that refuses to save until it is correct is not a draft. The value goes to the server as typed.
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    expect(saveDraftAction, 'an unreal NRIC stopped Save Draft').toHaveBeenCalled();
    expect(saveDraftAction.mock.calls[0][1].profile!.icNumber).toBe(IC_UNREAL);
  });

  it('(c) CHANGING the NRIC moves the Date of Birth — but never over a hand-typed one', async () => {
    const user = userEvent.setup();
    open(draftWith({}));

    await user.type(icInput(), IC_A);
    expect(dobInput().value).toBe('1990-01-01');

    // The corrected NRIC. THE DECISION: on a draft, on screen, the derived date FOLLOWS. See the header of
    // `nextAutofilledDob` — this is deliberately not `dobOnlyIfEmpty`, which guards a PERSISTED date.
    await user.clear(icInput());
    await user.type(icInput(), IC_B);
    expect(dobInput().value, 'the corrected NRIC left the first NRIC’s date behind').toBe('1985-06-15');
    expect(screen.getByText('40 Years')).toBeTruthy();

    // Now a HUMAN types a date. From here the NRIC may not touch it: a typed date is a statement about a
    // person, an NRIC is a guess about one.
    await user.clear(dobInput());
    await user.type(dobInput(), '1979-12-31');
    await user.clear(icInput());
    await user.type(icInput(), IC_A);
    expect(dobInput().value, 'a hand-typed date of birth was overwritten').toBe('1979-12-31');
  });

  it('(d) a NON-MALAYSIAN nationality derives nothing — there is no NRIC to derive from', () => {
    open(draftWith({ nationality: 'Indonesian', dateOfBirth: '' }));
    // Item 357faecf's rule, applied identically on both screens: the field is NOT RENDERED for a
    // nationality no registered pack claims, so nothing is collected and nothing is derived.
    expect(screen.queryByLabelText('Identity No (NRIC)'), 'an NRIC box was offered to a non-Malaysian').toBeNull();
    expect(dobInput().value).toBe('');
    expect(screen.getByText('Not Available')).toBeTruthy();
  });

  it('renders BOTH address blocks, with the record’s own headings and the record’s own ids', () => {
    open(draftWith({}));
    expect(screen.getByText('Permanent address')).toBeTruthy();
    expect(screen.getByText('Correspondence address')).toBeTruthy();
    // The ids are the contract the "same as permanent" island resolves on the activated record; the draft
    // renders the same ones through the same component, which is what makes the two screens one design.
    for (const suffix of ['addressLine1', 'addressLine2', 'addressLine3', 'postcode', 'city', 'state', 'country']) {
      expect(byId(`perm-${suffix}`), `perm-${suffix}`).toBeTruthy();
      expect(byId(`corr-${suffix}`), `corr-${suffix}`).toBeTruthy();
    }
    expect(byId('corr-mobile-phone')).toBeTruthy();
    expect(byId('corr-home-phone')).toBeTruthy();
  });

  it('(f) "same as permanent" is a RULE: a LATER edit to the permanent address follows through', async () => {
    const user = userEvent.setup();
    open(draftWith({}));

    await user.type(byId('perm-addressLine1') as HTMLInputElement, '1 Jalan Lama');
    await user.type(byId('perm-city') as HTMLInputElement, 'Klang');
    await user.click(screen.getByLabelText('Same as permanent address'));

    expect((byId('corr-addressLine1') as HTMLInputElement).value).toBe('1 Jalan Lama');
    expect((byId('corr-city') as HTMLInputElement).value).toBe('Klang');
    // A copy you can type into is how the pair silently diverges, so while the rule is on the
    // correspondence side is a derived VIEW, not an input.
    expect((byId('corr-addressLine1') as HTMLInputElement).disabled).toBe(true);

    // THE FOLLOW-UP EDIT — the failure a one-shot copy has and this does not.
    await user.clear(byId('perm-addressLine1') as HTMLInputElement);
    await user.type(byId('perm-addressLine1') as HTMLInputElement, '2 Jalan Baru');
    expect((byId('corr-addressLine1') as HTMLInputElement).value, 'the correspondence address did not follow')
      .toBe('2 Jalan Baru');

    // And it is STORED, not merely displayed: a Save carries the tick, so the correction still follows
    // after the draft is closed and reopened days later.
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    const sent = saveDraftAction.mock.calls.at(-1)![1];
    expect(sent.profile!.sameAsPermanent).toBe('yes');
    expect(sent.profile!.correspondenceAddressLine1).toBe('2 Jalan Baru');
  });

  it('unticking makes the two independent again, keeping what was copied', async () => {
    const user = userEvent.setup();
    open(draftWith({ permanentAddressLine1: '1 Jalan Lama', sameAsPermanent: 'yes', correspondenceAddressLine1: '1 Jalan Lama' }));

    await user.click(screen.getByLabelText('Same as permanent address'));
    const corr = byId('corr-addressLine1') as HTMLInputElement;
    expect(corr.disabled, 'unticking must return the field').toBe(false);
    expect(corr.value, 'unticking must not blank what was copied').toBe('1 Jalan Lama');

    await user.clear(corr);
    await user.type(corr, 'PO Box 9');
    await user.clear(byId('perm-addressLine1') as HTMLInputElement);
    await user.type(byId('perm-addressLine1') as HTMLInputElement, '5 Jalan Sendiri');
    expect((byId('corr-addressLine1') as HTMLInputElement).value, 'an unticked block still followed').toBe('PO Box 9');
  });
});
