/** Internal legacy helper owner. No new permission or transaction purpose. */
import {sql} from 'drizzle-orm';
import {setupAuthority} from './setup-data';
import type {RewardSetupQueryPort,PatCompany,RewardPlanCompanyChoiceQueryPort,PatVersion} from './setup-query-owner';
export const legacyRewardSetupQueryPort:RewardSetupQueryPort&RewardPlanCompanyChoiceQueryPort=Object.freeze({
 authority:setupAuthority,
 usedBy:(tx,id)=>tx.execute<{plan:string;company:string;year:number}>(sql`select * from app.reward_library_used_by(${id}::uuid)`),
 locked:(tx,id)=>tx.execute<{locked:boolean}>(sql`select app.reward_library_locked(${id}::uuid) as locked`),
 companiesWithStructure:(tx,year,at)=>tx.execute<PatCompany>(sql`select * from app.reward_review_plan_company_rows(${year},${at}::date,false)`),
 companies:(tx,year)=>tx.execute<{id:string;name:string;parentId:string|null;parentName:string|null}>(sql`select * from app.reward_setup_companies(${year})`),
 structure:(tx,id,at)=>tx.execute<{tags:{businessGroupId?:string;businessGroupName?:string;businessUnitId?:string;businessUnitName?:string;status?:string}}>(sql`select app.reward_company_structure(${id}::uuid,${at}::date) as tags`),
 planCompanyOrder:(tx,year,at)=>tx.execute<{id:string;name:string;parentName:string|null;businessGroupName:string|null;businessUnitName:string|null}>(sql`select id,name,"parentName","businessGroupName","businessUnitName" from app.reward_review_plan_company_rows(${year},${at}::date,false)`),
 patHistory:(tx,id,year)=>tx.execute<{value:PatVersion}>(sql`select app.reward_private_pat_history(${id}::uuid,${year}) as value`),
});
