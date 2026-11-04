/** AI v2 Phase 2 hardening (coordinator review, 4 November 2026) — a new joiner's one-tap answer to "Did you work for
 * another employer earlier this year?" on their own "Before payroll" checklist (migration 2011,
 * payroll_tp3_previous_employer_answer).
 *
 * Why: the checklist asked every joiner after 1 January to tell payroll about an earlier employer (LHDN TP3), so a fresh
 * graduate got a TP3 item they could never clear: a false positive. No record says whether a joiner had an earlier
 * employer this year, so the person is asked once:
 *  - "No" records the answer and the TP3 item leaves their checklist for that assessment year;
 *  - "Yes" records the answer and keeps the TP3 item, with its link to the TP3 form (/me/tp3).
 * The answer is a fact about the person, never pay data: no amount, and payroll reads none of it. The TP3 form
 * (core/tp3.ts, employee_tp3) stays the only source of previous-employer income; a "No" files nothing there.
 * Append-only: answering again records a new answer, and the latest one counts. Only the person answers, about their own
 * current-year employment (the TP3 owner's own eligibility), as themselves; row-level security checks the same. Each
 * answer is a `payroll-tp3.previous-employer-answered` domain event. No model is called. */
import {and,desc,eq} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {payrollTp3PreviousEmployerAnswer} from '../../db/teras-payroll-cycle-schema';
import {myTp3Eligibility,myTp3Employments} from '../../packs/payroll/service';
import {todayInKualaLumpur} from '../../lib/hr-date';

export const TP3_ANSWER_EVENT='payroll-tp3.previous-employer-answered';
export type Tp3PreviousEmployerAnswer='yes'|'no';
export class Tp3AnswerRefused extends Error{constructor(readonly reason:'not_self'|'invalid'|'not_eligible'){super('TP3 answer refused: '+reason);this.name='Tp3AnswerRefused';}}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person's latest answer for one assessment year, as this transaction may read it, or null. */
export async function latestTp3AnswerTx(tx:Tx,tenantId:string,personId:string,assessmentYear:number):Promise<Tp3PreviousEmployerAnswer|null>{
 const [row]=await tx.select({had:payrollTp3PreviousEmployerAnswer.hadPreviousEmployer}).from(payrollTp3PreviousEmployerAnswer)
  .where(and(eq(payrollTp3PreviousEmployerAnswer.tenantId,tenantId),eq(payrollTp3PreviousEmployerAnswer.personId,personId),
   eq(payrollTp3PreviousEmployerAnswer.assessmentYear,assessmentYear)))
  .orderBy(desc(payrollTp3PreviousEmployerAnswer.answeredAt),desc(payrollTp3PreviousEmployerAnswer.id)).limit(1);
 return row?(row.had?'yes':'no'):null;
}

/** The caller's own latest answer for one assessment year (the checklist's read, as the person). */
export async function myTp3PreviousEmployerAnswer(ctx:SessionContext,assessmentYear:number):Promise<Tp3PreviousEmployerAnswer|null>{
 if(!ctx.userId||ctx.agent||!ctx.personId)return null;
 const personId=ctx.personId;
 return withTenant(ctx,tx=>latestTp3AnswerTx(tx,ctx.tenantId,personId,assessmentYear));
}

/** The person answers for their own current-year employment. Refused unless the TP3 owner finds them eligible to file a
 * TP3 for that year (a current-year joiner) and the year is that one. */
export async function answerTp3PreviousEmployer(supplied:SessionContext,input:Readonly<{employmentId:unknown;assessmentYear:unknown;answer:unknown}>,
 options:Readonly<{today?:string}>={}):Promise<Readonly<{answer:Tp3PreviousEmployerAnswer;assessmentYear:number}>>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!ctx.personId)throw new Tp3AnswerRefused('not_self');
 const {employmentId,assessmentYear,answer}=input;
 const year=typeof assessmentYear==='number'?assessmentYear:typeof assessmentYear==='string'&&/^\d{4}$/.test(assessmentYear)?Number(assessmentYear):NaN;
 if(typeof employmentId!=='string'||!UUID.test(employmentId)||!Number.isInteger(year)||(answer!=='yes'&&answer!=='no'))throw new Tp3AnswerRefused('invalid');
 const today=options.today??todayInKualaLumpur();
 const own=(await myTp3Employments(ctx)).find(row=>row.employmentId===employmentId);
 const eligibility=myTp3Eligibility(own,today);
 if(!eligibility.eligible||eligibility.year!==year||year!==Number(today.slice(0,4)))throw new Tp3AnswerRefused('not_eligible');
 const personId=ctx.personId,userId=ctx.userId;
 await withTenant(ctx,async tx=>{
  await tx.insert(payrollTp3PreviousEmployerAnswer).values({tenantId:ctx.tenantId,personId,employmentId,assessmentYear:year,
   hadPreviousEmployer:answer==='yes',answeredByUserId:userId});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'person',aggregateId:personId,eventType:TP3_ANSWER_EVENT,actor:actorOf(ctx),
   subjectEmploymentId:employmentId,payload:{employmentId,assessmentYear:year,answer}});
 });
 return Object.freeze({answer,assessmentYear:year});
}
