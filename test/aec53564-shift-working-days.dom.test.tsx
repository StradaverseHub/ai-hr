/**
 * aec53564 (r331) → r429 (f6819e19) · D1 — THE WORKING-DAY ROW IS GONE FROM THE SHIFT FORM, RENDERED.
 *
 * REWRITTEN for r429. The r331 DOM test proved the Mon–Sun row greyed live as a Schedule Group was picked.
 * r429 retires the row (and the picker it followed) from this screen entirely: which days are worked is
 * now set ONLY on the Schedule Group's own "Working Days" section
 * (app/admin/attendance/schedule/group-sections.tsx), and the Shift page shows a READ-ONLY line instead
 * (app/admin/attendance/shift-form.tsx, a server component — its own render is exercised by the render
 * check, not here).
 *
 * What this file proves about the CLIENT ISLAND that is left (components/shift-time-fields.tsx):
 *   1. no `dayKind_<n>` select exists anywhere in it — the row is not merely disabled, it is gone;
 *   2. no Schedule Group picker (`attendanceRuleId`) exists in it either — D2 retired that too;
 *   3. the Breaks table renders with at least one row (a blank one for a shift with none), and ticking
 *      Flexible on a row opens its own minutes box (D4 — the ONE way to set a break now);
 *   4. every key it asks for resolves in all SIX catalogues.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import { ShiftTimeFields } from '../components/shift-time-fields';

function renderForm(messages: typeof en = en) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ShiftTimeFields defaultBreaks={[{ start: '', end: '' }]} />
    </NextIntlClientProvider>,
  );
}

describe('r429 (f6819e19) — the working-day row and the Schedule Group picker are GONE from this island', () => {
  it('renders no dayKind_<n> select at all', () => {
    const { container } = renderForm();
    for (let d = 1; d <= 7; d++) {
      expect(container.querySelector(`select[name="dayKind_${d}"]`), `dayKind_${d} must not render`).toBeNull();
    }
  });

  it('renders no Schedule Group picker', () => {
    const { container } = renderForm();
    expect(container.querySelector('select[name="attendanceRuleId"]')).toBeNull();
  });

  it('renders no whole-shift Flexible break switch', () => {
    const { container } = renderForm();
    expect(container.querySelector('input[name="flexibleBreakEnabled"]')).toBeNull();
  });
});

describe('r429 (f6819e19) — the Breaks table, one row minimum, Flexible the one way to set a break', () => {
  it('a shift with no stored breaks opens with ONE blank row', () => {
    const { container } = renderForm();
    const starts = container.querySelectorAll('input[type="time"][aria-label^="Break start"]');
    expect(starts.length).toBe(1);
  });

  it('+ Add Break adds a second row, and Delete removes it again', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: en.roster.addBreak }));
    expect(screen.getAllByLabelText(/^Break start/)).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: en.roster.removeBreak })[1]);
    expect(screen.getAllByLabelText(/^Break start/)).toHaveLength(1);
  });

  it('ticking Flexible on a row opens its own minutes box, prefilled with the row’s length', async () => {
    const user = userEvent.setup();
    const { container } = renderForm();
    const start = container.querySelector('input[aria-label^="Break start"]') as HTMLInputElement;
    const end = container.querySelector('input[aria-label^="Break end"]') as HTMLInputElement;
    fireEvent.change(start, { target: { value: '12:00' } });
    fireEvent.change(end, { target: { value: '13:00' } });
    const flexibleTick = screen.getByLabelText(en.roster.breakFlexibleLabel) as HTMLInputElement;
    await user.click(flexibleTick);
    const minutesBox = screen.getByLabelText(en.roster.breakRowMinutes) as HTMLInputElement;
    expect(minutesBox.value).toBe('60');
  });
});

describe('r429 (f6819e19) — every message key this island asks for exists in all six catalogues', () => {
  for (const [loc, messages] of [
    ['en', en],
    ['ms', ms],
    ['ta', ta],
    ['th', th],
    ['vi', vi],
    ['zh', zh],
  ] as const) {
    it(`${loc}: renders with no MISSING_MESSAGE and no raw key`, () => {
      const { container, unmount } = renderForm(messages as typeof en);
      const text = container.textContent ?? '';
      expect(text, 'no MISSING_MESSAGE').not.toContain('MISSING_MESSAGE');
      expect(text, 'no unresolved roster. key printed as itself').not.toContain('roster.');
      expect(text, 'no unresolved admin.attendancePolicy. key printed as itself').not.toContain('attendancePolicy.');
      unmount();
    });
  }
});
