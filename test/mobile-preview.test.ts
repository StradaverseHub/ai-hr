/**
 * Mobile App UI/UX preview guard (item ca2f2fef).
 *
 * The module is a purely presentational design-preview surface (no schema, no service, no writes).
 * These checks pin the structural contract the reporter asked for and the registry coupling the
 * function-access test relies on:
 *   1. The route is registered in lib/permissions.ts SCREENS with the scopedSession guard.
 *   2. The page actually enforces that guard (calls scopedSession) — registration alone isn't enough.
 *   3. The sidebar exposes exactly one /mobile-preview nav entry.
 *   4. The owner replaced the mock tiles with Monolith's five live task destinations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCREENS } from '../lib/permissions';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('mobile-preview module (ca2f2fef)', () => {
  it('registers the /mobile-preview screen with the scopedSession guard', () => {
    const screen = SCREENS.find((s) => s.screenKey === 'mobilePreview');
    expect(screen, 'mobilePreview column exists in SCREENS').toBeTruthy();
    expect(screen!.guard).toBe('scopedSession');
    expect(screen!.routes).toContain('/mobile-preview');
    expect(screen!.labelKey).toBe('nav.mobilePreview');
  });

  it('the page enforces the guard (not merely registered)', () => {
    const src = read('app/mobile-preview/page.tsx');
    expect(src).toMatch(/scopedSession\(/);
  });

  it('the sidebar exposes exactly one /mobile-preview nav entry', () => {
    const src = read('components/sidebar.tsx');
    const matches = src.match(/'\/mobile-preview'/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('the live preview presents the five task destinations without sample identities', () => {
    const src = read('components/mobile-preview/mobile-app.tsx');
    for (const id of ['home', 'clock', 'requests', 'inbox', 'me']) expect(src).toContain(`id: '${id}'`);
    expect(src).not.toContain('Aisyah Rahman');
    expect(src).toContain('MobilePreviewData');
    const page = read('app/mobile-preview/page.tsx');
    expect(page).toContain('loadMobilePreview(s, scopeIds, locale)');
  });
});
