/** Controller contracts only, never native/business/browser evidence. Generated-TS syntax uses the candidate TypeScript installed by setup-alpha. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFileSync} from 'node:fs';
import {nativeReadbackSpecification,closedDatabaseIdentifier,freshDatabaseBootstrapSql,fixturePreparationPlan,buildFixtureBootstrap,confirmedContainerAbsent,parseNativeReadbackResponse,nativeReadbackBootstrap,createPrivateNativeReadbackClient,MODULES,REMAINING,unitFor,childEnvironment,validateFixture,publicReport,parseOwnedGroupSnapshot} from './assistant-development-browser.mjs';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function packet(){const actors=Array.from({length:6},(_,n)=>({userId:id(n+1),personId:id(n+11),employmentId:id(n+21)}));return {format:1,state:'native_prerequisites_prepared_not_experienced',actors:{operator:actors[0],self:actors[1],reviewers:[actors[2],actors[3]],peer:actors[4],manager:actors[5]},finalNativePrerequisites:[0,2,3].map(n=>({userId:actors[n].userId,modules:MODULES.map(module=>({module,state:'complete',nativeEvidence:'present',qualityFailures:0,securityFailures:0,cases:[{id:module+':nonempty-business-evidence',category:'native',passed:true}]}))})),expectedNative:{selfLeaveRequests:0,selfProfileRequests:0,closeTargetStatus:'processed'},limits:{uiTargetEffects:'not_executed',providerCapability:'UNVERIFIED_NO_CALLS',notificationEmailConsent:'UNAVAILABLE_REQUIRES_ACTUAL_VERIFIED_PROVIDER_IDENTITY',releaseGate:'NOT_RUN'}};}
test('exact candidate/run/attempt own distinct finite container keys',()=>{const sha='a'.repeat(40);assert.match(unitFor('12','1',sha),/^db-[a-f0-9]{16}$/);assert.notEqual(unitFor('12','1',sha),unitFor('12','2',sha));assert.notEqual(unitFor('12','1',sha),unitFor('12','1','b'.repeat(40)));for(const args of [['x','1',sha],['1','0x1',sha],['1','1','main']])assert.throws(()=>unitFor(...args));});
test('child environment omits production secrets, provider/auth credentials and inherited DBs',()=>{const child=childEnvironment({PATH:'/bin',HOME:'/tmp/fixture',GH_TOKEN:'private',DATABASE_URL:'private',MIGRATION_DATABASE_URL:'private',OPENROUTER_API_KEY:'private',WORKOS_API_KEY:'private',AUTH_PROVIDER:'internal',NEXT_PUBLIC_AUTH_PROVIDER:'keycloak',AI_CONFIG_SECRET:'private'},{DATABASE_URL:'postgres://fictional@127.0.0.1:5433/new_fixture'});assert.equal(child.PATH,'/bin');assert.equal(child.DATABASE_URL,'postgres://fictional@127.0.0.1:5433/new_fixture');for(const key of ['GH_TOKEN','MIGRATION_DATABASE_URL','OPENROUTER_API_KEY','WORKOS_API_KEY','AUTH_PROVIDER','NEXT_PUBLIC_AUTH_PROVIDER','AI_CONFIG_SECRET'])assert.equal(child[key],undefined);});
test('all20 nonempty native prerequisite reports required, metadata-only or borrowed actor refuses',()=>{assert.equal(MODULES.length,20);assert.equal(new Set(MODULES).size,20);assert.doesNotThrow(()=>validateFixture(packet()));for(const mutate of [p=>p.finalNativePrerequisites[0].modules.pop(),p=>p.finalNativePrerequisites[0].modules[0].cases=[],p=>p.finalNativePrerequisites[0].modules[0].nativeEvidence='empty',p=>p.finalNativePrerequisites[0].modules[0].securityFailures=1,p=>p.finalNativePrerequisites[0].userId=p.actors.self.userId,p=>p.expectedNative.selfLeaveRequests=1,p=>p.limits.providerCapability='PASS',p=>p.limits.notificationEmailConsent='verified',p=>p.actors.reviewers.pop()]){const p=packet();mutate(p);assert.throws(()=>validateFixture(p));}});
test('smoke report cannot certify experience, provider identity or release',()=>{const report=publicReport('a'.repeat(40));report.state='smoke_passed_incomplete_experience';report.checks.push({workspace:'rendered'});assert.equal(report.releaseEligible,false);assert.equal(report.experienceComplete,false);assert.match(report.authentication,/not_production/);assert.match(report.notificationIdentity,/excluded/);assert.deepEqual(report.remaining,[...REMAINING]);assert(report.remaining.some(x=>x.includes('confirm')));assert(report.remaining.some(x=>x.includes('cross-person')));});
test('process cleanup excludes only inspector and retains real same-session descendants',()=>{assert.deepEqual(parseOwnedGroupSnapshot('100 100 100\n101 100 100\n102 100 100\n200 200 200\n',102,100),[100,101]);assert.deepEqual(parseOwnedGroupSnapshot('102 100 100\n200 200 200\n',102,100),[]);for(const text of ['', 'unknown', '100 100 999', '100 0 100'])assert.throws(()=>parseOwnedGroupSnapshot(text,102,100));assert.throws(()=>parseOwnedGroupSnapshot('100 100 100',undefined,100));});

test('private readback envelopes bind kind, sequence and closed fields',()=>{
 for(const kind of ['own_leave','profile','provider_config']){
  assert.equal(parseNativeReadbackResponse(JSON.stringify({kind,sequence:0,ok:true,ready:true}),0,'ready',kind),true);
  assert.deepEqual(parseNativeReadbackResponse(JSON.stringify({kind,sequence:1,ok:true,value:{counts:{}}}),1,'verify',kind),{counts:{}});
 }
 for(const patch of [{kind:'profile'},{sequence:2},{ok:false},{key:'private'}])assert.throws(()=>parseNativeReadbackResponse(JSON.stringify({kind:'own_leave',sequence:1,ok:true,value:{},...patch}),1,'verify','own_leave'));
 assert.throws(()=>parseNativeReadbackResponse(' '.repeat(131073),1,'verify'));assert.throws(()=>parseNativeReadbackResponse('{"sequence":0,"ok":true,"ready":true}',0,'ready'));
});
test('three closed native imports have exact5/5/4 phases and no caller-controlled factory input',()=>{
 const expected={own_leave:['ai-delivery-own-leave-native-readback.ts',5],profile:['ai-delivery-profile-native-readback.ts',5],provider_config:['ai-delivery-provider-config-native-readback.ts',4]};
 for(const [kind,[name,count]] of Object.entries(expected)){
  const spec=nativeReadbackSpecification(kind),source=nativeReadbackBootstrap('/fictional/source','/fictional/private/fixture.json',kind);
  assert.equal(spec.phases.length,count);assert(Object.isFrozen(spec)&&Object.isFrozen(spec.phases));assert(source.includes('from "/fictional/source/scripts/fixtures/'+name+'"'));
  assert.equal(source.split('await createNativeReadback(').length-1,1);assert(source.includes('await verify(p.invocation)'));assert(source.includes('calls!=='+count));assert(source.includes('sequence>'+String(count+1)));
  assert(source.includes("process.stdout.write(text+'\\n'"));for(const bad of ['file://','import.meta','populateAiDeliveryFullFixture','db:migrate','INSERT INTO','UPDATE public'])assert(!source.includes(bad));
  if(kind==='provider_config'){assert(source.includes('expected:{"model":"fictional/assistant-browser-inactive"'));assert(!source.includes('MIGRATION_DATABASE_URL'));assert(!source.includes('createDb'));assert(!source.includes('p.expected'));}
 }
 for(const kind of ['__proto__','unknown','../../source.ts','https://invalid.example',null,3])assert.throws(()=>nativeReadbackBootstrap('/fictional','/fixture',kind));
 assert.throws(()=>nativeReadbackBootstrap('/fictional','/fixture','own_leave',99));
});
function fakeReadbackChild(){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.exitCode=null;child.signalCode=null;return child;}
test('one persistent transport per kind requires ordered phases and exact finish before closure',async()=>{
 for(const kind of ['own_leave','profile','provider_config']){
  const child=fakeReadbackChild(),client=createPrivateNativeReadbackClient(child,{kind,timeoutMs:1000});let requestBuffer='';const observed=[];
  child.stdin.on('data',chunk=>{requestBuffer+=chunk.toString();for(let i;(i=requestBuffer.indexOf('\n'))>=0;){const p=JSON.parse(requestBuffer.slice(0,i));requestBuffer=requestBuffer.slice(i+1);observed.push(p);child.stdout.write(JSON.stringify(p.operation==='finish'?{kind,sequence:p.sequence,ok:true,finished:true}:{kind,sequence:p.sequence,ok:true,value:{phase:p.invocation.phase}})+'\n');}});
  child.stdout.write(JSON.stringify({kind,sequence:0,ok:true,ready:true})+'\n');await assert.rejects(client.finish());await assert.rejects(client.verifyCanonical({phase:'reopened_again'}));
  if(kind==='provider_config')await assert.rejects(client.verifyCanonical({phase:'baseline',expected:{key:'not_allowed'}}));
  for(const phase of nativeReadbackSpecification(kind).phases)assert.deepEqual(await client.verifyCanonical({phase}),{phase});
  await client.finish();assert.throws(()=>client.assertClosed(),'finish response alone is not process closure');const ended=new Promise(resolve=>child.stdout.once('end',resolve));child.stdout.end();await ended;child.exitCode=0;assert.throws(()=>client.assertClosed(),'EOF and assigned exitCode do not replace observed exit0');child.emit('exit',0,null);client.assertClosed();
  assert.deepEqual(observed.map(p=>p.sequence),Array.from({length:nativeReadbackSpecification(kind).phases.length+1},(_,i)=>i+1));assert(observed.every(p=>p.kind===kind));assert.deepEqual(Object.keys(observed.at(-1)).sort(),['kind','operation','sequence']);
 }
 assert.throws(()=>createPrivateNativeReadbackClient(fakeReadbackChild(),{kind:'own_leave',count:99}));
});
test('abort and mismatched kind/sequence cannot return private native facts',async()=>{
 const child=fakeReadbackChild(),abort=new AbortController(),client=createPrivateNativeReadbackClient(child,{signal:abort.signal,timeoutMs:1000});child.stdout.write('{"kind":"own_leave","sequence":0,"ok":true,"ready":true}\n');const pending=client.verifyCanonical({phase:'baseline'});abort.abort();await assert.rejects(pending);assert.throws(()=>client.assertClosed());
 const other=fakeReadbackChild(),otherClient=createPrivateNativeReadbackClient(other,{timeoutMs:1000});other.stdout.write('{"kind":"own_leave","sequence":0,"ok":true,"ready":true}\n');const request=otherClient.verifyCanonical({phase:'baseline'});await Promise.resolve();other.stdout.write('{"kind":"profile","sequence":1,"ok":true,"value":{}}\n');await assert.rejects(request);assert.throws(()=>otherClient.assertClosed());
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
  for(const [name,text] of [['prepare',buildFixtureBootstrap(root,fixture,'aihr_assistant_browser_0123456789abcdef')],...['own_leave','profile','provider_config'].map(kind=>[kind,nativeReadbackBootstrap(root,fixture,kind)])]){
   const parsed=ts.createSourceFile(name+'.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
   assert.deepEqual(parsed.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')),[]);
   assert(text.includes(";\nimport "));assert(!text.includes(';\\nimport '));assert(!text.includes('file://'));assert(!text.includes('import.meta'));
   for(const statement of parsed.statements){if(ts.isImportDeclaration(statement))assert(statement.moduleSpecifier.text.startsWith('/')||statement.moduleSpecifier.text.startsWith('node:'));assert(!(ts.isExpressionStatement(statement)&&ts.isAwaitExpression(statement.expression)));}
   const frameWrites=[];function inspect(node){if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='write'&&node.expression.expression.getText(parsed)==='process.stdout')frameWrites.push(node.arguments[0]);ts.forEachChild(node,inspect);}inspect(parsed);
   assert.equal(frameWrites.length,name==='prepare'?0:1);
   for(const frame of frameWrites){assert(ts.isBinaryExpression(frame)&&frame.operatorToken.kind===ts.SyntaxKind.PlusToken&&ts.isStringLiteral(frame.right));assert.deepEqual([...frame.right.text].map(character=>character.codePointAt(0)),[10],'RPC delimiter must be actual LF, never literal backslash+n');}

  }
 }
});

test('fresh fictional setup applies normal ACL BEFORE migrate and canonical catalog CLI before fixture',()=>{
 const database='aihr_assistant_browser_0123456789abcdef',container='aihr-ci-123-1-db-0123456789abcdef';
 const plan=fixturePreparationPlan('/fictional/source','file:///fictional/source/node_modules/tsx/dist/loader.mjs','/fictional/private/prepare.ts',database,container);
 assert.deepEqual(plan.map(stage=>stage.label),['bootstrap-normal-app-acl','migration','seed-native-catalogs','fixture']);
 assert.equal(plan[0].command,'docker');assert.deepEqual(plan[0].args.slice(0,-1),['exec',container,'psql','-h','127.0.0.1','-U','postgres','-p','5433','-v','ON_ERROR_STOP=1','-d',database,'-c']);assert.equal(plan[0].args.at(-1),freshDatabaseBootstrapSql(database));
 assert.equal(plan[1].command,'pnpm');assert.deepEqual(plan[1].args,['db:migrate']);
 assert.equal(plan[2].command,process.execPath);assert.deepEqual(plan[2].args,['--import','file:///fictional/source/node_modules/tsx/dist/loader.mjs','/fictional/source/scripts/seed-catalogs.ts']);
 assert.equal(plan[3].command,process.execPath);assert.deepEqual(plan[3].args,['--import','file:///fictional/source/node_modules/tsx/dist/loader.mjs','/fictional/private/prepare.ts']);
 assert(Object.isFrozen(plan)&&plan.every(stage=>Object.isFrozen(stage)&&Object.isFrozen(stage.args)));assert(plan.every(stage=>Number.isSafeInteger(stage.timeout)&&stage.timeout>0));
 assert(!JSON.stringify(plan).includes('seed:catalogs'));assert(!JSON.stringify(plan).includes('db/seed.ts'));assert(!JSON.stringify(plan).includes('reset'));
 assert.throws(()=>fixturePreparationPlan('/fictional','tsx','/prepare.ts',database,'aihr-ci-123-1-db-ffffffffffffffff'));
});
test('normal bootstrap SQL is only fresh target/actual owner/restricted app ACL and keeps migration revokes authoritative',()=>{
 const database='aihr_assistant_browser_0123456789abcdef',sql=freshDatabaseBootstrapSql(database);
 assert.equal(closedDatabaseIdentifier(database),'"'+database+'"');
 assert(sql.startsWith('BEGIN;\n'));assert(sql.endsWith('COMMIT;\n'));
 assert(sql.includes("current_user <> 'postgres'"));assert(sql.includes("current_database() <> '"+database+"'"));assert(sql.includes('datdba=current_user::regrole'));assert(sql.includes('inet_server_port() IS DISTINCT FROM 5433'));
 assert(sql.includes("rolname='ai_hr_app' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication"));assert(sql.includes('FROM pg_class'));assert(sql.includes('FROM pg_proc'));
 assert(sql.includes('GRANT CONNECT ON DATABASE "'+database+'" TO ai_hr_app;'));assert(sql.includes('GRANT USAGE ON SCHEMA public TO ai_hr_app;'));
 assert(sql.includes('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app;'));
 assert(sql.includes('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app;'));
 assert(!/GRANT\s+ALL|GRANT\s+CREATE|CREATE\s+ROLE|ALTER\s+ROLE|PASSWORD|ALL TABLES/i.test(sql));
 for(const name of ['ai_hr_dev','postgres','AIHR_ASSISTANT_BROWSER_0123456789abcdef',database+'; DROP DATABASE postgres','"'+database+'"']){assert.throws(()=>freshDatabaseBootstrapSql(name));assert.throws(()=>closedDatabaseIdentifier(name));}
 const fixture=buildFixtureBootstrap('/fictional/source','/fictional/private/fixture.json',database);
 assert(fixture.includes("has_column_privilege('ai_hr_app','public.ai_provider_config','api_key_ciphertext','SELECT')"));assert(fixture.includes('acl.ciphertext!==false||acl.metadata!==true'));assert(!/GRANT\s+ALL|GRANT\s+SELECT/i.test(fixture));
});

/** Authored source-only controls below are UNRUN, not browser/native acceptance. */
function importReadyInput(mode){const human={employeeCode:'AI-IMPORT-NEW',fullName:'Fictional Imported Human',email:'fictional-import@example.test',department:'Fictional fixture department',employmentType:'full_time',basicSalary:'3000.00',hiredOn:'2027-02-15'};return{sourceMode:mode,pastedText:'Employee ID,Full Name,Personal Email,Join Date,Unresolved Heading\nAI-IMPORT-NEW,Fictional Imported Human,fictional-import@example.test,,human must map or exclude\n',human,expected:{userId:id(1),companyId:id(99),sourceMode:mode,human:{...human}}};}
test('closed source modes preserve primary unit and give every fresh job a distinct database',async()=>{
 const {BROWSER_JOURNEYS,closedBrowserJourney,unitForJourney}=await import('./assistant-development-browser.mjs'),sha='a'.repeat(40);
 assert.deepEqual(BROWSER_JOURNEYS,['primary','employee_import_paste','employee_import_csv','employee_import_xlsx','specialist_governance','ai_controls','own_leave_retirement']);assert(Object.isFrozen(BROWSER_JOURNEYS));
 const units=BROWSER_JOURNEYS.map(kind=>unitForJourney('12','1',sha,kind));assert.equal(units[0],unitFor('12','1',sha));assert.equal(new Set(units).size,7);assert(units.every(unit=>/^db-[a-f0-9]{16}$/.test(unit)));
 for(const kind of ['employee_import','employee_import_xls','paste','../../source.ts','https://invalid.example',undefined,'__proto__']){assert.throws(()=>closedBrowserJourney(kind));assert.throws(()=>unitForJourney('12','1',sha,kind));}
});
test('three fixed import factories require six phases and never accept generated SQL or human args',()=>{
 for(const mode of ['paste','csv','xlsx']){
  const kind='employee_import_'+mode,spec=nativeReadbackSpecification(kind),source=nativeReadbackBootstrap('/fictional/source','/fictional/private/fixture.json',kind);
  assert.equal(spec.sourceMode,mode);assert.equal(spec.member,'createAiDeliveryEmployeeImportScenarioReadback');assert.equal(spec.module,'scripts/fixtures/ai-delivery-employee-import-native-readback.ts');assert.deepEqual(spec.phases,['baseline','unresolved','prepared','previewed','committed','reopened']);assert(Object.isFrozen(spec)&&Object.isFrozen(spec.phases));
  assert(source.includes('import {createAiDeliveryEmployeeImportScenarioReadback as createNativeReadback} from "/fictional/source/scripts/fixtures/ai-delivery-employee-import-native-readback.ts";'));assert(source.includes('await createNativeReadback({owner,fixture:packet.fixture,sourceMode:'+JSON.stringify(mode)+'})'));assert(source.includes('const verify=prepared.verifyCanonical;'));assert(source.includes('input:prepared.input'));assert(source.includes('calls!==6'));assert(source.includes('sequence>7'));
  for(const forbidden of ['SELECT ','INSERT ','UPDATE ','DELETE ','human:','apiKey','sourceMode:p.','from "https:','from "file:','module:p.','db/schema','ai-provider','provider_config'])assert(!source.includes(forbidden));
  assert.throws(()=>nativeReadbackBootstrap('/fictional/source','/fictional/private/fixture.json',kind,{human:importReadyInput(mode).human}));
 }
});
test('private import ready data is closed and bound to exact literals and matching source mode',()=>{
 for(const mode of ['paste','csv','xlsx']){const kind='employee_import_'+mode,input=importReadyInput(mode),packet={kind,sequence:0,ok:true,ready:true,input};assert.deepEqual(parseNativeReadbackResponse(JSON.stringify(packet),0,'ready',kind),input);
  for(const mutate of [p=>delete p.input,p=>p.input.key='private',p=>p.input.sourceMode='other',p=>p.input.human.basicSalary='3001',p=>p.input.human.country='MY',p=>p.input.human.hiredOn='tomorrow',p=>p.input.human.department='',p=>p.input.expected.human.department='different',p=>p.input.expected.key='private',p=>p.input.expected.sourceMode='other',p=>p.input.pastedText+='supplemented date']){const bad=structuredClone(packet);mutate(bad);assert.throws(()=>parseNativeReadbackResponse(JSON.stringify(bad),0,'ready',kind));}
  assert.throws(()=>parseNativeReadbackResponse(JSON.stringify({kind,sequence:0,ok:true,ready:true}),0,'ready',kind));
 }
 assert.throws(()=>parseNativeReadbackResponse(JSON.stringify({kind:'own_leave',sequence:0,ok:true,ready:true,input:importReadyInput('paste')}),0,'ready','own_leave'));
});
test('import transport requires private ready input, exact six phases, observed exit0 and clean EOF',async()=>{
 for(const mode of ['paste','csv','xlsx']){const kind='employee_import_'+mode,input=importReadyInput(mode),child=fakeReadbackChild(),client=createPrivateNativeReadbackClient(child,{kind,timeoutMs:1000});let buffer='';const observed=[];
  child.stdin.on('data',chunk=>{buffer+=chunk.toString();for(let i;(i=buffer.indexOf('\n'))>=0;){const p=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);observed.push(p);child.stdout.write(JSON.stringify(p.operation==='finish'?{kind,sequence:p.sequence,ok:true,finished:true}:{kind,sequence:p.sequence,ok:true,value:{phase:p.invocation.phase}})+'\n');}});
  child.stdout.write(JSON.stringify({kind,sequence:0,ok:true,ready:true,input})+'\n');const captured=await client.readyInput();assert.deepEqual(captured,input);captured.human.department='mutated';assert.equal((await client.readyInput()).human.department,input.human.department);
  await assert.rejects(client.finish());for(const bad of [{phase:'baseline',expected:input.expected,count:6},{phase:'baseline',expected:input.expected,human:input.human},{phase:'baseline',expected:input.expected,review:{}},{phase:'baseline',expected:input.expected,url:'https://invalid.example'},{phase:'prepared',expected:input.expected},{phase:'baseline',expected:{...input.expected,url:'https://invalid.example'}},{phase:'baseline',expected:{...input.expected,human:{...input.human,basicSalary:'9999'}}}])await assert.rejects(client.verifyCanonical(bad));
  for(const phase of nativeReadbackSpecification(kind).phases)assert.deepEqual(await client.verifyCanonical({phase,expected:input.expected}),{phase});await client.finish();assert.throws(()=>client.assertClosed());const ended=new Promise(resolve=>child.stdout.once('end',resolve));child.stdout.end();await ended;child.exitCode=0;assert.throws(()=>client.assertClosed());child.emit('exit',0,null);client.assertClosed();assert.equal(observed.length,7);assert(observed.every(p=>p.kind===kind));assert.deepEqual(observed.map(p=>p.sequence),[1,2,3,4,5,6,7]);
 }
});
test('import ready success never substitutes for a failed exit or malformed trailing EOF',async()=>{
 for(const failure of ['nonzero','signal','trailing']){const kind='employee_import_paste',child=fakeReadbackChild(),client=createPrivateNativeReadbackClient(child,{kind,timeoutMs:1000});child.stdout.write(JSON.stringify({kind,sequence:0,ok:true,ready:true,input:importReadyInput('paste')})+'\n');await client.readyInput();if(failure==='trailing'){child.stdout.write('incomplete');child.stdout.end();}else child.emit('exit',failure==='nonzero'?1:null,failure==='signal'?'SIGTERM':null);assert.throws(()=>client.assertClosed());}
});
test('source modes and primary generated TS remain syntactically closed without dynamic import paths',()=>{
 const require=createRequire(join(process.cwd(),'package.json')),ts=require('typescript');for(const mode of ['paste','csv','xlsx']){const source=nativeReadbackBootstrap("/fictional/source with space's",'/fictional/private/fixture.json','employee_import_'+mode),parsed=ts.createSourceFile(mode+'.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);assert.deepEqual(parsed.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')),[]);for(const statement of parsed.statements)if(ts.isImportDeclaration(statement)){assert(ts.isStringLiteral(statement.moduleSpecifier));assert(statement.moduleSpecifier.text.startsWith('/')||statement.moduleSpecifier.text.startsWith('node:'));}assert(source.includes("process.stdout.write(text+'\\n'"));assert(!source.includes(';\\nimport '));}
});

test('synthetic XLSX loader is one fixed module under the controller-verified SOURCE cwd',()=>{
 const source=readFileSync(new URL('./assistant-employee-import-experience.mjs',import.meta.url),'utf8'),controller=readFileSync(new URL('./assistant-development-browser.mjs',import.meta.url),'utf8');
 assert.equal(source.split("createRequire(resolve(process.cwd(),'package.json'))('xlsx')").length-1,1);assert(!source.includes("import('xlsx')"));assert(!source.includes('require(input'));assert(!source.includes('createRequire(input'));assert(!source.includes('process.env.NODE_PATH'));
 assert(controller.includes("assert.equal(sync('git',['rev-parse','HEAD']),sha)"));assert(controller.includes("assert.equal(sync('git',['status','--porcelain','--untracked-files=all']),'')"));assert(controller.indexOf("assert.equal(sync('git',['rev-parse','HEAD']),sha)")<controller.indexOf("await runNativeJourney(singleMode?selectedJourney:'provider_config',page)"));
});
test('proposed import jobs use three fresh isolated mode-bound targets and preserve explicit approval fence',()=>{
 const workflow=readFileSync(new URL('../workflows/ai-assistant-development-browser.yml',import.meta.url),'utf8'),controller=readFileSync(new URL('./assistant-development-browser.mjs',import.meta.url),'utf8');
 assert(workflow.includes('source_mode: [paste, csv, xlsx]'));assert(workflow.includes('fail-fast: false'));assert(workflow.includes('AIHR_CI_BROWSER_JOURNEY: employee_import_${{ matrix.source_mode }}'));assert(workflow.includes('assistant-development-import-${{ matrix.source_mode }}-smoke-not-release-evidence'));assert(workflow.includes('assistant-development-import-${{ matrix.source_mode }}/public/report.json'));assert(workflow.includes('assistant-development-import-${{ matrix.source_mode }}/private/cleanup-safe'));
 assert(workflow.includes('APPROVED_CONTROL_SHA: ${{ vars.AIHR_ASSISTANT_BROWSER_APPROVED_CONTROL_SHA }}'));assert(workflow.includes('test -n "$APPROVED_CONTROL_SHA"'));assert(workflow.includes('test "$APPROVED_CONTROL_SHA" = "$AIHR_CI_CONTROL_HEAD"'));assert(controller.includes('unitForJourney(process.env.GITHUB_RUN_ID,process.env.GITHUB_RUN_ATTEMPT,sha,selectedJourney)'));assert(controller.includes("report.requestedJourney=selectedJourney"));assert(controller.includes("report.databaseCleanup='confirmed_absent'"));assert.equal(publicReport('a'.repeat(40)).experienceComplete,false);assert.equal(publicReport('a'.repeat(40)).releaseEligible,false);
});


test('native specialist/control/retirement proposal units preserve closed RPC and independent cleanup',()=>{
 const expected={specialist_governance:['createAssistantSpecialistNativeReadback',121],ai_controls:['createAssistantAiControlsNativeReadback',11],own_leave_retirement:['createAiDeliveryOwnLeaveRetirementNativeReadback',5]};
 for(const[kind,[factory,count]]of Object.entries(expected)){const spec=nativeReadbackSpecification(kind),source=nativeReadbackBootstrap('/fictional/source','/fictional/private/fixture.json',kind);assert.equal(spec.phases.length,count);assert.equal(spec.controller,true);assert.equal(spec.rootArgument,true);assert(source.includes(factory));assert(source.includes('root:"/fictional/source",owner,fixture:packet.fixture'));assert(source.includes('calls!=='+count));assert(source.includes('client.end()'));}
 const workflow=readFileSync(new URL('../workflows/ai-assistant-development-browser.yml',import.meta.url),'utf8');assert(workflow.includes('journey: [specialist_governance, ai_controls, own_leave_retirement]'));assert(workflow.includes('AIHR_CI_BROWSER_JOURNEY: ${{ matrix.journey }}'));assert(workflow.includes('assistant-development-native-${{ matrix.journey }}/private/cleanup-safe'));assert(workflow.includes('assistant-development-native-${{ matrix.journey }}/public/report.json'));assert(workflow.includes('APPROVED_CONTROL_SHA: ${{ vars.AIHR_ASSISTANT_BROWSER_APPROVED_CONTROL_SHA }}'));
});
