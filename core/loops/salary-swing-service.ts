/** AI v2 P2-2a — payroll HR's disposition of a net-swing flag (migration 0964): "expected" or "a real problem".
 *
 * A flag is a Salary payroll loop case of kind swing (one person, one month, net pay moved by more than the company's
 * threshold). The disposition is recorded once, by a payroll administrator who administers that employment, attributed
 * to them and audited as a domain event; the database refuses anyone else and any case that is not such a flag. It
 * copies the flag's month, pattern, swing and threshold so the threshold proposals (core/loops/swing-proposals.ts) read
 * one table. A disposition changes no pay, no run and no setting: the loop closes the flag on its next run, and an
 * administrator decides any proposal the dispositions support. */
import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasLoopCase} from '../../db/teras-schema';
import {terasPayrollSwingDisposition,type SwingDisposition} from '../../db/teras-payroll-cycle-schema';
import {isAdmin} from '../../lib/authz-model';
import {isSwingPattern} from './net-swing';
import {PayrollLoopRefused} from './payroll-loop-settings';

const Input=z.object({caseId:z.guid(),disposition:z.enum(['expected','problem'])}).strict();
const PERIOD=/^\d{4}-(0[1-9]|1[0-2])$/;

export async function recordSwingDisposition(supplied:SessionContext,input:unknown){
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new PayrollLoopRefused('not_administrator');
 const parsed=Input.safeParse(input);
 if(!parsed.success)throw new PayrollLoopRefused('invalid');
 const {caseId,disposition}=parsed.data as {caseId:string;disposition:SwingDisposition};
 return withTenant(ctx,async tx=>{
  // The flag as the viewer may read it (row-level security), and only a Salary payroll loop swing case.
  const [flag]=await tx.select({id:terasLoopCase.id,companyId:terasLoopCase.companyId,employmentId:terasLoopCase.employmentId,subjectKey:terasLoopCase.subjectKey,
   facts:terasLoopCase.facts}).from(terasLoopCase)
   .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.id,caseId),eq(terasLoopCase.workerId,'loop_salary_payroll'))).limit(1);
  if(!flag||!flag.employmentId||!flag.subjectKey.startsWith('swing:'))throw new PayrollLoopRefused('not_found');
  const facts=flag.facts,payPeriod=facts.payPeriod,pattern=facts.pattern,swingBp=facts.swingBp,thresholdBp=facts.thresholdBp;
  if(typeof payPeriod!=='string'||!PERIOD.test(payPeriod)||!isSwingPattern(pattern)||typeof swingBp!=='number'||typeof thresholdBp!=='number')
   throw new PayrollLoopRefused('invalid');
  const [existing]=await tx.select({id:terasPayrollSwingDisposition.id}).from(terasPayrollSwingDisposition)
   .where(and(eq(terasPayrollSwingDisposition.tenantId,ctx.tenantId),eq(terasPayrollSwingDisposition.caseId,flag.id))).limit(1);
  if(existing)throw new PayrollLoopRefused('already');
  const [row]=await tx.insert(terasPayrollSwingDisposition).values({tenantId:ctx.tenantId,caseId:flag.id,companyId:flag.companyId,employmentId:flag.employmentId,
   payPeriod,pattern,swingBp,thresholdBp,disposition,decidedByUserId:ctx.userId!}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-payroll-loop',aggregateId:flag.companyId,eventType:'teras-payroll-loop.swing-disposed',
   actor:actorOf(ctx),subjectEmploymentId:flag.employmentId,payload:{caseId:flag.id,payPeriod,pattern,swingBp,thresholdBp,disposition}});
  return Object.freeze(row);
 });
}
