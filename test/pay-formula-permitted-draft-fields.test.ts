/** Provider metadata admission: native scope and field permissions, with no employee source access. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {payFormulaPermittedDraftFieldsTx} from '../core/pay-formula-personnel';
import {setLabelCriteria} from '../core/system-labels';
import {registerPayFormulaPersonnelField,payFormulaOptions} from '../core/pay-formula';
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
 expect(await read(unprivileged)).toEqual({profile:[],employee:[]});expect(await read({...unprivileged,userId:undefined})).toEqual({profile:[],employee:[]});
});

it('serializes no library list values when Personnel field permission is denied',async()=>{
 const [privateLabel]=await owner.withTenant(ctx,tx=>tx.insert(schema.department).values({tenantId:base.tenantId,companyId:base.companyId,name:'DENIED_LIST_SENTINEL',isGlobal:true}).returning());
 const before=await payFormulaOptions(ctx);expect(before.personnelFields.find(field=>field.key==='departmentId')?.listValues.some(value=>value.value===privateLabel.id)).toBe(true);
 await owner.db.insert(schema.payrollPermissionGrant).values(['hr_admin','super_admin'].map(role=>({tenantId:base.tenantId,companyId:base.companyId,role,permissionKey:'report.read.personnel',allowed:false})));
 const options=await payFormulaOptions(ctx);
 expect(options.personnelFields.find(field=>field.key==='companyId')).toMatchObject({enabled:false,unavailableReason:'permission',listValues:[]});
 expect(options.personnelFields.every(field=>!field.listValues.length)).toBe(true);expect(JSON.stringify(options.personnelFields)).not.toContain('DENIED_LIST_SENTINEL');
});
it('serializes no list values for disabled sources, including the otherwise available Company field',async()=>{
 await owner.withTenant(ctx,tx=>tx.insert(schema.department).values({tenantId:base.tenantId,companyId:base.companyId,name:'DISABLED_LIST_SENTINEL',isGlobal:true}));
 for(const sourceKey of ['companyId','departmentId','businessUnitId','positionId'])await registerPayFormulaPersonnelField(ctx,{sourceKey,label:'Disabled '+sourceKey,description:'An unavailable source must not retain serialized choices',enabled:false});
 const options=await payFormulaOptions(ctx);
 for(const key of ['companyId','departmentId','businessUnitId','positionId'])expect(options.personnelFields.find(field=>field.key===key)).toMatchObject({enabled:false,unavailableReason:'disabled',listValues:[]});
 expect(options.personnelFields.every(field=>field.enabled||!field.listValues.length)).toBe(true);expect(JSON.stringify(options.personnelFields)).not.toContain('DISABLED_LIST_SENTINEL');
});
it('uses saved per-code Criteria rather than creation-company or legacy-sharing flags and keeps genuine Global labels available',async()=>{
 const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Other Criteria company'}).returning();
 await owner.db.update(schema.company).set({sharedSystemLabels:true}).where(eq(schema.company.id,base.companyId));
 const departments=await owner.withTenant(ctx,tx=>tx.insert(schema.department).values([{tenantId:base.tenantId,companyId:base.companyId,name:'CRITERIA_EXCLUDED_DEPARTMENT'},{tenantId:base.tenantId,companyId:other.id,name:'ACTUAL_GLOBAL_DEPARTMENT'}]).returning());
 const units=await owner.withTenant(ctx,tx=>tx.insert(schema.businessUnit).values([{tenantId:base.tenantId,companyId:base.companyId,code:'CRITERIA_EXCLUDED_UNIT',name:'Excluded unit'},{tenantId:base.tenantId,companyId:other.id,code:'ACTUAL_GLOBAL_UNIT',name:'Global unit'}]).returning());
 const positions=await owner.withTenant(ctx,tx=>tx.insert(schema.position).values([{tenantId:base.tenantId,companyId:base.companyId,title:'CRITERIA_EXCLUDED_POSITION'},{tenantId:base.tenantId,companyId:other.id,title:'ACTUAL_GLOBAL_POSITION'}]).returning());
 const pairs=[{kind:'department',key:'departmentId',excluded:departments[0],global:departments[1]},{kind:'business_unit',key:'businessUnitId',excluded:units[0],global:units[1]},{kind:'position',key:'positionId',excluded:positions[0],global:positions[1]}];
 for(const pair of pairs){await setLabelCriteria(ctx,{kind:pair.kind,labelId:pair.excluded.id,isGlobal:false,companyIds:[other.id]});await setLabelCriteria(ctx,{kind:pair.kind,labelId:pair.global.id,isGlobal:true,companyIds:[]});}
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'criteria-picker-'+randomUUID()}).returning();
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,role:'hr_admin',companyId:base.companyId});
 const scoped={...ctx,userId:user.id,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:base.companyId}]} satisfies SessionContext;
 const options=await payFormulaOptions(scoped);
 for(const pair of pairs){const values=options.personnelFields.find(field=>field.key===pair.key)?.listValues??[];expect(values.some(value=>value.value===pair.excluded.id)).toBe(false);expect(values.some(value=>value.value===pair.global.id)).toBe(true);}
 expect(JSON.stringify(options.personnelFields)).not.toContain('CRITERIA_EXCLUDED');
});
it('limits list-value company scopes to companies granting the Personnel category, not any financially accessible company',async()=>{
 const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Permitted list company'}).returning();
 const [privateLabel]=await owner.withTenant(ctx,tx=>tx.insert(schema.department).values({tenantId:base.tenantId,companyId:base.companyId,name:'DENIED_COMPANY_LIST_SENTINEL'}).returning());
 await setLabelCriteria(ctx,{kind:'department',labelId:privateLabel.id,isGlobal:false,companyIds:[base.companyId]});
 await owner.db.insert(schema.payrollPermissionGrant).values(['hr_admin','super_admin'].map(role=>({tenantId:base.tenantId,companyId:base.companyId,role,permissionKey:'report.read.personnel',allowed:false})));
 const options=await payFormulaOptions(ctx),values=options.personnelFields.find(field=>field.key==='companyId')?.listValues??[];
 expect(values.map(value=>value.value)).toContain(other.id);expect(values.map(value=>value.value)).not.toContain(base.companyId);expect(JSON.stringify(options.personnelFields)).not.toContain('DENIED_COMPANY_LIST_SENTINEL');
});
