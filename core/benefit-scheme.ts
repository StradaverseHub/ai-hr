/**
 * Grade groups — the leave APPROVAL-ROUTING scope.
 *
 * ⚠️ THE FILENAME IS NOW A LIE, AND THAT IS DELIBERATE FOR ONE ROUND. This module was the benefit-scheme
 * entitlement layer. 6e9a126e release three dropped that layer entirely — benefit_scheme,
 * scheme_leave_entitlement, leave_policy and employment.benefit_scheme_id are gone — and what remains here
 * is grade groups and nothing else. Renaming the file to core/grade-group.ts is the obvious follow-up; it
 * is held back only so this release's diff stays about the removal rather than about ~10 import rewrites.
 *
 * WHY GRADE GROUPS SURVIVED A RELEASE THAT DELETED EVERYTHING AROUND THEM: 205 live leave_approval_policy
 * rows scope by them. Dropping them would have silently unscoped every one of those approval rules and
 * forced HR to rebuild each by hand. They are plain organisation grade banding now — they no longer select
 * an entitlement. Entitlement targeting is entitlement_eligibility_rule's job.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import {
  employment,
  gradeGroup,
  gradeGroupMember,
  jobGrade,
  leaveType,
} from '../db/schema';
import { isWellFormedBands, MAX_SERVICE_BANDS, type ServiceBand } from './leave-compute';
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

/** Validate a scheme entitlement's service bands (contiguous from 0, open-ended last, ≤MAX_SERVICE_BANDS). Reuses the
 *  engine's `isWellFormedBands` so a scheme entitlement can never persist a shape the resolver would reject. */
function validateBands(bands: ServiceBand[]): void {
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new Error('Leave entitlement: provide at least one service band.');
  }
  if (!isWellFormedBands(bands)) {
    throw new Error(
      `Leave entitlement: bands must be contiguous, start at 0 years, end open-ended, and have zero/positive days (at most ${MAX_SERVICE_BANDS} bands).`,
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
