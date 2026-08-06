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
  claimFormField,
  claimItem,
  claimMileageRate,
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
  type ClaimMileageStamp,
  type ClaimRateConfig,
} from '../db/schema';

export type { ClaimMileageStamp, ClaimRateConfig };
import { toCsv } from '../lib/csv';
import { assertCanDecide, filterDelegationOrgScopeTx } from './approvals';
import { scopeOf } from '../lib/delegation-scope';
import { resolveBatchScopeFilter, resolveBatchCutOffWindow, type BatchScope } from './payroll';
import { calendarWindowFor } from './payroll-policy-config';

import { todayInKualaLumpur } from '../lib/hr-date';

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'reimbursements';

const today = (): string => todayInKualaLumpur();
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

// ───────────── Grade-first Claim Limits (e7eb5d83 — the SCREEN inversion, no schema change) ─────────────
//
// listClaimLimits above is claim-type-first: one flat row per (type, grade), which with 55 grades × 4 claim
// types is 220 rows in one nine-column table and is exactly why not one per-grade limit was ever configured
// on production (measured 2026-08-06: claim_policy rows with a non-null grade_id = ZERO). This reader turns
// the same rows the other way round — pick ONE grade, get every claim type as a row — and is presentation
// only: no column, table or resolution rule changes.
//
// THE FALLBACK IS THE POINT. A grade with no row of its own does NOT have "no limit"; the tenant-wide
// (grade_id NULL) row is what actually applies to its employees, and rendering that cell blank is how an
// admin sets the same limit twice. `source` names which row won, so the screen can say so and a test can
// assert it.

/** The limit numbers themselves, independent of which tier they came from. */
export type ClaimLimitValues = {
  perClaimCap: number | null;
  monthlyLimit: number | null;
  annualBudget: number | null;
  lifetimeLimit: number | null;
  maxClaimsPerYear: number | null;
  rateConfig: ClaimRateConfig | null;
  validFrom: string;
};

export type ClaimGradeLimitRow = {
  claimTypeId: string;
  typeCode: string;
  typeName: string;
  /** Sub-types (claim_item) of this type — the screen indents them under their parent row. */
  items: ClaimItemRow[];
  /** The row set ON the selected grade, or null when this grade has none. */
  own: ClaimLimitValues | null;
  /** The tenant-wide (grade_id NULL) row, or null when the tenant has none either. */
  fallback: ClaimLimitValues | null;
  /** What actually applies to this grade's employees: own ?? fallback. */
  effective: ClaimLimitValues | null;
  /** 'grade' = its own row · 'company' = inherited from the tenant-wide row · 'none' = unlimited. */
  source: 'grade' | 'company' | 'none';
};

const toLimitValues = (r: ClaimLimitRow): ClaimLimitValues => ({
  perClaimCap: r.perClaimCap,
  monthlyLimit: r.monthlyLimit,
  annualBudget: r.annualBudget,
  lifetimeLimit: r.lifetimeLimit,
  maxClaimsPerYear: r.maxClaimsPerYear,
  rateConfig: r.rateConfig,
  validFrom: r.validFrom,
});

/**
 * Every non-archived claim type as seen BY ONE JOB GRADE: its own limit row, the tenant-wide fallback, and
 * which of the two applies. `gradeId: null` selects the tenant-wide view (own === fallback by construction,
 * source 'company' when a row exists).
 *
 * Deliberately built on listClaimLimits + listClaimTypes rather than a third SQL query: the resolution rule
 * ("the grade's own row wins, NULL is the fallback") already exists in getActiveClaimPolicy and a second
 * hand-written copy of it is how the screen and the engine start disagreeing about what an employee is
 * entitled to. Types with NO policy row at all still appear — listClaimLimits inner-joins from claim_policy
 * and would drop them, and a claim type missing from the limits screen is unconfigurable.
 */
export async function listClaimLimitsForGrade(
  ctx: SessionContext,
  p: { gradeId: string | null; asOf?: string },
): Promise<ClaimGradeLimitRow[]> {
  const asOf = p.asOf ?? today();
  const [limits, types] = await Promise.all([listClaimLimits(ctx, { asOf }), listClaimTypes(ctx, { asOf })]);
  const byType = new Map<string, ClaimLimitRow[]>();
  for (const l of limits) {
    const arr = byType.get(l.claimTypeId);
    if (arr) arr.push(l);
    else byType.set(l.claimTypeId, [l]);
  }
  return types.map((t) => {
    const rows = byType.get(t.id) ?? [];
    const fallbackRow = rows.find((r) => r.gradeId == null) ?? null;
    const ownRow = p.gradeId == null ? fallbackRow : (rows.find((r) => r.gradeId === p.gradeId) ?? null);
    const own = ownRow ? toLimitValues(ownRow) : null;
    const fallback = fallbackRow ? toLimitValues(fallbackRow) : null;
    // Mirrors getActiveClaimPolicy's tiering exactly: grade-match wins, else the null-grade default.
    const effective = own ?? fallback;
    const source: ClaimGradeLimitRow['source'] =
      p.gradeId != null && own != null ? 'grade' : effective != null ? 'company' : 'none';
    return {
      claimTypeId: t.id,
      typeCode: t.code,
      typeName: t.name,
      items: t.items,
      own,
      fallback,
      effective,
      source,
    };
  });
}

export type ClaimBalanceRow = {
  claimTypeId: string;
  typeCode: string;
  typeName: string;
  /** null across the board ⇒ no limit configured for this employee's grade (unlimited). */
  annualLimit: number | null;
  /** Total held against the annual limit this year: pending + approved + paid (drafts hold nothing). */
  usedThisYear: number;
  /** The RESERVED slice of usedThisYear — filed but not yet decided. Included in usedThisYear, not extra. */
  reservedThisYear: number;
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

// ═══════════════ Mileage RATE TABLE (e7eb5d83) — banded · vehicle-classed · grade-scoped · dated ═══════════════
//
// The reporter's mileage question was half right, and the missing half was the important one. There WAS a
// mileage rate: one flat number per kilometre (`rateConfig = {kind:'mileage_flat', ratePerKm}`) buried in a
// claim-limit row. There was no rate TABLE — no distance bands, no vehicle types, no effective dates. You
// could not pay 0.60 for the first 500km and 0.45 after that, and you could not change a rate without
// changing what last year's claims would recompute to.
//
// Rev 3 added the second question: different job grades, different rate tables. That is the SAME shape as
// the limits, and it is resolved by the SAME rule — see resolveMileageRateBands.
//
// BACK-COMPAT IS UNCONDITIONAL. A claim type with a mileage rateConfig and no rows in claim_mileage_rate
// prices exactly as it did before, through computeClaimAmount. Nothing about the existing four claim types
// changes until someone builds a table.

/** Vehicle classes a rate table can be scoped to. 'any' is a real value and the default — one table that
 *  applies whatever the employee drove, which is what every tenant has today. */
export const MILEAGE_VEHICLE_CLASSES = ['any', 'car', 'motorcycle', 'van', 'lorry'] as const;
export type MileageVehicleClass = (typeof MILEAGE_VEHICLE_CLASSES)[number];

/** One distance band. `toKm` null = "and above" — the open top band every table must end with. */
export type MileageBand = { fromKm: number; toKm: number | null; ratePerKm: number };

/** A resolved rate table: the bands plus which tier they came from, so the stamp can record it. */
export type ResolvedMileageTable = {
  bands: MileageBand[];
  source: 'grade' | 'company';
  gradeId: string | null;
  vehicleClass: string;
  validFrom: string;
};

const bandOf = (r: typeof claimMileageRate.$inferSelect): MileageBand => ({
  fromKm: Number(r.fromKm),
  toKm: r.toKm == null ? null : Number(r.toKm),
  ratePerKm: Number(r.ratePerKm),
});

/**
 * Validate one rate table as a SET, not row by row. A band table that is not contiguous is not a slower
 * table — it is a table that prices some distances at zero and nobody notices until a payout is short.
 *
 * The rules: starts at 0 · strictly ascending · each band's fromKm is the previous band's toKm (no gap, no
 * overlap) · exactly one open band, and it is the last · every rate ≥ 0.
 */
export function assertValidMileageBands(bands: MileageBand[]): void {
  if (bands.length === 0) throw new ClaimError('A mileage rate table needs at least one distance band');
  const sorted = [...bands].sort((a, b) => a.fromKm - b.fromKm);
  if (sorted[0].fromKm !== 0) throw new ClaimError('The first mileage band must start at 0 km');
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    if (!Number.isFinite(b.ratePerKm) || b.ratePerKm < 0) throw new ClaimError('Rate per km must be a number ≥ 0');
    if (!Number.isFinite(b.fromKm) || b.fromKm < 0) throw new ClaimError('Band start must be a number ≥ 0');
    const last = i === sorted.length - 1;
    if (last) {
      if (b.toKm != null) throw new ClaimError('The last mileage band must be open-ended ("and above") — leave its upper limit blank');
    } else {
      if (b.toKm == null) throw new ClaimError('Only the LAST mileage band may be open-ended ("and above")');
      if (!(b.toKm > b.fromKm)) throw new ClaimError('Each mileage band must end above where it starts');
      if (sorted[i + 1].fromKm !== b.toKm) {
        throw new ClaimError(
          `Mileage bands must be continuous: the band after ${b.toKm} km must start at ${b.toKm} km ` +
            `(it starts at ${sorted[i + 1].fromKm} km), or distances in the gap would be priced at nothing.`,
        );
      }
    }
  }
}

/**
 * Price a distance against a band table — pure, so it is unit-testable without a database.
 *
 * MARGINAL, not flat-on-total: 700 km against [0–500 @ 0.60, 500+ @ 0.45] is 500×0.60 + 200×0.45, not
 * 700×0.45. That is what "0.60 for the first 500km and 0.45 after that" means in the plan, and the
 * breakdown is returned so the stamp can show the arithmetic rather than assert a total.
 */
export function priceMileage(bands: MileageBand[], km: number): { amount: number; breakdown: ClaimMileageStamp['bands'] } {
  if (!(km > 0)) throw new ClaimError('Distance (km) must be greater than zero');
  const sorted = [...bands].sort((a, b) => a.fromKm - b.fromKm);
  const breakdown: ClaimMileageStamp['bands'] = [];
  let amount = 0;
  for (const b of sorted) {
    const top = b.toKm ?? Infinity;
    if (km <= b.fromKm) break;
    const charged = Math.min(km, top) - b.fromKm;
    if (charged <= 0) continue;
    const line = charged * b.ratePerKm;
    amount += line;
    breakdown.push({ fromKm: b.fromKm, toKm: b.toKm, ratePerKm: b.ratePerKm, km: charged, amount: Number(line.toFixed(2)) });
  }
  return { amount: Number(amount.toFixed(2)), breakdown };
}

/**
 * The active mileage rate table for (claim type, grade, vehicle class) at `asOf`, or null when none exists.
 *
 * ⚠️ THIS DELIBERATELY MIRRORS getActiveClaimPolicy INSTEAD OF INVENTING A SECOND RULE. Same ordering
 * (latest valid_from first among rows whose half-open validity contains asOf), same tiering (a row set
 * carrying the employee's grade wins; grade_id NULL is the company-wide fallback). Two independent
 * "grade then fallback" resolutions will diverge, and the one that diverges silently is the one that pays
 * money — the build notes call this out by name.
 *
 * Vehicle class falls back the same way: an exact-class table wins over the 'any' table.
 */
export async function resolveMileageRateBands(
  tx: Tx,
  claimTypeId: string,
  asOf: string,
  gradeId: string | null = null,
  vehicleClass = 'any',
): Promise<ResolvedMileageTable | null> {
  const rows = await tx
    .select()
    .from(claimMileageRate)
    .where(
      and(
        eq(claimMileageRate.claimTypeId, claimTypeId),
        lte(claimMileageRate.validFrom, asOf),
        or(isNull(claimMileageRate.validTo), sql`${claimMileageRate.validTo} > ${asOf}`),
      ),
    )
    .orderBy(desc(claimMileageRate.validFrom));
  if (rows.length === 0) return null;
  // Candidate tiers in priority order: (grade, exact class) → (grade, any) → (null, exact class) → (null, any).
  const tiers: { gradeId: string | null; vehicleClass: string; source: 'grade' | 'company' }[] = [];
  if (gradeId) {
    if (vehicleClass !== 'any') tiers.push({ gradeId, vehicleClass, source: 'grade' });
    tiers.push({ gradeId, vehicleClass: 'any', source: 'grade' });
  }
  if (vehicleClass !== 'any') tiers.push({ gradeId: null, vehicleClass, source: 'company' });
  tiers.push({ gradeId: null, vehicleClass: 'any', source: 'company' });

  for (const tier of tiers) {
    const inTier = rows.filter(
      (r) => (r.gradeId ?? null) === tier.gradeId && r.vehicleClass === tier.vehicleClass,
    );
    if (inTier.length === 0) continue;
    // rows are latest-validFrom-first, so inTier[0].validFrom identifies the ACTIVE version of this table;
    // the table itself is every row of that tier sharing that validFrom (one row per band).
    const validFrom = inTier[0].validFrom;
    const bands = inTier.filter((r) => r.validFrom === validFrom).map(bandOf).sort((a, b) => a.fromKm - b.fromKm);
    return { bands, source: tier.source, gradeId: tier.gradeId, vehicleClass: tier.vehicleClass, validFrom };
  }
  return null;
}

export type MileageRateTableRow = {
  claimTypeId: string;
  gradeId: string | null;
  vehicleClass: string;
  validFrom: string;
  validTo: string | null;
  bands: MileageBand[];
};

/**
 * Every ACTIVE rate table for a claim type as seen by ONE grade — the admin Mileage Rates screen. Returns
 * the grade's own tables when it has them and the company-wide ones when it does not, with `inherited`
 * saying which, for the same reason the limits screen does: a blank is how an admin sets a rate twice.
 */
export async function listMileageRateTables(
  ctx: SessionContext,
  p: { claimTypeId: string; gradeId: string | null; asOf?: string },
): Promise<{ tables: (MileageRateTableRow & { inherited: boolean })[] }> {
  const asOf = p.asOf ?? today();
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(claimMileageRate)
      .where(
        and(
          eq(claimMileageRate.claimTypeId, p.claimTypeId),
          lte(claimMileageRate.validFrom, asOf),
          or(isNull(claimMileageRate.validTo), sql`${claimMileageRate.validTo} > ${asOf}`),
        ),
      )
      .orderBy(desc(claimMileageRate.validFrom));
    // Group into tables: (gradeId, vehicleClass, validFrom). Keep only the latest validFrom per tier.
    const byTier = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.gradeId ?? ''}|${r.vehicleClass}`;
      const arr = byTier.get(key);
      if (arr) arr.push(r);
      else byTier.set(key, [r]);
    }
    const out: (MileageRateTableRow & { inherited: boolean })[] = [];
    for (const [, tierRows] of byTier) {
      const validFrom = tierRows[0].validFrom;
      const g = tierRows[0].gradeId ?? null;
      // Only the selected grade's own tables and the company-wide ones are relevant to this view.
      if (g !== p.gradeId && g !== null) continue;
      out.push({
        claimTypeId: p.claimTypeId,
        gradeId: g,
        vehicleClass: tierRows[0].vehicleClass,
        validFrom,
        validTo: tierRows[0].validTo ?? null,
        bands: tierRows.filter((r) => r.validFrom === validFrom).map(bandOf).sort((a, b) => a.fromKm - b.fromKm),
        inherited: p.gradeId != null && g == null,
      });
    }
    // A grade's own table for a class HIDES the company-wide one for that class — showing both would leave
    // the admin reading a row that does not apply to anybody.
    const ownClasses = new Set(out.filter((t) => !t.inherited && t.gradeId != null).map((t) => t.vehicleClass));
    const visible = p.gradeId == null ? out : out.filter((t) => !(t.inherited && ownClasses.has(t.vehicleClass)));
    visible.sort((a, b) => a.vehicleClass.localeCompare(b.vehicleClass));
    return { tables: visible };
  });
}

/**
 * Set (or replace) ONE rate table, effective-dated. Append-only CLOSE+INSERT on the whole SET — the same
 * versioning setClaimPolicy uses, for the same reason: an in-place UPDATE would silently re-price the
 * history, and a rate table with no history cannot answer "what did we pay in March".
 *
 * Passing an empty `bands` array CLOSES the table without opening a new one (the tier reverts to whatever
 * it falls back to) — that is how a grade-specific override is removed.
 */
export async function setMileageRateTable(
  ctx: SessionContext,
  p: {
    claimTypeId: string;
    gradeId?: string | null;
    vehicleClass?: string;
    effectiveFrom: string;
    bands: MileageBand[];
  },
): Promise<{ bands: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveFrom)) throw new ClaimError('effectiveFrom must be YYYY-MM-DD');
  const vehicleClass = p.vehicleClass ?? 'any';
  if (!(MILEAGE_VEHICLE_CLASSES as readonly string[]).includes(vehicleClass)) {
    throw new ClaimError(`Unknown vehicle class: ${vehicleClass}`);
  }
  if (p.bands.length > 0) assertValidMileageBands(p.bands);
  const gradeId = p.gradeId ?? null;
  return withTenant(ctx, async (tx) => {
    // Close the open version of THIS tier only — a null-safe grade compare so setting the Executive table
    // never closes the Manager one (setClaimPolicy's exact idiom).
    await tx
      .update(claimMileageRate)
      .set({ validTo: p.effectiveFrom })
      .where(
        and(
          eq(claimMileageRate.claimTypeId, p.claimTypeId),
          eq(claimMileageRate.vehicleClass, vehicleClass),
          isNull(claimMileageRate.validTo),
          gradeId == null ? isNull(claimMileageRate.gradeId) : eq(claimMileageRate.gradeId, gradeId),
        ),
      );
    const sorted = [...p.bands].sort((a, b) => a.fromKm - b.fromKm);
    if (sorted.length > 0) {
      await tx.insert(claimMileageRate).values(
        sorted.map((b) => ({
          tenantId: ctx.tenantId,
          claimTypeId: p.claimTypeId,
          gradeId,
          vehicleClass,
          fromKm: b.fromKm.toFixed(2),
          toKm: b.toKm == null ? null : b.toKm.toFixed(2),
          ratePerKm: b.ratePerKm.toFixed(4),
          validFrom: p.effectiveFrom,
        })),
      );
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-mileage-rate',
      aggregateId: p.claimTypeId,
      eventType: 'claim-mileage-rate.set',
      actor: actorOf(ctx),
      // Rates are CONFIG, not a claim amount — safe to log in full (ADR-0030, same call setClaimPolicy makes).
      payload: { claimTypeId: p.claimTypeId, gradeId, vehicleClass, effectiveFrom: p.effectiveFrom, bands: sorted },
    });
    return { bands: sorted.length };
  });
}

// ═══════════════════ Claim FORM DESIGNER (e7eb5d83) — per-claim-type custom fields ═══════════════════
//
// The one genuinely absent feature of the three the reporter raised: every claim type asked the same four
// things — amount, date, receipt, description — and there was nothing anywhere that could say otherwise.
// A grep for a dynamic-field table before building this returned nothing; it did not exist.

/** Field kinds the designer offers. Pinned to the DB by nothing (the column is free text, deliberately —
 *  see the migration header); pinned to reality by test/claims-form-designer.test.ts. */
export const CLAIM_FIELD_KINDS = ['text', 'number', 'money', 'date', 'select', 'boolean'] as const;
export type ClaimFieldKind = (typeof CLAIM_FIELD_KINDS)[number];

/**
 * ⚠️ THE FOUR BUILT-INS. These are NOT rows in claim_form_field and must never become rows.
 *
 * amount, incurred_on, description and the receipt attachment are real columns on claim_request with real
 * behaviour hanging off them: per-claim cap / monthly / annual / lifetime arithmetic, the receipt-age
 * window, taxable routing into payroll. Modelling them as configurable fields would put the limit engine
 * behind a jsonb blob and let an admin delete the column the money is computed from.
 *
 * The designer renders them as fixed, undeletable rows ABOVE the custom list. This constant is what makes
 * that true in the SERVICE and not merely in the UI: createClaimFormField refuses these keys outright, so a
 * forged POST that skips the screen cannot smuggle one in either — which is precisely what the plan's test
 * list asks to be proven ("the four built-ins cannot be deleted through any path including a forged POST").
 */
export const BUILT_IN_FIELD_KEYS = ['amount', 'incurredOn', 'incurred_on', 'description', 'receipt', 'attachment'] as const;

export type ClaimFormFieldRowOut = {
  id: string;
  claimTypeId: string;
  fieldKey: string;
  label: string;
  kind: ClaimFieldKind;
  required: boolean;
  options: string[];
  sortOrder: number;
};

const toFieldRow = (r: typeof claimFormField.$inferSelect): ClaimFormFieldRowOut => ({
  id: r.id,
  claimTypeId: r.claimTypeId,
  fieldKey: r.fieldKey,
  label: r.label,
  kind: r.kind as ClaimFieldKind,
  required: r.required,
  options: Array.isArray(r.options) ? (r.options as string[]) : [],
  sortOrder: r.sortOrder,
});

/** Live custom fields for a claim type, in designer order, in the caller tx. */
async function activeFormFieldsFor(tx: Tx, claimTypeId: string): Promise<ClaimFormFieldRowOut[]> {
  const rows = await tx
    .select()
    .from(claimFormField)
    .where(and(eq(claimFormField.claimTypeId, claimTypeId), isNull(claimFormField.archivedAt)))
    .orderBy(claimFormField.sortOrder, claimFormField.createdAt);
  return rows.map(toFieldRow);
}

/** The admin designer read: the live custom fields for one claim type. */
export async function listClaimFormFields(ctx: SessionContext, p: { claimTypeId: string }): Promise<ClaimFormFieldRowOut[]> {
  return withTenant(ctx, (tx) => activeFormFieldsFor(tx, p.claimTypeId));
}

const slugKey = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * BUILT_IN_FIELD_KEYS, put through slugKey — the set the guard actually compares against.
 *
 * ⚠️ THIS INDIRECTION IS NOT DECORATION; a straight `.includes()` on the raw list is a HOLE, and the test
 * for the forged POST is what found it. Every key an admin (or an attacker) supplies is slugified before
 * it is stored, so `incurredOn` becomes `incurredon` — which is not a member of the raw list, so it sailed
 * past the check and created a custom field shadowing a built-in. Normalising BOTH sides is what makes the
 * guard hold for every spelling of the same key, and it means a future built-in added to the list in
 * camelCase is protected without anyone having to remember this.
 */
const BUILT_IN_SLUGS: ReadonlySet<string> = new Set(BUILT_IN_FIELD_KEYS.map((k) => slugKey(k)));

/**
 * Validate a claim's custom-field answers against the type's LIVE form, returning the coerced values to
 * store (or null when the type has no custom fields — which is every claim type on production today, and
 * why nothing an employee sees changes until an admin designs a form).
 *
 * Pure so it is unit-testable without a database, and used by BOTH submit paths (fresh and draft) so
 * "required" cannot come to mean two different things.
 *
 * UNKNOWN KEYS ARE DROPPED, NOT REJECTED. A field archived between a draft being saved and submitted would
 * otherwise make the draft permanently unsubmittable, and the answer is genuinely no longer part of the
 * form. The archived row keeps whatever was already stored on historical claims.
 */
export function validateClaimFieldValues(
  fields: ClaimFormFieldRowOut[],
  values: Record<string, string | number | boolean | null> | null | undefined,
): Record<string, string | number | boolean | null> | null {
  if (fields.length === 0) return null;
  const given = values ?? {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const f of fields) {
    const raw = Object.prototype.hasOwnProperty.call(given, f.fieldKey) ? given[f.fieldKey] : null;
    const blank = raw == null || (typeof raw === 'string' && raw.trim() === '');
    if (blank) {
      // A boolean's "false" is an ANSWER, not a blank — an unticked checkbox posts nothing, so a required
      // yes/no field is satisfied by its own absence and must not be treated as unanswered.
      if (f.required && f.kind !== 'boolean') throw new ClaimError(`"${f.label}" is required`);
      out[f.fieldKey] = f.kind === 'boolean' ? false : null;
      continue;
    }
    switch (f.kind) {
      case 'number':
      case 'money': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
        if (!Number.isFinite(n)) throw new ClaimError(`"${f.label}" must be a number`);
        if (f.kind === 'money' && n < 0) throw new ClaimError(`"${f.label}" must be 0 or more`);
        out[f.fieldKey] = n;
        break;
      }
      case 'date': {
        const s = String(raw).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ClaimError(`"${f.label}" must be a date (YYYY-MM-DD)`);
        out[f.fieldKey] = s;
        break;
      }
      case 'boolean':
        out[f.fieldKey] = raw === true || raw === 'true' || raw === 'on' || raw === 1 || raw === '1';
        break;
      case 'select': {
        const s = String(raw).trim();
        // The option list is the whole point of a dropdown; accepting a value outside it would let a forged
        // POST write anything into the field and make the configured choices decorative.
        if (!f.options.includes(s)) throw new ClaimError(`"${s}" is not one of the choices for "${f.label}"`);
        out[f.fieldKey] = s;
        break;
      }
      default:
        out[f.fieldKey] = String(raw);
    }
  }
  return out;
}

/** Add a custom field to a claim type's form. */
export async function createClaimFormField(
  ctx: SessionContext,
  p: { claimTypeId: string; label: string; kind: string; required?: boolean; options?: string[]; fieldKey?: string },
): Promise<{ id: string }> {
  const label = p.label.trim();
  if (!label) throw new ClaimError('A field needs a label');
  if (!(CLAIM_FIELD_KINDS as readonly string[]).includes(p.kind)) throw new ClaimError(`Unknown field type: ${p.kind}`);
  const fieldKey = slugKey(p.fieldKey ?? label);
  if (!fieldKey) throw new ClaimError('A field needs a label with at least one letter or digit');
  // THE BUILT-IN GUARD, in the service — not in the screen. A forged POST reaches here too.
  if (BUILT_IN_SLUGS.has(fieldKey)) {
    throw new ClaimError(
      `"${label}" collides with a built-in claim field. Amount, date, description and receipt are always on ` +
        `every claim form and are not configurable — choose a different label.`,
    );
  }
  const options = (p.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0);
  if (p.kind === 'select' && options.length === 0) throw new ClaimError('A dropdown field needs at least one choice');
  return withTenant(ctx, async (tx) => {
    const [ct] = await tx.select({ id: claimType.id }).from(claimType).where(and(eq(claimType.id, p.claimTypeId), isNull(claimType.archivedAt))).limit(1);
    if (!ct) throw new ClaimError('Unknown or archived claim type');
    const existing = await activeFormFieldsFor(tx, p.claimTypeId);
    if (existing.some((f) => f.fieldKey === fieldKey)) throw new ClaimError(`This claim form already has a field called "${label}"`);
    const [row] = await tx
      .insert(claimFormField)
      .values({
        tenantId: ctx.tenantId,
        claimTypeId: p.claimTypeId,
        fieldKey,
        label,
        kind: p.kind,
        required: p.required ?? false,
        options,
        sortOrder: existing.length === 0 ? 0 : Math.max(...existing.map((f) => f.sortOrder)) + 1,
      })
      .returning({ id: claimFormField.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-form-field',
      aggregateId: row.id,
      eventType: 'claim-form-field.created',
      actor: actorOf(ctx),
      payload: { claimTypeId: p.claimTypeId, fieldKey, label, kind: p.kind, required: p.required ?? false, options },
    });
    return { id: row.id };
  });
}

/** Rename / retype / re-require a custom field. `fieldKey` is deliberately NOT editable — renaming it would
 *  orphan every answer already stored under it on historical claims. */
export async function updateClaimFormField(
  ctx: SessionContext,
  p: { id: string; label: string; kind: string; required: boolean; options?: string[] },
): Promise<void> {
  const label = p.label.trim();
  if (!label) throw new ClaimError('A field needs a label');
  if (!(CLAIM_FIELD_KINDS as readonly string[]).includes(p.kind)) throw new ClaimError(`Unknown field type: ${p.kind}`);
  const options = (p.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0);
  if (p.kind === 'select' && options.length === 0) throw new ClaimError('A dropdown field needs at least one choice');
  await withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(claimFormField).where(eq(claimFormField.id, p.id)).limit(1);
    if (!row || row.archivedAt) throw new ClaimError('That claim form field no longer exists');
    await tx.update(claimFormField).set({ label, kind: p.kind, required: p.required, options }).where(eq(claimFormField.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-form-field',
      aggregateId: p.id,
      eventType: 'claim-form-field.updated',
      actor: actorOf(ctx),
      payload: { claimTypeId: row.claimTypeId, fieldKey: row.fieldKey, label, kind: p.kind, required: p.required, options },
    });
  });
}

/** Remove a field from the form. ARCHIVE, never DELETE: the answers already stored against it on filed
 *  claims must survive, and a claim whose stored values reference a vanished field is unreadable. */
export async function archiveClaimFormField(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(claimFormField).where(eq(claimFormField.id, id)).limit(1);
    if (!row || row.archivedAt) throw new ClaimError('That claim form field no longer exists');
    await tx.update(claimFormField).set({ archivedAt: new Date() }).where(eq(claimFormField.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-form-field',
      aggregateId: id,
      eventType: 'claim-form-field.archived',
      actor: actorOf(ctx),
      payload: { claimTypeId: row.claimTypeId, fieldKey: row.fieldKey },
    });
  });
}

/** Move a field one place up or down the form. Renumbers the whole live list so a sort_order collision
 *  (two fields at 3) cannot make the order depend on insertion time. */
export async function moveClaimFormField(ctx: SessionContext, p: { id: string; direction: 'up' | 'down' }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(claimFormField).where(eq(claimFormField.id, p.id)).limit(1);
    if (!row || row.archivedAt) throw new ClaimError('That claim form field no longer exists');
    const fields = await activeFormFieldsFor(tx, row.claimTypeId);
    const i = fields.findIndex((f) => f.id === p.id);
    const j = p.direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= fields.length) return; // already at the end — a no-op, not an error
    [fields[i], fields[j]] = [fields[j], fields[i]];
    for (let k = 0; k < fields.length; k++) {
      await tx.update(claimFormField).set({ sortOrder: k }).where(eq(claimFormField.id, fields[k].id));
    }
  });
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
  /** e7eb5d83 — the custom fields designed for this claim type, in form order. EMPTY for every claim type
   *  until an admin designs one, which is what makes the feature invisible to employees until configured. */
  formFields: ClaimFormFieldRowOut[];
  balance: ClaimBalanceRow;
};

/**
 * Everything the employee claim form needs, resolved for THIS employee's job grade (ccbd0508): per claim
 * type — its grade-resolved rate config + receipt window + dependent items + the live balance panel data
 * (annual/monthly limits, used, remaining). One read so a graded employee never sees another grade's rate.
 */
export async function getEmployeeClaimTypes(ctx: SessionContext, employmentId: string): Promise<EmployeeClaimType[]> {
  const asOf = today();
  // The SAME set the submit check enforces against — the balance panel must show the employee the number
  // the server will actually use, pending reservations included, or the screen and the refusal disagree.
  const usedStatuses: ClaimStatus[] = [...RESERVING_STATUSES];
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
        // How much of usedThisYear is RESERVED rather than settled — i.e. filed and awaiting a decision.
        // Broken out so the employee can see why their remaining balance is lower than their approved
        // spend: a reservation the screen never mentions reads as the system losing money.
        const reservedThisYear = await claimedInScope(tx, employmentId, t.id, 'year', asOf, ['pending']);
        const usedLifetime = policy?.lifetimeLimit != null ? await claimedInScope(tx, employmentId, t.id, 'lifetime', asOf, usedStatuses) : 0;
        const claimsUsedThisYear = await claimCountInScope(tx, employmentId, t.id, 'year', asOf, usedStatuses);
        const balance: ClaimBalanceRow = {
          claimTypeId: t.id,
          typeCode: t.code,
          typeName: t.name,
          annualLimit: policy?.annualBudget ?? null,
          usedThisYear,
          reservedThisYear,
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
          formFields: await activeFormFieldsFor(tx, t.id),
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

// ─────────────────── Claim status: the ONE place the enum is classified (e7eb5d83) ───────────────────
//
// Every value of claim_status, and the single decision about which of them CONSUME LIMIT. A new status
// added to the enum without being classified here is a claim that some reader silently cannot see — the
// exact failure mode a new enum value invites. test/claims-draft-reservation.test.ts reads pg_enum and
// fails if this list, db/schema.ts's pgEnum, the classification below, the i18n `claims.status_*` keys or
// the /claims badge styles disagree, so the omission cannot ship quietly.

/** Every claim_status label, in lifecycle order. Mirrors db/schema.ts claimStatusEnum exactly. */
export const CLAIM_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'cancelled', 'paid'] as const;
export type ClaimRequestStatus = (typeof CLAIM_STATUSES)[number];

/**
 * THE RESERVATION. Statuses whose amounts are held against the employee's limit.
 *
 * This is a DERIVED reservation, not a stored counter, and that is the whole design. Submitting moves a
 * claim INTO this set (limit consumed); rejecting, cancelling — or never submitting at all — leaves it
 * OUT (limit released). There is no reserved-amount column to decrement, so a release cannot happen twice:
 * a double-release would require the same row to leave the set twice, which the status column forbids and
 * `SELECT … FOR UPDATE` in decideClaim/cancelClaim makes impossible even under concurrency. A stored
 * counter would have been the obvious build and is strictly worse — silently freeing limit that is still
 * consumed is a wrong answer nobody can see, whereas a derived sum is always exactly the rows that exist.
 *
 * 'draft' is deliberately absent: a saved-for-later claim holds nothing.
 */
export const RESERVING_STATUSES = ['pending', 'approved', 'paid'] as const;
/** Already-decided consumption — what an APPROVAL is re-checked against (the claim under decision excluded). */
export const SETTLED_STATUSES = ['approved', 'paid'] as const;
/** Holds nothing: never filed, or filed and released. Complement of RESERVING_STATUSES over CLAIM_STATUSES. */
export const NON_RESERVING_STATUSES = ['draft', 'rejected', 'cancelled'] as const;

type ClaimStatus = (typeof RESERVING_STATUSES)[number];

/**
 * The advisory-lock key that serializes every limit decision for one (tenant × employee × claim type).
 *
 * WHY A LOCK AT ALL — this is the defect the item is really about. The limit checks are read-then-write:
 * sum the reserved rows, compare, insert or update. Two transactions doing that at the same instant each
 * read a sum that does not include the other's uncommitted row, both pass, and both commit — so the total
 * lands over the configured limit with no error anywhere. It is invisible precisely because every
 * individual check was correct. Serializing the pair closes it; nothing else does, short of SERIALIZABLE
 * isolation for the whole application.
 *
 * WHY pg_advisory_xact_lock SPECIFICALLY:
 *   • It is released by COMMIT **or ROLLBACK**, by Postgres, with no unlock call in this file. A lock this
 *     code had to release by hand is a lock some future early-return leaks, and a leaked lock on the money
 *     path wedges every claim for that employee.
 *   • It is scoped to the pair that actually contends. Locking the claim_policy row would serialize every
 *     employee on that type against each other; locking nothing at all is today's bug.
 *   • It needs no schema, so it cannot drift from the rows it protects.
 * hashtextextended gives a stable bigint from the key text (collisions merely over-serialize; they cannot
 * corrupt, because the check that follows re-reads the real rows).
 *
 * Exported so tests can hold the SAME key from an independent session and prove the block is real rather
 * than inferring it from a race that happened to come out right.
 */
export function claimLimitLockKey(tenantId: string, employmentId: string, claimTypeId: string): string {
  return `claim-limit:${tenantId}:${employmentId}:${claimTypeId}`;
}

/** Take the (employee × type) limit lock for the rest of THIS transaction. Ordering: callers that also
 *  lock a claim ROW must take this first, then the row — never the other way round, or two decisions on
 *  different claims of the same pair can deadlock. */
async function lockClaimLimit(tx: Tx, tenantId: string, employmentId: string, claimTypeId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${claimLimitLockKey(tenantId, employmentId, claimTypeId)}, 0))`);
}

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
  /** e7eb5d83 — which vehicle the distance was driven in, when the rate table is class-scoped. */
  vehicleClass?: string | null;
  incurredOn: string;
  description?: string | null;
  hasReceipt?: boolean;
  /** e7eb5d83 — answers to the claim type's CUSTOM fields, keyed by field_key. Never the four built-ins. */
  fieldValues?: Record<string, string | number | boolean | null> | null;
};

/** What validation+pricing decides for a claim about to enter the reserved set. */
type PricedClaim = {
  amount: number;
  quantityKm: number | null;
  claimItemId: string | null;
  taxable: boolean;
  /** The rate table this claim was priced under, to be STAMPED on the row. null = not banded-mileage. */
  mileageStamp: ClaimMileageStamp | null;
  /** Custom-field answers, validated + coerced against the claim type's live form. */
  fieldValues: Record<string, string | number | boolean | null> | null;
};

/**
 * Validate, price and RESERVE-CHECK one claim, inside the caller's transaction.
 *
 * Extracted from insertClaimTx (e7eb5d83) because a draft being submitted has to run the identical
 * gauntlet a fresh submit does — same item rule, same receipt window, same authoritative pricing, same
 * limits — and two copies of a limit check is how one of them ends up a version behind the other.
 *
 * It does NOT write. The caller performs the state change (INSERT for a new claim, UPDATE draft→pending
 * for a draft) in the SAME transaction, so the lock taken here is still held when the reservation is
 * actually taken. That co-location is the correctness property: the check and the write it authorises
 * cannot be separated by another transaction's commit.
 *
 * `excludeId` keeps a row from counting itself. A draft is not in RESERVING_STATUSES so it never would —
 * it is passed anyway, because "the row being priced is never part of the sum it is compared against" is a
 * property worth holding unconditionally rather than one that depends on today's classification.
 */
async function priceAndCheckClaimTx(
  tx: Tx,
  ctx: SessionContext,
  p: SubmitClaimInput & { excludeId?: string },
): Promise<PricedClaim> {
  // 1. THE LIMIT LOCK, before the first limit read and before any other lock. Everything from here to this
  //    transaction's COMMIT is serialized against every other submit/approve for this (employee × type),
  //    which is what makes the sums below a reservation rather than a guess.
  await lockClaimLimit(tx, ctx.tenantId, p.employmentId, p.claimTypeId);

  // 2. Load the type + the claimant's grade + the grade-resolved active policy (also carries rateConfig).
  const [ct] = await tx.select().from(claimType).where(and(eq(claimType.id, p.claimTypeId), isNull(claimType.archivedAt))).limit(1);
  if (!ct) throw new ClaimError('Unknown or archived claim type');
  const [emp] = await tx.select({ gradeId: employment.gradeId }).from(employment).where(eq(employment.id, p.employmentId)).limit(1);
  const gradeId = emp?.gradeId ?? null;
  const policy = await getActiveClaimPolicy(tx, p.claimTypeId, p.incurredOn, gradeId);
  const committed: ClaimStatus[] = [...RESERVING_STATUSES];
  const excludeId = p.excludeId;

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
  //
  // e7eb5d83 — MILEAGE NOW PREFERS THE BANDED RATE TABLE, and falls back to the legacy flat ratePerKm when
  // the tenant has not built one. Resolution is grade-scoped through resolveMileageRateBands, which reuses
  // getActiveClaimPolicy's tiering rather than inventing a second one.
  //
  // ⚠️ RESOLVED AT SUBMIT AND STAMPED ON THE ROW (step 7 below writes it). The amount was always stored, so
  // nothing recomputes; the stamp is what makes the stored figure EXPLAINABLE after the table is edited. A
  // later rate-table change closes the old version and opens a new one — it never touches this claim.
  const isMileage = policy?.rateConfig?.kind === 'mileage_flat';
  const quantityKm = isMileage ? (p.quantityKm ?? null) : null;
  const vehicleClass = p.vehicleClass ?? 'any';
  let mileageStamp: ClaimMileageStamp | null = null;
  let amount: number;
  if (isMileage) {
    const table = await resolveMileageRateBands(tx, p.claimTypeId, p.incurredOn, gradeId, vehicleClass);
    if (table) {
      const km = p.quantityKm;
      if (km == null || !(km > 0)) throw new ClaimError('Distance (km) must be greater than zero');
      const priced = priceMileage(table.bands, km);
      amount = priced.amount;
      mileageStamp = {
        vehicleClass: table.vehicleClass,
        source: table.source,
        gradeId: table.gradeId,
        tableValidFrom: table.validFrom,
        bands: priced.breakdown,
      };
    } else {
      amount = computeClaimAmount(policy?.rateConfig, { quantityKm: p.quantityKm, enteredAmount: p.amount });
    }
  } else {
    amount = computeClaimAmount(policy?.rateConfig, { quantityKm: p.quantityKm, enteredAmount: p.amount });
  }
  if (!(amount > 0)) throw new ClaimError('Amount must be greater than zero');
  if (policy?.perClaimCap != null && amount > policy.perClaimCap) {
    throw new ClaimError(
      `This claim's amount (${rmMsg(amount)}) exceeds the per-claim cap for this claim type ` +
        `(${rmMsg(policy.perClaimCap)}). Reduce the amount, split it across multiple claims if appropriate, ` +
        `or ask an admin to review the cap.`,
    );
  }
  if (policy?.annualBudget != null) {
    const used = await claimedInScope(tx, p.employmentId, p.claimTypeId, 'year', p.incurredOn, committed, excludeId);
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
    const used = await claimedInScope(tx, p.employmentId, p.claimTypeId, 'month', p.incurredOn, committed, excludeId);
    if (used + amount > policy.monthlyLimit) {
      const remaining = Math.max(0, policy.monthlyLimit - used);
      throw new ClaimError(
        `This claim (${rmMsg(amount)}) would exceed the monthly limit of ${rmMsg(policy.monthlyLimit)} for this ` +
          `claim type. You have ${rmMsg(remaining)} remaining this month for this claim type.`,
      );
    }
  }
  if (policy?.lifetimeLimit != null) {
    const used = await claimedInScope(tx, p.employmentId, p.claimTypeId, 'lifetime', p.incurredOn, committed, excludeId);
    if (used + amount > policy.lifetimeLimit) {
      const remaining = Math.max(0, policy.lifetimeLimit - used);
      throw new ClaimError(
        `This claim (${rmMsg(amount)}) would exceed the lifetime limit of ${rmMsg(policy.lifetimeLimit)} for this ` +
          `claim type. You have ${rmMsg(remaining)} remaining for this claim type.`,
      );
    }
  }
  if (policy?.maxClaimsPerYear != null) {
    const count = await claimCountInScope(tx, p.employmentId, p.claimTypeId, 'year', p.incurredOn, committed, excludeId);
    if (count + 1 > policy.maxClaimsPerYear) {
      throw new ClaimError(
        `You have reached the maximum of ${policy.maxClaimsPerYear} claim(s) allowed this year for this claim type.`,
      );
    }
  }

  // 6. Receipt-required check (type-level, unchanged).
  if (ct.requiresReceipt && !p.hasReceipt) throw new ClaimError('A receipt is required for this claim type');

  // 7. e7eb5d83 — the claim type's CUSTOM fields. Runs here, inside the same gauntlet a draft being
  //    submitted goes through, so "required" means the same thing on both paths. A type with no designed
  //    fields returns null and nothing about the claim changes — which is the plan's promise that nothing
  //    an employee sees changes until the form is configured.
  const fields = await activeFormFieldsFor(tx, p.claimTypeId);
  const fieldValues = validateClaimFieldValues(fields, p.fieldValues ?? null);

  return { amount, quantityKm, claimItemId, taxable: ct.defaultTaxable, mileageStamp, fieldValues };
}

/** The submit body, running INSIDE a caller-provided tx so it can be composed atomically with a receipt
 *  write (see submitClaimWithAttachment). The date-format guard runs before the tx opens in the public
 *  wrappers; everything that touches the DB lives here so a downstream failure rolls the claim back too. */
async function insertClaimTx(tx: Tx, ctx: SessionContext, p: SubmitClaimInput): Promise<{ id: string }> {
  const { amount, quantityKm, claimItemId, taxable, mileageStamp, fieldValues } = await priceAndCheckClaimTx(tx, ctx, p);

  // Insert with the dependent item, mileage km, and computed amount — still inside the limit lock taken by
  // priceAndCheckClaimTx, so the row joins the reserved set before any other transaction can read the sum.
  const [row] = await tx
    .insert(claimRequest)
    .values({
      tenantId: ctx.tenantId,
      employmentId: p.employmentId,
      claimTypeId: p.claimTypeId,
      claimItemId,
      amount: amount.toFixed(2),
      quantityKm: quantityKm == null ? null : quantityKm.toFixed(2),
      // e7eb5d83 — the rate table this claim was priced under, written in the SAME insert as the amount it
      // produced. Written together or not at all: a stamp that can lag the amount is worse than no stamp.
      mileageRateApplied: mileageStamp,
      fieldValues,
      incurredOn: p.incurredOn,
      description: p.description ?? null,
      taxable,
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
    payload: { claimTypeId: p.claimTypeId, claimItemId, incurredOn: p.incurredOn, taxable },
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

/**
 * Approve or reject a pending claim. assertCanDecide bans self-approval + requires admin/active manager.
 * On approve, the decider may confirm/override `taxable`, and the annual budget is re-checked.
 *
 * TWO LOCKS, IN THIS ORDER, AND THE ORDER IS NOT ARBITRARY (e7eb5d83):
 *
 *   1. the (employee × type) advisory lock — so the re-check below and the UPDATE that acts on it cannot
 *      be interleaved with another decision on a DIFFERENT claim of the same pair. Without it, two
 *      approvers clicking at the same instant each read a settled total that excludes the other's
 *      uncommitted approval, both pass, and the employee ends up approved past their limit with no error
 *      raised anywhere. That is the wrong answer this item exists to remove.
 *   2. SELECT … FOR UPDATE on the claim row itself — so the SAME claim cannot be decided twice. The status
 *      read used to be an unlocked SELECT, which meant a concurrent approve+cancel (or two approves) could
 *      both see 'pending', both write, and both append a decision event to a claim that only moved once.
 *      Since the reservation is derived from status, a claim released twice is precisely a limit freed
 *      twice — the failure mode a stored reserved-amount column would have made routine.
 *
 * Advisory-before-row is the fixed ordering everywhere in this file: taking the row first would let two
 * decisions on different claims of one pair hold each other's next lock and deadlock.
 */
export async function decideClaim(
  ctx: SessionContext,
  p: { claimRequestId: string; decision: 'approve' | 'reject'; taxable?: boolean; deciderEmploymentId?: string | null },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    // Unlocked peek, ONLY to learn which (employee × type) lock this claim belongs to. Nothing is decided
    // on it — the authoritative read is the FOR UPDATE one below, taken after the lock is held.
    const [head] = await tx
      .select({ employmentId: claimRequest.employmentId, claimTypeId: claimRequest.claimTypeId })
      .from(claimRequest)
      .where(eq(claimRequest.id, p.claimRequestId))
      .limit(1);
    if (!head) throw new ClaimError('Claim not found');
    await lockClaimLimit(tx, ctx.tenantId, head.employmentId, head.claimTypeId);

    const [claim] = await tx.select().from(claimRequest).where(eq(claimRequest.id, p.claimRequestId)).limit(1).for('update');
    if (!claim) throw new ClaimError('Claim not found');
    if (claim.status !== 'pending') throw new ClaimError('Only a pending claim can be decided');
    await assertCanDecide(tx, ctx, claim.employmentId, 'claim', scopeOf('claims.claim'));

    if (p.decision === 'approve') {
      const taxable = p.taxable ?? claim.taxable;
      const [emp] = await tx.select({ gradeId: employment.gradeId }).from(employment).where(eq(employment.id, claim.employmentId)).limit(1);
      const policy = await getActiveClaimPolicy(tx, claim.claimTypeId, claim.incurredOn, emp?.gradeId ?? null);
      const amount = Number(claim.amount);
      const settled: ClaimStatus[] = [...SETTLED_STATUSES];
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

/**
 * Cancel a pending claim (the claimant or an admin) — the RELEASE half of the reservation.
 *
 * There is nothing here that subtracts an amount, and that is the point: the claim leaves
 * RESERVING_STATUSES, so the next sum simply does not include it. The only way this could release twice is
 * if the status moved twice, which the row lock below forbids — the same lock decideClaim takes, so an
 * approve and a cancel racing on one claim resolve to exactly one of the two, and the loser is told the
 * claim is no longer pending instead of silently overwriting the winner.
 */
export async function cancelClaim(ctx: SessionContext, claimRequestId: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    // Row lock FIRST (no limit read here, so no advisory lock is needed — and taking one would invert the
    // advisory-before-row ordering decideClaim relies on).
    const [locked] = await tx
      .select({ id: claimRequest.id, status: claimRequest.status, employmentId: claimRequest.employmentId })
      .from(claimRequest)
      .where(eq(claimRequest.id, claimRequestId))
      .limit(1)
      .for('update');
    if (!locked) throw new ClaimError('Claim not found');
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

// ─────────────────────────── Draft claims (e7eb5d83 stage 1) ───────────────────────────
//
// A draft is a claim_request row in status 'draft'. It is NOT a separate object, and that was the design
// decision: a parallel "draft claim" table would need every column claim_request has, would drift from it,
// and would make "submit" a copy rather than a transition — losing the row's identity, its attachments and
// its history at the exact moment it starts to matter.
//
// WHAT A DRAFT IS NOT:
//   • not reserved — 'draft' is outside RESERVING_STATUSES, so a saved draft holds none of the limit;
//   • not visible to an approver — listPendingClaims selects status = 'pending';
//   • not payable — both payout paths select 'approved'/'paid', and 0392's CHECK refuses a draft that
//     carries any payout provenance at all;
//   • not notified — core/notifications.ts has no mapping for the draft events, so saving one raises
//     nothing for anybody. The plan is explicit that a draft must not reach an approver.
//
// WHAT IS DELIBERATELY NOT CHECKED AT SAVE TIME: limits, the receipt requirement and the receipt-date
// window. A draft is work in progress; refusing to SAVE it because the amount is over budget or the date is
// still blank defeats the entire feature. Every one of those checks runs at SUBMIT, in
// priceAndCheckClaimTx, against the policy in force THEN — a draft saved in December and submitted in
// January is priced by January's rate, which is the only defensible answer.

/** What an employee may set on a draft. Same shape as a submit, minus the receipt flag (a draft's receipt
 *  is attached separately and is not required until submit). */
export type DraftClaimInput = {
  employmentId: string;
  claimTypeId: string;
  claimItemId?: string | null;
  amount: number;
  quantityKm?: number | null;
  incurredOn: string;
  description?: string | null;
  /** e7eb5d83 — custom-field answers, stored as given. NOT validated at save: a half-answered form is the
   *  normal state of a draft, and refusing to save one because a required field is blank defeats drafts
   *  entirely. validateClaimFieldValues runs at SUBMIT, which is the same posture as the limit checks. */
  fieldValues?: Record<string, string | number | boolean | null> | null;
};

/** Amount a draft SHOWS in the list. Provisional only — the authoritative amount is derived at submit from
 *  the policy in force then. Returns 0 rather than throwing when the rate config cannot price the draft
 *  yet (a mileage draft with no distance typed), because a half-filled draft is the normal case. */
function provisionalAmount(rateConfig: ClaimRateConfig | null, p: { quantityKm?: number | null; enteredAmount?: number | null }): number {
  try {
    const n = computeClaimAmount(rateConfig, p);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** The claimant's own person id must match, or the caller is not the owner. Managers and admins can SEE a
 *  draft through RLS (can_see_employment) — they may not edit, submit or delete one. A draft is private
 *  working material until its author decides otherwise; an admin acting on someone's unsubmitted claim is
 *  indistinguishable from filing a claim in their name. */
async function assertDraftOwner(tx: Tx, ctx: SessionContext, employmentId: string): Promise<void> {
  const [emp] = await tx.select({ personId: employment.personId }).from(employment).where(eq(employment.id, employmentId)).limit(1);
  if (!emp) throw new ClaimError('Claim not found');
  if (ctx.personId == null || emp.personId !== ctx.personId) {
    throw new ClaimError('Only the claimant can edit or submit their own draft claim');
  }
}

/**
 * Create a draft, or update one the caller owns (pass `id`). Reserves nothing and notifies nobody.
 *
 * Validation is limited to what would make the row meaningless: a live claim type, an item that actually
 * belongs to it when one is given, and a well-formed date. Note the item rule is LOOSER than submit's — a
 * draft may omit an item the type will eventually require, because "I haven't chosen yet" is the point of
 * a draft. Submit refuses it.
 */
export async function saveClaimDraft(
  ctx: SessionContext,
  p: DraftClaimInput & { id?: string },
  attachment: { fileName: string; mimeType: string; content: Buffer } | null = null,
): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.incurredOn)) throw new ClaimError('Incurred date must be YYYY-MM-DD');
  // Validated before the tx opens, exactly as submitClaimWithAttachment does, so a bad file never starts a
  // draft write it will then have to roll back.
  if (attachment) assertValidAttachment(attachment.mimeType, attachment.content);
  return withTenant(ctx, async (tx) => {
    await assertDraftOwner(tx, ctx, p.employmentId);
    const [ct] = await tx.select().from(claimType).where(and(eq(claimType.id, p.claimTypeId), isNull(claimType.archivedAt))).limit(1);
    if (!ct) throw new ClaimError('Unknown or archived claim type');
    const items = await activeItemsFor(tx, p.claimTypeId);
    let claimItemId: string | null = null;
    if (p.claimItemId) {
      if (!items.some((i) => i.id === p.claimItemId)) throw new ClaimError('That claim item does not belong to this claim type');
      claimItemId = p.claimItemId;
    }
    const [emp] = await tx.select({ gradeId: employment.gradeId }).from(employment).where(eq(employment.id, p.employmentId)).limit(1);
    const policy = await getActiveClaimPolicy(tx, p.claimTypeId, p.incurredOn, emp?.gradeId ?? null);
    const quantityKm = policy?.rateConfig?.kind === 'mileage_flat' ? (p.quantityKm ?? null) : null;
    const amount = provisionalAmount(policy?.rateConfig ?? null, { quantityKm: p.quantityKm, enteredAmount: p.amount });
    const values = {
      claimTypeId: p.claimTypeId,
      claimItemId,
      amount: amount.toFixed(2),
      quantityKm: quantityKm == null ? null : quantityKm.toFixed(2),
      incurredOn: p.incurredOn,
      description: p.description ?? null,
      taxable: ct.defaultTaxable,
      fieldValues: p.fieldValues ?? null,
    };

    if (p.id) {
      // Row lock before the status read: an edit racing this draft's own submit must not overwrite a claim
      // that has already become pending (which would let an employee change a filed claim's amount).
      const [existing] = await tx
        .select({ id: claimRequest.id, status: claimRequest.status, employmentId: claimRequest.employmentId })
        .from(claimRequest)
        .where(eq(claimRequest.id, p.id))
        .limit(1)
        .for('update');
      if (!existing) throw new ClaimError('Claim not found');
      if (existing.status !== 'draft') throw new ClaimError('Only a draft claim can be edited');
      await assertDraftOwner(tx, ctx, existing.employmentId);
      await tx.update(claimRequest).set(values).where(eq(claimRequest.id, p.id));
      if (attachment) {
        await insertClaimAttachmentTx(tx, ctx, { claimRequestId: p.id, employmentId: p.employmentId, status: 'draft', ...attachment });
      }
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: p.id,
        eventType: 'claim-request.draft-saved',
        actor: actorOf(ctx),
        subjectEmploymentId: p.employmentId,
        // ADR-0030 Layer 0: no amount in the log — it lives on claim_request[aggregateId].
        payload: { claimTypeId: p.claimTypeId, claimItemId, incurredOn: p.incurredOn },
      });
      return { id: p.id };
    }

    const [row] = await tx
      .insert(claimRequest)
      .values({ tenantId: ctx.tenantId, employmentId: p.employmentId, status: 'draft', ...values })
      .returning({ id: claimRequest.id });
    if (attachment) {
      await insertClaimAttachmentTx(tx, ctx, { claimRequestId: row.id, employmentId: p.employmentId, status: 'draft', ...attachment });
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-request',
      aggregateId: row.id,
      eventType: 'claim-request.draft-saved',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { claimTypeId: p.claimTypeId, claimItemId, incurredOn: p.incurredOn },
    });
    return { id: row.id };
  });
}

/** Delete a draft the caller owns, with any receipt already attached to it. Hard delete, not a status
 *  change: an unsubmitted claim never entered any ledger, so there is nothing for a tombstone to explain —
 *  and a 'deleted' status would be a sixth thing every reader of the enum has to know about. */
export async function deleteClaimDraft(ctx: SessionContext, claimRequestId: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [claim] = await tx
      .select({ id: claimRequest.id, status: claimRequest.status, employmentId: claimRequest.employmentId })
      .from(claimRequest)
      .where(eq(claimRequest.id, claimRequestId))
      .limit(1)
      .for('update');
    if (!claim) throw new ClaimError('Claim not found');
    if (claim.status !== 'draft') throw new ClaimError('Only a draft claim can be deleted');
    await assertDraftOwner(tx, ctx, claim.employmentId);
    await tx.delete(claimAttachment).where(eq(claimAttachment.claimRequestId, claim.id));
    await tx.delete(claimRequest).where(eq(claimRequest.id, claim.id));
    // Appended AFTER the delete and deliberately outside the aggregate's own row: the event is the only
    // remaining record that the draft existed.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-request',
      aggregateId: claim.id,
      eventType: 'claim-request.draft-deleted',
      actor: actorOf(ctx),
      subjectEmploymentId: claim.employmentId,
    });
  });
}

/**
 * Submit one or more of the caller's own drafts — the bulk "Submit Selected" the item asks for.
 *
 * ALL-OR-NOTHING, IN ONE TRANSACTION, AND THAT IS THE INTERESTING DECISION. Best-effort ("submit the ones
 * that fit") is friendlier and is wrong here: the drafts in a batch compete for the SAME limit, so a
 * partial success means the system silently chose which of the employee's claims to file, in whatever
 * order the ids arrived. Rolling the whole batch back and naming the claim that did not fit leaves the
 * choice with the person whose money it is.
 *
 * Each draft is checked against the state produced by the ones before it in the batch — the flip to
 * 'pending' happens inside the same transaction, so the second draft's limit read already includes the
 * first. A batch that fits individually but not collectively is refused, which is the case a per-claim
 * loop over separate transactions would wave through.
 *
 * The (employee × type) locks are taken in sorted key order (priceAndCheckClaimTx takes them one per
 * claim, and the batch is sorted by claim type first) so two employees' batches — or one employee's two
 * tabs — can never hold each other's next lock.
 */
export async function submitDraftClaims(ctx: SessionContext, p: { ids: string[] }): Promise<{ submitted: number }> {
  const ids = Array.from(new Set(p.ids.filter((s) => typeof s === 'string' && s.length > 0)));
  if (ids.length === 0) throw new ClaimError('Select at least one draft claim to submit');
  return withTenant(ctx, async (tx) => {
    const drafts = await tx
      .select({
        id: claimRequest.id,
        status: claimRequest.status,
        employmentId: claimRequest.employmentId,
        claimTypeId: claimRequest.claimTypeId,
        claimItemId: claimRequest.claimItemId,
        amount: claimRequest.amount,
        quantityKm: claimRequest.quantityKm,
        // e7eb5d83 — MUST be projected. A draft's custom-field answers are stored when it is saved; if the
        // submit path did not read them back, every required field would refuse every draft ("not answered")
        // even though the employee had answered it, which is the projection trap leave-type documents.
        fieldValues: claimRequest.fieldValues,
        incurredOn: claimRequest.incurredOn,
        description: claimRequest.description,
        typeName: claimType.name,
      })
      .from(claimRequest)
      .innerJoin(claimType, eq(claimType.id, claimRequest.claimTypeId))
      .where(inArray(claimRequest.id, ids))
      // Locked up front, in id order, so two concurrent bulk submits over overlapping selections queue
      // rather than both reading 'draft' and both filing the same claim twice.
      .orderBy(claimRequest.id)
      .for('update', { of: claimRequest });
    if (drafts.length !== ids.length) throw new ClaimError('One or more of those claims no longer exists');

    // Deterministic lock order for the advisory locks priceAndCheckClaimTx will take — sorted by the LOCK
    // KEY itself, not by claim id. A batch holds several locks at once, so two batches acquiring the same
    // keys in different orders is a textbook deadlock; ordering by the key makes any two batches agree.
    // (One person can hold two employments, so the employment id is part of the key and of the sort.)
    const lockKeyOf = (d: { employmentId: string; claimTypeId: string }) => claimLimitLockKey(ctx.tenantId, d.employmentId, d.claimTypeId);
    const ordered = [...drafts].sort((a, b) => lockKeyOf(a).localeCompare(lockKeyOf(b)) || a.id.localeCompare(b.id));

    for (const d of ordered) {
      if (d.status !== 'draft') throw new ClaimError(`"${d.typeName}" is no longer a draft and cannot be submitted again`);
      await assertDraftOwner(tx, ctx, d.employmentId);
      const hasReceipt = await draftHasAttachment(tx, d.id);
      let priced;
      try {
        priced = await priceAndCheckClaimTx(tx, ctx, {
          employmentId: d.employmentId,
          claimTypeId: d.claimTypeId,
          claimItemId: d.claimItemId,
          amount: Number(d.amount),
          quantityKm: d.quantityKm == null ? null : Number(d.quantityKm),
          incurredOn: d.incurredOn,
          description: d.description,
          hasReceipt,
          fieldValues: d.fieldValues ?? null,
          excludeId: d.id,
        });
      } catch (e) {
        // Name the claim. In a batch of five, "Amount must be greater than zero" with no subject is a
        // message the employee cannot act on.
        throw new ClaimError(`"${d.typeName}" (${d.incurredOn}) cannot be submitted: ${(e as Error).message}`);
      }
      // The transition IS the reservation, and it happens under the lock priceAndCheckClaimTx just took.
      await tx
        .update(claimRequest)
        .set({
          status: 'pending',
          claimItemId: priced.claimItemId,
          amount: priced.amount.toFixed(2),
          quantityKm: priced.quantityKm == null ? null : priced.quantityKm.toFixed(2),
          taxable: priced.taxable,
          // e7eb5d83 — a draft is priced at SUBMIT, so the rate it is stamped with is the one live on the
          // day it was filed, not the day it was drafted. Same column, same transition, same reservation.
          mileageRateApplied: priced.mileageStamp,
          fieldValues: priced.fieldValues,
        })
        .where(eq(claimRequest.id, d.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: d.id,
        // The SAME event a fresh submit appends: downstream (notifications, approval history, the audit
        // trail) must not have to learn that a claim can arrive by two different names.
        eventType: 'claim-request.submitted',
        actor: actorOf(ctx),
        subjectEmploymentId: d.employmentId,
        payload: { claimTypeId: d.claimTypeId, claimItemId: priced.claimItemId, incurredOn: d.incurredOn, taxable: priced.taxable, fromDraft: true },
      });
    }
    return { submitted: ordered.length };
  });
}

/** Does this draft already carry a receipt? Decides the type-level requiresReceipt check at submit. */
async function draftHasAttachment(tx: Tx, claimRequestId: string): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(claimAttachment)
    .where(eq(claimAttachment.claimRequestId, claimRequestId));
  return Number(row?.n ?? 0) > 0;
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
  // e7eb5d83: 'draft' joins 'pending' here. A draft that could not carry its receipt would force the
  // employee to keep the file until submit day, which is the paperwork the feature exists to remove — and
  // the receipt REQUIREMENT is still enforced at submit, not at save, so this loosens nothing.
  if (p.status !== 'pending' && p.status !== 'draft') {
    throw new ClaimError('Receipts can only be added while the claim is a draft or pending');
  }
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
  /** Carried so the Drafts list can re-open a draft in the submission form without a second read. */
  claimTypeId: string;
  claimItemId: string | null;
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
    claimTypeId: claimRequest.claimTypeId,
    claimItemId: claimRequest.claimItemId,
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
  claimTypeId: string;
  claimItemId: string | null;
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
  claimTypeId: r.claimTypeId,
  claimItemId: r.claimItemId,
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
    // R51 (baf56348): trim delegation-routed rows whose subject is outside the delegation's org coverage.
    const scoped = await filterDelegationOrgScopeTx(tx, ctx, rows, (r) => r.employmentId);
    const atts = await attachmentsByClaim(tx, scoped.map((r) => r.id));
    return scoped.map((r) => toRow(r, atts));
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
