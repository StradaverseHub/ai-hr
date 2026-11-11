/** Populated production upgrade rehearsal: the production ledger prefix, fictional production-shaped data written by
 * the baseline's own code, the installed role topology, then every candidate migration and the deploy's
 * post-migration steps as the restricted ai_hr_owner login, a data-preservation comparison and a real
 * backup/restore of the upgraded database.
 *
 * Inputs live in test/fixtures/production-upgrade/rehearsal.json: the installed production source, its applied
 * ledger length and watermark, and the populator source whose journal is exactly that prefix. The schema is built
 * from those Git objects, never from candidate files; the candidate's journal must extend that prefix byte for byte.
 *
 * Disposable databases on a disposable CI cluster only. Nothing here reads or connects to an installation, and every
 * row is fictional. The verdict is written to the focused evidence directory as its own claim; it is not staging
 * acceptance, package publication or a production installation. */
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {afterAll,expect,it} from 'vitest';
import {closeAll} from './harness';
import {PROJECT_INSTALLED_OWNERSHIP,SUPERUSER_LEFTOVERS} from './helpers/installed-role-topology';

type Entry={idx:number;version:string;when:number;tag:string;breakpoints:boolean};
type Notice={severity:string;code:string;message:string};
type TableSnapshot={key:string;columns:string[];rows:Map<string,string>};
const OWNER='ai_hr_owner';
const PRIVILEGE_WARNINGS=new Set(['01006','01007']);
const config=JSON.parse(readFileSync('test/fixtures/production-upgrade/rehearsal.json','utf8')) as {
 baseline:{installedSource:string;ledgerEntries:number;ledgerWatermark:number;expectedLedgerDigest:string;populatorSource:string;
  productionRoles:string[];productionPurposeOwners:Record<string,string>;productionShape:Record<string,number>};
 sizes:Record<string,unknown>;auditHashChainEnabled:string;replication:{targetEmployments:number}};
const sha256=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const git=(...args:string[])=>execFileSync('git',args,{maxBuffer:256*1024*1024});
const journalAt=(ref:string)=>(JSON.parse(git('show',`${ref}:db/migrations/meta/_journal.json`).toString()) as {entries:Entry[]}).entries;
const FLAGS=['MULTI_CYCLE_PAYROLL_ENABLED','TYPED_PAY_COMPONENTS_ENABLED','GROUP_PCB_COORDINATION_ENABLED','PAYROLL_RESET_ENABLED','NOTIFICATIONS_ENABLED',
 'TOIL_ENABLED','PAYROLL_UNLOCK_ENABLED','INDIVIDUAL_TXN_PAY_ENABLED','FEEDBACK_AI_PLANNING_ENABLED','SYSTEM_EXPLORER_ENABLED','ASSISTANT_ENABLED'];

/** Copies of template hires at the baseline's own column shapes. Each copy remaps person and employment ids (and the
 * own id of every dependent row), suffixes the identity text a person or employee code carries, and keeps every other
 * value, so foreign keys, company scope and row-security columns stay valid. Triggers stay on; a dependent table that
 * refuses a copy is skipped and recorded, never forced. */
const NOT_COPIED=/^(app_user|role_assignment|app_invitation|domain_event|payslip.*|payroll.*|claim.*|bank_.*|notification.*|leave_request.*|employee_draft.*|.*import.*)$/;
async function replicateEmployments(sql:postgres.Sql,tenantId:string,templates:string[],target:number){
 const started=Date.now();
 const [{count:before}]=await sql.unsafe<{count:number}[]>('SELECT count(*)::int AS count FROM employment WHERE tenant_id=$1::uuid',[tenantId]);
 if(!templates.length||before>=target)return {templates:templates.length,employmentsBefore:before,employmentsAfter:before,copies:0,tables:{},skipped:{},ms:0};
 const fks=[...await sql.unsafe<{tbl:string;col:string;ref:string}[]>(`SELECT k.relname::text AS tbl,a.attname::text AS col,r.relname::text AS ref
  FROM pg_constraint c JOIN pg_class k ON k.oid=c.conrelid JOIN pg_namespace n ON n.oid=k.relnamespace JOIN pg_class r ON r.oid=c.confrelid
  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
  WHERE c.contype='f' AND cardinality(c.conkey)=1 AND n.nspname='public' AND c.confrelid IN ('public.person'::regclass,'public.employment'::regclass)`)];
 const dependents=[...new Set(fks.map(fk=>fk.tbl))].filter(name=>name!=='person'&&name!=='employment'&&!NOT_COPIED.test(name)).sort();
 const plans=new Map<string,{columns:string[];select:string[];where:string}>();
 for(const table of ['person','employment',...dependents]){
  const columns=[...await sql.unsafe<{name:string;type:string;generated:string;identity:string;def:string|null}[]>(`SELECT a.attname::text AS name,
   format_type(a.atttypid,a.atttypmod) AS type,a.attgenerated::text AS generated,a.attidentity::text AS identity,pg_get_expr(d.adbin,d.adrelid) AS def
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=('public.'||quote_ident($1))::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[table])]
   .filter(column=>!column.generated&&!column.identity&&!(column.def??'').includes('nextval('));
  const [pk]=await sql.unsafe<{cols:string[]|null}[]>(`SELECT array_agg(a.attname::text) AS cols FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
   WHERE i.indrelid=('public.'||quote_ident($1))::regclass AND i.indisprimary`,[table]);
  const mapped=new Map(fks.filter(fk=>fk.tbl===table).map(fk=>[fk.col,fk.ref]));
  const uniques=[...await sql.unsafe<{cols:string[]}[]>(`SELECT array_agg(a.attname::text) AS cols FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
   WHERE i.indrelid=('public.'||quote_ident($1))::regclass AND i.indisunique AND NOT i.indisprimary GROUP BY i.indexrelid`,[table])];
  const suffixed=new Set<string>();
  for(const unique of uniques)if(!unique.cols.some(col=>mapped.has(col)||(pk.cols??[]).includes(col)))
   for(const col of unique.cols){const type=columns.find(column=>column.name===col)?.type??'';if(/text|character|citext/.test(type))suffixed.add(col);}
  const q=(name:string)=>'"'+name.replaceAll('"','""')+'"';
  const select=columns.map(({name,type})=>{
   if(table==='person'&&name==='id')return `(SELECT m.new FROM rp_map m WHERE m.kind='person' AND m.old=t.id)`;
   if(table==='employment'&&name==='id')return `(SELECT m.new FROM rp_map m WHERE m.kind='employment' AND m.old=t.id)`;
   if(mapped.has(name))return `coalesce((SELECT m.new FROM rp_map m WHERE m.kind='${mapped.get(name)}' AND m.old=t.${q(name)}),t.${q(name)})`;
   if((pk.cols??[]).length===1&&pk.cols![0]===name&&type==='uuid')return 'gen_random_uuid()';
   if(table==='person'&&name==='primary_email')return `CASE WHEN t.primary_email IS NULL THEN NULL ELSE 'c'||$1::text||'.'||t.primary_email END`;
   if(table==='person'&&name==='full_name')return `t.full_name||' C'||$1::text`;
   if(table==='employment'&&name==='employee_code')return `CASE WHEN t.employee_code IS NULL THEN NULL ELSE t.employee_code||'C'||$1::text END`;
   if(suffixed.has(name))return `CASE WHEN t.${q(name)} IS NULL THEN NULL ELSE t.${q(name)}||'-c'||$1::text END`;
   return `t.${q(name)}`;
  });
  const where=table==='person'?`t.id IN (SELECT old FROM rp_map WHERE kind='person')`:table==='employment'?`t.id IN (SELECT old FROM rp_map WHERE kind='employment')`
   :[...mapped].map(([col,ref])=>`t.${q(col)} IN (SELECT old FROM rp_map WHERE kind='${ref}')`).join(' OR ');
  plans.set(table,{columns:columns.map(column=>q(column.name)),select,where});
 }
 const copies=Math.ceil((target-before)/templates.length),tables:Record<string,number>={},skipped:Record<string,string>={};
 let triggersDisabled=false;
 for(let copy=1;copy<=copies;copy++){
  const slice=templates.slice(0,Math.min(templates.length,target-before-(copy-1)*templates.length));
  if(!slice.length)break;
  const attempt=async(replica:boolean)=>sql.begin(async tx=>{
   if(replica)await tx.unsafe(`SET LOCAL session_replication_role=replica`);
   await tx.unsafe(`CREATE TEMP TABLE rp_map(kind text,old uuid,new uuid,PRIMARY KEY(kind,old)) ON COMMIT DROP`);
   await tx.unsafe(`INSERT INTO rp_map SELECT 'employment',id,gen_random_uuid() FROM employment WHERE id=ANY($1::uuid[])`,[slice]);
   await tx.unsafe(`INSERT INTO rp_map SELECT 'person',person_id,gen_random_uuid() FROM employment WHERE id=ANY($1::uuid[])`,[slice]);
   for(const [table,plan] of plans){
    // $1 (the copy number) is always bound; the trailing predicate keeps it referenced when no column uses it.
    const statement=`INSERT INTO public."${table}" (${plan.columns.join(',')}) SELECT ${plan.select.join(',')} FROM public."${table}" t WHERE (${plan.where}) AND $1::text IS NOT NULL`;
    if(table==='person'||table==='employment'){const result=await tx.unsafe(statement,[String(copy)]);tables[table]=(tables[table]??0)+result.count;continue;}
    if(skipped[table])continue;
    try{const count=await tx.savepoint(async sp=>(await sp.unsafe(statement,[String(copy)])).count);tables[table]=(tables[table]??0)+count;}
    catch(error){skipped[table]=String((error as Error).message).slice(0,300);}
   }
  });
  try{await attempt(triggersDisabled);}
  catch(error){if(triggersDisabled)throw error;triggersDisabled=true;skipped['(triggers)']='person/employment copy refused with triggers on: '+String((error as Error).message).slice(0,300);await attempt(true);}
 }
 await sql.unsafe('ANALYZE');
 const [{count:after}]=await sql.unsafe<{count:number}[]>('SELECT count(*)::int AS count FROM employment WHERE tenant_id=$1::uuid',[tenantId]);
 return {templates:templates.length,employmentsBefore:before,employmentsAfter:after,copies,triggersDisabled,tables,skipped,ms:Date.now()-started};
}

afterAll(closeAll);

it('upgrades a populated production-baseline database to the candidate as the restricted owner, preserving data and restoring from backup',async()=>{
 const started=Date.now(),timings:Record<string,number>={};
 const timed=async<T,>(name:string,run:()=>Promise<T>|T)=>{const at=Date.now();try{return await run();}finally{timings[name]=Date.now()-at;}};
 const evidence:Record<string,unknown>={kind:'POPULATED_PRODUCTION_UPGRADE_REHEARSAL',fictional:true,productionAccess:false,
  candidate:git('rev-parse','HEAD').toString().trim(),ciHead:process.env.AIHR_CI_HEAD??null,baseline:config.baseline,sizes:config.sizes,timings};
 const write=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'production-upgrade-rehearsal.json'),JSON.stringify(evidence,null,2));};
 const {installedSource,ledgerEntries,ledgerWatermark,populatorSource}=config.baseline;

 // 0. The release this stands for: the candidate may differ from it only by the rehearsal's own files.
 const {releaseTarget}=JSON.parse(readFileSync('test/fixtures/production-upgrade/target.json','utf8')) as {releaseTarget:string};
 expect(releaseTarget).toMatch(/^[0-9a-f]{40}$/);
 const overlay=git('diff','--name-only',releaseTarget,'HEAD').toString().split('\n').filter(Boolean);
 const REHEARSAL_FILES=['scripts/production-upgrade-rehearsal.sh','test/production-upgrade-rehearsal.test.ts','test/helpers/installed-role-topology.ts',
  'test/fixtures/production-upgrade/populate-baseline.mts','test/fixtures/production-upgrade/rehearsal.json','test/fixtures/production-upgrade/target.json'];
 expect(overlay.filter(file=>!REHEARSAL_FILES.includes(file)),'the candidate is the release target plus the rehearsal files only').toEqual([]);
 evidence.releaseTarget=releaseTarget;evidence.overlayFiles=overlay;

 // 1. Identities. The applied prefix of the installed source is the populator's whole journal and the candidate's prefix.
 const installedJournal=journalAt(installedSource),populatorJournal=journalAt(populatorSource);
 const candidateJournal=(JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:Entry[]}).entries;
 const applied=installedJournal.filter(entry=>entry.when<=ledgerWatermark);
 expect(applied.length,'installed source entries at or below the production watermark').toBe(ledgerEntries);
 expect(installedJournal.slice(0,ledgerEntries),'the applied entries are the leading prefix of the installed journal').toEqual(applied);
 expect(populatorJournal,'the populator journal is exactly the applied prefix').toEqual(applied);
 expect(candidateJournal.slice(0,ledgerEntries),'the candidate journal extends the applied prefix').toEqual(applied);
 const appliedSql=applied.map(entry=>git('show',`${installedSource}:db/migrations/${entry.tag}.sql`));
 for(const [index,entry] of applied.entries()){
  expect(sha256(git('show',`${populatorSource}:db/migrations/${entry.tag}.sql`)),entry.tag+' populator bytes').toBe(sha256(appliedSql[index]));
  expect(sha256(readFileSync(`db/migrations/${entry.tag}.sql`)),entry.tag+' candidate bytes').toBe(sha256(appliedSql[index]));
 }
 const ledgerDigest=sha256(applied.map((entry,index)=>`${sha256(appliedSql[index])} ${entry.when}`).join('\n'));
 expect(ledgerDigest,'ordered ledger digest the owner preflight compares').toBe(config.baseline.expectedLedgerDigest);
 const release=candidateJournal.slice(ledgerEntries);
 for(const entry of release)expect(entry.when,entry.tag+' sits above the production watermark (a lower one is silently skipped)').toBeGreaterThan(ledgerWatermark);
 const releaseSql=release.map(entry=>readFileSync(`db/migrations/${entry.tag}.sql`,'utf8'));
 const createdRoles=[...new Set(releaseSql.flatMap(text=>[...text.matchAll(/CREATE\s+ROLE\s+([a-z_][a-z0-9_]*)/gi)].map(match=>match[1].toLowerCase())))].sort();
 const ownerTargets=[...new Set(releaseSql.flatMap(text=>[...text.matchAll(/OWNER\s+TO\s+(ai_hr_[a-z0-9_]+)/gi)].map(match=>match[1].toLowerCase())))].sort();
 evidence.identity={ledgerEntries,ledgerWatermark,ledgerDigest,releaseMigrations:release.length,firstRelease:release[0]?.tag,lastRelease:release.at(-1)?.tag,
  candidateJournalEntries:candidateJournal.length,rolesCreatedByRelease:createdRoles,
  rolesCreatedByReleaseAbsentOnProduction:createdRoles.filter(role=>!config.baseline.productionRoles.includes(role)),
  purposeOwnerTargetsInRelease:ownerTargets};
 write();

 const base=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appBase=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(base.hostname);expect(base.username).not.toBe(OWNER);
 const at=(database:string,user?:string,from:URL=base)=>{const url=new URL(from);url.pathname='/'+database;if(user){url.username=user;url.password='';}return url.toString();};
 const id=randomUUID().replaceAll('-',''),names={base:'ai_hr_prod_rehearsal_base_'+id,upgrade:'ai_hr_prod_rehearsal_owner_'+id,
  diagnosis:'ai_hr_prod_rehearsal_diag_'+id,restore:'ai_hr_rehearsal_arch_'+id};
 const admin=postgres(at('postgres'),{max:1,onnotice:()=>{}});
 const temporary=mkdtempSync(join(tmpdir(),'aihr-prod-rehearsal-'));
 const populator=join(temporary,'populator');
 const open:postgres.Sql[]=[];
 const connect=(url:string,notices?:Notice[])=>{const sql=postgres(url,{max:1,connect_timeout:10,idle_timeout:30,onnotice:notice=>{notices?.push({severity:String(notice.severity),code:String(notice.code),message:String(notice.message)});}});open.push(sql);return sql;};
 const close=async(sql:postgres.Sql)=>{await sql.end({timeout:5});open.splice(open.indexOf(sql),1);};
 const run=(command:string,args:string[],options:{cwd?:string;env?:NodeJS.ProcessEnv;timeout:number})=>{
  const result=spawnSync(command,args,{cwd:options.cwd,env:options.env??process.env,encoding:'utf8',timeout:options.timeout,maxBuffer:32*1024*1024});
  return {status:result.status,signal:result.signal,error:result.error?String(result.error):null,out:(result.stdout??'')+(result.stderr??'')};
 };
 const scriptEnv=(database:string,extra:Record<string,string>={})=>{
  const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:at(database,undefined,appBase),MIGRATION_DATABASE_URL:at(database,OWNER),
   AUDIT_HASH_CHAIN_ENABLED:config.auditHashChainEnabled,...extra};
  for(const flag of FLAGS)delete env[flag];
  return env;
 };
 try{
  const [cluster]=await admin.unsafe<{superuser:string;super:boolean;version:number}[]>(`SELECT current_user::text AS superuser,
   (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS super,current_setting('server_version_num')::int AS version`);
  expect(cluster.super).toBe(true);expect(cluster.version).toBeGreaterThanOrEqual(160000);
  const superuser=cluster.superuser;evidence.cluster={postgres:cluster.version};
  const [ownerRole]=await admin.unsafe<Record<string,boolean>[]>(`SELECT rolcanlogin AS login,rolsuper AS super,rolcreatedb AS createdb,rolcreaterole AS createrole,rolbypassrls AS bypassrls FROM pg_catalog.pg_roles WHERE rolname='${OWNER}'`);
  expect(ownerRole,'the CI migration owner is the restricted bootstrap login').toEqual({login:true,super:false,createdb:false,createrole:false,bypassrls:false});

  // 2. The production ledger prefix from the installed source's own SQL, with the bootstrap's grants (deploy/bootstrap-db.sql).
  await timed('baselineSchema',async()=>{
   await admin.unsafe(`CREATE DATABASE "${names.base}"`);
   const baseline=connect(at(names.base));
   await baseline.unsafe(`GRANT CONNECT ON DATABASE "${names.base}" TO ai_hr_app; GRANT USAGE ON SCHEMA public TO ai_hr_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE "${superuser}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE "${superuser}" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app;
    DO $platform$ BEGIN IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ai_hr_platform') THEN GRANT USAGE ON SCHEMA public TO ai_hr_platform; END IF; END $platform$;`);
   const folder=join(temporary,'baseline-migrations');mkdirSync(join(folder,'meta'),{recursive:true});
   applied.forEach((entry,index)=>writeFileSync(join(folder,`${entry.tag}.sql`),appliedSql[index]));
   writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...JSON.parse(git('show',`${installedSource}:db/migrations/meta/_journal.json`).toString()),entries:applied}));
   await migrate(drizzle(baseline),{migrationsFolder:folder});
   const ledger=await baseline.unsafe<{hash:string;created_at:string}[]>('SELECT hash,created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id');
   expect(sha256(ledger.map(row=>`${row.hash} ${row.created_at}`).join('\n')),'the built ledger matches the production digest').toBe(ledgerDigest);
   await close(baseline);
  });

  // 3. Fictional production-shaped data written by the baseline's own services (test/fixtures/production-upgrade/populate-baseline.mts).
  const population=await timed('population',async()=>{
   const add=run('git',['worktree','add','--detach',populator,populatorSource],{timeout:120_000});
   expect(add.status,add.out).toBe(0);
   copyFileSync('.env.example',join(populator,'.env.local'));
   const install=run('pnpm',['install','--frozen-lockfile','--prefer-offline'],{cwd:populator,timeout:420_000});
   expect(install.status,install.out.slice(-6000)).toBe(0);
   copyFileSync('test/fixtures/production-upgrade/populate-baseline.mts',join(populator,'scripts/production-rehearsal-populate.mts'));
   const output=join(temporary,'population.json');
   const env=scriptEnv(names.base,{TEST_MIGRATION_DATABASE_URL:at(names.base),TEST_DATABASE_URL:at(names.base,undefined,appBase),
    MIGRATION_DATABASE_URL:at(names.base),REHEARSAL_SIZES:JSON.stringify(config.sizes),REHEARSAL_POPULATION_OUTPUT:output,REHEARSAL_POPULATOR_SOURCE:populatorSource});
   const catalogs=run(process.execPath,['--import','tsx','scripts/seed-catalogs.ts'],{cwd:populator,env,timeout:180_000});
   expect(catalogs.status,'baseline seed-catalogs: '+catalogs.out.slice(-4000)).toBe(0);
   const populate=run(process.execPath,['--conditions=react-server','--import','tsx','scripts/production-rehearsal-populate.mts'],{cwd:populator,env,timeout:480_000});
   evidence.populationLog=populate.out.split('\n').filter(line=>line.startsWith('populate ')).slice(-20);
   if(populate.status!==0){evidence.populationFailure=populate.out.slice(-8000);write();}
   expect(populate.status,'baseline population: '+populate.out.slice(-8000)).toBe(0);
   return JSON.parse(readFileSync(output,'utf8')) as {tenantId:string;companyId:string;departmentId:string;adminUserId:string;foreignCompanyId:string;
    foreignEmploymentId:string;ownEmploymentId:string;templateEmploymentIds:string[];counts:Record<string,string>;timings:Record<string,number>};
  });
  evidence.population=population;write();

  // 3b. Production volume, set-wise: copy the service-written non-payroll hires (and every row that references their
  // person or employment, except users, payroll, claims and audit events) inside the same company.
  const replication=await timed('replication',async()=>{
   const sql=connect(at(names.base));
   try{return await replicateEmployments(sql,population.tenantId,population.templateEmploymentIds,config.replication.targetEmployments);}
   finally{await close(sql);}
  });
  evidence.replication=replication;write();
  expect(replication.employmentsAfter,'production-shaped employment volume').toBeGreaterThanOrEqual(Math.floor(config.replication.targetEmployments*0.9));

  // 4. The installed role topology on a copy: owner-owned objects, purpose owners kept, documented DBA prerequisites.
  const topology=await timed('topology',async()=>{
   await admin.unsafe(`CREATE DATABASE "${names.upgrade}" TEMPLATE "${names.base}" OWNER ${OWNER}`);
   const observer=connect(at(names.upgrade));
   await observer.unsafe(`GRANT CONNECT ON DATABASE "${names.upgrade}" TO ai_hr_app`);
   await observer.unsafe(PROJECT_INSTALLED_OWNERSHIP);
   const leftovers=[...await observer.unsafe<{object:string}[]>(SUPERUSER_LEFTOVERS)].map(row=>row.object);
   expect(leftovers,'nothing is left to the superuser').toEqual([]);
   const purpose=[...await observer.unsafe<{name:string;owner:string}[]>(`SELECT p.proname::text AS name,pg_catalog.pg_get_userbyid(p.proowner)::text AS owner
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname=ANY($1::text[]) ORDER BY 1`,[Object.keys(config.baseline.productionPurposeOwners)])];
   const purposeOwners=Object.fromEntries(purpose.map(row=>[row.name,row.owner]));
   const prerequisites:Record<string,string>={};
   for(const file of ['deploy/runner-control/rewards-deletion-role-prerequisite.sql','deploy/runner-control/notification-role-prerequisite.sql']){
    try{await observer.unsafe(readFileSync(file,'utf8'));prerequisites[file]='applied';}
    catch(error){prerequisites[file]='refused: '+String((error as Error).message);}
   }
   const graph=[...await observer.unsafe<Record<string,unknown>[]>(`SELECT r.rolname::text AS role,m.rolname::text AS member,a.inherit_option AS inherit,a.set_option AS "set"
    FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles r ON r.oid=a.roleid JOIN pg_catalog.pg_roles m ON m.oid=a.member WHERE m.rolname='${OWNER}' ORDER BY 1`)];
   await close(observer);
   return {purposeOwners,prerequisites,ownerMemberships:graph};
  });
  evidence.topology=topology;write();
  expect(topology.purposeOwners,'baseline purpose owners match production').toEqual(config.baseline.productionPurposeOwners);

  const snapshot=async(database:string,tables?:Map<string,TableSnapshot>)=>{
   const sql=connect(at(database));
   const listed=tables?[...tables.keys()]:[...await sql.unsafe<{name:string}[]>(`SELECT format('%I.%I',n.nspname,c.relname) AS name FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1`)].map(row=>row.name);
   const out=new Map<string,TableSnapshot>(),missing:string[]=[],missingColumns:Record<string,string[]>={};
   for(const name of listed){
    const [exists]=await sql.unsafe<{oid:string|null}[]>('SELECT to_regclass($1)::text AS oid',[name]);
    if(!exists.oid){missing.push(name);continue;}
    const present=[...await sql.unsafe<{name:string}[]>(`SELECT attname::text AS name FROM pg_catalog.pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,[name])].map(row=>row.name);
    const columns=tables?tables.get(name)!.columns:present;
    const gone=columns.filter(column=>!present.includes(column));if(gone.length)missingColumns[name]=gone;
    const kept=columns.filter(column=>present.includes(column));
    const [pk]=await sql.unsafe<{columns:string[]|null}[]>(`SELECT array_agg(a.attname::text ORDER BY a.attnum) AS columns FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=$1::regclass AND i.indisprimary`,[name]);
    const key=tables?tables.get(name)!.key:(pk.columns?.length?`concat_ws('|',${pk.columns.map(column=>`t."${column.replaceAll('"','""')}"`).join(',')})`:'');
    // Only the pre-upgrade columns, so a column a migration adds never reads as a changed row.
    const projection=`md5(coalesce((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(to_jsonb(t)) e WHERE e.key=ANY($1::text[])),'{}'::jsonb)::text)`;
    const rows=new Map<string,string>(),seen=new Map<string,number>();
    const result=await sql.unsafe<{k:string|null;h:string}[]>(`SELECT ${key?`${key}`:'NULL::text'} AS k,${projection} AS h FROM ${name} t`,[kept]);
    for(const row of result){
     if(key){rows.set(String(row.k),row.h);continue;}
     const occurrence=(seen.get(row.h)??0)+1;seen.set(row.h,occurrence);rows.set(`${row.h}#${occurrence}`,row.h);
    }
    out.set(name,{key,columns,rows});
   }
   await close(sql);
   return {tables:out,missing,missingColumns};
  };
  const before=await timed('snapshotBefore',()=>snapshot(names.upgrade));

  // 5. The candidate's audit-chain gate before migrating, as deploy/deploy.sh runs it.
  const gateBefore=run(process.execPath,['--import','tsx','scripts/check-audit-chain-gate.ts'],{env:scriptEnv(names.upgrade),timeout:180_000});
  evidence.auditChainGateBefore={status:gateBefore.status,tail:gateBefore.out.slice(-1500)};

  // 6. Every release migration through the stock engine, one transaction, the literal restricted login.
  const ownerNotices:Notice[]=[];
  let upgraded=names.upgrade;
  const migration=await timed('migrate',async()=>{
   const restricted=connect(at(names.upgrade,OWNER),ownerNotices);
   const [login]=await restricted.unsafe<{session:string;current:string}[]>(`SELECT session_user::text AS session,current_user::text AS current`);
   expect(login).toEqual({session:OWNER,current:OWNER});
   let refused:unknown=null;
   try{await migrate(drizzle(restricted),{migrationsFolder:'db/migrations'});}catch(error){refused=error;}
   await close(restricted);
   if(!refused)return {restrictedOwner:'applied',refusals:[] as string[]};
   // List every refusing migration on a copy: each alone as the owner; a refused one is applied as the superuser and
   // its objects handed to the owner, so later migrations meet the installed shape. The copy then carries on.
   const describe=(error:unknown)=>{const cause=(error as {cause?:{code?:string;message?:string}}).cause??(error as {code?:string;message?:string});return `${cause.code??'?'} ${cause.message??String(error)}`;};
   await admin.unsafe(`CREATE DATABASE "${names.diagnosis}" TEMPLATE "${names.upgrade}" OWNER ${OWNER}`);
   const builder=connect(at(names.diagnosis)),ownerLogin=connect(at(names.diagnosis,OWNER)),refusals:string[]=[];
   const folder=join(temporary,'diagnosis');mkdirSync(join(folder,'meta'),{recursive:true});
   for(const entry of candidateJournal)copyFileSync(`db/migrations/${entry.tag}.sql`,join(folder,`${entry.tag}.sql`));
   const meta=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
   for(const [index,entry] of release.entries()){
    writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...meta,entries:candidateJournal.slice(0,ledgerEntries+index+1)}));
    try{await migrate(drizzle(ownerLogin),{migrationsFolder:folder});}
    catch(error){refusals.push(`${entry.tag}: ${describe(error)}`);await migrate(drizzle(builder),{migrationsFolder:folder});await builder.unsafe(PROJECT_INSTALLED_OWNERSHIP);}
   }
   await close(builder);await close(ownerLogin);
   upgraded=names.diagnosis;
   return {restrictedOwner:'refused',firstRefusal:describe(refused),refusals};
  });
  evidence.migration={...migration,privilegeWarnings:ownerNotices.filter(notice=>PRIVILEGE_WARNINGS.has(notice.code)),
   warnings:ownerNotices.filter(notice=>notice.severity==='WARNING').map(notice=>`${notice.code} ${notice.message}`)};
  write();

  // 7. The deploy's post-migration steps, in deploy/deploy.sh order, with the candidate's code and the owner login.
  const steps:Record<string,{status:number|null;ms:number;tail:string}>={};
  for(const script of ['scripts/post-migrate-online.ts','scripts/seed-catalogs.ts','scripts/backfill-plan-history.ts','scripts/backfill-country-modules.ts',
   'scripts/check-audit-chain-gate.ts','scripts/check-notification-role.ts']){
   const at0=Date.now(),result=run(process.execPath,['--import','tsx',script],{env:scriptEnv(upgraded),timeout:600_000});
   steps[script]={status:result.status,ms:Date.now()-at0,tail:result.out.slice(-1500)};
  }
  evidence.postMigrate=steps;write();

  // 8. Data preservation: every pre-upgrade table and column still present, no row lost, changes listed per table.
  const after=await timed('snapshotAfter',()=>snapshot(upgraded,before.tables));
  const preservation:Record<string,{rows:number;removed:number;changed:number;added:number}>={};
  for(const [name,old] of before.tables){
   const now=after.tables.get(name);if(!now)continue;
   let removed=0,changed=0;
   for(const [key,hash] of old.rows){const next=now.rows.get(key);if(next===undefined)removed++;else if(next!==hash)changed++;}
   let added=[...now.rows.keys()].filter(key=>!old.rows.has(key)).length;
   // A table without a primary key is compared as a multiset: a changed row reads as one gone and one new.
   if(!old.key){changed=Math.min(removed,added);removed-=changed;added-=changed;}
   if(removed||changed||added)preservation[name]={rows:old.rows.size,removed,changed,added};
  }
  const identical=[...before.tables.keys()].filter(name=>after.tables.has(name)&&!preservation[name]).length;
  evidence.dataPreservation={tablesBefore:before.tables.size,identicalTables:identical,droppedTables:after.missing,droppedColumns:after.missingColumns,differences:preservation};
  write();

  // 9. Backup the upgraded database with the shipped script, restore it with the shipped rehearsal, then prove the
  // candidate's services read, isolate and write on the restored copy.
  const recovery=await timed('backupRestore',async()=>{
   const destination=join(temporary,'backups');
   const backup=run('/bin/bash',['scripts/backup-db.sh'],{timeout:600_000,env:{...process.env,BACKUP_DATABASE_URL:at(upgraded),BACKUP_APP_DATABASE_URL:at(upgraded,undefined,appBase),
    BACKUP_PROBE_USER_ID:population.adminUserId,BACKUP_DEST:destination,BACKUP_ALLOW_LOCAL_DEST:'1',BACKUP_STAGING:join(temporary,'stage')}});
   const backupVerdict=backup.out.split('\n').find(line=>line.startsWith('BACKUP_RESULT='))??null;
   if(!backupVerdict?.startsWith('BACKUP_RESULT=PASS'))return {backup:backupVerdict,backupTail:backup.out.slice(-3000)};
   const dump=join(destination,readdirSync(destination).find(file=>file.endsWith('.dump'))!);
   const restored=run('/bin/bash',['scripts/restore-rehearsal.sh','--dump',dump,'--scratch',names.restore,'--keep'],{timeout:600_000,env:{...process.env,
    REHEARSAL_DATABASE_URL:at('postgres'),REHEARSAL_APP_DATABASE_URL:at('postgres',undefined,appBase),REHEARSAL_LOG:join(temporary,'restore.log')}});
   const restoreVerdict=restored.out.split('\n').find(line=>line.startsWith('RESTORE_REHEARSAL_RESULT='))??null;
   if(!restoreVerdict?.startsWith('RESTORE_REHEARSAL_RESULT=PASS'))return {backup:backupVerdict,restore:restoreVerdict,restoreTail:restored.out.slice(-3000)};
   const {createDb}=await import('../db/client');const {resolveEntitlementsTx}=await import('../core/entitlements');
   const restoredOwner=createDb(at(names.restore),{max:1});
   let entitlements:unknown;
   try{entitlements=await restoredOwner.db.transaction(tx=>resolveEntitlementsTx(tx,population.tenantId));}finally{await restoredOwner.client.end({timeout:5});}
   const input=join(temporary,'proof.json');
   writeFileSync(input,JSON.stringify({context:{tenantId:population.tenantId,userId:population.adminUserId,roles:['hr_admin'],entitlements},
    companyId:population.companyId,departmentId:population.departmentId,foreignCompanyId:population.foreignCompanyId,
    ownEmploymentId:population.ownEmploymentId,foreignEmploymentId:population.foreignEmploymentId}));
   const proof=run(process.execPath,['--conditions=react-server','--import','tsx','scripts/fixtures/restore-business-proof.mjs',input],{timeout:180_000,
    env:{...process.env,DATABASE_URL:at(names.restore,undefined,appBase),MIGRATION_DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database'}});
   const last=proof.out.trim().split('\n').at(-1)??'';
   let business:unknown=null;try{business=JSON.parse(last);}catch{business={failed:proof.out.slice(-3000)};}
   return {backup:backupVerdict,restore:restoreVerdict,business};
  });
  evidence.recovery=recovery;

  // 10. The verdict, as separate claims.
  const changedTenantTables=Object.entries(preservation).filter(([name,diff])=>diff.removed>0||(diff.changed>0&&!['drizzle.__drizzle_migrations'].includes(name)));
  evidence.verdict={
   restrictedOwnerMigration:migration.restrictedOwner==='applied'?'PASS':'FAIL',
   postMigrateSteps:Object.values(steps).every(step=>step.status===0)?'PASS':'FAIL',
   noRowsLostNoTablesOrColumnsDropped:after.missing.length===0&&Object.keys(after.missingColumns).length===0&&Object.values(preservation).every(diff=>diff.removed===0)?'PASS':'FAIL',
   changedExistingRowsOutsideLedger:changedTenantTables.map(([name,diff])=>`${name} changed=${diff.changed} removed=${diff.removed}`),
   backupRestore:(recovery as {restore?:string}).restore?.startsWith('RESTORE_REHEARSAL_RESULT=PASS')?'PASS':'FAIL',
   restoredBusinessProof:JSON.stringify((recovery as {business?:unknown}).business)===JSON.stringify({restoredAuthorizedRead:true,crossTenantDenied:true,commandPersisted:true,auditPersisted:true})?'PASS':'FAIL',
  };
  evidence.elapsedMs=Date.now()-started;write();

  expect(evidence.verdict).toMatchObject({restrictedOwnerMigration:'PASS',postMigrateSteps:'PASS',noRowsLostNoTablesOrColumnsDropped:'PASS',backupRestore:'PASS',restoredBusinessProof:'PASS'});
  expect(evidence.migration).toMatchObject({privilegeWarnings:[]});
 }finally{
  write();
  for(const sql of [...open])await sql.end({timeout:5}).catch(()=>{});
  for(const name of Object.values(names))await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(()=>{});
  await admin.end({timeout:5});
  spawnSync('git',['worktree','remove','--force',populator]);spawnSync('git',['worktree','prune']);
  rmSync(temporary,{recursive:true,force:true});
 }
},1_080_000);
