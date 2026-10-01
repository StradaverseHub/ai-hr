/**
 * r365 cbfa8b0b · THE ANCHORED PANEL, EXTRACTED — AND THE PROOF THAT THE EXTRACTION KEPT ITS BEHAVIOUR.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT DRIVES THE **OLD** CALLER ──────────────────────────────────────────
 * components/ui/anchored-panel.tsx is not new behaviour. It is the `position: fixed` rect maths, the
 * flip-up rule, the capture-phase scroll/resize re-place and the Escape dismissal that
 * components/attendance-figure-cells.tsx has carried inline since 7c834696, lifted out so the Leave Credit
 * request row can open the same panel without a second copy.
 *
 * ⚠️ AN EXTRACTION IS A CLAIM ABOUT THE OLD CALLER, and until this file there was no DOM test of that
 * caller at all — test/attendance-explain-panel.test.ts checks the reader and the six catalogues and never
 * mounts anything. So "the extraction preserves behaviour" was unfalsifiable. Every case in block A drives
 * the ATTENDANCE island, through the shared module, and would fail on a move that dropped the flip, the
 * re-place, the Escape or the fixed positioning. Block B follows the approved r378 Leave Credit change to inline details, preserving
 * their reference content and verifying that no second modal surface remains.
 *
 * ── jsdom SUPPLIES NO LAYOUT, SO THE RECTS ARE STUBBED AND THAT IS THE POINT ────────────────────────────
 * `getBoundingClientRect` returns all zeros in jsdom, which would make every placement identical and every
 * assertion here vacuous. Each case installs the rect it is about — a trigger near the top of the viewport,
 * and one near the bottom — and asserts the two produce DIFFERENT placements. `window.innerHeight` is set
 * explicitly for the same reason: the flip rule reads it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import { AttendanceFigureCells } from '../components/attendance-figure-cells';
import { LeaveCreditRequestTable, type LeaveCreditDayFacts } from '../components/leave/leave-credit-request-table';
import type { AttendanceExplanation } from '../core/attendance-explain';

const OT = { flat: 0, ot00: 0, ot10: 60, ot15: 0, ot20: 0, ot30: 0 };

/** A real explanation, so the panel has something to draw and an empty panel cannot pass for an open one. */
const EXPLANATION: AttendanceExplanation = { kind: 'unavailable', reason: 'no-trace' };

/** Install a rect on every element, and remember what we installed so a case can assert against it. */
function stubRects(rect: { top: number; bottom: number; right: number; left?: number }) {
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left ?? 0,
        right: rect.right,
        width: rect.right - (rect.left ?? 0),
        height: rect.bottom - rect.top,
        x: rect.left ?? 0,
        y: rect.top,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const mountFigures = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <table>
        <tbody>
          <tr>
            <AttendanceFigureCells lateMinutes={5} earlyOutMinutes={0} ot={OT} hasRow explanation={EXPLANATION} />
          </tr>
        </tbody>
      </table>
    </NextIntlClientProvider>,
  );

const tooltip = () => document.querySelector('[role="tooltip"]') as HTMLElement | null;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// A. THE EXISTING CALLER, THROUGH THE EXTRACTED MODULE. Nothing here is new behaviour; all of it is
//    behaviour that was never pinned, and it is pinned now because an extraction moved it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r365 · the attendance figure panel still behaves exactly as it did inline', () => {
  it('opens on the figure, is position:fixed, and is placed from the trigger’s own rect', async () => {
    window.innerHeight = 900;
    window.innerWidth = 1400;
    stubRects({ top: 100, bottom: 120, right: 700 });
    const user = userEvent.setup();
    mountFigures();
    expect(tooltip(), 'nothing is open before the figure is touched').toBeNull();

    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(tooltip()).not.toBeNull());
    const el = tooltip()!;
    // ⚠️ FIXED, not absolute: the table lives in `overflow-x-auto`, which clips an absolute panel. Read
    // off the CLASS and not `getComputedStyle`, because jsdom has no stylesheet and computes every
    // Tailwind class to `static` — an assertion on the computed value would be about jsdom, not the panel.
    expect(el.className.split(' ')).toContain('fixed');
    expect(el.className, 'absolute is the defect this positioning exists to avoid').not.toMatch(/\babsolute\b/);
    // Below the trigger, by the 6px gap the inline version used.
    expect(el.style.top).toBe('126px');
    // Right-aligned to the trigger, clamped into the viewport: 700 - 360 = 340.
    expect(el.style.left).toBe('340px');
    expect(el.style.transform, 'not flipped: there is room below').toBe('');
  });

  it('FLIPS UP when there is no room below and there is room above — and the two placements differ', async () => {
    window.innerHeight = 600;
    window.innerWidth = 1400;
    stubRects({ top: 500, bottom: 520, right: 700 });
    const user = userEvent.setup();
    mountFigures();
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(tooltip()).not.toBeNull());
    const el = tooltip()!;
    // 520 + 340 > 600 and 500 > 340 ⇒ flip. Anchored to the trigger's TOP, less the gap, drawn upwards.
    expect(el.style.top).toBe('494px');
    expect(el.style.transform).toBe('translateY(-100%)');
  });

  it('re-places on a scroll in the CAPTURE phase — a container scroll does not bubble', async () => {
    window.innerHeight = 900;
    window.innerWidth = 1400;
    const spy = stubRects({ top: 100, bottom: 120, right: 700 });
    const user = userEvent.setup();
    mountFigures();
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(tooltip()!.style.top).toBe('126px'));

    // The anchor moved because its scroller did. The listener is on `window` with capture, so a scroll
    // dispatched on a DIV inside the tree reaches it without bubbling.
    spy.mockImplementation(
      () => ({ top: 40, bottom: 60, left: 0, right: 700, width: 700, height: 20, x: 0, y: 40, toJSON: () => ({}) }) as DOMRect,
    );
    const inner = document.querySelector('table')!;
    inner.dispatchEvent(new Event('scroll', { bubbles: false }));
    await waitFor(() => expect(tooltip()!.style.top).toBe('66px'));
  });

  it('Escape closes it', async () => {
    window.innerHeight = 900;
    stubRects({ top: 100, bottom: 120, right: 700 });
    const user = userEvent.setup();
    mountFigures();
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(tooltip()).not.toBeNull());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(tooltip()).toBeNull());
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// B. THE NEW CALLER, AND THE SHEET IT USES INSTEAD BELOW `lg`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
const TIERS = { extendedHalfDayMinutes: 240, extendedFullDayMinutes: 480, extendedBreakMinutes: 0, extendedGraceMinutes: 0 };
const WORKING_DAY: LeaveCreditDayFacts = {
  kind: 'workday',
  shiftStart: '09:00:00',
  shiftEnd: '18:00:00',
  actualClockIn: '08:52:00',
  actualClockOut: '21:05:00',
  measuredExtendedMinutes: 0,
  approvedOtPlan: null,
};

const mountCredit = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <LeaveCreditRequestTable
        replacementType={{ id: 'lt-1', name: 'Replacement Leave' }}
        submitAction={() => {}}
        today="2026-09-24"
        dayFactsAction={vi.fn(async () => WORKING_DAY)}
        tiers={TIERS}
        ordinaryDayAllowed
      />
    </NextIntlClientProvider>,
  );

// r378 replaces this caller's anchored panel/phone Drawer with one inline disclosure.
const detailsButton = () => screen.getAllByTestId('leave-credit-details-toggle')[0] as HTMLButtonElement;
const openDetails = async (user: ReturnType<typeof userEvent.setup>) => {
  expect(detailsButton().disabled).toBe(true);
  await user.type(screen.getAllByLabelText(en.replacementRequest.workedDate)[0], '2026-09-16');
  await waitFor(() => expect(detailsButton().disabled).toBe(false));
  expect(detailsButton().getAttribute('aria-expanded')).toBe('false');
  await user.click(detailsButton());
  await waitFor(() => expect(screen.queryByTestId('leave-credit-attendance-panel')).not.toBeNull());
};

describe('r378 · Leave Credit attendance details stay inline at wide and phone widths', () => {
  it.each([1400, 390])('at %ipx the same reference contents expand in the owning table row', async (width) => {
    window.innerWidth = width;
    const user = userEvent.setup();
    mountCredit();
    await openDetails(user);
    const panel = screen.getByTestId('leave-credit-attendance-panel');
    const cell = panel.closest('td');
    expect(cell, 'the facts belong to an actual table cell').not.toBeNull();
    expect(cell!.getAttribute('colspan')).toBe('7');
    expect(panel.closest('table')).toBe(screen.getByTestId('leave-credit-table'));
    expect(detailsButton().getAttribute('aria-expanded')).toBe('true');
    expect(detailsButton().type).toBe('button');
    expect(detailsButton().name).toBe('');
    expect(screen.getByTestId('leave-credit-attendance-footnote').textContent).toBe(
      en.replacementRequest.table.attendanceReferenceOnly,
    );
    expect(panel.textContent).toContain('2026-09-16');
    expect(panel.textContent).toContain('08:52');
    expect(panel.textContent).toContain('21:05');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(document.querySelector('.ui-drawer-panel')).toBeNull();
    await user.click(detailsButton());
    expect(detailsButton().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('leave-credit-attendance-panel')).toBeNull();
  });
});
