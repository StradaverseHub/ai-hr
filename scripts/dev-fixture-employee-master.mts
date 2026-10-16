/** Fictional local Employee Master setup. Only the held original18 coordinator may run it.
 * Fresh migrated System-only database; NO db:seed. No saved report, run, consent or delivery is made.
 * Complete second invocation reads/proves identical setup; interrupted or changed setup refuses.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {and,asc,eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {REPORT_FIXTURE_DATABASE as database,REPORT_FIXTURE_NAMESPACE as namespace,REPORT_FIXTURE_PORT as port,REPORT_FIXTURE_TENANT_NAME,REPORT_FIXTURE_FOREIGN_NAME,reportFixtureUrls,reportFixtureDigest,readEmployeeMasterFixtureProof} from './employee-master-fixture-proof.mjs';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const out=path.join(root,'scratchpad/board18-reports'),manifestFile=path.join(out,'fixture-manifest.json');
const SYSTEM='00000000-0000-0000-0000-000000000000';
const urls=reportFixtureUrls(process.env);
if(process.argv.length!==2)throw new Error('Reports fixture accepts no caller target or setup overrides.');
if(process.env.REPORT_FIXTURE_COORDINATOR_PID!==String(process.ppid)||!process.env.REPORT_FIXTURE_COORDINATOR_CANDIDATE)throw new Error('Use the declared immediate live Reports coordinator.');
const ancestors=new Set<number>();let ancestor=process.ppid;
for(let depth=0;ancestor>1&&depth<64;depth++){
 if(ancestors.has(ancestor))throw new Error('Invalid coordinator ancestry.');ancestors.add(ancestor);
 ancestor=Number(execFileSync('ps',['-o','ppid=','-p',String(ancestor)],{encoding:'utf8'}).trim());
 if(!Number.isSafeInteger(ancestor)||ancestor<0)throw new Error('Unproven coordinator ancestry.');
}
for(const [directory,name] of [['locks','board18reports-browser-a'],['locks','board18reports-browser-b'],['devdb-locks','board18reports-browser-db']]){
 const base=path.join(os.homedir(),'.aihr-gate-state',directory);
 const held=fsSync.readdirSync(base).filter(entry=>entry.startsWith('slot.')).some(entry=>{try{
  const lock=path.join(base,entry),pid=Number(fsSync.readFileSync(path.join(lock,'pid'),'utf8').trim());
  if(fsSync.readFileSync(path.join(lock,'name'),'utf8').trim()!==name||!ancestors.has(pid))return false;process.kill(pid,0);return true;
 }catch{return false;}});
 if(!held)throw new Error('Required live Reports coordinator lock missing.');
}
function candidate(){
 const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 if(!/^[0-9a-f]{40}$/.test(head)||head!==process.env.REPORT_FIXTURE_COORDINATOR_CANDIDATE||execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8'}).trim())throw new Error('Reports fixture candidate is dirty or changed.');return head;
}
const sourceCandidate=candidate();
// No runtime DB/owner imports until all target/process/source guards have passed.
const {createDb,client}=await import('../db/client');
const s=await import('../db/schema');
const {provisionTenant}=await import('../db/provision');
const {resolveEntitlementsTx,isModuleEnabled}=await import('../core/entitlements');
const {createCompany,createDepartment,assignRole}=await import('../core/admin');
const {hireEmployee,terminateEmployment}=await import('../core/org');
const {setCompensation}=await import('../core/comp'); // canonical kernel salary spine, not a pack-owned writer
const {createMovementEvent}=await import('../core/movement');
const {addDependent}=await import('../core/dependents');
const {addQualification}=await import('../core/qualifications');
const {createConfig}=await import('../core/employee-id-config');
const {createEmployeeDraftWithReservedCode,saveEmployeeDraft}=await import('../core/employee-draft');
const {setPayrollPermissionGrant}=await import('../packs/payroll/service');
const {requirePackFor}=await import('../localization/registry');
const {todayInKualaLumpur}=await import('../lib/hr-date');
const owner=createDb(process.env.MIGRATION_DATABASE_URL!);
type Principal={tenantId:string;personId:string;employmentId:string|null;employeeCode:string|null;companyId:string|null;userId:string;login:string;grants:{role:string;companyId:string|null}[]};
type Subject={personId:string;employmentId:string;employeeCode:string;companyId:string;basicSalary:number};
async function context(user:{id:string;tenantId:string;personId:string|null}):Promise<SessionContext>{
 const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,user.tenantId),eq(s.roleAssignment.appUserId,user.id))).orderBy(asc(s.roleAssignment.id));
 const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,user.tenantId));
 return {tenantId:user.tenantId,userId:user.id,personId:user.personId,grants,roles:[...new Set(grants.map(row=>row.role))],entitlements};
}
async function privateDirectory(){
 if(await fs.realpath(root)!==root)throw new Error('Reports root must be its actual owned checkout.');
 const scratch=path.join(root,'scratchpad');await fs.mkdir(scratch,{recursive:true});const parent=await fs.lstat(scratch);
 if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o022)!==0)throw new Error('Unsafe Reports scratch parent.');
 await fs.mkdir(out,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});const stat=await fs.lstat(out);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())throw new Error('Reports receipt directory is not privately owned.');await fs.chmod(out,0o700);
}
async function previousManifest(){
 try{const stat=await fs.lstat(manifestFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1_000_000)throw new Error('Unsafe Reports manifest.');return await fs.readFile(manifestFile,'utf8');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
async function emit(text:string){await new Promise<void>((resolve,reject)=>process.stdout.write('REPORT18_MANIFEST\n'+text,error=>error?reject(error):resolve()));}
const shift=(date:string,days:number)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
const month=(date:string,offset:number)=>{const d=new Date(date+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+offset,1);return d.toISOString().slice(0,10);};
async function main(){
 const [appRole]=await client`select current_user as name,current_database() as database,inet_server_addr()::text as server_addr,inet_server_port() as server_port,(select oid::text from pg_database where datname=current_database()) as database_oid,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
 const [ownerRole]=await owner.client`select current_user as name,current_database() as database,inet_server_addr()::text as server_addr,inet_server_port() as server_port,(select oid::text from pg_database where datname=current_database()) as database_oid`;
 if(appRole?.name!=='ai_hr_app'||appRole.rolsuper||appRole.rolbypassrls||appRole.database!==database||ownerRole?.database!==database||ownerRole.name!==decodeURIComponent(urls.owner.username)||!['127.0.0.1','::1'].includes(appRole.server_addr)||appRole.server_port!==5433||ownerRole.server_addr!==appRole.server_addr||ownerRole.server_port!==appRole.server_port||ownerRole.database_oid!==appRole.database_oid)throw new Error('Actual Reports role/database proof refused.');
 await privateDirectory();const previousText=await previousManifest();const date=todayInKualaLumpur();
 if(previousText){
  const previous=JSON.parse(previousText) as {root:string;candidate:string;database:string;namespace:string;port:number;date:string;tenantId:string;tenantName:string;foreignTenant:{id:string;name:string};proof:unknown};
  if(previous.root!==root||previous.candidate!==sourceCandidate||previous.database!==database||previous.namespace!==namespace||previous.port!==port||previous.date!==date||previous.tenantName!==REPORT_FIXTURE_TENANT_NAME||previous.foreignTenant?.name!==REPORT_FIXTURE_FOREIGN_NAME)throw new Error('Reports receipt binding changed; preserve the database.');
  const proof=await readEmployeeMasterFixtureProof(owner,{tenantId:previous.tenantId,foreignTenantId:previous.foreignTenant.id});
  if(reportFixtureDigest(proof)!==reportFixtureDigest(previous.proof))throw new Error('Reports setup drifted; no repair/reseed is permitted.');
  candidate();await emit(previousText);return; // ZERO business writes on complete second invocation
 }
 const tenants=await owner.db.select({id:s.tenant.id}).from(s.tenant).limit(2);
 if(tenants.length!==1||tenants[0].id!==SYSTEM)throw new Error('Fresh migrated System-only Reports database required; no Demo, repair or reset.');
 const dates={today:date,hiredOn:month(date,-6),salaryChange:month(date,-2),transferOn:shift(month(date,-1),14),recentHire:month(date,0),contractEnd:shift(date,20),resignedOn:shift(date,-1),asAtBefore:shift(month(date,-2),-1),asAtAfter:date};
 async function provision(name:string,email:string,key:string){
  const made=await owner.db.transaction(tx=>provisionTenant(tx,{name,adminEmail:email,country:'MY',modules:['attendance','payroll'],baseUrl:'http://127.0.0.1:'+port}));
  // Canonical invitation is not consumed, printed or mailed. Fictional demo login is not human Auth evidence.
  const login='report18-fixture:bootstrap:'+key;
  const [user]=await owner.db.insert(s.appUser).values({tenantId:made.tenantId,personId:made.personId,workosUserId:login,onboardedAt:new Date()}).returning();
  // Initial bootstrap grant only; subsequent fixture actor grants use the actual role owner.
  await owner.db.insert(s.roleAssignment).values({tenantId:made.tenantId,appUserId:user.id,role:'hr_admin',companyId:null});
  const ctx=await context(user);for(const module of ['attendance','payroll'])if(!isModuleEnabled(ctx,module))throw new Error('Canonical required module is unavailable.');
  return {made,user,ctx,login};
 }
 const primary=await provision(REPORT_FIXTURE_TENANT_NAME,'report18-bootstrap@demo.test','primary');
 const foreign=await provision(REPORT_FIXTURE_FOREIGN_NAME,'report18-foreign-bootstrap@demo.test','foreign');
 const tenantId=primary.made.tenantId;
 const companies:Record<string,{id:string;name:string;code:string|null;departmentId:string|null;tenantId:string;purpose:string}>={};
 for(const key of ['MainA','MainB','Hidden','Empty']){
  const name='Reports18 fictional '+key,code='R18-'+key.toUpperCase();
  const company=await createCompany(primary.ctx,{legalName:name,companyLabel:code,country:'MY',currency:'MYR'});
  const department=await createDepartment(primary.ctx,{companyId:company.id,name:'Reports18 '+key+' team'});
  companies[key]={id:company.id,name,code,departmentId:department.id,tenantId,purpose:key==='Hidden'?'Outside both scoped HR principals':key==='Empty'?'Authorised company with no employments':'Authorised representative data'};
 }
 companies.Provisioned={id:primary.made.companyId,name:REPORT_FIXTURE_TENANT_NAME,code:null,departmentId:null,tenantId,purpose:'Canonical provisioning company; excluded from A/B grants'};
 companies.Foreign={id:foreign.made.companyId,name:REPORT_FIXTURE_FOREIGN_NAME,code:null,departmentId:null,tenantId:foreign.made.tenantId,purpose:'Other tenant, never authorised to primary actors'};
 const foreignDepartment=await createDepartment(foreign.ctx,{companyId:foreign.made.companyId,name:'Reports18 foreign team'});companies.Foreign.departmentId=foreignDepartment.id;
 const people:Record<string,Principal>={};
 async function actor(key:string,companyKey:string,role:'hr_admin'|'super_admin'|'employee',scopeKeys:string[]){
  const company=companies[companyKey],ctx=companyKey==='Foreign'?foreign.ctx:primary.ctx;
  const employeeCode='R18-'+key.toUpperCase(),login='report18-fixture:'+key;
  const hired=await hireEmployee(ctx,{person:{fullName:'Reports18 '+key,primaryEmail:'report18-'+key.toLowerCase()+'@demo.test'},employeeCode,companyId:company.id,departmentId:company.departmentId!,employmentType:'full_time',hiredOn:dates.hiredOn});
  await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:4000,currency:'MYR',effectiveFrom:dates.hiredOn});
  const [user]=await owner.db.insert(s.appUser).values({tenantId:ctx.tenantId,personId:hired.personId,workosUserId:login,onboardedAt:new Date()}).returning();
  if(role==='super_admin'||role==='employee')await assignRole(ctx,{appUserId:user.id,role});
  else for(const scope of scopeKeys)await assignRole(ctx,{appUserId:user.id,role,companyId:companies[scope].id});
  const actual=await context(user);
  people[key]={tenantId:ctx.tenantId,personId:hired.personId,employmentId:hired.employmentId,employeeCode,companyId:company.id,userId:user.id,login,grants:actual.grants??[]};return actual;
 }
 await actor('HR_A','MainA','hr_admin',['MainA','MainB','Empty']);
 await actor('HR_B','MainB','hr_admin',['MainA','MainB','Empty']);
 await actor('NoSalary','MainA','super_admin',[]);
 await actor('HiddenHR','Hidden','hr_admin',['Hidden']);
 await actor('Employee','MainA','employee',[]);
 await actor('ForeignHR','Foreign','hr_admin',['Foreign']);
 // An override tier replaces defaults for all roles. Preserve A/B's real HR grant explicitly.
 await setPayrollPermissionGrant(primary.ctx,{permissionKey:'report.read.compensation',role:'hr_admin',allowed:true});
 await setPayrollPermissionGrant(primary.ctx,{permissionKey:'report.read.compensation',role:'super_admin',allowed:false});
 const subjects:Record<string,Subject>={};
 for(let i=1;i<=56;i++){
  const key='Row'+String(i).padStart(3,'0'),company=companies[i<=28?'MainA':'MainB'];
  const hiredOn=i===55?dates.recentHire:dates.hiredOn,employeeCode='R18-'+String(i).padStart(6,'0');
  const made=await hireEmployee(primary.ctx,{person:{fullName:i<=2?'Reports18 Same Name':i===3?'=1+1 Reports18 literal text':'Reports18 Employee '+String(i).padStart(3,'0'),primaryEmail:'report18-row'+i+'@demo.test'},companyId:company.id,departmentId:company.departmentId!,employeeCode,employmentType:i===56?'contract':'full_time',hiredOn,...(i===56?{provisionalEndOn:dates.contractEnd}:{})});
  const basicSalary=3000+i;
  await setCompensation(primary.ctx,{employmentId:made.employmentId,basicSalary,currency:'MYR',effectiveFrom:hiredOn});
  subjects[key]={...made,employeeCode,companyId:company.id,basicSalary};
 }
 // True dated salary and entity-transfer history, written by their canonical owners.
 await setCompensation(primary.ctx,{employmentId:subjects.Row001.employmentId,basicSalary:4321.25,currency:'MYR',effectiveFrom:dates.salaryChange,movement:{type:'salaryRevision'}});
 await createMovementEvent(primary.ctx,{employmentId:subjects.Row001.employmentId,kind:'entityTransfer',effectiveDate:dates.transferOn,companyId:companies.MainB.id,departmentId:companies.MainB.departmentId!,remarks:'Reports18 fictional dated transfer'});
 subjects.Row001.companyId=companies.MainB.id;
 await terminateEmployment(primary.ctx,{employmentId:subjects.Row054.employmentId,terminationDate:dates.resignedOn,terminationReasonCode:'resignation',terminationNoticeDays:0});
 const family=[];
 for(const [fullName,dateOfBirth] of [['Reports18 Child Same Name','2016-02-03'],['Reports18 Child Same Name','2018-04-05']]){
  const made=await addDependent(primary.ctx,{personId:subjects.Row001.personId,fullName,relationship:'child',dateOfBirth,phone:'0001234567',remarks:'Fictional repeated record; distinguish IDs and birth dates'});family.push({id:made.id,fullName,dateOfBirth});
 }
 const qualifications=[];
 for(const [qualification,fromYm,toYm,isHighest] of [['Diploma','2010-03','2012-08',false],['Bachelor','2013-09','2016-06',true]] as const){
  const made=await addQualification(primary.ctx,{employmentId:subjects.Row001.employmentId,qualification,fromYm,toYm,institute:'Reports18 Fictional Institute',description:'Independent qualification register',isHighest});qualifications.push({id:made.id,qualification,fromYm,toYm,isHighest});
 }
 await requirePackFor('MY').statutory.set(primary.ctx,{personId:subjects.Row001.personId,icNumber:null,epfNumber:'000180001',taxNumber:'000R18TAX',bankName:'Maybank',bankAccountNo:'000001234567'});
 const config=await createConfig(primary.ctx,{companyId:companies.MainA.id,templateName:'Reports18 Draft IDs',prefix:'R18-D',startNumber:1,numberLength:5,increment:1,allowManualOverride:false,status:'active'});
 const draft=await createEmployeeDraftWithReservedCode(primary.ctx,{companyId:companies.MainA.id,fullName:'Reports18 Unfinished Draft',primaryEmail:'report18-draft@demo.test',employeeIdMode:'auto'});
 await saveEmployeeDraft(primary.ctx,{id:draft.id,currentStep:4,data:{profile:{fullName:'Reports18 Unfinished Draft',primaryEmail:'report18-draft@demo.test',employeeIdMode:'auto'},employment:{companyId:companies.MainA.id,departmentId:companies.MainA.departmentId!,employmentType:'full_time',hiredOn:date},payroll:{basicSalary:'3500'},family:[]}});
 const proof=await readEmployeeMasterFixtureProof(owner,{tenantId,foreignTenantId:foreign.made.tenantId});
 candidate();
 const manifest={version:1,root,candidate:sourceCandidate,database,namespace,port,date,tenantId,tenantName:REPORT_FIXTURE_TENANT_NAME,foreignTenant:{id:foreign.made.tenantId,name:REPORT_FIXTURE_FOREIGN_NAME},companies,people,dates,subjects,
  repeated:{employmentId:subjects.Row001.employmentId,personId:subjects.Row001.personId,family,qualifications},draft:{id:draft.id,configId:config.id,companyId:companies.MainA.id},
  historical:{employmentId:subjects.Row001.employmentId,oldCompanyId:companies.MainA.id,currentCompanyId:companies.MainB.id,oldSalary:3001,newSalary:4321.25,salaryChange:dates.salaryChange,transferOn:dates.transferOn},
  expected:{authorisedEmployeeRows:60,primaryEmploymentRows:61,foreignEmploymentRows:1,unfinishedDrafts:1,note:'56 data subjects + HR_A/HR_B/NoSalary/Employee = 60 authorised A+B rows; HiddenHR is excluded. Counts are setup expectations, not observed report output.'},
  proof,routes:{hub:'/reports',saved:'/reports/employee-master',builder:'/reports/employee-master/new',starters:Object.fromEntries(['headcount','newHires','resigned','contractExpiry'].map(key=>[key,'/reports/employee-master/new?starter='+key])),login:'/login'},
  roleDecision:'Human explicitly authorised existing HR Admin for the approved HR Manager sharing example. Actual persisted role key is hr_admin; no custom role framework is claimed.',
  setupOnly:true,outcomes:'UNRUN: actual browser must create, save, reopen, share, preview and export reports. No report, schedule, consent, SMTP, provider binding or human authentication evidence is fabricated.',
  limits:['No scheduled-delivery acceptance; separate real installed worker/provider journey remains required.','NoSalary is actual super_admin with explicit compensation denial; A/B actual hr_admin compensation remains allowed.','Generic registry future-field propagation and hostile/stale request checks remain canonical regression outcomes, not manufactured fixture UI passes.','No report/model calls are performed by fixture. Resume validates immutable setup and preserves browser-created reports and run history.','Fresh fixture second invocation requires same candidate, KL date and proof; after journey use coordinator receipt-bound resume, never reseed.'],
  language:'Canonical routes have no locale prefix. Change language in the app (NEXT_LOCALE); six locales en/ms/zh/ta/th/vi.'};
 const text=JSON.stringify(manifest,null,2)+'\n';
 await fs.writeFile(manifestFile,text,{mode:0o600,flag:'wx'});await emit(text);
}
let result=0;
try{await main();}catch{result=1;console.error('Reports18 fixture refused; preserve the named database and inspect owned setup/receipt guards. No secret or raw SQL error is logged.');}
finally{try{await owner.client.end({timeout:5});}catch{result=1;}try{await client.end({timeout:5});}catch{result=1;}}
process.exit(result);
