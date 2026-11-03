/** AI v2 Phase 2, P2-6 — the loops' improvement proposals in one list, applied only by an administrator, versioned and
 * reversible.
 *
 * WHAT IS LISTED. Today the loops propose one kind of change: P2-2a's net-swing threshold proposals for the Salary payroll
 * loop (a higher threshold, or an excluded pay pattern), derived from payroll HR's own dispositions
 * (core/loops/swing-proposals.ts). Each company's open proposals are listed, and each applied one while it is still in force,
 * so it can be reverted. P2-1 makes no limit suggestions: its limits only become stricter without a promotion, and promotion
 * is by certificate on the loop's own page, never from here (core/loops/autonomy.ts). This module therefore surfaces no
 * limit change and promotes nothing.
 *
 * HOW A CHANGE IS APPLIED. Approving or rejecting calls the owner (core/loops/payroll-loop-settings.ts
 * decideThresholdProposal), which re-derives the proposal from the dispositions as they are now and refuses a stale one; an
 * approval writes the next settings version, attributed and audited. REVERTING writes the next version too, with the value
 * the proposal replaced (the threshold it raised from, or the exclusion removed), through the owner's own setter: nothing is
 * deleted, and the history keeps both. Applied from the next run. Nothing here touches the 11 payroll anomaly detectors,
 * a calculation, a permission or a disclosure rule. */
import {and,desc,eq,inArray} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasPayrollThresholdDecision} from '../../db/teras-payroll-cycle-schema';
import type {CapacityCompany} from '../capacity/baseline';
import {decideThresholdProposal,payrollLoopSettingsTx,setPayrollLoopSetting,thresholdProposalsTx,type PayrollLoopSetting} from '../loops/payroll-loop-settings';
import {LearningRefused,captureCtx,requireLearningAdmin} from './access';

export type LoopProposalView=Readonly<{
 /** open: waiting for an administrator; applied: approved and still in force (it can be reverted). */
 state:'open'|'applied';
 companyId:string;loop:'loop_salary_payroll';kind:'threshold'|'exclusion';
 /** The open proposal's key, for approve or reject. */
 proposalKey:string|null;
 /** The applied proposal's decision, for revert. */
 decisionId:string|null;
 fromThresholdBp:number;toThresholdBp:number|null;pattern:string|null;
 evidence:Readonly<{windowDays:number;flags:number;expected:number;problems:number;expectedShareBp:number;smallestProblemBp:number|null}>;
 decidedAt:Date|null}>;

/** Whether an approved decision's change is still what is in force. */
const inForce=(decision:Readonly<{kind:string;toThresholdBp:number|null;pattern:string|null}>,setting:PayrollLoopSetting)=>decision.kind==='threshold'
 ?setting.thresholdBp===decision.toThresholdBp:decision.pattern!==null&&setting.exclusions.includes(decision.pattern);

/** The open and applied proposals of the companies given (the viewer's, as the read's row-level security allows). */
export async function loopProposalsTx(tx:Tx,ctx:SessionContext,companies:readonly CapacityCompany[],now:Date):Promise<readonly LoopProposalView[]>{
 if(!companies.length)return Object.freeze([]);
 const out:LoopProposalView[]=[];
 const companyIds=companies.map(row=>row.id);
 const settings=await payrollLoopSettingsTx(tx,ctx.tenantId,companyIds);
 for(const company of companies){
  const {proposals}=await thresholdProposalsTx(tx,ctx.tenantId,company.id,now);
  for(const proposal of proposals)out.push(Object.freeze({state:'open',companyId:company.id,loop:'loop_salary_payroll',kind:proposal.kind,proposalKey:proposal.key,decisionId:null,
   fromThresholdBp:proposal.fromThresholdBp,toThresholdBp:proposal.toThresholdBp,pattern:proposal.pattern,evidence:proposal.evidence,decidedAt:null}));
 }
 const d=terasPayrollThresholdDecision;
 const approved=await tx.select().from(d).where(and(eq(d.tenantId,ctx.tenantId),inArray(d.companyId,companyIds),eq(d.decision,'approved')))
  .orderBy(desc(d.decidedAt),desc(d.id)).limit(100);
 const seen=new Set<string>();
 for(const row of approved){
  const setting=settings.get(row.companyId);
  // Only the latest approval of each change can still be in force.
  const change=row.companyId+'\u0000'+row.kind+'\u0000'+(row.kind==='threshold'?'':row.pattern);
  if(!setting||seen.has(change))continue;seen.add(change);
  if(!inForce(row,setting))continue;
  out.push(Object.freeze({state:'applied',companyId:row.companyId,loop:'loop_salary_payroll',kind:row.kind,proposalKey:null,decisionId:row.id,
   fromThresholdBp:row.fromThresholdBp,toThresholdBp:row.toThresholdBp,pattern:row.pattern,evidence:row.evidence,decidedAt:row.decidedAt}));
 }
 return Object.freeze(out);
}

const DecideInput=z.object({companyId:z.guid(),proposalKey:z.string().regex(/^[0-9a-f]{64}$/),decision:z.enum(['approved','rejected'])}).strict();
/** An administrator of the company approves or rejects one open proposal, through the owner (which re-derives it). */
export async function decideLoopProposal(supplied:SessionContext,input:unknown,options:Readonly<{now?:Date}>={}){
 const ctx=captureCtx(supplied);requireLearningAdmin(ctx);
 const parsed=DecideInput.safeParse(input);
 if(!parsed.success)throw new LearningRefused('invalid');
 return decideThresholdProposal(ctx,parsed.data,options);
}

const RevertInput=z.object({companyId:z.guid(),decisionId:z.guid()}).strict();
/** An administrator of the company reverts an applied proposal: the next settings version puts back what it replaced. A
 * proposal no longer in force (already reverted, or changed since) is refused as changed. */
export async function revertLoopProposal(supplied:SessionContext,input:unknown){
 const ctx=captureCtx(supplied);requireLearningAdmin(ctx);
 const parsed=RevertInput.safeParse(input);
 if(!parsed.success)throw new LearningRefused('invalid');
 const {companyId,decisionId}=parsed.data;
 const decision=await withTenant(ctx,async tx=>{
  const d=terasPayrollThresholdDecision;
  const [row]=await tx.select().from(d).where(and(eq(d.tenantId,ctx.tenantId),eq(d.companyId,companyId),eq(d.id,decisionId),eq(d.decision,'approved'))).limit(1);
  if(!row)throw new LearningRefused('not_found');
  const setting=(await payrollLoopSettingsTx(tx,ctx.tenantId,[companyId])).get(companyId)!;
  if(!inForce(row,setting))throw new LearningRefused('changed');
  return row;
 });
 // The owner's setter checks the administrator again, locks the company and writes the version with its audit event.
 const setting=decision.kind==='threshold'
  ?await setPayrollLoopSetting(ctx,{companyId,thresholdBp:decision.fromThresholdBp})
  :await setPayrollLoopSetting(ctx,{companyId,removeExclusion:decision.pattern!});
 await withTenant(ctx,tx=>appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-learning',aggregateId:companyId,eventType:'teras-learning.proposal-reverted',
  actor:actorOf(ctx),payload:{companyId,decisionId,kind:decision.kind,settingVersion:setting.version,fromThresholdBp:decision.fromThresholdBp,
   toThresholdBp:decision.toThresholdBp,pattern:decision.pattern}}));
 return Object.freeze({setting});
}
