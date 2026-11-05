/** Payroll history learning, P2 — "Learned this cycle": how many people's pay has been learned, by status, per company.
 *
 * COUNTS ONLY. For each company whose payroll the viewer administers: the learning mode, when it last learned, and how many
 * people's regular-pay baseline for the month is stable (6 or more clean closed runs), provisional (3 to 5), not yet learned
 * (fewer than 3), rebasing (fewer than 3 since a salary change) or contradicted (their latest pay has moved). The baseline of
 * a month is each person's latest one with an as-of month no later than it (no look-ahead). Read under the viewer's own
 * row-level security: only a payroll administrator of the company reads baselines (migration 2012). Never a person, an id
 * or an amount.
 *
 * Two readers: the Payroll cycle page (learnedThisCycle, exact counts for a payroll administrator) and the AI read
 * payroll_learning_status (core/explainers/payroll-learning.ts), which gives the model the same counts under the
 * small-group rule (./baseline-math.ts suppressSmallCounts: no count under 5, plus complementary suppression). */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {payrollLearningRun,type BaselineStatus,type PayrollLearningMode} from '../../db/payroll-learning-schema';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {learningModesTx} from './mode';

export const LEARNING_STATUSES:readonly BaselineStatus[]=Object.freeze(['stable','provisional','none','rebasing','contradicted']);
export type StatusCounts=Readonly<Record<BaselineStatus,number>>;
export type LearnedCompany=Readonly<{companyId:string;companyName:string;mode:PayrollLearningMode;
 /** When learning last ran for the company (Malaysian day), or null. */
 learnedOn:string|null;people:StatusCounts}>;
export type LearnedThisCycle=Readonly<{period:string;companies:readonly LearnedCompany[]}>;
export class LearningViewRefused extends Error{constructor(){super('Payroll learning view refused: not_administrator');this.name='LearningViewRefused';}}

const PERIOD=/^\d{4}-(0[1-9]|1[0-2])$/;
const zero=():Record<BaselineStatus,number>=>({stable:0,provisional:0,none:0,rebasing:0,contradicted:0});

/** The month's learning per company whose payroll the viewer administers (optionally only `companyIds`). */
export async function learnedThisCycle(ctx:SessionContext,options:Readonly<{period?:unknown;companyIds?:readonly string[];today?:string}>={}):Promise<LearnedThisCycle>{
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new LearningViewRefused();
 const period=typeof options.period==='string'&&PERIOD.test(options.period)?options.period:(options.today??todayInKualaLumpur()).slice(0,7);
 return withTenant(ctx,async tx=>{
  const allowed=Array.from(await tx.execute(sql`select c.id,c.legal_name from public.company c where c.tenant_id=${ctx.tenantId}::uuid
   and app.is_admin_for(c.id) and app.can_admin_payroll_for(c.id) order by c.legal_name,c.id`) as unknown as {id:string;legal_name:string}[])
   .filter(row=>!options.companyIds||options.companyIds.includes(row.id));
  const ids=allowed.map(row=>row.id);
  if(!ids.length)return Object.freeze({period,companies:Object.freeze([])});
  const modes=await learningModesTx(tx,ctx.tenantId,ids);
  const counts=Array.from(await tx.execute(sql`select latest.company_id,latest.status,count(*)::int as n from (
    select distinct on (b.employment_id) b.company_id,b.employment_id,b.status from public.payroll_learned_baseline b
    where b.tenant_id=${ctx.tenantId}::uuid and b.basis='regular' and b.as_of_period<=${period}
     and b.company_id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)})
    order by b.employment_id,b.as_of_period desc,b.version desc) latest group by 1,2`) as unknown as {company_id:string;status:BaselineStatus;n:number}[]);
  const runs=await tx.select({companyId:payrollLearningRun.companyId,at:sql<string>`max(${payrollLearningRun.finishedAt})`}).from(payrollLearningRun)
   .where(and(eq(payrollLearningRun.tenantId,ctx.tenantId),inArray(payrollLearningRun.companyId,ids),eq(payrollLearningRun.status,'ran')))
   .groupBy(payrollLearningRun.companyId);
  const companies=allowed.map(row=>{
   const people=zero();
   for(const item of counts)if(item.company_id===row.id&&item.status in people)people[item.status]+=Number(item.n);
   const last=runs.find(run=>run.companyId===row.id)?.at??null;
   return Object.freeze({companyId:row.id,companyName:row.legal_name,mode:modes.get(row.id)?.mode??'off',learnedOn:last?todayInKualaLumpur((last as unknown) instanceof Date?last as unknown as Date:new Date(String(last))):null,
    people:Object.freeze(people)});
  });
  return Object.freeze({period,companies:Object.freeze(companies)});
 });
}
