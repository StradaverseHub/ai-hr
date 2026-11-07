/** Notification projection observations, not scheduler commissioning or an email receipt.
 * There is intentionally no API accepting a caller's claimed source/build/accepted flag. The existing
 * notification worker has no protected accepted-artifact verifier yet, so release readiness stays closed. */
export const NOTIFICATION_PROJECTION_JOB_KEY = 'notifications.project' as const;
export const NOTIFICATION_PROJECTION_CAPABILITY_VERSION = 1;

export type NotificationProjectionCounters = Record<string, number> & {
  capabilityVersion: number; identityVerified: 0; scopeLoaded: number;
  projectionTenants: number; projectionCompletedTenants: number; projectionFailedTenants: number;
  projectionBlockedTenants: number; committedBatches: number; processedEvents: number; createdNotifications: number;
  cappedTenants: number; backlogObservedTenants: number; pendingEvents: number; oldestPendingSeconds: number;
  emailAttempted: number; emailSkipped: number; emailUnavailableTenants: number; emailCappedTenants: number;
};
export function notificationProjectionCounters(): NotificationProjectionCounters {
  return {capabilityVersion:NOTIFICATION_PROJECTION_CAPABILITY_VERSION,identityVerified:0,scopeLoaded:0,
    projectionTenants:0,projectionCompletedTenants:0,projectionFailedTenants:0,projectionBlockedTenants:0,
    committedBatches:0,processedEvents:0,createdNotifications:0,cappedTenants:0,backlogObservedTenants:0,
    pendingEvents:0,oldestPendingSeconds:0,emailAttempted:0,emailSkipped:0,emailUnavailableTenants:0,emailCappedTenants:0};
}

/** Call only after the dispatch promise resolves, which means its transaction committed. A later
 * failed batch does not erase the preceding commits; an uncertain batch is never counted or retried. */
export function recordCommittedProjectionBatch(counters: NotificationProjectionCounters, batch: {processed:number;created:number}) {
  for (const value of [batch.processed,batch.created]) if (!Number.isSafeInteger(value)||value<0) throw new Error('Invalid projection batch result.');
  counters.committedBatches++;
  counters.processedEvents+=batch.processed;
  counters.createdNotifications+=batch.created;
}

export type NotificationProjectionObservation = {
  jobKey: string; ranAt: Date; durationMs: number|null; outcome: string; result: Record<string,number>|null;
};
export type NotificationProjectionHealth = 'missing'|'invalid'|'running'|'interrupted'|'failed'|'stale'|'backlogged'|'completed';

/** maxAgeMs comes from the installation's authoritative schedule plus an agreed tolerance; this
 * contract neither invents a schedule nor substitutes the catalog default for installed state. */
export function notificationProjectionHealth(run: NotificationProjectionObservation|null, now: number, maxAgeMs: number): NotificationProjectionHealth {
  if (!Number.isFinite(now)||!Number.isFinite(maxAgeMs)||maxAgeMs<=0) return 'invalid';
  if (!run) return 'missing';
  const started=run.ranAt instanceof Date?run.ranAt.getTime():NaN;
  if (run.jobKey!==NOTIFICATION_PROJECTION_JOB_KEY||!Number.isFinite(started)||started>now) return 'invalid';
  if (run.outcome==='running') return run.durationMs===null?(now-started>maxAgeMs?'interrupted':'running'):'invalid';
  if (run.durationMs===null||!Number.isFinite(run.durationMs)||run.durationMs<0||started+run.durationMs>now) return 'invalid';
  // The combined worker may be partial because of a separate mail/lifecycle failure. Projection
  // health depends on its own complete counters; a fatal worker failure remains unavailable.
  if (run.outcome!=='success'&&run.outcome!=='partial') return 'failed';
  const r=run.result;
  const required=['scopeLoaded','projectionTenants','projectionCompletedTenants','projectionFailedTenants','projectionBlockedTenants','cappedTenants','backlogObservedTenants','pendingEvents','oldestPendingSeconds'];
  if (!r||r.capabilityVersion!==NOTIFICATION_PROJECTION_CAPABILITY_VERSION||required.some(key=>!Number.isFinite(r[key])||r[key]<0)
      ||r.scopeLoaded!==1||r.projectionCompletedTenants!==r.projectionTenants||r.backlogObservedTenants!==r.projectionTenants
      ||r.projectionFailedTenants!==0||r.projectionBlockedTenants!==0) return 'failed';
  if (now-(started+run.durationMs)>maxAgeMs) return 'stale';
  if (r.cappedTenants>0||r.pendingEvents>0) return 'backlogged';
  return 'completed';
}

/** Runtime evidence is useful independently, but cannot authorize removal of page catch-up. Even a
 * row containing identityVerified:1 and invented SHA/build strings is not an accepted worker receipt. */
export function notificationSchedulingPrerequisite(run: NotificationProjectionObservation|null, now: number, maxAgeMs: number): {
  ready:false; identity:'unverified'; reason:'protectedAcceptedWorkerVerifierUnavailable'; projection:NotificationProjectionHealth;
} {
  return {ready:false,identity:'unverified',reason:'protectedAcceptedWorkerVerifierUnavailable',projection:notificationProjectionHealth(run,now,maxAgeMs)};
}
