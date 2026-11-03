/** Native read projection and actual dated-source history; no fabricated supported controls. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createClaimType,createClaimItem,setClaimPolicy,setMileageRateTable,claimConfigurationWriteAccess,listClaimTypes,updateClaimType} from '../core/claims';
import {publishActionCapabilityPackage} from '../deploy/access/publish-workforce-capabilities';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext,typeId:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();admin=adminCtx(b);typeId=(await createClaimType(admin,{code:'PROJECTION',name:'Fictional native control projection',defaultTaxable:false,requiresReceipt:false,isMileage:true})).id;});
async function resources(){return owner.client`select kind,resource_key,born_xact::text,born_actor,completed from app.module_action_resource where tenant_id=${b.tenantId}::uuid order by kind,resource_key`;}
it('does not reserve or mutate dated resources while projecting actual native controls',async()=>{
 const before=await resources(),configuration=await owner.client`select * from access_configuration where tenant_id=${b.tenantId}::uuid`,epochs=await owner.client`select * from app.access_control_epoch where tenant_id=${b.tenantId}::uuid`;
 const selections=[{kind:'claim_policy' as const,claimTypeId:typeId,gradeId:null},{kind:'claim_mileage_rate' as const,claimTypeId:typeId,gradeId:null,vehicleClass:'lorry' as const}];
 expect(await claimConfigurationWriteAccess(admin,selections)).toEqual([true,true]);expect(await claimConfigurationWriteAccess(admin,selections)).toEqual([true,true]);
 expect(await resources()).toEqual(before);expect(await owner.client`select * from access_configuration where tenant_id=${b.tenantId}::uuid`).toEqual(configuration);expect(await owner.client`select * from app.access_control_epoch where tenant_id=${b.tenantId}::uuid`).toEqual(epochs);
});
it('shares the native resource-history fact with real Add and later dated Edit owners',async()=>{
 const fact=()=>owner.client.begin(async tx=>{const [row]=await tx`select * from app.claim_configuration_resource_fact('claim_policy',${JSON.stringify({tenant_id:b.tenantId,claim_type_id:typeId,grade_id:null,claim_item_id:null})}::jsonb)`;return row;});
 expect(await fact()).toEqual({resource_key:JSON.stringify([typeId,null,null]).replaceAll(',',', '),existed:false});
 await setClaimPolicy(admin,{claimTypeId:typeId,annualBudget:1200,perClaimCap:100,effectiveFrom:'2026-01-01'});expect((await fact()).existed).toBe(true);
 const born=await resources();expect(born.filter(row=>row.kind==='claim_policy')).toHaveLength(1);
 await setClaimPolicy(admin,{claimTypeId:typeId,annualBudget:1500,perClaimCap:125,effectiveFrom:'2026-02-01'});expect((await fact()).existed).toBe(true);expect(await resources()).toEqual(born);
 expect(await claimConfigurationWriteAccess(admin,[{kind:'claim_policy',claimTypeId:typeId,gradeId:null}])).toEqual([true]);
});
it('preserves member catalogue reference without exposing administrative mutation controls',async()=>{
 const userId=await createAppUser(b.tenantId,null,'employee'),member:SessionContext={...admin,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 expect((await listClaimTypes(member)).map(row=>row.id)).toContain(typeId);
 expect(await claimConfigurationWriteAccess(member,[{kind:'claim_policy',claimTypeId:typeId,gradeId:null}])).toEqual([false]);
});
it('fails closed for unknown/foreign logical sources and accepts every actual native vehicle class',async()=>{
 const other=await seedBase();const [foreignGrade]=await owner.db.insert(s.jobGrade).values({tenantId:other.tenantId,code:'FOREIGN',name:'Fictional foreign grade'}).returning({id:s.jobGrade.id});
 const otherType=(await createClaimType(admin,{code:'OTHER',name:'Fictional other parent',defaultTaxable:false,requiresReceipt:false})).id,item=(await createClaimItem(admin,{claimTypeId:otherType,code:'OTHER_ITEM',name:'Fictional other parent item'})).id;
 expect(await claimConfigurationWriteAccess(admin,[{kind:'claim_policy',claimTypeId:randomUUID(),gradeId:null},{kind:'claim_policy',claimTypeId:typeId,gradeId:foreignGrade.id},{kind:'claim_policy',claimTypeId:typeId,gradeId:null,claimItemId:item}])).toEqual([false,false,false]);
 const [invalid]=await withTenant(admin,tx=>tx.execute<{kind:boolean;vehicle:boolean}>(sql`select app.claim_configuration_write_access('unregistered',${typeId}::uuid,null,null,null) as kind,app.claim_configuration_write_access('claim_mileage_rate',${typeId}::uuid,null,null,'aeroplane') as vehicle`));expect(invalid).toEqual({kind:false,vehicle:false});
 for(const vehicleClass of ['any','car','motorcycle','van','lorry'] as const){
  expect(await claimConfigurationWriteAccess(admin,[{kind:'claim_mileage_rate',claimTypeId:typeId,gradeId:null,vehicleClass}])).toEqual([true]);
  await setMileageRateTable(admin,{claimTypeId:typeId,vehicleClass,effectiveFrom:'2026-01-01',bands:[{fromKm:0,toKm:null,ratePerKm:0.5}]});
 }
});

it('publishes the Claims Configuration actions and keeps a Types Edit denial separate from Limits',async()=>{
 const cap='function.claimsConfig.types.edit';
 try{
  expect(await publishActionCapabilityPackage(owner.client,'claim_configuration')).toMatchObject({changed:true,capabilities:16});
  expect(await publishActionCapabilityPackage(owner.client,'claim_configuration')).toMatchObject({changed:false});
  await updateClaimType(admin,{id:typeId,name:'Permitted type name',defaultTaxable:false,requiresReceipt:false});
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,effect)
   values(${b.tenantId}::uuid,${admin.userId!}::uuid,${cap},'deny')`;
  await expect(updateClaimType(admin,{id:typeId,name:'Forbidden type name',defaultTaxable:false,requiresReceipt:false})).rejects.toThrow();
  expect((await listClaimTypes(admin)).find(row=>row.id===typeId)?.name).toBe('Permitted type name');
  await setClaimPolicy(admin,{claimTypeId:typeId,annualBudget:1200,perClaimCap:100,effectiveFrom:'2026-01-01'});
  expect(await claimConfigurationWriteAccess(admin,[{kind:'claim_policy',claimTypeId:typeId,gradeId:null}])).toEqual([true]);
 }finally{
  await owner.client`delete from app.access_native_capability_default
   where capability_id like 'claims_configuration.%' or capability_id like 'function.claimsConfig.%' and capability_id not like 'function.claimsConfig.reimbursements.%'`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb
   where id like 'claims_configuration.%' or id like 'function.claimsConfig.%' and id not like 'function.claimsConfig.reimbursements.%'`;
 }
});
