/** UNINSTALLED fixed native helper vocabulary. No app-schema usage or query broker. */
import {sql} from 'drizzle-orm';
import {RewardSetupError} from '../../packs/rewards/setup-model';
import type {RewardSetupQueryPort,PatVersion} from '../../packs/rewards/setup-query-owner';
export const receiptRewardSetupQueryPort:RewardSetupQueryPort=Object.freeze({
 async authority(tx,company,operation){const [row]=await tx.execute<{allowed:boolean}>(sql`select reward_audit_read.allowed(${company}::uuid,${operation})as allowed`);if(row?.allowed!==true)throw new RewardSetupError('forbidden','This Rewards configuration is not available to you.');},
 usedBy:(tx,id)=>tx.execute<{plan:string;company:string;year:number}>(sql`select * from reward_audit_read.library_used_by(${id}::uuid)`),
 locked:(tx,id)=>tx.execute<{locked:boolean}>(sql`select reward_audit_read.library_locked(${id}::uuid)as locked`),
 companies:(tx,year)=>tx.execute<{id:string;name:string;parentId:string|null;parentName:string|null}>(sql`select * from reward_audit_read.companies(${year})`),
 structure:(tx,id,at)=>tx.execute<{tags:{businessGroupId?:string;businessGroupName?:string;businessUnitId?:string;businessUnitName?:string;status?:string}}>(sql`select reward_audit_read.company_structure(${id}::uuid,${at}::date)as tags`),
 patHistory:(tx,id,year)=>tx.execute<{value:PatVersion}>(sql`select reward_audit_read.pat_history(${id}::uuid,${year})as value`),
});
