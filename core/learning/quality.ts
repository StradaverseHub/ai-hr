/** AI v2 Phase 2, P2-6 — the read behind AI Centre › Insights › AI quality.
 *
 * WHO. HR and group administrators, for the companies they administer (app.is_admin_for): the Insights view renders the
 * section only for an administrator, and this read checks again. Every query runs as the viewer under row-level security
 * (migration 0972's policies, 0960's loop cases, 0963's loop actions, 0964's threshold decisions), so nothing exceeds what
 * they could open. Employees, managers and agent principals are refused before any read.
 *
 * WHAT. The figures of ./quality-math.ts over the viewer's companies (or the one the filter names): signals, loop cards,
 * gap occurrences and their statuses; the gap backlog with up to three redacted examples per intent (an expired example is
 * deleted first: the tenant's "Keep chats for" decides how long one is kept); the corrections waiting for review; the eval
 * candidates; the loops' threshold proposals and correction trends (./proposals.ts). Counts, closed-vocabulary names, dates,
 * the redacted words and opaque ids only: no name, no person, no amount. No HR-staff ratio is computed or returned. */
import {and,desc,eq,gte,inArray,sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {terasEvalCandidate,terasGapExample,terasGapStatus,terasLearningSignal,terasLearningSignalReview} from '../../db/teras-learning-schema';
import {captureCtx,requireLearningAdmin} from './access';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCompaniesTx,type CapacityCompany} from '../capacity/baseline';
import {malaysiaDayStart} from '../capacity/ledger-math';
import {listPayComponents} from '../../packs/payroll/service';
import {loopProposalsTx,type LoopProposalView} from './proposals';
import {chartMonths,computeQuality,gapBacklog,loopCorrectionTrend,periodStartDate,type GapFact,type GapRow,type GapStatusFact,type LoopCardFact,
 type LoopCorrectionFact,type LoopCorrectionRow,type QualityFigures,type SignalFact} from './quality-math';
import {CORRECTION_KINDS,isQualityPeriod,type AnswerReason,type CandidateState,type EvalFactor,type EvalKind,type LearningLocale,type LearningRole,type QualityPeriod,
 type ReviewDecision,type SignalKind} from './types';

export {LearningRefused,captureCtx,requireLearningAdmin} from './access';

export const EXAMPLES_PER_INTENT=3;
export const CORRECTIONS_SHOWN=50;
export const CANDIDATES_SHOWN=50;

export type CorrectionView=Readonly<{id:string;companyId:string;kind:SignalKind;action:string;area:string;role:LearningRole;locale:LearningLocale;at:Date;
 /** A "Not helpful" mark's reason, when the person gave one. */
 reason:AnswerReason|null;
 /** A redacted example of the same turn, when that turn was also a gap. */
 example:string|null}>;
export type CandidateView=Readonly<{id:string;companyId:string;signalId:string|null;intentKey:string|null;role:LearningRole;locale:LearningLocale;kind:EvalKind;
 factor:EvalFactor;question:string;expectation:string;state:CandidateState;version:number;changedAt:Date;approvedAt:Date|null;exportedAt:Date|null}>;
export type GapBacklogRow=GapRow&Readonly<{examples:readonly string[]}>;

export type QualityView=Readonly<{
 period:QualityPeriod;periodFrom:string;today:string;
 companies:readonly CapacityCompany[];
 /** The company the filter narrows to, or null for every company the viewer administers. */
 companyId:string|null;
 figures:QualityFigures;
 gaps:readonly GapBacklogRow[];
 corrections:readonly CorrectionView[];
 candidates:readonly CandidateView[];
 proposals:readonly LoopProposalView[];
 /** The current names of the pay items a proposal names (`item:<id>`), from the payroll catalogue as the viewer reads it. */
 patternNames:Readonly<Record<string,string>>;
 loopCorrections:readonly LoopCorrectionRow[];
}>;

const ids=(companyIds:readonly string[])=>sql`array[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
const day=(column:SQL)=>sql`to_char(${column} at time zone 'Asia/Kuala_Lumpur','YYYY-MM-DD')`;

/** An answer's first mark that was later changed counts no more: the change counts instead (0972 'answer_changed'). */
const CURRENT=sql`not (s.signal_key='answer' and exists (select 1 from public.teras_learning_signal c where c.tenant_id=s.tenant_id
 and c.record_id=s.record_id and c.signal_key='answer_changed'))`;
async function signalFactsTx(tx:Tx,ctx:SessionContext,scope:readonly string[],from:Date):Promise<SignalFact[]>{
 const rows=await tx.execute(sql`select s.company_id,s.kind,${day(sql`s.at`)} as day,count(*)::int as n from public.teras_learning_signal s
  where s.tenant_id=${ctx.tenantId}::uuid and s.company_id=any(${ids(scope)}) and s.at>=${from.toISOString()}::timestamptz and ${CURRENT} group by 1,2,3`) as unknown as {company_id:string;kind:SignalKind;day:string;n:number}[];
 return Array.from(rows).map(row=>Object.freeze({companyId:row.company_id,kind:row.kind,date:row.day,count:Number(row.n)}));
}
async function loopCardFactsTx(tx:Tx,ctx:SessionContext,scope:readonly string[],from:Date):Promise<LoopCardFact[]>{
 const rows=await tx.execute(sql`select c.company_id,c.resolution,${day(sql`c.closed_at`)} as day,count(*)::int as n from public.teras_loop_case c
  where c.tenant_id=${ctx.tenantId}::uuid and c.company_id=any(${ids(scope)}) and c.state='closed' and c.close_reason='done'
   and c.resolution in ('as_prepared','changed') and c.closed_at>=${from.toISOString()}::timestamptz group by 1,2,3`) as unknown as {company_id:string;resolution:'as_prepared'|'changed';day:string;n:number}[];
 return Array.from(rows).map(row=>Object.freeze({companyId:row.company_id,resolution:row.resolution,date:row.day,count:Number(row.n)}));
}
async function gapFactsTx(tx:Tx,ctx:SessionContext,scope:readonly string[],from:Date):Promise<GapFact[]>{
 const rows=await tx.execute(sql`select o.company_id,o.intent_key,o.role,${day(sql`o.at`)} as day,count(*)::int as n from public.teras_gap_occurrence o
  where o.tenant_id=${ctx.tenantId}::uuid and o.company_id=any(${ids(scope)}) and o.at>=${from.toISOString()}::timestamptz group by 1,2,3,4`) as unknown as {company_id:string;intent_key:string;role:LearningRole;day:string;n:number}[];
 return Array.from(rows).map(row=>Object.freeze({companyId:row.company_id,intentKey:row.intent_key,role:row.role,date:row.day,count:Number(row.n)}));
}
/** Each intent's current status per company: its highest version. */
export async function gapStatusesTx(tx:Tx,ctx:SessionContext,scope:readonly string[]):Promise<GapStatusFact[]>{
 if(!scope.length)return [];
 const g=terasGapStatus;
 const rows=await tx.selectDistinctOn([g.companyId,g.intentKey],{companyId:g.companyId,intentKey:g.intentKey,status:g.status,duplicateOf:g.duplicateOf})
  .from(g).where(and(eq(g.tenantId,ctx.tenantId),inArray(g.companyId,[...scope]))).orderBy(g.companyId,g.intentKey,desc(g.version));
 return rows.map(row=>Object.freeze({...row}));
}
/** Deletes the expired examples of these companies (their own stamp, or the tenant's "Keep chats for" as it is now), then
 * reads up to EXAMPLES_PER_INTENT per intent, newest first. An example whose chat was deleted, erased or removed by
 * retention is already gone with it (0972's ON DELETE CASCADE). */
async function examplesTx(tx:Tx,ctx:SessionContext,scope:readonly string[],intents:readonly string[]):Promise<Map<string,string[]>>{
 const out=new Map<string,string[]>();
 if(!scope.length||!intents.length)return out;
 const e=terasGapExample;
 await tx.delete(e).where(and(eq(e.tenantId,ctx.tenantId),inArray(e.companyId,[...scope]),sql`(${e.expiresAt}<=now() or not app.teras_gap_example_kept(${e.tenantId},${e.at}))`));
 const rows=await tx.select({intentKey:e.intentKey,text:e.text}).from(e)
  .where(and(eq(e.tenantId,ctx.tenantId),inArray(e.companyId,[...scope]),inArray(e.intentKey,[...intents]),sql`${e.expiresAt}>now()`))
  .orderBy(e.intentKey,desc(e.at),desc(e.id));
 for(const row of rows){const list=out.get(row.intentKey)??[];if(list.length<EXAMPLES_PER_INTENT&&!list.includes(row.text))list.push(row.text);out.set(row.intentKey,list);}
 return out;
}
/** Each signal's current review decision: its highest version; none is open. */
export async function reviewStatesTx(tx:Tx,ctx:SessionContext,signalIds:readonly string[]):Promise<Map<string,{decision:ReviewDecision;version:number}>>{
 if(!signalIds.length)return new Map();
 const r=terasLearningSignalReview;
 const rows=await tx.selectDistinctOn([r.signalId],{signalId:r.signalId,decision:r.decision,version:r.version}).from(r)
  .where(and(eq(r.tenantId,ctx.tenantId),inArray(r.signalId,[...signalIds]))).orderBy(r.signalId,desc(r.version));
 return new Map(rows.map(row=>[row.signalId,{decision:row.decision,version:row.version}]));
}
async function correctionsTx(tx:Tx,ctx:SessionContext,scope:readonly string[],from:Date):Promise<CorrectionView[]>{
 const s=terasLearningSignal;
 // Read a bounded page beyond what is shown, so reviewed rows can be skipped.
 const rows=await tx.select({id:s.id,companyId:s.companyId,kind:s.kind,action:s.action,area:s.area,role:s.role,locale:s.locale,at:s.at,recordId:s.recordId,reason:s.reason}).from(s)
  .where(and(eq(s.tenantId,ctx.tenantId),inArray(s.companyId,[...scope]),inArray(s.kind,[...CORRECTION_KINDS]),gte(s.at,from),
   sql`not (${s.signalKey}='answer' and exists (select 1 from public.teras_learning_signal c where c.tenant_id=${s.tenantId} and c.record_id=${s.recordId} and c.signal_key='answer_changed'))`))
  .orderBy(desc(s.at),desc(s.id)).limit(CORRECTIONS_SHOWN*4);
 const reviewed=await reviewStatesTx(tx,ctx,rows.map(row=>row.id));
 const open=rows.filter(row=>{const state=reviewed.get(row.id)?.decision;return state===undefined||state==='reopened';}).slice(0,CORRECTIONS_SHOWN);
 const e=terasGapExample;
 const examples=open.length?await tx.select({recordId:e.recordId,text:e.text}).from(e)
  .where(and(eq(e.tenantId,ctx.tenantId),inArray(e.recordId,open.map(row=>row.recordId)),sql`${e.expiresAt}>now()`)):[];
 const byRecord=new Map(examples.map(row=>[row.recordId,row.text]));
 return open.map(row=>Object.freeze({id:row.id,companyId:row.companyId,kind:row.kind,action:row.action,area:row.area,role:row.role,locale:row.locale,at:row.at,
  reason:row.reason??null,example:byRecord.get(row.recordId)??null}));
}
async function candidatesTx(tx:Tx,ctx:SessionContext,scope:readonly string[]):Promise<CandidateView[]>{
 const c=terasEvalCandidate;
 const rows=await tx.select().from(c).where(and(eq(c.tenantId,ctx.tenantId),inArray(c.companyId,[...scope]),sql`${c.state}<>'withdrawn'`))
  .orderBy(desc(c.changedAt),desc(c.id)).limit(CANDIDATES_SHOWN);
 return rows.map(row=>Object.freeze({id:row.id,companyId:row.companyId,signalId:row.signalId,intentKey:row.intentKey,role:row.role,locale:row.locale,kind:row.kind,
  factor:row.factor,question:row.question,expectation:row.expectation,state:row.state,version:row.version,changedAt:row.changedAt,approvedAt:row.approvedAt,exportedAt:row.exportedAt}));
}
/** Loop corrections by month: at Prepare, cards completed with a changed value; above Prepare, automatic actions people
 * changed or undid (the demotion signal of core/loops/autonomy-views.ts). */
async function loopCorrectionFactsTx(tx:Tx,ctx:SessionContext,scope:readonly string[],from:Date):Promise<LoopCorrectionFact[]>{
 const month=(column:SQL)=>sql`to_char(${column} at time zone 'Asia/Kuala_Lumpur','YYYY-MM')`;
 const cards=await tx.execute(sql`select c.worker_id as loop,c.company_id,${month(sql`c.closed_at`)} as month,count(*)::int as decided,
   count(*) filter (where c.resolution='changed')::int as corrected from public.teras_loop_case c
  where c.tenant_id=${ctx.tenantId}::uuid and c.company_id=any(${ids(scope)}) and c.state='closed' and c.close_reason='done'
   and c.resolution in ('as_prepared','changed') and c.closed_at>=${from.toISOString()}::timestamptz group by 1,2,3`) as unknown as {loop:string;company_id:string;month:string;decided:number;corrected:number}[];
 const actions=await tx.execute(sql`select a.worker_id as loop,a.company_id,${month(sql`a.applied_at`)} as month,count(*)::int as decided,
   count(*) filter (where a.people_changed_at is not null or exists (select 1 from public.teras_loop_action_undo u where u.action_id=a.id))::int as corrected
  from public.teras_loop_action a
  where a.tenant_id=${ctx.tenantId}::uuid and a.company_id=any(${ids(scope)}) and a.state='applied' and a.applied_at>=${from.toISOString()}::timestamptz group by 1,2,3`) as unknown as {loop:string;company_id:string;month:string;decided:number;corrected:number}[];
 return [...Array.from(cards),...Array.from(actions)].map(row=>Object.freeze({loop:row.loop,companyId:row.company_id,month:row.month,decided:Number(row.decided),corrected:Number(row.corrected)}));
}

export async function aiQuality(supplied:SessionContext,input:Readonly<{period?:unknown;companyId?:unknown;now?:Date}>={}):Promise<QualityView>{
 const ctx=captureCtx(supplied);
 requireLearningAdmin(ctx);
 const now=input.now??new Date();
 const period:QualityPeriod=isQualityPeriod(input.period)?input.period:'last30';
 const today=todayInKualaLumpur(now),periodFrom=periodStartDate(period,today),months=chartMonths(period,today);
 const from=malaysiaDayStart([periodFrom,months[0]+'-01'].sort()[0]);
 const view=await withTenant(ctx,async tx=>{
  const companies=await adminCompaniesTx(tx,ctx);
  // The filter only narrows: an id the viewer does not administer selects every company they do.
  const selected=companies.find(row=>row.id===input.companyId)??null;
  const scope=selected?[selected.id]:companies.map(row=>row.id);
  const empty=!scope.length;
  const signals:SignalFact[]=empty?[]:await signalFactsTx(tx,ctx,scope,from);
  const loopCards:LoopCardFact[]=empty?[]:await loopCardFactsTx(tx,ctx,scope,from);
  const gapFacts:GapFact[]=empty?[]:await gapFactsTx(tx,ctx,scope,from);
  const statuses:GapStatusFact[]=empty?[]:await gapStatusesTx(tx,ctx,scope);
  const figures=computeQuality({period,today,signals,loopCards,gaps:gapFacts,statuses});
  const backlog=gapBacklog({period,today,gaps:gapFacts,statuses});
  const examples=empty?new Map<string,string[]>():await examplesTx(tx,ctx,scope,backlog.map(row=>row.intentKey));
  const periodStart=malaysiaDayStart(periodFrom);
  const corrections=empty?[]:await correctionsTx(tx,ctx,scope,periodStart);
  const candidates=empty?[]:await candidatesTx(tx,ctx,scope);
  const proposals=empty?[]:await loopProposalsTx(tx,ctx,companies.filter(row=>scope.includes(row.id)),now);
  const loopCorrections=loopCorrectionTrend(empty?[]:await loopCorrectionFactsTx(tx,ctx,scope,from),months);
  return Object.freeze({period,periodFrom,today,companies,companyId:selected?.id??null,figures,
   gaps:Object.freeze(backlog.map(row=>Object.freeze({...row,examples:Object.freeze(examples.get(row.intentKey)??[])}))),
   corrections:Object.freeze(corrections),candidates:Object.freeze(candidates),proposals,loopCorrections});
 });
 return Object.freeze({...view,patternNames:await patternNamesOf(ctx,view.proposals.map(row=>row.pattern).filter((item):item is string=>Boolean(item)))});
}

/** A pay item pattern's current name (the Salary payroll loop's own lookup, core/loops/payroll-cycle-views.ts); a catalogue
 * the viewer cannot read gives no names, and the page says the item is not named. */
async function patternNamesOf(ctx:SessionContext,patterns:readonly string[]):Promise<Readonly<Record<string,string>>>{
 const wanted=new Set(patterns.filter(pattern=>pattern.startsWith('item:')));
 if(!wanted.size)return Object.freeze({});
 try{
  const components=await listPayComponents(ctx,{includeArchived:true});
  return Object.freeze(Object.fromEntries(components.filter(component=>wanted.has(`item:${component.id}`)).map(component=>[`item:${component.id}`,component.name])));
 }catch{return Object.freeze({});}
}
