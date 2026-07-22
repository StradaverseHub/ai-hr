/**
 * Expand Description Field Width in Add Leave Type Form (feedback 750732c3).
 *
 * Reported defect: in the create-leave-type row (app/admin/leave/entitlements/page.tsx) every field got an
 * equal 1/6 slice of the sm+ grid, so the Description box — meant for a sentence or two — was as narrow as the
 * short Code input while the row around it looked half-empty.
 *
 * The fix is UI-only, exactly two class additions:
 *   - the Description <Field> wrapper gains sm:col-span-3, so row 1 becomes Code (1) + Name (1) +
 *     Description (3) + Status (1) = 6 columns and Description is visibly 3x the other fields
 *   - the Add button gains sm:col-start-6 (alongside btnPrimary), right-anchoring the primary action on row 2
 *     under Status instead of leaving columns 3-6 of that row empty
 * Row 2 therefore reads Leave Unit (col 1), Paid (col 2), Add (col 6). NOTE: the source order stays the
 * dc3ec3c6-pinned Leave Unit → Paid (test/leave-type-add-field-order.test.ts asserts the exact name sequence);
 * the plan's draft narrative predated that swap. On mobile the container's grid-cols-1 stacks everything
 * full-width, unchanged.
 *
 * No field, name attr, server action or substrate changed — so this guards the layout invariants statically
 * (the repo convention for UI-only changes in this feature area; see test/leave-type-edit-layout.test.ts,
 * whose form-slicing helper this file mirrors).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

/** Isolate the create-leave-type <form> with an ANCHORED slice (keyed by its action). The page contains other
 *  forms — an unanchored lastIndexOf('<form') would grab the later setCompanyLeaveCycleAction form — so the
 *  slice anchors on the action marker first, exactly like leave-type-edit-layout.test.ts. */
function createForm(): string {
  const marker = pageSrc.indexOf('action={createLeaveTypeAction}');
  expect(marker).toBeGreaterThan(-1);
  const formStart = pageSrc.lastIndexOf('<form', marker);
  const formEnd = pageSrc.indexOf('</form>', marker);
  expect(formStart).toBeGreaterThan(-1);
  expect(formEnd).toBeGreaterThan(formStart);
  return pageSrc.slice(formStart, formEnd + '</form>'.length);
}

describe('750732c3 · Add Leave Type form layout — wide Description + right-anchored Add', () => {
  const form = createForm();

  it('keeps the responsive grid container: mobile single-column stack, six columns at sm+', () => {
    // className may sit on a following line inside the <form ...> tag; check the pre-first-Field region.
    const attrsRegion = form.slice(0, form.indexOf('<Field'));
    const classMatch = attrsRegion.match(/className="([^"]*)"/);
    expect(classMatch, 'form container className present').not.toBeNull();
    const containerClass = classMatch![1];
    expect(containerClass).toMatch(/\bgrid\b/);
    // grid-cols-1 is the mobile-stack promise — on a phone the boxes stack one per line exactly as before.
    expect(containerClass).toMatch(/\bgrid-cols-1\b/);
    expect(containerClass).toMatch(/sm:grid-cols-6/);
    expect(containerClass).toMatch(/\bitems-end\b/);
    expect(containerClass).toMatch(/\bgap-3\b/);
  });

  it('makes the Description Field span 3 of the 6 columns (3x the other fields)', () => {
    const descLabelIdx = form.indexOf("t('descriptionLabel')");
    expect(descLabelIdx).toBeGreaterThan(-1);
    const fieldTagStart = form.lastIndexOf('<Field', descLabelIdx);
    expect(fieldTagStart).toBeGreaterThan(-1);
    const fieldTag = form.slice(fieldTagStart, form.indexOf('>', fieldTagStart));
    expect(fieldTag).toMatch(/sm:col-span-3/);
  });

  it('keeps the Description textarea multiline, fluid and vertically resizable (fbcadc71)', () => {
    const taStart = form.indexOf('name="description"');
    expect(taStart).toBeGreaterThan(-1);
    const taBlock = form.slice(taStart, form.indexOf('/>', taStart) + 2);
    expect(taBlock).toMatch(/rows=\{3\}/);
    expect(taBlock).toMatch(/resize-y/);
    // inputCls contains w-full, so the textarea fills the wider 3-column cell automatically.
    expect(taBlock).toMatch(/inputCls/);
  });

  it('keeps row 1 in order: Code, Name, the wide Description, then Status', () => {
    const codeIdx = form.indexOf('name="code"');
    const nameIdx = form.indexOf('name="name"');
    const descIdx = form.indexOf('name="description"');
    const statusIdx = form.indexOf('name="active"');
    expect(codeIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeGreaterThan(codeIdx);
    expect(descIdx).toBeGreaterThan(nameIdx);
    expect(statusIdx).toBeGreaterThan(descIdx);
    // Status is the select posting name="active".
    const statusBlock = form.slice(form.lastIndexOf('<select', statusIdx), form.indexOf('</select>', statusIdx));
    expect(statusBlock).toContain('name="active"');
  });

  it('opens row 2 with Leave Unit then Paid, and right-anchors the Add button in column 6', () => {
    // Source order is the dc3ec3c6-pinned Leave Unit → Paid (see test/leave-type-add-field-order.test.ts).
    const unitIdx = form.indexOf('name="leaveUnit"');
    const paidIdx = form.indexOf('name="paid"');
    const buttonIdx = form.indexOf('<button');
    expect(unitIdx).toBeGreaterThan(-1);
    expect(paidIdx).toBeGreaterThan(unitIdx);
    expect(buttonIdx).toBeGreaterThan(paidIdx);
    // The primary action carries btnPrimary AND sm:col-start-6 — the tidy-second-row promise, tested not narrated.
    const buttonTag = form.slice(buttonIdx, form.indexOf('>', buttonIdx));
    expect(buttonTag).toMatch(/btnPrimary/);
    expect(buttonTag).toMatch(/sm:col-start-6/);
  });

  it('keeps every posted field name — validations and data-saving behaviour unchanged', () => {
    for (const name of ['code', 'name', 'description', 'active', 'paid', 'leaveUnit']) {
      expect(form).toContain(`name="${name}"`);
    }
  });
});
