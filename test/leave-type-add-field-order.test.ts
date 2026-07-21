/**
 * Add Leave Type form — Leave Unit before Paid, Paid as a captioned Field (feedback dc3ec3c6).
 *
 * Reported defect: in the create-leave-type row (app/admin/leave/entitlements/page.tsx) the Paid tick-box sat
 * wedged between the Status and Leave Unit dropdowns, and it was the only control in the row without the small
 * grey caption above it (it used a bare inline <label>).
 *
 * The fix swaps the two fields (row now ends Status → Leave Unit → Paid) and upgrades Paid to the same
 * <Field> + justify-self-end + explicit aria-label pattern the edit form already uses
 * (components/leave-type-panel.tsx). FormData lookup is name-keyed, so DOM order changes nothing about what
 * createLeaveTypeAction reads — this is guarded statically (the repo convention for UI-only changes in this
 * feature area; see test/leave-type-edit-layout.test.ts, whose form-slicing helper this file mirrors).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

/** Isolate the create-leave-type <form> (keyed by its action). The page contains other forms (and the string
 *  "leaveUnit" appears elsewhere, e.g. as a LeaveTypePanel prop), so a whole-file indexOf would pass whether
 *  or not the change was made — form isolation is mandatory. */
function createForm(): string {
  const marker = pageSrc.indexOf('action={createLeaveTypeAction}');
  expect(marker).toBeGreaterThan(-1);
  const formStart = pageSrc.lastIndexOf('<form', marker);
  const formEnd = pageSrc.indexOf('</form>', marker);
  expect(formStart).toBeGreaterThan(-1);
  expect(formEnd).toBeGreaterThan(formStart);
  return pageSrc.slice(formStart, formEnd + '</form>'.length);
}

describe('dc3ec3c6 · Add Leave Type form field order (Leave Unit → Paid) + captioned Paid', () => {
  const form = createForm();

  it('orders Leave Unit before Paid', () => {
    const unitIdx = form.indexOf('name="leaveUnit"');
    const paidIdx = form.indexOf('name="paid"');
    expect(unitIdx).toBeGreaterThan(-1);
    expect(paidIdx).toBeGreaterThan(-1);
    expect(unitIdx).toBeLessThan(paidIdx);
  });

  it('keeps the six-column grid container', () => {
    const openTag = form.slice(0, form.indexOf('>'));
    void openTag; // className may sit on a following line inside the tag; check the pre-first-Field region.
    const attrsRegion = form.slice(0, form.indexOf('<Field'));
    const classMatch = attrsRegion.match(/className="([^"]*)"/);
    expect(classMatch, 'form container className present').not.toBeNull();
    expect(classMatch![1]).toMatch(/sm:grid-cols-6/);
  });

  it('keeps Leave Unit in column 5 and Paid in column 6 (positional, not just textual, order)', () => {
    // Exactly four named fields precede Leave Unit, with Status (name="active") the last of them. The
    // requirement is POSITIONAL — insert any field before the pair and they land on different grid rows even
    // though a bare ordering check would stay green.
    const names = [...form.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['code', 'name', 'description', 'active', 'leaveUnit', 'paid']);
  });

  it('gives Paid the captioned Field wrapper, right-aligned, with an explicit aria-label', () => {
    const paidIdx = form.indexOf('name="paid"');
    const fieldTagStart = form.lastIndexOf('<Field', paidIdx);
    expect(fieldTagStart).toBeGreaterThan(-1);
    const fieldTag = form.slice(fieldTagStart, form.indexOf('>', fieldTagStart));
    expect(fieldTag).toContain("label={t('paidLabel')}");
    expect(fieldTag).toMatch(/justify-self-end/);
    // The checkbox itself: explicit accessible name (it no longer sits inside a bare wrapping <label>).
    const paidInput = form.slice(form.lastIndexOf('<input', paidIdx), form.indexOf('/>', paidIdx) + 2);
    expect(paidInput).toMatch(/aria-label=\{t\('paidLabel'\)\}/);
    // defaultChecked survives the restructure — dropping it would flip the default for every new type.
    expect(paidInput).toMatch(/defaultChecked/);
  });
});
