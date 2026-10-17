/** Fictional local 9689f5d3 preparation only. No observations, feedback, screenshots or catalogue acceptance.
 * Canonical owners write business facts. Direct owner writes are ONLY fictional login/grant fixtures.
 * A second run checks the immutable receipt and complete bounded fixture state; it never repairs drift.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import type {InstructionDefinition} from '../lib/system-testing/model';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard';
import {SYSTEM_TESTING_BROWSER_TARGET} from './system-testing-browser-target.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const {database,namespace,port,scratchpad}=SYSTEM_TESTING_BROWSER_TARGET,out=path.join(root,scratchpad);
const receiptPath=path.join(out,'fixture-manifest.json');
const refusal=demoSeedRefusal(process.env);
if(refusal||process.env.NODE_ENV==='production')throw new Error(refusal??'Development only.');
if(process.argv.length!==2||process.env.AUTH_PROVIDER!=='workos'||process.env.TEST_DB_NAMESPACE!==namespace||process.env.PORT!==port)throw new Error('Use the exact fictional System Testing coordinator target.');
const urls:Record<string,URL>={};
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']) {
 let url:URL;try{url=new URL(process.env[key]??'');}catch{throw new Error('Local credentials required.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/'+database||url.hash||[...url.searchParams].some(([k,v])=>k!=='sslmode'||v!=='disable'))throw new Error('Only the exact named localhost:5433 target is allowed.');
 urls[key]=url;
}
if(decodeURIComponent(urls.DATABASE_URL.username)!=='ai_hr_app'||urls.DATABASE_URL.username===urls.MIGRATION_DATABASE_URL.username)throw new Error('Restricted app and distinct migration credentials required.');
const candidate=process.env.SYSTEM_TESTING_FIXTURE_CANDIDATE;
if(!candidate||!/^[a-f0-9]{40}$/.test(candidate)||String(process.ppid)!==process.env.SYSTEM_TESTING_FIXTURE_COORDINATOR_PID)throw new Error('Use the live named coordinator, not a standalone fixture.');
const ancestors=new Set<number>();let ancestor=process.ppid;
for(let depth=0;ancestor>1&&depth<64;depth++) {if(ancestors.has(ancestor))throw new Error('Invalid process ancestry.');ancestors.add(ancestor);ancestor=Number(execFileSync('ps',['-o','ppid=','-p',String(ancestor)],{encoding:'utf8'}).trim());if(!Number.isSafeInteger(ancestor)||ancestor<0)throw new Error('Unproven coordinator ancestry.');}
for(const [directory,expected]of [['locks',namespace+'-browser-a'],['locks',namespace+'-browser-b'],['devdb-locks',namespace+'-browser-db']]) {
 const base=path.join(os.homedir(),'.aihr-gate-state',directory);
 const held=fsSync.readdirSync(base).filter(n=>n.startsWith('slot.')).some(n=>{try{const dir=path.join(base,n),pid=Number(fsSync.readFileSync(path.join(dir,'pid'),'utf8').trim());if(fsSync.readFileSync(path.join(dir,'name'),'utf8').trim()!==expected||!ancestors.has(pid))return false;process.kill(pid,0);return true;}catch{return false;}});
 if(!held)throw new Error('Required live coordinator lock missing: '+expected);
}
function frozen(){if(execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trim()||execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==candidate)throw new Error('Candidate changed or is dirty; preserve target.');}
frozen();
const {createDb,client}=await import('../db/client');
const s=await import('../db/schema');
const {resolveEntitlementsTx,isModuleEnabled}=await import('../core/entitlements');
const {provisionTenant}=await import('../db/provision');
const {createCompany,createDepartment}=await import('../core/admin');
const {hireEmployee,setReportingLine}=await import('../core/org');
const {saveTestInstructionDraft,publishTestInstruction,assignTestingCase}=await import('../core/system-testing-workspace');
const owner=createDb(process.env.MIGRATION_DATABASE_URL!,{max:1});
const locales=['en','ms','zh','ta','th','vi'] as const;
const tenantNames={primary:'SystemTesting16 fictional primary',foreign:'SystemTesting16 fictional foreign',off:'SystemTesting16 fictional unentitled'} as const;
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value)??'null';}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
type Principal={tenantId:string;userId:string;personId:string|null;employmentId:string|null;companyId:string|null;login:string;role:'hr_admin'|'employee'|'manager'};
async function context(p:Principal):Promise<SessionContext> {
 const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,p.tenantId),eq(s.roleAssignment.appUserId,p.userId))).orderBy(asc(s.roleAssignment.id));
 const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,p.tenantId));
 return {tenantId:p.tenantId,userId:p.userId,personId:p.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements};
}
// Closed owner read list, bounded row count, digest only. Never serialize credentials or invitation tokens.
const stateTables=['tenant_module','tenant_setting','company','department','person','employment','reporting_line','app_user','role_assignment','test_case','test_case_version','test_assignment','test_execution','test_run','test_execution_attachment','test_catalogue_update','feedback_request','feedback_attachment','domain_event'] as const;
async function stateDigest(ids:string[]) {
 return owner.client.begin('isolation level repeatable read read only',async tx=>{
  const state:Record<string,unknown>={};
  state.tenant=(await tx`SELECT to_jsonb(t) AS row FROM public.tenant t WHERE id=ANY(${ids}::uuid[]) ORDER BY id`).map(r=>r.row);
  for(const table of stateTables) {
   const [count]=await tx.unsafe(`SELECT count(*)::integer AS n FROM public.${table} WHERE tenant_id=ANY($1::uuid[])`,[ids]);
   if(count.n>2000)throw new Error('Fictional state exceeds bounded receipt inventory; no clean-twice claim.');
   // tenant_setting has a compound key, not id. Whole-row JSON order also retains every exact value.
   const rows=await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public.${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY to_jsonb(t)::text`,[ids]);
   state[table]=rows.map(r=>r.row);
  }
  return digest(state);
 });
}
async function main() {
 const [role]=await client`select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
 if(role?.name!=='ai_hr_app'||role.rolsuper||role.rolbypassrls)throw new Error('Restricted application principal proof failed.');
 const [migrationRole]=await owner.client`select current_user as name`;
 if(migrationRole?.name!==decodeURIComponent(urls.MIGRATION_DATABASE_URL.username))throw new Error('Migration principal differs.');
 let previous:Record<string,unknown>|null=null;
 try{const st=await fs.lstat(receiptPath);if(!st.isFile()||st.isSymbolicLink()||st.size>1048576)throw new Error('Invalid receipt file.');previous=JSON.parse(await fs.readFile(receiptPath,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const tenants=await owner.db.select({id:s.tenant.id,name:s.tenant.name}).from(s.tenant).orderBy(asc(s.tenant.id));
 if(tenants.length>5)throw new Error('Unexpected tenant count; preserve target.');
 if(previous) {
  const bound=previous.fixtureTenants;
  if(previous.format!==1||previous.root!==root||previous.database!==database||previous.namespace!==namespace||previous.port!==Number(port)||previous.candidate!==candidate||!Array.isArray(bound)||bound.length!==3||typeof previous.stateDigest!=='string')throw new Error('Receipt differs from exact candidate/target.');
  const expectedNames=Object.values(tenantNames);
  if(bound.some((t:unknown)=>!t||typeof t!=='object'||typeof (t as {id?:unknown}).id!=='string'||!expectedNames.includes((t as {name:typeof expectedNames[number]}).name))||new Set(bound.map(t=>t.id)).size!==3||new Set(bound.map(t=>t.name)).size!==3)throw new Error('Invalid receipt tenant binding.');
  const allowed=new Map([[DEMO_TENANT_ID,'Demo Group'],[SYSTEM_TENANT_ID,'System (auth audit)'],...bound.map(t=>[t.id,t.name])]);
  if(tenants.some(t=>allowed.get(t.id)!==t.name)||bound.some(t=>!tenants.some(actual=>actual.id===t.id&&actual.name===t.name)))throw new Error('Tenant drift; preserve target.');
  if(await stateDigest(bound.map(t=>t.id))!==previous.stateDigest)throw new Error('Fixture business state changed; no repair or reset is permitted.');
  frozen();console.log('SYSTEM_TESTING16_MANIFEST\n'+JSON.stringify({...previous,reused:true},null,2));return;
 }
 if(!tenants.some(t=>t.id===DEMO_TENANT_ID&&t.name==='Demo Group')||tenants.some(t=>t.id!==DEMO_TENANT_ID&&t.id!==SYSTEM_TENANT_ID))throw new Error('Only the seeded demo and System tenants may precede this fixture.');
 const fixtureTenants:{id:string;name:string;companyId:string;moduleEnabled:boolean}[]=[],people:Record<string,Principal>={};
 for(const key of ['primary','foreign','off'] as const) {
  const made=await owner.db.transaction(tx=>provisionTenant(tx,{name:tenantNames[key],adminEmail:`systemtesting16-${key}@demo.test`,country:'MY',modules:key==='off'?[]:['system_testing'],baseUrl:'http://127.0.0.1:'+port}));
  // Canonical activation URL is discarded. No notification/identity transport runs in this fixture.
  await owner.db.insert(s.roleAssignment).values({tenantId:made.tenantId,appUserId:made.appUserId,companyId:null,role:'hr_admin'});
  const user=await owner.db.select({login:s.appUser.workosUserId}).from(s.appUser).where(eq(s.appUser.id,made.appUserId));
  if(user.length!==1)throw new Error('Provisioned principal missing.');
  const actor={tenantId:made.tenantId,userId:made.appUserId,personId:made.personId,employmentId:null,companyId:null,login:user[0].login,role:'hr_admin' as const};
  people[key==='primary'?'HR':key==='foreign'?'ForeignHR':'DisabledHR']=actor;
  const enabled=isModuleEnabled(await context(actor),'system_testing');if(enabled!==(key!=='off'))throw new Error('Canonical module entitlement differs.');
  fixtureTenants.push({id:made.tenantId,name:tenantNames[key],companyId:made.companyId,moduleEnabled:enabled});
 }
 const hr=await context(people.HR),tenantId=people.HR.tenantId,primary=fixtureTenants.find(t=>t.id===tenantId);
 if(!primary)throw new Error('Primary tenant binding missing.');
 const companyId=primary.companyId;
 const otherCompany=await createCompany(hr,{legalName:'SystemTesting16 fictional other company',companyLabel:'ST16-OTHER',country:'MY',currency:'MYR'});
 const department=await createDepartment(hr,{companyId,name:'SystemTesting16 fictional team'});
 for(const key of ['TesterA','TesterB','ScopedHR','UserOnly','Empty'] as const) {
  let personId:string|null=null,employmentId:string|null=null;
  const userOnly=key==='UserOnly'||key==='Empty';
  if(!userOnly) {
   const made=await hireEmployee(hr,{person:{fullName:'SystemTesting16 '+key,primaryEmail:`systemtesting16-${key.toLowerCase()}@demo.test`},employeeCode:'ST16-'+key.toUpperCase(),companyId,departmentId:department.id,employmentType:'full_time',hiredOn:'2026-01-01'});
   personId=made.personId;employmentId=made.employmentId;
  }
  const role=key==='TesterB'?'manager' as const:key==='ScopedHR'?'hr_admin' as const:'employee' as const,login='systemtesting16-fixture:'+key;
  const [user]=await owner.db.insert(s.appUser).values({tenantId,personId,workosUserId:login,onboardedAt:new Date()}).returning({id:s.appUser.id});
  await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:user.id,companyId,role});
  people[key]={tenantId,userId:user.id,personId,employmentId,companyId,login,role};
 }
 const employeeId=people.TesterA.employmentId,managerId=people.TesterB.employmentId;
 if(!employeeId||!managerId)throw new Error('Canonical fictional employments missing.');
 await setReportingLine(hr,{subordinateEmploymentId:employeeId,managerEmploymentId:managerId,lineType:'administrative',validFrom:'2026-01-01'});
 function definition(key:string,active=true):InstructionDefinition {
  return {format:1,title:'SystemTesting16 '+key,objective:'Record only the fictional screen behavior actually observed.',functionKey:'systemtesting.fixture.'+key.toLowerCase(),area:'system_settings',moduleCode:'system_testing',category:'functional',priority:'medium',active,prerequisites:['Use your own explicitly assigned fictional login.'],testData:['No production people, payroll amounts or delivery credentials.'],steps:[{id:'open',action:'Open My Testing and the assigned fictional guide.',expected:'The current instruction version and own execution controls are visible.'},{id:'observe',action:'Compare the visible result, write an honest observation and save it.',expected:'Reopen shows your saved observation; other testers retain independent history.'}],expectedBehavior:'Own results stay tied to the exact published instruction version.',expectedFunction:'Versioned personal execution without granting business permissions.',permissions:['An active assignment to the actual signed-in app user; business access remains unchanged.'],jurisdiction:null,configuration:'Fictional local acceptance setup, not a completed test.',screenKeys:['mySystemTesting']};
 }
 const cases:Record<string,{caseId:string;versionId:string|null;ordinal:number|null;draftRevision:number;priorVersionId?:string;assignments:Record<string,{assignmentId:string;revision:number}>}>={};
 for(const key of ['Shared','History','Unassigned','Inactive','Incomplete']) {
  const d=definition(key,key!=='Inactive');if(key==='Incomplete'){d.objective='';d.steps=[{id:'unfinished',action:'',expected:''}];d.permissions=[];}
  const saved=await saveTestInstructionDraft(hr,{caseId:null,expectedRevision:0,definition:d});
  const published=key==='Incomplete'?null:await publishTestInstruction(hr,{caseId:saved.caseId,expectedDraftRevision:saved.revision,expectedVersionId:null});
  const item={caseId:saved.caseId,versionId:published?.versionId??null,ordinal:published?.ordinal??null,draftRevision:published?.draftRevision??saved.revision,assignments:{}} as typeof cases[string];
  if(key==='History'&&published) {
   const next=await saveTestInstructionDraft(hr,{caseId:saved.caseId,expectedRevision:published.draftRevision,definition:{...d,title:d.title+' version two',steps:[...d.steps,{id:'history',action:'Open the prior published instructions.',expected:'Version one remains immutable and separately labeled.'}]}});
   const v2=await publishTestInstruction(hr,{caseId:saved.caseId,expectedDraftRevision:next.revision,expectedVersionId:published.versionId});
   item.priorVersionId=published.versionId;item.versionId=v2.versionId;item.ordinal=v2.ordinal;item.draftRevision=v2.draftRevision;
  }
  const testers=key==='Shared'?['TesterA','TesterB','UserOnly']:key==='History'?['TesterA']:key==='Inactive'?['TesterA']:[];
  if(testers.length&&!item.versionId)throw new Error('Published assignment target missing.');
  for(const tester of testers){if(!item.versionId)throw new Error('Assignment version missing.');item.assignments[tester]=await assignTestingCase(hr,{caseId:item.caseId,testerUserId:people[tester].userId,expectedVersionId:item.versionId,active:true,expectedRevision:null});}
  cases[key]=item;
 }
 const ids=fixtureTenants.map(t=>t.id);
 for(const table of ['test_execution','test_run','test_execution_attachment','test_catalogue_update','feedback_request'] as const){const [count]=await owner.client.unsafe(`SELECT count(*)::integer AS n FROM public.${table} WHERE tenant_id=ANY($1::uuid[])`,[ids]);if(count.n!==0)throw new Error('Preparation must not fabricate observations, feedback or catalogue acceptance.');}
 const manifest={format:1,root,database,namespace,port:Number(port),candidate,tenantId,fixtureTenants,companyId,otherCompanyId:otherCompany.id,people,cases,locales,stateDigest:await stateDigest(ids),routes:{library:'/admin/system-testing',team:'/admin/system-testing?tab=team',updates:'/admin/system-testing?tab=updates',personal:'/system-testing',newCase:'/admin/system-testing/new',feedback:'/feedback'},preparedOnly:true,observationsCreated:0,cataloguePreloaded:false,screenshotsCreated:0,sourceBuildArrivalVerified:false};
 frozen();await fs.mkdir(out,{recursive:true});await fs.writeFile(receiptPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('SYSTEM_TESTING16_MANIFEST\n'+JSON.stringify({...manifest,reused:false},null,2));
}
try{await main();}finally{await owner.client.end();await client.end();}
// Keep imported development pools from retaining the process after a successful bounded fixture.
await new Promise<void>(resolve=>process.stdout.write('',()=>resolve()));process.exit(0);
