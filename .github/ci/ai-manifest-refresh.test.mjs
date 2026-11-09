/** Real temporary Git/source fixtures for the fixed generators; never provider, DB or native authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {manifestRefreshSelection,checkedManifestChild,assertRefreshProviderSource,manifestRemainingTimeout,refreshAiManifests,MANIFEST_REFRESH_COMMANDS} from './ai-manifest-refresh.mjs';
import {initAiManifestFixture,writeFixture,commitAiManifestFixture,fixtureGit} from './ai-manifest-test-fixture.mjs';
import {admitAiManifests} from './ai-manifest-admission.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
const approval='lib/ai/provider-data-approvals.ts';
const event=()=>({repository:{full_name:'StradaverseHub/ai-hr'},ref:'refs/heads/main',inputs:{refresh_ai_source_manifests:'true',candidate_ref:'codex/fixture',expected_sha:'a'.repeat(40),selected_tests:'[]'}});
function withPair(fn){
 const temp=mkdtempSync(join(tmpdir(),'ai-manifest-refresh-')),candidate=join(temp,'candidate'),controller=join(temp,'controller');
 try{
  for(const dir of [candidate,controller]){
   writeFixture(dir,'placeholder',dir===candidate?'fictional candidate':'fictional controller');initAiManifestFixture(dir);
   writeFixture(dir,approval,readFileSync(join(root,approval)));
   writeFixture(dir,'core/attendance-formula-ai.ts',"import '../lib/attendance-formula-ai';\n");
   writeFixture(dir,'lib/attendance-formula-ai.ts','// Fictional finite authoring serializer\n');
   writeFixture(dir,'core/performance.ts','// Fictional changed provider input\n');
   writeFixture(dir,'lib/ai/refresh-fixture.ts','// Fictional changed agent input\n');
   if(dir===controller){
    for(const path of ['.github/ci/ai-manifest-refresh.mjs','.github/ci/resolve.mjs','.github/ci/ai-manifest-admission.mjs']){
     writeFixture(dir,path,readFileSync(join(root,path)));
    }
   }
   commitAiManifestFixture(dir);
  }
  const options=()=>({candidatePath:candidate,controllerPath:controller,source:fixtureGit(candidate,'rev-parse','HEAD'),controller:fixtureGit(controller,'rev-parse','HEAD')});
  fn({candidate,controller,options});
 }finally{rmSync(temp,{recursive:true,force:true});}
}
function adversarialGenerator(pair,code){
 const file='scripts/ai-provider-data-source-manifest.mjs';
 for(const dir of [pair.candidate,pair.controller]){
  writeFixture(dir,file,readFileSync(join(dir,file),'utf8')+'\n'+code+'\n');commitAiManifestFixture(dir);
 }
}
test('refresh accepts only the exclusive exact boolean source-data request',()=>{
 assert.deepEqual(manifestRefreshSelection(event()),{branch:'codex/fixture',source:'a'.repeat(40)});
 const value=event();value.inputs.refresh_ai_source_manifests=true;assert.equal(manifestRefreshSelection(value).branch,'codex/fixture');
 for(const patch of [{selected_tests:'["test/x.test.ts"]'},{selected_tests:'[ ]'},{refresh_ai_source_manifests:false},{run_typecheck:'true'},{run_build:true},{run_native_typecheck:true},{run_native_bundle:true},{run_native_swift_models:true},{profile_database:true},{duration_order:true},{qualify_restricted_port_prerequisites:true},{employee_ascii_qualification:'off'},{model_eval:'fictional'},{eval_allowed_providers:'openai'},{expected_sha:'invalid'},{expected_sha:undefined},{candidate_ref:'../foreign'},{candidate_ref:''},{candidate_ref:undefined},{command:'node arbitrary'}]){
  const e=event();Object.assign(e.inputs,patch);assert.throws(()=>manifestRefreshSelection(e));
 }
 const foreign=event();foreign.repository.full_name='foreign/repository';assert.throws(()=>manifestRefreshSelection(foreign));
});
test('actual fixed generators refresh in dependency order and preserve every approval byte',()=>withPair(p=>{
 const before=readFileSync(join(p.candidate,approval));
 const source=p.options().source,tree=fixtureGit(p.candidate,'rev-parse','HEAD^{tree}');
 const result=refreshAiManifests(p.options());assert.equal(result.receipt.source,source);assert.equal(result.receipt.originalTree,tree);
 assert.notEqual(result.receipt.source,result.receipt.controller);
 assert.equal(result.generated.length,2);assert(result.generated.every(r=>r.bytes.equals(readFileSync(join(p.candidate,r.path)))));
 assert(readFileSync(join(p.candidate,approval)).equals(before));
 assert.deepEqual(result.receipt.approvalRecords,{approved:29,pending:2,unchanged:true,renewed:false});
 for(const path of ['core/attendance-formula-ai.ts','lib/attendance-formula-ai.ts']){
  assert.deepEqual(result.receipt.provider.members.find(row=>row.path===path),{path,sha256:hash(readFileSync(join(p.candidate,path)))});
 }
 assert(!result.receipt.provider.members.some(row=>row.path===approval));
 assert.deepEqual(result.receipt.agent.members.find(row=>row.path===approval),{path:approval,sha256:hash(before)});
 for(const field of ['releaseAuthorized','testAuthorized','nativeAuthorized','providerAuthorized'])assert.equal(result.receipt[field],false);
 const provider=result.generated[0],agentInput=result.receipt.agent.members.find(r=>r.path===provider.path);
 assert.equal(agentInput.sha256,hash(provider.bytes));assert.notEqual(result.receipt.originalOutputs[0].sha256,agentInput.sha256);
 assert.equal(result.receipt.agent.inputPhase,'after-provider-refresh');
 assert.deepEqual(fixtureGit(p.candidate,'diff','--name-only').split('\n'),result.generated.map(r=>r.path).sort());
 assert.equal(admitAiManifests(p.candidate,commitAiManifestFixture(p.candidate)).checks.length,2);
}));
test('same-count approval provenance drift refuses before either generated file changes',()=>withPair(p=>{
 const original=readFileSync(join(p.candidate,approval),'utf8');
 const changed=original.replace('human:zenlam repository-owner provisional','human:fictional reviewer provisional');
 assert.notEqual(changed,original);
 writeFixture(p.candidate,approval,changed);commitAiManifestFixture(p.candidate);
 assert.throws(()=>refreshAiManifests(p.options()),/Exact e706 approval registry required/);
 assert.equal(fixtureGit(p.candidate,'status','--porcelain'),'');
}));
test('a tracked Attendance serializer outside the actual provider closure refuses',()=>withPair(p=>{
 const attendance=readFileSync(join(root,'core/attendance-formula-ai.ts'),'utf8');
 assert.match(attendance,/from ['"]\.\.\/lib\/attendance-formula-ai['"]/);
 writeFixture(p.candidate,'core/attendance-formula-ai.ts','// Fictional missing authoring dependency\n');
 commitAiManifestFixture(p.candidate);
 assert.throws(()=>refreshAiManifests(p.options()),/Attendance authoring source closure required/);
 const generated='lib/ai/module-agent-source-manifest.ts';
 assert.equal(readFileSync(join(p.candidate,generated),'utf8'),fixtureGit(p.candidate,'show','HEAD:'+generated)+'\n');
}));
test('the actual previously approved provider digest refuses even with both Attendance members',()=>{
 const manifest=readFileSync(join(root,'lib/ai/provider-data-source-manifest.ts'),'utf8');
 const approved=/SOURCE_DIGEST = "([0-9a-f]{64})"/.exec(manifest)[1];
 const sources=['core/attendance-formula-ai.ts','lib/attendance-formula-ai.ts'];
 assert.throws(()=>assertRefreshProviderSource({sources,digest:approved}),/must leave the changed provider source unapproved/);
 assert.doesNotThrow(()=>assertRefreshProviderSource({sources,digest:'a'.repeat(64)}));
});
test('dirty or wrong source and controller identities refuse before generator work',()=>withPair(p=>{
 const initial=p.options();assert.throws(()=>refreshAiManifests({...initial,source:'f'.repeat(40)}),/Exact clean/);
 assert.throws(()=>refreshAiManifests({...initial,controller:'f'.repeat(40)}),/Exact clean/);
 writeFixture(p.candidate,'foreign.txt','fictional');assert.throws(()=>refreshAiManifests(initial),/Exact clean/);
 rmSync(join(p.candidate,'foreign.txt'));writeFixture(p.controller,'foreign.txt','fictional');assert.throws(()=>refreshAiManifests(initial),/Exact clean/);
}));
test('reviewed generator and source-scope identity cannot be replaced by a no-op',()=>withPair(p=>{
 for(const name of ['scripts/ai-provider-data-source-manifest.mjs','scripts/ai-agent-source-manifest.mjs','scripts/ai-agent-source-scope.mjs']){
  const bytes=readFileSync(join(p.candidate,name));writeFixture(p.candidate,name,'// no-op\n');commitAiManifestFixture(p.candidate);
  assert.throws(()=>refreshAiManifests(p.options()),/Unreviewed generator or scope/);
  writeFixture(p.candidate,name,bytes);commitAiManifestFixture(p.candidate);
 }
}));
test('actual generator approval mutation is refused without renewing a review',()=>withPair(p=>{
 adversarialGenerator(p,"writeFileSync('lib/ai/provider-data-approvals.ts','// changed approval');");
 assert.throws(()=>refreshAiManifests(p.options()),/Protected generator, scope or approval changed/);
}));
test('actual unexpected source writes cannot enter the generated-data artifact',()=>withPair(p=>{
 adversarialGenerator(p,"writeFileSync('unexpected.txt','fictional');");
 assert.throws(()=>refreshAiManifests(p.options()),/Unexpected candidate change/);
}));
test('ignored untracked provider inputs cannot masquerade as frozen commit members',()=>withPair(p=>{
 writeFixture(p.candidate,'.gitignore','core/ignored-refresh-input.ts\n');
 writeFixture(p.candidate,'core/performance.ts',"import './ignored-refresh-input';\n");
 writeFixture(p.candidate,'core/ignored-refresh-input.ts','// Fictional ignored input\n');commitAiManifestFixture(p.candidate);
 assert.equal(fixtureGit(p.candidate,'status','--porcelain'),'');
 assert.throws(()=>refreshAiManifests(p.options()),/frozen tracked source/);
}));
test('a clean Git CRLF checkout cannot change a source member or generated preimage',()=>{
 for(const [side,path,unwrittenOutput] of [
  ['candidate','core/performance.ts','module-agent-source-manifest.ts'],
  ['candidate','lib/ai/refresh-fixture.ts','provider-data-source-manifest.ts'],
  ['candidate','lib/ai/module-agent-source-manifest.ts','provider-data-source-manifest.ts'],
  ['controller','.github/ci/resolve.mjs','provider-data-source-manifest.ts'],
 ]){
  withPair(p=>{
   const directory=p[side];
   const lf=readFileSync(join(directory,path),'utf8');
   assert(lf.endsWith('\n')&&!lf.includes('\r'));
   writeFixture(directory,'.gitattributes',path+' text eol=crlf\n');
   commitAiManifestFixture(directory);
   fixtureGit(directory,'checkout-index','--force','--',path);
   assert.equal(fixtureGit(directory,'status','--porcelain'),'');
   assert.equal(fixtureGit(directory,'show','HEAD:'+path)+'\n',lf);
   assert.equal(readFileSync(join(directory,path),'utf8'),lf.replaceAll('\n','\r\n'));
   const output=join(p.candidate,'lib/ai',unwrittenOutput),before=readFileSync(output);
   assert.throws(()=>refreshAiManifests(p.options()),/differs from its frozen Git blob/);
   assert(readFileSync(output).equals(before));
  });
 }
});
test('actual generator or scope mutation refuses before the next fixed child',()=>withPair(p=>{
 adversarialGenerator(p,"writeFileSync('scripts/ai-agent-source-scope.mjs','// changed scope');");
 assert.throws(()=>refreshAiManifests(p.options()),/Protected generator, scope or approval changed/);
}));
test('actual excessive child output is bounded and never parsed as source evidence',()=>withPair(p=>{
 adversarialGenerator(p,"process.stdout.write('x'.repeat(2*1024*1024));");
 assert.throws(()=>refreshAiManifests(p.options()),/Fixed manifest operation refused|Fixed manifest output refused/);
}));
test('fixed child environment omits parent credentials and cannot select a command',()=>withPair(p=>{
 adversarialGenerator(p,"if(Object.keys(process.env).sort().join(',')!=='GIT_CONFIG_GLOBAL,GIT_CONFIG_NOSYSTEM,GIT_TERMINAL_PROMPT,LANG,LC_ALL,PATH,TZ')throw Error('Unexpected inherited environment');");
 const prior=process.env.FICTIONAL_PARENT_TOKEN;process.env.FICTIONAL_PARENT_TOKEN='fictional';
 try{assert.equal(refreshAiManifests(p.options()).receipt.providerAuthorized,false);}finally{if(prior===undefined)delete process.env.FICTIONAL_PARENT_TOKEN;else process.env.FICTIONAL_PARENT_TOKEN=prior;}
 assert.deepEqual(MANIFEST_REFRESH_COMMANDS,[['scripts/ai-provider-data-source-manifest.mjs','--list'],['scripts/ai-agent-source-manifest.mjs'],['scripts/ai-provider-data-source-manifest.mjs','--check'],['scripts/ai-agent-source-manifest.mjs','--check']]);
 assert(MANIFEST_REFRESH_COMMANDS.every(Object.isFrozen));
}));
test('child status timeout signal output shape and counts cannot become success',()=>{
 const good={status:0,signal:null,error:undefined,stdout:JSON.stringify({files:1,digest:'a'.repeat(64)}),stderr:''};
 assert.equal(checkedManifestChild(good).files,1);
 for(const patch of [{status:1},{signal:'SIGTERM'},{error:Object.assign(Error('timeout'),{code:'ETIMEDOUT'})},{error:Object.assign(Error('cap'),{code:'ENOBUFS'})},{stderr:'unexpected'},{stdout:'not JSON'},{stdout:JSON.stringify({files:0,digest:'a'.repeat(64)})},{stdout:JSON.stringify({files:1,digest:'short'})},{stdout:JSON.stringify({files:1,digest:'a'.repeat(64),extra:true})}])assert.throws(()=>checkedManifestChild({...good,...patch}));
 assert.throws(()=>checkedManifestChild({...good,stdout:JSON.stringify({files:2,digest:'a'.repeat(64),sources:['same','same']})},true));
});
test('one aggregate clock charges every operation instead of resetting per child',()=>{
 assert.equal(manifestRemainingTimeout(240000,0,60000),60000);assert.equal(manifestRemainingTimeout(240000,220000,60000),20000);
 assert.throws(()=>manifestRemainingTimeout(240000,240000,60000),/exhausted/);
 for(const values of [[Infinity,0,60000],[240000,NaN,60000],[240000,0,0]])assert.throws(()=>manifestRemainingTimeout(...values));
});
test('refresh workflow is exclusive and normal job commands retain their original owners',()=>{
 const workflow=readFileSync(join(root,'.github/workflows/alpha-focused-checks.yml'),'utf8');
 for(const name of ['resolve','selected-tests','typecheck','linux-build','native-typecheck','native-bundle','native-swift-models']){
  const block=workflow.split('\n  '+name+':\n')[1].split(/^  [a-z][a-z_-]*:\n/m)[0];assert(block.includes('!inputs.refresh_ai_source_manifests'));
 }
 const block=workflow.split('\n  refresh-ai-source-manifests:\n')[1];assert(block.includes("node automation/.github/ci/ai-manifest-refresh.mjs --selection"));assert(block.includes('node automation/.github/ci/resolve.mjs'));
 assert(block.indexOf('--selection')<block.indexOf('node automation/.github/ci/resolve.mjs'));assert(!/setup-alpha|pnpm|npm |sudo|postgres|deploy|--test/.test(block));
 assert(block.includes('persist-credentials: false'));assert(block.includes('timeout-minutes: 5'));assert(block.includes("node-version: '22.23.3'"));
});
