import {createHash} from 'node:crypto';
import path from 'node:path';
/** Closed acceptance targets. No arbitrary DB/path/port/fixture overrides. */
export const PERSONNEL_PREPARATION=Object.freeze({candidate:'299ccd2d6891de62149f5205cac81522b1076dea',pid:85618,stoppedAt:'2026-10-16T06:47:37.642Z',fixtureBytes:'fb7e3b34ffe6fc52711ee79cfe527056e80ab5146954f93f89d693faa87463af',browserBytes:'ed4d059f72617c7c7c0dfd0f14d36464a72e325c3b978696021ab9d91e8ace40',stopBytes:'b7971ba79002ef1667990ece31a07c0ecb830bb29f90507bb4005e1ce778f7f1',runnerBytes:'d7bc178a2de94d4db3c125625b79c091b3f7d92f16f3d657fdd6fd941498e0d6'});
export const ORIGINAL18_BROWSER_TARGETS=Object.freeze({
 schedules:Object.freeze({database:'ai_hr_board15schedules_browser',port:3192,namespace:'board15schedules',fixture:'dev-fixture-board15-schedules.ts',route:'/admin/attendance/settings'}),
 holidays:Object.freeze({database:'ai_hr_board15holiday_browser',port:3193,namespace:'board15holidays',fixture:'dev-fixture-board15-holidays.ts',route:'/admin/holidays/replacements'}),
 approval:Object.freeze({database:'ai_hr_board15_approval_browser',port:3195,namespace:'board15approval',fixture:'dev-fixture-attendance-hierarchy.ts',route:'/approvals'}),
 labels:Object.freeze({database:'ai_hr_board18_labels_browser',port:3198,namespace:'board18labels',fixture:'dev-fixture-system-labels.mts',route:'/admin/settings/system-labels',fresh:true,scratchpad:'scratchpad/board18-labels'}),
 reports:Object.freeze({database:'ai_hr_board18_reports_browser',port:3197,namespace:'board18reports',fixture:'dev-fixture-employee-master.mts',route:'/reports',fresh:true,scratchpad:'scratchpad/board18-reports'}),
 personnel:Object.freeze({database:'ai_hr_board15_personnel_browser',port:3203,namespace:'board15personnelregisters',fixture:null,route:'/admin/personnel',resumeOnly:true,scratchpad:'scratchpad/board15-personnel-registers'}),
 inquiry:Object.freeze({database:'ai_hr_board15_inquiry_browser',port:3196,namespace:'board15inquiry',fixture:'dev-fixture-leave-inquiry.ts',route:'/leave/tracker'}),
});
export function original18BrowserTarget(args,{allowWorker=false}={}){
 if(!Array.isArray(args)||args.some(arg=>typeof arg!=='string')||new Set(args).size!==args.length)throw new Error('Duplicate or invalid browser arguments.');
 const selections=args.filter(arg=>arg.startsWith('--scenario='));
 if(selections.length!==1||args.some(arg=>!arg.startsWith('--scenario=')&&arg!=='--resume'&&!(allowWorker&&arg==='--held-lock-worker')))throw new Error('Select exactly one original18 scenario; unknown flags refused.');
 const scenario=selections[0].slice(11);
 if(!Object.hasOwn(ORIGINAL18_BROWSER_TARGETS,scenario))throw new Error('Unknown original18 scenario.');
 if(ORIGINAL18_BROWSER_TARGETS[scenario].resumeOnly&&!args.includes('--resume'))throw new Error('Personnel is resume only; setup is forbidden.');
 return Object.freeze({...ORIGINAL18_BROWSER_TARGETS[scenario],scenario,scratchpad:ORIGINAL18_BROWSER_TARGETS[scenario].scratchpad??'scratchpad/board18-browser-'+scenario,resume:args.includes('--resume'),heldLockWorker:args.includes('--held-lock-worker')});
}
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const sha=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=()=>{throw new Error('Unproven original18 fixture/cleanup provenance; preserve target.');};
/** Invocation-local cancellation never targets another queued/active coordinator. */
export function original18InvocationStopFile(scratchpad,name){
 if(typeof scratchpad!=='string'||!path.isAbsolute(scratchpad)||typeof name!=='string'||!/^browser-request-[0-9a-f]{32}\.stop$/.test(name))fail();
 return path.join(scratchpad,name);
}
/** Only identity/liveness, deliberately excluding Grade/Qualification and other mutable UI facts. */
export function original18EmploymentProof(actor,employment,blocked){
 if(!record(actor)||typeof blocked!=='boolean'||blocked!==(actor.allowBlocked===true))fail();
 if(!actor.employmentId)return undefined;
 if(!record(employment)||employment.id!==actor.employmentId||employment.companyId!==actor.companyId||typeof employment.employeeCode!=='string'||!employment.employeeCode||actor.employeeCode!==undefined&&employment.employeeCode!==actor.employeeCode)fail();
 return {id:employment.id,companyId:employment.companyId,employeeCode:employment.employeeCode};
}
export function original18FixtureFacts(raw){
 if(!record(raw))fail();
 // These are run diagnostics, not declared business identities or configured/recorded outcomes.
 const {reused,sweep,...facts}=raw;
 return facts;
}
export function original18FixtureFromLog(content){
 if(typeof content!=='string'||Buffer.byteLength(content)>4*1024*1024)fail();
 const starts=[...content.matchAll(/^\{/gm)];if(starts.length!==1)fail();
 let parsed;try{parsed=JSON.parse(content.slice(starts[0].index).trim());}catch{fail();}
 if(!record(parsed))fail();return original18FixtureFacts(parsed);
}
/** Exact fictional IDs/logins/grants expected from each existing fixture, never application authority. */
export function original18FixtureIdentities(scenario,facts){
 if(!record(facts))fail();let companies=[],actors=[];
 const company=(id,label,name)=>{if(!uuid(id))fail();return {id,label,name};};
 const grant=(role,companyId)=>({role,companyId});
 const sameGrants=(a,b)=>Array.isArray(a)&&JSON.stringify(a.map(row=>[row.role,row.companyId]).sort())===JSON.stringify(b.map(row=>[row.role,row.companyId]).sort());
 if(scenario==='schedules'){
  companies=[company(facts.companyId,'BOARD15-SCHEDULES','Schedule board review (fictional)')];
  if(!Array.isArray(facts.groups)||facts.groups.length!==2||facts.groups.some(row=>!record(row)||!uuid(row.id))||!Array.isArray(facts.shifts)||facts.shifts.length!==2||facts.shifts.some(row=>!record(row)||!uuid(row.id))||!Array.isArray(facts.logins)||facts.logins.length!==4)fail();
  actors=facts.logins.map(row=>{if(!record(row)||!['hr','manager','fixed','flexi'].includes(row.key)||!uuid(row.id)||row.key!=='hr'&&!uuid(row.employmentId))fail();return {id:row.id,login:'board15-schedules:'+row.key,employmentId:row.employmentId??null,companyId:row.key==='hr'?null:facts.companyId,grants:[grant(row.key==='hr'?'hr_admin':row.key==='manager'?'manager':'employee',row.key==='hr'?null:facts.companyId)]};});
 }else if(scenario==='holidays'){
  if(!Array.isArray(facts.scenarios)||facts.scenarios.length!==5||!Array.isArray(facts.logins)||facts.logins.length!==6)fail();
  companies=facts.scenarios.map(row=>{if(!record(row)||!['A','B','C','REVIEW','EMPTY'].includes(row.key))fail();return company(row.companyId,'BOARD15-HOLIDAY-'+row.key,`Replacement holiday ${row.key} (fictional)`);});
  const a=facts.scenarios.find(row=>row.key==='A');
  actors=facts.logins.map(row=>{if(!record(row)||!['hr','scoped-hr','a','b','c','review'].includes(row.key)||!uuid(row.id))fail();const subject=facts.scenarios.find(value=>value.key.toLowerCase()===row.key);if(subject&&(!uuid(row.employmentId)||row.employmentId!==subject.employmentId||row.id!==subject.userId))fail();return {id:row.id,login:'board15-holidays:'+row.key,employmentId:row.employmentId??null,companyId:subject?.companyId??null,grants:[grant(row.key==='hr'||row.key==='scoped-hr'?'hr_admin':'employee',row.key==='hr'?null:row.key==='scoped-hr'?a?.companyId:subject?.companyId)]};});
 }else if(scenario==='approval'){
  if(!record(facts.companies)||Object.keys(facts.companies).sort().join(',')!=='Empty,Foreign,Main'||!record(facts.people)||Object.keys(facts.people).sort().join(',')!=='A,Arjun,D,D2,Daniel,ForeignHR,HR,NoSuperior,OtherHR')fail();
  companies=Object.entries(facts.companies).map(([key,id])=>company(id,'APPROVAL15-'+key,'Approval hierarchy fixture '+key));
  actors=Object.entries(facts.people).map(([key,row])=>{if(!record(row)||!uuid(row.userId)||!uuid(row.personId)||!uuid(row.employmentId)||row.login!=='approval15-fixture:'+key)fail();const role=['HR','OtherHR','ForeignHR'].includes(key)?'hr_admin':['D','D2','NoSuperior'].includes(key)?'employee':'manager';return {id:row.userId,personId:row.personId,employmentId:row.employmentId,companyId:facts.companies[key==='ForeignHR'?'Foreign':'Main'],employeeCode:'AP15-'+key.toUpperCase(),login:row.login,grants:[grant(role,facts.companies[key==='ForeignHR'?'Foreign':'Main']),...(key==='HR'?[grant('hr_admin',facts.companies.Empty)]:[])]};});
 }else if(scenario==='labels'){
  const tenants=original18FixtureTenants(scenario,facts),primary=tenants.find(row=>row.name==='Labels18 Primary (fictional)'),foreign=tenants.find(row=>row.name==='Labels18 Foreign (fictional)');
  if(!record(facts.companies)||Object.keys(facts.companies).sort().join(',')!=='B,Empty,Hidden,Main'||!record(facts.people)||Object.keys(facts.people).sort().join(',')!=='BEmployee,Employee,EmptyHR,ForeignHR,GroupHR,HiddenEmployee,Manager,Operator,ScopedHR')fail();
  companies=Object.entries(facts.companies).map(([key,row])=>{if(!record(row)||row.tenantId!==primary.id||row.name!==(key==='Main'?primary.name:`Labels18 ${key} (fictional)`)||row.companyLabel!==(key==='Main'?null:'LBL18-'+key.toUpperCase()))fail();return {...company(row.id,row.companyLabel,row.name),tenantId:row.tenantId};});
  const primaryRow=facts.fixtureTenants.find(row=>row.id===primary.id);if(primaryRow.companyId!==facts.companies.Main.id)fail();
  const foreignRow=facts.fixtureTenants.find(row=>row.id===foreign.id);companies.push({...company(foreignRow.companyId,null,foreign.name),tenantId:foreign.id});
  actors=Object.entries(facts.people).map(([key,row])=>{
   const tenantId=key==='ForeignHR'?foreign.id:primary.id,companyKey=key==='BEmployee'?'B':key==='HiddenEmployee'?'Hidden':'Main';
   const grants=['GroupHR','ForeignHR'].includes(key)?[grant('hr_admin',null)]:key==='ScopedHR'?[grant('hr_admin',facts.companies.Main.id),grant('hr_admin',facts.companies.B.id)]:key==='EmptyHR'?[grant('hr_admin',facts.companies.Empty.id)]:key==='Operator'?[grant('operator',null)]:[grant(key==='Manager'?'manager':'employee',facts.companies[companyKey].id)];
   if(!record(row)||row.tenantId!==tenantId||!uuid(row.userId)||!['EmptyHR','Operator'].includes(key)&&!uuid(row.personId)||['EmptyHR','Operator'].includes(key)&&(row.personId!==null||row.employmentId!==null)||['GroupHR','ForeignHR'].includes(key)&&row.employmentId!==null||!['GroupHR','ForeignHR','EmptyHR','Operator'].includes(key)&&!uuid(row.employmentId)||!['GroupHR','ForeignHR'].includes(key)&&row.login!=='labels18-fixture:'+key||typeof row.login!=='string'||!row.login||row.login.length>300||!Array.isArray(row.grants)||!sameGrants(row.grants,grants))fail();
   return {id:row.userId,personId:row.personId,employmentId:row.employmentId,companyId:row.employmentId?facts.companies[companyKey].id:null,...(row.employmentId?{employeeCode:'LBL18-'+key.toUpperCase()}:{}),tenantId,login:row.login,grants};
  });
 }else if(scenario==='reports'){
  original18FixtureTenants(scenario,facts);
  if(!record(facts.companies)||Object.keys(facts.companies).sort().join(',')!=='Empty,Foreign,Hidden,MainA,MainB,Provisioned'||!record(facts.people)||Object.keys(facts.people).sort().join(',')!=='Employee,ForeignHR,HR_A,HR_B,HiddenHR,NoSalary')fail();
  companies=Object.entries(facts.companies).map(([key,row])=>{const tenantId=key==='Foreign'?facts.foreignTenant.id:facts.tenantId,name=key==='Foreign'?facts.foreignTenant.name:key==='Provisioned'?facts.tenantName:'Reports18 fictional '+key,label=['Foreign','Provisioned'].includes(key)?null:'R18-'+key.toUpperCase();if(!record(row)||row.tenantId!==tenantId||row.name!==name||row.code!==label)fail();return {...company(row.id,label,name),tenantId};});
  actors=Object.entries(facts.people).map(([key,row])=>{
   const tenantId=key==='ForeignHR'?facts.foreignTenant.id:facts.tenantId,companyKey=key==='ForeignHR'?'Foreign':key==='HR_B'?'MainB':key==='HiddenHR'?'Hidden':'MainA';
   const grants=['HR_A','HR_B'].includes(key)?['MainA','MainB','Empty'].map(name=>grant('hr_admin',facts.companies[name].id)):key==='NoSalary'?[grant('super_admin',null)]:key==='Employee'?[grant('employee',null)]:[grant('hr_admin',facts.companies[companyKey].id)];
   if(!record(row)||row.tenantId!==tenantId||row.companyId!==facts.companies[companyKey].id||!uuid(row.userId)||!uuid(row.personId)||!uuid(row.employmentId)||row.employeeCode!=='R18-'+key.toUpperCase()||row.login!=='report18-fixture:'+key||!sameGrants(row.grants,grants))fail();
   return {id:row.userId,personId:row.personId,employmentId:row.employmentId,companyId:row.companyId,employeeCode:row.employeeCode,tenantId,login:row.login,grants};
  });
 }else if(scenario==='personnel'){
  if(!record(facts.companies)||Object.keys(facts.companies).sort().join(',')!=='Foreign,Main'||!record(facts.people)||Object.keys(facts.people).sort().join(',')!=='Employee,Foreign,HR,Inactive,Manager,Other')fail();
  companies=Object.entries(facts.companies).map(([key,id])=>company(id,'PERSONNEL15-'+key,'Personnel15 fictional '+key));
  actors=Object.entries(facts.people).map(([key,row])=>{if(!record(row)||!uuid(row.userId)||!uuid(row.personId)||!uuid(row.employmentId)||row.employeeCode!=='PR15-'+key.toUpperCase()||row.login!=='personnel15-fixture:'+key||row.companyId!==facts.companies[key==='Foreign'?'Foreign':'Main'])fail();return {id:row.userId,personId:row.personId,employmentId:row.employmentId,companyId:row.companyId,employeeCode:row.employeeCode,...(key==='Inactive'?{allowBlocked:true}:{}),login:row.login,grants:[grant(key==='HR'?'hr_admin':key==='Manager'?'manager':'employee',row.companyId)]};});
 }else if(scenario==='inquiry'){
  if(!record(facts.companies)||Object.keys(facts.companies).sort().join(',')!=='A,B,Empty,Hidden'||!Array.isArray(facts.users)||facts.users.length!==3||!Array.isArray(facts.people)||facts.people.length!==30)fail();
  companies=Object.entries(facts.companies).map(([key,id])=>company(id,'INQUIRY15-'+key,'Inquiry fixture '+key));
  actors=facts.users.map(row=>{if(!record(row)||!uuid(row.userId)||!['inquiry15-fixture:hr','inquiry15-fixture:manager','inquiry15-fixture:employee-00'].includes(row.login))fail();const key=row.login.slice('inquiry15-fixture:'.length),subject=facts.people.find(value=>value.key===key);if(!subject||!uuid(subject.personId)||!uuid(subject.employmentId)||subject.companyId!==facts.companies[key==='hr'?'Hidden':'A'])fail();return {id:row.userId,personId:subject.personId,employmentId:subject.employmentId,companyId:subject.companyId,login:row.login,grants:key==='hr'?[grant('hr_admin',facts.companies.A),grant('hr_admin',facts.companies.B),grant('hr_admin',facts.companies.Empty),grant('employee',facts.companies.Hidden)]:[grant(key==='manager'?'manager':'employee',facts.companies.A)]};});
 }else fail();
 if(new Set(companies.map(row=>row.id)).size!==companies.length||new Set(companies.map(row=>(row.tenantId??'demo')+':'+(row.label??row.id))).size!==companies.length||new Set(actors.map(row=>row.id)).size!==actors.length||new Set(actors.map(row=>row.login)).size!==actors.length||actors.some(row=>row.grants.some(value=>value.companyId!==null&&!uuid(value.companyId))))fail();
 return {companies:companies.sort((a,b)=>a.id.localeCompare(b.id)),actors:actors.sort((a,b)=>a.id.localeCompare(b.id))};
}
export function original18FixtureTenants(scenario,fixture){
 const system={id:'00000000-0000-0000-0000-000000000000',name:'System (auth audit)'};
 if(scenario==='labels'){
  const names=['Labels18 Primary (fictional)','Labels18 Foreign (fictional)'];
  if(!record(fixture)||!Array.isArray(fixture.fixtureTenants)||fixture.fixtureTenants.length!==2||new Set(fixture.fixtureTenants.map(row=>row.id)).size!==2||names.some(name=>!fixture.fixtureTenants.some(row=>record(row)&&row.name===name&&uuid(row.id)&&![system.id,'11111111-1111-1111-1111-111111111111'].includes(row.id)&&uuid(row.companyId)))||fixture.tenantId!==fixture.fixtureTenants.find(row=>row.name===names[0])?.id)fail();
  return [system,...fixture.fixtureTenants.map(row=>({id:row.id,name:row.name}))];
 }
 if(scenario==='reports'){
  if(!record(fixture)||!uuid(fixture.tenantId)||[system.id,'11111111-1111-1111-1111-111111111111'].includes(fixture.tenantId)||fixture.tenantName!=='Reports18 fictional primary tenant'||!record(fixture.foreignTenant)||!uuid(fixture.foreignTenant.id)||[system.id,'11111111-1111-1111-1111-111111111111'].includes(fixture.foreignTenant.id)||fixture.foreignTenant.id===fixture.tenantId||fixture.foreignTenant.name!=='Reports18 fictional foreign tenant')fail();
  return [system,{id:fixture.tenantId,name:fixture.tenantName},{id:fixture.foreignTenant.id,name:fixture.foreignTenant.name}];
 }
 return [system,{id:'11111111-1111-1111-1111-111111111111',name:'Demo Group'}];
}
export function original18ResumeReceiptName(name,candidate){return sha(candidate)&&typeof name==='string'&&/^browser-resume-[0-9a-f]{40}-[0-9]{13}\.json$/.test(name)&&name.startsWith('browser-resume-'+candidate+'-');}
/** Receipt validation proves only local preparation/cleanup, never browser acceptance or authorization. */
export function validateOriginal18Resume({fixture,browser,stopped,resumeRecords={},root,scenario}){
 const target=original18BrowserTarget(['--scenario='+scenario,...(scenario==='personnel'?['--resume']:[])]);
 const bound=row=>record(row)&&row.root===root&&row.scenario===scenario&&row.database===target.database&&row.namespace===target.namespace&&row.port===target.port;
 const preparationBound=row=>scenario==='personnel'||target.fresh?record(row)&&row.root===root&&row.database===target.database&&row.namespace===target.namespace&&row.port===target.port:bound(row);
 if(typeof root!=='string'||!root.startsWith('/')||![fixture,browser,stopped,resumeRecords].every(record)||!preparationBound(fixture)||!preparationBound(browser)||!target.fresh&&fixture.tenantId!=='11111111-1111-1111-1111-111111111111'||browser.fixtureRuns!==2||!sha(browser.candidate)||JSON.stringify(browser.fixture)!==JSON.stringify(fixture))fail();
 if(scenario==='personnel'){if(browser.candidate!==PERSONNEL_PREPARATION.candidate)fail();original18FixtureIdentities(scenario,fixture);}
 else if(target.fresh){
  if(!bound(browser)||fixture.candidate!==browser.candidate||!/^\d{4}-\d{2}-\d{2}$/.test(fixture.date??''))fail();original18FixtureTenants(scenario,fixture);original18FixtureIdentities(scenario,fixture);
  const proof=scenario==='labels'?fixture.sourceProof:fixture.proof;
  if(!record(proof))fail();
  if(scenario==='labels'){if(proof.format!==1||typeof proof.sha256!=='string'||!/^[0-9a-f]{64}$/.test(proof.sha256)||!Array.isArray(proof.paths)||proof.paths.length<1||proof.paths.length>32||proof.paths.some(row=>!record(row)||typeof row.path!=='string'||row.path.includes('..')||!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(row.path)||typeof row.sha256!=='string'||!/^[0-9a-f]{64}$/.test(row.sha256))||new Set(proof.paths.map(row=>row.path)).size!==proof.paths.length)fail();}
  else if(proof.version!==1||!['metadataDigest','stateDigest'].every(key=>typeof proof[key]==='string'&&/^[0-9a-f]{64}$/.test(proof[key]))||!Array.isArray(proof.tables)||proof.tables.length<1||proof.tables.length>64)fail();
 }
 else{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fixture.date??''))fail();const identities=original18FixtureIdentities(scenario,fixture.facts);
  if(JSON.stringify(identities)!==JSON.stringify(fixture.identities)||!Array.isArray(fixture.principals)||fixture.principals.length!==identities.actors.length||fixture.principals.some(row=>!record(row)||!uuid(row.id)||!uuid(row.personId))||new Set(fixture.principals.map(row=>row.id)).size!==identities.actors.length||identities.actors.some(actor=>!fixture.principals.some(row=>row.id===actor.id&&(!actor.personId||row.personId===actor.personId)&&(!actor.employmentId||record(row.employment)&&row.employment.id===actor.employmentId&&row.employment.companyId===actor.companyId&&typeof row.employment.employeeCode==='string'&&row.employment.employeeCode.length>0&&(actor.employeeCode===undefined||row.employment.employeeCode===actor.employeeCode)))))fail();
 }
 const preparationBrowserDigest=hash(browser),preparationFixtureDigest=hash(fixture),visited=new Set(),names=Object.keys(resumeRecords);
 if(names.length>64)fail();
 const visit=stop=>{
  if(scenario==='personnel'&&Object.keys(stop).sort().join(',')==='candidate,database,ownedServerStopped,port,stoppedAt'){
   if(stop.candidate!==PERSONNEL_PREPARATION.candidate||stop.database!==target.database||stop.port!==target.port||stop.ownedServerStopped!==true||stop.stoppedAt!==PERSONNEL_PREPARATION.stoppedAt)fail();return;
  }
  if(!bound(stop)||!sha(stop.candidate)||stop.preparationCandidate!==browser.candidate||stop.ownedServerStopped!==true||stop.cleanupSucceeded!==true||!['stopped','failed'].includes(stop.outcome)||stop.exitCode!==(stop.outcome==='failed'?1:0)||!Number.isSafeInteger(stop.serverPid)||stop.serverPid<=1||typeof stop.stoppedAt!=='string'||!Number.isFinite(Date.parse(stop.stoppedAt)))fail();
  if(stop.resumeReceipt===undefined){if(stop.candidate!==browser.candidate)fail();return;}
  const name=stop.resumeReceipt,previous=resumeRecords[name];
  if(!original18ResumeReceiptName(name,stop.candidate)||visited.has(name)||!bound(previous)||previous.candidate!==stop.candidate||previous.preparationCandidate!==browser.candidate||previous.preparationBrowserDigest!==preparationBrowserDigest||previous.preparationFixtureDigest!==preparationFixtureDigest||!record(previous.priorStoppedReceipt)||previous.resumedFromCandidate!==previous.priorStoppedReceipt.candidate||previous.fixtureRunsThisCandidate!==0||previous.migrationRunsThisCandidate!==0||previous.seedRunsThisCandidate!==0||previous.preparationManifest!=='browser-manifest.json'||previous.applicationAcceptance!=='UNVERIFIED'||typeof previous.resumedAt!=='string'||!Number.isFinite(Date.parse(previous.resumedAt)))fail();
  visited.add(name);visit(previous.priorStoppedReceipt);
 };
 visit(stopped);if(names.some(name=>!visited.has(name)))fail();
 return {preparationCandidate:browser.candidate,resumedFromCandidate:stopped.candidate,preparationBrowserDigest,preparationFixtureDigest};
}
