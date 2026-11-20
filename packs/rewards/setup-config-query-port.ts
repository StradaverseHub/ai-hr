/** Board 60f1fdcd: the Salary Structures, Bonus Matrices and PAT Inputs readers for every configuration editor
 * (Group Rewards, CTRO and HR Admin), through the owner-owned copies in migration 5580. Plans keep the legacy port. */
import {sql} from 'drizzle-orm';
import {configAnyAuthority,configAuthority,configLibraryView} from './setup-data';
import type {RewardSetupQueryPort,PatCompany,PatVersion} from './setup-query-owner';
export const configRewardSetupQueryPort:RewardSetupQueryPort=Object.freeze({
 authority:async(tx,companyId,operation)=>{
  if(operation==='library_view'){if(companyId===null)return configLibraryView(tx);const [r]=await tx.execute<{allowed:boolean}>(sql`select app.reward_config_viewer(${companyId}::uuid) as allowed`);if(r?.allowed)return;return configAuthority(tx,companyId);}
  // A list view without a company admits an editor of any company; its rows are already limited to their companies.
  return companyId===null?configAnyAuthority(tx):configAuthority(tx,companyId);
 },
 usedByRelation:id=>sql`app.reward_config_library_used_by(${id})`,
 lockedExpression:id=>sql`app.reward_config_library_locked(${id})`,
 companiesWithStructure:(tx,year,at)=>tx.execute<PatCompany>(sql`select * from app.reward_review_plan_company_rows(${year},${at}::date,true)`),
 companies:(tx,year)=>tx.execute<{id:string;name:string;parentId:string|null;parentName:string|null}>(sql`select * from app.reward_config_companies(${year})`),
 structure:(tx,id,at)=>tx.execute<{tags:{businessGroupId?:string;businessGroupName?:string;businessUnitId?:string;businessUnitName?:string;status?:string}}>(sql`select app.reward_config_company_structure(${id}::uuid,${at}::date) as tags`),
 patHistory:(tx,id,year)=>tx.execute<{value:PatVersion}>(sql`select app.reward_config_pat_history(${id}::uuid,${year}) as value`),
});
