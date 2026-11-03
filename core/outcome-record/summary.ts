/** Today (AI v2 Phase 1, W3): what the AI did for or on behalf of the caller, counted from outcome records.
 *
 * A read over the outcome record owner's own table (./record.ts), as the caller under its row-level security
 * (migration 0928): a person sees the records they asked for or granted, and a group administrator also sees
 * every other person's record except a turn that is private to its asker. So a routed or refused turn (a
 * sensitive topic, a workplace-harms request) is never counted for anyone but the person who asked, and this
 * read leaves even those out: it counts kinds only. A record holds no words at all (./types.ts), and this read
 * returns numbers only: no id, no person, no question, no reply.
 *
 * Company isolation: a record about someone else counts only when it names a company in the caller's current
 * scope (the company scope switcher), so narrowing the scope narrows the figures. The caller's own records
 * always count; they are about the caller. Nothing is written. */
import {and,count,eq,gte,inArray,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {terasOutcomeRecord} from '../../db/teras-schema';

/** The agent identities whose runs are counted, as the writers record them. */
export const ASSISTANT_TURN_IDENTITY='teras.assistant';
export const LEAVE_RECOMMENDER_IDENTITY='worker.approver_recommendation';

export type OutcomeSummary=Readonly<{
 /** Questions the AI Centre answered for the caller (answered or suggested turns). */
 answeredForYou:number;
 /** Questions it answered for other people the caller may see records of (group administrators only, by RLS). */
 answeredForOthers:number;
 /** Leave requests the recommender checked at the caller's request. */
 leaveChecks:number;
 /** Items a job the caller delegated prepared for them. */
 preparedForYou:number;
}>;

const ANSWERED=['answered','suggested'] as const;
const PREPARED=['prepared','done'] as const;

/** Counts since `since` (inclusive). `companyIds` is the caller's current company scope; an empty scope admits
 * only the caller's own records. */
export async function summariseOutcomeRecords(ctx:SessionContext,p:Readonly<{since:Date;companyIds:readonly string[]}>):Promise<OutcomeSummary>{
 const empty=Object.freeze({answeredForYou:0,answeredForOthers:0,leaveChecks:0,preparedForYou:0});
 const userId=ctx.userId;
 if(!userId||ctx.agent)return empty;
 const r=terasOutcomeRecord;
 const own=or(eq(r.askedByUserId,userId),eq(r.grantorUserId,userId))!;
 const visible=p.companyIds.length?or(own,inArray(r.companyId,[...p.companyIds]))!:own;
 const rows=await withTenant(ctx,tx=>tx.select({
  agentIdentity:r.agentIdentity,authorityKind:r.authorityKind,outcomeKind:r.outcomeKind,
  mine:sql<boolean>`(${r.askedByUserId} IS NOT DISTINCT FROM ${userId}::uuid OR ${r.grantorUserId} IS NOT DISTINCT FROM ${userId}::uuid)`,
  n:count(),
 }).from(r).where(and(eq(r.tenantId,ctx.tenantId),gte(r.startedAt,p.since),eq(r.privateToAsker,false),visible))
  .groupBy(r.agentIdentity,r.authorityKind,r.outcomeKind,sql`4`));
 let answeredForYou=0,answeredForOthers=0,leaveChecks=0,preparedForYou=0;
 for(const row of rows){
  const n=Number(row.n),mine=row.mine===true;
  if(!Number.isFinite(n)||n<=0)continue;
  if(row.authorityKind==='person'&&row.agentIdentity===ASSISTANT_TURN_IDENTITY&&(ANSWERED as readonly string[]).includes(row.outcomeKind)){
   if(mine)answeredForYou+=n;else answeredForOthers+=n;
  }
  else if(row.authorityKind==='person'&&row.agentIdentity===LEAVE_RECOMMENDER_IDENTITY&&mine)leaveChecks+=n;
  else if(row.authorityKind==='mandate'&&mine&&(PREPARED as readonly string[]).includes(row.outcomeKind))preparedForYou+=n;
 }
 return Object.freeze({answeredForYou,answeredForOthers,leaveChecks,preparedForYou});
}
