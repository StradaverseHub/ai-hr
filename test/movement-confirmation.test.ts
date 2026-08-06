/**
 * 3ced1040 — "Configure Confirmation Event Similar to Promotion Event".
 *
 * WHAT WAS WRONG. Confirmation was a LIFECYCLE kind: it recorded the confirmation date and nothing else.
 * HR confirming a probationer who was also getting a rise had to key the confirmation here and the salary
 * on another screen, which left two marks on the record for one decision. Promotion had the shape the
 * reporter wanted all along — the Current/After grid, one diff-driven writer, one history row — so
 * Confirmation simply joins COMPARISON_KINDS and inherits it.
 *
 * The four properties this suite pins, all of them named in the approved plan:
 *   • ONE history row for one decision, whatever mix of fields moved with it, and the employee's derived
 *     status flips Probation → Confirmed because the date is written (there is no status column);
 *   • a confirmation with NO other change still saves — the confirmation IS the change — while a genuine
 *     no-op (re-confirming on the date already stored) is still refused by MovementNoChangeError;
 *   • future dating now behaves like Promotion's: held as a pending intent and applied on the morning of
 *     its date. That is a BEHAVIOUR CHANGE from "stored the moment you save it" and is disclosed as such;
 *   • it can be ROLLED BACK, clearing the confirmation date with the rest of the legs. Reversal is where a
 *     new leg is most likely to be forgotten, and a Confirmation that could not be undone would be the one
 *     comparison movement with no way to correct a mistake.
 *
 * And the boundary that is NOT crossed: Confirmation is a comparison kind for FORM AND WRITER purposes
 * only. It stays out of INTERCHANGEABLE_COMPARISON_KINDS, so no tenant can mint an event type that
 * completes probation and no correction can turn a Transfer into one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { setCompensation } from '../core/comp';
import { createJobGrade } from '../core/admin';
import {
  COMPARISON_KINDS,
  INTERCHANGEABLE_COMPARISON_KINDS,
  createMovementEvent,
  editMovementEvent,
  movementHistory,
  MovementNoChangeError,
  MovementNotCorrectableError,
  reverseMovementEvent,
} from '../core/movement';
import { CONFIGURABLE_BEHAVIOUR_KINDS } from '../core/movement-type';
import { sweepDueMovements } from '../core/movement-apply';
import { deriveEmploymentStatus } from '../core/employment-status';
import { todayInKualaLumpur } from '../lib/hr-date';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `mcf_${randomUUID().slice(0, 8)}@t.local`;

/** ISO date + n days, pure UTC string maths (the codebase's dayBefore/plusDays convention). */
function plusDays(iso: string, n: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

const TODAY = todayInKualaLumpur();
const FUTURE = plusDays(TODAY, 30);
const PAST = plusDays(TODAY, -30);

async function hireOne() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Confirmation Subject', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

/** The lifecycle dates the derived Employee Status is a pure function of. */
async function employmentRow(employmentId: string) {
  const [row] = await owner.db
    .select({
      confirmationDate: schema.employment.confirmationDate,
      finalConfirmationDate: schema.employment.finalConfirmationDate,
      extendedConfirmationDate: schema.employment.extendedConfirmationDate,
      gradeId: schema.employment.gradeId,
      orgDivision: schema.employment.orgDivision,
    })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1);
  return row;
}

async function openCompensation(employmentId: string) {
  const rows = await owner.db
    .select()
    .from(schema.compensation)
    .where(eq(schema.compensation.employmentId, employmentId));
  return rows.filter((r) => r.validTo == null && r.supersededAt == null)[0];
}

describe('3ced1040 — Confirmation behaves like Promotion', () => {
  it('records ONE history row for a confirmation that also moves salary, grade and a flat column', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 4000,
      effectiveFrom: '2026-01-01',
    });
    const grade = await createJobGrade(adminCtx(b), {
      code: `G${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Grade ${randomUUID().slice(0, 5)}`,
      rank: 3,
    });

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'confirmation',
      effectiveDate: PAST,
      basicSalary: 5000,
      gradeId: grade.id,
      orgDivision: 'Retail',
      remarks: 'Confirmed with a rise',
    });

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.map((r) => r.kind), 'one decision, one line').toEqual(['hired', 'confirmation']);
    const row = rows.find((r) => r.kind === 'confirmation')!;
    expect(row.effectiveDate, 'the confirmation date IS the effective date').toBe(PAST);
    expect(row.status).toBe('applied');

    const emp = await employmentRow(hire.employmentId);
    expect(emp.confirmationDate).toBe(PAST);
    // No status column exists: writing the date IS the Probation → Confirmed flip.
    expect(emp.finalConfirmationDate).toBe(PAST);
    expect(deriveEmploymentStatus({ ...emp }, TODAY)).toBe('active');
    expect(emp.gradeId).toBe(grade.id);
    expect(emp.orgDivision).toBe('Retail');

    const comp = await openCompensation(hire.employmentId);
    expect(comp.basicSalary).toBe('5000.00');
    expect(comp.validFrom, 'pay versioned from the confirmation date').toBe(PAST);
  });

  it('saves with NO other change at all — the confirmation itself is the change', async () => {
    const hire = await hireOne();
    // Nothing but the date. This is the reporter's explicit requirement: confirming must not demand a
    // salary adjustment.
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'confirmation',
      effectiveDate: PAST,
    });

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.map((r) => r.kind)).toEqual(['hired', 'confirmation']);
    expect(rows.find((r) => r.kind === 'confirmation')!.effectiveDate).toBe(PAST);
    expect((await employmentRow(hire.employmentId)).confirmationDate).toBe(PAST);
  });

  it('still refuses a genuine no-op — re-confirming on the date already stored changes nothing', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'confirmation',
      effectiveDate: PAST,
    });
    // The "nothing changed" protection is not switched off for this kind; the confirmation date is simply
    // counted as one more delta, so a second identical submit is caught exactly as a repeated Transfer is.
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'confirmation',
        effectiveDate: PAST,
      }),
    ).rejects.toBeInstanceOf(MovementNoChangeError);
    expect(await movementHistory(adminCtx(b), hire.employmentId)).toHaveLength(2);
  });

  it('refuses a confirmation dated before the hire date, with the existing message', async () => {
    const hire = await hireOne(); // hired 2026-01-01
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'confirmation',
        effectiveDate: '2025-12-01',
      }),
    ).rejects.toThrow(/confirmation date cannot be earlier than the hire date/i);
    expect((await employmentRow(hire.employmentId)).confirmationDate).toBeNull();
  });

  /**
   * THE DISCLOSED BEHAVIOUR CHANGE. Before this item a future confirmation date was written the instant
   * HR saved, so the employee's stored confirmation date ran ahead of the decision. Comparison kinds fork
   * on the effective date, and Confirmation now inherits that fork — which is also what keeps a future
   * pay rise attached to the confirmation out of this month's payroll.
   */
  it('a FUTURE-dated confirmation is held pending and applies on the morning of its date', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'confirmation',
      effectiveDate: FUTURE,
      basicSalary: 6000,
    });

    let rows = await movementHistory(adminCtx(b), hire.employmentId);
    const pending = rows.find((r) => r.kind === 'confirmation')!;
    expect(pending.status).toBe('pending');
    expect(pending.effectiveDate).toBe(FUTURE);
    // NOTHING is written today — not the date, not the pay.
    let emp = await employmentRow(hire.employmentId);
    expect(emp.confirmationDate, 'still on probation until the date arrives').toBeNull();
    expect(await openCompensation(hire.employmentId)).toBeUndefined();

    // The day before: still nothing.
    expect((await sweepDueMovements(adminCtx(b), { today: plusDays(FUTURE, -1) })).applied).toBe(0);
    expect((await employmentRow(hire.employmentId)).confirmationDate).toBeNull();

    // The morning of: applied, with no HR action, and STILL exactly one row — its status moved.
    expect((await sweepDueMovements(adminCtx(b), { today: FUTURE })).applied).toBe(1);
    emp = await employmentRow(hire.employmentId);
    expect(emp.confirmationDate).toBe(FUTURE);
    expect(emp.finalConfirmationDate).toBe(FUTURE);
    expect((await openCompensation(hire.employmentId)).basicSalary).toBe('6000.00');
    rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.map((r) => r.kind)).toEqual(['hired', 'confirmation']);
    expect(rows.find((r) => r.id === pending.id)!.status).toBe('applied');
  });

  it('ROLLBACK clears the confirmation date along with every other leg', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 4000,
      effectiveFrom: '2026-01-01',
    });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'confirmation',
      effectiveDate: PAST,
      basicSalary: 5000,
      orgDivision: 'Retail',
    });
    const move = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'confirmation')!;
    expect(move.canReverse, 'a Confirmation is correctable like every other comparison movement').toBe(true);

    await reverseMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: move.id,
      reason: 'Confirmed the wrong employee',
    });

    const emp = await employmentRow(hire.employmentId);
    expect(emp.confirmationDate, 'the date the movement set is cleared').toBeNull();
    expect(emp.finalConfirmationDate, 're-derived from the restored inputs').toBeNull();
    expect(emp.orgDivision).toBeNull();
    expect((await openCompensation(hire.employmentId)).basicSalary).toBe('4000.00');
    // Back on probation, derived — nothing wrote a status either way.
    expect(deriveEmploymentStatus({ ...emp, probationEndDate: FUTURE }, TODAY)).toBe('probation');

    // The row STAYS, marked reversed (9064cffb option a) — a rollback is never an erasure.
    const after = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.id === move.id)!;
    expect(after).toBeTruthy();
    expect(after.status).toBe('reversed');
    expect(after.reversed!.reason).toBe('Confirmed the wrong employee');
  });

  it('a rollback restores a PREVIOUS confirmation date rather than blanking it', async () => {
    const hire = await hireOne();
    // An earlier confirmation recorded off the Employment Dates card (untagged — not a movement itself).
    await setEmploymentInfo(adminCtx(b), { employmentId: hire.employmentId, confirmationDate: '2026-03-01' });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'confirmation',
      effectiveDate: PAST,
    });
    const move = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'confirmation')!;

    await reverseMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: move.id,
      reason: 'Date was wrong',
    });
    // The leg's own stored before-value, not a blank — the same rule the flat columns follow.
    expect((await employmentRow(hire.employmentId)).confirmationDate).toBe('2026-03-01');
  });

  it('a CORRECTION moves the date and leaves one live row behind', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'confirmation',
      effectiveDate: PAST,
    });
    const move = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'confirmation')!;

    const corrected = plusDays(PAST, 7);
    await editMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: move.id,
      kind: 'confirmation',
      effectiveDate: corrected,
      reason: 'Confirmation date keyed a week early',
    });

    expect((await employmentRow(hire.employmentId)).confirmationDate).toBe(corrected);
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const live = rows.filter((r) => r.kind === 'confirmation' && r.status !== 'reversed');
    expect(live).toHaveLength(1);
    expect(live[0].effectiveDate).toBe(corrected);
  });

  /**
   * THE BOUNDARY. Confirmation shares Promotion's form and Promotion's writer; it does NOT share
   * Promotion's interchangeability, because it is the one comparison kind with a lifecycle consequence.
   */
  it('is a comparison kind for the form and the writer, but NOT interchangeable with the others', () => {
    expect(COMPARISON_KINDS).toContain('confirmation');
    expect(INTERCHANGEABLE_COMPARISON_KINDS).not.toContain('confirmation');
    // 476f23ed's rule survives: no tenant type may be mapped onto Confirmation.
    expect(CONFIGURABLE_BEHAVIOUR_KINDS).not.toContain('confirmation');
  });

  it('a correction cannot cross the Confirmation boundary in either direction', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'confirmation',
      effectiveDate: PAST,
    });
    const conf = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'confirmation')!;
    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        movementId: conf.id,
        kind: 'transfer',
        effectiveDate: PAST,
        departmentId: b.deptB,
        reason: 'Should have been a transfer',
      }),
      'a Confirmation must not become a Transfer — the date it exists to record would vanish',
    ).rejects.toBeInstanceOf(MovementNotCorrectableError);

    const other = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: other.employmentId,
      kind: 'transfer',
      effectiveDate: PAST,
      departmentId: b.deptB,
    });
    const transfer = (await movementHistory(adminCtx(b), other.employmentId)).find((r) => r.kind === 'transfer')!;
    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: other.employmentId,
        movementId: transfer.id,
        kind: 'confirmation',
        effectiveDate: PAST,
        reason: 'Should have been a confirmation',
      }),
      'a Transfer must not become a Confirmation — that would end probation as a side effect of a relabel',
    ).rejects.toBeInstanceOf(MovementNotCorrectableError);
    expect((await employmentRow(other.employmentId)).confirmationDate).toBeNull();
  });

  it('the Employment Dates card still writes the date directly, and mints no movement row', async () => {
    const hire = await hireOne();
    await setEmploymentInfo(adminCtx(b), { employmentId: hire.employmentId, confirmationDate: '2026-04-01' });
    expect((await employmentRow(hire.employmentId)).confirmationDate).toBe('2026-04-01');
    // 30325fc1's rule is untouched: an UNTAGGED info write is not a career movement, so the card produces
    // no second row beside a movement's own.
    expect((await movementHistory(adminCtx(b), hire.employmentId)).map((r) => r.kind)).toEqual(['hired']);
  });

  it('SOURCE GUARD: the New Event form renders the grid for Confirmation and explains its date', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../app/admin/personnel/[employmentId]/movement-new-event.tsx'),
      'utf8',
    );
    // The form keeps its OWN mirrored copy of the comparison list (it must not import a server module).
    // If the two drift, Confirmation renders the lifecycle form and this whole item silently reverts.
    const mirrored = src.slice(src.indexOf('const COMPARISON_KINDS'), src.indexOf('/** 66a63bd6'));
    expect(mirrored.includes("'confirmation'"), 'the mirrored list must carry confirmation').toBe(true);
    expect(src.includes("t('form.confirmationHint')"), 'the date is explained as the confirmation date').toBe(true);

    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      expect(
        typeof msg?.people?.detail?.movement?.form?.confirmationHint,
        `messages/${loc}.json missing movement.form.confirmationHint`,
      ).toBe('string');
    }
  });

  it('leaves no second writer behind: the dispatcher has no lifecycle confirmation case', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../core/movement.ts'), 'utf8');
    expect(src.includes("case 'confirmation':"), 'the dead lifecycle case must be gone, not left dangling').toBe(
      false,
    );
  });

  it('appends only the events the movement actually needs (no phantom leg)', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'confirmation',
      effectiveDate: PAST,
    });
    const rows = await owner.db
      .select({ eventType: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.subjectEmploymentId, hire.employmentId),
          eq(schema.domainEvent.eventType, 'employment.info.updated'),
        ),
      );
    expect(rows, 'a bare confirmation is exactly ONE info leg').toHaveLength(1);
  });
});
