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
import { render, screen, waitFor, within } from '@testing-library/react';
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
import { firstDirtyGuard, __resetUnsavedGuards } from '../lib/unsaved-changes';
import type { TabSaveResult } from '../lib/personnel-tab-sections';

const EMPLOYMENT_ID = '11111111-2222-3333-4444-555555555555';
const PERSON_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SAVED_NAME = 'Ali bin Ahmad';
const SAVED_EMAIL = 'ali@acme.test';

/**
 * The two Profile cards that share one Save, shaped like the real ones: separate forms, each with the
 * sibling's value carried through as a hidden input, plus one bucket (b) card OUTSIDE the scope.
 */
function Screen({ save }: { save: (fd: FormData) => Promise<TabSaveResult> }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <TabSaveScope tabKey="profile" employmentId={EMPLOYMENT_ID} saveAction={save}>
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

      {/* BUCKET (b) — a discrete, money-affecting act with its own button, rendered outside the scope the
          way the page renders the Emergency Contact register and the Payroll tab's salary revision. */}
      <form data-testid="salary-revision">
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
    render(<Screen save={save} />);
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
