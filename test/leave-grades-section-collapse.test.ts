/**
 * Feedback 03557e76 — Grades section collapse on the Leave Config Entitlement tab.
 *
 * Presentation-only change (no schema/service/domain event): the Grades card's content folds
 * behind a native <details>/<summary> heading (CollapsibleCardSection), starting CLOSED, with
 * the grade count kept visible on the heading and the open/closed choice persisted in a cookie
 * the server page reads SSR-side. These structural assertions guard the reported behaviour:
 * default-hidden grade list + heading toggle + persistence + unchanged GradeCatalog rendering,
 * across all 6 locales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'app/admin/leave/entitlements/page.tsx');
const SECTION = path.join(ROOT, 'components/collapsible-card-section.tsx');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

const page = fs.readFileSync(PAGE, 'utf8');
const section = fs.readFileSync(SECTION, 'utf8');

describe('leave grades section collapse', () => {
  it('renders the fold as a native details/summary with a hidden marker (in-repo pattern)', () => {
    expect(section).toMatch(/<details\b/);
    expect(section).toMatch(/<summary\b/);
    expect(section).toMatch(/\[&::-webkit-details-marker\]:hidden/);
  });

  it('wraps the Grades card content in the collapsible section on the entitlements page', () => {
    expect(page).toContain('<CollapsibleCardSection');
    const body = page.slice(page.indexOf('<CollapsibleCardSection'), page.indexOf('</CollapsibleCardSection>'));
    // GradeCatalog + its help text render unchanged INSIDE the fold; actions wiring is untouched.
    expect(body).toContain('<GradeCatalog');
    expect(body).toContain("t('gradesHelp')");
    expect(body).toContain('create: createJobGradeAction');
    expect(body).toContain('update: updateJobGradeAction');
    expect(body).toContain('archive: archiveJobGradeAction');
    expect(body).toContain('delete: deleteJobGradeAction');
  });

  it('keeps the section title + grade count visible on the heading even when closed', () => {
    const body = page.slice(page.indexOf('<CollapsibleCardSection'), page.indexOf('</CollapsibleCardSection>'));
    expect(body).toContain("title={t('gradesTitle')}");
    expect(body).toContain('count={grades.length}');
    // The component actually renders the count on the always-visible summary bar.
    const summary = section.slice(section.indexOf('<summary'), section.indexOf('</summary>'));
    expect(summary).toContain('{title}');
    expect(summary).toMatch(/\{count\}/);
  });

  it('starts CLOSED by default: cookie absent resolves defaultOpen to false, SSR-read (no flash)', () => {
    // Server page reads the cookie; strict equality to '1' means "no cookie" ⇒ closed.
    expect(page).toMatch(/cookies\(\)/);
    expect(page).toMatch(/GRADES_OPEN_COOKIE\)\?\.value === '1'/);
    expect(page).toContain('defaultOpen={gradesOpen}');
  });

  it('persists the open/closed choice via cookie on toggle (1-year, path=/, samesite=lax)', () => {
    expect(section).toMatch(/onToggle/);
    expect(section).toMatch(/document\.cookie/);
    expect(section).toMatch(/path=\/; max-age=31536000; samesite=lax/);
  });

  it('labels the toggle via a static t() call and ships the key in every locale', () => {
    expect(page).toContain("toggleLabel={t('gradesToggle')}");
    for (const loc of LOCALES) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      const leave = dict?.admin?.leave ?? {};
      expect(leave.gradesToggle, `${loc}.gradesToggle`).toBeTruthy();
    }
  });
});
