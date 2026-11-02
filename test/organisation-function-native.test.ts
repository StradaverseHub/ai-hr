import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {createDepartment,createPosition} from '../core/admin';
import {listDepartmentsForLabels,listPositionsForLabels} from '../core/admin';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as s from '../db/schema';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
it('preserves actual native Department and Position owners while dormant, and refuses unknown operations',async()=>{
 const ctx=adminCtx(b);
 const department=await createDepartment(ctx,{companyId:b.companyId,name:'Finite department'});
 const position=await createPosition(ctx,{companyId:b.companyId,title:'Finite position'});
 expect((await listDepartmentsForLabels(ctx)).some(row=>row.id===department.id)).toBe(true);
 expect((await listPositionsForLabels(ctx)).some(row=>row.id===position.id)).toBe(true);
 const [result]=await withTenant(ctx,tx=>tx.execute<{department:boolean;position:boolean;unknown:boolean;invented:boolean}>(sql`select app.organisation_settings_function_allowed('systemLabels.department','view',${b.companyId}::uuid) department,app.organisation_settings_function_allowed('systemLabels.position','view',${b.companyId}::uuid) position,app.organisation_settings_function_allowed('systemLabels.unknown','view',${b.companyId}::uuid) unknown,app.organisation_settings_function_allowed('systemLabels.department','approve',${b.companyId}::uuid) invented`));
 expect(result).toEqual({department:true,position:true,unknown:false,invented:false});
});
it('keeps company native maintenance independent of global-only configuration authority',async()=>{
 const userId=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
 const ctx={...adminCtx(b),userId,personId:null,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const [result]=await withTenant(ctx,tx=>tx.execute<{department:boolean;globalId:boolean;general:boolean;login:boolean}>(sql`select app.organisation_settings_function_allowed('systemLabels.department','add',${b.companyId}::uuid) department,app.organisation_settings_function_allowed('employeeIdConfig.global','edit',NULL) "globalId",app.organisation_settings_function_allowed('peopleGeneral','edit',NULL) general,app.organisation_settings_function_allowed('loginPresentation','edit',NULL) login`));
 expect(result).toEqual({department:true,globalId:false,general:false,login:false});
});
it('retains an honest unqualified publication state instead of exposing unsupported operation cells',async()=>{
 const [result]=await owner.db.execute<{complete:boolean;invented:number}>(sql`select to_regprocedure('app.organisation_settings_bindings_complete()') is not null complete,(select count(*)::int from app.access_function_action where function_key in ('peopleGeneral','loginPresentation','workflowEmail','emailTemplates','entra','systemExplorer') and operation not in ('view','edit')) invented`);
 expect(result).toEqual({complete:false,invented:0});
});
