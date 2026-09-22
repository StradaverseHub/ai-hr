/**
 * 420ebab5 part two — ONE Save per tab, RENDERED.
 *
 * The reported defect ("35 separate save points, nothing tells you what you changed, nothing warns you if
 * you leave") is a behaviour of the running screen, so the thing worth pinning is what a browser actually
 * does with a click and a keystroke — not a class string in a source file. Everything below drives
 * components/tab-save-scope.tsx through real events.
 *
 * WHY A STAND-IN AND NOT THE REAL PAGE. app/admin/personnel/[employmentId]/page.tsx is a 4,700-line async
 * server component that reads the database before it emits a field; it cannot be rendered here. What CAN
 * be rendered is the scope with cards shaped exactly like the real ones — separate `<form>`s carrying
 * `data-save-section`, each with the hidden carry-through inputs the real cards use, and a bucket (b)
 * card sitting OUTSIDE the scope exactly where the page puts the Emergency Contact register. The
 * structural claims about the real page (which forms are inside the scope, which are outside) are pinned
 * separately by test/personnel-tab-save.test.ts against the real source.
 *
 * §4 IS THE ONE THAT MATTERS MOST. It is the safety argument from
 * docs/audits/420ebab5-personnel-save-classification.md, executed: a card the tab does not own is
 * invisible to the change count, is absent from the payload, and survives Discard untouched. A tab-wide
 * "Discard Changes" that appeared to cover a recorded salary revision would be a control lying about what
 * it does, which is worse than the scattered buttons it replaced.
 *
 * §3 is the trap this consolidation introduces and the reason `syncCarriedValues` exists. Personal
 * Details posts the email it does not own, and Contact & Address posts the name it does not own, each as
 * a hidden input, so that saving one card cannot null the other's column. Those hidden values are the
 * LAST SAVED ones. Today the two cards can never be saved in the same request, so it does not matter;
 * under one Save it matters very much, and the assertion is that the hidden mirror carries the value the
 * admin can currently see, not the one the server rendered.
 *
 * Scope note: jsdom applies no CSS and computes no layout, so nothing below claims to have measured the
 * edited-field highlight — only that the attribute the stylesheet keys off is set and cleared.
 */
import { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';

// vi.mock factories are hoisted above every other statement in the file, so anything they close over has
// to be hoisted with them — vi.hoisted is how this repo does that (test/personnel-tab-retention.test.ts).
const { refresh, push, toastSuccess, toastError } = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

import { TabSaveScope } from '../components/tab-save-scope';
import { Combobox } from '../components/ui/combobox';
import { EmployeeSwitcher } from '../app/admin/personnel/employee-switcher';
import { firstDirtyGuard, __resetUnsavedGuards } from '../lib/unsaved-changes';
import type { TabSaveResult } from '../lib/personnel-tab-sections';

const EMPLOYMENT_ID = '11111111-2222-3333-4444-555555555555';
const PERSON_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SAVED_NAME = 'Ali bin Ahmad';
const SAVED_EMAIL = 'ali@acme.test';

const NATIONALITIES = [
  { value: 'malaysian', label: 'Malaysian' },
  { value: 'singaporean', label: 'Singaporean' },
];

/**
 * The two Profile cards that share one Save, shaped like the real ones: separate forms, each with the
 * sibling's value carried through as a hidden input, plus one bucket (b) card OUTSIDE the scope.
 *
 * The Nationality picker is the REAL components/ui/combobox.tsx, not a stand-in. §8 exists because that
 * component commits its selection from a React `onKeyDown` — i.e. on the BUBBLE phase, after the scope's
 * capture-phase Enter guard — and a stubbed select could never reproduce that ordering.
 */
function Screen({
  save,
  revision = async () => undefined,
}: {
  save: (fd: FormData) => Promise<TabSaveResult>;
  /** The bucket (b) card's OWN server action, as a real React 19 form action — see §12. */
  revision?: (fd: FormData) => Promise<void>;
}) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <TabSaveScope tabKey="profile" identity={{ employmentId: EMPLOYMENT_ID }} saveAction={save} covers={['Personal Details']}>
        <form data-save-section="person">
          <input type="hidden" name="employmentId" defaultValue={EMPLOYMENT_ID} />
          <input type="hidden" name="personId" defaultValue={PERSON_ID} />
          {/* owned by the Contact card; carried through so this save keeps it */}
          <input type="hidden" name="primaryEmail" defaultValue={SAVED_EMAIL} />
          <label>
            <span>Full Name</span>
            <input name="fullName" defaultValue={SAVED_NAME} />
          </label>
          <label>
            <span>Religion</span>
            <select name="religion" defaultValue="buddhist">
              <option value="">Not set</option>
              <option value="buddhist">Buddhist</option>
              <option value="hindu">Hindu</option>
            </select>
          </label>
          <div data-field-wrapper="nationality">
            <Combobox
              name="nationality"
              value="malaysian"
              options={NATIONALITIES}
              placeholder="Not set"
              searchPlaceholder="Search nationality"
              noResultsLabel="No matches"
              legacySuffix="(legacy)"
            />
          </div>
        </form>
        <form data-save-section="contact">
          <input type="hidden" name="employmentId" defaultValue={EMPLOYMENT_ID} />
          <input type="hidden" name="personId" defaultValue={PERSON_ID} />
          {/* owned by the Personal Details card; carried through so this save keeps it */}
          <input type="hidden" name="fullName" defaultValue={SAVED_NAME} />
          <label>
            <span>Work Email</span>
            <input name="primaryEmail" defaultValue={SAVED_EMAIL} />
          </label>
        </form>
      </TabSaveScope>

      {/* The two anchor shapes the screen-leaving guard has to tell apart: a real in-app link, and the
          Employment History workbook anchor, which is bare BY DESIGN and downloads without going
          anywhere (app/admin/personnel/[employmentId]/page.tsx). */}
      <a href="/admin/personnel">Back to list</a>
      <a href={`/admin/personnel/${EMPLOYMENT_ID}/movement-export`} data-unsaved-guard="ignore">
        Export to Excel
      </a>

      {/* BUCKET (b) — a discrete, money-affecting act with its own button, rendered outside the scope the
          way the page renders the Emergency Contact register and the Payroll tab's salary revision. */}
      <form data-testid="salary-revision" action={revision}>
        <label>
          <span>New Basic Salary</span>
          <input name="amount" defaultValue="5000" />
        </label>
        <button type="submit">Record revision</button>
      </form>
    </NextIntlClientProvider>
  );
}

type SaveFn = (formData: FormData) => Promise<TabSaveResult>;
const ok = (saved: string[]): TabSaveResult => ({ ok: true, saved });
/** Typed so `save.mock.calls[0][0]` IS the FormData — an untyped vi.fn infers a zero-arg signature. */
const saveMock = (impl: SaveFn) => vi.fn<SaveFn>(impl);

const fields = () => ({
  name: screen.getByLabelText('Full Name') as HTMLInputElement,
  email: screen.getByLabelText('Work Email') as HTMLInputElement,
  religion: screen.getByLabelText('Religion') as HTMLSelectElement,
  salary: screen.getByLabelText('New Basic Salary') as HTMLInputElement,
  saveBtn: screen.getByRole('button', { name: 'Save Changes' }),
  discardBtn: screen.getByRole('button', { name: 'Discard Changes' }),
});

beforeEach(() => {
  __resetUnsavedGuards();
  refresh.mockClear();
  push.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe('§1 one Save per tab, and it starts out with nothing to do', () => {
  it('renders ONE Save and ONE Discard for the whole tab, both inert until something changes', async () => {
    const save = saveMock(async () => ok(['person']));
    render(<Screen save={save} />);

    // The whole point of the item: not one control per card.
    expect(screen.getAllByRole('button', { name: 'Save Changes' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Discard Changes' })).toHaveLength(1);

    const { saveBtn, discardBtn } = fields();
    expect(saveBtn).toBeDisabled();
    expect(discardBtn).toBeDisabled();
    expect(screen.getByText('No unsaved changes')).toBeInTheDocument();

    // A disabled Save must also be an unclickable one — the payload and the dirty state are the same fact.
    await userEvent.click(saveBtn);
    expect(save).not.toHaveBeenCalled();
  });

  it('the bar SAYS which cards it covers, because on three of the four tabs it is not the last thing', () => {
    // r255 — the scope encloses a CONTIGUOUS run of the tab's field-edit cards, so on Profile,
    // Attendance and Employment the sticky bar renders above cards it does not cover (emergency
    // contacts; Work Location + Shift Arrangement; Direct Superior + delegations). Left unlabelled it is
    // a control that appears to do something it does not: edit the Direct Superior, press the Save above
    // it, and the bar answers "No unsaved changes". `covers` is what stops that reading.
    render(<Screen save={saveMock(async () => ok(['person']))} />);
    expect(screen.getByText('This Save covers: Personal Details')).toBeInTheDocument();
  });
});

describe('§2 the reader can see what changed before saving', () => {
  it('counts the edit, marks the field, and lists old value against new value', async () => {
    const user = userEvent.setup();
    render(<Screen save={saveMock(async () => ok(['person']))} />);
    const { name, saveBtn } = fields();

    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');

    await waitFor(() => expect(saveBtn).toBeEnabled());
    expect(screen.getByText('Unsaved changes: 1')).toBeInTheDocument();
    // The attribute app/globals.css keys the highlight off (jsdom has no CSS to measure).
    expect(name).toHaveAttribute('data-edited', 'true');

    await user.click(screen.getByRole('button', { name: 'Review changes' }));
    // By the row's own marker, not by its caption: the caption also exists on the field's <label>.
    const row = document.querySelector('[data-change-row="person.fullName"]') as HTMLTableRowElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText('Full Name')).toBeInTheDocument();
    expect(within(row).getByText(SAVED_NAME)).toBeInTheDocument();
    expect(within(row).getByText('Ali bin Hassan')).toBeInTheDocument();
  });

  it('shows a select by its OPTION TEXT, not its stored value', async () => {
    const user = userEvent.setup();
    render(<Screen save={saveMock(async () => ok(['person']))} />);
    const { religion } = fields();

    await user.selectOptions(religion, 'hindu');
    await user.click(await screen.findByRole('button', { name: 'Review changes' }));

    const row = document.querySelector('[data-change-row="person.religion"]') as HTMLTableRowElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText('Buddhist')).toBeInTheDocument();
    expect(within(row).getByText('Hindu')).toBeInTheDocument();
    expect(within(row).queryByText('buddhist')).not.toBeInTheDocument();
  });

  it('an edit that is typed back to its original value is not a change', async () => {
    const user = userEvent.setup();
    render(<Screen save={saveMock(async () => ok(['person']))} />);
    const { name, saveBtn } = fields();

    await user.type(name, 'X');
    await waitFor(() => expect(saveBtn).toBeEnabled());
    await user.type(name, '{backspace}');

    await waitFor(() => expect(saveBtn).toBeDisabled());
    expect(name).not.toHaveAttribute('data-edited');
    expect(screen.getByText('No unsaved changes')).toBeInTheDocument();
  });
});

describe('§3 the payload — each card still posts its OWN fields, with live carry-through', () => {
  it('packs only the dirty section, namespaced, and names it in `sections`', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    render(<Screen save={save} />);
    const { name } = fields();

    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await user.click(await screen.findByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const fd = save.mock.calls[0]![0] as FormData;
    expect(fd.get('sections')).toBe('person');
    expect(fd.get('employmentId')).toBe(EMPLOYMENT_ID);
    expect(fd.get('tab')).toBe('profile');
    // The card's own payload, unchanged — its identity hidden inputs included.
    expect(fd.get('section.person.fullName')).toBe('Ali bin Hassan');
    expect(fd.get('section.person.personId')).toBe(PERSON_ID);
    // The untouched card contributes NOTHING, so its service is never called.
    expect(fd.get('section.contact.primaryEmail')).toBeNull();
  });

  it('a hidden carry-through mirror posts the value on screen, not the last saved one', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person', 'contact']));
    render(<Screen save={save} />);
    const { name, email } = fields();

    // Both cards edited in one go — impossible before this item, and the exact shape that would let a
    // stale hidden mirror write the OLD name back over the new one.
    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await user.clear(email);
    await user.type(email, 'hassan@acme.test');
    await user.click(await screen.findByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const fd = save.mock.calls[0]![0] as FormData;
    expect(fd.get('sections')).toBe('person,contact');
    expect(fd.get('section.person.fullName')).toBe('Ali bin Hassan');
    expect(fd.get('section.contact.primaryEmail')).toBe('hassan@acme.test');
    // THE ASSERTION THIS SECTION EXISTS FOR: neither mirror is the server-rendered value any more.
    expect(fd.get('section.contact.fullName')).toBe('Ali bin Hassan');
    expect(fd.get('section.person.primaryEmail')).toBe('hassan@acme.test');
  });

  it('a successful save clears the indicator without resetting the fields it just wrote', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    render(<Screen save={save} />);
    const { name, saveBtn } = fields();

    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await user.click(saveBtn);

    await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());
    expect(toastSuccess).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
    // Re-baselined in place: a remount here would race router.refresh() and show the PRE-save value.
    expect(name.value).toBe('Ali bin Hassan');
    expect(name).not.toHaveAttribute('data-edited');
  });

  it('a per-section failure keeps the section that did not commit marked, and says which one broke', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ({
      ok: false,
      saved: ['person'],
      failedSection: 'contact',
      error: 'Invalid email address',
    }));
    render(<Screen save={save} />);
    const { name, email, saveBtn } = fields();

    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await user.clear(email);
    await user.type(email, 'nope');
    await user.click(saveBtn);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid email address'));
    expect(toastError).toHaveBeenCalled();
    // Personal Details committed → clean. Contact did not → still edited, still offered for saving.
    expect(name).not.toHaveAttribute('data-edited');
    expect(email).toHaveAttribute('data-edited', 'true');
    expect(screen.getByText('Unsaved changes: 1')).toBeInTheDocument();
    expect(saveBtn).toBeEnabled();
  });
});

describe('§4 THE FENCE — a card outside the scope is untouched by the tab-wide Save and Discard', () => {
  it('editing a bucket (b) card neither arms the tab Save nor reaches the payload nor is undone by Discard', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    const { rerender } = render(<Screen save={save} />);
    const { name, salary, saveBtn, discardBtn } = fields();

    // A salary revision typed into its own card is invisible to the tab.
    await user.clear(salary);
    await user.type(salary, '9000');
    await new Promise((r) => setTimeout(r, 40));
    expect(saveBtn).toBeDisabled();
    expect(discardBtn).toBeDisabled();
    expect(screen.getByText('No unsaved changes')).toBeInTheDocument();
    expect(salary).not.toHaveAttribute('data-edited');

    // …and it is not swept into the tab's payload when a card the tab DOES own is saved.
    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await user.click(saveBtn);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const fd = save.mock.calls[0]![0] as FormData;
    expect([...fd.keys()].some((k) => k.includes('amount'))).toBe(false);

    // The refresh that save asked for, coming back. Every save on the real page is followed by one; here
    // it has to be handed over by hand, and a Discard pressed before it arrives is deliberately HELD
    // rather than run against markup that is a round trip behind the record (§17).
    rerender(<Screen save={save} />);

    // …and Discard, the dangerous half, leaves it exactly where it was.
    await user.clear(name);
    await user.type(name, 'Ali bin Ismail');
    await waitFor(() => expect(discardBtn).toBeEnabled());
    await user.click(discardBtn);
    await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());
    expect((screen.getByLabelText('New Basic Salary') as HTMLInputElement).value).toBe('9000');
    expect(screen.getByRole('button', { name: 'Record revision' })).toBeInTheDocument();
  });
});

describe('§5 Discard restores the last saved values', () => {
  it('puts every field in the scope back and clears the indicator', async () => {
    const user = userEvent.setup();
    render(<Screen save={saveMock(async () => ok(['person']))} />);
    const { name, email, religion, discardBtn } = fields();

    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await user.clear(email);
    await user.type(email, 'hassan@acme.test');
    await user.selectOptions(religion, 'hindu');
    await waitFor(() => expect(discardBtn).toBeEnabled());

    await user.click(discardBtn);

    await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());
    const after = fields();
    expect(after.name.value).toBe(SAVED_NAME);
    expect(after.email.value).toBe(SAVED_EMAIL);
    expect(after.religion.value).toBe('buddhist');
    expect(after.saveBtn).toBeDisabled();
  });
});

describe('§6 leaving with unsaved changes asks first', () => {
  /** Stands in for the tab strip, which reaches the scope through the same module-level registry. */
  function TabStrip() {
    const [tab, setTab] = useState('profile');
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            const guard = firstDirtyGuard();
            if (guard) return guard.prompt(() => setTab('bankStatutory'));
            setTab('bankStatutory');
          }}
        >
          Bank &amp; Statutory
        </button>
        <p>tab:{tab}</p>
      </div>
    );
  }

  const renderWithStrip = (save: (fd: FormData) => Promise<TabSaveResult>) =>
    render(
      <>
        <Screen save={save} />
        <NextIntlClientProvider locale="en" messages={messages}>
          <TabStrip />
        </NextIntlClientProvider>
      </>,
    );

  const makeDirty = async (user: ReturnType<typeof userEvent.setup>) => {
    const { name, saveBtn } = fields();
    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await waitFor(() => expect(saveBtn).toBeEnabled());
  };

  it('a clean tab switches with no prompt at all', async () => {
    const user = userEvent.setup();
    renderWithStrip(saveMock(async () => ok(['person'])));
    await user.click(screen.getByRole('button', { name: 'Bank & Statutory' }));
    expect(screen.getByText('tab:bankStatutory')).toBeInTheDocument();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('Cancel stays put and keeps the edits', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    renderWithStrip(save);
    await makeDirty(user);

    await user.click(screen.getByRole('button', { name: 'Bank & Statutory' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Unsaved changes')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('tab:profile')).toBeInTheDocument();
    expect((screen.getByLabelText('Full Name') as HTMLInputElement).value).toBe('Ali bin Hassan');
    expect(save).not.toHaveBeenCalled();
  });

  it('Discard drops the edits and lets the switch through', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    renderWithStrip(save);
    await makeDirty(user);

    await user.click(screen.getByRole('button', { name: 'Bank & Statutory' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Discard Changes' }));

    await waitFor(() => expect(screen.getByText('tab:bankStatutory')).toBeInTheDocument());
    expect((screen.getByLabelText('Full Name') as HTMLInputElement).value).toBe(SAVED_NAME);
    expect(save).not.toHaveBeenCalled();
  });

  it('Save writes first and only then lets the switch through', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    renderWithStrip(save);
    await makeDirty(user);

    await user.click(screen.getByRole('button', { name: 'Bank & Statutory' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('tab:bankStatutory')).toBeInTheDocument());
    expect((save.mock.calls[0]![0] as FormData).get('section.person.fullName')).toBe('Ali bin Hassan');
  });

  it('a FAILED save from the prompt keeps the reader on the tab, edits intact', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ({ ok: false, saved: [], failedSection: 'person', error: 'Name required' }));
    renderWithStrip(save);
    await makeDirty(user);

    await user.click(screen.getByRole('button', { name: 'Bank & Statutory' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Name required'));
    expect(screen.getByText('tab:profile')).toBeInTheDocument();
    expect((screen.getByLabelText('Full Name') as HTMLInputElement).value).toBe('Ali bin Hassan');
  });
});

describe('§7 "Open another employee" asks too — the switcher navigates programmatically', () => {
  /**
   * The scope's own screen-leaving guard watches anchor clicks and `beforeunload`. The Search Employee
   * box does neither: it calls `router.push`. That is one of the routes the reporter named ("Open another
   * employee"), so the switcher consults the same registry the tab strip does. Nothing but a render can
   * show that it actually does — a source grep would pass on the import alone.
   */
  const EMPLOYEES = [
    { employmentId: 'ffffffff-0000-0000-0000-000000000001', name: 'Siti Nurhaliza', employeeCode: 'E-0002', company: 'Acme', department: 'Finance' },
  ];

  const renderWithSwitcher = (save: SaveFn) =>
    render(
      <>
        <Screen save={save} />
        <NextIntlClientProvider locale="en" messages={messages}>
          <EmployeeSwitcher employees={EMPLOYEES} currentEmploymentId={EMPLOYMENT_ID} tab="profile" />
        </NextIntlClientProvider>
      </>,
    );

  it('prompts before jumping, and jumps once the edits are discarded', async () => {
    const user = userEvent.setup();
    renderWithSwitcher(saveMock(async () => ok(['person'])));

    const { name, saveBtn } = fields();
    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await waitFor(() => expect(saveBtn).toBeEnabled());

    await user.type(screen.getByRole('combobox', { name: /search/i }), 'Siti');
    await user.click(await screen.findByRole('option', { name: /Siti Nurhaliza/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Unsaved changes')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Discard Changes' }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        '/admin/personnel/ffffffff-0000-0000-0000-000000000001?tab=profile',
      ),
    );
  });

  it('a clean screen jumps straight away', async () => {
    const user = userEvent.setup();
    renderWithSwitcher(saveMock(async () => ok(['person'])));

    await user.type(screen.getByRole('combobox', { name: /search/i }), 'Siti');
    await user.click(await screen.findByRole('option', { name: /Siti Nurhaliza/ }));

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('§8 THE ENTER KEY — a widget that owns it keeps it', () => {
  /**
   * THE BUG THIS SECTION EXISTS FOR was silent data loss, and the worst kind: the change vanished AND the
   * screen said everything was saved.
   *
   * The scope guards Enter from a CAPTURE-phase listener on the tab root, because HTML's implicit
   * submission would otherwise still post the one card left with a single blocking field. React dispatches
   * `onKeyDown` on the way back UP, so for the Combobox — whose documented gesture is type / ArrowDown /
   * Enter — the guard ran first: `buildTabPayload` read the pre-selection DOM, the save wrote the OLD
   * nationality, and `rebaselineSections` then read the now-committed DOM and adopted the value nobody had
   * written as the new baseline. Result: the admin's pick gone, the tab clean, a success toast.
   *
   * `save()` re-diffing the live DOM is the second half of the fix and is why the pick below is packed
   * correctly when the admin does press Save.
   */
  const openNationality = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Malaysian' }));
    const search = await screen.findByPlaceholderText('Search nationality');
    await waitFor(() => expect(search).toHaveFocus());
    return search;
  };

  const nationalityInput = () =>
    document.querySelector('input[name="nationality"]') as HTMLInputElement;

  it('Enter commits the pick, submits nothing, and NEVER saves the value it just replaced', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    render(<Screen save={save} />);
    const { name } = fields();

    // Something else must already be dirty, or `save()` no-ops on an empty section list and the fault is
    // invisible. This is exactly the shape an admin lands in: correct the name, then fix the nationality.
    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await waitFor(() => expect(screen.getByText('Unsaved changes: 1')).toBeInTheDocument());

    await openNationality(user);
    await user.keyboard('{ArrowDown}{Enter}');

    // THE ASSERTION THIS TEST EXISTS FOR: picking an option is not a save.
    expect(save).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    // …and the pick reached the value the form posts, so the tab is MORE dirty, not clean.
    await waitFor(() => expect(nationalityInput().value).toBe('singaporean'));
    await waitFor(() => expect(screen.getByText('Unsaved changes: 2')).toBeInTheDocument());
  });

  it('the review table reads the pick by its LABEL, old against new', async () => {
    const user = userEvent.setup();
    render(<Screen save={saveMock(async () => ok(['person']))} />);

    await openNationality(user);
    await user.keyboard('{ArrowDown}{Enter}');

    await user.click(await screen.findByRole('button', { name: 'Review changes' }));
    const row = document.querySelector('[data-change-row="person.nationality"]') as HTMLTableRowElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText('Malaysian')).toBeInTheDocument();
    expect(within(row).getByText('Singaporean')).toBeInTheDocument();
  });

  it('the pick the admin made is what the consolidated Save posts', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    render(<Screen save={save} />);

    await openNationality(user);
    await user.keyboard('{ArrowDown}{Enter}');

    const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    await user.click(saveBtn);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0]![0] as FormData).get('section.person.nationality')).toBe('singaporean');
  });

  it('Enter in a plain text field still runs the tab-wide save', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    render(<Screen save={save} />);
    const { name } = fields();

    await user.clear(name);
    await user.type(name, 'Ali bin Hassan{Enter}');

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0]![0] as FormData).get('section.person.fullName')).toBe('Ali bin Hassan');
  });
});

describe('§9 a section that appears LATER has been edited zero times', () => {
  /**
   * The Identity No (NRIC) card renders only while the nationality is Malaysian (item 357faecf), so on a
   * non-Malaysian employee it is simply absent when the baseline is taken. Without a baseline of its own
   * it used to be diffed against "there was nothing here before", so the server-rendered IC number it
   * arrived with was reported as an unsaved edit, packed into the payload, and re-written — appending an
   * `employee.ic.updated` event for a number nobody had touched — while the change table told the reader
   * they had typed something they had not.
   */
  function ConditionalScreen({ save }: { save: (fd: FormData) => Promise<TabSaveResult> }) {
    const [showIc, setShowIc] = useState(false);
    return (
      <NextIntlClientProvider locale="en" messages={messages}>
        <TabSaveScope tabKey="profile" identity={{ employmentId: EMPLOYMENT_ID }} saveAction={save} covers={['Personal Details']}>
          <form data-save-section="person">
            <label>
              <span>Full Name</span>
              <input name="fullName" defaultValue={SAVED_NAME} />
            </label>
          </form>
          {showIc && (
            <form data-save-section="ic">
              <input type="hidden" name="personId" defaultValue={PERSON_ID} />
              <label>
                <span>Identity No</span>
                <input name="icNumber" defaultValue="770101011234" />
              </label>
            </form>
          )}
        </TabSaveScope>
        <button type="button" onClick={() => setShowIc((v) => !v)}>
          Toggle NRIC
        </button>
      </NextIntlClientProvider>
    );
  }

  it('the card arrives clean, and is neither counted nor packed until it is actually edited', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['ic']));
    render(<ConditionalScreen save={save} />);

    await user.click(screen.getByRole('button', { name: 'Toggle NRIC' }));
    const ic = await screen.findByLabelText('Identity No');

    // THE ASSERTION: a card that merely appeared reports no change.
    await waitFor(() => expect(ic).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.getByText('No unsaved changes')).toBeInTheDocument();
    expect(document.querySelector('[data-change-row="ic.icNumber"]')).toBeNull();
    expect(ic).not.toHaveAttribute('data-edited');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();

    // …and once it IS edited it behaves like any other section.
    await user.clear(ic);
    await user.type(ic, '900101015030');
    await waitFor(() => expect(screen.getByText('Unsaved changes: 1')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const fd = save.mock.calls[0]![0] as FormData;
    expect(fd.get('sections')).toBe('ic');
    expect(fd.get('section.ic.icNumber')).toBe('900101015030');
  });
});

describe('§10 the screen-leaving guard intercepts LINKS, not downloads', () => {
  /**
   * The guard watches document clicks while the tab is dirty because an in-app link is a client-side
   * navigation `beforeunload` never sees. The Employment History "Export to Excel" anchor is deliberately
   * a bare `<a>` at a route handler that returns a workbook: clicking it downloads a file and leaves the
   * reader exactly where they were. Intercepting it turned a download into an "Unsaved changes" dialog
   * followed by a router.push at a route with no page to render.
   */
  /**
   * What the guard did with this click, read from a BUBBLE-phase listener — which is the only honest
   * vantage point, because the guard runs in the capture phase and an intercepted click never reaches
   * the bubble phase at all (it calls stopPropagation as well as preventDefault). So:
   *   'intercepted' — the bubble listener never fired: the guard swallowed the click.
   *   'through'     — the click arrived intact, default not prevented: the browser will follow the href.
   * The listener prevents the default itself, purely to stop jsdom logging an unimplemented navigation.
   */
  const clickVerdict = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    const seen: boolean[] = [];
    const spy = (e: Event) => {
      seen.push(e.defaultPrevented);
      e.preventDefault();
    };
    document.addEventListener('click', spy);
    try {
      await user.click(screen.getByRole('link', { name: label }));
    } finally {
      document.removeEventListener('click', spy);
    }
    if (seen.length === 0) return 'intercepted';
    return seen[0] ? 'prevented' : 'through';
  };

  const makeDirty = async (user: ReturnType<typeof userEvent.setup>) => {
    const { name, saveBtn } = fields();
    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await waitFor(() => expect(saveBtn).toBeEnabled());
  };

  it('leaves the export anchor alone — no prompt, no router.push, no preventDefault', async () => {
    const user = userEvent.setup();
    render(<Screen save={saveMock(async () => ok(['person']))} />);
    await makeDirty(user);

    expect(await clickVerdict(user, 'Export to Excel')).toBe('through');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    // The edit is still there, still unsaved, still offered.
    expect((screen.getByLabelText('Full Name') as HTMLInputElement).value).toBe('Ali bin Hassan');
    expect(screen.getByText('Unsaved changes: 1')).toBeInTheDocument();
  });

  it('but still stops a real in-app link and asks first', async () => {
    const user = userEvent.setup();
    render(<Screen save={saveMock(async () => ok(['person']))} />);
    await makeDirty(user);

    expect(await clickVerdict(user, 'Back to list')).toBe('intercepted');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Unsaved changes')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Discard Changes' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/personnel'));
  });
});

describe('§11 browser Back asks too', () => {
  /**
   * "Click Back" is one of the five routes the reporter listed, and the only one neither `beforeunload`
   * nor the click guard can see: an App Router history pop is a client-side navigation with no unload and
   * no anchor. The guard is a history sentinel — one extra entry at the same url, pushed the first time
   * the tab goes dirty, so the reader's Back press pops THAT instead of leaving the screen.
   */
  const back = async () => {
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
  };

  const makeDirty = async (user: ReturnType<typeof userEvent.setup>) => {
    const { name, saveBtn } = fields();
    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await waitFor(() => expect(saveBtn).toBeEnabled());
  };

  it('a clean tab never touches history, and a Back on it is left alone', async () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    try {
      render(<Screen save={saveMock(async () => ok(['person']))} />);
      expect(pushState).not.toHaveBeenCalled();

      await back();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(go).not.toHaveBeenCalled();
    } finally {
      pushState.mockRestore();
      go.mockRestore();
    }
  });

  it('a dirty tab arms the sentinel, prompts on Back, and only leaves once the edits are dealt with', async () => {
    const user = userEvent.setup();
    const pushState = vi.spyOn(window.history, 'pushState');
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    try {
      render(<Screen save={saveMock(async () => ok(['person']))} />);
      await makeDirty(user);
      await waitFor(() => expect(pushState).toHaveBeenCalled());

      await back();

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Unsaved changes')).toBeInTheDocument();
      // THE ASSERTION: the reader has NOT gone anywhere yet.
      expect(go).not.toHaveBeenCalled();
      expect((screen.getByLabelText('Full Name') as HTMLInputElement).value).toBe('Ali bin Hassan');

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(go).not.toHaveBeenCalled();

      // Back again, this time discarding: past the re-armed sentinel AND the entry it shadows.
      await back();
      const again = await screen.findByRole('dialog');
      await user.click(within(again).getByRole('button', { name: 'Discard Changes' }));
      await waitFor(() => expect(go).toHaveBeenCalledWith(-2));
      expect((screen.getByLabelText('Full Name') as HTMLInputElement).value).toBe(SAVED_NAME);
    } finally {
      pushState.mockRestore();
      go.mockRestore();
    }
  });

  it('once the edits are saved, Back is completed rather than questioned', async () => {
    const user = userEvent.setup();
    const pushState = vi.spyOn(window.history, 'pushState');
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    try {
      render(<Screen save={saveMock(async () => ok(['person']))} />);
      await makeDirty(user);
      await user.click(screen.getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());

      await back();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // The sentinel is still on the stack, so one step back from it is the reader's real destination.
      expect(go).toHaveBeenCalledWith(-1);
    } finally {
      pushState.mockRestore();
      go.mockRestore();
    }
  });
});

describe('§12 a bucket (b) write is a way off the tab too', () => {
  /**
   * The route nothing used to watch. Adding an emergency contact, archiving a qualification, recording a
   * salary revision — each is a server action whose `redirect()` re-renders the screen, which is neither
   * an anchor click nor an unload nor a history pop. An unsaved Full Name edit went with it silently.
   *
   * The fence of §4 is untouched by this and must stay untouched: the (b) card is still invisible to the
   * change count, still absent from the payload, still not restored by Discard. What changes is only that
   * the tab now ASKS before that card's write throws the pending edits away.
   *
   * `action={revision}` is a real React 19 form action, not an onSubmit spy, because the whole question is
   * whether a document capture listener runs before React dispatches it.
   */
  const makeDirty = async (user: ReturnType<typeof userEvent.setup>) => {
    const { name, saveBtn } = fields();
    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await waitFor(() => expect(saveBtn).toBeEnabled());
  };

  it('a clean tab lets the write straight through, exactly as before', async () => {
    const user = userEvent.setup();
    const revision = vi.fn(async () => undefined);
    render(<Screen save={saveMock(async () => ok(['person']))} revision={revision} />);

    await user.click(screen.getByRole('button', { name: 'Record revision' }));

    await waitFor(() => expect(revision).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a dirty tab asks first, and Cancel writes nothing while keeping the edits', async () => {
    const user = userEvent.setup();
    const revision = vi.fn(async () => undefined);
    render(<Screen save={saveMock(async () => ok(['person']))} revision={revision} />);
    await makeDirty(user);

    await user.click(screen.getByRole('button', { name: 'Record revision' }));

    // THE ASSERTION THIS SECTION EXISTS FOR, checked after the action would have had time to run: the
    // write that reloads the screen — and with it the pending edit — has not happened.
    await new Promise((r) => setTimeout(r, 60));
    expect(revision).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Unsaved changes')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(revision).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Full Name') as HTMLInputElement).value).toBe('Ali bin Hassan');
  });

  it('Discard drops the tab edits and then replays the original submit', async () => {
    const user = userEvent.setup();
    const revision = vi.fn(async () => undefined);
    render(<Screen save={saveMock(async () => ok(['person']))} revision={revision} />);
    await makeDirty(user);

    await user.click(screen.getByRole('button', { name: 'Record revision' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Discard Changes' }));

    // Replayed, not re-implemented — the card's own action runs, once.
    await waitFor(() => expect(revision).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText('Full Name') as HTMLInputElement).value).toBe(SAVED_NAME);
  });

  it('Save writes the tab first and only then replays the submit', async () => {
    const user = userEvent.setup();
    const revision = vi.fn(async () => undefined);
    const save = saveMock(async () => ok(['person']));
    render(<Screen save={save} revision={revision} />);
    await makeDirty(user);

    await user.click(screen.getByRole('button', { name: 'Record revision' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(revision).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0]![0] as FormData).get('section.person.fullName')).toBe('Ali bin Hassan');
  });
});

/**
 * ── §13 (r255) THE BUCKET (b) FORM THAT LIVES INSIDE A CONSOLIDATED CARD ────────────────────────────
 *
 * Until r255 every bucket (b) form on this screen sat outside the scope's subtree, and §12's guard was
 * written to match: it skipped any form the scope CONTAINED, on the assumption that a contained form was
 * one of the tab's own cards. The Employment tab breaks that assumption. Its company-transfer form and
 * its `method="get"` company-change navigation form both render INSIDE the Employment Information card,
 * above the Employment Dates form that carries the section marker — so under the old test they were
 * skipped by the document guard AND ignored by the scope-local one, and submitting either took the
 * reader's unsaved date edits with it in a redirect, silently.
 *
 * THE FENCE IS THE MARKER, NOT THE SUBTREE. That is what these cases pin, from both sides: the contained
 * (b) form still asks before it writes, and it is still invisible to the change count, the payload and
 * Discard's restore — a Discard must never look like it undid a company transfer.
 */
function EmploymentScreen({
  save,
  transfer = async () => undefined,
}: {
  save: (fd: FormData) => Promise<TabSaveResult>;
  transfer?: (fd: FormData) => Promise<void>;
}) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <TabSaveScope tabKey="job" identity={{ employmentId: EMPLOYMENT_ID }} saveAction={save} covers={['Employment Information']}>
        {/* ONE card, two forms — exactly the shape of employmentInfoCard on the real page. */}
        <div data-testid="employment-info-card">
          {/* BUCKET (b): an audited company transfer with a pre-transaction gate. No marker, own button. */}
          <form data-testid="company-transfer" action={transfer}>
            <label>
              <span>New Department</span>
              <input name="departmentId" defaultValue="" />
            </label>
            <button type="submit">Confirm company change</button>
          </form>
          {/* BUCKET (a): the Employment Dates form the tab's one Save owns. */}
          <form data-save-section="employment">
            <input type="hidden" name="employmentId" defaultValue={EMPLOYMENT_ID} />
            <label>
              <span>Confirmation Date</span>
              <input name="confirmationDate" defaultValue="2026-07-01" />
            </label>
          </form>
        </div>
      </TabSaveScope>
    </NextIntlClientProvider>
  );
}

describe('§13 a bucket (b) form INSIDE a consolidated card is still fenced off, and still asks', () => {
  const dirtyTheDates = async (user: ReturnType<typeof userEvent.setup>) => {
    const date = screen.getByLabelText('Confirmation Date') as HTMLInputElement;
    await user.clear(date);
    await user.type(date, '2026-09-30');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled());
  };

  it('editing the (b) form arms nothing: not the count, not the payload, and Discard leaves it alone', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['employment']));
    render(<EmploymentScreen save={save} />);

    const dept = screen.getByLabelText('New Department') as HTMLInputElement;
    await user.type(dept, 'Finance');
    // It is inside the scope's subtree, so the DOM listeners see the keystrokes — and still nothing arms.
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(screen.queryByText('1 change')).not.toBeInTheDocument();

    await dirtyTheDates(user);
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0]![0] as FormData;
    expect(sent.get('sections')).toBe('employment');
    expect(sent.get('section.employment.confirmationDate')).toBe('2026-09-30');
    // Nothing of the transfer form's is in the payload under any namespace.
    expect([...sent.keys()].some((k) => k.includes('departmentId'))).toBe(false);
  });

  it('submitting it while the dates are dirty ASKS first — the old subtree test let this through', async () => {
    const user = userEvent.setup();
    const transfer = vi.fn(async () => undefined);
    render(<EmploymentScreen save={saveMock(async () => ok(['employment']))} transfer={transfer} />);
    await dirtyTheDates(user);

    await user.click(screen.getByRole('button', { name: 'Confirm company change' }));

    // The write that reloads the screen — and with it the unsaved dates — has not happened.
    await new Promise((r) => setTimeout(r, 60));
    expect(transfer).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Unsaved changes')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(transfer).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Confirmation Date') as HTMLInputElement).value).toBe('2026-09-30');
  });

  it('Save writes the tab and only then replays the transfer, unchanged', async () => {
    const user = userEvent.setup();
    const transfer = vi.fn(async () => undefined);
    const save = saveMock(async () => ok(['employment']));
    render(<EmploymentScreen save={save} transfer={transfer} />);
    await dirtyTheDates(user);

    await user.click(screen.getByRole('button', { name: 'Confirm company change' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(transfer).toHaveBeenCalledTimes(1));
  });

  it('the tab’s own card still saves rather than prompting — the marker is what tells them apart', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['employment']));
    render(<EmploymentScreen save={save} />);
    await dirtyTheDates(user);

    // Enter inside the marked form is the consolidated save, not an "unsaved changes" dialog.
    await user.type(screen.getByLabelText('Confirmation Date'), '{Enter}');
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

/**
 * ── §14 (r257) DISCARD PUTS THE INFORMATION BACK TO THE LAST SAVED VERSION ──────────────────────────
 *
 * The plan's own words. §5 above already pins "Discard restores", but it only ever discards a FIRST
 * edit — and on a page nobody has saved yet, "the last saved version" and "the page as it first
 * rendered" are the same string, so §5 cannot tell the two apart. Everything the mechanism actually
 * depends on lives in the gap between them: Discard remounts the scope's subtree (`key={nonce}`), which
 * resets every uncontrolled input to the `defaultValue` its SERVER-RENDERED element carries, and that
 * element is only the last saved one because a successful save calls `router.refresh()` and the fresh
 * RSC payload replaces it. Save's own re-baseline is in-place and deliberately does NOT remount, so
 * nothing else on the save path moves those defaults.
 *
 * So this section drives a SECOND edit after a save, and asserts on the value the FIRST save wrote —
 * a value that does not appear in the initial render at all, which is what makes the assertion able to
 * fail. `rerender` with a new `serverName` IS `router.refresh()` landing; the real page gets the same
 * new element from the server, this test hands it over by hand because there is no server here.
 *
 * THE WINDOW BETWEEN THE SAVE AND THAT PAYLOAD is where this used to go wrong, and §17 below is where it
 * is now pinned: until the refresh comes back, the element this restore reads is still the PRE-save one.
 * r257 first documented that as a stale render and left it; the verify pass measured it properly and it
 * was worse than documented — the pre-save value went back into the input, became the new baseline, and
 * was posted by the next save. `discard` in components/tab-save-scope.tsx now waits for the payload.
 */
function RefreshableScreen({ save, serverName }: { save: SaveFn; serverName: string }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <TabSaveScope tabKey="profile" identity={{ employmentId: EMPLOYMENT_ID }} saveAction={save} covers={['Personal Details']}>
        <form data-save-section="person">
          <input type="hidden" name="employmentId" defaultValue={EMPLOYMENT_ID} />
          <input type="hidden" name="personId" defaultValue={PERSON_ID} />
          <label>
            <span>Full Name</span>
            {/* What the RSC page renders. It changes when — and only when — a save has landed and the
                refresh has come back, which is exactly what makes it "the last saved version". */}
            <input name="fullName" defaultValue={serverName} />
          </label>
          {/* A SECOND field in the SAME section, never saved and never refreshed — §17 edits this one so
              the tab can be dirty without touching the name the first save wrote. */}
          <label>
            <span>Date of Birth</span>
            <input name="dateOfBirth" defaultValue="1990-01-01" />
          </label>
        </form>
      </TabSaveScope>
    </NextIntlClientProvider>
  );
}

describe('§14 Discard restores the LAST SAVED version, not the page as it first rendered', () => {
  const SAVED_ONCE = 'Ali bin Hassan';
  const nameField = () => screen.getByLabelText('Full Name') as HTMLInputElement;

  /** Edit → Save → the refresh lands. The baseline is now SAVED_ONCE, which was never on screen at mount. */
  const saveOnce = async (
    user: ReturnType<typeof userEvent.setup>,
    save: ReturnType<typeof saveMock>,
    rerender: ReturnType<typeof render>['rerender'],
  ) => {
    await user.clear(nameField());
    await user.type(nameField(), SAVED_ONCE);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // A save re-baselines IN PLACE and asks the router to refresh; this is that refresh coming back.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    rerender(<RefreshableScreen save={save} serverName={SAVED_ONCE} />);
    await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());
  };

  it('a second edit discarded lands on what the first save wrote, not on what the page opened with', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    const { rerender } = render(<RefreshableScreen save={save} serverName={SAVED_NAME} />);

    await saveOnce(user, save, rerender);

    await user.clear(nameField());
    await user.type(nameField(), 'Ali bin Ismail');
    const discardBtn = screen.getByRole('button', { name: 'Discard Changes' });
    await waitFor(() => expect(discardBtn).toBeEnabled());

    await user.click(discardBtn);

    // THE ASSERTION THIS SECTION EXISTS FOR.
    await waitFor(() => expect(nameField().value).toBe(SAVED_ONCE));
    expect(nameField().value).not.toBe(SAVED_NAME);
    expect(screen.getByText('No unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    // Discard is not a write.
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('the change summary counts the second edit from the saved value, not from the opening one', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    const { rerender } = render(<RefreshableScreen save={save} serverName={SAVED_NAME} />);

    await saveOnce(user, save, rerender);

    await user.clear(nameField());
    await user.type(nameField(), 'Ali bin Ismail');
    await waitFor(() => expect(screen.getByText('Unsaved changes: 1')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Review changes' }));

    const changeRow = document.querySelector('[data-change-row="person.fullName"]') as HTMLElement | null;
    expect(changeRow).not.toBeNull();
    // "Original" is the LAST SAVED value. Reading the opening render here would tell the admin they had
    // changed something they had already saved.
    expect(within(changeRow!).getByText(SAVED_ONCE)).toBeInTheDocument();
    expect(within(changeRow!).getByText('Ali bin Ismail')).toBeInTheDocument();
    expect(within(changeRow!).queryByText(SAVED_NAME)).not.toBeInTheDocument();
  });
});

/**
 * ── §15 (r257) A RECORDED SALARY REVISION SURVIVES THE TAB'S DISCARD ────────────────────────────────
 *
 * The plan's own worked example, and the sentence the whole classification exists to keep true:
 * "Rolling them into a tab-wide Save would mean Discard Changes could silently undo a salary revision
 * you had already recorded."
 *
 * §4 and §13 pin the half before the write — an unsubmitted (b) form is invisible to the count, the
 * payload and the restore. This section pins the half AFTER it: the revision is actually RECORDED, and
 * only then is the tab's Discard pressed. Nothing may take it back, and nothing may replay it.
 *
 * THE SHAPE IS THE PAYROLL TAB'S, which is the sharpest one on the screen: `setCompensationAction`'s
 * revision dialog and the salary history it appends to both live INSIDE compensationCard, and that card
 * is INSIDE the scope (r256) because the tab's Payment Method field edit is nested in it. So Discard's
 * remount sweeps the very subtree the revision was recorded in. What keeps the record safe is not
 * distance — it is that the fence is the SECTION MARKER: the revision form carries none, so it is never
 * read, marked, packed or reset, and the history it wrote is rendered from state the scope does not own.
 *
 * WHAT THIS CASE DOES **NOT** REST ON, corrected after the r257 verify pass. "The recorded row is still
 * on screen" cannot fail here and is not the proof: the history is rendered by the component that RENDERS
 * the scope, so `key={nonce}` cannot reach it by construction — exactly as on the real page, where it is
 * server markup the remount re-renders unchanged. Stating that as a pinned result was overclaiming. The
 * assertions that CAN fail, and therefore carry the case, are these: the sweep really did happen and
 * really did cross this card (the unmarked Revision Note inside it is back to its server value); the
 * revision's own action ran exactly once and was neither replayed nor reversed; the tab reported nothing
 * to discard the moment the revision was written; and the amount reached no namespace of the payload.
 * The row's presence is kept as a consequence worth reading, below those, and labelled as one.
 */
function PayrollScreen({ save, revise }: { save: SaveFn; revise: (fd: FormData) => void }) {
  // Stands in for the salary history the server re-renders after `setCompensationAction` redirects.
  const [history, setHistory] = useState<string[]>(['5,000.00 from 2026-01-01']);
  const record = async (fd: FormData) => {
    revise(fd);
    setHistory((h) => [...h, `${String(fd.get('amount'))} from ${String(fd.get('effectiveFrom'))}`]);
  };
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <TabSaveScope
        tabKey="payroll"
        identity={{ employmentId: EMPLOYMENT_ID }}
        saveAction={save}
        covers={['How This Employee Is Paid']}
      >
        {/* ONE card, three things — the shape of compensationCard on the real page. */}
        <div data-testid="compensation-card">
          <ul data-testid="revision-history">
            {history.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
          {/* BUCKET (b): the effective-dated revision. Its own button, its own action, NO marker. */}
          <form data-testid="salary-revision" action={record}>
            <label>
              <span>New Basic Salary</span>
              <input name="amount" defaultValue="" />
            </label>
            <label>
              <span>Effective From</span>
              <input name="effectiveFrom" defaultValue="2026-10-01" />
            </label>
            <button type="submit">Record revision</button>
          </form>
          {/* NEITHER BUCKET — a control that belongs to no section and to no (b) form, the shape of the
              Employment tab's company-transfer inputs, which live inside a consolidated card. The remount
              DOES reset this one, and that is what makes "the sweep reached inside this card" an assertion
              capable of failing rather than a claim about geometry. */}
          <label>
            <span>Revision Note</span>
            <input data-testid="revision-note" defaultValue="" />
          </label>
          {/* BUCKET (a): the one field edit nested inside this card, which is why the scope encloses it. */}
          <form data-save-section="payment">
            <input type="hidden" name="employmentId" defaultValue={EMPLOYMENT_ID} />
            <label>
              <span>Payment Method</span>
              <select name="paymentMethod" defaultValue="bank">
                <option value="bank">Bank transfer</option>
                <option value="cash">Cash</option>
              </select>
            </label>
          </form>
        </div>
      </TabSaveScope>
    </NextIntlClientProvider>
  );
}

describe('§15 a revision that was RECORDED is not undone by the tab’s Discard', () => {
  const history = () => within(screen.getByTestId('revision-history'));
  const REVISION = '9000 from 2026-10-01';

  it('records it, then discards the tab, and the revision is still there', async () => {
    const user = userEvent.setup();
    const revise = vi.fn();
    const save = saveMock(async () => ok(['payment']));
    render(<PayrollScreen save={save} revise={revise} />);

    // 1 — typing the revision amount arms nothing at all, even though it is inside the scope's subtree.
    await user.type(screen.getByLabelText('New Basic Salary'), '9000');
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(screen.getByText('No unsaved changes')).toBeInTheDocument();

    // 2 — RECORD it. The tab is clean, so the write goes straight through with no prompt.
    await user.click(screen.getByRole('button', { name: 'Record revision' }));
    await waitFor(() => expect(revise).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(history().getByText(REVISION)).toBeInTheDocument());
    // A revision that has been WRITTEN is not a pending edit: the tab has nothing to save and nothing to
    // discard. Were the revision form ever given a section marker, the amount would read here as an
    // unsaved change and the tab would be offering to discard something already recorded.
    expect(screen.getByText('No unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard Changes' })).toBeDisabled();

    // 3 — type into a control that belongs to nothing, so the sweep has something to prove itself on,
    //     then edit the card's OWN field and press the tab's Discard.
    await user.type(screen.getByLabelText('Revision Note'), 'agreed at review');
    await user.selectOptions(screen.getByLabelText('Payment Method'), 'cash');
    const discardBtn = screen.getByRole('button', { name: 'Discard Changes' });
    await waitFor(() => expect(discardBtn).toBeEnabled());
    await user.click(discardBtn);
    await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());

    // THE ASSERTIONS THIS SECTION EXISTS FOR. First, the remount really happened and really did sweep the
    // INSIDE of the card the revision was recorded in: a control that belongs to no section at all is
    // back to its server value, and so is the field the tab does own. Discard IS reaching this subtree —
    // which is what makes the revision's survival a fact about the fence rather than about distance.
    expect((screen.getByTestId('revision-note') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Payment Method') as HTMLSelectElement).value).toBe('bank');
    // Second, the recorded revision came through that sweep as a WRITE, not as an edit: not reversed,
    // and — the fault a subtree fence would cause — not replayed either.
    expect(revise).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    // And so the row is still on screen. Read as a consequence, not as the proof: the history is state
    // of the component that renders the scope (server markup on the real page), which `key={nonce}`
    // cannot reach — see the note above this describe.
    expect(history().getByText(REVISION)).toBeInTheDocument();
    expect(history().getByText('5,000.00 from 2026-01-01')).toBeInTheDocument();
  });

  it('and the amount that recorded it never reaches the tab’s payload, under any namespace', async () => {
    const user = userEvent.setup();
    const revise = vi.fn();
    const save = saveMock(async () => ok(['payment']));
    render(<PayrollScreen save={save} revise={revise} />);

    await user.type(screen.getByLabelText('New Basic Salary'), '9000');
    await user.click(screen.getByRole('button', { name: 'Record revision' }));
    await waitFor(() => expect(revise).toHaveBeenCalledTimes(1));

    await user.selectOptions(screen.getByLabelText('Payment Method'), 'cash');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0]![0] as FormData;
    expect(sent.get('sections')).toBe('payment');
    expect(sent.get('section.payment.paymentMethod')).toBe('cash');
    expect([...sent.keys()].some((k) => k.includes('amount'))).toBe(false);
    expect([...sent.keys()].some((k) => k.includes('effectiveFrom'))).toBe(false);
  });
});

/**
 * ── §16 (r257) THE LAST WAY OFF THE SCREEN — reload, close, and an address typed into the bar ────────
 *
 * The plan promises that leaving the SCREEN with unsaved changes asks first, and the screen has two kinds
 * of exit. §10 pins the in-app one, which is a client-side navigation no unload event ever sees. This is
 * the other one: a reload, a closed tab, an external address, and the HARD navigation a bare `<a>`
 * performs — every one of which arrives as `beforeunload`, and none of which a router guard can reach.
 * The browser draws its own dialog there, so what a test can pin is the only half the page controls:
 * whether the event is cancelled, and whether it is cancelled on a page with nothing to lose.
 */
describe('§16 a reload or a close asks too, and only when there is something to lose', () => {
  const fireBeforeUnload = () => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e;
  };

  it('a clean tab lets the page go without a word', async () => {
    render(<Screen save={saveMock(async () => ok(['person']))} />);
    await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());

    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('a dirty tab cancels the unload, which is what makes the browser ask', async () => {
    const user = userEvent.setup();
    render(<Screen save={saveMock(async () => ok(['person']))} />);
    const { name, saveBtn } = fields();
    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await waitFor(() => expect(saveBtn).toBeEnabled());

    expect(fireBeforeUnload().defaultPrevented).toBe(true);
  });

  it('and stops asking again the moment the edits are dealt with', async () => {
    const user = userEvent.setup();
    render(<Screen save={saveMock(async () => ok(['person']))} />);
    const { name, discardBtn } = fields();
    await user.clear(name);
    await user.type(name, 'Ali bin Hassan');
    await waitFor(() => expect(discardBtn).toBeEnabled());
    expect(fireBeforeUnload().defaultPrevented).toBe(true);

    await user.click(discardBtn);
    await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());

    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });
});

/**
 * ── §17 (r257 verify) A DISCARD PRESSED BEFORE THE REFRESH COMES BACK CANNOT UN-SAVE A SAVED FIELD ───
 *
 * THE DEFECT THIS PINS, MEASURED RATHER THAN REASONED ABOUT. A successful save re-baselines in place and
 * asks the router to refresh; `router.refresh()` dispatches inside its own transition and returns
 * synchronously, so the bar is live again while `children` still carries the values the page opened with.
 * Discard restores by REMOUNTING that subtree. So a Discard pressed in the window between the two put the
 * PRE-save value back into an input the admin had already saved, the fresh baseline adopted it as "last
 * saved", and the next save of that section posted it — `buildTabPayload` packs every control of a dirty
 * section, and `syncCarriedValues` mirrors the same stale value into the sibling section's carry-through
 * input. r257 first wrote that down as a stale render and left it; the verify pass showed it was a lost
 * save, which is a different thing altogether.
 *
 * WHAT THE FIX IS. `discard` waits for the payload it restores from — see the note over it in
 * components/tab-save-scope.tsx — and nothing can be written on top of it in the meantime. The wait ends
 * when a new `children` identity arrives, which in the real page is the refreshed RSC tree and here is the
 * `rerender` below; it is bounded by REFRESH_WAIT_MS so that a refresh which never comes back cannot leave
 * Discard as a control that does nothing.
 *
 * The window is entered here by saving and NOT calling `rerender` — the save has resolved and the payload
 * has not landed, which is exactly the state the real page is in for one round trip after every save.
 */
describe('§17 a Discard in the refresh window cannot put back a value that was already saved', () => {
  const SAVED_ONCE = 'Ali bin Hassan';
  const DISCARDING = messages.components.tabSave.discarding;
  const nameField = () => screen.getByLabelText('Full Name') as HTMLInputElement;
  const dobField = () => screen.getByLabelText('Date of Birth') as HTMLInputElement;

  /** Save the name and stop there: the action has resolved, the refresh has been ASKED for, and the
   *  payload has not come back (no `rerender`). That is the window. */
  const saveNameAndStayInTheWindow = async (
    user: ReturnType<typeof userEvent.setup>,
    save: ReturnType<typeof saveMock>,
  ) => {
    await user.clear(nameField());
    await user.type(nameField(), SAVED_ONCE);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());
    expect(nameField().value).toBe(SAVED_ONCE);
  };

  /** Then edit a DIFFERENT field of the same section and press Discard. */
  const editDobAndDiscard = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.clear(dobField());
    await user.type(dobField(), '1991-02-02');
    const discardBtn = screen.getByRole('button', { name: 'Discard Changes' });
    await waitFor(() => expect(discardBtn).toBeEnabled());
    await user.click(discardBtn);
  };

  it('holds the discard instead of restoring the pre-save value, and nothing can be written meanwhile', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    render(<RefreshableScreen save={save} serverName={SAVED_NAME} />);

    await saveNameAndStayInTheWindow(user, save);
    await editDobAndDiscard(user);

    // THE ASSERTION THIS SECTION EXISTS FOR, and it is taken the instant the click returns because that
    // is when the remount used to happen: before the fix it put 'Ali bin Ahmad' — the value the page
    // opened with, and the one the record no longer holds — straight back into this input.
    expect(nameField().value).toBe(SAVED_ONCE);
    expect(nameField().value).not.toBe(SAVED_NAME);
    // …and the second half of the same defect: nothing may post while the discard is still owed, or the
    // stale value would be written back under a payload the admin never asked for.
    await waitFor(() => expect(screen.getByRole('button', { name: DISCARDING })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: DISCARDING })).toBeDisabled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('and runs it the moment the refreshed payload lands, so the discard is honoured, not dropped', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    const { rerender } = render(<RefreshableScreen save={save} serverName={SAVED_NAME} />);

    await saveNameAndStayInTheWindow(user, save);
    await editDobAndDiscard(user);
    await waitFor(() => expect(screen.getByRole('button', { name: DISCARDING })).toBeInTheDocument());

    // The refresh coming back — the real page gets this element from the server.
    rerender(<RefreshableScreen save={save} serverName={SAVED_ONCE} />);

    // The held discard runs: the second edit is gone, the tab is clean, the bar is a bar again.
    await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());
    expect(dobField().value).toBe('1990-01-01');
    expect(nameField().value).toBe(SAVED_ONCE);
    expect(screen.getByRole('button', { name: 'Discard Changes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: DISCARDING })).not.toBeInTheDocument();
  });

  it('so the next save of that section carries the name the first save wrote', async () => {
    const user = userEvent.setup();
    const save = saveMock(async () => ok(['person']));
    const { rerender } = render(<RefreshableScreen save={save} serverName={SAVED_NAME} />);

    await saveNameAndStayInTheWindow(user, save);
    await editDobAndDiscard(user);
    rerender(<RefreshableScreen save={save} serverName={SAVED_ONCE} />);
    await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeInTheDocument());

    await user.clear(dobField());
    await user.type(dobField(), '1992-03-03');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));

    // A whole-section pack: the name rides along with the date edit whether it moved or not. It must be
    // the saved one.
    const sent = save.mock.calls[1]![0] as FormData;
    expect(sent.get('section.person.dateOfBirth')).toBe('1992-03-03');
    expect(sent.get('section.person.fullName')).toBe(SAVED_ONCE);
    expect(sent.get('section.person.fullName')).not.toBe(SAVED_NAME);
  });
});
