/** ADR-0170 step 5 — one scheduled run of a person's daily digest: a `daily_digest` work-job mandate run through
 * the shared mandate runner (both keys, the stop switch, the grantor's current authority, the outcome record).
 * Kept apart from ./daily-digest.ts so the runner and the job do not import each other.
 *
 * Owner decision, 11 Nov 2026: the nightly sweep (scripts/review-sweep.ts, 03:00 Malaysia time) runs every digest
 * mandate that is due, so a morning summary someone started on Today is prepared before they open it. */
import {sql} from 'drizzle-orm';
import {withTenant} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {agentContext} from '../agent-principal';
import type {EntitlementSnapshot} from '../entitlement-types';
import {runMandate,type MandateRunOptions,type MandateRunResult} from '../mandates/run';
import type {DailyDigest} from './daily-digest';

export async function runDailyDigestMandate(options:MandateRunOptions):Promise<MandateRunResult<DailyDigest>>{
 const result=await runMandate<DailyDigest>(options);
 // The runner chose the job from the mandate's own type; refuse to label another job's result as a digest.
 if(result.status==='prepared'&&(result.summary as {kind?:unknown}).kind!=='teras.daily_digest')throw Error('Not a daily digest mandate.');
 return result;
}

/** At most this many digests are prepared for one tenant in one sweep; the rest are reported as capped and are picked
 * up by the next sweep (each is still due until it has today's prepared record). */
export const DIGEST_RUN_BATCH=500;
export type DueDigestRun=Readonly<{due:number;prepared:number;stopped:number;failed:number;capped:boolean}>;

/** Runs, one after another, every daily digest mandate in the tenant that is in force now and has no prepared digest
 * for today's HR day yet, as the tenant's agent principal through runDailyDigestMandate (which re-checks both keys, the
 * stop switch, the mandate and the grantor's current authority, and records every run). Due mandates are chosen in one
 * statement; none is chosen while the job type is switched off or the tenant stop switch is on, so a switched-off
 * tenant does not write a stopped record per person every night. Out-of-band only (nightly sweep), never a request. */
export async function runDueDailyDigests(options:Readonly<{tenantId:string;principalId:string;entitlements:EntitlementSnapshot;now?:Date}>):Promise<DueDigestRun>{
 const now=options.now??new Date(),instant=now.toISOString();
 const dayStart=new Date(todayInKualaLumpur(now)+'T00:00:00+08:00').toISOString();
 const agent=agentContext(options.tenantId,options.principalId,options.entitlements);
 const rows=await withTenant(agent,tx=>tx.execute<{id:string}>(sql`select m.id from teras_mandate m
  where m.tenant_id=${options.tenantId}::uuid and m.job_type='daily_digest' and m.revoked_at is null
   and m.valid_from<=${instant}::timestamptz and m.valid_until>${instant}::timestamptz
   and exists(select 1 from teras_mandate_job_type_enablement e where e.tenant_id=m.tenant_id and e.job_type='daily_digest' and e.enabled)
   and not exists(select 1 from teras_mandate_control c where c.tenant_id=m.tenant_id and c.stopped)
   and not exists(select 1 from teras_outcome_record r where r.tenant_id=m.tenant_id and r.mandate_id=m.id and r.outcome_kind='prepared' and r.started_at>=${dayStart}::timestamptz)
  order by m.id limit ${DIGEST_RUN_BATCH+1}`));
 const due=[...rows].map(row=>row.id),batch=due.slice(0,DIGEST_RUN_BATCH);
 let prepared=0,stopped=0,failed=0;
 for(const mandateId of batch){
  try{
   const result=await runDailyDigestMandate({tenantId:options.tenantId,principalId:options.principalId,entitlements:options.entitlements,mandateId,now});
   if(result.status==='prepared')prepared++;else stopped++;
  }catch{failed++;}
 }
 return Object.freeze({due:batch.length,prepared,stopped,failed,capped:due.length>DIGEST_RUN_BATCH});
}
