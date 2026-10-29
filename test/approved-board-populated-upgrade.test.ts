/** Rehearse the approved-board release over the original 562 and current deployed 563-receipt prefixes.
 * Only an owned disposable localhost database; ordinary Drizzle receipts and all guards stay active. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {readMigrationFiles} from 'drizzle-orm/migrator';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
import {defaultPolicy} from '../packs/rewards/model';

type Journal={entries:{idx:number;when:number;tag:string}[];[key:string]:unknown};
function identities(){return Object.fromEntries(['tenant','company','catalogueCompany','department','validBu','legacyBu','employeePerson','employeeUser','employment','hrUser','readerUser','cycle','unit','member','entry','decision','period','batch','input','txn','slip'].map(key=>[key,randomUUID()]));}

it.each([562,563])('upgrades populated payroll and Rewards from %i to 567 receipts without rewriting money or historical scope',async(start)=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as Journal;
 const manifest=readMigrationFiles({migrationsFolder:'db/migrations'});
 expect(journal.entries).toHaveLength(567);
 expect(journal.entries[start-1].tag).toBe(start===562?'0686_ai_provider_custody_owner_rls':'0687_assistant_question_budget');
 expect(journal.entries.slice(start).map(({idx,when,tag})=>({idx,when,tag}))).toEqual([
  {idx:677,when:1793330000013,tag:'0687_assistant_question_budget'},
  {idx:678,when:1793330000014,tag:'0688_payroll_txn_import_attempts'},
  {idx:679,when:1793330000015,tag:'0689_rewards_unit_governance'},
  {idx:680,when:1793330000016,tag:'0690_rewards_policy_pair_membership'},
  // b6dbadc5 — the EPF Top-up percentage mode rides the same populated upgrade.
  {idx:681,when:1793330000023,tag:'0697_epf_topup_percentage'},
 ].slice(start-562));
 // Preserve the separately reserved AI predecessor exactly as committed at dcea0fa56.
 expect(createHash('sha256').update(readFileSync('db/migrations/0687_assistant_question_budget.sql')).digest('hex')).toBe('ade48bffee0a5d6ebf72cdd61de36323f3650b81c805cd186701c5d8105e86c4');
 // Historical journal order includes an already-applied timestamp inversion. Preserve it;
 // ordinary replay inserts journal order, while the receipt witness is timestamp then identity.
 const orderedManifest=manifest.map((migration,index)=>({...migration,index})).sort((a,b)=>a.folderMillis-b.folderMillis||a.index-b.index);
 let watermark=Math.max(...manifest.slice(0,start).map(m=>m.folderMillis));
 for(const migration of manifest.slice(start)){expect(migration.folderMillis).toBeGreaterThan(watermark);watermark=migration.folderMillis;}
 const name='ai_hr_board_upgrade_'+randomUUID().replaceAll('-',''),directory=mkdtempSync(join(tmpdir(),'aihr-board-upgrade-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(ownerUrl.username).not.toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});let created=false;
 ownerUrl.pathname='/'+name;const storage=createDb(ownerUrl.toString(),{max:1});
 const fixtures=[identities(),identities()];
 async function actor(tx:Pick<typeof storage.client,'unsafe'>,f:ReturnType<typeof identities>,user:string=f.hrUser,role='hr_admin',runtime=false){
  await tx.unsafe("select set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.roles',$3,true),set_config('app.grants',$4,true),set_config('app.agent_principal_id','',true)",[f.tenant,user,role,JSON.stringify([{role,companyId:null}])]);
  if(runtime)await tx.unsafe('SET LOCAL ROLE ai_hr_app');
 }
 const oldTables=['company','business_unit','person','app_user','role_assignment','employment','assignment','compensation','reward_cycle','reward_unit','reward_member','reward_entry','reward_decision','reward_policy_group','reward_policy_group_version','reward_policy_group_target','pay_period','payroll_batch','payroll_input','payroll_individual_txn','payslip','domain_event'] as const;
 async function historicalRows(){
  const result:Record<string,unknown>={};
  for(const table of oldTables){
   // Literal inventory only; subtract the one additive default when comparing old input columns.
   const expression=table==='payroll_input'?"to_jsonb(t)-'reward_provenance'":'to_jsonb(t)';
   result[table]=await storage.client.unsafe(`select ${expression} as row from public.${table} t where tenant_id=ANY($1::uuid[]) order by (${expression})::text`,[fixtures.map(f=>f.tenant)]);
  }
  return result;
 }
 const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by created_at,id`;
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,start))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,start)}));
  await migrate(storage.db,{migrationsFolder:directory});
  const baseline=await ledger();expect(baseline).toHaveLength(start);
  expect(baseline.map(row=>({hash:row.hash,when:Number(row.created_at)}))).toEqual(orderedManifest.filter(m=>m.index<start).map(m=>({hash:m.hash,when:m.folderMillis})));
  const [clock]=await storage.client`select (now() at time zone 'Asia/Kuala_Lumpur')::date::text as day`;
  const day=clock.day as string,year=Number(day.slice(0,4)),policy={...defaultPolicy(year),patActual:500000,patTarget:1000000,targetMonthsBp:20000,multiplierBp:9000};
  // Physical historical witnesses, not fabricated current-command provenance. No guards are disabled.
  for(const f of fixtures)await storage.client.begin(async tx=>{
   await tx`insert into tenant(id,workos_org_id,name) values(${f.tenant},${randomUUID()},'Fictional approved-board upgrade')`;
   for(const company of [f.company,f.catalogueCompany])await tx`insert into company(id,tenant_id,legal_name,country,currency) values(${company},${f.tenant},'Fictional upgrade company','MY','MYR')`;
   await tx`insert into department(id,tenant_id,company_id,name) values(${f.department},${f.tenant},${f.company},'Upgrade department')`;
   await tx`insert into person(id,tenant_id,full_name,primary_email) values(${f.employeePerson},${f.tenant},'Fictional employee',${randomUUID()+'@upgrade.invalid'})`;
   for(const [user,role] of [[f.hrUser,'hr_admin'],[f.readerUser,'hr_admin'],[f.employeeUser,'employee']]){
    await tx`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${f.tenant},${user===f.employeeUser?f.employeePerson:null},${randomUUID()})`;
    await tx`insert into role_assignment(tenant_id,app_user_id,role) values(${f.tenant},${user},${role})`;
   }
   await actor(tx,f);
   // Both catalogue-global BUs used to be valid targets. Only validBu has a current People assignment.
   for(const [bu,code] of [[f.validBu,'LIVE'],[f.legacyBu,'OLD']])await tx`insert into business_unit(id,tenant_id,company_id,code,name,is_global) values(${bu},${f.tenant},${f.catalogueCompany},${code},'Fictional global catalogue BU',true)`;
   await tx`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${f.employment},${f.tenant},${f.employeePerson},${f.company},'2022-01-01')`;
   await tx`insert into assignment(tenant_id,employment_id,department_id,business_unit_id,employment_type,valid_from) values(${f.tenant},${f.employment},${f.department},${f.validBu},'full_time','2022-01-01')`;
   await tx`insert into compensation(tenant_id,employment_id,basic_salary,currency,valid_from) values(${f.tenant},${f.employment},5000,'MYR','2022-01-01')`;
   const [shared]=await tx`select app.reward_policy_group_commit(NULL,0,'Historical shared policy',${JSON.stringify(policy)}::jsonb,${JSON.stringify([f.validBu,f.legacyBu].map(businessUnitId=>({companyId:f.company,businessUnitId})))}::jsonb) as version`;
   await tx`insert into reward_cycle(id,tenant_id,name,year,created_by) values(${f.cycle},${f.tenant},'Historical cycle',${year},${f.hrUser})`;
   await tx`insert into reward_unit(id,tenant_id,cycle_id,company_id,business_unit_id,created_by,policy,snapshot_date,status,revision,policy_group_version_id) values(${f.unit},${f.tenant},${f.cycle},${f.company},${f.legacyBu},${f.hrUser},${JSON.stringify(policy)}::jsonb,${day},'draft',2,${shared.version.versionId})`;
   await tx`insert into reward_member(id,tenant_id,unit_id,user_id,role) values(${f.member},${f.tenant},${f.unit},${f.hrUser},'gr')`;
   await tx`insert into reward_entry(id,tenant_id,unit_id,employment_id,source,facts,recommendation) values(${f.entry},${f.tenant},${f.unit},${f.employment},${JSON.stringify({employmentId:f.employment,companyId:f.company,businessUnitId:f.legacyBu,basicSalaryCents:500000})}::jsonb,'{"historicalBonusCents":12550}'::jsonb,'{"bonusCents":12550}'::jsonb)`;
   await tx`insert into reward_decision(id,tenant_id,unit_id,actor_id,revision,action,from_stage,to_stage,reason,digest) values(${f.decision},${f.tenant},${f.unit},${f.hrUser},1,'return','bg','draft','Retained historical decision','historical-digest')`;
   await tx`insert into pay_period(id,tenant_id,company_id,period,status) values(${f.period},${f.tenant},${f.company},'2023-01','closed')`;
   await tx`insert into payroll_batch(id,tenant_id,company_id,pay_period_id,pay_period,batch_date,status,employee_count,totals) values(${f.batch},${f.tenant},${f.company},${f.period},'2023-01','2023-01-31','closed',1,'{"gross":5000,"net":4500}'::jsonb)`;
   await tx`insert into payroll_input(id,tenant_id,batch_id,employment_id,overtime_amount,bonus_amount,tp1_deduction,zakat) values(${f.input},${f.tenant},${f.batch},${f.employment},50,125.50,12.34,1.25)`;
   await tx`insert into payroll_individual_txn(id,tenant_id,batch_id,employment_id,kind,txn_date,amount,source,source_ref) values(${f.txn},${f.tenant},${f.batch},${f.employment},'earning','2023-01-15',75,'import','historical-import-file')`;
   await tx`insert into payslip(id,tenant_id,batch_id,employment_id,basic_salary,gross_pay,total_deductions,net_pay,employer_cost,statutory) values(${f.slip},${f.tenant},${f.batch},${f.employment},5000,5000,500,4500,5600,'{"epfEmployee":500,"epfEmployer":600}'::jsonb)`;
   await tx`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${f.tenant},'reward-unit',${f.unit},'reward-unit.returned','user',${f.hrUser},'{"fixture":"historical physical witness"}'::jsonb)`;
  });
  const before=await historicalRows();
  for(const table of ['reward_unit','reward_entry','reward_decision','payroll_input','payroll_individual_txn','payslip'])expect(before[table]).toHaveLength(2);
  expect(before.reward_policy_group_target).toHaveLength(4);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await historicalRows()).toEqual(before);
  const upgraded=await ledger();expect(upgraded).toHaveLength(567);expect(upgraded.slice(0,start)).toEqual(baseline);
  expect(upgraded.map(row=>({hash:row.hash,when:Number(row.created_at)}))).toEqual(orderedManifest.map(m=>({hash:m.hash,when:m.folderMillis})));
  expect(await storage.client`select id from payroll_txn_import_attempt`).toHaveLength(0); // Never invent ownership of old imports.
  expect(await storage.client`select reward_provenance from payroll_input`).toEqual([{reward_provenance:[]},{reward_provenance:[]}]);
  const newTables=['payroll_txn_import_attempt','reward_governance','reward_governance_history','reward_senior_evidence','reward_governance_public','reward_senior_award'];
  const rls=await storage.client`select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relname=ANY(${newTables}::text[])`;
  expect(rls).toHaveLength(newTables.length);for(const row of rls)expect(row).toMatchObject({relrowsecurity:true,relforcerowsecurity:true});
  const [grants]=await storage.client`select has_table_privilege('ai_hr_app','payroll_txn_import_attempt','SELECT,INSERT,UPDATE') as attempts,has_table_privilege('ai_hr_app','payroll_txn_import_attempt','DELETE') as delete_attempt,has_table_privilege('ai_hr_app','app.assistant_question_budget','SELECT,INSERT,UPDATE,DELETE') as raw_budget,has_table_privilege('ai_hr_app','reward_governance_history','UPDATE,DELETE') as rewrite_history,has_function_privilege('ai_hr_app','app.reward_policy_memberships(uuid[])','EXECUTE') as memberships,has_function_privilege('ai_hr_app','app.reward_policy_pair_valid(uuid,uuid,uuid,boolean)','EXECUTE') as private_pair`;
  expect(grants).toEqual({attempts:true,delete_attempt:false,raw_budget:false,rewrite_history:false,memberships:true,private_pair:false});
  const privileges=await storage.client`select t as name,has_table_privilege('ai_hr_app',t,'SELECT') as read,has_table_privilege('ai_hr_app',t,'INSERT') as append,has_table_privilege('ai_hr_app',t,'UPDATE') as change,has_table_privilege('ai_hr_app',t,'DELETE') as remove from unnest(${newTables}::text[]) t order by t`;
  expect(privileges).toEqual([
   {name:'payroll_txn_import_attempt',read:true,append:true,change:true,remove:false},
   {name:'reward_governance',read:true,append:true,change:true,remove:false},
   {name:'reward_governance_history',read:true,append:true,change:false,remove:false},
   {name:'reward_governance_public',read:true,append:true,change:true,remove:false},
   {name:'reward_senior_award',read:true,append:true,change:true,remove:true},
   {name:'reward_senior_evidence',read:true,append:true,change:false,remove:false},
  ]);
  const [budget]=await storage.client`select relrowsecurity,relforcerowsecurity from pg_class where oid='app.assistant_question_budget'::regclass`;expect(budget).toEqual({relrowsecurity:true,relforcerowsecurity:false});
  expect(await storage.client`select root_id from app.assistant_question_budget`).toHaveLength(0);
  for(const f of fixtures){
   const [pairs]=await storage.client`select app.reward_policy_pair_valid(${f.tenant}::uuid,${f.company}::uuid,${f.validBu}::uuid) as live,app.reward_policy_pair_valid(${f.tenant}::uuid,${f.company}::uuid,${f.legacyBu}::uuid) as historical`;
   expect(pairs).toEqual({live:true,historical:false});
   await storage.client.begin(async tx=>{
    await actor(tx,f,f.hrUser,'hr_admin',true);
    expect(await tx`select * from app.reward_policy_memberships(ARRAY[${f.company}::uuid,${fixtures.find(other=>other!==f)!.company}::uuid])`).toEqual([{company_id:f.company,business_unit_id:f.validBu}]);
    await tx`insert into reward_governance(unit_id,tenant_id,state) values(${f.unit},${f.tenant},'{"version":1,"forecastCents":12345}'::jsonb)`;
    const [attempt]=await tx`insert into payroll_txn_import_attempt(tenant_id,operation_id,created_by,company_ids,source_name,source_hash,method,records,preview) values(${f.tenant},${randomUUID()},${f.hrUser},${JSON.stringify([f.company])}::jsonb,'new.xlsx',${'a'.repeat(64)},'monthly','[]'::jsonb,'{"rows":[]}'::jsonb) returning state,written,outcomes,recalc_batch_ids,reverted_at,reverted_by,created_at,bindings`;
    expect(attempt).toMatchObject({bindings:{},state:'validated',written:0,outcomes:[],recalc_batch_ids:[],reverted_at:null,reverted_by:null});expect(attempt.created_at).toBeTruthy();
   });
   await expect(storage.client.begin(async tx=>{await actor(tx,f,f.hrUser,'hr_admin',true);await tx`select app.reward_policy_group_commit(NULL,0,'Rejected catalogue-only target',${JSON.stringify(policy)}::jsonb,${JSON.stringify([{companyId:f.company,businessUnitId:f.legacyBu}])}::jsonb)`;})).rejects.toMatchObject({code:'42501'});
  }
  for(const f of fixtures){
   await storage.client.begin(async tx=>{
    await actor(tx,f,f.hrUser,'hr_admin',true);
    const [principal]=await tx`select current_user as role,app.principal_snapshot_current() as current`;expect(principal).toEqual({role:'ai_hr_app',current:true});
    expect(await tx`select unit_id from reward_governance`).toEqual([{unit_id:f.unit}]);
    expect(await tx`select tenant_id from payroll_txn_import_attempt`).toEqual([{tenant_id:f.tenant}]);
   });
   for(const [user,role] of [[f.readerUser,'hr_admin'],[f.employeeUser,'employee']])await storage.client.begin(async tx=>{await actor(tx,f,user,role,true);expect(await tx`select unit_id from reward_governance`).toEqual([]);if(role==='employee')expect(await tx`select id from payroll_txn_import_attempt`).toEqual([]);});
   await expect(storage.client.begin(async tx=>{await actor(tx,f,f.employeeUser,'employee',true);await tx`insert into payroll_txn_import_attempt(tenant_id,operation_id,created_by,company_ids,source_name,source_hash,method,records,preview) values(${f.tenant},${randomUUID()},${f.employeeUser},${JSON.stringify([f.company])}::jsonb,'denied.xlsx',${'b'.repeat(64)},'monthly','[]'::jsonb,'{"rows":[]}'::jsonb)`;})).rejects.toMatchObject({code:'42501'});
   await expect(storage.client`update payslip set gross_pay=1 where id=${f.slip}`).rejects.toMatchObject({code:'23514'});
   await expect(storage.client`update payroll_input set reward_provenance='{}'::jsonb where id=${f.input}`).rejects.toMatchObject({code:'23514'});
  }
  expect(await historicalRows()).toEqual(before);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await ledger()).toEqual(upgraded);expect(await historicalRows()).toEqual(before);
 }finally{
  await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},180_000);
