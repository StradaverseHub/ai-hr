/**
 * 476f23ed — "Movement Settings for configurable career events".
 *
 * THE PROBLEM. The list of movement event types — Transfer, Promotion, Termination and the rest — is fixed
 * in code (core/movement.ts MOVEMENT_KINDS). There is no screen where an organisation can add one, rename
 * one, or switch one off, so a career event we did not anticipate cannot be recorded as itself.
 *
 * THE SHAPE. Movement kinds are not data today and they cannot simply become data: Employment History is a
 * read-time projection over domain_event, and that projection BRANCHES on specific kinds to decide a row's
 * kind, its effective-date source and its ordering. Those branches are behaviour. So this module separates
 * the two axes the reporter was actually conflating:
 *
 *   • the CATALOGUE — what the organisation calls its event types, which of them are offered, and any of
 *     its own. Configurable, per tenant, in `movement_event_type` (migration 0340).
 *   • the BEHAVIOUR — what the system DOES when one is recorded. Fixed, in code, keyed by MovementKind.
 *
 * Every catalogue entry MAPS to exactly one built-in behaviour kind. Rename and enable/disable are free;
 * semantics stay with the built-in kind. A tenant cannot invent a type that claims to be a Termination.
 *
 * AN OVERLAY, NOT A REPLACEMENT. The table records what a tenant DID to the built-in list — renamed a
 * label, switched a type off, added one of their own. A tenant with no rows behaves exactly as before.
 * That is deliberate: a seeded-per-tenant catalogue would need a top-up migration for every future kind,
 * and a tenant whose seed failed would have no movement types at all. This degrades the other way.
 *
 * THE TERMINATION-REASON CATALOGUE STAYS WHERE IT IS. core/termination-reason.ts names this item as its
 * eventual owner, and migration 0338 kept employment.termination_reason_code as TEXT so it could be
 * repointed here later with no type surgery. It is NOT repointed by this item: the approved plan is about
 * event TYPES, and moving the exit-reason list at the same time would change two things behind one screen.
 * The text column is what keeps that door open.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { movementEventType } from '../db/schema';
import { COMPARISON_KINDS, MOVEMENT_KINDS, type MovementKind } from './movement';

/**
 * The behaviour kinds a CUSTOM type may map onto.
 *
 * The comparison kinds record a change to employment/pay data through one diff-driven writer, and the two
 * record-only kinds change no state at all — none of them has a consequence beyond the movement itself, so
 * a tenant naming one of them "Redeployment" or "Regional Assignment" is naming a thing the system already
 * does. Everything absent from this list is absent on purpose: Termination ends employment, Confirmation
 * completes probation, Probation Extension moves the confirmation date, Blacklist gates rehire, and both
 * join-date corrections move leave entitlement. Those keep their built-in meaning even when renamed.
 */
export const CONFIGURABLE_BEHAVIOUR_KINDS: readonly MovementKind[] = [
  ...COMPARISON_KINDS,
  'secondment',
  'actingPosition',
];

export const isConfigurableBehaviourKind = (v: string): v is MovementKind =>
  (CONFIGURABLE_BEHAVIOUR_KINDS as readonly string[]).includes(v);

const isBuiltInKind = (v: string): v is MovementKind => (MOVEMENT_KINDS as readonly string[]).includes(v);

/** One row of the Movement Settings screen. */
export type MovementEventTypeRow = {
  /** The stable identity recorded in the ledger. */
  code: string;
  /** The built-in kind whose behaviour it carries — also what the New Event form's field set follows. */
  behaviourKind: MovementKind;
  /** The tenant's label, or null when the shipped six-locale translation is still in use. */
  label: string | null;
  active: boolean;
  sortOrder: number;
  /** true for one of the shipped kinds. A built-in can be renamed and deactivated but never deleted. */
  builtIn: boolean;
  /** A domain_event already records this code — it can be deactivated but not deleted. */
  inUse: boolean;
  /**
   * When the ORGANISATION added this type. 1b87e8a0 wanted a "Last Updated" column; there is no
   * updated_at on movement_event_type and adding one is a migration plus a write-path change that
   * would be NULL for every existing row, so the settings screen shows Created instead — disclosed to
   * the reporter as its own request rather than smuggled in.
   *
   * NULL FOR EVERY BUILT-IN, deliberately, and not merely when no overlay row exists. A built-in has
   * been in the product since it shipped, so it has no creation date to show; and once a tenant
   * renames or switches one off, the overlay row's created_at is the date of THAT edit, which under a
   * column headed "Created" would be a plain lie. The screen renders built-ins as built-in instead.
   */
  createdAt: Date | null;
};

export class MovementTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovementTypeError';
  }
}

function assertAdmin(ctx: SessionContext, what: string): void {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new MovementTypeError(`Only an admin can ${what}.`);
  }
}

/**
 * A code is a slug: lower-case letters, digits and underscores. Deliberately strict, because the value is
 * written into the append-only ledger and read back for years — a code with a space or a capital in it
 * would be one typo away from a second, near-identical type that history cannot tell apart.
 */
const CODE_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** Turn the admin's label into a candidate code (`Regional Assignment` → `regional_assignment`). */
export function codeFromLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** The overlay rows for this tenant, keyed by code. */
async function overlayTx(tx: Tx, tenantId: string) {
  const rows = await tx
    .select()
    .from(movementEventType)
    .where(eq(movementEventType.tenantId, tenantId))
    .orderBy(asc(movementEventType.sortOrder), asc(movementEventType.code));
  return new Map(rows.map((r) => [r.code, r]));
}

/**
 * Which catalogue codes the ledger already references. Read from the movement tag's `type` (and the
 * scheduled event's own `type`), because that is where a movement's chosen type is recorded — there is no
 * movement table to join against. This is the in-use guard behind "types already in use cannot be
 * deleted, only deactivated": deleting a referenced code would leave every past record unlabelled.
 */
async function inUseCodesTx(tx: Tx, tenantId: string): Promise<Set<string>> {
  // The two places — and ONLY the two places — a movement's chosen type is recorded:
  //   • `payload.movement.type`, the MovementTag every leg of a movement carries (core/movement.ts);
  //   • `payload.type` on the movement events that own a history row outright.
  //
  // The top-level read is SCOPED BY event_type on purpose. `type` is an ordinary word and other aggregates
  // put their own unrelated `type` in a payload; an unscoped read would mark a brand-new custom type as
  // "already used by recorded movements" because some leave or payroll event happened to carry a string
  // equal to its slug, and the screen would then refuse a deletion that is perfectly safe.
  const res = await tx.execute(sql`
    SELECT DISTINCT payload->'movement'->>'type' AS code
      FROM domain_event
     WHERE tenant_id = ${tenantId}
       AND payload->'movement'->>'type' IS NOT NULL
     UNION
    SELECT DISTINCT payload->>'type' AS code
      FROM domain_event
     WHERE tenant_id = ${tenantId}
       AND event_type IN ('employment.movement.recorded', 'employment.movement.scheduled')
       AND payload->>'type' IS NOT NULL`);
  const rows = res as unknown as { code: string | null }[];
  return new Set(rows.map((r) => r.code).filter((c): c is string => !!c));
}

/**
 * The full catalogue as the settings screen shows it: every built-in kind HR can create from the New Event
 * form, with the tenant's overrides applied, followed by the tenant's own types.
 *
 * Ordering is the built-in order first (it is the order the form has always offered, and reordering the
 * shipped list was not asked for), then custom types by their sort order. `sortOrder` is carried so a later
 * item can make the whole list orderable without a schema change.
 */
export function listMovementEventTypes(ctx: SessionContext): Promise<MovementEventTypeRow[]> {
  return withTenant(ctx, async (tx) => {
    const overlay = await overlayTx(tx, ctx.tenantId);
    const inUse = await inUseCodesTx(tx, ctx.tenantId);
    const rows: MovementEventTypeRow[] = MOVEMENT_KINDS.map((kind, i) => {
      const o = overlay.get(kind);
      return {
        code: kind,
        behaviourKind: kind,
        label: o?.label ?? null,
        active: o ? o.isActive : true,
        sortOrder: o?.sortOrder ?? i,
        builtIn: true,
        inUse: inUse.has(kind),
        // Never o.createdAt: that is when the tenant first RENAMED or switched this built-in, not when
        // the type came into being. See the field's doc comment.
        createdAt: null,
      };
    });
    for (const [code, o] of overlay) {
      if (isBuiltInKind(code)) continue;
      rows.push({
        code,
        // A custom row's behaviour is validated on write; a value that somehow fell outside the allowed set
        // degrades to the neutral record-only kind rather than borrowing a lifecycle kind's consequences.
        behaviourKind: isConfigurableBehaviourKind(o.behaviourKind) ? o.behaviourKind : 'secondment',
        label: o.label,
        active: o.isActive,
        sortOrder: o.sortOrder,
        builtIn: false,
        inUse: inUse.has(code),
        createdAt: o.createdAt,
      });
    }
    return rows;
  });
}

/** The types the New Event form offers — the catalogue minus everything switched off. */
export async function activeMovementEventTypes(ctx: SessionContext): Promise<MovementEventTypeRow[]> {
  return (await listMovementEventTypes(ctx)).filter((r) => r.active);
}

/**
 * Resolve one code as the movement writer needs it, inside the caller's transaction.
 *
 * Returns null for a code that is neither a built-in kind nor a row of this tenant's catalogue. An
 * INACTIVE type resolves (so history keeps rendering it and a correction of an old movement still works)
 * and reports `active: false`; refusing a new movement is the caller's decision, not this function's.
 */
export async function resolveMovementEventTypeTx(
  tx: Tx,
  tenantId: string,
  code: string,
): Promise<{ code: string; behaviourKind: MovementKind; active: boolean; label: string | null } | null> {
  const [row] = await tx
    .select()
    .from(movementEventType)
    .where(and(eq(movementEventType.tenantId, tenantId), eq(movementEventType.code, code)))
    .limit(1);
  if (row) {
    const behaviourKind = isBuiltInKind(row.behaviourKind)
      ? row.behaviourKind
      : isBuiltInKind(code)
        ? code
        : null;
    if (!behaviourKind) return null;
    // A CUSTOM type may only carry a configurable behaviour, whatever is in the row. This is the
    // read-side half of the write-side guard: a row edited around the service still cannot make a
    // tenant-invented type behave like a Termination.
    if (!isBuiltInKind(code) && !isConfigurableBehaviourKind(behaviourKind)) return null;
    return { code, behaviourKind, active: row.isActive, label: row.label };
  }
  if (isBuiltInKind(code)) return { code, behaviourKind: code, active: true, label: null };
  return null;
}

/**
 * Add a custom type, or rename / re-point an existing catalogue entry.
 *
 * Renaming a BUILT-IN writes an overlay row whose code is the built-in kind and whose behaviour is itself:
 * only the label moves. Renaming does not touch a single stored record — the ledger holds the code.
 */
export async function saveMovementEventType(
  ctx: SessionContext,
  p: { code?: string | null; label: string; behaviourKind?: string | null; sortOrder?: number },
): Promise<{ code: string }> {
  assertAdmin(ctx, 'change movement event types');
  const label = p.label.trim();
  if (!label) throw new MovementTypeError('A name is required.');

  return withTenant(ctx, async (tx) => {
    const existingCode = p.code?.trim() || null;

    // ── Renaming an existing entry (built-in or custom) ────────────────────────────────────────────
    if (existingCode) {
      const resolved = await resolveMovementEventTypeTx(tx, ctx.tenantId, existingCode);
      if (!resolved) throw new MovementTypeError('Unknown movement event type.');
      // The behaviour of a BUILT-IN is never editable; a custom type's may be re-pointed within the
      // configurable set. Attempting either from outside that rule is refused rather than ignored.
      let behaviourKind = resolved.behaviourKind;
      if (p.behaviourKind && p.behaviourKind !== resolved.behaviourKind) {
        if (isBuiltInKind(existingCode)) {
          throw new MovementTypeError(
            'A built-in event type keeps its built-in meaning. You can rename it or switch it off, but not change what it does.',
          );
        }
        if (!isConfigurableBehaviourKind(p.behaviourKind)) {
          throw new MovementTypeError('That is not an event behaviour a custom type can use.');
        }
        behaviourKind = p.behaviourKind;
      }
      await upsertTx(tx, ctx, {
        code: existingCode,
        behaviourKind,
        label,
        sortOrder: p.sortOrder,
      });
      return { code: existingCode };
    }

    // ── Adding a custom type ──────────────────────────────────────────────────────────────────────
    const behaviourKind = p.behaviourKind?.trim() || '';
    if (!isConfigurableBehaviourKind(behaviourKind)) {
      throw new MovementTypeError('Choose what the new event type should do.');
    }
    const code = codeFromLabel(label);
    if (!CODE_RE.test(code)) {
      throw new MovementTypeError('Use letters and numbers in the name so a code can be derived from it.');
    }
    if (isBuiltInKind(code)) {
      throw new MovementTypeError('That name is already used by a built-in event type. Rename that one instead.');
    }
    const existing = await overlayTx(tx, ctx.tenantId);
    if (existing.has(code)) throw new MovementTypeError('An event type with that name already exists.');
    await upsertTx(tx, ctx, { code, behaviourKind, label, sortOrder: p.sortOrder ?? existing.size });
    return { code };
  });
}

async function upsertTx(
  tx: Tx,
  ctx: SessionContext,
  p: { code: string; behaviourKind: MovementKind; label: string | null; sortOrder?: number; isActive?: boolean },
): Promise<void> {
  const [row] = await tx
    .insert(movementEventType)
    .values({
      tenantId: ctx.tenantId,
      code: p.code,
      behaviourKind: p.behaviourKind,
      label: p.label,
      ...(p.sortOrder === undefined ? {} : { sortOrder: p.sortOrder }),
      ...(p.isActive === undefined ? {} : { isActive: p.isActive }),
    })
    .onConflictDoUpdate({
      target: [movementEventType.tenantId, movementEventType.code],
      set: {
        behaviourKind: p.behaviourKind,
        ...(p.label === undefined ? {} : { label: p.label }),
        ...(p.sortOrder === undefined ? {} : { sortOrder: p.sortOrder }),
        ...(p.isActive === undefined ? {} : { isActive: p.isActive }),
      },
    })
    .returning({ id: movementEventType.id, isActive: movementEventType.isActive });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'movement-event-type',
    aggregateId: row.id,
    eventType: 'movement-event-type.saved',
    actor: actorOf(ctx),
    payload: { code: p.code, behaviourKind: p.behaviourKind, label: p.label, isActive: row.isActive },
  });
}

/** Switch a type on or off. Deactivating never alters records that already use it — it only stops the type
 *  being offered when HR records a new movement. */
export async function setMovementEventTypeActive(
  ctx: SessionContext,
  p: { code: string; active: boolean },
): Promise<void> {
  assertAdmin(ctx, 'change movement event types');
  await withTenant(ctx, async (tx) => {
    const resolved = await resolveMovementEventTypeTx(tx, ctx.tenantId, p.code);
    if (!resolved) throw new MovementTypeError('Unknown movement event type.');
    await upsertTx(tx, ctx, {
      code: p.code,
      behaviourKind: resolved.behaviourKind,
      label: resolved.label,
      isActive: p.active,
    });
  });
}

/**
 * Delete a custom type. Refused for a built-in (it is defined in code, so "deleting" it could only mean
 * hiding it — that is what deactivate is for) and refused for any code the ledger references, because
 * Employment History is a projection and an unresolvable code renders as an unlabelled row for every past
 * record that used it.
 */
export async function deleteMovementEventType(ctx: SessionContext, code: string): Promise<void> {
  assertAdmin(ctx, 'change movement event types');
  if (isBuiltInKind(code)) {
    throw new MovementTypeError('A built-in event type cannot be deleted. Switch it off instead.');
  }
  await withTenant(ctx, async (tx) => {
    const inUse = await inUseCodesTx(tx, ctx.tenantId);
    if (inUse.has(code)) {
      throw new MovementTypeError(
        'This event type is already used by recorded movements, so it cannot be deleted. Switch it off instead — the records that use it keep their meaning.',
      );
    }
    const [row] = await tx
      .delete(movementEventType)
      .where(and(eq(movementEventType.tenantId, ctx.tenantId), eq(movementEventType.code, code)))
      .returning({ id: movementEventType.id });
    if (!row) throw new MovementTypeError('Unknown movement event type.');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'movement-event-type',
      aggregateId: row.id,
      eventType: 'movement-event-type.deleted',
      actor: actorOf(ctx),
      payload: { code },
    });
  });
}
