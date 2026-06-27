/**
 * 1.2.6 EA Data Overwrite (ADR-0059) — an EA-ONLY amendment layer. Authorized HR may overwrite/amend
 * specific EA-form fields (employment income, allowances, bonus, tax deduction, statutory values) WITHOUT
 * mutating the original payroll records. The amended amount is overlaid onto the payroll-derived figure at
 * render time inside the MY pack's eaStatement(), so it affects ONLY the generated EA form — not payroll,
 * not CP8D/Form E, not any other surface.
 *
 * Substrate discipline (non-negotiable): every write appends a DomainEvent in the SAME tx via appendEvent,
 * actor via actorOf(ctx). RBAC: the service guard (isAdmin / canManagePayroll) is the PRIMARY enforcement
 * point; the table's RLS WITH CHECK can_admin_employment is the secondary SQL backstop. No approval /
 * maker-checker workflow — HR amends directly, RBAC-gated (per the approved plan).
 */
import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { eaOverride } from '../db/schema';
import { canManagePayroll, isAdmin } from '../lib/authz';
import { employeeEaStatement } from './reporting';
import { EA_FIELDS, type EaField, type EaOverrideEntry } from '../localization/my/reports';

export { EA_FIELDS, type EaField } from '../localization/my/reports';

export class EaOverrideError extends Error {
  constructor(
    message: string,
    readonly code: 'forbidden' | 'invalidField' | 'invalidAmount' | 'invalidYear' | 'reasonRequired' | 'notFound',
  ) {
    super(message);
    this.name = 'EaOverrideError';
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const isField = (s: string): s is EaField => (EA_FIELDS as readonly string[]).includes(s);

/** Service-layer write guard (the primary gate; RLS is the SQL backstop). Admin OR payroll partner. */
function assertCanAmend(ctx: SessionContext) {
  if (!isAdmin(ctx) && !canManagePayroll(ctx)) {
    throw new EaOverrideError('Not authorized to amend EA figures', 'forbidden');
  }
}

/**
 * The pure payroll-DERIVED value for one EA field (before any override). The statement already overlays
 * active overrides, so when an override for `field` exists we read its `original` (the pre-overlay derived
 * value); otherwise the statement's current field value IS the derived value. Returns null only when the
 * employment is missing (eaStatement → null).
 */
function derivedField(
  ea: { partB: { grossSalary: number; bonus: number; allowances: number; gross: number }; partD: { mtd: number }; partE: { epf: number; socso: number; eis: number }; overrides: EaOverrideEntry[] },
  field: EaField,
): number {
  const existing = ea.overrides.find((o) => o.field === field);
  if (existing) return existing.original;
  switch (field) {
    case 'grossSalary':
      return ea.partB.grossSalary;
    case 'bonus':
      return ea.partB.bonus;
    case 'allowances':
      return ea.partB.allowances;
    case 'gross':
      return ea.partB.gross;
    case 'mtd':
      return ea.partD.mtd;
    case 'epf':
      return ea.partE.epf;
    case 'socso':
      return ea.partE.socso;
    case 'eis':
      return ea.partE.eis;
  }
}

export type EaOverrideRow = { field: EaField; amount: number; reason: string };

/** Active overrides for (employment, year) — for the editor UI and any caller that needs the raw rows. */
export async function listEaOverrides(
  ctx: SessionContext,
  p: { employmentId: string; year: string },
): Promise<EaOverrideRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ field: eaOverride.field, amount: eaOverride.amount, reason: eaOverride.reason })
      .from(eaOverride)
      .where(and(eq(eaOverride.employmentId, p.employmentId), eq(eaOverride.year, p.year)));
    return rows.filter((r) => isField(r.field)).map((r) => ({ field: r.field as EaField, amount: round2(Number(r.amount)), reason: r.reason }));
  });
}

/**
 * Set (upsert) an EA-only amendment for one field. RBAC-gated (service guard + RLS WITH CHECK). Validates
 * field ∈ EA_FIELDS, amount finite ≥ 0 (zeroing a derived figure is legitimate), year `^\d{4}$`, reason
 * non-empty. If the amended value equals the derived value to 2dp it is a NO-OP CLEAR (delete any row),
 * not a redundant override. Appends `ea.override.set` (or `ea.override.cleared` on the no-op path) with the
 * derived `before` and amended `after` in the payload.
 */
export async function setEaOverride(
  ctx: SessionContext,
  p: { employmentId: string; year: string; field: string; amount: number; reason: string },
): Promise<{ cleared: boolean }> {
  assertCanAmend(ctx);
  if (!isField(p.field)) throw new EaOverrideError(`Unknown EA field: ${p.field}`, 'invalidField');
  if (!/^\d{4}$/.test(p.year)) throw new EaOverrideError(`Invalid year: ${p.year}`, 'invalidYear');
  const reason = (p.reason ?? '').trim();
  if (!reason) throw new EaOverrideError('A reason is required', 'reasonRequired');
  if (!Number.isFinite(p.amount) || p.amount < 0) {
    throw new EaOverrideError('Amount must be a number ≥ 0', 'invalidAmount');
  }
  const amount = round2(p.amount);
  const field = p.field;

  // The pre-overlay derived baseline drives both the no-op-clear check and the audit `before`.
  const ea = await employeeEaStatement(ctx, { employmentId: p.employmentId, year: p.year });
  if (!ea) throw new EaOverrideError('Employment not found', 'notFound');
  const before = derivedField(ea, field);

  return withTenant(ctx, async (tx) => {
    // No-op: amended == derived ⇒ drop any existing override rather than persist a redundant one.
    if (round2(before) === amount) {
      const deleted = await tx
        .delete(eaOverride)
        .where(and(eq(eaOverride.employmentId, p.employmentId), eq(eaOverride.year, p.year), eq(eaOverride.field, field)))
        .returning({ id: eaOverride.id });
      if (deleted.length > 0) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'ea-override',
          aggregateId: deleted[0].id,
          eventType: 'ea.override.cleared',
          actor: actorOf(ctx),
          subjectEmploymentId: p.employmentId,
          payload: { field, before, after: before, reason },
        });
      }
      return { cleared: true };
    }

    const [row] = await tx
      .insert(eaOverride)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        year: p.year,
        field,
        amount: amount.toFixed(2),
        reason,
        createdByUserId: ctx.userId ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [eaOverride.tenantId, eaOverride.employmentId, eaOverride.year, eaOverride.field],
        set: { amount: amount.toFixed(2), reason, createdByUserId: ctx.userId ?? null, updatedAt: new Date() },
      })
      .returning({ id: eaOverride.id });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'ea-override',
      aggregateId: row.id,
      eventType: 'ea.override.set',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { field, before, after: amount, reason },
    });
    return { cleared: false };
  });
}

/**
 * Hard-clear (reset to derived) one EA field's amendment. Admin-guarded; a hard DELETE — the immutable
 * event log preserves the trail. Appends `ea.override.cleared` with the prior amended value as `before`.
 * No-op (returns cleared:false) when no override exists.
 */
export async function clearEaOverride(
  ctx: SessionContext,
  p: { employmentId: string; year: string; field: string },
): Promise<{ cleared: boolean }> {
  assertCanAmend(ctx);
  if (!isField(p.field)) throw new EaOverrideError(`Unknown EA field: ${p.field}`, 'invalidField');
  if (!/^\d{4}$/.test(p.year)) throw new EaOverrideError(`Invalid year: ${p.year}`, 'invalidYear');
  const field = p.field;

  return withTenant(ctx, async (tx) => {
    const [prior] = await tx
      .select({ id: eaOverride.id, amount: eaOverride.amount })
      .from(eaOverride)
      .where(and(eq(eaOverride.employmentId, p.employmentId), eq(eaOverride.year, p.year), eq(eaOverride.field, field)))
      .limit(1);
    if (!prior) return { cleared: false };
    await tx.delete(eaOverride).where(eq(eaOverride.id, prior.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'ea-override',
      aggregateId: prior.id,
      eventType: 'ea.override.cleared',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { field, before: round2(Number(prior.amount)) },
    });
    return { cleared: true };
  });
}
