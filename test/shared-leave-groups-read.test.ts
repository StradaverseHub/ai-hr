/** 50d9b809 — the shared_leave_groups read (core/semantic-model/entities-leave-settings.ts, core/explainers/shared-leave-groups.ts),
 * served as the operations_status topic of the same name, over the real tool provider, capabilities, module switches and
 * AI Centre controls on fictional data.
 *
 *  - an HR administrator asking through operations_status gets exactly the Shared Leave Groups page's groups: name, member
 *    leave type names, shared limit, cap per application and employee placement, with the page as its provenance;
 *  - tenant isolation: another tenant's group never appears, and no id leaves the read;
 *  - an employee is never offered the topic, and the capability itself refuses them before reading (the page's requireAdmin);
 *  - the AI Centre child control read:shared_leave_groups (migration 4800) switches the read off on its own;
 *  - the declaration: configuration only, no identifier, its placements equal the leave service's own list.
 * Read only: nothing here writes a group through the AI. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {nativeToolProvider} from '../core/harness/tools';
import {createLeaveSharedGroup} from '../core/leave-shared-group';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {setAiCentreReadControl} from '../core/ai-centre-inventory';
import {ESS_PLACEMENTS} from '../lib/leave-groups';
import {LEAVE_SETTINGS_ENTITIES,LEAVE_SETTINGS_READS,SHARED_GROUP_PLACEMENTS,SHARED_LEAVE_GROUPS_PAGE} from '../core/semantic-model/entities-leave-settings';
import {TERAS_READS,terasEntity} from '../core/semantic-model/generate';
import {FOLDED_READS} from '../core/semantic-model/topic-tools';
import {KIT_CAPABILITIES} from '../core/improvement/kit-registry';
import type {SemanticField} from '../core/semantic-model/types';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const walk=(fields:readonly SemanticField[]):SemanticField[]=>fields.flatMap(field=>[field,...(field.of?walk(field.of):[])]);

describe('the declaration',()=>{
 it('is one administrators\' configuration read on the Shared Leave Groups page, folded into operations_status',()=>{
  expect(LEAVE_SETTINGS_READS.map(read=>[read.name,read.entity,read.input.length])).toEqual([['shared_leave_groups','shared_leave_group',0]]);
  const entity=terasEntity('shared_leave_group');
  expect(entity).toBe(LEAVE_SETTINGS_ENTITIES[0]);
  expect(entity).toMatchObject({module:'leave',audience:'admin',sensitivity:'ordinary',page:'/admin/leave-config/shared-groups'});
  expect(SHARED_LEAVE_GROUPS_PAGE).toBe('/admin/leave-config/shared-groups');
  expect(entity.owners).toEqual(['core/leave-shared-group.ts#listLeaveSharedGroups','core/read.ts#listLeaveTypes']);
  expect(TERAS_READS.some(read=>read.name==='shared_leave_groups')).toBe(true);
  expect(FOLDED_READS.get('shared_leave_groups')).toEqual({tool:'operations_status',topic:'shared_leave_groups'});
  expect(TERAS_CAPABILITIES.find(row=>row.name==='shared_leave_groups')).toMatchObject({module:'leave',admin:true,worker:null});
  expect(TERAS_CAPABILITIES.find(row=>row.name==='shared_leave_groups')!.topic).toBeUndefined();
  expect(KIT_CAPABILITIES.find(row=>row.read.name==='shared_leave_groups')?.binding).toMatchObject({module:'leave',admin:true,owner:'core/leave-shared-group.ts#listLeaveSharedGroups'});
 });
 it('returns only configuration: no identifier, no person, no free text; group names minimum, leave type names screened',()=>{
  const fields=walk(terasEntity('shared_leave_group').fields);
  expect(fields.filter(field=>['id','code','text','name'].includes(field.type))).toEqual([]);
  const groups=terasEntity('shared_leave_group').fields.find(field=>field.name==='groups')!;
  expect(groups.of!.map(field=>[field.name,field.type,field.disclosure])).toEqual([
   ['name','label','minimum'],['leaveTypes','list','full'],['sharedLimitDays','number','full'],['maxDaysPerApplication','number','full'],['employeePlacement','enum','full']]);
  expect(groups.of!.find(field=>field.name==='leaveTypes')!.of).toEqual([expect.objectContaining({name:'name',type:'label',disclosure:'full',screen:'sensitive_label'})]);
  // The placement vocabulary is the leave service's own, repeated so the model imports no service.
  expect([...SHARED_GROUP_PLACEMENTS]).toEqual([...ESS_PLACEMENTS]);
 });
});

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-shared-groups-passphrase');await resetDb();base=await seedBase();
 await setModule(base.tenantId,'assistant','active');});

type Grant={role:typeof schema.roleAssignment.$inferInsert['role'];companyId:string|null};
async function person(name:string,grants:readonly Grant[]):Promise<SessionContext>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'user_'+randomUUID(),personId:hired.personId}).returning({id:schema.appUser.id});
 for(const grant of grants)await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:grant.companyId,role:grant.role});
 await grantAssistant(adminCtx(base),{appUserId:user.id});
 const roles=[...new Set(grants.map(grant=>grant.role))];
 return{...await entitledCtx(base,roles),userId:user.id,personId:hired.personId,roles,grants:[...grants]} as SessionContext;
}
async function leaveType(tenantId:string,name:string):Promise<string>{
 const [row]=await owner.db.insert(schema.leaveType).values({tenantId,code:'SLG'+randomUUID().slice(0,6).toUpperCase(),name,paid:true,counting:'calendar_days'}).returning({id:schema.leaveType.id});
 return row.id;
}
const bound=async(ctx:SessionContext)=>(await nativeToolProvider(ctx,{companyId:base.companyId,locale:'en'},true)).bindings;
const operationsOf=async(ctx:SessionContext)=>{const binding=(await bound(ctx)).find(row=>row.name==='operations_status');if(!binding)throw Error('operations_status is not bound');return binding;};

/** Two groups in this tenant (one capped and shown first, one uncapped and hidden) and one in another tenant. */
async function fixture(){
 const admin=adminCtx(base);
 const [marriage,compassionate,exam,study]=[await leaveType(base.tenantId,'Fictional Marriage Leave'),await leaveType(base.tenantId,'Fictional Compassionate Leave'),
  await leaveType(base.tenantId,'Fictional Exam Leave'),await leaveType(base.tenantId,'Fictional Study Leave')];
 await createLeaveSharedGroup(admin,{name:'Fictional Special Leave',totalLimitDays:10,maxDaysPerApplication:3,essPlacement:'primary',leaveTypeIds:[marriage,compassionate]});
 await createLeaveSharedGroup(admin,{name:'Fictional Study and Exam',totalLimitDays:7.5,maxDaysPerApplication:null,essPlacement:'hidden',leaveTypeIds:[study,exam]});
 const other=await seedBase();
 const [otherA,otherB]=[await leaveType(other.tenantId,'Other Tenant Leave A'),await leaveType(other.tenantId,'Other Tenant Leave B')];
 await createLeaveSharedGroup(adminCtx(other),{name:'Other Tenant Pool',totalLimitDays:4,leaveTypeIds:[otherA,otherB]});
 return{ids:[marriage,compassionate,exam,study,otherA,otherB,other.tenantId]};
}

describe('an HR administrator asking through operations_status',()=>{
 it('gets exactly the page\'s groups, their leave types, limits and placement, and nothing from another tenant',async()=>{
  const {ids}=await fixture();
  const hr=await person('Fictional Groups Admin',[{role:'hr_admin',companyId:base.companyId}]);
  const run=await (await operationsOf(hr)).run({topic:'shared_leave_groups'});
  expect(run.ok).toBe(true);
  const content=run.content as {ok:boolean;groups:unknown[];provenance:{owner:string;page:string}};
  expect(content.ok).toBe(true);
  expect(content.groups).toEqual([
   {name:'Fictional Special Leave',leaveTypes:[{name:'Fictional Compassionate Leave'},{name:'Fictional Marriage Leave'}],sharedLimitDays:10,maxDaysPerApplication:3,employeePlacement:'primary'},
   {name:'Fictional Study and Exam',leaveTypes:[{name:'Fictional Exam Leave'},{name:'Fictional Study Leave'}],sharedLimitDays:7.5,maxDaysPerApplication:null,employeePlacement:'hidden'},
  ]);
  expect(content.provenance).toMatchObject({owner:'core/leave-shared-group.ts#listLeaveSharedGroups',page:'/admin/leave-config/shared-groups'});
  // Exactly the declared keys, and no id of any group, leave type or tenant.
  expect(Object.keys(content).sort()).toEqual(['groups','ok','provenance']);
  const text=JSON.stringify(content);
  expect(text).not.toContain('Other Tenant');
  for(const id of [...ids,base.tenantId])expect(text).not.toContain(id);
 },60000);

 it('says there is no group when none is configured',async()=>{
  const hr=await person('Fictional Empty Groups Admin',[{role:'hr_admin',companyId:base.companyId}]);
  const run=await (await operationsOf(hr)).run({topic:'shared_leave_groups'});
  expect(run).toMatchObject({ok:true,content:{ok:true,groups:[]}});
 },60000);

 it('is switched off on its own by its AI Centre control, leaving the other operations topics answering',async()=>{
  await fixture();
  const group=await person('Fictional Groups Group Admin',[{role:'hr_admin',companyId:null}]);
  const operations=await operationsOf(group);
  await setAiCentreReadControl(group,'read:shared_leave_groups',false);
  const off=await operations.run({topic:'shared_leave_groups'}).then(result=>result,()=>({ok:false}));
  expect(off.ok).toBe(false);
  expect(await operations.run({topic:'loops'})).toMatchObject({ok:true});
  await setAiCentreReadControl(group,'read:shared_leave_groups',true);
  expect(await operations.run({topic:'shared_leave_groups'})).toMatchObject({ok:true,content:{ok:true}});
 },60000);
});

describe('anyone who is not an administrator',()=>{
 it('is never offered the topic, and the capability refuses them before reading anything',async()=>{
  await fixture();
  const employee=await person('Fictional Groups Employee',[{role:'employee',companyId:null}]);
  const names=(await bound(employee)).map(row=>row.name);
  expect(names).not.toContain('operations_status');expect(names).not.toContain('shared_leave_groups');
  const capability=TERAS_CAPABILITIES.find(row=>row.name==='shared_leave_groups')!;
  const refused=await capability.run(employee,{},{companyId:base.companyId});
  expect(refused).toMatchObject({ok:false,refusal:'not_permitted'});
  expect(JSON.stringify(refused)).not.toContain('Fictional Special Leave');
 },60000);
});
