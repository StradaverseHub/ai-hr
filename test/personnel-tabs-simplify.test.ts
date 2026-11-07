/**
 * d3a02679 — Personnel (Admin) tab names + navigation. Presentation-only:
 *  (1) "Attendance Information" -> "Attendance" and "Leave Information" -> "Leave", mirrored across all
 *      6 locales with a real short translation (not the English word, not the old long label).
 *  (2) The ClientTabs tablist row wraps onto a second line (flex-wrap) instead of horizontally
 *      overflowing, so every tab stays one click away on any screen size.
 * Source-static guard (precedent: test/me-tabs.test.ts / test/ea-pdf-i18n-keys.test.ts): the exact
 * i18n-coverage keys already ensure the two keys exist in every locale — this pins the *values* and the
 * flex-wrap class so a future refactor can't silently regress either.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// Expected short label per locale (correctly translated, never the English word except in `en`).
const EXPECTED: Record<(typeof LOCALES)[number], { attendance: string; leave: string }> = {
  en: { attendance: 'Attendance', leave: 'Leave' },
  ms: { attendance: 'Kehadiran', leave: 'Cuti' },
  zh: { attendance: '考勤', leave: '休假' },
  ta: { attendance: 'வருகை', leave: 'விடுப்பு' },
  th: { attendance: 'การเข้างาน', leave: 'การลา' },
  vi: { attendance: 'Chấm công', leave: 'Nghỉ phép' },
};

const readTabs = (loc: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8')).people.detail
    .tabs as Record<string, string>;

describe('d3a02679 — Personnel tab simplification', () => {
  it('shortens Attendance/Leave labels in every locale to a real translation', () => {
    for (const loc of LOCALES) {
      const tabs = readTabs(loc);
      expect(tabs.attendance, `${loc} attendance`).toBe(EXPECTED[loc].attendance);
      expect(tabs.leave, `${loc} leave`).toBe(EXPECTED[loc].leave);
      // Old long labels must be gone.
      expect(tabs.attendance).not.toMatch(/Information|Maklumat|信息|தகவல்|ข้อมูล|Thông tin/);
      expect(tabs.leave).not.toMatch(/Information|Maklumat|信息|தகவல்|ข้อมูล|Thông tin/);
    }
  });

  it('non-English locales do not fall back to the English word', () => {
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const tabs = readTabs(loc);
      expect(tabs.attendance).not.toBe('Attendance');
      expect(tabs.leave).not.toBe('Leave');
    }
  });

  it('the tablist has one scrollable row without orphaned wrapped tabs', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../components/personnel-tabs.tsx'), 'utf8');
    expect(src).toContain('flex max-w-full gap-1 overflow-x-auto');
    expect(src).toContain('shrink-0 whitespace-nowrap');
    // Active-tab styling + keep-panels-mounted behaviour untouched.
    expect(src).toContain('bg-primary text-primary-foreground');
    expect(src).toContain('hidden={active !== tab.key}');
  });
});
