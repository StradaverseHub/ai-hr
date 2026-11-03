/** AI v2 P2-2a — the payroll-cycle loops' per-company settings, and the administrators' decisions on threshold proposals
 * (migration 0964).
 *
 * Per company: how often the Pre-salary loop checks (hourly, twice daily or daily; default daily, owner decision 4) and the
 * Salary payroll loop's net-swing threshold (default 15%, owner decision 5) with the pay patterns excluded from it. Every
 * change is a new version row, attributed to the administrator of the company who made it, and audited as a domain event
 * with its before and after. The threshold is never loosened silently: the loop never writes a setting, a proposal
 * applies only when an administrator approves it here, and approving re-derives the proposal from the dispositions as
 * they are now (the owner re-check at Confirm), so a stale screen cannot apply what the evidence no longer supports.
 * Applies from the next run. Nothing here touches the 11 payroll anomaly detectors or their thresholds. */
import {and,desc,eq,gte,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasPayrollLoopSetting,terasPayrollSwingDisposition,terasPayrollThresholdDecision,type PayrollLoopCheckInterval} from '../../db/teras-payroll-cycle-schema';
import {terasLoopRun} from '../../db/teras-schema';
import {isAdmin} from '../../lib/authz-model';
import {DEFAULT_SWING_THRESHOLD_BP} from './net-swing';
import {PROPOSAL_WINDOW_DAYS,deriveSwingProposals,type SwingProposal} from './swing-proposals';
import type {LoopId} from './types';

export const CHECK_INTERVALS=Object.freeze(['hourly','twice_daily','daily'] as const);
export const DEFAULT_CHECK_INTERVAL:PayrollLoopCheckInterval='daily';
const INTERVAL_MINUTES:Readonly<Record<PayrollLoopCheckInterval,number>>=Object.freeze({hourly:60,twice_daily:720,daily:1440});
/** A sweep started a few minutes early still counts as the next one (a daily 03:00 job never skips a day). */
const INTERVAL_SLACK_MINUTES=5;
const DAY_MS=86_400_000;

export type PayrollLoopSetting=Readonly<{companyId:string;version:number;interval:PayrollLoopCheckInterval;thresholdBp:number;exclusions:readonly string[];
 source:'default'|'admin'|'proposal';changedByUserId:string|null;changedAt:Date|null}>;
export const defaultPayrollLoopSetting=(companyId:string):PayrollLoopSetting=>Object.freeze({companyId,version:0,interval:DEFAULT_CHECK_INTERVAL,
 thresholdBp:DEFAULT_SWING_THRESHOLD_BP,exclusions:Object.freeze([]),source:'default',changedByUserId:null,changedAt:null});

export class PayrollLoopRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'|'changed'|'already'|'not_found'){super('Payroll loop change refused: '+reason);this.name='PayrollLoopRefused';}}

/** The settings in force for each company, as this transaction may read them (an absent company has the defaults). */
export async function payrollLoopSettingsTx(tx:Tx,tenantId:string,companyIds:readonly string[]):Promise<Map<string,PayrollLoopSetting>>{
 const out=new Map(companyIds.map(companyId=>[companyId,defaultPayrollLoopSetting(companyId)]));
 if(!companyIds.length)return out;
 const rows=await tx.select().from(terasPayrollLoopSetting)
  .where(and(eq(terasPayrollLoopSetting.tenantId,tenantId),inArray(terasPayrollLoopSetting.companyId,[...companyIds])))
  .orderBy(terasPayrollLoopSetting.companyId,desc(terasPayrollLoopSetting.version));
 for(const row of rows){
  if((out.get(row.companyId)?.version??0)>=row.version)continue;
  out.set(row.companyId,Object.freeze({companyId:row.companyId,version:row.version,interval:row.checkInterval,thresholdBp:row.swingThresholdBp,
   exclusions:Object.freeze([...row.swingExclusions]),source:row.source,changedByUserId:row.changedByUserId,changedAt:row.changedAt}));
 }
 return out;
}

/** The companies the Pre-salary loop is due to check now: each company's own interval since its last completed run. */
export async function payrollLoopDueTx(tx:Tx,input:Readonly<{tenantId:string;workerId:LoopId;companies:readonly string[];now:Date}>):Promise<string[]>{
 if(!input.companies.length)return [];
 const settings=await payrollLoopSettingsTx(tx,input.tenantId,input.companies);
 const last=await tx.select({companyId:terasLoopRun.companyId,at:sql<Date>`max(${terasLoopRun.startedAt})`}).from(terasLoopRun)
  .where(and(eq(terasLoopRun.tenantId,input.tenantId),eq(terasLoopRun.workerId,input.workerId),eq(terasLoopRun.status,'ran'),
   inArray(terasLoopRun.companyId,[...input.companies])))
  .groupBy(terasLoopRun.companyId);
 const lastAt=new Map(last.map(row=>[row.companyId,row.at?new Date(row.at):null]));
 return input.companies.filter(companyId=>{
  const at=lastAt.get(companyId);
  if(!at)return true;
  const minutes=INTERVAL_MINUTES[settings.get(companyId)?.interval??DEFAULT_CHECK_INTERVAL]-INTERVAL_SLACK_MINUTES;
  return input.now.getTime()-at.getTime()>=minutes*60_000;
 });
}

const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const lockCompany=(tx:Tx,tenantId:string,companyId:string)=>tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`teras-payroll-loop-setting:${tenantId}:${companyId}`},0))`);
/** The company must be this tenant's and the person its administrator: app.is_admin_for answers from the grants alone,
 * so a group-wide grant of another tenant would pass it for any company id. */
async function requireCompanyAdminTx(tx:Tx,companyId:string){
 const [row]=await tx.execute(sql`select exists(select 1 from public.company c where c.id=${companyId}::uuid and c.tenant_id=app.current_tenant_id()
  and app.is_admin_for(c.id)) as ok`) as unknown as {ok:boolean|null}[];
 if(row?.ok!==true)throw new PayrollLoopRefused('not_administrator');
}
const guard=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new PayrollLoopRefused('not_administrator');};

async function writeSettingTx(tx:Tx,ctx:SessionContext,before:PayrollLoopSetting,next:Readonly<{interval:PayrollLoopCheckInterval;thresholdBp:number;exclusions:readonly string[]}>,
 source:'admin'|'proposal',decisionId:string|null){
 const version=before.version+1;
 const [row]=await tx.insert(terasPayrollLoopSetting).values({tenantId:ctx.tenantId,companyId:before.companyId,version,checkInterval:next.interval,
  swingThresholdBp:next.thresholdBp,swingExclusions:[...next.exclusions],source,decisionId,changedByUserId:ctx.userId!}).returning();
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-payroll-loop',aggregateId:before.companyId,eventType:'teras-payroll-loop.setting-changed',
  actor:actorOf(ctx),payload:{companyId:before.companyId,version,source,decisionId,
   from:{interval:before.interval,thresholdBp:before.thresholdBp,exclusions:[...before.exclusions]},
   to:{interval:next.interval,thresholdBp:next.thresholdBp,exclusions:[...next.exclusions]}}});
 return row;
}

const SettingInput=z.object({companyId:z.guid(),interval:z.enum(CHECK_INTERVALS).optional(),thresholdBp:z.number().int().min(100).max(10_000).optional(),
 removeExclusion:z.string().regex(/^(cause:[a-z_]{1,40}|item:[A-Za-z0-9_.-]{1,40})$/).optional()}).strict();

/** An administrator of the company changes its interval or threshold, or removes an exclusion (which only tightens the
 * flag). Adding an exclusion is done only by approving a proposal. */
export async function setPayrollLoopSetting(supplied:SessionContext,input:unknown){
 const ctx=capture(supplied);guard(ctx);
 const parsed=SettingInput.safeParse(input);
 if(!parsed.success||(parsed.data.interval===undefined&&parsed.data.thresholdBp===undefined&&parsed.data.removeExclusion===undefined))throw new PayrollLoopRefused('invalid');
 const {companyId,interval,thresholdBp,removeExclusion}=parsed.data;
 return withTenant(ctx,async tx=>{
  await requireCompanyAdminTx(tx,companyId);
  await lockCompany(tx,ctx.tenantId,companyId);
  const before=(await payrollLoopSettingsTx(tx,ctx.tenantId,[companyId])).get(companyId)!;
  if(removeExclusion!==undefined&&!before.exclusions.includes(removeExclusion))throw new PayrollLoopRefused('changed');
  const next={interval:interval??before.interval,thresholdBp:thresholdBp??before.thresholdBp,
   exclusions:removeExclusion===undefined?before.exclusions:before.exclusions.filter(pattern=>pattern!==removeExclusion)};
  if(next.interval===before.interval&&next.thresholdBp===before.thresholdBp&&next.exclusions.length===before.exclusions.length)throw new PayrollLoopRefused('already');
  return Object.freeze(await writeSettingTx(tx,ctx,before,next,'admin',null));
 });
}

/** The proposals one company's dispositions support now, as this transaction may read them. */
export async function thresholdProposalsTx(tx:Tx,tenantId:string,companyId:string,now:Date):Promise<Readonly<{setting:PayrollLoopSetting;proposals:readonly SwingProposal[]}>>{
 const setting=(await payrollLoopSettingsTx(tx,tenantId,[companyId])).get(companyId)!;
 const since=new Date(now.getTime()-PROPOSAL_WINDOW_DAYS*DAY_MS);
 const rows=await tx.select({pattern:terasPayrollSwingDisposition.pattern,swingBp:terasPayrollSwingDisposition.swingBp,disposition:terasPayrollSwingDisposition.disposition})
  .from(terasPayrollSwingDisposition).where(and(eq(terasPayrollSwingDisposition.tenantId,tenantId),eq(terasPayrollSwingDisposition.companyId,companyId),
   gte(terasPayrollSwingDisposition.decidedAt,since)));
 const rejected=await tx.select({key:terasPayrollThresholdDecision.proposalKey}).from(terasPayrollThresholdDecision)
  .where(and(eq(terasPayrollThresholdDecision.tenantId,tenantId),eq(terasPayrollThresholdDecision.companyId,companyId),eq(terasPayrollThresholdDecision.decision,'rejected')));
 return Object.freeze({setting,proposals:deriveSwingProposals(rows,setting,new Set(rejected.map(row=>row.key)))});
}

const DecisionInput=z.object({companyId:z.guid(),proposalKey:z.string().regex(/^[0-9a-f]{64}$/),decision:z.enum(['approved','rejected'])}).strict();

/** An administrator of the company approves or rejects one proposal. Approval writes the new setting (applies from the next
 * run); both are recorded with the evidence. A proposal the evidence no longer supports is refused as changed. */
export async function decideThresholdProposal(supplied:SessionContext,input:unknown,options:Readonly<{now?:Date}>={}){
 const ctx=capture(supplied);guard(ctx);
 const parsed=DecisionInput.safeParse(input);
 if(!parsed.success)throw new PayrollLoopRefused('invalid');
 const {companyId,proposalKey,decision}=parsed.data;
 return withTenant(ctx,async tx=>{
  await requireCompanyAdminTx(tx,companyId);
  await lockCompany(tx,ctx.tenantId,companyId);
  const {setting,proposals}=await thresholdProposalsTx(tx,ctx.tenantId,companyId,options.now??new Date());
  const proposal=proposals.find(item=>item.key===proposalKey);
  if(!proposal)throw new PayrollLoopRefused('changed');
  const [recorded]=await tx.insert(terasPayrollThresholdDecision).values({tenantId:ctx.tenantId,companyId,proposalKey,kind:proposal.kind,
   fromThresholdBp:proposal.fromThresholdBp,toThresholdBp:proposal.toThresholdBp,pattern:proposal.pattern,evidence:{...proposal.evidence},decision,
   decidedByUserId:ctx.userId!}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-payroll-loop',aggregateId:companyId,eventType:'teras-payroll-loop.proposal-decided',
   actor:actorOf(ctx),payload:{companyId,decisionId:recorded.id,kind:proposal.kind,decision,fromThresholdBp:proposal.fromThresholdBp,
    toThresholdBp:proposal.toThresholdBp,pattern:proposal.pattern,evidence:{...proposal.evidence}}});
  if(decision==='rejected')return Object.freeze({decision:recorded,setting:null});
  const next=proposal.kind==='threshold'
   ?{interval:setting.interval,thresholdBp:proposal.toThresholdBp!,exclusions:setting.exclusions}
   :{interval:setting.interval,thresholdBp:setting.thresholdBp,exclusions:[...setting.exclusions,proposal.pattern!]};
  return Object.freeze({decision:recorded,setting:await writeSettingTx(tx,ctx,setting,next,'proposal',recorded.id)});
 });
}

/** The settings history of companies the viewer administers, newest first. */
export async function payrollLoopSettingHistoryTx(tx:Tx,tenantId:string,companyIds:readonly string[],limit=20){
 if(!companyIds.length)return [];
 return tx.select().from(terasPayrollLoopSetting).where(and(eq(terasPayrollLoopSetting.tenantId,tenantId),inArray(terasPayrollLoopSetting.companyId,[...companyIds])))
  .orderBy(desc(terasPayrollLoopSetting.changedAt),desc(terasPayrollLoopSetting.version)).limit(limit);
}
