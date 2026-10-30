/** GHA-only populated ordinary-ledger upgrade. No CI policy swap, live DB or native-save claim. */
import {describe,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,existsSync,mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {sql} from 'drizzle-orm';
import {createDb,type SessionContext} from '../db/client';

const TAG='0691_bank_import_point_read',SQL_SHA='be6f8d38850fadd9151d58ea7476d8f60e09a0bf2b2b078e0196f4cb90c5bfe9';
const HINT='app.bank_import_point_read';
// Original M52 parity successors plus independently reviewed0865. Execution still uses only
// the immutable581 Bank prefix; current-source identity validation is a separate claim.
const PARITY_SOURCE_TAIL=[
 {"idx":698,"when":1793330000212,"tag":"0812_ai_feature_switch_owner"},
 {"idx":699,"when":1793330000213,"tag":"0813_assistant_action_kind"},
 {"idx":700,"when":1793330000214,"tag":"0814_ai_provider_change_gate"},
 {"idx":701,"when":1793330000215,"tag":"0815_assistant_learning_loop_scope"},
 {"idx":702,"when":1793330000216,"tag":"0816_ai_agent_action_pause"},
 {"idx":703,"when":1793330000217,"tag":"0817_automatic_chasers"},
 {"idx":704,"when":1793330000218,"tag":"0818_delegated_approvals"},
 {"idx":705,"when":1793330000219,"tag":"0819_automatic_followups"},
 {"idx":706,"when":1793330000220,"tag":"0820_template_feature_switch_owner"},
 {"idx":707,"when":1793330000221,"tag":"0821_delegated_leave_review_receipts"},
 {"idx":708,"when":1793330000222,"tag":"0822_assistant_qualification_maintenance"},
 {"idx":709,"when":1793330000223,"tag":"0823_assistant_employee_draft_activation"},
 {"idx":710,"when":1793330000224,"tag":"0824_assistant_compensation_maintenance"},
 {"idx":711,"when":1793330000225,"tag":"0825_assistant_emergency_contact_maintenance"},
 {"idx":712,"when":1793330000226,"tag":"0826_assistant_workforce_profile_maintenance"},
 {"idx":713,"when":1793330000227,"tag":"0827_assistant_family_maintenance"},
 {"idx":714,"when":1793330000228,"tag":"0828_assistant_bank_maintenance"},
 {"idx":715,"when":1793330000229,"tag":"0829_assistant_document_metadata"},
 {"idx":716,"when":1793330000230,"tag":"0830_assistant_employee_code_maintenance"},
 {"idx":717,"when":1793330000231,"tag":"0831_assistant_passport_maintenance"},
 {"idx":718,"when":1793330000232,"tag":"0832_assistant_payment_method_maintenance"},
 {"idx":719,"when":1793330000233,"tag":"0833_assistant_fixed_item_archive"},
 {"idx":720,"when":1793330000234,"tag":"0834_assistant_tp3_opening_maintenance"},
 {"idx":721,"when":1793330000235,"tag":"0835_assistant_cost_allocation_maintenance"},
 {"idx":722,"when":1793330000236,"tag":"0836_assistant_personnel_review_navigation"},
 {"idx":723,"when":1793330000237,"tag":"0837_assistant_attendance_schedule_group"},
 {"idx":724,"when":1793330000238,"tag":"0838_assistant_performance_goal_approval"},
 {"idx":725,"when":1793330000239,"tag":"0839_assistant_rewards_cancel_review"},
 {"idx":726,"when":1793330000240,"tag":"0840_assistant_personnel_profile_request_rejection"},
 {"idx":727,"when":1793330000241,"tag":"0841_assistant_position_archive_custody"},
 {"idx":728,"when":1793330000242,"tag":"0842_assistant_payroll_reopen_review"},
 {"idx":729,"when":1793330000243,"tag":"0843_assistant_lifecycle_offboarding_step_review"},
 {"idx":730,"when":1793330000244,"tag":"0844_assistant_performance_checkin_cancel"},
 {"idx":731,"when":1793330000245,"tag":"0845_assistant_attendance_day_schedule_correction"},
 {"idx":732,"when":1793330000246,"tag":"0846_native_ess_bank_direct_purpose"},
 {"idx":733,"when":1793330000247,"tag":"0847_assistant_performance_checkin_complete_custody"},
 {"idx":734,"when":1793330000248,"tag":"0848_assistant_rewards_cycle_calendar_review"},
 {"idx":735,"when":1793330000249,"tag":"0849_assistant_lifecycle_offboarding_step_undo"},
 {"idx":736,"when":1793330000250,"tag":"0850_assistant_department_archive_custody"},
 {"idx":737,"when":1793330000251,"tag":"0851_assistant_payroll_reset_review"},
 {"idx":738,"when":1793330000252,"tag":"0852_assistant_employee_id_template_status_custody"},
 {"idx":739,"when":1793330000253,"tag":"0853_onboarding_draft_discard_absence_context"},
 {"idx":740,"when":1793330000254,"tag":"0854_assistant_performance_checkin_schedule_custody"},
 {"idx":741,"when":1793330000255,"tag":"0855_assistant_rewards_annual_return_review"},
 {"idx":742,"when":1793330000256,"tag":"0856_assistant_lifecycle_offboarding_case_cancel"},
 {"idx":743,"when":1793330000257,"tag":"0857_assistant_performance_review_postimage_proof"},
 {"idx":744,"when":1793330000258,"tag":"0858_assistant_people_general_policy_custody"},
 {"idx":745,"when":1793330000259,"tag":"0859_assistant_employee_draft_discard_custody"},
 {"idx":746,"when":1793330000260,"tag":"0860_assistant_payroll_review_draft_delete_compatibility"},
 {"idx":747,"when":1793330000261,"tag":"0861_assistant_review_body_pending_parent"},
 {"idx":748,"when":1793330000263,"tag":"0863_assistant_bank_effect_closure"},
 {"idx":749,"when":1793330000264,"tag":"0864_assistant_catalogue_effect_closure"},
 {"idx":750,"when":1793330000265,"tag":"0865_assistant_company_retention_references"},
] as const;
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const ident=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const exact=(actual:unknown,expected:unknown,message:string)=>expect(JSON.stringify(actual)===JSON.stringify(expected),message).toBe(true);
type Entry={idx:number;when:number;tag:string;version:string;breakpoints:boolean};
type Employee={tenantId:string;personId:string;employmentId:string;companyId:string;voided:boolean};
type Actor={name:string;ctx:SessionContext;expected:string[];human:boolean;agentValid:boolean};
type Policy={schema:string;table:string;name:string;qual:string|null;catalog:Record<string,unknown>};

describe.skipIf(process.env.GITHUB_ACTIONS!=='true')('0691 populated ordinary upgrade',()=>{
 it('migrates the exact 580-row V9 and Feedback predecessor to 581 (six-scope source preparation) without changing retained facts or authority',async()=>{
  expect(process.env.GITHUB_ACTIONS).toBe('true');expect(process.env.CI).toBe('true');
  const started=performance.now(),deadline=started+150000;
  const budget=()=>expect(performance.now()<deadline,'150-second work budget reserves owned cleanup within 180 seconds').toBe(true);
  const sourceJournalBytes=readFileSync('db/migrations/meta/_journal.json');
  const sourceJournal=JSON.parse(sourceJournalBytes.toString()) as {entries:Entry[];[key:string]:unknown};
  expect(PARITY_SOURCE_TAIL).toHaveLength(53);expect(sourceJournal.entries.length).toBe(583+PARITY_SOURCE_TAIL.length);
  expect(sourceJournal.entries[sourceJournal.entries.length-1]).toEqual({idx:750,version:'7',when:1793330000265,tag:'0865_assistant_company_retention_references',breakpoints:true});
  expect(sha(readFileSync('db/migrations/0865_assistant_company_retention_references.sql'))).toBe('088acfed2e8aba43deb012e0baed2d4d88765d115afd19a858ebee53e12141cd');
  exact(sourceJournal.entries.slice(583).map(({idx,when,tag})=>({idx,when,tag})),PARITY_SOURCE_TAIL,'The current source tail must match the explicit ratified parity allocation; it is not executed by the Bank-only fixture');
  exact(sourceJournal.entries.slice(581,583).map(({idx,when,tag})=>({idx,when,tag})),[{idx:696,when:1793330000200,tag:'0800_pay_formula_builder'},{idx:697,when:1793330000211,tag:'0811_pay_formula_company_retention'}],'The exact two ratified Formula successors immediately follow the immutable Bank proof prefix');
  expect(sha(readFileSync('db/migrations/0800_pay_formula_builder.sql'))).toBe('f8ba2919eb59346bc86453667cc7952a5671db88b740fcab3c41b4530802c322');
  expect(sha(readFileSync('db/migrations/0811_pay_formula_company_retention.sql'))).toBe('b3bea8f1c646e0989ac1cf161cc4950e4956439693961c2d8c00aba1c21aae5b');
  // This fixture proves the Bank policy change in isolation. Actual 583-row source upgrades are
  // and current-source tail are independently covered by populated-upgrade and release qualification.
  const journal={...sourceJournal,entries:sourceJournal.entries.slice(0,581)};
  const journalBytes=Buffer.from(JSON.stringify(journal,null,2)+'\n');
  const boundary=journal.entries.findIndex(e=>e.tag===TAG);
  expect(boundary).toBe(580);expect(journal.entries.length).toBe(581);
  expect(sha(journalBytes)).toBe('0ec4efea88ff081124c96922f3f84988e4dc1e082a7e46d25d2ae7b59550137e');
  expect(sha(JSON.stringify(journal.entries.slice(0,boundary)))).toBe("0f15971974a4aab83ea7756e1ddce5569b25965593e1cf2efdc4aece8b752ba7");
  exact(journal.entries.slice(-3).map(({idx,when,tag})=>({idx,when,tag})),[
   {idx:693,when:1793330000063,tag:'0720_lifecycle_v9_self_equipment'},
   {idx:694,when:1793330000065,tag:'0728_feedback_release_evidence'},
   {idx:695,when:1793330000075,tag:TAG},
  ],'Exact V9 and Feedback prefix plus source-only ratified Bank append; no release authority');
  expect(Math.max(...journal.entries.slice(0,boundary).map(e=>e.when))).toBe(1793330000065);
  expect(sha(readFileSync('db/migrations/'+TAG+'.sql'))).toBe(SQL_SHA);
  const expectedLedger=journal.entries.map(e=>({hash:sha(readFileSync('db/migrations/'+e.tag+'.sql')),created_at:String(e.when)}));
  expect(sha(JSON.stringify(expectedLedger.map(({created_at,hash})=>({created_at,hash}))))).toBe('38d86c3d2a32cc1203ca8f6456d43da4ee4c1dd65a424f25cdda6881920a7973');
  const name='ai_hr_bank_point_upgrade_'+randomUUID().replaceAll('-','');
  const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
  expect(['127.0.0.1','localhost','[::1]']).toContain(ownerUrl.hostname);
  expect(appUrl.host).toBe(ownerUrl.host);expect(appUrl.username).toBe('ai_hr_app');expect(ownerUrl.username).not.toBe(appUrl.username);
  expect(name).toMatch(/^ai_hr_bank_point_upgrade_[a-f0-9]{32}$/);
  const directory=mkdtempSync(join(tmpdir(),'bank-point-upgrade-'));
  ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{},connection:{statement_timeout:5000,lock_timeout:2000}});
  ownerUrl.pathname='/'+name;appUrl.pathname='/'+name;
  const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});
  let created=false,primary:unknown,phase='create-owned-database';
  const ledger=async()=>[...await storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`];
  const policyRows=async()=>[...await storage.client<Policy[]>`select n.nspname as schema,c.relname as table,p.polname as name,pg_get_expr(p.polqual,p.polrelid) as qual,to_jsonb(p) as catalog
   from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace order by n.nspname,c.relname,p.polname`];
  const metadata=async()=>({
   roles:[...await storage.client`select to_jsonb(r)-'rolpassword' as catalog from pg_roles r where rolname in(current_user,'ai_hr_app') order by rolname`],
   tables:[...await storage.client`select n.nspname,c.relname,c.oid,c.relowner,c.relkind,c.relacl::text as acl,c.relrowsecurity,c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','app') and c.relkind in('r','p') order by n.nspname,c.relname`],
   functions:[...await storage.client`select n.nspname,p.oid,to_jsonb(p) as catalog,case when p.prokind<>'a' then pg_get_functiondef(p.oid) end as definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','app') order by n.nspname,p.oid`],
   schemas:[...await storage.client`select nspname,nspowner,nspacl::text as acl from pg_namespace where nspname in('public','app') order by nspname`],
  });
  const allFacts=async()=>{
   const tables=await storage.client`select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in('public','app') and c.relkind in('r','p') order by n.nspname,c.relname`;
   const facts:Record<string,string[]>={};
   for(const table of tables){budget();const rows=await storage.client.unsafe(`select to_jsonb(t)::text as value from ${ident(String(table.nspname))}.${ident(String(table.relname))} t order by to_jsonb(t)::text`);facts[table.nspname+'.'+table.relname]=rows.map(row=>String(row.value));}
   return facts;
  };
  try{
   await admin.unsafe(`CREATE DATABASE ${ident(name)}`);created=true;
   await admin.unsafe(`GRANT CONNECT ON DATABASE ${ident(name)} TO ai_hr_app`);
   mkdirSync(join(directory,'meta'));
   for(const entry of journal.entries.slice(0,boundary)){
    const original='db/migrations/'+entry.tag+'.sql',copy=join(directory,entry.tag+'.sql');copyFileSync(original,copy);
    expect(sha(readFileSync(copy))).toBe(sha(readFileSync(original)));
   }
   writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));
   await storage.client`set statement_timeout=60000`;await storage.client`set lock_timeout=5000`;
   await application.client`set statement_timeout=15000`;await application.client`set lock_timeout=5000`;
   phase='normal-prefix-migration';budget();await migrate(storage.db,{migrationsFolder:directory});budget();
   const prior=await ledger();expect(prior.length).toBe(580);
   exact(prior.map(({hash,created_at})=>({hash,created_at})),expectedLedger.slice(0,boundary),'Every ordinary prefix hash/timestamp must match its exact copied SQL');
   phase='populate-retained-fixture';
   const [t1]=await storage.client`insert into tenant(workos_org_id,name) values(${randomUUID()},'Fictional point-upgrade tenant one') returning id`;
   const [t2]=await storage.client`insert into tenant(workos_org_id,name) values(${randomUUID()},'Fictional point-upgrade tenant two') returning id`;
   const company=async(tenant:string,label:string,parent:string|null=null)=>{
    const [row]=await storage.client`insert into company(tenant_id,legal_name,country,currency,parent_company_id) values(${tenant}::uuid,${label},'MY','MYR',${parent}::uuid) returning id`;return String(row.id);
   };
   const a=await company(t1.id,'Upgrade A'),child=await company(t1.id,'Upgrade A child',a),b=await company(t1.id,'Upgrade B'),foreignCompany=await company(t2.id,'Upgrade foreign');
   const login=async(tenant:string,label:string,personId:string|null,role:string,companyId:string|null)=>{
    const [u]=await storage.client`insert into app_user(tenant_id,workos_user_id,person_id) values(${tenant}::uuid,${'upgrade-'+label+'-'+randomUUID()},${personId}::uuid) returning id`;
    await storage.client`insert into role_assignment(tenant_id,app_user_id,role,company_id) values(${tenant}::uuid,${u.id}::uuid,${role}::role,${companyId}::uuid)`;
    return {tenantId:tenant,userId:String(u.id),roles:[role],grants:[{role,companyId}]} satisfies SessionContext;
   };
   const group=await login(t1.id,'group',null,'hr_admin',null);
   const body=Buffer.from('Fictional retained import source\n');
   const [attempt]=await storage.client`insert into import_attempt(tenant_id,kind,created_by,operation_key,source_name,mime_type,source_hash,source_content,company_ids,plan)
    values(${t1.id}::uuid,'employee_full',${group.userId}::uuid,${randomUUID()}::uuid,'retained-before-0691.csv','text/csv',${sha(body)},${body},ARRAY[${a}::uuid],'{}'::jsonb) returning id`;
   const employees:Employee[]=[];
   const employee=async(tenant:string,companyId:string,label:string,voided=false)=>{
    const [p]=await storage.client`insert into person(tenant_id,full_name,primary_email,voided_at)
     values(${tenant}::uuid,${'Fictional retained '+label},${'point-upgrade-'+label+'@example.invalid'},${voided?'2026-10-01T00:00:00Z':null}::timestamptz) returning id`;
    // A retained historical void has the full constraint-valid bundle and an actual
    // employee-full attempt. Ordinary triggers/constraints stay enabled throughout.
    const [e]=await storage.client`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on,payment_method,voided_at,voided_by,void_reason,voided_import_attempt_id,voided_employee_code)
     values(${tenant}::uuid,${p.id}::uuid,${companyId}::uuid,${voided?null:'UP-'+label},'2026-01-05','bank_transfer',
      ${voided?'2026-10-01T00:00:00Z':null}::timestamptz,${voided?group.userId:null}::uuid,${voided?'Fictional retained import void':null},${voided?attempt.id:null}::uuid,${voided?'UP-VOID':null}) returning id`;
    await storage.client`insert into employee_statutory_my(tenant_id,person_id,tax_number,bank_name,bank_account_no)
     values(${tenant}::uuid,${p.id}::uuid,${'T-RETAIN-'+label},'Maybank','0001234567')`;
    const value={tenantId:tenant,personId:String(p.id),employmentId:String(e.id),companyId,voided};employees.push(value);return value;
   };
   const ea=await employee(t1.id,a,'A'),ec=await employee(t1.id,child,'CHILD'),eb=await employee(t1.id,b,'B'),ev=await employee(t1.id,a,'VOID',true),ef=await employee(t2.id,foreignCompany,'FOREIGN');
   await storage.client`insert into import_attempt_item(tenant_id,attempt_id,company_id,employment_id,item_key,label,ordinal,status,before,after)
    values(${t1.id}::uuid,${attempt.id}::uuid,${a}::uuid,${ev.employmentId}::uuid,'retained-void','Fictional retained history',1,'applied','{}'::jsonb,'{}'::jsonb)`;
   await storage.client`insert into import_attempt_event(tenant_id,attempt_id,kind,actor_id,reason,detail)
    values(${t1.id}::uuid,${attempt.id}::uuid,'reverted',${group.userId}::uuid,'Fictional retained import reverted before upgrade','{}'::jsonb)`;
   const scoped=await login(t1.id,'scoped-a',null,'hr_admin',a),scopedChild=await login(t1.id,'scoped-child',null,'hr_admin',child),scopedB=await login(t1.id,'scoped-b',null,'hr_admin',b);
   const self=await login(t1.id,'self',ea.personId,'employee',null),partner=await login(t1.id,'payroll',null,'payroll_partner',b),foreign=await login(t2.id,'foreign-hr',null,'hr_admin',foreignCompany);
   for(const tenant of [String(t1.id),String(t2.id)])await storage.client`insert into app.ai_agent_principal(tenant_id) values(${tenant}::uuid) on conflict(tenant_id) do nothing`;
   // Ordinary migrations retain the pre-existing authentication tenant and its
   // principal. Select only our two fixture principals; all rows remain in allFacts().
   const principals=await storage.client`select id,tenant_id from app.ai_agent_principal where tenant_id in (${t1.id}::uuid,${t2.id}::uuid) order by tenant_id`;
   expect(principals.length).toBe(2);const principal1=String(principals.find(p=>p.tenant_id===t1.id)!.id),principal2=String(principals.find(p=>p.tenant_id===t2.id)!.id);
   const actors:Actor[]=[
    {name:'scoped-hr-a',ctx:scoped,expected:[ea.employmentId,ec.employmentId],human:true,agentValid:false},
    {name:'scoped-hr-child',ctx:scopedChild,expected:[ec.employmentId],human:true,agentValid:false},
    {name:'scoped-hr-b',ctx:scopedB,expected:[eb.employmentId],human:true,agentValid:false},
    {name:'group-hr',ctx:group,expected:[ea.employmentId,ec.employmentId,eb.employmentId],human:true,agentValid:false},
    {name:'self-employee',ctx:self,expected:[ea.employmentId],human:true,agentValid:false},
    {name:'payroll-partner-b',ctx:partner,expected:[eb.employmentId],human:true,agentValid:false},
    {name:'foreign-tenant-hr',ctx:foreign,expected:[ef.employmentId],human:true,agentValid:false},
    {name:'named-agent-one',ctx:{tenantId:t1.id,roles:[],grants:[],agent:{principalId:principal1,enablements:[]}},expected:[ea.employmentId,ec.employmentId,eb.employmentId,ev.employmentId],human:false,agentValid:true},
    {name:'named-agent-two',ctx:{tenantId:t2.id,roles:[],grants:[],agent:{principalId:principal2,enablements:[]}},expected:[ef.employmentId],human:false,agentValid:true},
    {name:'foreign-agent-principal',ctx:{tenantId:t2.id,roles:[],grants:[],agent:{principalId:principal1,enablements:[]}},expected:[],human:false,agentValid:false},
    {name:'no-user',ctx:{tenantId:t1.id,roles:[],grants:[]},expected:[],human:false,agentValid:false},
   ];
   const visibility=async()=>{
    const observations:Record<string,unknown>[]=[];
    for(const actor of actors)for(const marker of ['unset','off','on','garbage'] as const){
     budget();
     const visible=await application.withTenant(actor.ctx,async tx=>{
      if(marker!=='unset')await tx.execute(sql`select set_config(${HINT},${marker},true)`);
      const [proof]=await tx.execute<{role:string;super:boolean;bypass:boolean;owner_member:boolean;current:boolean;agent:boolean;backend:number;marker:string|null}>(sql`select current_user as role,r.rolsuper as super,r.rolbypassrls as bypass,
       pg_has_role(current_user,(select relowner from pg_class where oid='public.employment'::regclass),'USAGE') as owner_member,
       app.principal_snapshot_current() as current,app.current_agent_principal() is not null as agent,pg_backend_pid() as backend,nullif(current_setting(${HINT},true),'') as marker from pg_roles r where r.rolname=current_user`);
      expect(proof).toMatchObject({role:'ai_hr_app',super:false,bypass:false,owner_member:false,current:actor.human,agent:actor.agentValid,marker:marker==='unset'?null:marker});
      const employment=(await tx.execute<{id:string}>(sql`select id from employment order by id`)).map(r=>r.id);
      const people=(await tx.execute<{id:string}>(sql`select id from person order by id`)).map(r=>r.id);
      const statutory=(await tx.execute<{id:string}>(sql`select person_id as id from employee_statutory_my order by person_id`)).map(r=>r.id);
      exact(employment,actor.expected.slice().sort(),'Nonvacuous original scoped employment visibility must remain exact: '+actor.name);
      const otherPeople=new Set(employees.filter(e=>e.tenantId!==actor.ctx.tenantId).map(e=>e.personId));
      expect([...people,...statutory].every(id=>!otherPeople.has(id)),'Neither people nor statutory reads may cross tenant').toBe(true);
      if(actor.name==='self-employee'){expect(people.includes(ea.personId)).toBe(true);expect(statutory.includes(ea.personId)).toBe(true);}
      return {backend:proof.backend,employment,people,statutory};
     });
     const [restored]=await application.client`select pg_backend_pid() as backend,nullif(current_setting(${HINT},true),'') as marker,current_user as role`;
     exact({...restored},{backend:visible.backend,marker:null,role:'ai_hr_app'},'The exact single APP backend must restore the transaction-local marker');
     observations.push({actor:actor.name,marker,employment:visible.employment,people:visible.people,statutory:visible.statutory});
    }
    return observations;
   };
   phase='baseline-populated-snapshot';budget();
   const beforeFacts=await allFacts(),beforeMetadata=await metadata(),beforePolicies=await policyRows(),beforeVisibility=await visibility();
   for(const table of ['public.tenant','public.company','public.person','public.employment','public.employee_statutory_my','public.app_user','public.role_assignment','app.ai_agent_principal','public.import_attempt','public.import_attempt_item','public.import_attempt_event'])expect(beforeFacts[table].length,'Fixture must populate '+table).toBeGreaterThan(0);
   expect(beforeFacts['public.person'].length).toBe(5);expect(beforeFacts['public.employment'].length).toBe(5);expect(beforeFacts['public.employee_statutory_my'].length).toBe(5);
   const unchanged=async()=>{exact(await allFacts(),beforeFacts,'All public/app table rows must retain their exact complete JSON bytes');exact(await metadata(),beforeMetadata,'Roles, table ownership/ACL/RLS flags and all function definitions/catalog/owner/ACL must be unchanged');};
   phase='normal-bank-prefix-migration';
   copyFileSync('db/migrations/'+TAG+'.sql',join(directory,TAG+'.sql'));
   expect(sha(readFileSync(join(directory,TAG+'.sql')))).toBe(SQL_SHA);
   exact(readdirSync(directory).filter(name=>name.endsWith('.sql')).sort(),journal.entries.map(entry=>entry.tag+'.sql').sort(),'The ordinary loader receives every one of the exact 581 prefix SQL files');
   for(const entry of journal.entries)expect(sha(readFileSync(join(directory,entry.tag+'.sql')))).toBe(sha(readFileSync('db/migrations/'+entry.tag+'.sql')));
   expect(existsSync(join(directory,'0800_pay_formula_builder.sql')),'The Bank-only rehearsal must not execute Formula SQL').toBe(false);
   expect(existsSync(join(directory,'0811_pay_formula_company_retention.sql')),'The Bank-only rehearsal must not execute the later retention helper').toBe(false);
   expect(existsSync(join(directory,'0865_assistant_company_retention_references.sql')),'The Bank-only rehearsal must not execute the new company-retention migration').toBe(false);
   writeFileSync(join(directory,'meta/_journal.json'),journalBytes);
   budget();await migrate(storage.db,{migrationsFolder:directory});budget();
   const applied=await ledger();expect(applied.length).toBe(581);exact(applied.slice(0,boundary),prior,'The complete old 580-row ledger prefix must be immutable');
   exact(applied.map(({hash,created_at})=>({hash,created_at})),expectedLedger,'Normal migrator ledger must match every exact source SQL hash/timestamp');
   exact(applied.slice(boundary).map(({hash,created_at})=>({hash,created_at})),[{hash:SQL_SHA,created_at:'1793330000075'}],'Exactly the allocated 0691 ledger row must append');
   const afterPolicies=await policyRows();expect(afterPolicies.length).toBe(beforePolicies.length);
   const changes=afterPolicies.filter((p,i)=>p.qual!==beforePolicies[i].qual).map(p=>p.schema+'.'+p.table+'.'+p.name);exact(changes,['public.employment.employment_rls'],'Only the intended policy USING may change');
   const normalized=afterPolicies.map((p,i)=>p.schema==='public'&&p.table==='employment'&&p.name==='employment_rls'?{...p,qual:beforePolicies[i].qual,catalog:{...p.catalog,polqual:beforePolicies[i].catalog.polqual}}:p);
   exact(normalized,beforePolicies,'Policy OID, command, roles, permissiveness, WITH CHECK and additive named-agent policies must remain exact');
   const changed=afterPolicies.find(p=>p.schema==='public'&&p.table==='employment'&&p.name==='employment_rls')!;expect(changed.qual).toContain(HINT);
   phase='verify-retention-and-authority';await unchanged();exact(await visibility(),beforeVisibility,'Every principal and marker must return the same ordered IDs before/after');
   phase='normal-idempotent-rerun';await migrate(storage.db,{migrationsFolder:directory});exact(await ledger(),applied,'Rerunning the exact Bank prefix with the ordinary migrator must append nothing');
   exact(await policyRows(),afterPolicies,'Idempotent rerun must preserve the installed policy catalog');await unchanged();exact(await visibility(),beforeVisibility,'Idempotent rerun must retain the same authority');budget();
   expect(sha(readFileSync('db/migrations/'+TAG+'.sql'))).toBe(SQL_SHA);expect(sha(readFileSync('db/migrations/meta/_journal.json'))).toBe(sha(sourceJournalBytes));
   console.info('[bank-point-read-upgrade]',JSON.stringify({kind:'SCOPED_POPULATED_580_TO_581_BANK_PREFIX_NOT_FINAL_SOURCE_UPGRADE',prefixRows:prior.length,resultRows:applied.length,appendedSqlSha256:SQL_SHA,appendedTimestamp:journal.entries[boundary].when,
    ledgerSha256:sha(JSON.stringify(applied)),factTables:Object.keys(beforeFacts).length,fullRowsSha256:sha(JSON.stringify(beforeFacts)),retainedPeople:5,retainedEmployments:5,retainedStatutory:5,contexts:actors.length,humanPrincipals:actors.filter(a=>a.human).length,namedAgentPrincipals:principals.length,markerStates:4,
    onlyEmploymentUsingChanged:true,allRetainedRowsUnchanged:true,rolesFunctionsOwnershipAclAndRlsUnchanged:true,orderedVisibilityUnchanged:true,idempotent:true,elapsedMs:performance.now()-started,liveLedgerClaim:false,releaseAuthorized:false}));
  }catch(error){primary=error;console.info('[bank-point-read-upgrade-failed]',JSON.stringify({phase,elapsedMs:performance.now()-started,sqlState:(error as {code?:string})?.code}));throw error;}finally{
   const failures:unknown[]=[];
   for(const pool of [application.client,storage.client])try{await pool.end({timeout:5});}catch(error){failures.push(error);}
   // No FORCE, pg_terminate_backend or foreign process cleanup: close our exact pools,
   // then drop only the unique database that this test successfully created.
   if(created)try{await admin.unsafe(`DROP DATABASE ${ident(name)}`);}catch(error){failures.push(error);}
   try{await admin.end({timeout:5});}catch(error){failures.push(error);}
   try{rmSync(directory,{recursive:true,force:true});}catch(error){failures.push(error);}
   if(primary!==undefined)for(const error of failures)console.error('[bank-point-read-upgrade-cleanup-failed]',JSON.stringify({sqlState:(error as {code?:string})?.code}));
   else if(failures.length)throw failures[0];
  }
 },180000);
});
