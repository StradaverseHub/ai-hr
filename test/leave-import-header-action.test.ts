/**
 * Move Import Function as Action Button Instead of Standalone Section (R61 · feedback e8f2398f).
 *
 * The Entitlements tab used to render a whole standalone Card near the page bottom whose only job was
 * holding a link to /admin/leave/import. This change puts a "+ Import" btnPrimary Link into the
 * PageHeader actions slot (the standard top-right spot for page-level actions) and removes the
 * signpost Card. The import flow itself — screen, validation, templates — is untouched.
 *
 * DB-free source guard (the suite has no DOM runner): the RSC page can't be rendered here, so we assert
 * the composition + the i18n pruning statically.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED.
 *
 * e8f2398f's property is "the way into the importer is a PageHeader action button, not a standalone
 * signpost Card". Round 5 moved Import leave data to `/admin/leave-config/import` and put the button's
 * href through the area map (`leaveConfigScreenHref('importLeaveData')`), so a literal address is no
 * longer the right thing to assert — the map IS the address now, and asserting a literal would re-create
 * the two-answers defect r259 found. Both leave TYPE screens are checked while both exist: the old page
 * comes out in its own commit, and this list shrinks with it.
 */
const LEAVE_TYPE_PAGES = [
  '/app/admin/leave/entitlements/page.tsx',
  '/app/admin/leave-config/types/page.tsx',
] as const;
const entitlementsPage = read('/app/admin/leave/entitlements/page.tsx');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
// Keys of the removed standalone Card — pruned everywhere.
const PRUNED_KEYS = ['importTitle', 'importHelp', 'importLink'] as const;

describe('e8f2398f: Import is a PageHeader action button', () => {
  it.each(LEAVE_TYPE_PAGES)('%s puts the import link in the PageHeader actions slot', (rel) => {
    // The header carries an actions slot with the import link, labelled by the importAction key.
    const header = read(rel).match(/<PageHeader[\s\S]*?\/>/)?.[0] ?? '';
    expect(header).toMatch(/actions=\{/);
    expect(header).toMatch(/<Link href=\{leaveConfigScreenHref\('importLeaveData'\)\} className=\{btnPrimary\}>/);
    expect(header).toMatch(/\{t\('importAction'\)\}/);
  });

  it.each(LEAVE_TYPE_PAGES)('%s drops the standalone import section from the page body', (rel) => {
    const page = read(rel);
    for (const key of PRUNED_KEYS) expect(page.includes(key)).toBe(false);
    // Exactly ONE rendered way into the importer remains — the header action.
    const links = page.match(/href=\{leaveConfigScreenHref\('importLeaveData'\)\}/g) ?? [];
    expect(links).toHaveLength(1);
    // …and none of them is a literal that could disagree with the menu (r259).
    expect(page.match(/href="\/admin\/leave(-config)?\/import"/g) ?? []).toHaveLength(0);
  });

  it('leaves the import flow itself untouched — the importer page still exists, at its new address', () => {
    expect(() => read('/app/admin/leave-config/import/page.tsx')).not.toThrow();
    // And the old address still ANSWERS: it is a redirect stub, never deleted, because the reporter's
    // bookmarks are the reason the stubs exist (migration order → Round 5/6).
    const stub = read('/app/admin/leave/import/page.tsx');
    expect(stub).toContain('redirect(');
    expect(stub).toContain('/admin/leave-config/import');
  });
});

describe('e8f2398f: i18n — importAction added, standalone-card keys pruned, in all 6 locales', () => {
  for (const locale of LOCALES) {
    it(`${locale}.json has importAction ("+ …") and no card keys`, () => {
      const leave = JSON.parse(read(`/messages/${locale}.json`)).admin.leave as Record<string, unknown>;
      expect(leave, `${locale}: importAction must exist`).toHaveProperty('importAction');
      expect(String(leave.importAction).startsWith('+ '), `${locale}: importAction keeps the "+ " prefix`).toBe(true);
      for (const key of PRUNED_KEYS) expect(leave, `${locale}: ${key} should be pruned`).not.toHaveProperty(key);
      // History guard: a QW-wave commit once left an orphaned duplicate "importAction" line behind —
      // JSON.parse silently keeps the LAST one, so assert the raw file carries the key exactly once.
      const raw = read(`/messages/${locale}.json`);
      expect(raw.match(/"importAction"/g) ?? [], `${locale}: importAction defined exactly once`).toHaveLength(1);
    });
  }
});
