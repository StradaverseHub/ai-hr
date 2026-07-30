/**
 * Benefit Scheme & Leave Entitlement Configuration (feedback b83c6a3b).
 *
 * A friendlier CONFIGURATION LAYER over the grade-scoped leave_policy engine (core/leave-compute.ts). This
 * module owns the CRUD for grade groups, benefit schemes and their per-leave-type entitlement tables, plus
 * the employee↔scheme override. The RESOLUTION math is pure + reused (resolveEffectiveSchemeId + schemeBandDays
 * in core/leave-compute.ts, wired into the grant sweeps in core/leave.ts) — nothing here re-implements the
 * day-counting. Every state-changing method runs under withTenant and appends a DomainEvent (substrate).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import {
  benefitScheme,
  employment,
  gradeGroup,
  gradeGroupMember,
  jobGrade,
  leaveType,
  schemeLeaveEntitlement,
  schemeLeaveCombinedLimit,
  schemeLeaveCombinedLimitMember,
} from '../db/schema';
import { isWellFormedBands, type ServiceBand } from './leave-compute';
// ae5b84d5 — the profile-side recalc engine trues an employee's current-cycle balance up after a manual
// scheme override changes. No import cycle: core/leave.ts never imports this module.
import { reprojectEntitlementForEmployment } from './leave';

type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';
type SchemeStatus = 'active' | 'inactive';

function cleanName(v: string | undefined, label: string): string {
  const s = (v ?? '').trim();
  if (!s) throw new Error(`${label} is required.`);
  if (s.length > 120) throw new Error(`${label} must be 120 characters or fewer.`);
  return s;
}

const EMPLOYMENT_TYPES: readonly EmploymentType[] = ['full_time', 'part_time', 'contract', 'intern'];
function coerceEmploymentType(v: string | undefined): EmploymentType {
  if (v && (EMPLOYMENT_TYPES as readonly string[]).includes(v)) return v as EmploymentType;
  throw new Error('Employment type must be one of: full_time, part_time, contract, intern.');
}

function coerceStatus(v: string | undefined): SchemeStatus {
  return v === 'inactive' ? 'inactive' : 'active';
}

/** Validate a scheme entitlement's service bands (contiguous from 0, open-ended last, ≤10). Reuses the
 *  engine's `isWellFormedBands` so a scheme entitlement can never persist a shape the resolver would reject. */
function validateBands(bands: ServiceBand[]): void {
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new Error('Leave entitlement: provide at least one service band.');
  }
  if (!isWellFormedBands(bands)) {
    throw new Error(
      'Leave entitlement: bands must be contiguous, start at 0 years, end open-ended, and have zero/positive days (max 10 bands).',
    );
  }
}

// ── Grade groups ─────────────────────────────────────────────────────────────────────────────────────
export type GradeGroupRow = {
  id: string;
  name: string;
  archived: boolean;
  gradeIds: string[];
};

export async function listGradeGroups(ctx: SessionContext): Promise<GradeGroupRow[]> {
  // Read-only — no events (CLAUDE.md skip rule).
  return withTenant(ctx, async (tx) => {
    const groups = await tx
      .select({ id: gradeGroup.id, name: gradeGroup.name, archivedAt: gradeGroup.archivedAt })
      .from(gradeGroup)
      .orderBy(asc(gradeGroup.name));
    const members = await tx
      .select({ gradeGroupId: gradeGroupMember.gradeGroupId, gradeId: gradeGroupMember.gradeId })
      .from(gradeGroupMember);
    const byGroup = new Map<string, string[]>();
    for (const m of members) {
      const arr = byGroup.get(m.gradeGroupId);
      if (arr) arr.push(m.gradeId);
      else byGroup.set(m.gradeGroupId, [m.gradeId]);
    }
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      archived: g.archivedAt != null,
      gradeIds: byGroup.get(g.id) ?? [],
    }));
  });
}

export async function createGradeGroup(
  ctx: SessionContext,
  p: { name: string; gradeIds?: string[] },
) {
  const name = cleanName(p.name, 'Grade group name');
  const gradeIds = [...new Set((p.gradeIds ?? []).filter(Boolean))];
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(gradeGroup)
      .values({ tenantId: ctx.tenantId, name })
      .returning({ id: gradeGroup.id })
      .catch((e) => {
        if (String((e as { code?: string })?.code) === '23505') {
          throw new Error(`A grade group named “${name}” already exists.`);
        }
        throw e;
      });
    if (gradeIds.length) await replaceGroupMembers(tx, ctx.tenantId, row.id, gradeIds);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'grade-group',
      aggregateId: row.id,
      eventType: 'grade-group.created',
      actor: actorOf(ctx),
      payload: { name, gradeIds },
    });
    return row;
  });
}

export async function updateGradeGroup(
  ctx: SessionContext,
  p: { id: string; name: string; gradeIds?: string[] },
): Promise<{ gradeIds: string[] }> {
  const name = cleanName(p.name, 'Grade group name');
  const gradeIds = p.gradeIds === undefined ? undefined : [...new Set(p.gradeIds.filter(Boolean))];
  return withTenant(ctx, async (tx) => {
    // ae5b84d5: capture the BEFORE membership inside this tx — the action fires the cohort recalc over the
    // UNION of before/after grade ids, so both a grade that LEFT the group and one that JOINED are trued up
    // (the feedback's "employee transfers to another Grade Group" case, config-side).
    const beforeMembers = await tx
      .select({ gradeId: gradeGroupMember.gradeId })
      .from(gradeGroupMember)
      .where(eq(gradeGroupMember.gradeGroupId, p.id));
    await tx
      .update(gradeGroup)
      .set({ name })
      .where(eq(gradeGroup.id, p.id))
      .catch((e) => {
        if (String((e as { code?: string })?.code) === '23505') {
          throw new Error(`A grade group named “${name}” already exists.`);
        }
        throw e;
      });
    if (gradeIds !== undefined) await replaceGroupMembers(tx, ctx.tenantId, p.id, gradeIds);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'grade-group',
      aggregateId: p.id,
      eventType: 'grade-group.updated',
      actor: actorOf(ctx),
      payload: { name, ...(gradeIds !== undefined ? { gradeIds } : {}) },
    });
    return { gradeIds: [...new Set([...beforeMembers.map((m) => m.gradeId), ...(gradeIds ?? [])])] };
  });
}

export async function deleteGradeGroup(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    // Block deletion when an active scheme still references this group (FK is SET NULL, but silently
    // orphaning a scheme's grade group would break its auto-match — surface it instead).
    const [used] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(benefitScheme)
      .where(eq(benefitScheme.gradeGroupId, p.id));
    if ((used?.n ?? 0) > 0) {
      throw new Error('This grade group is used by one or more benefit schemes. Reassign or remove those schemes first.');
    }
    await tx.delete(gradeGroup).where(eq(gradeGroup.id, p.id)); // members cascade
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'grade-group',
      aggregateId: p.id,
      eventType: 'grade-group.deleted',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}

/** Replace a group's grade membership wholesale. A grade may belong to at most one group (unique index) —
 *  moving it here first detaches it from any other group so the reassignment never trips the index. */
async function replaceGroupMembers(tx: Tx, tenantId: string, groupId: string, gradeIds: string[]) {
  await tx.delete(gradeGroupMember).where(eq(gradeGroupMember.gradeGroupId, groupId));
  if (gradeIds.length === 0) return;
  // Detach these grades from any OTHER group first (a grade lives in one group).
  await tx.delete(gradeGroupMember).where(inArray(gradeGroupMember.gradeId, gradeIds));
  await tx.insert(gradeGroupMember).values(
    gradeIds.map((gradeId) => ({ tenantId, gradeGroupId: groupId, gradeId })),
  );
}

// ── Benefit schemes ──────────────────────────────────────────────────────────────────────────────────
export type BenefitSchemeListRow = {
  id: string;
  companyId: string;
  companyName: string | null;
  employmentType: EmploymentType;
  gradeGroupId: string | null;
  gradeGroupName: string | null;
  name: string;
  status: SchemeStatus;
  /** Feedback 0890a555: the grouping label. null ⇒ ungrouped. */
  schemeCategory: string | null;
};

/**
 * Feedback 0890a555 — normalise a posted Scheme Category. Blank / whitespace-only ⇒ null (ungrouped), which
 * is what the DB CHECK in migration 0335 also enforces: a whitespace category would render as an unnamed
 * group heading nobody can select or clear. Otherwise the tenant's own text with whitespace collapsed —
 * NOT re-cased, for the same reason `normalizeSchemeText` does not re-case a scheme name (title-casing
 * would mangle acronyms and is a rewrite of their words rather than a tidy-up of ours).
 */
export function cleanSchemeCategory(v: string | null | undefined): string | null {
  const text = (v ?? '').replace(/\s+/g, ' ').trim();
  return text.length === 0 ? null : text.slice(0, 120);
}

export async function listBenefitSchemes(ctx: SessionContext): Promise<BenefitSchemeListRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: benefitScheme.id,
        companyId: benefitScheme.companyId,
        employmentType: benefitScheme.employmentType,
        gradeGroupId: benefitScheme.gradeGroupId,
        gradeGroupName: gradeGroup.name,
        name: benefitScheme.name,
        status: benefitScheme.status,
        schemeCategory: benefitScheme.schemeCategory,
      })
      .from(benefitScheme)
      .leftJoin(gradeGroup, eq(gradeGroup.id, benefitScheme.gradeGroupId))
      .orderBy(asc(benefitScheme.name));
    // Company names live on the org read layer; keep this module self-contained by joining minimally.
    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      companyName: null,
      employmentType: r.employmentType as EmploymentType,
      gradeGroupId: r.gradeGroupId,
      gradeGroupName: r.gradeGroupName,
      name: r.name,
      status: r.status as SchemeStatus,
      schemeCategory: r.schemeCategory,
    }));
  });
}

export async function createBenefitScheme(
  ctx: SessionContext,
  p: {
    companyId: string;
    employmentType: string;
    gradeGroupId?: string | null;
    name: string;
    status?: string;
    /** Feedback 0890a555: grouping label only. Blank ⇒ null (ungrouped). */
    schemeCategory?: string | null;
  },
) {
  const name = cleanName(p.name, 'Benefit scheme name');
  const employmentType = coerceEmploymentType(p.employmentType);
  const status = coerceStatus(p.status);
  const gradeGroupId = p.gradeGroupId || null;
  const schemeCategory = cleanSchemeCategory(p.schemeCategory);
  if (!p.companyId) throw new Error('Company is required.');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(benefitScheme)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, employmentType, gradeGroupId, name, status, schemeCategory })
      .returning({ id: benefitScheme.id })
      .catch((e) => {
        const code = String((e as { code?: string })?.code);
        const constraint = String((e as { constraint?: string })?.constraint ?? '');
        if (code === '23505' && constraint === 'benefit_scheme_name_uq') {
          throw new Error(`A benefit scheme named “${name}” already exists.`);
        }
        if (code === '23505') {
          throw new Error('An active benefit scheme already exists for this company, employment type and grade group.');
        }
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'benefit-scheme',
      aggregateId: row.id,
      eventType: 'benefit-scheme.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, employmentType, gradeGroupId, name, status, schemeCategory },
    });
    return row;
  });
}

export async function updateBenefitScheme(
  ctx: SessionContext,
  p: {
    id: string;
    companyId: string;
    employmentType: string;
    gradeGroupId?: string | null;
    name: string;
    status?: string;
    /** Feedback 0890a555: grouping label only. Blank ⇒ null (ungrouped). */
    schemeCategory?: string | null;
  },
) {
  const name = cleanName(p.name, 'Benefit scheme name');
  const employmentType = coerceEmploymentType(p.employmentType);
  const status = coerceStatus(p.status);
  const gradeGroupId = p.gradeGroupId || null;
  const schemeCategory = cleanSchemeCategory(p.schemeCategory);
  if (!p.companyId) throw new Error('Company is required.');
  return withTenant(ctx, async (tx) => {
    const [prev] = await tx
      .select({
        companyId: benefitScheme.companyId,
        employmentType: benefitScheme.employmentType,
        gradeGroupId: benefitScheme.gradeGroupId,
        name: benefitScheme.name,
        status: benefitScheme.status,
        schemeCategory: benefitScheme.schemeCategory,
      })
      .from(benefitScheme)
      .where(eq(benefitScheme.id, p.id))
      .limit(1);
    await tx
      .update(benefitScheme)
      .set({ companyId: p.companyId, employmentType, gradeGroupId, name, status, schemeCategory })
      .where(eq(benefitScheme.id, p.id))
      .catch((e) => {
        const code = String((e as { code?: string })?.code);
        const constraint = String((e as { constraint?: string })?.constraint ?? '');
        if (code === '23505' && constraint === 'benefit_scheme_name_uq') {
          throw new Error(`A benefit scheme named “${name}” already exists.`);
        }
        if (code === '23505') {
          throw new Error('An active benefit scheme already exists for this company, employment type and grade group.');
        }
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'benefit-scheme',
      aggregateId: p.id,
      eventType: 'benefit-scheme.updated',
      actor: actorOf(ctx),
      payload: {
        before: prev ?? null,
        after: { companyId: p.companyId, employmentType, gradeGroupId, name, status, schemeCategory },
      },
    });
    // ae5b84d5: tell the action whether the scheme's MATCH IDENTITY / usability moved (status, employment
    // type, grade group, company) — those are the edits that re-shuffle who the scheme covers, so the
    // action fires the cohort recalc only then (a pure rename never moves a balance).
    const changed =
      !!prev &&
      (prev.status !== status ||
        prev.employmentType !== employmentType ||
        prev.gradeGroupId !== gradeGroupId ||
        prev.companyId !== p.companyId);
    return { changed };
  });
}

export async function deleteBenefitScheme(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    // Employment FK is SET NULL, so deleting cleanly reverts overridden employees to auto-match. Scheme
    // entitlements cascade. Emit the audit event.
    await tx.delete(benefitScheme).where(eq(benefitScheme.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'benefit-scheme',
      aggregateId: p.id,
      eventType: 'benefit-scheme.deleted',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}

// ── Scheme leave entitlements ─────────────────────────────────────────────────────────────────────────
export type SchemeEntitlementRow = {
  id: string;
  benefitSchemeId: string;
  leaveTypeId: string;
  leaveTypeName: string | null;
  leaveTypeCode: string | null;
  serviceBands: ServiceBand[];
};

export async function listSchemeEntitlements(
  ctx: SessionContext,
  p?: { benefitSchemeId?: string },
): Promise<SchemeEntitlementRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: schemeLeaveEntitlement.id,
        benefitSchemeId: schemeLeaveEntitlement.benefitSchemeId,
        leaveTypeId: schemeLeaveEntitlement.leaveTypeId,
        leaveTypeName: leaveType.name,
        leaveTypeCode: leaveType.code,
        serviceBands: schemeLeaveEntitlement.serviceBands,
      })
      .from(schemeLeaveEntitlement)
      .leftJoin(leaveType, eq(leaveType.id, schemeLeaveEntitlement.leaveTypeId))
      .where(p?.benefitSchemeId ? eq(schemeLeaveEntitlement.benefitSchemeId, p.benefitSchemeId) : undefined);
    return rows.map((r) => ({
      id: r.id,
      benefitSchemeId: r.benefitSchemeId,
      leaveTypeId: r.leaveTypeId,
      leaveTypeName: r.leaveTypeName,
      leaveTypeCode: r.leaveTypeCode,
      serviceBands: Array.isArray(r.serviceBands) ? (r.serviceBands as ServiceBand[]) : [],
    }));
  });
}

/** Create or replace a scheme's entitlement for one leave type (upsert on the unique (scheme, type)). */
export async function upsertSchemeEntitlement(
  ctx: SessionContext,
  p: { benefitSchemeId: string; leaveTypeId: string; serviceBands: ServiceBand[] },
) {
  if (!p.benefitSchemeId) throw new Error('Benefit scheme is required.');
  if (!p.leaveTypeId) throw new Error('Leave type is required.');
  validateBands(p.serviceBands);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(schemeLeaveEntitlement)
      .values({
        tenantId: ctx.tenantId,
        benefitSchemeId: p.benefitSchemeId,
        leaveTypeId: p.leaveTypeId,
        serviceBands: p.serviceBands,
      })
      .onConflictDoUpdate({
        target: [
          schemeLeaveEntitlement.tenantId,
          schemeLeaveEntitlement.benefitSchemeId,
          schemeLeaveEntitlement.leaveTypeId,
        ],
        set: { serviceBands: p.serviceBands },
      })
      .returning({ id: schemeLeaveEntitlement.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'scheme-leave-entitlement',
      aggregateId: row.id,
      eventType: 'scheme-leave-entitlement.set',
      actor: actorOf(ctx),
      payload: { benefitSchemeId: p.benefitSchemeId, leaveTypeId: p.leaveTypeId, serviceBands: p.serviceBands },
    });
    return row;
  });
}

export async function deleteSchemeEntitlement(
  ctx: SessionContext,
  p: { id: string },
): Promise<{ benefitSchemeId: string | null }> {
  return withTenant(ctx, async (tx) => {
    // ae5b84d5: resolve the owning scheme BEFORE the delete so the action can fire the cohort recalc
    // (covered employees fall back to grade-policy/floor days and must be trued up).
    const [row] = await tx
      .select({ benefitSchemeId: schemeLeaveEntitlement.benefitSchemeId })
      .from(schemeLeaveEntitlement)
      .where(eq(schemeLeaveEntitlement.id, p.id))
      .limit(1);
    await tx.delete(schemeLeaveEntitlement).where(eq(schemeLeaveEntitlement.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'scheme-leave-entitlement',
      aggregateId: p.id,
      eventType: 'scheme-leave-entitlement.deleted',
      actor: actorOf(ctx),
      payload: {},
    });
    return { benefitSchemeId: row?.benefitSchemeId ?? null };
  });
}

/** Copy all leave entitlements from a source scheme into a target scheme, SKIPPING any leave type the target
 *  already has (no overwrite). Emits ONE DomainEvent 'scheme-leave-entitlement.copied' with the copied count
 *  + leave-type ids (not one event per row). Dedup by leaveTypeId ties into the duplicate-validation item. */
export async function copySchemeEntitlements(
  ctx: SessionContext,
  p: { sourceSchemeId: string; targetSchemeId: string },
): Promise<{ copied: number; copiedLeaveTypeIds: string[] }> {
  if (!p.sourceSchemeId || !p.targetSchemeId) throw new Error('Source and target schemes are required.');
  if (p.sourceSchemeId === p.targetSchemeId) throw new Error('Source and target schemes must be different.');
  return withTenant(ctx, async (tx) => {
    const sourceRows = await tx
      .select({ leaveTypeId: schemeLeaveEntitlement.leaveTypeId, serviceBands: schemeLeaveEntitlement.serviceBands })
      .from(schemeLeaveEntitlement)
      .where(eq(schemeLeaveEntitlement.benefitSchemeId, p.sourceSchemeId));
    const targetRows = await tx
      .select({ leaveTypeId: schemeLeaveEntitlement.leaveTypeId })
      .from(schemeLeaveEntitlement)
      .where(eq(schemeLeaveEntitlement.benefitSchemeId, p.targetSchemeId));
    const existing = new Set(targetRows.map((r) => r.leaveTypeId));
    const toCopy = sourceRows.filter((r) => !existing.has(r.leaveTypeId));
    if (toCopy.length === 0) return { copied: 0, copiedLeaveTypeIds: [] };
    const inserted = await tx
      .insert(schemeLeaveEntitlement)
      .values(
        toCopy.map((r) => ({
          tenantId: ctx.tenantId,
          benefitSchemeId: p.targetSchemeId,
          leaveTypeId: r.leaveTypeId,
          serviceBands: r.serviceBands as ServiceBand[],
        })),
      )
      .returning({ id: schemeLeaveEntitlement.id, leaveTypeId: schemeLeaveEntitlement.leaveTypeId });
    const copiedLeaveTypeIds = inserted.map((r) => r.leaveTypeId);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'scheme-leave-entitlement',
      aggregateId: p.targetSchemeId,
      eventType: 'scheme-leave-entitlement.copied',
      actor: actorOf(ctx),
      payload: {
        sourceSchemeId: p.sourceSchemeId,
        targetSchemeId: p.targetSchemeId,
        count: inserted.length,
        copiedLeaveTypeIds,
      },
    });
    return { copied: inserted.length, copiedLeaveTypeIds };
  });
}

// ── Scheme combined leave-type limits (R44 4c48fd1f) ──────────────────────────────────────────────────
export type SchemeCombinedLimitRow = {
  id: string;
  benefitSchemeId: string;
  name: string;
  totalLimitDays: number;
  /** r82a 1ef1cf95 (0327): per-application day cap, null = uncapped (every pool predating 0327). */
  maxDaysPerApplication: number | null;
  leaveTypeIds: string[];
};

/** A pool caps SEVERAL leave types under one per-cycle total. Read-only — no events (CLAUDE.md skip rule). */
export async function listSchemeCombinedLimits(
  ctx: SessionContext,
  p?: { benefitSchemeId?: string },
): Promise<SchemeCombinedLimitRow[]> {
  return withTenant(ctx, async (tx) => {
    const pools = await tx
      .select({
        id: schemeLeaveCombinedLimit.id,
        benefitSchemeId: schemeLeaveCombinedLimit.benefitSchemeId,
        name: schemeLeaveCombinedLimit.name,
        totalLimitDays: schemeLeaveCombinedLimit.totalLimitDays,
        maxDaysPerApplication: schemeLeaveCombinedLimit.maxDaysPerApplication,
      })
      .from(schemeLeaveCombinedLimit)
      .where(p?.benefitSchemeId ? eq(schemeLeaveCombinedLimit.benefitSchemeId, p.benefitSchemeId) : undefined)
      .orderBy(asc(schemeLeaveCombinedLimit.name));
    if (pools.length === 0) return [];
    const members = await tx
      .select({
        combinedLimitId: schemeLeaveCombinedLimitMember.combinedLimitId,
        leaveTypeId: schemeLeaveCombinedLimitMember.leaveTypeId,
      })
      .from(schemeLeaveCombinedLimitMember)
      .where(
        inArray(
          schemeLeaveCombinedLimitMember.combinedLimitId,
          pools.map((x) => x.id),
        ),
      );
    const byPool = new Map<string, string[]>();
    for (const m of members) {
      const arr = byPool.get(m.combinedLimitId);
      if (arr) arr.push(m.leaveTypeId);
      else byPool.set(m.combinedLimitId, [m.leaveTypeId]);
    }
    return pools.map((x) => ({
      id: x.id,
      benefitSchemeId: x.benefitSchemeId,
      name: x.name,
      totalLimitDays: Number(x.totalLimitDays),
      maxDaysPerApplication: x.maxDaysPerApplication == null ? null : Number(x.maxDaysPerApplication),
      leaveTypeIds: byPool.get(x.id) ?? [],
    }));
  });
}

function cleanLimitDays(v: number | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) {
    throw new Error('Combined limit: total days must be greater than zero.');
  }
  if (v > 999) throw new Error('Combined limit: total days is too large.');
  return v.toFixed(2);
}

/** r82a 1ef1cf95 — the PER-APPLICATION cap (0327). Distinct from cleanLimitDays because "unset" is a
 *  legitimate, and indeed the default, answer here: null/undefined ⇒ null ⇒ no cap, so a caller that never
 *  heard of this field leaves the group exactly as it was. A supplied value must be a real positive figure
 *  — 0 or a negative would refuse every application of every member type, which is a mistake and not a
 *  policy, so it is rejected loudly rather than stored. Bounds mirror the DB CHECK in migration 0327. */
function cleanMaxDaysPerApplication(v: number | null | undefined): string | null {
  if (v == null) return null;
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error('Combined limit: maximum days per application must be greater than zero (leave it blank for no cap).');
  }
  if (v > 999) throw new Error('Combined limit: maximum days per application is too large.');
  return v.toFixed(2);
}

function cleanMemberTypeIds(ids: string[] | undefined): string[] {
  const unique = [...new Set((ids ?? []).filter(Boolean))];
  if (unique.length < 2) {
    throw new Error('Combined limit: pick at least two leave types to share the pool.');
  }
  return unique;
}

/** Replace a pool's member leave types. The scheme-wide unique (tenant, scheme, leave_type) enforces that a
 *  leave type joins at most one pool per scheme → a 23505 becomes a friendly error. */
async function replaceCombinedLimitMembers(
  tx: Tx,
  tenantId: string,
  poolId: string,
  benefitSchemeId: string,
  leaveTypeIds: string[],
) {
  await tx
    .delete(schemeLeaveCombinedLimitMember)
    .where(eq(schemeLeaveCombinedLimitMember.combinedLimitId, poolId));
  if (leaveTypeIds.length) {
    await tx
      .insert(schemeLeaveCombinedLimitMember)
      .values(leaveTypeIds.map((leaveTypeId) => ({ tenantId, combinedLimitId: poolId, benefitSchemeId, leaveTypeId })))
      .catch((e) => {
        // R47 d6f88c2f fix: drizzle wraps the driver error (DrizzleQueryError), so the SQLSTATE lives on
        // `.cause` — the original `.code`-only check never matched and the raw query error leaked through.
        const code = (e as { code?: string })?.code ?? ((e as { cause?: { code?: string } })?.cause?.code);
        if (String(code) === '23505') {
          throw new Error('Combined limit: a chosen leave type already belongs to another pool in this scheme.');
        }
        throw e;
      });
  }
}

export async function createSchemeCombinedLimit(
  ctx: SessionContext,
  p: {
    benefitSchemeId: string;
    name: string;
    totalLimitDays: number;
    /** 0327: omit (or null) for an uncapped group — the pre-0327 behaviour of every existing pool. */
    maxDaysPerApplication?: number | null;
    leaveTypeIds: string[];
  },
) {
  if (!p.benefitSchemeId) throw new Error('Benefit scheme is required.');
  const name = cleanName(p.name, 'Combined limit name');
  const totalLimitDays = cleanLimitDays(p.totalLimitDays);
  const maxDaysPerApplication = cleanMaxDaysPerApplication(p.maxDaysPerApplication);
  const leaveTypeIds = cleanMemberTypeIds(p.leaveTypeIds);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(schemeLeaveCombinedLimit)
      .values({ tenantId: ctx.tenantId, benefitSchemeId: p.benefitSchemeId, name, totalLimitDays, maxDaysPerApplication })
      .returning({ id: schemeLeaveCombinedLimit.id });
    await replaceCombinedLimitMembers(tx, ctx.tenantId, row.id, p.benefitSchemeId, leaveTypeIds);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'scheme-leave-combined-limit',
      aggregateId: row.id,
      eventType: 'scheme-leave-combined-limit.created',
      actor: actorOf(ctx),
      payload: { benefitSchemeId: p.benefitSchemeId, name, totalLimitDays, maxDaysPerApplication, leaveTypeIds },
    });
    return row;
  });
}

export async function updateSchemeCombinedLimit(
  ctx: SessionContext,
  p: {
    id: string;
    name: string;
    totalLimitDays: number;
    /** 0327: this is an ABSOLUTE set, not a patch — null clears the cap. Every UI form that posts this
     *  action must therefore carry the field (as a visible input or a hidden one), or saving the name
     *  would silently drop the cap. */
    maxDaysPerApplication?: number | null;
    leaveTypeIds: string[];
  },
) {
  if (!p.id) throw new Error('Combined limit id is required.');
  const name = cleanName(p.name, 'Combined limit name');
  const totalLimitDays = cleanLimitDays(p.totalLimitDays);
  const maxDaysPerApplication = cleanMaxDaysPerApplication(p.maxDaysPerApplication);
  const leaveTypeIds = cleanMemberTypeIds(p.leaveTypeIds);
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ benefitSchemeId: schemeLeaveCombinedLimit.benefitSchemeId })
      .from(schemeLeaveCombinedLimit)
      .where(eq(schemeLeaveCombinedLimit.id, p.id))
      .limit(1);
    if (!existing) throw new Error('Combined limit not found.');
    await tx
      .update(schemeLeaveCombinedLimit)
      .set({ name, totalLimitDays, maxDaysPerApplication })
      .where(eq(schemeLeaveCombinedLimit.id, p.id));
    await replaceCombinedLimitMembers(tx, ctx.tenantId, p.id, existing.benefitSchemeId, leaveTypeIds);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'scheme-leave-combined-limit',
      aggregateId: p.id,
      eventType: 'scheme-leave-combined-limit.updated',
      actor: actorOf(ctx),
      payload: { name, totalLimitDays, maxDaysPerApplication, leaveTypeIds },
    });
  });
}

export async function deleteSchemeCombinedLimit(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    // Members cascade via FK. The pool row delete is the audited write.
    await tx.delete(schemeLeaveCombinedLimit).where(eq(schemeLeaveCombinedLimit.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'scheme-leave-combined-limit',
      aggregateId: p.id,
      eventType: 'scheme-leave-combined-limit.deleted',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}

// ── DnD grouping entrypoints (R47 d6f88c2f) ───────────────────────────────────────────────────────────
// The drag-and-drop entitlement table replaces the standalone Combined Limits section. Two narrow writes
// back it: MOVE one leave type between pools (or out of its pool), and CREATE a pool from dragged rows even
// when a dragged type already belongs to another pool. Both respect the invariants the old forms enforced:
// a type is in at most ONE pool per scheme (DB unique), and a pool always has ≥2 members — a pool left with
// fewer than 2 members after a detach is DISSOLVED (deleted), never persisted as a 1-member pool.

/** Detach a leave type from whatever pool it is in within the scheme. Dissolves the source pool when the
 *  detach leaves it under the 2-member minimum. Appends the pool's `.deleted` event on dissolve (the same
 *  audit shape deleteSchemeCombinedLimit emits); the caller appends its own move/regroup event. */
async function detachTypeFromPool(
  tx: Tx,
  ctx: SessionContext,
  benefitSchemeId: string,
  leaveTypeId: string,
): Promise<{ fromCombinedLimitId: string | null; dissolvedCombinedLimitId: string | null }> {
  const [member] = await tx
    .select({ id: schemeLeaveCombinedLimitMember.id, combinedLimitId: schemeLeaveCombinedLimitMember.combinedLimitId })
    .from(schemeLeaveCombinedLimitMember)
    .where(
      and(
        eq(schemeLeaveCombinedLimitMember.benefitSchemeId, benefitSchemeId),
        eq(schemeLeaveCombinedLimitMember.leaveTypeId, leaveTypeId),
      ),
    )
    .limit(1);
  if (!member) return { fromCombinedLimitId: null, dissolvedCombinedLimitId: null };
  await tx.delete(schemeLeaveCombinedLimitMember).where(eq(schemeLeaveCombinedLimitMember.id, member.id));
  const remaining = await tx
    .select({ id: schemeLeaveCombinedLimitMember.id })
    .from(schemeLeaveCombinedLimitMember)
    .where(eq(schemeLeaveCombinedLimitMember.combinedLimitId, member.combinedLimitId));
  if (remaining.length >= 2) return { fromCombinedLimitId: member.combinedLimitId, dissolvedCombinedLimitId: null };
  await tx.delete(schemeLeaveCombinedLimit).where(eq(schemeLeaveCombinedLimit.id, member.combinedLimitId));
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'scheme-leave-combined-limit',
    aggregateId: member.combinedLimitId,
    eventType: 'scheme-leave-combined-limit.deleted',
    actor: actorOf(ctx),
    payload: { dissolvedBy: 'member-detach', leaveTypeId },
  });
  return { fromCombinedLimitId: member.combinedLimitId, dissolvedCombinedLimitId: member.combinedLimitId };
}

/** Move one leave type into an existing pool (`toCombinedLimitId`) or out of its pool (`null` = ungroup).
 *  A single drag never round-trips the whole member set: the source membership is detached (dissolving a
 *  now-under-minimum pool) and, for a move, one member row is inserted into the target. No-ops quietly when
 *  nothing changes (already in the target pool / ungrouping an ungrouped type). */
export async function moveCombinedLimitMember(
  ctx: SessionContext,
  p: { benefitSchemeId: string; leaveTypeId: string; toCombinedLimitId: string | null },
) {
  if (!p.benefitSchemeId) throw new Error('Benefit scheme is required.');
  if (!p.leaveTypeId) throw new Error('Leave type is required.');
  return withTenant(ctx, async (tx) => {
    if (p.toCombinedLimitId) {
      const [target] = await tx
        .select({ id: schemeLeaveCombinedLimit.id })
        .from(schemeLeaveCombinedLimit)
        .where(
          and(
            eq(schemeLeaveCombinedLimit.id, p.toCombinedLimitId),
            eq(schemeLeaveCombinedLimit.benefitSchemeId, p.benefitSchemeId),
          ),
        )
        .limit(1);
      if (!target) throw new Error('Combined limit not found in this scheme.');
    }
    const [current] = await tx
      .select({ combinedLimitId: schemeLeaveCombinedLimitMember.combinedLimitId })
      .from(schemeLeaveCombinedLimitMember)
      .where(
        and(
          eq(schemeLeaveCombinedLimitMember.benefitSchemeId, p.benefitSchemeId),
          eq(schemeLeaveCombinedLimitMember.leaveTypeId, p.leaveTypeId),
        ),
      )
      .limit(1);
    const from = current?.combinedLimitId ?? null;
    if (from === p.toCombinedLimitId) return; // no-op: nothing to move
    const detach = await detachTypeFromPool(tx, ctx, p.benefitSchemeId, p.leaveTypeId);
    if (p.toCombinedLimitId) {
      await tx.insert(schemeLeaveCombinedLimitMember).values({
        tenantId: ctx.tenantId,
        combinedLimitId: p.toCombinedLimitId,
        benefitSchemeId: p.benefitSchemeId,
        leaveTypeId: p.leaveTypeId,
      });
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'scheme-leave-combined-limit',
      // The pool that gained the member, else the pool that lost it (pure ungroup).
      aggregateId: p.toCombinedLimitId ?? from ?? p.benefitSchemeId,
      eventType: 'scheme-leave-combined-limit.member.moved',
      actor: actorOf(ctx),
      payload: {
        benefitSchemeId: p.benefitSchemeId,
        leaveTypeId: p.leaveTypeId,
        fromCombinedLimitId: from,
        toCombinedLimitId: p.toCombinedLimitId,
        dissolvedCombinedLimitId: detach.dissolvedCombinedLimitId,
      },
    });
  });
}

/** Create a pool from dragged rows. Same validation as createSchemeCombinedLimit, but each chosen type is
 *  first DETACHED from any pool it already belongs to in the scheme (dissolving under-minimum pools), so a
 *  grouped row can be dragged straight onto an ungrouped one to form a fresh group. The group name is
 *  supplied by the caller (the UI auto-names from the member leave-type names, editable before save). */
export async function groupSchemeLeaveTypes(
  ctx: SessionContext,
  p: {
    benefitSchemeId: string;
    name: string;
    totalLimitDays: number;
    /** 0327: optional per-application cap, set from the same create dialog. Blank ⇒ uncapped. */
    maxDaysPerApplication?: number | null;
    leaveTypeIds: string[];
  },
) {
  if (!p.benefitSchemeId) throw new Error('Benefit scheme is required.');
  const name = cleanName(p.name, 'Combined limit name');
  const totalLimitDays = cleanLimitDays(p.totalLimitDays);
  const maxDaysPerApplication = cleanMaxDaysPerApplication(p.maxDaysPerApplication);
  const leaveTypeIds = cleanMemberTypeIds(p.leaveTypeIds);
  return withTenant(ctx, async (tx) => {
    const dissolved: string[] = [];
    for (const leaveTypeId of leaveTypeIds) {
      const d = await detachTypeFromPool(tx, ctx, p.benefitSchemeId, leaveTypeId);
      if (d.dissolvedCombinedLimitId) dissolved.push(d.dissolvedCombinedLimitId);
    }
    const [row] = await tx
      .insert(schemeLeaveCombinedLimit)
      .values({ tenantId: ctx.tenantId, benefitSchemeId: p.benefitSchemeId, name, totalLimitDays, maxDaysPerApplication })
      .returning({ id: schemeLeaveCombinedLimit.id });
    await replaceCombinedLimitMembers(tx, ctx.tenantId, row.id, p.benefitSchemeId, leaveTypeIds);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'scheme-leave-combined-limit',
      aggregateId: row.id,
      eventType: 'scheme-leave-combined-limit.created',
      actor: actorOf(ctx),
      payload: {
        benefitSchemeId: p.benefitSchemeId,
        name,
        totalLimitDays,
        maxDaysPerApplication,
        leaveTypeIds,
        ...(dissolved.length ? { dissolvedCombinedLimitIds: dissolved } : {}),
      },
    });
    return row;
  });
}

// ── Employee ↔ scheme override ────────────────────────────────────────────────────────────────────────
/** Manually assign (or clear) an employee's benefit scheme override. null ⇒ revert to auto-match.
 *
 *  ae5b84d5: when the override actually CHANGES, the employee's current-cycle balance is trued up
 *  immediately (reprojectEntitlementForEmployment) — best-effort AFTER the write commits, following the
 *  recalcAfterProfileChange pattern in the personnel actions: a recalc hiccup never fails the assignment
 *  (the correction is idempotent and self-heals on the next trigger). */
export async function setEmploymentBenefitScheme(
  ctx: SessionContext,
  p: { employmentId: string; benefitSchemeId: string | null },
) {
  const changed = await withTenant(ctx, async (tx) => {
    const [prev] = await tx
      .select({ benefitSchemeId: employment.benefitSchemeId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    await tx
      .update(employment)
      .set({ benefitSchemeId: p.benefitSchemeId })
      .where(eq(employment.id, p.employmentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employment',
      aggregateId: p.employmentId,
      eventType: 'employment.benefit-scheme.assigned',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { before: prev?.benefitSchemeId ?? null, after: p.benefitSchemeId },
    });
    return (prev?.benefitSchemeId ?? null) !== p.benefitSchemeId;
  });
  if (changed) {
    try {
      await reprojectEntitlementForEmployment(ctx, {
        employmentId: p.employmentId,
        trigger: 'benefit_scheme_override',
      });
    } catch {
      // non-fatal — the assignment is committed; the idempotent recalc re-runs on the next trigger.
    }
  }
}

/** All grades (id + name + code) for the grade-group member picker. Read-only. */
export async function listGradesForGroups(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    return tx
      .select({ id: jobGrade.id, code: jobGrade.code, name: jobGrade.name })
      .from(jobGrade)
      .where(sql`${jobGrade.archivedAt} is null`)
      .orderBy(asc(jobGrade.rank));
  });
}
