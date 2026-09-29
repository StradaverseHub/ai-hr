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
 * re-place, the Escape or the fixed positioning. Block B then asserts the SAME behaviours through the new
 * Leave Credit caller, which is what makes "one panel, two callers" a fact rather than an intention.
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
import { ANCHORED_PANEL_SHEET_QUERY } from '../components/ui/anchored-panel';
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

const viewButton = () => screen.getAllByTestId('leave-credit-attendance-view')[0] as HTMLButtonElement;
const openView = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getAllByLabelText(en.replacementRequest.workedDate)[0], '2026-09-16');
  await waitFor(() => expect(viewButton().disabled).toBe(false));
  await user.click(viewButton());
  await waitFor(() => expect(screen.queryByTestId('leave-credit-attendance-panel')).not.toBeNull());
};

describe('r365 · the Leave Credit row opens the SAME panel, and the product’s sheet below lg', () => {
  it('the Attendance panel is the anchored one, placed from the button’s rect', async () => {
    window.innerHeight = 900;
    window.innerWidth = 1400;
    stubRects({ top: 200, bottom: 230, right: 900 });
    const user = userEvent.setup();
    mountCredit();
    await openView(user);
    const el = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(el.className.split(' ')).toContain('fixed');
    expect(el.style.top).toBe('236px'); // 230 + the 6px gap
    expect(el.style.left).toBe('540px'); // 900 - 360
  });

  /**
   * ⚠️ BELOW `lg` IT IS components/ui/drawer.tsx — THE PRODUCT'S OWN SHEET, FULL SCREEN ON A PHONE AND A
   * TABLET — and not a second, bottom-sliding style invented for one button. The reporter asked for a
   * bottom sheet; the plan says plainly that this product has a full-screen sheet and that inventing a
   * third one is one more thing to maintain and one more thing to look inconsistent.
   *
   * jsdom answers every media query `false`, which is why `useBelowLg` asks a **max-width**: the desktop
   * panel is what an environment with no real viewport gets. This case installs the answer the other way.
   */
  it('below lg the same contents open in the shared Drawer, as a modal dialog, not as an anchored box', async () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q === ANCHORED_PANEL_SHEET_QUERY,
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    stubRects({ top: 200, bottom: 230, right: 900 });
    const user = userEvent.setup();
    mountCredit();
    await openView(user);

    // Radix's Dialog, portalled to the body — NOT the anchored box. Found by the drawer's OWN class
    // rather than by `role`, because that is the claim: this is components/ui/drawer.tsx and not a
    // second sheet that happens to be a dialog.
    const modal = document.querySelector('.ui-drawer-panel') as HTMLElement;
    expect(modal, 'the shared Drawer, not a hand-rolled sheet').not.toBeNull();
    expect(modal.getAttribute('role'), 'Radix Dialog semantics come with it').toBe('dialog');
    expect(modal.className, 'full width below lg — that is what makes it full screen on a phone').toContain('w-full');
    expect(modal.className, 'and the lg clamp is what it grows into above the breakpoint').toContain('lg:w-[28rem]');
    // The modal overlay is the other half of "this is the product's sheet" and a bare panel has none.
    expect(document.querySelector('.ui-drawer-overlay')).not.toBeNull();
    // The same contents, not a second rendering of them.
    expect(screen.getByTestId('leave-credit-attendance-panel')).toBeTruthy();
    expect(screen.getByTestId('leave-credit-attendance-footnote').textContent).toBe(
      en.replacementRequest.table.attendanceReferenceOnly,
    );
    // …and NOTHING is anchored: a sheet and an anchored box at once is the bug this guards.
    expect(document.querySelectorAll('[role="dialog"]'), 'exactly one surface is open').toHaveLength(1);
    expect(document.querySelectorAll('.fixed.w-\\[22\\.5rem\\]'), 'the anchored panel must not also be mounted').toHaveLength(0);
  });
});
