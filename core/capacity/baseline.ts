/** AI v2 Phase 2, P2-4 — a company's HR capacity baseline: read, measure and set (migration 0966).
 *
 * The baseline is the company's OWN manual time per item before Autopilot started. Its period ends on the day AI Centre
 * prepared the company's first loop card (or on the day it is set, if no loop has started there) and runs back the
 * number of days the administrator chooses. Inside that period the event log measures what it can, through the process
 * assessment's own counting rule (core/process-assessment.ts measureForCompany): cases started, cases completed and
 * staff actions. The administrator supplies the minutes the log cannot know (core/capacity/baseline-rules.ts).
 *
 * Administrators of the company only, under their own login (the page's guard, checked again here, and the 0966
 * policies). Setting a baseline appends a new version; earlier versions stay. The measure is recomputed here on save,
 * never taken from the form. An audit event records who set which version, its period and each item's basis and
 * minutes (no name, no amount, no free text). */
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasCapacityBaseline} from '../../db/teras-capacity-schema';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {isModuleEnabled} from '../entitlements';
import {MIN_COMPLETED,PROCESS_PROFILES,measureForCompany} from '../process-assessment';
import {MAX_ITEM_MINUTES,MAX_MINUTES_PER_STAFF_ACTION,parseMinutes,resolveBaselineItems,type ProcessEvidence} from './baseline-rules';
import {addDays,malaysiaDayStart} from './ledger-math';
import {BASELINE_DAYS,CAPACITY_ITEMS,MEASURED_BY,type BaselineDays,type CapacityBaselineItems,type CapacityItem,type MeasuredProcess} from './types';

export class CapacityRefused extends Error{
 constructor(readonly reason:'not_administrator'|'invalid'|'empty'|'conflict'){super('Capacity ledger refused: '+reason);this.name='CapacityRefused';}
}
export const requireCapacityAdmin=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new CapacityRefused('not_administrator');};
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

export type CapacityCompany=Readonly<{id:string;name:string}>;
/** The companies the viewer administers, by name. */
export async function adminCompaniesTx(tx:Tx,ctx:SessionContext):Promise<readonly CapacityCompany[]>{
 const rows=await tx.execute(sql`select c.id,c.legal_name from public.company c where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id) is true
  order by c.legal_name,c.id`) as unknown as {id:string;legal_name:string}[];
 return Object.freeze(Array.from(rows).map(row=>Object.freeze({id:row.id,name:row.legal_name})));
}
async function isAdminForTx(tx:Tx,companyId:string){
 const [row]=await tx.execute(sql`select app.is_admin_for(${companyId}::uuid) as ok`) as unknown as {ok:boolean|null}[];
 return row?.ok===true;
}

export type CurrentBaseline=Readonly<{companyId:string;version:number;periodFrom:string;periodTo:string;minutesPerStaffAction:number|null;
 items:CapacityBaselineItems;setAt:Date}>;
/** Each company's current baseline (its highest version), as the viewer may read it. */
export async function currentBaselinesTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[]):Promise<readonly CurrentBaseline[]>{
 if(!companyIds.length)return [];
 const b=terasCapacityBaseline;
 const rows=await tx.selectDistinctOn([b.companyId],{companyId:b.companyId,version:b.version,periodFrom:b.periodFrom,periodTo:b.periodTo,
  minutesPerStaffAction:b.minutesPerStaffAction,items:b.items,setAt:b.setAt})
  .from(b).where(and(eq(b.tenantId,ctx.tenantId),inArray(b.companyId,[...companyIds]))).orderBy(b.companyId,desc(b.version));
 return Object.freeze(rows.map(row=>Object.freeze({...row,minutesPerStaffAction:row.minutesPerStaffAction==null?null:Number(row.minutesPerStaffAction)})));
}

/** The Malaysia calendar day AI Centre prepared each company's first loop card: when Autopilot started there. */
export async function autopilotStartsTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[]):Promise<ReadonlyMap<string,string>>{
 if(!companyIds.length)return new Map();
 const rows=await tx.execute(sql`select company_id,to_char(min(first_opened_at) at time zone 'Asia/Kuala_Lumpur','YYYY-MM-DD') as day
  from public.teras_loop_case where tenant_id=${ctx.tenantId}::uuid
   and company_id=any(array[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) group by company_id`) as unknown as {company_id:string;day:string}[];
 return new Map(Array.from(rows).map(row=>[row.company_id,row.day]));
}

/** The baseline period: `days` calendar days ending (exclusive) on the day Autopilot started, or today. */
export function baselinePeriod(autopilotStart:string|null,today:string,days:BaselineDays){
 const periodTo=autopilotStart&&autopilotStart<today?autopilotStart:today;
 return Object.freeze({periodFrom:addDays(periodTo,-days),periodTo});
}

const MEASURED_PROCESSES=[...new Set(Object.values(MEASURED_BY))] as MeasuredProcess[];
/** What the event log measures for one company over the baseline period; null where the owning module is off. */
export async function baselineEvidenceTx(tx:Tx,ctx:SessionContext,companyId:string,period:Readonly<{periodFrom:string;periodTo:string}>){
 const out:Partial<Record<MeasuredProcess,ProcessEvidence|null>>={};
 for(const process of MEASURED_PROCESSES){
  const module=PROCESS_PROFILES[process].module;
  if(module!=null&&!isModuleEnabled(ctx,module)){out[process]=null;continue;}
  const m=await measureForCompany(tx,process,companyId,malaysiaDayStart(period.periodFrom),malaysiaDayStart(period.periodTo));
  out[process]=Object.freeze({cases:m.started,completed:m.completed,staffActions:m.staffActions});
 }
 return Object.freeze(out);
}

export const parseBaselineDays=(value:unknown):BaselineDays=>{const n=Number(value);return (BASELINE_DAYS as readonly number[]).includes(n)?n as BaselineDays:90;};

export type BaselineSetup=Readonly<{company:CapacityCompany;days:BaselineDays;autopilotStart:string|null;periodFrom:string;periodTo:string;
 evidence:Readonly<Partial<Record<MeasuredProcess,ProcessEvidence|null>>>;minCompleted:number;current:CurrentBaseline|null}>;
/** What the guided set-up shows for one company the viewer administers: the period, the event log's measure, and the
 * current baseline. */
export async function baselineSetup(supplied:SessionContext,input:Readonly<{companyId:unknown;days:unknown;now?:Date}>):Promise<BaselineSetup>{
 const ctx=capture(supplied);requireCapacityAdmin(ctx);
 const companyId=z.guid().safeParse(input.companyId);
 if(!companyId.success)throw new CapacityRefused('invalid');
 const days=parseBaselineDays(input.days),today=todayInKualaLumpur(input.now);
 return withTenant(ctx,async tx=>{
  const company=(await adminCompaniesTx(tx,ctx)).find(row=>row.id===companyId.data);
  if(!company)throw new CapacityRefused('not_administrator');
  const autopilotStart=(await autopilotStartsTx(tx,ctx,[company.id])).get(company.id)??null;
  const period=baselinePeriod(autopilotStart,today,days);
  const [current]=await currentBaselinesTx(tx,ctx,[company.id]);
  return Object.freeze({company,days,autopilotStart,...period,evidence:await baselineEvidenceTx(tx,ctx,company.id,period),minCompleted:MIN_COMPLETED,current:current??null});
 });
}

/** Blank is "not given"; anything else must be a valid number of minutes, or the whole save is refused. */
function minutesField(value:unknown,max:number):number|null{
 if(value==null||(typeof value==='string'&&value.trim()===''))return null;
 const n=parseMinutes(value,max);
 if(n===null)throw new CapacityRefused('invalid');
 return n;
}

/** Sets a company's baseline: a new version, measured and resolved here. */
export async function setCapacityBaseline(supplied:SessionContext,input:Readonly<{companyId:unknown;days:unknown;minutesPerStaffAction:unknown;
 entered:Readonly<Record<string,unknown>>;now?:Date}>){
 const ctx=capture(supplied);requireCapacityAdmin(ctx);
 const companyId=z.guid().safeParse(input.companyId);
 if(!companyId.success||!(BASELINE_DAYS as readonly number[]).includes(Number(input.days)))throw new CapacityRefused('invalid');
 const days=Number(input.days) as BaselineDays,today=todayInKualaLumpur(input.now);
 const minutesPerStaffAction=minutesField(input.minutesPerStaffAction,MAX_MINUTES_PER_STAFF_ACTION);
 const entered:Partial<Record<CapacityItem,number|null>>={};
 for(const item of CAPACITY_ITEMS)entered[item]=minutesField(input.entered[item],MAX_ITEM_MINUTES);
 return withTenant(ctx,async tx=>{
  if(!(await isAdminForTx(tx,companyId.data)))throw new CapacityRefused('not_administrator');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`capacity-baseline:${ctx.tenantId}:${companyId.data}`},0))`);
  const autopilotStart=(await autopilotStartsTx(tx,ctx,[companyId.data])).get(companyId.data)??null;
  const period=baselinePeriod(autopilotStart,today,days);
  const evidence=await baselineEvidenceTx(tx,ctx,companyId.data,period);
  const items=resolveBaselineItems({entered,minutesPerStaffAction,evidence,minCompleted:MIN_COMPLETED});
  if(!Object.keys(items).length)throw new CapacityRefused('empty');
  const b=terasCapacityBaseline;
  const [last]=await tx.select({version:b.version}).from(b).where(and(eq(b.tenantId,ctx.tenantId),eq(b.companyId,companyId.data))).orderBy(desc(b.version)).limit(1);
  const version=(last?.version??0)+1;
  const [row]=await tx.insert(b).values({tenantId:ctx.tenantId,companyId:companyId.data,version,periodFrom:period.periodFrom,periodTo:period.periodTo,
   minutesPerStaffAction:minutesPerStaffAction==null?null:String(minutesPerStaffAction),items,setByUserId:ctx.userId!}).returning({id:b.id,version:b.version});
  if(!row)throw new CapacityRefused('conflict');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-capacity-baseline',aggregateId:companyId.data,eventType:'teras-capacity.baseline-set',
   actor:actorOf(ctx),payload:{companyId:companyId.data,version,periodFrom:period.periodFrom,periodTo:period.periodTo,minutesPerStaffAction,
    items:Object.fromEntries(Object.entries(items).map(([item,value])=>[item,{basis:value!.basis,minutes:value!.minutes}]))}});
  return Object.freeze({version:row.version,items,...period});
 });
}
