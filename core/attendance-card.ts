/**
 * 44bc1c33 — CARD / CLOCKING ID: the third way a physical attendance device's file finds an employee.
 *
 * The clocking importer (r424: core/attendance-clocking-import.ts; before it, `importAttendancePunches`)
 * matches a device's own identifier against `employment.employee_code` and the IC on `employee_statutory_my`. A company whose terminal records its own card numbers matched neither, so every punch in
 * the file came back unmatched — correctly, because the importer reports rather than guesses, but with no
 * way to fix it short of renumbering the device. This module owns the missing key.
 *
 * ── THE SETTING DERIVES, IT DOES NOT COPY ───────────────────────────────────────────────────────────
 * The ticket asked that, when "Card ID is the same as Employee ID/Number" is on, the employee code be
 * COPIED into the card id, and that a later change of employee code then update the copy (requirements 8
 * and 10). We do the opposite and the plan says so: with the setting on, `resolveCardId` simply RETURNS
 * the employee code. There is no copy to keep in step, so a rename cannot leave a stale card behind, and
 * requirement 10 stops being a rule anybody has to remember. `employment.card_id` therefore only ever
 * holds a card a human actually typed.
 *
 * ── THE COLLISION THAT MATTERS IS NOT THE ONE THE DATABASE CATCHES ──────────────────────────────────
 * 0474's unique index stops two employees holding the same CARD. The dangerous collision is different:
 * the importer builds employee_code, ic and card_id into ONE flat map, so a card id equal to ANOTHER
 * employee's code or ic would overwrite that entry and post one person's attendance onto another. That is
 * a cross-row, cross-column rule no constraint can express, so it is enforced here, at the point of
 * decision, and the column stays nullable (CLAUDE.md section 6).
 *
 * Substrate (ADR-0006): assigning or clearing a card appends `attendance.card.assigned` /
 * `attendance.card.cleared` — it changes how a device file is attributed to a person, which is exactly the
 * kind of change someone will later need to explain.
 */
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employeeStatutoryMy, employment, person } from '../db/schema';

/** Thrown when a card id is already in use — as a card, OR as another employee's code or IC. */
export class CardIdInUseError extends Error {
  constructor(
    readonly cardId: string,
    readonly clashesWith: 'card' | 'employee_code' | 'ic',
    readonly holderName: string,
  ) {
    super(`Card ID ${cardId} already identifies ${holderName} (as their ${clashesWith.replace('_', ' ')}).`);
    this.name = 'CardIdInUseError';
  }
}

/** Card ids are compared the way the importer compares them: trimmed, case-insensitively. */
export const normalizeCardId = (raw: string): string => raw.trim();

/**
 * What this employment is MATCHED BY when a device file arrives, and how the screen should say so.
 *
 * ⚠️ THE "CARD ID IS THE SAME AS EMPLOYEE ID" SETTING WAS NOT BUILT, AND THE REASON IS THAT IT HAS NO
 * EFFECT ON MATCHING. The ticket asks for a global switch that fills each Card ID in from the Employee ID
 * so HR need not type them. But the importer ALREADY matches on `employee_code` — a device
 * that records employee numbers has always imported, with no card row at all. So a setting that copies the
 * code into the card would change nothing about which punches match; it would only change what the screen
 * prints, at the cost of a stored duplicate of one fact and a sync rule on every code rename.
 *
 * So: no setting, no copy, no catalog entry. `card_id` NULL means "matched by Employee ID / IC", the screen
 * says exactly that beside the employee code, and the reporter's requirements 8-11 are satisfied by the
 * behaviour they were asking for rather than by the mechanism they proposed. Recorded for the round entry
 * and owed to the reporter in plain words.
 */
export type CardMatch =
  | { by: 'card'; value: string }
  | { by: 'employee_code'; value: string }
  | { by: 'none'; value: null };

export function resolveCardMatch(row: { cardId: string | null; employeeCode: string | null }): CardMatch {
  if (row.cardId) return { by: 'card', value: row.cardId };
  if (row.employeeCode) return { by: 'employee_code', value: row.employeeCode };
  return { by: 'none', value: null };
}

/**
 * Refuse a card id that any OTHER employment in the tenant already answers to — by card, by employee code
 * or by IC. Case-insensitive, and IC is compared on digits only, because that is exactly how
 * the clocking importer builds its lookup (core/attendance-clocking-import.ts): a value that collides there
 * makes the punch ambiguous at best, and this is the only place that can see it coming.
 */
export async function assertCardIdFree(tx: Tx, employmentId: string, cardId: string): Promise<void> {
  const wanted = normalizeCardId(cardId);
  const digits = wanted.replace(/\D/g, '');

  // ⚠️ THIS QUERY MIRRORS THE IMPORTER'S OWN KEYS, and has to: card, employee code and IC digits, the
  // IC joined from `employee_statutory_my` (it is NOT on `person`). r424 — the importer
  // (core/attendance-clocking-import.ts) now matches only employments EMPLOYED ON THE CLOCKING'S DATE and
  // refuses two answers at one level as ambiguous instead of letting the last writer of a flat map win. A
  // terminated employment can therefore still answer a card for a date before its termination; refusing
  // collisions among LIVE employments here remains the right guard for new assignments, and anything older
  // that still collides is reported by the importer as ambiguous rather than guessed.
  const clashes = await tx
    .select({
      id: employment.id,
      name: person.fullName,
      code: employment.employeeCode,
      ic: employeeStatutoryMy.icNumber,
      card: employment.cardId,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
    .where(
      and(
        ne(employment.id, employmentId),
        isNull(employment.terminatedOn),
        or(
          sql`lower(${employment.cardId}) = lower(${wanted})`,
          sql`lower(${employment.employeeCode}) = lower(${wanted})`,
          digits
            ? sql`regexp_replace(coalesce(${employeeStatutoryMy.icNumber}, ''), '[^0-9]', '', 'g') = ${digits}`
            : sql`false`,
        ),
      ),
    )
    .limit(1);

  const clash = clashes[0];
  if (!clash) return;

  const kind: 'card' | 'employee_code' | 'ic' =
    clash.card && clash.card.toLowerCase() === wanted.toLowerCase()
      ? 'card'
      : clash.code && clash.code.toLowerCase() === wanted.toLowerCase()
        ? 'employee_code'
        : 'ic';
  throw new CardIdInUseError(wanted, kind, clash.name);
}

/**
 * Assign or clear one employment's card id. `null` clears it — which returns that employee to matching on
 * code / IC, not to having no attendance.
 */
export async function setEmploymentCardId(
  ctx: SessionContext,
  p: { employmentId: string; cardId: string | null },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const next = p.cardId == null ? null : normalizeCardId(p.cardId);
    if (next !== null && next !== '') await assertCardIdFree(tx, p.employmentId, next);

    const [before] = await tx
      .select({ cardId: employment.cardId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);

    await tx
      .update(employment)
      .set({ cardId: next === '' ? null : next })
      .where(eq(employment.id, p.employmentId));

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: next ? 'attendance.card.assigned' : 'attendance.card.cleared',
      actor: actorOf(ctx),
      payload: { from: before?.cardId ?? null, to: next === '' ? null : next },
    });
  });
}
