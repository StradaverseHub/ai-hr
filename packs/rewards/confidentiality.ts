/**
 * 6fd08f37 — derived confidentiality. Anyone with an administrative reporting line, valid on the review's
 * snapshot date, to a person holding the unit's BG CEO seat is at least "BG confidential"; to the EC seat holder,
 * at least "EC confidential". Group Rewards may mark a person stricter, never lower (saveRewardEntry/importRewardFacts).
 * The native projection binds the current tenant, readable review and its company before returning floors.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { withConfidentialityFloor, type RewardSource } from './model';

export type ConfidentialityFloor = { level: 'bg' | 'ec'; managerEmploymentId: string };
/** One native floor projection serves snapshots and checker-owned access enactment. */
export async function deriveConfidentialityTx(tx:Tx,unitId:string,employmentIds:readonly string[],asOf:string):Promise<Map<string,ConfidentialityFloor>>{
 if(!employmentIds.length)return new Map();
 const rows=await tx.execute<{employment_id:string;level:'bg'|'ec';manager_employment_id:string}>(sql`select * from app.reward_confidentiality_floors(${unitId}::uuid,${`{${employmentIds.join(',')}}`}::uuid[],${asOf}::date)`);
 return new Map(rows.map(row=>[row.employment_id,{level:row.level,managerEmploymentId:row.manager_employment_id}]));
}
export const sourceWithFloor = (source: RewardSource, floor: ConfidentialityFloor | undefined) =>
  withConfidentialityFloor(source, floor ? { level: floor.level, reason: { seat: floor.level, managerEmploymentId: floor.managerEmploymentId } } : null);

