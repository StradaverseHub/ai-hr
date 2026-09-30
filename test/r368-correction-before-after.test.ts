/**
 * r368 · c8282468 — WHAT THE DAY SAID BEFORE SOMEBODY CHANGED IT.
 *
 * The caption under the admin day-correction form promised HR that a correction records "the previous
 * value". It did not. `decideAttendanceCorrection` wrote the day with a blind `insert …
 * onConflictDoUpdate` that never read the row it overwrote, `.returning` took the id only, and the
 * `attendance.amended` payload was after-values only. There is no attendance history table, no before
 * column, and no spelling of previousValue anywhere in the repo — so the figure a correction replaced was
 * destroyed unread, on the screen where an HR user changes a figure that feeds pay.
 *
 * ⚠️ `systemCalculatedOtMinutes` IS NOT THE PRIOR FIGURE, and a future round must not reach for it: it is
 * derived live, and on the clock branch it is derived from the PROPOSED punches. It looks like an answer
 * and is not.
 *
 * WHAT THIS FILE PINS
 *   1. a clock correction emits a TOP-LEVEL `{ before, after }` pair whose two sides carry the SAME KEY
 *      SET — the whole 33-column projection, restated here as the contract rather than imported from the
 *      code it guards — and `before` reflects the row AS IT STOOD;
 *   2. the 14 geo/method columns are IN the before-image. Nulling them is ADR-0070 and correct; losing the
 *      attestation with no copy was silent, and the diff now shows it;
 *   3. the OT-only branch does the same, and destroys NO geo reading doing it;
 *   4. a DEFERRED approval (a future-dated OT plan) writes nothing and emits nothing when it is approved,
 *      and records its before/after at the moment it LANDS — the moment a figure actually moves;
 *   5. `before: null` when there was no prior row. "Nothing was recorded" and "an explicit zero" are
 *      different befores;
 *   6. the after-only keys the event ALREADY carried are kept and unmoved, beside the pair, never replaced
 *      by it — the same "add beside, never relocate" rule localization/my/statutory.ts states for the EPF
 *      election, and a consumer of the event stream depends on it;
 *   7. `lib/audit-format.ts` `describePayload` renders the result as CHANGED "old → new" lines. Nesting the
 *      pair would drop it through to the flat-key dump and render it as JSON truncated at 120 characters,
 *      which is the failure mode that makes this whole shape load-bearing rather than cosmetic.
 *
 * DATES ARE PAST AND FIXED, and the deferral discriminator is INJECTED (`today`) rather than taken from the
 * clock: a hardcoded FUTURE date expires (CLAUDE.md §8), a past one never becomes future. 2026-03-04 is a
 * Wednesday, so it is a working day under the policy below.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import {
  checkIn,
  checkOut,
  decideAttendanceCorrection,
  requestAttendanceCorrection,
  setAttendancePolicy,
} from '../core/attendance';
import { describePayload } from '../lib/audit-format';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const DATE = '2026-03-04'; // Wednesday
const DAY_BEFORE = '2026-03-03';
const DAY_AFTER = '2026-03-05';
const GEO = { lat: 3.1478, lng: 101.6953 };
const uniqEmail = () => `r368_${Math.random().toString(36).slice(2, 10)}@t.local`;

/**
 * THE CONTRACT, RESTATED. Every column `decideAttendanceCorrection`'s upsert writes, and therefore every
 * column the audit trail has to be able to show as old → new. Deliberately NOT imported from
 * `AMENDED_FIGURE_KEYS`: a projection that silently drops a column would still match its own export, and
 * the geo half is exactly the half that would go unnoticed.
 *
 * `absenceReason` is deliberately absent — the upsert does not write it, and a before-image wider than the
 * write would assert a change that never happened.
 */
const FIGURE_KEYS = [
  'checkInAt',
  'checkOutAt',
  'status',
  'dayType',
  'workedMinutes',
  'otMinutes',
  // stage1Columns()
  'calcTrace',
  'lateMinutes',
  'earlyOutMinutes',
  'underMinutes',
  'lateDeductMinutes',
  'earlyOutDeductMinutes',
  // otSplitColumns()
  'otFlatMinutes',
  'ot00Minutes',
  'ot10Minutes',
  'ot15Minutes',
  'ot20Minutes',
  'ot30Minutes',
  'remarks',
  // ADR-0070 geo capture — seven per punch, all 14 nulled by a clock correction.
  'checkInMethod',
  'checkInLat',
  'checkInLng',
  'checkInClockingLocationId',
  'checkInDistanceM',
  'checkInGeofenceStatus',
  'checkInRadiusM',
  'checkOutMethod',
  'checkOutLat',
  'checkOutLng',
  'checkOutClockingLocationId',
  'checkOutDistanceM',
  'checkOutGeofenceStatus',
  'checkOutRadiusM',
].sort();

const GEO_KEYS = FIGURE_KEYS.filter((k) => /^check(In|Out)(Method|Lat|Lng|ClockingLocationId|DistanceM|GeofenceStatus|RadiusM)$/.test(k));

const BASE_POLICY = (companyId: string) => ({
  companyId,
  workStart: '09:00',
  workEnd: '18:00',
  breakMinutes: 60,
  lateAfter: '09:15',
  halfDayBefore: '13:00',
  workingDays: [1, 2, 3, 4, 5],
});

async function hire() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Corrected Worker', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: 5000,
    monthlyAllowance: 0,
    effectiveFrom: '2024-01-01',
  });
  await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
  return { a, employmentId: e.employmentId };
}

const attendanceRow = async (employmentId: string, date: string) =>
  (
    await owner.db
      .select()
      .from(schema.attendance)
      .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)))
  )[0];

/** Every `attendance.amended` event on the day's aggregate, in SEQUENCE order — an explicit ORDER BY, not
 *  "the newest row". Returns [] when the day has no attendance row at all, which is itself an assertion a
 *  test makes about the deferred branch. */
async function amendedPayloads(employmentId: string, date: string): Promise<Record<string, unknown>[]> {
  const row = await attendanceRow(employmentId, date);
  if (!row) return [];
  const rows = await owner.db
    .select({ payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.aggregateType, 'attendance'),
        eq(schema.domainEvent.aggregateId, row.id),
        eq(schema.domainEvent.eventType, 'attendance.amended'),
      ),
    )
    .orderBy(asc(schema.domainEvent.sequence));
  return rows.map((r) => (r.payload ?? {}) as Record<string, unknown>);
}

type Pair = { before: Record<string, unknown> | null; after: Record<string, unknown> };
const pairOf = (p: Record<string, unknown>): Pair => ({
  before: (p.before ?? null) as Record<string, unknown> | null,
  after: p.after as Record<string, unknown>,
});

/** Both sides carry the SAME key set, and that key set is the whole projection. This is what
 *  describePayload's per-key diff needs: a key on one side only renders as a change that did not happen,
 *  and a key missing from both is a column the trail has silently stopped showing. */
function expectFullPair(p: Record<string, unknown>, { beforeNull = false } = {}): Pair {
  expect(Object.keys(p), '`before` must be TOP-LEVEL — nested, describePayload renders a JSON dump').toContain(
    'before',
  );
  expect(Object.keys(p), '`after` must be TOP-LEVEL').toContain('after');
  const pair = pairOf(p);
  expect(Object.keys(pair.after).sort(), 'the after-image is the whole projection').toEqual(FIGURE_KEYS);
  if (beforeNull) {
    expect(pair.before, 'no prior row ⇒ before is NULL, not an empty object and not a row of nulls').toBeNull();
  } else {
    expect(pair.before, 'a day that HAD a record must carry its pre-image').not.toBeNull();
    expect(Object.keys(pair.before!).sort(), 'before and after must carry IDENTICAL key sets').toEqual(FIGURE_KEYS);
  }
  return pair;
}

/** The keys the event carried BEFORE this round, which a consumer of the event stream reads. Added beside,
 *  never replaced by, the pair. */
const AFTER_ONLY_CLOCK = ['correctionId', 'date', 'checkIn', 'checkOut', 'status', 'dayType', 'workedMinutes', 'otMinutes'];

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · a clock correction records the day as it STOOD', () => {
  it('carries a top-level before/after pair over the whole projection, and before is the pre-image', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: DATE, time: '09:25', geo: GEO });
    await checkOut(a, { employmentId, date: DATE, time: '17:30', geo: GEO });
    const pre = await attendanceRow(employmentId, DATE);

    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '19:00',
      reason: 'Gate log shows 19:00; the device missed the punch',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved', today: DAY_AFTER });

    const payloads = await amendedPayloads(employmentId, DATE);
    expect(payloads, 'one amendment, for one correction').toHaveLength(1);
    const { before, after } = expectFullPair(payloads[0]);

    // THE PRE-IMAGE IS THE ROW AS IT STOOD, field by field — not a re-derivation, and not the proposal.
    expect(before!.checkInAt, 'the time the employee actually clocked').toBe(pre.checkInAt);
    expect(before!.checkOutAt).toBe(pre.checkOutAt);
    expect(before!.workedMinutes).toBe(pre.workedMinutes);
    expect(before!.otMinutes).toBe(pre.otMinutes);
    expect(before!.lateMinutes, 'the 09:25 clock-in was late, and the OLD lateness is recoverable').toBe(
      pre.lateMinutes,
    );
    expect(before!.status).toBe(pre.status);
    expect(before!.calcTrace, 'the stored WORKING behind the old figures, which cannot be re-derived').toEqual(
      pre.calcTrace,
    );
    expect(before!.remarks).toBe(pre.remarks);

    // …AND THE AFTER-IMAGE IS THE ROW AS IT NOW STANDS, re-read rather than assembled from the write.
    const post = await attendanceRow(employmentId, DATE);
    expect(after.checkInAt).toBe(post.checkInAt);
    expect(after.checkOutAt).toBe(post.checkOutAt);
    expect(after.workedMinutes).toBe(post.workedMinutes);
    expect(after.otMinutes).toBe(post.otMinutes);
    expect(after.remarks).toBe('Corrected');
    // The correction genuinely moved the figures — otherwise everything above is vacuously true.
    expect(after.checkOutAt).not.toBe(before!.checkOutAt);
    expect(after.otMinutes).not.toBe(before!.otMinutes);
  });

  it('⚠️ THE GEO ATTESTATION: the reading that existed is in `before`, and its loss is in `after`', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: DATE, time: '09:00', geo: GEO });
    await checkOut(a, { employmentId, date: DATE, time: '18:00', geo: GEO });
    const pre = await attendanceRow(employmentId, DATE);
    // The fixture has to actually carry a reading, or the assertions below prove nothing.
    expect(pre.checkInLat, 'fixture: the punch was captured with coordinates').not.toBeNull();
    expect(pre.checkInMethod).toBe('web');
    expect(pre.checkInGeofenceStatus).not.toBeNull();

    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '08:55',
      checkOut: '19:30',
      reason: 'Worked late on the cut-over',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved', today: DAY_AFTER });

    const { before, after } = expectFullPair((await amendedPayloads(employmentId, DATE))[0]);
    expect(before!.checkInLat).toBe(pre.checkInLat);
    expect(before!.checkInLng).toBe(pre.checkInLng);
    expect(before!.checkInMethod).toBe('web');
    expect(before!.checkInGeofenceStatus).toBe(pre.checkInGeofenceStatus);
    expect(before!.checkOutLat).toBe(pre.checkOutLat);
    expect(before!.checkOutMethod).toBe('web');
    // ADR-0070: a correction clears all 14, deliberately. The clearing is right; doing it with no copy was
    // the silent half, and this is the assertion that keeps the copy.
    for (const k of GEO_KEYS) {
      expect(after[k], `${k} is cleared by the correction (ADR-0070)`).toBeNull();
    }
  });

  it('keeps the after-only keys it already carried, beside the pair rather than replaced by it', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: DATE, time: '09:00' });
    await checkOut(a, { employmentId, date: DATE, time: '18:00' });
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '20:00',
      reason: 'Approved overtime on the cut-over',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved', today: DAY_AFTER });

    const p = (await amendedPayloads(employmentId, DATE))[0];
    for (const k of AFTER_ONLY_CLOCK) {
      expect(Object.keys(p), `${k} is read by event-stream consumers and may not move into the pair`).toContain(k);
    }
    expect(p.correctionId).toBe(correctionId);
    expect(p.date).toBe(DATE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · an OT-only correction', () => {
  it('records the OT figure and its split old → new, and destroys no geo reading', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: DATE, time: '09:00', geo: GEO });
    await checkOut(a, { employmentId, date: DATE, time: '20:00', geo: GEO });
    const pre = await attendanceRow(employmentId, DATE);
    expect(pre.otMinutes, 'fixture: 09:00→20:00 less a 60-minute break over a 480 schedule').toBe(120);

    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      requestedOtMinutes: 180,
      reason: 'Agreed three hours for the release',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved', today: DAY_AFTER });

    const payloads = await amendedPayloads(employmentId, DATE);
    expect(payloads).toHaveLength(1);
    const { before, after } = expectFullPair(payloads[0]);
    expect(before!.otMinutes, 'the figure the engine had derived').toBe(120);
    expect(after.otMinutes, 'the figure the approver agreed').toBe(180);
    // The split is rewritten from the stored figure, so the buckets keep summing — and both states are kept.
    const sum = (o: Record<string, unknown>) =>
      ['otFlatMinutes', 'ot00Minutes', 'ot10Minutes', 'ot15Minutes', 'ot20Minutes', 'ot30Minutes'].reduce(
        (n, k) => n + ((o[k] as number | null) ?? 0),
        0,
      );
    expect(sum(before!)).toBe(120);
    expect(sum(after)).toBe(180);
    // ⚠️ THE PUNCHES ARE NOT TOUCHED ON THIS BRANCH, and neither is the location reading. An OT-only
    // correction that showed a geo loss would be reporting something that did not happen.
    for (const k of GEO_KEYS) {
      expect(after[k], `${k} must survive an OT-only correction`).toEqual(before![k]);
    }
    expect(after.checkInAt).toBe(before!.checkInAt);
    // The OT-approval keys are after-only and stay after-only.
    for (const k of ['requestedOtMinutes', 'systemCalculatedOtMinutes', 'approvedOtMinutes', 'otApprovalMethod']) {
      expect(Object.keys(payloads[0]), `${k} stays at the top level`).toContain(k);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · a DEFERRED approval records it when the plan LANDS', () => {
  it('approving a future-dated plan writes nothing and emits nothing; the landing carries the pair', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      requestedOtMinutes: 180,
      reason: 'Planned overtime for the release window',
      plannedStartTime: '18:00',
      plannedEndTime: '21:00',
      otReasonCategory: 'project_deadline',
    });
    // `today` is the day BEFORE the plan's date, so this is the deferred branch.
    const res = await decideAttendanceCorrection(a, { correctionId, decision: 'approved', today: DAY_BEFORE });
    expect(res.deferred, 'a future-dated plan is HELD, not applied').toBe(true);
    expect(await attendanceRow(employmentId, DATE), 'NO placeholder row').toBeUndefined();
    expect(await amendedPayloads(employmentId, DATE), 'nothing moved, so nothing is amended').toEqual([]);

    // …and now the day is worked. THIS is the moment a figure moves.
    await checkIn(a, { employmentId, date: DATE, time: '09:00', geo: GEO });
    await checkOut(a, { employmentId, date: DATE, time: '20:00', geo: GEO });

    const payloads = await amendedPayloads(employmentId, DATE);
    expect(payloads, 'one amendment: the landing').toHaveLength(1);
    const p = payloads[0];
    expect(p.otPlanApplied, 'the distinguishing mark of a deferred landing').toBe(true);
    const { before, after } = expectFullPair(p);
    expect(before!.otMinutes, 'what the clock-out had derived').toBe(120);
    expect(after.otMinutes, 'what the approver had agreed, resolved against the real clocking').toBe(180);
    // A landing moves OT and its split and NOTHING else — including no geo loss.
    expect(after.checkInAt).toBe(before!.checkInAt);
    expect(after.workedMinutes).toBe(before!.workedMinutes);
    for (const k of GEO_KEYS) {
      expect(after[k], `${k} must survive an OT plan landing`).toEqual(before![k]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · a day that had no record at all', () => {
  it('before is NULL, and the after-image is still the whole projection', async () => {
    const { a, employmentId } = await hire();
    expect(await attendanceRow(employmentId, DATE), 'fixture: nothing was ever clocked').toBeUndefined();

    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'Forgot to clock in and out entirely',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved', today: DAY_AFTER });

    const { before, after } = expectFullPair((await amendedPayloads(employmentId, DATE))[0], { beforeNull: true });
    expect(before).toBeNull();
    expect(after.checkInAt).toBe('09:00:00');
    expect(after.remarks).toBe('Corrected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · what the Audit Trail actually renders', () => {
  /**
   * `describePayload` is what /admin/audit expands a row into (components/audit-table.tsx). It recognises a
   * top-level `{ before, after }` pair and emits ONE LINE PER CHANGED KEY as "old → new". Nest the pair and
   * it falls through to the flat-key dump: two lines keyed `before` and `after`, each one a JSON string
   * truncated at 120 characters — which is unreadable and is the reason the shape is load-bearing.
   *
   * Run against the REAL payload the service just wrote, not a literal, so a shape change fails here.
   */
  it('renders CHANGED old → new lines, not a truncated JSON dump', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: DATE, time: '09:25', geo: GEO });
    await checkOut(a, { employmentId, date: DATE, time: '17:30', geo: GEO });
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '19:00',
      reason: 'Gate log shows 19:00',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved', today: DAY_AFTER });
    const payload = (await amendedPayloads(employmentId, DATE))[0];

    const lines = describePayload(payload);
    const keys = lines.map((l) => l.key);
    // ⚠️ THE DUMP SIGNATURE. If the pair were nested (or dropped), these two keys would appear as lines of
    // their own carrying truncated JSON, and the trail would say nothing a person can read.
    expect(keys, 'a line keyed `before` means describePayload fell through to the flat dump').not.toContain(
      'before',
    );
    expect(keys, 'a line keyed `after` means the same').not.toContain('after');

    const changed = lines.filter((l) => l.changed);
    expect(changed.length, 'the comparison must produce real lines').toBeGreaterThan(0);
    const value = (k: string) => changed.find((l) => l.key === k)?.value;
    expect(value('checkOutAt'), 'the clock time, old → new').toBe('17:30:00 → 19:00:00');
    expect(value('checkInAt')).toBe('09:25:00 → 09:00:00');
    // The geo loss reads as a loss: a value, then nothing.
    expect(value('checkInMethod'), 'the destroyed attestation is a line of its own').toBe('web → —');
    expect(value('checkInLat')).toMatch(/^3\.1478 → —$/);
    // An UNCHANGED key is not a line — that is what makes the rendering readable rather than 33 rows.
    expect(changed.map((l) => l.key), 'day type did not move on a working-day correction').not.toContain('dayType');
    // …and the after-only keys still render, after the comparison.
    expect(keys).toContain('correctionId');
    expect(keys).toContain('date');
  });
});
