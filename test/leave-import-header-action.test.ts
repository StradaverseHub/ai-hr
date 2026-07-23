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

const entitlementsPage = read('/app/admin/leave/entitlements/page.tsx');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
// Keys of the removed standalone Card — pruned everywhere.
const PRUNED_KEYS = ['importTitle', 'importHelp', 'importLink'] as const;

describe('e8f2398f: Import is a PageHeader action button', () => {
  it('renders a btnPrimary Link to /admin/leave/import inside the PageHeader actions slot', () => {
    // The header carries an actions slot with the import link, labelled by the importAction key.
    const header = entitlementsPage.match(/<PageHeader[\s\S]*?\/>/)?.[0] ?? '';
    expect(header).toMatch(/actions=\{/);
    expect(header).toMatch(/<Link href="\/admin\/leave\/import" className=\{btnPrimary\}>/);
    expect(header).toMatch(/\{t\('importAction'\)\}/);
  });

  it('drops the standalone import section from the page body', () => {
    for (const key of PRUNED_KEYS) expect(entitlementsPage.includes(key)).toBe(false);
    // Exactly ONE rendered link to the importer remains — the header action.
    const links = entitlementsPage.match(/href="\/admin\/leave\/import"/g) ?? [];
    expect(links).toHaveLength(1);
  });

  it('leaves the import flow itself untouched (the importer page still exists)', () => {
    expect(() => read('/app/admin/leave/import/page.tsx')).not.toThrow();
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
