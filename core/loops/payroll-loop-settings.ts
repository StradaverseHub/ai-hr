/** AI v2 P2-2a — the payroll-cycle loops' per-company settings, and the administrators' decisions on threshold proposals
 * (migration 0964).
 *
 * Per company: how often the Pre-salary loop checks (hourly, twice daily or daily; default daily, owner decision 4) and the
 * Salary payroll loop's net-swing threshold (default 15%, owner decision 5) with the pay patterns excluded from it. Every
 * change is a new version row, attributed to the administrator of the company who made it, and audited as a domain event
 * with its before and after. The threshold is never loosened silently: the loop never writes a setting, a proposal
 * applies only when an administrator approves it here, and approving re-derives the proposal from the dispositions as
 * they are now (the owner re-check at Confirm), so a stale screen cannot apply what the evidence no longer supports.
 * Applies from the next run. Nothing here touches the 11 payroll anomaly detectors or their thresholds.
 * Phase 2 hardening (4 November 2026): a threshold is never set above the proposal cap (MAX_THRESHOLD_BP, 50%), whether
 * directly or by a proposal; every change is a `teras-payroll-loop.setting-changed` configuration event, which the Audit
 * loop captures into the month's audit pack (core/payroll-audit/capture.ts CONFIG_EVENT_PREFIXES); and a proposal, which
 * loosens the flag, is approved only by a group administrator who disposed of none of the flags behind it (the payroll
 * administrator whose dispositions produced it cannot approve it). Rejecting one, which keeps the flag as it is, stays
 * with any administrator of the company. A setting also says whether the Pre-salary loop sends its automatic cut-off
 * reminders for the company (core/loops/cut-off-reminders.ts; on by default, owner ruling 18). */
import {and,desc,eq,gte,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasPayrollLoopSetting,terasPayrollSwingDisposition,terasPayrollThresholdDecision,type PayrollLoopCheckInterval} from '../../db/teras-payroll-cycle-schema';
import {terasLoopCase,terasLoopRun} from '../../db/teras-schema';
import {isAdmin,isGroupAdmin} from '../../lib/authz-model';
import {DEFAULT_SWING_THRESHOLD_BP} from './net-swing';
import {MAX_THRESHOLD_BP,PROPOSAL_WINDOW_DAYS,deriveSwingProposals,type SwingProposal} from './swing-proposals';
import type {LoopId} from './types';

export const CHECK_INTERVALS=Object.freeze(['hourly','twice_daily','daily'] as const);
export const DEFAULT_CHECK_INTERVAL:PayrollLoopCheckInterval='daily';
const INTERVAL_MINUTES:Readonly<Record<PayrollLoopCheckInterval,number>>=Object.freeze({hourly:60,twice_daily:720,daily:1440});
/** A sweep started a few minutes early still counts as the next one (a daily 03:00 job never skips a day). */
const INTERVAL_SLACK_MINUTES=5;
const DAY_MS=86_400_000;

export type PayrollLoopSetting=Readonly<{companyId:string;version:number;interval:PayrollLoopCheckInterval;thresholdBp:number;exclusions:readonly string[];
 /** Whether the Pre-salary loop sends automatic cut-off reminders for the company (on unless switched off). */
 remindersEnabled:boolean;
 source:'default'|'admin'|'proposal';changedByUserId:string|null;changedAt:Date|null}>;
export const defaultPayrollLoopSetting=(companyId:string):PayrollLoopSetting=>Object.freeze({companyId,version:0,interval:DEFAULT_CHECK_INTERVAL,
 thresholdBp:DEFAULT_SWING_THRESHOLD_BP,exclusions:Object.freeze([]),remindersEnabled:true,source:'default',changedByUserId:null,changedAt:null});
/** The configuration event every settings change appends (captured by the Audit loop into the month's pack). */
export const PAYROLL_LOOP_SETTING_EVENT='teras-payroll-loop.setting-changed';
export const PAYROLL_LOOP_DECISION_EVENT='teras-payroll-loop.proposal-decided';

export class PayrollLoopRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'|'changed'|'already'|'not_found'|'group_administrator'|'own_evidence'){super('Payroll loop change refused: '+reason);this.name='PayrollLoopRefused';}}

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
   exclusions:Object.freeze([...row.swingExclusions]),remindersEnabled:row.remindersEnabled,source:row.source,changedByUserId:row.changedByUserId,changedAt:row.changedAt}));
 }
 return out;
}

/** Phase 2 hardening: on its cut-off day the Pre-salary loop checks each company once more from this hour (Kuala Lumpur),
 * whatever its interval, so "done" is re-verified at the end of the day the inputs close. */
export const CUT_OFF_DAY_RECHECK_HOUR=23;
const klDay=(at:Date)=>new Date(at.getTime()+8*3_600_000).toISOString().slice(0,10);

/** The companies the Pre-salary loop is due to check now: each company's own interval since its last completed run, and
 * (Phase 2 hardening) once more at the end of its salary cut-off day, from CUT_OFF_DAY_RECHECK_HOUR Kuala Lumpur time, if
 * its last run was before then. The cut-off day is read from the loop's own case for the company (its `cutOff` fact, as
 * the detector resolved it through the payroll owner), which the agent principal may read. */
export async function payrollLoopDueTx(tx:Tx,input:Readonly<{tenantId:string;workerId:LoopId;companies:readonly string[];now:Date}>):Promise<string[]>{
 if(!input.companies.length)return [];
 const settings=await payrollLoopSettingsTx(tx,input.tenantId,input.companies);
 const last=await tx.select({companyId:terasLoopRun.companyId,at:sql<Date>`max(${terasLoopRun.startedAt})`}).from(terasLoopRun)
  .where(and(eq(terasLoopRun.tenantId,input.tenantId),eq(terasLoopRun.workerId,input.workerId),eq(terasLoopRun.status,'ran'),
   inArray(terasLoopRun.companyId,[...input.companies])))
  .groupBy(terasLoopRun.companyId);
 const lastAt=new Map(last.map(row=>[row.companyId,row.at?new Date(row.at):null]));
 const today=klDay(input.now),recheckFrom=new Date(`${today}T${String(CUT_OFF_DAY_RECHECK_HOUR).padStart(2,'0')}:00:00+08:00`);
 const cutOffToday=input.now.getTime()>=recheckFrom.getTime()?new Set((await tx.select({companyId:terasLoopCase.companyId}).from(terasLoopCase)
  .where(and(eq(terasLoopCase.tenantId,input.tenantId),eq(terasLoopCase.workerId,input.workerId),inArray(terasLoopCase.companyId,[...input.companies]),
   sql`${terasLoopCase.facts}->>'cutOff'=${today}`))).map(row=>row.companyId)):new Set<string>();
 return input.companies.filter(companyId=>{
  const at=lastAt.get(companyId);
  if(!at)return true;
  if(cutOffToday.has(companyId)&&at.getTime()<recheckFrom.getTime())return true;
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

type SettingValues=Readonly<{interval:PayrollLoopCheckInterval;thresholdBp:number;exclusions:readonly string[];remindersEnabled:boolean}>;
async function writeSettingTx(tx:Tx,ctx:SessionContext,before:PayrollLoopSetting,next:SettingValues,source:'admin'|'proposal',decisionId:string|null){
 const version=before.version+1;
 const [row]=await tx.insert(terasPayrollLoopSetting).values({tenantId:ctx.tenantId,companyId:before.companyId,version,checkInterval:next.interval,
  swingThresholdBp:next.thresholdBp,swingExclusions:[...next.exclusions],remindersEnabled:next.remindersEnabled,source,decisionId,changedByUserId:ctx.userId!}).returning();
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-payroll-loop',aggregateId:before.companyId,eventType:PAYROLL_LOOP_SETTING_EVENT,
  actor:actorOf(ctx),payload:{companyId:before.companyId,version,source,decisionId,
   from:{interval:before.interval,thresholdBp:before.thresholdBp,exclusions:[...before.exclusions],remindersEnabled:before.remindersEnabled},
   to:{interval:next.interval,thresholdBp:next.thresholdBp,exclusions:[...next.exclusions],remindersEnabled:next.remindersEnabled}}});
 return row;
}

const SettingInput=z.object({companyId:z.guid(),interval:z.enum(CHECK_INTERVALS).optional(),thresholdBp:z.number().int().min(100).max(MAX_THRESHOLD_BP).optional(),
 removeExclusion:z.string().regex(/^(cause:[a-z_]{1,40}|item:[A-Za-z0-9_.-]{1,40})$/).optional(),remindersEnabled:z.boolean().optional()}).strict();

/** An administrator of the company changes its interval, its threshold (never above the proposal cap) or its cut-off
 * reminders, or removes an exclusion (which only tightens the flag). Adding an exclusion is done only by approving a
 * proposal. */
export async function setPayrollLoopSetting(supplied:SessionContext,input:unknown){
 const ctx=capture(supplied);guard(ctx);
 const parsed=SettingInput.safeParse(input);
 if(!parsed.success||(parsed.data.interval===undefined&&parsed.data.thresholdBp===undefined&&parsed.data.removeExclusion===undefined
  &&parsed.data.remindersEnabled===undefined))throw new PayrollLoopRefused('invalid');
 const {companyId,interval,thresholdBp,removeExclusion,remindersEnabled}=parsed.data;
 return withTenant(ctx,async tx=>{
  await requireCompanyAdminTx(tx,companyId);
  await lockCompany(tx,ctx.tenantId,companyId);
  const before=(await payrollLoopSettingsTx(tx,ctx.tenantId,[companyId])).get(companyId)!;
  if(removeExclusion!==undefined&&!before.exclusions.includes(removeExclusion))throw new PayrollLoopRefused('changed');
  const next={interval:interval??before.interval,thresholdBp:thresholdBp??before.thresholdBp,
   exclusions:removeExclusion===undefined?before.exclusions:before.exclusions.filter(pattern=>pattern!==removeExclusion),
   remindersEnabled:remindersEnabled??before.remindersEnabled};
  if(next.interval===before.interval&&next.thresholdBp===before.thresholdBp&&next.exclusions.length===before.exclusions.length
   &&next.remindersEnabled===before.remindersEnabled)throw new PayrollLoopRefused('already');
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

/** Whether this login disposed of any flag behind the proposal: in its window, of its pattern (an exclusion) or of any
 * pattern (a threshold). Such a login may not approve it (migration 2005 repeats the rule in the decision policy). */
async function disposedOwnEvidenceTx(tx:Tx,ctx:SessionContext,companyId:string,proposal:SwingProposal,now:Date):Promise<boolean>{
 const since=new Date(now.getTime()-PROPOSAL_WINDOW_DAYS*DAY_MS);
 const [row]=await tx.select({id:terasPayrollSwingDisposition.id}).from(terasPayrollSwingDisposition)
  .where(and(eq(terasPayrollSwingDisposition.tenantId,ctx.tenantId),eq(terasPayrollSwingDisposition.companyId,companyId),
   eq(terasPayrollSwingDisposition.decidedByUserId,ctx.userId!),gte(terasPayrollSwingDisposition.decidedAt,since),
   ...(proposal.pattern?[eq(terasPayrollSwingDisposition.pattern,proposal.pattern)]:[]))).limit(1);
 return !!row;
}

/** One proposal decided. Approval, which loosens the flag, is a group administrator's who disposed of none of the flags
 * behind it; it writes the new setting (applies from the next run). Rejection is any administrator of the company's.
 * Both are recorded with the evidence. A proposal the evidence no longer supports is refused as changed. */
export async function decideThresholdProposal(supplied:SessionContext,input:unknown,options:Readonly<{now?:Date}>={}){
 const ctx=capture(supplied);guard(ctx);
 const parsed=DecisionInput.safeParse(input);
 if(!parsed.success)throw new PayrollLoopRefused('invalid');
 const {companyId,proposalKey,decision}=parsed.data;
 if(decision==='approved'&&!isGroupAdmin(ctx))throw new PayrollLoopRefused('group_administrator');
 const now=options.now??new Date();
 return withTenant(ctx,async tx=>{
  await requireCompanyAdminTx(tx,companyId);
  await lockCompany(tx,ctx.tenantId,companyId);
  const {setting,proposals}=await thresholdProposalsTx(tx,ctx.tenantId,companyId,now);
  const proposal=proposals.find(item=>item.key===proposalKey);
  if(!proposal)throw new PayrollLoopRefused('changed');
  if(decision==='approved'&&await disposedOwnEvidenceTx(tx,ctx,companyId,proposal,now))throw new PayrollLoopRefused('own_evidence');
  const [recorded]=await tx.insert(terasPayrollThresholdDecision).values({tenantId:ctx.tenantId,companyId,proposalKey,kind:proposal.kind,
   fromThresholdBp:proposal.fromThresholdBp,toThresholdBp:proposal.toThresholdBp,pattern:proposal.pattern,evidence:{...proposal.evidence},decision,
   decidedByUserId:ctx.userId!}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-payroll-loop',aggregateId:companyId,eventType:PAYROLL_LOOP_DECISION_EVENT,
   actor:actorOf(ctx),payload:{companyId,decisionId:recorded.id,kind:proposal.kind,decision,fromThresholdBp:proposal.fromThresholdBp,
    toThresholdBp:proposal.toThresholdBp,pattern:proposal.pattern,evidence:{...proposal.evidence}}});
  if(decision==='rejected')return Object.freeze({decision:recorded,setting:null});
  const next=proposal.kind==='threshold'
   ?{interval:setting.interval,thresholdBp:Math.min(proposal.toThresholdBp!,MAX_THRESHOLD_BP),exclusions:setting.exclusions,remindersEnabled:setting.remindersEnabled}
   :{interval:setting.interval,thresholdBp:setting.thresholdBp,exclusions:[...setting.exclusions,proposal.pattern!],remindersEnabled:setting.remindersEnabled};
  return Object.freeze({decision:recorded,setting:await writeSettingTx(tx,ctx,setting,next,'proposal',recorded.id)});
 });
}

/** The settings history of companies the viewer administers, newest first. */
export async function payrollLoopSettingHistoryTx(tx:Tx,tenantId:string,companyIds:readonly string[],limit=20){
 if(!companyIds.length)return [];
 return tx.select().from(terasPayrollLoopSetting).where(and(eq(terasPayrollLoopSetting.tenantId,tenantId),inArray(terasPayrollLoopSetting.companyId,[...companyIds])))
  .orderBy(desc(terasPayrollLoopSetting.changedAt),desc(terasPayrollLoopSetting.version)).limit(limit);
}
