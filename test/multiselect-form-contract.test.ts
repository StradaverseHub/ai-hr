/**
 * 2449fbb7 — Standardize multi-select dropdown auto-close: the shared MultiSelectPopover's FORM CONTRACT.
 *
 * The Run Earned Accrual pickers and the Festive Grant company picker are consolidated into
 * components/ui/multi-select-popover.tsx, which closes on outside click via a document mousedown
 * listener (no <label> wrapper, no full-viewport backdrop — see the component docblock for the
 * label-activation root cause).
 *
 * The suite has no DOM runner (vitest.config.ts: no jsdom), so click-outside behaviour itself is
 * browser-verified, not unit-tested. What this file locks is the one contract a regression would
 * silently break in production: Festive Grant posts its companies via hidden inputs that MUST be
 * rendered OUTSIDE the `open` conditional. Before this change, the per-company checkboxes carried
 * name="companyIds" and only existed while the panel was mounted — the form worked purely because
 * the close-then-reopen bug kept the panel open at submit time. The moment outside-click actually
 * closes the panel, only the always-mounted hidden inputs stand between a valid selection and
 * grantAdHocLeaveMulti throwing "Select at least one company." on every grant.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const POPOVER = 'components/ui/multi-select-popover.tsx';
const FESTIVE = 'components/festive-grant-card.tsx';
const EARNED = 'components/earned-accrual-card.tsx';

describe('2449fbb7 · MultiSelectPopover form contract', () => {
  const popover = read(POPOVER);
  const festive = read(FESTIVE);
  const earned = read(EARNED);

  it('the shared component exists and is a client leaf', () => {
    expect(popover.trimStart().startsWith("'use client'")).toBe(true);
  });

  it('emits one hidden <input name={name}> per selected id, OUTSIDE the open conditional', () => {
    expect(popover).toMatch(/type="hidden" name=\{name\} value=\{id\}/);
    // Source-order proof that the hidden inputs are NOT gated on the panel being open: the hidden-input
    // block must appear BEFORE the `{open &&` conditional. If someone moves the inputs inside the panel,
    // closing the dropdown would unmount them and every Festive Grant submit would hard-fail server-side
    // while the trigger still reads "N selected".
    const hiddenAt = popover.indexOf('type="hidden"');
    const openGuardAt = popover.indexOf('{open &&');
    expect(hiddenAt).toBeGreaterThan(-1);
    expect(openGuardAt).toBeGreaterThan(-1);
    expect(hiddenAt, 'hidden inputs must render before (outside) the {open && panel guard').toBeLessThan(
      openGuardAt,
    );
  });

  it('FestiveGrantCard wires the posted field name into the shared component', () => {
    // This is the single assertion standing between this change and a broken write path:
    // app/admin/actions.ts reads formData.getAll('companyIds') and grantAdHocLeaveMulti throws on empty.
    expect(festive).toMatch(/import \{ MultiSelectPopover \} from '\.\/ui\/multi-select-popover'/);
    expect(festive).toMatch(/name="companyIds"/);
    // The visible checkboxes are presentation-only now — no checkbox carries the posted name.
    expect(festive).not.toMatch(/type="checkbox"\s+name="companyIds"/);
  });

  it('both cards consume the shared component (the two local copies are gone)', () => {
    expect(earned).toMatch(/import \{ MultiSelectPopover \} from '\.\/ui\/multi-select-popover'/);
    expect(earned).not.toMatch(/function MultiSelect\(/);
    // Earned Accrual posts a plain JS scope object (not FormData), so nothing in the card carries a
    // form field name — in particular no name prop on its popovers (stray hidden inputs would be
    // harmless today but would misdocument the contract).
    expect(earned).not.toMatch(/\bname=/);
  });

  it('stays presentation-only: all copy arrives translated via props (i18n static-key contract)', () => {
    expect(popover).not.toMatch(/useTranslations|next-intl/);
  });
});
