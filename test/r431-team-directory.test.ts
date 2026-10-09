/**
 * r431 (edabd693): Manage → Personnel is renamed "Team Directory", and the directory profile no longer
 * carries a "View full record" shortcut to /admin/personnel for anyone (it was administrator-only before;
 * nobody else ever saw it). Static-source guard, DB-free. The admin route and its guard are untouched.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
// The word each locale used before the rename; the new label must have replaced it.
const OLD: Record<(typeof LOCALES)[number], string> = {
  en: 'Personnel',
  ms: 'Kakitangan',
  ta: 'பணியாளர்கள்',
  th: 'พนักงาน',
  vi: 'Nhân sự',
  zh: '员工',
};

describe('r431 Team Directory (edabd693)', () => {
  it('the directory profile renders no link to the admin record, for an administrator or anyone', () => {
    const src = read('app/personnel/[employmentId]/page.tsx');
    // Slice from the render onwards so the doc comment (which names the admin route) is excluded.
    const start = src.indexOf('  return (\n    <div className="mx-auto max-w-3xl');
    expect(start, 'render marker found').toBeGreaterThanOrEqual(0);
    const jsx = src.slice(start);
    expect(jsx.length, 'slice is the whole render, not an empty string').toBeGreaterThan(1500);
    expect(jsx).not.toContain('/admin/personnel');
    expect(src).not.toContain('viewFullRecord');
    // No admin-only branch is left to re-add the button behind.
    expect(src).not.toMatch(/isAdmin\(/);
  });

  it.each(LOCALES)('locale %s: menu row and page heading agree and carry the new name', (loc) => {
    const cat = JSON.parse(read(`messages/${loc}.json`));
    expect(cat.nav.people).toBeTruthy();
    expect(cat.nav.people).toBe(cat.people.list.title);
    expect(cat.nav.people).not.toBe(OLD[loc]);
    // The retired shortcut label is gone from every catalogue.
    expect(cat.people.detail.viewFullRecord).toBeUndefined();
  });

  it('English reads Team Directory in the menu and on the page', () => {
    const en = JSON.parse(read('messages/en.json'));
    expect(en.nav.people).toBe('Team Directory');
    expect(en.people.list.title).toBe('Team Directory');
  });
});
