/** Ordinary journal upgrade of existing Rewards/letter rows on a disposable CI database.
 * No draft installer, disabled trigger, manufactured migration receipt or production database. */
import {randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';
import {defaultPolicy} from '../packs/rewards/model';

it('preserves populated Rewards history, seats, shared policies and both notification audiences through the journal upgrade',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 const start=journal.entries.findIndex((entry:{tag:string})=>entry.tag==='0679_email_templates_r2');
 expect(start).toBeGreaterThan(0);
 expect(journal.entries.slice(start).map((entry:{tag:string})=>entry.tag)).toContain('0681_rewards_approval_participation');
 const name='ai_hr_rewards_upgrade_'+randomUUID().replaceAll('-',''),directory=mkdtempSync(join(tmpdir(),'aihr-rewards-upgrade-'));
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(ownerUrl.username).not.toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});let created=false;
 ownerUrl.pathname='/'+name;const storage=createDb(ownerUrl.toString(),{max:1});
 const ids=Object.fromEntries(['tenant','company','department','bu','requester','checker','employeeUser','requesterPerson','checkerPerson','employeePerson','employment','cycle','unit','grMember','buMember','decision','audit','employmentNotice','letterNotice','letterPolicy','template','templateVersion','batch','letter','letterEvent','letterJob'].map(key=>[key,randomUUID()]));
 const legacyMemberColumns='id,tenant_id,unit_id,user_id,role,created_at';
 async function actor(tx:Pick<typeof storage.client,'unsafe'>,user:string,role:string,appRole=false){
  await tx.unsafe("select set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.roles',$3,true),set_config('app.grants',$4,true),set_config('app.agent_principal_id','',true)",[ids.tenant,user,role,JSON.stringify([{role,companyId:null}])]);
  if(appRole)await tx.unsafe('SET LOCAL ROLE ai_hr_app');
 }
 async function unchangedRows(){
  return {
   units:await storage.client`select * from reward_unit where tenant_id=${ids.tenant} order by id`,
   members:await storage.client.unsafe(`select ${legacyMemberColumns} from reward_member where tenant_id=$1 order by id`,[ids.tenant]),
   decisions:await storage.client`select * from reward_decision where tenant_id=${ids.tenant} order by id`,
   audit:await storage.client`select * from domain_event where tenant_id=${ids.tenant} order by sequence`,
   groups:await storage.client`select * from reward_policy_group where tenant_id=${ids.tenant} order by id`,
   versions:await storage.client`select * from reward_policy_group_version where tenant_id=${ids.tenant} order by revision`,
   targets:await storage.client`select * from reward_policy_group_target where tenant_id=${ids.tenant} order by version_id,company_id,business_unit_id`,
   notifications:await storage.client`select * from notification where tenant_id=${ids.tenant} order by id`,
   letterJobs:await storage.client`select * from letter_job where tenant_id=${ids.tenant} order by id`,
   letters:await storage.client`select * from letter_record where tenant_id=${ids.tenant} order by id`,
  };
 }
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,start))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,start)}));
  await migrate(storage.db,{migrationsFolder:directory});
  const [clock]=await storage.client`select (now() at time zone 'Asia/Kuala_Lumpur')::date::text as day`;
  const day=clock.day as string,year=Number(day.slice(0,4)),policy=defaultPolicy(year);
  // Owner seeds a valid historical installation; every existing link/transition trigger remains active.
  await storage.client.begin(async tx=>{
   await tx`insert into tenant(id,workos_org_id,name) values(${ids.tenant},${randomUUID()},'Fictional populated Rewards tenant')`;
   await tx`insert into company(id,tenant_id,legal_name) values(${ids.company},${ids.tenant},'Fictional legacy company')`;
   await tx`insert into department(id,tenant_id,company_id,name) values(${ids.department},${ids.tenant},${ids.company},'Fictional legacy department')`;
   await tx`insert into business_unit(id,tenant_id,company_id,code,name) values(${ids.bu},${ids.tenant},${ids.company},'UPGRADE','Fictional legacy BU')`;
   for(const [user,person,role,label] of [[ids.requester,ids.requesterPerson,'hr_admin','Requester'],[ids.checker,ids.checkerPerson,'hr_admin','Checker'],[ids.employeeUser,ids.employeePerson,'employee','BU reviewer']]){
    await tx`insert into person(id,tenant_id,full_name,primary_email) values(${person},${ids.tenant},${'Fictional '+label},${randomUUID()+'@upgrade.test'})`;
    await tx`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${user},${ids.tenant},${person},${randomUUID()})`;
    await tx`insert into role_assignment(tenant_id,app_user_id,role) values(${ids.tenant},${user},${role})`;
   }
   await actor(tx,ids.requester,'hr_admin');
   await tx`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${ids.employment},${ids.tenant},${ids.employeePerson},${ids.company},${`${year-1}-01-01`})`;
   await tx`insert into assignment(tenant_id,employment_id,department_id,business_unit_id,employment_type,status,valid_from) values(${ids.tenant},${ids.employment},${ids.department},${ids.bu},'full_time','active',${`${year-1}-01-01`})`;
   const [shared]=await tx`select app.reward_policy_group_commit(NULL,0,'Fictional legacy shared policy',${JSON.stringify(policy)}::jsonb,${JSON.stringify([{companyId:ids.company,businessUnitId:ids.bu}])}::jsonb) as version`;
   await tx`insert into reward_cycle(id,tenant_id,name,year,created_by) values(${ids.cycle},${ids.tenant},'Fictional legacy cycle',${year},${ids.requester})`;
   await tx`insert into reward_unit(id,tenant_id,cycle_id,company_id,business_unit_id,created_by,policy,snapshot_date,status,revision,policy_group_version_id) values(${ids.unit},${ids.tenant},${ids.cycle},${ids.company},${ids.bu},${ids.requester},${JSON.stringify(policy)}::jsonb,${day},'draft',2,${shared.version.versionId})`;
   await tx`insert into reward_member(id,tenant_id,unit_id,user_id,role) values(${ids.grMember},${ids.tenant},${ids.unit},${ids.requester},'gr'),(${ids.buMember},${ids.tenant},${ids.unit},${ids.employeeUser},'bu')`;
   await tx`insert into reward_decision(id,tenant_id,unit_id,actor_id,revision,action,from_stage,to_stage,reason,digest) values(${ids.decision},${ids.tenant},${ids.unit},${ids.requester},1,'return','bg','draft','Fictional earlier revision returned','fictional-legacy-digest')`;
   await tx`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${ids.audit},${ids.tenant},'reward-unit',${ids.unit},'reward-unit.returned','user',${ids.requester},'{"fixture":"legacy audit retained"}'::jsonb)`;
   await tx`insert into notification(id,tenant_id,recipient_employment_id,kind,title,body,link_path,severity,source_event_id) values(${ids.employmentNotice},${ids.tenant},${ids.employment},'rewards.review','Fictional legacy review notice','A review is waiting.',${'/rewards/'+ids.unit+'?view=approvals'},'info',${ids.audit})`;
   // Minimal valid letter chain, including an independent template approval and exact guarded notice.
   const letterPolicy={version:1,stages:[{key:'signatory',label:'Signatory',userIds:[ids.checker],allowDelegation:false}],signatoryUserId:ids.checker,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'none',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:true,emailNotifications:false};
   await tx`insert into letter_policy_version(id,tenant_id,company_id,category,ordinal,enabled,policy,created_by) values(${ids.letterPolicy},${ids.tenant},${ids.company},'confirmation',1,true,${JSON.stringify(letterPolicy)}::jsonb,${ids.requester})`;
   await tx`insert into letter_template(id,tenant_id,company_id,code,created_by) values(${ids.template},${ids.tenant},${ids.company},'UPGRADE',${ids.requester})`;
   await tx`insert into letter_template_version(id,tenant_id,company_id,template_id,ordinal,name,category,document,effective_from,created_by) values(${ids.templateVersion},${ids.tenant},${ids.company},${ids.template},1,'Fictional upgrade letter','confirmation',${JSON.stringify({version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Fictional legacy letter.'}]}]})}::jsonb,${day},${ids.requester})`;
   await tx`update letter_template_version set status='submitted' where id=${ids.templateVersion}`;
   await actor(tx,ids.checker,'hr_admin');await tx`update letter_template_version set status='approved' where id=${ids.templateVersion}`;
   await actor(tx,ids.requester,'hr_admin');
   await tx`insert into letter_generation_batch(id,tenant_id,company_id,template_version_id,policy_version_id,selection,input_hash,created_by,operation_key) values(${ids.batch},${ids.tenant},${ids.company},${ids.templateVersion},${ids.letterPolicy},${JSON.stringify({employmentIds:[ids.employment]})}::jsonb,${'a'.repeat(64)},${ids.requester},${randomUUID()})`;
   await tx`insert into letter_record(id,tenant_id,company_id,employment_id,batch_id,reference,created_by,confidential,retain_until) values(${ids.letter},${ids.tenant},${ids.company},${ids.employment},${ids.batch},'FICTIONAL-UPGRADE-1',${ids.requester},false,${`${year+1}-12-31`})`;
   await tx`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${ids.letterEvent},${ids.tenant},'letter',${ids.letter},'letter.draft.batch-created','user',${ids.requester},${JSON.stringify({batchId:ids.batch,count:1})}::jsonb)`;
   await tx`insert into letter_job(id,tenant_id,company_id,letter_id,kind,recipient_user_id,source_event_id,dedupe_key,payload,due_at) values(${ids.letterJob},${ids.tenant},${ids.company},${ids.letter},'notification',${ids.requester},${ids.letterEvent},${ids.batch+':created:'+ids.requester},${JSON.stringify({purpose:'draftCreated',batchId:ids.batch,portal:true,email:false})}::jsonb,now())`;
   await tx`insert into notification(id,tenant_id,recipient_user_id,company_id,letter_job_id,kind,title,body,link_path,severity,source_event_id) values(${ids.letterNotice},${ids.tenant},${ids.requester},${ids.company},${ids.letterJob},'letter.created','letters.notifications.created','letters.notifications.body',${'/letters/generate/'+ids.batch},'info',${ids.letterEvent})`;
  });
  const before=await unchangedRows();expect(before.units).toHaveLength(1);expect(before.members).toHaveLength(2);expect(before.decisions).toHaveLength(1);expect(before.audit.length).toBeGreaterThan(1);expect(before.groups).toHaveLength(1);expect(before.versions).toHaveLength(1);expect(before.targets).toHaveLength(1);expect(before.notifications).toHaveLength(2);expect(before.letterJobs).toHaveLength(1);expect(before.letters).toHaveLength(1);
  const [migrationClock]=await storage.client`select (now() at time zone 'Asia/Kuala_Lumpur')::date::text as day`;
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await unchangedRows()).toEqual(before);
  const seats=await storage.client`select id,valid_from::text,valid_to,covers_user_id,restored_reason,restored_fingerprint from reward_member where unit_id=${ids.unit} order by id`;
  expect(seats.map(row=>row.id).sort()).toEqual([ids.grMember,ids.buMember].sort());
  for(const seat of seats)expect(seat).toMatchObject({valid_from:migrationClock.day,valid_to:null,covers_user_id:null,restored_reason:null,restored_fingerprint:null});
  for(const [user,role,member,expected] of [[ids.requester,'hr_admin',ids.grMember,'gr'],[ids.employeeUser,'employee',ids.buMember,'bu']])await storage.client.begin(async tx=>{
   await actor(tx,user,role,true);const [proof]=await tx`select current_user as db_role,app.reward_member_eligible(${member}::uuid) as eligible,array(select app.reward_roles(${ids.unit}::uuid)) as roles`;
   expect(proof).toMatchObject({db_role:'ai_hr_app',eligible:true,roles:[expected]});
  });
  for(const [user,role,notice] of [[ids.employeeUser,'employee',ids.employmentNotice],[ids.requester,'hr_admin',ids.letterNotice]])await storage.client.begin(async tx=>{
   await actor(tx,user,role,true);const rows=await tx`select id from notification where id=${notice}`;expect(rows.map(row=>row.id)).toEqual([notice]);
  });
  // The old review has no current-transaction bootstrap receipt: even a real administrator must request a change.
  await expect(storage.client.begin(async tx=>{await actor(tx,ids.requester,'hr_admin',true);await tx`insert into reward_member(tenant_id,unit_id,user_id,role) values(${ids.tenant},${ids.unit},${ids.checker},'gr')`;})).rejects.toMatchObject({code:'42501'});
  expect(await unchangedRows()).toEqual(before);
  const changes=[{unitId:ids.unit,revision:2,before:null,after:{userId:ids.employeeUser,role:'pbp'}}];
  const requestId=await storage.client.begin(async tx=>{await actor(tx,ids.requester,'hr_admin',true);const [row]=await tx`select app.reward_access_request_create(${JSON.stringify(changes)}::jsonb) as id`;return row.id as string;});
  expect(await storage.client`select id from reward_member where unit_id=${ids.unit} and role='pbp'`).toHaveLength(0);
  await expect(storage.client.begin(async tx=>{await actor(tx,ids.requester,'hr_admin',true);await tx`select app.reward_access_request_decide(${requestId}::uuid,true,'')`;})).rejects.toMatchObject({code:'42501'});
  const [pending]=await storage.client`select status from reward_access_request where id=${requestId}`;expect(pending.status).toBe('pending');
  await storage.client.begin(async tx=>{await actor(tx,ids.checker,'hr_admin',true);const [row]=await tx`select app.reward_access_request_decide(${requestId}::uuid,true,'') as status`;expect(row.status).toBe('approved');});
  const [added]=await storage.client`select user_id,role from reward_member where unit_id=${ids.unit} and role='pbp'`;expect(added).toMatchObject({user_id:ids.employeeUser,role:'pbp'});
  const [receipt]=await storage.client`select actor_id from domain_event where aggregate_id=${requestId} and event_type='reward-access.approved'`;expect(receipt.actor_id).toBe(ids.checker);
  expect(await storage.client`select * from reward_decision where tenant_id=${ids.tenant}`).toEqual(before.decisions);
  expect(await storage.client`select * from notification where tenant_id=${ids.tenant} order by id`).toEqual(before.notifications);
  await migrate(storage.db,{migrationsFolder:'db/migrations'});
  expect(await storage.client`select * from notification where tenant_id=${ids.tenant} order by id`).toEqual(before.notifications);
 }finally{
  await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();rmSync(directory,{recursive:true,force:true});
 }
},180_000);
