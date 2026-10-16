import {createHash} from 'node:crypto';
/** Closed acceptance targets. No arbitrary DB/path/port/fixture overrides. */
export const PERSONNEL_PREPARATION=Object.freeze({candidate:'299ccd2d6891de62149f5205cac81522b1076dea',pid:85618,stoppedAt:'2026-10-16T06:47:37.642Z',fixtureBytes:'fb7e3b34ffe6fc52711ee79cfe527056e80ab5146954f93f89d693faa87463af',browserBytes:'ed4d059f72617c7c7c0dfd0f14d36464a72e325c3b978696021ab9d91e8ace40',stopBytes:'b7971ba79002ef1667990ece31a07c0ecb830bb29f90507bb4005e1ce778f7f1',runnerBytes:'d7bc178a2de94d4db3c125625b79c091b3f7d92f16f3d657fdd6fd941498e0d6'});
export const ORIGINAL18_BROWSER_TARGETS=Object.freeze({
 schedules:Object.freeze({database:'ai_hr_board15schedules_browser',port:3192,namespace:'board15schedules',fixture:'dev-fixture-board15-schedules.ts',route:'/admin/attendance/settings'}),
 holidays:Object.freeze({database:'ai_hr_board15holiday_browser',port:3193,namespace:'board15holidays',fixture:'dev-fixture-board15-holidays.ts',route:'/admin/holidays/replacements'}),
 approval:Object.freeze({database:'ai_hr_board15_approval_browser',port:3195,namespace:'board15approval',fixture:'dev-fixture-attendance-hierarchy.ts',route:'/approvals'}),
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
 if(scenario==='schedules'){
  companies=[company(facts.companyId,'BOARD15-SCHEDULES','Schedule board review (fictional)')];
  if(!Array.isArray(facts.groups)||facts.groups.length!==2||facts.groups.some(row=>!record(row)||!uuid(row.id))||!Array.isArray(facts.shifts)||facts.shifts.length!==2||facts.shifts.some(row=>!record(row)||!uuid(row.id))||!Array.isArray(facts.logins)||facts.logins.length!==4)fail();
  actors=facts.logins.map(row=>{if(!record(row)||!['hr','manager','fixed','flexi'].includes(row.key)||!uuid(row.id)||row.key!=='hr'&&!uuid(row.employmentId))fail();return {id:row.id,login:'board15-schedules:'+row.key,employmentId:row.employmentId??null,grants:[grant(row.key==='hr'?'hr_admin':row.key==='manager'?'manager':'employee',row.key==='hr'?null:facts.companyId)]};});
 }else if(scenario==='holidays'){
  if(!Array.isArray(facts.scenarios)||facts.scenarios.length!==5||!Array.isArray(facts.logins)||facts.logins.length!==6)fail();
  companies=facts.scenarios.map(row=>{if(!record(row)||!['A','B','C','REVIEW','EMPTY'].includes(row.key))fail();return company(row.companyId,'BOARD15-HOLIDAY-'+row.key,`Replacement holiday ${row.key} (fictional)`);});
  const a=facts.scenarios.find(row=>row.key==='A');
  actors=facts.logins.map(row=>{if(!record(row)||!['hr','scoped-hr','a','b','c','review'].includes(row.key)||!uuid(row.id))fail();const subject=facts.scenarios.find(value=>value.key.toLowerCase()===row.key);if(subject&&(!uuid(row.employmentId)||row.employmentId!==subject.employmentId||row.id!==subject.userId))fail();return {id:row.id,login:'board15-holidays:'+row.key,employmentId:row.employmentId??null,grants:[grant(row.key==='hr'||row.key==='scoped-hr'?'hr_admin':'employee',row.key==='hr'?null:row.key==='scoped-hr'?a?.companyId:subject?.companyId)]};});
 }else if(scenario==='approval'){
  if(!record(facts.companies)||Object.keys(facts.companies).sort().join(',')!=='Empty,Foreign,Main'||!record(facts.people)||Object.keys(facts.people).sort().join(',')!=='A,Arjun,D,D2,Daniel,ForeignHR,HR,NoSuperior,OtherHR')fail();
  companies=Object.entries(facts.companies).map(([key,id])=>company(id,'APPROVAL15-'+key,'Approval hierarchy fixture '+key));
  actors=Object.entries(facts.people).map(([key,row])=>{if(!record(row)||!uuid(row.userId)||!uuid(row.personId)||!uuid(row.employmentId)||row.login!=='approval15-fixture:'+key)fail();const role=['HR','OtherHR','ForeignHR'].includes(key)?'hr_admin':['D','D2','NoSuperior'].includes(key)?'employee':'manager';return {id:row.userId,personId:row.personId,employmentId:row.employmentId,login:row.login,grants:[grant(role,facts.companies[key==='ForeignHR'?'Foreign':'Main']),...(key==='HR'?[grant('hr_admin',facts.companies.Empty)]:[])]};});
 }else if(scenario==='personnel'){
  if(!record(facts.companies)||Object.keys(facts.companies).sort().join(',')!=='Foreign,Main'||!record(facts.people)||Object.keys(facts.people).sort().join(',')!=='Employee,Foreign,HR,Inactive,Manager,Other')fail();
  companies=Object.entries(facts.companies).map(([key,id])=>company(id,'PERSONNEL15-'+key,'Personnel15 fictional '+key));
  actors=Object.entries(facts.people).map(([key,row])=>{if(!record(row)||!uuid(row.userId)||!uuid(row.personId)||!uuid(row.employmentId)||row.employeeCode!=='PR15-'+key.toUpperCase()||row.login!=='personnel15-fixture:'+key||row.companyId!==facts.companies[key==='Foreign'?'Foreign':'Main'])fail();return {id:row.userId,personId:row.personId,employmentId:row.employmentId,login:row.login,grants:[grant(key==='HR'?'hr_admin':key==='Manager'?'manager':'employee',row.companyId)]};});
 }else if(scenario==='inquiry'){
  if(!record(facts.companies)||Object.keys(facts.companies).sort().join(',')!=='A,B,Empty,Hidden'||!Array.isArray(facts.users)||facts.users.length!==3||!Array.isArray(facts.people)||facts.people.length!==30)fail();
  companies=Object.entries(facts.companies).map(([key,id])=>company(id,'INQUIRY15-'+key,'Inquiry fixture '+key));
  actors=facts.users.map(row=>{if(!record(row)||!uuid(row.userId)||!['inquiry15-fixture:hr','inquiry15-fixture:manager','inquiry15-fixture:employee-00'].includes(row.login))fail();const key=row.login.slice('inquiry15-fixture:'.length),subject=facts.people.find(value=>value.key===key);if(!subject||!uuid(subject.personId)||!uuid(subject.employmentId))fail();return {id:row.userId,personId:subject.personId,employmentId:subject.employmentId,login:row.login,grants:key==='hr'?[grant('hr_admin',facts.companies.A),grant('hr_admin',facts.companies.B),grant('hr_admin',facts.companies.Empty),grant('employee',facts.companies.Hidden)]:[grant(key==='manager'?'manager':'employee',facts.companies.A)]};});
 }else fail();
 if(new Set(companies.map(row=>row.id)).size!==companies.length||new Set(companies.map(row=>row.label)).size!==companies.length||new Set(actors.map(row=>row.id)).size!==actors.length||new Set(actors.map(row=>row.login)).size!==actors.length||actors.some(row=>row.grants.some(value=>value.companyId!==null&&!uuid(value.companyId))))fail();
 return {companies:companies.sort((a,b)=>a.id.localeCompare(b.id)),actors:actors.sort((a,b)=>a.id.localeCompare(b.id))};
}
export function original18ResumeReceiptName(name,candidate){return sha(candidate)&&typeof name==='string'&&/^browser-resume-[0-9a-f]{40}-[0-9]{13}\.json$/.test(name)&&name.startsWith('browser-resume-'+candidate+'-');}
/** Receipt validation proves only local preparation/cleanup, never browser acceptance or authorization. */
export function validateOriginal18Resume({fixture,browser,stopped,resumeRecords={},root,scenario}){
 const target=original18BrowserTarget(['--scenario='+scenario,...(scenario==='personnel'?['--resume']:[])]);
 const bound=row=>record(row)&&row.root===root&&row.scenario===scenario&&row.database===target.database&&row.namespace===target.namespace&&row.port===target.port;
 const preparationBound=row=>scenario==='personnel'?record(row)&&row.root===root&&row.database===target.database&&row.namespace===target.namespace&&row.port===target.port:bound(row);
 if(typeof root!=='string'||!root.startsWith('/')||![fixture,browser,stopped,resumeRecords].every(record)||!preparationBound(fixture)||!preparationBound(browser)||fixture.tenantId!=='11111111-1111-1111-1111-111111111111'||browser.fixtureRuns!==2||!sha(browser.candidate)||JSON.stringify(browser.fixture)!==JSON.stringify(fixture))fail();
 if(scenario==='personnel'){if(browser.candidate!==PERSONNEL_PREPARATION.candidate)fail();original18FixtureIdentities(scenario,fixture);}
 else{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(fixture.date??''))fail();const identities=original18FixtureIdentities(scenario,fixture.facts);
  if(JSON.stringify(identities)!==JSON.stringify(fixture.identities)||!Array.isArray(fixture.principals)||fixture.principals.length!==identities.actors.length||fixture.principals.some(row=>!record(row)||!uuid(row.id)||!uuid(row.personId))||new Set(fixture.principals.map(row=>row.id)).size!==identities.actors.length||identities.actors.some(actor=>!fixture.principals.some(row=>row.id===actor.id&&(!actor.personId||row.personId===actor.personId))))fail();
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
