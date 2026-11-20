/** Exact public F8/Board924 historical replay +145 forward bodies, populated BEFORE either upgrade.
 * Separate from the existing729 rehearsal. Disposable source-derived evidence, never an installed-ledger export.
 * Board business records are produced by the frozen native child, not copied/forged managed state.
 * A second phase applies the independently pinned Board50 plus the separately appended public-guidance migration to both actual1069 databases.
 */
import {createHash,randomUUID} from 'node:crypto';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import postgres from 'postgres';
import {getTableName,sql} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import type {PgTable} from 'drizzle-orm/pg-core';
import {afterAll,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {createDb} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {todayInKualaLumpur} from '../lib/hr-date';
import {seedCatalogsAt} from '../scripts/seed-catalogs';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule} from './harness';
import {assertApprovedUpgradeTail} from './helpers/approved-upgrade';
import {copyTenantRowsAtPrefix} from './helpers/prefix-seed';
import {PROJECT_INSTALLED_OWNERSHIP} from './helpers/installed-owner-projection';
import {pgSqlState} from '../lib/db-error';
import {snapshotCatalogue,catalogueDifferences,snapshotPublicRows,purposeOwned,ownerRoleGraph,ownerAttributes,ledger,leftovers} from './helpers/combined-board-baseline-observer';

type Entry={idx:number;version:string;when:number;tag:string;breakpoints:boolean};
type Journal={version:string;dialect:string;entries:Entry[]};
type Notice={severity:string;code:string;message:string};
type SeedReceipt={source:string;actor:{userId:string;personId:string};businessUnitId:string;checkerUserId:string;
 plan:{year:number;companyId:string;revision:number;versionId:string;planType:'no_awards';reason:string};
 history:{id:string;jobId:string;employmentId:string;companyId:string;year:number;kind:'annual';source:'upload'};
 expected:{incrementCents:string;bonusCents:string;incrementBp:number;bonusMonthsBp:number}};
type ChildResult={kind:'NATIVE_F8_BOARD_BASELINE';mode:'seed'|'read';source:string;receipt:SeedReceipt;
 checks:{plan:boolean;historyMetadata:boolean;uploadCompleted:boolean;privateAmountsDenied:boolean;companyRetention:boolean}};
const F8='f8c90ebcd3c0d4bd8310d9fb1cbab645b2ad108e';
const CANDIDATE='e17b0e022c373af9b713940cb11cfff16fce8c2f';
const PREFIX=924,TAIL=145,BOARD_TAIL=50,GUIDANCE_TAIL=1,SIX_ITEM_TAIL=4,PAYROLL_ACCESS_TAIL=1,OWNER='ai_hr_owner';
const GUIDANCE:Entry={idx:10360,version:'7',when:1795028006960,tag:'6960_board_public_guidance_function_kinds',breakpoints:true};
const PAYROLL_ACCESS:Entry={idx:10440,version:'7',when:1795028007040,tag:'7040_payroll_original_employer_row_security',breakpoints:true};
const GUIDANCE_SHA256='c1b4926b4d1860e6a4a79019685c39ba0988af3a97f30dbdebf2365565c0972b';
const PREFIX_DIGEST='a1823185bd55be1e39e17ad0469f212339dab21ced58b83f1266f615010efd5b';
const PRIOR_TAIL=144,PRIOR_TAIL_DIGEST='1fad77ff8ff4ac272b07146c3ed4805dadaf190e7ad7e1c7794cfa115f468e77';
const TAIL_DIGEST='63c7c63e258e3a05b2e75b964e0a00b7858638c63a7a524beef60a73077a6277';
const LAST:Entry={idx:5504,version:'7',when:1794841006104,tag:'6104_lifecycle_recipient_fanout',breakpoints:true};
const ATTRIBUTES=[{login:true,inherit:true,super:false,createdb:false,createrole:false,replication:false,bypassrls:false}];
const PURPOSE_READERS:Record<string,string>={
 'app.reward_uploaded_snapshot_roster(uuid,date)':'ai_hr_reward_setup_reader',
 'app.reward_create_planned_unit_bound(uuid,uuid,uuid)':'ai_hr_reward_setup_reader',
 'app.reward_setup_grade_choices()':'ai_hr_reward_setup_reader',
 'app.reward_uploaded_validation(uuid)':'ai_hr_reward_upload_reader',
};
// Exact audited public archive identities, also checked against the canonical history module below.
const HISTORICAL=[
 {tag:'0180_profile_option',when:1781862179000,currentSha256:'2e4c8e82998f00ffdc4e06913ef25c37216f4c86a9ce0a5216bf0abb2bd30898',appliedSha256:'ae128e75c9491bd1d39537fdddd18ad9307b2050f813b8a056d473dcfda9d41f',originalCommit:'b33432256168fc67955e5f183bb84c1a444b63ed'},
 {tag:'0212_dashboard_card_config',when:1781862211000,currentSha256:'f02ea6e29fa45da548a6d2fd524f0822299d7ebb748ad3db742dcf308de6bf56',appliedSha256:'aa9337028da35cd3816d8d66486455595e36aea709c98405868ca36320c99f41',originalCommit:'b8bb0740d3fa5ef1cf60400eb484fa40399e921c'},
];
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const exec=promisify(execFile);
afterAll(closeAll);

async function verifyPayrollProcessFourGrants(observer:postgres.Sql,tenantId:string) {
 const allowed=Array.from({length:4},(_,index)=>({
  id:randomUUID(),historyBatchId:randomUUID(),draftBatchId:randomUUID(),period:'2026-0'+String(index+6),
 }));
 const ungrantedCompanyId=randomUUID(),ungrantedBatchId=randomUUID();
 const userId=randomUUID(),attemptId=randomUUID(),source='fictional payroll process regression';
 const allowedIds=allowed.map(company=>company.id);
 const grants=allowedIds.map(companyId=>({role:'hr_admin',companyId}));
 await observer.begin(async tx=>{
  // Only the disposable rehearsal database uses fixture inserts in place of an import job.
  await tx`set local session_replication_role = replica`;
  await tx`insert into public.company(id,tenant_id,legal_name)
    select id,${tenantId},'Payroll Process rehearsal '||id from unnest(${[...allowedIds,ungrantedCompanyId]}::uuid[]) ids(id)`;
  await tx`insert into public.app_user(id,tenant_id,workos_user_id) values(${userId},${tenantId},${'user_'+userId})`;
  await tx`insert into public.role_assignment(tenant_id,app_user_id,company_id,role)
    select ${tenantId},${userId},id,'hr_admin' from unnest(${allowedIds}::uuid[]) ids(id)`;
  await tx`insert into public.payroll_history_import_attempt
    (id,tenant_id,created_by,operation_key,source_name,mime_type,source_hash,source_content,company_ids,plan)
    values(${attemptId},${tenantId},${userId},${attemptId},'payroll-process-rehearsal.csv','text/csv',
      ${sha(source)},${Buffer.from(source)},${allowedIds}::uuid[],'{}'::jsonb)`;
  for (const company of allowed) {
   await tx`insert into public.payroll_batch
     (id,tenant_id,company_id,pay_period,batch_date,run_type,status,employee_count,history_import_attempt_id)
     values(${company.historyBatchId},${tenantId},${company.id},'2026-11','2026-11-28','adjustment','closed',0,${attemptId}),
           (${company.draftBatchId},${tenantId},${company.id},${company.period},${company.period+'-28'},'regular','draft',0,null)`;
  }
  await tx`insert into public.payroll_batch(id,tenant_id,company_id,pay_period,batch_date,run_type,status,employee_count)
    values(${ungrantedBatchId},${tenantId},${ungrantedCompanyId},'2026-12','2026-12-28','regular','draft',0)`;
  await tx`set local session_replication_role = origin`;
  await tx`set local role ai_hr_app`;
  await tx`select set_config('app.tenant_id',${tenantId},true),set_config('app.user_id',${userId},true),
    set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(grants)},true),
    set_config('app.payroll_tax_basis_reader','1',true),set_config('app.payroll_import_tax_basis_reader','1',true),
    set_config('jit','off',true)`;
  const latestPeriod=async(companyIds:string[])=>{
   const [period]=await tx<{latest:string|null}[]>`select max(b.pay_period) as latest
     from public.payroll_history_effective_batch b join public.company c on c.id=b.company_id
     where b.company_id=any(${companyIds}::uuid[]) and (b.history_import_attempt_id is null or b.employee_count>0)`;
   return period.latest;
  };
  for (const company of allowed) expect(await latestPeriod([company.id])).toBe(company.period);
  expect(await latestPeriod(allowedIds)).toBe('2026-09');
  expect(await latestPeriod([ungrantedCompanyId])).toBeNull();
  const [permission]=await tx<{allowed:boolean;ungranted:boolean}[]>`select
    app.payroll_tax_basis_original_employer_read(${allowed[0].historyBatchId}) as allowed,
    app.payroll_tax_basis_original_employer_read(${ungrantedBatchId}) as ungranted`;
  expect(permission).toEqual({allowed:true,ungranted:false});
 });
}

it('replays exact frozen924 +145, then reviewed Board50 as literal ai_hr_owner, preserving native data and matching a superuser twin',async()=>{
 const root=process.cwd(),base=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 // Before any connection: only this generated namespace on the existing disposable hosted cluster.
 expect(['postgres:','postgresql:']).toContain(base.protocol);expect(base.hostname).toBe('127.0.0.1');expect(base.port).toBe('5433');
 expect(base.username).toBe('postgres');expect(base.password).toBe('');expect(base.search).toBe('');expect(base.hash).toBe('');
 expect(/^\/ai_hr_test(?:_w(?:_aifocus)?[1-9][0-9]*|_tpl(?:_aifocus)?)?$/.test(base.pathname)).toBe(true);
 const id=randomUUID().replaceAll('-',''),names={base:'ai_hr_exact924_base_'+id,ref:'ai_hr_exact924_ref_'+id,owner:'ai_hr_exact924_owner_'+id};
 const at=(name:string,user=base.username)=>{expect(Object.values(names).includes(name)||name==='postgres').toBe(true);const u=new URL(base);u.pathname='/'+name;u.username=user;u.password='';return u.toString();};
 const folder=realpathSync(mkdtempSync(join(tmpdir(),'aihr-exact924-'))),source=join(folder,'source'),forwardSource=join(folder,'candidate'),migrations=join(folder,'migrations');
 const pools:postgres.Sql[]=[];
 const connect=(url:string,notices?:Notice[])=>{const client=postgres(url,{max:1,connect_timeout:10,onnotice:n=>notices?.push({severity:String(n.severity),code:String(n.code),message:String(n.message)})});pools.push(client);return client;};
 const close=async(client:postgres.Sql)=>{await client.end({timeout:5});const i=pools.indexOf(client);if(i>=0)pools.splice(i,1);};
 let admin:postgres.Sql|undefined;
 try{
  // Frozen public tracked sources only. No live checkout, environment file, network fallback or ledger input.
  for(const [commit,destination] of [[F8,source],[CANDIDATE,forwardSource]] as const){
   expect(execFileSync('git',['rev-parse',commit+'^{commit}'],{cwd:root,encoding:'utf8'}).trim()).toBe(commit);
   mkdirSync(destination);const archive=join(folder,commit+'.tar');
   execFileSync('git',['archive','--format=tar','--output='+archive,commit],{cwd:root});
   execFileSync('tar',['-xf',archive,'-C',destination]);
  }
  for(const file of ['package.json','pnpm-lock.yaml','scripts/seed-catalogs.ts','packs/catalog.ts']){
   expect(readFileSync(join(source,file)).equals(readFileSync(join(forwardSource,file))),file+' same frozen dependency/catalogue source').toBe(true);
   if(file!=='package.json'&&file!=='pnpm-lock.yaml')expect(readFileSync(join(source,file)).equals(readFileSync(join(root,file))),file+' current prepared catalogue source').toBe(true);
  }
  // Approved additive leaf only. Remove these exact bytes ONCE from the current manifest/lock
  // and require byte-for-byte equality with BOTH frozen archives above. Every pre-existing
  // dependency, version, peer binding, integrity and snapshot therefore remains unchanged.
  // The historical source files and runtime are never overlaid with candidate application code.
  const leafAdditions:Record<string,string[]>={
   'package.json':['    "libphonenumber-js": "1.13.16",\n'],
   'pnpm-lock.yaml':[
    '      libphonenumber-js:\n        specifier: 1.13.16\n        version: 1.13.16\n',
    '  libphonenumber-js@1.13.16:\n    resolution: {integrity: sha512-tIOCM9yx2Go6d5/ZANe0K+G4AZek1Ymx81HxQpf19Sri4zMP95eQbKdnUGHAvFQ4nx0PeLhFqvAfisTADXj3tQ==}\n\n',
    '  libphonenumber-js@1.13.16: {}\n\n',
   ],
  };
  for(const [file,additions]of Object.entries(leafAdditions)){
   const archived=readFileSync(join(source,file),'utf8');let prepared=readFileSync(join(root,file),'utf8');
   for(const addition of additions){
    expect(archived.includes(addition),file+' leaf is absent from the frozen runtime').toBe(false);
    expect(prepared.split(addition)).toHaveLength(2);prepared=prepared.replace(addition,'');
   }
   expect(prepared,file+' only the exact approved additive leaf differs').toBe(archived);
  }
  symlinkSync(realpathSync(join(root,'node_modules')),join(source,'node_modules'),'dir');
  const currentJournal=JSON.parse(readFileSync(join(root,'db/migrations/meta/_journal.json'),'utf8')) as Journal;
  const frozen=JSON.parse(readFileSync(join(source,'db/migrations/meta/_journal.json'),'utf8')) as Journal;
  const candidate=JSON.parse(readFileSync(join(forwardSource,'db/migrations/meta/_journal.json'),'utf8')) as Journal;
  // The original phase still uses ONLY the exact historical candidate archive. A later source
  // cannot redefine its145 bodies, digest, order or rehearsal merely by appending a migration.
  const journal=candidate;
  expect(frozen.entries).toHaveLength(PREFIX);expect(journal.entries).toHaveLength(PREFIX+TAIL);
  expect(currentJournal.entries).toHaveLength(PREFIX+TAIL+BOARD_TAIL+GUIDANCE_TAIL+SIX_ITEM_TAIL+PAYROLL_ACCESS_TAIL);
  const guidanceStart=PREFIX+TAIL+BOARD_TAIL;
  const guidanceTail=currentJournal.entries.slice(guidanceStart,guidanceStart+GUIDANCE_TAIL);
  expect(guidanceTail).toEqual([GUIDANCE]);
  const sixItemStart=guidanceStart+GUIDANCE_TAIL;
  const sixItemTail=currentJournal.entries.slice(sixItemStart,sixItemStart+SIX_ITEM_TAIL);
  const payrollAccessTail=currentJournal.entries.slice(sixItemStart+SIX_ITEM_TAIL);
  expect(payrollAccessTail).toEqual([PAYROLL_ACCESS]);
  expect(sixItemTail).toHaveLength(SIX_ITEM_TAIL);
  expect(sha(readFileSync(join(root,'db/migrations',GUIDANCE.tag+'.sql')))).toBe(GUIDANCE_SHA256);
  expect({...currentJournal,entries:currentJournal.entries.slice(0,PREFIX+TAIL)}).toEqual(candidate);
  // This existing independent owner pins the exact current journal and literal SHA256 of each
  // reviewed forward SQL body. It runs before any connection and again before phase two.
  assertApprovedUpgradeTail(currentJournal.entries);
  expect(frozen.entries[PREFIX-1]).toEqual(LAST);expect(journal.entries.slice(0,PREFIX)).toEqual(frozen.entries);
  // Reuse audited archive owner through a separate public-source module, without importing a legacy test.
  const historicalModule=await import(/* @vite-ignore */ new URL('../.github/ci/migration-history.mjs',import.meta.url).href) as {
   HISTORICAL_MIGRATIONS:typeof HISTORICAL;
   appliedMigrationIdentity:(tag:string,when:number,bytes:Buffer,options:{readArchive:(record:typeof HISTORICAL[number])=>Buffer})=>{hash:string};
  };
  expect(readFileSync(join(root,'.github/ci/migration-history.mjs')).equals(readFileSync(join(source,'.github/ci/migration-history.mjs')))).toBe(true);
  expect(historicalModule.HISTORICAL_MIGRATIONS).toEqual(HISTORICAL);
  mkdirSync(join(migrations,'meta'),{recursive:true});
  const identities=frozen.entries.map(entry=>{
   const bytes=readFileSync(join(source,'db/migrations',entry.tag+'.sql'));
   expect(readFileSync(join(root,'db/migrations',entry.tag+'.sql')).equals(bytes),entry.tag+' immutable prefix SQL').toBe(true);
   const currentHash=sha(bytes),identity=historicalModule.appliedMigrationIdentity(entry.tag,entry.when,bytes,{readArchive:record=>readFileSync(join(source,'.github/ci/historical-migrations',record.tag+'.sql'))});
   const historical=HISTORICAL.find(record=>record.tag===entry.tag);
   const applied=historical?readFileSync(join(source,'.github/ci/historical-migrations',entry.tag+'.sql')):bytes;
   expect(sha(applied)).toBe(identity.hash);writeFileSync(join(migrations,entry.tag+'.sql'),applied);
   return [entry.idx,entry.version,entry.when,entry.tag,entry.breakpoints,currentHash,identity.hash];
  });
  expect(sha(JSON.stringify(identities))).toBe(PREFIX_DIGEST);
  const tail=journal.entries.slice(PREFIX);expect(tail).toHaveLength(TAIL);expect(tail[0].tag).toBe('6300_resignation_journey');
  expect(new Set(tail.map(e=>e.when)).size).toBe(TAIL);
  const tailIdentities=tail.map((entry,i)=>{
   expect(entry.when).toBeGreaterThan(i?tail[i-1].when:LAST.when);
   const bytes=readFileSync(join(forwardSource,'db/migrations',entry.tag+'.sql'));
   expect(readFileSync(join(root,'db/migrations',entry.tag+'.sql')).equals(bytes),entry.tag+' frozen reviewed tail').toBe(true);
   writeFileSync(join(migrations,entry.tag+'.sql'),bytes);
   const hash=sha(bytes);return[entry.idx,entry.version,entry.when,entry.tag,entry.breakpoints,hash,hash];
  });
  expect(sha(JSON.stringify(tailIdentities.slice(0,PRIOR_TAIL)))).toBe(PRIOR_TAIL_DIGEST);
  expect(sha(JSON.stringify(tailIdentities))).toBe(TAIL_DIGEST);
  // The historical timestamp tie remains ordered exactly as public source, never sorted/deduplicated.
  expect(frozen.entries.filter(e=>e.tag==='0220_scheme_leave_combined_limit'||e.tag==='0240_employment_blacklist')).toEqual([
   {idx:220,version:'7',when:1781862219000,tag:'0220_scheme_leave_combined_limit',breakpoints:true},
   {idx:240,version:'7',when:1781862219000,tag:'0240_employment_blacklist',breakpoints:true},
  ]);
  const expectedLedger=journal.entries.map(e=>({hash:sha(readFileSync(join(migrations,e.tag+'.sql'))),created_at:String(e.when)}));
  writeFileSync(join(migrations,'meta/_journal.json'),JSON.stringify({...journal,entries:frozen.entries}));
  admin=connect(at('postgres'));
  const [cluster]=await admin.unsafe<{superuser:string;super:boolean;version:number}[]>(`select current_user::text as superuser,(select rolsuper from pg_roles where rolname=current_user) as super,current_setting('server_version_num')::int as version`);
  expect(cluster.super).toBe(true);expect(cluster.version).toBeGreaterThanOrEqual(160000);expect(await ownerAttributes(admin)).toEqual(ATTRIBUTES);
  const superuser=cluster.superuser;
  await admin.unsafe(`CREATE DATABASE "${names.base}"`);const baseline=connect(at(names.base));
  // Same bootstrap/default-privilege spine as the existing installed-owner rehearsal.
  await baseline.unsafe(`GRANT USAGE ON SCHEMA public TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE ai_hr_owner IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE ai_hr_owner IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE "${superuser}" IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE "${superuser}" IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ai_hr_app;
   DO $platform$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_platform') THEN GRANT USAGE ON SCHEMA public TO ai_hr_platform;END IF;END $platform$;`);
  await migrate(drizzle(baseline),{migrationsFolder:migrations});expect(await ledger(baseline)).toEqual(expectedLedger.slice(0,PREFIX));
  await seedCatalogsAt(at(names.base));
  await resetDb();const b=await seedBase();await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'rewards','active');
  const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional exact924 maker',${randomUUID()+'@exact924.test'}) returning id`);
  await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${b.adminUserId}::uuid`);
  const ctx={...await entitledCtx(b),personId:person.id},year=Number(todayInKualaLumpur().slice(0,4)),hiredOn=String(year-3)+'-01-01';
  const employee=await hireEmployee(ctx,{person:{fullName:'Fictional924 worker',primaryEmail:randomUUID()+'@exact924.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'F8-924',hiredOn});
  await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:5000,effectiveFrom:hiredOn});
  const target=createDb(at(names.base),{max:1});
  try{
   const tables:PgTable[]=[schema.tenant,schema.company,schema.department,schema.position,schema.costCenter,schema.leaveType,schema.person,schema.appUser,schema.roleAssignment,schema.tenantModule,schema.employment,schema.assignment,schema.compensation,schema.domainEvent];
   for(const table of tables){const count=await copyTenantRowsAtPrefix(owner,target,table,b.tenantId);if(['tenant','company','person','app_user','tenant_module','employment','assignment','compensation','domain_event'].includes(getTableName(table)))expect(count,getTableName(table)+' nonempty').toBeGreaterThan(0);}
   // Explicit sequence values copied above must not make genuinely new native audit events run backwards.
   // Only this disposable baseline generator changes; every copied event image remains intact.
   const [sequence]=await target.client.unsafe<{last:string;maximum:string}[]>(`select setval(pg_get_serial_sequence('public.domain_event','sequence'),(select max(sequence) from public.domain_event),true)::text as last,(select max(sequence)::text from public.domain_event) as maximum`);
   expect(BigInt(sequence.maximum)).toBeGreaterThan(BigInt(0));expect(BigInt(sequence.last)).toBeGreaterThanOrEqual(BigInt(sequence.maximum));
  }finally{await target.client.end({timeout:5});}
  const seedInput={sourceRoot:source,ctx:{tenantId:b.tenantId,userId:b.adminUserId,personId:person.id,roles:['hr_admin']},companyId:b.companyId,departmentId:b.deptA,employmentId:employee.employmentId,employeeCode:'F8-924',year};
  const child=async(mode:'seed'|'read',database:string,receipt?:SeedReceipt)=>{
   const url=at(database),appUrl=at(database,'ai_hr_app');
   const {stdout}=await exec(process.execPath,['--conditions=react-server','--import','tsx',resolve(root,'test/helpers/combined-board-baseline-seed-child.ts'),JSON.stringify({...seedInput,mode,receipt})],{
    cwd:source,env:{...process.env,DATABASE_URL:appUrl,TEST_DATABASE_URL:appUrl,MIGRATION_DATABASE_URL:url,TEST_MIGRATION_DATABASE_URL:url,TSX_TSCONFIG_PATH:join(source,'tsconfig.json'),VITEST_POOL_ID:'1'},timeout:300_000,maxBuffer:4*1024*1024});
   const lines=stdout.split('\n').filter(line=>line.startsWith('EXACT_924_RESULT '));expect(lines).toHaveLength(1);
   const result=JSON.parse(lines[0].slice('EXACT_924_RESULT '.length)) as ChildResult;
   expect(result).toMatchObject({kind:'NATIVE_F8_BOARD_BASELINE',source:F8,mode,checks:{plan:true,historyMetadata:true,uploadCompleted:true,privateAmountsDenied:true,companyRetention:true}});
   if(receipt)expect(result.receipt).toEqual(receipt);return result.receipt;
  };
  const receipt=await child('seed',names.base);
  expect(receipt).toMatchObject({source:F8,actor:{userId:b.adminUserId,personId:person.id},plan:{year,companyId:b.companyId,revision:2,planType:'no_awards'},history:{employmentId:employee.employmentId,companyId:b.companyId,year:year-2,kind:'annual',source:'upload'},expected:{incrementCents:'25000',bonusCents:'500000',incrementBp:500,bonusMonthsBp:10000}});
  expect(receipt.checkerUserId).not.toBe(b.adminUserId);
  // Independent physical PostgreSQL facts: these expectations do not come from the child's PASS flags.
  const verifyNativeFacts=async(client:postgres.Sql)=>{
   const employment=await client.unsafe<{company:string;hired:string;code:string}[]>(`select company_id::text as company,hired_on::text as hired,employee_code as code from employment where tenant_id=$1::uuid and id=$2::uuid`,[b.tenantId,employee.employmentId]);
   expect([...employment]).toEqual([{company:b.companyId,hired:hiredOn,code:'F8-924'}]);
   // Assignment owns employment type. Native independently approved mapping publication projects
   // the actual hire range at its effective day, retaining the earlier placement interval.
   const assignment=await client.unsafe<{company:string;department:string;unit:string|null;type:string;start:string;end:string|null}[]>(`select company_id::text as company,department_id::text as department,business_unit_id::text as unit,employment_type as type,valid_from::text as start,valid_to::text as end from assignment where tenant_id=$1::uuid and employment_id=$2::uuid and superseded_at is null order by valid_from,id`,[b.tenantId,employee.employmentId]);
   expect([...assignment]).toEqual([
    {company:b.companyId,department:b.deptA,unit:null,type:'full_time',start:hiredOn,end:String(year)+'-01-01'},
    {company:b.companyId,department:b.deptA,unit:receipt.businessUnitId,type:'full_time',start:String(year)+'-01-01',end:null},
   ]);
   const classifications=await client.unsafe<{company:string;day:string;unit:string}[]>(`select company_id::text as company,effective_on::text as day,tags->>'businessUnitId' as unit from employment_organisation_classification where tenant_id=$1::uuid and employment_id=$2::uuid and effective_on=$3::date`,[b.tenantId,employee.employmentId,String(year)+'-01-01']);
   expect(classifications.length,'native mapping classification receipts are nonempty').toBeGreaterThan(0);
   for(const classification of classifications)expect(classification).toEqual({company:b.companyId,day:String(year)+'-01-01',unit:receipt.businessUnitId});
   const compensation=await client.unsafe<{salary:string;currency:string;start:string}[]>(`select basic_salary::text as salary,currency,valid_from::text as start from compensation where tenant_id=$1::uuid and employment_id=$2::uuid and superseded_at is null and valid_to is null`,[b.tenantId,employee.employmentId]);
   expect([...compensation]).toEqual([{salary:'5000.00',currency:'MYR',start:hiredOn}]);
   const history=await client.unsafe<{id:string;company:string;employment:string;year:number;kind:string;source:string;creator:string;job:string;increment:string;bonus:string;merit:number;increase:string;months:string}[]>(`select id::text,company_id::text as company,employment_id::text as employment,year,kind,source,created_by::text as creator,upload_batch_id::text as job,increment_cents::text as increment,bonus_cents::text as bonus,merit_bp as merit,total_increase_bp::text as increase,bonus_months_bp::text as months from reward_person_history where tenant_id=$1::uuid and id=$2::uuid and superseded_at is null`,[b.tenantId,receipt.history.id]);
   expect([...history]).toEqual([{id:receipt.history.id,company:b.companyId,employment:employee.employmentId,year:year-2,kind:'annual',source:'upload',creator:b.adminUserId,job:receipt.history.jobId,increment:'25000',bonus:'500000',merit:500,increase:'500',months:'10000'}]);
   const job=await client.unsafe<{creator:string;kind:string;state:string}[]>(`select created_by::text as creator,kind,state from bulk_job where tenant_id=$1::uuid and id=$2::uuid`,[b.tenantId,receipt.history.jobId]);
   expect([...job]).toEqual([{creator:b.adminUserId,kind:'reward_person_history',state:'completed'}]);
   const plan=await client.unsafe<{type:string;reason:string;revision:number;version:string;creator:string;person:string}[]>(`select c.plan_type as type,c.reason,c.revision,c.plan_version_id::text as version,y.created_by::text as creator,y.created_by_person_id::text as person from reward_plan_year_company c join reward_plan_year y using(tenant_id,year) where c.tenant_id=$1::uuid and c.year=$2 and c.company_id=$3::uuid`,[b.tenantId,year,b.companyId]);
   expect([...plan]).toEqual([{type:'no_awards',reason:'Fictional company has no awards this year',revision:2,version:receipt.plan.versionId,creator:b.adminUserId,person:person.id}]);
   const version=await client.unsafe<{creator:string;company:string;unit:string}[]>(`select v.created_by::text as creator,t.company_id::text as company,t.business_unit_id::text as unit from reward_policy_group_version v join reward_policy_group_target t on t.tenant_id=v.tenant_id and t.version_id=v.id where v.tenant_id=$1::uuid and v.id=$2::uuid`,[b.tenantId,receipt.plan.versionId]);
   expect([...version]).toEqual([{creator:b.adminUserId,company:b.companyId,unit:receipt.businessUnitId}]);
   const exclusion=await client.unsafe<{creator:string;type:string;reason:string}[]>(`select created_by::text as creator,award_type as type,reason from reward_company_exclusion where tenant_id=$1::uuid and company_id=$2::uuid and year=$3 and ended_at is null`,[b.tenantId,b.companyId,year]);
   expect([...exclusion]).toEqual([{creator:b.adminUserId,type:'no_awards',reason:'Fictional company has no awards this year'}]);
   const audit=await client.unsafe<{event:string;actor:string;type:string}[]>(`select event_type as event,actor_id::text as actor,actor_type as type from domain_event where tenant_id=$1::uuid and event_type in('reward-plan.created','reward-plan.changed') order by sequence`,[b.tenantId]);
   expect([...audit]).toEqual([{event:'reward-plan.created',actor:b.adminUserId,type:'user'},{event:'reward-plan.changed',actor:b.adminUserId,type:'user'}]);
   const uploadAudit=await client.unsafe<{actor:string;type:string;employment:string;year:number;source:string}[]>(`select actor_id::text as actor,actor_type as type,payload->>'employmentId' as employment,(payload->>'year')::int as year,payload->>'source' as source from domain_event where tenant_id=$1::uuid and aggregate_id=$2::uuid and event_type='reward-person-history.uploaded'`,[b.tenantId,receipt.history.jobId]);
   expect([...uploadAudit]).toEqual([{actor:b.adminUserId,type:'user',employment:employee.employmentId,year:year-2,source:'upload'}]);
  };
  await verifyNativeFacts(baseline);
  const before=await snapshotPublicRows(baseline),columns=Object.fromEntries(Object.entries(before).map(([key,value])=>[key,value.columns]));
  for(const table of ['public.reward_plan_year','public.reward_plan_year_company','public.reward_policy_group_version','public.reward_policy_group_target','public.reward_company_exclusion','public.reward_person_history','public.bulk_job','public.domain_event'])expect(before[table]?.rows.length,table+' actual native rows').toBeGreaterThan(0);
  await close(baseline); // Child pools also close before cloning; CREATE TEMPLATE refuses leaked connections.
  await admin.unsafe(`CREATE DATABASE "${names.ref}" TEMPLATE "${names.base}"`);
  await admin.unsafe(`CREATE DATABASE "${names.owner}" TEMPLATE "${names.base}" OWNER ai_hr_owner`);
  const observer=connect(at(names.owner));await observer.unsafe(`GRANT CONNECT ON DATABASE "${names.owner}" TO ai_hr_app`);
  await observer.unsafe(PROJECT_INSTALLED_OWNERSHIP);await observer.unsafe(readFileSync(join(root,'deploy/runner-control/rewards-deletion-role-prerequisite.sql'),'utf8'));
  expect(await leftovers(observer)).toEqual([]);
  const [ownership]=await observer.unsafe<{database:string;app:string;drizzle:string;ledger:string}[]>(`select (select pg_get_userbyid(datdba) from pg_database where datname=current_database())::text as database,(select pg_get_userbyid(nspowner) from pg_namespace where nspname='app')::text as app,(select pg_get_userbyid(nspowner) from pg_namespace where nspname='drizzle')::text as drizzle,(select pg_get_userbyid(relowner) from pg_class where oid='drizzle.__drizzle_migrations'::regclass)::text as ledger`);
  expect(ownership).toEqual({database:OWNER,app:OWNER,drizzle:OWNER,ledger:OWNER});
  const purposeBefore=await purposeOwned(observer,superuser),graphBefore=await ownerRoleGraph(observer);
  for(const [key,role]of Object.entries(PURPOSE_READERS))expect(purposeBefore.find(row=>row.key===key)?.owner,key).toBe(role);
  expect(graphBefore.filter(e=>e.member===OWNER&&e.role!=='ai_hr_app'&&e.role!=='ai_hr_draft_discard_port')).toEqual([]);
  for(const edge of graphBefore.filter(e=>e.member===OWNER))expect(edge).toMatchObject({inherit:false,set:true,admin:false});
  for(const role of [...new Set(purposeBefore.map(row=>row.owner))].filter(role=>role!=='ai_hr_draft_discard_port'))expect((await observer.unsafe<{member:boolean}[]>(`select pg_has_role('ai_hr_owner',$1,'MEMBER') as member`,[role]))[0].member,role+' not inherited').toBe(false);
  const referenceNotices:Notice[]=[],ownerNotices:Notice[]=[];
  const reference=connect(at(names.ref),referenceNotices),restricted=connect(at(names.owner,OWNER),ownerNotices);
  // Existing stock superuser-reference prerequisite; no purpose-role membership or new grant invented.
  await reference.unsafe(`GRANT EXECUTE ON FUNCTION app.reward_setup_allowed(uuid,text) TO ai_hr_owner`);
  const [login]=await restricted.unsafe<{session:string;current:string;role:string}[]>(`select session_user::text as session,current_user::text as current,current_setting('role') as role`);
  expect(login).toEqual({session:OWNER,current:OWNER,role:'none'});expect(await ownerAttributes(restricted)).toEqual(ATTRIBUTES);
  writeFileSync(join(migrations,'meta/_journal.json'),JSON.stringify(journal));
  await migrate(drizzle(reference),{migrationsFolder:migrations});
  await migrate(drizzle(restricted),{migrationsFolder:migrations}); // Refusal remains a failure; never owner-repaired through the twin.
  for(const client of [reference,restricted])expect(await ledger(client)).toEqual(expectedLedger);
  const warnings=(notices:Notice[])=>notices.filter(n=>n.severity==='WARNING').map(n=>n.code+' '+n.message).sort();
  expect(ownerNotices.filter(n=>n.code==='01006'||n.code==='01007')).toEqual([]);expect(warnings(ownerNotices)).toEqual(warnings(referenceNotices));
  expect(await purposeOwned(observer,superuser)).toEqual(purposeBefore);expect(await ownerRoleGraph(observer)).toEqual(graphBefore);expect(await ownerAttributes(observer)).toEqual(ATTRIBUTES);expect(await leftovers(observer)).toEqual([]);
  const catalogue=await snapshotCatalogue(observer,superuser);expect(catalogueDifferences(await snapshotCatalogue(reference,superuser),catalogue)).toEqual([]);
  for(const [client,name]of [[reference,names.ref],[observer,names.owner]] as const){
   const retained=await snapshotPublicRows(client,columns);
   // Preserve EACH original image with multiplicity, while allowing source-defined new rows.
   // A changed/deleted original row fails; there are no table-wide exclusions or value normalization.
   for(const [table,original]of Object.entries(before)){
    expect(retained[table].columns,table+' original columns').toEqual(original.columns);
    const counts=new Map<string,number>();for(const row of retained[table].rows)counts.set(row,(counts.get(row)??0)+1);
    for(const row of original.rows){expect(counts.get(row)??0,table+' retains original PostgreSQL row image').toBeGreaterThan(0);counts.set(row,counts.get(row)!-1);}
   }
   await verifyNativeFacts(client);
   await child('read',name,receipt);
   const [boundary]=await client.unsafe<{archiveApp:boolean;archivePublic:boolean;expression:string;validated:boolean}[]>(`select has_function_privilege('ai_hr_app','app.contract_configuration_directory_before_combined(uuid[],text,uuid[])','EXECUTE') as "archiveApp",exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='app.contract_configuration_directory_before_combined(uuid[],text,uuid[])'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') as "archivePublic",regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[[:space:]]','','g') as expression,c.convalidated as validated from pg_constraint c where c.conrelid='public.automation_email_delivery'::regclass and c.conname='automation_email_delivery_module_check'`);
   expect(boundary).toEqual({archiveApp:false,archivePublic:false,expression:"(module=ANY(ARRAY['probation'::text,'contract_staff'::text,'off'::text]))",validated:true});
   const app=connect(at(name,'ai_hr_app'));let archiveRefusal:unknown;
   try{await app.unsafe(`select * from app.contract_configuration_directory_before_combined('{}'::uuid[],'','{}'::uuid[])`);}catch(error){archiveRefusal=error;}
   expect(pgSqlState(archiveRefusal),'archived directory actually refuses app execution').toBe('42501');await close(app);
  }
  expect(await snapshotPublicRows(reference)).toEqual(await snapshotPublicRows(observer));
  const finalRows=await snapshotPublicRows(observer),noopCatalogue=await snapshotCatalogue(observer,superuser);
  await migrate(drizzle(restricted),{migrationsFolder:migrations});
  expect(await ledger(restricted)).toEqual(expectedLedger);expect(await snapshotPublicRows(observer)).toEqual(finalRows);expect(await snapshotCatalogue(observer,superuser)).toEqual(noopCatalogue);expect(await ownerRoleGraph(observer)).toEqual(graphBefore);

  // Phase two begins on the ACTUAL restricted1069 installation and its verified reference twin.
  // Snapshot every public row and its original1069 columns before the50; never re-seed or reconstruct.
  const combinedRows=await snapshotPublicRows(observer),combinedColumns=Object.fromEntries(Object.entries(combinedRows).map(([key,value])=>[key,value.columns]));
  expect(await snapshotPublicRows(reference)).toEqual(combinedRows);
  const combinedPurpose=await purposeOwned(observer,superuser),combinedGraph=await ownerRoleGraph(observer);
  expect(combinedPurpose).toEqual(purposeBefore);expect(combinedGraph).toEqual(graphBefore);
  const [secondLogin]=await restricted.unsafe<{session:string;current:string;role:string}[]>(`select session_user::text as session,current_user::text as current,current_setting('role') as role`);
  expect(secondLogin).toEqual({session:OWNER,current:OWNER,role:'none'});expect(await ownerAttributes(restricted)).toEqual(ATTRIBUTES);
  expect(await leftovers(observer)).toEqual([]);
  assertApprovedUpgradeTail(currentJournal.entries);
  const boardTail=currentJournal.entries.slice(PREFIX+TAIL,PREFIX+TAIL+BOARD_TAIL);expect(boardTail).toHaveLength(BOARD_TAIL);
  expect(boardTail[0].tag).toBe('6600_probation_reconciliation');
  const forwardTail=[...boardTail,...guidanceTail,...sixItemTail,...payrollAccessTail];
  expect(forwardTail).toHaveLength(BOARD_TAIL+GUIDANCE_TAIL+SIX_ITEM_TAIL+PAYROLL_ACCESS_TAIL);
  const boardIdentities=forwardTail.map((entry,index)=>{
   expect(entry.when).toBeGreaterThan(index?forwardTail[index-1].when:journal.entries.at(-1)!.when);
   const bytes=readFileSync(join(root,'db/migrations',entry.tag+'.sql'));
   // Identity was admitted above against literal reviewed pins, not a candidate-derived expected catalogue.
   writeFileSync(join(migrations,entry.tag+'.sql'),bytes);
   return {hash:sha(bytes),created_at:String(entry.when)};
  });
  const expectedCurrentLedger=[...expectedLedger,...boardIdentities];expect(expectedCurrentLedger).toHaveLength(PREFIX+TAIL+BOARD_TAIL+GUIDANCE_TAIL+SIX_ITEM_TAIL+PAYROLL_ACCESS_TAIL);
  const referenceNoticeOffset=referenceNotices.length,ownerNoticeOffset=ownerNotices.length;
  writeFileSync(join(migrations,'meta/_journal.json'),JSON.stringify(currentJournal));
  await migrate(drizzle(reference),{migrationsFolder:migrations});
  await migrate(drizzle(restricted),{migrationsFolder:migrations}); // A restricted refusal fails; never repair from the twin.
  for(const client of [reference,restricted])expect(await ledger(client)).toEqual(expectedCurrentLedger);
  const referenceBoardNotices=referenceNotices.slice(referenceNoticeOffset),ownerBoardNotices=ownerNotices.slice(ownerNoticeOffset);
  expect(warnings(referenceBoardNotices)).toEqual([]);expect(warnings(ownerBoardNotices)).toEqual([]);
  expect(ownerBoardNotices.filter(n=>n.code==='01006'||n.code==='01007')).toEqual([]);
  expect(await purposeOwned(observer,superuser)).toEqual(combinedPurpose);
  expect(await ownerRoleGraph(observer)).toEqual(combinedGraph);expect(await ownerAttributes(observer)).toEqual(ATTRIBUTES);expect(await leftovers(observer)).toEqual([]);
  expect(catalogueDifferences(await snapshotCatalogue(reference,superuser),await snapshotCatalogue(observer,superuser))).toEqual([]);
  for(const [client,name]of [[reference,names.ref],[observer,names.owner]] as const){
   const retained=await snapshotPublicRows(client,combinedColumns);
   for(const [table,original]of Object.entries(combinedRows)){
    expect(retained[table].columns,table+' retains every1069 original column').toEqual(original.columns);
    const counts=new Map<string,number>();for(const row of retained[table].rows)counts.set(row,(counts.get(row)??0)+1);
    for(const row of original.rows){expect(counts.get(row)??0,table+' retains each1069 PostgreSQL row image with multiplicity').toBeGreaterThan(0);counts.set(row,counts.get(row)!-1);}
   }
   await verifyNativeFacts(client);await child('read',name,receipt);
   // Both canonical module membership and archived RPC privacy remain exactly as the frozen145 phase.
   const [boundary]=await client.unsafe<{archiveApp:boolean;archivePublic:boolean;expression:string;validated:boolean}[]>(`select has_function_privilege('ai_hr_app','app.contract_configuration_directory_before_combined(uuid[],text,uuid[])','EXECUTE') as "archiveApp",exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='app.contract_configuration_directory_before_combined(uuid[],text,uuid[])'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') as "archivePublic",regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[[:space:]]','','g') as expression,c.convalidated as validated from pg_constraint c where c.conrelid='public.automation_email_delivery'::regclass and c.conname='automation_email_delivery_module_check'`);
   expect(boundary).toEqual({archiveApp:false,archivePublic:false,expression:"(module=ANY(ARRAY['probation'::text,'contract_staff'::text,'off'::text]))",validated:true});
   const app=connect(at(name,'ai_hr_app'));let archiveRefusal:unknown;
   try{await app.unsafe(`select * from app.contract_configuration_directory_before_combined('{}'::uuid[],'','{}'::uuid[])`);}catch(error){archiveRefusal=error;}
   expect(pgSqlState(archiveRefusal),'archived directory still refuses app after Board50').toBe('42501');await close(app);
  }
  expect(await snapshotPublicRows(reference)).toEqual(await snapshotPublicRows(observer));
  const currentRows=await snapshotPublicRows(observer),currentCatalogue=await snapshotCatalogue(observer,superuser);
  for(const client of [reference,restricted])await migrate(drizzle(client),{migrationsFolder:migrations});
  for(const client of [reference,restricted])expect(await ledger(client)).toEqual(expectedCurrentLedger);
  expect(await snapshotPublicRows(reference)).toEqual(currentRows);expect(await snapshotPublicRows(observer)).toEqual(currentRows);
  expect(catalogueDifferences(await snapshotCatalogue(reference,superuser),currentCatalogue)).toEqual([]);
  expect(await snapshotCatalogue(observer,superuser)).toEqual(currentCatalogue);
  expect(await purposeOwned(observer,superuser)).toEqual(combinedPurpose);expect(await ownerRoleGraph(observer)).toEqual(combinedGraph);
  expect(await ownerAttributes(restricted)).toEqual(ATTRIBUTES);expect(await leftovers(observer)).toEqual([]);
  await verifyPayrollProcessFourGrants(observer,b.tenantId);
 }finally{
  for(const client of [...pools].filter(client=>client!==admin))await close(client);
  if(admin){for(const name of Object.values(names))await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await close(admin);}
  rmSync(folder,{recursive:true,force:true});
 }
},900_000);
