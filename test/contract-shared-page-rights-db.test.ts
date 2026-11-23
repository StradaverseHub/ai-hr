/** 7150: the Contract list evaluates company-level rights once per company. It must return exactly what the original
 * 6314 list returned, for every kind of access, and must not run the permission check once per case for a user
 * whose company rights already permit every case. The original list is recreated from its own migration source. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,createAppUser,owner,type Base} from './harness';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');});

const ORACLE='app.contract_shared_page_6314_oracle';
function originalListSource(){
 const migration=readFileSync(new URL('../db/migrations/6314_contract_shared_projections.sql',import.meta.url),'utf8');
 const head='CREATE FUNCTION app.contract_shared_page(';
 const start=migration.indexOf(head),end=migration.indexOf('$$;',start)+3;
 const statement=migration.slice(start,end);
 if(!statement.includes("WHERE app.contract_shared_case_permitted(c.id,'view') AND"))throw Error('The original 6314 Contract list oracle changed');
 return statement.replace(head,`CREATE FUNCTION ${ORACLE}(`);
}
async function withOracle<T>(fn:()=>Promise<T>):Promise<T>{
 await owner.client.unsafe(originalListSource());
 try{return await fn();}finally{await owner.client.unsafe(`DROP FUNCTION ${ORACLE}(text,integer,integer)`);}
}
type Page={rows:{id:string;companyId:string}[]};
async function pages(userId:string,search:string,limit:number,offset:number){
 return owner.client.begin(async connection=>{
  await connection`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${userId},true),set_config('jit','off',true)`;
  const [live]=await connection<{page:Page}[]>`select app.contract_shared_page(${search},${limit},${offset}) as page`;
  const [original]=await connection.unsafe<{page:Page}[]>(`select ${ORACLE}($1,$2,$3) as page`,[search,limit,offset]);
  return {live:live.page,original:original.page};
 });
}

async function company(name:string,parent:string|null=null){
 const [row]=await owner.db.execute<{id:string}>(sql`insert into company(tenant_id,legal_name,parent_company_id) values(${b.tenantId}::uuid,${name},${parent}::uuid) returning id`);return row.id;
}
async function employee(name:string,companyId:string){
 const [p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${randomUUID()+'@rights.test'}) returning id`);
 const [e]=await owner.db.execute<{id:string}>(sql`insert into employment(tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number)
  values(${b.tenantId}::uuid,${p.id}::uuid,${companyId}::uuid,'2020-01-01'::date,${'R-'+randomUUID().slice(0,8)},'2026-01-01'::date,'2027-12-31'::date,2) returning id`);
 return {personId:p.id,employmentId:e.id};
}
async function contractCase(employmentId:string,companyId:string,number:string){
 const [term]=await owner.db.execute<{id:string}>(sql`insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
  values(gen_random_uuid(),${b.tenantId}::uuid,${companyId}::uuid,${employmentId}::uuid,1,'project','2026-01-01'::date,'2027-12-31'::date,'rights-fixture') returning id`);
 await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
  values(gen_random_uuid(),${b.tenantId}::uuid,${companyId}::uuid,${employmentId}::uuid,${term.id}::uuid,${number},1,
   jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn','2026-01-01','endOn','2027-12-31'),'decision',NULL,'decisionDraft',NULL))`);
}
async function user(name:string,companyId:string){
 const person=await employee(name,companyId);
 return {...person,userId:await createAppUser(b.tenantId,person.personId,'employee')};
}
async function grant(userId:string,permissions:string[],scope:{companyId?:string;groupId?:string},extra:{validTo?:string;revoked?:boolean}={}){
 const roleId=randomUUID();
 await owner.db.execute(sql`insert into contract_access_role(tenant_id,id,name,permissions,updated_by) values(${b.tenantId}::uuid,${roleId}::uuid,${'Rights '+roleId.slice(0,8)},${`{${permissions.join(',')}}`}::text[],${b.adminUserId}::uuid)`);
 await owner.db.execute(sql`insert into contract_access_member(tenant_id,role_id,user_id,company_id,business_group_id,valid_from,valid_to,revoked_at,created_by)
  values(${b.tenantId}::uuid,${roleId}::uuid,${userId}::uuid,${scope.companyId??null}::uuid,${scope.groupId??null}::uuid,'2020-01-01'::date,${extra.validTo??null}::date,${extra.revoked?sql`now()`:sql`null`},${b.adminUserId}::uuid)`);
}

describe('Contract list company rights (7150)',()=>{
 it('returns exactly the original 6314 list for every kind of Contract access',async()=>{
  const [admin]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional rights administrator',${randomUUID()+'@rights.test'}) returning id`);
  await owner.db.execute(sql`update app_user set person_id=${admin.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${b.adminUserId}::uuid`);
  const group=await company('Fictional Rights Group'),first=await company('Fictional Rights S1',group),second=await company('Fictional Rights S2',group),other=await company('Fictional Rights C3');
  const cases:Record<string,string[]>={};let n=0;
  for(const [label,companyId] of [['group',group],['first',first],['second',second],['other',other]] as const){
   cases[label]=[];
   for(let i=0;i<3;i++){const e=await employee(`Fictional rights ${label} ${i}`,companyId);await contractCase(e.employmentId,companyId,`CT-R-${++n}`);cases[label].push(e.employmentId);}
  }
  // A case whose employment has since moved company is not company-current and is not listed by either source.
  const moved=await employee('Fictional rights moved',first);await contractCase(moved.employmentId,first,'CT-R-moved');
  await owner.db.execute(sql`update employment set company_id=${second}::uuid where id=${moved.employmentId}::uuid`);
  // A blacklisted employment is filtered by both.
  const blacklisted=await employee('Fictional rights blacklisted',other);await contractCase(blacklisted.employmentId,other,'CT-R-blacklisted');
  await owner.db.execute(sql`update employment set blacklisted_at=now() where id=${blacklisted.employmentId}::uuid`);

  const firstMember=await user('Fictional rights first member',b.companyId);await grant(firstMember.userId,['view'],{companyId:first});
  const groupMember=await user('Fictional rights group member',b.companyId);await grant(groupMember.userId,['view'],{groupId:group});
  const revoked=await user('Fictional rights revoked member',b.companyId);await grant(revoked.userId,['view'],{companyId:second},{revoked:true});
  const expired=await user('Fictional rights expired member',b.companyId);await grant(expired.userId,['view'],{companyId:other},{validTo:'2021-12-31'});
  const templates=await user('Fictional rights templates member',b.companyId);await grant(templates.userId,['templates'],{companyId:other});
  const tenantWide=await user('Fictional rights tenant member',b.companyId);await grant(tenantWide.userId,['view'],{});
  // The superior has no company rights: every case they see comes from the per-employment check.
  const superior=await user('Fictional rights superior',second);
  for(const subordinate of [cases.second[0],cases.other[0],cases.first[1]])
   await owner.db.execute(sql`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from) values(${b.tenantId}::uuid,${subordinate}::uuid,${superior.employmentId}::uuid,'administrative','2020-01-01'::date)`);
  await owner.db.execute(sql`insert into contract_shared_settings(tenant_id,company_id,superior_enabled,updated_by) values(${b.tenantId}::uuid,${other}::uuid,false,${b.adminUserId}::uuid)`);
  await owner.db.execute(sql`insert into contract_shared_settings(tenant_id,company_id,superior_permissions,updated_by) values(${b.tenantId}::uuid,${first}::uuid,'{decide}'::text[],${b.adminUserId}::uuid)`);
  const nobody=await user('Fictional rights nobody',b.companyId);
  const blank=await user('   ',b.companyId);await grant(blank.userId,['view'],{companyId:first});

  const users={admin:b.adminUserId,firstMember:firstMember.userId,groupMember:groupMember.userId,revoked:revoked.userId,expired:expired.userId,
   templates:templates.userId,tenantWide:tenantWide.userId,superior:superior.userId,nobody:nobody.userId,blank:blank.userId};
  const counts:Record<string,number>={};
  await withOracle(async()=>{
   for(const [label,userId] of Object.entries(users))for(const [search,limit,offset] of [['',100,0],['',2,1],['Rights S1',100,0],['rights other',100,0]] as const){
    const {live,original}=await pages(userId,search,limit,offset);
    expect(live,`${label} ${search} ${limit}/${offset}`).toEqual(original);
    if(search===''&&limit===100)counts[label]=live.rows.length;
   }
  });
  // The comparison exercised both branches: company grants (admin, members) and the per-employment superior grant.
  expect(counts).toEqual({admin:12,firstMember:3,groupMember:9,revoked:0,expired:0,templates:0,tenantWide:12,superior:1,nobody:0,blank:0});
 });

 it('checks company rights once per company and no case-level permission for a user whose company rights permit every case',async()=>{
  await owner.db.execute(sql`
   with companies as (
    insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Rights scale company '||lpad(n::text,2,'0') from generate_series(1,70) n returning id,legal_name
   ), numbered as materialized(select id,row_number() over(order by legal_name) as n from companies), fixture as materialized(
    select series.n,gen_random_uuid() as person_id,gen_random_uuid() as employment_id,gen_random_uuid() as term_id,c.id as company_id
    from generate_series(1,1000) series(n) join numbered c on c.n=((series.n-1)%70)+1
   ), people as (
    insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Rights scale employee '||lpad(n::text,4,'0'),'rights-scale-'||n||'@rights.test' from fixture
   ), employments as (
    insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number)
    select employment_id,${b.tenantId}::uuid,person_id,company_id,'2026-01-01'::date,'RS-'||n,'2026-01-01'::date,'2027-12-31'::date,4 from fixture
   ), terms as (
    insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
    select term_id,${b.tenantId}::uuid,company_id,employment_id,1,'project','2026-01-01'::date,'2027-12-31'::date,'rights-scale' from fixture
   )
   insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
   select gen_random_uuid(),${b.tenantId}::uuid,company_id,employment_id,term_id,'CT-RS-'||lpad(n::text,4,'0'),1,
    jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn','2026-01-01','endOn','2027-12-31'),'decision',NULL,'decisionDraft',NULL) from fixture`);
  const [admin]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional rights administrator',${randomUUID()+'@rights.test'}) returning id`);
  await owner.db.execute(sql`update app_user set person_id=${admin.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${b.adminUserId}::uuid`);
  const [scale]=await owner.db.execute<{id:string}>(sql`select id from company where tenant_id=${b.tenantId}::uuid and legal_name='Rights scale company 07'`);
  const member=await user('Fictional rights scale member',b.companyId);await grant(member.userId,['view'],{companyId:scale.id});
  await owner.client.unsafe('analyze');
  // Exact results at the 70-company shape, for the administrator and a one-company member, first and last pages.
  await withOracle(async()=>{
   for(const userId of [b.adminUserId,member.userId])for(const offset of [0,950]){
    const {live,original}=await pages(userId,'',100,offset);
    expect(live,`${userId} ${offset}`).toEqual(original);
   }
  });
  // Machine-speed independent: one company-level check per company with cases, none per case.
  const calls=await owner.client.begin(async connection=>{
   await connection`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${b.adminUserId},true),set_config('jit','off',true),set_config('track_functions','all',true)`;
   const count=async()=>Object.fromEntries((await connection<{funcname:string;calls:number}[]>`select funcname,sum(calls)::int as calls from pg_stat_xact_user_functions where schemaname='app' and funcname in('contract_shared_permitted','contract_shared_case_permitted') group by funcname`).map(row=>[row.funcname,row.calls]));
   const before=await count();
   const [page]=await connection<{page:Page}[]>`select app.contract_shared_page('',1,0) as page`;
   expect(page.page.rows).toHaveLength(2);
   const after=await count();
   return {permitted:(after.contract_shared_permitted??0)-(before.contract_shared_permitted??0),casePermitted:(after.contract_shared_case_permitted??0)-(before.contract_shared_case_permitted??0)};
  });
  expect(calls).toEqual({permitted:70,casePermitted:0});
 },180_000);
});
