/**
 * WP-B2 (APR-022) — the leader seat registry: business unit CEO, business group CEO and group chief seats,
 * the per-person head of department (HOD), calibration groups, and calibration scopes generated from them.
 *
 * Authority and invariants live in the database (migration 0663) and are not re-implemented here: RLS
 * decides who may read and write each row, validation triggers refuse backdating, inactive holders,
 * cross-business-group HODs and a locked group chief change, and exclusion constraints keep one holder per
 * anchor per day. This service adds what a single row cannot see: replacing the current holder, the HOD
 * preview (blockers, warnings, fingerprint), keeping open department reviews in step with an HOD change,
 * and the idempotent scope generation.
 *
 * Dates are Malaysia calendar days from lib/hr-date. A seat or assignment is live on `d` when
 * valid_from <= d < valid_to. Nothing is deleted: rows are ended; a moved department-review entry is
 * retired into its history table by app.onehr_retire_calibration_entry.
 *
 * No notifications are sent for seat or HOD changes; the source sends none.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { actorOf, appendEvent } from '../../../db/events';
import { calibrationGroup, calibrationGroupMember, company, department, hodAssignment, leaderSeat, onehrCalibration, onehrCalibrationEntry, onehrCycle, onehrReview, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { onehrLabel } from './person-labels';
import { onehrAssignment, onehrEmployment } from './employment-projection';
import { calibrationAssignableCycleTx } from './service';
import { calibrationWindowState } from './calibration-list-model';
import { policySchema } from './model';
import {
  HOD_BLOCKER_ORDER, HOD_WARNING_ORDER, LEADER_SEAT_TYPES, canonicalIssues, hodPlanFingerprint, isoDate, mapLeaderImport, partitionHodPlan,
  type HodBlocker, type HodPlanRow, type HodWarning, type LeaderImportInput, type LeaderImportPlan, type LeaderSeatType,
} from './leader-seat-model';

const uuid = z.uuid();
const ids = (values: readonly string[]): SQL => (values.length ? sql`array[${sql.join(values.map((v) => sql`${v}::uuid`), sql`, `)}]::uuid[]` : sql`'{}'::uuid[]`);
async function flag(tx: Tx, query: SQL): Promise<boolean> {
  const [row] = await tx.execute<{ ok: boolean | null }>(sql`select (${query}) as ok`);
  return !!row?.ok;
}
async function requireHodWriter(tx: Tx) {
  if (!(await flag(tx, sql`app.onehr_hod_writer()`))) throw Error('A group-wide HR administrator manages heads of department and calibration groups.');
}
async function lockKey(tx: Tx, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
}
async function leaderEvent(tx: Tx, ctx: SessionContext, aggregateId: string, eventType: string, payload: Record<string, unknown>) {
  // Administration history: no subject scoping, so only administrators read it (fail-closed).
  await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'performance-leader', aggregateId, eventType, actor: actorOf(ctx), payload });
}

/** Postgres errors from the 0663 constraints and triggers, as the sentence a person can act on. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  performance_leader_seat_one_holder: 'This seat already has a holder on that date.',
  performance_leader_seat_one_group_per_holder: 'This person already leads another business group on that date.',
  performance_hod_assignment_one_hod: 'This person already has a head of department on that date.',
  performance_calibration_group_member_one_group: 'This person is already in a calibration group on that date.',
  performance_calibration_group_name_uq: 'A calibration group with this name already exists.',
  performance_onehr_calibration_anchor_uq: 'This calibration scope already exists for the cycle.',
};
function pgError(e: unknown): { code?: string; message?: string; constraint?: string } | null {
  let cur = e as { code?: unknown; message?: string; constraint_name?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 5; i++) {
    if (typeof cur.code === 'string' && /^[0-9A-Z]{5}$/.test(cur.code)) return { code: cur.code, message: cur.message, constraint: cur.constraint_name };
    cur = cur.cause as typeof cur;
  }
  return null;
}
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const pg = pgError(e);
    if (pg?.constraint && CONSTRAINT_MESSAGES[pg.constraint]) throw Error(CONSTRAINT_MESSAGES[pg.constraint]);
    if (pg?.code === 'P0001' && pg.message) throw Error(pg.message);
    throw e;
  }
}
const live = (from: unknown, to: unknown, day: string) => sql`${from}<=${day}::date and (${to} is null or ${to}>${day}::date)`;

// ── Seats ───────────────────────────────────────────────────────────────────────────────────────────────

export type LeaderSeatRow = {
  id: string; seatType: LeaderSeatType; companyId: string | null; companyName: string | null; calibrationGroupId: string | null; groupName: string | null;
  holderEmploymentId: string; holderName: string | null; holderEmployeeCode: string | null;
  validFrom: string; validTo: string | null; live: boolean; source: string; endReason: string | null; createdAt: Date; endedAt: Date | null;
};

/**
 * Seats the viewer may read (OneHR administrators of the anchor's company, any OneHR administrator for group
 * chiefs, and holders for their own), newest first within each anchor. Ended seats are history and stay
 * listed unless `liveOnly`.
 */
export async function listLeaderSeats(ctx: SessionContext, raw: unknown = {}): Promise<LeaderSeatRow[]> {
  const p = z.object({ seatType: z.enum(LEADER_SEAT_TYPES).optional(), liveOnly: z.boolean().default(false) }).parse(raw);
  const today = todayInKualaLumpur();
  return withPerformanceTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        seat: leaderSeat, companyName: company.legalName, groupName: calibrationGroup.name,
        holderName: onehrLabel.fullName(leaderSeat.holderEmploymentId), holderEmployeeCode: onehrLabel.employeeCode(leaderSeat.holderEmploymentId),
      })
      .from(leaderSeat)
      .leftJoin(company, eq(company.id, leaderSeat.companyId))
      .leftJoin(calibrationGroup, eq(calibrationGroup.id, leaderSeat.calibrationGroupId))
      .where(and(p.seatType ? eq(leaderSeat.seatType, p.seatType) : undefined, p.liveOnly ? live(leaderSeat.validFrom, leaderSeat.validTo, today) : undefined))
      .orderBy(asc(leaderSeat.seatType), sql`coalesce(${company.legalName},${calibrationGroup.name})`, sql`${leaderSeat.validFrom} desc`, sql`${leaderSeat.createdAt} desc`, asc(leaderSeat.id));
    return rows.map(({ seat, companyName, groupName, holderName, holderEmployeeCode }) => ({
      id: seat.id, seatType: seat.seatType as LeaderSeatType, companyId: seat.companyId, companyName: companyName ?? null,
      calibrationGroupId: seat.calibrationGroupId, groupName: groupName ?? null, holderEmploymentId: seat.holderEmploymentId,
      holderName: holderName ?? null, holderEmployeeCode: holderEmployeeCode ?? null, validFrom: seat.validFrom, validTo: seat.validTo,
      live: seat.validFrom <= today && (seat.validTo === null || seat.validTo > today), source: seat.source, endReason: seat.endReason,
      createdAt: seat.createdAt, endedAt: seat.endedAt,
    }));
  });
}

const appointSchema = z.object({
  seatType: z.enum(LEADER_SEAT_TYPES),
  companyId: uuid.nullable().default(null),
  calibrationGroupId: uuid.nullable().default(null),
  holderEmploymentId: uuid,
  validFrom: isoDate.optional(),
  /** Business unit CEO only: also end the holder's other unit seats (otherwise one person may hold several). */
  moveFromOtherUnits: z.boolean().default(false),
}).refine((p) => (p.seatType === 'group_chief' ? !!p.calibrationGroupId && !p.companyId : !!p.companyId && !p.calibrationGroupId), 'Choose the company or calibration group this seat belongs to.');
type AppointInput = z.infer<typeof appointSchema>;

async function endSeatRowTx(tx: Tx, ctx: SessionContext, row: typeof leaderSeat.$inferSelect, validTo: string, reason: string | null) {
  // Never before today (an end rewrites nobody's past access) and never before the row starts.
  const today = todayInKualaLumpur(), to = [validTo, today, row.validFrom].sort().at(-1)!;
  const ended = await tx.update(leaderSeat).set({ validTo: to, endedBy: ctx.userId!, endedAt: new Date(), endReason: reason })
    .where(and(eq(leaderSeat.id, row.id), isNull(leaderSeat.endedAt))).returning({ id: leaderSeat.id });
  if (!ended.length) throw Error('That seat is outside your companies or has already ended.');
  await leaderEvent(tx, ctx, row.id, 'performance.leader-seat.ended', { seatType: row.seatType, companyId: row.companyId, calibrationGroupId: row.calibrationGroupId, holderEmploymentId: row.holderEmploymentId, validTo: to, reason });
}

/** Appoints a holder, ending the current holder's row on the same day. The successor needs no other change. */
async function appointLeaderSeatTx(tx: Tx, ctx: SessionContext, p: AppointInput, source: 'admin' | 'import', sourceRef: string | null) {
  const today = todayInKualaLumpur(), validFrom = p.validFrom ?? today;
  if (source === 'admin' && validFrom < today) throw Error('A seat cannot start before today.');
  if (!(await flag(tx, sql`app.onehr_leader_seat_writer(${p.seatType}::text,${p.companyId}::uuid)`))) {
    throw Error(p.seatType === 'group_chief' ? 'A group-wide HR administrator appoints group chiefs.' : 'Only a group-wide HR administrator or the HR administrator of the business group can appoint this seat.');
  }
  const anchor = p.companyId ?? p.calibrationGroupId!;
  await lockKey(tx, `onehr-leader-seat:${ctx.tenantId}:${p.seatType}:${anchor}`);
  const anchorRows = await tx.select().from(leaderSeat)
    .where(and(eq(leaderSeat.seatType, p.seatType), p.companyId ? eq(leaderSeat.companyId, p.companyId) : eq(leaderSeat.calibrationGroupId, p.calibrationGroupId!),
      sql`(${leaderSeat.validTo} is null or ${leaderSeat.validTo}>${validFrom}::date)`))
    .orderBy(asc(leaderSeat.validFrom)).for('update');
  if (anchorRows.some((r) => r.validFrom > validFrom)) throw Error('A later appointment is already scheduled for this seat. End it first.');
  const current = anchorRows.find((r) => r.validFrom <= validFrom) ?? null;
  if (current?.holderEmploymentId === p.holderEmploymentId) return { id: current.id, unchanged: true as const };
  if (current) await endSeatRowTx(tx, ctx, current, validFrom, 'replaced');
  // One business group per CEO: appointing someone who leads another group leaves that group vacant.
  // A unit seat move (opt-in) ends the holder's other unit seats the same way.
  if (p.seatType === 'bg_ceo' || (p.seatType === 'bu_ceo' && p.moveFromOtherUnits)) {
    const others = await tx.select().from(leaderSeat)
      .where(and(eq(leaderSeat.seatType, p.seatType), eq(leaderSeat.holderEmploymentId, p.holderEmploymentId), isNull(leaderSeat.endedAt),
        sql`${leaderSeat.companyId} is distinct from ${p.companyId}::uuid`, sql`(${leaderSeat.validTo} is null or ${leaderSeat.validTo}>${validFrom}::date)`))
      .orderBy(asc(leaderSeat.validFrom)).for('update');
    for (const other of others) await endSeatRowTx(tx, ctx, other, validFrom, 'moved');
  }
  const [created] = await tx.insert(leaderSeat).values({
    tenantId: ctx.tenantId, seatType: p.seatType, companyId: p.companyId, calibrationGroupId: p.calibrationGroupId,
    holderEmploymentId: p.holderEmploymentId, validFrom, source, sourceRef, createdBy: ctx.userId!,
  }).returning({ id: leaderSeat.id });
  await leaderEvent(tx, ctx, created.id, 'performance.leader-seat.appointed', {
    seatType: p.seatType, companyId: p.companyId, calibrationGroupId: p.calibrationGroupId, holderEmploymentId: p.holderEmploymentId,
    previousHolderEmploymentId: current?.holderEmploymentId ?? null, validFrom, source,
  });
  return { id: created.id, unchanged: false as const };
}

/** Appoint or change a BU CEO, BG CEO or group chief. `validFrom` defaults to today; it may be later, never earlier. */
export async function appointLeaderSeat(ctx: SessionContext, raw: unknown) {
  const p = appointSchema.parse(raw);
  return withPerformanceTenant(ctx, (tx) => guarded(() => appointLeaderSeatTx(tx, ctx, p, 'admin', null)));
}

/** End a seat. Ending it today removes the holder's access at once; the row stays as history. */
export async function endLeaderSeat(ctx: SessionContext, seatId: string, raw: unknown = {}) {
  uuid.parse(seatId);
  const p = z.object({ validTo: isoDate.optional(), reason: z.string().trim().max(500).optional() }).parse(raw);
  const today = todayInKualaLumpur(), validTo = p.validTo ?? today;
  if (validTo < today) throw Error('A seat cannot end before today.');
  return withPerformanceTenant(ctx, (tx) => guarded(async () => {
    // Read first (readers see the seat), decide authority, then lock: FOR UPDATE applies the write policy.
    const [seen] = await tx.select().from(leaderSeat).where(eq(leaderSeat.id, seatId));
    if (!seen) throw Error('Seat not found.');
    if (!(await flag(tx, sql`app.onehr_leader_seat_writer(${seen.seatType}::text,${seen.companyId}::uuid)`))) throw Error('You cannot change this seat.');
    const [row] = await tx.select().from(leaderSeat).where(eq(leaderSeat.id, seatId)).for('update');
    if (!row) throw Error('You cannot change this seat.');
    if (row.endedAt) throw Error('This seat has already ended.');
    if (row.validTo !== null && row.validTo <= validTo) throw Error('This seat already ends by that date.');
    await endSeatRowTx(tx, ctx, row, validTo, p.reason || null);
    return { id: row.id, validTo: validTo < row.validFrom ? row.validFrom : validTo };
  }));
}

// ── Heads of department ─────────────────────────────────────────────────────────────────────────────────

export type HodAssignmentRow = {
  id: string; subjectEmploymentId: string; subjectName: string | null; subjectEmployeeCode: string | null;
  hodEmploymentId: string; hodName: string | null; validFrom: string; validTo: string | null; live: boolean; source: string;
  overrideReason: string | null; endedAt: Date | null;
};

/** HOD assignments the viewer may read, by HOD then person. `liveOnly` keeps today's. */
export async function listHodAssignments(ctx: SessionContext, raw: unknown = {}): Promise<HodAssignmentRow[]> {
  const p = z.object({ hodEmploymentId: uuid.optional(), subjectEmploymentId: uuid.optional(), liveOnly: z.boolean().default(true) }).parse(raw);
  const today = todayInKualaLumpur();
  return withPerformanceTenant(ctx, async (tx) => {
    const subjectName = onehrLabel.fullName(hodAssignment.subjectEmploymentId), hodName = onehrLabel.fullName(hodAssignment.hodEmploymentId);
    const rows = await tx.select({ row: hodAssignment, subjectName, subjectEmployeeCode: onehrLabel.employeeCode(hodAssignment.subjectEmploymentId), hodName })
      .from(hodAssignment)
      .where(and(p.hodEmploymentId ? eq(hodAssignment.hodEmploymentId, p.hodEmploymentId) : undefined,
        p.subjectEmploymentId ? eq(hodAssignment.subjectEmploymentId, p.subjectEmploymentId) : undefined,
        p.liveOnly ? live(hodAssignment.validFrom, hodAssignment.validTo, today) : undefined))
      .orderBy(asc(hodName), asc(subjectName), sql`${hodAssignment.validFrom} desc`, asc(hodAssignment.id));
    return rows.map(({ row, subjectName: s, subjectEmployeeCode, hodName: h }) => ({
      id: row.id, subjectEmploymentId: row.subjectEmploymentId, subjectName: s ?? null, subjectEmployeeCode: subjectEmployeeCode ?? null,
      hodEmploymentId: row.hodEmploymentId, hodName: h ?? null, validFrom: row.validFrom, validTo: row.validTo,
      live: row.validFrom <= today && (row.validTo === null || row.validTo > today), source: row.source, overrideReason: row.overrideReason, endedAt: row.endedAt,
    }));
  });
}

const hodChangeSchema = z.object({
  subjectEmploymentIds: z.array(uuid).max(20000).default([]),
  departmentIds: z.array(uuid).max(500).default([]),
  /** The new HOD; null removes the HOD (group-wide administrators only, as every HOD write is). */
  hodEmploymentId: uuid.nullable(),
  only: z.union([z.literal('all'), z.literal('unset'), uuid]).default('all'),
  validFrom: isoDate.optional(),
}).refine((p) => p.subjectEmploymentIds.length > 0 || p.departmentIds.length > 0, 'Pick at least one person or department.');
type HodChangeInput = z.infer<typeof hodChangeSchema>;
export type HodPlan = {
  validFrom: string; hodEmploymentId: string | null; source: 'admin' | 'import';
  rows: HodPlanRow[]; unchanged: number; selfExcluded: number; blockers: HodBlocker[]; warnings: HodWarning[]; fingerprint: string;
};

type OpenCycle = { id: string; policy: ReturnType<typeof policySchema.parse> };
async function openCalibrationCyclesTx(tx: Tx): Promise<OpenCycle[]> {
  const rows = await tx.select({ id: reviewCycle.id, policy: onehrCycle.policy }).from(reviewCycle)
    .innerJoin(onehrCycle, and(eq(onehrCycle.cycleId, reviewCycle.id), eq(onehrCycle.tenantId, reviewCycle.tenantId)))
    .where(and(inArray(reviewCycle.status, ['open', 'calibration']), sql`coalesce((${onehrCycle.policy}->'modules'->>'calibration')::boolean,true)`))
    .orderBy(asc(reviewCycle.id));
  return rows.flatMap((r) => { const parsed = policySchema.safeParse(r.policy); return parsed.success ? [{ id: r.id, policy: parsed.data }] : []; });
}
type Placed = { review_id: string; employment_id: string; session_id: string; entry_id: string; anchor_kind: string | null; anchor_employment_id: string | null; entry_locked: boolean; session_locked: boolean; decided: boolean };
async function placedTx(tx: Tx, cycleId: string, tier: 'hod' | 'bu' | 'bg' | 'group'): Promise<Placed[]> {
  return tx.execute<Placed>(sql`select * from app.onehr_calibration_placed(${cycleId}::uuid,${tier}::text) order by review_id, session_id`);
}

/** One plan function shared by preview and apply, so apply refuses anything the preview did not show. */
async function hodPlanTx(tx: Tx, p: HodChangeInput, source: 'admin' | 'import', now = new Date()): Promise<HodPlan> {
  const today = todayInKualaLumpur(now), validFrom = p.validFrom ?? today;
  if (validFrom < today) throw Error('A head of department change cannot start before today.');
  const picked = new Set(p.subjectEmploymentIds);
  if (p.departmentIds.length) {
    const inDepartment = await tx.select({ id: onehrAssignment.employmentId }).from(onehrAssignment)
      .innerJoin(onehrEmployment, eq(onehrEmployment.id, onehrAssignment.employmentId))
      .where(and(inArray(onehrAssignment.departmentId, p.departmentIds), isNull(onehrAssignment.supersededAt), live(onehrAssignment.validFrom, onehrAssignment.validTo, today),
        sql`(${onehrEmployment.terminatedOn} is null or ${onehrEmployment.terminatedOn}>${validFrom}::date)`));
    for (const r of inDepartment) picked.add(r.id);
  }
  const subjectIds = [...picked].sort();
  const people = subjectIds.length ? await tx.select({ id: onehrEmployment.id, personId: onehrEmployment.personId }).from(onehrEmployment).where(inArray(onehrEmployment.id, subjectIds)) : [];
  if (people.length !== subjectIds.length) throw Error('A picked person is not in your companies.');
  let next: { employmentId: string; personId: string } | null = null;
  if (p.hodEmploymentId) {
    const [h] = await tx.select({ id: onehrEmployment.id, personId: onehrEmployment.personId, terminatedOn: onehrEmployment.terminatedOn }).from(onehrEmployment).where(eq(onehrEmployment.id, p.hodEmploymentId));
    if (!h) throw Error('Head of department not found.');
    if (h.terminatedOn && h.terminatedOn <= validFrom) throw Error('The head of department must be an active employee.');
    next = { employmentId: h.id, personId: h.personId };
  }
  const assignments = subjectIds.length ? await tx.select().from(hodAssignment)
    .where(and(inArray(hodAssignment.subjectEmploymentId, subjectIds), sql`(${hodAssignment.validTo} is null or ${hodAssignment.validTo}>${validFrom}::date)`))
    .orderBy(asc(hodAssignment.validFrom), asc(hodAssignment.id)) : [];
  if (assignments.some((a) => a.validFrom > validFrom)) throw Error('A later head of department change is already scheduled for someone picked.');
  const currentOf = new Map(assignments.filter((a) => a.validFrom <= validFrom).map((a) => [a.subjectEmploymentId, a.hodEmploymentId]));
  const { rows, unchanged, selfExcluded } = partitionHodPlan(people.map((x) => ({ employmentId: x.id, personId: x.personId, currentHodEmploymentId: currentOf.get(x.id) ?? null })), next, p.only);
  if (next && rows.length) {
    const nodes = await tx.execute<{ id: string; node: string | null }>(sql`select e.id, app.onehr_business_group_node(e.company_id) as node from app.onehr_employment e where e.id = any(${ids([next.employmentId, ...rows.map((r) => r.subjectEmploymentId)])}) and e.tenant_id=app.current_tenant_id()`);
    const nodeOf = new Map(nodes.map((n) => [n.id, n.node]));
    if (rows.some((r) => nodeOf.get(r.subjectEmploymentId) !== nodeOf.get(next!.employmentId))) throw Error('A head of department can span business units but not business groups.');
  }
  const blockers: HodBlocker[] = [], warnings: HodWarning[] = [];
  const moved = rows.map((r) => r.subjectEmploymentId);
  if (rows.length && validFrom === today) {
    for (const cycle of await openCalibrationCyclesTx(tx)) {
      const reviews = await tx.select({ reviewId: onehrReview.reviewId, employmentId: onehrReview.employmentId }).from(onehrReview)
        .where(and(eq(onehrReview.cycleId, cycle.id), inArray(onehrReview.employmentId, moved)));
      if (!reviews.length) continue;
      const reviewOf = new Map(reviews.map((r) => [r.employmentId, r.reviewId]));
      const [hod, bu, bg] = [await placedTx(tx, cycle.id, 'hod'), await placedTx(tx, cycle.id, 'bu'), await placedTx(tx, cycle.id, 'bg')];
      const anchored = await tx.select({ id: onehrCalibration.id, hod: onehrCalibration.anchorEmploymentId, lockedAt: onehrCalibration.lockedAt, performanceLockedAt: onehrCalibration.performanceLockedAt, potentialLockedAt: onehrCalibration.potentialLockedAt })
        .from(onehrCalibration).where(and(eq(onehrCalibration.cycleId, cycle.id), eq(onehrCalibration.anchorKind, 'hod')));
      const sessionOfHod = new Map(anchored.map((s) => [s.hod!, s]));
      const hodWindowClosed = calibrationWindowState(cycle.policy, 'hod', false, now).window === 'closed';
      for (const r of rows) {
        const reviewId = reviewOf.get(r.subjectEmploymentId);
        if (!reviewId) continue;
        const oldEntries = hod.filter((e) => e.review_id === reviewId && e.anchor_kind === 'hod' && e.anchor_employment_id === r.currentHodEmploymentId);
        if (oldEntries.some((e) => e.session_locked)) blockers.push({ code: 'old_hod_review_submitted', employmentIds: [r.subjectEmploymentId] });
        else if (oldEntries.some((e) => e.decided)) warnings.push({ code: 'old_hod_decision_dropped', employmentIds: [r.subjectEmploymentId] });
        const target = r.nextHodEmploymentId ? sessionOfHod.get(r.nextHodEmploymentId) : undefined;
        if (target && (target.lockedAt || target.performanceLockedAt || target.potentialLockedAt)) blockers.push({ code: 'new_hod_review_submitted', employmentIds: [r.subjectEmploymentId] });
        else if (target && hodWindowClosed) warnings.push({ code: 'new_hod_review_closed', employmentIds: [r.subjectEmploymentId] });
        if (bu.some((e) => e.review_id === reviewId && (e.entry_locked || e.session_locked))) blockers.push({ code: 'bu_review_locked', employmentIds: [r.subjectEmploymentId] });
        if (bg.some((e) => e.review_id === reviewId && (e.entry_locked || e.session_locked))) blockers.push({ code: 'bg_review_locked', employmentIds: [r.subjectEmploymentId] });
      }
    }
  }
  const formerHods = [...new Set(rows.map((r) => r.currentHodEmploymentId).filter((h): h is string => !!h))].sort();
  if (formerHods.length) {
    const remaining = await tx.select({ hod: hodAssignment.hodEmploymentId }).from(hodAssignment)
      .where(and(inArray(hodAssignment.hodEmploymentId, formerHods), live(hodAssignment.validFrom, hodAssignment.validTo, validFrom),
        moved.length ? sql`not (${hodAssignment.subjectEmploymentId} = any(${ids(moved)}))` : undefined));
    const stillHeads = new Set(remaining.map((r) => r.hod));
    const nobody = formerHods.filter((h) => !stillHeads.has(h));
    if (nobody.length) warnings.push({ code: 'former_hod_heads_nobody', employmentIds: nobody });
  }
  if (rows.length && source === 'admin') warnings.push({ code: 'import_overwrites', employmentIds: moved });
  if (rows.length && validFrom > today) warnings.push({ code: 'future_dated_sessions_not_moved', employmentIds: moved });
  const plan = { validFrom, hodEmploymentId: next?.employmentId ?? null, source, rows, unchanged, selfExcluded, blockers: canonicalIssues(blockers, HOD_BLOCKER_ORDER), warnings: canonicalIssues(warnings, HOD_WARNING_ORDER) };
  return { ...plan, fingerprint: hodPlanFingerprint(plan) };
}

export type HodPreviewRow = HodPlanRow & {
  subjectName: string | null; subjectEmployeeCode: string | null; companyName: string | null; departmentName: string | null;
  currentHodName: string | null; nextHodName: string | null;
};
async function previewRowsTx(tx: Tx, rows: readonly HodPlanRow[]): Promise<HodPreviewRow[]> {
  if (!rows.length) return [];
  const today = todayInKualaLumpur();
  const facts = await tx.select({
    id: onehrEmployment.id, name: onehrLabel.fullName(onehrEmployment.id), code: onehrLabel.employeeCode(onehrEmployment.id), companyName: company.legalName,
    departmentName: sql<string | null>`(select d.name from app.onehr_assignment a join department d on d.id=a.department_id where a.employment_id=${onehrEmployment.id} and a.superseded_at is null and ${live(sql`a.valid_from`, sql`a.valid_to`, today)} order by a.valid_from desc, a.id limit 1)`,
  }).from(onehrEmployment).leftJoin(company, eq(company.id, onehrEmployment.companyId))
    .where(inArray(onehrEmployment.id, [...new Set(rows.flatMap((r) => [r.subjectEmploymentId, r.currentHodEmploymentId, r.nextHodEmploymentId]).filter((x): x is string => !!x))]));
  const by = new Map(facts.map((f) => [f.id, f]));
  return rows.map((r) => {
    const s = by.get(r.subjectEmploymentId);
    return {
      ...r, subjectName: s?.name ?? null, subjectEmployeeCode: s?.code ?? null, companyName: s?.companyName ?? null, departmentName: s?.departmentName ?? null,
      currentHodName: r.currentHodEmploymentId ? by.get(r.currentHodEmploymentId)?.name ?? null : null,
      nextHodName: r.nextHodEmploymentId ? by.get(r.nextHodEmploymentId)?.name ?? null : null,
    };
  }).sort((a, b) => (a.subjectName ?? '').localeCompare(b.subjectName ?? '') || a.subjectEmploymentId.localeCompare(b.subjectEmploymentId));
}

/** The fingerprinted preview of an HOD change: rows that change, blockers, warnings. Writes nothing. */
export async function previewHodChange(ctx: SessionContext, raw: unknown) {
  const p = hodChangeSchema.parse(raw);
  return withPerformanceTenant(ctx, async (tx) => {
    await requireHodWriter(tx);
    const plan = await hodPlanTx(tx, p, 'admin');
    return { ...plan, rows: await previewRowsTx(tx, plan.rows) };
  });
}

type HodApplyResult = { changed: number; retired: number; added: number; keptInPlace: number };
async function applyHodPlanTx(tx: Tx, ctx: SessionContext, plan: HodPlan, opts: { sourceRef: string | null; overrideReason: string | null }): Promise<HodApplyResult> {
  const result: HodApplyResult = { changed: 0, retired: 0, added: 0, keptInPlace: 0 };
  for (const r of plan.rows) {
    const [current] = await tx.select().from(hodAssignment)
      .where(and(eq(hodAssignment.subjectEmploymentId, r.subjectEmploymentId), live(hodAssignment.validFrom, hodAssignment.validTo, plan.validFrom))).for('update');
    if ((current?.hodEmploymentId ?? null) !== r.currentHodEmploymentId) throw Error('This change was previewed against different data. Preview it again.');
    if (current) {
      const ended = await tx.update(hodAssignment).set({ validTo: plan.validFrom, endedBy: ctx.userId!, endedAt: new Date() })
        .where(and(eq(hodAssignment.id, current.id), isNull(hodAssignment.endedAt))).returning({ id: hodAssignment.id });
      if (!ended.length) throw Error('This change was previewed against different data. Preview it again.');
    }
    if (r.nextHodEmploymentId) {
      await tx.insert(hodAssignment).values({
        tenantId: ctx.tenantId, subjectEmploymentId: r.subjectEmploymentId, hodEmploymentId: r.nextHodEmploymentId, validFrom: plan.validFrom,
        source: plan.source, sourceRef: opts.sourceRef, overrideReason: opts.overrideReason, createdBy: ctx.userId!,
      });
    }
    await leaderEvent(tx, ctx, r.subjectEmploymentId, r.nextHodEmploymentId ? 'performance.hod.assigned' : 'performance.hod.ended', {
      subjectEmploymentId: r.subjectEmploymentId, fromHodEmploymentId: r.currentHodEmploymentId, toHodEmploymentId: r.nextHodEmploymentId,
      validFrom: plan.validFrom, source: plan.source, overrideReason: opts.overrideReason,
    });
    result.changed++;
  }
  if (opts.overrideReason) {
    await leaderEvent(tx, ctx, plan.hodEmploymentId ?? plan.rows[0]!.subjectEmploymentId, 'performance.hod.override', { blockers: plan.blockers, reason: opts.overrideReason, subjects: plan.rows.map((r) => r.subjectEmploymentId) });
  }
  // D-B2-4: open department reviews follow a change effective today. A future-dated change leaves them as
  // they are (the preview warned); a hand-built department review is never touched.
  if (plan.validFrom !== todayInKualaLumpur() || !plan.rows.length) return result;
  for (const cycle of await openCalibrationCyclesTx(tx)) {
    const reviews = await tx.select({ reviewId: onehrReview.reviewId, employmentId: onehrReview.employmentId }).from(onehrReview)
      .where(and(eq(onehrReview.cycleId, cycle.id), inArray(onehrReview.employmentId, plan.rows.map((r) => r.subjectEmploymentId))));
    if (!reviews.length) continue;
    const reviewOf = new Map(reviews.map((r) => [r.employmentId, r.reviewId]));
    const anchored = await tx.select({ id: onehrCalibration.id, hod: onehrCalibration.anchorEmploymentId }).from(onehrCalibration)
      .where(and(eq(onehrCalibration.cycleId, cycle.id), eq(onehrCalibration.anchorKind, 'hod')));
    const sessionOfHod = new Map(anchored.map((s) => [s.hod!, s.id]));
    let placed = await placedTx(tx, cycle.id, 'hod');
    for (const r of plan.rows) {
      const reviewId = reviewOf.get(r.subjectEmploymentId);
      if (!reviewId) continue;
      for (const entry of placed.filter((e) => e.review_id === reviewId && e.anchor_kind === 'hod' && e.anchor_employment_id === r.currentHodEmploymentId)) {
        await tx.execute(sql`select app.onehr_retire_calibration_entry(${entry.entry_id}::uuid,'hod_changed')`);
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'onehr', aggregateId: entry.session_id, eventType: 'onehr.calibration-entry-retired', actor: actorOf(ctx), payload: { reviewId, reason: 'hod_changed' } });
        result.retired++;
      }
      placed = await placedTx(tx, cycle.id, 'hod');
      const target = r.nextHodEmploymentId ? sessionOfHod.get(r.nextHodEmploymentId) : undefined;
      if (!target) continue;
      if (placed.some((e) => e.review_id === reviewId)) { result.keptInPlace++; continue; }
      if (!(await flag(tx, sql`app.assessment_review_participates(${reviewId}::uuid)`))) continue;
      await tx.insert(onehrCalibrationEntry).values({ tenantId: ctx.tenantId, sessionId: target, reviewId, employmentId: r.subjectEmploymentId });
      result.added++;
    }
  }
  return result;
}

const applySchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  acknowledged: z.boolean().default(false),
  overrideReason: z.string().trim().max(500).optional(),
});
/** Blockers refuse unless a group-wide administrator gives a reason; the reason is recorded and audited. */
async function admitOverride(tx: Tx, blocked: boolean, reason: string | undefined): Promise<string | null> {
  if (!blocked) return null;
  if (!reason) throw Error('Locked calibration work blocks this change. A group-wide HR administrator may apply it with a reason.');
  if (!(await flag(tx, sql`app.onehr_leader_admin(null)`))) throw Error('Only a group-wide HR administrator may override locked calibration work.');
  return reason;
}

/**
 * Applies a previewed HOD change. Refuses a stale fingerprint, unacknowledged warnings, and blockers without
 * a group-wide override reason (recorded on the new rows and audited). Each person's current row is ended
 * and the new one inserted in this transaction, then open department reviews follow (D-B2-4).
 */
export async function applyHodChange(ctx: SessionContext, raw: unknown) {
  const p = hodChangeSchema.parse(raw), a = applySchema.parse(raw);
  return withPerformanceTenant(ctx, (tx) => guarded(async () => {
    await requireHodWriter(tx);
    await lockKey(tx, `onehr-hod:${ctx.tenantId}`);
    const plan = await hodPlanTx(tx, p, 'admin');
    if (plan.fingerprint !== a.fingerprint) throw Error('This change was previewed against different data. Preview it again.');
    if (plan.warnings.length && !a.acknowledged) throw Error('Confirm that you have read the warnings before applying this change.');
    const overrideReason = await admitOverride(tx, plan.blockers.length > 0, a.overrideReason);
    return applyHodPlanTx(tx, ctx, plan, { sourceRef: null, overrideReason });
  }));
}

// ── Calibration groups (D-B2-1) ─────────────────────────────────────────────────────────────────────────

const groupName = z.string().trim().min(1).max(200);

/** Calibration groups with today's chief and live member count. Retired groups stay listed as history. */
export async function listCalibrationGroups(ctx: SessionContext) {
  const today = todayInKualaLumpur();
  return withPerformanceTenant(ctx, async (tx) => {
    const groups = await tx.select().from(calibrationGroup).orderBy(sql`${calibrationGroup.retiredAt} is not null`, sql`lower(${calibrationGroup.name})`, asc(calibrationGroup.id));
    if (!groups.length) return [];
    const chiefs = await tx.select({ id: leaderSeat.id, groupId: leaderSeat.calibrationGroupId, employmentId: leaderSeat.holderEmploymentId, name: onehrLabel.fullName(leaderSeat.holderEmploymentId) })
      .from(leaderSeat).where(and(eq(leaderSeat.seatType, 'group_chief'), live(leaderSeat.validFrom, leaderSeat.validTo, today)));
    const counts = await tx.select({ groupId: calibrationGroupMember.groupId, n: sql<number>`count(*)::int` }).from(calibrationGroupMember)
      .where(live(calibrationGroupMember.validFrom, calibrationGroupMember.validTo, today)).groupBy(calibrationGroupMember.groupId);
    return groups.map((g) => {
      const chief = chiefs.find((c) => c.groupId === g.id);
      return { id: g.id, name: g.name, retiredAt: g.retiredAt, members: counts.find((c) => c.groupId === g.id)?.n ?? 0, chief: chief ? { seatId: chief.id, employmentId: chief.employmentId, name: chief.name ?? null } : null };
    });
  });
}

export async function createCalibrationGroup(ctx: SessionContext, raw: unknown) {
  const p = z.object({ name: groupName }).parse(raw);
  return withPerformanceTenant(ctx, (tx) => guarded(async () => {
    await requireHodWriter(tx);
    const [g] = await tx.insert(calibrationGroup).values({ tenantId: ctx.tenantId, name: p.name, createdBy: ctx.userId! }).returning({ id: calibrationGroup.id });
    await leaderEvent(tx, ctx, g.id, 'performance.calibration-group.created', { name: p.name });
    return g.id;
  }));
}

export async function renameCalibrationGroup(ctx: SessionContext, groupId: string, raw: unknown) {
  uuid.parse(groupId);
  const p = z.object({ name: groupName }).parse(raw);
  return withPerformanceTenant(ctx, (tx) => guarded(async () => {
    await requireHodWriter(tx);
    const [before] = await tx.select().from(calibrationGroup).where(eq(calibrationGroup.id, groupId)).for('update');
    if (!before || before.retiredAt) throw Error('Calibration group not found or retired.');
    await tx.update(calibrationGroup).set({ name: p.name }).where(eq(calibrationGroup.id, groupId));
    await leaderEvent(tx, ctx, groupId, 'performance.calibration-group.renamed', { from: before.name, to: p.name });
  }));
}

/** Retires a group: today ends its chief seat and its memberships (all kept as history), then the group. */
export async function retireCalibrationGroup(ctx: SessionContext, groupId: string) {
  uuid.parse(groupId);
  const today = todayInKualaLumpur();
  return withPerformanceTenant(ctx, (tx) => guarded(async () => {
    await requireHodWriter(tx);
    const [g] = await tx.select().from(calibrationGroup).where(eq(calibrationGroup.id, groupId)).for('update');
    if (!g || g.retiredAt) throw Error('Calibration group not found or retired.');
    const seats = await tx.select().from(leaderSeat).where(and(eq(leaderSeat.calibrationGroupId, groupId), isNull(leaderSeat.endedAt), sql`(${leaderSeat.validTo} is null or ${leaderSeat.validTo}>${today}::date)`)).for('update');
    for (const s of seats) await endSeatRowTx(tx, ctx, s, today, 'group_retired');
    const members = await tx.select().from(calibrationGroupMember).where(and(eq(calibrationGroupMember.groupId, groupId), isNull(calibrationGroupMember.endedAt), sql`(${calibrationGroupMember.validTo} is null or ${calibrationGroupMember.validTo}>${today}::date)`)).for('update');
    for (const m of members) await tx.update(calibrationGroupMember).set({ validTo: m.validFrom > today ? m.validFrom : today, endedBy: ctx.userId!, endedAt: new Date() }).where(eq(calibrationGroupMember.id, m.id));
    await tx.update(calibrationGroup).set({ retiredAt: new Date(), retiredBy: ctx.userId! }).where(eq(calibrationGroup.id, groupId));
    await leaderEvent(tx, ctx, groupId, 'performance.calibration-group.retired', { endedSeats: seats.length, endedMembers: members.length });
  }));
}

export async function listCalibrationGroupMembers(ctx: SessionContext, groupId: string, raw: unknown = {}) {
  uuid.parse(groupId);
  const p = z.object({ liveOnly: z.boolean().default(true) }).parse(raw);
  const today = todayInKualaLumpur();
  return withPerformanceTenant(ctx, async (tx) => {
    const name = onehrLabel.fullName(calibrationGroupMember.employmentId);
    const rows = await tx.select({ m: calibrationGroupMember, name, code: onehrLabel.employeeCode(calibrationGroupMember.employmentId) }).from(calibrationGroupMember)
      .where(and(eq(calibrationGroupMember.groupId, groupId), p.liveOnly ? live(calibrationGroupMember.validFrom, calibrationGroupMember.validTo, today) : undefined))
      .orderBy(asc(name), asc(calibrationGroupMember.id));
    return rows.map(({ m, name: n, code }) => ({ id: m.id, employmentId: m.employmentId, name: n ?? null, employeeCode: code ?? null, segment: m.segment, source: m.source, validFrom: m.validFrom, validTo: m.validTo, endedAt: m.endedAt }));
  });
}

async function addMembersTx(tx: Tx, ctx: SessionContext, groupId: string, p: { employmentIds: string[]; segment: string | null; source: 'department' | 'person' | 'import'; validFrom: string }) {
  for (const employmentId of [...new Set(p.employmentIds)].sort()) {
    await tx.insert(calibrationGroupMember).values({ tenantId: ctx.tenantId, groupId, employmentId, segment: p.segment, source: p.source, validFrom: p.validFrom, createdBy: ctx.userId! });
  }
  await leaderEvent(tx, ctx, groupId, 'performance.calibration-group.members-added', { employmentIds: [...new Set(p.employmentIds)].sort(), segment: p.segment, source: p.source, validFrom: p.validFrom });
}

/** Adds people to a group from `validFrom` (today by default). A person is in one group at a time. */
export async function addCalibrationGroupMembers(ctx: SessionContext, groupId: string, raw: unknown) {
  uuid.parse(groupId);
  const p = z.object({ employmentIds: z.array(uuid).min(1).max(5000), segment: z.string().trim().max(120).nullable().default(null), source: z.enum(['department', 'person']).default('person'), validFrom: isoDate.optional() }).parse(raw);
  const today = todayInKualaLumpur(), validFrom = p.validFrom ?? today;
  if (validFrom < today) throw Error('A membership cannot start before today.');
  return withPerformanceTenant(ctx, (tx) => guarded(async () => {
    await requireHodWriter(tx);
    await addMembersTx(tx, ctx, groupId, { employmentIds: p.employmentIds, segment: p.segment || null, source: p.source, validFrom });
  }));
}

export async function endCalibrationGroupMember(ctx: SessionContext, memberId: string, raw: unknown = {}) {
  uuid.parse(memberId);
  const p = z.object({ validTo: isoDate.optional() }).parse(raw);
  const today = todayInKualaLumpur(), validTo = p.validTo ?? today;
  if (validTo < today) throw Error('A membership cannot end before today.');
  return withPerformanceTenant(ctx, (tx) => guarded(async () => {
    await requireHodWriter(tx);
    const [m] = await tx.select().from(calibrationGroupMember).where(eq(calibrationGroupMember.id, memberId)).for('update');
    if (!m || m.endedAt) throw Error('Membership not found or already ended.');
    const to = validTo < m.validFrom ? m.validFrom : validTo;
    await tx.update(calibrationGroupMember).set({ validTo: to, endedBy: ctx.userId!, endedAt: new Date() }).where(eq(calibrationGroupMember.id, memberId));
    await leaderEvent(tx, ctx, m.groupId, 'performance.calibration-group.member-ended', { memberId, employmentId: m.employmentId, validTo: to });
  }));
}

// ── Scope generation (D-B2-5) ───────────────────────────────────────────────────────────────────────────

const GENERATED_TIERS = ['hod', 'bu', 'bg', 'group'] as const;
type GeneratedTier = (typeof GENERATED_TIERS)[number];
const anchorKindOf: Record<GeneratedTier, 'hod' | 'bu_ceo' | 'bg_ceo' | 'group_chief'> = { hod: 'hod', bu: 'bu_ceo', bg: 'bg_ceo', group: 'group_chief' };
export type GeneratedScopes = {
  created: { id: string; tier: GeneratedTier; anchorId: string; name: string; people: number }[];
  extended: { id: string; tier: GeneratedTier; anchorId: string; added: number }[];
  skipped: { tier: GeneratedTier; anchorId: string; reason: 'outside_your_companies' | 'already_placed' }[];
};

/**
 * One anchored calibration scope per (tier, anchor) with people, created idempotently; a repeat run adds
 * only people newly in scope. Population comes from the leaders registry: HOD from live HOD assignments,
 * BU from the review's company, BG from the company's group node, Group from live group membership.
 * Reviewer grants are empty: the live seat decides who calibrates. Hand-built scopes are left as they are,
 * never anchored, and a person already placed at a tier stays where they are.
 */
export async function generateCalibrationScopes(ctx: SessionContext, cycleId: string, raw: unknown = {}): Promise<GeneratedScopes> {
  uuid.parse(cycleId);
  const p = z.object({ tiers: z.array(z.enum(GENERATED_TIERS)).min(1).default([...GENERATED_TIERS]) }).parse(raw);
  const today = todayInKualaLumpur();
  return withPerformanceTenant(ctx, (tx) => guarded(async () => {
    await calibrationAssignableCycleTx(tx, cycleId);
    await lockKey(tx, `onehr-calibration-generate:${cycleId}`);
    const out: GeneratedScopes = { created: [], extended: [], skipped: [] };
    const reviews = await tx.select({ reviewId: onehrReview.reviewId, employmentId: onehrReview.employmentId, companyId: onehrReview.companyId }).from(onehrReview)
      .where(and(eq(onehrReview.cycleId, cycleId), sql`app.assessment_review_participates(${onehrReview.reviewId})`)).orderBy(asc(onehrReview.reviewId));
    if (!reviews.length) return out;
    const companies = await tx.select({ id: company.id, name: company.legalName, parent: company.parentCompanyId, hasUnits: sql<boolean>`exists(select 1 from company ch where ch.parent_company_id=${company.id} and ch.tenant_id=${company.tenantId})` }).from(company);
    const companyOf = new Map(companies.map((c) => [c.id, c]));
    for (const tier of GENERATED_TIERS.filter((t) => p.tiers.includes(t))) {
      // anchor id → { companyId of the scope, name, reviews }
      type Scope = { companyId: string | null; name: string; reviewIds: string[]; employmentOf: Map<string, string> };
      const scopes = new Map<string, Scope>();
      const add = (anchorId: string, companyId: string | null, name: string, r: (typeof reviews)[number]) => {
        const scope: Scope = scopes.get(anchorId) ?? { companyId, name, reviewIds: [], employmentOf: new Map<string, string>() };
        scope.reviewIds.push(r.reviewId); scope.employmentOf.set(r.reviewId, r.employmentId); scopes.set(anchorId, scope);
      };
      if (tier === 'hod') {
        const assignments = await tx.select({ subject: hodAssignment.subjectEmploymentId, hod: hodAssignment.hodEmploymentId }).from(hodAssignment)
          .where(and(inArray(hodAssignment.subjectEmploymentId, reviews.map((r) => r.employmentId)), live(hodAssignment.validFrom, hodAssignment.validTo, today)));
        const hodOf = new Map(assignments.map((a) => [a.subject, a.hod]));
        const hods = [...new Set(assignments.map((a) => a.hod))];
        const heads = hods.length ? await tx.execute<{ id: string; node: string | null; name: string | null; code: string | null }>(sql`
          select e.id, app.onehr_business_group_node(e.company_id) as node,
           (select l.full_name from app.onehr_person_labels(array[e.id]) l) as name, (select l.employee_code from app.onehr_person_labels(array[e.id]) l) as code
          from app.onehr_employment e where e.id = any(${ids(hods)}) and e.tenant_id=app.current_tenant_id()`) : [];
        const headOf = new Map(heads.map((h) => [h.id, h]));
        for (const r of reviews) { const h = hodOf.get(r.employmentId), head = h ? headOf.get(h) : undefined; if (h && head) add(h, head.node, head.name ?? head.code ?? h, r); }
      } else if (tier === 'bu') {
        for (const r of reviews) add(r.companyId, r.companyId, companyOf.get(r.companyId)?.name ?? r.companyId, r);
      } else if (tier === 'bg') {
        for (const r of reviews) {
          const c = companyOf.get(r.companyId), node = c ? c.parent ?? c.id : null, nodeRow = node ? companyOf.get(node) : undefined;
          if (node && nodeRow?.hasUnits) add(node, node, nodeRow.name, r);
        }
      } else {
        const members = await tx.select({ groupId: calibrationGroupMember.groupId, employmentId: calibrationGroupMember.employmentId, name: calibrationGroup.name }).from(calibrationGroupMember)
          .innerJoin(calibrationGroup, and(eq(calibrationGroup.id, calibrationGroupMember.groupId), isNull(calibrationGroup.retiredAt)))
          .where(and(inArray(calibrationGroupMember.employmentId, reviews.map((r) => r.employmentId)), live(calibrationGroupMember.validFrom, calibrationGroupMember.validTo, today)));
        const groupOf = new Map(members.map((m) => [m.employmentId, m]));
        for (const r of reviews) { const m = groupOf.get(r.employmentId); if (m) add(m.groupId, null, m.name, r); }
      }
      const placed = new Set((await placedTx(tx, cycleId, tier)).map((e) => e.review_id));
      const kind = anchorKindOf[tier];
      for (const [anchorId, scope] of [...scopes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const inScope = await flag(tx, scope.companyId ? sql`app.onehr_admin(${scope.companyId}::uuid)` : sql`app.onehr_admin(null)`);
        if (!inScope) { out.skipped.push({ tier, anchorId, reason: 'outside_your_companies' }); continue; }
        const fresh = scope.reviewIds.filter((id) => !placed.has(id));
        const [existing] = await tx.select({ id: onehrCalibration.id }).from(onehrCalibration)
          .where(and(eq(onehrCalibration.cycleId, cycleId), eq(onehrCalibration.anchorKind, kind),
            sql`coalesce(${onehrCalibration.anchorEmploymentId},${onehrCalibration.calibrationGroupId},${onehrCalibration.companyId})=${anchorId}::uuid`));
        if (!fresh.length) { if (!existing) out.skipped.push({ tier, anchorId, reason: 'already_placed' }); continue; }
        let sessionId = existing?.id;
        if (!sessionId) {
          const [created] = await tx.insert(onehrCalibration).values({
            tenantId: ctx.tenantId, cycleId, companyId: scope.companyId, name: scope.name.slice(0, 300), tier, reviewerUserIds: [], pbtAchievement: null, mode: 'after', bgWeight: 50,
            anchorKind: kind, anchorEmploymentId: tier === 'hod' ? anchorId : null, calibrationGroupId: tier === 'group' ? anchorId : null,
          }).returning({ id: onehrCalibration.id });
          sessionId = created.id;
        }
        for (const reviewId of fresh) await tx.insert(onehrCalibrationEntry).values({ tenantId: ctx.tenantId, sessionId, reviewId, employmentId: scope.employmentOf.get(reviewId)! });
        for (const id of fresh) placed.add(id);
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'onehr', aggregateId: sessionId, eventType: existing ? 'onehr.calibration-extended' : 'onehr.calibration-assigned', actor: actorOf(ctx), payload: { tier, count: fresh.length, anchorKind: kind, generated: true } });
        if (existing) out.extended.push({ id: sessionId, tier, anchorId, added: fresh.length });
        else out.created.push({ id: sessionId, tier, anchorId, name: scope.name.slice(0, 300), people: fresh.length });
      }
    }
    return out;
  }));
}

// ── Leader import ───────────────────────────────────────────────────────────────────────────────────────

const importApplySchema = z.object({ apply: z.boolean().default(false), fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(), acknowledged: z.boolean().default(false), overrideReason: z.string().trim().max(500).optional() });

async function importPlanTx(tx: Tx, raw: LeaderImportInput) {
  const today = todayInKualaLumpur();
  const employments = await tx.select({ id: onehrEmployment.id, code: onehrEmployment.employeeCode }).from(onehrEmployment)
    .where(sql`${onehrEmployment.employeeCode} is not null and (${onehrEmployment.terminatedOn} is null or ${onehrEmployment.terminatedOn}>${today}::date)`);
  const companies = await tx.select({ id: company.id, label: company.companyLabel, legal: company.legalName }).from(company);
  const groups = await tx.select({ id: calibrationGroup.id, name: calibrationGroup.name }).from(calibrationGroup).where(isNull(calibrationGroup.retiredAt));
  const index = <T>(rows: readonly T[], keys: (r: T) => (string | null)[], id: (r: T) => string) => {
    const m = new Map<string, string[]>();
    for (const r of rows) for (const k of new Set(keys(r).filter((x): x is string => !!x).map((x) => x.trim().toLowerCase()))) m.set(k, [...(m.get(k) ?? []), id(r)]);
    return m;
  };
  const plan: LeaderImportPlan = mapLeaderImport(raw, {
    employmentsByCode: index(employments, (e) => [e.code], (e) => e.id),
    companiesByKey: index(companies, (c) => [c.label, c.legal], (c) => c.id),
    groupsByName: index(groups, (g) => [g.name], (g) => g.id),
  });
  const hod = [];
  for (const change of plan.hod) hod.push(await hodPlanTx(tx, { subjectEmploymentIds: change.subjectEmploymentIds, departmentIds: [], hodEmploymentId: change.hodEmploymentId, only: 'all', validFrom: today }, 'import'));
  const fingerprint = createHash('sha256').update(JSON.stringify({
    hod: hod.map((h) => h.fingerprint),
    seats: plan.seats.map((s) => [s.line, s.seatType, s.companyId, s.calibrationGroupId, s.holderEmploymentId, s.validFrom]),
    errors: plan.errors.map((e) => [e.kind, e.line]),
  })).digest('hex');
  return { plan, hod, fingerprint };
}

/**
 * Leader import from already-parsed rows (person employee ID → HOD employee ID; seat rows). Blank leaves a
 * value as it is, NONE removes it. Rows resolve to existing employments, companies and groups only. A
 * preview (`apply: false`) returns the resolved plan, each HOD change's blockers and warnings, line errors
 * and a fingerprint; apply requires that fingerprint, no line errors, acknowledged warnings and an override
 * reason for blockers, then writes through the same writers as the screen with source 'import'. HOD rows
 * start today (the cutover). A seat row may carry its original start date only when its seat has no row on
 * or after that date; otherwise it starts today.
 */
export async function importLeaders(ctx: SessionContext, raw: LeaderImportInput, rawOptions: unknown = {}) {
  const o = importApplySchema.parse(rawOptions);
  return withPerformanceTenant(ctx, (tx) => guarded(async () => {
    if ((raw.hodRows?.length ?? 0) > 0) await requireHodWriter(tx);
    await lockKey(tx, `onehr-hod:${ctx.tenantId}`);
    const { plan, hod, fingerprint } = await importPlanTx(tx, raw);
    const blockers = hod.flatMap((h) => h.blockers), warnings = hod.flatMap((h) => h.warnings);
    if (!o.apply) return { applied: false as const, plan, hod: await Promise.all(hod.map(async (h) => ({ ...h, rows: await previewRowsTx(tx, h.rows) }))), errors: plan.errors, fingerprint };
    if (plan.errors.length) throw Error('Fix the rows with errors before applying the import.');
    if (o.fingerprint !== fingerprint) throw Error('This import was previewed against different data. Preview it again.');
    if (warnings.length && !o.acknowledged) throw Error('Confirm that you have read the warnings before applying this import.');
    const overrideReason = await admitOverride(tx, blockers.length > 0, o.overrideReason);
    const result = { applied: true as const, hod: { changed: 0, retired: 0, added: 0, keptInPlace: 0 }, seats: { appointed: 0, ended: 0, unchanged: 0 } };
    for (const h of hod) {
      const r = await applyHodPlanTx(tx, ctx, h, { sourceRef: 'import', overrideReason: h.blockers.length ? overrideReason : null });
      result.hod.changed += r.changed; result.hod.retired += r.retired; result.hod.added += r.added; result.hod.keptInPlace += r.keptInPlace;
    }
    const today = todayInKualaLumpur();
    for (const s of plan.seats) {
      if (s.holderEmploymentId === null) {
        if (!(await flag(tx, sql`app.onehr_leader_seat_writer(${s.seatType}::text,${s.companyId}::uuid)`))) throw Error(`Seat row ${s.line}: you cannot change this seat.`);
        const current = await tx.select().from(leaderSeat).where(and(eq(leaderSeat.seatType, s.seatType), s.companyId ? eq(leaderSeat.companyId, s.companyId) : eq(leaderSeat.calibrationGroupId, s.calibrationGroupId!), isNull(leaderSeat.endedAt), sql`(${leaderSeat.validTo} is null or ${leaderSeat.validTo}>${today}::date)`)).for('update');
        if (!current.length) { result.seats.unchanged++; continue; }
        for (const row of current) await endSeatRowTx(tx, ctx, row, today, 'import');
        result.seats.ended++;
        continue;
      }
      let validFrom = today;
      if (s.validFrom && s.validFrom < today) {
        const [later] = await tx.select({ id: leaderSeat.id }).from(leaderSeat).where(and(eq(leaderSeat.seatType, s.seatType), s.companyId ? eq(leaderSeat.companyId, s.companyId) : eq(leaderSeat.calibrationGroupId, s.calibrationGroupId!), sql`(${leaderSeat.validTo} is null or ${leaderSeat.validTo}>${s.validFrom}::date)`)).limit(1);
        if (!later) validFrom = s.validFrom;
      } else if (s.validFrom) validFrom = s.validFrom;
      const r = await appointLeaderSeatTx(tx, ctx, { seatType: s.seatType, companyId: s.companyId, calibrationGroupId: s.calibrationGroupId, holderEmploymentId: s.holderEmploymentId, validFrom, moveFromOtherUnits: false }, 'import', 'import');
      if (r.unchanged) result.seats.unchanged++; else result.seats.appointed++;
    }
    return result;
  }));
}
