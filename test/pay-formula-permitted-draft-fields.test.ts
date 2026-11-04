/** Provider metadata admission: native scope and field permissions, with no employee source access. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {payFormulaPermittedDraftFieldsTx} from '../core/pay-formula-personnel';
import {registerPayFormulaPersonnelField} from '../core/pay-formula';
import {PAY_FORMULA_FIELD_TYPES} from '../lib/pay-formula-registry';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');ctx=await entitledCtx(base);});
const read=(actor=ctx)=>withTenant(actor,tx=>payFormulaPermittedDraftFieldsTx(tx,actor));
it('returns only code-owned field keys and never company or private registration metadata',async()=>{
 await owner.db.update(schema.company).set({legalName:'PRIVATE COMPANY SENTINEL'}).where(eq(schema.company.id,base.companyId));
 await registerPayFormulaPersonnelField(ctx,{sourceKey:'companyId',label:'PRIVATE LABEL SENTINEL',description:'PRIVATE DESCRIPTION SENTINEL',enabled:true});
 const fields=await read();expect(fields.profile).toContain('companyId');expect(fields.profile).toContain('joinDate');expect(fields.employee).toContain('dateOfBirth');expect(fields.employee).toContain('profile.personal_details.fullname');
 expect(Object.keys(fields).sort()).toEqual(['employee','profile']);
 for(const group of ['profile','employee'] as const)expect(fields[group].every(key=>Object.hasOwn(PAY_FORMULA_FIELD_TYPES[group],key))).toBe(true);
 const output=JSON.stringify(fields);for(const privateValue of [base.companyId,'PRIVATE COMPANY SENTINEL','PRIVATE LABEL SENTINEL','PRIVATE DESCRIPTION SENTINEL'])expect(output).not.toContain(privateValue);
});
it('honors field permissions only within the author’s financially authorized companies, including legacy mappings',async()=>{
 const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Private outside financial scope'}).returning();
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'draft-fields-'+randomUUID()}).returning();
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,role:'hr_admin',companyId:base.companyId});
 await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:base.tenantId,companyId:base.companyId,role:'hr_admin',permissionKey:'report.read.identity',allowed:false});
 const scoped={...ctx,userId:user.id,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:base.companyId}]} satisfies SessionContext;
 const denied=await read(scoped);expect(denied.profile).toContain('companyId');expect(denied.profile).toContain('employeeNo');expect(denied.employee).toEqual([]);
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,role:'hr_admin',companyId:other.id});
 const expanded={...scoped,grants:[...scoped.grants,{role:'hr_admin',companyId:other.id}]};
 const allowed=await read(expanded);expect(allowed.employee).toContain('dateOfBirth');expect(allowed.employee).toContain('profile.personal_details.fullname');
});
it('uses the latest enabled state and does not suggest a disabled descriptor through a legacy alias',async()=>{
 await registerPayFormulaPersonnelField(ctx,{sourceKey:'companyId',label:'Employer',description:'Explicit disabled source for authoring',enabled:false});
 await registerPayFormulaPersonnelField(ctx,{sourceKey:'departmentId',label:'Department identity',description:'Explicit disabled source and legacy alias',enabled:false});
 const disabled=await read();expect(disabled.profile).not.toContain('companyId');expect(disabled.profile).not.toContain('departmentId');expect(disabled.profile).not.toContain('departmentCode');
 await registerPayFormulaPersonnelField(ctx,{sourceKey:'companyId',label:'Private renamed employer',description:'Private reviewed registration description',enabled:true});
 const enabled=await read();expect(enabled.profile).toContain('companyId');expect(enabled.profile).not.toContain('departmentCode');expect(enabled.employee).toContain('dateOfBirth');
});
it('returns no field definitions without current native author/financial authority',async()=>{
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'no-draft-fields-'+randomUUID()}).returning();
 const unprivileged={...ctx,userId:user.id,personId:null,roles:[],grants:[]} satisfies SessionContext;
 expect(await read(unprivileged)).toEqual({profile:[],employee:[]});expect(await read({...unprivileged,userId:null})).toEqual({profile:[],employee:[]});
});
