/** Real frozen command builders and follower; only transport is replaced. No network/deploy/DB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LOCAL_REPAIR as P} from './local-environment-repair.mjs';
import {loadFrozenModule} from './local-environment-repair-evidence.mjs';
import {deployRepairBuild,stagingRepairTransport,resolveStagingRepairAddress} from './local-environment-repair-operator.mjs';
const candidate=process.env.AIHR_REPAIR_FLOW_CANDIDATE;
assert.ok(candidate,'Set AIHR_REPAIR_FLOW_CANDIDATE to the frozen installed candidate; actual helpers are required');
const official=await loadFrozenModule(candidate,'scripts/improve/release.ts');
const build={identity:{buildRecordId:'11111111-1111-4111-8111-111111111111'}};
function fixture({status={},throws={}}={}){
 const events=[],saved=[];
 const evidence={tier:P.tier,policyVersion:P.version,sha:P.candidate,baseline:P.baseline,originalResult:'FAIL',candidatePath:candidate};
 const values={state:'ok',ref:P.candidate,built_ref:P.candidate,built_build_id:'fixture-next-id',stale_build:'0',log:'-',log_size:'0',...status};
 const reply=Buffer.from(official.DEPLOY_STATE_SENTINEL+'\n'+Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
 const transport={ssh:(command,options={})=>{
  events.push({kind:'ssh',command,options});
  if(command===official.buildPendingCommand(P.candidate)&&throws.announce)throw Error('fixture pending failed');
  if(command===official.buildTestingRecordCommand(P.candidate,build.identity.buildRecordId)&&throws.testing)throw Error('fixture testing record refused');
  if(command===official.buildFollowCommand(0)){assert.equal(options.encoding,null);if(throws.follow)throw Error('fixture disconnect');return reply;}
  return 'fixture launch output';
 },transfer:path=>{events.push({kind:'transfer',path});if(throws.transfer)throw Error('fixture transfer failed');}};
 const args={evidence,official,testingBuild:build,stableTestingJson:JSON.stringify,transport,
  revalidate:phase=>{events.push({kind:'verify',phase});if(throws[phase])throw Error('fixture evidence changed');},
  assertBuildFrozen:()=>{events.push({kind:'build-frozen'});if(throws.frozen)throw Error('fixture build changed');},save:(name,value)=>saved.push({name,value}),
  observation:{write:()=>{},notice:()=>{},sleep:()=>{},now:()=>0,maxConsecutiveFailures:2}};
 return {args,events,saved};
}
test('Actual helper flow verifies baseline, announces, transfers, publishes testing identity, verifies pending, launches and follows binary output',()=>{
 const f=fixture(),result=deployRepairBuild(f.args);
 assert.equal(result.built_ref,P.candidate);
 assert.deepEqual(f.events.filter(e=>e.kind==='verify').map(e=>e.phase),['baseline','pending','pending']);
 const commands=f.events.filter(e=>e.kind==='ssh').map(e=>e.command);
 assert.equal(commands[0],official.buildPendingCommand(P.candidate));
 assert.equal(commands[1],official.buildTestingRecordCommand(P.candidate,build.identity.buildRecordId));
 assert.equal(commands[2],official.buildLaunchCommand(P.candidate,'/opt/ai-hr','/var/tmp/aihr-deploy',build.identity.buildRecordId));
 assert.equal(commands[3],official.buildFollowCommand(0));
 assert.deepEqual(f.saved.map(x=>x.name),['launch.json','remote-build-result.json']);
 assert.equal(f.events.filter(e=>e.kind==='transfer').length,1);
});
for(const failure of ['baseline','frozen','announce','pending','transfer','testing'])test('Actual helper flow stops before launch on '+failure,()=>{
 const f=fixture({throws:{[failure]:true}});assert.throws(()=>deployRepairBuild(f.args));
 assert.ok(!f.events.some(e=>e.command===official.buildLaunchCommand(P.candidate,'/opt/ai-hr','/var/tmp/aihr-deploy',build.identity.buildRecordId)));
 if(['baseline','frozen','announce','pending'].includes(failure))assert.equal(f.events.filter(e=>e.kind==='transfer').length,0);
});
for(const status of [{state:'failed'},{built_ref:'b'.repeat(40)},{ref:'b'.repeat(40)},{stale_build:'1'},{built_build_id:''}])test('Actual terminal build state refuses '+JSON.stringify(status),()=>{
 const f=fixture({status});assert.throws(()=>deployRepairBuild(f.args));assert.equal(f.saved.at(-1).name,'remote-build-result.json');
});
test('Lost transport cannot become success',()=>{const f=fixture({throws:{follow:true}});assert.throws(()=>deployRepairBuild(f.args),/lost contact/);});
test('Full/CI/legacy success cannot be substituted for this separate repair evidence',()=>{for(const tier of ['full','ci','phase-reuse']){const f=fixture();f.args.evidence.tier=tier;assert.throws(()=>deployRepairBuild(f.args));assert.equal(f.events.length,0);}});
test('Staging alias and private config retain actual canonical rsync exclusions',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'aihr-port-repair-transport-')));
 try{
  const config=join(dir,'ssh config');writeFileSync(config,'Host aihr-staging\n HostName fixture.invalid\n',{mode:0o600});
  const calls=[],run=(cmd,args,options)=>{calls.push({cmd,args,options});return 'fixture';};
  const transport=stagingRepairTransport(official,config,run);
  transport.ssh('fixture read only');transport.transfer(candidate);
  assert.deepEqual(calls[0].args,['-F',config,'-o','BatchMode=yes','-o','ConnectTimeout=12','aihr-staging','fixture read only']);
  const actual=calls[1].args,expected=official.deploymentRsyncArgs(candidate);
  assert.deepEqual(actual,expected);
  const address=resolveStagingRepairAddress(config,(cmd,args)=>{assert.equal(cmd,'ssh');assert.deepEqual(args,['-G','-F',config,'aihr-staging']);return 'hostname fixture.invalid\nuser fixture_user\nport 2222\n';});
  assert.deepEqual(address,{hostname:'fixture.invalid',user:'fixture_user',port:'2222'});
  assert.throws(()=>resolveStagingRepairAddress(config,()=> 'hostname fixture.invalid\nhostname other.invalid\nuser fixture\nport 2222\n'));
  chmodSync(config,0o644);assert.throws(()=>stagingRepairTransport(official,config,run));
 }finally{rmSync(dir,{recursive:true});}
});
