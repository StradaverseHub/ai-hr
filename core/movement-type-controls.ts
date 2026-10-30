/**
 * 1d58019a Step 2 (ADR-0166) — the per-type CONTROLS of the movement event-type catalogue: which termination
 * reasons a Termination type offers, and the Field Controls of a comparison type.
 *
 * ONE OWNER PER FACT. The type itself (code, label, behaviour, description, on/off) stays in
 * core/movement-type.ts; these are two more facts about a type, written by the same Save, under the same
 * catalogue lock, from inside saveMovementEventType. They live in their own module because core/movement.ts
 * enforces them inside the movement writer, and core/movement-type.ts already imports core/movement — a leaf
 * both can import keeps the graph acyclic (the reason core/movement-kinds.ts exists).
 *
 * NOTHING HERE IS RETROACTIVE. Rules are read by the writer when a movement is recorded or corrected; the
 * projection, the sweep applying a scheduled movement and the replay of later movements during an older
 * correction never consult them, so a rule saved today never re-judges a movement recorded yesterday.
 *
 * PERMISSIONS. Reads are open to whoever may record a movement (tenant-read RLS); the settings read and
 * every write are admin-only here, in addition to the page guard and the tables' admin-only write policies.
 */
import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { movementTypeFieldRule, movementTypeTerminationReason } from '../db/schema';
import { isComparisonKind } from './movement-kinds';
import {
  TerminationReasonError,
  resolveTerminationReasonTx,
  terminationReasonCatalogueTx,
  type ResolvedTerminationReason,
} from './termination-reason-catalog';
import {
  effectiveMovementFieldRules,
  isMovementDocumentMode,
  isMovementRuleField,
  movementRuleFieldsFor,
  normaliseMovementFieldRule,
  type MovementFieldRule,
} from '../lib/movement-field-rules';

export class MovementTypeControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovementTypeControlError';
  }
}

function assertAdmin(ctx: SessionContext, what: string): void {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new MovementTypeControlError(`Only an admin can ${what}.`);
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────

/** The reason codes a type's offer list names, or null when it has none (= every active reason). */
export async function typeTerminationReasonCodesTx(tx: Tx, tenantId: string, typeCode: string): Promise<string[] | null> {
  const rows = await tx
    .select({ reasonCode: movementTypeTerminationReason.reasonCode })
    .from(movementTypeTerminationReason)
    .where(and(eq(movementTypeTerminationReason.tenantId, tenantId), eq(movementTypeTerminationReason.typeCode, typeCode)));
  return rows.length ? rows.map((r) => r.reasonCode).sort() : null;
}

async function storedRulesTx(tx: Tx, tenantId: string, typeCode: string): Promise<MovementFieldRule[]> {
  const rows = await tx
    .select()
    .from(movementTypeFieldRule)
    .where(and(eq(movementTypeFieldRule.tenantId, tenantId), eq(movementTypeFieldRule.typeCode, typeCode)));
  return rows.flatMap((r) =>
    isMovementRuleField(r.field) && isMovementDocumentMode(r.document)
      ? [{ field: r.field, included: r.included, editable: r.editable, mustChange: r.mustChange, document: r.document }]
      : [],
  );
}

/**
 * The effective Field Controls of one type, for the movement writer. Non-comparison behaviours have none
 * (an empty list): they change no comparison field, so there is nothing to control.
 */
export async function movementFieldRulesTx(
  tx: Tx,
  tenantId: string,
  typeCode: string,
  behaviour: string,
): Promise<{ configured: boolean; rules: MovementFieldRule[] }> {
  if (!isComparisonKind(behaviour)) return { configured: false, rules: [] };
  return effectiveMovementFieldRules(behaviour, await storedRulesTx(tx, tenantId, typeCode));
}

/**
 * Refuse a reason a Termination type does not offer, for a NEW termination of that type (and a correction
 * that changes the reason). Switched-off and unknown reasons are refused separately, by the reason catalogue.
 */
export async function assertTerminationReasonOfferedForTypeTx(
  tx: Tx,
  tenantId: string,
  typeCode: string,
  reasonCode: string,
): Promise<void> {
  const offered = await typeTerminationReasonCodesTx(tx, tenantId, typeCode);
  if (offered && !offered.includes(reasonCode)) {
    throw new TerminationReasonError(
      'That termination reason is not offered for this event type. Choose one of the reasons ticked for it in Movement Settings.',
    );
  }
}

/** Everything the New Event form needs per type, in one read: offered reasons and Field Controls. */
export type MovementTypeControls = {
  /** Termination types: the ticked reason codes, or null for "every active reason". */
  reasonCodes: string[] | null;
  /** Comparison types: the effective rule per field; `configured` false means today's behaviour. */
  configured: boolean;
  rules: MovementFieldRule[];
};

async function allControlsTx(tx: Tx, tenantId: string) {
  const reasons = await tx
    .select()
    .from(movementTypeTerminationReason)
    .where(eq(movementTypeTerminationReason.tenantId, tenantId));
  const rules = await tx.select().from(movementTypeFieldRule).where(eq(movementTypeFieldRule.tenantId, tenantId));
  const reasonsByType = new Map<string, string[]>();
  for (const r of reasons) reasonsByType.set(r.typeCode, [...(reasonsByType.get(r.typeCode) ?? []), r.reasonCode]);
  const rulesByType = new Map<string, MovementFieldRule[]>();
  for (const r of rules) {
    if (!isMovementRuleField(r.field) || !isMovementDocumentMode(r.document)) continue;
    rulesByType.set(r.typeCode, [
      ...(rulesByType.get(r.typeCode) ?? []),
      { field: r.field, included: r.included, editable: r.editable, mustChange: r.mustChange, document: r.document },
    ]);
  }
  return { reasonsByType, rulesByType };
}

/** The controls of every given type (code + behaviour), inside a caller's transaction. */
export async function movementTypeControlsTx(
  tx: Tx,
  tenantId: string,
  types: readonly { code: string; behaviourKind: string }[],
): Promise<Map<string, MovementTypeControls>> {
  const { reasonsByType, rulesByType } = await allControlsTx(tx, tenantId);
  return new Map(
    types.map((t) => {
      const effective = isComparisonKind(t.behaviourKind)
        ? effectiveMovementFieldRules(t.behaviourKind, rulesByType.get(t.code) ?? [])
        : { configured: false, rules: [] };
      const ticked = reasonsByType.get(t.code);
      const reasonCodes = t.behaviourKind === 'termination' && ticked ? [...ticked].sort() : null;
      return [t.code, { reasonCodes, ...effective }] as const;
    }),
  );
}

/** For the New Event form (whoever may record a movement may read the controls it applies). */
export function movementTypeControls(
  ctx: SessionContext,
  types: readonly { code: string; behaviourKind: string }[],
): Promise<Map<string, MovementTypeControls>> {
  return withTenant(ctx, (tx) => movementTypeControlsTx(tx, ctx.tenantId, types));
}

/** For the event-type configuration page: admin-only, like every settings read. */
export async function movementTypeControlsForSettings(
  ctx: SessionContext,
  type: { code: string; behaviourKind: string },
): Promise<MovementTypeControls> {
  assertAdmin(ctx, 'view movement settings');
  return (await movementTypeControls(ctx, [type])).get(type.code)!;
}

/**
 * The reasons a Termination type EFFECTIVELY offers: the tenant's active reasons, narrowed to the ticked ones
 * when it has a list. Used by the New Event form and the workbook (reference sheet and fingerprint).
 */
export function offeredTerminationReasons(
  catalogue: readonly ResolvedTerminationReason[],
  reasonCodes: readonly string[] | null,
): ResolvedTerminationReason[] {
  return catalogue.filter((r) => r.active && (!reasonCodes || reasonCodes.includes(r.code)));
}

export { terminationReasonCatalogueTx };

// ── Writes (only from core/movement-type.ts saveMovementEventType / deleteMovementEventType) ─────────────

const sortedRules = (rules: readonly MovementFieldRule[]) =>
  JSON.stringify(
    [...rules]
      .sort((x, y) => x.field.localeCompare(y.field))
      .map((r) => [r.field, r.included, r.editable, r.mustChange, r.document]),
  );
const sameRules = (a: readonly MovementFieldRule[], b: readonly MovementFieldRule[]) => sortedRules(a) === sortedRules(b);

/**
 * Write a type's reason list and Field Controls. The caller holds the exclusive catalogue write lock and
 * has already resolved the type's behaviour. `undefined` leaves a control as stored; a value replaces it.
 *
 * Canonical storage: an empty reason list and a grid identical to the defaults are stored as NO ROWS, which
 * is what "no rules means today's behaviour" means on read. Each control appends its own audit event, and
 * only when it actually changed, so re-saving an unchanged page writes nothing.
 *
 * Controls that no longer apply to the type's behaviour (a custom type re-pointed while still unused) are
 * removed rather than left to come back if it is pointed back.
 */
export async function writeMovementTypeControlsTx(
  tx: Tx,
  ctx: SessionContext,
  p: {
    code: string;
    /** movement_event_type.id — the audit aggregate. */
    aggregateId: string;
    behaviour: string;
    reasonCodes?: readonly string[] | null;
    fieldRules?: readonly MovementFieldRule[] | null;
  },
): Promise<void> {
  assertAdmin(ctx, 'change movement event types');
  const isTermination = p.behaviour === 'termination';
  const isComparison = isComparisonKind(p.behaviour);

  // ── Reasons ──────────────────────────────────────────────────────────────────────────────────────
  const storedReasons = (await typeTerminationReasonCodesTx(tx, ctx.tenantId, p.code)) ?? [];
  let nextReasons: string[] = storedReasons;
  if (p.reasonCodes !== undefined) {
    const submitted = [...new Set(p.reasonCodes ?? [])].sort();
    if (submitted.length && !isTermination) {
      throw new MovementTypeControlError('Termination reasons can only be chosen for a Termination event type.');
    }
    for (const code of submitted) {
      // Resolves under the shared reason-catalogue lock, so a concurrent delete of this code cannot interleave.
      if (!(await resolveTerminationReasonTx(tx, ctx.tenantId, code))) {
        throw new MovementTypeControlError('Unknown termination reason.');
      }
    }
    nextReasons = submitted;
  }
  if (!isTermination) nextReasons = [];
  if (nextReasons.join('\u0000') !== storedReasons.join('\u0000')) {
    await tx
      .delete(movementTypeTerminationReason)
      .where(and(eq(movementTypeTerminationReason.tenantId, ctx.tenantId), eq(movementTypeTerminationReason.typeCode, p.code)));
    if (nextReasons.length) {
      await tx
        .insert(movementTypeTerminationReason)
        .values(nextReasons.map((reasonCode) => ({ tenantId: ctx.tenantId, typeCode: p.code, reasonCode })));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'movement-event-type',
      aggregateId: p.aggregateId,
      eventType: 'movement-type-reasons.saved',
      actor: actorOf(ctx),
      payload: { code: p.code, reasonCodes: nextReasons, before: storedReasons },
    });
  }

  // ── Field Controls ────────────────────────────────────────────────────────────────────────────────
  const storedRules = await storedRulesTx(tx, ctx.tenantId, p.code);
  let nextRules: MovementFieldRule[] = storedRules;
  if (p.fieldRules !== undefined) {
    const submitted = p.fieldRules ?? [];
    if (submitted.length && !isComparison) {
      throw new MovementTypeControlError('Field Controls apply only to event types that change employment details.');
    }
    const allowed = new Set<string>(movementRuleFieldsFor(p.behaviour));
    const seen = new Set<string>();
    for (const r of submitted) {
      if (!isMovementRuleField(r.field) || !allowed.has(r.field) || seen.has(r.field) || !isMovementDocumentMode(r.document)) {
        throw new MovementTypeControlError('One of the Field Controls is not valid for this event type.');
      }
      seen.add(r.field);
    }
    const normalised = submitted.map((r) => normaliseMovementFieldRule(p.behaviour, r));
    const defaults = effectiveMovementFieldRules(p.behaviour, []).rules;
    const effective = effectiveMovementFieldRules(p.behaviour, normalised).rules;
    nextRules = sameRules(effective, defaults) ? [] : effective;
  }
  if (!isComparison) nextRules = [];
  if (!sameRules(nextRules, storedRules)) {
    await tx
      .delete(movementTypeFieldRule)
      .where(and(eq(movementTypeFieldRule.tenantId, ctx.tenantId), eq(movementTypeFieldRule.typeCode, p.code)));
    if (nextRules.length) {
      await tx.insert(movementTypeFieldRule).values(
        nextRules.map((r) => ({
          tenantId: ctx.tenantId,
          typeCode: p.code,
          field: r.field,
          included: r.included,
          editable: r.editable,
          mustChange: r.mustChange,
          document: r.document,
        })),
      );
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'movement-event-type',
      aggregateId: p.aggregateId,
      eventType: 'movement-type-field-rules.saved',
      actor: actorOf(ctx),
      payload: { code: p.code, rules: nextRules, before: storedRules },
    });
  }
}

/** A deleted custom type takes its controls with it, so a later type of the same name starts clean. The
 *  caller holds the catalogue write lock and appends the type's own deletion event. */
export async function deleteMovementTypeControlsTx(tx: Tx, tenantId: string, code: string): Promise<void> {
  await tx
    .delete(movementTypeTerminationReason)
    .where(and(eq(movementTypeTerminationReason.tenantId, tenantId), eq(movementTypeTerminationReason.typeCode, code)));
  await tx
    .delete(movementTypeFieldRule)
    .where(and(eq(movementTypeFieldRule.tenantId, tenantId), eq(movementTypeFieldRule.typeCode, code)));
}
