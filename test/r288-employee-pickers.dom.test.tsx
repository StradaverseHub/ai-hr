/**
 * r288 (8521e160) — THE TERMINAL STATES ON LEAVE ADJUSTMENTS AND ON NOTICE BOARD, RENDERED AND DRIVEN.
 *
 * ── WHY THIS FILE IS A RENDER AND NOT A SOURCE SCAN ───────────────────────────────────────────────────
 * Every claim here is about what an operator SEES after typing and clicking: which rows are offered, what
 * is said when none are, whether the button that walks on is reachable, and whether a count that has
 * already failed goes on claiming to be working. A scan can assert the strings exist; only a render can
 * assert they appear at the right moment. Six vacuous guards were found in this session, and the ones that
 * mattered were scans matching code the defect had left intact.
 *
 * ── THE HALF THAT WAS MISSING LAST ROUND, ON BOTH SCREENS ─────────────────────────────────────────────
 * §A ① a search WITH matches · ② a search with NO matches that NAMES what was searched · ③ zero selected
 * refused before Save. §B the two doors producing ONE posted list. §C — specific to Adjustments — a count
 * that fails does not leave the previous number standing AND does not fall back to the pending sentence,
 * which is what it actually did (see the file header of test/r288-employee-pickers.test.ts).
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so a
 * row the popover is FILTERING OUT is asserted as the `hidden` class the component sets, not as computed
 * visibility. `offered()` below encodes that once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { AdjustmentForm } from '../components/leave/adjustment-form';
import { NoticeForm, type NoticeFormLabels } from '../components/notice/notice-form';
import { mergeEmploymentSelection } from '../lib/employment-selection';
import type { CriteriaSection } from '../core/org-criteria-form';

const L = messages.admin.leave as unknown as Record<string, string>;
const N = messages.notices as unknown as Record<string, string>;

/** Real-shaped employment ids: the field holds uuids, and a fixture that pretends otherwise proves less. */
const IRWIN = '11111111-1111-4111-8111-111111111111';
const NADIA = '22222222-2222-4222-8222-222222222222';
const DANIEL = '33333333-3333-4333-8333-333333333333';

const employees = [
  // Ordered by full name, as `listEmployees` returns them — neither picker may re-sort.
  { id: DANIEL, name: 'Daniel Tan', employeeCode: 'EMP-0005' },
  { id: IRWIN, name: 'Irwin Tan', employeeCode: 'EMP-0008' },
  // No Employee ID: the column is nullable, and a chip must read "Nadia Rahim", never "Nadia Rahim · null".
  { id: NADIA, name: 'Nadia Rahim', employeeCode: null },
];

const criteriaSections: CriteriaSection[] = [
  {
    key: 'company',
    title: 'Company Information',
    fields: [{ name: 'companyIds', label: 'Company', kind: 'multi', options: [{ value: 'c1', label: 'Acme' }] }],
  },
];

// ── the two mounts ───────────────────────────────────────────────────────────────────────────────────

type PreviewArg = Parameters<Parameters<typeof AdjustmentForm>[0]['previewAction']>[0];
let payloads: PreviewArg[] = [];
const preview = vi.fn(async (p: PreviewArg) => {
  payloads.push(p);
  return { employees: p.employmentIds.length, targeted: p.employmentIds.length, willWrite: 0, issues: [] };
});
const lastPayload = () => payloads[payloads.length - 1];

function mountAdjustments() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AdjustmentForm
        action={() => {}}
        previewAction={preview}
        today="2026-08-05"
        leaveTypes={[{ value: 'lt-annual', label: 'Annual Leave' }]}
        criteriaSections={criteriaSections}
        employees={employees}
      />
    </NextIntlClientProvider>,
  );
}

/**
 * The copy object built EXACTLY as app/admin/notice-board/{new,[id]}/page.tsx build it — one `t()` call per
 * label, so a key this component needs but no page passes shows up here as `undefined`, not as a plausible
 * placeholder. (`test/r288-employee-pickers.test.ts` §C pins that the pages themselves pass them.)
 */
const noticeLabels: NoticeFormLabels = {
  sectionBasics: N.sectionBasics,
  sectionContent: N.sectionContent,
  sectionAudience: N.sectionAudience,
  sectionDelivery: N.sectionDelivery,
  fTitle: N.fTitle,
  fStartOn: N.fStartOn,
  fEndOn: N.fEndOn,
  fShowEndDate: N.fShowEndDate,
  fBody: N.fBody,
  fBodyHelp: N.fBodyHelp,
  write: N.write,
  preview: N.preview,
  previewEmpty: N.previewEmpty,
  byCriteria: N.byCriteria,
  byIndividual: N.byIndividual,
  companies: N.fCompanies,
  departments: N.fDepartments,
  employmentTypes: N.fEmploymentTypes,
  employeePicker: N.fEmployeePicker,
  employeeNoneChosen: N.fEmployeeNoneChosen,
  employeeSearch: N.fEmployeeSearch,
  employeeNoMatchTemplate: N.fEmployeeNoMatch,
  employeeNonePicked: N.fEmployeeNonePicked,
  employeeSelectedCountTemplate: N.fEmployeeSelectedCount,
  employeeSelectAll: N.fEmployeeSelectAll,
  employeeClearAll: N.fEmployeeClearAll,
  employeeRemoveTemplate: N.fEmployeeRemove,
  pasteAlternative: N.fPasteAlternative,
  pasteAlternativeHelp: N.fPasteAlternativeHelp,
  pasteUnmatchedTemplate: N.fPasteUnmatched,
  everyoneWarning: N.everyoneWarning,
  targetingFrozen: N.targetingFrozen,
  fNotify: N.fNotify,
  fNotifyHelp: N.fNotifyHelp,
  fPopup: N.fPopup,
  fPopupFrequency: N.fPopupFrequency,
  popupOnce: N.popupOnce,
  popupUntilAcknowledged: N.popupUntilAcknowledged,
  submit: N.saveDraft,
};

function mountNotice(over: { employmentIds?: string[]; targetMode?: 'criteria' | 'individual' } = {}) {
  return render(
    <NoticeForm
      action={() => {}}
      values={{
        title: 'Town hall',
        body: 'Body',
        startOn: '2026-08-01',
        endOn: '2026-08-31',
        showEndDate: false,
        targetMode: over.targetMode ?? 'criteria',
        criteria: {},
        employmentIds: over.employmentIds ?? [],
        notifyOnPublish: false,
        popupEnabled: false,
        popupFrequency: 'once',
      }}
      companies={[{ value: 'c1', label: 'Acme' }]}
      departments={[]}
      employmentTypes={[]}
      orgCriteria={[]}
      employees={employees}
      targetingFrozen={false}
      labels={noticeLabels}
    />
  );
}

// ── shared probes ────────────────────────────────────────────────────────────────────────────────────

const searchBox = (placeholder: string) => screen.getByPlaceholderText(placeholder) as HTMLInputElement;
const panelOf = (placeholder: string) => searchBox(placeholder).parentElement!;

/**
 * The option rows the popover is currently OFFERING. Every option stays mounted; the component narrows by
 * putting `hidden` on the rows it filters out (see the scope note in this file's header), so "offered"
 * means "mounted without that class".
 */
const offered = (placeholder: string): string[] =>
  [...panelOf(placeholder).querySelectorAll('label')]
    .filter((el) => !el.className.includes('hidden'))
    .map((el) => el.textContent?.trim() ?? '');

/**
 * The paste box, by its POSTED NAME rather than its accessible name.
 *
 * REASON, so a later reader does not read this as laziness: <Field> renders a <label> wrapping the caption,
 * the control AND the help paragraph, so this textarea's computed accessible name is the caption plus the
 * whole of the help sentence. Matching on that would be a test of the help text's wording. That the field
 * is LABELLED is asserted separately, once per screen, in §B.
 */
const pasteBox = (root: HTMLElement) =>
  root.querySelector('textarea[name="employmentIdsRaw"]') as HTMLTextAreaElement;

/**
 * What the form would actually POST, run through the SAME merge the two server actions run. This is the
 * seam the whole round turns on: the popover's hidden-input contract plus the paste box, read the way
 * `idsFrom` / `inputFrom` read them.
 */
const postedIds = (root: HTMLElement): string[] => {
  const form = root.querySelector('form') ?? (root.closest('form') as HTMLFormElement);
  const fd = new FormData(form as HTMLFormElement);
  // r289 — an empty population: every reference this file pastes is an internal employment uuid, which is
  // the arm that must keep working untouched. Resolution by Employee ID is pinned in
  // test/r289-paste-employee-code.dom.test.tsx, which mounts these same three forms.
  return mergeEmploymentSelection(
    fd.getAll('employmentIds').map(String),
    String(fd.get('employmentIdsRaw') ?? ''),
    [],
  );
};

beforeEach(() => {
  window.localStorage.clear();
  preview.mockReset();
  preview.mockImplementation(async (p: PreviewArg) => {
    payloads.push(p);
    return { employees: p.employmentIds.length, targeted: p.employmentIds.length, willWrite: 0, issues: [] };
  });
  payloads = [];
});

/** Walk Adjustments to step ② and switch to Pick individually — the branch this round is about. */
async function openAdjustmentsIndividual(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: L.adjustmentsStepWho }));
  await user.click(screen.getByRole('radio', { name: L.adjustmentsByIndividual }));
}

/** Switch the Notice Board audience step to "Specific people". */
async function openNoticeIndividual(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('radio', { name: N.byIndividual }));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('r288 §A · LEAVE ADJUSTMENTS — the three terminal states', () => {
  it('① A SEARCH WITH MATCHES offers exactly the matching rows, and no empty-state line', async () => {
    const user = userEvent.setup();
    mountAdjustments();
    await openAdjustmentsIndividual(user);
    await user.click(screen.getByRole('button', { name: L.adjustmentsEmployeePicker }));

    // Unfiltered, the picker offers everyone the page read — the control case for the two states below.
    expect(offered(L.adjustmentsEmployeeSearchPlaceholder)).toHaveLength(3);

    await user.type(searchBox(L.adjustmentsEmployeeSearchPlaceholder), 'Irwin');
    expect(offered(L.adjustmentsEmployeeSearchPlaceholder)).toEqual(['Irwin Tan · EMP-0008']);
    // THE STATE THE OLD BOX COULD NEVER REACH: a name typed into it produced a database error, not a row.
    expect(panelOf(L.adjustmentsEmployeeSearchPlaceholder).textContent).not.toContain('No employee matches');

    // Searching by Employee ID, FOLDED, is the house rule (lib/employee-search.ts) — a picker that prints
    // "EMP-0008" on the row and cannot find it when typed is the same broken promise one layer down.
    await user.clear(searchBox(L.adjustmentsEmployeeSearchPlaceholder));
    await user.type(searchBox(L.adjustmentsEmployeeSearchPlaceholder), 'emp0008');
    expect(offered(L.adjustmentsEmployeeSearchPlaceholder)).toEqual(['Irwin Tan · EMP-0008']);
  });

  it('② A SEARCH WITH NO MATCHES says so, and NAMES WHAT WAS SEARCHED', async () => {
    const user = userEvent.setup();
    mountAdjustments();
    await openAdjustmentsIndividual(user);
    await user.click(screen.getByRole('button', { name: L.adjustmentsEmployeePicker }));
    await user.type(searchBox(L.adjustmentsEmployeeSearchPlaceholder), 'Zoltan');

    expect(offered(L.adjustmentsEmployeeSearchPlaceholder)).toEqual([]);
    const text = panelOf(L.adjustmentsEmployeeSearchPlaceholder).textContent ?? '';
    // Naming the query is the requirement, not the sentence: "nothing found" leaves an operator wondering
    // whether the screen heard them at all. An empty box asserts nothing (CLAUDE.md §8).
    expect(text).toContain('Zoltan');
    expect(text).toContain(L.adjustmentsEmployeeNoMatch.replace('{query}', 'Zoltan'));
    // And never the raw key or an unsubstituted placeholder — next-intl renders both silently.
    expect(text).not.toContain('adjustmentsEmployeeNoMatch');
    expect(text).not.toContain('{query}');
  });

  it('③ ZERO SELECTED refuses to walk on, and says why; either door re-enables it', async () => {
    const user = userEvent.setup();
    const { container } = mountAdjustments();
    await openAdjustmentsIndividual(user);

    const next = () => screen.getByRole('button', { name: L.adjustmentsNext }) as HTMLButtonElement;
    expect(next().disabled, 'Pick individually with nobody chosen must not walk on').toBe(true);
    expect(screen.getAllByText(L.adjustmentsEmployeeNonePicked).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: L.adjustmentsEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' }));
    expect(next().disabled).toBe(false);

    // A PASTED list counts too — it is the second door and it must unlock the same button.
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' })); // untick
    expect(next().disabled).toBe(true);
    await user.type(pasteBox(container), IRWIN);
    expect(next().disabled).toBe(false);
  });

  it('BY CRITERIA is NOT blocked — an empty criteria set legitimately means everyone', async () => {
    const user = userEvent.setup();
    mountAdjustments();
    await user.click(screen.getByRole('button', { name: L.adjustmentsStepWho }));
    // Still on "By criteria", nothing filled. Blocking here would break behaviour this screen has always
    // had, and `adjustmentsEveryoneWarning` is what covers it instead.
    expect((screen.getByRole('button', { name: L.adjustmentsNext }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(L.adjustmentsEveryoneWarning)).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('r288 §A · NOTICE BOARD — the same three terminal states', () => {
  it('① A SEARCH WITH MATCHES offers exactly the matching rows, and no empty-state line', async () => {
    const user = userEvent.setup();
    mountNotice();
    await openNoticeIndividual(user);
    await user.click(screen.getByRole('button', { name: N.fEmployeePicker }));

    expect(offered(N.fEmployeeSearch)).toHaveLength(3);
    await user.type(searchBox(N.fEmployeeSearch), 'Irwin');
    expect(offered(N.fEmployeeSearch)).toEqual(['Irwin Tan · EMP-0008']);
    expect(panelOf(N.fEmployeeSearch).textContent).not.toContain('No employee matches');

    await user.clear(searchBox(N.fEmployeeSearch));
    await user.type(searchBox(N.fEmployeeSearch), 'emp0008');
    expect(offered(N.fEmployeeSearch)).toEqual(['Irwin Tan · EMP-0008']);
  });

  it('② A SEARCH WITH NO MATCHES says so, and NAMES WHAT WAS SEARCHED', async () => {
    const user = userEvent.setup();
    mountNotice();
    await openNoticeIndividual(user);
    await user.click(screen.getByRole('button', { name: N.fEmployeePicker }));
    await user.type(searchBox(N.fEmployeeSearch), 'Zoltan');

    expect(offered(N.fEmployeeSearch)).toEqual([]);
    const text = panelOf(N.fEmployeeSearch).textContent ?? '';
    expect(text).toContain('Zoltan');
    expect(text).toContain(N.fEmployeeNoMatch.replace('{query}', 'Zoltan'));
    // This screen substitutes the placeholder ITSELF (`String.replace`, not next-intl), because its copy
    // crosses the server→client boundary as plain strings. A dropped substitution is silent, so it is
    // asserted rather than assumed.
    expect(text).not.toContain('{query}');
  });

  it('③ ZERO SELECTED refuses SAVE, and says why — checked while choosing, not at the end', async () => {
    const user = userEvent.setup();
    const { container } = mountNotice();
    const save = () => screen.getByRole('button', { name: N.saveDraft }) as HTMLButtonElement;

    // By criteria: an empty set legitimately means everyone, so Save stays live.
    expect(save().disabled).toBe(false);

    await openNoticeIndividual(user);
    // THE DEFECT: before this round nothing was checked here at all. The whole notice was written, Save was
    // pressed, and `cleanNotice` refused it on the far side of a round trip.
    expect(save().disabled, 'Specific people with nobody chosen must not be savable').toBe(true);
    expect(screen.getAllByText(N.fEmployeeNonePicked).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: N.fEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' }));
    expect(save().disabled).toBe(false);

    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' })); // untick
    expect(save().disabled).toBe(true);
    await user.type(pasteBox(container), IRWIN);
    expect(save().disabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('r288 §B · two ways in, ONE posted list — on both screens', () => {
  it('ADJUSTMENTS: picking two people and pasting the same two post an IDENTICAL list', async () => {
    const user = userEvent.setup();
    const picked = mountAdjustments();
    await openAdjustmentsIndividual(user);
    await user.click(screen.getByRole('button', { name: L.adjustmentsEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' }));
    const fromPicker = postedIds(picked.container);
    expect(fromPicker).toEqual([IRWIN, NADIA]);
    // …and the live count was asked about exactly that list, not about the previous one. A checkbox inside
    // the popover fires no `change` the enclosing <form onChange> hears, so without the explicit recount
    // the number on screen would describe the previous selection.
    await waitFor(() => expect(lastPayload()?.employmentIds).toEqual([IRWIN, NADIA]));
    picked.unmount();

    payloads = [];
    const pasted = mountAdjustments();
    await openAdjustmentsIndividual(user);
    // Whitespace, commas and new lines — the three separators the box has always accepted.
    await user.type(pasteBox(pasted.container), `${IRWIN},  ${NADIA}`);
    expect(postedIds(pasted.container)).toEqual(fromPicker);
    await waitFor(() => expect(lastPayload()?.employmentIds).toEqual(fromPicker));
  });

  it('NOTICE BOARD: picking two people and pasting the same two post an IDENTICAL list', async () => {
    const user = userEvent.setup();
    const picked = mountNotice();
    await openNoticeIndividual(user);
    await user.click(screen.getByRole('button', { name: N.fEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' }));
    const fromPicker = postedIds(picked.container);
    expect(fromPicker).toEqual([IRWIN, NADIA]);
    picked.unmount();

    const pasted = mountNotice();
    await openNoticeIndividual(user);
    await user.type(pasteBox(pasted.container), `${IRWIN}\n${NADIA}`);
    expect(postedIds(pasted.container)).toEqual(fromPicker);
  });

  it('THE SAME PERSON CANNOT BE POSTED TWICE — by either door, or by both at once (both screens)', async () => {
    const user = userEvent.setup();
    const adj = mountAdjustments();
    await openAdjustmentsIndividual(user);
    await user.click(screen.getByRole('button', { name: L.adjustmentsEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    // The picker itself: a second click on a picked row un-picks, it never appends a duplicate.
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    // ACROSS THE TWO DOORS, which is the case a picker-only test would miss.
    await user.type(pasteBox(adj.container), `${IRWIN}, ${NADIA}`);
    expect(postedIds(adj.container)).toEqual([IRWIN, NADIA]);
    adj.unmount();

    const notice = mountNotice();
    await openNoticeIndividual(user);
    await user.click(screen.getByRole('button', { name: N.fEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    await user.type(pasteBox(notice.container), `${IRWIN} ${NADIA}`);
    expect(postedIds(notice.container)).toEqual([IRWIN, NADIA]);
  });

  it('THE PASTE PATH SURVIVES on both screens — the field, its label and its parsing are intact', async () => {
    const user = userEvent.setup();
    const adj = mountAdjustments();
    await openAdjustmentsIndividual(user);
    // Deleting this affordance would be an unrequested regression: it is how a bulk run is set up today.
    expect(pasteBox(adj.container), 'Adjustments must keep the reference-paste field').toBeTruthy();
    expect(screen.getByRole('textbox', { name: new RegExp(L.adjustmentsPasteAlternative) })).toBe(
      pasteBox(adj.container),
    );
    await user.type(pasteBox(adj.container), `${IRWIN}\n${NADIA} ${DANIEL}`);
    expect(postedIds(adj.container)).toEqual([IRWIN, NADIA, DANIEL]);
    adj.unmount();

    const notice = mountNotice();
    await openNoticeIndividual(user);
    expect(pasteBox(notice.container), 'Notice Board must keep the reference-paste field').toBeTruthy();
    expect(screen.getByRole('textbox', { name: new RegExp(N.fPasteAlternative) })).toBe(pasteBox(notice.container));
  });

  it('a chip per chosen employee, carrying NAME and EMPLOYEE ID, removable with one click (both screens)', async () => {
    const user = userEvent.setup();
    const adj = mountAdjustments();
    await openAdjustmentsIndividual(user);
    await user.click(screen.getByRole('button', { name: L.adjustmentsEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' }));

    expect(screen.getByRole('button', { name: 'Remove Irwin Tan · EMP-0008' })).toBeTruthy();
    // Nadia has no Employee ID — her chip is her name, not "Nadia Rahim · null".
    expect(screen.getByRole('button', { name: 'Remove Nadia Rahim' })).toBeTruthy();
    expect(adj.container.textContent).not.toContain('null');

    await user.click(screen.getByRole('button', { name: 'Remove Irwin Tan · EMP-0008' }));
    expect(postedIds(adj.container)).toEqual([NADIA]);
    // The × sits OUTSIDE the popover's root, so clicking it also dismisses an open panel (the shared
    // click-outside contract). Re-open to read the tick: removing a chip and unticking the row are ONE
    // operation over ONE set, so the two views cannot disagree about who is covered.
    await user.click(screen.getByRole('button', { name: L.adjustmentsEmployeePicker }));
    expect((screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Nadia Rahim' }) as HTMLInputElement).checked).toBe(true);
    adj.unmount();

    const notice = mountNotice();
    await openNoticeIndividual(user);
    await user.click(screen.getByRole('button', { name: N.fEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Nadia Rahim' }));
    // Notice Board's remove label is substituted from a TEMPLATE that crossed the boundary as a string, so
    // a dropped `{name}` would be silent — this is the assertion that catches it.
    const remove = screen.getByRole('button', { name: N.fEmployeeRemove.replace('{name}', 'Nadia Rahim') });
    expect(remove).toBeTruthy();
    await user.click(remove);
    expect(postedIds(notice.container)).toEqual([]);
  });

  /**
   * THE EDIT SCREEN'S ROUND TRIP, rendered. A saved audience is split back across the two doors — ids this
   * administrator can see become chips, anything else stays in the box — so opening an individual notice
   * and saving without touching the audience posts exactly what was stored. Dropping the unknown half
   * would silently shrink the audience of a live notice on a plain Save, which is the r272-shaped failure
   * only a real save finds.
   */
  it('NOTICE BOARD: a saved audience reopens across BOTH doors and re-posts unchanged', async () => {
    const stray = '00000000-0000-4000-8000-0000000000ff';
    const { container } = mountNotice({ targetMode: 'individual', employmentIds: [IRWIN, stray] });

    // The known one came back as a chip…
    expect(screen.getByRole('button', { name: N.fEmployeeRemove.replace('{name}', 'Irwin Tan · EMP-0008') })).toBeTruthy();
    // …and the unknown one is visible and editable in the box rather than silently dropped.
    expect(pasteBox(container).value).toBe(stray);
    expect([...postedIds(container)].sort()).toEqual([IRWIN, stray].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('r288 §C · ADJUSTMENTS — a count that failed stops claiming to be working', () => {
  /**
   * THE HALF THE TICKET DESCRIBED AND THE HALF IT GOT WRONG, both pinned in one walk.
   *
   * The reporter was told the matched count "simply stops updating" and leaves a stale number. Rendered, it
   * does something adjacent: the catch sets `preview` to null and null has always printed
   * `adjustmentsMatchedPending` — "Working it out…". So the assertion has to be a superset of both readings:
   * after a failure the previous NUMBER must be gone AND the pending sentence must be gone, replaced by a
   * terminal one.
   */
  it('the previous number does not stand, and neither does the pending sentence', async () => {
    const user = userEvent.setup();
    const { container } = mountAdjustments();
    await openAdjustmentsIndividual(user);
    await user.click(screen.getByRole('button', { name: L.adjustmentsEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));

    // A real answer first, so the failure below has something to leave standing.
    await waitFor(() => expect(screen.getAllByText('1 employee').length).toBeGreaterThan(0));

    // The real failure this reproduces: `employment.id IN ('Irwin')` is rejected by Postgres
    // (`invalid input syntax for type uuid`), so the action REJECTS — it does not return an empty result.
    preview.mockRejectedValue(new Error('invalid input syntax for type uuid: "Irwin"'));
    await user.type(pasteBox(container), 'Irwin');

    await waitFor(() => expect(screen.getAllByText(L.adjustmentsMatchedUnknown).length).toBeGreaterThan(0));
    expect(screen.queryByText('1 employee'), 'a count that failed must not leave the old number standing').toBeNull();
    expect(
      screen.queryByText(L.adjustmentsMatchedPending),
      'and it must not fall back to the PENDING sentence, which is what it actually did',
    ).toBeNull();
  });

  it('a later SUCCESSFUL count clears the terminal sentence again', async () => {
    const user = userEvent.setup();
    const { container } = mountAdjustments();
    await openAdjustmentsIndividual(user);
    preview.mockRejectedValue(new Error('invalid input syntax for type uuid: "Irwin"'));
    await user.type(pasteBox(container), 'Irwin');
    await waitFor(() => expect(screen.getAllByText(L.adjustmentsMatchedUnknown).length).toBeGreaterThan(0));

    preview.mockImplementation(async (p: PreviewArg) => {
      payloads.push(p);
      return { employees: 2, targeted: 2, willWrite: 2, issues: [] };
    });
    await user.clear(pasteBox(container));
    await user.type(pasteBox(container), `${IRWIN} ${NADIA}`);
    await waitFor(() => expect(screen.getAllByText('2 employees').length).toBeGreaterThan(0));
    expect(screen.queryByText(L.adjustmentsMatchedUnknown)).toBeNull();
  });

  it('the matched-count row shows exactly ONE of the three states at a time', async () => {
    const user = userEvent.setup();
    mountAdjustments();
    await user.click(screen.getByRole('button', { name: L.adjustmentsStepWho }));
    await waitFor(() => expect(lastPayload()).toBeTruthy());
    // The counter row is the one carrying the "Employees matched" caption.
    const row = screen.getByText(L.adjustmentsMatched).parentElement as HTMLElement;
    const text = within(row).getByText(/.+/, { selector: 'span.tabular-nums' }).textContent ?? '';
    expect(text).not.toContain(L.adjustmentsMatchedPending);
    expect(text).not.toContain(L.adjustmentsMatchedUnknown);
  });
});
