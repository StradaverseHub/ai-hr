/**
 * r289 — THE PASTE BOX, RENDERED AND TYPED INTO, ON ALL THREE SCREENS.
 *
 * ── WHY THIS FILE IS A RENDER AND NOT A SOURCE SCAN ───────────────────────────────────────────────────
 * `test/r289-paste-employee-code.test.ts` pins the RULE and the write paths. What it cannot see is whether
 * an operator typing `EMP-0008` into the box gets Irwin — the component has to hand its own `employees`
 * prop to the resolver, and a component that forgot to would keep every other assertion in this round
 * green. The probe is therefore the component's OWN OUTPUT: the payload it sends to the preview action,
 * which is the number the screen shows and, on two of the three screens, the population the submit posts.
 *
 * ── AND WHY THE SENTENCE IS READ OFF THE SCREEN ───────────────────────────────────────────────────────
 * "Name anything that did not match" is the half of this round a jsdom guard can actually judge. It is read
 * as TEXT, and asserted to contain the token, NOT to contain the key path or an unsubstituted `{list}` —
 * the two silent failures that put `notices.fEmployeeNoMatch` on a live screen behind a green 200 last
 * round (CLAUDE.md §8).
 *
 * Scope note (inherited from r288's file): jsdom applies no CSS, so nothing here asserts visibility.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { GenerateForm } from '../components/leave/generate-form';
import { AdjustmentForm } from '../components/leave/adjustment-form';
import { NoticeForm, type NoticeFormLabels } from '../components/notice/notice-form';
import type { CriteriaSection } from '../core/org-criteria-form';
import type { LeaveGenerationResult } from '../core/leave-generation';

const L = messages.admin.leave as unknown as Record<string, string>;
const N = messages.notices as unknown as Record<string, string>;

/** Real-shaped employment ids: the field holds uuids, and a fixture that pretends otherwise proves less. */
const DANIEL = '33333333-3333-4333-8333-333333333333';
const IRWIN = '11111111-1111-4111-8111-111111111111';
const NADIA = '22222222-2222-4222-8222-222222222222';

const employees = [
  // Ordered by full name, as `listEmployees` returns them.
  { id: DANIEL, name: 'Daniel Tan', employeeCode: 'EMP-0005' },
  { id: IRWIN, name: 'Irwin Tan', employeeCode: 'EMP-0008' },
  // No Employee ID: the column is nullable, and nobody may be reached by the absence of a code.
  { id: NADIA, name: 'Nadia Rahim', employeeCode: null },
];

const criteriaSections: CriteriaSection[] = [
  {
    key: 'company',
    title: 'Company Information',
    fields: [{ name: 'companyIds', label: 'Company', kind: 'multi', options: [{ value: 'c1', label: 'Acme' }] }],
  },
];

// ── Generate Entitlement ─────────────────────────────────────────────────────────────────────────────
const genResult = (selected: number): LeaveGenerationResult => ({
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
});
let genPayloads: Parameters<Parameters<typeof GenerateForm>[0]['previewAction']>[0][] = [];
const genPreview = vi.fn(async (p: (typeof genPayloads)[number]) => {
  genPayloads.push(p);
  return genResult(p.employmentIds.length);
});
const mountGenerate = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GenerateForm
        action={() => {}}
        previewAction={genPreview}
        years={[2025, 2026]}
        defaultYear={2026}
        leaveTypes={[{ value: 'lt-annual', label: 'Annual Leave' }]}
        criteriaSections={criteriaSections}
        employees={employees}
      />
    </NextIntlClientProvider>,
  );

// ── Leave Adjustments ────────────────────────────────────────────────────────────────────────────────
type AdjArg = Parameters<Parameters<typeof AdjustmentForm>[0]['previewAction']>[0];
let adjPayloads: AdjArg[] = [];
const adjPreview = vi.fn(async (p: AdjArg) => {
  adjPayloads.push(p);
  return { employees: p.employmentIds.length, targeted: p.employmentIds.length, willWrite: 0, issues: [] };
});
const mountAdjustments = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AdjustmentForm
        action={() => {}}
        previewAction={adjPreview}
        today="2026-08-05"
        leaveTypes={[{ value: 'lt-annual', label: 'Annual Leave' }]}
        criteriaSections={criteriaSections}
        employees={employees}
      />
    </NextIntlClientProvider>,
  );

// ── Notice Board ─────────────────────────────────────────────────────────────────────────────────────
/**
 * The copy object built EXACTLY as app/admin/notice-board/{new,[id]}/page.tsx build it — one `t()` value
 * per label, so a key this component needs but no page passes shows up as `undefined` rather than as a
 * plausible placeholder.
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
const mountNotice = () =>
  render(
    <NoticeForm
      action={() => {}}
      values={{
        title: 'Town hall',
        body: 'Body',
        startOn: '2026-08-01',
        endOn: '2026-08-31',
        showEndDate: false,
        targetMode: 'criteria',
        criteria: {},
        employmentIds: [],
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
    />,
  );

// ── shared probes ────────────────────────────────────────────────────────────────────────────────────
const pasteBox = (): HTMLTextAreaElement =>
  document.querySelector('textarea[name="employmentIdsRaw"]') as HTMLTextAreaElement;

/** The whole of the paste box's <Field>: caption, control, help sentence and the unmatched line. */
const pasteField = (): HTMLElement => pasteBox().closest('label') as HTMLElement;

beforeEach(() => {
  window.localStorage.clear();
  genPreview.mockClear();
  adjPreview.mockClear();
  genPayloads = [];
  adjPayloads = [];
});

const openGenerate = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: L.generateStepWho }));
  await user.click(screen.getByRole('radio', { name: L.adjustmentsByIndividual }));
};
const openAdjustments = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: L.adjustmentsStepWho }));
  await user.click(screen.getByRole('radio', { name: L.adjustmentsByIndividual }));
};
const openNotice = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('radio', { name: N.byIndividual }));
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('r289 §E · GENERATE ENTITLEMENT — the box takes the Employee ID you can see', () => {
  it('pasting EMP-0008 asks the server about IRWIN, not about the string', async () => {
    const user = userEvent.setup();
    mountGenerate();
    await openGenerate(user);
    await user.type(pasteBox(), 'EMP-0008');

    // The payload is the component's OWN output — the same list a submit posts, and the list the matched
    // count on screen is computed from. Before this round it carried the literal "EMP-0008", the action
    // fed it to `employment.id IN (…)` against a uuid column, and the screen sat on "Working it out…".
    await waitFor(() => expect(genPayloads.at(-1)?.employmentIds).toEqual([IRWIN]));
    expect(pasteField().textContent).not.toContain(L.generatePasteUnmatched.replace('{list}', ''));
  });

  it('the three spellings reach the same person, and the picker agrees with all of them', async () => {
    for (const spelling of ['EMP-0008', 'emp0008', 'EMP 0008']) {
      const view = mountGenerate();
      const user = userEvent.setup();
      await openGenerate(user);
      await user.type(pasteBox(), spelling);
      await waitFor(() => expect(genPayloads.at(-1)?.employmentIds, spelling).toEqual([IRWIN]));
      view.unmount();
      genPayloads = [];
    }
  });

  it('an internal id still works untouched, and is never called unrecognised', async () => {
    const user = userEvent.setup();
    mountGenerate();
    await openGenerate(user);
    await user.type(pasteBox(), `${IRWIN} ${NADIA}`);
    await waitFor(() => expect(genPayloads.at(-1)?.employmentIds).toEqual([IRWIN, NADIA]));
    expect(pasteField().textContent).not.toContain('not recognised');
    expect(pasteField().textContent).not.toContain('Not recognised');
  });

  /** ⚠️ THE THIRD ARM, RENDERED: named on screen AND still in the list the server is asked about. */
  it('a token matching nothing is NAMED on screen and STILL handed to the server', async () => {
    const user = userEvent.setup();
    mountGenerate();
    await openGenerate(user);
    await user.type(pasteBox(), 'EMP-0008 NOPE-1');

    const text = () => pasteField().textContent ?? '';
    await waitFor(() => expect(text()).toContain('NOPE-1'));
    expect(text()).toContain(L.generatePasteUnmatched.replace('{list}', 'NOPE-1'));
    // Never the key path and never an unsubstituted placeholder — next-intl renders both in silence.
    expect(text()).not.toContain('generatePasteUnmatched');
    expect(text()).not.toContain('{list}');
    // AND NOT DROPPED. The typo is still in the restriction, so it resolves to nobody rather than making
    // a two-person run look like a successful one-person run.
    await waitFor(() => expect(genPayloads.at(-1)?.employmentIds).toEqual([IRWIN, 'NOPE-1']));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('r289 §F · LEAVE ADJUSTMENTS — the same box, the same rule', () => {
  it('pasting EMP-0008 counts IRWIN; a bad token is named and still counted against nobody', async () => {
    const user = userEvent.setup();
    mountAdjustments();
    await openAdjustments(user);
    await user.type(pasteBox(), 'emp0008');
    await waitFor(() => expect(adjPayloads.at(-1)?.employmentIds).toEqual([IRWIN]));

    await user.type(pasteBox(), ' NOPE-1');
    const text = () => pasteField().textContent ?? '';
    await waitFor(() => expect(text()).toContain(L.adjustmentsPasteUnmatched.replace('{list}', 'NOPE-1')));
    expect(text()).not.toContain('adjustmentsPasteUnmatched');
    expect(text()).not.toContain('{list}');
    await waitFor(() => expect(adjPayloads.at(-1)?.employmentIds).toEqual([IRWIN, 'NOPE-1']));
  });

  it('the picker and the paste box name the SAME person, so choosing both is one person', async () => {
    const user = userEvent.setup();
    mountAdjustments();
    await openAdjustments(user);
    await user.click(screen.getByRole('button', { name: L.adjustmentsEmployeePicker }));
    await user.click(screen.getByRole('checkbox', { name: 'Irwin Tan · EMP-0008' }));
    await user.type(pasteBox(), 'EMP-0008');
    // De-duplication AFTER resolution is the only ordering that works here: the other order counts Irwin
    // twice and every count computed downstream still reads 1, because the engine de-duplicates again.
    await waitFor(() => expect(adjPayloads.at(-1)?.employmentIds).toEqual([IRWIN]));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
describe('r289 §G · NOTICE BOARD — the screen whose column accepts anything', () => {
  it('names an unrecognised reference, substituting its own placeholder on the client side', async () => {
    const user = userEvent.setup();
    mountNotice();
    await openNotice(user);
    await user.type(pasteBox(), 'EMP-0008 NOPE-1');

    const text = () => pasteField().textContent ?? '';
    await waitFor(() => expect(text()).toContain(N.fPasteUnmatched.replace('{list}', 'NOPE-1')));
    // The label crosses the server→client boundary as a STRING, so the page has to pass the placeholder
    // back in and this component has to substitute it. Both halves fail SILENTLY: a bare `t()` renders the
    // key path, and a missed `.replace` leaves `{list}` on screen.
    expect(text()).not.toContain('fPasteUnmatched');
    expect(text()).not.toContain('{list}');
    // …and `EMP-0008` is NOT among the ones it names, because it resolves. Asserted against the SENTENCE
    // rather than against the field's text: the textarea's own value is part of that text, so a bare
    // "does it mention EMP-0008" probe would be answered by the box the operator just typed into.
    expect(text()).not.toContain(N.fPasteUnmatched.replace('{list}', 'EMP-0008'));
  });

  it('a clean paste says nothing at all — the sentence is a report, not decoration', async () => {
    const user = userEvent.setup();
    mountNotice();
    await openNotice(user);
    await user.type(pasteBox(), 'EMP-0005, emp0008');
    // The Save button is the only thing this screen derives from the merged list, and it is enabled
    // because two people were named — by their Employee IDs, which is what this round is for.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: N.saveDraft }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(pasteField().textContent).not.toContain(N.fPasteUnmatched.replace('{list}', ''));
  });
});
