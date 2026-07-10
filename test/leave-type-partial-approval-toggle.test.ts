/**
 * Partial Leave Approval admin toggle (ac6c2025 · re-add of the removed enable switch).
 *
 * The per-date (partial) approval MODAL is already shipped (ADR-0068 / R18). What was missing after feedback
 * 9d8cf621 was the HR-facing enable TOGGLE in components/leave-type-panel.tsx — the sub-form that flips a leave
 * type's per_date_approval flag on/off. This item re-adds that sub-form. The sub-form is a client component
 * (not directly unit-testable here), but its correctness rests on two contracts we CAN assert end-to-end:
 *
 *   1. The read layer (listLeaveTypes) must project `perDateApproval` AND `counting`, or the re-added checkbox
 *      renders unchecked / the greyed ineligibility note misfires on every reload ("my setting didn't save").
 *   2. The sub-form posts a `partialApproval=1` marker + `perDateApproval` checkbox into updateLeaveType, which
 *      persists it as a tri-state (set when the marker is present, untouched otherwise). This mirrors exactly
 *      what the form's hidden field + checkbox produce.
 *
 * Together these guard the round-trip the toggle depends on. (The tri-state edge cases themselves are also
 * covered in leave-backdating.test.ts — this file pins the read-projection the UI consumes.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes } from '../core/read';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('per-date-approval admin toggle — read projection + tri-state round-trip', () => {
  it('listLeaveTypes projects perDateApproval and counting so the toggle + greyed note round-trip', async () => {
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) {
      // The re-added checkbox binds defaultChecked={perDateApproval}; a missing projection ⇒ always unchecked.
      expect(typeof t.perDateApproval).toBe('boolean');
      // The greyed "won't apply" note keys off counting !== 'working_days'; a missing projection ⇒ note misfires.
      expect(typeof t.counting).toBe('string');
    }
  });

  it('enabling the toggle (marker present) sets the flag; a save without the marker leaves it untouched', async () => {
    const [seed] = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    // Mirror the sub-form posting partialApproval=1 + perDateApproval checked ⇒ updateLeaveType receives true.
    await updateLeaveType(adminCtx(b), { id: seed.id, name: seed.name, perDateApproval: true });
    const afterEnable = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === seed.id);
    expect(afterEnable?.perDateApproval).toBe(true);

    // A different sub-form save that omits the marker ⇒ perDateApproval undefined ⇒ flag must NOT be cleared.
    await updateLeaveType(adminCtx(b), { id: seed.id, name: `${seed.name} v2` });
    const afterRename = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === seed.id);
    expect(afterRename?.perDateApproval).toBe(true);

    // Unchecking (marker present, box off) ⇒ perDateApproval false ⇒ flag cleared.
    await updateLeaveType(adminCtx(b), { id: seed.id, name: `${seed.name} v2`, perDateApproval: false });
    const afterDisable = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === seed.id);
    expect(afterDisable?.perDateApproval).toBe(false);
  });
});
