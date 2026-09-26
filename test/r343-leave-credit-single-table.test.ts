/**
 * r343 · cbfa8b0b — THE LEAVE CREDIT REQUEST AS ONE TABLE, WITH DAY TYPE AS AN INPUT.
 *
 * The reporter's contest REVERSED the design r336 shipped: "Do not create separate sections/screens for
 * these day types. All four types must be submitted from the same screen and displayed in the same request
 * table", and the Day Type becomes a four-option dropdown the employee fills in, validated against their own
 * work calendar / roster.
 *
 * WHAT THIS FILE DEFENDS, in the order the risk sits:
 *
 *  1. ⚠️ THE ADJUDICATION IS THE ONLY THING IN THE SYSTEM THAT CATCHES A REST-DAY / OFF-DAY / PUBLIC-HOLIDAY
 *     MIX-UP. `submitReplacementLeaveRequest` refuses a working-day row claimed as a non-working day and
 *     vice versa, because those land in different code paths — but all three non-working kinds produce the
 *     SAME claim path, so a row typed "Rest Day" on a date the roster calls an off day sails straight
 *     through it and is stored as an off day. The vacuity control below submits exactly that through the
 *     layer beneath and watches it SUCCEED, which is what makes the refusal above it evidence of anything.
 *  2. THE REFUSAL NAMES WHAT THE ROSTER HOLDS. "Does not match your roster" is useless advice on a screen
 *     that cannot show the roster.
 *  3. ONE TABLE, NOT TWO SECTIONS — and the per-row conditional survives as DISABLED CELLS. Pinned as a
 *     source shape because a second section is a layout fact no runtime assertion sees.
 *  4. A DISABLED CELL MUST NOT SHORTEN A ZIPPED FIELD LIST. A browser does not submit a disabled input, and
 *     the action zips the five row fields BY INDEX, so every posted value comes from a hidden input that is
 *     present whatever the row's day type. This is the defect that would silently shift every row after the
 *     first non-Ordinary one.
 *
 * Dates derive from `todayInKualaLumpur()` (CLAUDE.md §8) and sit in LAST calendar month, so they are always
 * in the past.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut } from '../core/attendance';
import { assignDefaultShift, assignShift, createShift, setRestDay } from '../core/roster';
import { todayInKualaLumpur } from '../lib/hr-date';
import { setToilPolicy, type ToilPolicyInput } from '../core/toil';
import {
  LEAVE_CREDIT_DAY_TYPES,
  LEAVE_CREDIT_DAY_TYPE_LABEL,
  adjudicateDayTypes,
  claimsTimeWindow,
  dayTypeMismatchMessage,
  isLeaveCreditDayType,
  type LeaveCreditDayType,
} from '../lib/leave-credit-day-type';
import {
  LeaveCreditDayTypeMismatchError,
  leaveCreditRosterKinds,
  sourceTypeForDayType,
  submitLeaveCreditRequest,
} from '../core/leave-credit-request';
import { ReplacementRequestInvalidError, submitReplacementLeaveRequest } from '../core/replacement-request';
import type { SessionContext } from '../db/client';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TABLE_TSX = 'components/leave/leave-credit-request-table.tsx';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (1) THE PURE HALF — the vocabulary, the per-row conditional and the adjudication, with no roster at all.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r343 · the four options and the per-row conditional', () => {
  it('the dropdown is exactly the reporter’s four options, in the order they were listed', () => {
    expect([...LEAVE_CREDIT_DAY_TYPES]).toEqual(['rest_day', 'off_day', 'holiday', 'workday']);
  });

  it('ONLY an ordinary day claims a time window — the other three do not', () => {
    expect(claimsTimeWindow('workday')).toBe(true);
    for (const d of ['rest_day', 'off_day', 'holiday'] as const) expect(claimsTimeWindow(d), d).toBe(false);
  });

  it('the claim path is DERIVED from the day type: three kinds are one path, the ordinary day is the other', () => {
    expect(sourceTypeForDayType('workday')).toBe('extended_hours');
    for (const d of ['rest_day', 'off_day', 'holiday'] as const) expect(sourceTypeForDayType(d), d).toBe('non_working_day');
  });

  /**
   * THE TWO VOCABULARIES ARE SET-EQUAL, AT RUNTIME, AGAINST THE COLUMN'S OWN ENUM.
   *
   * ⚠️ ADDED IN r343's FIX PASS. core/leave-credit-request.ts used to claim a compile-time pin here that it
   * did not have: `LEAVE_CREDIT_DAY_TYPES satisfies readonly ToilWorkedDayKind[]` is one-directional, so a
   * FIFTH roster kind satisfied it unchanged and the dropdown would have gone on offering four options for
   * a roster that answers five. The type-level check is now bidirectional (two `Exclude`s), and this case is
   * its runtime twin — because a type error is invisible to `vitest`, and `toilWorkedDayKindEnum` is what the
   * `worked_day_kind` column actually accepts. Widen the pg enum and this fails by name.
   */
  it('the four options are the roster vocabulary itself — set-equal to toil_worked_day_kind, both ways', () => {
    const roster = [...schema.toilWorkedDayKindEnum.enumValues].sort();
    expect([...LEAVE_CREDIT_DAY_TYPES].sort()).toEqual(roster);
    for (const kind of roster) expect(isLeaveCreditDayType(kind), kind).toBe(true);
  });

  it('a value that is not one of the four is not a day type', () => {
    for (const v of ['', 'weekend', 'WORKDAY', null, undefined, 7]) expect(isLeaveCreditDayType(v), String(v)).toBe(false);
  });
});

describe('r343 · adjudicateDayTypes', () => {
  const roster = (m: Record<string, LeaveCreditDayType>) => new Map(Object.entries(m));

  it('a row that agrees with the roster is not a mismatch', () => {
    expect(adjudicateDayTypes([{ workedDate: '2026-01-04', dayType: 'rest_day' }], roster({ '2026-01-04': 'rest_day' }))).toEqual([]);
  });

  it('⚠️ REST DAY vs OFF DAY is caught — the case the layer below cannot see, because both are one claim path', () => {
    const out = adjudicateDayTypes([{ workedDate: '2026-01-03', dayType: 'rest_day' }], roster({ '2026-01-03': 'off_day' }));
    expect(out).toEqual([{ workedDate: '2026-01-03', chosen: 'rest_day', roster: 'off_day' }]);
  });

  it('every offending row is reported at once, not one per round trip', () => {
    const out = adjudicateDayTypes(
      [
        { workedDate: '2026-01-03', dayType: 'holiday' },
        { workedDate: '2026-01-04', dayType: 'rest_day' },
        { workedDate: '2026-01-05', dayType: 'workday' },
      ],
      roster({ '2026-01-03': 'off_day', '2026-01-04': 'rest_day', '2026-01-05': 'holiday' }),
    );
    expect(out.map((r) => r.workedDate)).toEqual(['2026-01-03', '2026-01-05']);
  });

  it('a date the roster did not answer for is NOT a mismatch — it fails open here and closed below', () => {
    expect(adjudicateDayTypes([{ workedDate: '2026-01-09', dayType: 'holiday' }], roster({}))).toEqual([]);
  });

  it('the refusal names BOTH halves: what was chosen and what the roster holds', () => {
    const msg = dayTypeMismatchMessage([{ workedDate: '2026-01-03', chosen: 'rest_day', roster: 'off_day' }]);
    expect(msg).toContain('2026-01-03');
    expect(msg).toContain(LEAVE_CREDIT_DAY_TYPE_LABEL.rest_day);
    expect(msg).toContain(LEAVE_CREDIT_DAY_TYPE_LABEL.off_day);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (2) THE LAYOUT, AS A SOURCE SHAPE. A second section and a short posted list are both invisible at runtime.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r343 · ONE table, no sections, and five posted values per row', () => {
  it('the request form is ONE table and carries no section container of its own', () => {
    const src = read(TABLE_TSX);
    expect((src.match(/<table/g) ?? []).length, 'exactly one <table> in the request form').toBe(1);
    // r336's two sections were `<section data-testid="leave-credit-section-a|b">`. Neither may come back.
    expect(src).not.toContain('leave-credit-section-a');
    expect(src).not.toContain('leave-credit-section-b');
    expect(src).not.toContain('<section');
  });

  it('every one of the five row values is posted from a HIDDEN input, so a disabled cell cannot shorten the zip', () => {
    const src = read(TABLE_TSX);
    for (const name of ['workedDate', 'dayType', 'days', 'claimStart', 'claimEnd']) {
      expect(src, name).toContain(`type="hidden" name="${name}"`);
    }
  });

  it('no visible date / time / select control carries a posted name — the row state is the only source', () => {
    const src = read(TABLE_TSX);
    // A `name=` on a control that can be disabled is the defect. The only named controls in the form are
    // the hidden row fields plus the three whole-form fields, none of which is ever disabled.
    const named = [...src.matchAll(/name="([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect([...new Set(named)].sort()).toEqual(
      ['claimEnd', 'claimStart', 'dayType', 'days', 'firstScheduleConsent', 'leaveTypeId', 'reason', 'workedDate'].sort(),
    );
  });

  /**
   * ⚠️ STRENGTHENED IN r343's FIX PASS — THE SET ABOVE CANNOT SEE A DOUBLE-POSTED FIELD.
   *
   * `new Set` deduplicates, so adding `name="claimStart"` to the VISIBLE time input while KEEPING the hidden
   * one leaves the set identical and passes. That is not a theoretical shape: it posts TWO values for one
   * row whenever the cell is enabled and ONE when it is disabled, which breaks the action's by-index zip
   * from the other direction — the same defect the hidden inputs exist to prevent, arrived at by addition
   * instead of omission. Verified against the real failure: the adversarial verifier's revert 3 (hidden
   * input deleted, name moved onto the visible input) passed the set assertion and was caught only by the
   * `type="hidden"` case. COUNTING is what closes both directions at once.
   */
  it('each of the five row fields is posted EXACTLY ONCE, and that one occurrence is the hidden input', () => {
    const src = read(TABLE_TSX);
    for (const name of ['workedDate', 'dayType', 'days', 'claimStart', 'claimEnd']) {
      const all = (src.match(new RegExp(`name="${name}"`, 'g')) ?? []).length;
      const hidden = (src.match(new RegExp(`type="hidden" name="${name}"`, 'g')) ?? []).length;
      expect(all, `${name}: one posted occurrence, not ${all} — two would post two values per row`).toBe(1);
      expect(hidden, `${name}: its one occurrence must be the hidden input`).toBe(1);
    }
  });

  it('the per-row conditional is expressed as DISABLED cells driven by the chosen day type', () => {
    const src = read(TABLE_TSX);
    // Three states, one per cell group: the Days cell is live when the row DECLARES days; the claimed-window
    // cells are live only when the row wants a window AND the company can credit one (`windowLive`) — the
    // fix-pass split, because the Ordinary Day option is now offered to companies that cannot credit it.
    expect(src).toContain('disabled={!windowLive}');
    expect(src).toContain('disabled={!declaresDays}');
    expect(src).toContain('const windowLive = wantsWindow && !ordinaryUnavailable;');
    expect(src).toContain('claimsTimeWindow');
  });

  /**
   * ⚠️ THE FIX-PASS PIN FOR THE FOURTH OPTION. The first cut filtered `LEAVE_CREDIT_DAY_TYPES` by the
   * company's extended-hours switch, which is false by default on every company (migration 0486) — so the
   * reporter's "exactly four options" rendered as three. The runtime proof is in
   * test/r343-leave-credit-table.dom.test.tsx (four options with the tiers and without); this is the source
   * shape, because a filter is easy to reintroduce and reads as a courtesy while it removes a requirement.
   */
  it('the dropdown is built from the WHOLE vocabulary — no company switch filters the option list', () => {
    const src = read(TABLE_TSX);
    expect(src).toContain('const dayTypeOptions = LEAVE_CREDIT_DAY_TYPES;');
    expect(src).not.toMatch(/LEAVE_CREDIT_DAY_TYPES\s*\.\s*filter/);
    // What the switch DOES decide, stated once: whether an Ordinary Day row can earn anything here.
    expect(src).toContain('const ordinaryEarnsNothing = extendedHoursTiers == null;');
    expect(src).toContain('ordinaryUnavailableRows.length > 0');
  });

  it('the screen composes its day-type labels from the dayKind keys that already exist in all six locales', () => {
    const src = read(TABLE_TSX);
    for (const k of ['dayKind.restDay', 'dayKind.offDay', 'dayKind.holiday', 'dayKind.workday']) expect(src).toContain(k);
    for (const l of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${l}.json`));
      expect(Object.keys(m.replacementRequest.dayKind).sort(), l).toEqual(['holiday', 'offDay', 'restDay', 'workday']);
      expect(typeof m.replacementRequest.table.rosterMismatch, l).toBe('string');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (2b) ONE EMPLOYEE SURFACE, NOT TWO.
//
// ⚠️ THIS BLOCK IS THE FIX-PASS PIN FOR THE ROUND'S WORST DEFECT, and nothing in the suite could see it
// before. r343's first cut built the single table as a new screen at /leave/credit and LEFT r336's
// two-section dialog mounted on My Absence — so the product offered two ways to ask for one credit, and the
// prominent one was the layout the reporter had just rejected. Every guard was green: the new screen's tests
// passed against the new screen, the r336 tests passed against the r336 modal, and the exact-set nav guards
// passed precisely BECAUSE nothing had been added to nav. A duplicate surface is invisible to any test that
// only ever looks at one surface, which is why these cases look at the wiring BETWEEN files (CLAUDE.md §8:
// when a defect lives in the contract between two files, pin it across both).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r343 · the employee has ONE Leave Credit surface, and it is the single table', () => {

  // ⚠️ AND A WAY BACK TO IT. /leave/credit holds the itemised list of what the employee asked for — the
  // other half of the contest, "displayed in the same request table". My Absence renders only a summed
  // pending-days figure, so without a link the employee reaches the list by submitting something or by
  // typing the URL. A summary with no route to its detail is the half-delivered shape this item exists
  // to stop.
  it('My Absence links to the requests list, so the itemised table is reachable without submitting', () => {
    const page = read('app/leave/page.tsx');
    expect(page, 'the link exists').toContain('href="/leave/credit"');
    expect(page, 'and is findable by test rather than by position').toContain('leave-credit-requests-link');
    expect(page, 'and is captioned from the catalogue, not hardcoded').toContain("replacementRequest.viewMyRequests");
  });
  const DIALOG_TSX = 'components/leave/replacement-leave-request-dialog.tsx';
  const MY_LEAVE = 'app/leave/page.tsx';
  const CREDIT_PAGE = 'app/leave/credit/page.tsx';

  it('the My Absence dialog’s BODY is the single table — r336’s two sections are gone from it', () => {
    const src = read(DIALOG_TSX);
    expect(src).toContain('<LeaveCreditRequestTable');
    expect(src).toContain("from './leave-credit-request-table'");
    // The two sections, their own field names and their own totals. Any one of these coming back is the
    // rejected design coming back — in the file the employee's own button opens.
    for (const gone of [
      'leave-credit-section-a',
      'leave-credit-section-b',
      'sectionA.title',
      'sectionB.title',
      'aWorkedDate',
      'bWorkedDate',
      'leave-credit-total-a',
      'leave-credit-total-b',
    ]) {
      expect(src, `${gone} must not be in the dialog any more`).not.toContain(gone);
    }
  });

  it('the trigger the employee already knows is still the only one, and it opens THAT dialog', () => {
    const dialog = read(DIALOG_TSX);
    expect(dialog).toContain('data-tour="replacement-leave-request"');
    expect(dialog).toContain("{t('trigger')}");
    const myLeave = read(MY_LEAVE);
    expect(myLeave).toContain('<ReplacementLeaveRequestDialog');
    // …and it posts through the SINGLE-TABLE action, not r336's two-section one.
    expect(myLeave).toContain('submitAction={submitLeaveCreditRequestAction}');
    expect(myLeave).toContain('dayFactsAction={leaveCreditDayFactsAction}');
    expect(myLeave).not.toContain('submitAction={submitReplacementLeaveRequestAction}');
    expect(myLeave).not.toContain('dayKindAction=');
    expect(myLeave).not.toContain('extendedHoursAction=');
  });

  it('the /leave/credit screen renders the SAME component, imported — never a second copy of the form', () => {
    const page = read(CREDIT_PAGE);
    expect(page).toContain("from '@/components/leave/leave-credit-request-table'");
    expect(page).toContain('<LeaveCreditRequestTable');
    // A second copy would mean a second <form>, a second dropdown or a second set of posted names here.
    expect(page).not.toContain('name="workedDate"');
    expect(page).not.toContain('<select');
    // Exactly one file in the product defines this form.
    const defining = ['components/leave/leave-credit-request-table.tsx', DIALOG_TSX, CREDIT_PAGE, MY_LEAVE].filter((f) =>
      read(f).includes('export function LeaveCreditRequestTable'),
    );
    expect(defining).toEqual(['components/leave/leave-credit-request-table.tsx']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (2c) WHAT THIS SCREEN SAYS IN SIX LOCALES — COUNTED, NOT ASSERTED AGAINST ITSELF.
//
// ⚠️ THE GUARD THIS REPLACES COULD NOT FAIL. The six-locale DOM test compares the rendered text with the
// same catalogue it feeds the provider, so it passes whatever the words are: overwrite zh's `dayKind.restDay`
// with "Rest day" and it stays green (the verifier proved exactly that). What can fail is a comparison
// between the CATALOGUES: a key that is meant to be translated must differ from English in all five
// non-English locales, and the keys that ship English must be a NAMED, FIXED set — so the English debt of
// this screen cannot grow by accident, and a key that is translated today fails the day it turns English.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r343 · the translated keys are translated, and the English ones are named and counted', () => {
  const SURFACE = [
    'components/leave/leave-credit-request-table.tsx',
    'components/leave/replacement-leave-request-dialog.tsx',
    'app/leave/credit/page.tsx',
  ];
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const CAT = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`)).replacementRequest as Record<string, unknown>]),
  ) as Record<(typeof LOCALES)[number], Record<string, unknown>>;
  const at = (locale: (typeof LOCALES)[number], key: string) =>
    key.split('.').reduce<unknown>((cur, part) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined), CAT[locale]);

  /** Every `replacementRequest` key the three files of this surface actually render, comments stripped. */
  const renderedKeys = () => {
    const out = new Set<string>();
    for (const f of SURFACE) {
      const code = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const m of code.matchAll(/\bt\('([^']+)'/g)) out.add(m[1]);
    }
    return [...out].sort();
  };

  /**
   * THE ENGLISH DEBT OF THIS SCREEN, NAMED. Nineteen keys read the same in all six catalogues: the eight
   * `table.*` keys r343 added, and eleven this form already rendered in English before it. They are listed
   * here so the number is a decision rather than an accident — the report for this round claimed the screen
   * "composed from existing translated keys", and for the four day-type LABELS that is true, but these
   * nineteen are English on the ms, ta, th, vi and zh screens and saying so is the honest half.
   */
  const ENGLISH_EVERYWHERE = [
    'addRow',
    'cancel',
    'days',
    'firstScheduleConsent',
    'leaveType',
    'reason',
    'removeRow',
    'table.dayTypeChoose',
    'table.help',
    'table.myRequests',
    'table.noRequests',
    'table.rosterMismatch',
    'table.statusHeading',
    'table.submittedOn',
    'table.windowNotClaimed',
    'totalDays',
    'unit',
    'unitDay',
    'workedDate',
  ];

  it('the keys that ship English are EXACTLY the nineteen named above — a twentieth fails this case', () => {
    const english = renderedKeys().filter((k) => {
      const en = at('en', k);
      return typeof en === 'string' && LOCALES.slice(1).every((l) => at(l, k) === en);
    });
    expect(english).toEqual(ENGLISH_EVERYWHERE);
  });

  it('every OTHER key this screen renders is genuinely different from English in all five locales', () => {
    const shouldBeTranslated = renderedKeys().filter((k) => !ENGLISH_EVERYWHERE.includes(k));
    // Non-vacuity: the four day-type labels and the ordinary-day refusal are in this set by construction.
    for (const k of ['dayKind.restDay', 'dayKind.offDay', 'dayKind.holiday', 'dayKind.workday', 'workingDayRefused'])
      expect(shouldBeTranslated, k).toContain(k);
    for (const k of shouldBeTranslated) {
      const en = at('en', k);
      expect(typeof en, k).toBe('string');
      for (const l of LOCALES.slice(1)) {
        const v = at(l, k);
        expect(typeof v, `${l}:${k}`).toBe('string');
        expect(v, `${l}:${k} is still the English string — a deep merge over en.json cannot be told from a translation at runtime`).not.toBe(en);
      }
    }
  });

  it('the fourth day type’s "earns nothing here" sentence is a TRANSLATED key, not a new English one', () => {
    // The Ordinary Day option is offered on every company (see the component header); what the switch
    // decides is what it earns. `workingDayRefused` says exactly that and exists translated in all six.
    expect(read(SURFACE[0])).toContain("t('workingDayRefused')");
    expect(at('en', 'workingDayRefused')).toBe('An ordinary working day cannot earn a credit.');
    for (const l of LOCALES.slice(1)) expect(at(l, 'workingDayRefused'), l).not.toBe(at('en', 'workingDayRefused'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (3) END TO END, AGAINST A REAL ROSTER.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
let b: Base;
let ctx: SessionContext;

const TODAY = todayInKualaLumpur();
const monthBefore = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};
const PERIOD = monthBefore(TODAY);
const weekdayIn = (isoWeekday: number, nth = 1) => {
  let seen = 0;
  for (let d = 1; d <= 28; d++) {
    const date = `${PERIOD}-${String(d).padStart(2, '0')}`;
    if ((new Date(`${date}T00:00:00Z`).getUTCDay() || 7) === isoWeekday && ++seen === nth) return date;
  }
  throw new Error('unreachable');
};
/** Wednesday: inside the Mon–Fri pattern, so an ordinary working day. */
const WORKDAY = weekdayIn(3);
/** Saturday: in the DEFAULT shift's OFF-day pattern (b8aa3466's four-way row) ⇒ the roster calls it an OFF
 *  day, which is neither the statutory rest day nor an ordinary working day. */
const OFF_DAY = weekdayIn(6);
/** Sunday, explicitly rostered as a rest day. */
const REST_DAY = weekdayIn(7);

const uniqEmail = () => `r343_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId: b.companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  employeeRequestEnabled: true,
  extendedHoursEnabled: true,
  extendedHalfDayMinutes: 240,
  extendedFullDayMinutes: 480,
  extendedBreakMinutes: 0,
  extendedGraceMinutes: 0,
  ...over,
});

/**
 * Mon–Fri 06:00–14:00 as the DEFAULT shift, with SATURDAY in the shift's own off-day pattern — the
 * `default-shift-rest` + `kind === 'off'` branch of `scheduleFor`, which is the only thing in this system
 * that produces `off_day` (core/attendance.ts:1009, workedDayKindForTx:3667). A Saturday left merely outside
 * the weekly pattern resolves as `rest_day`, which would have made the rest-day/off-day mix-up below
 * unreachable — so this line IS the fixture.
 */
async function hire() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Single Table Claimant', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 9000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  const shift = await createShift(a, {
    companyId: b.companyId,
    name: `Day ${Math.random().toString(36).slice(2, 7)}`,
    code: `D_${Math.random().toString(36).slice(2, 8)}`,
    startTime: '06:00:00',
    endTime: '14:00:00',
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
    offPattern: [6],
  });
  await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: shift.id });
  await setRestDay(a, { employmentId: e.employmentId, shiftDate: REST_DAY });
  await checkIn(a, { employmentId: e.employmentId, date: REST_DAY, time: '08:00:00' });
  await checkOut(a, { employmentId: e.employmentId, date: REST_DAY, time: '17:00:00' });
  await checkIn(a, { employmentId: e.employmentId, date: OFF_DAY, time: '08:00:00' });
  await checkOut(a, { employmentId: e.employmentId, date: OFF_DAY, time: '17:00:00' });
  // An ordinary working day with eight hours past the 14:00 shift end ⇒ a full day of extended-hours credit.
  await assignShift(a, { employmentId: e.employmentId, shiftDate: WORKDAY, shiftId: shift.id });
  await checkIn(a, { employmentId: e.employmentId, date: WORKDAY, time: '06:00:00' });
  await checkOut(a, { employmentId: e.employmentId, date: WORKDAY, time: '22:00:00' });
  return e.employmentId;
}

const claimLines = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.replacementLeaveRequestDate)
    .where(eq(schema.replacementLeaveRequestDate.subjectEmploymentId, employmentId))
    .orderBy(schema.replacementLeaveRequestDate.workedDate);

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'toil', 'active');
  ctx = await entitledCtx(b);
});

describe('r343 · the roster adjudicates the employee’s chosen Day Type', () => {
  it('the fixture roster really does hold three different kinds for the three dates', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const employmentId = await hire();
    const kinds = await leaveCreditRosterKinds(ctx, employmentId, [REST_DAY, OFF_DAY, WORKDAY]);
    expect(kinds.get(REST_DAY)).toBe('rest_day');
    expect(kinds.get(OFF_DAY)).toBe('off_day');
    expect(kinds.get(WORKDAY)).toBe('workday');
  });

  it('⚠️ a row typed "Rest Day" on a date the roster calls an OFF day is REFUSED, naming the off day', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const employmentId = await hire();
    await expect(
      submitLeaveCreditRequest(ctx, {
        employmentId,
        rows: [{ workedDate: OFF_DAY, dayType: 'rest_day', days: 1 }],
        today: TODAY,
      }),
    ).rejects.toThrow(LeaveCreditDayTypeMismatchError);
    await expect(
      submitLeaveCreditRequest(ctx, {
        employmentId,
        rows: [{ workedDate: OFF_DAY, dayType: 'rest_day', days: 1 }],
        today: TODAY,
      }),
    ).rejects.toThrow(/roster has Off day/);
    expect(await claimLines(employmentId)).toHaveLength(0);
  });

  it('THE VACUITY CONTROL — the layer below ACCEPTS the very same claim, so the refusal above is the only one', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const employmentId = await hire();
    // Identical row, posted the way r336's Section A posted it: the day type is not carried at all, so
    // nothing compares it with the roster. It succeeds, and it is stored as an OFF day the employee never
    // asked for. This is what `adjudicateDayTypes` exists to stop.
    const res = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: OFF_DAY, days: 1, sourceType: 'non_working_day' }],
      today: TODAY,
    });
    expect(res.totalDays).toBe(1);
    const lines = await claimLines(employmentId);
    expect(lines).toHaveLength(1);
    expect(lines[0].workedDayKind).toBe('off_day');
  });

  it('a row that agrees with the roster submits, and all four day types share one request and one total', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const employmentId = await hire();
    const res = await submitLeaveCreditRequest(ctx, {
      employmentId,
      rows: [
        { workedDate: REST_DAY, dayType: 'rest_day', days: 1 },
        { workedDate: OFF_DAY, dayType: 'off_day', days: 0.5 },
        { workedDate: WORKDAY, dayType: 'workday', claimStart: '14:00', claimEnd: '22:00' },
      ],
      today: TODAY,
    });
    // 1 + 0.5 + 1 (eight hours past the shift end is the full-day tier, capped at one day).
    expect(res.totalDays).toBe(2.5);
    const lines = await claimLines(employmentId);
    expect(lines).toHaveLength(3);
    const byDate = new Map(lines.map((l) => [l.workedDate, l]));
    expect(byDate.get(REST_DAY)!.sourceType).toBe('non_working_day');
    expect(byDate.get(OFF_DAY)!.workedDayKind).toBe('off_day');
    expect(byDate.get(WORKDAY)!.sourceType).toBe('extended_hours');
    expect(byDate.get(WORKDAY)!.eligibleMinutes).toBe(480);
  });

  it('an Ordinary Day row with no claimed window is refused BEFORE any roster read, naming the date', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const employmentId = await hire();
    await expect(
      submitLeaveCreditRequest(ctx, { employmentId, rows: [{ workedDate: WORKDAY, dayType: 'workday' }], today: TODAY }),
    ).rejects.toThrow(new RegExp(WORKDAY));
    await expect(
      submitLeaveCreditRequest(ctx, { employmentId, rows: [{ workedDate: WORKDAY, dayType: 'workday' }], today: TODAY }),
    ).rejects.toThrow(ReplacementRequestInvalidError);
  });

  it('a day type that is not one of the four is refused rather than treated as a fifth kind', async () => {
    await setToilPolicy(adminCtx(b), policy());
    const employmentId = await hire();
    await expect(
      submitLeaveCreditRequest(ctx, {
        employmentId,
        rows: [{ workedDate: REST_DAY, dayType: 'weekend' as unknown as LeaveCreditDayType, days: 1 }],
        today: TODAY,
      }),
    ).rejects.toThrow(/Choose a day type/);
  });
});
