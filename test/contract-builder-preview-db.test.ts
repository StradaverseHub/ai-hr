import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {v9Setup} from '../packs/lifecycle/service';
import {saveContractSharedRole,saveContractSharedMember,contractSharedPage,contractTemplatePreviewCases,contractTemplatePreviewValues,contractRoutingPreviewCases,contractRoutingCheck} from '../packs/contracts/service';
import type {Routing} from '../lib/automation/routing';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional Contract administrator',${randomUUID()+'@contracts.test'}) returning id`);await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${b.adminUserId}::uuid`);admin={...admin,personId:person.id};await v9Setup(admin);});
async function ordinary(){
 const [p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional Contract operator',${randomUUID()+'@contracts.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 return {...admin,userId,personId:p.id,roles:['employee'],grants:undefined} as SessionContext;
}

async function seedScale(){
  await owner.db.execute(sql`
   with companies as (
    insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Contract scale company '||lpad(n::text,2,'0') from generate_series(1,70) n returning id,legal_name
   ), numbered as materialized(select id,row_number() over(order by legal_name) as n from companies), fixture as materialized(
    select series.n,gen_random_uuid() as person_id,gen_random_uuid() as employment_id,gen_random_uuid() as term_id,gen_random_uuid() as case_id,c.id as company_id
    from generate_series(1,1000) series(n) join numbered c on c.n=((series.n-1)%70)+1
   ), people as (
    insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Contract scale employee '||lpad(n::text,4,'0'),'scale-'||n||'@contracts.test' from fixture
   ), employments as (
    insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number)
    select employment_id,${b.tenantId}::uuid,person_id,company_id,'2026-01-01'::date,'SCALE-'||n,'2026-01-01'::date,'2027-12-31'::date,4 from fixture
   ), terms as (
    insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
    select term_id,${b.tenantId}::uuid,company_id,employment_id,1,'project','2026-01-01'::date,'2027-12-31'::date,'scale-fixture' from fixture
   )
   insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
   select case_id,${b.tenantId}::uuid,company_id,employment_id,term_id,'CT-2026-'||lpad(n::text,4,'0'),1,
    jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn','2026-01-01','endOn','2027-12-31'),'decision',NULL,'decisionDraft',NULL) from fixture`);
}
describe('Native Contract builder preview authority and source values',()=>{
 it('matches the real case-view page across70 companies/1000 employments and excludes current pay from template values',async()=>{
  await seedScale();admin={...await entitledCtx(b),personId:admin.personId};
  const native=await contractSharedPage(admin,{limit:20}),choices=await contractTemplatePreviewCases(admin);
  expect(choices.map(row=>row.id)).toEqual(native.rows.map(row=>row.id));expect(choices).toHaveLength(20);
  expect(choices[0].label).toContain('Contract scale employee 0001');
  const values=await contractTemplatePreviewValues(admin,choices[0].id);expect(values['employee.name']).toBe('Contract scale employee 0001');expect(values['contract.number']).toBe('4');expect(values['contract.salary']).toBe('');expect(JSON.stringify(values)).not.toMatch(/salaryCents|allowanceCents|bankAccount|passport/i);
  const editor=await ordinary(),roleId=randomUUID(),companyId=native.rows[0].companyId;
  await saveContractSharedRole(admin,{id:roleId,name:'One company template reviewer',permissions:['view','templates'],expectedRevision:0});await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:editor.userId,companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
  const scoped=await contractSharedPage(editor,{limit:20}),selected=await contractTemplatePreviewCases(editor);expect(selected.map(row=>row.id)).toEqual(scoped.rows.map(row=>row.id));expect(selected).toHaveLength(15);
  await expect(contractTemplatePreviewValues(editor,native.rows[1].id)).rejects.toMatchObject({code:'forbidden'});
 });
 it('requires separate template and actual case-view authority, with no writes or false identity',async()=>{
  await seedScale();admin={...await entitledCtx(b),personId:admin.personId};const cases=await contractSharedPage(admin,{limit:1}),editor=await ordinary(),roleId=randomUUID();
  await saveContractSharedRole(admin,{id:roleId,name:'Template editor only',permissions:['templates'],expectedRevision:0});await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:editor.userId,companyId:cases.rows[0].companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
  expect(await contractTemplatePreviewCases(editor)).toEqual([]);await expect(contractTemplatePreviewValues(editor,cases.rows[0].id)).rejects.toMatchObject({code:'forbidden'});
  await expect(contractRoutingPreviewCases(editor)).rejects.toMatchObject({code:'forbidden'});
  const nobody=await ordinary();await expect(contractTemplatePreviewCases(nobody)).rejects.toMatchObject({code:'forbidden'});
  await expect(withTenant(editor,tx=>tx.execute(sql`select * from contract_shared_case`))).rejects.toThrow();
 });
 it('checks only the selected matching routing row and real active named people, without simulating a fallback',async()=>{
  await seedScale();admin={...await entitledCtx(b),personId:admin.personId};const cases=await contractSharedPage(admin,{limit:1}),named=await ordinary();
  const routing:Routing={id:randomUUID(),name:'Fictional matching row',rows:[{match:{company:[cases.rows[0].companyId]},assignTo:{kind:'people',userIds:[named.userId!]}},{match:{},assignTo:{kind:'people',userIds:[admin.userId!]}}]};
  const checker=await ordinary(),roleId=randomUUID();await saveContractSharedRole(admin,{id:roleId,name:'Scoped routing checker',permissions:['view','groups'],expectedRevision:0});await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:checker.userId,companyId:cases.rows[0].companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
  expect(await contractRoutingCheck(checker,routing,cases.rows[0].id)).toEqual({employee:'Contract scale employee 0001',row:1,people:['Fictional Contract operator']});
  await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${b.tenantId}::uuid and id=${named.userId}::uuid`);
  expect(await contractRoutingCheck(admin,routing,cases.rows[0].id)).toEqual({employee:'Contract scale employee 0001',row:1,people:[]});
 });
});
