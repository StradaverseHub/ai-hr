/**
 * r293 — RUN EARNED ACCRUAL MARKS THE LEAVE TYPES IT CAN NEVER ACCRUE, RENDERED.
 *
 * WHAT THE ITEM IS. `app/admin/leave-config/earned-accrual/page.tsx` feeds the picker
 * `listLeaveTypes(s, { includeArchived: false })` — EVERY active leave type, swept or not — while
 * `accrueEarnedLeave` filters `code IN STANDING_LEAVE_CODES` (ANNUAL · SICK · HOSPITALIZATION) BEFORE it
 * reads a single employment. So the control has always offered rows that can never produce a day, and the
 * only signal was the r285 typed empty reason (`type_not_swept`), reached AFTER the operator picked one
 * and spent a preview. This round moves that fact to where the choice is made.
 *
 * ⚠️ THE REPORTER'S OWN DIAGNOSIS IS NOT WHAT IS BUILT HERE. They reported that the process "only
 * recognizes Hospitalization Leave and Medical Leave" and that Annual Leave is excluded from it. `ANNUAL`
 * IS in `STANDING_LEAVE_CODES` — what their account actually holds is an ACTIVE `AL` "*Annual Leave"
 * outside the constant beside an ARCHIVED `ANNUAL`. The engine is therefore correct and UNCHANGED (see
 * §4 of test/r293-earned-accrual-picker.test.ts, and ADR-0066 line 89 for why the boundary is deliberate);
 * the screen is what was silent.
 *
 * ⚠️ WHY THIS FILE RENDERS RATHER THAN GREPS. The option rows exist only while the popover is OPEN, and
 * the popover is a `useState` inside a client island mounted in a Radix portal — so none of this markup is
 * ever in the SSR output and a curl of the route proves nothing about it (CLAUDE.md §8). A key that exists
 * in no catalogue satisfies tsc, `next build` and every source scan while next-intl paints
 * `MISSING_MESSAGE` in the browser. The real component is therefore driven against the SHIPPING
 * catalogues, in all six locales.
 *
 * ⚠️ THE SECOND ARM IS THE ONE THAT MATTERS. A marker painted on every row would pass every "the marker
 * is shown" assertion in §A. §B is the arm a vacuous guard hides in: an ACTIVE type on a STANDING code
 * carries NOTHING, and §E pins that a tenant whose types are all swept sees no paragraph at all.
 *
 * NOTHING ABOUT THE ENGINE IS ASSERTED HERE. Which codes the sweep covers, and that this round left that
 * filter exactly where it was, is test/r293-earned-accrual-picker.test.ts's job against a real database.
 * This file pins only what the picker does with the facts it is handed — including that it prints THE
 * TENANT'S OWN type names and never a hardcoded English one.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

// The SHIPPING catalogues, not fixtures: a half-translated round is the failure §F exists to catch.
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { EarnedAccrualCard, type EarnedLeaveTypeOption } from '../components/earned-accrual-card';

/**
 * ⚠️ THE ENGINE'S CONSTANT, WRITTEN OUT RATHER THAN IMPORTED — AND THAT IS NOT A SHORTCUT. `core/leave.ts`
 * opens the database connection at module load, and the `dom` vitest project deliberately has no env
 * bootstrap and no database; importing its VALUES fails collection outright. The copy is unavoidable,
 * leaving it unpinned is not: test/r293-earned-accrual-picker.test.ts runs in the node project, CAN import
 * the engine, and reads this literal back out of THIS FILE'S SOURCE. Keep the name and the single-line
 * array shape — it is what the regex there matches.
 */
const ENGINE_STANDING_CODES_COPY = ['ANNUAL', 'SICK', 'HOSPITALIZATION'];

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Both action modules are server modules; in jsdom they would drag the database in. Nothing in this file
// runs or previews an accrual — the marking is visible before either — so both are inert stubs.
vi.mock('@/app/admin/actions', () => ({ runEarnedAccrualAction: async () => ({ granted: 0, forfeits: 0 }) }));
vi.mock('@/app/admin/leave-config/earned-accrual/actions', () => ({
  previewEarnedAccrualWithReasonAction: async () => ({
    rows: [],
    asOf: '2026-09-15',
    emptyReason: null,
    archivedHint: [],
    earnedToDateTotal: 0,
  }),
}));

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

/**
 * ⚠️ THE TENANT'S OWN NAMES, AND DELIBERATELY NOT THE ENGLISH DEFAULTS. The three standing CODES are
 * fixed; the names against them are whatever the tenant typed. "Annual Leave is not accrued here" is a
 * riddle on an account that has two leave types both called some variant of Annual Leave — which is
 * exactly the account that raised this — so these fixtures share no word with the defaults, and §D asserts
 * the defaults never appear. The `*`-prefixed twin beside its swept namesake reproduces the production
 * shape (an ACTIVE `AL` next to an `ANNUAL`) in miniature.
 */
const NOT_SWEPT_DAILY = '*Cuti Tahunan'; // code 'AL', accrual_method earned_daily, ACTIVE
const NOT_SWEPT_FESTIVE = 'Hari Raya Day'; // code 'FEST', granted in full, ACTIVE
const SWEPT_ANNUAL = 'Cuti Tahunan'; // code 'ANNUAL', ACTIVE
const SWEPT_SICK = 'MC'; // code 'SICK', ACTIVE
const SWEPT_HOSP = 'Ward Leave'; // code 'HOSPITALIZATION', ACTIVE
const ENGLISH_DEFAULTS = ['Annual Leave', 'Medical Leave', 'Hospitalization Leave', 'Sick Leave'];

/** The tenant that raised this, in miniature: two non-swept actives, all three standing codes active. */
const MIXED: EarnedLeaveTypeOption[] = [
  { id: 'lt-al', name: NOT_SWEPT_DAILY, swept: false },
  { id: 'lt-fest', name: NOT_SWEPT_FESTIVE, swept: false },
  { id: 'lt-annual', name: SWEPT_ANNUAL, swept: true },
  { id: 'lt-sick', name: SWEPT_SICK, swept: true },
  { id: 'lt-hosp', name: SWEPT_HOSP, swept: true },
];
const SWEPT_NAMES_OF = (types: EarnedLeaveTypeOption[]) =>
  types
    .filter((o) => o.swept)
    .map((o) => o.name)
    .sort((a, b) => a.localeCompare(b));

const CARD_PROPS = {
  companies: [{ id: 'c1', name: 'Acme Sdn Bhd' }],
  grades: [{ id: 'g1', name: 'Executive' }],
  leaveYears: [{ year: 2026, status: 'draft' }],
  defaultYear: 2026,
};

const mount = (
  leaveTypes: EarnedLeaveTypeOption[],
  sweptLeaveTypeNames: string[],
  locale = 'en',
  messages: Record<string, unknown> = en as never,
) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <EarnedAccrualCard
        {...CARD_PROPS}
        leaveTypes={leaveTypes}
        sweptLeaveTypeNames={sweptLeaveTypeNames}
      />
    </NextIntlClientProvider>,
  );

/** The pickers carry TRANSLATED captions, so each is found by its own locale's string. */
const captions = (messages: typeof en) => ({
  type: messages.admin.leave.earnedScopeLeaveType,
  company: messages.admin.leave.earnedScopeCompany,
  grade: messages.admin.leave.earnedScopeGrade,
});

/** Open one of the three scope popovers by its caption — the trigger's accessible name. */
const openPicker = async (caption: string) =>
  userEvent.click(screen.getByRole('button', { name: caption }));

/** Every option row that carries a marker, as `name → marker`. */
const markedRows = () =>
  Object.fromEntries(
    screen.queryAllByTestId('multi-select-option-note').map((note) => {
      const label = note.closest('label');
      const name = label?.querySelector('span')?.textContent ?? '';
      return [name, note.textContent ?? ''];
    }),
  );

/** The whole row text for one option, marker included — `null` when the option is not on screen. */
const rowTextOf = (name: string) => screen.getByText(name).closest('label')?.textContent ?? null;

describe('§A the production case — an ACTIVE type outside the standing codes is MARKED', () => {
  it('marks the earned_daily type the reporter can pick, in the picker, before any run', async () => {
    mount(MIXED, SWEPT_NAMES_OF(MIXED));
    await openPicker(captions(en).type);
    const tag = en.admin.leave.earnedTypeNotCoveredTag;
    expect(rowTextOf(NOT_SWEPT_DAILY)).toBe(`${NOT_SWEPT_DAILY}${tag}`);
    // The code decides, not the earning method: `accrueEarnedLeave` returns on the code filter before it
    // has looked at one. A festive type set to grant in full is just as unreachable from this screen.
    expect(rowTextOf(NOT_SWEPT_FESTIVE)).toBe(`${NOT_SWEPT_FESTIVE}${tag}`);
  });

  it('says what the two words mean, naming both halves', async () => {
    mount(MIXED, SWEPT_NAMES_OF(MIXED));
    expect(screen.getByTestId('earned-types-not-swept').textContent).toBe(
      'Run Earned Accrual covers only these leave types: Cuti Tahunan, MC, and Ward Leave. It does not ' +
        'cover *Cuti Tahunan and Hari Raya Day, so those can never accrue day by day — no entitlement ' +
        'table, date or earning method can change that.',
    );
  });

  it('agrees with the leave type editor, which is the point of reusing its sentence', () => {
    // r288 shipped the same fact on the editing screen. The reporter has now been given the wrong reason
    // twice; two screens describing ONE boundary in two different sets of words is how that happens. The
    // shared shape is pinned, not a byte-identical string: the editor speaks about the one type being
    // edited ("this one"), this screen about a list it is offering.
    const editor = en.admin.leave.subStep.earningNotSwept;
    const picker = en.admin.leave.earnedTypesNotSwept;
    expect(editor).toContain('Run Earned Accrual covers only these leave types: {swept}.');
    expect(picker).toContain('Run Earned Accrual covers only these leave types: {swept}.');
    expect(editor).toContain('never accrue day by day');
    expect(picker).toContain('never accrue day by day');
    expect(editor).toContain('no entitlement table, date or earning method can change that');
    expect(picker).toContain('no entitlement table, date or earning method can change that');
  });
});

describe('§B the second arm — an ACTIVE type ON a standing code is NOT marked', () => {
  it('carries no marker, and the row is its name and nothing else', async () => {
    mount(MIXED, SWEPT_NAMES_OF(MIXED));
    await openPicker(captions(en).type);
    // ⚠️ THE VACUOUS-GUARD ARM. A marker painted on every row passes §A in full and fails here.
    for (const name of [SWEPT_ANNUAL, SWEPT_SICK, SWEPT_HOSP]) expect(rowTextOf(name)).toBe(name);
    expect(Object.keys(markedRows()).sort()).toEqual([NOT_SWEPT_FESTIVE, NOT_SWEPT_DAILY].sort());
  });

  it('a tenant whose active types are ALL swept sees no marker and no paragraph', async () => {
    const allSwept = MIXED.filter((o) => o.swept);
    mount(allSwept, SWEPT_NAMES_OF(allSwept));
    expect(screen.queryByTestId('earned-types-not-swept')).toBeNull();
    await openPicker(captions(en).type);
    expect(screen.queryAllByTestId('multi-select-option-note')).toHaveLength(0);
  });

  it('the company and grade pickers are untouched — this is the leave-type axis only', async () => {
    mount(MIXED, SWEPT_NAMES_OF(MIXED));
    for (const caption of [captions(en).company, captions(en).grade]) {
      await openPicker(caption);
      expect(screen.queryAllByTestId('multi-select-option-note')).toHaveLength(0);
      await openPicker(caption); // close again
    }
  });
});

describe('§C MARK, DO NOT REMOVE AND DO NOT DISABLE', () => {
  it('the marked option is still listed, still enabled and still selectable', async () => {
    mount(MIXED, SWEPT_NAMES_OF(MIXED));
    await openPicker(captions(en).type);
    // The engine's typed empty reason stays the authority on why a run found nothing. Hiding the row
    // would replace one silence with another — and would hide the very type the reporter went looking for.
    const box = screen.getByText(NOT_SWEPT_DAILY).closest('label')!.querySelector('input')!;
    expect(box).toBeEnabled();
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(box).toBeChecked();
    // The scope the card would post is unchanged: one selected id, reported by the trigger exactly as it
    // is for a swept type.
    expect(
      screen.getByRole('button', { name: captions(en).type }).textContent,
    ).toContain(en.admin.leave.multiSelectSelectedCount.replace('{count}', '1'));
  });
});

describe('§D the names are the TENANT’S — never an English default', () => {
  it('neither the paragraph nor any marked row contains a default leave-type name', async () => {
    mount(MIXED, SWEPT_NAMES_OF(MIXED));
    await openPicker(captions(en).type);
    const rendered = document.body.textContent ?? '';
    for (const name of ENGLISH_DEFAULTS) {
      expect(rendered, `the picker printed the English default "${name}"`).not.toContain(name);
    }
    // And the fixture is honest about which arm each row is: the two marked rows are the codes outside
    // the engine's constant, the three unmarked ones are the constant itself.
    expect(ENGINE_STANDING_CODES_COPY).toHaveLength(MIXED.filter((o) => o.swept).length);
  });

  it('prints whatever it is handed, including names that share a prefix', async () => {
    // The production riddle in miniature: '*Cuti Tahunan' and 'Cuti Tahunan' differ by one character, and
    // only one of them is swept. A screen that matched on name rather than on the server's boolean would
    // mark both or neither.
    mount(MIXED, SWEPT_NAMES_OF(MIXED));
    await openPicker(captions(en).type);
    expect(rowTextOf(NOT_SWEPT_DAILY)).toContain(en.admin.leave.earnedTypeNotCoveredTag);
    expect(rowTextOf(SWEPT_ANNUAL)).toBe(SWEPT_ANNUAL);
  });
});

describe('§E the none-active sentence — the reporting account’s actual state', () => {
  it('names the types and says nothing is covered, rather than printing an empty list', () => {
    // On that tenant `ANNUAL` and `SICK` are archived and `HOSPITALIZATION` grants in full: the swept
    // list is EMPTY. A sentence built round an empty {swept} would read "covers only these leave types: ."
    const onlyUnswept = MIXED.filter((o) => !o.swept);
    mount(onlyUnswept, []);
    expect(screen.getByTestId('earned-types-not-swept').textContent).toBe(
      'Run Earned Accrual does not cover *Cuti Tahunan and Hari Raya Day, and no leave type it does ' +
        'cover is active on this account — so those can never accrue day by day.',
    );
  });
});

describe('§F all six locales — a marker that paints MISSING_MESSAGE is not a marker', () => {
  for (const [locale, messages] of LOCALES) {
    it(`${locale} renders the marker and the sentence, with the subjects named`, async () => {
      const m = messages as unknown as typeof en;
      mount(MIXED, SWEPT_NAMES_OF(MIXED), locale, messages as never);

      const para = screen.getByTestId('earned-types-not-swept').textContent ?? '';
      expect(para, `${locale}: paragraph`).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
      expect(para, `${locale}: lost its subject`).toContain(NOT_SWEPT_DAILY);
      expect(para, `${locale}: lost what IS covered`).toContain(SWEPT_HOSP);
      // The raw ICU placeholders must be GONE — a bare t() on one of these renders the key path.
      expect(para, `${locale}: unformatted placeholder`).not.toMatch(/\{swept\}|\{types\}/);

      await openPicker(captions(m).type);
      const marks = screen.queryAllByTestId('multi-select-option-note');
      expect(marks, `${locale}: wrong number of marked rows`).toHaveLength(2);
      for (const mark of marks) {
        expect(mark.textContent, `${locale}: marker`).toBeTruthy();
        expect(mark.textContent, `${locale}: marker`).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
        expect(mark.textContent).toBe(m.admin.leave.earnedTypeNotCoveredTag);
      }

      // The none-active variant is a different sentence and gets the same treatment.
      screen.getByTestId('earned-types-not-swept');
      const noneActive = m.admin.leave.earnedTypesNotSweptNoneActive;
      expect(noneActive, `${locale}: none-active sentence`).toBeTruthy();
      expect(noneActive, `${locale}: none-active must name no swept list`).not.toContain('{swept}');
    });
  }
});
