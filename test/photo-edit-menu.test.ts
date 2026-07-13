/**
 * dc23d3b6 — Profile-photo UI redesign (static-source guard).
 *
 * The admin photo controls on the Personnel detail header used to sit permanently under the avatar
 * (a file input + Upload/Replace submit, plus a Remove form). This item hides them behind a small
 * pencil/Edit trigger (components/photo-edit-menu.tsx, a 'use client' island) and adds a confirm
 * before REPLACING an existing photo. Photo storage / 2 MB limit / admin-only permissions unchanged
 * (test/person-photo.test.ts proves the server-action + RLS layer independently).
 *
 * This guard is DB-free / jsdom-free (the suite has no DOM runner) so it runs fast and deterministically.
 * It fails loudly if a future edit (a) drops the Edit island so the controls are permanently visible
 * again, (b) removes the replace-confirm, (c) breaks the RSC boundary by making the island a server
 * function, or (d) drops one of the new i18n keys from any of the 6 locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const PAGE = 'app/admin/personnel/[employmentId]/page.tsx';
const ISLAND = 'components/photo-edit-menu.tsx';
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
