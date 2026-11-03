/** AI v2 W8 — the cards the loops prepared, for Today's "Needs you", read as the viewer.
 *
 * Only open cases are shown, only while their loop's switch is on, the tenant is not stopped and the company is not
 * paused for that loop (a stale card from a loop that no longer runs is never shown). Row-level security decides
 * what the viewer may read (migration 0960): an employee their own cases addressed to them, an administrator the
 * cases of employments and companies they administer. Each card opens the owning service's own page, where the person
 * confirms; the card itself completes nothing. Facts are the case's own dates, times and keys; the only names are the
 * employee's and the company's, read through their owners' row-level security. */
import {and,eq,inArray} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {company,employment,person} from '../../db/schema';
import {terasLoopCase,terasLoopPause} from '../../db/teras-schema';
import {terasLoopLevel} from '../../db/teras-autonomy-schema';
import {assignedApprovalHref} from '../../lib/assigned-approval-focus';
import {workerRunGateTx} from '../agent-registry/controls';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {PAYROLL_INPUTS_LEAD_DAYS,daysBetween} from './period';
import {LOOP_IDS,type LoopFacts,type LoopId} from './types';
import {readAutonomyCardsTx,type AutonomyCard} from './autonomy-cards';

export type LoopCard=Readonly<
 /** `reviewId`: the probation review the case found, when one is open (Today shows a review already waiting as an
  * approvals task once, as that task: components/today/reads.ts). */
 |{kind:'probation';caseId:string;name:string|null;endDate:string;stage:'none'|'with_manager'|'with_hr';overdue:boolean;reviewId:string|null;href:string}
 |{kind:'payroll';caseId:string;companyName:string|null;payPeriod:string;cutOff:string;missing:readonly string[];blockers:number;href:string;
  /** AI v2 P2-2a: the Pre-salary checks still open or waiting (core/loops/pre-salary-checks.ts keys), set-up excluded. */
  checks:readonly string[]}
 |{kind:'passports';count:number;first:string;href:string}
 |{kind:'clockOut';caseId:string;date:string;checkIn:string;proposedCheckOut:string;href:string}
 |{kind:'record';caseId:string;gaps:readonly string[];href:string}
 |{kind:'passport';caseId:string;expiresOn:string;href:string}>
 /** AI v2 Phase 2 P2-1: a clock-out the loop set on the viewer's own day (with Undo), and a loop that moved itself down. */
 |AutonomyCard;
/** At most this many cards of one kind on one view; the loop's page lists every case. */
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
 clockOut:(date:string,proposedCheckOut:string)=>`/attendance/my-records/${date}?${new URLSearchParams({checkOut:proposedCheckOut})}`,
 // The person's own profile change request section (the readiness work list's own link).
 record:(tab:string)=>`/me?tab=${tab}#section-request-${tab}`,
 passport:()=>'/me?tab=profile',
});

/** `admin`: the viewer's Today shows HR cards for the companies in `scopeIds`; everyone sees their own cards. `today`
 * (default the HR day): the Pre-salary card shows only in the last PAYROLL_INPUTS_LEAD_DAYS before its cut-off. */
export async function readLoopCards(ctx:SessionContext,p:Readonly<{scopeIds:readonly string[];admin:boolean;today?:string}>):Promise<readonly LoopCard[]>{
 if(!ctx.userId||ctx.agent)return [];
 const today=p.today??todayInKualaLumpur();
 return withTenant(ctx,async tx=>{
  // P2-1: open undo windows and automatic moves down are shown whether or not the loop still runs.
  const autonomy=await readAutonomyCardsTx(tx,ctx,{scopeIds:p.scopeIds,admin:p.admin});
  const live:LoopId[]=[];
  for(const id of LOOP_IDS)if((await workerRunGateTx(tx,ctx,id)).run)live.push(id);
  if(!live.length)return autonomy;
  const paused=new Set((await tx.select({workerId:terasLoopPause.workerId,companyId:terasLoopPause.companyId}).from(terasLoopPause)
   .where(and(eq(terasLoopPause.tenantId,ctx.tenantId),eq(terasLoopPause.paused,true)))).map(row=>`${row.workerId}:${row.companyId}`));
  const fetched=(await tx.select({id:terasLoopCase.id,workerId:terasLoopCase.workerId,companyId:terasLoopCase.companyId,employmentId:terasLoopCase.employmentId,
   recipient:terasLoopCase.recipient,facts:terasLoopCase.facts,personId:employment.personId,name:person.fullName,companyName:company.legalName})
   .from(terasLoopCase).leftJoin(employment,eq(employment.id,terasLoopCase.employmentId)).leftJoin(person,eq(person.id,employment.personId))
   .leftJoin(company,eq(company.id,terasLoopCase.companyId))
   .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.state,'open'),inArray(terasLoopCase.workerId,live))))
   .filter(row=>!paused.has(`${row.workerId}:${row.companyId}`));
  // P2-1: a loop at Watch for a company observes and records there, and shows nobody a card.
  const watching=new Set((await tx.select({workerId:terasLoopLevel.workerId,companyId:terasLoopLevel.companyId}).from(terasLoopLevel)
   .where(and(eq(terasLoopLevel.tenantId,ctx.tenantId),eq(terasLoopLevel.level,0)))).map(row=>`${row.workerId}:${row.companyId}`));
  const rows=fetched.filter(row=>!watching.has(`${row.workerId}:${row.companyId}`));
  const scope=new Set(p.scopeIds),own=(row:typeof rows[number])=>row.recipient==='employee'&&!!ctx.personId&&row.personId===ctx.personId;
  const hr=(row:typeof rows[number])=>p.admin&&scope.has(row.companyId)&&!own(row);
  const cards:LoopCard[]=[];
  const take=<T extends LoopCard>(items:T[],order:(card:T)=>string)=>cards.push(...items.sort((a,b)=>order(a).localeCompare(order(b))).slice(0,LOOP_CARD_LIMIT));
  // The employee's own cards.
  take(rows.filter(row=>own(row)&&row.workerId==='loop_missed_clock_outs').flatMap(row=>{
   const date=str(row.facts,'date'),checkIn=str(row.facts,'checkIn'),out=str(row.facts,'proposedCheckOut');
   return isDate(date)&&isClock(checkIn)&&isClock(out)?[{kind:'clockOut' as const,caseId:row.id,date,checkIn,proposedCheckOut:out,href:LOOP_CARD_HREF.clockOut(date,out)}]:[];
  }),card=>card.date);
  take(rows.filter(row=>own(row)&&row.workerId==='loop_missing_employee_data').flatMap(row=>{
   const gaps=list(row.facts,'gaps'),tab=list(row.facts,'tabs').find(value=>TABS.has(value));
   return gaps.length&&tab?[{kind:'record' as const,caseId:row.id,gaps,href:LOOP_CARD_HREF.record(tab)}]:[];
  }),card=>card.caseId);
  take(rows.filter(row=>own(row)&&row.workerId==='loop_document_expiry').flatMap(row=>{
   const expiresOn=str(row.facts,'expiresOn');
   return isDate(expiresOn)?[{kind:'passport' as const,caseId:row.id,expiresOn,href:LOOP_CARD_HREF.passport()}]:[];
  }),card=>card.expiresOn);
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
 });
}
