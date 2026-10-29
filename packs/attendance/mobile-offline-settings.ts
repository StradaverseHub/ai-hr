/** Per-company offline clocking settings: the one write service for draft 0647's two attendance_policy columns, and
 * the settings card's phones-offline-now and waiting-for-review counts (owner-approved design 2026-10-28). Reachable from the facade, so no
 * 'server-only' import here or below.
 *
 * The columns exist only where draft 0647 is installed and db/schema.ts does not declare them, so every statement
 * that names them runs only after offlineClockingColumnsPresentTx answered true in the same transaction. Their
 * presence is read once per transaction from pg_attribute and never cached per process (a hosted worker installs and
 * drops the draft at runtime), as core/attendance-clock.ts reads attendance_clock_capture.effective_at.
 *
 * Who may write: the attendance policy's own rule, can_admin_payroll_for(company) (attendance_policy_rls, 0099),
 * checked here so a refusal is typed rather than an RLS error; the screen adds requireAdmin. The upsert names only the
 * two offline columns: an existing row keeps every other column, and a new row takes the table defaults for them. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {withAttendanceTenant} from '../../core/module-gate';
import {OFFLINE_PROVEN_WINDOW_SECONDS,readOfflineClockingPolicyTx,type OfflineClockingPolicy} from './mobile-offline-adjudicator';

export type OfflineClockingSettingsRefusal='invalid_input'|'forbidden'|'unavailable';
/** invalid_input: not a company id, a boolean and a whole number of seconds from 60 to 86400 (the DB CHECK).
 * forbidden: not a company of this tenant the session may administer. unavailable: draft 0647 is not installed. */
export class OfflineClockingSettingsError extends Error{
 constructor(readonly reason:OfflineClockingSettingsRefusal){super('Offline clocking settings unavailable');this.name='OfflineClockingSettingsError';}
}
const refuse=(reason:OfflineClockingSettingsRefusal)=>new OfflineClockingSettingsError(reason);

const columnsByTx=new WeakMap<Tx,Promise<boolean>>();
/** Whether attendance_policy carries both draft 0647 columns, read once per transaction. */
export function offlineClockingColumnsPresentTx(tx:Tx):Promise<boolean>{
 let present=columnsByTx.get(tx);
 if(!present){
  present=tx.execute<{present:boolean}>(sql`select count(*)=2 as present from pg_attribute where attrelid=to_regclass('public.attendance_policy')
   and attname in ('offline_clocking_enabled','offline_max_proven_window_seconds') and not attisdropped`).then(([row])=>row?.present===true);
  columnsByTx.set(tx,present);
 }
 return present;
}

export type OfflineClockingSettingsView={columns:boolean;canEdit:boolean;policy:OfflineClockingPolicy};
/** The card's read of one company: whether the columns exist, whether this session may change them, and the stored
 * policy (the engine default, OFF and 900 s, when there is no row or no draft). */
export async function readOfflineClockingSettingsTx(tx:Tx,companyId:string):Promise<OfflineClockingSettingsView>{
 const id=z.string().uuid().safeParse(companyId);if(!id.success)throw refuse('invalid_input');
 const [allowed]=await tx.execute<{allowed:boolean}>(sql`select coalesce(app.can_admin_payroll_for(${id.data}::uuid),false) as allowed`);
 return {columns:await offlineClockingColumnsPresentTx(tx),canEdit:allowed?.allowed===true,policy:await readOfflineClockingPolicyTx(tx,id.data)};
}

const PolicyInput=z.object({companyId:z.string().uuid().transform(value=>value.toLowerCase()),enabled:z.boolean(),
 maxProvenWindowSeconds:z.number().int().min(OFFLINE_PROVEN_WINDOW_SECONDS.minimum).max(OFFLINE_PROVEN_WINDOW_SECONDS.maximum)}).strict();
export type OfflineClockingPolicyInput=z.input<typeof PolicyInput>;
/** Sets one company's offline clocking switch and maximum proven window. Writes only those two columns, and one audit
 * event with the previous values (the engine default when no row existed) and the new ones. */
export async function setOfflineClockingPolicy(ctx:SessionContext,input:OfflineClockingPolicyInput){
 const parsed=PolicyInput.safeParse(input);if(!parsed.success)throw refuse('invalid_input');const p=parsed.data;
 return withAttendanceTenant(ctx,async tx=>{
  if(!(await offlineClockingColumnsPresentTx(tx)))throw refuse('unavailable');
  const [allowed]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from company c where c.id=${p.companyId}::uuid and c.tenant_id=${ctx.tenantId}::uuid)
   and coalesce(app.can_admin_payroll_for(${p.companyId}::uuid),false) as allowed`);
  if(allowed?.allowed!==true)throw refuse('forbidden');
  // The row is locked before it is read, so the recorded previous values are the ones this write replaced.
  const [before]=await tx.execute<{enabled:boolean;seconds:number}>(sql`select offline_clocking_enabled enabled,offline_max_proven_window_seconds seconds
   from attendance_policy where company_id=${p.companyId}::uuid and tenant_id=${ctx.tenantId}::uuid for update`);
  const previous={stored:Boolean(before),enabled:before?before.enabled===true:false,maxProvenWindowSeconds:before?Number(before.seconds):OFFLINE_PROVEN_WINDOW_SECONDS.default};
  const [row]=await tx.execute<{id:string}>(sql`insert into attendance_policy (tenant_id,company_id,offline_clocking_enabled,offline_max_proven_window_seconds)
   values (${ctx.tenantId}::uuid,${p.companyId}::uuid,${p.enabled},${p.maxProvenWindowSeconds})
   on conflict (company_id) do update set offline_clocking_enabled=excluded.offline_clocking_enabled,offline_max_proven_window_seconds=excluded.offline_max_proven_window_seconds
   returning id`);
  if(!row?.id)throw refuse('unavailable');
  const next={enabled:p.enabled,maxProvenWindowSeconds:p.maxProvenWindowSeconds};
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-policy',aggregateId:row.id,eventType:'attendance-policy.offline-clocking.updated',actor:actorOf(ctx),
   payload:{companyId:p.companyId,previous,next}});
  return {id:row.id,previous,next};
 });
}

/** Held claims of `companyIds` (the employment's current company) with no human resolution yet, that this session may
 * correct (RLS and app.can_correct_attendance, as the review list reads them). null: draft 0647 is not installed. */
export async function countOfflineClaimsAwaitingReviewTx(tx:Tx,companyIds:readonly string[]):Promise<number|null>{
 const ids=companyIds.filter(value=>z.string().uuid().safeParse(value).success);
 const [ready]=await tx.execute<{ready:boolean}>(sql`select to_regclass('public.mobile_offline_claim_resolution') is not null as ready`);
 if(ready?.ready!==true)return null;
 if(!ids.length)return 0;
 const [row]=await tx.execute<{count:number}>(sql`select count(*)::int as count from mobile_offline_claim c join employment e on e.id=c.employment_id
  where c.tenant_id=app.current_tenant_id() and c.outcome='needs_review' and e.company_id=any(array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)}]::uuid[])
  and app.can_correct_attendance(c.employment_id) and not exists(select 1 from mobile_offline_claim_resolution r where r.claim_id=c.id and r.tenant_id=c.tenant_id)`);
 return Number(row?.count??0);
}
/** Open offline contexts of one company (phones that may clock offline now: not closed, not expired), counted by draft
 * 0647's definer app.mobile_offline_open_context_count, because context rows are readable only by their own actor.
 * null: the draft (the function) is not installed, or this session may not administer the company's attendance policy
 * (the function refuses with NULL, never a count). */
export async function countOpenOfflineContextsTx(tx:Tx,companyId:string):Promise<number|null>{
 const id=z.string().uuid().safeParse(companyId);if(!id.success)return null;
 const [ready]=await tx.execute<{ready:boolean}>(sql`select to_regprocedure('app.mobile_offline_open_context_count(uuid)') is not null as ready`);
 if(ready?.ready!==true)return null;
 const [row]=await tx.execute<{count:number|null}>(sql`select app.mobile_offline_open_context_count(${id.data}::uuid) as count`);
 return row?.count==null?null:Number(row.count);
}
export function countOpenOfflineContexts(ctx:SessionContext,companyId:string){return withAttendanceTenant(ctx,tx=>countOpenOfflineContextsTx(tx,companyId));}
export function countOfflineClaimsAwaitingReview(ctx:SessionContext,companyIds:readonly string[]){return withAttendanceTenant(ctx,tx=>countOfflineClaimsAwaitingReviewTx(tx,companyIds));}
export function readOfflineClockingSettings(ctx:SessionContext,companyId:string){return withAttendanceTenant(ctx,tx=>readOfflineClockingSettingsTx(tx,companyId));}
