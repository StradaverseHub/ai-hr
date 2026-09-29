/**
 * 2a237f5f (r332) — THE LEAVE CREDIT REQUEST'S LEAVE TYPE BOX, RENDERED.
 *
 * The reported defect is a control: My Leave → Leave Credit Request offered a Leave type dropdown listing
 * every type the employee was eligible for, when a Leave Credit is only ever Replacement Leave. A source
 * guard can say the <select> is gone; only a render can say what stands in its place and WHAT THE FORM
 * POSTS — and the posted value is the half that a "the markup looks right" check misses, because the
 * visible box is `disabled` and a disabled control is never submitted. So the claims here are made against
 * a real `FormData` built from the real form, not against the markup.
 *
 * WHY THE VISIBLE BOX IS NOT THE ONE CARRYING THE NAME. The HR-side dialog
 * (components/leave/leave-credit-add-dialog.tsx) posts NOTHING for its fixed leave type — the service knows.
 * This one deliberately still posts the resolved id, because `replacement_leave_request.leave_type_id` is
 * populated on the rows already in production and nulling it on new rows would quietly change stored data
 * nobody asked to change. `disabled` + a separate hidden input is what makes both true at once.
 *
 * AND THE OTHER FORM IS UNTOUCHED. The last case renders the ordinary Request Leave fields with six leave
 * types and asserts all six are still offered. Fixing one dropdown by narrowing both would be the obvious
 * way to get this item wrong, and nothing else in the suite would notice.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { ReplacementLeaveRequestDialog } from '../components/leave/replacement-leave-request-dialog';
import { LeaveDurationFields, type LeaveTypeOption } from '../components/leave-duration-fields';

const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

/** The tenant's OWN name for their replacement type, deliberately not the English seed name and not any
 *  string in `messages/`: a box that printed a translated constant would read "Replacement Leave" here. */
const TENANT_TYPE = { id: '11111111-1111-4111-8111-111111111111', name: 'Off in Lieu (Acme)' };

/** r343 — the roster answer the single table needs for a typed date. No date is typed in this file. */
const NO_FACTS = vi.fn(async () => null);

function openDialog(locale: Locale) {
  render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <ReplacementLeaveRequestDialog
        replacementType={TENANT_TYPE}
        submitAction={vi.fn()}
        today="2026-09-17"
        dayFactsAction={NO_FACTS}
        // r358 — `extendedHoursTiers={null}` used to mean BOTH "no tier ladder" and "an ordinary
        // day earns nothing here". Those are two facts now: the ladder applies to every day type,
        // and the switch governs the ordinary one alone.
        tiers={{ extendedHalfDayMinutes: 240, extendedFullDayMinutes: 480, extendedBreakMinutes: 0, extendedGraceMinutes: 0 }}
        ordinaryDayAllowed={false}
      />
    </NextIntlClientProvider>,
  );
  const rr = (CATALOGUES[locale] as unknown as { replacementRequest: Record<string, string> }).replacementRequest;
  fireEvent.click(screen.getByText(rr.trigger));
  const dialog = screen.getByRole('dialog');
  return { dialog, rr, form: dialog.querySelector('form') as HTMLFormElement };
}

describe('2a237f5f: the Leave Credit request names one leave type and offers no other', () => {
  for (const locale of LOCALES) {
    it(`[${locale}] renders the tenant's own type name in a fixed, non-editable box`, () => {
      const { dialog, rr } = openDialog(locale);

      // The field is still LABELLED "Leave type" — the employee must still be told what the box is.
      expect(dialog.textContent).toContain(rr.leaveType);

      // r343 — the fixed box moved into the single table with the rest of the form; the testid moved with it.
      const box = dialog.querySelector('[data-testid="leave-credit-leave-type"]') as HTMLInputElement;
      expect(box).toBeTruthy();
      expect(box.tagName).toBe('INPUT');
      expect(box.value).toBe(TENANT_TYPE.name);
      expect(box.readOnly).toBe(true);
      expect(box.disabled).toBe(true);
      // …and it carries no `name`, so it cannot post anything of its own even if `disabled` were removed.
      expect(box.getAttribute('name')).toBeNull();

      /*
       * NO CHOICE OF LEAVE TYPE IS ON OFFER — pinned by NAMING every dropdown the form has, which is the
       * only form of this assertion that cannot rot.
       *
       * ⚠️ UPDATED TWICE, AND BOTH TIMES THE SUBJECT SURVIVED. r332 asserted "the one <select> left is the
       * day/hour unit". cbfa8b0b (r336) made the unit a fixed field, so the one select became Section A's
       * 1-or-0.5 day picker. r343's contest then made the DAY TYPE an input, so the row has TWO selects: the
       * four-option day type and the day count. Counting them is not the claim — the claim is that NEITHER
       * offers a leave type, and it is asserted by aria-label, by `select[name="leaveTypeId"]` and by the
       * option labels below.
       */
      const selects = Array.from(dialog.querySelectorAll('select'));
      const dayTypeLabel = (rr as unknown as { sectionA: Record<string, string> }).sectionA.dayType;
      // r358 — ONE select per row, not two. This read `[dayTypeLabel, rr.days]`: the second was the
      // 1-or-0.5 day picker, which the owner's answer replaced with the claimed window ("4 hours of
      // eligible work = 0.5 day … regardless of the Day Type"). The claim this case makes is unchanged
      // and is not about the count — it is that NO select here offers a leave type.
      expect(selects.map((el) => el.getAttribute('aria-label'))).toEqual([dayTypeLabel]);
      expect(dialog.querySelector('select[name="leaveTypeId"]')).toBeNull();
      expect(dialog.querySelector('select[name="unit"]'), 'the unit stopped being a choice').toBeNull();

      /*
       * …AND THE UNIT IS NOT POSTED AT ALL ANY MORE. r336 posted `<input type="hidden" name="unit"
       * value="day">`; r343's `submitLeaveCreditRequest` DERIVES it (every row of the single table credits in
       * days) and passes `unit: 'day'` to the layer below itself. A field the form does not send cannot be
       * tampered with, so this is the stronger end of the same claim — but it is a real change, and pinning
       * the absence is what stops the constant being reintroduced as an employee-controlled value.
       */
      expect(dialog.querySelector('input[name="unit"]'), 'nothing posts a unit; the service derives it').toBeNull();
      expect(dialog.querySelector('select[name="aDays"]'), 'r336’s section field names are gone').toBeNull();

      const optionLabels = Array.from(dialog.querySelectorAll('option')).map((o) => o.textContent);
      expect(optionLabels).not.toContain(TENANT_TYPE.name);
      expect(optionLabels, 'no leftover Hour option now that nothing credits in hours').not.toContain(rr.unitHour);
    });
  }

  it('POSTS the resolved replacement type id — once, from a hidden field', () => {
    // The contract this dialog has with app/leave/credit/actions.ts `submitLeaveCreditRequestAction`, which
    // reads `formData.get('leaveTypeId')` (r343; it was `submitReplacementLeaveRequestAction` before). Asserted through FormData rather than by looking for an input,
    // because "a field exists" and "a field is submitted" are different facts and `disabled` is the whole
    // difference here (CLAUDE.md §8: a form field that is always submitted cannot be read by presence).
    const { dialog, form } = openDialog('en');
    expect(form).toBeTruthy();

    const fd = new FormData(form);
    expect(fd.getAll('leaveTypeId')).toEqual([TENANT_TYPE.id]);
    // The NAME never travels: it is display only, and the id is what the row records.
    expect([...fd.values()]).not.toContain(TENANT_TYPE.name);

    const hidden = dialog.querySelector('input[name="leaveTypeId"]') as HTMLInputElement;
    expect(hidden.type).toBe('hidden');
    expect(hidden.value).toBe(TENANT_TYPE.id);
  });

  it('a different tenant type flows straight through to both the box and the post', () => {
    // Non-vacuity for the two assertions above: neither is comparing a constant against itself.
    const other = { id: '22222222-2222-4222-8222-222222222222', name: 'Rest Day Credit' };
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ReplacementLeaveRequestDialog
          replacementType={other}
          submitAction={vi.fn()}
          today="2026-09-17"
          dayFactsAction={NO_FACTS}
          // r358 — `extendedHoursTiers={null}` used to mean BOTH "no tier ladder" and "an ordinary
          // day earns nothing here". Those are two facts now: the ladder applies to every day type,
          // and the switch governs the ordinary one alone.
          tiers={{ extendedHalfDayMinutes: 240, extendedFullDayMinutes: 480, extendedBreakMinutes: 0, extendedGraceMinutes: 0 }}
          ordinaryDayAllowed={false}
        />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByText((en as unknown as { replacementRequest: { trigger: string } }).replacementRequest.trigger));
    const dialog = screen.getByRole('dialog');
    expect((dialog.querySelector('[data-testid="leave-credit-leave-type"]') as HTMLInputElement).value).toBe(other.name);
    expect(new FormData(dialog.querySelector('form') as HTMLFormElement).get('leaveTypeId')).toBe(other.id);
  });
});

describe('2a237f5f: the ordinary Request Leave form still offers every type the employee holds', () => {
  it('keeps all six eligible types in its own leave-type <select>', () => {
    // THE SCOPE LINE. This item fixes ONE dropdown. The Request Leave form is where an employee chooses
    // which entitlement to spend, and a choice there is real — this asserts it was not narrowed with it.
    const types: LeaveTypeOption[] = [
      { id: 't1', label: 'Annual Leave', durations: null },
      { id: 't2', label: 'Sick Leave', durations: null },
      { id: 't3', label: 'Maternity Leave', durations: null },
      { id: 't4', label: 'Unpaid Leave', durations: null },
      { id: 't5', label: 'Compassionate Leave', durations: null },
      { id: 't6', label: 'Replacement Leave', durations: null },
    ];
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <LeaveDurationFields types={types} summaryAction={vi.fn(async () => null)} />
      </NextIntlClientProvider>,
    );
    const select = container.querySelector('select[name="leaveTypeId"]') as HTMLSelectElement;
    expect(select, 'Request Leave still picks a leave type').toBeTruthy();
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual(
      types.map((t) => t.label),
    );
  });
});
