/** AI v2 Phase 2 hardening (4 November 2026) — standing "expected, not an exception" acknowledgements (owner ruling 19),
 * and the learning step that proposes them (migration 2011).
 *
 * WHAT ONE IS. A payroll administrator of a company says, once, that ONE check is expected for one person, one group
 * (department) or the whole company: for example the Audit loop's "pay without attendance" for a cash-paid driver who
 * never clocks in. It carries a reason, an optional review date, who and when. It is audited (a
 * `payroll-check.acknowledgement-recorded` / `-revoked` configuration event, which the Audit loop captures into the month's
 * pack) and reversible (revoked, never rewritten). It NEVER changes a calculation, a figure, a record or a check's own
 * result: the check still runs and still finds what it finds.
 * WHAT IT DOES:
 *  - a WARNING it covers (an Audit loop finding, a net-swing flag, a review-severity payroll anomaly) leaves the to-do
 *    counts and the repeat-issue counts, but is still listed, marked "expected", on the Audit loop page and in the pack;
 *  - a BLOCK (negative net pay, a statutory amount over its cap, a missing bank profile, the same person paid twice) is
 *    never suppressed: it stays counted, and its one-tap resolve is only PRE-FILLED with the acknowledgement's reason, so
 *    a person still presses it, each run.
 * Nobody acknowledges a check about themselves. Read and written under the caller's own row-level security.
 *
 * LEARNING. When payroll HR has disposed of the same check for the same person at least PROPOSAL_MIN_RUNS times running
 * and at least 80% of them as expected, a standing acknowledgement for that person is PROPOSED (the swing-proposals
 * pattern, core/loops/swing-proposals.ts): it is evidence only, never applied by itself; a group administrator who made
 * none of those dispositions approves it (which records the decision and creates the acknowledgement, source
 * `proposal`), or any administrator of the company rejects it; a rejected proposal is not offered again while its
 * evidence is the same. No model is called. */
import {createHash} from 'node:crypto';
import {and,desc,eq,inArray,isNull,sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {payrollCheckAcknowledgement,payrollCheckRuleDecision,terasPayrollSwingDisposition,type AcknowledgementScope} from '../../db/teras-payroll-cycle-schema';
import {payrollAuditDisposition,payrollAuditFinding} from '../../db/payroll-audit-schema';
import {canManagePayroll,isGroupAdmin} from '../../lib/authz-model';
import {DETECTORS} from '../payroll-anomaly-detectors';
import {AUDIT_CONTROL_IDS} from '../payroll-audit/types';

/** Every check that may be acknowledged: each Audit loop control, each payroll anomaly detector, and the net-swing flag. */
export const ACKNOWLEDGEABLE_CHECKS:readonly string[]=Object.freeze([...AUDIT_CONTROL_IDS.map(id=>`audit:${id}`),...DETECTORS.map(detector=>`anomaly:${detector.id}`),'swing:net_swing']);
/** The checks whose finding BLOCKS (never suppressed; only the resolve is pre-filled). */
export const BLOCK_CHECKS:ReadonlySet<string>=new Set(['anomaly:negative-net','anomaly:statutory-over-cap','anomaly:missing-bank-profile','anomaly:duplicate-employment-pay']);
export const isBlockCheck=(checkId:string)=>BLOCK_CHECKS.has(checkId);
export const isAcknowledgeableCheck=(value:unknown):value is string=>typeof value==='string'&&ACKNOWLEDGEABLE_CHECKS.includes(value);
export const ACKNOWLEDGEMENT_EVENT_RECORDED='payroll-check.acknowledgement-recorded';
export const ACKNOWLEDGEMENT_EVENT_REVOKED='payroll-check.acknowledgement-revoked';
export const RULE_PROPOSAL_EVENT='payroll-check.rule-proposal-decided';
export const PROPOSAL_MIN_RUNS=5;
export const PROPOSAL_EXPECTED_SHARE_BP=8000;
/** At most this many of a person's latest dispositions of a check are the evidence of a proposal. */
const PROPOSAL_LOOKBACK=10;

export type Acknowledgement=Readonly<{id:string;companyId:string;checkId:string;scope:AcknowledgementScope;employmentId:string|null;departmentId:string|null;
 reason:string;reviewOn:string|null;source:'person'|'proposal';createdByUserId:string;createdAt:Date}>;
export class AcknowledgementRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'|'not_found'|'own'|'already'|'group_administrator'|'own_evidence'|'changed'){
 super('Acknowledgement refused: '+reason);this.name='AcknowledgementRefused';}}

const clone=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const guard=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!canManagePayroll(ctx))throw new AcknowledgementRefused('not_administrator');};
const ok=async(tx:Tx,query:SQL)=>((await tx.execute(query)) as unknown as {ok:boolean|null}[])[0]?.ok===true;

/** The acknowledgements in force for some companies, as this transaction may read them. */
export async function acknowledgementsTx(tx:Tx,tenantId:string,companyIds:readonly string[]):Promise<Acknowledgement[]>{
 if(!companyIds.length)return [];
 const rows=await tx.select().from(payrollCheckAcknowledgement).where(and(eq(payrollCheckAcknowledgement.tenantId,tenantId),
  inArray(payrollCheckAcknowledgement.companyId,[...companyIds]),isNull(payrollCheckAcknowledgement.revokedAt)))
  .orderBy(desc(payrollCheckAcknowledgement.createdAt),desc(payrollCheckAcknowledgement.id));
 return rows.map(row=>Object.freeze({id:row.id,companyId:row.companyId,checkId:row.checkId,scope:row.scope,employmentId:row.employmentId,departmentId:row.departmentId,
  reason:row.reason,reviewOn:row.reviewOn??null,source:row.source,createdByUserId:row.createdByUserId,createdAt:row.createdAt}));
}

/** Each employment's current department (its live assignment), for group-scope acknowledgements. */
export async function currentDepartmentsTx(tx:Tx,employmentIds:readonly string[]):Promise<Map<string,string>>{
 if(!employmentIds.length)return new Map();
 const rows=Array.from(await tx.execute(sql`select distinct on (a.employment_id) a.employment_id,a.department_id from public.assignment a
  where a.employment_id in (${sql.join([...new Set(employmentIds)].map(id=>sql`${id}::uuid`),sql`,`)}) and a.superseded_at is null
  order by a.employment_id,a.valid_from desc`) as unknown as {employment_id:string;department_id:string}[]);
 return new Map(rows.map(row=>[row.employment_id,row.department_id]));
}

/** Which acknowledgement, if any, covers one check for one subject: the person's own, then their group's, then the
 * company's. PURE. */
export function acknowledgementFor(list:readonly Acknowledgement[],p:Readonly<{companyId:string;checkId:string;employmentId:string|null;departmentId:string|null}>):Acknowledgement|null{
 const mine=list.filter(item=>item.companyId===p.companyId&&item.checkId===p.checkId);
 return mine.find(item=>item.scope==='person'&&!!p.employmentId&&item.employmentId===p.employmentId)
  ??mine.find(item=>item.scope==='group'&&!!p.departmentId&&item.departmentId===p.departmentId)
  ??mine.find(item=>item.scope==='company')??null;
}

const Input=z.object({companyId:z.guid(),checkId:z.string(),scope:z.enum(['person','group','company']),employmentId:z.guid().optional(),departmentId:z.guid().optional(),
 reason:z.string().trim().min(1).max(500),reviewOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).strict();

/** A payroll administrator of the company records one standing acknowledgement. */
export async function acknowledgeCheck(supplied:SessionContext,input:unknown):Promise<Acknowledgement>{
 const ctx=clone(supplied);guard(ctx);
 const parsed=Input.safeParse(input);
 if(!parsed.success||!isAcknowledgeableCheck(parsed.data.checkId))throw new AcknowledgementRefused('invalid');
 const v=parsed.data;
 if((v.scope==='person')!==(v.employmentId!==undefined)||(v.scope==='group')!==(v.departmentId!==undefined))throw new AcknowledgementRefused('invalid');
 return withTenant(ctx,async tx=>{
  if(!await ok(tx,sql`select app.can_admin_payroll_for(${v.companyId}::uuid) as ok`))throw new AcknowledgementRefused('not_administrator');
  if(v.employmentId){
   const [row]=Array.from(await tx.execute(sql`select e.company_id,app.can_admin_employment(e.id) as admin,app.is_self_person(e.person_id) as own
    from public.employment e where e.id=${v.employmentId}::uuid`) as unknown as {company_id:string;admin:boolean|null;own:boolean|null}[]);
   if(!row||row.company_id!==v.companyId||row.admin!==true)throw new AcknowledgementRefused('not_found');
   if(row.own===true)throw new AcknowledgementRefused('own');
  }
  return recordTx(tx,ctx,{...v,reviewOn:v.reviewOn??null,source:'person',decisionId:null});
 });
}

async function recordTx(tx:Tx,ctx:SessionContext,v:Readonly<{companyId:string;checkId:string;scope:AcknowledgementScope;employmentId?:string;departmentId?:string;
 reason:string;reviewOn:string|null;source:'person'|'proposal';decisionId:string|null}>):Promise<Acknowledgement>{
 const existing=(await acknowledgementsTx(tx,ctx.tenantId,[v.companyId])).find(item=>item.checkId===v.checkId&&item.scope===v.scope
  &&item.employmentId===(v.employmentId??null)&&item.departmentId===(v.departmentId??null));
 if(existing)throw new AcknowledgementRefused('already');
 const [row]=await tx.insert(payrollCheckAcknowledgement).values({tenantId:ctx.tenantId,companyId:v.companyId,checkId:v.checkId,scope:v.scope,
  employmentId:v.employmentId??null,departmentId:v.departmentId??null,reason:v.reason,reviewOn:v.reviewOn,source:v.source,decisionId:v.decisionId,
  createdByUserId:ctx.userId!}).returning();
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-check-acknowledgement',aggregateId:row.id,eventType:ACKNOWLEDGEMENT_EVENT_RECORDED,
  actor:actorOf(ctx),payload:{companyId:v.companyId,checkId:v.checkId,scope:v.scope,employmentId:v.employmentId??null,
   departmentId:v.departmentId??null,reviewOn:v.reviewOn,source:v.source,decisionId:v.decisionId,blocks:isBlockCheck(v.checkId)}});
 return Object.freeze({id:row.id,companyId:row.companyId,checkId:row.checkId,scope:row.scope,employmentId:row.employmentId,departmentId:row.departmentId,
  reason:row.reason,reviewOn:row.reviewOn??null,source:row.source,createdByUserId:row.createdByUserId,createdAt:row.createdAt});
}

/** A payroll administrator of the company revokes one acknowledgement (recorded once; the row is never rewritten). */
export async function revokeAcknowledgement(supplied:SessionContext,input:Readonly<{id:unknown}>){
 const ctx=clone(supplied);guard(ctx);
 const id=z.guid().safeParse(input.id);
 if(!id.success)throw new AcknowledgementRefused('invalid');
 return withTenant(ctx,async tx=>{
  const [row]=await tx.update(payrollCheckAcknowledgement).set({revokedAt:sql`now()`,revokedByUserId:ctx.userId!})
   .where(and(eq(payrollCheckAcknowledgement.tenantId,ctx.tenantId),eq(payrollCheckAcknowledgement.id,id.data),isNull(payrollCheckAcknowledgement.revokedAt))).returning();
  if(!row)throw new AcknowledgementRefused('not_found');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-check-acknowledgement',aggregateId:row.id,eventType:ACKNOWLEDGEMENT_EVENT_REVOKED,actor:actorOf(ctx),
   payload:{companyId:row.companyId,checkId:row.checkId,scope:row.scope,employmentId:row.employmentId,departmentId:row.departmentId}});
  return Object.freeze(row);
 });
}

// ── Learning: standing rules proposed from runs of the same disposition ──

export type RuleProposalEvidence=Readonly<{runs:number;expected:number;expectedShareBp:number;lastDisposedAt:string}>;
export type RuleProposal=Readonly<{key:string;companyId:string;checkId:string;employmentId:string;evidence:RuleProposalEvidence;disposers:readonly string[]}>;
export type DispositionRun=Readonly<{companyId:string;checkId:string;employmentId:string;expected:boolean;by:string;at:Date}>;
export const ruleProposalKey=(p:Readonly<{companyId:string;checkId:string;employmentId:string;evidence:RuleProposalEvidence}>)=>createHash('sha256')
 .update(JSON.stringify([p.companyId,p.checkId,p.employmentId,p.evidence.runs,p.evidence.expected,p.evidence.lastDisposedAt])).digest('hex');

/** PURE. From the dispositions of each check and person (newest first, at most PROPOSAL_LOOKBACK of them): a proposal when
 * at least PROPOSAL_MIN_RUNS were decided and at least 80% as expected, the latest disposition is itself "expected", and
 * nothing already acknowledges it or was rejected on the same evidence. */
export function deriveRuleProposals(runs:readonly DispositionRun[],acknowledged:(p:{companyId:string;checkId:string;employmentId:string})=>boolean,
 rejected:ReadonlySet<string>=new Set()):readonly RuleProposal[]{
 const groups=new Map<string,DispositionRun[]>();
 for(const run of runs){const key=`${run.companyId}|${run.checkId}|${run.employmentId}`;const list=groups.get(key)??[];list.push(run);groups.set(key,list);}
 const out:RuleProposal[]=[];
 for(const list of groups.values()){
  const latest=[...list].sort((a,b)=>b.at.getTime()-a.at.getTime()).slice(0,PROPOSAL_LOOKBACK);
  const first=latest[0];
  if(!first||latest.length<PROPOSAL_MIN_RUNS||!first.expected||isBlockCheck(first.checkId))continue;
  const expected=latest.filter(run=>run.expected).length,shareBp=Math.floor(expected*10_000/latest.length);
  if(shareBp<PROPOSAL_EXPECTED_SHARE_BP)continue;
  if(acknowledged(first))continue;
  const evidence=Object.freeze({runs:latest.length,expected,expectedShareBp:shareBp,lastDisposedAt:first.at.toISOString()});
  const key=ruleProposalKey({companyId:first.companyId,checkId:first.checkId,employmentId:first.employmentId,evidence});
  if(rejected.has(key))continue;
  out.push(Object.freeze({key,companyId:first.companyId,checkId:first.checkId,employmentId:first.employmentId,evidence,
   disposers:Object.freeze([...new Set(latest.map(run=>run.by))].sort())}));
 }
 return Object.freeze(out.sort((a,b)=>a.checkId.localeCompare(b.checkId)||a.employmentId.localeCompare(b.employmentId)));
}

/** The proposals the dispositions of some companies support now (Audit loop findings and net-swing flags), as read. */
export async function ruleProposalsTx(tx:Tx,tenantId:string,companyIds:readonly string[]):Promise<readonly RuleProposal[]>{
 if(!companyIds.length)return [];
 const audit=await tx.select({companyId:payrollAuditFinding.companyId,controlId:payrollAuditFinding.controlId,employmentId:payrollAuditFinding.employmentId,
  disposition:payrollAuditDisposition.disposition,by:payrollAuditDisposition.disposedByUserId,at:payrollAuditDisposition.disposedAt})
  .from(payrollAuditDisposition).innerJoin(payrollAuditFinding,and(eq(payrollAuditFinding.id,payrollAuditDisposition.findingId),eq(payrollAuditFinding.tenantId,payrollAuditDisposition.tenantId)))
  .where(and(eq(payrollAuditDisposition.tenantId,tenantId),inArray(payrollAuditFinding.companyId,[...companyIds]),sql`${payrollAuditFinding.employmentId} is not null`));
 const swing=await tx.select({companyId:terasPayrollSwingDisposition.companyId,employmentId:terasPayrollSwingDisposition.employmentId,
  disposition:terasPayrollSwingDisposition.disposition,by:terasPayrollSwingDisposition.decidedByUserId,at:terasPayrollSwingDisposition.decidedAt})
  .from(terasPayrollSwingDisposition).where(and(eq(terasPayrollSwingDisposition.tenantId,tenantId),inArray(terasPayrollSwingDisposition.companyId,[...companyIds])));
 const runs:DispositionRun[]=[
  ...audit.map(row=>({companyId:row.companyId,checkId:`audit:${row.controlId}`,employmentId:row.employmentId!,expected:row.disposition==='expected'||row.disposition==='false_positive',by:row.by,at:row.at})),
  ...swing.map(row=>({companyId:row.companyId,checkId:'swing:net_swing',employmentId:row.employmentId,expected:row.disposition==='expected',by:row.by,at:row.at}))];
 const list=await acknowledgementsTx(tx,tenantId,companyIds);
 const departments=await currentDepartmentsTx(tx,[...new Set(runs.map(run=>run.employmentId))]);
 const rejected=await tx.select({key:payrollCheckRuleDecision.proposalKey}).from(payrollCheckRuleDecision)
  .where(and(eq(payrollCheckRuleDecision.tenantId,tenantId),inArray(payrollCheckRuleDecision.companyId,[...companyIds]),eq(payrollCheckRuleDecision.decision,'rejected')));
 return deriveRuleProposals(runs,p=>!!acknowledgementFor(list,{...p,departmentId:departments.get(p.employmentId)??null}),new Set(rejected.map(row=>row.key)));
}

const DecisionInput=z.object({companyId:z.guid(),proposalKey:z.string().regex(/^[0-9a-f]{64}$/),decision:z.enum(['approved','rejected']),
 reason:z.string().trim().min(1).max(500).optional()}).strict();

/** A group administrator approves a proposed standing rule (never one whose evidence holds their own dispositions), or any
 * payroll administrator of the company rejects it. Approval re-derives the proposal first, records the decision and
 * creates the person's acknowledgement (source `proposal`). */
export async function decideRuleProposal(supplied:SessionContext,input:unknown){
 const ctx=clone(supplied);guard(ctx);
 const parsed=DecisionInput.safeParse(input);
 if(!parsed.success)throw new AcknowledgementRefused('invalid');
 const {companyId,proposalKey,decision}=parsed.data;
 if(decision==='approved'&&!isGroupAdmin(ctx))throw new AcknowledgementRefused('group_administrator');
 return withTenant(ctx,async tx=>{
  if(!await ok(tx,sql`select app.can_admin_payroll_for(${companyId}::uuid) as ok`))throw new AcknowledgementRefused('not_administrator');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-check-rule:${ctx.tenantId}:${companyId}`},0))`);
  const proposal=(await ruleProposalsTx(tx,ctx.tenantId,[companyId])).find(item=>item.key===proposalKey);
  if(!proposal)throw new AcknowledgementRefused('changed');
  if(decision==='approved'&&proposal.disposers.includes(ctx.userId!))throw new AcknowledgementRefused('own_evidence');
  const [recorded]=await tx.insert(payrollCheckRuleDecision).values({tenantId:ctx.tenantId,companyId,proposalKey,checkId:proposal.checkId,
   employmentId:proposal.employmentId,evidence:{...proposal.evidence},decision,decidedByUserId:ctx.userId!}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-check-acknowledgement',aggregateId:recorded.id,eventType:RULE_PROPOSAL_EVENT,actor:actorOf(ctx),
   payload:{companyId,decisionId:recorded.id,checkId:proposal.checkId,employmentId:proposal.employmentId,decision,evidence:{...proposal.evidence}}});
  if(decision==='rejected')return Object.freeze({decision:recorded,acknowledgement:null});
  const acknowledgement=await recordTx(tx,ctx,{companyId,checkId:proposal.checkId,scope:'person',employmentId:proposal.employmentId,
   reason:parsed.data.reason??`Standing rule: ${proposal.evidence.expected} of the last ${proposal.evidence.runs} were expected.`,reviewOn:null,source:'proposal',decisionId:recorded.id});
  return Object.freeze({decision:recorded,acknowledgement});
 });
}

export type AcknowledgementView=Acknowledgement&Readonly<{personName:string|null;departmentName:string|null;createdBy:string|null;blocks:boolean}>;
/** The acknowledgements of some companies with the names the viewer may read, for the loop pages. */
export async function acknowledgementViewsTx(tx:Tx,tenantId:string,companyIds:readonly string[]):Promise<AcknowledgementView[]>{
 const list=await acknowledgementsTx(tx,tenantId,companyIds);
 if(!list.length)return [];
 const names=Array.from(await tx.execute(sql`select a.id,p.full_name as person,d.name as department,cp.full_name as created_by
  from public.payroll_check_acknowledgement a left join public.employment e on e.id=a.employment_id left join public.person p on p.id=e.person_id
  left join public.department d on d.id=a.department_id left join public.app_user u on u.id=a.created_by_user_id left join public.person cp on cp.id=u.person_id
  where a.id in (${sql.join(list.map(item=>sql`${item.id}::uuid`),sql`,`)})`) as unknown as {id:string;person:string|null;department:string|null;created_by:string|null}[]);
 const byId=new Map(names.map(row=>[row.id,row]));
 return list.map(item=>Object.freeze({...item,personName:byId.get(item.id)?.person??null,departmentName:byId.get(item.id)?.department??null,
  createdBy:byId.get(item.id)?.created_by??null,blocks:isBlockCheck(item.checkId)}));
}
