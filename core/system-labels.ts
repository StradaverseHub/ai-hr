/**
 * Shared System Labels — the multi-company assignment resolver + mutations (ADR-0073, feedback d356dec8).
 *
 * PHASE 2 of the phased rollout in the approved plan. The org labels (department / position / cost_center /
 * business_unit) each keep a single ORIGIN company_id; a `label_company_assignment` junction gives a label
 * ADDITIONAL companies that may use it; and an `is_global` flag on each label = "All Companies". This module
 * owns the resolver that every consumer reads through, and the assign/unassign/copy/global mutations.
 *
 * SAFETY — the flag: with company.shared_system_labels OFF for a target company, `labelsForCompany` returns
 * ORIGIN-ONLY rows for that company (junction + global are ignored), so behaviour is byte-identical to today.
 * Only when an admin turns the flag on does a label shared into that company become visible there. This is
 * what keeps Phase 2 shippable ahead of the Phase 4 grid UI: nothing changes for any consumer until the flag
 * is flipped per company.
 *
 * SUBSTRATE: every write appends a DomainEvent (ADR-0006). These are company/tenant-level events with no
 * single employee subject, so subjectEmploymentId is left undefined (admin-only reads — correct, fail-closed).
 */
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  assignment,
  businessUnit,
  company,
  costCenter,
  department,
  employment,
  labelCompanyAssignment,
  position,
  LABEL_KINDS,
  type LabelKind,
} from '../db/schema';

export { LABEL_KINDS, type LabelKind } from '../db/schema';

/** Thrown when an unassign/delete would strip a company that still USES the label (data-integrity guard). */
export class LabelInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabelInUseError';
  }
}

/** Thrown when a label_id / label_kind does not resolve to a real row in the tenant. */
export class UnknownLabelError extends Error {
  constructor() {
    super('The system label does not exist.');
    this.name = 'UnknownLabelError';
  }
}

/** Map a kind → the Drizzle table + the assignment FK column name used by the in-use guard. */
const KIND_TABLE = {
  department: department,
  position: position,
  cost_center: costCenter,
  business_unit: businessUnit,
} as const;

/** The `assignment` typed column that references each label kind (business_unit is referenced via department). */
const ASSIGNMENT_FK = {
  department: assignment.departmentId,
  position: assignment.positionId,
  cost_center: assignment.costCenterId,
  business_unit: null, // BUs are used indirectly (department.business_unit_id) — guarded separately below.
} as const;

/** kebab-case aggregateType for the substrate (matches the existing create/update events' aggregateType). */
function aggForKind(kind: LabelKind): string {
  return kind === 'cost_center' ? 'cost-center' : kind === 'business_unit' ? 'business-unit' : kind;
}

function assertKind(kind: string): asserts kind is LabelKind {
  if (!(LABEL_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown system-label kind “${kind}”.`);
}

/** Load a label row's origin company + is_global, or throw if it does not exist in the tenant. */
async function loadLabel(
  tx: Tx,
  tenantId: string,
  kind: LabelKind,
  labelId: string,
): Promise<{ companyId: string; isGlobal: boolean }> {
  const table = KIND_TABLE[kind];
  const [row] = await tx
    .select({ companyId: table.companyId, isGlobal: table.isGlobal })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), eq(table.id, labelId)))
    .limit(1);
  if (!row) throw new UnknownLabelError();
  return row;
}

/**
 * Resolve the set of company ids that MAY use a given label = origin ∪ junction ∪ (all-tenant if is_global).
 * Read path for the assignment editor / grid. Tenant-wide read (RLS-legal for non-admins too).
 */
export function companiesForLabel(ctx: SessionContext, kind: string, labelId: string): Promise<string[]> {
  assertKind(kind);
  return withTenant(ctx, async (tx) => {
    const label = await loadLabel(tx, ctx.tenantId, kind, labelId);
    if (label.isGlobal) {
      const rows = await tx.select({ id: company.id }).from(company).where(eq(company.tenantId, ctx.tenantId));
      return rows.map((r) => r.id);
    }
    const junction = await tx
      .select({ companyId: labelCompanyAssignment.companyId })
      .from(labelCompanyAssignment)
      .where(
        and(
          eq(labelCompanyAssignment.tenantId, ctx.tenantId),
          eq(labelCompanyAssignment.labelKind, kind),
          eq(labelCompanyAssignment.labelId, labelId),
        ),
      );
    return Array.from(new Set([label.companyId, ...junction.map((j) => j.companyId)]));
  });
}

/**
 * Resolve the label ids of a given kind that a company MAY use.
 *
 *   flag OFF for `companyId`  →  ORIGIN-ONLY (labels whose company_id = companyId). Byte-identical to today.
 *   flag ON                   →  origin ∪ junction (labels assigned to the company) ∪ global (is_global).
 *
 * Every consumer that today filters `inArray(<table>.company_id, companyIds)` migrates to this so a shared
 * label surfaces in the companies it was shared into — but only once that company opts in via the flag.
 */
export function labelIdsForCompany(ctx: SessionContext, kind: string, companyId: string): Promise<string[]> {
  assertKind(kind);
  const table = KIND_TABLE[kind];
  return withTenant(ctx, async (tx) => {
    const [co] = await tx
      .select({ shared: company.sharedSystemLabels })
      .from(company)
      .where(and(eq(company.tenantId, ctx.tenantId), eq(company.id, companyId)))
      .limit(1);

    // Origin-owned labels (always visible in their own company, flag or not).
    const origin = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, ctx.tenantId), eq(table.companyId, companyId)));
    const ids = new Set(origin.map((r) => r.id));

    if (!co?.shared) return Array.from(ids); // flag off → origin-only, unchanged behaviour.

    // Junction: labels of this kind assigned INTO this company.
    const assigned = await tx
      .select({ id: labelCompanyAssignment.labelId })
      .from(labelCompanyAssignment)
      .where(
        and(
          eq(labelCompanyAssignment.tenantId, ctx.tenantId),
          eq(labelCompanyAssignment.labelKind, kind),
          eq(labelCompanyAssignment.companyId, companyId),
        ),
      );
    for (const r of assigned) ids.add(r.id);

    // Global labels: is_global rows of this kind, tenant-wide.
    const globals = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, ctx.tenantId), eq(table.isGlobal, true)));
    for (const r of globals) ids.add(r.id);

    return Array.from(ids);
  });
}

/**
 * The SQL predicate a consumer's list-read ANDs in to filter a label table to the rows a company set
 * MAY use — the resolver expressed as one WHERE fragment so a consumer stays a single query (no extra
 * round-trip). Union of:
 *   • origin      — `company_id IN (companyIds)`  (always; a label is visible in its own company)
 *   • shared-in   — assigned into a companyId whose `shared_system_labels` flag is ON (junction)
 *   • global      — `is_global = true` AND at least one companyId has the flag ON
 *
 * With the flag OFF for every company in the set, the shared-in and global branches are empty, so the
 * predicate collapses to `company_id IN (companyIds)` — byte-identical to the pre-share behaviour. This
 * is why turning the resolver on for a consumer changes nothing until an admin flips a company's flag.
 */
export function visibleLabelIdsCondition(
  table: typeof department | typeof position | typeof costCenter | typeof businessUnit,
  labelKind: LabelKind,
  companyIds: string[],
): SQL {
  const ids = sql.join(
    companyIds.map((c) => sql`${c}`),
    sql`, `,
  );
  return sql`(
    ${table.companyId} in (${ids})
    or ${table.id} in (
      select lca.label_id from label_company_assignment lca
      join company co on co.id = lca.company_id
      where lca.label_kind = ${labelKind}
        and lca.company_id in (${ids})
        and co.shared_system_labels = true
    )
    or (${table.isGlobal} = true and exists (
      select 1 from company co2 where co2.id in (${ids}) and co2.shared_system_labels = true
    ))
  )`;
}

/**
 * Batched read variant of `labelIdsForCompany`: the ids of `kind` any of `companyIds` may use.
 * Read-only — no DomainEvent (SUBSTRATE: reads never append). Used by tests and by consumers that
 * want the resolved id set rather than the inline SQL predicate.
 */
export function labelIdsForCompanies(ctx: SessionContext, kind: string, companyIds: string[]): Promise<string[]> {
  assertKind(kind);
  const table = KIND_TABLE[kind];
  const ids = Array.from(new Set(companyIds.filter(Boolean)));
  return withTenant(ctx, async (tx) => {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, ctx.tenantId), visibleLabelIdsCondition(table, kind, ids)));
    return Array.from(new Set(rows.map((r) => r.id)));
  });
}

/**
 * Guard used by cross-company write paths (hire / transfer): true if `labelId` of `kind` is one this
 * company MAY use under the resolver (origin, shared-in with the flag on, or global with the flag on).
 * Replaces the old strict `label.company_id === company_id` check so a shared label is accepted only
 * where the resolver would surface it — flag OFF keeps the exact old strictness (origin-only).
 */
export async function labelUsableByCompany(
  tx: Tx,
  tenantId: string,
  kind: LabelKind,
  labelId: string,
  companyId: string,
): Promise<boolean> {
  const table = KIND_TABLE[kind];
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(
      and(eq(table.tenantId, tenantId), eq(table.id, labelId), visibleLabelIdsCondition(table, kind, [companyId])),
    )
    .limit(1);
  return !!row;
}

/** True if any company in `removing` still USES `labelId` via an employee assignment (or, for a BU, via a
 *  department that itself is still in use). The data-integrity guard for unassign/global-off. */
async function labelInUseByCompanies(
  tx: Tx,
  tenantId: string,
  kind: LabelKind,
  labelId: string,
  removing: string[],
): Promise<boolean> {
  if (removing.length === 0) return false;
  const fk = ASSIGNMENT_FK[kind];
  if (fk) {
    // An active assignment on an employee in one of the removing companies that points at this label.
    const rows = await tx
      .select({ id: assignment.id })
      .from(assignment)
      .innerJoin(employment, eq(employment.id, assignment.employmentId))
      .where(
        and(
          eq(assignment.tenantId, tenantId),
          eq(fk, labelId),
          isNull(assignment.supersededAt),
          inArray(employment.companyId, removing),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  // business_unit: used indirectly — a department in a removing company links to this BU.
  const rows = await tx
    .select({ id: department.id })
    .from(department)
    .where(
      and(
        eq(department.tenantId, tenantId),
        eq(department.businessUnitId, labelId),
        inArray(department.companyId, removing),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Batch read for the grid: every (labelId → companyId) assignment of a kind in the tenant. Read-only,
 * no event. The grid pairs this with each row's origin company + is_global to render the Scope cell.
 */
export function listLabelAssignments(ctx: SessionContext, kind: string): Promise<{ labelId: string; companyId: string }[]> {
  assertKind(kind);
  return withTenant(ctx, (tx) =>
    tx
      .select({ labelId: labelCompanyAssignment.labelId, companyId: labelCompanyAssignment.companyId })
      .from(labelCompanyAssignment)
      .where(and(eq(labelCompanyAssignment.tenantId, ctx.tenantId), eq(labelCompanyAssignment.labelKind, kind))),
  );
}

/**
 * Assign a label to one or more companies (multi-company). Idempotent per company (ON CONFLICT DO NOTHING).
 * The label's origin company is always implicitly assigned; passing it again is a harmless no-op.
 */
export function assignLabelToCompanies(
  ctx: SessionContext,
  p: { kind: string; labelId: string; companyIds: string[] },
): Promise<{ assigned: string[] }> {
  assertKind(p.kind);
  const kind = p.kind;
  const companyIds = Array.from(new Set(p.companyIds.filter(Boolean)));
  return withTenant(ctx, async (tx) => {
    await loadLabel(tx, ctx.tenantId, kind, p.labelId); // 404 if the label is not real.
    if (companyIds.length === 0) return { assigned: [] };
    await tx
      .insert(labelCompanyAssignment)
      .values(companyIds.map((companyId) => ({ tenantId: ctx.tenantId, labelKind: kind, labelId: p.labelId, companyId })))
      .onConflictDoNothing();
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: aggForKind(kind),
      aggregateId: p.labelId,
      eventType: `${aggForKind(kind)}.companies.assigned`,
      actor: actorOf(ctx),
      payload: { kind, companyIds },
    });
    return { assigned: companyIds };
  });
}

/**
 * Unassign a label from one or more companies. REFUSES (LabelInUseError) if any company being removed still
 * USES the label via an employee assignment — the "maintain data integrity" requirement. Removing the
 * origin company's self-assignment is allowed (the origin remains resolvable via the label row itself).
 */
export function unassignLabelFromCompanies(
  ctx: SessionContext,
  p: { kind: string; labelId: string; companyIds: string[] },
): Promise<{ unassigned: string[] }> {
  assertKind(p.kind);
  const kind = p.kind;
  const companyIds = Array.from(new Set(p.companyIds.filter(Boolean)));
  return withTenant(ctx, async (tx) => {
    await loadLabel(tx, ctx.tenantId, kind, p.labelId);
    if (companyIds.length === 0) return { unassigned: [] };
    if (await labelInUseByCompanies(tx, ctx.tenantId, kind, p.labelId, companyIds)) {
      throw new LabelInUseError('Cannot unassign: a company still uses this label. Reassign its employees first.');
    }
    await tx
      .delete(labelCompanyAssignment)
      .where(
        and(
          eq(labelCompanyAssignment.tenantId, ctx.tenantId),
          eq(labelCompanyAssignment.labelKind, kind),
          eq(labelCompanyAssignment.labelId, p.labelId),
          inArray(labelCompanyAssignment.companyId, companyIds),
        ),
      );
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: aggForKind(kind),
      aggregateId: p.labelId,
      eventType: `${aggForKind(kind)}.companies.unassigned`,
      actor: actorOf(ctx),
      payload: { kind, companyIds },
    });
    return { unassigned: companyIds };
  });
}

/**
 * Set (or clear) the "All Companies" global flag on a label. The DB trigger app.guard_is_global() enforces
 * that only a GROUP admin may set is_global=true; a per-company admin's attempt raises insufficient_privilege.
 * Clearing the flag is guarded like an unassign: refuse if any company outside the label's own junction still
 * uses it (turning off "all companies" must not orphan an employee whose company only had access via global).
 */
export function setLabelGlobal(
  ctx: SessionContext,
  p: { kind: string; labelId: string; isGlobal: boolean },
): Promise<{ isGlobal: boolean }> {
  assertKind(p.kind);
  const kind = p.kind;
  const table = KIND_TABLE[kind];
  return withTenant(ctx, async (tx) => {
    const label = await loadLabel(tx, ctx.tenantId, kind, p.labelId);
    if (label.isGlobal === p.isGlobal) return { isGlobal: p.isGlobal }; // no-op, no event.

    if (!p.isGlobal) {
      // Turning global OFF: companies that keep access are origin ∪ junction; refuse if any OTHER company
      // (that only had access because the label was global) still uses it.
      const junction = await tx
        .select({ companyId: labelCompanyAssignment.companyId })
        .from(labelCompanyAssignment)
        .where(
          and(
            eq(labelCompanyAssignment.tenantId, ctx.tenantId),
            eq(labelCompanyAssignment.labelKind, kind),
            eq(labelCompanyAssignment.labelId, p.labelId),
          ),
        );
      const keeps = new Set([label.companyId, ...junction.map((j) => j.companyId)]);
      const allCompanies = await tx
        .select({ id: company.id })
        .from(company)
        .where(eq(company.tenantId, ctx.tenantId));
      const losing = allCompanies.map((c) => c.id).filter((id) => !keeps.has(id));
      if (await labelInUseByCompanies(tx, ctx.tenantId, kind, p.labelId, losing)) {
        throw new LabelInUseError('Cannot remove global: a company still uses this label only via the global assignment.');
      }
    }

    await tx
      .update(table)
      .set({ isGlobal: p.isGlobal })
      .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, p.labelId)));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: aggForKind(kind),
      aggregateId: p.labelId,
      eventType: p.isGlobal ? `${aggForKind(kind)}.made.global` : `${aggForKind(kind)}.global.cleared`,
      actor: actorOf(ctx),
      payload: { kind, isGlobal: p.isGlobal },
    });
    return { isGlobal: p.isGlobal };
  });
}
