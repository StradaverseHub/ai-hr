/** Workforce-purpose adapter. Existing record, financial, self-service and approval owners remain independent. */
import {sql,type SQL} from 'drizzle-orm';
import {type SessionContext,type Tx} from '../db/client';
import {joinAccessConfigurationTx,joinWorkforceBarrierTx} from './workforce-lock-mode';
import {withPersonnelRead} from './personnel-read-bounds';
import {assertAiPresentationPrincipalTx} from './ai-principal';
export type WorkforceOperation='view'|'maintain';
export class WorkforceAccessError extends Error{
 constructor(){super('Employee record or permission is unavailable.');this.name='WorkforceAccessError';}
}
/** This predicate is evaluated inside the actual Workforce query, never cached in a session. */
export function workforceEmploymentPredicate(subject:SQL,operation:WorkforceOperation='view',companyIds?:readonly string[]){
 if(companyIds?.length===0)return sql`false`;
 return sql`app.access_workforce_employment(${subject},${'workforce.'+operation})`;
}
/** Set-wise form of workforceEmploymentPredicate for a reader that scans employment rows (migration 9911): exactly
 * the same rows, with the company check run once per company (an InitPlan) instead of once per employment. Pass the
 * reader's own employment columns. */
export type WorkforceEmploymentColumns={tenantId:SQL;companyId:SQL;voidedAt:SQL;importPendingAttemptId:SQL};
export function workforceEmploymentSetPredicate(row:WorkforceEmploymentColumns,operation:WorkforceOperation='view'){
 return sql`app.access_workforce_employment_permitted(${row.tenantId},${row.companyId},${row.voidedAt},${row.importPendingAttemptId},(select app.access_workforce_permitted_companies(${'workforce.'+operation})))`;
}
/** A converted writer that already holds the shared Access lock joins in shared mode and never upgrades.
 * Every other caller keeps the exclusive barrier it had before the reader/writer lock. */
async function lockWorkforceOperationTx(tx:Tx,ctx:SessionContext,operation:WorkforceOperation){
 if(operation==='maintain')await joinWorkforceBarrierTx(tx,ctx.tenantId);
 else await joinAccessConfigurationTx(tx,ctx.tenantId);
}
export async function assertWorkforceCompanyTx(tx:Tx,ctx:SessionContext,companyId:string,operation:WorkforceOperation){
 await lockWorkforceOperationTx(tx,ctx,operation);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_company(${companyId}::uuid,${'workforce.'+operation}) as allowed`);
 if(!row?.allowed)throw new WorkforceAccessError();
}
export async function assertWorkforceEmploymentTx(tx:Tx,ctx:SessionContext,employmentId:string,operation:WorkforceOperation){
 await lockWorkforceOperationTx(tx,ctx,operation);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,${'workforce.'+operation}) as allowed`);
 if(!row?.allowed)throw new WorkforceAccessError();
}
/** Pure display authority only. A command or provider effect must use its current barrier owner. */
export async function assertWorkforcePresentationEmploymentTx(tx:Tx,ctx:SessionContext,employmentId:string){
 ctx=structuredClone(ctx);
 await assertAiPresentationPrincipalTx(tx,ctx);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,'workforce.view') as allowed`);
 if(!row?.allowed)throw new WorkforceAccessError();
}
export async function assertWorkforcePersonTx(tx:Tx,ctx:SessionContext,personId:string,operation:WorkforceOperation){
 await lockWorkforceOperationTx(tx,ctx,operation);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_person(${personId}::uuid,${'workforce.'+operation}) as allowed`);
 if(!row?.allowed)throw new WorkforceAccessError();
}
async function readWorkforceCompanyIds(tx:Tx,operation:WorkforceOperation){
 const allowed=operation==='view'?sql`app.access_workforce_projection_company(id)`:sql`app.access_workforce_company(id,'workforce.maintain')`;
 const rows=await tx.execute<{id:string}>(sql`select id from company where tenant_id=app.current_tenant_id() and ${allowed} order by id`);
 return rows.map(row=>row.id);
}

/** Scope metadata only. Actual reads use their own authorized snapshot; commands recheck under a write barrier. */
export function workforceCompanies(ctx:SessionContext,operation:WorkforceOperation='view',outerTx?:Tx){
 return withPersonnelRead(ctx,tx=>readWorkforceCompanyIds(tx,operation),{existingTx:outerTx});
}

export function personnelMaintenanceCompanyIds(ctx:SessionContext){
 return withPersonnelRead(ctx,tx=>readWorkforceCompanyIds(tx,'maintain'));
}

export function workforceEmploymentAccess(ctx:SessionContext,employmentId:string,operation:WorkforceOperation){
 return withPersonnelRead(ctx,async tx=>{
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,${'workforce.'+operation}) as allowed`);
  return row?.allowed===true;
 });
}

/** Availability of the implemented fixed-command lane; never a raw-row or legacy-role grant. */
export function workforceCommandAccess(ctx:SessionContext,employmentId:string){
 return withPersonnelRead(ctx,async tx=>{
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_command_allowed(${employmentId}::uuid) as allowed`);
  return row?.allowed===true;
 });
}

// Dormant company access requires a claimed administrative grant. Everyone else
// uses the current-principal capability owner over the same RLS-visible companies.
export const workforceNavigationAllowedSql = sql`(
   case when exists(select 1 from app.current_grants() where role in ('hr_admin','super_admin')) then
    exists(select 1 from company where tenant_id=app.current_tenant_id() and app.access_workforce_projection_company(id))
   when app.principal_snapshot_current() then
    exists(select 1 from company where tenant_id=app.current_tenant_id() and app.access_capability_allowed('workforce.view',id))
   else false end
   or app.access_workforce_unassigned('workforce.view')
  )`;

/** The shared navigation only needs to know whether any Workforce scope is visible. */
export function canOpenWorkforce(ctx:SessionContext){
 return withPersonnelRead(ctx,async tx=>{
  const [row]=await tx.execute<{allowed:boolean}>(sql`select ${workforceNavigationAllowedSql} as allowed`);
  return row?.allowed===true;
 });
}

/** workforceViewScope and personnelMaintenanceCompanyIds as one scalar jsonb expression, for a page
 * that selects them inside a statement it already spends in its own read-only snapshot. */
export const personnelPageAccessSql = sql`jsonb_build_object(
  'companyIds', coalesce((select jsonb_agg(id order by id) from company
    where tenant_id = app.current_tenant_id() and app.access_workforce_projection_company(id)), '[]'::jsonb),
  'unassigned', app.access_workforce_unassigned('workforce.view'),
  'maintainIds', coalesce((select jsonb_agg(id order by id) from company
    where tenant_id = app.current_tenant_id() and app.access_workforce_company(id, 'workforce.maintain')), '[]'::jsonb))`;
export type PersonnelPageAccess = {companyIds: string[]; unassigned: boolean; maintainIds: string[]};
export function personnelPageAccessFrom(value: unknown): PersonnelPageAccess & {canOpen: boolean} {
  const access = value as PersonnelPageAccess;
  return {...access, canOpen: access.companyIds.length > 0 || access.unassigned === true};
}

/** Page-scope metadata only. This does not widen the shared company switcher or other modules' scope. */
export function workforceViewScope(ctx: SessionContext, options?: { personnelList: true }) {
 const read=async (tx: Tx)=>{
  const [scope] = await tx.execute<{company_ids: string[]; unassigned: boolean}>(sql`
    select coalesce(jsonb_agg(id order by id), '[]'::jsonb) as company_ids,
      app.access_workforce_unassigned('workforce.view') as unassigned
    from company
    where tenant_id = app.current_tenant_id() and app.access_workforce_projection_company(id)
  `);
  const companyIds = scope?.company_ids ?? [];
  return {companyIds, canOpen: companyIds.length > 0 || scope?.unassigned === true};
 };
 return withPersonnelRead(ctx, read);
}
