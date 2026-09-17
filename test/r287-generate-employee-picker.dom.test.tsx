/**
 * r287 (ff1c935f) — "FIX THE PICK INDIVIDUALLY EMPLOYEE SELECTION", RENDERED AND DRIVEN.
 *
 * ── WHAT WAS ACTUALLY WRONG, because the plan's own diagnosis was half right ──────────────────────────
 * The reporter picked "Pick individually", typed a name, and the screen sat on "Working it out…" with no
 * result. The plan said the box was matching typed text against employee REFERENCES and finding none.
 * It is not. `core/org-criteria.ts` `resolveOrgCriteriaTargets` puts the contents of `employmentIdsRaw`
 * straight into `employment.id IN (…)`, and `employment.id` is a **uuid** column:
 *
 *     ai_hr_dev=# select count(*) from employment where id in ('Irwin');
 *     ERROR:  invalid input syntax for type uuid: "Irwin"
 *
 * So a typed name does not resolve to nothing — the statement is REJECTED, `previewLeaveGenerationAction`
 * rejects with it, and `GenerateForm`'s catch set `preview` back to null. Null was rendered as the PENDING
 * sentence, which is why "Working it out…" stayed on screen forever instead of ever becoming an answer.
 * That is two defects wearing one symptom, and both are pinned below (§A and §D).
 *
 * ── WHY THIS FILE IS A DOM TEST AND NOT A SOURCE SCAN ─────────────────────────────────────────────────
 * Every claim here is about what an operator SEES after typing and clicking: which rows are offered, what
 * is said when none are, whether the search box survives a pick, whether Next is reachable. A source scan
 * can assert the strings exist; only a render can assert they appear at the right moment. Four vacuous
 * guards were found in this session's earlier rounds and every one of them was a scan that matched code
 * the defect had left intact.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * a row the popover is FILTERING OUT is asserted as the `hidden` class the component sets, not as computed
 * visibility. `optionsOffered` below encodes that once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { GenerateForm } from '../components/leave/generate-form';
import type { CriteriaSection } from '../core/org-criteria-form';
import type { LeaveGenerationResult } from '../core/leave-generation';

const L = messages.admin.leave as unknown as Record<string, string>;

/** Real-shaped employment ids: the field holds uuids, and a fixture that pretends otherwise proves less. */
const IRWIN = '11111111-1111-4111-8111-111111111111';
const NADIA = '22222222-2222-4222-8222-222222222222';
const DANIEL = '33333333-3333-4333-8333-333333333333';

const employees = [
  // Ordered by full name, as `listEmployees` returns them — the picker must not re-sort.
  { id: DANIEL, name: 'Daniel Tan', employeeCode: 'EMP-0005' },
  { id: IRWIN, name: 'Irwin Tan', employeeCode: 'EMP-0008' },
  { id: NADIA, name: 'Nadia Rahim', employeeCode: null },
];

const criteriaSections: CriteriaSection[] = [
  {
    key: 'company',
    title: 'Company Information',
    fields: [{ name: 'companyIds', label: 'Company', kind: 'multi', options: [{ value: 'c1', label: 'Acme' }] }],
  },
];

const emptyResult = (selected: number): LeaveGenerationResult => ({
  year: 2026,
  employeesSelected: selected,
  employeesReached: selected,
  employeesPassed: selected,
  employeesFailed: 0,
  granted: selected,
  skipped: 0,
  forfeits: 0,
  lines: [],
  decidedBy: [],
  // r301 (e5018593) — no earned line in this fixture, so no earned Annual Leave half.
  accrual: null,
});

/** Every payload the component has asked the server about, in order. */
let payloads: Parameters<Parameters<typeof GenerateForm>[0]['previewAction']>[0][] = [];
const preview = vi.fn(async (p: (typeof payloads)[number]) => {
  payloads.push(p);
  return emptyResult(p.employmentIds.length);
});

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GenerateForm
        action={() => {}}
        previewAction={preview}
        years={[2025, 2026]}
        defaultYear={2026}
        leaveTypes={[{ value: 'lt-annual', label: 'Annual Leave' }]}
        criteriaSections={criteriaSections}
        employees={employees}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  preview.mockClear();
  payloads = [];
});

/** Walk to step ③ and switch to Pick individually — the branch this whole round is about. */
async function openPickIndividually(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: L.generateStepWho }));
  await user.click(screen.getByRole('radio', { name: L.adjustmentsByIndividual }));
}

/** The popover panel, reached through its own search box (the only control unique to it). */
const searchBox = () => screen.getByPlaceholderText(L.generateEmployeeSearchPlaceholder) as HTMLInputElement;
const panel = () => searchBox().parentElement!;

/**
 * The option rows the popover is currently OFFERING. Every option stays mounted; the component narrows by
 * putting `hidden` on the rows it filters out (see the scope note in this file's header), so "offered"
 * means "mounted without that class".
 */
const optionsOffered = (): string[] =>
  [...panel().querySelectorAll('label')]
    .filter((el) => !el.className.includes('hidden'))
    .map((el) => el.textContent?.trim() ?? '');

/**
 * The paste box, by its POSTED NAME rather than by its accessible name.
 *
 * REASON, so a later reader does not read this as laziness: <Field> renders a <label> wrapping the caption,
 * the control AND the help paragraph, so the computed accessible name of this textarea is the caption plus
 * the whole of `generatePasteAlternativeHelp`. Matching on that would be a test of the help text's wording.
 * The field is separately asserted to BE labelled, once, in §C.
 */
const pasteBox = (): HTMLTextAreaElement =>
  document.querySelector('textarea[name="employmentIdsRaw"]') as HTMLTextAreaElement;

/** What the form would POST for the picker: the MultiSelectPopover hidden-input contract. */
const postedIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('input[type="hidden"][name="employmentIds"]')].map(
    (el) => (el as HTMLInputElement).value,
  );

const lastPayload = () => payloads[payloads.length - 1];

describe('r287 §A · the three terminal states — the whole of the complaint', () => {
  it('① A SEARCH WITH MATCHES offers exactly the matching rows, and no empty-state line', async () => {
    const user = userEvent.setup();
    mount();
    await openPickIndividually(user);
    await user.click(screen.getByRole('button', { name: L.generateEmployeePicker }));

    // Unfiltered, the picker offers everyone the page read — this is the "scalable selection experience"
    // half of the request and it is also the control case for the two states below.
    expect(optionsOffered()).toHaveLength(3);

    await user.type(searchBox(), 'Irwin');
    expect(optionsOffered()).toEqual(['Irwin Tan · EMP-0008']);
    // THE STATE THE OLD BOX COULD NEVER REACH: a name typed into it produced a database error, not a row.
    expect(panel().textContent).not.toContain('No employee matches');

    // Searching by Employee ID, folded, is the house rule (lib/employee-search.ts) — a picker that prints
    // "EMP-0008" on the row and then cannot find it when typed is the same broken promise one layer down.
    await user.clear(searchBox());
    await user.type(searchBox(), 'emp0008');
    expect(optionsOffered()).toEqual(['Irwin Tan · EMP-0008']);
  });

  it('② A SEARCH WITH NO MATCHES says so, and NAMES WHAT WAS SEARCHED', async () => {
    const user = userEvent.setup();
    mount();
    await openPickIndividually(user);
    await user.click(screen.getByRole('button', { name: L.generateEmployeePicker }));
    await user.type(searchBox(), 'Zoltan');

    expect(optionsOffered()).toEqual([]);
    const text = panel().textContent ?? '';
    // Naming the query is the requirement, not the sentence: "nothing found" leaves an operator wondering
    // whether the screen heard them at all. An empty box asserts nothing (CLAUDE.md §8).
    expect(text).toContain('Zoltan');
    expect(text).toContain(L.generateEmployeeNoMatch.replace('{query}', 'Zoltan'));
    // And never the raw key or an unsubstituted placeholder — next-intl renders both silently.
    expect(text).not.toContain('generateEmployeeNoMatch');
    expect(text).not.toContain('{query}');
  });

  it('③ ZERO SELECTED disables Next, and says why; one pick re-enables it', async () => {
    const user = userEvent.setup();
    mount();
    await openPickIndividually(user);

    const next = () => screen.getByRole('button', { name: L.adjustmentsNext }) as HTMLButtonElement;
    expect(next().disabled, 'Pick individually with nobody chosen must not walk on').toBe(true);
    expect(screen.getAllByText(L.generateEmployeeNonePicked).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: L.generateEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' }));
    expect(next().disabled).toBe(false);

    // A PASTED list counts too — it is the second door and it must unlock the same button.
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' })); // untick
    expect(next().disabled).toBe(true);
    await user.type(pasteBox(), IRWIN);
    expect(next().disabled).toBe(false);
  });

  it('BY CRITERIA is NOT blocked — an empty criteria set legitimately means everyone', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: L.generateStepWho }));
    // Still on "By criteria", nothing filled. Blocking here would break the behaviour the plain Generate
    // button this screen replaces has always had, and `generateEveryoneWarning` is what covers it instead.
    expect((screen.getByRole('button', { name: L.adjustmentsNext }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(L.generateEveryoneWarning)).toBeTruthy();
  });
});

describe('r287 §B · pick, keep typing, remove — without leaving the screen', () => {
  it('the search box stays ACTIVE after a pick, so a second person needs no reopening', async () => {
    const user = userEvent.setup();
    mount();
    await openPickIndividually(user);
    await user.click(screen.getByRole('button', { name: L.generateEmployeePicker }));

    await user.type(searchBox(), 'Tan');
    expect(optionsOffered()).toEqual(['Daniel Tan · EMP-0005', 'Irwin Tan · EMP-0008']);
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));

    // THE REPORTER'S WORDS: "without requiring the HR user to repeatedly leave or reload the page". The
    // panel is still open, the filter is still applied, and the box still holds what was typed.
    expect(searchBox().value).toBe('Tan');
    expect(optionsOffered()).toEqual(['Daniel Tan · EMP-0005', 'Irwin Tan · EMP-0008']);
    // …and the second pick lands with no reopening.
    await user.click(screen.getByRole('checkbox', { name: 'Daniel Tan · EMP-0005' }));
    expect(postedIds(document.body as HTMLElement).sort()).toEqual([IRWIN, DANIEL].sort());
  });

  it('a chip per chosen employee, carrying the NAME and the EMPLOYEE ID, removable with one click', async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await openPickIndividually(user);
    await user.click(screen.getByRole('button', { name: L.generateEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' }));

    const remove = (name: string) => screen.getByRole('button', { name: `Remove ${name}` });
    expect(remove('Irwin Tan · EMP-0008')).toBeTruthy();
    // Nadia has no Employee ID (the column is nullable) — her chip is her name, not "Nadia Rahim · null".
    expect(remove('Nadia Rahim')).toBeTruthy();
    expect(container.textContent).not.toContain('null');

    await user.click(remove('Irwin Tan · EMP-0008'));
    expect(postedIds(container)).toEqual([NADIA]);
    // The × sits OUTSIDE the popover's root, so clicking it also dismisses an open panel (the shared
    // click-outside contract). Re-open to read the tick: removing a chip and unticking the row are ONE
    // operation over ONE set, so the two views cannot disagree about who the run will cover.
    await user.click(screen.getByRole('button', { name: L.generateEmployeePicker }));
    expect((screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Nadia Rahim' }) as HTMLInputElement).checked).toBe(true);
  });

  it('THE SAME PERSON CANNOT BE ADDED TWICE — by either door, or by both at once', async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await openPickIndividually(user);
    await user.click(screen.getByRole('button', { name: L.generateEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));

    // The picker itself: a second click on a picked row un-picks, it never appends a duplicate.
    expect(postedIds(container)).toEqual([IRWIN]);
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    expect(postedIds(container)).toEqual([]);
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    expect(postedIds(container)).toEqual([IRWIN]);

    // ACROSS THE TWO DOORS, which is the case a picker-only test would miss: the same person picked AND
    // pasted must reach the engine once. The merge is `lib/employment-selection.ts` and both the live
    // preview and `openLeaveYearAction` call it (§C).
    await user.type(pasteBox(), `${IRWIN}, ${NADIA}`);
    await waitFor(() => expect(lastPayload()?.employmentIds).toEqual([IRWIN, NADIA]));
  });
});

describe('r287 §C · two ways in, ONE list out', () => {
  /**
   * THE ASSERTION THE PLAN ASKED FOR: for the SAME people, the picker and the paste box resolve to the
   * SAME employment-id list. Pinned on the payload the component sends to `previewLeaveGeneration`, which
   * is the same list `openLeaveYearAction` builds from the same two fields through the same function —
   * the identity of the RESOLVED population against a real database is pinned next door, in
   * test/r287-employment-selection.test.ts, which can run the engine.
   */
  it('picking two people and pasting the same two produce an IDENTICAL list', async () => {
    const user = userEvent.setup();
    const picked = mount();
    await openPickIndividually(user);
    await user.click(screen.getByRole('button', { name: L.generateEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' }));
    await waitFor(() => expect(lastPayload()?.employmentIds).toHaveLength(2));
    const fromPicker = lastPayload()!.employmentIds;
    picked.unmount();

    payloads = [];
    mount();
    await openPickIndividually(user);
    // Whitespace, commas and new lines — the three separators the box has always accepted.
    await user.type(pasteBox(), `${IRWIN},  ${NADIA}`);
    await waitFor(() => expect(lastPayload()?.employmentIds).toHaveLength(2));

    expect(lastPayload()!.employmentIds).toEqual(fromPicker);
  });

  it('the paste path is NOT removed — the field, its name and its parsing are intact', async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await openPickIndividually(user);
    // Deleting this affordance would be an unrequested regression: it is how a bulk run is set up today.
    const box = container.querySelector('textarea[name="employmentIdsRaw"]');
    expect(box, 'the reference-paste field must survive the picker').toBeTruthy();
    // …and it is LABELLED, which is the half a `querySelector` everywhere else would stop checking.
    expect(screen.getByRole('textbox', { name: new RegExp(L.generatePasteAlternative) })).toBe(box);
    await user.type(box as HTMLTextAreaElement, `${IRWIN}\n${NADIA} ${DANIEL}`);
    await waitFor(() => expect(lastPayload()?.employmentIds).toEqual([IRWIN, NADIA, DANIEL]));
  });

  it('CRITERIA mode sends no employment ids at all — the two modes are alternatives', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: L.generateStepWho }));
    await waitFor(() => expect(lastPayload()).toBeTruthy());
    expect(lastPayload()!.targetMode).toBe('criteria');
    expect(lastPayload()!.employmentIds).toEqual([]);
  });
});

describe('r287 §D · "Working it out…" is a PENDING state, not an answer', () => {
  it('a preview that FAILS prints a terminal sentence instead of pretending to still be working', async () => {
    const user = userEvent.setup();
    // The real failure this reproduces: `employment.id IN ('Irwin')` is rejected by Postgres
    // (`invalid input syntax for type uuid`), so the action REJECTS — it does not return an empty result.
    preview.mockRejectedValue(new Error('invalid input syntax for type uuid: "Irwin"'));
    mount();
    await user.click(screen.getByRole('button', { name: L.generateStepWho }));

    await waitFor(() => expect(screen.getAllByText(L.generateMatchedUnknown).length).toBeGreaterThan(0));
    // THE DEFECT ITSELF: before this round the same state printed the PENDING sentence, forever.
    expect(screen.queryByText(L.adjustmentsMatchedPending)).toBeNull();
    preview.mockReset();
  });
});
