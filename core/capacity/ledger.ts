/** AI v2 Phase 2, P2-4 — the read behind AI Centre › Insights › HR capacity (approved mock-up Ledger.dc.html).
 *
 * WHAT IT COUNTS, per company in the viewer's filter:
 *  - loop work: every loop card a person completed (teras_loop_case closed as done), with the time from its
 *    preparation to its confirmation and whether the person changed what was prepared;
 *  - employee questions AI Centre answered (the assistant's answered or suggested turns in the outcome record);
 *  - AI-prepared actions a person confirmed (an outcome record whose decision follow-up accepted it), with
 *    the time from preparation to that decision;
 *  - payroll errors caught before the run: anomaly findings resolved as fixed upstream before the batch closed.
 * HOURS FREED come from the arithmetic in ./ledger-math.ts over the company's own baseline (./baseline.ts).
 *
 * WHO. HR and group administrators, for the companies they administer (app.is_admin_for); the page's guard, checked
 * again here. Every read runs as the viewer under row-level security, so nothing exceeds what they could open: the
 * outcome record is readable across people by group administrators only (migration 0928), so question and confirmed-
 * action counts are shown to group administrators and marked unavailable for others; anomaly verdicts are readable by
 * payroll administrators (migration 0425), and the tile is shown only while the tenant holds payroll. Counts only:
 * no name, no question, no amount leaves this file. Employees never reach it. */
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {isGroupAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {isModuleEnabled} from '../entitlements';
import {ASSISTANT_TURN_IDENTITY} from '../outcome-record/summary';
import {adminCompaniesTx,autopilotStartsTx,currentBaselinesTx,requireCapacityAdmin,type CapacityCompany,type CurrentBaseline} from './baseline';
import {LOOP_IDS} from '../loops/types';
import {chartMonths,computeLedger,malaysiaDayStart,periodStartDate,type CountFact,type Ledger,type WorkFact} from './ledger-math';
import {isCapacityPeriod,type CapacityItem,type CapacityPeriod} from './types';

export type CapacityLedgerView=Readonly<{
 period:CapacityPeriod;periodFrom:string;today:string;
 companies:readonly CapacityCompany[];
 /** The company the filter narrows to, or null for every company the viewer administers. */
 companyId:string|null;
 baselines:readonly CurrentBaseline[];
 /** The earliest day Autopilot started in the filter's companies, if it has. */
 autopilotStart:string|null;
 ledger:Ledger;
}>;

const ids=(companyIds:readonly string[])=>sql`array[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
const day=(column:SQL)=>sql`to_char(${column} at time zone 'Asia/Kuala_Lumpur','YYYY-MM-DD')`;
type FactRow={company_id:string;item:string;day:string;n:number|string;changed:number|string;gaps:(number|string)[]|null};
const toFacts=(rows:FactRow[]):WorkFact[]=>rows.map(row=>Object.freeze({companyId:row.company_id,item:row.item as CapacityItem,date:row.day,
 count:Number(row.n),changed:Number(row.changed),gaps:row.gaps===null?null:row.gaps.map(Number)}));

async function loopFactsTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[],from:Date):Promise<WorkFact[]>{
 const closed=sql`c.closed_at`;
 const rows=await tx.execute(sql`select c.company_id,c.worker_id as item,${day(closed)} as day,count(*)::int as n,
   count(*) filter (where c.resolution='changed')::int as changed,
   array_agg(round((greatest(0,extract(epoch from c.closed_at-c.opened_at))/60.0)::numeric,1)::float8) as gaps
  from public.teras_loop_case c
  where c.tenant_id=${ctx.tenantId}::uuid and c.state='closed' and c.close_reason='done' and c.closed_at>=${from.toISOString()}::timestamptz
   and c.company_id=any(${ids(companyIds)}) and c.worker_id=any(array[${sql.join(LOOP_IDS.map(id=>sql`${id}`),sql`, `)}]::text[])
  group by 1,2,3`) as unknown as FactRow[];
 return toFacts(Array.from(rows));
}

async function outcomeFactsTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[],from:Date):Promise<WorkFact[]>{
 const decided=sql`f.at`;
 const confirmed=await tx.execute(sql`select r.company_id,'actions_confirmed' as item,${day(decided)} as day,count(*)::int as n,0 as changed,
   array_agg(round((greatest(0,extract(epoch from f.at-r.finished_at))/60.0)::numeric,1)::float8) as gaps
  from public.teras_outcome_record r join public.teras_outcome_followup f on f.tenant_id=r.tenant_id and f.record_id=r.id
  where r.tenant_id=${ctx.tenantId}::uuid and f.kind='decision' and f.decision='accepted' and f.at>=${from.toISOString()}::timestamptz
   and r.company_id=any(${ids(companyIds)})
  group by 1,3`) as unknown as FactRow[];
 const started=sql`r.started_at`;
 const answered=await tx.execute(sql`select r.company_id,'questions_answered' as item,${day(started)} as day,count(*)::int as n,0 as changed,null as gaps
  from public.teras_outcome_record r
  where r.tenant_id=${ctx.tenantId}::uuid and r.agent_identity=${ASSISTANT_TURN_IDENTITY} and r.authority_kind='person' and r.run_kind='turn'
   and r.outcome_kind in ('answered','suggested') and not r.private_to_asker and r.started_at>=${from.toISOString()}::timestamptz
   and r.company_id=any(${ids(companyIds)})
   and not exists (select 1 from public.teras_outcome_followup f where f.tenant_id=r.tenant_id and f.record_id=r.id and f.kind='decision'
    and f.decision='accepted')
  group by 1,3`) as unknown as FactRow[];
 return [...toFacts(Array.from(confirmed)),...toFacts(Array.from(answered))];
}

/** Anomaly findings fixed upstream before their batch closed: each one an error caught before the run. */
async function payrollErrorFactsTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[],from:Date):Promise<CountFact[]>{
 const resolved=sql`v.resolved_at`;
 const rows=await tx.execute(sql`select b.company_id,${day(resolved)} as day,count(*)::int as n
  from public.payroll_anomaly_verdict v join public.payroll_batch b on b.id=v.batch_id and b.tenant_id=v.tenant_id
  where v.tenant_id=${ctx.tenantId}::uuid and v.resolution='fixed_upstream' and v.resolved_at>=${from.toISOString()}::timestamptz
   and (b.closed_at is null or v.resolved_at<b.closed_at) and b.company_id=any(${ids(companyIds)})
  group by 1,2`) as unknown as {company_id:string;day:string;n:number|string}[];
 return Array.from(rows).map(row=>Object.freeze({companyId:row.company_id,date:row.day,count:Number(row.n)}));
}

export async function capacityLedger(supplied:SessionContext,input:Readonly<{period?:unknown;companyId?:unknown;now?:Date}>={}):Promise<CapacityLedgerView>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 requireCapacityAdmin(ctx);
 const period:CapacityPeriod=isCapacityPeriod(input.period)?input.period:'last30';
 const today=todayInKualaLumpur(input.now),periodFrom=periodStartDate(period,today),months=chartMonths(period,today);
 const readFrom=[periodFrom,months[0]+'-01'].sort()[0];
 const from=malaysiaDayStart(readFrom);
 const outcomesVisible=isGroupAdmin(ctx),payrollVisible=isModuleEnabled(ctx,'payroll');
 return withTenant(ctx,async tx=>{
  const companies=await adminCompaniesTx(tx,ctx);
  // The filter only narrows: an id the viewer does not administer selects every company they do.
  const selected=companies.find(row=>row.id===input.companyId)??null;
  const scope=selected?[selected.id]:companies.map(row=>row.id);
  const baselines=await currentBaselinesTx(tx,ctx,scope);
  const starts=await autopilotStartsTx(tx,ctx,scope);
  const work=scope.length?[...await loopFactsTx(tx,ctx,scope,from),...(outcomesVisible?await outcomeFactsTx(tx,ctx,scope,from):[])]:[];
  const payrollErrors=payrollVisible?(scope.length?await payrollErrorFactsTx(tx,ctx,scope,from):[]):null;
  const ledger=computeLedger({periodFrom,months,companyIds:scope,baselines:baselines.map(row=>({companyId:row.companyId,items:row.items})),
   work,payrollErrors,outcomesVisible});
  return Object.freeze({period,periodFrom,today,companies,companyId:selected?.id??null,baselines,
   autopilotStart:[...starts.values()].sort()[0]??null,ledger});
 });
}
