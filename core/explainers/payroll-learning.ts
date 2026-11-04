/** Payroll history learning (P2) — payroll_learning_status, "Learned this cycle" as a payroll administrator may ask about it
 * (core/semantic-model/entities-payroll-learning.ts), over the page's own read owner, run as the caller
 * (core/payroll-learning/status.ts learnedThisCycle: only the companies whose payroll the caller administers).
 *
 * Copies only the declared fields: the company name, the mode, the day it last learned and the five counts, each under the
 * small-group rule (core/payroll-learning/baseline-math.ts suppressSmallCounts) BEFORE the model sees them. Never an amount,
 * a range, a person, an id or the sponsor. The owner refuses anyone but an administrator; that refusal leaves as
 * not_permitted. Nothing here writes. */
import type {SessionContext} from '../../db/client';
import {canManagePayroll} from '../../lib/authz-model';
import {suppressSmallCounts} from '../payroll-learning/baseline-math';
import {LearningViewRefused,learnedThisCycle} from '../payroll-learning/status';
import {provenance,refuse,type ExplainerOutcome} from './outcome';

const PERIOD=/^\d{4}-(0[1-9]|1[0-2])$/;

export async function payrollLearningStatus(ctx:SessionContext,input:Readonly<Record<string,unknown>>):Promise<ExplainerOutcome>{
 if(!canManagePayroll(ctx))return refuse('not_permitted','What AI Centre has learned from payroll history is available to payroll administrators only.');
 try{
  const view=await learnedThisCycle(ctx,{period:typeof input.period==='string'&&PERIOD.test(input.period)?input.period:undefined});
  return{ok:true,period:view.period,
   companies:view.companies.map(c=>({company:c.companyName,mode:c.mode,learnedOn:c.learnedOn,
    people:suppressSmallCounts({stable:c.people.stable,provisional:c.people.provisional,notYet:c.people.none,rebasing:c.people.rebasing,contradicted:c.people.contradicted})})),
   provenance:provenance('core/payroll-learning/status.ts#learnedThisCycle','Not applicable: counts of learned pay ranges, not a versioned rule.','/control-tower/loops/payroll-cycle',
    'Counts only, read under the administrator\'s own access, and none under 5: never a person, an amount or a range. A usual range only explains a flag; pay is calculated only by the payroll service and a person approves and closes payroll.')};
 }catch(error){
  if(error instanceof LearningViewRefused)return refuse('not_permitted','What AI Centre has learned from payroll history is available to payroll administrators only.');
  throw error;
 }
}
