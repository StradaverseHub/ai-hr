/**
 * aec53564 (r331) — THE WORKING-DAY ROW, RENDERED, AND FOLLOWING THE SCHEDULE GROUP LIVE.
 *
 * The write half is pinned in test/aec53564-shift-working-days.test.ts. What only a render can answer is
 * the promise the reporter will actually check: "pick a group that sets a week and the days grey out AS
 * YOU PICK IT; clear the group and they come back. No save required to find out which you got."
 *
 * Three things are asserted that a source scan cannot see:
 *   1. the seven dropdowns are DISABLED and not REMOVED — the row is still on screen, still readable, and
 *      it is the shift's own fallback week the operator can come back to;
 *   2. what a greyed row SHOWS is the group's week — `weekPatternFor`'s return value, the one in force —
 *      not the shift's stored row greyed out. Displaying an inert week is the defect this item exists to
 *      end, not a politer version of it;
 *   3. the reason is stated WHERE THE CONTROL IS: the Schedule Group by name, a link to the section of its
 *      page that states the week, and a link back down to the picker. The picker is in Section 4, below
 *      this row, so a greyed row with no sentence beside it would be a bug report.
 *
 * The last block renders it once per SHIPPING catalogue: a missing key here returns 200 and prints
 * "admin.attendancePolicy.shiftWorkingDaysDecidedBy" over the one sentence that explains a dead control.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import { ShiftTimeFields, type DayKind } from '../components/shift-time-fields';
import {
  SHIFT_SCHEDULE_GROUP_ANCHOR,
  ShiftScheduleGroupProvider,
  ShiftScheduleGroupSelect,
  type ShiftScheduleGroupOption,
} from '../components/shift-schedule-group';

const ISO = [1, 2, 3, 4, 5, 6, 7] as const;

/** The shift's OWN week: Mon–Wed full, Thu half, Fri off, weekend rest. Deliberately unlike any group's. */
const OWN: Record<number, DayKind> = { 1: 'full', 2: 'full', 3: 'full', 4: 'half', 5: 'off', 6: 'rest', 7: 'rest' };

/** The tenant Standard rule as migration 0483 leaves it: all three arrays NULL. It must never win. */
const STANDARD: ShiftScheduleGroupOption = {
  id: 'std-0000-0000-0000-000000000000',
  name: 'Standard',
  isDefault: true,
  inactive: false,
  href: '/admin/attendance/schedule/std-0000-0000-0000-000000000000?section=workingDay#section-workingDay',
  pattern: null,
  halfPattern: null,
  offPattern: null,
};

/** A Schedule Group that DOES state a week: Mon–Fri full, Sat off. */
const FIVE_DAY: ShiftScheduleGroupOption = {
  id: 'grp-0000-0000-0000-000000000001',
  name: 'Standard 5 Day + Saturday Off',
  isDefault: false,
  inactive: false,
  href: '/admin/attendance/schedule/grp-0000-0000-0000-000000000001?section=workingDay#section-workingDay',
  pattern: [1, 2, 3, 4, 5],
  halfPattern: [],
  offPattern: [6],
};

function renderForm(defaultRuleId: string, messages: typeof en = en) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ShiftScheduleGroupProvider groups={[STANDARD, FIVE_DAY]} defaultRuleId={defaultRuleId}>
        <ShiftTimeFields dayKinds={OWN} />
        {/* Section 4 in the real form — deliberately rendered AFTER the day row here too. */}
        <ShiftScheduleGroupSelect />
      </ShiftScheduleGroupProvider>
    </NextIntlClientProvider>,
  );
}

const daySelects = (c: HTMLElement) =>
  ISO.map((d) => c.querySelector(`select[name="dayKind_${d}"]`) as HTMLSelectElement);
const kinds = (c: HTMLElement) => daySelects(c).map((s) => s.value);
const groupSelect = (c: HTMLElement) => c.querySelector('select[name="attendanceRuleId"]') as HTMLSelectElement;

describe('aec53564 — the days are editable exactly when nothing else is deciding', () => {
  it('no group states a week ⇒ seven editable dropdowns showing the SHIFT’s own week', () => {
    const { container } = renderForm('');
    expect(daySelects(container).every((s) => s != null), 'all seven render').toBe(true);
    expect(daySelects(container).some((s) => s.disabled), 'none is disabled').toBe(false);
    expect(kinds(container)).toEqual(['full', 'full', 'full', 'half', 'off', 'rest', 'rest']);
    // The group's NAME is on screen either way — it is an <option> in the picker. What must be absent is
    // the sentence that explains a dead control, so assert on THAT, not on the name.
    expect(
      screen.queryByRole('link', { name: en.admin.attendancePolicy.shiftWorkingDaysDecidedLink }),
      'no "this is decided elsewhere" note when nothing is deciding',
    ).toBeNull();
  });

  it('a group that states a week ⇒ all seven disabled, showing the GROUP’s week, with the reason beside them', () => {
    const { container } = renderForm(FIVE_DAY.id);
    expect(daySelects(container).every((s) => s.disabled), 'every day is disabled').toBe(true);
    expect(daySelects(container).length, 'and NOT removed — the fallback stays visible').toBe(7);
    expect(kinds(container), 'what is shown is the week in force, not the inert stored one').toEqual([
      'full',
      'full',
      'full',
      'full',
      'full',
      'off',
      'rest',
    ]);

    const link = screen.getByRole('link', { name: en.admin.attendancePolicy.shiftWorkingDaysDecidedLink });
    const note = link.closest('p') as HTMLElement;
    expect(note.textContent, 'the group is named, not merely implied').toContain('Standard 5 Day + Saturday Off');
    expect(link.getAttribute('href'), 'the section rides as a query parameter AND the fragment').toBe(
      `/admin/attendance/schedule/${FIVE_DAY.id}?section=workingDay#section-workingDay`,
    );
    expect(link.getAttribute('href'), 'never concatenated in front of a query key (the r287 → r301 defect)').not.toMatch(
      /\?section=[^#]*\?/,
    );
    const jump = screen.getByRole('link', { name: en.admin.attendancePolicy.shiftWorkingDaysChangeGroup });
    expect(jump.getAttribute('href'), 'and the picker itself is one click away').toBe(`#${SHIFT_SCHEDULE_GROUP_ANCHOR}`);
    expect(container.querySelector(`#${SHIFT_SCHEDULE_GROUP_ANCHOR}`), 'which is a real element on this page').not.toBeNull();
  });

  /**
   * (c) THE LIVE HALF. No save, no reload, no server round trip: the two assertions below are one render
   * apart and the only thing between them is a change event on the picker.
   */
  it('follows the picker BOTH WAYS with no save, and the shift’s own week survives the round trip', async () => {
    const user = userEvent.setup();
    const { container } = renderForm('');
    expect(daySelects(container).some((s) => s.disabled)).toBe(false);

    await user.selectOptions(groupSelect(container), FIVE_DAY.id);
    expect(daySelects(container).every((s) => s.disabled), 'greyed as the group is picked').toBe(true);
    expect(kinds(container)).toEqual(['full', 'full', 'full', 'full', 'full', 'off', 'rest']);

    await user.selectOptions(groupSelect(container), '');
    expect(daySelects(container).some((s) => s.disabled), 'and editable again when it is cleared').toBe(false);
    expect(kinds(container), 'with the shift’s own week intact — nothing overwrote it').toEqual([
      'full',
      'full',
      'full',
      'half',
      'off',
      'rest',
      'rest',
    ]);
  });

  it('the tenant Standard rule, whose three arrays are NULL, does NOT lock the row', async () => {
    const user = userEvent.setup();
    const { container } = renderForm('');
    await user.selectOptions(groupSelect(container), STANDARD.id);
    expect(
      daySelects(container).some((s) => s.disabled),
      'a group that states no working week does not win — a week matching nothing would book every day as rest',
    ).toBe(false);
    expect(kinds(container)).toEqual(['full', 'full', 'full', 'half', 'off', 'rest', 'rest']);
  });

  it('an operator edit still reaches the dropdown when nothing is deciding', async () => {
    const user = userEvent.setup();
    const { container } = renderForm('');
    await user.selectOptions(daySelects(container)[5], 'full');
    expect(kinds(container)[5]).toBe('full');
  });
});

describe('aec53564 — the sentence beside a dead control resolves in all six catalogues', () => {
  for (const [loc, messages] of [
    ['en', en],
    ['ms', ms],
    ['ta', ta],
    ['th', th],
    ['vi', vi],
    ['zh', zh],
  ] as const) {
    it(`${loc}: the group name is substituted and nothing renders a raw key`, () => {
      const { container, unmount } = renderForm(FIVE_DAY.id, messages as typeof en);
      const text = container.textContent ?? '';
      expect(text, 'no MISSING_MESSAGE').not.toContain('MISSING_MESSAGE');
      expect(text, 'no unresolved key printed as itself').not.toContain('attendancePolicy.');
      expect(text, 'the ICU argument was substituted, not printed').not.toContain('{group}');
      expect(text, 'the group is named in this locale too').toContain(FIVE_DAY.name);
      const cat = (messages as typeof en).admin.attendancePolicy;
      expect(text).toContain(cat.shiftWorkingDaysDecidedLink);
      expect(text).toContain(cat.shiftWorkingDaysChangeGroup);
      expect(text, 'and the picker hint that explains the reach of this control').toContain(cat.ruleFieldWeekHint);
      unmount();
    });
  }
});
