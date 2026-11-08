/** Fixed native lifecycle port only. No app pool, Drizzle Tx, SQL broker or projection fallback. */
import type {Sql} from 'postgres';
export type NativeNotificationScope={tenant_id:string;standing:string;consumer:'notifications'|'assessment-reminders'|null;entitlement_facts:unknown};
export type NativeNotificationEvent={event_id:string;aggregate_type:string;aggregate_id:string;event_type:string;subject_employment_id:string|null;payload:unknown;event_sequence:string};
/** `interrupted` requires the additive UNINSTALLED process-stage native profile. */
export type NotificationWorkerFailure='projection-unimplemented'|'scope-changed'|'budget-exhausted'|'database-refusal'|'interrupted';
export class NotificationProjectionUnavailable extends Error{constructor(){super('Canonical narrow-worker projection is not implemented');}}
/** A dedicated max1 direct connection owns the native backend-bound run across commits.
 * Native state, not this object or its arguments, establishes every authorization. */
export function notificationWorkerLifecycle(connection:Sql){
 if(connection.options.max!==1)throw Error('Notification lifecycle requires one dedicated physical connection');
 return {
  async openRun(){const [row]=await connection<{run_id:string}[]>`select notification_worker.open_run() as run_id`;return row.run_id;},
  async scopePage(run:string,after:string|null=null,count=100){
   return Array.from(await connection<NativeNotificationScope[]>`select * from notification_worker.scope_page(${run}::uuid,${after}::uuid,${count}::integer)`);
  },
  /** Stage1 can commit an empty admission only. A nonempty admission and its
   * source locks roll back together; no caller may claim it was processed. */
  async finishEmptyBatch(run:string,tenant:string,count=100){
   return connection.begin(async tx=>{
    const [batch]=await tx<{batch_id:string}[]>`select notification_worker.open_batch(${run}::uuid,${tenant}::uuid,${count}::integer) as batch_id`;
    const events=await tx<NativeNotificationEvent[]>`select * from notification_worker.events(${batch.batch_id}::uuid)`;
    if(events.length)throw new NotificationProjectionUnavailable();
    const [result]=await tx<{processed:number;created:number}[]>`select * from notification_worker.finish_batch(${batch.batch_id}::uuid)`;
    return result;
   });
  },
  async settleScope(run:string,tenant:string,reason:'drained'|'capped'|'failed'|'disabled'){
   const [row]=await connection<{pending:string;oldest_seconds:number;observed_at:Date}[]>`select * from notification_worker.settle_scope(${run}::uuid,${tenant}::uuid,${reason}::text)`;return row;
  },
  async finishRun(run:string){await connection`select notification_worker.finish_run(${run}::uuid)`;},
  async failRun(run:string,reason:NotificationWorkerFailure){await connection`select notification_worker.fail_run(${run}::uuid,${reason}::text)`;},
 };
}
