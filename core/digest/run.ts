/** ADR-0170 step 5 — one scheduled run of a person's daily digest: a `daily_digest` work-job mandate run through
 * the shared mandate runner (both keys, the stop switch, the grantor's current authority, the outcome record).
 * Kept apart from ./daily-digest.ts so the runner and the job do not import each other. */
import {runMandate,type MandateRunOptions,type MandateRunResult} from '../mandates/run';
import type {DailyDigest} from './daily-digest';

export async function runDailyDigestMandate(options:MandateRunOptions):Promise<MandateRunResult<DailyDigest>>{
 const result=await runMandate<DailyDigest>(options);
 // The runner chose the job from the mandate's own type; refuse to label another job's result as a digest.
 if(result.status==='prepared'&&(result.summary as {kind?:unknown}).kind!=='teras.daily_digest')throw Error('Not a daily digest mandate.');
 return result;
}
