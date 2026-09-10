/**
 * Edit Leave Code (feedback 37a49524).
 *
 * Reported defect: opening a leave type's edit form hid the Leave Code entirely (it only showed as small
 * grey text on the collapsed row). expected_behavior accepts a read-only display fallback when codes are not
 * editable. Leave codes ARE immutable by design — the code (e.g. ANNUAL) is the permanent semantic key the
 * leave/payroll engine matches on for EA-1955 statutory rules, carry-forward and encashment; renaming it would
 * silently switch those rules off. So the fix surfaces the code as an explicitly read-only field in the edit
 * (identity) sub-form.
 *
 * This is a frontend + i18n change only (no service write), so this guards the two load-bearing invariants
 * statically: (1) the read-only Code field lives inside the identity edit form and posts nothing new to the
 * server (no `name` attr ⇒ action/substrate untouched, still read-only at every layer), and (2) the
 * explanatory hint string exists in all six locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. `components/leave-type-panel.tsx` (3,367 lines)
 * was DELETED with the page that mounted it: the four steps and six sub-steps it carried are the FIVE
 * TABS of `/admin/leave-config/types` (IA §2), which is what this whole item was raised about. The panel
 * became three files, so what this guard scans is their concatenation — the property it pins is about the
 * leave TYPE screen, not about one filename, and pinning it to a file that no longer exists would have
 * taken the guard out rather than moved it.
 */
const LEAVE_TYPE_SCREEN = [
  'app/admin/leave-config/types/page.tsx',
  'app/admin/leave-config/types/leave-type-tabs.tsx',
  'app/admin/leave-config/types/leave-type-sub-forms.tsx',
];
const panelSrc = LEAVE_TYPE_SCREEN.map((f) => readFileSync(resolve(here, '..', f), 'utf8')).join('\n');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('Edit Leave Code (37a49524) — read-only display in the edit form', () => {
  it('renders the Code as a read-only field labelled by admin.leave.codeLabel', () => {
    // The identity edit sub-form is keyed by the `identity` marker input.
    const formStart = panelSrc.indexOf('name="identity"');
    expect(formStart).toBeGreaterThan(-1);
    const formEnd = panelSrc.indexOf('</form>', formStart);
    const identityForm = panelSrc.slice(formStart, formEnd);

    // A Code field, bound to the passed `code`, labelled with the existing codeLabel key, marked read-only.
    expect(identityForm).toMatch(/t\('codeLabel'\)/);
    expect(identityForm).toMatch(/value=\{code\}/);
    expect(identityForm).toMatch(/readOnly/);
  });

  it('posts NOTHING new for the code (no name attr) so the server action + substrate stay untouched', () => {
    // Isolate the read-only code <input> and assert it has no `name=` attribute — the reason renaming stays
    // impossible at the server layer and no DomainEvent semantics change.
    const anchor = panelSrc.indexOf('value={code}');
    expect(anchor).toBeGreaterThan(-1);
    // Find the enclosing <input ... /> around the anchor.
    const inputStart = panelSrc.lastIndexOf('<input', anchor);
    const inputEnd = panelSrc.indexOf('/>', anchor);
    const codeInput = panelSrc.slice(inputStart, inputEnd + 2);
    expect(codeInput).toMatch(/readOnly/);
    expect(codeInput).not.toMatch(/\sname=/);
    // Still surfaces the code, so the reporter's "display read-only so users can view it" is satisfied.
    expect(codeInput).toMatch(/value=\{code\}/);
  });

  it('has the immutability hint (codeReadOnlyHint) in every locale', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const hint = msgs?.admin?.leave?.codeReadOnlyHint;
      expect(typeof hint, `${loc}.admin.leave.codeReadOnlyHint`).toBe('string');
      expect((hint as string).length, `${loc} hint non-empty`).toBeGreaterThan(0);
    }
  });
});
