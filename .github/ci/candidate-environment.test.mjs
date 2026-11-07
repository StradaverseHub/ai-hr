import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPlan} from './plan.mjs';
import {candidateEnvironment,nativePreparationEnvironment} from './candidate-environment.mjs';
import {fullCiRoleMigrationEnvironment} from './run-unit.mjs';
test('all candidate execution contexts drop platform/provider credentials without mutating owner authentication',()=>{
 const source={GH_TOKEN:'private',GITHUB_TOKEN:'private',ACTIONS_RUNTIME_TOKEN:'private',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'private',OPENAI_API_KEY:'private',AI_CONFIG_SECRET:'private',AWS_ACCESS_KEY_ID:'private',SSH_AUTH_SOCK:'/private/agent',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_RUN_ID:'123',DATABASE_URL:'postgres://fictional@127.0.0.1:5433/test',NODE_OPTIONS:'--max-old-space-size=4096',PATH:'/usr/bin:/bin'};
 const sanitized=candidateEnvironment(source);
 assert.deepEqual(sanitized,{GITHUB_REPOSITORY:source.GITHUB_REPOSITORY,GITHUB_RUN_ID:'123',DATABASE_URL:source.DATABASE_URL,NODE_OPTIONS:source.NODE_OPTIONS,PATH:source.PATH});
 assert.equal(source.GH_TOKEN,'private');assert.equal(source.ACTIONS_RUNTIME_TOKEN,'private');
 const migration=fullCiRoleMigrationEnvironment(source,{mode:'full_ci_disposable',unit:'db-1',offset:0,planFingerprint:'a'.repeat(64)},'/private/evidence');
 assert(!('GH_TOKEN'in migration)&&!('ACTIONS_RUNTIME_TOKEN'in migration)&&!('OPENAI_API_KEY'in migration));
 assert.equal(migration.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');
});

test('actual classifier/migration-shaped child sees only sanitized metadata and purpose database capability',()=>{
 const parent={...process.env,GH_TOKEN:'fictional-private-token',ACTIONS_RUNTIME_TOKEN:'fictional-runtime-token',OPENAI_API_KEY:'fictional-provider-key',PLATFORM_DATABASE_URL:'postgres://fictional-owner@control.invalid/secret',OTHER_OWNER_DATABASE_URL:'postgres://fictional-owner@other.invalid/secret',CONTROL_DB_DSN:'postgres://fictional-owner@other.invalid/secret',POSTGRES_URL_NON_POOLING:'postgres://fictional-owner@other.invalid/secret',PGPASSWORD:'fictional-pg-password',PGPASSFILE:'/fictional/private-passfile'};
 const child=spawnSync(process.execPath,['-e',"process.stdout.write(JSON.stringify({github:process.env.GH_TOKEN??null,runtime:process.env.ACTIONS_RUNTIME_TOKEN??null,provider:process.env.OPENAI_API_KEY??null,platform:process.env.PLATFORM_DATABASE_URL??null,alternate:process.env.OTHER_OWNER_DATABASE_URL??null,dsn:process.env.CONTROL_DB_DSN??null,unpooled:process.env.POSTGRES_URL_NON_POOLING??null,password:process.env.PGPASSWORD??null,passfile:process.env.PGPASSFILE??null,repository:process.env.GITHUB_REPOSITORY??null}))"],{env:candidateEnvironment({...parent,GITHUB_REPOSITORY:'StradaverseHub/ai-hr'}),encoding:'utf8'});
 assert.equal(child.status,0);assert.deepEqual(JSON.parse(child.stdout),{github:null,runtime:null,provider:null,platform:null,alternate:null,dsn:null,unpooled:null,password:null,passfile:null,repository:'StradaverseHub/ai-hr'});
 assert.equal(parent.GH_TOKEN,'fictional-private-token');
});

test('only the four declared purpose database URLs survive; preparation closes all four',()=>{
 const keys=['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'];
 const owned=Object.fromEntries(keys.map(k=>[k,'postgres://fictional-purpose@127.0.0.1/owned']));
 const result=candidateEnvironment({...owned,PLATFORM_DATABASE_URL:'postgres://fictional-owner@control.invalid/other',RANDOM_DATABASE_URL:'postgres://fictional-owner@control.invalid/other',PGHOST:'outside.invalid'});
 assert.deepEqual(result,owned);
 const prepared=nativePreparationEnvironment({...owned,PLATFORM_DATABASE_URL:'postgres://fictional-owner@control.invalid/other',RANDOM_DATABASE_URL:'postgres://fictional-owner@control.invalid/other',PGHOST:'outside.invalid'});
 assert.deepEqual(prepared,Object.fromEntries(keys.map(k=>[k,'postgres://nobody:nothing@127.0.0.1:1/no_database'])));
});
test('real Git clean filters cannot inherit the metadata owner token or database capabilities',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-git-metadata-')),repo=join(root,'source'),filter=join(root,'filter.mjs'),witness=join(root,'witness.json');
 const keys=['GH_TOKEN','GITHUB_TOKEN','PGPASSWORD','DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL','AIHR_CI_HEAD'];
 const original=new Map(keys.map(key=>[key,process.env[key]]));
 try{
  mkdirSync(repo);
  writeFileSync(filter,`import{readFileSync,writeFileSync}from'node:fs';const input=readFileSync(0);writeFileSync(${JSON.stringify(witness)},JSON.stringify({tokenAbsent:!process.env.GH_TOKEN&&!process.env.GITHUB_TOKEN,passwordAbsent:!process.env.PGPASSWORD,databasesClosed:['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'].every(key=>process.env[key]==='postgres://nobody:nothing@127.0.0.1:1/no_database')}));process.stdout.write(input);`);
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:repo,env:nativePreparationEnvironment(process.env),encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
  git('init','--quiet');
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  git('config','filter.aihr-metadata-test.clean',[process.execPath,filter].map(quote).join(' '));
  writeFileSync(join(repo,'.gitattributes'),'tracked.txt filter=aihr-metadata-test\n');writeFileSync(join(repo,'tracked.txt'),'before\n');
  git('add','.');git('-c','user.name=Fictional CI','-c','user.email=ci@example.invalid','commit','--quiet','-m','Fictional metadata control');
  unlinkSync(witness);writeFileSync(join(repo,'tracked.txt'),'after\n');
  for(const key of keys)process.env[key]=key.endsWith('_URL')?'postgres://fictional-owner@control.invalid/private':'fictional-sentinel';
  delete process.env.AIHR_CI_HEAD;
  assert.throws(()=>createPlan(repo),/CI requires a clean candidate/);
  assert.deepEqual(JSON.parse(readFileSync(witness,'utf8')),{tokenAbsent:true,passwordAbsent:true,databasesClosed:true});
  assert.equal(process.env.GH_TOKEN,'fictional-sentinel');
 }finally{
  for(const[key,value]of original){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(root,{recursive:true,force:true});
 }
});
