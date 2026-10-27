/** Controller contracts only, never native/business/browser evidence. Generated-TS syntax uses the candidate TypeScript installed by setup-alpha. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {buildFixtureBootstrap,confirmedContainerAbsent,parseNativeReadbackResponse,nativeReadbackBootstrap,createPrivateNativeReadbackClient,MODULES,REMAINING,unitFor,childEnvironment,validateFixture,publicReport,parseOwnedGroupSnapshot} from './assistant-development-browser.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function packet(){const actors=Array.from({length:6},(_,n)=>({userId:id(n+1),personId:id(n+11),employmentId:id(n+21)}));return {format:1,state:'native_prerequisites_prepared_not_experienced',actors:{operator:actors[0],self:actors[1],reviewers:[actors[2],actors[3]],peer:actors[4],manager:actors[5]},finalNativePrerequisites:[0,2,3].map(n=>({userId:actors[n].userId,modules:MODULES.map(module=>({module,state:'complete',nativeEvidence:'present',qualityFailures:0,securityFailures:0,cases:[{id:module+':nonempty-business-evidence',category:'native',passed:true}]}))})),expectedNative:{selfLeaveRequests:0,selfProfileRequests:0,closeTargetStatus:'processed'},limits:{uiTargetEffects:'not_executed',providerCapability:'UNVERIFIED_NO_CALLS',notificationEmailConsent:'UNAVAILABLE_REQUIRES_ACTUAL_VERIFIED_PROVIDER_IDENTITY',releaseGate:'NOT_RUN'}};}
test('exact candidate/run/attempt own distinct finite container keys',()=>{const sha='a'.repeat(40);assert.match(unitFor('12','1',sha),/^db-[a-f0-9]{16}$/);assert.notEqual(unitFor('12','1',sha),unitFor('12','2',sha));assert.notEqual(unitFor('12','1',sha),unitFor('12','1','b'.repeat(40)));for(const args of [['x','1',sha],['1','0x1',sha],['1','1','main']])assert.throws(()=>unitFor(...args));});
test('child environment omits production secrets, provider/auth credentials and inherited DBs',()=>{const child=childEnvironment({PATH:'/bin',HOME:'/tmp/fixture',GH_TOKEN:'private',DATABASE_URL:'private',MIGRATION_DATABASE_URL:'private',OPENROUTER_API_KEY:'private',WORKOS_API_KEY:'private',AUTH_PROVIDER:'internal',NEXT_PUBLIC_AUTH_PROVIDER:'keycloak',AI_CONFIG_SECRET:'private'},{DATABASE_URL:'postgres://fictional@127.0.0.1:5433/new_fixture'});assert.equal(child.PATH,'/bin');assert.equal(child.DATABASE_URL,'postgres://fictional@127.0.0.1:5433/new_fixture');for(const key of ['GH_TOKEN','MIGRATION_DATABASE_URL','OPENROUTER_API_KEY','WORKOS_API_KEY','AUTH_PROVIDER','NEXT_PUBLIC_AUTH_PROVIDER','AI_CONFIG_SECRET'])assert.equal(child[key],undefined);});
test('all20 nonempty native prerequisite reports required, metadata-only or borrowed actor refuses',()=>{assert.equal(MODULES.length,20);assert.equal(new Set(MODULES).size,20);assert.doesNotThrow(()=>validateFixture(packet()));for(const mutate of [p=>p.finalNativePrerequisites[0].modules.pop(),p=>p.finalNativePrerequisites[0].modules[0].cases=[],p=>p.finalNativePrerequisites[0].modules[0].nativeEvidence='empty',p=>p.finalNativePrerequisites[0].modules[0].securityFailures=1,p=>p.finalNativePrerequisites[0].userId=p.actors.self.userId,p=>p.expectedNative.selfLeaveRequests=1,p=>p.limits.providerCapability='PASS',p=>p.limits.notificationEmailConsent='verified',p=>p.actors.reviewers.pop()]){const p=packet();mutate(p);assert.throws(()=>validateFixture(p));}});
test('smoke report cannot certify experience, provider identity or release',()=>{const report=publicReport('a'.repeat(40));report.state='smoke_passed_incomplete_experience';report.checks.push({workspace:'rendered'});assert.equal(report.releaseEligible,false);assert.equal(report.experienceComplete,false);assert.match(report.authentication,/not_production/);assert.match(report.notificationIdentity,/excluded/);assert.deepEqual(report.remaining,[...REMAINING]);assert(report.remaining.some(x=>x.includes('confirm')));assert(report.remaining.some(x=>x.includes('cross-person')));});
test('process cleanup excludes only inspector and retains real same-session descendants',()=>{assert.deepEqual(parseOwnedGroupSnapshot('100 100 100\n101 100 100\n102 100 100\n200 200 200\n',102,100),[100,101]);assert.deepEqual(parseOwnedGroupSnapshot('102 100 100\n200 200 200\n',102,100),[]);for(const text of ['', 'unknown', '100 100 999', '100 0 100'])assert.throws(()=>parseOwnedGroupSnapshot(text,102,100));assert.throws(()=>parseOwnedGroupSnapshot('100 100 100',undefined,100));});

test('private readback response envelopes refuse wrong phase sequence, unknown fields and oversize',()=>{
 assert.equal(parseNativeReadbackResponse('{"sequence":0,"ok":true,"ready":true}',0,'ready'),true);
 assert.deepEqual(parseNativeReadbackResponse('{"sequence":1,"ok":true,"value":{"counts":{}}}',1,'verify'),{counts:{}});
 for(const [value,sequence,operation] of [[{sequence:2,ok:true,value:{}},1,'verify'],[{sequence:1,ok:false},1,'verify'],[{sequence:1,ok:true,value:{},key:'private'},1,'verify'],[{sequence:0,ok:true,ready:true},1,'verify'],[{sequence:6,ok:true,finished:false},6,'finish']])assert.throws(()=>parseNativeReadbackResponse(JSON.stringify(value),sequence,operation));
 assert.throws(()=>parseNativeReadbackResponse(' '.repeat(131073),1,'verify'));
});
test('one private bootstrap creates one persistent canonical verifier with absolute imports and readback only',()=>{
 const source=nativeReadbackBootstrap('/fictional/source','/fictional/private/fixture.json');
 assert(source.includes('from "/fictional/source/db/client.ts"'));assert(source.includes('from "/fictional/source/scripts/fixtures/ai-delivery-own-leave-native-readback.ts"'));
 assert.equal(source.split('await createAiDeliveryOwnLeaveNativeReadback(').length-1,1);assert(source.includes('await verify(p.invocation)'));assert(source.includes("calls!==5"));assert(source.includes("process.stdout.write(text+'\\n'"));
 for(const disallowed of ['file://','import.meta','populateAiDeliveryFullFixture','db:migrate','INSERT INTO','UPDATE public','createAiDeliveryOwnLeaveNativeReadback(p.'])assert(!source.includes(disallowed));
});
function fakeReadbackChild(){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.exitCode=null;child.signalCode=null;return child;}
test('private transport retains a single sequential stream, enforces correspondence and confirms clean finish',async()=>{
 const child=fakeReadbackChild(),client=createPrivateNativeReadbackClient(child,{timeoutMs:1000});let requestBuffer='';const observed=[];
 child.stdin.on('data',chunk=>{requestBuffer+=chunk.toString();for(let i;(i=requestBuffer.indexOf('\n'))>=0;){const line=requestBuffer.slice(0,i);requestBuffer=requestBuffer.slice(i+1);const p=JSON.parse(line);observed.push(p);child.stdout.write(JSON.stringify(p.operation==='finish'?{sequence:p.sequence,ok:true,finished:true}:{sequence:p.sequence,ok:true,value:{phase:p.invocation.phase}})+'\n');}});
 child.stdout.write('{"sequence":0,"ok":true,"ready":true}\n');
 for(const phase of ['baseline','prepared','submitted','reopened','reopened_again'])assert.deepEqual(await client.verifyCanonical({phase}),{phase});
 await client.finish();const ended=new Promise(resolve=>child.stdout.once('end',resolve));child.stdout.end();await ended;child.exitCode=0;child.emit('exit',0,null);client.assertClosed();
 assert.deepEqual(observed.map(p=>p.sequence),[1,2,3,4,5,6]);assert.deepEqual(Object.keys(observed[5]).sort(),['operation','sequence']);
});
test('abort and malformed/unsolicited private replies cannot produce a verification fact',async()=>{
 const child=fakeReadbackChild(),abort=new AbortController(),client=createPrivateNativeReadbackClient(child,{signal:abort.signal,timeoutMs:1000});child.stdout.write('{"sequence":0,"ok":true,"ready":true}\n');const pending=client.verifyCanonical({phase:'baseline'});abort.abort();await assert.rejects(pending);assert.throws(()=>client.assertClosed());
 const other=fakeReadbackChild(),otherClient=createPrivateNativeReadbackClient(other,{timeoutMs:1000});other.stdout.write('{"sequence":0,"ok":true,"ready":true}\n');const request=otherClient.verifyCanonical({phase:'baseline'});await Promise.resolve();other.stdout.write('{"sequence":99,"ok":true,"value":{}}\n');await assert.rejects(request);assert.throws(()=>otherClient.assertClosed());
});

test('exact Docker absence is distinct from daemon, permissions, signals and unknown cleanup',()=>{
 const name='aihr-ci-123-1-db-0123456789abcdef';
 const absent={status:1,signal:null,stdout:'[]\n',stderr:'Error: No such object: '+name+'\n'};
 assert.equal(confirmedContainerAbsent(absent,name),true);
 assert.equal(confirmedContainerAbsent({...absent,stdout:'',stderr:'Error response from daemon: No such container: '+name},name),true);
 for(const patch of [{status:0},{status:null},{signal:'SIGTERM'},{error:new Error('timeout')},{stdout:'unparsed response'},{stderr:'Cannot connect to the Docker daemon'},{stderr:'permission denied'},{stderr:''},{stderr:'Error: No such object: aihr-ci-999-1-db-0123456789abcdef'},{stderr:'daemon unavailable\nError: No such object: '+name}])assert.equal(confirmedContainerAbsent({...absent,...patch},name),false);
 assert.equal(confirmedContainerAbsent(absent,'arbitrary container'),false);
});
test('both generated TS bootstrap variants parse with real statement separators and absolute imports',()=>{
 const require=createRequire(join(process.cwd(),'package.json')),ts=require('typescript');
 for(const root of ['/fictional/source',"/fictional/source with space's"]){
  const fixture=join(root,'private','fixture.json');
  for(const [name,text] of [['prepare',buildFixtureBootstrap(root,fixture,'aihr_assistant_browser_0123456789abcdef')],['readback',nativeReadbackBootstrap(root,fixture)]]){
   const parsed=ts.createSourceFile(name+'.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
   assert.deepEqual(parsed.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')),[]);
   assert(text.includes(";\nimport "));assert(!text.includes(';\\nimport '));assert(!text.includes('file://'));assert(!text.includes('import.meta'));
   for(const statement of parsed.statements){if(ts.isImportDeclaration(statement))assert(statement.moduleSpecifier.text.startsWith('/')||statement.moduleSpecifier.text.startsWith('node:'));assert(!(ts.isExpressionStatement(statement)&&ts.isAwaitExpression(statement.expression)));}
  }
 }
});
