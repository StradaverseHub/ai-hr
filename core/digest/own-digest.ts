/** Owner decision, 11 Nov 2026 — the product path that delegates a job: an HR administrator's own morning summary,
 * started and stopped on Admin Today (components/today/admin/panels.tsx MorningSummaryPanel).
 *
 * What may be delegated here is a closed list, narrower than the delegable work jobs (core/mandates/job-types.ts):
 *  - `daily_digest` ("every morning, tell me what waits for me") is OFFERED. It summarises the grantor's own approvals
 *    queue, setup gaps and statutory deadlines as counts and links; it completes nothing and is about nobody else.
 *  - `team_absence_weekly_summary` is a valid work job but NOT OFFERED: no screen shows its prepared result yet, so a
 *    grant would run a job nobody could read. It is refused here as `not_offered`.
 *  - Decision jobs (approve leave or claims) and everything never delegable (pay, payroll close or reprocess,
 *    employment status, access, anything irreversible, deciding one's own requests) stay refused by the core
 *    (job-types.ts delegableJobType), before this list is consulted. Humans still decide pay, employment and access.
 *
 * Granting: an HR administrator (hr_admin or super_admin, of any company) for themself only. The grant is the core
 * grantMandate, which checks the two keys (a group administrator allowed the job type in AI Centre settings; the tenant
 * stop switch is off), confirms the administrator role in the database, inserts the mandate and appends its audit event
 * in one transaction. The mandate runs for the tenant's validity ceiling, once a day, over the grantor's own items.
 * The digest covers only what the administrator can already see (the companies the database says they administer).
 * Stopping: the grantor revokes their own mandate at once, whatever their role is now (core revokeMandate, audited).
 *
 * Reading: one bounded statement for the Today panel (readMorningSummary). */
import {and,desc,eq,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {terasMandate} from '../../db/teras-schema';
import {isAdmin} from '../../lib/authz-model';
import {MandateRefused,delegableJobType,type WorkJobType} from '../mandates/job-types';
import {grantMandate,revokeMandate,type GrantMandateInput} from '../mandates/mandates';
import {digestFromOutcome,type DailyDigest} from './daily-digest';

/** The job types a person can delegate through the product today. */
export const OFFERED_JOB_TYPES=Object.freeze(['daily_digest'] as const satisfies readonly WorkJobType[]);
export type OfferedJobType=typeof OFFERED_JOB_TYPES[number];

/** A valid work job that the product does not offer yet (see the module note). */
export class JobNotOffered extends Error{
 readonly reason='not_offered' as const;
 constructor(){super('Delegation refused: not_offered');this.name='JobNotOffered';}
}

/** Decision and never-delegable jobs are refused by the core first (MandateRefused 'decision_job' or 'never_delegable');
 * a delegable job outside OFFERED_JOB_TYPES is refused as not offered. */
export function offeredJobType(value:unknown):OfferedJobType{
 const type=delegableJobType(value);
 if(!(OFFERED_JOB_TYPES as readonly string[]).includes(type))throw new JobNotOffered();
 return type as OfferedJobType;
}

/** Each offered job's fixed shape: whose items, how often, how many people. Nothing here is caller-supplied. */
const SHAPES:Readonly<Record<OfferedJobType,Omit<GrantMandateInput,'jobType'|'validDays'>>>=Object.freeze({
 daily_digest:Object.freeze({scope:{team:'self'},limits:{maxRunsPerDay:1,maxPeople:1},schedule:{daily:true},notify:'daily_summary'}),
});

/** An HR administrator delegates an offered job for themself. */
export async function delegateOwnJob(ctx:SessionContext,input:Readonly<{jobType:unknown}>,now:Date=new Date()){
 if(!ctx.userId||!ctx.personId||ctx.agent||!isAdmin(ctx))throw new MandateRefused('not_administrator');
 const jobType=offeredJobType(input.jobType);
 // validDays is replaced by the tenant's ceiling inside the grant's transaction.
 return grantMandate(ctx,{jobType,...SHAPES[jobType],validDays:1},now,{requireAdministrator:true,validForCeiling:true});
}

/** The grantor stops their own offered job at once. Refused as not found when they have none in force. */
export async function stopOwnJob(ctx:SessionContext,input:Readonly<{jobType:unknown}>){
 if(!ctx.userId||ctx.agent)throw new MandateRefused('invalid');
 const jobType=offeredJobType(input.jobType);
 const [own]=await withTenant(ctx,tx=>tx.select({id:terasMandate.id}).from(terasMandate)
  .where(and(eq(terasMandate.tenantId,ctx.tenantId),eq(terasMandate.grantorUserId,ctx.userId!),eq(terasMandate.jobType,jobType),isNull(terasMandate.revokedAt)))
  .orderBy(desc(terasMandate.createdAt),desc(terasMandate.id)).limit(1));
 if(!own)throw new MandateRefused('not_found');
 return revokeMandate(ctx,own.id);
}

export type MorningSummary=Readonly<{
 /** A group administrator allowed the job type and the tenant stop switch is off: a new grant could succeed. */
 offered:boolean;
 /** The tenant stop switch is on. */
 stopped:boolean;
 /** The viewer's own mandate in force now, if any. */
 mandate:Readonly<{id:string;validUntil:Date}>|null;
 /** That mandate's latest prepared digest, if any (the panel shows it only when it is today's). */
 prepared:Readonly<{recordId:string;preparedAt:Date;digest:DailyDigest}>|null;
}>;
/** Instants come back as UTC ISO text (to_char), so they parse the same whatever the driver's date handling. */
type Row={enabled:boolean|null;stopped:boolean|null;mandate_id:string|null;valid_until:string|null;record_id:string|null;started_at:string|null;outcome:unknown};
const at=(value:string)=>new Date(value);

/** The viewer's morning summary for Today, in ONE statement: the job type's key 1, the stop switch, the viewer's own
 * mandate in force (at most one, migration 0906) and its latest prepared record. Every lookup is by the viewer's own
 * login on an existing index (teras_mandate_grantor_idx, teras_outcome_record_grantor_idx), so its cost does not grow
 * with the number of companies or people; row security still applies. */
export async function readMorningSummary(ctx:SessionContext,now:Date=new Date()):Promise<MorningSummary>{
 if(!ctx.userId||ctx.agent)return Object.freeze({offered:false,stopped:false,mandate:null,prepared:null});
 const instant=now.toISOString();
 const [row]=await withTenant(ctx,tx=>tx.execute<Row>(sql`select
  (select e.enabled from teras_mandate_job_type_enablement e where e.tenant_id=${ctx.tenantId}::uuid and e.job_type='daily_digest') as enabled,
  (select c.stopped from teras_mandate_control c where c.tenant_id=${ctx.tenantId}::uuid) as stopped,
  m.id as mandate_id,to_char(m.valid_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as valid_until,
  r.id as record_id,to_char(r.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at,r.outcome
 from (select 1) as one
 left join lateral (select x.id,x.valid_until from teras_mandate x where x.tenant_id=${ctx.tenantId}::uuid and x.grantor_user_id=${ctx.userId}::uuid
  and x.job_type='daily_digest' and x.revoked_at is null and x.valid_from<=${instant}::timestamptz and x.valid_until>${instant}::timestamptz
  order by x.created_at desc,x.id desc limit 1) as m on true
 left join lateral (select y.id,y.started_at,y.outcome from teras_outcome_record y where y.tenant_id=${ctx.tenantId}::uuid and y.grantor_user_id=${ctx.userId}::uuid
  and y.mandate_id=m.id and y.outcome_kind='prepared' order by y.started_at desc,y.id desc limit 1) as r on true`));
 const stopped=row?.stopped===true;
 const outcome=typeof row?.outcome==='string'?JSON.parse(row.outcome) as Record<string,unknown>:row?.outcome as Record<string,unknown>|null|undefined;
 return Object.freeze({offered:row?.enabled===true&&!stopped,stopped,
  mandate:row?.mandate_id&&row.valid_until?Object.freeze({id:row.mandate_id,validUntil:at(row.valid_until)}):null,
  prepared:row?.record_id&&row.started_at&&outcome?Object.freeze({recordId:row.record_id,preparedAt:at(row.started_at),digest:digestFromOutcome(outcome)}):null});
}
