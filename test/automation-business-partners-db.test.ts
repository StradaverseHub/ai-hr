/** Real app-role management and unchanged Contract/Probation business-PBP resolution. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {v9Setup} from '../packs/lifecycle/service';
import {assignContractRole,contractSharedTracker,saveContractSharedRole,saveContractSharedMember} from '../packs/contracts/service';
import {saveAutomationRouting} from '../packs/automation/service';
import {pgSqlState} from '../lib/db-error';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
type Rule={userId:string;rules:{businessGroup?:string[];company?:string[];department?:string[]}};
type Option={id:string;name:string};
type Workspace={revision:number;rules:Rule[];people:Option[];scopeLabels:Record<'businessGroup'|'company'|'department',Option[]>};
let b:Base,admin:SessionContext,bp:SessionContext,other:SessionContext,unitId:string,companyName:string;
const reason='Reviewed actual Contract and Probation Business Partner responsibilities';
beforeAll(migrateTestDb);afterAll(closeAll);
async function account(name:string,tenantId=b.tenantId,role:'employee'|'hr_admin'='employee'){
 const[person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${tenantId}::uuid,${name},${randomUUID()+'@bp-owner.invalid'}) returning id`);
 if(!person)throw Error('Actual fixture Person was not created');
 const userId=await createAppUser(tenantId,person.id,role);
 return{...admin,tenantId,userId,personId:person.id,roles:[role],grants:undefined};
}
const read=(ctx:SessionContext)=>withTenant(ctx,async tx=>{const[row]=await tx.execute<{value:Workspace}>(sql`select app.automation_business_partner_workspace() as value`);if(!row)throw Error('Native workspace receipt missing');return row.value;});
const save=(ctx:SessionContext,expected:number,rules:unknown,why=reason)=>withTenant(ctx,async tx=>{const[row]=await tx.execute<{value:Workspace}>(sql`select app.automation_business_partner_save(${expected},${JSON.stringify(rules)}::text::jsonb,${why}) as value`);if(!row)throw Error('Native save receipt missing');return row.value;});
const canManage=(ctx:SessionContext)=>withTenant(ctx,async tx=>{const[row]=await tx.execute<{ok:boolean}>(sql`select app.automation_business_partner_can_manage() as ok`);if(!row)throw Error('Native management decision missing');return row.ok;});
async function denied(operation:Promise<unknown>,code:string){let error:unknown;try{await operation;}catch(cause){error=cause;}expect(error).toBeDefined();expect(pgSqlState(error)).toBe(code);}
const current=()=>[{userId:bp.userId!,rules:{company:[b.companyId]}}];
const counts=()=>owner.db.execute<{history:number;events:number}>(sql`select (select count(*)::integer from automation_business_partner_config_revision where tenant_id=${b.tenantId}::uuid) as history,(select count(*)::integer from domain_event where tenant_id=${b.tenantId}::uuid and event_type='automation.businessPartners.saved') as events`);
async function contractSubject(){
 const today=todayInKualaLumpur(),start=today.slice(0,4)+'-01-01',end=(Number(today.slice(0,4))+1)+'-12-31';
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional native BP subject',primaryEmail:randomUUID()+'@bp-owner.invalid'},companyId:b.companyId,departmentId:b.deptA,businessUnitId:unitId,employmentType:'contract',hiredOn:start,provisionalEndOn:end});
 await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:4});return employee;
}
const optIn=(actor:SessionContext,to:string|null=null)=>assignContractRole(admin,{companyId:b.companyId,businessUnitId:null,userId:actor.userId,role:'pbp',from:'2020-01-01',to,reason:'Explicit current native Contract PBP opt-in'});
const facts=(ctx:SessionContext,employmentId:string)=>owner.withTenant(ctx,async tx=>{const[row]=await tx.execute<{user:string|null;scope:boolean;users:string[]}>(sql`select app.lifecycle_canonical_pbp_user(${employmentId}::uuid,null::uuid) as "user",app.lifecycle_canonical_pbp_scope(${b.companyId}::uuid,${unitId}::uuid,${ctx.userId}::uuid) as scope,array(select app.contract_pbp_users(${employmentId}::uuid)) as users`);if(!row)throw Error('Native responsibility fact missing');return row;});
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const[person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional BP administrator',${randomUUID()+'@bp-owner.invalid'}) returning id`);if(!person)throw Error('Administrator Person missing');
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${b.adminUserId}::uuid`);admin={...admin,personId:person.id};await v9Setup(admin);
 const[company]=await owner.db.execute<{name:string}>(sql`select legal_name as name from company where tenant_id=${b.tenantId}::uuid and id=${b.companyId}::uuid`);if(!company)throw Error('Actual company missing');companyName=company.name;
 bp=await account('Fictional selected Business Partner');other=await account('Fictional second Business Partner');
 const[unit]=await owner.db.execute<{id:string}>(sql`insert into business_unit(tenant_id,company_id,code,name) values(${b.tenantId}::uuid,${b.companyId}::uuid,${randomUUID()},'Fictional actual business unit') returning id`);if(!unit)throw Error('Actual business unit missing');unitId=unit.id;
});
describe('Native Business Partner responsibility owner',()=>{
 it('starts empty, atomically records real actor/history/event, and leaves retired On/Off configuration untouched',async()=>{
  const initial=await read(admin);expect(initial).toEqual({revision:0,rules:[],people:[],scopeLabels:{businessGroup:[],company:[],department:[]}});expect(await canManage(admin)).toBe(true);
  const tables=await owner.db.execute<{name:string;rls:boolean;forced:boolean}>(sql`select relname as name,relrowsecurity as rls,relforcerowsecurity as forced from pg_class where oid in ('public.automation_business_partner_config'::regclass,'public.automation_business_partner_config_revision'::regclass) order by relname`);
  expect(tables).toEqual([{name:'automation_business_partner_config',rls:true,forced:true},{name:'automation_business_partner_config_revision',rls:true,forced:true}]);
  const ports=await owner.db.execute<{signature:string;app:boolean;public:boolean}>(sql`select signature,has_function_privilege('ai_hr_app',signature,'EXECUTE') as app,exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=signature::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') as public from (values ('app.automation_business_partner_can_manage()'),('app.automation_business_partner_workspace()'),('app.automation_business_partner_save(integer,jsonb,text)'),('app.automation_business_partner_people(text)'),('app.automation_business_partner_scope_options(text,text)'),('app.automation_business_partner_history_immutable()'),('app.lifecycle_canonical_pbp_scope(uuid,uuid,uuid)'),('app.lifecycle_canonical_pbp_user(uuid,uuid)')) names(signature) order by signature`);
  expect(ports).toHaveLength(8);for(const port of ports){expect(port.public).toBe(false);expect(port.app).toBe(!port.signature.includes('history_immutable')&&!port.signature.includes('lifecycle_canonical'));}
  const[old]=await owner.db.execute<{data:unknown;revision:number}>(sql`select data,revision from lc_v9_config where tenant_id=${b.tenantId}::uuid`);
  const rules=[{userId:bp.userId!,rules:{businessGroup:[unitId],company:[b.companyId],department:[b.deptA]}}];const saved=await save(admin,0,rules);
  expect(saved.revision).toBe(1);expect(saved.rules).toEqual(rules);expect(saved.people).toEqual([{id:bp.userId,name:'Fictional selected Business Partner'}]);expect(saved.scopeLabels.businessGroup).toEqual([{id:unitId,name:'Fictional actual business unit · '+companyName}]);expect(saved.scopeLabels.company.map(row=>row.id)).toEqual([b.companyId]);expect(saved.scopeLabels.department.map(row=>row.id)).toEqual([b.deptA]);
  expect((await owner.db.execute(sql`select data,revision from lc_v9_config where tenant_id=${b.tenantId}::uuid`))[0]).toEqual(old);
  const[receipt]=await owner.db.execute<{revision:number;rules:Rule[];user:string;person:string;reason:string;event:string}>(sql`select h.revision,h.rules,h.actor_user_id as "user",h.actor_person_id as person,h.reason,e.event_type as event from automation_business_partner_config_revision h join domain_event e on e.id=h.event_id and e.tenant_id=h.tenant_id where h.tenant_id=${b.tenantId}::uuid`);
  expect(receipt).toEqual({revision:1,rules,user:admin.userId,person:admin.personId,reason,event:'automation.businessPartners.saved'});expect(await counts()).toEqual([{history:1,events:1}]);
  await denied(withTenant(admin,tx=>tx.execute(sql`select rules from automation_business_partner_config where tenant_id=${b.tenantId}::uuid`)),'42501');
  await denied(withTenant(admin,tx=>tx.execute(sql`update automation_business_partner_config set rules='[]'::jsonb where tenant_id=${b.tenantId}::uuid`)),'42501');
  await denied(owner.withTenant(admin,tx=>tx.execute(sql`update automation_business_partner_config_revision set reason='Attempted historical mutation must fail' where tenant_id=${b.tenantId}::uuid`)),'55000');
 });
 it('requires the actual tenant-wide group administrator, not company admin or Contract configuration capabilities',async()=>{
  const companyAccount=await account('Fictional company administrator',b.tenantId,'hr_admin');await owner.db.execute(sql`update role_assignment set company_id=${b.companyId}::uuid where tenant_id=${b.tenantId}::uuid and app_user_id=${companyAccount.userId}::uuid and role='hr_admin'`);
  const companyAdmin:SessionContext={...companyAccount,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const[scope]=await withTenant(companyAdmin,tx=>tx.execute<{current:boolean;company:boolean;group:boolean}>(sql`select app.principal_snapshot_current() as current,app.is_admin_for(${b.companyId}::uuid) as company,app.is_group_admin() as "group"`));expect(scope).toEqual({current:true,company:true,group:false});
  const configurer=await account('Fictional Contract-only configurer'),roleId=randomUUID();await saveContractSharedRole(admin,{id:roleId,name:'Contract configuration only',permissions:['workflows','templates','groups','access'],expectedRevision:0});await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:configurer.userId,companyId:null,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
  const[actual]=await withTenant(configurer,tx=>tx.execute<{allowed:boolean}>(sql`select app.automation_can_manage('contract_staff','workflows') as allowed`));expect(actual.allowed).toBe(true);
  for(const actor of [companyAdmin,configurer,bp]){expect(await canManage(actor)).toBe(false);await denied(read(actor),'42501');await denied(save(actor,0,current()),'42501');await denied(withTenant(actor,tx=>tx.execute(sql`select app.automation_business_partner_people('Fictional')`)),'42501');await denied(withTenant(actor,tx=>tx.execute(sql`select app.automation_business_partner_scope_options('company','Demo')`)),'42501');}
  expect(await counts()).toEqual([{history:0,events:0}]);expect((await read(admin)).revision).toBe(0);
 });
 it('enforces the real global lifecycle entitlement and real administrator Person even with a stale entitled context',async()=>{
  await setModule(b.tenantId,'lifecycle','disabled');expect(await canManage(admin)).toBe(false);await denied(read(admin),'42501');await denied(save(admin,0,current()),'42501');
  await setModule(b.tenantId,'lifecycle',null);await setModule(b.tenantId,'lifecycle','active',b.companyId);expect(await canManage(admin)).toBe(false);await denied(save(admin,0,current()),'42501');
  await setModule(b.tenantId,'lifecycle','active');expect(await canManage(admin)).toBe(true);
  await owner.db.execute(sql`update app_user set person_id=null where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);expect(await canManage(admin)).toBe(false);await denied(save(admin,0,current()),'42501');expect(await counts()).toEqual([{history:0,events:0}]);
 });
 it('refuses a stale or cross-tenant claimed principal at the native ports without creating configuration',async()=>{
  const foreign=await seedBase();expect(await canManage({...admin,tenantId:foreign.tenantId})).toBe(false);await denied(read({...admin,tenantId:foreign.tenantId}),'42501');
  // Actual grant deletion after this fixture's context was resolved leaves its claimed tenant-wide HR role stale.
  await owner.db.execute(sql`delete from role_assignment where tenant_id=${b.tenantId}::uuid and app_user_id=${admin.userId}::uuid and role='hr_admin'`);
  const[native]=await withTenant(admin,tx=>tx.execute<{current:boolean;allowed:boolean}>(sql`select app.principal_snapshot_current() as current,app.automation_business_partner_can_manage() as allowed`));expect(native).toEqual({current:false,allowed:false});await denied(read(admin),'42501');await denied(save(admin,0,current()),'42501');expect(await counts()).toEqual([{history:0,events:0}]);
 });
 it('rejects stale CAS independently of validity, with no duplicate history/event side effects',async()=>{
  await save(admin,0,current());await denied(save(admin,0,[{userId:other.userId!,rules:{company:[b.companyId]}}]),'40001');expect((await read(admin)).rules).toEqual(current());expect(await counts()).toEqual([{history:1,events:1}]);
  const attempts=await Promise.allSettled([save(admin,1,current()),save(admin,1,current())]);expect(attempts.filter(row=>row.status==='fulfilled')).toHaveLength(1);const failed=attempts.find(row=>row.status==='rejected');if(failed?.status!=='rejected')throw Error('Actual losing concurrent CAS receipt missing');expect(pgSqlState(failed.reason)).toBe('40001');expect((await read(admin)).revision).toBe(2);expect(await counts()).toEqual([{history:2,events:2}]);
 });
 it('rejects foreign, unavailable or unverified accounts and foreign/wrong-dimension scopes atomically',async()=>{
  const foreign=await seedBase(),foreignPerson=await account('Fictional foreign account',foreign.tenantId),unlinked=await createAppUser(b.tenantId,null,'employee'),blank=await account('   '),archived=await account('Fictional archived account');await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${b.tenantId}::uuid and id=${archived.userId}::uuid`);
  const invalid:unknown[]=[[{userId:foreignPerson.userId,rules:{}}],[{userId:unlinked,rules:{}}],[{userId:blank.userId,rules:{}}],[{userId:archived.userId,rules:{}}],[{userId:bp.userId,rules:{company:[foreign.companyId]}}],[{userId:bp.userId,rules:{department:[foreign.deptA]}}],[{userId:bp.userId,rules:{businessGroup:[b.companyId]}}],[{userId:bp.userId,rules:{jobTitle:[b.positionId]}}],[{userId:bp.userId,rules:{company:'not-an-array'}}],[{userId:bp.userId,rules:{company:['not-a-UUID']}}],[{userId:bp.userId,rules:{},extra:true}],Array.from({length:501},()=>({userId:bp.userId,rules:{}}))];
  for(const rules of invalid)await denied(save(admin,0,rules),'22023');await denied(save(admin,0,current(),'short reason'),'22023');expect((await read(admin)).rules).toEqual([]);expect(await counts()).toEqual([{history:0,events:0}]);
 });
 it('preserves specificity, distinct-person ambiguity and explicit Contract opt-in for both canonical and inline readers',async()=>{
  const employee=await contractSubject();await save(admin,0,current());expect((await facts(bp,employee.employmentId)).user).toBe(bp.userId);expect((await contractSharedTracker(bp)).total).toBe(0);await optIn(bp);expect((await facts(bp,employee.employmentId)).users).toEqual([bp.userId]);expect((await contractSharedTracker(bp)).total).toBe(1);
  const specific={userId:other.userId!,rules:{company:[b.companyId],department:[b.deptA]}};await save(admin,1,[...current(),specific]);await optIn(other);expect((await facts(other,employee.employmentId)).user).toBe(other.userId);expect((await contractSharedTracker(bp)).total).toBe(0);expect((await contractSharedTracker(other)).total).toBe(1);
  const third=await account('Fictional ambiguous Business Partner');await save(admin,2,[...current(),specific,{...specific,userId:third.userId!}]);expect((await facts(other,employee.employmentId)).user).toBeNull();expect((await facts(other,employee.employmentId)).users).toEqual([]);expect((await contractSharedTracker(other)).total).toBe(0);
 });
 it('retains expired opt-in and own-person exclusion without treating a configured responsibility as access',async()=>{
  const employee=await contractSubject();await save(admin,0,current());await optIn(bp,addDaysIso(todayInKualaLumpur(),-1));expect((await facts(bp,employee.employmentId)).user).toBe(bp.userId);expect((await facts(bp,employee.employmentId)).users).toEqual([]);expect((await contractSharedTracker(bp)).total).toBe(0);
  const selfId=await createAppUser(b.tenantId,employee.personId,'employee'),self={...admin,userId:selfId,personId:employee.personId,roles:['employee'],grants:undefined};await save(admin,1,[{userId:selfId,rules:{company:[b.companyId]}}]);await optIn(self);expect((await facts(self,employee.employmentId)).user).toBe(selfId);expect((await facts(self,employee.employmentId)).users).toEqual([]);expect((await contractSharedTracker(self)).total).toBe(0);
 });
 it('preserves Probation designated BP routing precedence over the new legacy fallback owner',async()=>{
  const employee=await contractSubject();await save(admin,0,current());
  const routed=()=>owner.withTenant(admin,async tx=>{const[row]=await tx.execute<{pbp:string|null;users:string[];source:string}>(sql`select pbp,pbp_users as users,pbp_source as source from app.probation_routed_holders(array[${employee.employmentId}::uuid])`);if(!row)throw Error('Actual Probation holder row missing');return row;});
  expect(await routed()).toMatchObject({pbp:null,users:[],source:'bpRules'});
  const[permission]=await withTenant(admin,tx=>tx.execute<{allowed:boolean}>(sql`select app.probation_config_admin(${b.companyId}::uuid) as allowed`));expect(permission.allowed).toBe(true);
  const[assignment]=await withTenant(admin,tx=>tx.execute<{id:string}>(sql`select app.probation_assign_access(${b.companyId}::uuid,${bp.userId}::uuid,'pbp','2020-01-01'::date,null::date,${unitId}::uuid,null::uuid,'Explicit current Probation Business Partner opt-in') as id`));expect(assignment.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(await routed()).toMatchObject({pbp:bp.userId,users:[bp.userId],source:'bpRules'});
  await saveAutomationRouting(admin,{routing:{id:'a0700000-0000-4000-8000-000000001001',name:'BP by business group',rows:[{match:{},assignTo:{kind:'people',userIds:[other.userId!]}}]},retired:false,expectedRevision:0,reason:'Explicit native shared Probation BP routing precedence'});
  expect(await routed()).toMatchObject({pbp:other.userId,users:[other.userId],source:'routing'});await save(admin,1,[]);expect(await routed()).toMatchObject({pbp:other.userId,users:[other.userId],source:'routing'});
 });
 it('distinguishes duplicate-named actual business units and departments by their own tenant company',async()=>{
  const[second]=await owner.db.execute<{id:string}>(sql`insert into company(tenant_id,legal_name) values(${b.tenantId}::uuid,'Fictional second responsibility company') returning id`);if(!second)throw Error('Second actual company missing');
  await owner.db.execute(sql`update business_unit set name='Repeated Ops' where tenant_id=${b.tenantId}::uuid and id=${unitId}::uuid`);await owner.db.execute(sql`update department set name='Repeated Ops' where tenant_id=${b.tenantId}::uuid and id=${b.deptA}::uuid`);
  const[unit]=await owner.db.execute<{id:string}>(sql`insert into business_unit(tenant_id,company_id,code,name) values(${b.tenantId}::uuid,${second.id}::uuid,${randomUUID()},'Repeated Ops') returning id`);const[department]=await owner.db.execute<{id:string}>(sql`insert into department(tenant_id,company_id,name) values(${b.tenantId}::uuid,${second.id}::uuid,'Repeated Ops') returning id`);if(!unit||!department)throw Error('Actual duplicate-name scopes missing');
  const lookup=(dimension:string)=>withTenant(admin,async tx=>{const[row]=await tx.execute<{value:Option[]}>(sql`select app.automation_business_partner_scope_options(${dimension},'Repeated Ops') as value`);if(!row)throw Error('Native scope result missing');return row.value;});
  const expected=['Repeated Ops · '+companyName,'Repeated Ops · Fictional second responsibility company'].sort();expect((await lookup('businessGroup')).map(row=>row.name).sort()).toEqual(expected);expect((await lookup('department')).map(row=>row.name).sort()).toEqual(expected);
  const saved=await save(admin,0,[{userId:bp.userId!,rules:{businessGroup:[unitId,unit.id],company:[b.companyId,second.id],department:[b.deptA,department.id]}}]);expect(saved.scopeLabels.businessGroup.map(row=>row.name).sort()).toEqual(expected);expect(saved.scopeLabels.department.map(row=>row.name).sort()).toEqual(expected);expect(saved.scopeLabels.company.map(row=>row.name).sort()).toEqual([companyName,'Fictional second responsibility company'].sort());
 });
 it('returns bounded deterministic search and every saved selected label without truncating rules',async()=>{
  for(let index=0;index<21;index++)await account('Fictional BP Search '+String(index).padStart(2,'0'));
  const[people]=await withTenant(admin,tx=>tx.execute<{value:Option[]}>(sql`select app.automation_business_partner_people('Fictional BP Search') as value`));expect(people.value).toHaveLength(20);expect(people.value[0].name).toBe('Fictional BP Search 00');expect(people.value.at(-1)?.name).toBe('Fictional BP Search 19');
  const units=await owner.db.execute<{id:string;name:string}>(sql`insert into business_unit(tenant_id,company_id,code,name) select ${b.tenantId}::uuid,${b.companyId}::uuid,'BP-SEARCH-'||lpad(n::text,2,'0'),'Fictional scope search '||lpad(n::text,2,'0') from generate_series(0,20) n returning id,name`);
  const[options]=await withTenant(admin,tx=>tx.execute<{value:Option[]}>(sql`select app.automation_business_partner_scope_options('businessGroup','Fictional scope search') as value`));expect(options.value).toHaveLength(20);expect(options.value.every(row=>units.some(unit=>unit.id===row.id))).toBe(true);expect(options.value.some(row=>row.id===b.companyId)).toBe(false);
  const saved=await save(admin,0,[{userId:bp.userId!,rules:{businessGroup:units.map(row=>row.id)}}]);expect(saved.scopeLabels.businessGroup).toHaveLength(21);expect(saved.rules[0].rules.businessGroup).toHaveLength(21);
  await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${b.tenantId}::uuid and id=${bp.userId}::uuid`);const unavailable=await read(admin);expect(unavailable.rules).toEqual(saved.rules);expect(unavailable.people).toEqual([]);
 });
});
