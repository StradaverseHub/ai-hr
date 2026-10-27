/** SOURCE PROPOSAL. Fictional development smoke, never a release gate or authentication proof.
 * Import-safe pure contracts are tested separately; main alone owns disposable resources. */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,unlinkSync,readdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {runAssistantOwnLeaveEnglishExperience} from './assistant-own-leave-experience.mjs';
import {runAssistantEmployeeImportEnglishExperience} from './assistant-employee-import-experience.mjs';
import {runAssistantProfileEnglishExperience} from './assistant-profile-experience.mjs';
import {INACTIVE_PROVIDER_SELECTION,runAssistantProviderInactiveConfigEnglishExperience} from './assistant-provider-config-experience.mjs';
export const MODULES=Object.freeze(['employees','org','leave','ess','approvals','knowledge_base','payroll','attendance','claims','performance','rewards','lifecycle','toil','multi_cycle_payroll','typed_pay_components','country-my','notifications','system_explorer','assistant','system_testing']);
const HUMAN_ENTRY=Object.freeze({employees:'/admin/personnel/import',org:'/assistant/org',leave:'/assistant/leave',ess:'/assistant/profile',approvals:'/assistant/approvals',knowledge_base:'/assistant/knowledge-base',payroll:'/assistant/payroll-close',attendance:'/assistant/attendance',claims:'/assistant/claims',performance:'/assistant/performance',rewards:'/assistant/rewards',lifecycle:'/assistant/lifecycle',toil:'/assistant/toil',multi_cycle_payroll:'/assistant/payroll-runs',typed_pay_components:'/assistant/pay-codes','country-my':'/assistant/statutory',notifications:'/assistant/notifications',system_testing:'/assistant/testing'});
export const REMAINING=Object.freeze(['remaining specialist/action prepare/review/confirm journeys beyond the primary English own-leave, ESS profile request and inactive provider-configuration positives','expiry/discard/uncertain-response replay and erasure','cross-person/company/tenant denial and revocation interleavings','governed independent evaluation/promotion/rollback and actual provider capability/cost/latency','employee import source modes not exercised by this job and real user dataset baseline comparison','internal HTTPS login/MFA and actual verified notification identity/consent','locale switch interaction/accessibility and full desktop/mobile action journeys','combined exact-candidate final gate and deployment arrival']);
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function unitFor(run,attempt,sha){assert(/^\d+$/.test(run)&&/^\d+$/.test(attempt)&&/^[0-9a-f]{40}$/.test(sha));return 'db-'+createHash('sha256').update([run,attempt,sha,'assistant-development-v1'].join(':')).digest('hex').slice(0,16);}
export const BROWSER_JOURNEYS=Object.freeze(['primary','employee_import_paste','employee_import_csv','employee_import_xlsx']);
export function closedBrowserJourney(value){assert(typeof value==='string'&&BROWSER_JOURNEYS.includes(value),'Unknown closed browser journey');return value;}
/** Existing primary unit stays byte-for-byte compatible; each import mode owns a distinct target. */
export function unitForJourney(run,attempt,sha,journey){closedBrowserJourney(journey);const primary=unitFor(run,attempt,sha);return journey==='primary'?primary:'db-'+createHash('sha256').update([run,attempt,sha,'assistant-development-v1',journey].join(':')).digest('hex').slice(0,16);}
export function childEnvironment(input,add={}){
 const env={};for(const key of ['PATH','HOME','TMPDIR','LANG','RUNNER_TEMP','CI','GITHUB_ACTIONS','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])if(input[key])env[key]=input[key];
 return {...env,TZ:'Asia/Kuala_Lumpur',NEXT_TELEMETRY_DISABLED:'1',...add};
}
export function validateFixture(f){
 assert.equal(f?.format,1);assert.equal(f.state,'native_prerequisites_prepared_not_experienced');
 const actors=[f.actors?.operator,f.actors?.self,...(f.actors?.reviewers??[]),f.actors?.peer,f.actors?.manager];assert.equal(actors.length,6);
 for(const a of actors)assert(UUID.test(a?.userId)&&UUID.test(a?.personId)&&UUID.test(a?.employmentId));assert.equal(new Set(actors.map(a=>a.userId)).size,6);
 assert.equal(f.finalNativePrerequisites?.length,3);
 assert.deepEqual(f.finalNativePrerequisites.map(x=>x.userId).sort(),[actors[0].userId,actors[2].userId,actors[3].userId].sort());
 for(const proof of f.finalNativePrerequisites){assert.deepEqual(proof.modules.map(x=>x.module).sort(),[...MODULES].sort());for(const m of proof.modules){assert.equal(m.state,'complete');assert.equal(m.nativeEvidence,'present');assert.equal(m.qualityFailures,0);assert.equal(m.securityFailures,0);assert(m.cases?.length&&m.cases.every(c=>c.passed===true));assert(m.cases.some(c=>c.id===m.module+':nonempty-business-evidence'&&c.category==='native'));}}
 assert.equal(f.expectedNative?.selfLeaveRequests,0);assert.equal(f.expectedNative?.selfProfileRequests,0);assert.equal(f.expectedNative?.closeTargetStatus,'processed');
 assert.equal(f.limits?.uiTargetEffects,'not_executed');assert.equal(f.limits?.providerCapability,'UNVERIFIED_NO_CALLS');assert.equal(f.limits?.notificationEmailConsent,'UNAVAILABLE_REQUIRES_ACTUAL_VERIFIED_PROVIDER_IDENTITY');
 assert.equal(f.limits?.releaseGate,'NOT_RUN');return f;
}
export function publicReport(sha){return {format:1,candidate:sha,kind:'assistant_development_browser_smoke',state:'incomplete',experienceComplete:false,releaseEligible:false,authentication:'gated_demo_switcher_not_production_identity',provider:'UNVERIFIED_NO_LIVE_PROVIDER_CALLS_AUTHORIZED',notificationIdentity:'excluded_requires_separate_internal_HTTPS',remaining:[...REMAINING],checks:[],errorCounts:{page:0,console:0,server:0,external:0},failure:null};}
/** Unknown/malformed snapshots cannot establish cleanup. Only the observed inspector is excluded. */
export function parseOwnedGroupSnapshot(text,inspectorPid,group){
 assert(Number.isSafeInteger(inspectorPid)&&inspectorPid>1&&Number.isSafeInteger(group)&&group>1);assert(typeof text==='string'&&text.trim());
 const result=[];for(const line of text.trim().split('\n')){const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);assert(match,'Unknown process snapshot');const [pid,pgid,sid]=match.slice(1).map(Number);assert([pid,pgid,sid].every(n=>Number.isSafeInteger(n)&&n>0));if(pgid===group&&pid!==inspectorPid){assert.equal(sid,group,'Owned group identity changed');result.push(pid);}}return result;
}
/** Only this generated fictional target is an SQL identifier; arbitrary names are refused. */
export function closedDatabaseIdentifier(database){assert(/^aihr_assistant_browser_[a-f0-9]{16}$/.test(database));return '"'+database+'"';}
/** deploy/bootstrap-db.sql normal app ACL subset, BEFORE migrations and their deliberate REVOKEs.
 * postgres is the verified actual migration/database owner of this maintained disposable container.
 * No app CREATE, role/password changes, table GRANT ALL, or existing-runtime repair. */
export function freshDatabaseBootstrapSql(database){
 const identifier=closedDatabaseIdentifier(database);
 return `BEGIN;
DO $bootstrap$
BEGIN
 IF current_user <> 'postgres' OR current_database() <> '${database}'
  OR inet_server_port() IS DISTINCT FROM 5433 OR coalesce(host(inet_server_addr()),'') NOT IN ('127.0.0.1','::1')
  OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=current_user::regrole)
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_app' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
 THEN RAISE EXCEPTION 'Fresh fictional database bootstrap refused'; END IF;
END $bootstrap$;
GRANT CONNECT ON DATABASE ${identifier} TO ai_hr_app;
GRANT USAGE ON SCHEMA public TO ai_hr_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app;
COMMIT;
`;
}
/** Normal fresh setup order is executable code, never a metadata-only attestation. */
export function fixturePreparationPlan(root,tsx,bootstrap,database,container){
 const sql=freshDatabaseBootstrapSql(database);assert(/^aihr-ci-\d+-\d+-db-[a-f0-9]{16}$/.test(container));assert(container.endsWith('db-'+database.slice('aihr_assistant_browser_'.length)));
 return Object.freeze([
  {label:'bootstrap-normal-app-acl',command:'docker',args:['exec',container,'psql','-h','127.0.0.1','-U','postgres','-p','5433','-v','ON_ERROR_STOP=1','-d',database,'-c',sql],timeout:120000},
  {label:'migration',command:'pnpm',args:['db:migrate'],timeout:900000},
  {label:'seed-native-catalogs',command:process.execPath,args:['--import',tsx,join(root,'scripts/seed-catalogs.ts')],timeout:120000},
  {label:'fixture',command:process.execPath,args:['--import',tsx,bootstrap],timeout:1200000},
 ].map(stage=>Object.freeze({...stage,args:Object.freeze(stage.args)})));
}
/** Exact absence only. A failed Docker daemon/permission/timeout is never cleanup proof. */
export function confirmedContainerAbsent(result,container){
 if(!/^aihr-ci-\d+-\d+-db-[a-f0-9]{16}$/.test(container)||!result||result.error||result.signal!=null||result.status!==1||typeof result.stderr!=='string'||typeof result.stdout!=='string')return false;
 if(!['','[]'].includes(result.stdout.trim()))return false;
 const expected=new RegExp('^(?:Error:\\s+|Error response from daemon:\\s+)?No such (?:object|container):\\s+'+container+'$','i');
 return expected.test(result.stderr.trim());
}
/** Real statement separators live in this template; JSON quoting applies only to data/import paths. */
export function buildFixtureBootstrap(root,fixturePath,database){
 assert(/^aihr_assistant_browser_[a-f0-9]{16}$/.test(database));
 return `import {writeFileSync} from 'node:fs';
import {createDb,client} from ${JSON.stringify(join(root,'db/client.ts'))};
import {MODULE_AGENT_ACTIONS} from ${JSON.stringify(join(root,'lib/ai/module-agent-actions.ts'))};
import {populateAiDeliveryFullFixture} from ${JSON.stringify(join(root,'scripts/fixtures/ai-delivery-full-fixture.ts'))};
async function prepare(){
 const owner=createDb(process.env.MIGRATION_DATABASE_URL!,{max:1});
 try{
  for(const [pool,role,superuser] of [[owner.client,'postgres',true],[client,'ai_hr_app',false]] as const){
   const [p]=await pool.unsafe("select current_user as role,current_database() as db,inet_server_port() as port,host(inet_server_addr()) as address,rolsuper or rolbypassrls as privileged from pg_roles where rolname=current_user");
   if(p.role!==role||p.db!==${JSON.stringify(database)}||p.port!==5433||!['127.0.0.1','::1'].includes(p.address)||p.privileged!==superuser)throw Error('Physical fixture ownership refused');
  }
  const [acl]=await owner.client.unsafe("select has_column_privilege('ai_hr_app','public.ai_provider_config','api_key_ciphertext','SELECT') as ciphertext,has_column_privilege('ai_hr_app','public.ai_provider_config','model','SELECT') as metadata");if(acl.ciphertext!==false||acl.metadata!==true)throw Error('Normal migration provider ACL not preserved');
  const before=await owner.client.unsafe('select count(*)::int n from public.ai_provider_config');if(before[0].n!==0)throw Error('Provider configuration forbidden');
  const fixture=await populateAiDeliveryFullFixture(owner);
  const after=await owner.client.unsafe('select count(*)::int n from public.ai_provider_config');if(after[0].n!==0)throw Error('Provider configuration forbidden');
  writeFileSync(${JSON.stringify(fixturePath)},JSON.stringify({fixture,declarations:Object.values(MODULE_AGENT_ACTIONS).map(d=>({module:d.module,coverage:d.coverage,actions:d.actions.map(a=>({id:a.id,prepare:a.prepare.status,confirm:a.confirm.status}))}))}),{mode:0o600});
 }finally{await owner.client.end();await client.end();}
}
prepare().catch(()=>{process.exitCode=1;});
`;
}
/** Private transport only. These envelopes are not canonical facts and confer no authority. */
const READBACK_SPECS=Object.freeze({
 own_leave:Object.freeze({module:'scripts/fixtures/ai-delivery-own-leave-native-readback.ts',member:'createAiDeliveryOwnLeaveNativeReadback',phases:Object.freeze(['baseline','prepared','submitted','reopened','reopened_again']),owner:true}),
 profile:Object.freeze({module:'scripts/fixtures/ai-delivery-profile-native-readback.ts',member:'createAiDeliveryProfileNativeReadback',phases:Object.freeze(['baseline','prepared','submitted','reopened','reopened_again']),owner:true}),
 provider_config:Object.freeze({module:'scripts/fixtures/ai-delivery-provider-config-native-readback.ts',member:'createAiDeliveryProviderConfigNativeReadback',phases:Object.freeze(['baseline','invalid_routes','saved','reloaded']),owner:false}),
 employee_import_paste:Object.freeze({module:'scripts/fixtures/ai-delivery-employee-import-native-readback.ts',member:'createAiDeliveryEmployeeImportScenarioReadback',phases:Object.freeze(['baseline','unresolved','prepared','previewed','committed','reopened']),owner:true,sourceMode:'paste'}),
 employee_import_csv:Object.freeze({module:'scripts/fixtures/ai-delivery-employee-import-native-readback.ts',member:'createAiDeliveryEmployeeImportScenarioReadback',phases:Object.freeze(['baseline','unresolved','prepared','previewed','committed','reopened']),owner:true,sourceMode:'csv'}),
 employee_import_xlsx:Object.freeze({module:'scripts/fixtures/ai-delivery-employee-import-native-readback.ts',member:'createAiDeliveryEmployeeImportScenarioReadback',phases:Object.freeze(['baseline','unresolved','prepared','previewed','committed','reopened']),owner:true,sourceMode:'xlsx'}),
});
export function nativeReadbackSpecification(kind){assert(typeof kind==='string'&&Object.hasOwn(READBACK_SPECS,kind),'Unknown closed readback kind');return READBACK_SPECS[kind];}
export function parseNativeReadbackResponse(line,sequence,operation,kind='own_leave'){
 nativeReadbackSpecification(kind);assert(typeof line==='string'&&Buffer.byteLength(line,'utf8')<=131072);const value=JSON.parse(line);
 assert(value&&typeof value==='object'&&!Array.isArray(value));assert.equal(value.kind,kind);assert.equal(value.sequence,sequence);assert.equal(value.ok,true);
 const keys=Object.keys(value).sort();
 if(operation==='ready'){const spec=nativeReadbackSpecification(kind);assert.deepEqual(keys,spec.sourceMode?['input','kind','ok','ready','sequence']:['kind','ok','ready','sequence']);assert.equal(value.ready,true);return spec.sourceMode?validateEmployeeImportInput(value.input,spec.sourceMode):true;}
 if(operation==='finish'){assert.deepEqual(keys,['finished','kind','ok','sequence']);assert.equal(value.finished,true);return true;}
 assert.equal(operation,'verify');assert.deepEqual(keys,['kind','ok','sequence','value']);assert(value.value&&typeof value.value==='object'&&!Array.isArray(value.value));return value.value;
}
/** Closed private ready data, never a public artifact or caller-authored HR fact. Native scenario
 * owner separately checks current authority/actual department/clock before creating this packet. */
export function validateEmployeeImportInput(input,sourceMode){
 assert(['paste','csv','xlsx'].includes(sourceMode));const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...keys].sort());};
 exact(input,['sourceMode','pastedText','human','expected']);assert.equal(input.sourceMode,sourceMode);
 assert.equal(input.pastedText,'Employee ID,Full Name,Personal Email,Join Date,Unresolved Heading\nAI-IMPORT-NEW,Fictional Imported Human,fictional-import@example.test,,human must map or exclude\n');
 exact(input.human,['employeeCode','fullName','email','department','employmentType','basicSalary','hiredOn']);const h=input.human;
 assert.equal(h.employeeCode,'AI-IMPORT-NEW');assert.equal(h.fullName,'Fictional Imported Human');assert.equal(h.email,'fictional-import@example.test');assert.equal(h.employmentType,'full_time');assert.equal(h.basicSalary,'3000.00');assert(typeof h.department==='string'&&h.department.length>0&&h.department.length<=200);assert(/^\d{4}-\d{2}-\d{2}$/.test(h.hiredOn));
 exact(input.expected,['userId','companyId','sourceMode','human']);assert(UUID.test(input.expected.userId)&&UUID.test(input.expected.companyId));assert.equal(input.expected.sourceMode,sourceMode);assert.deepEqual(input.expected.human,h);return structuredClone(input);
}
export function nativeReadbackBootstrap(root,fixturePath,kind='own_leave'){
 assert(arguments.length<=3,'No caller-provided readback count');const spec=nativeReadbackSpecification(kind),count=spec.phases.length;
 const factoryArgs=spec.sourceMode?'owner,fixture:packet.fixture,sourceMode:'+JSON.stringify(spec.sourceMode):spec.owner?'owner,fixture:packet.fixture':'fixture:packet.fixture,expected:'+JSON.stringify(INACTIVE_PROVIDER_SELECTION);
 return `import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {${spec.owner?'createDb,client':'client'}} from ${JSON.stringify(join(root,'db/client.ts'))};
import {${spec.member} as createNativeReadback} from ${JSON.stringify(join(root,spec.module))};
async function main(){
 ${spec.owner?'const owner=createDb(process.env.MIGRATION_DATABASE_URL!,{max:1});':''}
 const lines=createInterface({input:process.stdin,crlfDelay:Infinity}),phases=${JSON.stringify(spec.phases)};
 const send=(value:object)=>new Promise<void>((ok,bad)=>{const text=JSON.stringify({kind:${JSON.stringify(kind)},...value});if(Buffer.byteLength(text,'utf8')>131072)return bad(Error('Bounded readback reply refused'));process.stdout.write(text+'\\n',error=>error?bad(error):ok());});
 let sequence=0,calls=0;
 try{
  const packet=JSON.parse(readFileSync(${JSON.stringify(fixturePath)},'utf8'));
  const ${spec.sourceMode?'prepared':'verify'}=await createNativeReadback({${factoryArgs}});
  ${spec.sourceMode?'const verify=prepared.verifyCanonical;':''}
  await send({sequence:0,ok:true,ready:true${spec.sourceMode?',input:prepared.input':''}});
  for await(const line of lines){
   if(Buffer.byteLength(line,'utf8')>131072)throw Error('Bounded readback input refused');
   const p=JSON.parse(line);if(!p||typeof p!=='object'||Array.isArray(p)||p.kind!==${JSON.stringify(kind)}||p.sequence!==++sequence||sequence>${count+1})throw Error('Readback sequence refused');
   if(p.operation==='finish'){
    if(Object.keys(p).sort().join(',')!=='kind,operation,sequence'||calls!==${count})throw Error('Readback finish refused');
    await send({sequence,ok:true,finished:true});return;
   }
   if(p.operation!=='verify'||Object.keys(p).sort().join(',')!=='invocation,kind,operation,sequence'||calls>=${count}||p.invocation?.phase!==phases[calls])throw Error('Readback operation refused');
   const value=await verify(p.invocation);calls++;await send({sequence,ok:true,value});
  }
  throw Error('Readback input ended before completion');
 }catch{await send({sequence,ok:false});process.exitCode=1;}
 finally{lines.close();const closed=await Promise.allSettled([${spec.owner?'owner.client.end(),':''}client.end()]);if(closed.some(result=>result.status!=='fulfilled'))throw Error('Readback pool closure refused');}
}
main().catch(()=>{process.exitCode=1;});
`;
}
export function createPrivateNativeReadbackClient(child,options={}){
 assert(options&&typeof options==='object'&&!Array.isArray(options)&&Object.keys(options).every(key=>['signal','timeoutMs','kind'].includes(key)));const {signal,timeoutMs=30000,kind='own_leave'}=options;
 const spec=nativeReadbackSpecification(kind);assert(child?.stdin&&child?.stdout);assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000);
 let sequence=0,verified=0,pending,failed=false,inFlight=false,finished=false,ended=false,exited=false,buffer='';const decoder=new TextDecoder('utf-8',{fatal:true});
 const fail=()=>{failed=true;if(pending){const p=pending;pending=undefined;clearTimeout(p.timer);p.reject(Error('Private native readback unavailable'));}};
 const wait=(operation,number)=>new Promise((resolve,reject)=>{assert(!pending);pending={operation,number,resolve,reject,timer:setTimeout(fail,timeoutMs)};});
 const ready=wait('ready',0);ready.catch(()=>{});
 child.stdout.on('data',chunk=>{try{
  buffer+=decoder.decode(chunk,{stream:true});assert(Buffer.byteLength(buffer,'utf8')<=262144);
  for(let index;(index=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);assert(pending&&!failed);const value=parseNativeReadbackResponse(line,pending.number,pending.operation,kind);const p=pending;pending=undefined;clearTimeout(p.timer);p.resolve(value);}
 }catch{fail();}});
 child.stdout.once('end',()=>{try{assert.equal(decoder.decode(),'');assert.equal(buffer,'');ended=true;if(!finished)fail();}catch{fail();}});
 child.once('error',fail);child.stdin.on('error',fail);child.once('exit',(code,signal)=>{if(code!==0||signal!==null||!finished)fail();else exited=true;});
 if(signal){if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true});}
 async function request(operation,invocation){
  if(spec.sourceMode&&operation==='verify')invocation=structuredClone(invocation);
  assert(!failed&&!inFlight&&!finished);
  if(operation==='verify'){const allowed=kind==='provider_config'?['phase']:spec.sourceMode?['phase','expected']:['phase','expected','actionId','receipt','review'];assert(invocation&&Object.keys(invocation).every(key=>allowed.includes(key))&&invocation.phase===spec.phases[verified]);}else assert(operation==='finish'&&verified===spec.phases.length);
  inFlight=true;
  try{const readyValue=await ready;assert(!failed);if(spec.sourceMode&&operation==='verify'){assert.deepEqual(Object.keys(invocation).sort(),['expected','phase']);assert.deepEqual(invocation.expected,readyValue.expected);}const next=sequence+1,packet=JSON.stringify(operation==='verify'?{kind,sequence:next,operation,invocation}:{kind,sequence:next,operation});
   assert(Buffer.byteLength(packet,'utf8')<=131072);sequence=next;const response=wait(operation,next);
   child.stdin.write(packet+'\n',error=>{if(error)fail();});const value=await response;if(operation==='finish'){finished=true;child.stdin.end();}else verified++;return value;
  }finally{inFlight=false;}
 }
 return {readyInput:async()=>{assert(spec.sourceMode,'Ready input only exists for closed import modes');const input=await ready;assert(!failed);return structuredClone(input);},verifyCanonical:invocation=>request('verify',invocation),finish:()=>request('finish'),assertClosed(){assert(!failed&&finished&&ended&&exited&&verified===spec.phases.length&&!pending&&buffer===''&&child.exitCode===0&&child.signalCode===null,'Readback closure unconfirmed');}};
}
const here=dirname(fileURLToPath(import.meta.url));
async function main(){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.CI,'true');assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(process.versions.node.split('.')[0],'20');
 const root=process.cwd(),sha=process.env.AIHR_CI_HEAD,control=process.env.AIHR_CI_CONTROL_HEAD,selectedJourney=closedBrowserJourney(process.env.AIHR_CI_BROWSER_JOURNEY??'primary'),importMode=selectedJourney!=='primary';assert(/^[0-9a-f]{40}$/.test(sha??''));assert(/^[0-9a-f]{40}$/.test(control??''));
 const out=resolve(process.argv[2]??'');assert(out.startsWith(resolve(process.env.RUNNER_TEMP)+'/'));assert(!existsSync(out),'Evidence path must be new');mkdirSync(join(out,'private'),{recursive:true,mode:0o700});mkdirSync(join(out,'public'),{mode:0o700});
 const report=publicReport(sha);report.requestedJourney=selectedJourney;const privateDir=join(out,'private'),children=new Set();let browser,browserServer,postgresOwned=false,failed=false;
 const unit=unitForJourney(process.env.GITHUB_RUN_ID,process.env.GITHUB_RUN_ATTEMPT,sha,selectedJourney),container=`aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${unit}`,database='aihr_assistant_browser_'+unit.slice(3),base='http://127.0.0.1:3177';
 const gate=randomBytes(32).toString('hex'),encryption=randomBytes(32).toString('hex');
 const basic=childEnvironment(process.env,{AIHR_CI_UNIT:unit,AIHR_CI_PG_MEMORY_GIB:'2'});
 const ownerUrl=`postgres://postgres@127.0.0.1:5433/${database}`,appUrl=`postgres://ai_hr_app@127.0.0.1:5433/${database}`;
 const appEnv={...basic,NODE_ENV:'production',DATABASE_URL:appUrl,AUTH_PROVIDER:'workos',NEXT_PUBLIC_APP_URL:base,PORT:'3177',ALLOW_DEMO_SESSION:'true',SHARE_PASSWORD:gate,AI_CONFIG_SECRET:encryption,TEST_DB_NAMESPACE:'assistant_browser_'+unit.slice(3)};
 const fixtureEnv={...appEnv,MIGRATION_DATABASE_URL:ownerUrl};
 const sync=(cmd,args,env=basic)=>{const r=spawnSync(cmd,args,{cwd:root,env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});assert(!r.error&&r.status===0,'Controller command refused');return r.stdout.trim();};
 function members(child){
  const inspection=spawnSync('ps',['-eo','pid=,pgid=,sid='],{env:basic,encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024});
  assert(!inspection.error&&inspection.status===0,'Process inspection unavailable');
  return parseOwnedGroupSnapshot(inspection.stdout,inspection.pid,child.pid);
 }
 async function stop(child){
  for(const signal of ['SIGTERM','SIGKILL']){if(!members(child).length){children.delete(child);return;}process.kill(-child.pid,signal);for(let n=0;n<100;n++){await delay(100);if(!members(child).length){children.delete(child);return;}}}
  throw Error('Owned process group termination unconfirmed');
 }
 async function command(label,cmd,args,env,timeout=900000,background=false){
  const fd=openSync(join(privateDir,label+'.log'),'wx',0o600),child=spawn(cmd,args,{cwd:root,env,detached:true,stdio:['ignore',fd,fd]});closeSync(fd);children.add(child);
  const done=new Promise((ok,bad)=>{child.once('error',bad);child.once('exit',(code,signal)=>{code===0?ok():bad(Error('Child command failed'));});});
  if(background){done.catch(()=>{});return child;}let timer;try{await Promise.race([done,new Promise((_,bad)=>{timer=setTimeout(()=>bad(Error('Child timeout')),timeout);}),new Promise((_,bad)=>{if(abort.signal.aborted)bad(Error('Interrupted'));else abort.signal.addEventListener('abort',()=>bad(Error('Interrupted')),{once:true});})]);}finally{clearTimeout(timer);if(children.has(child))await stop(child);}
 }
 const abort=new AbortController();let interrupted=false;const signal=()=>{interrupted=true;abort.abort();};const deadline=setTimeout(signal,50*60*1000);process.on('SIGTERM',signal);process.on('SIGINT',signal);
 try{
  assert.equal(sync('git',['rev-parse','HEAD']),sha);assert.equal(sync('git',['status','--porcelain','--untracked-files=all']),'');
  assert.equal(sync('git',['-C',resolve(here,'../..'),'rev-parse','HEAD']),control);
  // setup-alpha creates exactly this example copy; refuse any other private environment files.
  if(existsSync(join(root,'.env.local'))){assert.equal(readFileSync(join(root,'.env.local'),'utf8'),readFileSync(join(root,'.env.example'),'utf8'));unlinkSync(join(root,'.env.local'));}
  assert.deepEqual(readdirSync(root).filter(x=>/^\.env(?:\.|$)/.test(x)&&x!=='.env.example'),[]);
  assert(existsSync(join(root,'scripts/fixtures/ai-delivery-full-fixture.ts')),'Full native fixture owner absent; no legacy fallback');
  for(const kind of importMode?[selectedJourney]:['own_leave','profile','provider_config'])assert(existsSync(join(root,nativeReadbackSpecification(kind).module)),'Required canonical '+kind+' readback owner absent; no fallback');
  const inspect=spawnSync('docker',['container','inspect',container],{env:basic,encoding:'utf8',timeout:30000,maxBuffer:1048576});assert(confirmedContainerAbsent(inspect,container),'Unknown docker inspection is not absence');
  writeFileSync(join(privateDir,'owned-unit'),unit,{mode:0o600});postgresOwned=true;report.databaseCleanup='unconfirmed';
  await command('postgres', 'bash',[join(here,'postgres.sh'),'reset'],basic,120000);
  sync('docker',['exec',container,'psql','-U','postgres','-p','5433','-v','ON_ERROR_STOP=1','-d','postgres','-c',`CREATE DATABASE ${closedDatabaseIdentifier(database)};`]);
  const require=createRequire(join(root,'package.json')),tsx=pathToFileURL(require.resolve('tsx')).href;
  const fixturePath=join(privateDir,'fixture.json'),bootstrap=join(privateDir,'prepare.ts');
  writeFileSync(bootstrap,buildFixtureBootstrap(root,fixturePath,database),{mode:0o600});
  for(const stage of fixturePreparationPlan(root,tsx,bootstrap,database,container))await command(stage.label,stage.command,stage.args,{...fixtureEnv,TSX_TSCONFIG_PATH:join(root,'tsconfig.json')},stage.timeout);
  const packet=JSON.parse(readFileSync(fixturePath,'utf8')),fixture=validateFixture(packet.fixture);
  assert.deepEqual(packet.declarations.map(d=>d.module).sort(),[...MODULES].sort());
  for(const d of packet.declarations){assert(['partial_actions','read_only','orchestration_only'].includes(d.coverage),'Unknown declaration coverage');for(const a of d.actions){assert(typeof a.id==='string'&&a.id.length<100);assert(['implemented','read_context_only','human_workflow_only','pending_adapter','unavailable'].includes(a.prepare));assert(['implemented','read_context_only','human_workflow_only','pending_adapter','unavailable'].includes(a.confirm));}}
  report.declaredAvailability=packet.declarations;
  const experienced=new Set();
  async function runNativeJourney(kind,page){
   nativeReadbackSpecification(kind);assert(!experienced.has(kind));const bridgePath=join(privateDir,kind+'-native-readback.ts');writeFileSync(bridgePath,nativeReadbackBootstrap(root,fixturePath,kind),{mode:0o600});
   const stderr=openSync(join(privateDir,kind+'-native-readback.stderr.log'),'wx',0o600);
   const bridge=spawn(process.execPath,['--import',tsx,bridgePath],{cwd:root,env:{...fixtureEnv,TSX_TSCONFIG_PATH:join(root,'tsconfig.json')},detached:true,stdio:['pipe','pipe',stderr]});closeSync(stderr);children.add(bridge);
   const bridgeExit=new Promise((ok,bad)=>{bridge.once('error',bad);bridge.once('close',(code,signal)=>code===0&&!signal?ok():bad(Error('Native readback exited unsuccessfully')));});bridgeExit.catch(()=>{});
   const readback=createPrivateNativeReadbackClient(bridge,{signal:abort.signal,kind});
   try{
    let experience,checkIds,reportKey,journey,coverage;
    switch(kind){
     case 'own_leave':experience=await runAssistantOwnLeaveEnglishExperience({page,fixture,verifyCanonical:readback.verifyCanonical});checkIds=['real_current_own_selection','prepare_no_native_effect','literal_saved_review','single_explicit_confirm_native_refs','reload_same_completed_receipt','repeat_readonly_reopen_no_extra_effect'];reportKey='ownLeaveExperience';journey='english_own_leave_primary';coverage='fictional_english_positive_ui_and_readonly_native_reconciliation_only';break;
     case 'profile':experience=await runAssistantProfileEnglishExperience({page,fixture,verifyCanonical:readback.verifyCanonical});checkIds=['actual_own_permitted_selection','prepare_no_native_effect','literal_human_profile_review','explicit_human_confirm_exact_native_refs','same_completed_reopen','repeat_reopen_no_extra_request_or_profile_application'];reportKey='profileExperience';journey='english_ess_profile_request_primary';coverage='fictional_english_profile_request_submission_only';break;
     case 'provider_config':experience=await runAssistantProviderInactiveConfigEnglishExperience({page,fixture,verifyNative:readback.verifyCanonical});checkIds=['invalid_route_ui_refuses_before_save','privacy_policy_displayed_no_activation_control','synthetic_candidate_saved_inactive_without_probe','same_nonsecret_candidate_version_and_routing_after_reload'];reportKey='providerConfigExperience';journey='english_inactive_synthetic_provider_candidate';coverage='fictional_english_inactive_candidate_only_no_probe_or_activation';break;
     case 'employee_import_paste':case 'employee_import_csv':case 'employee_import_xlsx':{
      const sourceMode=nativeReadbackSpecification(kind).sourceMode,input=await readback.readyInput();assert.equal(input.expected.userId,fixture.actors.operator.userId);assert.equal(input.expected.companyId,fixture.companyId);
      experience=await runAssistantEmployeeImportEnglishExperience({page,fixture,input,verifyCanonical:readback.verifyCanonical});checkIds=['actual_messy_source_local_intake','unresolved_and_unreviewed_prevent_commit','explicit_original_mapping_and_exclusions','blank_human_added_fields_explicit_review','editing_clears_human_review','local_preparation_and_native_preview_no_effects','single_human_commit_native_graph_events','separate_native_history_reopen_no_duplicate'];reportKey='employeeImportExperience';journey='english_employee_import_'+sourceMode;coverage='fictional_'+sourceMode+'_full_employee_creation_only';break;
     }
     default:throw Error('Unknown closed journey');
    }
    assert.equal(experience.journey,journey);assert.deepEqual(experience.checks.map(check=>check.id),checkIds);assert(experience.checks.every(check=>check.passed===true&&JSON.stringify(Object.keys(check).sort())===JSON.stringify(['id','passed'])));
    await readback.finish();await Promise.race([bridgeExit,delay(10000).then(()=>{throw Error('Readback exit unconfirmed');})]);await stop(bridge);readback.assertClosed();
    report[reportKey]={journey,checks:checkIds.map(id=>({id,passed:true})),coverage};
    if(kind==='provider_config'){assert.equal(experience.capability,'UNVERIFIED_NO_PROVIDER_CALLS');assert.equal(experience.liveActivation,'UNVERIFIED_NOT_ATTEMPTED');report[reportKey].capability='UNVERIFIED_NO_PROVIDER_CALLS';report[reportKey].liveActivation='UNVERIFIED_NOT_ATTEMPTED';report[reportKey].security='UNVERIFIED_BOUNDED_POSITIVE_AND_CLIENT_ROUTE_REFUSAL_ONLY';report[reportKey].syntheticCredentialOnly=true;report.provider='INACTIVE_SYNTHETIC_CANDIDATE_NO_PROBES';}
    experienced.add(kind);
   }finally{if(children.has(bridge))await stop(bridge);}
  }
  await command('production-build','pnpm',['build'],{...appEnv,DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database',NODE_OPTIONS:'--max-old-space-size=6144'});
  const server=await command('production-app',process.execPath,[require.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3177'],appEnv,0,true);
  const auth='Basic '+Buffer.from('ci:'+gate).toString('base64');let ready=false;
  for(let n=0;n<120;n++){assert(!interrupted);assert(server.exitCode===null&&server.signalCode===null,'App exited');try{const r=await fetch(base+'/login',{headers:{authorization:auth},signal:AbortSignal.timeout(2000)});if(r.status===200){ready=true;break;}}catch{}await delay(1000);}assert(ready,'App unavailable');assert.equal((await fetch(base+'/',{redirect:'manual'})).status,401);
  browserServer=await require('playwright').chromium.launchServer({headless:true});children.add(browserServer.process());browser=await require('playwright').chromium.connect(browserServer.wsEndpoint());
  const roles=importMode?[['operator',fixture.actors.operator,false]]:[['operator',fixture.actors.operator,true],['reviewer1',fixture.actors.reviewers[0],true],['reviewer2',fixture.actors.reviewers[1],true],['self',fixture.actors.self,false],['peer',fixture.actors.peer,false],['manager',fixture.actors.manager,false],['standalone_tester',fixture.platform.testing.standalone,false],['prehire',fixture.platform.prehire,false]];
  for(const [role,actor,all] of roles){
   assert(UUID.test(actor?.userId));const context=await browser.newContext({httpCredentials:{username:'ci',password:gate}});const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(20000);
   page.on('pageerror',()=>report.errorCounts.page++);page.on('console',m=>{if(m.type()==='error')report.errorCounts.console++;});page.on('response',r=>{if(r.status()>=500)report.errorCounts.server++;});
   await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===base||['data:','blob:','about:'].includes(url.protocol))return route.continue();report.errorCounts.external++;return route.abort();});
   try{
    await page.goto(base+'/login');await page.locator(`form[action="/login/as"]:has(input[name="userId"][value="${actor.userId}"]) button[type="submit"]`).click();await page.waitForURL(u=>!['/login','/login/as'].includes(u.pathname));
    for(const locale of importMode?['en']:['en','ms','zh','ta','th','vi'])for(const viewport of importMode?[{width:1440,height:1000}]:[{width:1440,height:1000},{width:375,height:812}]){
     assert(!interrupted);await context.addCookies([{name:'NEXT_LOCALE',value:locale,url:base}]);await page.setViewportSize(viewport);await page.goto(base+'/assistant');assert.equal(new URL(page.url()).pathname,'/assistant');await page.locator('[data-tour="intelligence-assistant"]').waitFor();
     const available=await page.locator('a[href^="/assistant?job="]').evaluateAll(nodes=>[...new Set(nodes.map(n=>new URL(n.href).searchParams.get('job')))]);assert(available.every(m=>MODULES.includes(m)));if(all)assert.deepEqual([...available].sort(),[...MODULES].sort());
     report.checks.push({role,locale,viewport:viewport.width,workspace:'rendered',available});
     // Full20 across all current native reviewer contexts on EN desktop; locale/mobile smoke
     // repeats workspace plus own-leave entry, not an invented full translated action journey.
     if(all&&locale==='en'&&viewport.width===1440)for(const module of MODULES){await page.locator(`a[href="/assistant?job=${module}"]`).first().click();assert.equal(new URL(page.url()).searchParams.get('job'),module);await page.locator(`a[href="/assistant?job=${module}"][aria-current="page"]`).waitFor();assert(await page.locator('[data-ui-card]').count()>0);if(HUMAN_ENTRY[module])assert(await page.locator(`a[href="${HUMAN_ENTRY[module]}"]`).count()>0,'Declared human entry missing');assert(!/SQLSTATE|PostgresError|ECONNREFUSED|Unhandled Runtime Error|stack trace|AI_CONFIG_SECRET|MIGRATION_DATABASE_URL|postgres:\/\//i.test(await page.locator('body').innerText()));report.checks.push({role,locale,viewport:viewport.width,module,navigation:'rendered'});}
     if(role==='self'){await page.goto(base+'/assistant/leave');assert.equal(new URL(page.url()).pathname,'/assistant/leave');await page.locator('select[id$="-employment"]').waitFor();assert(await page.locator('select[id$="-employment"] option').count()>1);assert(await page.locator('input[type="date"]').count()===1);assert(await page.locator('textarea[id$="-reason"]').count()===1);report.checks.push({role,locale,viewport:viewport.width,ownLeaveEntry:'human_inputs_rendered_not_prepared'});}
     if(locale==='en'&&viewport.width===1440){if(role==='operator')await runNativeJourney(importMode?selectedJourney:'provider_config',page);if(role==='self'){await runNativeJourney('own_leave',page);await runNativeJourney('profile',page);}}
     const body=await page.locator('body').innerText();assert(!/SQLSTATE|PostgresError|ECONNREFUSED|Unhandled Runtime Error|stack trace|AI_CONFIG_SECRET|MIGRATION_DATABASE_URL|postgres:\/\//i.test(body));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow');
    }
   }finally{await context.close();}
  }
  assert.deepEqual([...experienced].sort(),importMode?[selectedJourney]:['own_leave','profile','provider_config'],'Required primary journeys did not complete');assert(Object.values(report.errorCounts).every(n=>n===0),'Browser errors or unexpected external requests');report.state='smoke_passed_incomplete_experience';
 }catch{failed=true;report.state='failed';report.failure=interrupted?'interrupted':'bounded_controller_or_browser_failure';}
 finally{
  if(browser)try{await Promise.race([browser.close(),delay(10000).then(()=>{throw Error('Browser cleanup timeout');})]);}catch{failed=true;report.failure='browser_cleanup_failure';}
  if(browserServer)try{await Promise.race([browserServer.close(),delay(10000).then(()=>{throw Error('Browser server cleanup timeout');})]);}catch{failed=true;report.failure='browser_cleanup_failure';}
  let groupsGone=true;for(const child of [...children])try{await stop(child);}catch{groupsGone=false;failed=true;report.failure='owned_process_cleanup_unconfirmed';}
  if(groupsGone)writeFileSync(join(privateDir,'cleanup-safe'),'all owned process groups confirmed absent',{mode:0o600});
  if(postgresOwned&&groupsGone)try{await command('postgres-cleanup','bash',[join(here,'postgres.sh'),'stop'],basic,120000);const absent=spawnSync('docker',['container','inspect',container],{env:basic,encoding:'utf8',timeout:30000,maxBuffer:1048576});assert(confirmedContainerAbsent(absent,container),'Database removal not confirmed');report.databaseCleanup='confirmed_absent';}catch{failed=true;report.failure='owned_database_cleanup_unconfirmed';}
  clearTimeout(deadline);process.off('SIGTERM',signal);process.off('SIGINT',signal);if(failed)report.state='failed';writeFileSync(join(out,'public/report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 }
 if(failed)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Assistant development browser controller refused before startup.');process.exitCode=1;});
