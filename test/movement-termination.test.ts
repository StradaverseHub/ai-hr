/**
 * ae9350f2 — "Movement Type: Termination".
 *
 * WHAT WAS ALREADY THERE, AND WHAT THIS ITEM ADDS. `termination` has been a MOVEMENT_KIND since 78853b97
 * and Employment History has projected Termination/Resignation rows off `employment.terminated` for as
 * long — so this was never greenfield, and migration 0331's header says so explicitly ("this migration adds
 * no termination handling … the seam is employment.terminated_on … ae9350f2 writes it"). What the old path
 * did NOT have is the structured exit (coded reason, last working day, notice, resignation date), the
 * validation rules, exactly-one history row, and — the one that was a live defect rather than a gap — a
 * future-dated termination that does not disturb the employee TODAY.
 *
 * THE DEFECT, IN ONE SENTENCE. terminateEmploymentTx CLOSES the open assignment version and the open
 * administrative reporting lines at the termination date. Every reader that resolves "current" as the OPEN
 * row (`isNull(valid_to)`) — the Employment tab, the org chart, the directory, movementCurrentState — was
 * therefore losing the employee's department, position and manager the INSTANT a future termination was
 * keyed. That is 941c9dac's fault with the sign flipped, and it gets 941c9dac's fix: schedule, then apply
 * on the morning of the effective date.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import {
  createMovementEvent,
  editMovementEvent,
  movementCurrentState,
  movementHistory,
  reverseMovementEvent,
} from '../core/movement';
import { sweepDueMovements } from '../core/movement-apply';
import { deriveEmploymentStatus } from '../core/employment-status';
import {
  TERMINATION_REASONS,
  TERMINATION_REASON_CATEGORIES,
  terminationTypeForReason,
} from '../core/termination-reason';
import { todayInKualaLumpur } from '../lib/hr-date';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `term_${randomUUID().slice(0, 8)}@t.local`;

/** ISO date + n days, pure UTC string maths (this repo's convention — see core/movement.ts dayBefore). */
function plusDays(iso: string, n: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

const TODAY = todayInKualaLumpur();
const FUTURE = plusDays(TODAY, 30);
const PAST = plusDays(TODAY, -30);
const HIRED_ON = '2020-01-01';

async function hireOne(name = 'Termination Test') {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: HIRED_ON,
  });
}

const employmentRow = async (id: string) => {
  const [row] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, id));
  return row;
};

const assignmentsOf = (employmentId: string) =>
  owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, employmentId));

const appliedEventsFor = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.tenantId, b.tenantId),
        eq(schema.domainEvent.subjectEmploymentId, employmentId),
        eq(schema.domainEvent.eventType, 'employment.movement.applied'),
      ),
    );

/** A valid termination submission — the minimum the rules accept. */
const terminationInput = (employmentId: string, effectiveDate: string, over: Record<string, unknown> = {}) => ({
  employmentId,
  kind: 'termination' as const,
  effectiveDate,
  endDate: effectiveDate, // Last Working Day
  terminationReasonCode: 'redundancy',
  ...over,
});

// ───────────────────────── the built-in catalogue ─────────────────────────

describe('the termination reason catalogue', () => {
  it('covers the reporter\'s list, split into voluntary and involuntary', () => {
    const codes = TERMINATION_REASONS.map((r) => r.code);
    for (const c of [
      'resignation', 'career_opportunity', 'personal_reason', 'retirement', 'early_retirement',
      'performance_issue', 'misconduct', 'redundancy', 'contract_expiry', 'absconded', 'medical_unfit',
    ]) {
      expect(codes).toContain(c);
    }
    expect(TERMINATION_REASONS.filter((r) => r.category === 'voluntary').length).toBeGreaterThan(0);
    expect(TERMINATION_REASONS.filter((r) => r.category === 'involuntary').length).toBeGreaterThan(0);
  });

  /**
   * The reason DERIVES the turnover classification, which is what makes a single picker safe. Without this
   * the two could be saved in contradiction (a Misconduct exit filed as "voluntary") and nothing in the
   * record would say which one the user meant.
   */
  it('maps every reason onto an existing termination_type enum value — no new enum value is needed', () => {
    const enumValues = ['voluntary', 'involuntary', 'retired', 'contract_end', 'death', 'other'];
    for (const r of TERMINATION_REASONS) {
      expect(enumValues).toContain(r.type);
      expect(terminationTypeForReason(r.code)).toBe(r.type);
    }
    // Every enum value stays REACHABLE through the single control — that is why death/other are codes.
    for (const v of enumValues) {
      expect(TERMINATION_REASONS.some((r) => r.type === v)).toBe(true);
    }
    expect(terminationTypeForReason('not_a_reason')).toBeNull();
  });

  /**
   * The i18n guard (test/i18n-coverage.test.ts check C) matches LITERAL t('key') only, so the page's
   * computed `movement.terminationReason.${code}` keys are invisible to it — the exact second hole the
   * handoff records. This is the hand-written replacement it asks for.
   */
  it('has a label for every code and category in ALL SIX locales', () => {
    for (const locale of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const j = JSON.parse(readFileSync(`${process.cwd()}/messages/${locale}.json`, 'utf8'));
      const mv = j.people.detail.movement;
      for (const r of TERMINATION_REASONS) {
        expect(String(mv.terminationReason?.[r.code] ?? '').trim(), `${locale}: reason ${r.code}`).not.toBe('');
      }
      for (const c of TERMINATION_REASON_CATEGORIES) {
        expect(String(mv.terminationReasonCategory?.[c] ?? '').trim(), `${locale}: category ${c}`).not.toBe('');
      }
      for (const k of ['lastWorkingDay', 'terminationReason', 'terminationReasonPlaceholder', 'terminationTypeDerived', 'resignationDate', 'terminationNoticeDays', 'terminationPayrollFlag']) {
        expect(String(mv.form?.[k] ?? '').trim(), `${locale}: form.${k}`).not.toBe('');
      }
    }
  });
});

// ───────────────────────── recording a termination ─────────────────────────

describe('recording a termination dated today or in the past', () => {
  it('applies at once, writes the structured exit, and leaves EXACTLY ONE history row', async () => {
    const { employmentId } = await hireOne();
    await createMovementEvent(
      adminCtx(b),
      terminationInput(employmentId, TODAY, {
        endDate: plusDays(TODAY, -2),
        terminationReasonCode: 'misconduct',
        terminationNoticeDays: 0,
        remarks: 'Summary dismissal',
      }),
    );

    const row = await employmentRow(employmentId);
    expect(row.terminatedOn).toBe(TODAY);
    expect(row.lastWorkingDate).toBe(plusDays(TODAY, -2));
    expect(row.terminationReasonCode).toBe('misconduct');
    // DERIVED from the reason, never submitted alongside it.
    expect(row.terminationType).toBe('involuntary');
    expect(row.terminationNoticeDays).toBe(0);

    // THE 4d391ab7 PROPERTY. The exit dates are written by setEmploymentInfo, whose event carries
    // lastWorkingDate and therefore projects a "Resignation" row of its own unless it is tagged secondary.
    const hist = await movementHistory(adminCtx(b), employmentId);
    expect(hist.filter((r) => r.kind === 'termination')).toHaveLength(1);
    expect(hist.filter((r) => r.kind === 'resignation')).toHaveLength(0);
    const mv = hist.find((r) => r.kind === 'termination')!;
    expect(mv.status).toBe('applied');
    expect(mv.effectiveDate).toBe(TODAY);
    expect(mv.endDate).toBe(plusDays(TODAY, -2));
    expect(mv.remarks).toBe('Summary dismissal');

    // Employee Status follows the DATES — no stored status column exists to write (migration 0331).
    expect(deriveEmploymentStatus(row, TODAY)).toBe('resigned');
  });

  it('records the tendered resignation date for a resignation, and requires it', async () => {
    const { employmentId } = await hireOne();
    await expect(
      createMovementEvent(
        adminCtx(b),
        terminationInput(employmentId, TODAY, { terminationReasonCode: 'resignation' }),
      ),
    ).rejects.toThrow(/resignation date/i);

    await createMovementEvent(
      adminCtx(b),
      terminationInput(employmentId, TODAY, {
        terminationReasonCode: 'resignation',
        resignationDate: plusDays(TODAY, -30),
      }),
    );
    const row = await employmentRow(employmentId);
    expect(row.tenderResignationDate).toBe(plusDays(TODAY, -30));
    expect(row.terminationType).toBe('voluntary');
  });

  it('closes the assignment and the reporting hierarchy at the termination date — without deleting either', async () => {
    const manager = await hireOne('Term Manager');
    const { employmentId } = await hireOne('Term Report');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: employmentId,
      managerEmploymentId: manager.employmentId,
      lineType: 'administrative',
      validFrom: HIRED_ON,
    });

    await createMovementEvent(adminCtx(b), terminationInput(employmentId, PAST, { endDate: PAST }));

    const asg = await assignmentsOf(employmentId);
    expect(asg).toHaveLength(1);
    expect(asg[0].validTo).toBe(PAST); // closed, not removed — history and reporting stay intact
    const lines = await owner.db
      .select()
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.subordinateEmploymentId, employmentId));
    expect(lines).toHaveLength(1);
    expect(lines[0].validTo).toBe(PAST);
  });
});

// ───────────────────────── the future-dated case (the defect) ─────────────────────────

describe('a FUTURE-dated termination', () => {
  it('writes NOTHING today — the placement, the manager and terminated_on are all untouched', async () => {
    const manager = await hireOne('Future Term Manager');
    const { employmentId } = await hireOne('Future Term');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: employmentId,
      managerEmploymentId: manager.employmentId,
      lineType: 'administrative',
      validFrom: HIRED_ON,
    });
    const before = await movementCurrentState(adminCtx(b), employmentId);

    await createMovementEvent(
      adminCtx(b),
      terminationInput(employmentId, FUTURE, { endDate: FUTURE, remarks: 'Contract runs out' }),
    );

    // THE REGRESSION GUARD. Before this item, every one of these had already moved.
    const after = await movementCurrentState(adminCtx(b), employmentId);
    expect(after.departmentId).toBe(before.departmentId);
    expect(after.positionId).toBe(before.positionId);
    expect(after.managerEmploymentId).toBe(manager.employmentId);

    const row = await employmentRow(employmentId);
    expect(row.terminatedOn).toBeNull();
    expect(row.lastWorkingDate).toBeNull();
    expect(row.terminationReasonCode).toBeNull();
    expect((await assignmentsOf(employmentId))[0].validTo).toBeNull();

    // One scheduled event and no termination event at all.
    const types = await eventTypesFor(b.tenantId, employmentId);
    expect(types).toContain('employment.movement.scheduled');
    expect(types).not.toContain('employment.terminated');

    const hist = await movementHistory(adminCtx(b), employmentId);
    const mv = hist.find((r) => r.kind === 'termination')!;
    expect(mv.status).toBe('pending');
    expect(mv.effectiveDate).toBe(FUTURE);
    expect(mv.endDate).toBe(FUTURE);
    expect(mv.entryDate).toBe(TODAY); // captured, never chosen (941c9dac / r85's KL-date fix)
  });

  it('is applied by the sweep on its effective date, keeping ONE history row whose status moves to Applied', async () => {
    const { employmentId } = await hireOne('Swept Term');
    await createMovementEvent(adminCtx(b), terminationInput(employmentId, FUTURE, { endDate: FUTURE }));

    // The day before: not due.
    await sweepDueMovements(adminCtx(b), { today: plusDays(FUTURE, -1) });
    expect((await employmentRow(employmentId)).terminatedOn).toBeNull();

    await sweepDueMovements(adminCtx(b), { today: FUTURE });
    const row = await employmentRow(employmentId);
    expect(row.terminatedOn).toBe(FUTURE);
    expect(row.terminationReasonCode).toBe('redundancy');
    expect(row.terminationType).toBe('involuntary');
    expect(row.lastWorkingDate).toBe(FUTURE);

    const hist = await movementHistory(adminCtx(b), employmentId);
    expect(hist.filter((r) => r.kind === 'termination')).toHaveLength(1);
    expect(hist.filter((r) => r.kind === 'resignation')).toHaveLength(0);
    // Per-EMPLOYMENT, not the tenant-wide sweep counter — r83's lesson about file-order coupling.
    expect(await appliedEventsFor(employmentId)).toHaveLength(1);
  });

  it('is apply-once: a second sweep on the same morning does nothing', async () => {
    const { employmentId } = await hireOne('Twice Swept');
    await createMovementEvent(adminCtx(b), terminationInput(employmentId, FUTURE, { endDate: FUTURE }));
    await sweepDueMovements(adminCtx(b), { today: FUTURE });
    await sweepDueMovements(adminCtx(b), { today: FUTURE });
    expect(await appliedEventsFor(employmentId)).toHaveLength(1);
    expect((await movementHistory(adminCtx(b), employmentId)).filter((r) => r.kind === 'termination')).toHaveLength(1);
  });

  it('reads as Active — Serving Notice until the effective date arrives, then Resigned', async () => {
    const { employmentId } = await hireOne('Serving Notice');
    await createMovementEvent(adminCtx(b), terminationInput(employmentId, FUTURE, { endDate: FUTURE }));
    await sweepDueMovements(adminCtx(b), { today: FUTURE });
    const row = await employmentRow(employmentId);
    expect(deriveEmploymentStatus(row, plusDays(FUTURE, -1))).toBe('active_serving_notice');
    expect(deriveEmploymentStatus(row, FUTURE)).toBe('resigned');
  });

  it('can be CANCELLED while pending, and cancelling frees the employee to be terminated again', async () => {
    const { employmentId } = await hireOne('Cancelled Term');
    await createMovementEvent(adminCtx(b), terminationInput(employmentId, FUTURE, { endDate: FUTURE }));
    const hist = await movementHistory(adminCtx(b), employmentId);
    const pending = hist.find((r) => r.kind === 'termination')!;
    expect(pending.canReverse).toBe(true);

    await reverseMovementEvent(adminCtx(b), { employmentId, movementId: pending.id, reason: 'Withdrawn' });
    expect((await employmentRow(employmentId)).terminatedOn).toBeNull();
    expect(
      (await movementHistory(adminCtx(b), employmentId)).find((r) => r.id === pending.id)!.status,
    ).toBe('reversed');

    // The sweep must not resurrect it.
    await sweepDueMovements(adminCtx(b), { today: FUTURE });
    expect((await employmentRow(employmentId)).terminatedOn).toBeNull();

    // And a fresh termination is accepted (the duplicate rule counts only LIVE terminations).
    await createMovementEvent(adminCtx(b), terminationInput(employmentId, TODAY, { endDate: TODAY }));
    expect((await employmentRow(employmentId)).terminatedOn).toBe(TODAY);
  });

  it('can be CORRECTED while pending — the Edit affordance the projection offers actually works', async () => {
    const { employmentId } = await hireOne('Corrected Term');
    await createMovementEvent(adminCtx(b), terminationInput(employmentId, FUTURE, { endDate: FUTURE }));
    const pending = (await movementHistory(adminCtx(b), employmentId)).find((r) => r.kind === 'termination')!;
    expect(pending.canEdit).toBe(true);

    const newDate = plusDays(FUTURE, 7);
    await editMovementEvent(adminCtx(b), {
      ...terminationInput(employmentId, newDate, {
        endDate: newDate,
        terminationReasonCode: 'contract_expiry',
      }),
      movementId: pending.id,
      reason: 'Extended to the end of the contract',
    });

    const hist = await movementHistory(adminCtx(b), employmentId);
    const live = hist.filter((r) => r.kind === 'termination' && r.status === 'pending');
    expect(live).toHaveLength(1);
    expect(live[0].effectiveDate).toBe(newDate);
    // Still nothing written — a corrected pending movement is still pending.
    expect((await employmentRow(employmentId)).terminatedOn).toBeNull();
  });
});

// ───────────────────────── the reporter's validation rules ─────────────────────────

describe('validation rules', () => {
  it('refuses a termination date earlier than the joining date', async () => {
    const { employmentId } = await hireOne();
    await expect(
      createMovementEvent(adminCtx(b), terminationInput(employmentId, '2019-06-30', { endDate: '2019-06-30' })),
    ).rejects.toThrow(/earlier than the hire date/i);
  });

  it('requires a last working day, and refuses one after the termination date', async () => {
    const { employmentId } = await hireOne();
    await expect(
      createMovementEvent(adminCtx(b), { ...terminationInput(employmentId, TODAY), endDate: null }),
    ).rejects.toThrow(/last working day/i);
    await expect(
      createMovementEvent(adminCtx(b), terminationInput(employmentId, TODAY, { endDate: plusDays(TODAY, 3) })),
    ).rejects.toThrow(/later than the termination date/i);
  });

  it('requires a reason, and refuses one outside the catalogue', async () => {
    const { employmentId } = await hireOne();
    await expect(
      createMovementEvent(adminCtx(b), terminationInput(employmentId, TODAY, { terminationReasonCode: null })),
    ).rejects.toThrow(/termination reason is required/i);
    await expect(
      createMovementEvent(adminCtx(b), terminationInput(employmentId, TODAY, { terminationReasonCode: 'sacked_lol' })),
    ).rejects.toThrow(/unknown termination reason/i);
  });

  it('refuses a DUPLICATE termination — applied or still pending', async () => {
    const applied = await hireOne('Dup Applied');
    await createMovementEvent(adminCtx(b), terminationInput(applied.employmentId, TODAY, { endDate: TODAY }));
    await expect(
      createMovementEvent(adminCtx(b), terminationInput(applied.employmentId, TODAY, { endDate: TODAY })),
    ).rejects.toThrow(/already terminated/i);

    const pending = await hireOne('Dup Pending');
    await createMovementEvent(adminCtx(b), terminationInput(pending.employmentId, FUTURE, { endDate: FUTURE }));
    await expect(
      createMovementEvent(adminCtx(b), terminationInput(pending.employmentId, plusDays(FUTURE, 1), { endDate: plusDays(FUTURE, 1) })),
    ).rejects.toThrow(/termination is already recorded/i);
  });

  it('refuses a termination that clashes with an approved future movement', async () => {
    const { employmentId } = await hireOne('Clash');
    await createMovementEvent(adminCtx(b), {
      employmentId,
      kind: 'transfer',
      effectiveDate: plusDays(TODAY, 60),
      departmentId: b.deptB,
    });
    await expect(
      createMovementEvent(adminCtx(b), terminationInput(employmentId, plusDays(TODAY, 30), { endDate: plusDays(TODAY, 30) })),
    ).rejects.toThrow(/already scheduled/i);

    // A movement that lands BEFORE the exit is legitimate and is not refused.
    const ok = await hireOne('No Clash');
    await createMovementEvent(adminCtx(b), {
      employmentId: ok.employmentId,
      kind: 'transfer',
      effectiveDate: plusDays(TODAY, 10),
      departmentId: b.deptB,
    });
    await createMovementEvent(
      adminCtx(b),
      terminationInput(ok.employmentId, plusDays(TODAY, 60), { endDate: plusDays(TODAY, 60) }),
    );
    expect(
      (await movementHistory(adminCtx(b), ok.employmentId)).filter((r) => r.kind === 'termination'),
    ).toHaveLength(1);
  });

  it('refuses a negative or fractional notice period', async () => {
    const { employmentId } = await hireOne();
    await expect(
      createMovementEvent(adminCtx(b), terminationInput(employmentId, TODAY, { terminationNoticeDays: -1 })),
    ).rejects.toThrow(/whole number of days/i);
  });
});

// ───────────────────────── what this item deliberately RELIES ON rather than rebuilds ─────────────────────────

describe('the downstream effects that were already wired', () => {
  /**
   * "Stop future payroll processing" is NOT built here — it already exists, as a WHERE clause on every
   * payroll employment selection. Pinned as source so a refactor that drops the predicate is caught here
   * rather than by an employee being paid after they left. (The plan's other payroll half — the final
   * settlement calculation — is deliberately a second step; core/payroll.ts leaverAdvisory is its seam.)
   */
  it('payroll selection still excludes employments terminated before the period', () => {
    const src = readFileSync(`${process.cwd()}/core/payroll.ts`, 'utf8');
    expect(src).toContain('or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart))');
    expect(src).toContain('leaverAdvisory');
  });

  /**
   * "Disable ESS login after the termination effective date" is also already wired: app.login_blocked() and
   * its TypeScript twin read the same end dates the termination writes. Nothing new here — a guard that the
   * seam still exists.
   */
  it('login blocking still reads the lifecycle end dates the termination writes', () => {
    const src = readFileSync(`${process.cwd()}/core/employment-status.ts`, 'utf8');
    expect(src).toContain('earliest(emp.resignationDate, emp.lastWorkingDate, emp.terminatedOn)');
  });

  /**
   * r78 deleted `transferAction` for being an unreferenced but LIVE `use server` RPC endpoint. `terminateAction`
   * was the same shape and is deleted here: it called terminateEmployment directly and so bypassed every rule
   * above. A test, not a comment, because the failure mode is somebody re-adding a "convenient" direct writer.
   */
  it('has no second, unguarded termination endpoint', () => {
    const src = readFileSync(`${process.cwd()}/app/admin/personnel/[employmentId]/actions.ts`, 'utf8');
    expect(src).not.toContain('export async function terminateAction');
  });
});
