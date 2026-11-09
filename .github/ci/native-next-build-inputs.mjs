/** Fixed credential-free candidate preparation subprocess, never an API owner. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync,realpathSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {candidateEnvironment} from './candidate-environment.mjs';
export async function prepareNativeCandidateInputs(source,output,candidate,buildRecordId){
 const safe=candidateEnvironment(process.env);assert(Object.keys(process.env).every(key=>Object.hasOwn(safe,key)),'Candidate preparation received credentials');
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
 assert.equal(process.env.GITHUB_JOB,'native-test');assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])assert(process.env[key]==='postgres://nobody:nothing@127.0.0.1:1/no_database','Canonical preparation database must be closed');
 assert.equal(realpathSync(source),source);assert.equal(source,realpathSync(process.cwd()));
 assert(/^[a-f0-9]{40}$/.test(candidate)&&/^[a-f0-9-]{36}$/.test(buildRecordId));
 const temporary=realpathSync(process.env.RUNNER_TEMP),parent=realpathSync(resolve(output,'..'));
 assert(parent.startsWith(temporary+'/')&&parent.endsWith('-native-build-private'));
 const info=lstatSync(parent);assert(info.isDirectory()&&info.uid===process.getuid()&&(info.mode&0o777)===0o700);
 assert.equal(output,join(parent,'canonical-prepared.json'));
 const git=(...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8',timeout:30000,maxBuffer:1048576}).trim();
 assert.equal(git('rev-parse','HEAD'),candidate);assert.equal(git('status','--porcelain'),'');
 const raw=await import(pathToFileURL(join(source,'scripts/improve/system-testing-manifest.ts')).href),owner={...(raw.default??{}),...raw};
 const rawHash=await import(pathToFileURL(join(source,'lib/system-testing/hash.ts')).href),hashOwner={...(rawHash.default??{}),...rawHash};
 const prepared=owner.prepareSystemTestingBuild({worktree:source,candidate,buildRecordId}),bytes=Buffer.from(hashOwner.stableTestingJson(prepared)+'\n');
 assert(bytes.length>0&&bytes.length<=80*1024);assert.equal(git('rev-parse','HEAD'),candidate);assert.equal(git('status','--porcelain'),'');
 writeFileSync(output,bytes,{flag:'wx',mode:0o600});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.equal(process.argv.length,6);prepareNativeCandidateInputs(...process.argv.slice(2)).catch(()=>{console.error('Native candidate preparation refused');process.exitCode=1;});
}
