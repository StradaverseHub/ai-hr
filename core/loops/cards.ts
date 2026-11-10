/** AI v2 W8 — the cards the loops prepared, for Today's "Needs you", read as the viewer.
 *
 * Only open cases are shown, only while their loop's switch is on, the tenant is not stopped and the company is not
 * paused for that loop (a stale card from a loop that no longer runs is never shown). Row-level security decides
 * what the viewer may read (migration 0960): an employee their own cases addressed to them, an administrator the
 * cases of employments and companies they administer. Each card opens the owning service's own page, where the person
 * confirms; the card itself completes nothing. Facts are the case's own dates, times and keys; the only names are the
 * employee's and the company's, read through their owners' row-level security. */
import {and,eq,inArray,sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {company,employment,person} from '../../db/schema';
import {terasLoopCase,terasLoopPause} from '../../db/teras-schema';
import {terasLoopLevel} from '../../db/teras-autonomy-schema';
import {assignedApprovalHref} from '../../lib/assigned-approval-focus';
import {workerModule,workerRunGatesBundleSql,workerRunGatesFromBundle,workerRunGatesTx} from '../agent-registry/controls';
import {decodeJsonFieldRows,jsonFieldsSql,jsonRowsSql} from '../../db/json-fields';
import {isModuleEnabled} from '../entitlements';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {PAYROLL_INPUTS_LEAD_DAYS,daysBetween} from './period';
import {LOOP_IDS,type LoopFacts,type LoopId} from './types';
import {readAutonomyCardsTx,type AutonomyCard} from './autonomy-cards';

export type EmployeeLoopCard=Readonly<
 |{kind:'clockOut';caseId:string;date:string;checkIn:string;proposedCheckOut:string;href:string}
 |{kind:'record';caseId:string;gaps:readonly string[];href:string}
 |{kind:'passport';caseId:string;expiresOn:string;href:string}>;

export type LoopCard=Readonly<
 /** `reviewId`: the probation review the case found, when one is open (Today shows a review already waiting as an
  * approvals task once, as that task: components/today/reads.ts). */
 |{kind:'probation';caseId:string;name:string|null;endDate:string;stage:'none'|'with_manager'|'with_hr';overdue:boolean;reviewId:string|null;href:string}
 |{kind:'payroll';caseId:string;companyName:string|null;payPeriod:string;cutOff:string;missing:readonly string[];blockers:number;href:string;
  /** AI v2 P2-2a: the Pre-salary checks still open or waiting (core/loops/pre-salary-checks.ts keys), set-up excluded. */
  checks:readonly string[]}
 |{kind:'passports';count:number;first:string;href:string}> | EmployeeLoopCard
 /** AI v2 Phase 2 P2-1: a clock-out the loop set on the viewer's own day (with Undo), and a loop that moved itself down. */
 |AutonomyCard;
/** Cap administrative summaries. Every open self-service case is shown to its employee. */
export const LOOP_CARD_LIMIT=5;

const str=(facts:LoopFacts,key:string)=>typeof facts[key]==='string'?facts[key] as string:null;
const list=(facts:LoopFacts,key:string)=>Array.isArray(facts[key])?(facts[key] as readonly string[]).filter(value=>typeof value==='string'):[];
const isDate=(value:string|null):value is string=>!!value&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const isClock=(value:string|null):value is string=>!!value&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const isUuid=(value:string|null):value is string=>!!value&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const TABS=new Set(['profile','bankStatutory','payroll']);

/** Where each card opens: the owner's own page. Exported for the tests, which pin them. */
export const LOOP_CARD_HREF=Object.freeze({
 probation:(employmentId:string,stage:string,reviewId:string|null)=>stage==='with_hr'&&isUuid(reviewId)?assignedApprovalHref({kind:'hrReview',id:reviewId})
  :`/admin/personnel/${encodeURIComponent(employmentId)}`,
 // AI v2 P2-2a: the Pre-salary loop's company view on the Payroll cycle page, where each check links to its owner page.
 payroll:(companyId:string,payPeriod:string)=>`/control-tower/loops/payroll-cycle?${new URLSearchParams({company:companyId,period:payPeriod})}`,
 passports:()=>'/personnel',
 // The slice 1 correction's own form: the person's attendance day, the proposed clock-out in its box.
 clockOut:(date:string,proposedCheckOut:string,employmentId?:string)=>`/attendance/my-records/${date}?${new URLSearchParams({checkOut:proposedCheckOut,...(employmentId?{employmentId,home:'1'}:{})})}`,
 // The person's own profile change request section (the readiness work list's own link).
 record:(tab:string,employmentId?:string)=>`/me?${new URLSearchParams({tab,...(employmentId?{employmentId}:{})})}#section-request-${tab}`,
 passport:(employmentId?:string)=>`/me?${new URLSearchParams({tab:'profile',...(employmentId?{employmentId}:{})})}`,
});

/** `admin`: the viewer's Today shows HR cards for the companies in `scopeIds`; everyone sees their own cards. `today`
 * (default the HR day): the Pre-salary card shows only in the last PAYROLL_INPUTS_LEAD_DAYS before its cut-off. */
type LoopCardRead=Readonly<{scopeIds:readonly string[];admin:boolean;today?:string;employeeOnly?:true}>;
const LOOP_PAUSE_FIELDS={workerId:terasLoopPause.workerId,companyId:terasLoopPause.companyId};
const loopPauseWhere=(ctx:SessionContext)=>and(eq(terasLoopPause.tenantId,ctx.tenantId),eq(terasLoopPause.paused,true));
const LOOP_CASE_FIELDS={id:terasLoopCase.id,workerId:terasLoopCase.workerId,companyId:terasLoopCase.companyId,employmentId:terasLoopCase.employmentId,
 recipient:terasLoopCase.recipient,facts:terasLoopCase.facts,personId:employment.personId,name:person.fullName,companyName:company.legalName};
const loopCaseWhere=(ctx:SessionContext,p:LoopCardRead,workers:readonly LoopId[])=>and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.state,'open'),inArray(terasLoopCase.workerId,[...workers]),
 p.employeeOnly ? and(eq(terasLoopCase.recipient,'employee'),eq(employment.personId,ctx.personId!)) : undefined);
const LOOP_LEVEL_FIELDS={workerId:terasLoopLevel.workerId,companyId:terasLoopLevel.companyId};
const loopWatchWhere=(ctx:SessionContext)=>and(eq(terasLoopLevel.tenantId,ctx.tenantId),eq(terasLoopLevel.level,0));
const liveLoops=(gates:ReadonlyMap<string,{gate:{run:boolean}}>,p:LoopCardRead):LoopId[]=>LOOP_IDS.filter(id=>gates.get(id)?.gate.run===true &&
 (!p.employeeOnly || id==='loop_missed_clock_outs'||id==='loop_missing_employee_data'||id==='loop_document_expiry'));
type LoopCaseRow={id:string;workerId:string;companyId:string;employmentId:string|null;recipient:string;facts:LoopFacts;personId:string|null;name:string|null;companyName:string|null};
type LoopKey={workerId:string;companyId:string};
export async function readLoopCards(ctx:SessionContext,p:LoopCardRead):Promise<readonly LoopCard[]>{
 if(!ctx.userId||ctx.agent||(p.employeeOnly&&!ctx.personId))return [];
 const today=p.today??todayInKualaLumpur();
 return withTenant(ctx,async tx=>{
  // P2-1: open undo windows and automatic moves down are shown whether or not the loop still runs.
  const autonomy=p.employeeOnly?[]:await readAutonomyCardsTx(tx,ctx,{scopeIds:p.scopeIds,admin:p.admin});
  // Every loop's gate, each as workerRunGateTx answers it, read in one pass (AI Centre navigation speed, 4 Nov 2026).
  const gates=await workerRunGatesTx(tx,ctx,LOOP_IDS);
  const live=liveLoops(gates,p);
  if(!live.length)return autonomy;
  const paused=await tx.select(LOOP_PAUSE_FIELDS).from(terasLoopPause).where(loopPauseWhere(ctx));
  const fetched=await tx.select(LOOP_CASE_FIELDS)
   .from(terasLoopCase).leftJoin(employment,eq(employment.id,terasLoopCase.employmentId)).leftJoin(person,eq(person.id,employment.personId))
   .leftJoin(company,eq(company.id,terasLoopCase.companyId))
   .where(loopCaseWhere(ctx,p,live));
  // P2-1: a loop at Watch for a company observes and records there, and shows nobody a card.
  const watching=await tx.select(LOOP_LEVEL_FIELDS).from(terasLoopLevel).where(loopWatchWhere(ctx));
  return loopCardsFrom(ctx,p,today,{live,paused,fetched:fetched as LoopCaseRow[],watching},autonomy);
 });
}

/** readLoopCards for the Before payroll checklist's own read (scopeIds [], admin false) as one JSON value, a section
 * of the one-statement Before payroll read (core/pre-salary/before-payroll-bundle.ts): every loop's gate, the pauses,
 * the open cases of every loop (the projection keeps those of the live loops, as the owner's own predicate does) and
 * the Watch levels. The autonomy cards (open undo windows, moves down) are not read: the checklist reads clock-out
 * cards only. */
export function readLoopCardsBundleSql(ctx:SessionContext):SQL{
 const p:LoopCardRead={scopeIds:[],admin:false};
 return sql`jsonb_build_object('gates',${workerRunGatesBundleSql(ctx,LOOP_IDS)},
  'paused',${jsonRowsSql({row:jsonFieldsSql(LOOP_PAUSE_FIELDS),from:sql`${terasLoopPause}`,where:loopPauseWhere(ctx)})},
  'cases',${jsonRowsSql({row:jsonFieldsSql(LOOP_CASE_FIELDS),from:sql`${terasLoopCase} left join ${employment} on ${eq(employment.id,terasLoopCase.employmentId)}
   left join ${person} on ${eq(person.id,employment.personId)} left join ${company} on ${eq(company.id,terasLoopCase.companyId)}`,where:loopCaseWhere(ctx,p,LOOP_IDS)})},
  'watching',${jsonRowsSql({row:jsonFieldsSql(LOOP_LEVEL_FIELDS),from:sql`${terasLoopLevel}`,where:loopWatchWhere(ctx)})})`;
}
/** readLoopCards(ctx, {scopeIds: [], admin: false, today}) over readLoopCardsBundleSql's rows, without the autonomy
 * cards; null where the owner must read (a gate read elsewhere, or two cards whose order the owner leaves to the plan). */
export function readLoopCardsFromBundle(ctx:SessionContext,value:unknown,today?:string):readonly LoopCard[]|null{
 if(!ctx.userId||ctx.agent)return [];
 const p:LoopCardRead={scopeIds:[],admin:false};
 const raw=value as {gates:unknown;paused:unknown;cases:unknown;watching:unknown};
 const gates=workerRunGatesFromBundle(LOOP_IDS,raw.gates);
 if(!gates)return null;
 const live=liveLoops(gates,p);
 if(!live.length)return [];
 const cases=(decodeJsonFieldRows(LOOP_CASE_FIELDS,raw.cases) as LoopCaseRow[]).filter(row=>(live as readonly string[]).includes(row.workerId));
 try{
  return loopCardsFrom(ctx,p,today??todayInKualaLumpur(),{live,paused:decodeJsonFieldRows(LOOP_PAUSE_FIELDS,raw.paused),fetched:cases,
   watching:decodeJsonFieldRows(LOOP_LEVEL_FIELDS,raw.watching)},[],true);
 }catch(error){if(error instanceof LoopCardOrderTie)return null;throw error;}
}
class LoopCardOrderTie extends Error{}

/** readLoopCards' card rules over its rows. `refuseTies`: two cards of one kind whose sort keys tie throw, because their
 * order (and a consumer keying them by that value) is the plan's row order, which only the owner's own read can give. */
function loopCardsFrom(ctx:SessionContext,p:LoopCardRead,today:string,read:Readonly<{live:readonly LoopId[];paused:readonly LoopKey[];
 fetched:readonly LoopCaseRow[];watching:readonly LoopKey[]}>,autonomy:readonly AutonomyCard[],refuseTies=false):readonly LoopCard[]{
  const paused=new Set(read.paused.map(row=>`${row.workerId}:${row.companyId}`));
  const watching=new Set(read.watching.map(row=>`${row.workerId}:${row.companyId}`));
  const rows=read.fetched.filter(row=>!paused.has(`${row.workerId}:${row.companyId}`))
   .filter(row=>!watching.has(`${row.workerId}:${row.companyId}`)&&isModuleEnabled(ctx,workerModule(row.workerId),row.companyId));
  const scope=new Set(p.scopeIds),own=(row:typeof rows[number])=>row.recipient==='employee'&&!!ctx.personId&&row.personId===ctx.personId;
  const hr=(row:typeof rows[number])=>p.admin&&scope.has(row.companyId)&&!own(row);
  const cards:LoopCard[]=[];
  const take=<T extends LoopCard>(items:T[],order:(card:T)=>string,limit=LOOP_CARD_LIMIT)=>{
   const sorted=items.sort((a,b)=>order(a).localeCompare(order(b)));
   if(refuseTies&&sorted.some((card,index)=>index>0&&order(card).localeCompare(order(sorted[index-1]))===0))throw new LoopCardOrderTie();
   cards.push(...sorted.slice(0,limit));
  };
  // The employee's own cards.
  take(rows.filter(row=>own(row)&&row.workerId==='loop_missed_clock_outs').flatMap(row=>{
   const date=str(row.facts,'date'),checkIn=str(row.facts,'checkIn'),out=str(row.facts,'proposedCheckOut');
   return isDate(date)&&isClock(checkIn)&&isClock(out)?[{kind:'clockOut' as const,caseId:row.id,date,checkIn,proposedCheckOut:out,href:LOOP_CARD_HREF.clockOut(date,out,row.employmentId ?? undefined)}]:[];
  }),card=>card.date,Infinity);
  take(rows.filter(row=>own(row)&&row.workerId==='loop_missing_employee_data').flatMap(row=>{
   const gaps=list(row.facts,'gaps'),tab=list(row.facts,'tabs').find(value=>TABS.has(value));
   return gaps.length&&tab?[{kind:'record' as const,caseId:row.id,gaps,href:LOOP_CARD_HREF.record(tab,row.employmentId ?? undefined)}]:[];
  }),card=>card.caseId,Infinity);
  take(rows.filter(row=>own(row)&&row.workerId==='loop_document_expiry').flatMap(row=>{
   const expiresOn=str(row.facts,'expiresOn');
   return isDate(expiresOn)?[{kind:'passport' as const,caseId:row.id,expiresOn,href:LOOP_CARD_HREF.passport(row.employmentId ?? undefined)}]:[];
  }),card=>card.expiresOn,Infinity);
  // HR's cards, for the companies in the viewer's current scope.
  take(rows.filter(row=>hr(row)&&row.workerId==='loop_probation_ending'&&row.employmentId).flatMap(row=>{
   const endDate=str(row.facts,'endDate'),raw=str(row.facts,'stage'),stage=raw==='with_hr'||raw==='with_manager'?raw:'none';
   const reviewId=stage!=='none'&&isUuid(str(row.facts,'reviewId'))?str(row.facts,'reviewId'):null;
   return isDate(endDate)?[{kind:'probation' as const,caseId:row.id,name:row.name??null,endDate,stage,overdue:row.facts.overdue===true,reviewId,
    href:LOOP_CARD_HREF.probation(row.employmentId!,stage,str(row.facts,'reviewId'))}]:[];
  }),card=>card.endDate);
  take(rows.filter(row=>hr(row)&&row.workerId==='loop_payroll_inputs').flatMap(row=>{
   const payPeriod=str(row.facts,'payPeriod'),cutOff=str(row.facts,'cutOff'),missing=list(row.facts,'missing');
   const checks=list(row.facts,'blocking').filter(key=>key!=='setup');
   return payPeriod&&isDate(cutOff)&&(missing.length||checks.length)&&daysBetween(today,cutOff)<=PAYROLL_INPUTS_LEAD_DAYS
    ?[{kind:'payroll' as const,caseId:row.id,companyName:row.companyName??null,payPeriod,cutOff,missing,checks,
    blockers:typeof row.facts.blockers==='number'?row.facts.blockers:0,href:LOOP_CARD_HREF.payroll(row.companyId,payPeriod)}]:[];
  }),card=>card.cutOff);
  const expiring=rows.filter(row=>hr(row)&&row.workerId==='loop_document_expiry').map(row=>str(row.facts,'expiresOn')).filter(isDate).sort();
  if(expiring.length)cards.push({kind:'passports',count:expiring.length,first:expiring[0],href:LOOP_CARD_HREF.passports()});
  return Object.freeze([...cards,...autonomy]);
}

export async function readEmployeeLoopCards(ctx:SessionContext):Promise<readonly EmployeeLoopCard[]>{
 if(!ctx.personId)return [];
 const cards=await readLoopCards(ctx,{scopeIds:[],admin:false,employeeOnly:true});
 return cards.filter((card):card is EmployeeLoopCard=>card.kind==='clockOut'||card.kind==='record'||card.kind==='passport');
}
