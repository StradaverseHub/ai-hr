/** Tiny typed source fixture only: no application build/compiler/DB/provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {nativePreparationEnvironment} from './candidate-environment.mjs';
const helper=fileURLToPath(new URL('./native-next-build-inputs.mjs',import.meta.url));
test('real fixed preparation child binds frozen typed source with closed DB and no owner credentials',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'native-source-input-'))),source=join(root,'source'),privateDir=join(root,'db-fixture-native-build-private');
 try{
  mkdirSync(source);mkdirSync(privateDir,{mode:0o700});mkdirSync(join(source,'scripts/improve'),{recursive:true});mkdirSync(join(source,'lib/system-testing'),{recursive:true});
  writeFileSync(join(source,'package.json'),'{"type":"module"}');
  writeFileSync(join(source,'scripts/improve/system-testing-manifest.ts'),`export function prepareSystemTestingBuild(p:{worktree:string;candidate:string;buildRecordId:string}){
   if(process.env.GH_TOKEN||process.env.ACTIONS_RUNTIME_TOKEN||process.env.OPENAI_API_KEY)throw Error('Credentials reached candidate');
   if(process.env.MIGRATION_DATABASE_URL!=='postgres://nobody:nothing@127.0.0.1:1/no_database')throw Error('Open DB reached candidate');
   return{format:1,identity:{sourceRef:p.candidate,buildRecordId:p.buildRecordId},sourceHashRecord:[],activeServiceVerified:false};}
  `);
  writeFileSync(join(source,'lib/system-testing/hash.ts'),'export const stableTestingJson=(value:unknown):string=>JSON.stringify(value);');
  const git=(...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');git('add','.');git('-c','user.name=CI fixture','-c','user.email=fixture@example.invalid','commit','-qm','fictional canonical inputs');
  const sha=git('rev-parse','HEAD'),record='00000000-0000-4000-8000-000000000001',output=join(privateDir,'canonical-prepared.json');
  const env=nativePreparationEnvironment({...process.env,GH_TOKEN:'fictional-owner-token',ACTIONS_RUNTIME_TOKEN:'fictional-runtime-token',OPENAI_API_KEY:'fictional-key',MIGRATION_DATABASE_URL:'postgres://fictional-owner@outside.invalid/closed',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_JOB:'native-test',GITHUB_RUN_ATTEMPT:'1',RUNNER_TEMP:root});
  const child=spawnSync(process.execPath,['--experimental-strip-types',helper,source,output,sha,record],{cwd:source,env,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'');
  assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),{format:1,identity:{sourceRef:sha,buildRecordId:record},sourceHashRecord:[],activeServiceVerified:false});
  rmSync(output);writeFileSync(join(source,'package.json'),'{"type":"module","changed":true}');
  const drift=spawnSync(process.execPath,['--experimental-strip-types',helper,source,output,sha,record],{cwd:source,env,encoding:'utf8'});
  assert.notEqual(drift.status,0);assert.equal(drift.stderr.trim().endsWith('Native candidate preparation refused'),true);
  const leaked=spawnSync(process.execPath,['--experimental-strip-types',helper,source,output,sha,record],{cwd:source,env:{...env,GH_TOKEN:'fictional-must-not-print'},encoding:'utf8'});
  assert.notEqual(leaked.status,0);assert(!leaked.stderr.includes('fictional-must-not-print'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
