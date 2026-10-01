/**
 * ce5ded11 (r362) · APPLY OT PLAN, CALENDAR-FIRST — what the two Plan OT screens must and must not carry.
 *
 * A source-static guard, in the house style of test/attendance-screens-layout.test.ts, because most of
 * what this round promised is a property of the SCREEN and of the CONTRACT BETWEEN TWO FILES, neither of
 * which a database test can see. tsc, next build and the whole suite were green on the JavaScript-off
 * defect this round fixes for as long as it existed.
 *
 * WHAT IS PINNED, and why each one:
 *
 *  A. The calendar is mounted, on BOTH screens, and it is the SAME component — the reason it exists is
 *     that the Apply screen and the Self Overtime list must not grow two month grids that disagree.
 *  B. THE REFUSALS. The approved plan lists what this round deliberately does not build, each for an
 *     evidenced reason: Draft / Resubmit, a second overtime period, the 2100- / 0300+ notation (ordinary overnight HH:mm is now supported), a
 *     configurable ceiling, a configurable long-plan threshold, Day Type and Actual Hours columns on the
 *     list, bulk OT planning, a second OT REST writer. Private clock/photo routes are separate. Each of those is a refusal we owe the reporter, and a refusal that
 *     nothing holds in place is an oversight waiting to be "fixed" by the next round.
 *  C. THE FOUR STATUSES AND NO FIFTH. The calendar's dots are keyed by the stored enum, so a Draft dot
 *     cannot appear without a migration and a decision.
 *  D. EVERY COLOUR CARRIES TEXT. Four shades plus a dashed outline is five states nobody can be expected
 *     to tell apart by colour; each has a label key and each cell renders the word.
 *  E. THE TWO PANELS THAT WENT. The blue "kind of day" panel moved INTO the day card and the green
 *     "both of these warn you" explainer was removed as a correction (it held no warnings). Their keys
 *     are RETIRED, not deleted, in all six catalogues.
 *  F. THE CONTRACT BETWEEN THE FORM AND THE ACTION. Integer minutes ride in a hidden field the island fills in;
 *     when it arrives blank the action derives them from the strict window, including overnight. Neither half is any use alone, so
 *     both are pinned here and the service's side of it in test/ot-plan-calendar.test.ts §5.
 *  G. THE DYNAMIC KEYS. Three of this screen's label maps are resolved as `t(MAP[value])`, which
 *     test/i18n-coverage.test.ts Check C cannot see. Every one of them is resolved here, in all six
 *     catalogues, against the value sets that can actually reach them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attendanceCorrectionStatusEnum } from '../db/schema';
import { formatMinutesToHM, plannedOvertimeMinutes } from '../lib/overtime-duration';

const root = (p: string) => path.resolve(__dirname, '..', p);
const read = (p: string) => fs.readFileSync(root(p), 'utf8');

const APPLY = read('app/attendance/plan-ot/apply/page.tsx');
const FIELDS = read('app/attendance/plan-ot/apply/plan-ot-fields.tsx');
const LIST = read('app/attendance/plan-ot/page.tsx');
const CAL = read('components/ot-plan-calendar.tsx');
const ACTIONS = read('app/me/actions.ts');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const MESSAGES: Record<string, { me: Record<string, string> }> = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`)) as { me: Record<string, string> }]),
);

/** Source with comments removed. A guard that reads a comment proves what somebody wrote, not what ships. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every locale carries the key, and none of them carries an empty string for it. */
function keyEverywhere(key: string) {
  for (const l of LOCALES) {
    const v = MESSAGES[l].me[key];
    expect(typeof v === 'string' && v.trim() !== '', `me.${key} missing or blank in ${l}.json`).toBe(true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('A · one calendar, mounted on both Plan OT screens', () => {
  it('Apply OT Plan renders the month grid and keeps the overtime form bound to the one action', () => {
    expect(APPLY).toContain('<OtPlanCalendar');
    expect(APPLY).toContain("from '@/components/ot-plan-calendar'");
    expect(APPLY).toContain('action={myRequestOvertime}');
    // The day panel and the summary card are the other two things the plan promised on this screen.
    expect(APPLY).toContain("t('otCalThisMonth')");
    expect(APPLY).toContain("t('otCalActuallyClocked')");
  });

  it('the Self Overtime list offers the SAME component behind a Table / Calendar switch', () => {
    expect(LIST).toContain('<OtPlanCalendar');
    expect(LIST).toContain("from '@/components/ot-plan-calendar'");
    expect(LIST).toContain("t('otViewTable')");
    expect(LIST).toContain("t('otViewCalendar')");
    // A second grid written for the list is the failure this component exists to prevent.
    expect(code(LIST).includes('grid-cols-7'), 'the list must not grow a month grid of its own').toBe(false);
    expect(code(APPLY).includes('grid-cols-7'), 'nor must the apply screen').toBe(false);
  });

  it('the calendar resolves its month maths through lib/roster-month, not its own copy', () => {
    // The whole reason the shared module exists: the OT calendar and the duty roster must not disagree
    // about which dates a month contains or which weekday one falls on.
    expect(CAL).toContain("from '@/lib/roster-month'");
    expect(CAL).toContain('monthDates(month)');
    expect(CAL).toContain('isoWeekdayOf(first)');
  });

  it('the dates are real links, so the grid works with scripting off and with the keyboard', () => {
    expect(CAL).toContain('<Link');
    expect(CAL).toContain('data-otcal-date={iso}');
    expect(CAL).toContain("aria-current={isSelected ? 'date' : undefined}");
    // Arrow keys are an ADDITION to tab order, never a replacement for it.
    expect(CAL).toContain('onKeyDown');
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) expect(CAL).toContain(k);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B · the refusals the approved plan owes the reporter', () => {
  const SURFACE = [code(APPLY), code(FIELDS), code(LIST), code(CAL)].join('\n').toLowerCase();

  it('no Draft and no Resubmit — the stored status vocabulary has four values and this round adds none', () => {
    for (const word of ['draft', 'resubmit']) {
      expect(SURFACE.includes(word), `"${word}" is not a status this system has`).toBe(false);
    }
  });

  it('no second overtime period — one pending request per (employment, date) is a database index', () => {
    for (const marker of ['ot 1', 'ot 2', 'ot1', 'ot2', 'add another ot', 'second ot period']) {
      expect(SURFACE.includes(marker), `"${marker}" would promise a second plan the index forbids`).toBe(false);
    }
  });

  it('no special cross-midnight notation — strict HH:mm supports approved overnight plans', () => {
    expect(SURFACE.includes('2100-')).toBe(false);
    expect(SURFACE.includes('0300+')).toBe(false);
    expect(FIELDS).toContain('plannedOvertimeMinutes(startValue, end)');
    expect(plannedOvertimeMinutes('22:00', '01:30')).toBe(210);
    expect(plannedOvertimeMinutes('21:00', '18:00')).toBe(1260);
    expect(plannedOvertimeMinutes('21:00', '21:00')).toBeNull();
    expect(plannedOvertimeMinutes('2100-', '0300+')).toBeNull();
  });

  it('no bulk / multi-date OT planning or second OT request route; private clock routes stay separate', () => {
    for (const marker of ['bulk', 'multi-date', 'multiselect']) {
      expect(SURFACE.includes(marker), `"${marker}" is the reporter's own later phase`).toBe(false);
    }
    expect(code(FIELDS)).not.toContain('/api/attendance');
    expect(fs.readdirSync(root('app/api/attendance')).sort()).toEqual(['clock', 'photo', 'today']);
    const photoRoute = read('app/api/attendance/photo/[id]/route.ts');
    expect(photoRoute).toContain('clockApiSession');
    expect(photoRoute).toContain('clockCapturePhoto');
    expect(photoRoute).toContain('no-store');
    expect(photoRoute).not.toContain('requestAttendanceCorrection');
  });

  it('the 104-hour ceiling and the long-plan threshold stay where they are', () => {
    // The ceiling is read from the service's own figure, never restated as a literal on the screen…
    expect(APPLY).toContain('cap.capMinutes');
    expect(FIELDS).toContain('capMinutes');
    expect(/\b104\b/.test(code(APPLY) + code(FIELDS) + code(LIST)), 'no hardcoded 104 on the screen').toBe(false);
    // …and there is no setting for either of them here.
    expect(SURFACE.includes('capsetting')).toBe(false);
    expect(SURFACE.includes('longplan')).toBe(false);
  });

  it('the Self Overtime list gains Approved hours and NOT Day Type or Actual Hours', () => {
    expect(LIST).toContain("t('otApprovedHoursColumn')");
    expect(LIST).toContain('p.approvedOtMinutes != null');
    // Day type is one scheduling resolution per row and actual hours one attendance lookup per row, on a
    // list of up to a hundred plans across arbitrary months.
    const listCode = code(LIST);
    expect(listCode.includes('otCalWorkingDay'), 'no per-row day type on the list').toBe(false);
    expect(listCode.includes('attendanceForEmploymentRange'), 'no per-row attendance lookup on the list').toBe(false);
    // The calendar's two extra reads are paid for only when the calendar is the view on screen.
    expect(LIST).toContain('isCalendar ? otPlanCalendarMonth(s, me.employmentId, month) : Promise.resolve([])');
  });

  it('the warnings still only warn — nothing on either screen disables Submit', () => {
    for (const [name, src] of [
      ['apply', code(APPLY)],
      ['fields', code(FIELDS)],
    ] as const) {
      expect(/\bdisabled\b/.test(src), `${name}: a genuine month-end must still be submittable`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('C · exactly the four statuses the database has', () => {
  it('the calendar’s dot vocabulary IS the stored enum', () => {
    const t = CAL.match(/export type OtCalendarPlanStatus =([^;]*);/);
    expect(t, 'OtCalendarPlanStatus must stay a plain literal union this guard can read').not.toBeNull();
    const offered = [...t![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(offered).toEqual([...attendanceCorrectionStatusEnum.enumValues]);
    // Both maps are keyed by the union, so a status added without a colour or without a word is a type
    // error rather than a silently grey, silently unlabelled dot.
    expect(CAL).toContain('const PLAN_DOT: Record<OtCalendarPlanStatus, string>');
    expect(CAL).toContain('const PLAN_LABEL_KEY: Record<OtCalendarPlanStatus, string>');
  });

  it('`cancelled` still reads "Withdrawn" on an overtime row, on the grid as well as in the table', () => {
    expect(MESSAGES.en.me.otCalPlanWithdrawn).toBe('Withdrawn');
    expect(MESSAGES.en.me.otStatusWithdrawn).toBe('Withdrawn');
    expect(LIST).toContain('statusLabel(p.status, t, true)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('D · every colour also carries text', () => {
  it('each day shade has a word, and each cell renders it', () => {
    const t = CAL.match(/export type OtCalendarKind =([^;]*);/);
    expect(t).not.toBeNull();
    const kinds = [...t![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(kinds).toEqual(['workday', 'rest_day', 'off_day', 'holiday']);
    expect(CAL).toContain('const KIND_CLS: Record<OtCalendarKind, string>');
    expect(CAL).toContain('const KIND_LABEL_KEY: Record<OtCalendarKind, string>');
    // The word is in the cell itself, not only in the legend: a legend is a second place to look.
    expect(CAL).toContain('<span className="sr-only">{kindLabel}</span>');
    expect(CAL).toContain('aria-label={[iso, kindLabel');
    // …and the outline state is named too, because "no roster entry" is the one state with no fill.
    expect(CAL).toContain("t('otCalNoRosterEntry')");
  });

  it('the ‹ › month steppers are named for a screen reader', () => {
    expect(CAL).toContain("aria-label={t('otCalPreviousMonth')}");
    expect(CAL).toContain("aria-label={t('otCalNextMonth')}");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('E · the two right-hand panels, and what happened to their keys', () => {
  it('the blue "kind of day" panel and the green explainer are off the screen', () => {
    for (const key of ['otDayTypeHeading', 'otDayTypeOrdinary', 'otDayTypeRestDay', 'otDayTypeHoliday', 'otWarnNotBlockHeading', 'otWarnNotBlockBody']) {
      expect(code(APPLY).includes(key), `${key} must no longer be rendered on Apply OT Plan`).toBe(false);
    }
    // The sentence they carried is now the day card's chip plus its From line — ONE place answering
    // "what kind of day is this", which is what the reporter asked for.
    expect(APPLY).toContain('KIND_LABEL[day.kind]');
    expect(APPLY).toContain("t('otCalFrom')");
  });

  it('their keys are RETIRED, not deleted — every catalogue still carries them', () => {
    for (const key of ['otDayTypeHeading', 'otDayTypeOrdinary', 'otDayTypeRestDay', 'otDayTypeHoliday', 'otWarnNotBlockHeading', 'otWarnNotBlockBody', 'otNothingSavedUntilSubmit', 'otDateOpensTomorrow']) {
      keyEverywhere(key);
    }
  });

  it('the standing "you already have an approved plan" sentence is still never rendered unguarded', () => {
    // It used to tell a brand-new employee they had something to withdraw. What replaced it is a query
    // result: the day card lists the plans that actually exist for the selected date.
    expect(code(APPLY).includes('otAlreadyApprovedForDate')).toBe(false);
    keyEverywhere('otAlreadyApprovedForDate');
    expect(APPLY).toContain('plansOnDate.length > 0');
    expect(APPLY).toContain('monthPlans.filter((p) => p.attendanceDate === date)');
  });

  it('ec30b2e9 (r364) — the refusal the ErrorBanner prints comes from the CATALOGUE, in two dated flavours', () => {
    // THE CLAIM THIS REPLACES, which stood in a comment on APPLY and was half wrong:
    //   "The key me.otAlreadyApprovedForDate is kept for that path".
    // It was not kept for that path — it names no date, and the action needs one. There are now TWO
    // refusals, they read differently because the way out of each differs, and both are resolved in
    // app/me/actions.ts where the typed error is caught. me.otAlreadyApprovedForDate is RETIRED, not
    // deleted (asserted above), and this screen must still never render it.
    for (const key of ['otPlanApprovedNotCounted', 'otAlreadyCountedForDate']) {
      keyEverywhere(key);
      for (const l of LOCALES) {
        expect(MESSAGES[l].me[key], `me.${key} must interpolate the date in ${l}.json`).toContain('{date}');
      }
    }
    // Statically resolvable keys — a computed t(`me.${x}`) is invisible to test/i18n-coverage.test.ts.
    expect(code(ACTIONS)).toContain("t('otPlanApprovedNotCounted', { date: e.date })");
    expect(code(ACTIONS)).toContain("t('otAlreadyCountedForDate', { date: e.date })");
    // And the localizer runs BEFORE the one refusal redirect rather than adding a second one — the
    // redirect count and the date-carrying rule are pinned by §F below.
    expect(code(ACTIONS)).toContain('const msg = await localizeOvertimeRequestError(e);');
  });

  it('the footer no longer promises the superior is told "the moment" it arrives', () => {
    // Notifications materialise when dispatchNotifications runs, which is triggered on an ADMIN page
    // load — so "the moment it arrives" is optimistic. The replacement sentence says "when it arrives".
    expect(APPLY).toContain("t('otStaysOnCalendarHelp')");
    expect(MESSAGES.en.me.otStaysOnCalendarHelp.includes('the moment')).toBe(false);
    expect(MESSAGES.en.me.otStaysOnCalendarHelp).toContain('when it arrives');
    expect(MESSAGES.en.me.otStaysOnCalendarHelp).toContain('You stay on this calendar afterwards.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('F · the contract between the form and the server action', () => {
  it('the form still posts exactly the field names the action reads', () => {
    for (const name of ['date', 'plannedStart', 'plannedEnd', 'otMinutes']) {
      expect(FIELDS.includes(`name="${name}"`), `the island must keep posting ${name}`).toBe(true);
    }
    expect(FIELDS).not.toContain('name="otHours"');
    expect(FIELDS).not.toContain('name="otReasonCategory"');
    expect(APPLY).toContain('name="reason"');
    // The date is no longer typed — the calendar picks it — so it rides as a hidden field.
    expect(FIELDS).toContain('<input type="hidden" name="date" value={date} />');
    expect(code(FIELDS).includes('type="date"'), 'the plain date box is gone').toBe(false);
  });

  it('Remarks and Attachment are offered, and the action posts both', () => {
    expect(APPLY).toContain('name="remark"');
    expect(APPLY).toContain('name="attachment"');
    // A multipart form: a server action parses it either way, but a scripting-off POST would send only
    // the file NAME without the attribute.
    expect(APPLY).toContain('encType="multipart/form-data"');
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function myRequestOvertime'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    expect(body).toContain("formData.get('remark')");
    expect(body).toContain("formData.get('attachment')");
    expect(body).toContain('remark: remark || null');
    expect(body).toContain('addAttendanceCorrectionAttachment');
    // ORPHAN PREVENTION: the file is refused BEFORE the request row commits, so a rejected upload never
    // leaves a pending request behind. The order of these two lines is the whole rule.
    expect(body.indexOf('assertAttendanceAttachmentAcceptable')).toBeGreaterThan(-1);
    expect(
      body.indexOf('assertAttendanceAttachmentAcceptable') < body.indexOf('await requestAttendanceCorrection'),
      'the file must be validated before the request row is created',
    ).toBe(true);
  });

  it('blank hidden minutes are derived server-side; supplied minutes must agree with the window', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function myRequestOvertime'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    expect(body).toContain('plannedOvertimeMinutes(plannedStart, plannedEnd)');
    expect(body).toContain('if (derivedMinutes == null) throw');
    expect(body).toContain('requestedOtMinutes = derivedMinutes;');
    expect(body).toContain('!Number.isSafeInteger(value)');
    expect(body).toContain('value !== derivedMinutes');
    expect(FIELDS).toContain('value={derivedMinutes ?? \'\'}');
    expect(body).toContain('derivedMinutes == null && otHoursRaw');
    expect(body).toContain('hours > 24');
    expect(body).not.toContain('otReasonCategory');
    expect(code(APPLY)).not.toContain('initialOtMinutes');
    expect(code(FIELDS)).not.toContain('initialOtMinutes');
  });

  it('the common refusal redirect carries the date, and success stays on the calendar', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function myRequestOvertime'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    // Every redirect out of this action names the apply screen AND the date the employee picked. The
    // non-negative-hours one used to drop it and reset the form to tomorrow.
    const redirects = [...body.matchAll(/redirect\(\s*\n?\s*`([^`]*)`/g)].map((m) => m[1]);
    expect(redirects.length, 'validation and service failures share one refusal; then success').toBe(2);
    for (const r of redirects) {
      expect(r, `redirect must return to the form: ${r}`).toContain('${PLAN_OT_PAGE}/apply');
      expect(r, `redirect must carry the date: ${r}`).toContain('date=${encodeURIComponent(date)}');
    }
    expect(redirects.some((r) => r.includes('toast=Overtime+plan+submitted'))).toBe(true);
  });

  it('on a phone Submit is pinned to the bottom of the screen, and is an ordinary footer row from lg up', () => {
    // The approved picture draws it pinned, with the hours and the date beside it. `sticky bottom-0`
    // only works because nothing between this row and `main` clips overflow — components/ui/card.tsx
    // carries no overflow-hidden, and the scroll container is main itself (app/layout.tsx).
    //
    // ⚠️ c7c69a18 (r369) MOVED THE BREAKPOINT FROM `md` TO `lg`, and this case is UPDATED rather than
    // loosened. Until then it asserted, and the case was titled, "an ordinary footer row from md up":
    //     expect(APPLY).toContain('md:static');
    //     // Single column below md, two from md up — the calendar on top, the day panel and the form under it.
    //     expect(APPLY).toContain('grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]');
    // ce5ded11's reading was not wrong, it was superseded by the reporter's own measurement: at 768px the
    // month grid and the form sat side by side at about 300px and 450px, so the calendar was squeezed. The
    // columns now stack until 1024px. The footer moves WITH them deliberately — a footer that un-pinned at
    // `md` while the form was still one stacked column would disagree with the layout across that band.
    expect(APPLY).toContain('sticky bottom-0');
    expect(APPLY).toContain('lg:static');
    expect(read('components/ui/card.tsx').includes('overflow-hidden'), 'a clipping Card would strand the sticky bar').toBe(
      false,
    );
    // Single column below lg, two from lg up — the calendar on top, the day panel and the form under it.
    expect(APPLY).toContain('grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]');
    // And the old breakpoint is gone from the page, not merely joined by the new one: `md:static` beside
    // `lg:static` would leave the footer un-pinning a breakpoint early, which is the defect this pins.
    expect(code(APPLY).includes('md:'), 'no `md:` variant survives on this screen').toBe(false);
  });

  it('the overtime start is prefilled from the scheduled finish on a working day, and nowhere else', () => {
    // A rest day, a public holiday and an off day have no scheduled finishing time; guessing one would
    // put a figure in front of the approver that nobody chose.
    expect(APPLY).toContain("const plannedStartPrefill = day?.kind === 'workday' ? (day.scheduleEnd ?? '') : '';");
    expect(FIELDS).toContain('const startValue = start ?? plannedStartPrefill;');
    expect(FIELDS).toContain("t('otStartFromShiftEnd')");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('G · the dynamically-resolved keys, which Check C of i18n-coverage cannot see', () => {
  it('every day-kind, plan-status and "From" key resolves in all six catalogues', () => {
    const kinds = ['otCalWorkingDay', 'otCalRestDay', 'otCalPublicHoliday', 'otCalOffDay'];
    const statuses = ['otCalPlanPending', 'otCalPlanApproved', 'otCalPlanRejected', 'otCalPlanWithdrawn'];
    // One per RUNG of the scheduling ladder, plus the two the default-shift rung splits into and the
    // holiday sentence — six, because "your usual shift's rest day" and "…off day" are paid differently.
    const from = [
      'otCalFromRoster',
      'otCalFromRosterRest',
      'otCalFromUsualShift',
      'otCalFromUsualRest',
      'otCalFromUsualOff',
      'otCalFromHoliday',
      'otCalFromPolicy',
    ];
    for (const k of [...kinds, ...statuses, ...from]) keyEverywhere(k);
    // …and every one of them is actually named in the source that resolves it, so a key set that drifts
    // from the code fails here rather than rendering a raw key on somebody's screen.
    for (const k of kinds) expect(CAL + APPLY, `${k} is never referenced`).toContain(k);
    for (const k of statuses) expect(CAL, `${k} is never referenced`).toContain(k);
    for (const k of from) expect(APPLY, `${k} is never referenced`).toContain(k);
  });

  it('none of the new captions is the English string copied across', () => {
    const newKeys = Object.keys(MESSAGES.en.me).filter((k) => /^otCal|^otView|^otStaysOnCalendar|^otStartFromShiftEnd|^otApprovedHoursColumn/.test(k));
    expect(newKeys.length, 'this round added a real set of captions').toBeGreaterThan(40);
    const copies: string[] = [];
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      for (const k of newKeys) {
        if (k !== 'otCalHoursValue' && MESSAGES[l].me[k] === MESSAGES.en.me[k]) copies.push(`${l}.${k}`);
      }
    }
    expect(copies, `untranslated: ${copies.join(', ')}`).toEqual([]);
    // A symbolic placeholder has no words to translate; the duration carries its units already.
    for (const l of LOCALES) expect(MESSAGES[l].me.otCalHoursValue).toBe('{hours}');
    expect(formatMinutesToHM(150)).toBe('2h30m');
    expect(formatMinutesToHM(45)).toBe('45m');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * H · c7c69a18 (r369) — THE FIELD NAMES. The reporter reads this screen in the words on it, and two of
 * the three names here were developer phrasing that reached production: "Planned start" / "Planned end"
 * for boxes that hold a start and an end time, and "Overtime hours" over a figure the same screen also
 * calls a duration. Pinned because a label is exactly the kind of change a later round reverts without
 * noticing it was asked for.
 */
describe('H · c7c69a18 — the field names this screen asks for', () => {
  it('the two time boxes read Start Time and End Time in all six catalogues, on the SAME keys', () => {
    // A VALUE rename, not a key rename: the keys carry no screen wording, so nothing else moves with them.
    // They read "Planned start" and "Planned end" from 1e9145d4 until c7c69a18.
    expect(FIELDS).toContain("t('plannedStartLabel')");
    expect(FIELDS).toContain("t('plannedEndLabel')");
    expect(MESSAGES.en.me.plannedStartLabel).toBe('Start Time');
    expect(MESSAGES.en.me.plannedEndLabel).toBe('End Time');
    for (const k of ['plannedStartLabel', 'plannedEndLabel']) keyEverywhere(k);
    const copies = LOCALES.filter((l) => l !== 'en').flatMap((l) =>
      (['plannedStartLabel', 'plannedEndLabel'] as const)
        .filter((k) => MESSAGES[l].me[k] === MESSAGES.en.me[k])
        .map((k) => `${l}.${k}`),
    );
    expect(copies, `untranslated: ${copies.join(', ')}`).toEqual([]);
  });

  it('the approved running total is "Overtime Hours", on a key of this screen’s own, and the old key is retired in place', () => {
    expect(FIELDS).toContain("t('otDurationLabel')");
    expect(code(FIELDS).includes("t('otHoursLabel')"), 'this screen is off the shared key now').toBe(false);
    expect(MESSAGES.en.me.otDurationLabel).toBe('Overtime Hours');
    expect(MESSAGES.en.me.otComputedHoursHelp).toBe('Worked out from Start Time and End Time.');
    keyEverywhere('otComputedHoursHelp');
    keyEverywhere('otDurationLabel');
    // RETIRED, NEVER DELETED. me.otHoursLabel is unreferenced after this round and stays in all six
    // catalogues at its own wording, so anything that resolves it later does not silently acquire this
    // screen's. (The approved plan's build note said app/approvals/page.tsx shares this key; it does not —
    // that file opens getTranslations('approvals') and reads approvals.otHoursLabel, whose value is "OT".)
    keyEverywhere('otHoursLabel');
    expect(MESSAGES.en.me.otHoursLabel, 'the retired key keeps its own wording').toBe('Overtime hours');
  });
});
