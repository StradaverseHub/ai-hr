/**
 * 93249794 — the Generate Entitlement five-step flow, RENDERED.
 *
 * A 200 IS NOT A RENDER CHECK, and for THIS screen a server render is not one either. The three things
 * most likely to go wrong here are invisible to tsc, to the suite, to `next build` and to curl:
 *
 * 1. THE COMPUTED MESSAGE KEYS. The validation table renders `t(`generateOutcome_${outcome}`)`, which
 *    `test/i18n-coverage.test.ts` check C cannot see (it matches LITERAL keys only). A missing one paints
 *    the raw key path on screen behind a green suite — and a curl of this page never reaches it, because
 *    the table only exists once the preview SERVER ACTION has answered. This file drives that path with a
 *    stubbed preview and reads the actual rendered text. r127 shipped a sibling screen with two entire
 *    label sets missing exactly this way.
 *
 * 2. EVERY STEP STAYS MOUNTED. The flow is ONE form with ONE submit, so a step that unmounts is a step
 *    whose values do not post — here that means a leave year or a criteria set silently lost between
 *    picking it and pressing Generate.
 *
 * 3. THE PERSISTED STEP KEY. `leaveGenerateFlow` lives in localStorage, which is PER-BROWSER state that no
 *    grep and no server render can see. Steps ④ and ⑤ are DERIVED from a preview a fresh page load has not
 *    asked for yet, so a browser restored straight onto either would show a summary of nothing — the
 *    blank-screen failure `STEP_REMAP` exists to prevent.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * "hidden" is asserted as the class the component sets, not as computed visibility.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { GenerateForm } from '../components/leave/generate-form';
import type { CriteriaSection } from '../core/org-criteria-form';
import type { LeaveGenerationResult } from '../core/leave-generation';

const leaveTypes = [
  { value: 'lt-annual', label: 'Annual Leave' },
  { value: 'lt-sick', label: 'Sick Leave' },
];

/**
 * r287 (ff1c935f) — step ③'s employee picker needs a list. Two rows is enough for THIS file, whose
 * subject is the five-step walk; the picker's own three terminal states are pinned next door in
 * test/r287-generate-employee-picker.dom.test.tsx.
 */
const employees = [
  { id: 'emp-1', name: 'Irwin Tan', employeeCode: 'EMP-0008' },
  { id: 'emp-2', name: 'Nadia Rahim', employeeCode: 'EMP-0011' },
];

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

/** Every outcome the engine can report, so each computed label is forced through a real render. */
const OUTCOMES = [
  'granted',
  'unconfigured_method',
  'already_open',
  'frozen',
  'earned_method',
  'no_entitlement',
  'pack_blocked',
] as const;

const line = (i: number, outcome: (typeof OUTCOMES)[number]): LeaveGenerationResult['lines'][number] => ({
  employmentId: `e${i}`,
  employeeName: `Employee ${i}`,
  leaveTypeId: 'lt-annual',
  leaveTypeName: 'Annual Leave',
  outcome,
  days: outcome === 'granted' ? 12 : 0,
  carry: 0,
  forfeit: 0,
  belowStatutoryFloor: false,
  earnedMethodNotAnnualLeave: false,
  // r301 (e5018593) — the accrual reached none of these lines; the reached arm is pinned below.
  earnedAccrual: null,
});

const result: LeaveGenerationResult = {
  year: 2026,
  employeesSelected: 7,
  employeesReached: 7,
  employeesPassed: 4,
  employeesFailed: 3,
  granted: 4,
  skipped: 1,
  forfeits: 0,
  lines: OUTCOMES.map((o, i) => line(i, o)),
  decidedBy: [{ employmentId: 'e0', ruleName: 'Executives, Peninsular', templateName: 'Executive', alsoMatched: 2 }],
  accrual: null,
};

const preview = vi.fn(async () => result);

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GenerateForm
        action={() => {}}
        previewAction={preview}
        years={[2025, 2026, 2027]}
        defaultYear={2026}
        leaveTypes={leaveTypes}
        criteriaSections={criteriaSections}
        employees={employees}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  preview.mockClear();
});

describe('93249794 · the five-step flow renders', () => {
  it('shows all five steps in the reporter’s order and starts on step ①', async () => {
    mount();
    for (const label of [
      'Leave Selection',
      'Generation Settings',
      'Employee Selection',
      'Validation & Preview',
      'Process',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    // Step ① is the year + leave types. The step BAR button and the leave-type PICKER must not share an
    // accessible name — they did, and this assertion is why that was found rather than shipped.
    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Leave Selection' })).toHaveLength(1);
  });

  it('EVERY step stays mounted — a hidden step still posts its values', () => {
    const { container } = mount();
    const sections = container.querySelectorAll('form > section');
    expect(sections).toHaveLength(5);
    // Exactly one visible; the other four carry the hidden class rather than being unmounted.
    expect([...sections].filter((s) => !s.className.includes('hidden'))).toHaveLength(1);
    // The year select — on step ① — is in the DOM whatever step is showing, or it could not post.
    expect(container.querySelector('select[name="year"]')).toBeTruthy();
    expect(container.querySelector('input[name="targetMode"]')).toBeTruthy();
  });

  it('the three Generation Settings statements render as text, not as controls that would lie', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Generation Settings' }));
    // Named individually: "we added a settings step" is not checkable, "recalculate is missing" is.
    expect(screen.getByText('Prorate leave for new employees')).toBeTruthy();
    expect(screen.getByText('Generate leave until a chosen month')).toBeTruthy();
    expect(screen.getByText('Recalculate previous year')).toBeTruthy();
    // ⚠️ AND NOT AS CHECKBOXES. A disabled checkbox implies "switch this on later and it works"; the two
    // deferred options change what the calculation does and the third is already automatic.
    const { container } = mount();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });
});

describe('93249794 · the validation table resolves every COMPUTED message key', () => {
  it('renders a real label — never a raw key path — for all seven engine outcomes', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(preview).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Validation & Preview' }));

    // r301 (e5018593) — step ④ now also renders "Entitlement to grant" (and, with an earned line, "Earned
    // Annual Leave to add") as tables, so the issues table is found by its own accessible name.
    const table = await screen.findByRole('table', { name: messages.admin.leave.generateIssuesAria });
    const body = within(table).getAllByRole('row').slice(1); // drop the header
    // `granted` is not a failure and is filtered out of the table, as is `already_open`; the other five are.
    expect(body).toHaveLength(OUTCOMES.length - 2);

    const text = table.textContent ?? '';
    // THE ACTUAL DEFECT THIS CATCHES: next-intl renders a missing key as the key PATH.
    expect(text).not.toContain('generateOutcome_');
    expect(text).not.toContain('admin.leave');
    for (const outcome of OUTCOMES) {
      if (outcome === 'granted' || outcome === 'already_open') continue;
      const label = (messages.admin.leave as unknown as Record<string, string>)[`generateOutcome_${outcome}`];
      expect(typeof label, `generateOutcome_${outcome} must exist`).toBe('string');
      expect(text, `the table must show the ${outcome} label`).toContain(label);
    }
  });

  it('the summary tiles and the ICU count lines format rather than throw', async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await waitFor(() => expect(preview).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Validation & Preview' }));

    // ⚠️ SCOPED TO STEP ④'s OWN <dl>. Every step stays mounted (that is the whole design), so a global
    // getByText for a bare figure is ambiguous by construction — step ⑤ shows a count too. Asserting
    // globally is how a test starts passing for the wrong element.
    const tiles = container.querySelector('form > section:nth-of-type(4) dl')!;
    expect(tiles).toBeTruthy();
    const tileText = tiles.textContent ?? '';
    expect(tileText).toContain('Employees selected');
    expect(tileText).toContain('Passed');
    expect(tileText).toContain('Failed');
    // The numbers come from the preview, not from anything this component recomputes.
    expect(tileText).toContain('7');
    expect(tileText).toContain('4');
    expect(tileText).toContain('3');

    // 6e9a126e's "which rule won" line — an ICU message with three placeholders. A t() with no arguments
    // would throw FORMATTING_ERROR at render; the r140 hole. Asserted on the SUBSTITUTED text.
    expect(container.textContent).toContain('Executives, Peninsular');
    expect(container.textContent).toContain('Executive');
    expect(container.textContent).not.toContain('{rule}');
    expect(container.textContent).not.toContain('{template}');
  });

  it('step ③ shows the matched count through its plural rule', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(preview).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Employee Selection' }));
    expect(screen.getByText('7 employees selected')).toBeTruthy();
  });
});

describe('r299 (3de1453a) · an earned_method line says whether anything will ever add the days', () => {
  /**
   * The engine skips an earned method on a year-open for EVERY type, so the stored outcome is `earned_method`
   * either way. But Earned Accrual covers Annual Leave only: on Annual Leave the days come from Run Earned
   * Accrual, and on any other type nothing adds them. The server marks the second (`earnedMethodNotAnnualLeave`,
   * decided beside `isEarnedAccrualType` in openLeaveYear) and the label follows it. BOTH ARMS, one table.
   */
  it('a STRANDED earned method reads as stranded; Annual Leave on the same method keeps its label exactly', async () => {
    const L = messages.admin.leave;
    const mixed: LeaveGenerationResult = {
      ...result,
      lines: [
        line(0, 'earned_method'), // Annual Leave, unflagged
        { ...line(1, 'earned_method'), leaveTypeId: 'lt-sick', leaveTypeName: 'Sick Leave', earnedMethodNotAnnualLeave: true },
      ],
    };
    preview.mockImplementation(async () => mixed);
    try {
      const user = userEvent.setup();
      mount();
      await waitFor(() => expect(preview).toHaveBeenCalled());
      await user.click(screen.getByRole('button', { name: 'Validation & Preview' }));
      const table = await screen.findByRole('table', { name: L.generateIssuesAria });
      const reason = (employee: string) => {
        const row = within(table).getAllByRole('row').find((r) => r.textContent?.includes(employee));
        return row?.querySelectorAll('td')[2]?.textContent;
      };
      // ANNUAL LEAVE — byte-identical to the label it has always had.
      expect(reason('Employee 0')).toBe(L.generateOutcome_earned_method);
      // THE STRANDED TYPE — never "accrues through the year".
      expect(reason('Employee 1')).toBe(L.generateOutcomeEarnedMethodNotAnnualLeave);
      expect(reason('Employee 1')).not.toBe(L.generateOutcome_earned_method);
      expect(table.textContent).not.toContain('generateOutcome');
    } finally {
      preview.mockImplementation(async () => result);
    }
  });
});

describe('93249794 · the persisted step key cannot strand a browser', () => {
  it('a stored derived step lands on step ① rather than on a summary of nothing', async () => {
    for (const stored of ['validate', 'process']) {
      window.localStorage.setItem('leaveGenerateFlow', JSON.stringify({ step: stored }));
      const { container, unmount } = mount();
      await waitFor(() => {
        const first = container.querySelector('form > section');
        expect(first?.className.includes('hidden')).toBe(false);
      });
      unmount();
    }
  });

  it('an unknown stored key falls back to step ① rather than rendering nothing', async () => {
    window.localStorage.setItem('leaveGenerateFlow', JSON.stringify({ step: 'a-step-that-was-retired' }));
    const { container } = mount();
    const sections = container.querySelectorAll('form > section');
    expect([...sections].filter((s) => !s.className.includes('hidden'))).toHaveLength(1);
    expect(sections[0].className.includes('hidden')).toBe(false);
  });

  it('a KNOWN stored key is restored', async () => {
    window.localStorage.setItem('leaveGenerateFlow', JSON.stringify({ step: 'employees' }));
    const { container } = mount();
    await waitFor(() => {
      const sections = container.querySelectorAll('form > section');
      expect(sections[2].className.includes('hidden')).toBe(false);
    });
  });
});
