/**
 * SHARED LEAVE GROUPS (r88, feedback 1ef1cf95) — several leave types drawing on ONE pooled allowance.
 *
 * A group is its own thing: a name, a shared annual limit, an optional maximum per application, and a list
 * of the leave types that belong to it. It is TENANT-LEVEL. It is not owned by a benefit scheme, it is not
 * created from inside one, and it does not have to be repeated for every scheme it applies to.
 *
 * WHAT THIS REPLACES. Until r88 the group lived on `scheme_leave_combined_limit` / `_member`, hung off a
 * benefit scheme (0220 / R44 4c48fd1f, extended by r82a 0327). The reporter rejected that shape outright —
 * "I don't want to improve the existing Benefit Scheme selector" — and asked for this one. Migration 0339
 * created the new tables, archived the old configuration into `leave_shared_group_reset_archive` and dropped
 * the old tables; the reset was part of the request, not a side effect.
 *
 * WHAT MOVING IT COSTS, stated plainly because it is not recoverable from the columns: dropping the
 * benefit-scheme dimension removes a PER-EMPLOYEE dimension. Before, two employees on different schemes
 * could have different shared limits over the same leave types. Now they cannot — one group, one rule,
 * tenant-wide. The reporter's description ("Special Leave, 10 days shared, maximum 3 per application, tick
 * the types it covers") is a single global rule, and that is what is built.
 *
 * WHAT DID NOT CHANGE. The two rules the group enforces, and both places they are enforced — at APPLY and
 * again at APPROVAL (`enforceSharedLeaveGroupLimit`, core/leave.ts). That half is proven and was re-pointed
 * at the new tables, not rewritten. Entitlement is untouched: a group caps what may be TAKEN and never says
 * how many days are GRANTED.
 *
 * A LEAVE TYPE BELONGS TO AT MOST ONE GROUP. Enforced by a unique index on (tenant, leave_type) — the
 * deduction path has no defined behaviour for a type in two pools — and surfaced BY NAME here, so the admin
 * is told "Marriage Leave is already in Special Leave" rather than being silently moved or shown a
 * constraint violation.
 *
 * Every state-changing function runs under withTenant and appends a DomainEvent (substrate discipline).
 */
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { leaveSharedGroup, leaveSharedGroupMember, leaveType } from '../db/schema';

/** A shared group as the config surfaces read it. `leaveTypeIds` is the tick list. */
export type LeaveSharedGroupRow = {
  id: string;
  name: string;
  totalLimitDays: number;
  /** null = no per-application cap. */
  maxDaysPerApplication: number | null;
  leaveTypeIds: string[];
};

/**
 * A chosen leave type is already in another group. Carries BOTH names so the caller can say which type and
 * which group without a second query — the plan's "we will tell you which one rather than silently moving
 * it". A named class (not a bare Error) so the action layer can localize it; `message` stays readable for
 * anything that only logs.
 */
export class LeaveTypeAlreadyGroupedError extends Error {
  readonly leaveTypeName: string;
  readonly groupName: string;
  constructor(leaveTypeName: string, groupName: string) {
    super(`${leaveTypeName} already belongs to the shared leave group "${groupName}".`);
    this.name = 'LeaveTypeAlreadyGroupedError';
    this.leaveTypeName = leaveTypeName;
    this.groupName = groupName;
  }
}

/** Two groups with the same name are indistinguishable in every error message and every picker. */
export class LeaveSharedGroupNameTakenError extends Error {
  readonly groupName: string;
  constructor(groupName: string) {
    super(`A shared leave group named "${groupName}" already exists.`);
    this.name = 'LeaveSharedGroupNameTakenError';
    this.groupName = groupName;
  }
}

function cleanName(v: string | undefined): string {
  const s = (v ?? '').trim();
  if (!s) throw new Error('Shared leave group name is required.');
  if (s.length > 120) throw new Error('Shared leave group name must be 120 characters or fewer.');
  return s;
}

/** The shared annual allowance. Zero or negative would refuse every application of every member type, which
 *  is a mistake rather than a policy, so it is rejected loudly instead of stored. */
function cleanTotalLimitDays(v: number | undefined): string {
  if (v == null || !Number.isFinite(v) || v <= 0) {
    throw new Error('Shared leave group: the shared annual limit must be greater than zero.');
  }
  if (v > 999) throw new Error('Shared leave group: the shared annual limit is too large.');
  return v.toFixed(2);
}

/** The per-application cap. "Unset" is a legitimate — indeed the default — answer here: null ⇒ no cap. */
function cleanMaxDaysPerApplication(v: number | null | undefined): string | null {
  if (v == null) return null;
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error('Shared leave group: maximum days per application must be greater than zero (leave it blank for no cap).');
  }
  if (v > 999) throw new Error('Shared leave group: maximum days per application is too large.');
  return v.toFixed(2);
}

function cleanMemberTypeIds(ids: string[] | undefined): string[] {
  const unique = [...new Set((ids ?? []).filter(Boolean))];
  if (unique.length < 2) {
    throw new Error('Shared leave group: pick at least two leave types to share the allowance.');
  }
  return unique;
}

/** The SQLSTATE lives on `.cause` once drizzle wraps the driver error (DrizzleQueryError) — the `.code`-only
 *  check that predates this helper never matched and let the raw query error leak through. */
const isUniqueViolation = (e: unknown): boolean => {
  const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return String(code) === '23505';
};

/**
 * Refuse a member set that would put a leave type in two groups, naming the type and the group it is
 * already in. `excludeGroupId` is the group being edited — its OWN members are not a clash with itself.
 *
 * The DB unique index is still the authority (this read is not serialisable against a concurrent write);
 * this exists so the ordinary case produces a sentence a human can act on, and the index is the backstop.
 */
async function assertTypesUngrouped(
  tx: Tx,
  leaveTypeIds: string[],
  excludeGroupId: string | null,
): Promise<void> {
  const clashes = await tx
    .select({ leaveTypeName: leaveType.name, groupName: leaveSharedGroup.name })
    .from(leaveSharedGroupMember)
    .innerJoin(leaveSharedGroup, eq(leaveSharedGroup.id, leaveSharedGroupMember.groupId))
    .innerJoin(leaveType, eq(leaveType.id, leaveSharedGroupMember.leaveTypeId))
    .where(
      and(
        inArray(leaveSharedGroupMember.leaveTypeId, leaveTypeIds),
        ...(excludeGroupId ? [ne(leaveSharedGroupMember.groupId, excludeGroupId)] : []),
      ),
    )
    .limit(1);
  if (clashes.length > 0) {
    throw new LeaveTypeAlreadyGroupedError(clashes[0].leaveTypeName, clashes[0].groupName);
  }
}

/** Replace a group's member leave types wholesale (the tick list is an absolute set, not a patch). */
async function replaceMembers(tx: Tx, tenantId: string, groupId: string, leaveTypeIds: string[]) {
  await tx.delete(leaveSharedGroupMember).where(eq(leaveSharedGroupMember.groupId, groupId));
  if (leaveTypeIds.length === 0) return;
  await tx
    .insert(leaveSharedGroupMember)
    .values(leaveTypeIds.map((leaveTypeId) => ({ tenantId, groupId, leaveTypeId })))
    .catch((e) => {
      // The named-clash path above handles the ordinary case; this is the race backstop, and it must not
      // pretend to know which type clashed (it does not).
      if (isUniqueViolation(e)) {
        throw new Error('Shared leave group: one of the chosen leave types just joined another group.');
      }
      throw e;
    });
}

/** Read-only — no events (the substrate skip rule). */
export async function listLeaveSharedGroups(ctx: SessionContext): Promise<LeaveSharedGroupRow[]> {
  return withTenant(ctx, async (tx) => {
    const groups = await tx
      .select({
        id: leaveSharedGroup.id,
        name: leaveSharedGroup.name,
        totalLimitDays: leaveSharedGroup.totalLimitDays,
        maxDaysPerApplication: leaveSharedGroup.maxDaysPerApplication,
      })
      .from(leaveSharedGroup)
      .orderBy(asc(leaveSharedGroup.name));
    if (groups.length === 0) return [];
    const members = await tx
      .select({ groupId: leaveSharedGroupMember.groupId, leaveTypeId: leaveSharedGroupMember.leaveTypeId })
      .from(leaveSharedGroupMember)
      .where(
        inArray(
          leaveSharedGroupMember.groupId,
          groups.map((g) => g.id),
        ),
      );
    const byGroup = new Map<string, string[]>();
    for (const m of members) {
      const arr = byGroup.get(m.groupId);
      if (arr) arr.push(m.leaveTypeId);
      else byGroup.set(m.groupId, [m.leaveTypeId]);
    }
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      totalLimitDays: Number(g.totalLimitDays),
      maxDaysPerApplication: g.maxDaysPerApplication == null ? null : Number(g.maxDaysPerApplication),
      leaveTypeIds: byGroup.get(g.id) ?? [],
    }));
  });
}

export async function createLeaveSharedGroup(
  ctx: SessionContext,
  p: {
    name: string;
    totalLimitDays: number;
    /** Omit or null for an uncapped group. */
    maxDaysPerApplication?: number | null;
    leaveTypeIds: string[];
  },
) {
  const name = cleanName(p.name);
  const totalLimitDays = cleanTotalLimitDays(p.totalLimitDays);
  const maxDaysPerApplication = cleanMaxDaysPerApplication(p.maxDaysPerApplication);
  const leaveTypeIds = cleanMemberTypeIds(p.leaveTypeIds);
  return withTenant(ctx, async (tx) => {
    await assertTypesUngrouped(tx, leaveTypeIds, null);
    const [row] = await tx
      .insert(leaveSharedGroup)
      .values({ tenantId: ctx.tenantId, name, totalLimitDays, maxDaysPerApplication })
      .returning({ id: leaveSharedGroup.id })
      .catch((e) => {
        if (isUniqueViolation(e)) throw new LeaveSharedGroupNameTakenError(name);
        throw e;
      });
    await replaceMembers(tx, ctx.tenantId, row.id, leaveTypeIds);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-shared-group',
      aggregateId: row.id,
      eventType: 'leave-shared-group.created',
      actor: actorOf(ctx),
      payload: { name, totalLimitDays, maxDaysPerApplication, leaveTypeIds },
    });
    return row;
  });
}

export async function updateLeaveSharedGroup(
  ctx: SessionContext,
  p: {
    id: string;
    name: string;
    totalLimitDays: number;
    /** ABSOLUTE set, not a patch — null clears the cap. Any form posting this action must carry the field
     *  (visible or hidden), or saving the name would silently drop the cap. */
    maxDaysPerApplication?: number | null;
    leaveTypeIds: string[];
  },
) {
  if (!p.id) throw new Error('Shared leave group id is required.');
  const name = cleanName(p.name);
  const totalLimitDays = cleanTotalLimitDays(p.totalLimitDays);
  const maxDaysPerApplication = cleanMaxDaysPerApplication(p.maxDaysPerApplication);
  const leaveTypeIds = cleanMemberTypeIds(p.leaveTypeIds);
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: leaveSharedGroup.id })
      .from(leaveSharedGroup)
      .where(eq(leaveSharedGroup.id, p.id))
      .limit(1);
    if (!existing) throw new Error('Shared leave group not found.');
    await assertTypesUngrouped(tx, leaveTypeIds, p.id);
    await tx
      .update(leaveSharedGroup)
      .set({ name, totalLimitDays, maxDaysPerApplication })
      .where(eq(leaveSharedGroup.id, p.id))
      .catch((e) => {
        if (isUniqueViolation(e)) throw new LeaveSharedGroupNameTakenError(name);
        throw e;
      });
    await replaceMembers(tx, ctx.tenantId, p.id, leaveTypeIds);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-shared-group',
      aggregateId: p.id,
      eventType: 'leave-shared-group.updated',
      actor: actorOf(ctx),
      payload: { name, totalLimitDays, maxDaysPerApplication, leaveTypeIds },
    });
  });
}

export async function deleteLeaveSharedGroup(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    // Members cascade via FK. The group row delete is the audited write.
    await tx.delete(leaveSharedGroup).where(eq(leaveSharedGroup.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-shared-group',
      aggregateId: p.id,
      eventType: 'leave-shared-group.deleted',
      actor: actorOf(ctx),
      payload: {},
    });
  });
}
