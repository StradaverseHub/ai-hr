/** HR administrator Today (owner decision, 11 Nov 2026; AdminToday.dc.html): three set-based reads, one per panel fact.
 *
 * "All companies" is 70 or more companies and thousands of people (docs/SCALE-AND-RELEASE-RULES.md rules 1–3), so each
 * read here is a fixed number of statements whatever the number of companies or people in view: no statement runs per
 * company or per person, and every count is made in SQL.
 *
 * AUTHORIZE FIRST. Each read refuses anyone but an HR administrator with a login before it opens a transaction, then
 * takes the SHARED Access lock (never the exclusive one) before reading authority or counting, and reads under the
 * caller's row-level security, narrowed to the companies of the caller's scope (the company switcher). Payroll readiness
 * also keeps only the companies whose payroll the caller administers (app.is_admin_for, app.can_admin_payroll_for, once
 * per company row); the other two rely on row-level security alone, as their per-company owners do, so no authority
 * function runs per person or per case. Nothing here writes, decides or computes pay.
 *
 *  - readAdminPayrollReadiness: for each company in view that uses payroll, the pay period whose cut-off is next (the
 *    company's own cut-off days, resolved by the payroll owner's cutOffWindowFor through core/loops/payroll-inputs.ts)
 *    and whether the Pre-salary loop's own case for it is done (ready), open (waiting on inputs) or absent (not checked
 *    yet). Four statements: the companies with their cut-off days, the loop's switch and the stop switch, its paused
 *    companies, and the cases.
 *  - readAdminStatutoryDeadlines: CP22 and CP22A notifications overdue or due within 7 days, the same people, windows,
 *    deadlines and statuses as the per-company statutory worklist (core/reporting.ts complianceWorklist), counted for
 *    every company in view in one statement. A company whose country no localization pack owns has no statutory
 *    deadline, exactly as there.
 *  - readAdminLoopHandled: what the loops did over a window, from their own case ledger: cases opened and cases closed
 *    as done, per loop, in one statement.
 *  - readAdminExceptionCounts: open payroll exceptions and how many block a run, with the same filters as Operations ›
 *    Exceptions (core/payroll-anomaly.ts openExceptionsAcrossRuns: live, unresolved, not auto-cleared, joined to the
 *    person, employment and run), counted in one statement for the runs of the companies in view. That reader loads
 *    every open verdict to count them; Today needs only the two numbers. */
import {and,eq,gte,inArray,isNull,ne,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {company,companyPayrollConfig,employment,payrollAnomalyVerdict,payrollBatch,person} from '../db/schema';
import {terasLoopCase,terasLoopPause} from '../db/teras-schema';
import {isAdmin} from '../lib/authz-model';
import {addCalendarDays} from '../lib/hr-date-calendar';
import {packFor} from '../localization/registry';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
import {workerRunGatesTx} from './agent-registry/controls';
import {payrollKey,upcomingPeriod,type CompanyCutOffs} from './loops/payroll-inputs';
import type {LoopId} from './loops/types';

export class TodayAdminReadRefused extends Error{constructor(){super('Today administrator read refused: not an administrator.');this.name='TodayAdminReadRefused';}}
const requireAdministrator=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new TodayAdminReadRefused();};
const uniqueIds=(ids:readonly string[])=>[...new Set(ids.filter(id=>typeof id==='string'&&id.length>0))];

// ── Payroll readiness ──────────────────────────────────────────────────────────────────────────────────────────
export const PRE_SALARY_LOOP='loop_payroll_inputs' as const;
export type CompanyReadiness='ready'|'waiting'|'not_started';
export type PayrollReadinessRow=Readonly<{companyId:string;payPeriod:string;cutOff:string;state:CompanyReadiness}>;
export type PayrollReadiness=Readonly<{
 /** Companies in view that use payroll and whose payroll the caller administers. */
 companies:number;ready:number;waiting:number;notStarted:number;
 /** The earliest cut-off still ahead among them, and its pay period. */
 nextCutOff:string|null;nextPeriod:string|null;
 /** The Pre-salary loop may run (switched on, tenant not stopped). When it may not, no company has been checked. */
 checking:boolean;
 rows:readonly PayrollReadinessRow[];
}>;
const NO_READINESS:PayrollReadiness=Object.freeze({companies:0,ready:0,waiting:0,notStarted:0,nextCutOff:null,nextPeriod:null,checking:false,rows:Object.freeze([])});

/** `payrollOn`: whether the payroll module is in use for a company (the caller's entitlement check). */
export async function readAdminPayrollReadiness(ctx:SessionContext,p:Readonly<{scopeIds:readonly string[];today:string;payrollOn:(companyId:string)=>boolean}>):Promise<PayrollReadiness>{
 requireAdministrator(ctx);
 const scope=uniqueIds(p.scopeIds);
 if(!scope.length)return NO_READINESS;
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  // 1. The companies in view whose payroll the caller administers, with their own cut-off days, in one statement.
  const companies=await tx.select({companyId:company.id,cutOffDay:companyPayrollConfig.cutOffDay,overtimeCutOffDay:companyPayrollConfig.overtimeCutOffDay,
   claimCutOffDay:companyPayrollConfig.claimCutOffDay,unpaidLeaveCutOffDay:companyPayrollConfig.unpaidLeaveCutOffDay,
   attendanceCutOffDay:companyPayrollConfig.attendanceCutOffDay,payDay:companyPayrollConfig.payDay}).from(company)
   .leftJoin(companyPayrollConfig,and(eq(companyPayrollConfig.companyId,company.id),eq(companyPayrollConfig.tenantId,company.tenantId)))
   .where(and(eq(company.tenantId,ctx.tenantId),inArray(company.id,scope),isNull(company.archivedAt),
    sql`app.is_admin_for(${company.id})`,sql`app.can_admin_payroll_for(${company.id})`))
   .orderBy(company.id);
  const inUse=companies.filter(row=>p.payrollOn(row.companyId));
  if(!inUse.length)return NO_READINESS;
  // Each company's next cut-off from its own days: pure date rules over the rows already read, no statement.
  const subjects=inUse.map(row=>{const cfg:CompanyCutOffs=row;const {period,windows}=upcomingPeriod(cfg,p.today);
   return {companyId:row.companyId,payPeriod:period,cutOff:windows.salary.end,key:payrollKey(row.companyId,period)};});
  // 2–4. The loop's switch and the stop switch; its paused companies; its cases for those periods.
  const gate=(await workerRunGatesTx(tx,ctx,[PRE_SALARY_LOOP])).get(PRE_SALARY_LOOP)?.gate.run===true;
  const ids=subjects.map(subject=>subject.companyId);
  const paused=new Set((await tx.select({companyId:terasLoopPause.companyId}).from(terasLoopPause)
   .where(and(eq(terasLoopPause.tenantId,ctx.tenantId),eq(terasLoopPause.workerId,PRE_SALARY_LOOP),eq(terasLoopPause.paused,true),inArray(terasLoopPause.companyId,ids))))
   .map(row=>row.companyId));
  const cases=new Map((await tx.select({subjectKey:terasLoopCase.subjectKey,state:terasLoopCase.state,closeReason:terasLoopCase.closeReason}).from(terasLoopCase)
   .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.workerId,PRE_SALARY_LOOP),inArray(terasLoopCase.subjectKey,subjects.map(subject=>subject.key)))))
   .map(row=>[row.subjectKey,row] as const));
  const rows=subjects.map(subject=>{
   const found=cases.get(subject.key);
   // As the Payroll cycle page reads the same case (core/loops/payroll-cycle-views.ts): closed as done is ready, still
   // open is waiting on inputs; no case, a paused company or a switched-off loop has not been checked.
   const state:CompanyReadiness=!gate||paused.has(subject.companyId)||!found||found.closeReason==='out_of_scope'?'not_started'
    :found.state==='closed'&&found.closeReason==='done'?'ready':'waiting';
   return Object.freeze({companyId:subject.companyId,payPeriod:subject.payPeriod,cutOff:subject.cutOff,state});
  });
  const next=[...rows].sort((a,b)=>a.cutOff.localeCompare(b.cutOff)||a.payPeriod.localeCompare(b.payPeriod))[0]??null;
  return Object.freeze({companies:rows.length,ready:rows.filter(row=>row.state==='ready').length,waiting:rows.filter(row=>row.state==='waiting').length,
   notStarted:rows.filter(row=>row.state==='not_started').length,nextCutOff:next?.cutOff??null,nextPeriod:next?.payPeriod??null,checking:gate,rows:Object.freeze(rows)});
 });
}

// ── Statutory deadlines (CP22 / CP22A) ─────────────────────────────────────────────────────────────────────────
export type StatutoryCompany=Readonly<{companyId:string;overdue:number;dueSoon:number;earliestDue:string|null}>;
export type StatutoryDeadlines=Readonly<{overdue:number;dueSoon:number;earliestDue:string|null;companies:readonly StatutoryCompany[]}>;
const NO_DEADLINES:StatutoryDeadlines=Object.freeze({overdue:0,dueSoon:0,earliestDue:null,companies:Object.freeze([])});
/** complianceWorklist's windows: hires in the last 60 days; cessations from 60 days back to 90 days ahead. CP22 is due
 * 30 days after the start; CP22A at least 30 days before the cessation (a death has no computable deadline). Due soon:
 * within the 7 days before the deadline. */
const HIRE_BACK=60,CEASE_BACK=60,CEASE_AHEAD=90,CP22_DAYS=30,CP22A_DAYS=30,SOON=7;

export async function readAdminStatutoryDeadlines(ctx:SessionContext,p:Readonly<{scopeIds:readonly string[];today:string}>):Promise<StatutoryDeadlines>{
 requireAdministrator(ctx);
 const scope=uniqueIds(p.scopeIds);
 if(!scope.length)return NO_DEADLINES;
 const today=p.today,hireFloor=addCalendarDays(today,-HIRE_BACK),ceaseFloor=addCalendarDays(today,-CEASE_BACK),ceaseCeil=addCalendarDays(today,CEASE_AHEAD);
 const hired=sql`(${employment.hiredOn} >= ${hireFloor}::date and ${employment.hiredOn} <= ${today}::date)`;
 const ceasing=sql`(${employment.terminatedOn} is not null and ${employment.terminatedOn} >= ${ceaseFloor}::date and ${employment.terminatedOn} <= ${ceaseCeil}::date
  and ${employment.terminationType} is distinct from 'death')`;
 // Whole-day constants are written into the statement, so date arithmetic is date ± integer (a parameter would be untyped).
 const cp22Due=sql`(${employment.hiredOn} + ${sql.raw(String(CP22_DAYS))})`,cp22aDue=sql`(${employment.terminatedOn} - ${sql.raw(String(CP22A_DAYS))})`;
 const overdue=(due:typeof cp22Due)=>sql`(${today}::date > ${due})`;
 const soon=(due:typeof cp22Due)=>sql`(${today}::date <= ${due} and ${today}::date >= ${due} - ${sql.raw(String(SOON))})`;
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const rows=await tx.select({companyId:employment.companyId,country:company.country,
   cp22Overdue:sql<number>`(count(*) filter (where ${hired} and ${overdue(cp22Due)}))::int`,
   cp22Soon:sql<number>`(count(*) filter (where ${hired} and ${soon(cp22Due)}))::int`,
   cp22aOverdue:sql<number>`(count(*) filter (where ${ceasing} and ${overdue(cp22aDue)}))::int`,
   cp22aSoon:sql<number>`(count(*) filter (where ${ceasing} and ${soon(cp22aDue)}))::int`,
   cp22First:sql<string|null>`(min(${cp22Due}) filter (where ${hired} and (${overdue(cp22Due)} or ${soon(cp22Due)})))::text`,
   cp22aFirst:sql<string|null>`(min(${cp22aDue}) filter (where ${ceasing} and (${overdue(cp22aDue)} or ${soon(cp22aDue)})))::text`,
  }).from(employment)
   .innerJoin(person,eq(person.id,employment.personId))
   .innerJoin(company,eq(company.id,employment.companyId))
   // Row-level security narrows the people to those the caller may see, exactly as for the worklist; no per-row
   // authority function runs here.
   .where(and(eq(employment.tenantId,ctx.tenantId),inArray(employment.companyId,scope),or(hired,ceasing)))
   .groupBy(employment.companyId,company.country)
   .orderBy(employment.companyId);
  const companies=rows.filter(row=>packFor(row.country)).map(row=>{
   const first=[row.cp22First,row.cp22aFirst].filter((day):day is string=>!!day).sort()[0]??null;
   return Object.freeze({companyId:row.companyId,overdue:Number(row.cp22Overdue)+Number(row.cp22aOverdue),dueSoon:Number(row.cp22Soon)+Number(row.cp22aSoon),earliestDue:first});
  }).filter(row=>row.overdue+row.dueSoon>0);
  return Object.freeze({overdue:companies.reduce((sum,row)=>sum+row.overdue,0),dueSoon:companies.reduce((sum,row)=>sum+row.dueSoon,0),
   earliestDue:companies.map(row=>row.earliestDue).filter((day):day is string=>!!day).sort()[0]??null,companies:Object.freeze(companies)});
 });
}

// ── What the loops did ─────────────────────────────────────────────────────────────────────────────────────────
export type LoopHandled=Readonly<{workerId:LoopId;opened:number;done:number}>;
/** Per loop, the cases it opened since `since` and the cases closed as done since then (the condition it found was
 * resolved), for the companies in view the caller administers. Loops with neither are left out. */
export async function readAdminLoopHandled(ctx:SessionContext,p:Readonly<{scopeIds:readonly string[];since:Date}>):Promise<readonly LoopHandled[]>{
 requireAdministrator(ctx);
 const scope=uniqueIds(p.scopeIds);
 if(!scope.length)return Object.freeze([]);
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const c=terasLoopCase,since=p.since.toISOString();
  const rows=await tx.select({workerId:c.workerId,
   opened:sql<number>`(count(*) filter (where ${c.firstOpenedAt} >= ${since}::timestamptz))::int`,
   done:sql<number>`(count(*) filter (where ${c.closedAt} >= ${since}::timestamptz and ${c.closeReason}='done'))::int`,
  }).from(c)
   .where(and(eq(c.tenantId,ctx.tenantId),inArray(c.companyId,scope),or(gte(c.firstOpenedAt,p.since),gte(c.closedAt,p.since))))
   .groupBy(c.workerId).orderBy(c.workerId);
  return Object.freeze(rows.map(row=>Object.freeze({workerId:row.workerId,opened:Number(row.opened),done:Number(row.done)})).filter(row=>row.opened+row.done>0));
 });
}

// ── Payroll exceptions ─────────────────────────────────────────────────────────────────────────────────────────
export type ExceptionCounts=Readonly<{total:number;blocking:number}>;
/** Open exceptions on the runs of the companies in view, and how many of them block a run. */
export async function readAdminExceptionCounts(ctx:SessionContext,p:Readonly<{scopeIds:readonly string[]}>):Promise<ExceptionCounts>{
 requireAdministrator(ctx);
 const scope=uniqueIds(p.scopeIds);
 if(!scope.length)return Object.freeze({total:0,blocking:0});
 return withTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const v=payrollAnomalyVerdict;
  const [row]=await tx.select({total:sql<number>`(count(*))::int`,blocking:sql<number>`(count(*) filter (where ${v.disposition}='block'))::int`}).from(v)
   .innerJoin(employment,eq(employment.id,v.employmentId))
   .innerJoin(person,eq(person.id,employment.personId))
   .innerJoin(payrollBatch,eq(payrollBatch.id,v.batchId))
   .where(and(eq(v.tenantId,ctx.tenantId),inArray(payrollBatch.companyId,scope),isNull(v.supersededAt),isNull(v.resolvedAt),ne(v.disposition,'auto_clear')));
  return Object.freeze({total:Number(row?.total??0),blocking:Number(row?.blocking??0)});
 });
}
