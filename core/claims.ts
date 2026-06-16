/**
 * Claims module (ADR-0021) — claim-type catalog + effective-dated budget policy. Admin-managed (RLS
 * admin-write); every state change appends a DomainEvent. The lifecycle (submit/decide) + payout live in
 * later slices of this file.
 */
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { claimPolicy, claimType } from '../db/schema';

const today = (): string => new Date().toISOString().slice(0, 10);
const num = (v: string | null): number | null => (v == null ? null : Number(v));

export type ClaimTypeRow = {
  id: string;
  code: string;
  name: string;
  defaultTaxable: boolean;
  requiresReceipt: boolean;
  archivedAt: string | null;
  policy: { annualBudget: number | null; perClaimCap: number | null; validFrom: string } | null;
};

/** The active policy (latest effective version ≤ asOf) for a claim type, or null. Pure read in the caller tx. */
export async function getActiveClaimPolicy(
  tx: Tx,
  claimTypeId: string,
  asOf: string,
): Promise<{ annualBudget: number | null; perClaimCap: number | null; validFrom: string } | null> {
  const [row] = await tx
    .select()
    .from(claimPolicy)
    .where(
      and(
        eq(claimPolicy.claimTypeId, claimTypeId),
        lte(claimPolicy.validFrom, asOf),
        or(isNull(claimPolicy.validTo), sql`${claimPolicy.validTo} > ${asOf}`),
      ),
    )
    .orderBy(desc(claimPolicy.validFrom))
    .limit(1);
  return row ? { annualBudget: num(row.annualBudget), perClaimCap: num(row.perClaimCap), validFrom: row.validFrom } : null;
}

/** All non-archived claim types with their active policy — the admin catalog. */
export async function listClaimTypes(ctx: SessionContext, p?: { asOf?: string }): Promise<ClaimTypeRow[]> {
  const asOf = p?.asOf ?? today();
  return withTenant(ctx, async (tx) => {
    const types = await tx
      .select()
      .from(claimType)
      .where(isNull(claimType.archivedAt))
      .orderBy(claimType.code);
    return Promise.all(
      types.map(async (t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        defaultTaxable: t.defaultTaxable,
        requiresReceipt: t.requiresReceipt,
        archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
        policy: await getActiveClaimPolicy(tx, t.id, asOf),
      })),
    );
  });
}

export async function createClaimType(
  ctx: SessionContext,
  p: { code: string; name: string; defaultTaxable: boolean; requiresReceipt: boolean },
): Promise<{ id: string }> {
  const code = p.code.trim().toUpperCase();
  if (!code) throw new Error('Claim type code is required');
  if (!p.name.trim()) throw new Error('Claim type name is required');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(claimType)
      .values({ tenantId: ctx.tenantId, code, name: p.name.trim(), defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt })
      .returning({ id: claimType.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-type',
      aggregateId: row.id,
      eventType: 'claim-type.created',
      actor: actorOf(ctx),
      payload: { code, name: p.name.trim(), defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt },
    });
    return { id: row.id };
  });
}

export async function updateClaimType(
  ctx: SessionContext,
  p: { id: string; name: string; defaultTaxable: boolean; requiresReceipt: boolean },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(claimType)
      .set({ name: p.name.trim(), defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt })
      .where(eq(claimType.id, p.id))
      .returning({ id: claimType.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-type',
      aggregateId: p.id,
      eventType: 'claim-type.updated',
      actor: actorOf(ctx),
      payload: { name: p.name.trim(), defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt },
    });
  });
}

export async function archiveClaimType(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(claimType)
      .set({ archivedAt: new Date() })
      .where(and(eq(claimType.id, id), isNull(claimType.archivedAt)))
      .returning({ id: claimType.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-type',
      aggregateId: id,
      eventType: 'claim-type.archived',
      actor: actorOf(ctx),
    });
  });
}

/**
 * Set the budget policy for a claim type, effective-dated (CLOSE the open version + INSERT a new one — never
 * UPDATE business columns in place). NULL budget/cap = unlimited / no cap.
 */
export async function setClaimPolicy(
  ctx: SessionContext,
  p: { claimTypeId: string; annualBudget: number | null; perClaimCap: number | null; effectiveFrom: string },
): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveFrom)) throw new Error('effectiveFrom must be YYYY-MM-DD');
  if (p.annualBudget != null && p.annualBudget < 0) throw new Error('Annual budget must be ≥ 0');
  if (p.perClaimCap != null && p.perClaimCap < 0) throw new Error('Per-claim cap must be ≥ 0');
  return withTenant(ctx, async (tx) => {
    // Close any currently-open policy for this type (half-open validity).
    await tx
      .update(claimPolicy)
      .set({ validTo: p.effectiveFrom })
      .where(and(eq(claimPolicy.claimTypeId, p.claimTypeId), isNull(claimPolicy.validTo)));
    const [row] = await tx
      .insert(claimPolicy)
      .values({
        tenantId: ctx.tenantId,
        claimTypeId: p.claimTypeId,
        annualBudget: p.annualBudget == null ? null : p.annualBudget.toFixed(2),
        perClaimCap: p.perClaimCap == null ? null : p.perClaimCap.toFixed(2),
        validFrom: p.effectiveFrom,
      })
      .returning({ id: claimPolicy.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-policy',
      aggregateId: row.id,
      eventType: 'claim-policy.set',
      actor: actorOf(ctx),
      payload: { claimTypeId: p.claimTypeId, annualBudget: p.annualBudget, perClaimCap: p.perClaimCap, effectiveFrom: p.effectiveFrom },
    });
    return { id: row.id };
  });
}
