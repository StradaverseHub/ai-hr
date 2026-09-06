/**
 * COLLAPSIBLE NAV SECTIONS — the rail has to FIT, and the active section has to stay visible.
 *
 * ═══ THE MEASUREMENT THAT CAUSED THIS ═══
 *
 * A browser audit of the production build at 1440x900 found the rail's content was **1490px inside a
 * 746px column, on every one of 44 screens**: 34 entries, 16 reachable without scrolling, 18 below the
 * fold — and the 18 included Analytics, Audit trail, Data Privacy, Security & permissions and AI, which
 * is where an AI provider is configured. After sections became collapsible the same audit reports
 * ratio 1.0 and **zero** entries below the fold on all 45 screens.
 *
 * ⚠️ WHY A SOURCE-SHAPE TEST. The nav structure lives in module-private consts inside a `'use client'`
 * component, so this follows the established convention of test/sidebar-flyout.test.ts and
 * test/sidebar-attendance-group.test.ts rather than rendering. Acknowledged limit, stated there too:
 * greps prove presence, not wiring — the browser pass is the wiring check, and it is what produced the
 * numbers above.
 *
 * The properties pinned here are the ones whose loss would silently undo the fix:
 *  1. EVERY group is labelled. The first group had no label, which meant it could not collapse; at ten
 *     rows it alone is half the rail, and no amount of collapsing the other three could make it fit.
 *  2. The ACTIVE section is force-open and its control is disabled. "Where am I" must never depend on a
 *     toggle — collapsing the section you are standing in hides the highlighted row.
 *  3. A closed section renders NO items. If the items render and are merely hidden by CSS, the rail's
 *     scroll height is unchanged and the fix is cosmetic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SIDEBAR = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
const EN = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8'));

describe('sidebar sections must keep the rail inside the viewport', () => {
  it('every group carries a labelKey, so every group can collapse', () => {
    // The unlabelled group was the reason the rail could not fit. A new group added without a label
    // reintroduces exactly that, and would render with no heading and no way to close it.
    const groupsBlock = SIDEBAR.slice(SIDEBAR.indexOf('const GROUPS: Group[] = ['));
    const groupOpeners = [...groupsBlock.matchAll(/^ {2}\{$/gm)].length;
    const labelKeys = [...groupsBlock.matchAll(/^ {4}labelKey: '/gm)].length;
    expect(groupOpeners).toBeGreaterThan(0);
    expect(labelKeys).toBe(groupOpeners);
  });

  it('names the first section, and the label exists in the catalogue', () => {
    expect(SIDEBAR).toContain("labelKey: 'sectionHome'");
    // A missing key here is a MISSING_MESSAGE that passes tsc, the suite and next build alike.
    expect(EN.nav.sectionHome).toBeTruthy();
  });

  it('forces the active section open and disables its toggle', () => {
    expect(SIDEBAR).toContain('const activeSectionKey');
    // The force-open lives in sectionOpen so every reader agrees; a caller checking only the state Set
    // would collapse the current section.
    expect(SIDEBAR).toMatch(/sectionOpen\s*=\s*\(key\?: string\)\s*=>\s*\n?\s*key == null \|\| key === activeSectionKey/);
    expect(SIDEBAR).toContain('disabled={group.labelKey === activeSectionKey}');
  });

  it('does not RENDER the items of a closed section', () => {
    // The load-bearing half. Hiding items with CSS leaves scrollHeight unchanged and the rail still
    // overflows — the guard is that the map is gated behind the open check.
    expect(SIDEBAR).toMatch(/\{\(collapsed \|\| sectionOpen\(group\.labelKey\)\) &&\s*\n\s*group\.items\.map\(/);
  });

  it('keeps every section open in the icon rail, where a heading cannot be shown', () => {
    // Labels are hidden in the collapsed rail, so a chevron there would hide destinations behind a
    // control with nothing to say what is inside. `collapsed ||` is what keeps them all rendered.
    expect(SIDEBAR).toContain('(collapsed || sectionOpen(group.labelKey))');
    expect(SIDEBAR).toContain('{!collapsed && group.labelKey && (');
  });

  it('points aria-controls at an element that exists', () => {
    expect(SIDEBAR).toContain('aria-controls={`nav-section-${group.labelKey}`}');
    expect(SIDEBAR).toContain('id={group.labelKey ? `nav-section-${group.labelKey}` : undefined}');
  });
});
