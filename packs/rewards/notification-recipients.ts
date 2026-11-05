import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { rewardRoles } from './model';

/** In-app notification fan-out for the shared dispatcher; payloads contain no employee pay. */
/** Pool changes concern every live approver, independently of the review's current routing stage. */
export async function rewardPoolNotificationRecipients(tx:Tx,unitId:string):Promise<string[]>{
 const rows=await tx.execute<{employmentId:string}>(sql`select app.reward_pool_notification_recipients(${unitId}::uuid) as "employmentId"`);
 return rows.map(row=>row.employmentId);
}

export async function rewardNotificationRecipients(tx: Tx, unitId: string, stage: unknown): Promise<string[]> {
  if (typeof stage !== 'string') return [];
  const role = stage === 'approved' ? 'payroll' : stage === 'draft' ? 'bu' : stage;
  if (!(rewardRoles as readonly string[]).includes(role)) return [];
  const rows = await tx.execute<{ employmentId: string }>(sql`select app.reward_notification_recipients(${unitId}::uuid, ${stage}) as "employmentId"`);
  return rows.map(r => r.employmentId);
}

export async function rewardAccessSuspensionEventRecipients(tx:Tx,eventId:string|undefined):Promise<string[]>{
 if(!eventId)return [];
 const rows=await tx.execute<{employment_id:string}>(sql`select app.reward_access_suspension_event_recipients(${eventId}::uuid) as employment_id`);
 return rows.map(row=>row.employment_id);
}
export async function rewardAccessSuspensionRecipients(tx:Tx,unitId:string):Promise<string[]>{
 const rows=await tx.execute<{employment_id:string}>(sql`select app.reward_access_suspension_recipients(${unitId}::uuid) as employment_id`);
 return rows.map(row=>row.employment_id);
}

export async function rewardUploadCheckerRecipients(tx:Tx,unitId:string){const rows=await tx.execute<{employmentId:string}>(sql`select app.reward_upload_checker_recipients(${unitId}::uuid) as "employmentId"`);return rows.map(r=>r.employmentId);}
