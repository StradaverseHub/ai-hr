/**
 * Benefit scheme delete placement (feedback b7d04d7d): the scheme Delete action lives on the table ROW
 * (next to Edit) behind a ConfirmSubmit confirmation, and the SchemeEditDialog is purely for editing —
 * no delete inside. Before this change the ONLY delete surface was an unconfirmed one-click button inside
 * the edit dialog, and deleting a scheme cascades away every scheme_leave_entitlement row under it.
 *
 * This is a DB-free static-source guard (same style as `test/statutory-my-layout.test.ts`). It fails
 * loudly if a future edit (a) removes the row-level delete or its confirmation, (b) reintroduces a
 * delete inside SchemeEditDialog, or (c) drops the scheme-name/entitlement-count interpolation that
 * tells the admin what the cascade actually removes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(root + 'components/benefit-scheme-config.tsx', 'utf8');

// The edit dialog's source region: from its function declaration to the next top-level component.
const dialogStart = src.indexOf('function SchemeEditDialog');
const dialogEnd = src.indexOf('function CopyEntitlementsDialog');
const dialogSrc = src.slice(dialogStart, dialogEnd);

describe('benefit scheme delete placement (b7d04d7d)', () => {
  it('locates the SchemeEditDialog source region', () => {
    expect(dialogStart).toBeGreaterThan(-1);
    expect(dialogEnd).toBeGreaterThan(dialogStart);
  });

  it('renders the delete form on the scheme row, outside the edit dialog', () => {
    const rowDelete = src.indexOf('action={actions.deleteScheme}');
    expect(rowDelete).toBeGreaterThan(-1);
    // The row delete lives in BenefitSchemeConfig's scheme table, BEFORE the dialog component.
    expect(rowDelete).toBeLessThan(dialogStart);
  });

  it('wraps the row delete in a ConfirmSubmit confirmation naming the scheme and its entitlement count', () => {
    const rowDelete = src.indexOf('action={actions.deleteScheme}');
    const region = src.slice(rowDelete, rowDelete + 900);
    expect(region.includes('<ConfirmSubmit')).toBe(true);
    expect(region.includes("t('deleteSchemeConfirmTitle')")).toBe(true);
    expect(region.includes("t('deleteSchemeConfirmDescription'")).toBe(true);
    // The description must say WHAT is lost: the scheme name + how many entitlements cascade with it.
    expect(region.includes('name: s.name')).toBe(true);
    expect(region.includes('entCountByScheme.get(s.id)')).toBe(true);
  });

  it('SchemeEditDialog carries no delete — editing and deleting are separate surfaces', () => {
    expect(dialogSrc.includes('deleteScheme')).toBe(false);
    expect(dialogSrc.includes("t('delete')")).toBe(false);
    // The footer keeps Cancel.
    expect(dialogSrc.includes("t('cancel')")).toBe(true);
  });

  it('the confirm keys exist in all six locales with the {name}/{count} placeholders', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const messages = JSON.parse(readFileSync(`${root}messages/${loc}.json`, 'utf8')) as {
        admin: { benefitScheme: Record<string, string> };
      };
      const bs = messages.admin.benefitScheme;
      expect(bs.deleteSchemeConfirmTitle, `${loc}: deleteSchemeConfirmTitle`).toBeTruthy();
      expect(bs.deleteSchemeConfirmDescription, `${loc}: deleteSchemeConfirmDescription`).toBeTruthy();
      expect(bs.deleteSchemeConfirmDescription.includes('{name}'), `${loc}: {name} placeholder`).toBe(true);
      expect(bs.deleteSchemeConfirmDescription.includes('{count'), `${loc}: {count} placeholder`).toBe(true);
    }
  });
});
