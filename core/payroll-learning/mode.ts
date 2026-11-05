/** Payroll history learning, P1 — each company's learning mode (migration 2012 payroll_learning_mode).
 *
 *  - off: the default (no row). Nothing is learned for the company and nothing learned is shown.
 *  - evidence: the company's closed payroll history is learned from and payroll HR sees evidence lines.
 *  - classify: phase P4 (a stable baseline may set a warning to info, never a block). Reached only by an approved proposal
 *    backed by backtest evidence (phase P3): nobody may set it here, and the database refuses it too.
 * Who: only a GROUP ADMINISTRATOR switches evidence on (the loosening direction, as for the loops' other settings); any
 * payroll administrator of the company switches it off. Every change is a new version, attributed to the person who made it
 * and recorded as a `payroll-learning.mode-set` configuration event, which the Audit loop's pack captures for the month
 * (core/payroll-audit/capture.ts CONFIG_EVENT_PREFIXES); the earlier mode is restored by setting it again. The group
 * administrator who last switched learning on for a company sponsors it: the learning runs (./recompute.ts) read and write
 * under their current authority, re-read every time. Learning never changes a calculation, a permission or a disclosure
 * rule. Set on AI Centre › Operations › Loops › Payroll cycle › Settings. */
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {appUser,person} from '../../db/schema';
import {payrollLearningMode,type PayrollLearningMode} from '../../db/payroll-learning-schema';
import {canManagePayroll,isGroupAdmin} from '../../lib/authz-model';

export const LEARNING_MODES:readonly PayrollLearningMode[]=Object.freeze(['off','evidence','classify']);
/** The modes a person may set directly: off (any payroll administrator) and evidence (a group administrator). */
export const SETTABLE_LEARNING_MODES=Object.freeze(['off','evidence'] as const);
/** The audited configuration event of a change (captured by the Audit loop's pack). */
export const LEARNING_MODE_EVENT='payroll-learning.mode-set' as const;
export class PayrollLearningRefused extends Error{constructor(readonly reason:'not_permitted'|'group_administrator'|'invalid'|'unchanged'){super('Payroll learning refused: '+reason);this.name='PayrollLearningRefused';}}

export type CompanyLearningMode=Readonly<{companyId:string;mode:PayrollLearningMode;version:number;setByUserId:string|null;setAt:Date|null}>;

/** Each company's current mode as the caller may read it (a payroll administrator, or the agent principal); off when none. */
export async function learningModesTx(tx:Tx,tenantId:string,companyIds:readonly string[]):Promise<Map<string,CompanyLearningMode>>{
 const out=new Map<string,CompanyLearningMode>(companyIds.map(companyId=>[companyId,Object.freeze({companyId,mode:'off' as const,version:0,setByUserId:null,setAt:null})]));
 if(!companyIds.length)return out;
 const rows=await tx.select({companyId:payrollLearningMode.companyId,mode:payrollLearningMode.mode,version:payrollLearningMode.version,
  setByUserId:payrollLearningMode.setByUserId,setAt:payrollLearningMode.setAt}).from(payrollLearningMode)
  .where(and(eq(payrollLearningMode.tenantId,tenantId),inArray(payrollLearningMode.companyId,[...companyIds]))).orderBy(desc(payrollLearningMode.version));
 const seen=new Set<string>();
 for(const row of rows){if(seen.has(row.companyId))continue;seen.add(row.companyId);out.set(row.companyId,Object.freeze({...row}));}
 return out;
}

export type LearningModeHistoryRow=Readonly<{version:number;mode:PayrollLearningMode;source:'admin'|'proposal';by:string|null;at:Date}>;
export type LearningSettings=Readonly<{companyId:string;mode:PayrollLearningMode;version:number;history:readonly LearningModeHistoryRow[]}>;
/** The settings page's learning section: for each of `companyIds` whose payroll the viewer administers, the current mode
 * and its history, newest first, with who changed it where the viewer may read their name. Others are left out. */
export async function learningSettingsView(ctx:SessionContext,companyIds:readonly string[]):Promise<ReadonlyMap<string,LearningSettings>>{
 if(!ctx.userId||ctx.agent||!companyIds.length)return new Map();
 return withTenant(ctx,async tx=>{
  const allowed=(Array.from(await tx.execute(sql`select c.id from public.company c where c.tenant_id=${ctx.tenantId}::uuid
   and c.id in (${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`,`)}) and app.can_admin_payroll_for(c.id) is true`)) as unknown as {id:string}[]).map(row=>row.id);
  if(!allowed.length)return new Map();
  const rows=await tx.select({companyId:payrollLearningMode.companyId,version:payrollLearningMode.version,mode:payrollLearningMode.mode,source:payrollLearningMode.source,
   at:payrollLearningMode.setAt,name:person.fullName}).from(payrollLearningMode)
   .leftJoin(appUser,eq(appUser.id,payrollLearningMode.setByUserId)).leftJoin(person,eq(person.id,appUser.personId))
   .where(and(eq(payrollLearningMode.tenantId,ctx.tenantId),inArray(payrollLearningMode.companyId,allowed))).orderBy(desc(payrollLearningMode.version));
  return new Map(allowed.map(companyId=>{
   const own=rows.filter(row=>row.companyId===companyId).slice(0,20);
   return [companyId,Object.freeze({companyId,mode:own[0]?.mode??'off',version:own[0]?.version??0,
    history:Object.freeze(own.map(row=>Object.freeze({version:row.version,mode:row.mode,source:row.source,by:row.name??null,at:row.at})))})] as const;
  }));
 });
}

const Input=z.object({companyId:z.guid(),mode:z.enum(SETTABLE_LEARNING_MODES)}).strict();
/** Sets a company's learning mode, as a new version: evidence by a group administrator, off by any payroll administrator
 * of the company. */
export async function setPayrollLearningMode(supplied:SessionContext,input:unknown):Promise<CompanyLearningMode>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!canManagePayroll(ctx))throw new PayrollLearningRefused('not_permitted');
 const parsed=Input.safeParse(input);
 if(!parsed.success)throw new PayrollLearningRefused('invalid');
 const {companyId,mode}=parsed.data;
 if(mode==='evidence'&&!isGroupAdmin(ctx))throw new PayrollLearningRefused('group_administrator');
 return withTenant(ctx,async tx=>{
  const [allowed]=await tx.execute(sql`select app.can_admin_payroll_for(${companyId}::uuid) as ok`) as unknown as {ok:boolean|null}[];
  if(allowed?.ok!==true)throw new PayrollLearningRefused('not_permitted');
  const current=(await learningModesTx(tx,ctx.tenantId,[companyId])).get(companyId)!;
  if(current.mode===mode)throw new PayrollLearningRefused('unchanged');
  const [row]=await tx.insert(payrollLearningMode).values({tenantId:ctx.tenantId,companyId,version:current.version+1,mode,source:'admin',setByUserId:ctx.userId!}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-learning',aggregateId:companyId,eventType:LEARNING_MODE_EVENT,actor:actorOf(ctx),
   payload:{companyId,mode,from:current.mode,version:row.version,source:'admin'}});
  return Object.freeze({companyId,mode:row.mode,version:row.version,setByUserId:row.setByUserId,setAt:row.setAt});
 });
}
