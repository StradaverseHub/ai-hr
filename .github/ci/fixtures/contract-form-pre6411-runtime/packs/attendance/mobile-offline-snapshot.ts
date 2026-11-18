/** The production offline clock snapshot: the ONE trusted current policy/site/attendance read that context issuance
 * records and the adjudicator measures drift against (OfflineContextIssuePorts['snapshot']). Every value comes from its
 * owner in the caller's transaction and RLS; nothing is stored or duplicated here. Target, window and permit count are
 * deployment-owned and passed in. The device requirement is not part of it (the adjudicator and plan read it live).
 * Read-only: no write, network, nested transaction or clock beyond what the owners read. UNMOUNTED: no route or
 * production wiring passes it yet. A value the issued context cannot represent (more than 32 sites, a site name over
 * 200 characters) is refused as the context service's own typed configuration_unavailable, never truncated. */
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {attendancePolicy,employment} from '../../db/schema';
import type {OfflineContextIssuePorts,OfflineContextSnapshot} from '../../core/mobile-offline-context';
import {OfflineContextIssueError} from '../../lib/mobile-offline-errors';
import {assignedClockingSitesTx} from '../../core/attendance';
import {liveClockStateTx} from '../../core/attendance-clock-read';
import {clockFingerprint,punchesForCorrectionTx} from '../../core/attendance-punch-change';
import {OfflineClockContextData,OfflineClockContextTarget} from '../../lib/mobile-offline-context';
import {OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT} from '../../lib/mobile-offline-clock';
import {readOfflineClockingPolicyTx} from './mobile-offline-adjudicator';
export type OfflineClockSnapshotDeployment={target:OfflineContextSnapshot['target'];windowMs:number;permitCount:number};
const Deployment=z.object({target:OfflineClockContextTarget,windowMs:OfflineClockContextData.shape.policy.shape.windowMs,
 permitCount:z.number().int().min(1).max(OFFLINE_CLOCK_CONTEXT_CLAIM_LIMIT)}).strict();
// The issued context's own bounds (lib/mobile-offline-context.ts), checked here so issuance refuses before recording.
const Checked=z.object({policy:OfflineClockContextData.shape.policy,sites:OfflineClockContextData.shape.sites,attendance:OfflineClockContextData.shape.attendance,
 target:OfflineClockContextTarget,permitCount:Deployment.shape.permitCount}).strict();
const unrepresentable=()=>new OfflineContextIssueError('configuration_unavailable');
/** Deterministic over the policy fields alone, in the issued context's positional order; no time, site or attendance. */
export function offlineClockPolicyRevision(p:Omit<OfflineContextSnapshot['policy'],'revision'>){
 return createHash('sha256').update(JSON.stringify(['attendance.clock.offline.policy',1,p.offlineEnabled,p.windowMs,p.geofencingRequired,p.maximumAccuracyM,p.photoRequirement]),'utf8').digest('hex');
}
/** `subject.key` is accepted as the port passes it and is not read: the device requirement is not part of the snapshot. */
export async function readOfflineClockSnapshotTx(tx:Tx,_ctx:SessionContext,subject:{employmentId:string;companyId:string;key?:unknown},deployment:OfflineClockSnapshotDeployment):Promise<OfflineContextSnapshot>{
 const d=Deployment.safeParse(deployment);if(!d.success)throw unrepresentable();
 const [emp]=await tx.select({companyId:employment.companyId,geofencingEnabled:employment.geofencingEnabled,photo:employment.attendancePhotoSetting}).from(employment).where(eq(employment.id,subject.employmentId)).limit(1);
 // resolveGeofence reads sites for the employment's own company; a different subject company is a changed binding.
 if(!emp||emp.companyId!==subject.companyId)throw new OfflineContextIssueError('binding_conflict');
 const company=await readOfflineClockingPolicyTx(tx,subject.companyId),geofencingRequired=emp.geofencingEnabled;
 // Geofencing OFF: resolveGeofence reads neither the accuracy limit nor a site, so neither is signed or compared.
 const [limit]=geofencingRequired?await tx.select({maximum:attendancePolicy.geofenceMaximumAccuracyM}).from(attendancePolicy).where(eq(attendancePolicy.companyId,subject.companyId)).limit(1):[];
 const sites=geofencingRequired?(await assignedClockingSitesTx(tx,subject.employmentId,subject.companyId)).filter(s=>s.radiusM!=null)
  .map(s=>({id:s.id,name:s.name,lat:s.lat,lng:s.lng,radiusM:s.radiusM!})).sort((x,y)=>x.id<y.id?-1:x.id>y.id?1:0):[];
 const state=await liveClockStateTx(tx,subject.employmentId),baseline=clockFingerprint(await punchesForCorrectionTx(tx,subject.employmentId,state.date));
 const fields={offlineEnabled:company.enabled,windowMs:d.data.windowMs,geofencingRequired,maximumAccuracyM:geofencingRequired?limit?.maximum??null:null,photoRequirement:emp.photo};
 const checked=Checked.safeParse({policy:{revision:offlineClockPolicyRevision(fields),...fields},sites,attendance:{baseline,...state},target:d.data.target,permitCount:d.data.permitCount});
 if(!checked.success)throw unrepresentable();
 return checked.data;
}
/** The port both callers take: context issuance (OfflineContextIssuePorts.snapshot) and createOfflineAdjudicator. One
 * function, so an unchanged world signs and compares identical values and shows no drift. */
export function offlineClockSnapshotPort(deployment:OfflineClockSnapshotDeployment):OfflineContextIssuePorts['snapshot']{
 const d=Deployment.safeParse(deployment);if(!d.success)throw unrepresentable();
 const fixed=Object.freeze({...d.data});
 return (tx,ctx,subject)=>readOfflineClockSnapshotTx(tx,ctx,subject,fixed);
}
