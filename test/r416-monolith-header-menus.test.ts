/**
 * r416 — "Seems like I can't log out or change company after the new theme."
 *
 * Reproduced in Chromium (Monolith, 1440 and 390): the header's `monolith-rv` reveal keeps a transform on
 * <header>, which makes it a stacking context, so the company menu and the account menu (z-50 INSIDE it)
 * were painted UNDER <main>. The page showed through the company list and, on a phone, "Customize
 * Dashboard" sat on top of "Log out" and took the tap. Separately, on a phone the company switcher was
 * crushed to 0px by the top line's other children. After the fix, both menus and "Log out" are the
 * elements hit at their own centres (scratchpad r416/click2.mjs; the same script failed before the fix).
 *
 * These pins keep the two fixes in place: the header's own stacking context sits above <main> in
 * Monolith, and the switcher keeps a minimum width there. Classic's classes are untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('r416 · the Monolith header menus are painted above the page', () => {
  it('the header raises its own stacking context above <main> in Monolith', () => {
    const layout = read('app/layout.tsx');
    const start = layout.indexOf('<header className="grid h-16');
    const end = layout.indexOf('">', start);
    expect(start, 'the shell header was found').toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const cls = layout.slice(start, end);
    expect(cls.length, 'the header class string is substantial').toBeGreaterThan(200);
    expect(cls).toContain('monolith-rv');
    expect(cls).toContain('monolith:relative');
    expect(cls).toContain('monolith:z-30');
    // Classic's own classes carry no z-index of their own here: the fix is Monolith-only.
    expect(cls.split(/\s+/).filter((t) => /^z-/.test(t))).toEqual([]);
  });

  it('the company switcher keeps a minimum width in Monolith, so a phone can still tap it', () => {
    const src = read('components/company-switcher.tsx');
    expect(src).toContain('<div className="relative min-w-0 monolith:min-w-[5.5rem]">');
  });
});
