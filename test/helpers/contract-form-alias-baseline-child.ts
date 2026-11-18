/** Disposable historical Form signer. No migration/reset, future SQL, fabricated signature or recovery shim. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {SessionContext} from '../../db/client';
import type {Field} from '../../lib/lifecycle-v9-model';
import type {AutomationWorkflow} from '../../packs/automation/service';

const SOURCE='175bdd3f31320711e84c49a16239220eb00233e0';
const RESULT='CONTRACT_FORM_ALIAS_BASELINE_RESULT ';
const PINS={
 'package.json':'e90075de8d53a96463a1a7310646d313cc4c076ae9fa39e6100f9cd664ee7e1e',
 'pnpm-lock.yaml':'7c833cb438bd31a1e22045b1704ed1498a4922343828e2d302e3ef4a6cdfb99a',
 'tsconfig.json':'f5bc3a05bc19d85f6d1b7735e34bdd6b93f8f15741316108cc55d67ff4173785',
 'test/harness.ts':'fcbe3a0e8c8055addaf4de2bcface65bb7c708edccaeb0329211b9537adfaecf',
 'test/profile.ts':'6595b52e11aeeea1c9836222fa34c083ffe987783b4a600a2c4a775921ad948a',
 'test/harness-reset-errors.ts':'50dc1618952f67bd7cf22caf6d2159af62ae2355e32d249817166d5250200a0f',
 'db/client.ts':'93da2cd8b227b65bc913243920b1ecad3292903cac64f6b920d8df6ddb2a6b42',
 'db/sql-executor.ts':'f6f1be8e33093421ec2b2eca5abb822897017ee55aac0d6e90e9632a6c431929',
 'core/org.ts':'d5043c1d70d5150e5d597cc43c481b3887ee17fb13bc5e8addb4f01debfde841',
 'core/comp.ts':'a29591bcb6c9015e0ef543d2df584cbbf28a0c2460590f8a487b2f6f6804f827',
 'core/bulk-job-worker.ts':'35f019441a7d033d94037eaf882b852c397817c6021ad70380804223c697e9d2',
 'core/bulk-job.ts':'494c0726babd3f6eb2ec7f98407fa5975c3a25f4b0e53389c1aef29e0edd7c28',
 'core/contract-shared-automation-job.ts':'c6771b338783a07bcaa6acfac5892db16b1129fb628619be26cc89572973fca3',
 'core/contract-shared-preview-job.ts':'97e73ced5e79d6a3e24714cb13d4a87b4391650217bcecace1b9b786e16310a1',
 'core/contract-shared-email-recovery.ts':'eaea957b1d563fe42b787ce0a75aa8dd3158ef31309218d629c9cfd91600ae1f',
 'core/contract-shared-form.ts':'e73ef5129b9c63183d49214fced1c40ff49f84b09e096dd5d9c6ff74211ee153',
 'core/contract-shared-signing.ts':'e068a5949eb47718044f4843502735ca911f8695723315ff0deadf6ed13df1d5',
 'core/contract-shared-tracker.ts':'311efd742e5df6b5a9db0f43b33352d6647e9dd49e5b17a7da58313df32cec87',
 'core/contract-shared-commands.ts':'a4e4a20bab435da6850b89555e8ba03a660ea9d273dfe972d82f59e396c4b7c0',
 'core/contract-shared-read.ts':'48df10cf2690897548c1f10ff2206526b737297ff7dd6dbaae2c4172423836da',
 'core/contract-shared-period.ts':'c73626f9f5865f262277910b04df0e807cae4963ad3d599744632a1a5a6ea05a',
 'packs/contracts/service.ts':'c2d85db3588a419640635a0be1943ccb65b96d46775ca6088cb669cd95758004',
 'packs/automation/service.ts':'a0855d55be69ae78f5d222362884c592d2ffc53386a1254606038232c0ebb1c2',
 'packs/lifecycle/v9/service.ts':'25529b20d68c865b9a51b1e94cebdfbd269205107ae89b2ca692d22ffaece7d2',
 'packs/lifecycle/service.ts':'7b44c8a792400c37512e7bd12289d86c95f4e6ce748bf77fe45e84948c98bfdf',
 'packs/document-signing/service.ts':'89f7230b274ccdbfae8f49dcd727f5d67deb95a848a549dd7655587de3bf6840',
 'lib/lifecycle-v9-model.ts':'70784507d5bc70f804674fa956c56d1539555c3fe640c8f77497f99d1c03acab',
 'core/entitlements.ts':'bb11d9601ec9d40c0d6c50cc9d878a4de555241e13f0116b18180aa417a3df98',
 'scripts/seed-catalogs.ts':'67e3d5bf3164fcc4eb839eae64c22373009843f2372a34166cef32bddb3199d7',
 'packs/catalog.ts':'80ce4ae14cece1bbeb5ca538187d14be0b31a1b84999edd9493bb5b92191e793',
};
type Input={sourceRoot:string;expectedDatabase:string;prefixCount:number};
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function database(value:string|undefined,username:'postgres'|'ai_hr_app',name:string){
 assert(value,'All four bound database URLs are required');const url=new URL(value);
 assert.equal(url.protocol,'postgres:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5433');
 assert.equal(url.username,username);assert.equal(url.password,'');assert.equal(url.search,'');assert.equal(url.hash,'');assert.equal(url.pathname,'/'+name);
 return url.toString();
}
function sqlState(error:unknown):string|undefined{
 for(let cause=error,n=0;cause&&typeof cause==='object'&&n<8;cause=(cause as {cause?:unknown}).cause,n++){
  const code=(cause as {code?:unknown}).code;if(typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code))return code;
 }
}

async function main(){
 assert.equal(process.argv.length,3,'One JSON protocol argument required');const input=JSON.parse(process.argv[2]) as Input;
 assert.deepEqual(Object.keys(input).sort(),['expectedDatabase','prefixCount','sourceRoot']);
 assert(/^ai_hr_contract_alias_upgrade_[a-f0-9]{32}$/.test(input.expectedDatabase));assert(Number.isSafeInteger(input.prefixCount)&&input.prefixCount>924);
 const env=process.env;
 assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.CI,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(env.RUNNER_OS,'Linux');assert.equal(process.platform,'linux');
 assert.equal(env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(env.GITHUB_REPOSITORY_ID,'1333414856');
 assert((env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_JOB==='selected-tests')||(env.GITHUB_WORKFLOW==='alpha-staging-ci'&&env.GITHUB_JOB==='test'));
 assert(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID??''));assert(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT??''));assert(/^[a-f0-9]{40}$/.test(env.AIHR_CI_HEAD??''));
 assert(!env.GIT_DIR&&!env.GIT_WORK_TREE&&!env.GIT_INDEX_FILE,'No alternate Git context');
 assert(isAbsolute(process.argv[1]));
 const current=realpathSync(resolve(dirname(process.argv[1]),'../..'));
 const git=(args:string[])=>execFileSync('git',args,{cwd:current,encoding:'utf8',maxBuffer:8*1024*1024});
 assert.equal(git(['rev-parse','--show-toplevel']).trim(),current);assert.equal(git(['rev-parse','HEAD']).trim(),env.AIHR_CI_HEAD);
 assert.equal(git(['status','--porcelain','--untracked-files=no']).trim(),'','The current source checkout must be frozen');
 assert.equal(git(['rev-parse',SOURCE+'^{commit}']).trim(),SOURCE);
 const self='test/helpers/contract-form-alias-baseline-child.ts';assert.equal(realpathSync(process.argv[1]),join(current,self));assert.equal(sha(readFileSync(join(current,self))),sha(git(['show','HEAD:'+self])));
 const source=realpathSync(input.sourceRoot),inside=relative(realpathSync(tmpdir()),source);
 assert(isAbsolute(input.sourceRoot)&&source===resolve(input.sourceRoot));assert(inside&&!inside.startsWith('..'+sep)&&!isAbsolute(inside));
 assert(inside.split(sep).some(part=>/^contract-form-alias-upgrade-[A-Za-z0-9_-]+$/.test(part)),'Only the parent-owned temporary source archive is admitted');
 assert(!existsSync(join(source,'.git'))&&!existsSync(join(source,'.env'))&&!existsSync(join(source,'.env.local')));
 for(const [file,hash]of Object.entries(PINS))assert.equal(sha(readFileSync(join(source,file))),hash,'Frozen source mismatch: '+file);
 for(const file of ['package.json','pnpm-lock.yaml'])assert.equal(sha(readFileSync(join(current,file))),sha(readFileSync(join(source,file))),'Prepared dependencies must match historical source');
 assert.equal(realpathSync(join(source,'node_modules')),realpathSync(join(current,'node_modules')));assert(existsSync(join(source,'node_modules/drizzle-orm/index.js')));
 assert.equal(realpathSync(env.TSX_TSCONFIG_PATH!),join(source,'tsconfig.json'));
 const currentJournal=JSON.parse(readFileSync(join(current,'db/migrations/meta/_journal.json'),'utf8')) as {entries:{tag:string}[]};
 assert.equal(input.prefixCount,currentJournal.entries.findIndex(entry=>entry.tag==='6411_contract_form_native_field_parity'));
 const app=database(env.TEST_DATABASE_URL,'ai_hr_app',input.expectedDatabase),migration=database(env.TEST_MIGRATION_DATABASE_URL,'postgres',input.expectedDatabase);
 assert.equal(database(env.DATABASE_URL,'ai_hr_app',input.expectedDatabase),app);assert.equal(database(env.MIGRATION_DATABASE_URL,'postgres',input.expectedDatabase),migration);
 // Binding precedes every historical import. This child never provisions roles, migrates or resets.
 for(const key of ['DATABASE_URL','DATABASE_POOLED_URL','TEST_DATABASE_URL'])env[key]=app;
 for(const key of ['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])env[key]=migration;
 for(const key of Object.keys(env))if(key.startsWith('VITEST_')||key.startsWith('AIHR_FOCUSED_')||key.startsWith('AIHR_CI_ROLE_')||key.startsWith('AIHR_CI_DISPOSABLE_ROLE_')||key==='WORKER_DB'||key==='TEST_DB_NAMESPACE')delete env[key];
 env.AIHR_DB_PROCESS_ROLE='worker';env.AIHR_DB_POOL_MAX='1';env.AIHR_DB_POOLER_SERVER_CONNECTIONS='1';process.chdir(source);
 const load=async<T>(file:string):Promise<T>=>{const module=await import(pathToFileURL(join(source,file)).href);return(module.default??module) as T;};
 const harness=await load<typeof import('../harness')>('test/harness.ts');
 try{
  const {owner}=harness,{sql}=await load<typeof import('drizzle-orm')>('node_modules/drizzle-orm/index.js');
  const ledger=async()=>[...await owner.client<{hash:string;created_at:string}[]>`select hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`];
  const prefix=await ledger();assert.equal(prefix.length,input.prefixCount);
  const [empty]=await owner.client<{n:number;future:boolean}[]>`select (select count(*)::int from tenant) as n,to_regprocedure('app.contract_shared_email_recovery_original(uuid)') is not null as future`;
  assert.equal(empty.n,0,'Only a new disposable baseline may be seeded');assert.equal(empty.future,false,'No future recovery API may be installed');
  const {seedCatalogs}=await load<typeof import('../../scripts/seed-catalogs')>('scripts/seed-catalogs.ts');await seedCatalogs(owner.db);
  // Only the existing pure ordinary identity/catalogue primitives, never harness reset or migration.
  const b=await harness.seedBase();await harness.setModule(b.tenantId,'lifecycle','active');await harness.setModule(b.tenantId,'payroll','active');
  const [person]=await owner.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId},'Fictional ending administrator',${randomUUID()+'@ending.test'}) returning id`;
  await owner.client`update app_user set person_id=${person.id} where tenant_id=${b.tenantId} and id=${b.adminUserId}`;
  const admin:SessionContext={...await harness.entitledCtx(b),personId:person.id};assert(uuid(admin.userId));
  const lifecycle=await load<typeof import('../../packs/lifecycle/service')>('packs/lifecycle/service.ts');
  const org=await load<typeof import('../../core/org')>('core/org.ts');
  const {setCompensation}=await load<typeof import('../../core/comp')>('core/comp.ts');
  const automation=await load<typeof import('../../packs/automation/service')>('packs/automation/service.ts');
  const contracts=await load<typeof import('../../packs/contracts/service')>('packs/contracts/service.ts');
  const client=await load<typeof import('../../db/client')>('db/client.ts');
  const {todayInKualaLumpur}=await load<typeof import('../../lib/hr-date')>('lib/hr-date.ts');
  const {runBulkJobTick}=await load<typeof import('../../core/bulk-job-worker')>('core/bulk-job-worker.ts');
  const {readBulkJob}=await load<typeof import('../../core/bulk-job')>('core/bulk-job.ts');
  const [principal]=await client.withTenant(admin,tx=>tx.execute<{current:boolean}>(sql`select app.principal_snapshot_current() as current`));assert.equal(principal.current,true);
  await lifecycle.v9Setup(admin);const config=(await lifecycle.v9Workspace(admin)).config;assert(config);const groupId=config.peopleOpsGroup;assert(groupId);
  assert.equal(config.groups.filter(group=>group.id===groupId).length,1);
  await lifecycle.v9SaveConfig(admin,config.revision,{...config,groups:config.groups.map(group=>group.id===groupId?{...group,name:'Contract ending People Ops',members:[admin.userId!]}:group)});
  const saved=(await lifecycle.v9Workspace(admin)).config;assert(saved);assert.equal(saved.peopleOpsGroup,groupId);
  const year=Number(todayInKualaLumpur().slice(0,4)),start=`${year}-01-01`,end=`${year}-12-31`;
  const subject=await org.hireEmployee(admin,{person:{fullName:'Fictional ending subject',primaryEmail:randomUUID()+'@ending.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end});
  await org.setEmploymentInfo(admin,{employmentId:subject.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:3});
  await setCompensation(admin,{employmentId:subject.employmentId,basicSalary:5000,effectiveFrom:start});
  const employeeId=await harness.createAppUser(b.tenantId,subject.personId,'employee');
  const employee:SessionContext={...admin,userId:employeeId,personId:subject.personId,roles:['employee'],grants:undefined};
  await owner.client`insert into employee_statutory_my(tenant_id,person_id,ic_number,bank_account_no) values(${b.tenantId},${subject.personId},'990101-01-1234','FICTIONAL-BANK-001')`;
  const companySetup=(await lifecycle.v9Workspace(admin)).config;assert(companySetup);
  await lifecycle.v9SaveConfig(admin,companySetup.revision,{...companySetup,companies:[...(companySetup.companies??[]).filter(c=>c.companyId!==b.companyId),{companyId:b.companyId,signatoryUserId:null,signatoryTitle:'',letterhead:{registrationNo:'FICTIONAL-REG',address:'Fictional Shared address',color:'#123456'}}]});
  const fields:Field[]=[
   {id:'hrChoice',label:'HR decision',type:'select',owner:'hr',pmKey:null,required:true,sensitive:false,options:['Yes','No'],section:'main',when:null},
   {id:'lockedIC',label:'Identity number',type:'text',owner:'pmLocked',pmKey:'icNo',required:true,sensitive:true,options:[],section:'main',when:null},
   {id:'lockedBank',label:'Bank account',type:'text',owner:'pmLocked',pmKey:'bankAcc',required:false,sensitive:true,options:[],section:'main',when:null},
   {id:'inactiveLocked',label:'Inactive source',type:'text',owner:'pmLocked',pmKey:'unsupported.private',required:true,sensitive:false,options:[],section:'main',when:{field:'hrChoice',value:'Never'}},
   {id:'employeeAck',label:'Employee answer',type:'checkbox',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],section:'main',when:{field:'hrChoice',value:'Yes'}},
   {id:'employeeRows',label:'Employee table',type:'table',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],columns:['Name','Value'],section:'main',when:{field:'hrChoice',value:'Yes'}},
  ];
  const templateId=randomUUID();
  await automation.saveAutomationDocumentTemplate(admin,{template:{id:templateId,module:'contract_staff',name:'Contract outcome',description:'Fictional ending wording',rules:{},blocks:[{id:'intro',type:'text',text:'Dear {employee.name}. Current end: {contract.end}.',section:''}],fields:[],routing:[{id:randomUUID(),order:1,action:'review',owner:true,who:{kind:'group',groupId}},{id:randomUUID(),order:2,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
  await automation.saveAutomationDocumentTemplate(admin,{template:{id:templateId,module:'contract_staff',name:'Fictional shared employment Form',description:'Real Form owner regression',rules:{},blocks:[{id:'head',type:'letterhead',text:'',section:''},{id:'intro',type:'text',text:'Known {Full name}; unresolved {Bank account number}.',section:''},{id:'fields',type:'fields',text:'',section:'main'}],fields,routing:[{id:'hr-review',order:1,action:'review',owner:true,who:{kind:'group',groupId}},{id:'hr-sign',order:2,action:'sign',owner:false,who:{kind:'group',groupId}},{id:'employee-sign',order:3,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:1,publish:true,retired:false});
  const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Contract ending decision',description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:randomUUID(),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}}]};
  await automation.saveAutomationWorkflow(admin,{workflow,expectedRevision:0,reason:'Reviewed historical Form workflow fixture'});
  const finish=async(id:string,kind:'contract_preview'|'contract_automation')=>{
   assert(uuid(id));const handler=kind==='contract_preview'?contracts.contractPreviewJobHandler:contracts.contractAutomationJobHandler;let failure:unknown;
   const diagnostic:typeof handler={...handler,describeFailure:async(...args:Parameters<NonNullable<typeof handler.describeFailure>>)=>{failure=args[1];return handler.describeFailure!(...args);}};
   for(let n=0;n<100;n++){
    const job=await readBulkJob(admin,id,kind);if(job.state==='completed')return;
    if(job.state==='failed'||job.state==='cancelled')throw failure??Error(job.error??'The historical native job refused');
    const delay=job.not_before?Date.parse(String(job.not_before))-Date.now():0;
    if(delay>0){await new Promise(resolve=>setTimeout(resolve,Math.min(delay,100)));continue;}
    // Reproduce the historical native fixture's real createDb/Drizzle-wrapped owner transport.
    await runBulkJobTick(owner.client,{handlers:[diagnostic]});
   }
   throw Error('The bounded historical native worker did not finish');
  };
  const period=await contracts.contractSharedPeriodContext(admin,subject.employmentId);assert.equal(period.canOpen,true);assert.equal(period.sourceIssue,null);
  if('sourceIssue' in period.source)assert.equal(period.source.sourceIssue,null);
  const opened=await contracts.openContractSharedPeriod(admin,{employmentId:subject.employmentId,sourceRevision:period.sourceRevision});assert(uuid(opened.caseId));assert(uuid(opened.jobId));
  await finish(opened.jobId,'contract_automation'); // No rapid-user empty-opening recovery is needed.
  const context=await contracts.contractSharedContext(admin,opened.caseId);assert(context.flow);
  const preview=await contracts.previewContractSharedDecision(admin,{caseId:opened.caseId,revision:context.flow.revision,draft:{kind:'renew',payChanges:false,months:6,reason:'Continue the role'}});
  await finish(preview.jobId,'contract_preview');
  const ready=await contracts.readContractSharedDecisionPreview(admin,preview.previewId);assert.equal(ready.caseId,opened.caseId);assert(ready.plan);assert.deepEqual(ready.plan.blockers,[]);
  assert.deepEqual(ready.plan.workflowVersions,[{workflowId:workflow.id,revision:1}]);
  const accepted=await contracts.submitContractSharedDecision(admin,{caseId:opened.caseId,revision:context.flow.revision,previewId:preview.previewId});await finish(accepted.jobId,'contract_automation');
  const letters=await owner.client<{id:string}[]>`select id from contract_shared_letter where tenant_id=${b.tenantId} and case_id=${opened.caseId} order by id`;assert.equal(letters.length,1);const letterId=letters[0].id;
  const visible=(form:Awaited<ReturnType<typeof contracts.readContractSharedForm>>)=>{assert(form?.visible,'Actual routed Form body required');return form;};
  const first=await contracts.readContractSharedLetter(admin,letterId),response=visible(await contracts.readContractSharedForm(admin,letterId));assert(first.contentHash);
  await contracts.saveContractSharedForm(admin,{id:letterId,contentRevision:first.contentRevision,contentHash:first.contentHash,responseRevision:response.responseRevision,responseHash:response.responseHash,values:{hrChoice:'No'}});
  const act=async(actor:SessionContext,action:'reviewed'|'signed')=>{
   const letter=await contracts.readContractSharedLetter(actor,letterId),form=visible(await contracts.readContractSharedForm(actor,letterId));assert(letter.pendingAction);assert(letter.contentHash);
   await contracts.actContractSharedLetter(actor,{id:letterId,actionId:randomUUID(),stepId:letter.pendingAction.stepId,revision:letter.contentRevision,hash:letter.contentHash,responseRevision:form.responseRevision,responseHash:form.responseHash,action,...(action==='signed'?{method:'typed' as const,value:'Fictional verified signer',consent:true}:{})});
  };
  await act(admin,'reviewed');await act(admin,'signed');await act(employee,'signed');
  const before=await contracts.readContractSharedLetter(admin,letterId),form=visible(await contracts.readContractSharedForm(admin,letterId));
  assert.equal(before.state,'released');assert.equal(before.valuesFixed,true);assert(before.body);assert.equal(before.body.values.bankAcc,'FICTIONAL-BANK-001');assert(!Object.hasOwn(before.body.values,'Bank account number'));
  assert.equal(form.values.lockedBank,'FICTIONAL-BANK-001');assert.equal(before.body.receipts.length,2);assert.equal(form.receipts.length,3);
  assert.equal(sha(before.body.fingerprintSource),before.contentHash);
  assert.deepEqual(before.body.receipts.map(r=>r.actorId).sort(),[admin.userId,employee.userId].sort());
  for(const receipt of before.body.receipts)assert.deepEqual(receipt.signature,{method:'typed',value:'Fictional verified signer',consent:true});
  for(const actor of [admin,employee])assert(form.receipts.some(r=>r.actorUserId===actor.userId&&r.actorPersonId===actor.personId));
  const document=contracts.renderContractSharedLetter(before);assert(document);const intro=document.blocks.find(block=>block.id==='intro');assert(intro);
  const {merge}=await load<typeof import('../../lib/lifecycle-v9-model')>('lib/lifecycle-v9-model.ts');
  const rendered=merge(intro.text,{...document.mergeValues,...form.values}).text;assert.equal(rendered,'Known Fictional ending subject; unresolved {Bank account number}.');
  assert.deepEqual(await ledger(),prefix,'The native seed must not alter migration history');
  console.log(RESULT+JSON.stringify({version:1,source:SOURCE,tenantId:b.tenantId,companyId:b.companyId,employmentId:subject.employmentId,employeePersonId:subject.personId,caseId:opened.caseId,letterId,admin:{userId:admin.userId,personId:admin.personId},employee:{userId:employee.userId,personId:employee.personId},before,form,rendered,ledger:prefix}));
 }finally{await harness.closeAll();}
}
main().catch(error=>{console.error('CONTRACT_FORM_ALIAS_BASELINE_FAILED '+JSON.stringify({code:sqlState(error),message:(error instanceof Error?error.message:'Unknown native fixture failure').replace(/postgres(?:ql)?:\/\/\S+/g,'[database URL]').slice(0,600)}));process.exitCode=1;});
