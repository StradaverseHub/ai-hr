/** Real maintenance admission, independent metadata and exact native source effects. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createGradeGroup,updateGradeGroup,deleteGradeGroup,listGradeGroups,listGradeGroupsForMaintenance} from '../packs/leave/service';
import {moduleFunctionAccess} from '../core/module-action-access';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext,employee:SessionContext,gradeA:string,gradeB:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin=adminCtx(b);
 const userId=await createAppUser(b.tenantId,null,'employee');
 employee={...admin,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 [gradeA,gradeB]=(await owner.db.insert(s.jobGrade).values([{tenantId:b.tenantId,code:'GROUP_A',name:'Fictional Grade A'},{tenantId:b.tenantId,code:'GROUP_B',name:'Fictional Grade B'}]).returning()).map(row=>row.id);
});
it('preserves native maintenance CRUD, actual membership replacement and cascade deletion',async()=>{
 const a=await createGradeGroup(admin,{name:'Fictional Group A',gradeIds:[gradeA]}),c=await createGradeGroup(admin,{name:'Fictional Group B',gradeIds:[gradeB]});
 await updateGradeGroup(admin,{id:c.id,name:'Fictional Group B revised',gradeIds:[gradeA,gradeB]});
 expect((await listGradeGroupsForMaintenance(admin)).find(row=>row.id===a.id)?.gradeIds).toEqual([]);
 expect((await listGradeGroupsForMaintenance(admin)).find(row=>row.id===c.id)?.gradeIds.sort()).toEqual([gradeA,gradeB].sort());
 await deleteGradeGroup(admin,{id:c.id});
 expect((await owner.db.select().from(s.gradeGroupMember).where(eq(s.gradeGroupMember.gradeGroupId,c.id)))).toEqual([]);
 expect((await owner.client`select event_type from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${c.id}::uuid order by occurred_at,id`).map(row=>row.event_type).sort()).toEqual(['grade-group.created','grade-group.deleted','grade-group.updated']);
});
it('keeps metadata available to routing consumers while refusing employee maintenance and raw deletes',async()=>{
 const group=await createGradeGroup(admin,{name:'Fictional Shared Metadata',gradeIds:[gradeA]});
 expect((await listGradeGroups(employee)).find(row=>row.id===group.id)?.gradeIds).toEqual([gradeA]);
 expect(await moduleFunctionAccess(employee,'leaveConfig.gradeGroups','view')).toBe(false);
 await expect(listGradeGroupsForMaintenance(employee)).rejects.toThrow('Module action is unavailable');
 await expect(createGradeGroup(employee,{name:'Forbidden'})).rejects.toThrow('Module action is unavailable');
 const before=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await expect(withTenant(employee,async tx=>{
  await tx.execute(sql`select set_config('app.owner','true',true)`);
  await tx.transaction(async nested=>{await nested.delete(s.gradeGroupMember).where(eq(s.gradeGroupMember.gradeGroupId,group.id));});
 })).rejects.toThrow();
 await expect(withTenant(employee,tx=>tx.delete(s.gradeGroup).where(eq(s.gradeGroup.id,group.id)))).rejects.toThrow();
 expect((await listGradeGroups(admin)).find(row=>row.id===group.id)?.gradeIds).toEqual([gradeA]);
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(before);
 await expect(withTenant(employee,tx=>tx.execute(sql`insert into app.module_grade_group_source values(pg_current_xact_id(),${b.tenantId}::uuid,${employee.userId}::uuid,${randomUUID()}::uuid,'add')`))).rejects.toThrow();
});
