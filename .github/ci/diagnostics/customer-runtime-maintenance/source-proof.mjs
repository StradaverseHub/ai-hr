/** Canonical read-only source/ledger proof for an existing retained baseline. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,realpathSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
export function retainedSourceIdentity(source,baseline){
 source=resolve(source);
 assert(realpathSync(source)===source&&lstatSync(source).isDirectory()&&!lstatSync(source).isSymbolicLink(),'Canonical retained source directory required');
 const git=(...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8'}).trim();
 assert(git('rev-parse','--show-toplevel')===source,'Retained source must be its own worktree root');
 assert(git('rev-parse','HEAD')===baseline&&git('status','--porcelain')==='','Exact clean retained baseline required');
 assert(git('remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','Unexpected retained source origin');
 return {retainedSourceRef:baseline,retainedSourceTree:git('rev-parse','HEAD^{tree}')};
}
async function main(){
const [controller,privatePlan,retainedSource,sshConfig,output]=process.argv.slice(2);
assert(output&&process.argv.length===7,'Usage: source-proof.mjs <controller> <read-only-plan> <retained-source> <SSH-config> <new-output>');
const root=resolve(controller),plan=JSON.parse(readFileSync(privatePlan));
const retained=retainedSourceIdentity(retainedSource,plan.baseline);
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
assert(git('rev-parse','HEAD')===plan.controller&&git('status','--porcelain')==='');
const load=async name=>{const raw=await import(pathToFileURL(join(root,name)).href);return {...(raw.default??{}),...raw};};
const official=await load('scripts/improve/release.ts');
const {stagingTransport}=await load('.github/ci/staging-transport.mjs');
const {verifyBaselineMigrationPreflight}=await load('.github/ci/staging-migration-ledger.mjs');
const transport=stagingTransport(root,{...process.env,AIHR_SSH_CONFIG:resolve(sshConfig)});
const ssh=(command,options={})=>execFileSync('ssh',transport.sshArgs(command),{encoding:'utf8',timeout:30000,maxBuffer:4*1024**2,...options});
const state=official.parseDeployStatus(ssh('cd /opt/ai-hr && deploy/deploy-state.sh status'));
assert(state.state==='ok'&&state.ref===plan.baseline&&state.built_ref===plan.baseline&&state.stale_build==='0'&&state.built_build_id===plan.snapshot.baseline.buildId);
const checksumOutput=execFileSync('rsync',['--dry-run','--checksum','--itemize-changes',...transport.rsyncArgs(official,resolve(retainedSource))],{encoding:'utf8',timeout:120000,maxBuffer:8*1024**2});
assert(checksumOutput==='','Actual retained baseline source checksum differs; no change made');
assert.deepEqual(retainedSourceIdentity(retainedSource,plan.baseline),retained,'Retained source changed during checksum');
const ledger=verifyBaselineMigrationPreflight({candidatePath:root,baseline:plan.baseline,ssh});
assert(ledger.rows===plan.baselineMigrationRows);
const proof={kind:'CANONICAL_READ_ONLY_BASELINE_SOURCE_AND_LEDGER',baseline:plan.baseline,...retained,buildId:state.built_build_id,checksumOutput,ledger,observedAt:new Date().toISOString(),hostWrites:false,dataWrites:false};
const bytes=Buffer.from(JSON.stringify(proof,null,2)+'\n');writeFileSync(output,bytes,{flag:'wx',mode:0o600});
console.log(JSON.stringify({...proof,evidenceSha256:createHash('sha256').update(bytes).digest('hex')}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
