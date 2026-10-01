/**
 * 7ac6b4db rename/date/resolved-shift guarantees remain. Approved r378 adds mandatory private camera
 * capture; the prior deliberate-camera-absence guard is superseded by capture/storage/access guards.
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
  it('formats the authoritative server-owned clocking date explicitly in Kuala Lumpur', () => {
    const reader = codeOnly(read('/core/attendance-clock-read.ts'));
    expect(reader).toContain('todayInKualaLumpur(now)');
    expect(reader).toContain('serverNow:now.toISOString(),date');
    const client = codeOnly(read(CLIENT));
    expect(client).toContain("timeZone:'Asia/Kuala_Lumpur',weekday:'long'");
    expect(client).toContain("new Date(today.date+'T12:00:00+08:00')");
    expect(client).not.toContain('toLocaleDateString');
  });

  it('the Current shift card uses the same resolved identity and window, with only an explicit Switch preview', () => {
    const client = codeOnly(read(CLIENT));
    expect(client).toContain("t('currentShift')");
    expect(client).toContain("shown?.name??shiftName??t('noShiftAssigned')");
    expect(client).toContain("shown?.start??today.shift.start??'—'");
    expect(client).toContain("shown?.end??today.shift.end??'—'");
    expect(client).toContain('shiftOptions.length>1&&');
    expect(read(PAGE)).toContain('s.code===resolved?.shiftCode');
    expect(read(PAGE)).toContain('shiftName={shift?.name??null}');
  });

  it('a day that resolves to NO shift says so, rather than rendering an empty card', () => {
    expect(codeOnly(read(CLIENT))).toContain("t('noShiftAssigned')");
  });

  it('the shift window depends on the existing engine schedule resolver', () => {
    const reader = codeOnly(read('/core/attendance-clock-read.ts'));
    expect(reader).toContain('const schedule = await clockScheduleForTx(tx, me.employmentId, date)');
    expect(reader).toContain('shift:{code:schedule.code,start:schedule.start,end:schedule.end}');
    expect(read('/core/attendance.ts')).toContain('const schedule = await scheduleFor(tx, employmentId, date)');
  });
});

describe('r378 · mandatory private camera capture supersedes deliberate absence', () => {
  it('requires front-camera review, cleanup and the private authenticated capture endpoint', () => {
    const client = codeOnly(read(CLIENT));
    expect(client).toContain("getUserMedia({video:{facingMode:'user'},audio:false})");
    expect(client).toContain("body.set('photo',photo,'attendance.jpg')");
    expect(client).toContain('if(!photo||!action||busy)return');
    expect(client).toContain("fetch('/api/attendance/clock',{method:'POST'");
    expect(client).toContain('stream.current?.getTracks().forEach(track=>track.stop())');
    expect(client).not.toContain('type="file"');
    expect(client).not.toContain('requestFullscreen');
    const command = codeOnly(read('/core/attendance-clock.ts'));
    expect(command).toContain('decodeClockPhoto(p.photo, p.mime)');
    expect(command).toContain('const me = await myEmployment(ctx)');
    expect(command).toContain('clockCaptureId: captureId');
    const migration = read('/db/migrations/0500_attendance_clock_evidence.sql');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('app.can_see_employment(employment_id)');
    expect(migration).toContain('REVOKE ALL ON attendance_clock_capture FROM ai_hr_app');
    expect(migration).toContain('app.purge_attendance_clock_photo');
  });

  it('the existing profile-photo erasure precedent remains in place', () => {
    // Existing profile-photo erasure behavior remains unchanged by private clock evidence.
    const pdpa = read('/core/pdpa.ts');
    expect(pdpa).toContain('personPhoto');
    expect(pdpa).toContain("erased.push('profilePhoto')");
  });
});
