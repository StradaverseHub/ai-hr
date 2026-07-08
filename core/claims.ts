/**
 * Claims module (ADR-0021) — claim-type catalog + effective-dated budget policy. Admin-managed (RLS
 * admin-write); every state change appends a DomainEvent. The lifecycle (submit/decide) + payout live in
 * later slices of this file.
 */
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  claimAttachment,
  claimItem,
  claimPolicy,
  claimRequest,
  claimType,
  company,
  employeeStatutoryMy,
  employment,
  jobGrade,
  payrollBatch,
  payrollInput,
  person,
  type ClaimRateConfig,
} from '../db/schema';

export type { ClaimRateConfig };
import { toCsv } from '../lib/csv';
import { assertCanDecide } from './approvals';
import { resolveBatchScopeFilter, resolveBatchCutOffWindow, type BatchScope } from './payroll';
import { calendarWindowFor } from './payroll-policy-config';

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'reimbursements';

const today = (): string => new Date().toISOString().slice(0, 10);
const num = (v: string | null): number | null => (v == null ? null : Number(v));

/** UTC-date floor for the receipt window: the YYYY-MM-DD `days` before the given UTC date (inclusive on the
 *  caller's >= compare). Computed off the same UTC date string the UI picker uses, so the boundary the user
 *  sees and the server enforces agree even at a UTC+8 local midnight. */
export const dateMinusDays = (yyyyMmDd: string, days: number): string =>
  new Date(new Date(`${yyyyMmDd}T00:00:00Z`).getTime() - days * 86400000).toISOString().slice(0, 10);

/** Receipt date window: not in the future, and not more than this many days back (≈1.5 months per ticket). */
export const RECEIPT_BACKDATE_DAYS = 45;

/** RM money for a user-facing error/message (2dp). */
const rmMsg = (n: number): string => `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;

export type ClaimItemRow = { id: string; code: string; name: string };

export type ClaimPolicyRow = {
  annualBudget: number | null;
  perClaimCap: number | null;
  monthlyLimit: number | null;
  lifetimeLimit: number | null;
  maxClaimsPerYear: number | null;
  /** Which grade this resolved row is scoped to (null = the all-grades default). (ccbd0508) */
  gradeId: string | null;
  rateConfig: ClaimRateConfig | null;
  validFrom: string;
};

export type ClaimTypeRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultTaxable: boolean;
  requiresReceipt: boolean;
  maxReceiptAgeDays: number | null;
  archivedAt: string | null;
  policy: ClaimPolicyRow | null;
  items: ClaimItemRow[];
};

type RawPolicy = typeof claimPolicy.$inferSelect;
const toPolicyRow = (row: RawPolicy): ClaimPolicyRow => ({
  annualBudget: num(row.annualBudget),
  perClaimCap: num(row.perClaimCap),
  monthlyLimit: num(row.monthlyLimit),
  lifetimeLimit: num(row.lifetimeLimit),
  maxClaimsPerYear: row.maxClaimsPerYear ?? null,
  gradeId: row.gradeId ?? null,
  rateConfig: row.rateConfig ?? null,
  validFrom: row.validFrom,
});

/**
 * The active policy for a claim type resolved for the employee's job grade, or null. Pure read in the
 * caller tx. Grade tiering (ccbd0508): a policy row whose grade_id matches the employee's grade wins over
 * the null-grade default (mirrors leave_policy's resolveGradePolicy). Within the winning grade tier the
 * latest effective version ≤ asOf is chosen (append-only CLOSE+INSERT versioning). `gradeId = null` (the
 * default) resolves exactly as the pre-ccbd0508 code did, so ungraded employees and legacy null-grade
 * policies are byte-identical.
 */
export async function getActiveClaimPolicy(
  tx: Tx,
  claimTypeId: string,
  asOf: string,
  gradeId: string | null = null,
): Promise<ClaimPolicyRow | null> {
  const rows = await tx
    .select()
    .from(claimPolicy)
    .where(
      and(
        eq(claimPolicy.claimTypeId, claimTypeId),
        lte(claimPolicy.validFrom, asOf),
        or(isNull(claimPolicy.validTo), sql`${claimPolicy.validTo} > ${asOf}`),
      ),
    )
    .orderBy(desc(claimPolicy.validFrom));
  // latest-validFrom-first, so [0] of any subset is that tier's active version.
  const graded = gradeId ? rows.filter((r) => r.gradeId === gradeId) : [];
  const chosen = graded.length > 0 ? graded[0] : rows.find((r) => r.gradeId == null);
  return chosen ? toPolicyRow(chosen) : null;
}

/** Non-archived items for a claim type (code asc), in the caller tx. */
async function activeItemsFor(tx: Tx, claimTypeId: string): Promise<ClaimItemRow[]> {
  const rows = await tx
    .select({ id: claimItem.id, code: claimItem.code, name: claimItem.name })
    .from(claimItem)
    .where(and(eq(claimItem.claimTypeId, claimTypeId), isNull(claimItem.archivedAt)))
    .orderBy(claimItem.code);
  return rows;
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
        description: t.description ?? null,
        defaultTaxable: t.defaultTaxable,
        requiresReceipt: t.requiresReceipt,
        maxReceiptAgeDays: t.maxReceiptAgeDays ?? null,
        archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
        // The admin Claim Types tab resolves the null-grade default only; per-grade limits live on the
        // Claim Limits tab (listClaimLimits) and the employee form resolves for the claimant's own grade.
        policy: await getActiveClaimPolicy(tx, t.id, asOf),
        items: await activeItemsFor(tx, t.id),
      })),
    );
  });
}

/** Non-archived items for a claim type — the admin sub-list. */
export async function listClaimItems(ctx: SessionContext, p: { claimTypeId: string }): Promise<ClaimItemRow[]> {
  return withTenant(ctx, (tx) => activeItemsFor(tx, p.claimTypeId));
}

// ─────────────────────────────── Claim Limits (ccbd0508 — per Job-Grade × Claim Type) ───────────────────────────────

export type ClaimLimitRow = {
  claimTypeId: string;
  typeCode: string;
  typeName: string;
  gradeId: string | null;
  gradeName: string | null;
  gradeRank: number | null;
  annualBudget: number | null;
  perClaimCap: number | null;
  monthlyLimit: number | null;
  lifetimeLimit: number | null;
  maxClaimsPerYear: number | null;
  rateConfig: ClaimRateConfig | null;
  validFrom: string;
};

/**
 * Every non-archived claim type × its ACTIVE limit rows across grades (the Claim Limits admin tab). One row
 * per (type, grade) — the latest effective version ≤ asOf — joined to the job_grade name/rank. gradeId null =
 * the all-grades default row. Read-only (no events).
 */
export async function listClaimLimits(ctx: SessionContext, p?: { asOf?: string }): Promise<ClaimLimitRow[]> {
  const asOf = p?.asOf ?? today();
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        claimTypeId: claimType.id,
        typeCode: claimType.code,
        typeName: claimType.name,
        gradeId: claimPolicy.gradeId,
        gradeName: jobGrade.name,
        gradeRank: jobGrade.rank,
        annualBudget: claimPolicy.annualBudget,
        perClaimCap: claimPolicy.perClaimCap,
        monthlyLimit: claimPolicy.monthlyLimit,
        lifetimeLimit: claimPolicy.lifetimeLimit,
        maxClaimsPerYear: claimPolicy.maxClaimsPerYear,
        rateConfig: claimPolicy.rateConfig,
        validFrom: claimPolicy.validFrom,
      })
      .from(claimPolicy)
      .innerJoin(claimType, eq(claimType.id, claimPolicy.claimTypeId))
      .leftJoin(jobGrade, eq(jobGrade.id, claimPolicy.gradeId))
      .where(
        and(
          isNull(claimType.archivedAt),
          lte(claimPolicy.validFrom, asOf),
          or(isNull(claimPolicy.validTo), sql`${claimPolicy.validTo} > ${asOf}`),
        ),
      )
      .orderBy(claimType.code, desc(claimPolicy.validFrom));
    // Keep only the latest active version per (type, grade).
    const seen = new Set<string>();
    const out: ClaimLimitRow[] = [];
    for (const r of rows) {
      const key = `${r.claimTypeId}:${r.gradeId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        claimTypeId: r.claimTypeId,
        typeCode: r.typeCode,
        typeName: r.typeName,
        gradeId: r.gradeId ?? null,
        gradeName: r.gradeName ?? null,
        gradeRank: r.gradeRank ?? null,
        annualBudget: num(r.annualBudget),
        perClaimCap: num(r.perClaimCap),
        monthlyLimit: num(r.monthlyLimit),
        lifetimeLimit: num(r.lifetimeLimit),
        maxClaimsPerYear: r.maxClaimsPerYear ?? null,
        rateConfig: r.rateConfig ?? null,
        validFrom: r.validFrom,
      });
    }
    return out;
  });
}

export type ClaimBalanceRow = {
  claimTypeId: string;
  typeCode: string;
  typeName: string;
  /** null across the board ⇒ no limit configured for this employee's grade (unlimited). */
  annualLimit: number | null;
  usedThisYear: number;
  remainingThisYear: number | null;
  monthlyLimit: number | null;
  usedThisMonth: number;
  remainingThisMonth: number | null;
  perClaimCap: number | null;
  lifetimeLimit: number | null;
  usedLifetime: number;
  claimsUsedThisYear: number;
  maxClaimsPerYear: number | null;
};


/** Normalize the optional per-type receipt-age window: null (use global default) or a positive integer. */
const receiptAgeOrNull = (v: number | null | undefined): number | null => {
  if (v == null) return null;
  if (!Number.isInteger(v) || v <= 0) throw new Error('Maximum receipt age must be a positive whole number of days');
  return v;
};

export async function createClaimType(
  ctx: SessionContext,
  p: {
    code: string;
    name: string;
    defaultTaxable: boolean;
    requiresReceipt: boolean;
    description?: string | null;
    maxReceiptAgeDays?: number | null;
  },
): Promise<{ id: string }> {
  const code = p.code.trim().toUpperCase();
  if (!code) throw new Error('Claim type code is required');
  if (!p.name.trim()) throw new Error('Claim type name is required');
  const description = p.description?.trim() || null;
  const maxReceiptAgeDays = receiptAgeOrNull(p.maxReceiptAgeDays);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(claimType)
      .values({
        tenantId: ctx.tenantId,
        code,
        name: p.name.trim(),
        description,
        defaultTaxable: p.defaultTaxable,
        requiresReceipt: p.requiresReceipt,
        maxReceiptAgeDays,
      })
      .returning({ id: claimType.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-type',
      aggregateId: row.id,
      eventType: 'claim-type.created',
      actor: actorOf(ctx),
      payload: { code, name: p.name.trim(), description, defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt, maxReceiptAgeDays },
    });
    return { id: row.id };
  });
}

export async function updateClaimType(
  ctx: SessionContext,
  p: {
    id: string;
    name: string;
    defaultTaxable: boolean;
    requiresReceipt: boolean;
    description?: string | null;
    maxReceiptAgeDays?: number | null;
  },
): Promise<void> {
  const description = p.description?.trim() || null;
  const maxReceiptAgeDays = receiptAgeOrNull(p.maxReceiptAgeDays);
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(claimType)
      .set({ name: p.name.trim(), description, defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt, maxReceiptAgeDays })
      .where(eq(claimType.id, p.id))
      .returning({ id: claimType.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-type',
      aggregateId: p.id,
      eventType: 'claim-type.updated',
      actor: actorOf(ctx),
      payload: { name: p.name.trim(), description, defaultTaxable: p.defaultTaxable, requiresReceipt: p.requiresReceipt, maxReceiptAgeDays },
    });
  });
}

/**
 * Hard-delete a claim type — ONLY when it has never been used (zero claim_request rows in ANY status).
 * Cascade-deletes its claim_item sub-categories and claim_policy limit versions in the same tx. A type that
 * has claim history must be Archived instead (soft-delete), so money records are never orphaned. (ccbd0508)
 */
export async function deleteClaimType(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [ct] = await tx.select({ id: claimType.id, code: claimType.code }).from(claimType).where(eq(claimType.id, id)).limit(1);
    if (!ct) return;
    const [used] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(claimRequest)
      .where(eq(claimRequest.claimTypeId, id));
    if (Number(used?.n ?? 0) > 0) {
      throw new Error('This claim type has claims and cannot be deleted — archive it instead.');
    }
    const items = await tx.delete(claimItem).where(eq(claimItem.claimTypeId, id)).returning({ id: claimItem.id });
    const policies = await tx.delete(claimPolicy).where(eq(claimPolicy.claimTypeId, id)).returning({ id: claimPolicy.id });
    await tx.delete(claimType).where(eq(claimType.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-type',
      aggregateId: id,
      eventType: 'claim-type.deleted',
      actor: actorOf(ctx),
      payload: { code: ct.code, hadItems: items.length, hadPolicies: policies.length },
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

// ─────────────────────────────── Claim-item catalog (dependent sub-category) ───────────────────────────────
// Mirrors the claim-type CRUD: code normalized to TRIM + UPPER (so PARKING/parking can't both live under one
// type and defeat the partial-unique index), code immutable after create, soft-delete via archivedAt.

export async function createClaimItem(
  ctx: SessionContext,
  p: { claimTypeId: string; code: string; name: string },
): Promise<{ id: string }> {
  const code = p.code.trim().toUpperCase();
  if (!code) throw new Error('Claim item code is required');
  if (!p.name.trim()) throw new Error('Claim item name is required');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(claimItem)
      .values({ tenantId: ctx.tenantId, claimTypeId: p.claimTypeId, code, name: p.name.trim() })
      .returning({ id: claimItem.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-item',
      aggregateId: row.id,
      eventType: 'claim-item.created',
      actor: actorOf(ctx),
      payload: { claimTypeId: p.claimTypeId, code, name: p.name.trim() },
    });
    return { id: row.id };
  });
}

export async function updateClaimItem(ctx: SessionContext, p: { id: string; name: string }): Promise<void> {
  if (!p.name.trim()) throw new Error('Claim item name is required');
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(claimItem)
      .set({ name: p.name.trim() })
      .where(eq(claimItem.id, p.id))
      .returning({ id: claimItem.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-item',
      aggregateId: p.id,
      eventType: 'claim-item.updated',
      actor: actorOf(ctx),
      payload: { name: p.name.trim() },
    });
  });
}

export async function archiveClaimItem(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(claimItem)
      .set({ archivedAt: new Date() })
      .where(and(eq(claimItem.id, id), isNull(claimItem.archivedAt)))
      .returning({ id: claimItem.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-item',
      aggregateId: id,
      eventType: 'claim-item.archived',
      actor: actorOf(ctx),
    });
  });
}

/** Validate a rate-config union, throwing a plain Error for the admin path. */
function assertValidRateConfig(rc: ClaimRateConfig): void {
  if (rc.kind === 'mileage_flat') {
    if (!(rc.ratePerKm > 0)) throw new Error('Mileage rate per km must be greater than zero');
  } else if (rc.kind === 'fixed_allowance') {
    if (!(rc.amount > 0)) throw new Error('Fixed allowance amount must be greater than zero');
  }
}

/**
 * Set the budget policy for a claim type, effective-dated (CLOSE the open version + INSERT a new one — never
 * UPDATE business columns in place). NULL budget/cap = unlimited / no cap. `rateConfig` (optional) carries the
 * per-type calculation kind; because policies are append-only, a rate change is a new effective-dated version
 * with full history — no destructive in-place overwrite, no silent re-pricing of historical claims.
 */
export async function setClaimPolicy(
  ctx: SessionContext,
  p: {
    claimTypeId: string;
    annualBudget: number | null;
    perClaimCap: number | null;
    effectiveFrom: string;
    rateConfig?: ClaimRateConfig | null;
    /** null (or absent) = the all-grades default row; a grade id = a per-grade limit. (ccbd0508) */
    gradeId?: string | null;
    monthlyLimit?: number | null;
    lifetimeLimit?: number | null;
    maxClaimsPerYear?: number | null;
  },
): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveFrom)) throw new Error('effectiveFrom must be YYYY-MM-DD');
  if (p.annualBudget != null && p.annualBudget < 0) throw new Error('Annual budget must be ≥ 0');
  if (p.perClaimCap != null && p.perClaimCap < 0) throw new Error('Per-claim cap must be ≥ 0');
  if (p.monthlyLimit != null && p.monthlyLimit < 0) throw new Error('Monthly limit must be ≥ 0');
  if (p.lifetimeLimit != null && p.lifetimeLimit < 0) throw new Error('Lifetime limit must be ≥ 0');
  const maxClaimsPerYear = p.maxClaimsPerYear ?? null;
  if (maxClaimsPerYear != null && (!Number.isInteger(maxClaimsPerYear) || maxClaimsPerYear < 0)) {
    throw new Error('Number of claims allowed must be a whole number ≥ 0');
  }
  if (p.rateConfig != null) assertValidRateConfig(p.rateConfig);
  const gradeId = p.gradeId ?? null;
  return withTenant(ctx, async (tx) => {
    // Close the currently-open policy version for THIS (type, grade) only (half-open validity) — a
    // null-safe grade compare so changing the Executive-Medical limit never closes the Manager-Medical row.
    await tx
      .update(claimPolicy)
      .set({ validTo: p.effectiveFrom })
      .where(
        and(
          eq(claimPolicy.claimTypeId, p.claimTypeId),
          isNull(claimPolicy.validTo),
          gradeId == null ? isNull(claimPolicy.gradeId) : eq(claimPolicy.gradeId, gradeId),
        ),
      );
    const [row] = await tx
      .insert(claimPolicy)
      .values({
        tenantId: ctx.tenantId,
        claimTypeId: p.claimTypeId,
        gradeId,
        annualBudget: p.annualBudget == null ? null : p.annualBudget.toFixed(2),
        perClaimCap: p.perClaimCap == null ? null : p.perClaimCap.toFixed(2),
        monthlyLimit: p.monthlyLimit == null ? null : p.monthlyLimit.toFixed(2),
        lifetimeLimit: p.lifetimeLimit == null ? null : p.lifetimeLimit.toFixed(2),
        maxClaimsPerYear,
        rateConfig: p.rateConfig ?? null,
        validFrom: p.effectiveFrom,
      })
      .returning({ id: claimPolicy.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-policy',
      aggregateId: row.id,
      eventType: 'claim-policy.set',
      actor: actorOf(ctx),
      // limits + rateConfig are RATES/config (not a claim amount) — safe to log (ADR-0030).
      payload: {
        claimTypeId: p.claimTypeId,
        gradeId,
        annualBudget: p.annualBudget,
        perClaimCap: p.perClaimCap,
        monthlyLimit: p.monthlyLimit ?? null,
        lifetimeLimit: p.lifetimeLimit ?? null,
        maxClaimsPerYear,
        effectiveFrom: p.effectiveFrom,
        rateConfig: p.rateConfig ?? null,
      },
    });
    return { id: row.id };
  });
}

/**
 * Derive the authoritative claim amount from the rate config (pure — unit-testable in isolation):
 *   • receipt (or null/absent) → the employee-entered amount.
 *   • mileage_flat            → quantityKm × ratePerKm (km must be > 0).
 *   • fixed_allowance         → the config amount (entered amount ignored).
 */
export function computeClaimAmount(
  rateConfig: ClaimRateConfig | null | undefined,
  p: { quantityKm?: number | null; enteredAmount?: number | null },
): number {
  const kind = rateConfig?.kind ?? 'receipt';
  if (kind === 'mileage_flat') {
    const km = p.quantityKm;
    if (km == null || !(km > 0)) throw new ClaimError('Distance (km) must be greater than zero');
    return (rateConfig as { ratePerKm: number }).ratePerKm * km;
  }
  if (kind === 'fixed_allowance') {
    return (rateConfig as { amount: number }).amount;
  }
  return p.enteredAmount ?? 0;
}

export type EmployeeClaimType = {
  id: string;
  code: string;
  name: string;
  requiresReceipt: boolean;
  rateConfig: ClaimRateConfig | null;
  /** Per-type receipt-backdate window in days (the per-type override, or the global default). */
  maxReceiptAgeDays: number;
  items: ClaimItemRow[];
  balance: ClaimBalanceRow;
};

/**
 * Everything the employee claim form needs, resolved for THIS employee's job grade (ccbd0508): per claim
 * type — its grade-resolved rate config + receipt window + dependent items + the live balance panel data
 * (annual/monthly limits, used, remaining). One read so a graded employee never sees another grade's rate.
 */
export async function getEmployeeClaimTypes(ctx: SessionContext, employmentId: string): Promise<EmployeeClaimType[]> {
  const asOf = today();
  const usedStatuses: ClaimStatus[] = ['pending', 'approved', 'paid'];
  return withTenant(ctx, async (tx) => {
    const [emp] = await tx.select({ gradeId: employment.gradeId }).from(employment).where(eq(employment.id, employmentId)).limit(1);
    const gradeId = emp?.gradeId ?? null;
    const types = await tx.select().from(claimType).where(isNull(claimType.archivedAt)).orderBy(claimType.code);
    return Promise.all(
      types.map(async (t) => {
        const policy = await getActiveClaimPolicy(tx, t.id, asOf, gradeId);
        const items = await activeItemsFor(tx, t.id);
        const usedThisYear = await claimedInScope(tx, employmentId, t.id, 'year', asOf, usedStatuses);
        const usedThisMonth = await claimedInScope(tx, employmentId, t.id, 'month', asOf, usedStatuses);
        const usedLifetime = policy?.lifetimeLimit != null ? await claimedInScope(tx, employmentId, t.id, 'lifetime', asOf, usedStatuses) : 0;
        const claimsUsedThisYear = await claimCountInScope(tx, employmentId, t.id, 'year', asOf, usedStatuses);
        const balance: ClaimBalanceRow = {
          claimTypeId: t.id,
          typeCode: t.code,
          typeName: t.name,
          annualLimit: policy?.annualBudget ?? null,
          usedThisYear,
          remainingThisYear: policy?.annualBudget == null ? null : Math.max(0, policy.annualBudget - usedThisYear),
          monthlyLimit: policy?.monthlyLimit ?? null,
          usedThisMonth,
          remainingThisMonth: policy?.monthlyLimit == null ? null : Math.max(0, policy.monthlyLimit - usedThisMonth),
          perClaimCap: policy?.perClaimCap ?? null,
          lifetimeLimit: policy?.lifetimeLimit ?? null,
          usedLifetime,
          claimsUsedThisYear,
          maxClaimsPerYear: policy?.maxClaimsPerYear ?? null,
        };
        return {
          id: t.id,
          code: t.code,
          name: t.name,
          requiresReceipt: t.requiresReceipt,
          rateConfig: policy?.rateConfig ?? null,
          maxReceiptAgeDays: t.maxReceiptAgeDays ?? RECEIPT_BACKDATE_DAYS,
          items,
          balance,
        };
      }),
    );
  });
}

// ─────────────────────────────── Lifecycle (ADR-0021 §2) ───────────────────────────────
// submit → pending → (approve | reject) ; approved → paid ; pending → cancelled. The service enforces the
// state machine + the self-approval ban (assertCanDecide) on top of the RLS visibility scope.

export class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimError';
  }
}

const yearOf = (d: string): number => Number(d.slice(0, 4));

type ClaimStatus = 'pending' | 'approved' | 'paid';
/** Period scope for a limit check, resolved off the claim's incurred_on date (YYYY-MM-DD):
 *   'year'     → same calendar year   ·   'month' → same calendar month   ·   'lifetime' → all-time. */
type LimitScope = 'year' | 'month' | 'lifetime';

const scopeCond = (scope: LimitScope, incurredOn: string) => {
  if (scope === 'year') return sql`extract(year from ${claimRequest.incurredOn}) = ${yearOf(incurredOn)}`;
  if (scope === 'month') return sql`to_char(${claimRequest.incurredOn}, 'YYYY-MM') = ${incurredOn.slice(0, 7)}`;
  return sql`true`; // lifetime — no period filter
};

/** Sum of a claim type's amounts for an employment within a period scope (by incurred_on), over the given
 *  statuses — used for budget/monthly/lifetime enforcement. */
async function claimedInScope(
  tx: Tx,
  employmentId: string,
  claimTypeId: string,
  scope: LimitScope,
  incurredOn: string,
  statuses: ClaimStatus[],
  excludeId?: string,
): Promise<number> {
  const conds = [
    eq(claimRequest.employmentId, employmentId),
    eq(claimRequest.claimTypeId, claimTypeId),
    scopeCond(scope, incurredOn),
    inArray(claimRequest.status, statuses),
  ];
  if (excludeId) conds.push(sql`${claimRequest.id} <> ${excludeId}`);
  const [row] = await tx.select({ s: sql<string>`coalesce(sum(${claimRequest.amount}), 0)` }).from(claimRequest).where(and(...conds));
  return Number(row?.s ?? 0);
}

/** Count of a claim type's claims for an employment within a period scope — used for the claims-per-year cap. */
async function claimCountInScope(
  tx: Tx,
  employmentId: string,
  claimTypeId: string,
  scope: LimitScope,
  incurredOn: string,
  statuses: ClaimStatus[],
  excludeId?: string,
): Promise<number> {
  const conds = [
    eq(claimRequest.employmentId, employmentId),
    eq(claimRequest.claimTypeId, claimTypeId),
    scopeCond(scope, incurredOn),
    inArray(claimRequest.status, statuses),
  ];
  if (excludeId) conds.push(sql`${claimRequest.id} <> ${excludeId}`);
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(claimRequest).where(and(...conds));
  return Number(row?.n ?? 0);
}


/** Submit a claim (employee, for their own employment — RLS enforces). Resolves the per-type rate config,
 *  validates the dependent item + receipt-date window, DERIVES the authoritative amount, then enforces the
 *  per-claim cap + annual budget against that amount. `taxable` defaults from the claim type. */
type SubmitClaimInput = {
  employmentId: string;
  claimTypeId: string;
  claimItemId?: string | null;
  amount: number;
  quantityKm?: number | null;
  incurredOn: string;
  description?: string | null;
  hasReceipt?: boolean;
};

/** The submit body, running INSIDE a caller-provided tx so it can be composed atomically with a receipt
 *  write (see submitClaimWithAttachment). The date-format guard runs before the tx opens in the public
 *  wrappers; everything that touches the DB lives here so a downstream failure rolls the claim back too. */
async function insertClaimTx(tx: Tx, ctx: SessionContext, p: SubmitClaimInput): Promise<{ id: string }> {
  // 2. Load the type + the claimant's grade + the grade-resolved active policy (also carries rateConfig).
  const [ct] = await tx.select().from(claimType).where(and(eq(claimType.id, p.claimTypeId), isNull(claimType.archivedAt))).limit(1);
  if (!ct) throw new ClaimError('Unknown or archived claim type');
  const [emp] = await tx.select({ gradeId: employment.gradeId }).from(employment).where(eq(employment.id, p.employmentId)).limit(1);
  const gradeId = emp?.gradeId ?? null;
  const policy = await getActiveClaimPolicy(tx, p.claimTypeId, p.incurredOn, gradeId);
  const committed: ClaimStatus[] = ['pending', 'approved', 'paid'];

  // 3. Item validation (D5): if the type has ≥1 live item, an item is required and must belong to the type.
  const items = await activeItemsFor(tx, p.claimTypeId);
  let claimItemId: string | null = null;
  if (items.length > 0) {
    if (!p.claimItemId) throw new ClaimError('A claim item is required for this claim type');
    if (!items.some((i) => i.id === p.claimItemId)) throw new ClaimError('That claim item does not belong to this claim type');
    claimItemId = p.claimItemId;
  }

  // 4. Receipt-date window: not in the future, and not more than the per-type window (or the global default)
  //    back. Compared as UTC date strings off the same helper the client picker uses (no UTC+8 off-by-one).
  const backdateDays = ct.maxReceiptAgeDays ?? RECEIPT_BACKDATE_DAYS;
  const todayUtc = today();
  if (p.incurredOn > todayUtc) throw new ClaimError('Receipt date cannot be in the future');
  if (p.incurredOn < dateMinusDays(todayUtc, backdateDays)) {
    throw new ClaimError(`Receipt date cannot be more than ${backdateDays} days ago`);
  }

  // 5. Derive the authoritative amount from the rate config BEFORE the value guards.
  const quantityKm = policy?.rateConfig?.kind === 'mileage_flat' ? (p.quantityKm ?? null) : null;
  const amount = computeClaimAmount(policy?.rateConfig, { quantityKm: p.quantityKm, enteredAmount: p.amount });
  if (!(amount > 0)) throw new ClaimError('Amount must be greater than zero');
  if (policy?.perClaimCap != null && amount > policy.perClaimCap) {
    throw new ClaimError(
      `This claim's amount (${rmMsg(amount)}) exceeds the per-claim cap for this claim type ` +
        `(${rmMsg(policy.perClaimCap)}). Reduce the amount, split it across multiple claims if appropriate, ` +
        `or ask an admin to review the cap.`,
    );
  }
  if (policy?.annualBudget != null) {
    const used = await claimedInScope(tx, p.employmentId, p.claimTypeId, 'year', p.incurredOn, committed);
    if (used + amount > policy.annualBudget) {
      const remaining = Math.max(0, policy.annualBudget - used);
      throw new ClaimError(
        `This claim (${rmMsg(amount)}) would bring your total for this claim type this year to ` +
          `${rmMsg(used + amount)}, which exceeds the annual limit of ${rmMsg(policy.annualBudget)}. You have ` +
          `${rmMsg(remaining)} remaining this year for this claim type.`,
      );
    }
  }
  if (policy?.monthlyLimit != null) {
    const used = await claimedInScope(tx, p.employmentId, p.claimTypeId, 'month', p.incurredOn, committed);
    if (used + amount > policy.monthlyLimit) {
      const remaining = Math.max(0, policy.monthlyLimit - used);
      throw new ClaimError(
        `This claim (${rmMsg(amount)}) would exceed the monthly limit of ${rmMsg(policy.monthlyLimit)} for this ` +
          `claim type. You have ${rmMsg(remaining)} remaining this month for this claim type.`,
      );
    }
  }
  if (policy?.lifetimeLimit != null) {
    const used = await claimedInScope(tx, p.employmentId, p.claimTypeId, 'lifetime', p.incurredOn, committed);
    if (used + amount > policy.lifetimeLimit) {
      const remaining = Math.max(0, policy.lifetimeLimit - used);
      throw new ClaimError(
        `This claim (${rmMsg(amount)}) would exceed the lifetime limit of ${rmMsg(policy.lifetimeLimit)} for this ` +
          `claim type. You have ${rmMsg(remaining)} remaining for this claim type.`,
      );
    }
  }
  if (policy?.maxClaimsPerYear != null) {
    const count = await claimCountInScope(tx, p.employmentId, p.claimTypeId, 'year', p.incurredOn, committed);
    if (count + 1 > policy.maxClaimsPerYear) {
      throw new ClaimError(
        `You have reached the maximum of ${policy.maxClaimsPerYear} claim(s) allowed this year for this claim type.`,
      );
    }
  }

  // 6. Receipt-required check (type-level, unchanged).
  if (ct.requiresReceipt && !p.hasReceipt) throw new ClaimError('A receipt is required for this claim type');

  // 7. Insert with the dependent item, mileage km, and computed amount.
  const [row] = await tx
    .insert(claimRequest)
    .values({
      tenantId: ctx.tenantId,
      employmentId: p.employmentId,
      claimTypeId: p.claimTypeId,
      claimItemId,
      amount: amount.toFixed(2),
      quantityKm: quantityKm == null ? null : quantityKm.toFixed(2),
      incurredOn: p.incurredOn,
      description: p.description ?? null,
      taxable: ct.defaultTaxable,
    })
    .returning({ id: claimRequest.id });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'claim-request',
    aggregateId: row.id,
    eventType: 'claim-request.submitted',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    // ADR-0030 Layer 0: amount + quantityKm live on claim_request[aggregateId]; reference, not cleartext in
    // the log (km × a readable per-km rate would reconstruct the redacted amount). claimItemId is safe (a
    // non-sensitive sub-category reference), so it is logged.
    payload: { claimTypeId: p.claimTypeId, claimItemId, incurredOn: p.incurredOn, taxable: ct.defaultTaxable },
  });
  return { id: row.id };
}

export async function submitClaim(ctx: SessionContext, p: SubmitClaimInput): Promise<{ id: string }> {
  // 1. Format guard for the date (value guards run AFTER the amount is derived, below).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.incurredOn)) throw new ClaimError('Incurred date must be YYYY-MM-DD');
  return withTenant(ctx, (tx) => insertClaimTx(tx, ctx, p));
}

/**
 * Submit a claim AND attach its receipt in ONE transaction so the two writes are atomic (ADR-0021 §2 fix).
 * The employee-facing action used to call submitClaim (its own committed tx) and THEN addClaimAttachment in a
 * SEPARATE tx: if the attachment step threw (bad bytes, size, a DB error), the claim was already committed but
 * the user still saw the error redirect — a "committed claim they think failed." Here a receipt failure rolls
 * the whole claim back, so the user's error and the DB agree: nothing was created. The optional-receipt path
 * (no attachment) collapses to a plain insertClaimTx. */
export async function submitClaimWithAttachment(
  ctx: SessionContext,
  p: SubmitClaimInput,
  attachment: { fileName: string; mimeType: string; content: Buffer } | null,
): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.incurredOn)) throw new ClaimError('Incurred date must be YYYY-MM-DD');
  // Validate the attachment BEFORE opening the tx so a bad file never even starts a claim insert.
  if (attachment) assertValidAttachment(attachment.mimeType, attachment.content);
  return withTenant(ctx, async (tx) => {
    const { id } = await insertClaimTx(tx, ctx, { ...p, hasReceipt: p.hasReceipt || attachment != null });
    if (attachment) {
      await insertClaimAttachmentTx(tx, ctx, {
        claimRequestId: id,
        employmentId: p.employmentId,
        status: 'pending',
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        content: attachment.content,
      });
    }
    return { id };
  });
}

/** Approve or reject a pending claim. assertCanDecide bans self-approval + requires admin/active manager.
 *  On approve, the decider may confirm/override `taxable`, and the annual budget is re-checked. */
export async function decideClaim(
  ctx: SessionContext,
  p: { claimRequestId: string; decision: 'approve' | 'reject'; taxable?: boolean; deciderEmploymentId?: string | null },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [claim] = await tx.select().from(claimRequest).where(eq(claimRequest.id, p.claimRequestId)).limit(1);
    if (!claim) throw new ClaimError('Claim not found');
    if (claim.status !== 'pending') throw new ClaimError('Only a pending claim can be decided');
    await assertCanDecide(tx, ctx, claim.employmentId, 'claim');

    if (p.decision === 'approve') {
      const taxable = p.taxable ?? claim.taxable;
      const [emp] = await tx.select({ gradeId: employment.gradeId }).from(employment).where(eq(employment.id, claim.employmentId)).limit(1);
      const policy = await getActiveClaimPolicy(tx, claim.claimTypeId, claim.incurredOn, emp?.gradeId ?? null);
      const amount = Number(claim.amount);
      const settled: ClaimStatus[] = ['approved', 'paid'];
      if (policy?.annualBudget != null) {
        const others = await claimedInScope(tx, claim.employmentId, claim.claimTypeId, 'year', claim.incurredOn, settled, claim.id);
        if (others + amount > policy.annualBudget) {
          throw new ClaimError(`Approving this would exceed the annual limit (${rmMsg(policy.annualBudget)})`);
        }
      }
      if (policy?.monthlyLimit != null) {
        const others = await claimedInScope(tx, claim.employmentId, claim.claimTypeId, 'month', claim.incurredOn, settled, claim.id);
        if (others + amount > policy.monthlyLimit) {
          throw new ClaimError(`Approving this would exceed the monthly limit (${rmMsg(policy.monthlyLimit)})`);
        }
      }
      if (policy?.lifetimeLimit != null) {
        const others = await claimedInScope(tx, claim.employmentId, claim.claimTypeId, 'lifetime', claim.incurredOn, settled, claim.id);
        if (others + amount > policy.lifetimeLimit) {
          throw new ClaimError(`Approving this would exceed the lifetime limit (${rmMsg(policy.lifetimeLimit)})`);
        }
      }
      if (policy?.maxClaimsPerYear != null) {
        const others = await claimCountInScope(tx, claim.employmentId, claim.claimTypeId, 'year', claim.incurredOn, settled, claim.id);
        if (others + 1 > policy.maxClaimsPerYear) {
          throw new ClaimError(`Approving this would exceed the maximum of ${policy.maxClaimsPerYear} claim(s) allowed this year`);
        }
      }
      await tx
        .update(claimRequest)
        .set({ status: 'approved', taxable, decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: new Date() })
        .where(eq(claimRequest.id, claim.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: claim.id,
        eventType: 'claim-request.approved',
        actor: actorOf(ctx),
        subjectEmploymentId: claim.employmentId,
        payload: { taxable, payoutMethod: taxable ? 'payroll' : 'reimbursement' }, // amount on claim_request[aggregateId] (ADR-0030)
      });
    } else {
      await tx
        .update(claimRequest)
        .set({ status: 'rejected', decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: new Date() })
        .where(eq(claimRequest.id, claim.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: claim.id,
        eventType: 'claim-request.rejected',
        actor: actorOf(ctx),
        subjectEmploymentId: claim.employmentId,
      });
    }
  });
}

/** Cancel a pending claim (the claimant or an admin). */
export async function cancelClaim(ctx: SessionContext, claimRequestId: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [claim] = await tx
      .select({ id: claimRequest.id, status: claimRequest.status, employmentId: claimRequest.employmentId, personId: employment.personId })
      .from(claimRequest)
      .innerJoin(employment, eq(employment.id, claimRequest.employmentId))
      .where(eq(claimRequest.id, claimRequestId))
      .limit(1);
    if (!claim) throw new ClaimError('Claim not found');
    if (claim.status !== 'pending') throw new ClaimError('Only a pending claim can be cancelled');
    const isAdmin = (ctx.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
    const isOwner = ctx.personId != null && claim.personId === ctx.personId;
    if (!isAdmin && !isOwner) throw new ClaimError('Only the claimant or an admin can cancel this claim');
    await tx.update(claimRequest).set({ status: 'cancelled' }).where(eq(claimRequest.id, claim.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-request',
      aggregateId: claim.id,
      eventType: 'claim-request.cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: claim.employmentId,
    });
  });
}

/** Receipt MIME allowlist (fail-closed): only PDF / JPG / PNG. The action sniffs magic bytes to derive a
 *  trustworthy mimeType BEFORE calling this, so the allowlist is checked against the sniffed value, not the
 *  spoofable client `file.type`. */
export const ALLOWED_RECEIPT_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;

/** Fail-closed receipt validation (empty / oversized / disallowed MIME). Shared by addClaimAttachment and the
 *  atomic submitClaimWithAttachment so both paths reject the same files with the same messages. */
function assertValidAttachment(mimeType: string, content: Buffer): void {
  if (content.byteLength === 0) throw new ClaimError('Empty file');
  if (content.byteLength > 10 * 1024 * 1024) throw new ClaimError('File exceeds 10 MB');
  if (!(ALLOWED_RECEIPT_MIME as readonly string[]).includes(mimeType)) {
    throw new ClaimError('Only PDF, JPG, or PNG files are allowed');
  }
}

/** Insert a receipt row + its event INSIDE a caller-provided tx. `status` is the claim's already-known status
 *  (skips a re-read when the caller just inserted the claim in the same tx). */
async function insertClaimAttachmentTx(
  tx: Tx,
  ctx: SessionContext,
  p: { claimRequestId: string; employmentId: string; status: string; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  if (p.status !== 'pending') throw new ClaimError('Receipts can only be added while the claim is pending');
  const [row] = await tx
    .insert(claimAttachment)
    .values({
      tenantId: ctx.tenantId,
      claimRequestId: p.claimRequestId,
      employmentId: p.employmentId,
      content: p.content,
      fileName: p.fileName,
      mimeType: p.mimeType,
      sizeBytes: p.content.byteLength,
      uploadedByUserId: ctx.userId ?? null,
    })
    .returning({ id: claimAttachment.id });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'claim-request',
    aggregateId: p.claimRequestId,
    eventType: 'claim-request.receipt-added',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: { fileName: p.fileName, sizeBytes: p.content.byteLength },
  });
  return { id: row.id };
}

/** Attach a receipt to a claim (denormalizes employment_id from the claim for RLS). */
export async function addClaimAttachment(
  ctx: SessionContext,
  p: { claimRequestId: string; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  assertValidAttachment(p.mimeType, p.content);
  return withTenant(ctx, async (tx) => {
    const [claim] = await tx
      .select({ id: claimRequest.id, employmentId: claimRequest.employmentId, status: claimRequest.status })
      .from(claimRequest)
      .where(eq(claimRequest.id, p.claimRequestId))
      .limit(1);
    if (!claim) throw new ClaimError('Claim not found');
    return insertClaimAttachmentTx(tx, ctx, {
      claimRequestId: claim.id,
      employmentId: claim.employmentId,
      status: claim.status,
      fileName: p.fileName,
      mimeType: p.mimeType,
      content: p.content,
    });
  });
}

/** Read a receipt's bytes for download (RLS scopes visibility to the claim). */
export async function getClaimAttachment(
  ctx: SessionContext,
  attachmentId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ content: claimAttachment.content, fileName: claimAttachment.fileName, mimeType: claimAttachment.mimeType })
      .from(claimAttachment)
      .where(eq(claimAttachment.id, attachmentId))
      .limit(1);
    return row ? { content: row.content, fileName: row.fileName, mimeType: row.mimeType } : null;
  });
}

// ─────────────────────────────── Reads (UI) ───────────────────────────────

export type ClaimRow = {
  id: string;
  typeCode: string;
  typeName: string;
  itemName: string | null;
  amount: number;
  quantityKm: number | null;
  incurredOn: string;
  description: string | null;
  taxable: boolean;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  paidAt: string | null;
  claimantName?: string;
  employeeCode: string | null;
  personId: string | null;
  attachments: { id: string; fileName: string; sizeBytes: number }[];
};

function rowSelect() {
  return {
    id: claimRequest.id,
    typeCode: claimType.code,
    typeName: claimType.name,
    itemName: claimItem.name,
    amount: claimRequest.amount,
    quantityKm: claimRequest.quantityKm,
    incurredOn: claimRequest.incurredOn,
    description: claimRequest.description,
    taxable: claimRequest.taxable,
    status: claimRequest.status,
    createdAt: claimRequest.createdAt,
    decidedAt: claimRequest.decidedAt,
    paidAt: claimRequest.paidAt,
    employmentId: claimRequest.employmentId,
    claimantName: person.fullName,
    employeeCode: employment.employeeCode,
    personId: employment.personId,
  };
}

async function attachmentsByClaim(tx: Tx, claimIds: string[]) {
  if (claimIds.length === 0) return new Map<string, { id: string; fileName: string; sizeBytes: number }[]>();
  const atts = await tx
    .select({ id: claimAttachment.id, claimRequestId: claimAttachment.claimRequestId, fileName: claimAttachment.fileName, sizeBytes: claimAttachment.sizeBytes })
    .from(claimAttachment)
    .where(inArray(claimAttachment.claimRequestId, claimIds));
  const m = new Map<string, { id: string; fileName: string; sizeBytes: number }[]>();
  for (const a of atts) {
    const arr = m.get(a.claimRequestId) ?? [];
    arr.push({ id: a.id, fileName: a.fileName, sizeBytes: a.sizeBytes });
    m.set(a.claimRequestId, arr);
  }
  return m;
}

type RawClaimRow = {
  id: string;
  typeCode: string;
  typeName: string;
  itemName: string | null;
  amount: string;
  quantityKm: string | null;
  incurredOn: string;
  description: string | null;
  taxable: boolean;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  paidAt: Date | null;
  employmentId: string;
  claimantName: string;
  employeeCode: string | null;
  personId: string | null;
};

const toRow = (r: RawClaimRow, atts: Map<string, ClaimRow['attachments']>): ClaimRow => ({
  id: r.id,
  typeCode: r.typeCode,
  typeName: r.typeName,
  itemName: r.itemName,
  amount: Number(r.amount),
  quantityKm: r.quantityKm == null ? null : Number(r.quantityKm),
  incurredOn: r.incurredOn,
  description: r.description,
  taxable: r.taxable,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  paidAt: r.paidAt ? r.paidAt.toISOString() : null,
  claimantName: r.claimantName,
  employeeCode: r.employeeCode,
  personId: r.personId,
  attachments: atts.get(r.id) ?? [],
});

/** A single employment's claims (newest first) — "my claims". */
export async function listClaimsForEmployment(ctx: SessionContext, employmentId: string): Promise<ClaimRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select(rowSelect())
      .from(claimRequest)
      .innerJoin(claimType, eq(claimType.id, claimRequest.claimTypeId))
      // LEFT join: legacy/zero-item rows (claim_item_id IS NULL) must not be dropped from the list.
      .leftJoin(claimItem, eq(claimItem.id, claimRequest.claimItemId))
      .innerJoin(employment, eq(employment.id, claimRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(claimRequest.employmentId, employmentId))
      .orderBy(desc(claimRequest.createdAt));
    const atts = await attachmentsByClaim(tx, rows.map((r) => r.id));
    return rows.map((r) => toRow(r, atts));
  });
}

/** Pending claims the caller may decide (RLS scopes: manager → reports, admin → all) — the approvals inbox. */
export async function listPendingClaims(ctx: SessionContext): Promise<ClaimRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select(rowSelect())
      .from(claimRequest)
      .innerJoin(claimType, eq(claimType.id, claimRequest.claimTypeId))
      // LEFT join: zero-item / legacy claims must still appear in the approvals inbox.
      .leftJoin(claimItem, eq(claimItem.id, claimRequest.claimItemId))
      .innerJoin(employment, eq(employment.id, claimRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(claimRequest.status, 'pending'))
      .orderBy(desc(claimRequest.createdAt));
    const atts = await attachmentsByClaim(tx, rows.map((r) => r.id));
    return rows.map((r) => toRow(r, atts));
  });
}

// ──────────────────────────── Payout (ADR-0021 §3, Slice 5) ────────────────────────────
//
// Two routes, chosen by the `taxable` flag confirmed at approval:
//   • taxable     → folded into the payslip's taxable allowance base (PCB/EPF/SOCSO/EIS) via
//                   payroll_input.claim_allowance. `prefillClaimsForBatch` queues approved-taxable
//                   claims onto a draft batch; generatePayslips marks them paid when it processes.
//   • non-taxable → paid off-cycle as a reimbursement (`markReimbursementsPaid` + bank CSV export).

/**
 * Queue approved, taxable, not-yet-scheduled claims for an employee's company onto a DRAFT payroll
 * batch: sum per employment into payroll_input.claim_allowance and stamp each claim's payrollBatchId
 * so generatePayslips folds the amount into the taxable allowance line (and marks the claims paid on
 * processing). Idempotent — already-linked claims are excluded, so re-running adds only new approvals.
 * Mirrors prefillOvertimeFromAttendance (preserves any existing manual input on the row).
 */
export async function prefillClaimsForBatch(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<{ applied: number; claims: number; total: number }> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
        scope: payrollBatch.scope,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new ClaimError('Payroll batch not found');
    if (batch.status !== 'draft') throw new ClaimError('Claims can only be prefilled onto a draft batch');

    // c7fdfcf6 (Payroll Schedule) — the CLAIM cut-off window for this run. A claim is queued only when it was
    // DECIDED (approved) on or before the window's close; approvals after the cut-off roll to the next run. The
    // filter is an UPPER bound only (older still-unscheduled claims catch up, unchanged). Applied ONLY when a
    // real (non-calendar) claim cut-off is configured — with no cut-off, claims are queued by status alone, exactly
    // as before (byte-identical: the plain calendar month is NOT imposed as a new filter).
    const claimWindow = await resolveBatchCutOffWindow(tx, batch.companyId, 'claim', batch.payPeriod);
    const calWindow = calendarWindowFor(batch.payPeriod);
    const claimCutOffActive = claimWindow.end !== calWindow.end || claimWindow.start !== calWindow.start;
    // Inclusive end-of-day upper bound on the approval timestamp (UTC — matches how decided_at is stored).
    const claimDecidedUpperBound = claimCutOffActive
      ? lte(claimRequest.decidedAt, sql`${`${claimWindow.end}T23:59:59.999Z`}::timestamptz`)
      : undefined;

    // Money-safety fix (Payroll Process wizard plan): narrow to the batch's scope (departments' current
    // assignees ∪ explicit individuals) EXACTLY the way generatePayslips resolves it, so this button never
    // reserves — and later marks paid — a claim belonging to someone who isn't actually in the run. No
    // scope ⇒ whole company (unchanged today's behaviour).
    const { filter: scopeFilter } = await resolveBatchScopeFilter(tx, (batch.scope ?? null) as BatchScope | null);

    // Approved + taxable + unscheduled claims for employees of this batch's company (and scope, if any).
    const due = await tx
      .select({ id: claimRequest.id, employmentId: claimRequest.employmentId, amount: claimRequest.amount })
      .from(claimRequest)
      .innerJoin(employment, eq(employment.id, claimRequest.employmentId))
      .where(
        and(
          eq(employment.companyId, batch.companyId),
          eq(claimRequest.status, 'approved'),
          eq(claimRequest.taxable, true),
          isNull(claimRequest.payrollBatchId),
          scopeFilter,
          claimDecidedUpperBound,
        ),
      );
    if (due.length === 0) return { applied: 0, claims: 0, total: 0 };

    // Sum per employment, and remember which claim ids belong to each.
    const sumByEmp = new Map<string, { cents: number; ids: string[] }>();
    for (const c of due) {
      const acc = sumByEmp.get(c.employmentId) ?? { cents: 0, ids: [] };
      acc.cents += Math.round(Number(c.amount) * 100);
      acc.ids.push(c.id);
      sumByEmp.set(c.employmentId, acc);
    }

    // Existing inputs: claim_allowance accumulates on top of any prior prefill for this batch.
    const existing = await tx
      .select({ id: payrollInput.id, employmentId: payrollInput.employmentId, claimAllowance: payrollInput.claimAllowance })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, p.batchId));
    const existingBy = new Map(existing.map((r) => [r.employmentId, r]));

    let total = 0;
    for (const [employmentId, { cents }] of sumByEmp) {
      const amount = cents / 100;
      total += cents;
      const prior = existingBy.get(employmentId);
      if (prior) {
        const next = round2Cents(Math.round(Number(prior.claimAllowance) * 100) + cents);
        await tx
          .update(payrollInput)
          .set({ claimAllowance: next, updatedAt: sql`now()` })
          .where(eq(payrollInput.id, prior.id));
      } else {
        await tx.insert(payrollInput).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId,
          claimAllowance: amount.toFixed(2),
        });
      }
    }

    // Stamp the claims onto the batch (reservation) — a deliberate state change, so each gets an event.
    const allIds = [...sumByEmp.values()].flatMap((v) => v.ids);
    await tx
      .update(claimRequest)
      .set({ payrollBatchId: p.batchId })
      .where(inArray(claimRequest.id, allIds));
    for (const c of due) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: c.id,
        eventType: 'claim-request.queued-for-payroll',
        actor: actorOf(ctx),
        subjectEmploymentId: c.employmentId,
        payload: { batchId: p.batchId }, // amount on claim_request[aggregateId] (ADR-0030)
      });
    }
    return { applied: sumByEmp.size, claims: due.length, total: total / 100 };
  });
}

const round2Cents = (cents: number): string => (cents / 100).toFixed(2);

export type ReimbursementRow = {
  id: string;
  claimant: string;
  employeeCode: string | null;
  typeCode: string;
  typeName: string;
  amount: number;
  incurredOn: string;
  bankName: string | null;
  bankAccountNo: string | null;
};

/** Approved, NON-taxable claims awaiting an off-cycle reimbursement payout (RLS-scoped to the caller). */
export async function listReimbursementsDue(ctx: SessionContext): Promise<ReimbursementRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: claimRequest.id,
        claimant: person.fullName,
        employeeCode: employment.employeeCode,
        typeCode: claimType.code,
        typeName: claimType.name,
        amount: claimRequest.amount,
        incurredOn: claimRequest.incurredOn,
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
      })
      .from(claimRequest)
      .innerJoin(claimType, eq(claimType.id, claimRequest.claimTypeId))
      .innerJoin(employment, eq(employment.id, claimRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(and(eq(claimRequest.status, 'approved'), eq(claimRequest.taxable, false)))
      .orderBy(person.fullName);
    return rows.map((r) => ({
      id: r.id,
      claimant: r.claimant,
      employeeCode: r.employeeCode,
      typeCode: r.typeCode,
      typeName: r.typeName,
      amount: Number(r.amount),
      incurredOn: r.incurredOn,
      bankName: r.bankName,
      bankAccountNo: r.bankAccountNo,
    }));
  });
}

/**
 * Bank-upload CSV for the non-taxable reimbursements due — a plain, neutral file (employee, bank,
 * account, amount), deliberately NOT a byte-exact giro/IBG format (mirrors paymentSummaryForBatch).
 * Read-only: building the file does not mark anything paid — that's an explicit `markReimbursementsPaid`.
 */
export async function reimbursementCsv(
  ctx: SessionContext,
): Promise<{ content: string; filename: string; payeeCount: number; total: number; missingBank: number }> {
  const due = await listReimbursementsDue(ctx);
  const header = ['No', 'Employee', 'Employee Code', 'Claim Type', 'Incurred On', 'Bank', 'Account No', 'Amount (RM)'];
  const body = due.map((r, i) => [
    i + 1,
    r.claimant,
    r.employeeCode ?? '',
    r.typeCode,
    r.incurredOn,
    r.bankName ?? '',
    r.bankAccountNo ?? '',
    r.amount.toFixed(2),
  ]);
  const content = toCsv([header, ...body]);
  const total = due.reduce((sum, r) => sum + Math.round(r.amount * 100), 0) / 100;
  const missingBank = due.filter((r) => !r.bankName || !r.bankAccountNo).length;
  return { content, filename: `reimbursements_${slugify(today())}.csv`, payeeCount: due.length, total, missingBank };
}

/** Mark approved non-taxable claims as reimbursed (off-cycle payout confirmed). Appends a paid event per claim. */
export async function markReimbursementsPaid(
  ctx: SessionContext,
  p: { claimIds: string[]; payoutRef?: string | null },
): Promise<{ paid: number }> {
  if (p.claimIds.length === 0) return { paid: 0 };
  return withTenant(ctx, async (tx) => {
    // RLS already scopes visibility; only flip ones that are genuinely approved + non-taxable.
    const paid = await tx
      .update(claimRequest)
      .set({ status: 'paid', paidAt: new Date(), payoutRef: p.payoutRef ?? 'reimbursement' })
      .where(
        and(
          inArray(claimRequest.id, p.claimIds),
          eq(claimRequest.status, 'approved'),
          eq(claimRequest.taxable, false),
        ),
      )
      .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId, amount: claimRequest.amount });
    for (const c of paid) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: c.id,
        eventType: 'claim-request.paid',
        actor: actorOf(ctx),
        subjectEmploymentId: c.employmentId,
        payload: { via: 'reimbursement', payoutRef: p.payoutRef ?? 'reimbursement' }, // amount on claim_request[aggregateId] (ADR-0030)
      });
    }
    return { paid: paid.length };
  });
}
