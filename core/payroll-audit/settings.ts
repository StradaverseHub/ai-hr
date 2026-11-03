/** AI v2 P2-2b — the Audit loop's per-company control settings, and the optional auditor grant.
 *
 * Settings: the bank-change window in days (default 7, between 3 and 30), the manual-adjustment amount above which a reason
 * is expected (default 1000.00, between 100.00 and 50000.00), and whether "one login both processed and closed a run"
 * opens a finding or is information only (default information: owner decision 2 has no second approver). No row means the
 * defaults. A payroll administrator of the company tightens them under their own login; LOOSENING one (a shorter window,
 * a higher amount, a finding made information) needs a group administrator, and the database refuses anyone else
 * (migration 2006). Every change is attributed in the row and audited as a `payroll-audit.settings-changed` event with
 * before and after, which the Audit loop captures into the month's pack as a configuration change (Phase 2 hardening).
 * Auditor: an administrator of a company lets a named login of the same tenant read that company's Audit loop and audit
 * pack, read-only, until revoked. An administrator never grants themselves; a grant is revoked once and never rewritten
 * (migration 0965). Both changes are audited. */
import {and,eq,isNull,sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {payrollAuditControlSetting,payrollAuditReader} from '../../db/payroll-audit-schema';
import {canManagePayroll,isAdmin,isGroupAdmin} from '../../lib/authz-model';
import {AUDIT_CONTROL_BOUNDS,AUDIT_CONTROL_DEFAULTS,PREPARER_CLOSED_MODES,type PreparerClosedMode} from './types';

export type AuditControlSettings=Readonly<{bankChangeDays:number;adjustmentThreshold:number;preparerClosedMode:PreparerClosedMode;version:number|null}>;
export class AuditSettingsRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'|'not_found'|'group_administrator'){super('Audit settings refused: '+reason);this.name='AuditSettingsRefused';}}
/** Whether moving from one setting to another loosens a control: fewer days watched, a higher amount, or a finding made
 * information. Pure; the database repeats it (app.payroll_audit_control_setting_guard). */
export const loosensAuditControl=(before:Pick<AuditControlSettings,'bankChangeDays'|'adjustmentThreshold'|'preparerClosedMode'>,
 after:Pick<AuditControlSettings,'bankChangeDays'|'adjustmentThreshold'|'preparerClosedMode'>)=>
 after.bankChangeDays<before.bankChangeDays||after.adjustmentThreshold>before.adjustmentThreshold
 ||(before.preparerClosedMode==='finding'&&after.preparerClosedMode==='info');
const clone=(supplied:SessionContext):SessionContext=>({...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))});
const ok=async(tx:Tx,query:SQL)=>((await tx.execute(query)) as unknown as {ok:boolean|null}[])[0]?.ok===true;

/** The company's settings, or the defaults. */
export async function controlSettingsTx(tx:Tx,tenantId:string,companyId:string):Promise<AuditControlSettings>{
 const [row]=await tx.select().from(payrollAuditControlSetting)
  .where(and(eq(payrollAuditControlSetting.tenantId,tenantId),eq(payrollAuditControlSetting.companyId,companyId))).limit(1);
 return Object.freeze(row?{bankChangeDays:row.bankChangeDays,adjustmentThreshold:Number(row.adjustmentThreshold),preparerClosedMode:row.preparerClosedMode,version:row.version}
  :{...AUDIT_CONTROL_DEFAULTS,version:null});
}

export async function setControlSettings(supplied:SessionContext,input:Readonly<{companyId:unknown;bankChangeDays:unknown;adjustmentThreshold:unknown;preparerClosedMode?:unknown}>){
 const ctx=clone(supplied);
 if(!ctx.userId||ctx.agent||!canManagePayroll(ctx))throw new AuditSettingsRefused('not_administrator');
 const B=AUDIT_CONTROL_BOUNDS;
 const parsed=z.object({companyId:z.guid(),bankChangeDays:z.number().int().min(B.bankChangeDays.min).max(B.bankChangeDays.max),
  adjustmentThreshold:z.number().min(B.adjustmentThreshold.min).max(B.adjustmentThreshold.max).refine(value=>Number(value.toFixed(2))===value),
  preparerClosedMode:z.enum(PREPARER_CLOSED_MODES).optional()}).strict().safeParse(input);
 if(!parsed.success)throw new AuditSettingsRefused('invalid');
 const {companyId,bankChangeDays}=parsed.data,threshold=parsed.data.adjustmentThreshold.toFixed(2);
 return withTenant(ctx,async tx=>{
  if(!await ok(tx,sql`select app.can_admin_payroll_for(${companyId}::uuid) as ok`))throw new AuditSettingsRefused('not_administrator');
  const before=await controlSettingsTx(tx,ctx.tenantId,companyId);
  const preparerClosedMode=parsed.data.preparerClosedMode??before.preparerClosedMode;
  // Loosening a control is a group administrator's (the database refuses anyone else as well).
  if(loosensAuditControl(before,{bankChangeDays,adjustmentThreshold:Number(threshold),preparerClosedMode})&&!isGroupAdmin(ctx))
   throw new AuditSettingsRefused('group_administrator');
  const where=and(eq(payrollAuditControlSetting.tenantId,ctx.tenantId),eq(payrollAuditControlSetting.companyId,companyId));
  const [row]=before.version!==null
   ?await tx.update(payrollAuditControlSetting).set({bankChangeDays,adjustmentThreshold:threshold,preparerClosedMode,changedByUserId:ctx.userId!,changedAt:sql`now()`}).where(where).returning()
   :await tx.insert(payrollAuditControlSetting).values({tenantId:ctx.tenantId,companyId,bankChangeDays,adjustmentThreshold:threshold,preparerClosedMode,changedByUserId:ctx.userId!}).returning();
  if(!row)throw new AuditSettingsRefused('not_administrator');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-audit-setting',aggregateId:companyId,eventType:'payroll-audit.settings-changed',actor:actorOf(ctx),
   payload:{companyId,before:{bankChangeDays:before.bankChangeDays,adjustmentThreshold:before.adjustmentThreshold.toFixed(2),preparerClosedMode:before.preparerClosedMode},
    after:{bankChangeDays,adjustmentThreshold:threshold,preparerClosedMode},version:row.version}});
  return Object.freeze({bankChangeDays:row.bankChangeDays,adjustmentThreshold:Number(row.adjustmentThreshold),preparerClosedMode:row.preparerClosedMode,version:row.version});
 });
}

export async function grantAuditReader(supplied:SessionContext,input:Readonly<{companyId:unknown;appUserId:unknown}>){
 const ctx=clone(supplied);
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new AuditSettingsRefused('not_administrator');
 const parsed=z.object({companyId:z.guid(),appUserId:z.guid()}).strict().safeParse(input);
 if(!parsed.success||parsed.data.appUserId===ctx.userId)throw new AuditSettingsRefused('invalid');
 const {companyId,appUserId}=parsed.data;
 return withTenant(ctx,async tx=>{
  if(!await ok(tx,sql`select app.is_admin_for(${companyId}::uuid) as ok`))throw new AuditSettingsRefused('not_administrator');
  const [existing]=await tx.select().from(payrollAuditReader).where(and(eq(payrollAuditReader.tenantId,ctx.tenantId),eq(payrollAuditReader.companyId,companyId),
   eq(payrollAuditReader.appUserId,appUserId),isNull(payrollAuditReader.revokedAt))).limit(1);
  if(existing)return Object.freeze(existing);
  const [row]=await tx.insert(payrollAuditReader).values({tenantId:ctx.tenantId,companyId,appUserId,grantedByUserId:ctx.userId!}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-audit-reader',aggregateId:row!.id,eventType:'payroll-audit.reader-granted',actor:actorOf(ctx),
   payload:{companyId,appUserId}});
  return Object.freeze(row!);
 });
}

export async function revokeAuditReader(supplied:SessionContext,input:Readonly<{grantId:unknown}>){
 const ctx=clone(supplied);
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new AuditSettingsRefused('not_administrator');
 const grantId=z.guid().safeParse(input.grantId);
 if(!grantId.success)throw new AuditSettingsRefused('invalid');
 return withTenant(ctx,async tx=>{
  const [row]=await tx.update(payrollAuditReader).set({revokedAt:sql`now()`,revokedByUserId:ctx.userId!})
   .where(and(eq(payrollAuditReader.tenantId,ctx.tenantId),eq(payrollAuditReader.id,grantId.data),isNull(payrollAuditReader.revokedAt))).returning();
  if(!row)throw new AuditSettingsRefused('not_found');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-audit-reader',aggregateId:row.id,eventType:'payroll-audit.reader-revoked',actor:actorOf(ctx),
   payload:{companyId:row.companyId,appUserId:row.appUserId}});
  return Object.freeze(row);
 });
}

/** Whether the caller may read the company's Audit loop and pack: a payroll administrator of it, or a current auditor. */
export async function canReadAuditTx(tx:Tx,companyId:string):Promise<boolean>{
 return ok(tx,sql`select app.payroll_audit_can_read(${companyId}::uuid) as ok`);
}

export type AuditReaderView=Readonly<{id:string;appUserId:string;label:string|null;grantedAt:Date;grantedBy:string|null}>;
export type AuditCompanyAdministration=Readonly<{companyId:string;companyName:string;settings:AuditControlSettings;readers:readonly AuditReaderView[]}>;
export type AuditAdministration=Readonly<{companies:readonly AuditCompanyAdministration[];candidates:readonly Readonly<{appUserId:string;label:string|null}>[]}>;
const label=(name:unknown,email:unknown)=>{const parts=[name,email].filter((v):v is string=>typeof v==='string'&&v.trim()!=='');return parts.length?parts.join(' · '):null;};

/** What the Audit loop page's administration card shows a group or HR administrator: per company they administer, the control
 * settings and the current auditors; and the logins of the tenant they may give access to (never themselves). Read under the
 * administrator's own row-level security. */
export async function auditAdministration(supplied:SessionContext,input:Readonly<{companyIds?:readonly string[]}>={}):Promise<AuditAdministration>{
 const ctx=clone(supplied);
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new AuditSettingsRefused('not_administrator');
 return withTenant(ctx,async tx=>{
  const all=Array.from(await tx.execute(sql`select c.id,c.legal_name from public.company c where c.tenant_id=${ctx.tenantId}::uuid
   and app.is_admin_for(c.id) and app.can_admin_payroll_for(c.id) order by c.legal_name,c.id`) as unknown as {id:string;legal_name:string}[]);
  const wanted=input.companyIds?.length?new Set(input.companyIds):null;
  const companies:AuditCompanyAdministration[]=[];
  for(const item of all.filter(row=>!wanted||wanted.has(row.id))){
   const readers=Array.from(await tx.execute(sql`select r.id,r.app_user_id,r.granted_at,r.granted_by_user_id,p.full_name,p.primary_email
    from public.payroll_audit_reader r left join public.app_user u on u.id=r.app_user_id left join public.person p on p.id=u.person_id
    where r.tenant_id=${ctx.tenantId}::uuid and r.company_id=${item.id}::uuid and r.revoked_at is null order by r.granted_at,r.id`) as unknown as
    {id:string;app_user_id:string;granted_at:string|Date;granted_by_user_id:string|null;full_name:string|null;primary_email:string|null}[]);
   companies.push(Object.freeze({companyId:item.id,companyName:item.legal_name,settings:await controlSettingsTx(tx,ctx.tenantId,item.id),
    readers:Object.freeze(readers.map(row=>Object.freeze({id:row.id,appUserId:row.app_user_id,label:label(row.full_name,row.primary_email),
     grantedAt:row.granted_at instanceof Date?row.granted_at:new Date(String(row.granted_at)),grantedBy:row.granted_by_user_id})))}));
  }
  const candidates=Array.from(await tx.execute(sql`select u.id,p.full_name,p.primary_email from public.app_user u left join public.person p on p.id=u.person_id
   where u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and u.id<>${ctx.userId!}::uuid order by p.full_name nulls last,u.id limit 500`) as unknown as
   {id:string;full_name:string|null;primary_email:string|null}[]);
  return Object.freeze({companies:Object.freeze(companies),
   candidates:Object.freeze(candidates.map(row=>Object.freeze({appUserId:row.id,label:label(row.full_name,row.primary_email)})))});
 });
}
