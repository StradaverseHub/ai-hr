/** Hosted disposable native setup, then read-only measurement under the literal restricted owner. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {basename,join,resolve,sep} from 'node:path';
import type {SessionContext} from '../../db/client';
import type {RestrictedNavigationRuntimeReceipt} from './contract-navigation-restricted-owner-runtime';
import type {BusinessPartnerRule} from '../../lib/automation/business-partners';
type Prepared={tenantId:string;companyId:string;subjectEmploymentId:string;ambiguousEmploymentId:string;users:Record<string,string>;businessPartner:{revision:number;rules:BusinessPartnerRule[]}};
type Right={employment_id:string;can_view:boolean|null;can_decide:boolean|null};
const RESULT='CONTRACT_NAVIGATION_OWNER_RESULT ';
async function main(){
 assert.ok(process.execArgv.includes('--conditions=react-server'));
 const phase=process.env.CONTRACT_NAVIGATION_OWNER_RUNTIME_PHASE,database=process.env.CONTRACT_NAVIGATION_OWNER_RUNTIME_DATABASE;
 const nonce=process.env.CONTRACT_NAVIGATION_OWNER_RUNTIME_NONCE,folder=process.env.CONTRACT_NAVIGATION_OWNER_RUNTIME_FOLDER,temp=process.env.RUNNER_TEMP;
 assert.ok(phase==='prepare'||phase==='measure');assert.ok(database&&/^ai_hr_test_w_aifocus[1-9][0-9]*$/.test(database));assert.ok(nonce&&/^[0-9a-f-]{36}$/.test(nonce));assert.ok(folder&&temp);
 assert.equal(realpathSync(folder),resolve(folder));assert.equal(realpathSync(temp),resolve(temp));assert.ok(folder.startsWith(realpathSync(temp)+sep));assert.ok(basename(folder).startsWith('aihr-contract-navigation-owner-runtime-'));
 for(const[key,value]of Object.entries({GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',NODE_ENV:'test',WORKER_DB:'0',TEST_DB_NAMESPACE:'aifocus'}))assert.equal(process.env[key],value);assert.equal(process.platform,'linux');
 const candidate=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();assert.equal(candidate,process.env.AIHR_CI_HEAD);
 assert.deepEqual(JSON.parse(readFileSync(join(folder,'binding.json'),'utf8')),{version:1,database,nonce,candidate,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT});
 const urls=()=>{for(const[key,user]of [['TEST_DATABASE_URL','ai_hr_app'],['DATABASE_URL','ai_hr_app'],['TEST_MIGRATION_DATABASE_URL',phase==='measure'?'ai_hr_owner':'postgres'],['MIGRATION_DATABASE_URL',phase==='measure'?'ai_hr_owner':'postgres']]as const){const u=new URL(process.env[key]??'');assert.ok(['postgres:','postgresql:'].includes(u.protocol));assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'5433');assert.equal(u.username,user);assert.equal(u.pathname,'/'+database);assert.equal(u.password+u.search+u.hash,'');}};urls();await import('../env');urls();
 const {sql}=await import('drizzle-orm'),{owner,closeAll,createAppUser}=await import('../harness');
 const {createDb}=await import('../../db/client');
 const {contractPostingFixture}=await import('./contract-posting-fixture');
 const {saveContractSharedRole,saveContractSharedMember,contractSharedSettings,saveContractSharedSettings}=await import('../../packs/contracts/service');
 const {hireEmployee,setEmploymentInfo}=await import('../../core/org');
 const {assignRole}=await import('../../core/admin');
 const {automationBusinessPartnerWorkspace,saveAutomationBusinessPartners}=await import('../../packs/automation/service');
 const {resolveEntitlementsTx}=await import('../../core/entitlements');
 try{
  const[bound]=await owner.db.execute<{nonce:string;candidate:string;database_name:string}>(sql`select nonce,candidate,database_name from app._test_contract_navigation_owner_runtime_binding`);assert.deepEqual(bound,{nonce,candidate,database_name:database});
  if(phase==='prepare'){
   const f=await contractPostingFixture({future:false,payChanges:false}),b=f.b,start=f.start,end=f.end;
  await owner.db.execute(sql`with companies as(insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Tracker company '||lpad(n::text,2,'0') from generate_series(1,70) n returning id,legal_name),departments as(insert into department(tenant_id,company_id,name) select ${b.tenantId}::uuid,id,'Tracker department' from companies returning id,company_id),numbered as materialized(select c.id,d.id as department_id,row_number() over(order by c.legal_name) as n from companies c join departments d on d.company_id=c.id),fixture as materialized(select series.n,gen_random_uuid() as person_id,gen_random_uuid() as employment_id,c.id as company_id,c.department_id from generate_series(1,1000) series(n) join numbered c on c.n=((series.n-1)%70)+1),people as(insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Tracker employee '||lpad(n::text,4,'0'),'scale-'||n||'@tracker.test' from fixture),employments as(insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number) select employment_id,${b.tenantId}::uuid,person_id,company_id,${start}::date,'SCALE-'||n,${start}::date,${end}::date,4 from fixture) insert into assignment(id,tenant_id,employment_id,company_id,department_id,employment_type,valid_from) select gen_random_uuid(),${b.tenantId}::uuid,employment_id,company_id,department_id,'contract',${start}::date from fixture`);
   const companies=await owner.db.execute<{id:string;departmentId:string}>(sql`select c.id,d.id as "departmentId" from company c join department d on d.tenant_id=c.tenant_id and d.company_id=c.id where c.tenant_id=${b.tenantId}::uuid and c.legal_name like 'Tracker company %' order by c.legal_name`);assert.equal(companies.length,70);
   async function actor():Promise<SessionContext>{const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional navigation scope actor',${randomUUID()+'@navigation.test'}) returning id`);const userId=await createAppUser(b.tenantId,p.id,'employee');return {...f.admin,userId,personId:p.id,roles:['employee'],grants:undefined};}
   async function grant(as:SessionContext,company:string,options:{expired?:boolean;revoked?:boolean}={}){const roleId=randomUUID(),id=randomUUID();await saveContractSharedRole(f.admin,{id:roleId,name:randomUUID(),permissions:['view','decide'],expectedRevision:0});const input={id,roleId,userId:as.userId!,companyId:company,businessGroupId:null,validFrom:options.expired?'2020-01-01':start,validTo:options.expired?'2021-01-01':null};await saveContractSharedMember(f.admin,{...input,revoked:false,expectedRevision:0});if(options.revoked)await saveContractSharedMember(f.admin,{...input,revoked:true,expectedRevision:1});}
   const viewer=await actor(),outsider=await actor(),expired=await actor(),revoked=await actor(),pbp=await actor(),ambiguous=await actor(),otherPbp=await actor(),emptyViewer=await actor(),scopedHr=await actor(),disabledCompanyViewer=await actor(),archivedActor=await actor();
   await grant(viewer,companies[1].id);await grant(expired,companies[2].id,{expired:true});await grant(revoked,companies[3].id,{revoked:true});await grant(disabledCompanyViewer,companies[6].id);await grant(archivedActor,companies[7].id);
   const[empty]=await owner.db.execute<{id:string}>(sql`insert into company(tenant_id,legal_name) values(${b.tenantId}::uuid,'Fictional empty view scope') returning id`);await grant(emptyViewer,empty.id);
   await assignRole(f.admin,{appUserId:scopedHr.userId!,role:'hr_admin',companyId:companies[5].id});
   const partners=await automationBusinessPartnerWorkspace(f.admin);assert(partners);
   const desiredRules:BusinessPartnerRule[]=[...partners.rules,{userId:otherPbp.userId!,rules:{}},{userId:pbp.userId!,rules:{company:[b.companyId]}},{userId:ambiguous.userId!,rules:{company:[companies[0].id]}},{userId:otherPbp.userId!,rules:{company:[companies[0].id]}}];
   const savedPartners=await saveAutomationBusinessPartners(f.admin,{expectedRevision:partners.revision,rules:desiredRules,reason:'Configure actual unique and ambiguous navigation responsibilities'});assert.deepEqual(savedPartners.rules,desiredRules);
   const verifiedPartners=await automationBusinessPartnerWorkspace(f.admin);assert(verifiedPartners);assert.deepEqual({revision:verifiedPartners.revision,rules:verifiedPartners.rules},{revision:savedPartners.revision,rules:savedPartners.rules});
   for(const[as,company,role]of [[f.approver,b.companyId,'gbs'],[pbp,b.companyId,'pbp'],[ambiguous,companies[0].id,'pbp'],[otherPbp,companies[0].id,'pbp']]as const)await owner.db.execute(sql`insert into contract_role_assignment(tenant_id,company_id,user_id,role,valid_from,created_by) values(${b.tenantId}::uuid,${company}::uuid,${as.userId}::uuid,${role},${start}::date,${f.admin.userId}::uuid)`);
   const manager=await hireEmployee(f.admin,{person:{fullName:'Fictional view-disabled superior',primaryEmail:randomUUID()+'@navigation.test'},companyId:companies[4].id,departmentId:companies[4].departmentId,employmentType:'full_time',hiredOn:start});const disabledId=await createAppUser(b.tenantId,manager.personId,'employee');
   const report=await hireEmployee(f.admin,{person:{fullName:'Fictional disabled-superior report',primaryEmail:randomUUID()+'@navigation.test'},companyId:companies[4].id,departmentId:companies[4].departmentId,employmentType:'contract',hiredOn:start,provisionalEndOn:end,reportingManagerEmploymentId:manager.employmentId});await setEmploymentInfo(f.admin,{employmentId:report.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:4});
   const settings=await contractSharedSettings(f.admin,companies[4].id);await saveContractSharedSettings(f.admin,{companyId:companies[4].id,expectedRevision:settings.revision,settings:{...settings.settings,automaticSuperior:{enabled:true,permissions:['decide']}}});
   const[target]=await owner.db.execute<{id:string}>(sql`select id from employment where tenant_id=${b.tenantId}::uuid and company_id=${companies[0].id}::uuid order by id limit 1`);
   // Prepare real entitlement/account negatives before the read-only measured phase.
   await owner.db.execute(sql`delete from tenant_module where tenant_id=${b.tenantId}::uuid and module_code='lifecycle'`);
   await owner.db.execute(sql`insert into tenant_module(tenant_id,module_code,status,company_id) select ${b.tenantId}::uuid,'lifecycle','active',id from company where tenant_id=${b.tenantId}::uuid and id<>${companies[6].id}::uuid`);
   await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${b.tenantId}::uuid and id=${archivedActor.userId}::uuid`);
   const prepared:Prepared={businessPartner:{revision:savedPartners.revision,rules:savedPartners.rules},tenantId:b.tenantId,companyId:b.companyId,subjectEmploymentId:f.employee.employmentId,ambiguousEmploymentId:target.id,users:{admin:f.admin.userId!,superior:f.proposer.userId!,gbs:f.approver.userId!,viewer:viewer.userId!,outsider:outsider.userId!,expired:expired.userId!,revoked:revoked.userId!,pbp:pbp.userId!,ambiguous:ambiguous.userId!,emptyViewer:emptyViewer.userId!,scopedHr:scopedHr.userId!,viewDisabledSuperior:disabledId,disabledCompanyViewer:disabledCompanyViewer.userId!,archivedActor:archivedActor.userId!}};
   writeFileSync(join(folder,'prepared.json'),JSON.stringify(prepared),{mode:0o600,flag:'wx'});console.log(RESULT+JSON.stringify({prepared:true}));return;
  }
  const[identity]=await owner.client<{session:string;current:string;super:boolean;bypass:boolean;createRole:boolean}[]>`select session_user::text as session,current_user::text as current,(select rolsuper from pg_roles where rolname=current_user) as super,(select rolbypassrls from pg_roles where rolname=current_user) as bypass,(select rolcreaterole from pg_roles where rolname=current_user) as "createRole"`;
  assert.deepEqual({...identity},{session:'ai_hr_owner',current:'ai_hr_owner',super:false,bypass:false,createRole:false});
  const signatures=['app.contract_shared_configuration_company_scope()','app.contract_shared_navigation_access()','app.contract_shared_tracker_subjects()','app.contract_shared_tracker_company_scope()','app.contract_shared_tracker_managed_subjects()'];
  const definitions=await owner.client<{signature:string;owner:string;body:string}[]>`select oid::regprocedure::text as signature,proowner::regrole::text as owner,prosrc as body from pg_proc where oid::regprocedure::text=any(${signatures}::text[]) order by 1`;
  assert.equal(definitions.length,signatures.length);assert.ok(definitions.every(d=>d.owner==='ai_hr_owner'));
  for(const signature of ['app.contract_shared_tracker_company_scope()','app.contract_shared_tracker_managed_subjects()'])assert.equal((await owner.client`select has_function_privilege('ai_hr_app',${signature},'EXECUTE') as allowed`)[0].allowed,false);
  const prepared=JSON.parse(readFileSync(join(folder,'prepared.json'),'utf8')) as Prepared;
  const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string}[]};const originals=journal.entries.filter(entry=>entry.tag.endsWith('_contract_shared_tracker'));assert.equal(originals.length,1);
  const original=readFileSync('db/migrations/'+originals[0].tag+'.sql','utf8').split('AS $$',2)[1].split('$$;',1)[0];assert.equal(createHash('sha256').update(original).digest('hex'),'2205d31871034e13ef046ed9f22922a1bbc26a2f54b42e3a634a4bb5643d53f6');
  // Preserve the frozen query's business rules; adapt only the retired BP fact-owner lookup.
  // The independent People Ops lc_v9_config lookup, joins, weights and role guards stay literal.
  const oldBpSource="FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'bpRules','[]'::jsonb)) r WHERE v.tenant_id=app.current_tenant_id()";
  const sharedBpSource="FROM public.automation_business_partner_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.rules,'[]'::jsonb)) r WHERE v.tenant_id=app.current_tenant_id()";
  assert.equal(original.split(oldBpSource).length-1,1,'Frozen BP source clause must occur exactly once');
  const adaptedOriginal=original.replace(oldBpSource,sharedBpSource);
  assert.equal(adaptedOriginal.replace(sharedBpSource,oldBpSource),original);
  const currentTracker=definitions.find(definition=>definition.signature==='app.contract_shared_tracker_subjects()');assert(currentTracker);
  assert.equal(currentTracker.body.split(sharedBpSource).length-1,1,'Actual native tracker must use the same shared BP fact owner');
  assert.ok(prepared.businessPartner.revision>0);assert.ok(prepared.businessPartner.rules.length>=4);
  async function context(userId:string):Promise<SessionContext>{const[account]=await owner.db.execute<{person:string}>(sql`select person_id as person from app_user where tenant_id=${prepared.tenantId}::uuid and id=${userId}::uuid`);assert.ok(account?.person);const grants=await owner.db.execute<{role:string;companyId:string|null}>(sql`select role::text as role,company_id as "companyId" from role_assignment where tenant_id=${prepared.tenantId}::uuid and app_user_id=${userId}::uuid`);return {tenantId:prepared.tenantId,userId,personId:account.person,grants:Array.from(grants),roles:[...new Set(grants.map(g=>g.role))],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,prepared.tenantId))};}
  // Preparation removed the global entitlement deliberately. Company-only consumers retain their
  // native PBP facts, while the original tenant-wide configuration owner is now unavailable.
  assert.equal(await automationBusinessPartnerWorkspace(await context(prepared.users.admin)),null);
  const snapshot=async()=>{const result:Record<string,string>={};for(const table of ['employment','assignment','compensation','contract_case','contract_shared_case','contract_shared_event','automation_run','personnel_posting','domain_event']){const rows=await owner.client.unsafe<{digest:string}[]>(`select md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) as digest from public.${table} t where tenant_id=$1::uuid`,[prepared.tenantId]);result[table]=rows[0].digest;}return result;};
  const before=await snapshot(),timings:RestrictedNavigationRuntimeReceipt['timings']={},plans:Record<string,unknown>={},outputs:Record<string,Right[]>={};
  const backends:RestrictedNavigationRuntimeReceipt['backends']={},seenBackends=new Set<number>(),seenClients=new WeakSet<object>();
  const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR??join(temp,'aihr-ci');assert.ok(resolve(evidence).startsWith(realpathSync(temp)+sep));mkdirSync(evidence,{recursive:true,mode:0o700});assert.equal(realpathSync(evidence),resolve(evidence));
  const evidenceFiles=['contract-navigation-owner-timings.json','contract-navigation-owner-plans.json'];let status:'running'|'complete'='running';
  const flush=()=>{writeFileSync(join(evidence,evidenceFiles[0]),JSON.stringify({candidate,status,kind:'NATIVE_RESTRICTED_OWNER_READ_ONLY',identity,actors:Object.keys(prepared.users),timings,backends},null,2),{mode:0o600});writeFileSync(join(evidence,evidenceFiles[1]),JSON.stringify({candidate,status,kind:'ACTUAL_RESTRICTED_OWNER_NESTED_SOURCE_PLANS',plans},null,2),{mode:0o600});};flush();
  const sorted=(rows:Iterable<Right>)=>Array.from(rows).sort((a,b)=>a.employment_id.localeCompare(b.employment_id));
  for(const[key,userId]of Object.entries(prepared.users)){
   const ctx=await context(userId),actorUrl=new URL(process.env.TEST_DATABASE_URL!);
   // createDb intentionally caches by URL. A supported startup label gives each actor
   // its own canonical pool/backend instead of reopening a previously ended cached pool.
   const applicationName:string='contract-nav:'+nonce.slice(0,8)+':'+key;assert.ok(Buffer.byteLength(applicationName,'utf8')<=63);
   actorUrl.searchParams.set('application_name',applicationName);
   const app=createDb(actorUrl.toString(),{max:1});
   try{
    assert.equal(app.client.options.max,1);assert.equal(seenClients.has(app.client),false);seenClients.add(app.client);
    const[backend]=await app.client<{pid:number;applicationName:string;sessionUser:string;currentUser:string}[]>`select pg_backend_pid() as pid,current_setting('application_name') as "applicationName",session_user::text as "sessionUser",current_user::text as "currentUser"`;
    assert.equal(backend.applicationName,applicationName);assert.equal(backend.sessionUser,'ai_hr_app');assert.equal(backend.currentUser,'ai_hr_app');assert.equal(seenBackends.has(backend.pid),false);seenBackends.add(backend.pid);backends[key]={...backend};flush();
    const read=()=>app.withSharedReadSnapshot(ctx,()=>app.withTenant(ctx,async tx=>{
     const[actual]=await tx.execute<{ro:string;pid:number;applicationName:string;sessionUser:string;currentUser:string}>(sql`select current_setting('transaction_read_only') as ro,pg_backend_pid() as pid,current_setting('application_name') as "applicationName",session_user::text as "sessionUser",current_user::text as "currentUser"`);
     assert.deepEqual(actual,{ro:'on',...backend});
     return (await tx.execute<{facts:{page:boolean;configure:boolean;intake:boolean;automation:boolean;postings:boolean}}>(sql`select app.contract_shared_navigation_access() as facts`))[0].facts;
    }));
    const started=performance.now(),facts=await read(),coldMs=performance.now()-started,warmMs:number[]=[];for(let n=0;n<3;n++){const start=performance.now();assert.deepEqual(await read(),facts);warmMs.push(performance.now()-start);}timings[key]={coldMs,warmMs};flush();assert.ok(coldMs<3000,key+' cold navigation exceeded 3 seconds');assert.ok(Math.max(...warmMs)<1000,key+' warm navigation exceeded 1 second');
    if(key==='emptyViewer')assert.equal(facts.page,true);if(['outsider','expired','revoked','viewDisabledSuperior','disabledCompanyViewer','archivedActor'].includes(key))assert.equal(facts.page,false);if(key==='superior'||key==='pbp')assert.equal(facts.page,true);
    await owner.withSharedReadSnapshot(ctx,()=>owner.withTenant(ctx,async tx=>{
     const[real]=await tx.execute<{session:string;current:string;ro:string;noTemp:boolean;path:string}>(sql`select session_user::text as session,current_user::text as current,current_setting('transaction_read_only') as ro,pg_my_temp_schema()=0 as "noTemp",current_setting('search_path') as path`);
     assert.equal(real.session,'ai_hr_owner');assert.equal(real.current,'ai_hr_owner');assert.equal(real.ro,'on');assert.equal(real.noTemp,true);
     // Literal bodies qualify all relations/app calls. Record caller namespace; do not bypass the read carrier's setting guard.
     plans[key+':context']={session:real.session,current:real.current,readOnly:real.ro,searchPath:real.path,noTemp:real.noTemp};
     const [rules]=await tx.execute<{revision:number;rules:BusinessPartnerRule[]}>(sql`select revision,rules from public.automation_business_partner_config where tenant_id=app.current_tenant_id()`);
     assert(rules);assert.deepEqual({revision:rules.revision,rules:rules.rules},prepared.businessPartner,'Both queries must use the same nonempty native saved rule slice');
     const prior=sorted(await tx.execute<Right>(sql.raw('select * from ('+adaptedOriginal.trim()+') frozen_business_rules_shared_owner(employment_id,can_view,can_decide)'))),current=sorted(await tx.execute<Right>(sql`select * from app.contract_shared_tracker_subjects()`));assert.deepEqual(current,prior,key+' tracker rights differ from frozen5818 business-rule semantics over the shared fact owner');outputs[key]=current;
    }));
    if(['admin','superior','viewer','outsider'].includes(key))await owner.withTenant(ctx,async tx=>{
     // EXPLAIN requires its own transaction per the canonical shared-read contract.
     await tx.execute(sql`SET TRANSACTION READ ONLY`);
     await tx.execute(sql`SET LOCAL search_path = pg_catalog,public,pg_temp`);
     const[real]=await tx.execute<{session:string;current:string;ro:string}>(sql`select session_user::text as session,current_user::text as current,current_setting('transaction_read_only') as ro`);
     assert.deepEqual(real,{session:'ai_hr_owner',current:'ai_hr_owner',ro:'on'});
     for(const definition of definitions){const rows=await tx.execute<Record<string,unknown>>(sql.raw('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+definition.body));plans[key+':'+definition.signature]=rows[0]['QUERY PLAN'];flush();}
    });
   }finally{await app.client.end({timeout:5});}
  }
  assert.equal(seenBackends.size,Object.keys(prepared.users).length);
  assert.equal(outputs.pbp.find(r=>r.employment_id===prepared.subjectEmploymentId)?.can_view,true);
  assert.equal(outputs.ambiguous.find(r=>r.employment_id===prepared.ambiguousEmploymentId)?.can_view,false);
  assert.ok(outputs.viewDisabledSuperior.some(r=>r.can_decide&&!r.can_view));assert.equal(outputs.expired.filter(r=>r.can_view).length,0);assert.equal(outputs.revoked.filter(r=>r.can_view).length,0);
  const manager=await context(prepared.users.superior),managed=await owner.withSharedReadSnapshot(manager,()=>owner.withTenant(manager,tx=>tx.execute(sql`select * from app.contract_shared_tracker_managed_subjects()`)));assert.equal(managed.length,1);
  assert.deepEqual(await snapshot(),before,'Read-only navigation/equivalence/plan measurement changed business rows');
  const[counts]=await owner.db.execute<{companies:number;employments:number}>(sql`select (select count(*)::int from company where tenant_id=${prepared.tenantId}::uuid) companies,(select count(*)::int from employment where tenant_id=${prepared.tenantId}::uuid) employments`);assert.ok(counts.companies>=70&&counts.employments>=1000);
  status='complete';flush();
  const receipt:RestrictedNavigationRuntimeReceipt={version:1,sessionUser:'ai_hr_owner',currentUser:'ai_hr_owner',superuser:false,bypassRls:false,createRole:false,actors:Object.keys(prepared.users).length,equivalentRights:true,readOnlyMeasurements:true,companies:counts.companies,employments:counts.employments,managedReports:managed.length,timings,backends,evidenceFiles};console.log(RESULT+JSON.stringify(receipt));
 }finally{await closeAll();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
