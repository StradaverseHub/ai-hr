/** CI-only populated 569→579 upgrade. Never connects to an installation or replays an installer.
 * The credential-free witness is metadata only; payroll/review rows below are fictional physical rows.
 * This proves migration preservation, not decryption or native decision behavior (covered separately). */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
import {expectedMigrationLedger,validateMigrationLedgerRows} from '../.github/ci/staging-migration-ledger.mjs';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import witness from './fixtures/ai-dev-applied-ledger-20261030.json';

type Entry={idx:number;when:number;tag:string};
type Journal={entries:Entry[];[key:string]:unknown};
const TAIL=[
 '0703_ai_feature_switch_owner','0704_assistant_action_kind','0705_ai_provider_change_gate',
 '0706_assistant_learning_loop_scope','0707_ai_agent_action_pause','0708_automatic_chasers',
 '0709_delegated_approvals','0710_automatic_followups','0711_template_feature_switch_owner',
 '0712_delegated_leave_review_receipts',
];
const PERFORMANCE=['performance.ai_360_enabled','performance.ai_tc_enabled','performance.ai_pm_enabled',
 'performance.ai_review_enabled','performance.ai_idp_enabled','performance.ai_calib_enabled'];
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');

it('upgrades the exact observed populated FEEDBACK prefix without rewriting applied history, payroll, settings or sealed reviews',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as Journal;
 const prefix=journal.entries.findIndex(entry=>entry.tag===TAIL[0]);
 expect(prefix).toBe(569);expect(witness.rows).toHaveLength(prefix);
 expect(witness.source).toBe('348b720e7a82c5e5573fc09196d06dfce50c787c');
 expect(witness.buildId).toBe('pYcygMSnqy5gufcCpl73B');expect(witness.observedAt).toBe('2026-10-30T01:57:09.823Z');
 expect(journal.entries[prefix-1]).toEqual({idx:683,version:'7',when:1793330000031,tag:'0696_feedback_menu_operator_switch',breakpoints:true});
 expect(journal.entries.slice(prefix).map(({tag,idx,when})=>({tag,idx,when}))).toEqual(TAIL.map((tag,i)=>({tag,idx:684+i,when:1793330000032+i})));
 // The canonical identity owner recognizes only the two retained historical SQL versions. It reads the
 // archived original bytes; this is not a checksum waiver or replacement of applied source.
 const expected:{tag:string;created_at:string;hash:string;sourceSha256?:string}[]=expectedMigrationLedger(process.cwd());
 expect(validateMigrationLedgerRows(expected.slice(0,prefix),witness.rows)).toEqual(witness.proof);
 expect(expected.slice(0,prefix).filter(row=>'sourceSha256' in row).map(row=>row.tag).sort()).toEqual(['0180_profile_option','0212_dashboard_card_config']);

 const name='ai_hr_ai_upgrade_'+randomUUID().replaceAll('-',''),directory=mkdtempSync(join(tmpdir(),'aihr-ai-upgrade-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(ownerUrl.username).not.toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+name;const storage=createDb(ownerUrl.toString(),{max:1});let created=false;
 const tenantIds:string[]=[];
 const tables=['tenant','company','person','app_user','employment','compensation','pay_period','payroll_batch','payroll_input','payslip','domain_event','tenant_setting'] as const;
 const ledger=()=>storage.client`select m.id::text as id,m.hash,m.created_at::text as created_at from drizzle.__drizzle_migrations m order by m.id`;
 async function retainedRows(){
  const rows:Record<string,unknown>={};
  for(const table of tables){
   const predicate=table==='tenant'?'id=ANY($1::uuid[])':'tenant_id=ANY($1::uuid[])';
   rows[table]=await storage.client.unsafe(`select to_jsonb(t) as row from public.${table} t where ${predicate} order by to_jsonb(t)::text`,[tenantIds]);
  }
  rows.review=await storage.client`select * from app.assistant_own_leave_review order by id`;
  rows.content=await storage.client`select * from app.assistant_own_leave_review_content order by action_id`;
  return rows;
 }
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,prefix))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,prefix)}));
  await migrate(storage.db,{migrationsFolder:directory});
  const replay=await ledger();expect(replay).toHaveLength(prefix);
  expect(replay.map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(journal.entries.slice(0,prefix).map(entry=>({hash:hash(readFileSync(`db/migrations/${entry.tag}.sql`)),created_at:String(entry.when)})));
  // ONLY this newly owned disposable fixture: restore the observed IDs/gaps and audited original
  // receipt hashes after native DDL replay. The installation and SQL bytes are never written.
  await storage.client`update drizzle.__drizzle_migrations set id=id+1000000`;
  for(let i=0;i<prefix;i++){
   const observed=witness.rows[i];
   await storage.client`update drizzle.__drizzle_migrations set id=${observed.id}::integer,hash=${observed.hash},created_at=${observed.created_at}::bigint where id=${Number(replay[i].id)+1000000}`;
  }
  await storage.client`select setval(pg_get_serial_sequence('drizzle.__drizzle_migrations','id'),(select max(id) from drizzle.__drizzle_migrations))`;
  expect(await ledger()).toEqual(witness.rows);

  for(let i=0;i<2;i++){
   const tenant=randomUUID(),company=randomUUID(),person=randomUUID(),user=randomUUID(),employment=randomUUID(),period=randomUUID(),batch=randomUUID(),event=randomUUID(),pending=randomUUID();
   tenantIds.push(tenant);
   await storage.client`insert into tenant(id,workos_org_id,name) values(${tenant},${randomUUID()},'Fictional AI upgrade tenant')`;
   await storage.client`insert into company(id,tenant_id,legal_name,country,currency) values(${company},${tenant},'Fictional preserved company','MY','MYR')`;
   await storage.client`insert into person(id,tenant_id,full_name,primary_email) values(${person},${tenant},'Fictional reviewer',${randomUUID()+'@upgrade.invalid'})`;
   await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${tenant},${person},${randomUUID()})`;
   await storage.client`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${employment},${tenant},${person},${company},'2022-01-01')`;
   await storage.client`insert into compensation(tenant_id,employment_id,basic_salary,currency,valid_from) values(${tenant},${employment},5000,'MYR','2022-01-01')`;
   await storage.client`insert into pay_period(id,tenant_id,company_id,period,status) values(${period},${tenant},${company},'2023-01','closed')`;
   await storage.client`insert into payroll_batch(id,tenant_id,company_id,pay_period_id,pay_period,batch_date,status,employee_count,totals) values(${batch},${tenant},${company},${period},'2023-01','2023-01-31','closed',1,'{"gross":5000,"net":4500}'::jsonb)`;
   await storage.client`insert into payroll_input(tenant_id,batch_id,employment_id,overtime_amount,bonus_amount,tp1_deduction,zakat) values(${tenant},${batch},${employment},50,125.50,12.34,1.25)`;
   await storage.client`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,total_deductions,net_pay,employer_cost,statutory) values(${tenant},${batch},${employment},5000,5000,500,4500,5600,'{"epfEmployee":500,"epfEmployer":600}'::jsonb)`;
   await storage.client`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${event},${tenant},'fictional-upgrade',${randomUUID()},'fictional-upgrade.created','user',${user},'{"physicalWitness":true}'::jsonb)`;
   await storage.client`insert into app.assistant_own_leave_review(id,action_kind,tenant_id,user_id,state,pay_component_id,pay_component_created_event_id,created_at,expires_at) values(${randomUUID()},'typed_pay_components.create',${tenant},${user},'completed',${randomUUID()},${event},now(),now()+interval '10 minutes')`;
   await storage.client`insert into app.assistant_own_leave_review(id,action_kind,tenant_id,user_id,state,intent_digest,reviewed_digest,created_at,expires_at) values(${pending},'typed_pay_components.create',${tenant},${user},'awaiting_confirmation',${'a'.repeat(64)},${'b'.repeat(64)},now(),now()+interval '10 minutes')`;
   await storage.client`insert into app.assistant_own_leave_review_content(action_id,kid,wrapped_dek,ciphertext) values(${pending},${'c'.repeat(16)},'fictional opaque wrapped-key bytes','fictional opaque sealed-review bytes')`;
   // Opposite explicit stored choices must survive the new default-OFF definitions unchanged.
   await storage.client`insert into tenant_setting(tenant_id,key,value,source,updated_by) values(${tenant},'performance.ai_pm_enabled',${JSON.stringify(i===0)}::jsonb,'customer',${user})`;
  }
  const before=await retainedRows();for(const table of tables)expect(before[table],table).toHaveLength(2);expect(before.review).toHaveLength(4);expect(before.content).toHaveLength(2);
  const definitions=await storage.client`select * from setting_definition order by key`;
  const priorPerformance=definitions.filter(row=>PERFORMANCE.includes(String(row.key)));
  expect(priorPerformance).toHaveLength(6);
  for(const row of priorPerformance)expect(row).toMatchObject({default_value:true,default_on_install:true});
  const baseline=await ledger();
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await retainedRows()).toEqual(before);
  const after=await ledger();expect(after).toHaveLength(579);expect(after.slice(0,prefix)).toEqual(baseline);
  expect(after.slice(prefix).map(({hash,created_at})=>({hash,created_at}))).toEqual(TAIL.map((tag,i)=>({hash:hashFile(tag),created_at:String(1793330000032+i)})));
  const changedDefinitions=await storage.client`select * from setting_definition order by key`;
  expect(changedDefinitions).toEqual(definitions.map(row=>PERFORMANCE.includes(String(row.key))?{...row,default_value:false,default_on_install:false}:row));
  expect(changedDefinitions.filter(row=>PERFORMANCE.includes(String(row.key)))).toHaveLength(6);
  const constraints=await storage.client`select conname,convalidated from pg_constraint where conname in ('assistant_review_action_kind_registered','ai_native_outcome_association_action_registered') order by conname`;
  expect(constraints).toEqual([{conname:'ai_native_outcome_association_action_registered',convalidated:true},{conname:'assistant_review_action_kind_registered',convalidated:true}]);
  const [kinds]=await storage.client`select count(*)::int as n from app.assistant_action_kind`;expect(kinds.n).toBe(AGENT_ACTIONS.length);
  expect(await storage.client`select action_id from app.ai_agent_action_pause`).toEqual([]);
  const [switches]=await storage.client`select count(*)::int as n from app.ai_feature_setting`;expect(switches.n).toBe(15);
  // Ordinary replay is idempotent; it neither re-applies the tail nor rewrites retained rows.
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await ledger()).toEqual(after);expect(await retainedRows()).toEqual(before);
 }finally{
  await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},300_000);
function hashFile(tag:string){return hash(readFileSync(`db/migrations/${tag}.sql`));}
