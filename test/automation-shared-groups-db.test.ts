import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {v9Setup} from '../packs/lifecycle/service';
import {automationGroupWorkspace,saveAutomationAssignmentGroups,searchAutomationGroupPeople} from '../packs/automation/service';
import {saveContractSharedMember,saveContractSharedRole,contractSharedAccess} from '../packs/contracts/service';
let b:Base,admin:SessionContext,editor:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional configuration administrator',${randomUUID()+'@groups.invalid'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where id=${b.adminUserId}::uuid`);admin={...admin,personId:person.id};await v9Setup(admin);
 const [subject]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional assignment group editor',${randomUUID()+'@groups.invalid'}) returning id`);
 const userId=await createAppUser(b.tenantId,subject.id,'employee');editor={...admin,userId,personId:subject.id,roles:['employee'],grants:undefined};
 const roleId=randomUUID();await saveContractSharedRole(admin,{id:roleId,name:'Shared group editor only',permissions:['groups'],expectedRevision:0});
 await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId,companyId:b.companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
});
const input=async()=>{const view=await automationGroupWorkspace(editor);if(!view)throw new Error('Expected authorized shared groups.');return view;};
describe('Shared assignment groups through the exact Contract groups grant',()=>{
 it('edits canonical members and the V9 projection atomically while preserving every unrelated setting and case grant',async()=>{
  const view=await input(),before=await owner.db.execute<{native:unknown;v9:unknown}>(sql`select n.data-'groups' as native,v.data-ARRAY['groups','groupsRevision','revision'] as v9 from lc_onboarding_config n join lc_v9_config v on v.tenant_id=n.tenant_id where n.tenant_id=${b.tenantId}::uuid`);
  const id=randomUUID(),groups=[...view.groups,{id,name:'Fictional Contract reviewers',members:[editor.userId!],limit:12}];
  const saved=await saveAutomationAssignmentGroups(editor,{revision:view.revision,v9Revision:view.v9Revision,groups,reason:'Actual group-only grant adds a shared group'});
  expect(saved.revision).toBe(view.revision+1);expect(saved.v9Revision).toBe(view.v9Revision!+1);expect(saved.groups.find(group=>group.id===id)).toEqual(groups.at(-1));
  const after=await owner.db.execute<{native:unknown;v9:unknown}>(sql`select n.data-'groups' as native,v.data-ARRAY['groups','groupsRevision','revision'] as v9 from lc_onboarding_config n join lc_v9_config v on v.tenant_id=n.tenant_id where n.tenant_id=${b.tenantId}::uuid`);
  expect(after).toEqual(before);
  const [rows]=await owner.db.execute<{native:unknown;v9:unknown}>(sql`select n.data->'groups' as native,v.data->'groups' as v9 from lc_onboarding_config n join lc_v9_config v on v.tenant_id=n.tenant_id where n.tenant_id=${b.tenantId}::uuid`);
  expect(rows.native).toEqual(groups);expect(rows.v9).toEqual(groups);
  expect((await searchAutomationGroupPeople(editor,'assignment group')).map(person=>person.id)).toContain(editor.userId);
  await expect(contractSharedAccess(editor)).rejects.toMatchObject({code:'forbidden'});
  const [rights]=await withTenant(editor,tx=>tx.execute<{view:boolean;pay:boolean;templates:boolean}>(sql`select app.contract_shared_permitted('view',${b.companyId}::uuid) as view,app.contract_shared_permitted('seePay',${b.companyId}::uuid) as pay,app.automation_can_manage('contract_staff','templates') as templates`));
  expect(rights).toEqual({view:false,pay:false,templates:false});
  await expect(withTenant(editor,tx=>tx.execute(sql`update lc_v9_config set data=data||'{"peopleOpsGroup":"unrelated"}'::jsonb where tenant_id=${b.tenantId}::uuid returning tenant_id`))).resolves.toHaveLength(0);
 });
 it('rejects stale native and V9 revisions, deletion, duplicate members and foreign tenant accounts without writes',async()=>{
  const view=await input(),request={revision:view.revision,v9Revision:view.v9Revision,groups:view.groups,reason:'A checked configuration change'};
  await expect(saveAutomationAssignmentGroups(editor,{...request,revision:view.revision+1})).rejects.toMatchObject({code:'conflict'});
  await expect(saveAutomationAssignmentGroups(editor,{...request,v9Revision:view.v9Revision!+1})).rejects.toMatchObject({code:'conflict'});
  expect(view.groups.length).toBeGreaterThan(0);
  await expect(saveAutomationAssignmentGroups(editor,{...request,groups:view.groups.slice(1)})).rejects.toMatchObject({code:'invalid'});
  await expect(saveAutomationAssignmentGroups(editor,{...request,groups:[...view.groups,{id:randomUUID(),name:'Duplicates',members:[editor.userId!,editor.userId!],limit:20}]})).rejects.toMatchObject({code:'invalid'});
  await expect(saveAutomationAssignmentGroups(editor,{...request,groups:[...view.groups,{id:randomUUID(),name:'Foreign member',members:[randomUUID()],limit:20}]})).rejects.toMatchObject({code:'invalid'});
  expect(await input()).toEqual(view);
 });
 it('reads only group facts across 70 companies and 1,000 employments, including a company-scoped groups grant',async()=>{
  const before=await input();
  await owner.db.execute(sql`with companies as(insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Group fixture company '||n from generate_series(1,70) n returning id),
   numbered as materialized(select id,row_number() over(order by id) as n from companies),fixture as materialized(select s.n,gen_random_uuid() as person_id,c.id as company_id from generate_series(1,1000) s(n) join numbered c on c.n=((s.n-1)%70)+1),
   people as(insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Unrelated employment '||n,'groups-scale-'||n||'@groups.invalid' from fixture)
   insert into employment(tenant_id,person_id,company_id,hired_on,employee_code) select ${b.tenantId}::uuid,person_id,company_id,'2026-01-01'::date,'GROUP-SCALE-'||n from fixture`);
  expect(await input()).toEqual(before);
  const allAdmin={...await entitledCtx(b),personId:admin.personId};
  expect((await automationGroupWorkspace(allAdmin))?.groups).toEqual(before.groups);
  const nobody={...editor,userId:randomUUID(),personId:undefined};
  expect(await automationGroupWorkspace(nobody)).toBeNull();expect(await searchAutomationGroupPeople(nobody,'Fictional')).toEqual([]);
 });
});
