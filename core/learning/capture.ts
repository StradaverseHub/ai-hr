/** AI v2 Phase 2, P2-6 — what every learning capture shares: the caller's own turn, the role band, the locale and the
 * one-signal-per-record insert. Light on purpose (the database client, the schemas and the role predicates only), so a
 * caller on a decision path (the approvals page) loads nothing more than it needs. ./signals.ts holds the captures.
 *
 * Every signal names the outcome record of the turn it came from, read here as the caller: their own record, of a
 * person's run, not private to the asker. A gated turn's record IS private to the asker (migrations 0905/0928), so it is
 * refused here and again by the 0972 insert policies. */
import {and,eq} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {terasOutcomeRecord} from '../../db/teras-schema';
import {terasLearningSignal} from '../../db/teras-learning-schema';
import {hasTeamAccess,isAdmin,isGroupAdmin,isPayrollPartner} from '../../lib/authz-model';
import {isLearningLocale,type LearningLocale,type LearningRole} from './types';

/** The agent identities whose runs are learned from, as their writers record them (core/harness/trace-persistence.ts
 * ASSISTANT_AGENT_IDENTITY and core/recommenders/leave-decision.ts RECOMMENDER_AGENT_IDENTITY; a test pins both). */
export const ASSISTANT_TURN_IDENTITY='teras.assistant';
export const RECOMMENDER_IDENTITY='worker.approver_recommendation';

export const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
export const person=(ctx:SessionContext):ctx is SessionContext&{userId:string}=>Boolean(ctx.userId)&&!ctx.agent;
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The role band a signal is recorded under: the eval set's roles. Group administrator first, then HR administrator, then
 * payroll, then manager; anyone else is an employee. */
export function roleBand(ctx:SessionContext):LearningRole{
 if(isGroupAdmin(ctx))return 'group_admin';
 if(isAdmin(ctx))return 'hr_admin';
 if(isPayrollPartner(ctx))return 'payroll';
 if(hasTeamAccess(ctx))return 'manager';
 return 'employee';
}
export const localeOf=(value:unknown):LearningLocale=>isLearningLocale(value)?value:'en';

export type OwnRecord=Readonly<{id:string;companyId:string;agentIdentity:string;reads:readonly {tool:string}[]}>;
/** The caller's own open record of a person's run, by run id (a turn) or id. A record private to the asker, another
 * login's record (invisible under 0928) or one without a company is null. */
export async function ownRecordTx(tx:Tx,ctx:SessionContext&{userId:string},by:Readonly<{runId:string}|{id:string}>):Promise<OwnRecord|null>{
 const r=terasOutcomeRecord;
 const [row]=await tx.select({id:r.id,companyId:r.companyId,agentIdentity:r.agentIdentity,reads:r.reads,privateToAsker:r.privateToAsker,authorityKind:r.authorityKind,askedByUserId:r.askedByUserId})
  .from(r).where(and(eq(r.tenantId,ctx.tenantId),'runId' in by?eq(r.runId,by.runId):eq(r.id,by.id))).limit(1);
 if(!row||row.privateToAsker||row.authorityKind!=='person'||row.askedByUserId!==ctx.userId||!row.companyId)return null;
 return Object.freeze({id:row.id,companyId:row.companyId,agentIdentity:row.agentIdentity,reads:row.reads});
}

/** Rows a statement without RETURNING wrote (postgres-js reports `count`). */
export const affected=(result:unknown)=>Number((result as {count?:unknown}|null)?.count??0);
/** One signal per record and key: a repeat records nothing (the first stands). */
export async function insertSignalTx(tx:Tx,row:typeof terasLearningSignal.$inferInsert):Promise<boolean>{
 const inserted=await tx.insert(terasLearningSignal).values(row).onConflictDoNothing().returning({id:terasLearningSignal.id});
 return inserted.length===1;
}

export type SignalOutcome=Readonly<{recorded:boolean}>;
export const NOT_RECORDED:SignalOutcome=Object.freeze({recorded:false});
