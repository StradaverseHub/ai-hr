import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {spawnSync} from 'node:child_process';
import {counterExceptionFlow,COUNTER_MIRROR_SCRIPT,counterMirrorCommand,bindCounterTransfer} from './local-counter-exception-operator.mjs';
import {COUNTER_EXCEPTION as P} from './local-counter-exception.mjs';
import {ACCEPTANCE_TIER} from './local-counter-exception-acceptance.mjs';
const head='c'.repeat(40);
function fixture(){
 const calls=[],evidence={tier:ACCEPTANCE_TIER,result:'ACCEPTED_WITH_OWNER_EXCEPTION',stagingBuildAuthorized:true,canonicalResult:'FAIL',originalCandidate:P.candidate,rawVitestExit:'UNKNOWN_NOT_SEPARATELY_RECORDED',sourceBoundary:{counterRepairApplied:true},candidate:head,candidatePath:'/private/candidate'};
 const status={state:'ok',ref:head,built_ref:head,stale_build:'0',built_build_id:'new-linux-build'};
 const official={buildPendingCommand:sha=>'pending:'+sha,buildTestingRecordCommand:(sha,id)=>'record:'+sha+':'+id,buildLaunchCommand:(sha,dir,state,id)=>'launch:'+sha+':'+dir+':'+state+':'+id,buildFollowCommand:offset=>'follow:'+offset,isSuccessState:s=>s==='ok',followDeploy:({run})=>{assert(Buffer.isBuffer(run(0)));return status;}};
 const transport={ssh:(command,options)=>{calls.push(command);return command.startsWith('follow:')?Buffer.from('status'):'launched';},transfer:path=>calls.push('transfer:'+path)};
 return {calls,status,args:{evidence,official,transport,testingBuild:{identity:{buildRecordId:'real-owned-uuid'}},stableTestingJson:JSON.stringify,revalidate:phase=>calls.push('validate:'+phase),assertBuildFrozen:()=>calls.push('frozen'),save:name=>calls.push('save:'+name)}};
}
test('exception uses staged official sequence and fresh testing identity without a full PASS',()=>{
 const f=fixture();assert.equal(counterExceptionFlow(f.args),f.status);
 assert.deepEqual(f.calls.slice(0,6),['validate:baseline','frozen','pending:'+head,'validate:pending','frozen','transfer:/private/candidate']);
 assert(f.calls.includes('record:'+head+':real-owned-uuid'));
 assert(f.calls.some(c=>c.startsWith('launch:'+head+':/opt/ai-hr:/var/tmp/aihr-deploy:')));
 assert(f.calls.includes('follow:0'));assert(f.calls.includes('save:remote-build-result.json'));
 assert.equal(f.args.evidence.canonicalResult,'FAIL');assert.equal(f.args.evidence.rawVitestExit,'UNKNOWN_NOT_SEPARATELY_RECORDED');
});
test('missing exception or failed revalidation cannot announce or transfer',()=>{
 for(const change of [a=>a.evidence.stagingBuildAuthorized=false,a=>a.evidence.canonicalResult='PASS',a=>a.evidence.rawVitestExit='0',a=>a.evidence.sourceBoundary.counterRepairApplied=false,a=>a.revalidate=()=>{throw Error('changed source');}]){
  const f=fixture();change(f.args);assert.throws(()=>counterExceptionFlow(f.args));assert(!f.calls.some(c=>c.startsWith('pending:')||c.startsWith('transfer:')));
 }
});
test('announcement/transfer/publication failures prevent launch; wrong built source refuses',()=>{
 for(const fail of ['pending:','transfer:','record:']){
  const f=fixture();f.args.transport={ssh:c=>{f.calls.push(c);if(c.startsWith(fail))throw Error('transport failure');return 'ok';},transfer:p=>{f.calls.push('transfer:'+p);if(fail==='transfer:')throw Error('transfer failed');}};
  assert.throws(()=>counterExceptionFlow(f.args));assert(!f.calls.some(c=>c.startsWith('launch:')));
 }
 const f=fixture();f.status.built_ref='d'.repeat(40);assert.throws(()=>counterExceptionFlow(f.args));assert(!f.calls.includes('save:remote-build-result.json'));
});
test('mirror shell quoting transports literal code and metadata writes are private and exclusive',()=>{
 const command=counterMirrorCommand(),parsed=spawnSync('python3',['-c','import shlex,json,sys; print(json.dumps(shlex.split(sys.argv[1])))',command],{encoding:'utf8'});
 assert.equal(parsed.status,0,parsed.stderr);assert.deepEqual(JSON.parse(parsed.stdout),['/opt/node20/bin/node','-e',COUNTER_MIRROR_SCRIPT]);
 const writes=[],fs={readFileSync:()=>JSON.stringify({kind:'OWNER_COUNTER_EXCEPTION_RELEASE_EVIDENCE',evidence:{candidate:head}}),mkdirSync:(...a)=>writes.push(['mkdir',...a]),writeFileSync:(...a)=>writes.push(['write',...a])};
 runInNewContext(COUNTER_MIRROR_SCRIPT,{require:name=>{assert.equal(name,'node:fs');return fs;}});
 assert.equal(writes[1][2],JSON.stringify({kind:'OWNER_COUNTER_EXCEPTION_RELEASE_EVIDENCE',evidence:{candidate:head}})+'\n');
 assert.equal(writes[0][2].mode,0o700);assert.equal(writes[1][1],'/var/tmp/aihr-deploy/owner-exceptions/'+head+'.json');assert.equal(writes[1][3].flag,'wx');assert.equal(writes[1][3].mode,0o600);
 assert.throws(()=>runInNewContext(COUNTER_MIRROR_SCRIPT,{require:()=>({...fs,readFileSync:()=>JSON.stringify({kind:'OWNER_COUNTER_EXCEPTION_RELEASE_EVIDENCE',evidence:{candidate:'../../other'}})})}));
});

test('rsync preserves official filters/source while binding checked private config and alias',()=>{
 const config="/private/config with 'quote'/ssh config",address={user:'operator',hostname:'staging.invalid',port:'2222'};
 const native=['-az','--delete','-e','ssh -p 2222 -o BatchMode=yes -o ConnectTimeout=12','--exclude','node_modules','--exclude','.env*','--exclude','/scratchpad/','/private/candidate/','operator@staging.invalid:/opt/ai-hr/'];
 const bound=bindCounterTransfer(native,address,config,'/private/candidate');
 assert.deepEqual(bound.slice(4,-1),native.slice(4,-1));assert.equal(bound.at(-1),'aihr-staging:/opt/ai-hr/');assert.equal(native.at(-1),'operator@staging.invalid:/opt/ai-hr/');
 const parsed=spawnSync('python3',['-c','import shlex,json,sys; print(json.dumps(shlex.split(sys.argv[1])))',bound[3]],{encoding:'utf8'});
 assert.equal(parsed.status,0);assert.deepEqual(JSON.parse(parsed.stdout),['ssh','-F',config,'-o','BatchMode=yes','-o','ConnectTimeout=12']);
 assert.throws(()=>bindCounterTransfer([...native.slice(0,-1),'other:/opt/ai-hr/'],address,config,'/private/candidate'));
 assert.throws(()=>bindCounterTransfer(native,address,config,'/different/source'));
});
test('exception mirror retry accepts identical immutable evidence and refuses conflicting bytes',()=>{
 const value={kind:'OWNER_COUNTER_EXCEPTION_RELEASE_EVIDENCE',evidence:{candidate:head}},text=JSON.stringify(value)+'\n';let existing=text;
 const fs={readFileSync:p=>p===0?JSON.stringify(value):existing,mkdirSync:()=>{},writeFileSync:()=>{throw Object.assign(Error('exists'),{code:'EEXIST'});}};
 runInNewContext(COUNTER_MIRROR_SCRIPT,{require:()=>fs});existing='other';assert.throws(()=>runInNewContext(COUNTER_MIRROR_SCRIPT,{require:()=>fs}));
});
