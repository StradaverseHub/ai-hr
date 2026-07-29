/**
 * Feedback 62a359e7 — Group Structure collapse.
 *
 * Presentation-only change (no schema/service/domain event): the first Card on the admin
 * Organization page becomes a native <details>/<summary> that starts COLLAPSED, with a
 * Show/Hide affordance, while CompanyTree stays server-rendered inside. These structural
 * assertions guard the reported behaviour: default-hidden group structure + show/hide control
 * + unchanged hierarchy rendering, across all 6 locales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'app/admin/organization/page.tsx');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

const src = fs.readFileSync(PAGE, 'utf8');

describe('organization group-structure collapse', () => {
  it('renders the group structure as a native details/summary (server component, no client JS)', () => {
    expect(src).toMatch(/<details\b/);
    expect(src).toMatch(/<summary\b/);
  });

  it('starts COLLAPSED by default (the details has no open attribute)', () => {
    // Grab the opening <details ...> tag and assert it carries no `open` attribute.
    const openTag = src.match(/<details[^>]*>/)?.[0] ?? '';
    expect(openTag).not.toMatch(/\bopen\b/);
  });

  it('provides a Show/Hide affordance via static t() calls (group-open CSS toggle)', () => {
    expect(src).toContain("t('showGroupStructure')");
    expect(src).toContain("t('hideGroupStructure')");
    expect(src).toMatch(/group-open:hidden/);
    expect(src).toMatch(/group-open:inline/);
  });

  it('keeps CompanyTree rendering unchanged inside the collapsible body', () => {
    const detailsBody = src.slice(src.indexOf('<details'), src.indexOf('</details>'));
    // `visibleTree`, not the raw `tree`, since feedback ae3bd088: the tree is drawn from the SAME
    // resolved company list the Companies card renders, so the bracketed count on this summary cannot
    // disagree with the card's. For a group-wide admin the two arrays are identical, which is why this
    // remains a presentation-only assertion. The behavioural pin lives in
    // test/organization-companies-reachable.test.ts.
    expect(detailsBody).toContain('<CompanyTree nodes={visibleTree} />');
    expect(detailsBody).toContain("t('noCompaniesYet')");
  });

  it('adds show/hide labels to admin.organization in every locale', () => {
    for (const loc of LOCALES) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      const org = dict?.admin?.organization ?? {};
      expect(org.showGroupStructure, `${loc}.showGroupStructure`).toBeTruthy();
      expect(org.hideGroupStructure, `${loc}.hideGroupStructure`).toBeTruthy();
    }
  });
});
