/**
 * Flyout navigation guard (item fdc20776 — redesign of the right/left nav panel).
 *
 * The ticket replaces the accordion-style expand-in-place navigation (nav-collapsible-group.tsx)
 * with a flyout: modules with sub-items open a panel BESIDE the rail, the rail keeps a constant
 * height, and only one module's panel is open at a time.
 *
 * The nav structure lives in module-private consts inside `'use client'` components, so — per the
 * established convention (test/sidebar-attendance-group.test.ts, test/helpers/sidebar-source.ts) —
 * these are source-text checks on components/sidebar.tsx and components/nav-flyout.tsx, not
 * renders. Acknowledged limit: greps prove presence, not wiring — the browser pass is the wiring
 * check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SIDEBAR = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
const FLYOUT = fs.readFileSync(path.resolve(__dirname, '../components/nav-flyout.tsx'), 'utf8');

describe('sidebar flyout navigation (fdc20776)', () => {
  it('sidebar renders nav-flyout and no longer imports the accordion component', () => {
    expect(SIDEBAR).toContain(`from '@/components/nav-flyout'`);
    expect(SIDEBAR).not.toContain('nav-collapsible-group');
  });

  it('permission-filters children with canSeeChild before rendering a flyout node', () => {
    // Both the rail trigger and the open panel must render only the viewer's visible children.
    const filtered = SIDEBAR.match(/children\.filter\(canSeeChild\)/g) ?? [];
    expect(filtered.length, 'canSeeChild filtering applied to flyout children').toBeGreaterThanOrEqual(2);
  });

  it('trigger carries the popup ARIA contract (haspopup / expanded / controls)', () => {
    expect(FLYOUT).toContain('aria-haspopup');
    expect(FLYOUT).toContain('aria-expanded');
    expect(FLYOUT).toContain('aria-controls');
  });

  it('dismisses via the repo backdrop idiom (fixed inset-0), not a document click listener', () => {
    expect(FLYOUT).toMatch(/fixed inset-0 z-40/);
    expect(FLYOUT).not.toMatch(/addEventListener\('click'/);
  });

  it('closes on Escape via a mounted-only keydown listener', () => {
    expect(FLYOUT).toMatch(/addEventListener\('keydown'/);
    expect(FLYOUT).toMatch(/removeEventListener\('keydown'/);
    expect(FLYOUT).toMatch(/key === 'Escape'/);
  });

  it('every child link closes the panel on click (mandatory: Reports children differ only by query)', () => {
    expect(FLYOUT).toMatch(/onClick=\{onClose\}/);
  });

  it('active predicate is query-aware (splits the href on ? and compares search params)', () => {
    expect(FLYOUT).toMatch(/split\('\?'\)/);
    expect(FLYOUT).toContain('URLSearchParams');
    // sidebar consumes the shared predicates rather than re-deriving pathname-only matching.
    expect(SIDEBAR).toContain('isHrefActive');
    expect(SIDEBAR).toContain('isParentActive');
    expect(SIDEBAR).toContain('useSearchParams');
  });
});
