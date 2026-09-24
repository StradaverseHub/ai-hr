/**
 * SHARED LEAVE GROUPS (r88, feedback 1ef1cf95) — several leave types drawing on ONE pooled allowance.
 *
 * A group is its own thing: a name, a shared annual limit, an optional maximum per application, and a list
 * of the leave types that belong to it. It is TENANT-LEVEL. It is not owned by a benefit scheme, it is not
 * created from inside one, and it does not have to be repeated for every scheme it applies to.
 *
 * WHAT THIS REPLACES. Until r88 the group lived on `scheme_leave_combined_limit` / `_member`, hung off a
 * benefit scheme (0220 / R44 4c48fd1f, extended by r82a 0327). The reporter rejected that shape outright —
 * "I don't want to improve the existing Benefit Scheme selector" — and asked for this one. Migration 0342
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
import { and, asc, eq, inArray, ne, gte, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { leaveRequest, leaveSharedGroup, leaveSharedGroupMember, leaveType } from '../db/schema';
import {
  resolveSharedGroupPlacement,
  sharedGroupAvailableDays,
  sharedGroupCycleWindow,
  type EssPlacement,
} from '../lib/leave-groups';
import { todayInKualaLumpur } from '../lib/hr-date';
import { leaveBalances, pickName } from './read';

/** A shared group as the config surfaces read it. `leaveTypeIds` is the tick list. */
export type LeaveSharedGroupRow = {
  id: string;
  name: string;
  totalLimitDays: number;
  /** null = no per-application cap. */
  maxDaysPerApplication: number | null;
  /** 46afcc48 — WHERE this group is drawn on the employee Leave tab. 'hidden' ⇒ drawn nowhere, which is
   *  what every existing group reads (the column's DEFAULT, migration 0438). Display only. */
  essPlacement: EssPlacement;
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

/** 46afcc48 — WHERE the group is drawn on the employee Leave tab. Unlike a leave TYPE, 'hidden' is a
 *  legitimate STORED value here (a group has no visible_to_employee twin to express it with); the DB CHECK
 *  admits all three. Anything unrecognised — an omitted form field, a tampered post — resolves to Hidden,
 *  which is the safe direction: a group is never revealed to every employee by accident. */
function cleanEssPlacement(v: string | null | undefined): EssPlacement {
  return resolveSharedGroupPlacement(v);
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
        essPlacement: leaveSharedGroup.essPlacement,
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
      essPlacement: resolveSharedGroupPlacement(g.essPlacement),
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
    /** 46afcc48 — where the group is drawn on the employee Leave tab. Omitted ⇒ Hidden, matching the
     *  column DEFAULT: a group created without a deliberate choice appears on nobody's screen. */
    essPlacement?: string | null;
    leaveTypeIds: string[];
  },
) {
  const name = cleanName(p.name);
  const totalLimitDays = cleanTotalLimitDays(p.totalLimitDays);
  const maxDaysPerApplication = cleanMaxDaysPerApplication(p.maxDaysPerApplication);
  const essPlacement = cleanEssPlacement(p.essPlacement);
  const leaveTypeIds = cleanMemberTypeIds(p.leaveTypeIds);
  return withTenant(ctx, async (tx) => {
    await assertTypesUngrouped(tx, leaveTypeIds, null);
    const [row] = await tx
      .insert(leaveSharedGroup)
      .values({ tenantId: ctx.tenantId, name, totalLimitDays, maxDaysPerApplication, essPlacement })
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
      payload: { name, totalLimitDays, maxDaysPerApplication, essPlacement, leaveTypeIds },
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
    /** ABSOLUTE, like every other field on this action: omitted ⇒ Hidden, NOT "leave as it was". Any form
     *  posting this must carry the control (a <select> always submits, which is why one was used rather
     *  than a checkbox — trap 17: a field that is always sent cannot be read by presence). */
    essPlacement?: string | null;
    leaveTypeIds: string[];
  },
) {
  if (!p.id) throw new Error('Shared leave group id is required.');
  const name = cleanName(p.name);
  const totalLimitDays = cleanTotalLimitDays(p.totalLimitDays);
  const maxDaysPerApplication = cleanMaxDaysPerApplication(p.maxDaysPerApplication);
  const essPlacement = cleanEssPlacement(p.essPlacement);
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
      .set({ name, totalLimitDays, maxDaysPerApplication, essPlacement })
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
      payload: { name, totalLimitDays, maxDaysPerApplication, essPlacement, leaveTypeIds },
    });
  });
}

// ── THE DISPLAY READ (feedback 46afcc48) ─────────────────────────────────────────────────────────────
//
// Until now a shared group was ENFORCEMENT ONLY: it refused applications past its ceiling and appeared on
// no employee screen. The reporter asked to see the pot itself — "Special Leave" as ONE balance — with its
// six member types still shown or hidden individually, and hiding them changing nothing about the pot.
//
// THIS FUNCTION LIVES IN THIS FILE ON PURPOSE. `test/shared-leave-group-single-mechanism.test.ts` pins
// that exactly two core modules touch `leaveSharedGroupMember`: this one, which CONFIGURES, and
// core/leave.ts, which ENFORCES. Putting a third reader in core/read.ts would have failed that guard, and
// the guard is right: the fewer modules that can read the group, the fewer can start disagreeing about it.

/** One shared group as the employee's Leave tab draws it. */
export type SharedLeaveGroupBalance = {
  id: string;
  name: string;
  /** Where to draw it. 'hidden' groups are never returned — the caller cannot forget to filter. */
  placement: Exclude<EssPlacement, 'hidden'>;
  /** The configured shared ceiling. Shown as context ("of 10.00"), never as the available figure. */
  totalLimitDays: number;
  /** null = no per-application cap. */
  maxDaysPerApplication: number | null;
  /** WHAT IS GENUINELY LEFT — see `sharedGroupAvailableDays`. NOT `totalLimitDays`. */
  available: number;
  /** Pending + approved days already committed across every member type this cycle. */
  usedDays: number;
  /** EVERY member type's name in the viewer's locale, name-ordered — including the ones HR has hidden.
   *  The pot is what it is; naming only the visible half would describe a different pot. */
  memberNames: string[];
  /**
   * 76dbcaa1 — the SAME members, with their ids, so a caller can offer one Apply action per reason.
   *
   * Identical set and identical order to `memberNames` (both are built from one list in one pass), and
   * hidden members are in it for the reason above: the employee may still APPLY for a member type whose
   * balance card HR has hidden — hiding a card is a presentation choice, never an entitlement one, and
   * a reason list that silently dropped half the pot would be describing a different pot again.
   *
   * `memberNames` is deliberately kept: 46afcc48's card renders a comma-joined sentence and has no use
   * for ids, and removing it would push that join into every caller.
   */
  members: { id: string; name: string }[];
};

/**
 * The shared-group balances for ONE employment, ready to render.
 *
 * ⚠️ MEMBER VISIBILITY IS NOT AN INPUT TO ANY FIGURE HERE, and that is the reporter's central requirement.
 * `leaveBalances` is called with `includeHidden: true` so the member sum covers every member type whether
 * or not HR has hidden it from the employee's screens. Summing the filtered list instead would make this
 * number shrink when a type is hidden while `enforceSharedLeaveGroupLimit` — which has never consulted
 * visibility — kept allowing the same applications. A displayed figure that disagrees with the engine's
 * verdict is the exact failure this whole area is built to avoid. No hidden type's own name or balance is
 * disclosed: they are summed into one figure and `memberNames` is the group's membership, which the
 * employee is being told about by definition.
 *
 * ⚠️ AND IT CHANGES NOTHING ABOUT ENFORCEMENT. This is a read. The ceiling, the per-application cap and
 * both refusals live in core/leave.ts and are untouched by 46afcc48.
 *
 * COST: two small queries, and the balance read only when a non-hidden group actually exists — so every
 * tenant with no groups (and every tenant whose groups are still Hidden, which is all of them on the day
 * this ships) pays two indexed lookups and nothing else.
 */
export async function sharedLeaveGroupBalances(
  ctx: SessionContext,
  employmentId: string,
  opts: {
    locale?: string;
    /** Point-in-time cut passed through to `leaveBalances` for the member sum, and the date whose CALENDAR
     *  YEAR is the group's cycle. Omit for today. */
    asOf?: string;
  } = {},
): Promise<SharedLeaveGroupBalance[]> {
  const onDate = opts.asOf ?? todayInKualaLumpur();
  const { start: windowStart, end: windowEnd } = sharedGroupCycleWindow(onDate);

  // Step 1 — the groups that are actually drawn, with their members and this employee's usage. All of it
  // in one withTenant so the three reads see one snapshot.
  const shown = await withTenant(ctx, async (tx) => {
    const groups = await tx
      .select({
        id: leaveSharedGroup.id,
        name: leaveSharedGroup.name,
        totalLimitDays: leaveSharedGroup.totalLimitDays,
        maxDaysPerApplication: leaveSharedGroup.maxDaysPerApplication,
        essPlacement: leaveSharedGroup.essPlacement,
      })
      .from(leaveSharedGroup)
      .orderBy(asc(leaveSharedGroup.name));
    const visible = groups.filter((g) => resolveSharedGroupPlacement(g.essPlacement) !== 'hidden');
    if (visible.length === 0) return null;
    const groupIds = visible.map((g) => g.id);

    // Members, with the name columns the tab prints. `leaveType.i18n` is resolved through the SAME
    // `pickName` every other leave surface uses — see its export note in core/read.ts.
    const members = await tx
      .select({
        groupId: leaveSharedGroupMember.groupId,
        leaveTypeId: leaveSharedGroupMember.leaveTypeId,
        name: leaveType.name,
        i18n: leaveType.i18n,
      })
      .from(leaveSharedGroupMember)
      .innerJoin(leaveType, eq(leaveType.id, leaveSharedGroupMember.leaveTypeId))
      .where(inArray(leaveSharedGroupMember.groupId, groupIds))
      .orderBy(asc(leaveType.name));

    // Usage per group — the SAME measure `enforceSharedLeaveGroupLimit` takes: pending + approved days
    // across every member type whose request STARTS inside the cycle. Deliberately NOT cut at `asOf`:
    // the guard counts the whole cycle, and a figure cut differently would announce room the guard then
    // refuses to give.
    const usage = await tx
      .select({
        groupId: leaveSharedGroupMember.groupId,
        used: sql<string>`coalesce(sum(${leaveRequest.days}), 0)`,
      })
      .from(leaveSharedGroupMember)
      .innerJoin(leaveRequest, eq(leaveRequest.leaveTypeId, leaveSharedGroupMember.leaveTypeId))
      .where(
        and(
          inArray(leaveSharedGroupMember.groupId, groupIds),
          eq(leaveRequest.employmentId, employmentId),
          inArray(leaveRequest.status, ['pending', 'approved']),
          gte(leaveRequest.startDate, windowStart),
          lte(leaveRequest.startDate, windowEnd),
        ),
      )
      .groupBy(leaveSharedGroupMember.groupId);

    return { visible, members, usage };
  });
  if (!shown) return [];

  // Step 2 — the member types' own Available figures, UNFILTERED by visibility. See the warning above.
  // ec991c2a — `includeArchived` here for the SAME reason as `includeHidden`, and it is the one
  // SELF-SERVICE caller that opts out of that gate. This sum displays no leave-type name: it produces ONE
  // pooled figure for a shared group. The group guard (`enforceSharedLeaveGroupLimit`) has never consulted
  // `archived_at` — no more than it consults `visible_to_employee` — so summing the FILTERED list would put
  // a number on screen that disagrees with the verdict the engine gives, which is the one thing that must
  // not happen. No archived type's own name or per-type figure reaches the employee through this path.
  // d272834b — `includeIneligible` for the THIRD time and the same argument: this sum must not depend on
  // which cards happen to be drawn. `enforceSharedLeaveGroupLimit` has never consulted eligibility any
  // more than it consults `visible_to_employee` or `archived_at`, so summing the FILTERED list would put
  // a number on screen that disagrees with the verdict the engine gives. No ineligible type's own name or
  // per-type figure reaches the employee through this path.
  const balances = await leaveBalances(ctx, employmentId, opts.locale, {
    includeHidden: true,
    includeArchived: true,
    includeIneligible: true,
    ...(opts.asOf ? { asOf: opts.asOf } : {}),
  });
  const availableByType = new Map(balances.map((b) => [b.leaveTypeId, b.available]));
  const usedByGroup = new Map(shown.usage.map((u) => [u.groupId, Number(u.used ?? 0)]));

  const out: SharedLeaveGroupBalance[] = [];
  for (const g of shown.visible) {
    const placement = resolveSharedGroupPlacement(g.essPlacement);
    if (placement === 'hidden') continue; // unreachable (filtered above); kept so the type narrows honestly
    const mine = shown.members.filter((m) => m.groupId === g.id);
    // A member type the employee has no ledger row, no request and no eligibility for contributes 0 —
    // absent from `leaveBalances` is "nothing available from this type", not "unknown".
    const memberAvailableSum = mine.reduce((sum, m) => sum + (availableByType.get(m.leaveTypeId) ?? 0), 0);
    const totalLimitDays = Number(g.totalLimitDays);
    const usedDays = usedByGroup.get(g.id) ?? 0;
    out.push({
      id: g.id,
      name: g.name,
      placement,
      totalLimitDays,
      maxDaysPerApplication: g.maxDaysPerApplication == null ? null : Number(g.maxDaysPerApplication),
      available: sharedGroupAvailableDays({ totalLimitDays, usedDays, memberAvailableSum }),
      usedDays,
      memberNames: mine.map((m) => pickName(m.name, m.i18n as Record<string, { name: string }> | null, opts.locale)),
      // 76dbcaa1 — one pass, so the two can never describe different memberships.
      members: mine.map((m) => ({
        id: m.leaveTypeId,
        name: pickName(m.name, m.i18n as Record<string, { name: string }> | null, opts.locale),
      })),
    });
  }
  return out;
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
