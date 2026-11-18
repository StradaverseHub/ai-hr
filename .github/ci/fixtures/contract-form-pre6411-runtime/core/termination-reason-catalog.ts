/**
 * 1d58019a — "Movement Settings Enhancement", Step 1: the tenant's termination-reason catalogue (ADR-0165).
 *
 * THE SHAPE IS movement_event_type's, ON PURPOSE. core/termination-reason.ts keeps the thirteen built-in
 * reasons as the STARTING list; `termination_reason` (migration 0721) records only what a tenant DID to it —
 * renamed or switched off a built-in reason, or added one of its own in one of the three fixed groups. A
 * tenant with no rows behaves exactly as before, and nothing is seeded, so there is nothing to keep in step
 * when the shipped list grows.
 *
 * ONE OWNER FOR THE TURNOVER CLASSIFICATION. Nothing here stores a termination_type. A built-in reason keeps
 * its shipped mapping however it is renamed (retirement → retired, contract_expiry → contract_end); a custom
 * reason derives it from its group. The groups are fixed because they feed the Terminations and Turnover
 * reports — a fourth group would quietly drop those exits from both.
 *
 * HISTORY KEEPS ITS CODE. employment.termination_reason_code is text with no foreign key (0338), and the
 * movement ledger carries the code in its payloads. So a switched-off reason still resolves (old records
 * keep rendering and stay correctable), and deleting is refused for a built-in and for any code already
 * recorded — the same rule, for the same reason, as deleting an event type.
 *
 * PERMISSIONS. Viewing the settings list and every write require an admin (super_admin or hr_admin) here in
 * the service, independently of the page guard and of the table's admin-only write policies. Resolving a
 * reason inside a movement write needs no admin role: whoever may record the termination may read the
 * tenant's reasons (tenant-read RLS).
 *
 * CONCURRENCY. Every catalogue write takes an exclusive per-tenant advisory lock; resolving a reason for a
 * movement write takes the shared form. A delete therefore cannot pass its "never used" check while a
 * termination naming that same code is still being recorded, and then commit after it.
 *
 * Deliberately NO import of core/movement or core/movement-type: core/org.ts imports this module, and
 * core/movement imports core/org.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { movementTypeTerminationReason, terminationReason } from '../db/schema';
import type { TerminationType } from './org';
import {
  TERMINATION_REASONS,
  isTerminationReasonCategory,
  terminationReasonOf,
  terminationTypeForCategory,
  type TerminationReasonCategory,
} from './termination-reason';

/** One reason as the catalogue resolves it — what the writer and the New Event form need. */
export type ResolvedTerminationReason = {
  code: string;
  /** The tenant's label, or null when the shipped six-locale translation is still in use. */
  label: string | null;
  category: TerminationReasonCategory;
  /** The classification written to employment.termination_type. Derived, never stored. */
  terminationType: TerminationType;
  active: boolean;
  builtIn: boolean;
};

/** One row of the Termination Reasons settings tab. */
export type TerminationReasonRow = ResolvedTerminationReason & {
  sortOrder: number;
  /** Already recorded on an employment or in the movement ledger — can be switched off, never deleted. */
  inUse: boolean;
  /** When the organisation added its own reason. NULL for every built-in (see MovementEventTypeRow). */
  createdAt: Date | null;
};

export class TerminationReasonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminationReasonError';
  }
}

function assertAdmin(ctx: SessionContext, what: string): void {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new TerminationReasonError(`Only an admin can ${what}.`);
  }
}

/** Same slug rule as event-type codes: the value is written into history and read back for years. */
const CODE_RE = /^[a-z][a-z0-9_]{1,39}$/;
const LABEL_MAX = 120;

/** `Mutual Separation` → `mutual_separation`. */
export function reasonCodeFromLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

async function lockShared(tx: Tx, tenantId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('termination-reason-catalogue:' || ${tenantId}::text,0))`);
}
async function lockWrite(tx: Tx, tenantId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('termination-reason-catalogue:' || ${tenantId}::text,0))`);
}

type OverlayRow = typeof terminationReason.$inferSelect;

async function overlayTx(tx: Tx, tenantId: string): Promise<Map<string, OverlayRow>> {
  const rows = await tx
    .select()
    .from(terminationReason)
    .where(eq(terminationReason.tenantId, tenantId))
    .orderBy(asc(terminationReason.sortOrder), asc(terminationReason.code));
  return new Map(rows.map((r) => [r.code, r]));
}

/**
 * The single resolution rule. A built-in code always resolves to its shipped group and classification (an
 * overlay row may only rename or switch it off); a custom code resolves only from a well-formed row of THIS
 * tenant; anything else is unknown.
 */
function resolveRow(code: string, row: OverlayRow | undefined): ResolvedTerminationReason | null {
  const def = terminationReasonOf(code);
  if (def) {
    return {
      code,
      label: row?.label ?? null,
      category: def.category,
      terminationType: def.type,
      active: row ? row.isActive : true,
      builtIn: true,
    };
  }
  if (!row || !isTerminationReasonCategory(row.category)) return null;
  return {
    code,
    label: row.label,
    category: row.category,
    terminationType: terminationTypeForCategory(row.category),
    active: row.isActive,
    builtIn: false,
  };
}

/**
 * Which reason codes history already references: the employment column the termination writer sets, and
 * every ledger payload that carries the code (employment.terminated, a scheduled termination, its field
 * diff). The payload key is specific to this field, so unlike an event type's generic `type` it needs no
 * event_type scoping. Admins read the whole tenant's ledger (domain_event_read), so the ledger half is
 * complete even for an admin whose employment visibility is company-scoped.
 */
async function inUseCodesTx(tx: Tx, tenantId: string): Promise<Set<string>> {
  const res = await tx.execute(sql`
    SELECT DISTINCT termination_reason_code AS code
      FROM employment
     WHERE tenant_id = ${tenantId}
       AND termination_reason_code IS NOT NULL
     UNION
    SELECT DISTINCT payload->>'terminationReasonCode' AS code
      FROM domain_event
     WHERE tenant_id = ${tenantId}
       AND payload ? 'terminationReasonCode'
     UNION
    SELECT DISTINCT payload->'input'->>'terminationReasonCode' AS code
      FROM domain_event
     WHERE tenant_id = ${tenantId}
       AND payload->'input' ? 'terminationReasonCode'`);
  const rows = res as unknown as { code: string | null }[];
  return new Set(rows.map((r) => r.code).filter((c): c is string => !!c));
}

function catalogue(overlay: Map<string, OverlayRow>): (ResolvedTerminationReason & { sortOrder: number; createdAt: Date | null })[] {
  const out: (ResolvedTerminationReason & { sortOrder: number; createdAt: Date | null })[] = [];
  TERMINATION_REASONS.forEach((def, i) => {
    const o = overlay.get(def.code);
    // Never o.createdAt for a built-in: that is when the tenant first renamed or switched it off.
    out.push({ ...resolveRow(def.code, o)!, sortOrder: o?.sortOrder ?? i, createdAt: null });
  });
  for (const [code, o] of overlay) {
    if (terminationReasonOf(code)) continue;
    const r = resolveRow(code, o);
    if (r) out.push({ ...r, sortOrder: o.sortOrder, createdAt: o.createdAt });
  }
  return out;
}

/**
 * The Termination Reasons settings tab: built-ins in their shipped order, then the organisation's own by
 * sort order. Admin-only — this is the settings view, with in-use flags.
 */
// async so the admin refusal is a rejected promise like every other settings call, never a sync throw.
export async function listTerminationReasons(ctx: SessionContext): Promise<TerminationReasonRow[]> {
  assertAdmin(ctx, 'view termination reason settings');
  return withTenant(ctx, async (tx) => {
    const overlay = await overlayTx(tx, ctx.tenantId);
    const inUse = await inUseCodesTx(tx, ctx.tenantId);
    return catalogue(overlay).map((r) => ({ ...r, inUse: inUse.has(r.code) }));
  });
}

/**
 * Every reason this tenant knows, switched-off ones included and flagged — the New Event form offers the
 * active ones and still shows a switched-off reason a movement being corrected already carries. No admin
 * requirement: whoever may record a termination may read the reasons it offers.
 */
export function terminationReasonCatalogue(ctx: SessionContext): Promise<ResolvedTerminationReason[]> {
  return withTenant(ctx, (tx) => terminationReasonCatalogueTx(tx, ctx.tenantId));
}

/** 1d58019a Step 2 — the same catalogue inside a caller's transaction (the movement workbook's catalogue
 *  read and fingerprint, and the per-type offer lists). Read-only; no admin requirement. */
export async function terminationReasonCatalogueTx(tx: Tx, tenantId: string): Promise<ResolvedTerminationReason[]> {
  return catalogue(await overlayTx(tx, tenantId)).map((r) => ({
    code: r.code,
    label: r.label,
    category: r.category,
    terminationType: r.terminationType,
    active: r.active,
    builtIn: r.builtIn,
  }));
}

/**
 * Resolve one code inside a movement write's transaction. Includes switched-off reasons (history and
 * corrections); refusing a switched-off reason for a NEW movement is the caller's decision. Takes the shared
 * catalogue lock so a concurrent delete cannot slip between this read and the caller's commit.
 */
export async function resolveTerminationReasonTx(
  tx: Tx,
  tenantId: string,
  code: string,
): Promise<ResolvedTerminationReason | null> {
  await lockShared(tx, tenantId);
  if (terminationReasonOf(code) === null && !CODE_RE.test(code)) return null;
  const [row] = await tx
    .select()
    .from(terminationReason)
    .where(and(eq(terminationReason.tenantId, tenantId), eq(terminationReason.code, code)))
    .limit(1);
  return resolveRow(code, row);
}

/** The classification a recorded reason derives, tenant-aware; null when absent or unknown. */
export async function terminationTypeForReasonTx(
  tx: Tx,
  tenantId: string,
  code: string | null | undefined,
): Promise<TerminationType | null> {
  if (!code) return null;
  return (await resolveTerminationReasonTx(tx, tenantId, code))?.terminationType ?? null;
}

/** Refuse a reason that cannot be used for a NEW termination: unknown, or switched off. */
export async function assertTerminationReasonOfferedTx(tx: Tx, tenantId: string, code: string): Promise<void> {
  const r = await resolveTerminationReasonTx(tx, tenantId, code);
  if (!r) throw new TerminationReasonError('Unknown termination reason.');
  if (!r.active) {
    throw new TerminationReasonError(
      'That termination reason has been switched off in Movement Settings, so it cannot be used for a new termination.',
    );
  }
}

async function upsertTx(
  tx: Tx,
  ctx: SessionContext,
  p: { code: string; category: TerminationReasonCategory; label?: string | null; sortOrder?: number; isActive?: boolean },
): Promise<void> {
  const [row] = await tx
    .insert(terminationReason)
    .values({
      tenantId: ctx.tenantId,
      code: p.code,
      category: p.category,
      label: p.label ?? null,
      ...(p.sortOrder === undefined ? {} : { sortOrder: p.sortOrder }),
      ...(p.isActive === undefined ? {} : { isActive: p.isActive }),
    })
    .onConflictDoUpdate({
      target: [terminationReason.tenantId, terminationReason.code],
      set: {
        ...(p.label === undefined ? {} : { label: p.label }),
        ...(p.sortOrder === undefined ? {} : { sortOrder: p.sortOrder }),
        ...(p.isActive === undefined ? {} : { isActive: p.isActive }),
      },
    })
    .returning({ id: terminationReason.id, label: terminationReason.label, isActive: terminationReason.isActive });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'termination-reason',
    aggregateId: row.id,
    eventType: 'termination-reason.saved',
    actor: actorOf(ctx),
    payload: { code: p.code, category: p.category, label: row.label, isActive: row.isActive },
  });
}

/**
 * Add one of the organisation's own reasons, or rename an existing one (built-in or custom). The group is
 * chosen once, when the reason is added: it is what the turnover reports read, so it is not re-pointed by a
 * rename. Renaming touches no stored record — history holds the code.
 */
export async function saveTerminationReason(
  ctx: SessionContext,
  p: { code?: string | null; label: string; category?: string | null },
): Promise<{ code: string }> {
  assertAdmin(ctx, 'change termination reasons');
  const label = p.label.trim();
  if (!label) throw new TerminationReasonError('A name is required.');
  if (label.length > LABEL_MAX) throw new TerminationReasonError(`Keep the name to ${LABEL_MAX} characters or fewer.`);

  return withTenant(ctx, async (tx) => {
    await lockWrite(tx, ctx.tenantId);
    const existingCode = p.code?.trim() || null;

    if (existingCode) {
      const [row] = await tx
        .select()
        .from(terminationReason)
        .where(and(eq(terminationReason.tenantId, ctx.tenantId), eq(terminationReason.code, existingCode)))
        .limit(1);
      const resolved = resolveRow(existingCode, row);
      if (!resolved) throw new TerminationReasonError('Unknown termination reason.');
      if (p.category && p.category !== resolved.category) {
        throw new TerminationReasonError(
          'A reason keeps the group it was created in, because the turnover reports read it. Add a new reason in the other group instead.',
        );
      }
      await upsertTx(tx, ctx, { code: existingCode, category: resolved.category, label });
      return { code: existingCode };
    }

    const category = p.category?.trim() || '';
    if (!isTerminationReasonCategory(category)) throw new TerminationReasonError('Choose the group the reason belongs to.');
    const code = reasonCodeFromLabel(label);
    if (!CODE_RE.test(code)) {
      throw new TerminationReasonError('Use letters and numbers in the name so a code can be derived from it.');
    }
    if (terminationReasonOf(code)) {
      throw new TerminationReasonError('That name is already used by a standard reason. Rename that one instead.');
    }
    const existing = await overlayTx(tx, ctx.tenantId);
    if (existing.has(code)) throw new TerminationReasonError('A termination reason with that name already exists.');
    await upsertTx(tx, ctx, { code, category, label, sortOrder: TERMINATION_REASONS.length + existing.size });
    return { code };
  });
}

/** Switch a reason on or off. Records that already carry it are untouched. */
export async function setTerminationReasonActive(ctx: SessionContext, p: { code: string; active: boolean }): Promise<void> {
  assertAdmin(ctx, 'change termination reasons');
  await withTenant(ctx, async (tx) => {
    await lockWrite(tx, ctx.tenantId);
    const [row] = await tx
      .select()
      .from(terminationReason)
      .where(and(eq(terminationReason.tenantId, ctx.tenantId), eq(terminationReason.code, p.code)))
      .limit(1);
    const resolved = resolveRow(p.code, row);
    if (!resolved) throw new TerminationReasonError('Unknown termination reason.');
    await upsertTx(tx, ctx, { code: p.code, category: resolved.category, isActive: p.active });
  });
}

/**
 * Delete one of the organisation's own reasons that nothing has recorded. Refused for a built-in (switching
 * it off is what hides it) and for any code history references, which would otherwise render as a bare code.
 */
export async function deleteTerminationReason(ctx: SessionContext, code: string): Promise<void> {
  assertAdmin(ctx, 'change termination reasons');
  if (terminationReasonOf(code)) {
    throw new TerminationReasonError('A standard termination reason cannot be deleted. Switch it off instead.');
  }
  await withTenant(ctx, async (tx) => {
    await lockWrite(tx, ctx.tenantId);
    const inUse = await inUseCodesTx(tx, ctx.tenantId);
    if (inUse.has(code)) {
      throw new TerminationReasonError(
        'This termination reason is already used by recorded terminations, so it cannot be deleted. Switch it off instead — the records that use it keep their reason.',
      );
    }
    const [row] = await tx
      .delete(terminationReason)
      .where(and(eq(terminationReason.tenantId, ctx.tenantId), eq(terminationReason.code, code)))
      .returning({ id: terminationReason.id });
    if (!row) throw new TerminationReasonError('Unknown termination reason.');
    // 1d58019a Step 2 — an unused reason may still be ticked on a Termination type's offer list. Remove those
    // ticks with it, so a later reason of the same name does not silently inherit them. Saving an offer list
    // resolves every code under the shared form of this lock, so it cannot re-tick the code mid-delete.
    await tx
      .delete(movementTypeTerminationReason)
      .where(and(eq(movementTypeTerminationReason.tenantId, ctx.tenantId), eq(movementTypeTerminationReason.reasonCode, code)));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'termination-reason',
      aggregateId: row.id,
      eventType: 'termination-reason.deleted',
      actor: actorOf(ctx),
      payload: { code },
    });
  });
}
