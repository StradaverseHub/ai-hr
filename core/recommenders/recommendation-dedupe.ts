/** One recorded recommendation per approver, leave request, approval step and HR day while it says the same.
 *
 * The recommender runs when an approver opens `?recommend=<id>` in the Inbox, a GET render. Before this, every
 * reload or back/forward navigation wrote another outcome record, inflating the worker's run and agreement
 * counts (PR 198 review, low finding "recommender writes on every view"). The recommendation is still
 * computed fresh each time, so the approver always sees today's facts; only the RECORD is reused, and only when
 * all of these hold for the approver's latest record on this request:
 *  - it was started on the same HR day (lib/hr-date.ts, the repository's HR date owner);
 *  - no approval step of the request has been decided since it was started (so it is the same step);
 *  - it has the same recommender version, verdict, check results, failed rules and rule versions.
 * Anything different writes a new record, exactly as before. Reads only the caller's own records (RLS:
 * asked_by_user_id is the caller) inside the recommender's own record transaction. */
import {and,desc,eq,gte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {leaveApprovalStep} from '../../db/schema';
import {terasOutcomeRecord} from '../../db/teras-schema';
import {HR_LOCAL_TZ} from '../../lib/hr-date';

export type RecommendationFingerprint=Readonly<{
 agentIdentity:string;instructionSet:string;leaveRequestId:string;today:string;verdict:string;
 checks:readonly string[];failedRules:readonly string[];ruleVersions:readonly (string|null)[];
}>;

const sameList=(stored:unknown,expected:readonly unknown[])=>Array.isArray(stored)&&stored.length===expected.length&&stored.every((value,index)=>value===expected[index]);

/** The id of today's matching record for this request and step, or null when a new record is due. */
export async function sameRecommendationTodayTx(tx:Tx,ctx:SessionContext,p:RecommendationFingerprint):Promise<string|null>{
 if(!ctx.userId)return null;
 const [latest]=await tx.select({id:terasOutcomeRecord.id,startedAt:terasOutcomeRecord.startedAt,outcome:terasOutcomeRecord.outcome,
  checks:terasOutcomeRecord.checks,replay:terasOutcomeRecord.replay}).from(terasOutcomeRecord)
  .where(and(eq(terasOutcomeRecord.tenantId,ctx.tenantId),eq(terasOutcomeRecord.askedByUserId,ctx.userId),eq(terasOutcomeRecord.agentIdentity,p.agentIdentity),
   eq(terasOutcomeRecord.outcomeKind,'suggested'),sql`${terasOutcomeRecord.outcome}->>'leaveRequestId' = ${p.leaveRequestId}`,
   sql`(${terasOutcomeRecord.startedAt} AT TIME ZONE ${HR_LOCAL_TZ})::date = ${p.today}::date`))
  .orderBy(desc(terasOutcomeRecord.startedAt),desc(terasOutcomeRecord.id)).limit(1);
 if(!latest)return null;
 const outcome=latest.outcome as Record<string,unknown>;
 if(outcome.verdict!==p.verdict||latest.replay?.instructionSet!==p.instructionSet)return null;
 if(!sameList(outcome.checks,p.checks)||!sameList(outcome.failedRules,p.failedRules))return null;
 if(!sameList((latest.checks??[]).map(check=>check.ruleVersion),p.ruleVersions))return null;
 // A step decided since then means the request is at another step (or another approver's turn).
 const [decided]=await tx.select({id:leaveApprovalStep.id}).from(leaveApprovalStep)
  .where(and(eq(leaveApprovalStep.leaveRequestId,p.leaveRequestId),gte(leaveApprovalStep.decidedAt,latest.startedAt))).limit(1);
 return decided?null:latest.id;
}
