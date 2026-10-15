import { tenantMutation } from '../db/tenant-mutation';
/** System Labels criteria owner. Creation company is provenance and write ownership;
 * availability is exclusively Global or an explicit nonempty company assignment set.
 * Legacy company sharing flags are retained for data compatibility, never read as a gate. */
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
    return Array.from(new Set(junction.map((j) => j.companyId)));
  });
}

/** Resolve through the same predicate used by every write and SQL picker. */
export function labelIdsForCompany(ctx: SessionContext, kind: string, companyId: string): Promise<string[]> {
  return labelIdsForCompanies(ctx, kind, [companyId]);
}

/** Explicit company criteria carried to client pickers; creation company is not availability. */
export function labelCompanyIdsSql(
  table: typeof department | typeof position | typeof costCenter | typeof businessUnit,
  kind: LabelKind,
): SQL<string[]> {
  return sql<string[]>`array(select lca.company_id::text from label_company_assignment lca
    where lca.tenant_id = ${table.tenantId} and lca.label_kind = ${kind}
      and lca.label_id = ${table.id} order by lca.company_id)`;
}

/** Global automatically includes current and future companies; scoped rows use only saved criteria. */
export function visibleLabelIdsCondition(
  table: typeof department | typeof position | typeof costCenter | typeof businessUnit,
  labelKind: LabelKind,
  companyIds: string[],
): SQL {
  if (!companyIds.length) return sql`false`;
  const ids = sql.join(companyIds.map(id => sql`${id}`), sql`, `);
  return sql`(${table.isGlobal} = true or exists (
    select 1 from label_company_assignment lca
    where lca.tenant_id = ${table.tenantId} and lca.label_kind = ${labelKind}
      and lca.label_id = ${table.id} and lca.company_id in (${ids})
  ))`;
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

/** One complete Criteria save. All permission, in-use and collision checks share this Tx. */
export async function setLabelCriteria(
  ctx: SessionContext,
  p: { kind: string; labelId: string; isGlobal: boolean; companyIds: string[] },
  existingTx?: Tx,
): Promise<{ isGlobal: boolean; companyIds: string[] }> {
  assertKind(p.kind);
  const kind = p.kind;
  const ids = [...new Set(p.companyIds)];
  if (ids.length > 1000 || ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))
    throw new Error('Choose valid companies from the available list.');
  if (!p.isGlobal && !ids.length) throw new Error('Select at least one company, or choose Global.');
  return tenantMutation(ctx, existingTx, async tx => {
    const table = KIND_TABLE[kind];
    await tx.execute(sql`select app.lock_system_label_criteria(${ctx.tenantId}::uuid, ${kind})`);
    const [label] = await tx.select({ companyId: table.companyId, isGlobal: table.isGlobal })
      .from(table).where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, p.labelId))).for('update');
    if (!label) throw new UnknownLabelError();
    const proof = await tx.execute(sql`select app.is_group_admin() as global,
      app.is_admin_for(${label.companyId}::uuid) as origin`) as unknown as {global:boolean;origin:boolean}[];
    if (!proof[0]?.origin) throw new Error('You do not administer this label’s creation company.');
    if ((p.isGlobal || label.isGlobal) && !proof[0]?.global) throw new Error('Only a group administrator may change Global criteria.');
    const companies = await tx.select({ id: company.id, archivedAt: company.archivedAt,
      writable: sql<boolean>`app.is_admin_for(${company.id})` }).from(company)
      .where(and(eq(company.tenantId, ctx.tenantId), ids.length ? inArray(company.id, ids) : sql`false`));
    if (companies.length !== ids.length || companies.some(row => !row.writable || row.archivedAt))
      throw new Error('A selected company is unavailable or outside your administrator scope.');
    const previous = await tx.select({ companyId: labelCompanyAssignment.companyId }).from(labelCompanyAssignment)
      .where(and(eq(labelCompanyAssignment.tenantId, ctx.tenantId), eq(labelCompanyAssignment.labelKind, kind), eq(labelCompanyAssignment.labelId, p.labelId)));
    const priorIds = label.isGlobal
      ? (await tx.select({ id: company.id }).from(company).where(eq(company.tenantId, ctx.tenantId))).map(row => row.id)
      : previous.map(row => row.companyId);
    const effective = p.isGlobal ? [] : ids;
    const losing = p.isGlobal ? [] : priorIds.filter(id => !effective.includes(id));
    if (losing.length && !proof[0]?.global) {
      const allowed = await tx.select({ id: company.id }).from(company)
        .where(and(inArray(company.id, losing), sql`app.is_admin_for(${company.id})`));
      if (allowed.length !== losing.length) throw new Error('You cannot remove another company’s criteria.');
    }
    if (await labelInUseByCompanies(tx, ctx.tenantId, kind, p.labelId, losing))
      throw new LabelInUseError('A removed company still uses this label. Reassign its records before changing Criteria.');
    if (label.isGlobal === p.isGlobal && [...previous.map(row => row.companyId)].sort().join(',') === [...effective].sort().join(','))
      return { isGlobal: p.isGlobal, companyIds: effective };
    await tx.update(table).set({ isGlobal: p.isGlobal }).where(eq(table.id, p.labelId));
    await tx.delete(labelCompanyAssignment).where(and(eq(labelCompanyAssignment.tenantId, ctx.tenantId),
      eq(labelCompanyAssignment.labelKind, kind), eq(labelCompanyAssignment.labelId, p.labelId)));
    if (effective.length) await tx.insert(labelCompanyAssignment).values(effective.map(companyId => ({ tenantId: ctx.tenantId, labelKind: kind, labelId: p.labelId, companyId })));
    await assertLabelCriteriaCodeTx(tx, ctx.tenantId, kind, p.labelId);
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: aggForKind(kind), aggregateId: p.labelId,
      eventType: `${aggForKind(kind)}.criteria.changed`, actor: actorOf(ctx), payload: { kind, isGlobal: p.isGlobal, companyIds: effective } });
    return { isGlobal: p.isGlobal, companyIds: effective };
  });
}

/** Shared by criteria changes and all label code/name saves. No other label values are exposed. */
export async function assertLabelCriteriaCodeTx(tx: Tx, tenantId: string, kind: LabelKind, labelId: string) {
  const table = KIND_TABLE[kind];
  const key = kind === 'department' ? department.name : kind === 'position' ? position.title : kind === 'cost_center' ? costCenter.code : businessUnit.code;
  const [label] = await tx.select({ value: key, global: table.isGlobal, archivedAt: table.archivedAt,
    companyIds: labelCompanyIdsSql(table, kind) }).from(table).where(and(eq(table.tenantId, tenantId), eq(table.id, labelId)));
  if (!label || label.archivedAt) return;
  const [collision] = await tx.select({ id: table.id }).from(table).where(and(eq(table.tenantId, tenantId),
    sql`${table.id} <> ${labelId}::uuid`, isNull(table.archivedAt), sql`lower(trim(${key})) = lower(trim(${label.value}))`,
    label.global ? undefined : visibleLabelIdsCondition(table, kind, label.companyIds))).limit(1);
  if (collision) throw new Error('Another active label has the same code or name in the selected Criteria.');
}

/** Compatibility entry points delegate to the complete owner; no independent sharing switch exists. */
export function assignLabelToCompanies(ctx: SessionContext, p: {kind:string;labelId:string;companyIds:string[]}, existingTx?: Tx): Promise<{assigned:string[]}> {
  assertKind(p.kind);
  return tenantMutation(ctx, existingTx, async tx => {
    const label = await loadLabel(tx, ctx.tenantId, p.kind as LabelKind, p.labelId);
    const existing = await tx.select({ companyId: labelCompanyAssignment.companyId }).from(labelCompanyAssignment)
      .where(and(eq(labelCompanyAssignment.labelId, p.labelId), eq(labelCompanyAssignment.labelKind, p.kind)));
    await setLabelCriteria(ctx, { ...p, isGlobal: label.isGlobal, companyIds: [...existing.map(row => row.companyId), ...p.companyIds] }, tx);
    return { assigned: p.companyIds };
  });
}
export function unassignLabelFromCompanies(ctx: SessionContext, p: {kind:string;labelId:string;companyIds:string[]}, existingTx?: Tx): Promise<{unassigned:string[]}> {
  assertKind(p.kind);
  return tenantMutation(ctx, existingTx, async tx => {
    const label = await loadLabel(tx, ctx.tenantId, p.kind as LabelKind, p.labelId);
    const existing = await tx.select({ companyId: labelCompanyAssignment.companyId }).from(labelCompanyAssignment)
      .where(and(eq(labelCompanyAssignment.labelId, p.labelId), eq(labelCompanyAssignment.labelKind, p.kind)));
    await setLabelCriteria(ctx, { ...p, isGlobal: label.isGlobal, companyIds: existing.map(row => row.companyId).filter(id => !p.companyIds.includes(id)) }, tx);
    return { unassigned: p.companyIds };
  });
}
export function setLabelGlobal(ctx: SessionContext, p: {kind:string;labelId:string;isGlobal:boolean}, existingTx?: Tx): Promise<{isGlobal:boolean}> {
  assertKind(p.kind);
  return tenantMutation(ctx, existingTx, async tx => {
    const existing = await tx.select({ companyId: labelCompanyAssignment.companyId }).from(labelCompanyAssignment)
      .where(and(eq(labelCompanyAssignment.labelId, p.labelId), eq(labelCompanyAssignment.labelKind, p.kind)));
    const label = await loadLabel(tx, ctx.tenantId, p.kind as LabelKind, p.labelId);
    await setLabelCriteria(ctx, { ...p, companyIds: p.isGlobal ? [] : existing.length ? existing.map(row => row.companyId) : [label.companyId] }, tx);
    return { isGlobal: p.isGlobal };
  });
}
