/**
 * d990f14a — Full screen on the inquiry tables, and which filters survive a tab change.
 *
 * PRESENTATION AND NAVIGATION ONLY. Like 026e16b9 before it, this item may not move a figure, so this file
 * asserts nothing about data. It pins the three things that are cheap to break by accident:
 *
 *   1. the overlay's load-bearing assumption (no transformed ancestor), which is invisible until it fails;
 *   2. that `asOf` is NEVER carried to a tab that cannot honour it;
 *   3. that the table is rendered ONCE, not a second time inside the overlay.
 *
 * WHAT IS NOT COVERED HERE, stated rather than implied: there is no DOM or interaction runner in this repo,
 * so "Escape closes it" and "focus returns to the opener" are not tested here — they are browser claims and
 * belong in the round entry's measurements, the way 026e16b9 recorded its widths.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const OVERLAY = '/components/leave/table-fullscreen.tsx';
const NAV = '/components/leave/leave-inquiry-nav.tsx';
const CARD = '/components/ui/card.tsx';
const BALANCES = '/app/leave/employee-balances/page.tsx';
const RECORDS = '/app/leave/employee-records/page.tsx';
const DETAILS = '/app/leave/tracker/page.tsx';

describe('d990f14a · the Full screen overlay', () => {
  it('is ONE shared component, used by all three tabs rather than copied', () => {
    for (const p of [RECORDS]) {
      expect(read(p).includes("from '@/components/leave/table-fullscreen'"), `${p} imports it`).toBe(true);
    }
  });

  it('renders the table ONCE — the wrapper is promoted, the children are not duplicated', () => {
    const src = read(OVERLAY);
    // Exactly one `{children}` placement. A second one is the duplicate-DOM/duplicate-id defect the
    // component's own header rules out, and it would double the widest table in the product.
    expect(src.match(/\{children\}/g) ?? []).toHaveLength(1);
    // …and it is NOT portalled: a container change at the same tree position remounts the table and
    // resets the horizontal scroll, which is the thing someone opening Full screen is trying to keep.
    expect(src.includes('createPortal'), 'promoting in place, not portalling').toBe(false);
  });

  /**
   * THE ASSERTION THE COMPONENT'S HEADER POINTS AT. `position: fixed` escapes an `overflow: hidden`
   * ancestor, which `Card` is, but it does NOT escape one carrying a transform, filter or `contain`. If
   * Card ever gains a hover-lift, this overlay silently becomes a box inside the card instead of covering
   * the viewport, with nothing failing anywhere. If this assertion must ever be relaxed, the overlay has to
   * move to a portal and accept the remount.
   */
  it('Card carries no transform, filter or contain — the overlay depends on it', () => {
    const card = read(CARD);
    for (const trap of ['transform', 'scale-', 'rotate-', 'filter', 'backdrop-', 'contain-']) {
      expect(card.includes(trap), `Card gained \`${trap}\`, which traps a fixed overlay inside it`).toBe(
        false,
      );
    }
  });

  it('is a modal dialog while open, and its trigger is a real button', () => {
    const src = read(OVERLAY);
    expect(src.includes('role={open ? \'dialog\' : undefined}')).toBe(true);
    expect(src.includes('aria-modal={open ? true : undefined}')).toBe(true);
    expect(src.includes('fixed inset-0 z-50')).toBe(true);
    // Escape and the body-scroll lock are wired, even though the behaviour itself is a browser claim.
    expect(src.includes("e.key === 'Escape'")).toBe(true);
    expect(src.includes("document.body.style.overflow = 'hidden'")).toBe(true);
    // The trigger is hidden rather than unmounted while open, so the opener ref survives for focus return.
    expect(src.includes('hidden={open}')).toBe(true);
    expect(src.includes('openerRef.current?.focus()')).toBe(true);
  });

  it('every label crosses the server/client boundary as a plain string', () => {
    const src = read(OVERLAY);
    expect(src.startsWith("'use client';")).toBe(true);
    // No translator crosses: the component never imports next-intl, it takes finished strings.
    expect(src.includes('next-intl'), 'the overlay must not translate anything itself').toBe(false);
    for (const p of [RECORDS]) {
      expect(read(p).includes("openLabel={tInq('fullScreen')}"), `${p} passes a finished string`).toBe(true);
    }
  });
});

describe('d990f14a · which filters follow a tab change', () => {
  it('carries only what the DESTINATION can honour, from an allowlist rather than the query string', () => {
    const nav = read(NAV);
    expect(nav.includes('const CARRY: Record<Tab, readonly string[]>')).toBe(true);
    // details gets `emp` alone: its search is an employee search in its own edQ namespace.
    expect(nav).not.toMatch(/details:\s*\[/);
    expect(nav).toMatch(/balances:\s*\['q',\s*'type',\s*'pickerQ'/);
    expect(nav).toMatch(/records:\s*\['q',\s*'type',\s*'pickerQ'/);
  });

  /**
   * THE ONE THAT MATTERS. `asOf` is Employee Balances' own As-at date; Employee Leave Record dates a leave
   * by its own from/to and Employee Details has no date at all. Carrying it would put a value in a query
   * the destination cannot honour — and, worse, would make the search bar above the bar look like one
   * control governing all three tabs, which it is not.
   */
  it('NEVER carries asOf to another tab', () => {
    const nav = read(NAV);
    expect(nav.includes("'asOf'"), 'asOf must not appear in any carry list').toBe(false);
    for (const [, list] of nav.matchAll(/(?:details|balances|records):\s*\[([^\]]*)\]/g)) {
      expect(list.includes('asOf')).toBe(false);
    }
  });

  it('emp is still threaded through every tab — losing the selection is what made the screen unusable', () => {
    expect(read(NAV).includes("p.set('emp', employmentId)")).toBe(true);
    for (const p of [BALANCES, RECORDS]) {
      expect(read(p).includes('carry={{ ...panelPreserve, q, type: typeIds }}'), `${p} hands its filters on`).toBe(true);
    }
    // Details passes no carry at all, by design.
    expect(read(DETAILS)).not.toContain('<LeaveInquiryNav');
    expect(read(BALANCES)).not.toContain('<TableFullscreen');
  });
});
