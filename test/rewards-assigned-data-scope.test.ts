/** An actual unit review is an independent record course; it is never a Personnel grant. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createRewardUnit,getRewardUnit,saveRewardEntry} from '../packs/rewards/service';
import {setRewardMember} from './rewards-access-fixture';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,root:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');root=await entitledCtx(b);});
async function hire(code:string){return hireEmployee(root,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01',employeeCode:code,person:{fullName:'Fictional '+code,primaryEmail:randomUUID()+'@fixture.invalid'}});}
async function actor(code:string,role:'employee'|'manager'='employee'){
 const employee=await hire(code),userId=await createAppUser(b.tenantId,employee.personId,role);
 return{...employee,ctx:{...root,userId,personId:employee.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext};
}
async function restrict(userId:string,code:string){
 const id=randomUUID(),revision=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${id},${b.tenantId},${'Assigned reward '+id})`;
 await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${id},${JSON.stringify({legacyCompany:false,predicates:[{field:'employeeId',values:[code]}]})}::text::jsonb,${root.userId!})`;
 await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${id}`;
 await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${userId},${id},${root.userId!})`;
}
it('keeps only actual current unit membership, with no raw subject access and immediate revocation',async()=>{
 const subject=await hire('REWARD-SUBJECT'),reviewer=await actor('REWARD-REVIEWER'),other=await actor('REWARD-OTHER'),manager=await actor('REWARD-MANAGER','manager');
 const [bu]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'REWARD-TASK',name:'Fictional assigned review'}).returning();
 await owner.db.update(s.assignment).set({businessUnitId:bu.id}).where(eq(s.assignment.employmentId,subject.employmentId));
 const today=todayInKualaLumpur(),unit=await createRewardUnit(root,{name:'Fictional assigned review',year:Number(today.slice(0,4)),companyId:b.companyId,businessUnitId:bu.id,snapshotDate:today});
 const second=await createRewardUnit(root,{name:'Fictional other review',year:Number(today.slice(0,4))-1,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:(Number(today.slice(0,4))-1)+'-12-31'});
 const reviewed=await getRewardUnit(root,unit),entry=reviewed.rows.find(row=>row.source.employmentId===subject.employmentId)!;
 await saveRewardEntry(root,unit,reviewed.unit.revision,entry.id,entry.recommendation,{...entry.facts,reviewed:true});
 await setRewardMember(root,unit,(await getRewardUnit(root,unit)).unit.revision,reviewer.ctx.userId!,'bg');
 await setRewardMember(root,second,(await getRewardUnit(root,second)).unit.revision,other.ctx.userId!,'bg');
 for(const [person,code] of [[reviewer,'REWARD-REVIEWER'],[other,'REWARD-OTHER'],[manager,'REWARD-MANAGER']] as const)await restrict(person.ctx.userId!,code);
 const raw=await withTenant(reviewer.ctx,async tx=>({people:await tx.select().from(s.person).where(eq(s.person.id,subject.personId)),employments:await tx.select().from(s.employment).where(eq(s.employment.id,subject.employmentId)),entries:await tx.select({employmentId:s.rewardEntry.employmentId}).from(s.rewardEntry).where(eq(s.rewardEntry.unitId,unit))}));
 expect(raw.people).toEqual([]);expect(raw.employments).toEqual([]);expect(raw.entries.map(row=>row.employmentId)).toContain(subject.employmentId);
 expect((await getRewardUnit(reviewer.ctx,unit)).rows.map(row=>row.source.employmentId)).toContain(subject.employmentId);
 for(const outsider of [other,manager])expect(await withTenant(outsider.ctx,tx=>tx.select().from(s.rewardEntry).where(eq(s.rewardEntry.unitId,unit)))).toEqual([]);
 await owner.db.delete(s.rewardMember).where(eq(s.rewardMember.userId,reviewer.ctx.userId!));
 expect(await withTenant(reviewer.ctx,tx=>tx.select().from(s.rewardEntry).where(eq(s.rewardEntry.unitId,unit)))).toEqual([]);
 await expect(getRewardUnit(reviewer.ctx,unit)).rejects.toThrow();
});
