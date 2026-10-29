import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {defaultPolicy,type RewardPolicy} from '../packs/rewards/model';
import {REWARD_POLICY_GRADES} from '../packs/rewards/policy-grid-validation';
import {owner,migrateTestDb} from './harness';
/** Business-valid policy fixtures; no invented production defaults. */
export function completeSharedRewardPolicy(year:number):RewardPolicy{
 return {...defaultPolicy(year),ranges:Object.fromEntries(REWARD_POLICY_GRADES.filter(grade=>grade!=='23').map(grade=>[grade,[10000,20000,30000] as [number,number,number]])),bonusMatrix:Object.fromEntries(REWARD_POLICY_GRADES.map(grade=>[grade,[0,10000,20000,30000,40000] as [number,number,number,number,number]]))};
}
/** Explicit People writer establishes membership. A master catalogue row never substitutes for this fact. */
export async function establishRewardMembership(ctx:SessionContext,p:{tenantId:string;companyId:string;businessUnitId:string;departmentId?:string;year:number}){
 const departmentId=p.departmentId??(await owner.db.insert(schema.department).values({tenantId:p.tenantId,companyId:p.companyId,name:`Rewards membership ${randomUUID()}`}).returning({id:schema.department.id}))[0].id;
 return hireEmployee(ctx,{person:{fullName:'Rewards scope fixture',primaryEmail:`${randomUUID()}@reward-scope.test`},companyId:p.companyId,businessUnitId:p.businessUnitId,departmentId,employmentType:'full_time',hiredOn:`${p.year-2}-01-01`});
}
/** Private worker DB only, until parent integrates the allocated successor journal. */
export async function migrateRewardMembershipFixture(){
 await migrateTestDb();const [state]=await owner.db.execute<{present:boolean}>(sql`select to_regprocedure('app.reward_policy_memberships(uuid[])') is not null as present`);
 if(!state.present){const draft=readFileSync(new URL('../docs/migration-drafts/0690_rewards_policy_pair_membership.sql',import.meta.url),'utf8');await owner.db.transaction(async tx=>{for(const statement of draft.split('--> statement-breakpoint').filter(statement=>statement.trim()))await tx.execute(sql.raw(statement));});}
}
