/** Payroll history learning, P1 — each company's learning mode (migration 2012 payroll_learning_mode).
 *
 *  - off: the default (no row). Nothing is learned for the company and nothing learned is shown.
 *  - evidence: the company's closed payroll history is learned from and payroll HR sees evidence lines.
 *  - classify: phase P4 (a stable baseline may set a warning to info, never a block). Reached only by an approved proposal
 *    backed by backtest evidence (phase P3): nobody may set it here, and the database refuses it too.
 * Every change is a new version, attributed to the payroll administrator who made it and audited as a domain event; the
 * earlier mode is restored by setting it again. The administrator who last switched learning on for a company sponsors it:
 * the learning runs (./recompute.ts) read and write under their current authority, re-read every time. Learning never
 * changes a calculation, a permission or a disclosure rule. */
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {payrollLearningMode,type PayrollLearningMode} from '../../db/payroll-learning-schema';
import {canManagePayroll} from '../../lib/authz-model';

export const LEARNING_MODES:readonly PayrollLearningMode[]=Object.freeze(['off','evidence','classify']);
/** The modes a payroll administrator may set directly. */
export const SETTABLE_LEARNING_MODES=Object.freeze(['off','evidence'] as const);
export class PayrollLearningRefused extends Error{constructor(readonly reason:'not_permitted'|'invalid'|'unchanged'){super('Payroll learning refused: '+reason);this.name='PayrollLearningRefused';}}

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

/** The company's mode history, newest first, as a payroll administrator may read it. */
export async function learningModeHistoryTx(tx:Tx,tenantId:string,companyId:string,limit=20){
 return tx.select().from(payrollLearningMode).where(and(eq(payrollLearningMode.tenantId,tenantId),eq(payrollLearningMode.companyId,companyId)))
  .orderBy(desc(payrollLearningMode.version)).limit(Math.min(100,Math.max(1,limit)));
}

const Input=z.object({companyId:z.guid(),mode:z.enum(SETTABLE_LEARNING_MODES)}).strict();
/** Sets a company's learning mode to off or evidence, as a payroll administrator of the company, as a new version. */
export async function setPayrollLearningMode(supplied:SessionContext,input:unknown):Promise<CompanyLearningMode>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!canManagePayroll(ctx))throw new PayrollLearningRefused('not_permitted');
 const parsed=Input.safeParse(input);
 if(!parsed.success)throw new PayrollLearningRefused('invalid');
 const {companyId,mode}=parsed.data;
 return withTenant(ctx,async tx=>{
  const [allowed]=await tx.execute(sql`select app.can_admin_payroll_for(${companyId}::uuid) as ok`) as unknown as {ok:boolean|null}[];
  if(allowed?.ok!==true)throw new PayrollLearningRefused('not_permitted');
  const current=(await learningModesTx(tx,ctx.tenantId,[companyId])).get(companyId)!;
  if(current.mode===mode)throw new PayrollLearningRefused('unchanged');
  const [row]=await tx.insert(payrollLearningMode).values({tenantId:ctx.tenantId,companyId,version:current.version+1,mode,source:'admin',setByUserId:ctx.userId!}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-learning',aggregateId:companyId,eventType:'payroll-learning.mode-set',actor:actorOf(ctx),
   payload:{companyId,mode,from:current.mode,version:row.version}});
  return Object.freeze({companyId,mode:row.mode,version:row.version,setByUserId:row.setByUserId,setAt:row.setAt});
 });
}
