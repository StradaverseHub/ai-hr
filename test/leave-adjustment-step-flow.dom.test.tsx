/**
 * 18103ba4 — the Leave Adjustments four-step flow, RENDERED, because the two things most likely to go
 * wrong here cannot be seen any other way.
 *
 * 1. THE PERSISTED STEP KEY. `leaveAdjustmentFlow` lives in localStorage. It is PER-BROWSER state: no
 *    source grep proves what a browser holding an old value actually lands on, and no server render can
 *    see it at all. The repeated lesson in components/leave-type-panel.tsx is that a stored key which no
 *    longer resolves silently strands the user — which is why a remap table exists there and here. A jsdom
 *    render is the only thing that can put a value in storage and then look at the screen.
 *
 * 2. EVERY STEP STAYS MOUNTED. The flow is ONE form with ONE submit, so a step that unmounts is a step
 *    whose values do not post — an adjustment that silently loses its reason or its effective date. That
 *    is invisible to types, to the build, and to any test that does not render.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * "hidden" here is asserted as the class the component sets, not as a computed visibility.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { AdjustmentForm, type CriteriaSection } from '../components/leave/adjustment-form';

/**
 * r288 — the individual-target picker's population. Real-shaped uuids: the field holds uuids, and a
 * fixture that pretends otherwise proves less.
 */
const employees = [
  { id: '33333333-3333-4333-8333-333333333333', name: 'Daniel Tan', employeeCode: 'EMP-0005' },
  { id: '11111111-1111-4111-8111-111111111111', name: 'Irwin Tan', employeeCode: 'EMP-0008' },
];

const leaveTypes = [
  { value: 'lt-annual', label: 'Annual Leave' },
  { value: 'lt-sick', label: 'Sick Leave' },
];

/** A two-section builder — enough to prove the grouping and the three control kinds render. */
const criteriaSections: CriteriaSection[] = [
  {
    key: 'company',
    title: 'Company Information',
    fields: [
      { name: 'companyIds', label: 'Company', kind: 'multi', options: [{ value: 'c1', label: 'Acme Sdn Bhd' }] },
      { name: 'departmentIds', label: 'Department', kind: 'multi', options: [{ value: 'd1', label: 'Finance' }] },
    ],
  },
  {
    key: 'service',
    title: 'Service Information',
    fields: [
      { name: 'hiredFrom', label: 'Hired on or after', kind: 'date' },
      { name: 'minYearsOfService', label: 'Years of service — at least', kind: 'number' },
    ],
    note: 'Job Title, Employee Group and Employee Class are not held…',
  },
];

type PreviewArg = {
  leaveTypeIds: string[];
  effectiveOn: string;
  targetMode: 'criteria' | 'individual';
  criteria: Record<string, string[] | string>;
  employmentIds: string[];
};
const preview = vi.fn(async (_p: PreviewArg) => ({
  employees: 7,
  targeted: 14,
  willWrite: 14,
  issues: [] as { kind: string; count: number; leaveTypeName?: string }[],
}));

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AdjustmentForm
        action={() => {}}
        previewAction={preview}
        today="2026-08-05"
        leaveTypes={leaveTypes}
        criteriaSections={criteriaSections}
        employees={employees}
      />
    </NextIntlClientProvider>,
  );
}

/** The step the bar says is current. Exactly one carries aria-current="step" (the SubStepBar invariant). */
const currentStep = () =>
  screen.getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'step')?.textContent ?? '';

beforeEach(() => {
  window.localStorage.clear();
  // mockReset, not mockClear: a test that installs its own mockResolvedValue would otherwise leak it into
  // every test after it, and the failure lands on an innocent neighbour.
  preview.mockReset();
  preview.mockResolvedValue({ employees: 7, targeted: 14, willWrite: 14, issues: [] });
});

describe('18103ba4 · the four steps, in the reporter’s walk order', () => {
  it('renders the shared SubStepBar with all four steps and starts on Leave Type', () => {
    mount();
    const bar = screen.getByRole('list', { name: messages.admin.leave.adjustmentsFlowAria });
    for (const label of [
      messages.admin.leave.adjustmentsStepTypes,
      messages.admin.leave.adjustmentsStepWho,
      messages.admin.leave.adjustmentsStepWhat,
      messages.admin.leave.adjustmentsStepReview,
    ]) {
      expect(bar.textContent).toContain(label);
    }
    expect(currentStep()).toContain(messages.admin.leave.adjustmentsStepTypes);
  });

  it('Next walks forward and Back walks back', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: messages.admin.leave.adjustmentsNext }));
    expect(currentStep()).toContain(messages.admin.leave.adjustmentsStepWho);
    await user.click(screen.getByRole('button', { name: messages.admin.leave.adjustmentsBack }));
    expect(currentStep()).toContain(messages.admin.leave.adjustmentsStepTypes);
  });

  it('the criteria are GROUPED into expandable sections, not one long list', () => {
    mount();
    // Native <details>: a <summary> per group, and the reporter's "instead of displaying one long list".
    for (const s of criteriaSections) expect(screen.getByText(s.title).tagName).toBe('SUMMARY');
  });
});

describe('18103ba4 · EVERY STEP STAYS MOUNTED — one form, one submit', () => {
  it('step 3’s inputs are in the DOM while step 1 is showing', () => {
    const { container } = mount();
    expect(currentStep()).toContain(messages.admin.leave.adjustmentsStepTypes);
    // If any of these unmounted with their step, the submitted FormData would silently lose them.
    for (const name of ['days', 'effectiveOn', 'reason']) {
      expect(container.querySelector(`[name="${name}"]`), `${name} mounted`).not.toBeNull();
    }
    // …and step 2's range controls, which are ordinary inputs.
    for (const name of ['hiredFrom', 'minYearsOfService']) {
      expect(container.querySelector(`[name="${name}"]`), `${name} mounted`).not.toBeNull();
    }
    // A ChipMultiSelect with NOTHING chosen deliberately renders no named element at all — it emits one
    // hidden input per SELECTED value, and "no restriction on this axis" is expressed by posting nothing.
    // So the mounted-ness of a criteria picker is its section being present, not a `[name=…]` node.
    expect(screen.getByText('Company Information').tagName).toBe('SUMMARY');
  });

  it('no control carries `required` — a hidden required control makes the browser refuse to submit', () => {
    // Chrome reports "An invalid form control with name=… is not focusable" and the form never posts, with
    // nothing on screen to act on. Completeness is the flow's job; applyLeaveAdjustmentBatch is the
    // authority, and it throws readable errors for every missing field.
    const { container } = mount();
    expect(container.querySelectorAll('[required]').length).toBe(0);
  });

  it('exactly one step is visible at a time', () => {
    const { container } = mount();
    const sections = [...container.querySelectorAll('form > section')];
    expect(sections.length).toBe(4);
    expect(sections.filter((s) => !s.className.includes('hidden')).length).toBe(1);
  });
});

describe('18103ba4 · the persisted step key, and the browser it must not strand', () => {
  it('restores a stored step', () => {
    window.localStorage.setItem('leaveAdjustmentFlow', JSON.stringify({ step: 'details' }));
    mount();
    expect(currentStep()).toContain(messages.admin.leave.adjustmentsStepWhat);
  });

  it('persists the step the user picked', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: messages.admin.leave.adjustmentsNext }));
    expect(JSON.parse(window.localStorage.getItem('leaveAdjustmentFlow') ?? '{}')).toEqual({ step: 'employees' });
  });

  it('A STORED "review" LANDS ON STEP 1, NOT ON AN EMPTY SUMMARY', () => {
    // The real remap, and the reason the table exists. Review renders nothing of its own — it summarises
    // the three steps in front of it — so a fresh load restored onto it would show a summary of a form
    // that has just been emptied. That is the blank-screen failure, and it is invisible to every other
    // kind of test because the value lives in one person's browser.
    window.localStorage.setItem('leaveAdjustmentFlow', JSON.stringify({ step: 'review' }));
    mount();
    expect(currentStep()).toContain(messages.admin.leave.adjustmentsStepTypes);
  });

  it('a RETIRED or unknown step key falls back to step 1 rather than rendering nothing', () => {
    window.localStorage.setItem('leaveAdjustmentFlow', JSON.stringify({ step: 'somethingRetiredInR200' }));
    mount();
    expect(currentStep()).toContain(messages.admin.leave.adjustmentsStepTypes);
    // …and the screen is not blank: step 1's own controls are there.
    expect(screen.getByText(messages.admin.leave.adjustmentsAdjustmentType)).toBeInTheDocument();
  });

  it('malformed storage is survivable', () => {
    window.localStorage.setItem('leaveAdjustmentFlow', 'not json{');
    mount();
    expect(currentStep()).toContain(messages.admin.leave.adjustmentsStepTypes);
  });
});

describe('18103ba4 · the live matched count', () => {
  it('asks the server and shows the number, replacing the static “this matches everyone” warning', async () => {
    mount();
    // The count is requested on mount (and on every change) — countAdjustmentTargets had ZERO callers
    // before this item, and the screen showed only a warning, never a figure.
    await vi.waitFor(() => expect(preview).toHaveBeenCalled());
    // The English message is an ICU plural, so assert the rendered text rather than a template
    // substitution. findAll, because Step 2's counter and Step 4's summary row both say it — and both are
    // mounted at once, which is the point of the one-form design.
    expect(await screen.findAllByText('7 employees')).not.toHaveLength(0);
  });

  /**
   * r288 (8521e160) UPDATED THIS GUARD RATHER THAN DELETING IT — CLAUDE.md §8: "a guard pinning a decision
   * you are reversing is updated, not deleted."
   *
   * 18103ba4 pinned that a failed count printed `adjustmentsMatchedPending`. That WAS the decision, and it
   * was the defect: "Working it out…" is a PENDING sentence, so a count that had already failed was
   * indistinguishable from one still in flight and the screen sat on it forever. The half of the old
   * promise that still holds — no number is invented — is asserted below, alongside the terminal sentence
   * that now replaces the pending one.
   */
  it('does not invent a number when the count fails, and stops claiming to be working', async () => {
    preview.mockRejectedValueOnce(new Error('nope'));
    mount();
    await screen.findAllByText(messages.admin.leave.adjustmentsMatchedUnknown);
    expect(screen.queryByText(messages.admin.leave.adjustmentsMatchedPending)).toBeNull();
    expect(screen.queryByText('7 employees')).toBeNull();
  });

  it('switching to Pick individually re-asks, because the two modes resolve different sets', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: messages.admin.leave.adjustmentsNext }));
    const before = preview.mock.calls.length;
    await user.click(screen.getByRole('radio', { name: messages.admin.leave.adjustmentsByIndividual }));
    await vi.waitFor(() => expect(preview.mock.calls.length).toBeGreaterThan(before));
    expect(preview.mock.lastCall?.[0].targetMode).toBe('individual');
    // The paste box replaces the criteria builder, and it posts ONE field the action parses server-side.
    expect(document.querySelector('[name="employmentIdsRaw"]')).not.toBeNull();
  });

  it('RECOUNTS WHEN A CRITERIA CHIP IS PICKED — the bug a render found and a source read could not', async () => {
    // A ChipMultiSelect row is a <button>, not an input, so toggling one fires NO `change` event and the
    // form-level onChange listener never hears it. On the live page this showed as the matched count
    // sitting on "everyone" while the operator picked criteria, moving only when they happened to touch a
    // date or number field — a count describing a different set of people from the one on screen.
    const user = userEvent.setup();
    mount();
    await vi.waitFor(() => expect(preview).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: messages.admin.leave.adjustmentsNext }));
    const before = preview.mock.calls.length;

    // Open the Company picker (its caption is its accessible name) and tick a value.
    await user.click(screen.getByRole('button', { name: 'Company' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Acme Sdn Bhd' }));

    await vi.waitFor(() => expect(preview.mock.calls.length).toBeGreaterThan(before));
    // …and the recount carried the picked criterion, rather than firing with an empty set.
    expect(preview.mock.lastCall?.[0].criteria).toEqual({ companyIds: ['c1'] });
  });
});

describe('18103ba4 · Step 4 · Review & Process', () => {
  /** Fill enough of the flow that the review has something to summarise, then land on step 4. */
  async function walkToReview(user: ReturnType<typeof userEvent.setup>) {
    mount();
    // The step-bar button and the picker trigger share the caption; only the trigger is a popover.
    await user.click(screen.getByRole('button', { name: 'Leave type', expanded: false }));
    await user.click(await screen.findByRole('checkbox', { name: 'Annual Leave' }));
    await user.keyboard('{Escape}');
    const form = document.querySelector('form')!;
    const days = form.querySelector<HTMLInputElement>('[name="days"]')!;
    await user.type(days, '2');
    await user.type(form.querySelector<HTMLInputElement>('[name="reason"]')!, 'CNY goodwill');
    await user.click(screen.getByRole('button', { name: messages.admin.leave.adjustmentsStepReview }));
    await vi.waitFor(() => expect(preview).toHaveBeenCalled());
  }

  it('summarises what is about to happen, in the reporter’s five rows', async () => {
    const user = userEvent.setup();
    await walkToReview(user);
    // (Not asserting the leave-type NAME here: it legitimately appears twice, once as step 1's chip and
    // once in this summary, because every step stays mounted.)
    // The DIRECTION and the UNIT together: "+2 Days", not a bare number whose sign lives on another step.
    await screen.findByText('+2 Days');
    await screen.findByText('CNY goodwill');
    // ICU plurals agree with their counts — "1 leave type" singular next to two plurals.
    await screen.findByText('14 records — 1 leave type × 7 employees');
  });

  it('RENDERS ALL FOUR VALIDATION MESSAGES with their counts and leave-type names', async () => {
    // These four `t()` calls only run when the server reports a problem, so a plain page render never
    // reaches them — exactly how twelve labels shipped broken in r127. Rendering them here against the real
    // en.json exercises the actual ICU formatting, placeholder names included.
    preview.mockResolvedValue({
      employees: 7,
      targeted: 7,
      willWrite: 5,
      issues: [
        { kind: 'not_found', count: 1 },
        { kind: 'inactive', count: 2 },
        { kind: 'not_eligible', count: 3, leaveTypeName: 'Annual Leave' },
        { kind: 'frozen', count: 2, leaveTypeName: 'Annual Leave' },
      ],
    });
    const user = userEvent.setup();
    await walkToReview(user);
    await screen.findByText(messages.admin.leave.adjustmentsIssuesTitle);
    await screen.findByText('1 employee references were not recognised and will be ignored.');
    await screen.findByText('2 employees were not employed on the effective date. They will still be adjusted.');
    await screen.findByText('3 employees do not qualify for Annual Leave on the effective date.');
    await screen.findByText('2 Annual Leave balances are frozen for encashment and will be skipped.');
  });

  it('OFFERS NO PROCESS BUTTON when there is nothing to process', async () => {
    // The reporter asks for validation to run before processing is allowed. An empty batch is the simplest
    // case of that: applyLeaveAdjustmentBatch would refuse it, but only after a navigation and a red
    // banner — which is a worse way to find out than the button not being there.
    preview.mockResolvedValue({ employees: 0, targeted: 0, willWrite: 0, issues: [] });
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: messages.admin.leave.adjustmentsStepReview }));
    await screen.findByText(messages.admin.leave.adjustmentsReviewNothing);
    expect(screen.queryByRole('button', { name: messages.admin.leave.adjustmentsSubmit })).toBeNull();
  });

  it('offers the Process button once the batch resolves to something', async () => {
    const user = userEvent.setup();
    await walkToReview(user);
    await screen.findByRole('button', { name: messages.admin.leave.adjustmentsSubmit });
  });
});
