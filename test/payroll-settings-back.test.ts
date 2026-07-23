/**
 * Structural regression guard for the "← Payroll Settings" back link.
 *
 * Every maintenance screen reachable from the /payroll/setup card grid must render a PageHeader
 * back link that returns to /payroll/setup. This is a cheap source-level assertion (mirrors the
 * i18n-coverage structural guard) — no rendering needed — so a future refactor that drops the
 * back link on any of these screens fails CI.
 *
 * The label is resolved through app/payroll/setup/back.ts (which reads payroll.setup.title) so the
 * back prop carries href: '/payroll/setup'. We assert on that href string being wired to the header.
 * The configuration page has TWO PageHeader render sites (edit-mode / view-mode) and both must carry
 * the back link, so we assert at least two back={...} occurrences there. (ADR-0080 rung 5c removed the
 * former third "no-pack" header: the page now resolves the acting company's country pack through
 * requireConfigSection(), which notFound()s when no pack declares the section instead of rendering a
 * no-pack banner in-page — so the no-pack render site no longer exists to carry a back link.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('payroll settings back link', () => {
  it('the shared helper resolves the /payroll/setup back link', () => {
    const src = read('app/payroll/setup/back.ts');
    expect(src).toContain("href: '/payroll/setup'");
    // Reuses payroll.setup.title — no new i18n key minted.
    expect(src).toContain("getTranslations('payroll.setup')");
    expect(src).toContain("t('title')");
  });

  // Every destination reachable from the /payroll/setup card grid must wire the helper into a
  // PageHeader back prop.
  const SINGLE_HEADER_PAGES = [
    'app/admin/payroll-config/page.tsx',
    'app/admin/pay-components/page.tsx',
    'app/admin/payroll-policy/page.tsx',
  ] as const;

  for (const rel of SINGLE_HEADER_PAGES) {
    it(`${rel} wires the back link into its PageHeader`, () => {
      const src = read(rel);
      expect(src).toContain("import { settingsBack } from '@/app/payroll/setup/back'");
      expect(src).toContain('back={await settingsBack()}');
    });
  }

  it('app/payroll/configuration/page.tsx carries the back link on both headers', () => {
    const src = read('app/payroll/configuration/page.tsx');
    expect(src).toContain("import { settingsBack } from '@/app/payroll/setup/back'");
    // back is resolved once and passed to every header (edit-mode / view-mode). The no-pack header was
    // retired in ADR-0080 rung 5c — requireConfigSection() notFound()s instead of rendering in-page.
    expect(src).toContain('const back = await settingsBack();');
    const backProps = src.match(/back=\{back\}/g) ?? [];
    expect(backProps.length).toBeGreaterThanOrEqual(2);
  });
});
