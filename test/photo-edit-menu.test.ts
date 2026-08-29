/**
 * dc23d3b6 — Profile-photo UI redesign (static-source guard).
 *
 * The admin photo controls on the Personnel detail header used to sit permanently under the avatar
 * (a file input + Upload/Replace submit, plus a Remove form). This item hides them behind a small
 * pencil/Edit trigger (components/photo-edit-menu.tsx, a 'use client' island) and adds a confirm
 * before REPLACING an existing photo. Photo storage / 2 MB limit / admin-only permissions unchanged
 * (test/person-photo.test.ts proves the server-action + RLS layer independently).
 *
 * This guard is DB-free / jsdom-free so it runs fast and deterministically. It fails loudly if a future
 * edit (a) drops the Edit island so the controls are permanently visible again, (b) removes the
 * replace-confirm, (c) breaks the RSC boundary by making the island a server function, or (d) drops one
 * of the new i18n keys from any of the 6 locales.
 *
 * r227 ADDS A FIFTH THING IT CANNOT SEE BY RENDERING, ONLY BY READING: WHERE THE PANEL IS POSITIONED.
 * The popover was `absolute`, so <main>'s `overflow-y-auto` (a non-visible overflow on one axis computes
 * the OTHER axis to `auto` too) CLIPPED it — measured in Chromium at ~43px off the panel's LEFT end, at
 * every width where the profile header lays out as a row, which takes the left end of every button in it.
 * The fix portals the panel to document.body and positions it `fixed` from a measured, viewport-clamped
 * trigger rect, exactly as r206 / 65e2d5de did for app/payroll/row-actions.tsx. Neither jsdom (no layout,
 * no CSS) nor a 200 from the page can show that regressing, so it is pinned here as source assertions —
 * the same way the row-actions fix is pinned. Delete these and the clipping comes back silently.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const PAGE = 'app/admin/personnel/[employmentId]/page.tsx';
const ISLAND = 'components/photo-edit-menu.tsx';
const LOGO = 'components/company-logo.tsx';
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('Photo edit menu: controls live behind the Edit trigger', () => {
  const page = read(PAGE);
  const island = read(ISLAND);

  it('the island is a client component that only toggles visibility (no server export)', () => {
    expect(island.trimStart().startsWith("'use client'")).toBe(true);
    // Renders a pencil trigger + accepts the forms as children (built by the page).
    expect(island).toMatch(/Pencil/);
    expect(island).toMatch(/children/);
    // Toggle-only: it holds open state, it does NOT bind either photo server action itself.
    expect(island).toMatch(/useState/);
    expect(island.includes('setPersonPhotoAction')).toBe(false);
    expect(island.includes('removePersonPhotoAction')).toBe(false);
  });

  it('the page renders PhotoEditMenu as JSX (RSC boundary: rendered, never called)', () => {
    expect(page).toMatch(/import\s*\{\s*PhotoEditMenu\s*\}\s*from\s*'@\/components\/photo-edit-menu'/);
    expect(page).toMatch(/<PhotoEditMenu\b/);
    // Uppercase component name → never called as a function (rsc-boundary-guard covers the general case).
    expect(page.includes('PhotoEditMenu(')).toBe(false);
  });

  it('both photo forms are now nested inside the Edit menu, not permanently visible', () => {
    // The forms must appear AFTER the <PhotoEditMenu opening tag and BEFORE its close.
    const open = page.indexOf('<PhotoEditMenu');
    const close = page.indexOf('</PhotoEditMenu>');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const menuBody = page.slice(open, close);
    expect(menuBody.includes('action={setPersonPhotoAction}')).toBe(true);
    expect(menuBody.includes('action={removePersonPhotoAction}')).toBe(true);
  });

  it('replacing an existing photo prompts via ConfirmSubmit; first-time upload does not', () => {
    // photoExists ? <ConfirmSubmit ... photoReplaceConfirm ...> : plain Upload button
    expect(page).toMatch(/photoExists \? \(\s*<ConfirmSubmit/);
    expect(page.includes("description={t('photoReplaceConfirm')}")).toBe(true);
    // The no-photo branch keeps a direct submit (no confirm) for the first upload.
    expect(page).toMatch(/\) : \(\s*<button[^>]*>\{t\('photoUpload'\)\}<\/button>/);
  });

  it('remove still confirms and photo storage limits are untouched', () => {
    expect(page.includes("description={t('photoRemoveConfirm')}")).toBe(true);
    // accept + required file input preserved (2 MB / mime enforcement lives server-side, unchanged).
    expect(page.includes('accept="image/png,image/jpeg"')).toBe(true);
    expect(page).toMatch(/type="file"[\s\S]*?required/);
  });
});

describe('Photo edit menu: the panel escapes the scroll container (r227)', () => {
  const island = read(ISLAND);
  const page = read(PAGE);
  const logo = read(LOGO);

  it('portals the panel out of the page, so no scrolling ancestor can clip it', () => {
    expect(island).toMatch(/import\s*\{\s*createPortal\s*\}\s*from\s*'react-dom'/);
    expect(island, 'the open panel is rendered through the portal').toMatch(/createPortal\(/);
    expect(island, 'portalled to the document, not to some inner container').toContain('document.body');
  });

  it('is positioned FIXED from a measured trigger rect, not absolutely inside the header', () => {
    expect(island, 'the trigger is measured').toContain('getBoundingClientRect');
    expect(island, 'the panel is fixed').toMatch(/className="fixed z-50 /);
    // The exact shape that was being trimmed: a centre-anchored ABSOLUTE panel. If this comes back, so
    // does the bug — nothing else in this file would notice.
    expect(island, 'no absolute centre-anchored panel').not.toMatch(/absolute left-1\/2/);
    expect(island).not.toMatch(/-translate-x-1\/2/);
  });

  it('clamps itself inside the viewport at any width, including one narrower than the panel', () => {
    expect(island, 'width cap for a viewport narrower than 14rem').toContain('max-w-[calc(100vw-1rem)]');
    expect(island, 'the right edge is clamped against the viewport').toContain('window.innerWidth');
    // Clamp ORDER is the assertion, not decoration: Math.min against the right edge FIRST and the
    // Math.max floor SECOND. The other order returns a negative left once the viewport is narrower than
    // the panel — which is exactly the case this item is about.
    expect(island).toMatch(/Math\.max\(EDGE, Math\.min\(/);
    expect(island, 'and it flips above the trigger rather than off the bottom').toContain('flip');
    expect(island).toContain('translateY(-100%)');
  });

  it('follows the trigger on scroll and resize, in the CAPTURE phase', () => {
    // A fixed box does not travel with the page, so the open-time coordinates go stale on any scroll.
    // Capture phase because the scroll that matters is <main>'s own, and scroll events do not bubble.
    expect(island).toMatch(/addEventListener\('scroll'[\s\S]{0,60}capture: true/);
    expect(island).toMatch(/addEventListener\('resize'/);
    expect(island).toMatch(/removeEventListener\('scroll'[\s\S]{0,60}capture: true/);
  });

  it('a scroll RE-PLACES the panel; it must not close it, or the picked file dies with the form', () => {
    // PayrollRowActions closes on any scroll — it holds links. This panel holds a <form> with a file
    // input, and closing unmounts the children (see the island's docblock + company-logo-edit.dom.test).
    expect(island).toMatch(/const sync = \(\) => place\(\)/);
    expect(island, 'the scroll handler is not a close').not.toMatch(/const sync = \(\) => setAt\(null\)/);
  });

  it('BOTH mount sites inherit the fix, because neither positions the panel itself', () => {
    // The island is shared by the Personnel employee header and the company logo editor, under the same
    // scrolling ancestor (app/layout.tsx's <main>). It cannot be repositioned for one caller alone, and a
    // second, per-caller positioning implementation is the thing to prevent.
    expect(logo).toContain("from './photo-edit-menu'");
    expect(logo).toContain('<PhotoEditMenu');
    expect(logo, 'the logo editor does not place a panel of its own').not.toContain('createPortal');
    expect(logo).not.toContain('getBoundingClientRect');
    expect(page).toMatch(/<PhotoEditMenu\b/);
    // Inside the Personnel mount the children are forms and nothing else — no positioning of their own.
    const menuBody = page.slice(page.indexOf('<PhotoEditMenu'), page.indexOf('</PhotoEditMenu>'));
    expect(menuBody, 'no per-caller positioning in the Personnel mount').not.toMatch(/\babsolute\b|\bfixed\b/);
  });
});

describe('Photo edit menu: i18n keys present in all 6 locales', () => {
  for (const loc of LOCALES) {
    it(`${loc}.json has photoEdit + photoReplaceConfirm under people.detail`, () => {
      const msgs = JSON.parse(read(`messages/${loc}.json`)) as {
        people: { detail: Record<string, string> };
      };
      const d = msgs.people.detail;
      expect(typeof d.photoEdit).toBe('string');
      expect(d.photoEdit.length).toBeGreaterThan(0);
      expect(typeof d.photoReplaceConfirm).toBe('string');
      expect(d.photoReplaceConfirm.length).toBeGreaterThan(0);
    });
  }
});
