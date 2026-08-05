/**
 * Item 35b7af0a — THE PROOF THAT THE TWO SCREENS AGREE, taken by rendering rather than by grepping.
 *
 * WHY THIS FILE EXISTS ALONGSIDE test/wizard-personnel-shared-fields.test.ts. That file asserts the two
 * screens IMPORT the shared groups and that the retired catalog keys are gone. Neither of those is the
 * reporter's actual complaint. The complaint is that creating an employee and editing one show different
 * things, and the only way to check that is to render both and compare what a reader SEES. A source grep
 * cannot: `<PersonDetailsFields mode="form" …>` and `<PersonDetailsFields mode="controlled" …>` are
 * different call sites, and a mode branch that dropped an option would satisfy every string assertion.
 *
 * SO EACH GROUP IS RENDERED TWICE — once exactly as the Personnel (Admin) profile renders it (`mode="form"`,
 * uncontrolled, named for a server action) and once exactly as the Create New Employee wizard renders it
 * (`mode="controlled"`) — and the two renders are compared option-for-option and label-for-label. That is
 * the assertion the item is actually about, and it is written so it stays true for groups added later.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression. It is not a substitute for the
 * dev-server render check either — MISSING_MESSAGE only shows there, because NextIntlClientProvider here is
 * given the real catalog and would throw on a missing key rather than paint one.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import { PersonDetailsFields } from '../components/person-details-fields';
import { PayStructureFields } from '../components/pay-structure-fields';
import { BirthDateFields } from '../components/birth-date-fields';
import { EpfRegistrationFields } from '../components/epf-registration-fields';

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

/** Every visible label + value of a <select>, in order — what an HR administrator can actually pick. */
const optionsOf = (el: HTMLElement) =>
  [...el.querySelectorAll('option')].map((o) => `${o.getAttribute('value')}=${o.textContent}`);

/** The whole rendered surface as "label → options / text", so two renders compare in one assertion instead
 *  of one assertion per field (a per-field list is a list somebody forgets to extend).
 *
 *  WHAT IT DELIBERATELY DOES NOT COMPARE: caller-supplied hint text. Two screens asking for the same field
 *  may legitimately explain it differently — the wizard tells HR that a blank Date of Birth is taken from
 *  the identity number, which is true only at hire — and that is guidance, not a field definition. The
 *  label, the control type and the OPTION SET are the field definition, and those are what must match. */
const surfaceOf = (container: HTMLElement) =>
  [...container.querySelectorAll('label')].map((l) => {
    const caption = l.querySelector('span')?.textContent ?? '';
    const select = l.querySelector('select');
    if (select) return `${caption}: [${optionsOf(select).join(' | ')}]`;
    const input = l.querySelector('input');
    if (input) return `${caption}: <input ${input.getAttribute('type') ?? 'text'}>`;
    return `${caption}: ${l.querySelector('p')?.textContent ?? ''}`;
  });

// ── group 1 — Personal Details (Gender + Marital Status) ──────────────────────────────────────────
describe('group 1 — the two screens offer the SAME genders and marital statuses', () => {
  it('renders an identical surface in form mode (Personnel) and controlled mode (wizard)', () => {
    const personnel = wrap(<PersonDetailsFields mode="form" gender="female" maritalStatus="widowed" />);
    const asPersonnel = surfaceOf(personnel.container);
    personnel.unmount();

    const wizard = wrap(
      <PersonDetailsFields
        mode="controlled"
        gender="female"
        maritalStatus="widowed"
        onGenderChange={() => {}}
        onMaritalStatusChange={() => {}}
      />,
    );
    expect(surfaceOf(wizard.container)).toEqual(asPersonnel);
  });

  it('offers all three genders and all six marital statuses — the values the wizard used to be missing', () => {
    // The live defect group 1 fixed: the wizard offered single/married only, so divorced, widowed,
    // separated and undisclosed were unrecordable at hire and recordable one screen later.
    wrap(
      <PersonDetailsFields
        mode="controlled"
        gender=""
        maritalStatus=""
        onGenderChange={() => {}}
        onMaritalStatusChange={() => {}}
      />,
    );
    const gender = screen.getByLabelText('Gender');
    const marital = screen.getByLabelText('Marital status');
    expect(optionsOf(gender)).toEqual([
      '=— Not set', 'male=Male', 'female=Female', 'undisclosed=Undisclosed',
    ]);
    expect(optionsOf(marital).map((o) => o.split('=')[0])).toEqual([
      '', 'single', 'married', 'divorced', 'widowed', 'separated', 'other',
    ]);
  });

  it('form mode posts named values and passes NO handler; controlled mode reports every change', async () => {
    // The two halves of the mode contract, each of which has broken production before: a named/uncontrolled
    // input is what a server action reads out of FormData, and a function prop reaching a server component
    // is the r123 500.
    const { container, unmount } = wrap(
      <PersonDetailsFields mode="form" gender="male" maritalStatus="single" />,
    );
    const named = [...container.querySelectorAll('select')].map((s) => s.getAttribute('name'));
    expect(named).toEqual(['gender', 'maritalStatus']);
    unmount();

    const seen: string[] = [];
    wrap(
      <PersonDetailsFields
        mode="controlled"
        gender=""
        maritalStatus=""
        onGenderChange={(v) => seen.push(`gender=${v}`)}
        onMaritalStatusChange={(v) => seen.push(`marital=${v}`)}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Gender'), 'undisclosed');
    await userEvent.selectOptions(screen.getByLabelText('Marital status'), 'divorced');
    expect(seen).toEqual(['gender=undisclosed', 'marital=divorced']);
  });
});

// ── group 2 — Pay structure ───────────────────────────────────────────────────────────────────────
describe('group 2 — the two screens offer the SAME pay modes and payment terms', () => {
  it('renders an identical surface in both modes', () => {
    const personnel = wrap(
      <PayStructureFields defaultPayMode="daily" defaultPaymentTerm="weekly" defaultRateAmount="180" />,
    );
    const asPersonnel = surfaceOf(personnel.container);
    personnel.unmount();

    const wizard = wrap(
      <PayStructureFields
        mode="controlled"
        payMode="daily"
        paymentTerm="weekly"
        rateAmount="180"
        onChange={() => {}}
      />,
    );
    expect(surfaceOf(wizard.container)).toEqual(asPersonnel);
  });

  it('the Rate box appears only off-monthly, in BOTH modes (one rule, not a per-screen one)', () => {
    // The wizard used to show a bare Rate box on every hire, monthly included.
    const monthly = wrap(
      <PayStructureFields
        mode="controlled"
        payMode="monthly"
        paymentTerm="monthly"
        rateAmount=""
        onChange={() => {}}
      />,
    );
    expect(monthly.container.querySelectorAll('input')).toHaveLength(0);
    monthly.unmount();

    const hourly = wrap(
      <PayStructureFields
        mode="controlled"
        payMode="hourly"
        paymentTerm="monthly"
        rateAmount=""
        onChange={() => {}}
      />,
    );
    // Labelled with its unit and required — the same rule setCompensation enforces server-side.
    expect(screen.getByText(/per hour/i)).toBeInTheDocument();
    expect(hourly.container.querySelector('input')).toBeRequired();
  });
});

// ── group 3 — Date of Birth + Age ─────────────────────────────────────────────────────────────────
describe('group 3 — Date of Birth carries the auto-calculated Age on BOTH screens', () => {
  it('renders an identical surface in form mode (Personnel) and controlled mode (wizard)', () => {
    const personnel = wrap(
      <BirthDateFields mode="form" inputId="profile-dob-input" dateOfBirth="1990-01-01" today="2026-07-23" />,
    );
    const asPersonnel = surfaceOf(personnel.container);
    personnel.unmount();

    const wizard = wrap(
      <BirthDateFields mode="controlled" dateOfBirth="1990-01-01" today="2026-07-23" onChange={() => {}} />,
    );
    expect(surfaceOf(wizard.container)).toEqual(asPersonnel);
  });

  it("shows the reporter's example age, and the SAME figure on both screens", () => {
    const personnel = wrap(
      <BirthDateFields mode="form" inputId="profile-dob-input" dateOfBirth="1990-01-01" today="2026-07-23" />,
    );
    expect(within(personnel.container).getByText('36 Years')).toBeInTheDocument();
    personnel.unmount();

    const wizard = wrap(
      <BirthDateFields mode="controlled" dateOfBirth="1990-01-01" today="2026-07-23" onChange={() => {}} />,
    );
    expect(within(wizard.container).getByText('36 Years')).toBeInTheDocument();
  });

  it('a blank or malformed DOB reads Not Available rather than NaN', () => {
    const blank = wrap(<BirthDateFields mode="controlled" dateOfBirth="" today="2026-07-23" onChange={() => {}} />);
    expect(within(blank.container).getByText('Not Available')).toBeInTheDocument();
    blank.unmount();

    // A stored draft is free-form JSON and can hold anything; `new Date('nonsense')` yields NaN years.
    const junk = wrap(
      <BirthDateFields mode="controlled" dateOfBirth="not-a-date" today="2026-07-23" onChange={() => {}} />,
    );
    expect(within(junk.container).getByText('Not Available')).toBeInTheDocument();
    expect(junk.container.textContent).not.toContain('NaN');
  });

  it('the Age is read-only and is never submitted — one date input, no second field to save', () => {
    const { container } = wrap(
      <BirthDateFields mode="form" inputId="profile-dob-input" dateOfBirth="1990-01-01" today="2026-07-23" />,
    );
    const inputs = [...container.querySelectorAll('input')];
    expect(inputs).toHaveLength(1);
    expect(inputs[0].getAttribute('name')).toBe('dateOfBirth');
    expect(inputs[0].getAttribute('id')).toBe('profile-dob-input');
    // Uncontrolled: components/ic-dob-autofill.tsx writes this node's .value directly with no React event,
    // and a controlled input would discard that write on the next render (item 354a500d).
    expect(inputs[0]).toHaveValue('1990-01-01');
    expect(within(container).getByText('36 Years').tagName).toBe('P');
  });

  it('the Age follows what is typed, on both screens', async () => {
    // Wizard: the parent owns the value, so the re-render carries the new age.
    const wizard = wrap(
      <BirthDateFields mode="controlled" dateOfBirth="2000-07-15" today="2026-07-23" onChange={() => {}} />,
    );
    expect(within(wizard.container).getByText('26 Years')).toBeInTheDocument();
    wizard.unmount();

    // Personnel: the input stays UNCONTROLLED (the server action reads it out of FormData) and the group
    // merely observes it, so the age updates before the save rather than only after it.
    const { container } = wrap(
      <BirthDateFields mode="form" inputId="profile-dob-input" dateOfBirth="1990-01-01" today="2026-07-23" />,
    );
    expect(within(container).getByText('36 Years')).toBeInTheDocument();
    const input = container.querySelector('input')!;
    await userEvent.clear(input);
    await userEvent.type(input, '2000-07-15');
    expect(within(container).getByText('26 Years')).toBeInTheDocument();
    // Still uncontrolled and still named — the observation must not have taken ownership of the field.
    expect(input.getAttribute('name')).toBe('dateOfBirth');
    expect(input).toHaveValue('2000-07-15');
  });

  it('a newly stored DOB from the server wins over what was typed locally (no stale age)', async () => {
    // The real sequence on the Personnel page, which is why the observed copy needs a reset rather than
    // living forever: HR types a DOB into the compliance card WITHOUT saving it, then saves the Identity
    // card instead — setIcAction persists the IC-derived DOB, the page re-renders with a different stored
    // value, and an age still showing the abandoned typed date would be simply wrong.
    const page = (dob: string) => (
      <NextIntlClientProvider locale="en" messages={messages}>
        <BirthDateFields mode="form" inputId="profile-dob-input" dateOfBirth={dob} today="2026-07-23" />
      </NextIntlClientProvider>
    );
    const { container, rerender } = render(page('1990-01-01'));
    expect(within(container).getByText('36 Years')).toBeInTheDocument();

    const input = container.querySelector('input')!;
    await userEvent.clear(input);
    await userEvent.type(input, '2010-03-04');
    expect(within(container).getByText('16 Years')).toBeInTheDocument();

    rerender(page('2000-07-15'));
    expect(within(container).getByText('26 Years')).toBeInTheDocument();
  });
});

// ── group 4 — EPF registration ────────────────────────────────────────────────────────────────────
describe('group 4 — the two screens offer the SAME EPF citizenships, in the same words', () => {
  it('renders an identical surface in form mode (Personnel) and controlled mode (wizard)', () => {
    const personnel = wrap(<EpfRegistrationFields mode="form" epfNumber="123456789" epfCitizenship="pr" />);
    const asPersonnel = surfaceOf(personnel.container);
    personnel.unmount();

    const wizard = wrap(
      <EpfRegistrationFields mode="controlled" epfNumber="123456789" epfCitizenship="pr" onChange={() => {}} />,
    );
    expect(surfaceOf(wizard.container)).toEqual(asPersonnel);
  });

  it('offers exactly the three values the column can hold, in the Personnel wording', () => {
    // The wizard used to say "Citizen / Permanent resident / Non-citizen" AND offer a fourth "— Not set —"
    // that `epf_citizenship NOT NULL DEFAULT 'citizen'` has never been able to store: choosing it produced
    // 'citizen' anyway, and the profile screen then showed "Malaysian citizen" for a foreign worker whose
    // recruiter had deliberately left it blank.
    wrap(<EpfRegistrationFields mode="controlled" epfNumber="" epfCitizenship="" onChange={() => {}} />);
    expect(optionsOf(screen.getByLabelText('EPF citizenship'))).toEqual([
      'citizen=Malaysian citizen',
      'pr=Permanent resident (PR)',
      'non_citizen=Non-citizen (foreign worker)',
    ]);
  });

  it('an unset or unrecognised value DISPLAYS the column default without being written anywhere', () => {
    // Displayed, not written: completeEmployeeDraft creates the Malaysian statutory row only when some
    // statutory field is non-blank (hasAnyStatutory), so a default written into the draft merely because
    // the field was rendered would conjure a statutory row for every hire that has none today. Rendering
    // must therefore be silent — not one patch until HR actually picks something.
    const patches: unknown[] = [];
    const { unmount } = wrap(
      <EpfRegistrationFields
        mode="controlled"
        epfNumber=""
        epfCitizenship=""
        onChange={(p) => patches.push(p)}
      />,
    );
    expect(screen.getByLabelText('EPF citizenship')).toHaveValue('citizen');
    expect(patches).toEqual([]);
    unmount();

    // A legacy / half-written draft value falls back the same way rather than leaving the select showing an
    // option it is not actually set to.
    wrap(
      <EpfRegistrationFields
        mode="controlled"
        epfNumber=""
        epfCitizenship="alien"
        onChange={(p) => patches.push(p)}
      />,
    );
    expect(screen.getByLabelText('EPF citizenship')).toHaveValue('citizen');
    expect(patches).toEqual([]);
  });

  it('form mode posts the named values setStatutoryAction reads, and passes NO handler', () => {
    const { container } = wrap(
      <EpfRegistrationFields mode="form" epfNumber="123456789" epfCitizenship="non_citizen" />,
    );
    expect(container.querySelector('input')!.getAttribute('name')).toBe('epfNumber');
    expect(container.querySelector('input')!).toHaveValue('123456789');
    const select = container.querySelector('select')!;
    expect(select.getAttribute('name')).toBe('epfCitizenship');
    expect(select).toHaveValue('non_citizen');
  });

  it('controlled mode reports each change as a patch the draft can merge', async () => {
    const patches: unknown[] = [];
    wrap(
      <EpfRegistrationFields
        mode="controlled"
        epfNumber=""
        epfCitizenship="citizen"
        onChange={(p) => patches.push(p)}
      />,
    );
    await userEvent.type(screen.getByLabelText('EPF number'), '9');
    await userEvent.selectOptions(screen.getByLabelText('EPF citizenship'), 'pr');
    // One key per field, so the wizard's `set('statutory', patch)` merges without touching the other.
    expect(patches).toEqual([{ epfNumber: '9' }, { epfCitizenship: 'pr' }]);
  });
});
