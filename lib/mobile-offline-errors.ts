/** Offline context issuance refusal, in a module with no 'server-only' marker: the attendance facade
 * (packs/attendance/service, imported by db/seed.ts and other plain Node processes) loads the snapshot and adjudicator
 * owners, which throw and test this class. core/mobile-offline-context.ts re-exports this SAME class, so every
 * existing import and instanceof check is unchanged. No dependency, no logic: a class only. */
export class OfflineContextIssueError extends Error{
 constructor(readonly reason:'configuration_unavailable'|'key_unavailable'|'binding_conflict'|'online_pending'|'context_closed'|'time_unavailable'|'offline_disabled'|'device_required'){
  super('Offline context unavailable');this.name='OfflineContextIssueError';
 }
}
