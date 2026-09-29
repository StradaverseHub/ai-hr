/**
 * r343 · cbfa8b0b — THE LEAVE CREDIT REQUEST AS ONE TABLE. ⚠️ r360: THE DAY TYPE IS NO LONGER AN INPUT.
 *
 * The reporter's contest REVERSED the design r336 shipped: "Do not create separate sections/screens for
 * these day types. All four types must be submitted from the same screen and displayed in the same request
 * table", and the Day Type became a four-option dropdown the employee filled in, validated against their own
 * work calendar / roster.
 *
 * ⚠️⚠️ r360 REVERSED THE DROPDOWN AND PROMOTED THIS FILE. The reporter asked for the cell to be read-only
 * again (r336's design, but NOT by r336's argument — the roster check r343 added is what settles it: the
 * server refuses any day type that disagrees, so the dropdown offered a choice it would always refuse). The
 * screen can no longer be made to post a disagreeing row, which means EVERY assertion below about a refused
 * mismatch is now the ONLY place that refusal is pinned: the DOM guards in
 * test/r343-leave-credit-table.dom.test.tsx and test/r336-leave-credit-modal.dom.test.tsx say the mismatch is
 * unproducible from the screen and point here for the refusal itself. A posted form field is tamperable
 * whatever the screen renders, so this is not a hypothetical path — it is the only one left.
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
  flooredByScheduledShiftEnd,
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
describe('r343 · the four day types and the per-row conditional', () => {
  // r360 — was "the dropdown is exactly the reporter's four options, in the order they were listed". There is
  // no dropdown; the vocabulary is unchanged and is still what the cell's label function must cover and what
  // the column's enum must match, so the assertion stands and only the sentence around it moved.
  it('the vocabulary is exactly the reporter’s four day types, in the order they were listed', () => {
    expect([...LEAVE_CREDIT_DAY_TYPES]).toEqual(['rest_day', 'off_day', 'holiday', 'workday']);
  });

  /**
   * ⚠️ REVERSED IN r358 BY THE OWNER, IN WRITING. This case read "ONLY an ordinary day claims a time
   * window — the other three do not", and asserted `claimsTimeWindow(d) === false` for rest_day, off_day
   * and holiday. The owner's answer on 70294f7a: "Whether the employee works on a Normal Working Day,
   * Rest Day, Off Day, or Public Holiday, the Leave Credit calculation rule is the same … regardless of
   * the Day Type." So every type claims one, and what still differs per type moved to the case below.
   */
  it('EVERY day type claims a time window now — the declared 1-or-0.5 is gone', () => {
    for (const d of LEAVE_CREDIT_DAY_TYPES) expect(claimsTimeWindow(d), d).toBe(true);
  });

  it('the scheduled shift end floors the window on an ordinary day ONLY', () => {
    // The honest remainder of the rule reversed above, and the reason a rest-day claim counts the whole
    // entered window: there was no scheduled work for it to be "after".
    expect(flooredByScheduledShiftEnd('workday')).toBe(true);
    for (const d of ['rest_day', 'off_day', 'holiday'] as const) expect(flooredByScheduledShiftEnd(d), d).toBe(false);
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
    // ⚠️ r364 — COMMENTS ARE STRIPPED FIRST, and that is a correction rather than a convenience. These
    // are source-text counts, and they were run over the RAW file: a comment that merely NAMED the tag
    // it was guarding pushed the count to 2 and failed the case. It happened the first time anyone
    // wrote a comment explaining why the hidden inputs must sit inside a cell, because explaining it
    // requires saying where the parser would otherwise move them — to just before the table.
    //
    // A tag inside a comment is not a tag, exactly as a guard name inside a comment is not a call; the
    // same blind spot in test/function-access.test.ts was fixed for the opposite reason, where a
    // comment made an UNGUARDED page look guarded. Four other helpers in this very file already strip
    // before matching. Nothing is loosened: a real second <table> or <section> still fails.
    const src = read(TABLE_TSX)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect((src.match(/<table/g) ?? []).length, 'exactly one <table> in the request form').toBe(1);
    // r336's two sections were `<section data-testid="leave-credit-section-a|b">`. Neither may come back.
    expect(src).not.toContain('leave-credit-section-a');
    expect(src).not.toContain('leave-credit-section-b');
    expect(src).not.toContain('<section');
  });

  // r358 — FOUR values, not five: `days` is gone with the dropdown that fed it. The old list is quoted in
  // the constant below so the removal is visible rather than looking like a shortened assertion.
  it('every one of the four row values is posted from a HIDDEN input, so a disabled cell cannot shorten the zip', () => {
    const src = read(TABLE_TSX);
    // was ['workedDate', 'dayType', 'days', 'claimStart', 'claimEnd'] before r358
    for (const name of ['workedDate', 'dayType', 'claimStart', 'claimEnd']) {
      expect(src, name).toContain(`type="hidden" name="${name}"`);
    }
  });

  it('no visible date / time / select control carries a posted name — the row state is the only source', () => {
    const src = read(TABLE_TSX);
    // A `name=` on a control that can be disabled is the defect. The only named controls in the form are
    // the hidden row fields plus the three whole-form fields, none of which is ever disabled.
    const named = [...src.matchAll(/name="([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect([...new Set(named)].sort()).toEqual(
      // r358 — `days` left this set with the dropdown that posted it.
      ['claimEnd', 'claimStart', 'dayType', 'firstScheduleConsent', 'leaveTypeId', 'reason', 'workedDate'].sort(),
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
  it('each of the four row fields is posted EXACTLY ONCE, and that one occurrence is the hidden input', () => {
    const src = read(TABLE_TSX);
    // was ['workedDate', 'dayType', 'days', 'claimStart', 'claimEnd'] before r358
    for (const name of ['workedDate', 'dayType', 'claimStart', 'claimEnd']) {
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
    // r358 — `declaresDays` is gone with the days dropdown. What the chosen day type still drives is the
    // window's liveness and the two reference cells, so those are what this pins now.
    expect(src).not.toContain('declaresDays');
    expect(src).toContain('disabled={!windowLive}');
    expect(src).toContain('flooredByScheduledShiftEnd(chosen)');
    expect(src).toContain('const windowLive = wantsWindow && !ordinaryUnavailable;');
    expect(src).toContain('claimsTimeWindow');
  });

  /**
   * ⚠️⚠️ REVERSED IN r360, AND THE OLD ASSERTION IS QUOTED BECAUSE IT WAS EARNED.
   *
   * THE OLD CLAIM: `the dropdown is built from the WHOLE vocabulary — no company switch filters the option
   * list`, asserting `expect(src).toContain('const dayTypeOptions = LEAVE_CREDIT_DAY_TYPES;')` and
   * `expect(src).not.toMatch(/LEAVE_CREDIT_DAY_TYPES\s*\.\s*filter/)`. It existed because r343's first cut
   * DID filter, by a switch that is false on every company (migration 0486), so the reporter's "exactly four
   * options" would have rendered as three.
   *
   * r360 removed the control, and `dayTypeOptions` with it — keeping the line would have pinned dead code, and
   * a guard on dead code reads as protection while protecting nothing. What replaces it is the assertion the
   * old one could not make: THERE IS NO OPTION LIST AND NO CONTROL, in source, on the file that would have to
   * grow one. The requirement the old guard defended ("all four kinds reach the screen, whatever the company
   * has switched on") is pinned at runtime, per kind × per switch state, in
   * test/r343-leave-credit-table.dom.test.tsx; the vocabulary is pinned set-equal to `toil_worked_day_kind`
   * above, which is what still catches a fifth roster kind.
   */
  it('the Day Type is not a control at all — no select, no option, no change handler on that cell', () => {
    const src = read(TABLE_TSX);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(code, 'a <select> anywhere in this form is the dropdown coming back').not.toMatch(/<select/);
    expect(code, 'and an <option> is the same thing arriving in pieces').not.toMatch(/<option/);
    // The two writers r353 needed for a hand-made choice. Both are gone; a `chooseDayType` here again means
    // something can write the cell that is not the roster.
    expect(code).not.toContain('chooseDayType');
    expect(code).not.toContain('touchedDayType');
    // The cell and its caption, by testid, so the reporter's two halves are findable by test not by position.
    expect(src).toContain('data-testid="leave-credit-day-type"');
    expect(src).toContain('data-testid="leave-credit-day-type-source"');
    // What the extended-hours switch DOES decide, stated once: whether an Ordinary Day row earns anything.
    // r358 — the switch and the ladder came apart: `extendedHoursTiers == null` meant both "no ladder"
    // and "an ordinary day earns nothing", and every day type needs the ladder now.
    expect(src).toContain('const ordinaryEarnsNothing = !ordinaryDayAllowed;');
    expect(src).toContain('ordinaryUnavailableRows.length > 0');
  });

  /**
   * ⚠️ r360 — THE CELL MUST FOLLOW THE DATE, AND THIS IS THE SOURCE HALF OF A MEASURED DEFECT.
   *
   * 2466c3c9 removed the control but left r353's fill condition (`dayType === '' && !touchedDayType`), written
   * to protect a hand-made choice. With nothing able to make one, a re-dated row KEPT the first date's kind:
   * "Rest day / From your roster" over a date the roster calls a working day, the mismatch raised, the submit
   * disabled, and no control left to correct it. The runtime guard is in
   * test/r343-leave-credit-table.dom.test.tsx ("⚠️ RE-DATING a filled row re-asks the roster"); this pins the
   * one line that makes it true, because `patch(r.key, 'workedDate', …)` is the obvious thing to write here and
   * it is the defect.
   */
  it('changing the DATE clears the day type in the same update — the cell cannot outlive its date', () => {
    const src = read(TABLE_TSX);
    expect(src).toContain("{ ...x, workedDate: value, dayType: '' }");
    expect(src, 'the date input must go through it, not through the generic patch').toContain(
      'onChange={(e) => changeWorkedDate(r.key, e.target.value)}',
    );
    expect(src).not.toContain("patch(r.key, 'workedDate'");
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
// (2b2) ⚠️ r360 cbfa8b0b · THE FAILED LOOKUP, AND THE DEAD FORM FIELD THE ACTION WAS STILL READING.
//
// Two source shapes that no runtime assertion on this side of the wire can see. The first is the reported
// defect's mechanism; the second is a field that had been dead for two rounds and still read as live code.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r360 · the lookup failure is recorded, and the action reads no dead field', () => {
  const ACTIONS = 'app/leave/credit/actions.ts';

  /**
   * ⚠️ THE REPORTED DEFECT WAS AN ABSENT `.catch()`. The effect read
   * `void dayFactsAction(d).then((v) => setFacts(...))` — a rejected server action was swallowed, `facts[d]`
   * stayed null for ever (the date is marked as asked BEFORE the call, so it is never re-asked), and the row
   * showed a blank Day Type, a blank shift end and a blank clock-out with nothing to say why. The round trip is
   * pinned at runtime in test/r343-leave-credit-table.dom.test.tsx; this pins the shape, because `void p.then()`
   * with no catch is exactly what gets written back in and it is invisible to tsc, to the linter and to a render.
   */
  it('the day-facts fetch has a catch, and the retry clears the failed dates so the effect can re-ask', () => {
    const src = read(TABLE_TSX);
    expect(src, 'a rejection must be recorded, not swallowed').toMatch(/\.catch\(\(\) => setFactError/);
    // The state the catch writes and the cell reads. Without the first, the catch has nowhere to put the news.
    expect(src).toContain('const [factError, setFactError] = useState<Record<string, true>>({});');
    expect(src).toContain("t('table.dayTypeLookupFailed')");
    expect(src).toContain('data-testid="leave-credit-day-type-retry"');
    // ⚠️ AND THE RETRY MUST DELETE THE CACHED `facts` ENTRY. `d in facts` is the effect's own guard, so a retry
    // that only cleared `factError` would repaint the row and never ask the server again — the defect wearing
    // a control. `retryTick` is what makes a second failure re-runnable rather than a one-shot.
    expect(src).toMatch(/for \(const d of failed\) delete next\[d\];/);
    expect(src).toContain('setRetryTick((n) => n + 1);');
  });

  /**
   * ⚠️ `days` WAS STILL BEING READ OFF THE FORM, AND HAD BEEN DEAD SINCE r358.
   *
   * r358 removed the 1-or-0.5 picker: the field left the form and `days` left `LeaveCreditRowInput`. The action
   * went on doing `formData.getAll('days')` and assigning `days: … Number(days[i])` into each row, and TSC
   * PASSED — an object literal inside `.map()` is not "fresh" at the point the result is assigned to a typed
   * array, so excess-property checking never fires. (The same blind spot silently dropped a `workedDayKind`
   * added during r358 itself.) `getAll` on a form that emits no such input returns `[]`, so every row carried
   * `days: undefined` and nothing read it: inert, but it read as live code, and the next person to touch the
   * zip would have counted five row fields where the form posts four.
   *
   * §8 — when a defect lives in the contract between two files, pin it across both: the form's posted names
   * are pinned above, and this is the reader's end.
   */
  it('the action reads no `days` field — the form stopped posting one at r358 and tsc could not say so', () => {
    const src = read(ACTIONS);
    // ⚠️ COMMENTS STRIPPED FIRST, AND THIS IS NOT a formality: the note that records the removal quotes both
    // `getAll('days')` and `days: undefined`, so a source-text assertion made against the raw file would fail
    // on the very comment explaining why it passes. (The pack-drift ratchet reads comments for the opposite
    // reason; here they are prose about the past.)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'the dead read').not.toMatch(/getAll\('days'\)/);
    expect(code, 'and the dead assignment into the row').not.toMatch(/\bdays\s*:/);
    // NON-VACUITY: the four fields it DOES read, so this cannot pass on a file that reads nothing at all.
    for (const name of ['workedDate', 'dayType', 'claimStart', 'claimEnd']) {
      expect(code, `${name} is still read`).toContain(`getAll('${name}')`);
    }
    // …and the whole-form field, which is `get` not `getAll`.
    expect(code).toContain("get('leaveTypeId')");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (2b3) ⚠️ r362 · THE TWO SOURCE SHAPES THIS ROUND TURNS ON, NEITHER OF THEM VISIBLE AT RUNTIME.
//
// 5c72039e: a retired key is only retired if NOTHING renders it and it is STILL in every catalogue — two
// claims a DOM test cannot make (it can only see what one render happened to paint). 58424c7f: the
// night-shift note must come from the roll's OWN condition, and "it agrees today" is what a second parse
// also does; what has to be pinned is that there is no second parse.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r362 · the retired placeholder, the settled record, and the note that reads the roll', () => {
  const LOCALES6 = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const stripped = (rel: string) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  /**
   * ⚠️ RETIRED, NEVER DELETED (CLAUDE.md §8). `table.dayTypeChoose` was the read-only cell's "not known
   * yet" text and it said "Choose a day type" — an instruction to use a control r360 removed, with nothing
   * in the box to click. Deleting the key would be the other error: a catalogue key is a value, and a
   * deletion propagates through a naive locale merge as a resurrection or a MISSING_MESSAGE somewhere
   * nobody looked. So BOTH halves are asserted, and they fail for opposite mistakes.
   */
  it('`table.dayTypeChoose` is rendered by nothing, and still present in all six catalogues', () => {
    for (const f of ['components/leave/leave-credit-request-table.tsx', 'components/leave/replacement-leave-request-dialog.tsx', 'app/leave/credit/page.tsx'])
      expect(stripped(f), `${f} must not render the retired placeholder`).not.toContain("t('table.dayTypeChoose')");
    for (const l of LOCALES6) {
      const v = (JSON.parse(read(`messages/${l}.json`)).replacementRequest as any).table.dayTypeChoose;
      expect(typeof v, `${l} lost the retired key — retired is not deleted`).toBe('string');
    }
  });

  /**
   * ⚠️ THE THIRD RECORD IS THE ROUND, AND NEW COPY WITHOUT IT WOULD HAVE BEEN A LIE IN NEW WORDS.
   *
   * `facts[d]` is written `null` BEFORE the call (so a re-render mid-flight does not re-ask) and
   * `leaveCreditDayFactsAction` ALSO resolves `null` for a malformed date or no employment. "Asked, still
   * in flight" and "answered with nothing" were therefore the same stored value, and no wording can tell
   * them apart from it. `factsSettled` written in the settle path is what separates them; without the
   * clear on retry, a retried date would read "Not found — pick the date again" while it was being asked
   * again. Both halves pinned here, because a component that dropped either still compiles and still
   * renders something plausible.
   */
  it('a second record settles a date in BOTH directions, and the retry un-settles it', () => {
    const code = stripped(TABLE_TSX);
    expect(code).toContain('const [factsSettled, setFactsSettled] = useState<Record<string, true>>({});');
    // Settled however it ended: `.finally` is the one place a resolve-with-null and a reject are one event.
    expect(code, 'the settle must cover the rejection too, or a failed date reads "reading" for ever').toMatch(
      /\.finally\(\(\) => setFactsSettled/,
    );
    // …and the cell reads "in facts, not settled" rather than guessing from a timer.
    expect(code).toContain('r.workedDate in factsSettled');
    expect(code, 'no timer may stand in for the server having answered').not.toMatch(/setTimeout|Date\.now\(\)/);
    // The retry path drops the settled mark with the cached facts entry.
    const retry = code.slice(code.indexOf('const retryFacts'), code.indexOf('const retryFacts') + 900);
    expect(retry, 'retryFacts must un-settle the dates it re-asks').toContain('setFactsSettled((prev) => {');
  });

  /**
   * ⚠️ 58424c7f · ONE COMPARISON, AND THE COLOUR IS PART OF THE CLAIM.
   *
   * The reporter asked for an end-before-start REFUSAL; it is deliberately not built, because that is how a
   * shift across midnight is entered and refusing it would take r353's `<`-not-`<=` money fix with it. The
   * note that lands instead must read the SAME condition the roll rolls on — a second `split(':')` in the
   * component would agree today and disagree the first time either moved — and it must be MUTED: the amber
   * clock-out warning and the destructive-red refusal row are both beside it, and either colour would teach
   * employees that a correctly entered night shift is a problem.
   */
  it('the cross-midnight note reads `claimCrossesMidnight`, is muted, and refuses nothing', () => {
    const code = stripped(TABLE_TSX);
    expect(code, 'the roll’s own condition, imported').toContain('claimCrossesMidnight');
    expect(code, 'and NOT a second parse of the two times in the component').not.toMatch(/claimStart\.split|claimEnd\.split/);
    // The note's OWN element, not a window of source around it — the amber warning is a few lines up and a
    // sloppy slice would pass or fail on how the file happens to be laid out.
    const el = code.match(/className="([^"]*)"\s+data-testid="leave-credit-crosses-midnight"/);
    expect(el, 'the note must exist, with its class on the same element').not.toBeNull();
    const cls = el![1];
    expect(cls, `muted, not amber — an amber note teaches that a night shift is a problem (got "${cls}")`).not.toMatch(/amber/);
    expect(cls, `muted, not destructive red (got "${cls}")`).not.toMatch(/destructive/);
    expect(cls, `the note is muted (got "${cls}")`).toMatch(/text-muted-foreground/);
    // It is a NOTE: the note's condition may not reach the list of things that stop the submit.
    const blocked = code.slice(code.indexOf('const blocked ='), code.indexOf('const blocked =') + 300);
    expect(blocked, 'nothing new is refused').not.toMatch(/crossesMidnight/i);
  });

  /**
   * AND THE ROLL ITSELF IS UNTOUCHED — the half of this item that is a promise rather than a change.
   * `claimCrossesMidnight` is `end0 < start` on `timeToMinutes`, and `assessExtendedClaim` asks it instead
   * of re-spelling it. 18:00→18:00 must stay OUT of the cross-midnight set: that is the `<=`→`<` fix r353
   * hand-made after a zero-length window rolled to 1440 minutes and, through the tier ladder, a full day of
   * credit. The arithmetic is asserted by execution in test/r336-leave-credit-request-screen.test.ts; this
   * is the source shape, because "it happens to agree" is what a divergent copy also does.
   */
  it('`assessExtendedClaim` asks the predicate rather than re-spelling the roll', () => {
    const lib = stripped('lib/extended-hours.ts');
    expect(lib).toContain('export function claimCrossesMidnight(');
    expect(lib).toContain('const end = claimCrossesMidnight(p.claimStart, p.claimEnd) ? end0 + 1440 : end0;');
    // The old inline form must be GONE, or there are two conditions again and only one of them is exported.
    expect(lib, 'exactly one comparison decides the roll').not.toMatch(/const end = end0 < start \?/);
    // And the predicate is strict: `<=` here is the money defect r353 removed.
    expect(lib).not.toMatch(/return end0 <= start;/);
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
   * THE ENGLISH DEBT OF THIS SCREEN, NAMED. The keys listed here read the same in all six catalogues, so
   * the number is a decision rather than an accident — the report for r343 claimed the screen was
   * "composed from existing translated keys", and for the four day-type LABELS that is true, but these are
   * English on the ms, ta, th, vi and zh screens and saying so is the honest half.
   *
   * ⚠️ THE ARITHMETIC IN THIS COMMENT HAD BEEN WRONG SINCE r358 AND r362 IS CORRECTING IT RATHER THAN
   * INHERITING IT (CLAUDE.md §8 — prose outlives the kernel). It read: "Nineteen keys … the eight `table.*`
   * keys r343 added, and eleven this form already rendered in English before it", then "r358 — EIGHTEEN,
   * not nineteen: `days` was the column header over the 1-or-0.5 dropdown, and both are gone". But the same
   * round also took `table.help` and `table.windowNotClaimed` out (the note inside the list says so), which
   * left SIXTEEN entries under a comment claiming eighteen. The LIST was always right and the case title
   * always matched it; only the running total above drifted. `days` is still NOT retired in the catalogues
   * — it is a generic label other leave surfaces render — what changed is that this screen stopped
   * reaching for it.
   */
  // r362 5c72039e — FIFTEEN. `table.dayTypeChoose` ("Choose a day type") is RETIRED: it was the read-only
  // cell's "not known yet" text and it told the employee to make a choice the cell has not permitted since
  // r360. The key stays in all six catalogues — retired, never deleted — it is simply no longer rendered,
  // so `renderedKeys()` cannot see it and it may not sit on a list of keys this screen RENDERS in English.
  const ENGLISH_EVERYWHERE = [
    'addRow',
    'cancel',
    'firstScheduleConsent',
    'leaveType',
    'reason',
    'removeRow',
    // r358 — `table.help` and `table.windowNotClaimed` LEFT this list, and that is a gain rather than a
    // loss: both had to be rewritten for the owner's new rule, and both were translated into all six
    // locales while they were being rewritten. A key leaving the English-everywhere set is the set doing
    // its job — it exists to make the English-only count a decision rather than an accident.
    'table.myRequests',
    'table.noRequests',
    'table.rosterMismatch',
    'table.statusHeading',
    'table.submittedOn',
    'totalDays',
    'unit',
    'unitDay',
    'workedDate',
  ];

  // r362 — the title said "the sixteen … a seventeenth", which was true of the list as it stood. Retiring
  // `table.dayTypeChoose` takes it to fifteen. The number is in the title on purpose: it is the one place a
  // reader sees the size of the debt without counting, so it moves with the list.
  it('the keys that ship English are EXACTLY the fifteen named above — a sixteenth fails this case', () => {
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
    // ⚠️ r360's four new keys are named here rather than left to the filter to notice. They are TRANSLATED in
    // all six catalogues, which is a decision: `table.dayTypeChoose` used to sit beside them English
    // everywhere, so a new `table.*` key on this screen going either way has to be argued, not defaulted.
    // Naming them also means a key quietly dropped from the component fails this case instead of silently
    // leaving the set — which is the whole reason to name r362's three as well.
    //
    // ⚠️ r362's THREE, and the argument for each. `dayTypeReading` and `dayTypeNotFound` (5c72039e) REPLACE
    // `table.dayTypeChoose` in two of the three states it was covering, and replacing an English-everywhere
    // key with two more English-everywhere keys would have paid the reporter's copy complaint while leaving
    // five locales reading English — so they are translated. `crossesMidnight` (58424c7f) is the night-shift
    // note, and an employee reading a Tamil screen is exactly who needs to be told how their window was
    // read. The filter below would catch an English copy anyway; naming them is what catches the OTHER
    // failure, a key that stops being rendered and quietly leaves the set with nothing going red.
    for (const k of [
      'table.dayTypeLookupFailed',
      'table.dayTypeRetry',
      'table.dayTypeFromRoster',
      'table.dayTypeFromHolidays',
      'table.dayTypeReading',
      'table.dayTypeNotFound',
      'table.crossesMidnight',
    ])
      expect(shouldBeTranslated, `${k} must be rendered by this surface AND translated`).toContain(k);
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
// (2d) ⚠️ r353 cbfa8b0b · THE APPROVER'S HALF OF THE REVERSAL.
//
// The owner removed the clock-out clip and the measured cap from `eligibleExtendedMinutes`, so the only
// thing standing between a typed window and a banked credit — which blocks overtime pay for the same hours
// and converts to cash on expiry — is the line manager reading the approvals queue. A warning nobody drew,
// or one drawn from a SECOND derivation that disagrees with the employee's own screen, would make that
// hand-over a fiction. Neither is visible at runtime from a server component, so both are pinned here as a
// source shape, the way (2b) pins the wiring between files.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r353 · the approvals queue warns, from the SAME computation the employee’s screen used', () => {
  const APPROVALS = 'app/approvals/page.tsx';
  const TABLE = 'components/leave/leave-credit-request-table.tsx';

  it('ONE computation: both surfaces call assessExtendedClaim, and neither re-derives the discrepancy', () => {
    for (const f of [APPROVALS, TABLE]) {
      expect(read(f), `${f} must read the shared assessment`).toContain('assessExtendedClaim(');
      expect(read(f), `${f} must import it rather than copy it`).toMatch(/from '@\/lib\/extended-hours'/);
    }
    // A hand-rolled comparison of the two times on either surface is the second derivation this forbids.
    for (const f of [APPROVALS, TABLE]) {
      expect(read(f), `${f}: the discrepancy is returned, never recomputed`).not.toMatch(/claimEnd\s*>\s*clockOut/);
    }
  });

  it('the approver is shown the absence as well as the time — the clock-out is no longer printed only when present', () => {
    const src = read(APPROVALS);
    // Before r353 the row rendered nothing at all when `actualClockOut` was NULL, so "no clock-out behind
    // this claim" and "an approver who has not looked" were the same row.
    expect(src).toContain("t('creditClockOutNone')");
    expect(src).not.toContain("{d.actualClockOut ? ` · ${t('creditClockOut')}");
  });

  it('both warnings exist, are amber, and are findable by test rather than by position', () => {
    const src = read(APPROVALS);
    expect(src).toContain("data-testid=\"approval-credit-clock-out-warning\"");
    expect(src).toContain("t('creditWarnPastClockOut'");
    expect(src).toContain("t('creditWarnNoClockOut'");
    // ⚠️ VISIBILITY IS THE REQUIREMENT, not the mention. A control this loosens must not be handed over in
    // the same muted grey as the rest of the line.
    expect(src).toMatch(/border-amber-300[^"]*bg-amber-50/);
    expect(src).toMatch(/dark:border-amber-700/);
  });

  it('the three approver strings are translated in all six locales, not English six times', () => {
    const keys = ['creditClockOutNone', 'creditWarnPastClockOut', 'creditWarnNoClockOut'] as const;
    const cat = Object.fromEntries(
      ['en', 'ms', 'ta', 'th', 'vi', 'zh'].map((l) => [l, JSON.parse(read(`messages/${l}.json`)).approvals as Record<string, string>]),
    ) as Record<string, Record<string, string>>;
    for (const k of keys) {
      expect(typeof cat.en[k], k).toBe('string');
      for (const l of ['ms', 'ta', 'th', 'vi', 'zh']) {
        expect(typeof cat[l][k], `${l}:${k}`).toBe('string');
        expect(cat[l][k], `${l}:${k} is still the English string`).not.toBe(cat.en[k]);
      }
    }
    // The two placeholders the warning is useless without.
    expect(cat.en.creditWarnPastClockOut).toContain('{claimEnd}');
    expect(cat.en.creditWarnPastClockOut).toContain('{clockOut}');
    expect(cat.en.creditWarnNoClockOut).toContain('{date}');
  });

  it('⚠️ the kernel keeps no ceiling of its own: neither caller re-applies one after the shared call', () => {
    // CLAUDE.md §8 — when a defect lives in the contract between files, pin it across both. The plan's third
    // point was exactly this question, and "it inherits the new basis" is only true while nothing local
    // narrows the answer afterwards.
    for (const f of ['core/replacement-request.ts', 'core/toil.ts']) {
      const src = read(f);
      expect(src, `${f} must not pass a measured cap into the shared function any more`).not.toMatch(
        // `[^)]` stops the scan at the end of the call's own argument object: a later mention of the
        // measured figure elsewhere in the file is not this call passing it.
        /eligibleExtendedMinutes\(\{[^)]*?measuredExtendedMinutes/,
      );
      expect(src, `${f} must not clamp the returned minutes`).not.toMatch(
        /Math\.min\([^)]*(eligibleMinutes|measuredExtendedMinutes)/,
      );
    }
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
        rows: [{ workedDate: OFF_DAY, dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' }],
        today: TODAY,
      }),
    ).rejects.toThrow(LeaveCreditDayTypeMismatchError);
    await expect(
      submitLeaveCreditRequest(ctx, {
        employmentId,
        rows: [{ workedDate: OFF_DAY, dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' }],
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
        // r358 — a window, not a declared figure: eight hours is the full-day tier, four is the half.
        { workedDate: REST_DAY, dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' },
        { workedDate: OFF_DAY, dayType: 'off_day', claimStart: '09:00', claimEnd: '13:00' },
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
        rows: [{ workedDate: REST_DAY, dayType: 'weekend' as unknown as LeaveCreditDayType, claimStart: '09:00', claimEnd: '17:00' }],
        today: TODAY,
      }),
    ).rejects.toThrow(/Choose a day type/);
  });
});
