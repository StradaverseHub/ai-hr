/** Original18 / approved6d26c915: fictional preparation, never application acceptance.
 * Run only as the named original18 coordinator's child. No demo seed, import apply, criteria change,
 * overlapping legacy exception, fabricated history or new commercial entitlement is created here.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import type {SessionContext,Grant} from '../db/client';
import type {OrganisationLabelKind} from '../lib/system-label-definition';
import {SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard';
import {systemLabelFixtureSourceProof} from './system-label-fixture-contract.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const database='ai_hr_board18_labels_browser',namespace='board18labels',port=3198;
const out=path.join(root,'scratchpad/board18-labels'),receiptFile=path.join(out,'fixture-manifest.json');
const names={primary:'Labels18 Primary (fictional)',foreign:'Labels18 Foreign (fictional)'} as const;
const refusal=demoSeedRefusal(process.env);
if(refusal||process.env.NODE_ENV!=='development')throw new Error(refusal??'Local development only.');
if(process.argv.length!==2||process.env.AUTH_PROVIDER!=='workos'||process.env.TEST_DB_NAMESPACE!==namespace||process.env.PORT!==String(port))throw new Error('Use the closed Labels coordinator target.');
const urls:Record<string,URL>={};
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']){
 let url:URL;try{url=new URL(process.env[key]??'');}catch{throw new Error('Local app and migration credentials required.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/'+database||url.hash||[...url.searchParams].some(([k,v])=>k!=='sslmode'||v!=='disable'))throw new Error('Only the exact named localhost5433 Labels database is permitted.');
 urls[key]=url;
}
if(decodeURIComponent(urls.DATABASE_URL.username)!=='ai_hr_app'||urls.DATABASE_URL.username===urls.MIGRATION_DATABASE_URL.username)throw new Error('Use restricted ai_hr_app and separate migration credentials.');
const candidate=process.env.LABELS_FIXTURE_COORDINATOR_CANDIDATE;
if(!candidate||!/^[a-f0-9]{40}$/.test(candidate)||process.env.LABELS_FIXTURE_COORDINATOR_PID!==String(process.ppid))throw new Error('Fixture must be the declared live coordinator child.');
const ancestors=new Set<number>();let ancestor=process.ppid;
for(let depth=0;ancestor>1&&depth<64;depth++){
 if(ancestors.has(ancestor))throw new Error('Invalid coordinator ancestry.');ancestors.add(ancestor);
 ancestor=Number(execFileSync('ps',['-o','ppid=','-p',String(ancestor)],{encoding:'utf8'}).trim());
 if(!Number.isSafeInteger(ancestor)||ancestor<0)throw new Error('Cannot prove coordinator ancestry.');
}
for(const [directory,expected]of [['locks',namespace+'-browser-a'],['locks',namespace+'-browser-b'],['devdb-locks',namespace+'-browser-db']]){
 const base=path.join(os.homedir(),'.aihr-gate-state',directory);
 const held=fsSync.readdirSync(base).filter(n=>n.startsWith('slot.')).some(n=>{try{const dir=path.join(base,n),pid=Number(fsSync.readFileSync(path.join(dir,'pid'),'utf8').trim());if(fsSync.readFileSync(path.join(dir,'name'),'utf8').trim()!==expected||!ancestors.has(pid))return false;process.kill(pid,0);return true;}catch{return false;}});
 if(!held)throw new Error('Required live coordinator lock missing: '+expected);
}
function frozen(){if(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==candidate||execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trim())throw new Error('Candidate changed or is dirty; preserve target.');}
frozen();
// Import database owners only after all target/resource/candidate guards.
const {createDb,client}=await import('../db/client');
const s=await import('../db/schema');
const {provisionTenant}=await import('../db/provision');
const {resolveEntitlementsTx}=await import('../core/entitlements');
const {createCompany,createDepartment,createPosition,createCostCenter,createBusinessUnit,createJobGrade,assignRole}=await import('../core/admin');
const {hireEmployee,setReportingLine,setEmploymentInfo}=await import('../core/org');
const {createProfileOption,CATEGORY_EMPLOYMENT_COLUMN}=await import('../core/profile-options');
const {EMPLOYMENT_LABEL_CATEGORIES,LABEL_IMPORT_DEFINITIONS,ORGANISATION_LABEL_KINDS}=await import('../lib/system-label-definition');
const {downloadSystemLabelTemplate,downloadSystemLabelsWithData}=await import('../core/system-label-import');
const {buildSystemLabelWorkbook,systemLabelExportId}=await import('../lib/system-label-workbook');
const {toCsv}=await import('../lib/csv');
const {todayInKualaLumpur}=await import('../lib/hr-date');
const owner=createDb(process.env.MIGRATION_DATABASE_URL!,{max:1});
type Principal={tenantId:string;userId:string;personId:string|null;employmentId:string|null;login:string;grants:Grant[]};
type CompanyRef={id:string;tenantId:string;name:string;companyLabel:string|null};
type FileProof={fileName:string;sha256:string;bytes:number;format:'xlsx'|'csv';intent:string;exportId?:string};
type FixtureManifest={format:1;root:string;candidate:string;database:string;namespace:string;port:number;tenantId:string;date:string;fixtureTenants:{id:string;name:string;companyId:string}[];companies:Record<string,CompanyRef>;people:Record<string,Principal>;labels:Record<string,Record<string,{id:string;code:string}>>;files:FileProof[];stateSha256:string;[key:string]:unknown};
function canonical(value:unknown):string{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value)??'null';}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const byteDigest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
async function actualGrants(tenantId:string,userId:string):Promise<Grant[]>{
 return owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,tenantId),eq(s.roleAssignment.appUserId,userId))).orderBy(asc(s.roleAssignment.id));
}
async function context(p:Principal):Promise<SessionContext>{
 const grants=await actualGrants(p.tenantId,p.userId);
 return {tenantId:p.tenantId,userId:p.userId,personId:p.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,p.tenantId))};
}
// Hash only a closed, bounded table inventory. No invitation/session tokens or credentials are exported.
const stateTables=['tenant_module','tenant_setting','company','business_unit','department','position','cost_center','job_grade','profile_option','person','employment','assignment','reporting_line','app_user','role_assignment','label_company_assignment','system_label_criteria_epoch','system_label_collision_baseline','domain_event'] as const;
async function stateSha256(ids:string[]){return owner.client.begin('isolation level repeatable read read only',async tx=>{
 const state:Record<string,unknown>={};state.tenant=(await tx`select to_jsonb(t) as row from public.tenant t where id=any(${ids}::uuid[]) order by id`).map(r=>r.row);
 for(const table of stateTables){
  const [count]=await tx.unsafe(`select count(*)::integer as n from public.${table} where tenant_id=any($1::uuid[])`,[ids]);
  if(count.n>4000)throw new Error('Fixture state exceeds the receipt inventory bound.');
  state[table]=(await tx.unsafe(`select to_jsonb(t) as row from public.${table} t where tenant_id=any($1::uuid[]) order by to_jsonb(t)::text`,[ids])).map(r=>r.row);
 }
 return digest(state);
});}
async function fileProofsUnchanged(files:FileProof[]){
 if(files.length<8||files.length>24||new Set(files.map(f=>f.fileName)).size!==files.length)throw new Error('Invalid fixture artifact list.');
 for(const file of files){if(!/^[a-z0-9-]+\.(xlsx|csv)$/.test(file.fileName)||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>750000)throw new Error('Invalid artifact binding.');const destination=path.join(out,'files',file.fileName),st=await fs.lstat(destination);if(!st.isFile()||st.isSymbolicLink()||st.size!==file.bytes||byteDigest(await fs.readFile(destination))!==file.sha256)throw new Error('Fixture artifact changed; preserve target.');}
}
async function assertManifestBindings(manifest:FixtureManifest){
 if(manifest.tenantId!==manifest.fixtureTenants.find(t=>t.name===names.primary)?.id||!manifest.people||!manifest.companies)throw new Error('Invalid primary tenant binding.');
 const tenantIds=new Set(manifest.fixtureTenants.map(t=>t.id));
 const expectedPeople=['GroupHR','ForeignHR','Manager','Employee','ScopedHR','BEmployee','HiddenEmployee','EmptyHR','Operator'];
 if(Object.keys(manifest.people).sort().join('|')!==expectedPeople.sort().join('|')||Object.keys(manifest.companies).sort().join('|')!=='B|Empty|Hidden|Main')throw new Error('Unexpected fictional identity inventory.');
 for(const [key,p]of Object.entries(manifest.people)){
  if(!uuid(p.userId)||!tenantIds.has(p.tenantId)||typeof p.login!=='string'||!p.login||!Array.isArray(p.grants))throw new Error('Invalid fictional principal declaration.');
  const primaryTenant=manifest.fixtureTenants.find(t=>t.name===names.primary),foreignTenant=manifest.fixtureTenants.find(t=>t.name===names.foreign);
  if(!primaryTenant||!foreignTenant||p.tenantId!==(key==='ForeignHR'?foreignTenant.id:primaryTenant.id))throw new Error('Fictional principal tenant graph changed.');
  const employed=['Manager','Employee','ScopedHR','BEmployee','HiddenEmployee'].includes(key);
  if(Boolean(p.employmentId)!==employed||Boolean(p.personId)!==(!['Operator','EmptyHR'].includes(key)))throw new Error('Fictional principal person/employment graph changed.');
  if(!['GroupHR','ForeignHR'].includes(key)&&p.login!==`labels18-fixture:${key}`)throw new Error('Fictional login subject changed.');
  const expectedGrants:Grant[]=key==='GroupHR'||key==='ForeignHR'?[{role:'hr_admin',companyId:null}]:key==='Operator'?[{role:'operator',companyId:null}]:key==='ScopedHR'?['Main','B'].map(k=>({role:'hr_admin',companyId:manifest.companies[k].id})):key==='EmptyHR'?[{role:'hr_admin',companyId:manifest.companies.Empty.id}]:[{role:key==='Manager'?'manager':'employee',companyId:null}];
  const [actual]=await owner.db.select().from(s.appUser).where(eq(s.appUser.id,p.userId));
  if(!actual||actual.tenantId!==p.tenantId||actual.personId!==p.personId||actual.workosUserId!==p.login||actual.archivedAt)throw new Error('Fictional login binding changed.');
  if(p.personId){const [person]=await owner.db.select({tenantId:s.person.tenantId}).from(s.person).where(eq(s.person.id,p.personId));if(person?.tenantId!==p.tenantId)throw new Error('Fictional person binding changed.');}
  const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,p.tenantId),eq(s.roleAssignment.appUserId,p.userId)));
  const ordered=(items:Grant[])=>items.map(g=>({role:g.role,companyId:g.companyId})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  if(canonical(ordered(grants))!==canonical(ordered(p.grants))||canonical(ordered(grants))!==canonical(ordered(expectedGrants)))throw new Error('Fictional principal grant binding changed.');
  if(p.employmentId){const [employment]=await owner.db.select({tenantId:s.employment.tenantId,personId:s.employment.personId,employeeCode:s.employment.employeeCode}).from(s.employment).where(eq(s.employment.id,p.employmentId));if(employment?.tenantId!==p.tenantId||employment.personId!==p.personId||employment.employeeCode!==`LBL18-${key.toUpperCase()}`)throw new Error('Fictional employment binding changed.');}
 }
 if(manifest.companies.Main.id!==manifest.fixtureTenants.find(t=>t.name===names.primary)?.companyId)throw new Error('Primary company provenance changed.');
 for(const company of Object.values(manifest.companies)){
  if(!uuid(company.id)||company.tenantId!==manifest.tenantId)throw new Error('Invalid fictional company declaration.');
  const [actual]=await owner.db.select().from(s.company).where(eq(s.company.id,company.id));
  if(!actual||actual.tenantId!==company.tenantId||actual.legalName!==company.name||actual.companyLabel!==company.companyLabel)throw new Error('Fictional company binding changed.');
 }
}
async function emit(manifest:FixtureManifest,reused:boolean){
 await new Promise<void>((resolve,reject)=>process.stdout.write('BOARD18_LABELS_MANIFEST\n'+JSON.stringify({...manifest,reused},null,2)+'\n',error=>error?reject(error):resolve()));
}
async function main(){
 const [appRole]=await client`select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
 const [migrationRole]=await owner.client`select current_user as name`;
 if(appRole?.name!=='ai_hr_app'||appRole.rolsuper||appRole.rolbypassrls||migrationRole?.name!==decodeURIComponent(urls.MIGRATION_DATABASE_URL.username))throw new Error('Actual connected roles do not match the guarded target.');
 const [schema]=await owner.client`select to_regclass('public.system_label_criteria_epoch')::text as epoch,to_regclass('public.system_label_collision_baseline')::text as baseline`;
 if(!schema.epoch||!schema.baseline)throw new Error('Apply the real reviewed System Labels migration first.');
 let previous:FixtureManifest|null=null;
 try{const st=await fs.lstat(receiptFile);if(!st.isFile()||st.isSymbolicLink()||st.size>1048576)throw new Error('Invalid prior fixture receipt.');previous=JSON.parse(await fs.readFile(receiptFile,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const tenants=await owner.db.select({id:s.tenant.id,name:s.tenant.name}).from(s.tenant).orderBy(asc(s.tenant.id));
 if(previous){
  if(previous.format!==1||previous.root!==root||previous.candidate!==candidate||previous.database!==database||previous.namespace!==namespace||previous.port!==port||previous.date!==todayInKualaLumpur()||!Array.isArray(previous.fixtureTenants)||previous.fixtureTenants.length!==2||!Array.isArray(previous.files))throw new Error('Fixture receipt differs from exact target/candidate/date.');
  const declared=previous.fixtureTenants;
  if(new Set(declared.map(t=>t.id)).size!==2||new Set(declared.map(t=>t.name)).size!==2||declared.some(t=>!uuid(t.id)||!uuid(t.companyId)||!Object.values(names).some(name=>name===t.name)))throw new Error('Invalid fictional tenant declarations.');
  const allowed=new Map<string,string>([[SYSTEM_TENANT_ID,'System (auth audit)']]);for(const t of declared)allowed.set(t.id,t.name);
  if(tenants.some(t=>allowed.get(t.id)!==t.name)||declared.some(t=>!tenants.some(actual=>actual.id===t.id&&actual.name===t.name)))throw new Error('Unknown or changed tenant; no reset/repair.');
  if(canonical(previous.sourceProof)!==canonical(await systemLabelFixtureSourceProof(root)))throw new Error('Canonical fixture source contract changed; preserve target.');
  await assertManifestBindings(previous);
  await fileProofsUnchanged(previous.files);
  if(await stateSha256(declared.map(t=>t.id))!==previous.stateSha256)throw new Error('Stored fixture state changed; preserve browser edits and refuse.');
  frozen();await emit(previous,true);return;
 }
 if(tenants.some(t=>t.id!==SYSTEM_TENANT_ID||t.name!=='System (auth audit)'))throw new Error('Fresh migrated System-only target required; do not demo-seed or replace unknown tenants.');
 if(fsSync.existsSync(path.join(out,'files')))throw new Error('A previous artifact preparation exists without its completed receipt; preserve it.');
 const fixtureTenants:FixtureManifest['fixtureTenants']=[],people:Record<string,Principal>={},companies:Record<string,CompanyRef>={};
 for(const key of ['primary','foreign'] as const){
  const made=await owner.db.transaction(tx=>provisionTenant(tx,{name:names[key],adminEmail:`labels18-${key}@demo.test`,country:'MY',modules:[],baseUrl:`http://127.0.0.1:${port}`}));
  // Actual canonical first-admin chain; one fixture HR grant. Activation URL is discarded, never sent/logged.
  await owner.db.insert(s.roleAssignment).values({tenantId:made.tenantId,appUserId:made.appUserId,role:'hr_admin',companyId:null});
  const [user]=await owner.db.select().from(s.appUser).where(eq(s.appUser.id,made.appUserId));
  const [co]=await owner.db.select().from(s.company).where(eq(s.company.id,made.companyId));
  if(!user||!co)throw new Error('Canonical fictional provisioning incomplete.');
  // Local fictional login setup only: avoid the unrelated onboarding tour in acceptance.
  await owner.db.update(s.appUser).set({onboardedAt:new Date()}).where(eq(s.appUser.id,user.id));
  fixtureTenants.push({id:made.tenantId,name:names[key],companyId:made.companyId});
  people[key==='primary'?'GroupHR':'ForeignHR']={tenantId:made.tenantId,userId:made.appUserId,personId:made.personId,employmentId:null,login:user.workosUserId,grants:[{role:'hr_admin',companyId:null}]};
  if(key==='primary')companies.Main={id:co.id,tenantId:co.tenantId,name:co.legalName,companyLabel:co.companyLabel};
 }
 const tenantId=people.GroupHR.tenantId,admin=await context(people.GroupHR),date=todayInKualaLumpur();
 for(const key of ['B','Hidden','Empty']){const made=await createCompany(admin,{legalName:`Labels18 ${key} (fictional)`,companyLabel:`LBL18-${key.toUpperCase()}`,country:'MY',currency:'MYR'});companies[key]={id:made.id,tenantId,name:`Labels18 ${key} (fictional)`,companyLabel:`LBL18-${key.toUpperCase()}`};}
 const labels:FixtureManifest['labels']=Object.fromEntries(ORGANISATION_LABEL_KINDS.map(kind=>[kind,{}]));
 for(const key of ['Main','B','Hidden']){
  const companyId=companies[key].id,code=key==='Hidden'?'LBL18_HIDDEN':'LBL18_DUPLICATE';
  const unit=await createBusinessUnit(admin,{companyId,code,name:`Labels18 ${key} business unit`});labels.business_unit[key]={id:unit.id,code};
  const department=await createDepartment(admin,{companyId,businessUnitId:unit.id,name:code,description:''});labels.department[key]={id:department.id,code};
  const position=await createPosition(admin,{companyId,title:code,description:''});labels.position[key]={id:position.id,code};
  const cost=await createCostCenter(admin,{companyId,code,name:`Labels18 ${key} cost centre`});labels.cost_center[key]={id:cost.id,code};
 }
 const longName='Labels18 fictional long cost centre description for mobile wrapping and keyboard editing — operational reference information retained exactly on reopen';
 const long=await createCostCenter(admin,{companyId:companies.Main.id,code:'LBL18_LONG',name:longName,description:''});labels.cost_center.Long={id:long.id,code:'LBL18_LONG'};
 const editable=await createDepartment(admin,{companyId:companies.Main.id,name:'LBL18_EDIT',description:'Baseline optional description for blank-retains and explicit-clear review.'});labels.department.Edit={id:editable.id,code:'LBL18_EDIT'};
 const grade=await createJobGrade(admin,{code:'LBL18_GRADE',name:'Labels18 fictional grade',rank:18,description:''});
 const profileValues:Record<string,string>={};
 for(const category of EMPLOYMENT_LABEL_CATEGORIES){const value=`LBL18_${category.toUpperCase()}`;await createProfileOption(admin,{category,value,label:`Labels18 ${category}`,description:'',sortOrder:18});const column=CATEGORY_EMPLOYMENT_COLUMN[category]?.[0];if(!column)throw new Error('Canonical employment-label binding missing.');profileValues[column]=value;}
 const ambiguousOptions=[];
 for(const value of ['LBL18_BRANCH_A','LBL18_BRANCH_B'])ambiguousOptions.push(await createProfileOption(admin,{category:'branch',value,label:'Labels18 duplicate branch caption',description:'Distinct immutable codes; name-only import must not pick a first row.',sortOrder:19}));
 for(const key of ['Manager','Employee','ScopedHR','BEmployee','HiddenEmployee'] as const){
  const companyKey=key==='BEmployee'?'B':key==='HiddenEmployee'?'Hidden':'Main';
  const hired=await hireEmployee(admin,{person:{fullName:`Labels18 ${key}`,primaryEmail:`labels18-${key.toLowerCase()}@demo.test`},employeeCode:`LBL18-${key.toUpperCase()}`,companyId:companies[companyKey].id,departmentId:labels.department[companyKey].id,positionId:labels.position[companyKey].id,costCenterId:labels.cost_center[companyKey].id,gradeId:grade.id,employmentType:'full_time',hiredOn:date});
  await setEmploymentInfo(admin,{employmentId:hired.employmentId,...profileValues});
  const login=`labels18-fixture:${key}`,role=key==='Manager'?'manager':key==='ScopedHR'?'hr_admin':'employee';
  const [user]=await owner.db.insert(s.appUser).values({tenantId,personId:hired.personId,workosUserId:login,onboardedAt:new Date()}).returning({id:s.appUser.id});
  if(key==='ScopedHR')for(const scope of ['Main','B'])await assignRole(admin,{appUserId:user.id,role:'hr_admin',companyId:companies[scope].id});
  else await assignRole(admin,{appUserId:user.id,role});
  // The canonical writer normalizes manager/employee companyId to null; actual employment
  // and reporting-line owners determine their scope. Never manufacture inert company grants.
  const grants=await actualGrants(tenantId,user.id);
  people[key]={tenantId,userId:user.id,personId:hired.personId,employmentId:hired.employmentId,login,grants};
 }
 const [emptyAdmin]=await owner.db.insert(s.appUser).values({tenantId,personId:null,workosUserId:'labels18-fixture:EmptyHR',onboardedAt:new Date()}).returning({id:s.appUser.id});
 await assignRole(admin,{appUserId:emptyAdmin.id,role:'hr_admin',companyId:companies.Empty.id});
 people.EmptyHR={tenantId,userId:emptyAdmin.id,personId:null,employmentId:null,login:'labels18-fixture:EmptyHR',grants:await actualGrants(tenantId,emptyAdmin.id)};
 const [operator]=await owner.db.insert(s.appUser).values({tenantId,personId:null,workosUserId:'labels18-fixture:Operator',onboardedAt:new Date()}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:operator.id,role:'operator',companyId:null});
 people.Operator={tenantId,userId:operator.id,personId:null,employmentId:null,login:'labels18-fixture:Operator',grants:[{role:'operator',companyId:null}]};
 const employee=people.Employee.employmentId,manager=people.Manager.employmentId;if(!employee||!manager)throw new Error('Canonical fictional employments missing.');
 await setReportingLine(admin,{subordinateEmploymentId:employee,managerEmploymentId:manager,lineType:'administrative',validFrom:date});
 const ids=fixtureTenants.map(t=>t.id);
 const [commercial]=await owner.client`select count(*)::integer as n from tenant_module where tenant_id=any(${ids}::uuid[])`;
 const [baseline]=await owner.client`select count(*)::integer as n from system_label_collision_baseline where tenant_id=any(${ids}::uuid[])`;
 const [global]=await owner.client`select (select count(*) from department where tenant_id=any(${ids}::uuid[]) and is_global)+(select count(*) from position where tenant_id=any(${ids}::uuid[]) and is_global)+(select count(*) from cost_center where tenant_id=any(${ids}::uuid[]) and is_global)+(select count(*) from business_unit where tenant_id=any(${ids}::uuid[]) and is_global) as n`;
 if(commercial.n!==0||baseline.n!==0||Number(global.n)!==0)throw new Error('Preparation must not add commercial grants, inherited exceptions or Global labels.');
 const headReferences=await owner.db.select({code:s.employment.employeeCode,companyId:s.employment.companyId,name:s.person.fullName}).from(s.employment).innerJoin(s.person,eq(s.employment.personId,s.person.id)).where(eq(s.employment.tenantId,tenantId)).orderBy(asc(s.employment.id));
 const employees=headReferences.map(head=>{if(!head.code)throw new Error('Fictional employee reference code missing.');return [head.code,head.companyId,head.name];});
 const references={companies:Object.values(companies).map(co=>[co.name,co.id]),grades:[['LBL18_GRADE','Labels18 fictional grade']],employees};
 await fs.mkdir(path.join(out,'files'),{recursive:true,mode:0o700});const files:FileProof[]=[];
 async function save(fileName:string,bytes:Uint8Array,intent:string,exportId?:string){if(bytes.length>750000)throw new Error('Prepared workbook exceeds authoritative size bound.');await fs.writeFile(path.join(out,'files',fileName),bytes,{flag:'wx',mode:0o600});files.push({fileName,bytes:bytes.length,sha256:byteDigest(bytes),format:fileName.endsWith('.csv')?'csv':'xlsx',intent,...(exportId?{exportId}:{})});}
 const row=(code:string,companyId=companies.Main.id,criteria='companies',companyIds=companyId)=>({Company:companyId,Criteria:criteria,'Criteria Companies':criteria==='global'?'':companyIds,Code:code,Label:'Fictional Labels18 import caption',Description:'Fictional Labels18 import description','Head Employee Code':''});
 async function workbook(fileName:string,kind:OrganisationLabelKind,rows:Record<string,string>[],intent:string){await save(fileName,await buildSystemLabelWorkbook({references,kinds:[kind],rows:{[kind]:rows}}),intent);}
 await save('blank-current-template.xlsx',await downloadSystemLabelTemplate(admin),'Canonical blank owner download; no labels imported.');
 await workbook('valid-main-new.xlsx','department',[row('LBL18_UI_NEW')],'Add a new Main-only code through the actual import preview/confirm.');
 await workbook('valid-multi-new.xlsx','position',[row('LBL18_UI_MULTI',companies.Main.id,'companies',companies.Main.id+';'+companies.B.id)],'GroupHR actual import may create explicit Main+B availability; no fixture apply.');
 await workbook('global-group-only.xlsx','department',[row('LBL18_UI_GLOBAL',companies.Main.id,'global')],'GroupHR Global positive; ScopedHR Global refusal.');
 await workbook('empty-company-criteria.xlsx','department',[row('LBL18_UI_EMPTY',companies.Main.id,'companies','')],'Empty scoped company criteria must be refused.');
 await workbook('unauthorized-hidden-company.xlsx','department',[row('LBL18_UI_HIDDEN',companies.Main.id,'companies',companies.Hidden.id)],'ScopedHR must not create or share into Hidden; inspect scope refusal.');
 const foreignTenant=fixtureTenants.find(t=>t.name===names.foreign);if(!foreignTenant)throw new Error('Fictional foreign tenant binding missing.');
 await workbook('foreign-company.xlsx','department',[row('LBL18_UI_FOREIGN',foreignTenant.companyId)],'Foreign tenant company must be refused; actual owner cannot resolve it in the primary tenant.');
 await workbook('existing-code-global-collision.xlsx','department',[row(labels.department.Main.code,companies.Main.id,'global')],'Update Main duplicate to Global must refuse new overlap with B; preserve IDs/codes.');
 await workbook('conflicting-duplicate-rows.xlsx','department',[row('LBL18_UI_CONFLICT'),{...row('LBL18_UI_CONFLICT'),Label:'A conflicting second caption'}],'Conflicting same-file identity must not select a row silently.');
 await workbook('optional-clear-update.xlsx','department',[{...row('LBL18_EDIT'),Label:'',Description:'[CLEAR]'}],'Use merge to check blank retains and explicit optional Description clear; actual preview/apply/reopen.');
 // Exports use actual canonical actor/scope/audit binding. Initially current; only a later real UI edit
 // makes a changed row stale. Do not fabricate an _Export ID or promise a stale result before that edit.
 for(const [key,ctx,scope]of [['group',admin,['Main','B','Hidden','Empty']],['scoped',await context(people.ScopedHR),['Main','B']]] as const){const bytes=await downloadSystemLabelsWithData(ctx,{companyIds:scope.map(k=>companies[k].id),kinds:[...ORGANISATION_LABEL_KINDS],includeInactive:true});const exportId=systemLabelExportId(bytes);if(!exportId)throw new Error('Canonical current-data export missing its identity.');await save(key+'-current-before-ui.xlsx',bytes,`Canonical ${key} actor-bound current export; edit LBL18_EDIT via UI to exercise stale warning, or use another actor for export-identity refusal.`,exportId);}
 const columns=LABEL_IMPORT_DEFINITIONS.find(d=>d.kind==='department')?.columns;if(!columns)throw new Error('Authoritative Department template missing.');const csvRow=row('LBL18_UNSUPPORTED_CSV');await save('unsupported-label-upload.csv',Buffer.from(toCsv([columns,columns.map(column=>csvRow[column as keyof typeof csvRow]??'')])),'Negative control only: System Labels intentionally accepts XLSX, no CSV import owner exists.');
 frozen();const manifest:FixtureManifest={sourceProof:await systemLabelFixtureSourceProof(root),format:1,root,candidate,database,namespace,port,tenantId,date,fixtureTenants,companies,people,labels,files,stateSha256:await stateSha256(ids),gradeId:grade.id,ambiguousOptionIds:ambiguousOptions.map(option=>option.id),longName,routes:{labels:'/admin/settings/system-labels',profileOptions:'/admin/settings/system-labels/profile-options',personnel:'/admin/personnel',newPersonnel:'/admin/personnel/new',companies:'/admin/organization'},preparedOnly:true,importsApplied:0,globalOrMultiCompanyActionsPerformed:false,legacyOverlapExceptionsCreated:0,commercialEntitlementsCreated:0,locales:['en','ms','zh','ta','th','vi'],limitations:['Current owner creates only scoped-origin baseline; genuine pre0550 old-flag and inherited-overlap upgrade evidence remains separate.','No CSV label-import contract exists; CSV file is an explicit unsupported-format refusal control.','Stale export requires a real later UI change; preparation never invents stale metadata.','No actual browser, import preview/apply, tests, types, gate or release is established.']};
 await assertManifestBindings(manifest);
 await fs.writeFile(receiptFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});await emit(manifest,false);
}
let result=0;
try{await main();}catch{result=1;console.error('Labels18 fixture refused; preserve the named database and inspect its preparation guards. No acceptance PASS claimed.');}
finally{
 // Attempt both independent closes even if one fails; never report a clean exit after a close failure.
 try{await owner.client.end({timeout:5});}catch{result=1;}
 try{await client.end({timeout:5});}catch{result=1;}
}
// Repository fixture convention: hidden imported handles cannot keep an otherwise completed child alive.
// emit() awaits stdout first; process status remains authoritative for preparation and cleanup.
process.exit(result);
