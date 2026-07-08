/**
 * Mobile App UI/UX preview guard (item ca2f2fef).
 *
 * The module is a purely presentational design-preview surface (no schema, no service, no writes).
 * These checks pin the structural contract the reporter asked for and the registry coupling the
 * function-access test relies on:
 *   1. The route is registered in lib/permissions.ts SCREENS with the scopedSession guard.
 *   2. The page actually enforces that guard (calls scopedSession) — registration alone isn't enough.
 *   3. The sidebar exposes exactly one /mobile-preview nav entry.
 *   4. The home screen lists the reporter's six feature tiles in the specified 3×2 order.
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

  it('the home screen lists the six feature tiles in the reporter order', () => {
    const src = read('components/mobile-preview/mobile-app.tsx');
    const order = [
      'feature.attendance',
      'feature.leave',
      'feature.claim',
      'feature.payroll',
      'feature.performance',
      'feature.setting',
    ];
    let cursor = -1;
    for (const key of order) {
      const at = src.indexOf(key, cursor + 1);
      expect(at, `${key} appears after the previous tile`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });
});
