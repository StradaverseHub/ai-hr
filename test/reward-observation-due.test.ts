/** The Rewards task source keeps the native suspension observation WRITE (0681) and runs it exactly when it has
 * something to record (5081 app.reward_access_observation_due). Nothing suspended: no write transaction and no
 * observation. A newly suspended member: the same single observation and audit event as before, once. The probe
 * answers for the current login only, like the write it guards. */
import {createApprovedRewardUnit} from './rewards-setup-fixture';
import {migrateRewardMembershipFixture} from './rewards-shared-policy-fixture';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {client,withSharedReadSnapshot,withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {pendingRewardTasks} from '../packs/rewards/service';
import {resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,closeAll,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';

let b:Base,admin:SessionContext,target:SessionContext,unitId:string,employmentId:string;
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
beforeAll(async()=>{
 await migrateRewardMembershipFixture();
 await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');admin=await entitledCtx(b);
 const [unit]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'DUE',name:'Fictional observation unit'}).returning();
 const hire=await hireEmployee(admin,{person:{fullName:'Fictional observed reviewer',primaryEmail:randomUUID()+'@due.test'},companyId:b.companyId,departmentId:b.deptA,businessUnitId:unit.id,employmentType:'full_time',hiredOn:`${year-1}-01-01`});
 employmentId=hire.employmentId;
 unitId=await createApprovedRewardUnit(admin,{name:'Fictional observation review',year,companyId:b.companyId,businessUnitId:unit.id,snapshotDate:today});
 const [employee]=await owner.db.select().from(s.employment).where(eq(s.employment.id,employmentId));
 const userId=await createAppUser(b.tenantId,employee.personId,'employee');
 target={...admin,userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 await owner.db.insert(s.rewardMember).values({tenantId:b.tenantId,unitId,userId,role:'gr'});
});
afterAll(closeAll);

const observations=()=>owner.client<{n:number}[]>`select count(*)::int as n from reward_access_observation where tenant_id=${b.tenantId}::uuid`.then(rows=>rows[0].n);
const events=()=>owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,unitId),eq(s.domainEvent.eventType,'reward-access.suspended')));
const due=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.execute<{due:boolean}>(sql`select app.reward_access_observation_due(NULL::uuid) as due`)).then(rows=>rows[0].due);
async function statementsOf(work:()=>Promise<unknown>){
 const options=client.options as {debug?:unknown},previous=options.debug,seen:string[]=[];
 options.debug=(_connection:number,query:string)=>{seen.push(query);};
 try{await work();}finally{options.debug=previous;}
 return seen;
}

describe('Rewards access observation on the task read',()=>{
 it('skips the write when nothing is newly suspended, inside and outside a shared snapshot',async()=>{
  expect(await due(target)).toBe(false);
  for(const read of [()=>pendingRewardTasks(target,undefined),()=>withSharedReadSnapshot(target,()=>pendingRewardTasks(target,undefined))]){
   const sent=await statementsOf(read);
   expect(sent.filter(text=>text.includes('reward_access_observe('))).toEqual([]);
   expect(sent.filter(text=>text.includes('reward_access_observation_due('))).toHaveLength(1);
  }
  expect(await observations()).toBe(0);
 });

 it('records a new suspension exactly once, as the unconditional write did',async()=>{
  await owner.db.update(s.employment).set({tenderResignationDate:today}).where(eq(s.employment.id,employmentId));
  expect(await due(target)).toBe(true);
  // The company's Rewards administrator observes the same member through its own admin branch.
  expect(await due(admin)).toBe(true);
  const sent=await statementsOf(()=>withSharedReadSnapshot(target,()=>pendingRewardTasks(target,undefined)));
  expect(sent.filter(text=>text.includes('reward_access_observe('))).toHaveLength(1);
  expect(await observations()).toBe(1);
  expect(await events()).toHaveLength(1);
  expect(await due(target)).toBe(false);
  await pendingRewardTasks(target,undefined);
  expect(await observations()).toBe(1);
  expect(await events()).toHaveLength(1);
 });
});
