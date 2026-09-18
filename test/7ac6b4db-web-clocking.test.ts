/**
 * 7ac6b4db — My Attendance › Clock in/out becomes Web Clocking, with the shift it is clocking against.
 *
 * ⚠️ THE WEBCAM PHOTO IS NOT IN THIS ROUND, AND THAT IS A DECISION, NOT AN OVERSIGHT. The ticket asks for a
 * photo on every Clock In and Clock Out. A face photo is biometric-adjacent personal data — this codebase
 * already says so about the profile photograph (core/pdpa.ts, b4682879: identity scope, erased on an
 * identity/all erasure, never statutory-locked) — and there would be hundreds per employee per year rather
 * than one. Shipping it needs a storage design that is NOT person_photo's in-row bytea (150-400 KB × 2 per
 * working day is 10-20 GB a year of primary-database bytes, inside every backup), its own RLS policy, a
 * place in the PDPA erasure path, a consent record, and a retention sweep ON THE BOX'S CRONTAB — a script
 * in scripts/ that nobody schedules is not a retention policy. That is a round, and it is owed to the
 * reporter in those words rather than half-built beside a menu rename.
 *
 * What IS here: the rename, the date the employee is clocking for, and the shift they are clocking against.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const json = (rel: string) => JSON.parse(read(rel)) as Record<string, never>;

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const CLIENT = '/app/attendance/clock/clock-client.tsx';
const PAGE = '/app/attendance/clock/page.tsx';

const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('7ac6b4db · the rename', () => {
  it('the menu row and the page heading BOTH read Web Clocking, in all six locales', () => {
    for (const loc of LOCALES) {
      const m = json(`/messages/${loc}.json`) as never as {
        nav: Record<string, string>;
        attendance: { clock: Record<string, string> };
      };
      expect(m.nav.attendanceClock, `${loc} nav row`).toBeTruthy();
      expect(m.attendance.clock.title, `${loc} page heading`).toBeTruthy();
      // The row and the heading must not drift apart — they name one screen.
      expect(m.attendance.clock.title, `${loc}: heading and row disagree`).toBe(m.nav.attendanceClock);
    }
    const en = json('/messages/en.json') as never as { nav: Record<string, string> };
    expect(en.nav.attendanceClock).toBe('Web Clocking');
  });

  /**
   * THE ROUTE DID NOT MOVE. Renaming a label is not renaming an address: /attendance/clock is in saved
   * links and in the attendance pack's nav row. A rename that quietly changed the href would break every
   * bookmark for a cosmetic gain.
   */
  it('the ADDRESS is untouched', () => {
    // The nav row still points at the same place. (The screen is not in lib/permissions.ts: it is
    // self-service, guarded by the session rather than by a screen column, so there is no matrix entry to
    // check — asserting one would be asserting something that was never true.)
    expect(read('/packs/attendance/index.ts')).toContain("{ href: '/attendance/clock', labelKey: 'attendanceClock'");
    expect(read('/app/attendance/clock/page.tsx')).toContain('getSession');
  });
});

describe('7ac6b4db · the date and the shift being clocked against', () => {
  /**
   * The island renders a FINISHED string. `toLocaleDateString` in the browser formats against the BROWSER's
   * locale and time zone, so a viewer in another zone could be shown yesterday's date beside today's
   * punches — on the one screen whose entire job is to say which day you are clocking for.
   */
  it('the date is formatted on the SERVER and crosses as a string', () => {
    expect(read(PAGE)).toContain('const todayLabel = `${fmtDayDate(today, locale)}, ${fmtDayName(today, locale)}`');
    expect(read(PAGE)).toContain('const locale = await getLocale();');
    const client = codeOnly(read(CLIENT));
    expect(client).toContain('todayLabel');
    expect(client.includes('toLocaleDateString'), 'the island must not format a date itself').toBe(false);
  });

  it('the Current shift card reads the SAME resolved shift the "ends at" line does', () => {
    const client = codeOnly(read(CLIENT));
    for (const key of ['currentShift', 'shiftId', 'shiftStarts', 'shiftEnds', 'noShiftAssigned']) {
      expect(client, `the card is missing ${key}`).toContain(`t('${key}')`);
    }
    // `shownShiftEnd` is the value the shift-end line already used (resolved shift, or the Switch's pick);
    // a second resolution here could name a different shift from the one the punch is judged against.
    expect(client).toContain('shownShiftEnd');
    expect(client).toContain('resolvedShiftStart');
  });

  it('a day that resolves to NO shift says so, rather than rendering an empty card', () => {
    expect(codeOnly(read(CLIENT))).toContain("t('noShiftAssigned')");
  });

  it('the shift start comes from the engine’s resolved row, not a second read', () => {
    expect(read(PAGE)).toContain('resolvedShiftStart={resolved?.shiftStart ?? null}');
  });
});

describe('7ac6b4db · the photo is deliberately absent, and nothing half-built was left behind', () => {
  /**
   * A half-landed capture path is worse than none: a `getUserMedia` call with no storage, no retention and
   * no erasure route is a screen that asks for a face and does something undefined with it. If a later
   * round adds the photo, it deletes this test and says so in the round entry.
   */
  it('no camera capture exists anywhere yet', () => {
    for (const p of [CLIENT, PAGE, '/app/attendance/clock/actions.ts']) {
      const src = codeOnly(read(p));
      expect(src.includes('getUserMedia'), `${p} started capturing before the design landed`).toBe(false);
      expect(src.includes('requestFullscreen'), p).toBe(false);
    }
  });

  it('the PDPA erasure precedent this WILL have to join is still in place', () => {
    // core/pdpa.ts deletes person_photo on an identity/all erasure and reports it. A clocking photo is the
    // same classification; when it ships it joins this path. Pinned so the precedent cannot quietly vanish
    // between now and then, which is how the new table would end up outside the erasure scope.
    const pdpa = read('/core/pdpa.ts');
    expect(pdpa).toContain('personPhoto');
    expect(pdpa).toContain("erased.push('profilePhoto')");
  });
});
