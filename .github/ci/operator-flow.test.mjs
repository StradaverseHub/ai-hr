/** Actual frozen candidate helpers, only fixture transport; never a real SSH/deploy. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {STAGING,bindStaging,followStagingDeployment,requireSuccessfulBuild} from './operator-release.mjs';
const raw=await import(pathToFileURL(join(process.cwd(),'scripts/improve/release.ts')).href);
const official={...(raw.default??{}),...raw};
const sha='a'.repeat(40);
const reply=(state,log='',extra={})=>Buffer.from(log+official.DEPLOY_STATE_SENTINEL+'\n'+Object.entries({state,log:'/tmp/fixture-only.log',log_size:Buffer.byteLength(log),built_ref:sha,stale_build:state==='ok'?'0':'1',...extra}).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
const observation={write:()=>{},notice:()=>{},sleep:()=>{},now:()=>0,maxConsecutiveFailures:2};
test('Real followDeploy consumes binary SSH replies; string mode would reproduce the escaped regression',()=>{
 const commands=[];const replies=[reply('running','log\n'),reply('ok','',{log_size:4})];
 const ssh=(command,options)=>{commands.push(command);assert.equal(options.encoding,null);const out=replies.shift();return options.encoding===null?out:out.toString('utf8');};
 const status=followStagingDeployment(official,ssh,observation);
 assert.equal(status.state,'ok');assert.equal(commands[0],official.buildFollowCommand(0));assert.equal(commands[1],official.buildFollowCommand(4));assert.equal(requireSuccessfulBuild(official,status,sha),status);
});
test('Dropped transport reconnects through the official loop; no lost deploy is assumed successful',()=>{let calls=0;const ssh=()=>{if(calls++===0)throw Error('fictional disconnect');return reply('ok');};assert.equal(followStagingDeployment(official,ssh,observation).state,'ok');assert.equal(calls,2);});
test('Unobservable deploy still refuses after bounded official retries',()=>{assert.throws(()=>followStagingDeployment(official,()=>{throw Error('offline');},observation),/lost contact/);});
test('Actual failed terminal state is returned then refused by operator result handling',()=>{const status=followStagingDeployment(official,()=>reply('failed'),observation);assert.equal(status.state,'failed');assert.throws(()=>requireSuccessfulBuild(official,status,sha));});
test('Wrong deployed source and stale build cannot become success',()=>{for(const patch of [{built_ref:'b'.repeat(40)},{stale_build:'1'}]){const status=followStagingDeployment(official,()=>reply('ok','',patch),observation);assert.throws(()=>requireSuccessfulBuild(official,status,sha));}});

test('Staging release pins the private alias and refuses endpoint or directory overrides',()=>{
 const env={};
 bindStaging(env);
 assert.equal(env.IMPROVE_SSH_HOST,'aihr-staging');
 assert.equal(env.IMPROVE_SSH_USER,'');
 assert.equal(env.IMPROVE_SSH_PORT,'');
 assert.equal(env.IMPROVE_REMOTE_DIR,STAGING.directory);
 assert.equal(env.AIHR_DEPLOY_STATE_DIR,STAGING.stateDirectory);
 for(const [key,value] of Object.entries({IMPROVE_SSH_HOST:'other.example.com',IMPROVE_SSH_USER:'other-user',IMPROVE_SSH_PORT:'2222',IMPROVE_REMOTE_DIR:'/tmp/other',AIHR_DEPLOY_STATE_DIR:'/tmp/other-state'})){
  assert.throws(()=>bindStaging({[key]:value}),/Staging target mismatch/);
 }
 assert.doesNotThrow(()=>bindStaging(env));
});
