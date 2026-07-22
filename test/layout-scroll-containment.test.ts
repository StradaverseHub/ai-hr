/**
 * Viewport scroll-trap guard (user-reported 2026-07-22: "Security & permissions page cut off from
 * the bottom").
 *
 * Source-static guard (precedent: test/personnel-family-children.test.ts). The app shell fixes the
 * canvas with body h-dvh overflow-hidden and scrolls INSIDE <main> (and inside the sidebar <nav>).
 * That only holds if every position:absolute descendant stays contained: Tailwind's sr-only is
 * position:absolute, and with NO positioned ancestor those boxes escape the scroll containers and
 * accumulate scrollable overflow directly on <html> (observed: scrollHeight 3192 vs 720 viewport on
 * /admin/users). body's overflow-hidden propagates to the viewport and disables USER scrolling only —
 * focus/scrollIntoView/window.scrollTo still scroll it programmatically, so a deep focus shifted the
 * whole canvas (header + sidebar top off-screen) with no mouse-wheel way back, which reads as "the
 * page is cut off". `relative` on the two scroll containers makes them the containing block, so the
 * absolute boxes scroll and clip WITH their container.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LAYOUT = fs.readFileSync(path.resolve(__dirname, '../app/layout.tsx'), 'utf8');
const SIDEBAR = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');

describe('app shell — scroll containers contain absolute descendants', () => {
  it('<main> is a positioned scroll container', () => {
    expect(LAYOUT).toContain('<main className="relative min-w-0 flex-1 overflow-y-auto pb-1">');
  });

  it('sidebar <nav> is a positioned scroll container', () => {
    expect(SIDEBAR).toContain(
      'className="relative flex w-full flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden py-3"',
    );
  });

  it('the shell still pins the canvas (body stays h-dvh overflow-hidden)', () => {
    // If this ever changes to a document-scrolling layout, the two assertions above become moot —
    // whoever relaxes this should rethink scroll containment as a whole, not just delete this test.
    expect(LAYOUT).toContain('h-dvh overflow-hidden');
  });
});
