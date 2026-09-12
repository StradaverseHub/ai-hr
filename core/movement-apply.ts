/**
 * 941c9dac — the overnight pass that puts FUTURE-DATED movements into effect on the morning of their
 * effective date.
 *
 * Runs inside scripts/review-sweep.ts (the existing nightly job — no second cron), shaped on
 * sweepLeaveApprovalEscalations (core/leave-escalation.ts) and sweepReviewReminders
 * (core/employment-review.ts).
 *
 * IDEMPOTENCY. No ledger table and no "last run" marker: the domain_event log IS the memory of what has
 * already been applied. A movement is due iff the ledger says so — an `employment.movement.scheduled`
 * event with no `employment.movement.applied` and no `employment.movement.reversed` against it, that has
 * not been superseded by a conflicting movement which already arrived. Applying it appends the applied
 * event, which takes it out of that set permanently. Running the sweep twice on the same morning
 * therefore does nothing the second time, and a crash halfway through leaves the remaining movements
 * still due. Migration 0329 makes this a hard guarantee rather than a race: a partial UNIQUE INDEX on
 * (tenant_id, payload->>'scheduledId') for applied events means two concurrent sweeps cannot both record
 * an application — the loser's transaction fails and rolls back whole, the legs it wrote included.
 *
 * ISOLATION. One transaction per EMPLOYMENT, not one for the pass. A movement that cannot be applied
 * (say a non-movement writer moved the assignment underneath it, so the effective date now predates the
 * open row) rolls back only that employee's work and is counted as a failure — it never costs the other
 * employees their applications. The failure is durable and visible rather than silently swallowed,
 * because a movement that quietly refuses to take effect is exactly the fault this item exists to fix.
 */
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { domainEvent } from '../db/schema';
import { applyDueMovementsTx } from './movement';
// 9e2a89e9 — the pre-write grade read. core/ → core/, no pack boundary crossed.
import { employmentGradeId } from './org';
// Through the pack facade, not `core/leave` directly: this file is NEW, and ADR-0080 D9's import
// ratchet only ever shrinks its allowlist (test/leave-pack-drift.test.ts).
import { reprojectEntitlementForEmployment } from '../packs/leave/service';
import { todayInKualaLumpur } from '../lib/hr-date';

export type MovementSweepResult = {
  /** Movements that took effect this pass. */
  applied: number;
  /** Movements that arrived to find their values already in place — recorded as applied, never retried. */
  noop: number;
  /** Employments whose pass failed and rolled back. Counted and logged, never fatal to the sweep. */
  failed: number;
};

/**
 * One nightly pass over a tenant. `today` is injectable for tests and defaults to the KL local date —
 * the cron runs 03:00 MYT, which is still "yesterday" in UTC, so a UTC slice would apply every movement
 * a day late. That matters more here than anywhere else in the codebase: "never before, and never
 * delayed past it" is the entire requirement.
 */
export async function sweepDueMovements(
  ctx: SessionContext,
  opts: { today?: string } = {},
): Promise<MovementSweepResult> {
  const today = opts.today ?? todayInKualaLumpur();

  // The candidate employments: anyone with a scheduled movement whose effective date has arrived and
  // which has no application recorded against it yet. Reversal and supersession are NOT filtered here —
  // they are decided per employment by the projection, so there is exactly ONE implementation of those
  // rules and the sweep can never disagree with what the Employment History screen shows.
  const candidates = await withTenant(ctx, async (tx) =>
    tx
      .selectDistinct({ employmentId: domainEvent.subjectEmploymentId })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.tenantId, ctx.tenantId),
          eq(domainEvent.eventType, 'employment.movement.scheduled'),
          sql`${domainEvent.payload} ->> 'effectiveDate' <= ${today}`,
          sql`not exists (
            select 1 from domain_event a
            where a.tenant_id = ${ctx.tenantId}
              and a.event_type = 'employment.movement.applied'
              and a.payload ->> 'scheduledId' = ${domainEvent.id}::text
          )`,
          sql`not exists (
            select 1 from domain_event r
            where r.tenant_id = ${ctx.tenantId}
              and r.event_type = 'employment.movement.reversed'
              and r.payload ->> 'movementId' = ${domainEvent.id}::text
          )`,
        ),
      ),
  );

  let applied = 0;
  let noop = 0;
  let failed = 0;
  for (const c of candidates) {
    if (!c.employmentId) continue;
    try {
      // 9e2a89e9 — READ BEFORE THE WRITE, for the same reason the save path does: after the movement has
      // been applied, employment.grade_id is the NEW grade. One indexed read per employment that has a
      // movement due, which is a handful a morning.
      const gradeBefore = { gradeId: await employmentGradeId(ctx, c.employmentId) };
      // One transaction per employment: the legs and the applied event land together or not at all.
      const r = await withTenant(ctx, (tx) => applyDueMovementsTx(tx, ctx, c.employmentId!, today));
      applied += r.applied;
      noop += r.noop;

      // R45 7527ea5f parity. A movement can move job grade, employment type or the org placement, and all
      // three feed grade-scoped / benefit-scheme leave entitlement. The SAVE path recomputes for every
      // comparison kind (createMovementEventAction); a scheduled movement must not skip it just because a
      // cron applied it instead of an admin — the symptom would be an employee silently left on a stale
      // entitlement band. Best-effort and AFTER the commit, exactly as the save path does it: the
      // recompute is idempotent and self-healing, so a hiccup here must never undo an application that
      // has already, correctly, taken effect.
      if (r.applied > 0) {
        try {
          await reprojectEntitlementForEmployment(ctx, {
            employmentId: c.employmentId,
            trigger: 'movement_applied',
            // 9e2a89e9 — the two grades and the date the promotion TOOK EFFECT. `appliedEffectiveDate`
            // rather than `today`: a sweep that has not run for three days is applying movements whose
            // dates have already passed, and the record must say when the change happened, not when the
            // cron noticed. `asOf` is deliberately NOT moved — that would change the arithmetic.
            gradeBefore,
            changeEffectiveOn: r.appliedEffectiveDate,
          });
        } catch {
          // non-fatal — re-runs on the next profile trigger or policy edit.
        }
      }
    } catch (e) {
      failed += 1;
      console.warn(
        `movement-apply: employment ${c.employmentId} — scheduled movement could not be applied: ${(e as Error).message}`,
      );
    }
  }

  // One summary event per run that did work (the sweep convention — zero-work runs append nothing).
  if (applied > 0 || noop > 0 || failed > 0) {
    await withTenant(ctx, (tx) =>
      appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'movement-apply-sweep',
        aggregateId: ctx.tenantId, // tenant-level virtual aggregate (mirrors the escalation sweep)
        eventType: 'employment.movements.swept',
        actor: actorOf(ctx),
        payload: { today, applied, noop, failed },
      }),
    );
  }

  return { applied, noop, failed };
}
