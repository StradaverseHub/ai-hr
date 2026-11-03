/** AI v2 P2-2b — the Audit loop's per-company control settings, and the optional auditor grant.
 *
 * Settings: the bank-change window in days (default 7) and the manual-adjustment amount above which a reason is expected
 * (default 1000.00). No row means the defaults. A payroll administrator of the company changes them under their own login;
 * the change is attributed in the row and audited as a domain event with before and after.
 * Auditor: an administrator of a company lets a named login of the same tenant read that company's Audit loop and audit
 * pack, read-only, until revoked. An administrator never grants themselves; a grant is revoked once and never rewritten
 * (migration 0965). Both changes are audited. */
import {and,eq,isNull,sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {payrollAuditControlSetting,payrollAuditReader} from '../../db/payroll-audit-schema';
import {canManagePayroll,isAdmin} from '../../lib/authz-model';
import {AUDIT_CONTROL_DEFAULTS} from './types';

export type AuditControlSettings=Readonly<{bankChangeDays:number;adjustmentThreshold:number;version:number|null}>;
export class AuditSettingsRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'|'not_found'){super('Audit settings refused: '+reason);this.name='AuditSettingsRefused';}}
const clone=(supplied:SessionContext):SessionContext=>({...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))});
const ok=async(tx:Tx,query:SQL)=>((await tx.execute(query)) as unknown as {ok:boolean|null}[])[0]?.ok===true;

/** The company's settings, or the defaults. */
export async function controlSettingsTx(tx:Tx,tenantId:string,companyId:string):Promise<AuditControlSettings>{
 const [row]=await tx.select().from(payrollAuditControlSetting)
  .where(and(eq(payrollAuditControlSetting.tenantId,tenantId),eq(payrollAuditControlSetting.companyId,companyId))).limit(1);
 return Object.freeze(row?{bankChangeDays:row.bankChangeDays,adjustmentThreshold:Number(row.adjustmentThreshold),version:row.version}
  :{...AUDIT_CONTROL_DEFAULTS,version:null});
}

export async function setControlSettings(supplied:SessionContext,input:Readonly<{companyId:unknown;bankChangeDays:unknown;adjustmentThreshold:unknown}>){
 const ctx=clone(supplied);
 if(!ctx.userId||ctx.agent||!canManagePayroll(ctx))throw new AuditSettingsRefused('not_administrator');
 const parsed=z.object({companyId:z.guid(),bankChangeDays:z.number().int().min(1).max(60),adjustmentThreshold:z.number().positive().max(9_999_999_999.99)
  .refine(value=>Number(value.toFixed(2))===value)}).strict().safeParse(input);
 if(!parsed.success)throw new AuditSettingsRefused('invalid');
 const {companyId,bankChangeDays}=parsed.data,threshold=parsed.data.adjustmentThreshold.toFixed(2);
 return withTenant(ctx,async tx=>{
  if(!await ok(tx,sql`select app.can_admin_payroll_for(${companyId}::uuid) as ok`))throw new AuditSettingsRefused('not_administrator');
  const before=await controlSettingsTx(tx,ctx.tenantId,companyId);
  const where=and(eq(payrollAuditControlSetting.tenantId,ctx.tenantId),eq(payrollAuditControlSetting.companyId,companyId));
  const [row]=before.version!==null
   ?await tx.update(payrollAuditControlSetting).set({bankChangeDays,adjustmentThreshold:threshold,changedByUserId:ctx.userId!,changedAt:sql`now()`}).where(where).returning()
   :await tx.insert(payrollAuditControlSetting).values({tenantId:ctx.tenantId,companyId,bankChangeDays,adjustmentThreshold:threshold,changedByUserId:ctx.userId!}).returning();
  if(!row)throw new AuditSettingsRefused('not_administrator');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-audit-setting',aggregateId:companyId,eventType:'payroll-audit.settings-changed',actor:actorOf(ctx),
   payload:{companyId,before:{bankChangeDays:before.bankChangeDays,adjustmentThreshold:before.adjustmentThreshold.toFixed(2)},after:{bankChangeDays,adjustmentThreshold:threshold},
    version:row.version}});
  return Object.freeze({bankChangeDays:row.bankChangeDays,adjustmentThreshold:Number(row.adjustmentThreshold),version:row.version});
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
