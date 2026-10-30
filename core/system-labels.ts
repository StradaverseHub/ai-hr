import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import { tenantMutation } from '../db/tenant-mutation';
/** System Labels criteria owner. Creation company is provenance and write ownership;
 * availability is exclusively Global or an explicit nonempty company assignment set.
 * Legacy company sharing flags are retained for data compatibility, never read as a gate. */
import { and, asc, eq, getTableName, inArray, isNull, sql, type SQL } from 'drizzle-orm';
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
  person,
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
  business_unit: assignment.businessUnitId, // Direct assignment and department-link references are both retained.
} as const;

/** kebab-case aggregateType for the substrate (matches the existing create/update events' aggregateType). */
function aggForKind(kind: LabelKind): string {
  return kind === 'cost_center' ? 'cost-center' : kind === 'business_unit' ? 'business-unit' : kind;
}

function assertKind(kind: string): asserts kind is LabelKind {
  if (!(LABEL_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown system-label kind “${kind}”.`);
}

/** Acquire the Criteria owner's persistent coordination rows before taking any label row lock.
 * All four kinds are intentional: an assignment, department link or mixed workbook can touch more
 * than one kind. Every caller uses the same order as the reference-write database trigger.
 * This is coordination only, never authorization; the database still checks tenant identity/RLS.
 * A caller-supplied transaction must invoke this before its first label FOR SHARE/FOR UPDATE.
 */
export async function lockLabelCriteriaTx(tx: Tx, tenantId: string): Promise<void> {
  for (const kind of LABEL_KINDS) {
    await tx.execute(sql`select app.lock_system_label_criteria(${tenantId}::uuid, ${kind})`);
  }
}

/** Read barrier for catalogue review. Same physical rows/order as the native criteria writer,
 * without counting a read as a configuration change. Call before any label row lock. */
export async function lockLabelCriteriaReadTx(tx: Tx, tenantId: string): Promise<void> {
  for (const kind of LABEL_KINDS) {
    await tx.execute(sql`insert into system_label_criteria_epoch(tenant_id,label_kind) values(${tenantId}::uuid,${kind}) on conflict do nothing`);
    await tx.execute(sql`select revision from system_label_criteria_epoch where tenant_id=${tenantId}::uuid and label_kind=${kind} for update`);
  }
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
 * Resolve the saved nonempty company set, or every tenant company for Global.
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
  // Drizzle unqualifies Column chunks inside a SELECT expression. Explicit SQL identifiers retain
  // the OUTER label binding; a bare id would bind lca.id and silently erase saved company Criteria.
  const outer=sql.identifier(getTableName(table));
  return sql<string[]>`array(select lca.company_id::text from label_company_assignment lca
    where lca.tenant_id = ${outer}.${sql.identifier('tenant_id')} and lca.label_kind = ${kind}
      and lca.label_id = ${outer}.${sql.identifier('id')} order by lca.company_id)`;
}

/** Global automatically includes current and future companies; scoped rows use only saved criteria. */
export function visibleLabelIdsCondition(
  table: typeof department | typeof position | typeof costCenter | typeof businessUnit,
  labelKind: LabelKind,
  companyIds: string[],
): SQL {
  if (!companyIds.length) return sql`false`;
  const ids = sql.join(companyIds.map(id => sql`${id}`), sql`, `);
  return sql`(exists(select 1 from company requested_company where requested_company.tenant_id=${table.tenantId} and requested_company.id in (${ids})) and (${table.isGlobal} = true or exists (
    select 1 from label_company_assignment lca
    where lca.tenant_id = ${table.tenantId} and lca.label_kind = ${labelKind}
      and lca.label_id = ${table.id} and lca.company_id in (${ids})
  )))`;
}

/** Common maintenance is independent of the company switcher. Database administrator scope
 * is applied to rows before any consumer search, count, page limit or export projection. */
export function labelMaintenanceCondition(table:typeof department|typeof position|typeof costCenter|typeof businessUnit,kind:LabelKind):SQL{
 return sql`app.is_admin() and (app.is_admin_for(${table.companyId}) or
   (${table.isGlobal}=true and exists(select 1 from company scope_co where scope_co.tenant_id=${table.tenantId} and app.is_admin_for(scope_co.id))) or
   exists(select 1 from label_company_assignment scope_lca join company scope_co on scope_co.id=scope_lca.company_id and scope_co.tenant_id=scope_lca.tenant_id
     where scope_lca.tenant_id=${table.tenantId} and scope_lca.label_kind=${kind} and scope_lca.label_id=${table.id} and app.is_admin_for(scope_co.id)))`;
}
export const SYSTEM_LABEL_MAINTENANCE_LIMIT=5000;
export function boundedLabelMaintenanceRows<T extends readonly unknown[]>(rows:T):T{if(rows.length>SYSTEM_LABEL_MAINTENANCE_LIMIT)throw new Error('This System Labels list exceeds the supported maintenance size. Use a narrower authorized workbook selection.');return rows;}
export function labelMaintenanceCompanies(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=await tx.select({id:company.id,name:company.legalName,archivedAt:company.archivedAt}).from(company)
  .where(and(eq(company.tenantId,ctx.tenantId),sql`app.is_admin() and app.is_admin_for(${company.id})`)).orderBy(asc(company.legalName),asc(company.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1);
 return boundedLabelMaintenanceRows(rows);
});}
/** Retain stored heads, including ended employments; writes independently validate current eligibility. */
export function labelMaintenanceHeadOptions(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=await tx.select({employmentId:employment.id,companyId:employment.companyId,employeeCode:employment.employeeCode,name:person.fullName}).from(employment)
  .innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId)))
  .where(and(eq(employment.tenantId,ctx.tenantId),sql`app.is_admin() and app.is_admin_for(${employment.companyId})`)).orderBy(asc(employment.employeeCode),asc(employment.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1);
 return boundedLabelMaintenanceRows(rows);
});}

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
 * company MAY use under the same explicit Criteria rule shown by SQL and client pickers.
 * Neither creation ownership nor retired sharing flags grant implicit availability.
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
  if(kind==='cost_center'){const [allocation]=await tx.execute<{used:boolean}>(sql`select app.cost_allocation_label_in_use(${labelId}::uuid,array[${sql.join(removing.map(id=>sql`${id}::uuid`),sql`, `)}]) as used`);if(allocation?.used)return true;}
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
          sql`coalesce(${assignment.companyId},${employment.companyId}) in (${sql.join(removing.map(id=>sql`${id}::uuid`),sql`, `)})`,
        ),
      )
      .limit(1);
    if(rows.length)return true;
    if(kind!=='business_unit')return false;
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
 * no event. Maintenance consumers use each row's scoped assignment projection directly.
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

export type LabelCriteriaChange={kind:string;labelId:string;isGlobal:boolean;companyIds:string[]};
/** One complete owner for a single save or a reviewed batch. No caller can skip final validation. */
export async function setLabelCriteria(ctx:SessionContext,p:LabelCriteriaChange,existingTx?:Tx):Promise<{isGlobal:boolean;companyIds:string[]}>{
 p=structuredClone(p);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const [result]=await setLabelCriteriaBatch(ctx,[p],existingTx);return {isGlobal:result.isGlobal,companyIds:result.companyIds};
}
export async function setLabelCriteriaBatch(ctx:SessionContext,changes:readonly LabelCriteriaChange[],existingTx?:Tx):Promise<{kind:LabelKind;labelId:string;isGlobal:boolean;companyIds:string[]}[]>{
 changes=structuredClone(changes);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const rawChanges:unknown=changes;
 if(!Array.isArray(rawChanges)||rawChanges.some(change=>!change||typeof change.kind!=='string'||typeof change.labelId!=='string'||typeof change.isGlobal!=='boolean'||!Array.isArray(change.companyIds)||change.companyIds.some((id:unknown)=>typeof id!=='string')))throw new Error('Choose valid label Criteria.');
 if(changes.length>1000||new Set(changes.map(change=>change.kind+':'+change.labelId)).size!==changes.length)throw new Error('Choose each label once within the supported batch size.');
 for(const p of changes){assertKind(p.kind);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.labelId))throw new UnknownLabelError();const ids=[...new Set(p.companyIds)];if(ids.length>1000||ids.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))throw new Error('Choose valid companies from the available list.');if(!p.isGlobal&&!ids.length)throw new Error('Select at least one company, or choose Global.');}
 return tenantMutation(ctx,existingTx,async tx=>{
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  await lockLabelCriteriaTx(tx, ctx.tenantId);
  const plans:{kind:LabelKind;labelId:string;isGlobal:boolean;companyIds:string[]}[]=[],results:typeof plans=[];
  for(const p of changes){assertKind(p.kind);const kind=p.kind,ids=[...new Set(p.companyIds)];
    const table = KIND_TABLE[kind];
    const [label] = await tx.select({ companyId: table.companyId, isGlobal: table.isGlobal })
      .from(table).where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, p.labelId))).for('update');
    if (!label) throw new UnknownLabelError();
    const proof = await tx.execute(sql`select app.is_group_admin() as global,
      app.is_admin_for(${label.companyId}::uuid) as origin`) as unknown as {global:boolean;origin:boolean}[];
    if (!proof[0]?.origin) throw new Error('You do not administer this label’s creation company.');
    const previous = await tx.select({ companyId: labelCompanyAssignment.companyId }).from(labelCompanyAssignment)
      .where(and(eq(labelCompanyAssignment.tenantId, ctx.tenantId), eq(labelCompanyAssignment.labelKind, kind), eq(labelCompanyAssignment.labelId, p.labelId)));
    const effective = p.isGlobal ? [] : ids;
    // Unchanged availability is not a Criteria mutation. Preserve origin-admin text/archive rights,
    // including retained scoped companies outside their scope and legacy junctions on a Global row.
    if (label.isGlobal === p.isGlobal && (p.isGlobal || [...previous.map(row => row.companyId)].sort().join(',') === [...effective].sort().join(','))) {
      results.push({kind,labelId:p.labelId,isGlobal:p.isGlobal,companyIds:effective});continue;
    }
    if ((p.isGlobal || label.isGlobal) && !proof[0]?.global) throw new Error('Only a group administrator may change Global criteria.');
    const companies = await tx.select({ id: company.id, archivedAt: company.archivedAt,
      writable: sql<boolean>`app.is_admin_for(${company.id})` }).from(company)
      .where(and(eq(company.tenantId, ctx.tenantId), ids.length ? inArray(company.id, ids) : sql`false`));
    if (companies.length !== ids.length || companies.some(row => !row.writable || row.archivedAt))
      throw new Error('A selected company is unavailable or outside your administrator scope.');
    const priorIds = label.isGlobal
      ? (await tx.select({ id: company.id }).from(company).where(eq(company.tenantId, ctx.tenantId))).map(row => row.id)
      : previous.map(row => row.companyId);

    const losing = p.isGlobal ? [] : priorIds.filter(id => !effective.includes(id));
    if (losing.length && !proof[0]?.global) {
      const allowed = await tx.select({ id: company.id }).from(company)
        .where(and(inArray(company.id, losing), sql`app.is_admin_for(${company.id})`));
      if (allowed.length !== losing.length) throw new Error('You cannot remove another company’s criteria.');
    }
    if (await labelInUseByCompanies(tx, ctx.tenantId, kind, p.labelId, losing))
      throw new LabelInUseError('A removed company still uses this label. Reassign its records before changing Criteria.');

    const plan={kind,labelId:p.labelId,isGlobal:p.isGlobal,companyIds:effective};plans.push(plan);results.push(plan);
  }
  for(const p of plans){const table=KIND_TABLE[p.kind];
    await tx.update(table).set({isGlobal:p.isGlobal}).where(and(eq(table.tenantId,ctx.tenantId),eq(table.id,p.labelId)));
    await tx.delete(labelCompanyAssignment).where(and(eq(labelCompanyAssignment.tenantId,ctx.tenantId),eq(labelCompanyAssignment.labelKind,p.kind),eq(labelCompanyAssignment.labelId,p.labelId)));
    if(p.companyIds.length)await tx.insert(labelCompanyAssignment).values(p.companyIds.map(companyId=>({tenantId:ctx.tenantId,labelKind:p.kind,labelId:p.labelId,companyId})));
  }
  // All scopes are now final. Deferred database constraints independently check that same final state.
  for(const p of plans){await assertLabelCriteriaCodeTx(tx,ctx.tenantId,p.kind,p.labelId);await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:aggForKind(p.kind),aggregateId:p.labelId,eventType:`${aggForKind(p.kind)}.criteria.changed`,actor:actorOf(ctx),payload:{kind:p.kind,isGlobal:p.isGlobal,companyIds:p.companyIds}});}
  return results;
 });
}

/** Shared by criteria changes and all label code/name saves. No other label values are exposed. */
export async function assertLabelCriteriaCodeTx(tx: Tx, tenantId: string, kind: LabelKind, labelId: string) {
  const table = KIND_TABLE[kind];
  const key = kind === 'department' ? department.name : kind === 'position' ? position.title : kind === 'cost_center' ? costCenter.code : businessUnit.code;
  const [label] = await tx.select({ value: key, global: table.isGlobal, archivedAt: table.archivedAt }).from(table).where(and(eq(table.tenantId, tenantId), eq(table.id, labelId)));
  if (!label || label.archivedAt) return;
  const [collision] = await tx.select({ id: table.id }).from(table).where(and(eq(table.tenantId, tenantId),
    sql`${table.id} <> ${labelId}::uuid`, isNull(table.archivedAt), sql`lower(trim(${key})) = lower(trim(${label.value}))`,
    sql`not app.system_label_collision_allowed(${tenantId}::uuid,${kind},${label.value},
      ${labelId}::uuid,${table.id},${label.global},${table.isGlobal},
      array(select lca.company_id from label_company_assignment lca where lca.tenant_id=${tenantId}::uuid
        and lca.label_kind=${kind} and lca.label_id=${labelId}::uuid),${labelCompanyIdsSql(table,kind)}::uuid[])`)).limit(1);
  if (collision) throw new Error('Another active label has the same code or name in the selected Criteria.');
}

/** Projected final pairs use the same read-only collision predicate as the deferred DB guard.
 * null identity means a NEW row, derived by the workbook owner, never an exemption flag. This
 * grants no write permission: actual write guards independently load stored final rows. */
export type LabelCollisionProposal = {
  key: string; kind: LabelKind; code: string;
  first: {id: string|null; global: boolean; companyIds: string[]};
  second: {id: string|null; global: boolean; companyIds: string[]};
};
export const LABEL_COLLISION_PREVIEW_PAIR_LIMIT = 10000;
export async function refusedLabelCollisionProposalsTx(tx: Tx, tenantId: string,
  pairs: LabelCollisionProposal[]): Promise<string[]> {
  if (!pairs.length) return [];
  if (pairs.length>LABEL_COLLISION_PREVIEW_PAIR_LIMIT) throw new Error('Too many matching label codes. Preview a smaller workbook.');
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const seen=new Set<string>();
  for(const pair of pairs){
    if(!pair || typeof pair.key!=='string' || !pair.key || pair.key.length>200 || seen.has(pair.key)
      || !LABEL_KINDS.includes(pair.kind) || typeof pair.code!=='string' || pair.code.length>1000)
      throw new Error('Invalid projected label collision identity.');
    seen.add(pair.key);
    for(const row of [pair.first,pair.second]) if(!row || (row.id!==null&&!uuid.test(row.id))
      || typeof row.global!=='boolean' || !Array.isArray(row.companyIds) || row.companyIds.length>1000
      || row.companyIds.some(id=>typeof id!=='string'||!uuid.test(id))) throw new Error('Invalid projected label Criteria.');
  }
  const json=JSON.stringify(pairs);
  if(json.length>2_000_000) throw new Error('Too many matching label codes. Preview a smaller workbook.');
  const result=await tx.execute(sql`select p.key from jsonb_to_recordset(${json}::jsonb)
    as p(key text,kind text,code text,first jsonb,second jsonb)
    where not app.system_label_collision_allowed(${tenantId}::uuid,p.kind,p.code,
      (p.first->>'id')::uuid,(p.second->>'id')::uuid,
      (p.first->>'global')::boolean,(p.second->>'global')::boolean,
      array(select jsonb_array_elements_text(p.first->'companyIds'))::uuid[],
      array(select jsonb_array_elements_text(p.second->'companyIds'))::uuid[])`);
  return (result as unknown as {key:string}[]).map(row=>row.key);
}

/** Create-only workbook identity check. The database returns no hidden record or company data. */
export async function existingSystemLabelImportKeysTx(tx:Tx,tenantId:string,rows:{key:string;kind:LabelKind;code:string}[]):Promise<string[]> {
  if(!rows.length)return [];
  const seen=new Set<string>();
  if(rows.length>7000)throw new Error('Invalid import code request.');
  for(const row of rows){if(!row||typeof row.key!=='string'||!row.key||row.key.length>200||seen.has(row.key)||!LABEL_KINDS.includes(row.kind)||typeof row.code!=='string'||!row.code||row.code.length>1000)throw new Error('Invalid import code request.');seen.add(row.key);}
  const payload=JSON.stringify(rows);
  if(Buffer.byteLength(payload)>8_000_000)throw new Error('Import code request exceeds the supported size.');
  const result=await tx.execute(sql`select key from app.existing_system_label_import_keys(${tenantId}::uuid,${payload}::jsonb)`);
  return (result as unknown as {key:string}[]).map(row=>row.key);
}

/** Compatibility entry points delegate to the complete owner; no independent sharing switch exists. */
export function assignLabelToCompanies(ctx: SessionContext, p: {kind:string;labelId:string;companyIds:string[]}, existingTx?: Tx): Promise<{assigned:string[]}> {
 p=structuredClone(p);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  assertKind(p.kind);
  return tenantMutation(ctx, existingTx, async tx => {
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
    const label = await loadLabel(tx, ctx.tenantId, p.kind as LabelKind, p.labelId);
    const existing = await tx.select({ companyId: labelCompanyAssignment.companyId }).from(labelCompanyAssignment)
      .where(and(eq(labelCompanyAssignment.labelId, p.labelId), eq(labelCompanyAssignment.labelKind, p.kind)));
    await setLabelCriteria(ctx, { ...p, isGlobal: label.isGlobal, companyIds: [...existing.map(row => row.companyId), ...p.companyIds] }, tx);
    return { assigned: p.companyIds };
  });
}
export function unassignLabelFromCompanies(ctx: SessionContext, p: {kind:string;labelId:string;companyIds:string[]}, existingTx?: Tx): Promise<{unassigned:string[]}> {
 p=structuredClone(p);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  assertKind(p.kind);
  return tenantMutation(ctx, existingTx, async tx => {
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
    const label = await loadLabel(tx, ctx.tenantId, p.kind as LabelKind, p.labelId);
    const existing = await tx.select({ companyId: labelCompanyAssignment.companyId }).from(labelCompanyAssignment)
      .where(and(eq(labelCompanyAssignment.labelId, p.labelId), eq(labelCompanyAssignment.labelKind, p.kind)));
    await setLabelCriteria(ctx, { ...p, isGlobal: label.isGlobal, companyIds: existing.map(row => row.companyId).filter(id => !p.companyIds.includes(id)) }, tx);
    return { unassigned: p.companyIds };
  });
}
export function setLabelGlobal(ctx: SessionContext, p: {kind:string;labelId:string;isGlobal:boolean}, existingTx?: Tx): Promise<{isGlobal:boolean}> {
 p=structuredClone(p);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  assertKind(p.kind);
  return tenantMutation(ctx, existingTx, async tx => {
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
    const existing = await tx.select({ companyId: labelCompanyAssignment.companyId }).from(labelCompanyAssignment)
      .where(and(eq(labelCompanyAssignment.labelId, p.labelId), eq(labelCompanyAssignment.labelKind, p.kind)));
    const label = await loadLabel(tx, ctx.tenantId, p.kind as LabelKind, p.labelId);
    await setLabelCriteria(ctx, { ...p, companyIds: p.isGlobal ? [] : existing.length ? existing.map(row => row.companyId) : [label.companyId] }, tx);
    return { isGlobal: p.isGlobal };
  });
}
