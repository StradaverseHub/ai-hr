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
import * as seedGuardNamespace from '../db/seed-guard';
import {SYSTEM_TESTING_BROWSER_TARGET} from './system-testing-browser-target.mjs';
import {profileTestingDates,profileTestingInvariant} from './profile-testing-fixture-proof.mjs';
import * as hrDateNamespace from '../lib/hr-date';
import {typescriptCliExports} from './typescript-cli-exports.mjs';
const {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal}=typescriptCliExports(seedGuardNamespace);
const {todayInKualaLumpur}=typescriptCliExports(hrDateNamespace);
const root=fileURLToPath(new URL('..',import.meta.url));
const {database,namespace,port,scratchpad}=SYSTEM_TESTING_BROWSER_TARGET,out=path.join(root,scratchpad);
const receiptPath=path.join(out,'fixture-manifest.json');
const refusal=demoSeedRefusal(process.env);
if(refusal||process.env.NODE_ENV==='production')throw new Error(refusal??'Development only.');
if(process.argv.length!==2||process.env.AUTH_PROVIDER!=='workos'||process.env.TEST_DB_NAMESPACE!==namespace||process.env.PORT!==port)throw new Error('Use the exact fictional System Testing coordinator target.');
const urls:Record<string,URL>={};
for(const [key,value] of [['DATABASE_URL',process.env.DATABASE_URL],['MIGRATION_DATABASE_URL',process.env.MIGRATION_DATABASE_URL]] as const) {
 let url:URL;try{url=new URL(value??'');}catch{throw new Error('Local credentials required.');}
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
const {createDb,client}=typescriptCliExports(await import('../db/client'));
const s=typescriptCliExports(await import('../db/schema'));
const {resolveEntitlementsTx,isModuleEnabled}=typescriptCliExports(await import('../core/entitlements'));
const {provisionTenant}=typescriptCliExports(await import('../db/provision'));
const {createCompany,createDepartment}=typescriptCliExports(await import('../core/admin'));
const {hireEmployee,setReportingLine,updatePerson,terminateEmployment,setEmploymentPaymentMethod}=typescriptCliExports(await import('../core/org'));
const {setCompensation}=typescriptCliExports(await import('../core/comp'));
const {createProfileOption,setProfileOptionActive}=typescriptCliExports(await import('../core/profile-options'));
const {addDependent}=typescriptCliExports(await import('../core/dependents'));
const {addQualification,archiveQualification}=typescriptCliExports(await import('../core/qualifications'));
const {addEmergencyContact,archiveEmergencyContact}=typescriptCliExports(await import('../core/emergency-contacts'));
const {setPersonPhoto}=typescriptCliExports(await import('../core/person-photo'));
const {addEmployeeDocument}=typescriptCliExports(await import('../core/employee-documents'));
const {requirePackFor}=typescriptCliExports(await import('../localization/registry'));
const {createBatch,generatePayslips,closeBatch,preProcessAdvisory}=typescriptCliExports(await import('../packs/payroll/service'));
const {myPayslips}=typescriptCliExports(await import('../core/read'));
const {setPersonComplianceFields}=typescriptCliExports(await import('../core/profile'));
const {saveTestInstructionDraft,publishTestInstruction,assignTestingCase}=typescriptCliExports(await import('../core/system-testing-workspace'));
const owner=createDb(process.env.MIGRATION_DATABASE_URL!,{max:1});
const locales=['en','ms','zh','ta','th','vi'] as const;
const tenantNames={primary:'Board19 Profile Testing fictional primary',foreign:'Board19 Profile Testing fictional foreign',off:'Board19 Profile Testing fictional core only'} as const;
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value)??'null';}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
type Principal={tenantId:string;userId:string;personId:string|null;employmentId:string|null;companyId:string|null;login:string;role:'hr_admin'|'employee'|'manager'};
async function context(p:Principal):Promise<SessionContext> {
 const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,p.tenantId),eq(s.roleAssignment.appUserId,p.userId))).orderBy(asc(s.roleAssignment.id));
 const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,p.tenantId));
 return {tenantId:p.tenantId,userId:p.userId,personId:p.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements};
}
// Closed owner read list, bounded row count, digest only. Never serialize credentials or invitation tokens.
const stateTables=['tenant_module','tenant_setting','company','department','person','employment','assignment','compensation','employee_statutory_my','employment_tax_selection_my','employee_dependent','employee_qualification','person_emergency_contact','profile_option','person_photo','employee_document','pay_period','payroll_batch','payslip','profile_change_request','reporting_line','app_user','role_assignment','test_case','test_case_version','test_assignment','test_execution','test_run','test_execution_attachment','test_catalogue_update','feedback_request','feedback_attachment','domain_event'] as const;
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
  const allowed=new Map<string,string>([[DEMO_TENANT_ID,'Demo Group'],[SYSTEM_TENANT_ID,'System (auth audit)'],...bound.map((t):[string,string]=>[t.id,t.name])]);
  if(tenants.some(t=>allowed.get(t.id)!==t.name)||bound.some(t=>!tenants.some(actual=>actual.id===t.id&&actual.name===t.name)))throw new Error('Tenant drift; preserve target.');
  if(await stateDigest(bound.map(t=>t.id))!==previous.stateDigest)throw new Error('Fixture business state changed; no repair or reset is permitted.');
  frozen();console.log('SYSTEM_TESTING16_MANIFEST\n'+JSON.stringify({...previous,reused:true},null,2));return;
 }
 if(!tenants.some(t=>t.id===DEMO_TENANT_ID&&t.name==='Demo Group')||tenants.some(t=>t.id!==DEMO_TENANT_ID&&t.id!==SYSTEM_TENANT_ID))throw new Error('Only the seeded demo and System tenants may precede this fixture.');
 const fixtureTenants:{id:string;name:string;companyId:string;moduleEnabled:boolean}[]=[],people:Record<string,Principal>={},dates=profileTestingDates(todayInKualaLumpur());
 for(const key of ['primary','foreign','off'] as const) {
  const made=await owner.db.transaction(tx=>provisionTenant(tx,{name:tenantNames[key],adminEmail:`board19-${key}@demo.test`,country:'MY',modules:key==='off'?[]:key==='primary'?['system_testing','attendance','payroll','typed_pay_components','country-my']:['system_testing'],baseUrl:'http://127.0.0.1:'+port}));
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
 const otherCompany=await createCompany(hr,{legalName:'Board19 fictional Singapore',companyLabel:'B19-SG',country:'SG',currency:'SGD',nonStatutory:true});
 const endedCompany=await createCompany(hr,{legalName:'Board19 fictional former company',companyLabel:'B19-ENDED',country:'MY',currency:'MYR'});
 const department=await createDepartment(hr,{companyId,name:'Board19 fictional team'});
 const otherDepartment=await createDepartment(hr,{companyId:otherCompany.id,name:'Board19 concurrent team'});
 const endedDepartment=await createDepartment(hr,{companyId:endedCompany.id,name:'Board19 former team'});
 if(!people.HR.personId)throw new Error('Provisioned HR Person missing.');
 const hrEmployment=await hireEmployee(hr,{person:{id:people.HR.personId},employeeCode:'B19-GROUP-HR',companyId,departmentId:department.id,employmentType:'full_time',hiredOn:dates.hiredOn});
 people.HR.employmentId=hrEmployment.employmentId;people.HR.companyId=companyId;
 const off=fixtureTenants.find(t=>t.id===people.DisabledHR.tenantId);if(!off||!people.DisabledHR.personId)throw new Error('Unentitled subject missing.');
 const offContext=await context(people.DisabledHR),offDepartment=await createDepartment(offContext,{companyId:off.companyId,name:'Board19 core-only team'});
 const offEmployment=await hireEmployee(offContext,{person:{id:people.DisabledHR.personId},employeeCode:'B19-OFF-HR',companyId:off.companyId,departmentId:offDepartment.id,employmentType:'full_time',hiredOn:dates.hiredOn});
 people.DisabledHR.employmentId=offEmployment.employmentId;people.DisabledHR.companyId=off.companyId;
 for(const key of ['TesterA','TesterB','ScopedHR','UserOnly','Empty'] as const) {
  let personId:string|null=null,employmentId:string|null=null;
  const userOnly=key==='UserOnly'||key==='Empty';
  if(!userOnly) {
   const made=await hireEmployee(hr,{person:{fullName:'Board19 '+key,primaryEmail:`board19-${key.toLowerCase()}@demo.test`,nationality:'Malaysian'},employeeCode:'B19-'+key.toUpperCase(),companyId,departmentId:department.id,employmentType:'full_time',hiredOn:dates.hiredOn,initialTaxScheme:'resident'});
   personId=made.personId;employmentId=made.employmentId;
  }
  const role=key==='TesterB'?'manager' as const:key==='ScopedHR'?'hr_admin' as const:'employee' as const,login='board19-fixture:'+key;
  const [user]=await owner.db.insert(s.appUser).values({tenantId,personId,workosUserId:login,onboardedAt:new Date()}).returning({id:s.appUser.id});
  await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:user.id,companyId,role});
  people[key]={tenantId,userId:user.id,personId,employmentId,companyId,login,role};
 }
 const employeeId=people.TesterA.employmentId,managerId=people.TesterB.employmentId;
 if(!employeeId||!managerId)throw new Error('Canonical fictional employments missing.');
 await setReportingLine(hr,{subordinateEmploymentId:employeeId,managerEmploymentId:managerId,lineType:'administrative',validFrom:dates.hiredOn});
 const personId=people.TesterA.personId;if(!personId)throw new Error('TesterA Person missing.');
 const concurrent=await hireEmployee(hr,{person:{id:personId},employeeCode:'B19-A-SG',companyId:otherCompany.id,departmentId:otherDepartment.id,employmentType:'part_time',hiredOn:dates.concurrentOn});
 const former=await hireEmployee(hr,{person:{id:personId},employeeCode:'B19-A-OLD',companyId:endedCompany.id,departmentId:endedDepartment.id,employmentType:'full_time',hiredOn:dates.oldHiredOn});
 await terminateEmployment(hr,{employmentId:former.employmentId,terminationDate:dates.oldEndedOn,terminationReason:'Board19 fictional former employment'});
 await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:people.TesterA.userId,companyId:otherCompany.id,role:'employee'});
 await updatePerson(hr,{personId,fullName:'Board19 TesterA',primaryEmail:'board19-testera@demo.test',phone:'001234567890',homePhone:'000301234567',personalEmail:'board19-personal@demo.test',permanentAddressLine1:'0001 Fictional Permanent Lane',permanentPostcode:'00123',permanentCity:'Fictional City',correspondenceAddressLine1:'0002 Fictional Correspondence Lane',correspondencePostcode:'00456',addressLine1:'0003 Retained Legacy Address',postcode:'00789',via:'board19-fixture'});
 await setPersonComplianceFields(hr,{employmentId:employeeId,dateOfBirth:dates.birthDate,gender:'male',maritalStatus:'single'});
 const pack=requirePackFor('MY'),ic=dates.birthDate.slice(2,4)+'0302140001';
 await pack.statutory.set(hr,{personId,icNumber:ic,epfNumber:'0000190001',socsoNumber:ic,taxNumber:'000B19TAX',taxCategory:1,numChildren:0,isResident:true,epfCitizenship:'citizen',bankName:'Maybank',bankAccountNo:'000019123456'});
 const family:string[]=[],qualifications:Record<string,string>={},emergency:Record<string,string>={};
 for(const dob of dates.children){const made=await addDependent(hr,{personId,fullName:'Board19 same-name child',relationship:'child',dateOfBirth:dob,phone:'000190011',childTaxRelief:false,remarks:'Invented Family identity; no relief election in initial fixture'});family.push(made.id);}
 const vocabulary:Record<string,string>={},oldOptionIds:string[]=[];
 for(const [key,category,value,label]of [['degree','qualificationLevel','B19_DEGREE','Board19 degree'],['oldDegree','qualificationLevel','B19_OLD_DEGREE','Board19 recorded old degree'],['contact','relationship','B19_CONTACT','Board19 trusted contact'],['oldContact','relationship','B19_OLD_CONTACT','Board19 recorded old contact']]){const made=await createProfileOption(hr,{category,value,label});vocabulary[key]=value;if(key.startsWith('old'))oldOptionIds.push(made.id);}
 for(const [key,qualification,isHighest]of [['highest',vocabulary.degree,true],['secondary',vocabulary.oldDegree,false],['archived',vocabulary.degree,false]]as const){const made=await addQualification(hr,{employmentId:employeeId,qualification,description:'Board19 qualification '+key,institute:'Board19 '+key+' institute',major:'Fictional studies',fromYm:dates.qualificationFrom,toYm:dates.qualificationTo,graduationDate:dates.graduationDate,result:'Recorded fictional result',isHighest});qualifications[key]=made.id;if(key==='archived')await archiveQualification(hr,{id:made.id});}
 for(const [key,priority]of [['primary','primary'],['secondary','secondary'],['archived','other']]as const){const made=await addEmergencyContact(hr,{personId,fullName:'Board19 same-name contact',relationship:key==='secondary'?vocabulary.oldContact:vocabulary.contact,mobilePhone:key==='primary'?'001901111':'001902222',homePhone:'0003190000',address:'0004 Fictional Contact Lane',remarks:'Board19 contact '+key,priority});emergency[key]=made.id;if(key==='archived')await archiveEmergencyContact(hr,{id:made.id});}
 for(const id of oldOptionIds)await setProfileOptionActive(hr,{id,isActive:false});
 await pack.statutory.setTax(hr,{personId,taxNumber:'000B19TAX',taxCategory:1,taxResidency:'resident',numChildren:0,childReliefMode:'auto',disabledIndividual:false,disabledSpouse:false});
 if(!pack.statutory.saveTaxSelection)throw new Error('MY country pack lacks canonical tax-selection owner.');
 await pack.statutory.saveTaxSelection(hr,{employmentId:employeeId,expectedCompanyId:companyId,scheme:'resident'});
 await setEmploymentPaymentMethod(hr,{employmentId:employeeId,paymentMethod:'bank_transfer'});
 await setCompensation(hr,{employmentId:employeeId,basicSalary:3500,monthlyAllowance:0,currency:'MYR',payMode:'monthly',paymentTerm:'monthly',effectiveFrom:dates.hiredOn,remarks:'Board19 fictional release preservation fixture'});
 const photo=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmXsAAAAASUVORK5CYII=','base64');
 await setPersonPhoto(hr,{personId,content:photo,fileName:'board19-fictional.png',mimeType:'image/png',sizeBytes:photo.length});
 await addEmployeeDocument(hr,{employmentId:employeeId,title:'BOARD19 HR REPOSITORY PRIVATE MARKER',description:'Protected HR repository; not a released employee output',fileName:'board19-hr.txt',mimeType:'text/plain',content:Buffer.from('Invented local acceptance HR-only supporting record.\n')});
 const {batchId}=await createBatch(hr,{companyId,payPeriod:dates.payPeriod,scope:{employmentIds:[employeeId]}});
 const advisory=await preProcessAdvisory(hr,batchId);
 if(Object.values(advisory).some(rows=>Array.isArray(rows)&&rows.length))throw new Error('Fictional Payroll readiness has actual gaps; preserve target and review canonical advisory, never bypass it.');
 await generatePayslips(hr,{batchId});await closeBatch(hr,{batchId});
 const released=(await myPayslips(await context(people.TesterA),[employeeId])).filter(row=>row.status==='closed'&&row.released&&row.payPeriod===dates.payPeriod);
 if(released.length!==1)throw new Error('Exactly one genuine own released payslip required.');
 const releasedPayroll={batchId,payslipId:released[0].id,employmentId:employeeId,payPeriod:dates.payPeriod,pdfRoute:`/me/payslip/${released[0].id}/pdf`,pdfObservation:'Actual browser Download still required; fixture generates no PDF bytes'};
 people.GroupHR=people.HR;people.EmployeeA=people.TesterA;people.ManagerB=people.TesterB;
 function definition(key:string,active=true):InstructionDefinition {
  return {format:1,title:'Board19 '+key,objective:'Observe your own Profile identity and record only the behavior actually seen.',functionKey:'systemtesting.fixture.'+key.toLowerCase(),area:'personnel',moduleCode:'system_testing',category:'functional',priority:'medium',active,prerequisites:['Use your own explicitly assigned fictional login.'],testData:['Fictional own employment if linked; UserOnly deliberately has no Person or Employment.'],steps:[{id:'open',action:'Open My Profile. If an employment chooser appears, select your own intended employment.',expected:'Your own employee header/code or the explicit unlinked state appears; no other person is substituted and no Today clocking block is shown.'},{id:'observe',action:'Return to this assigned My Testing guide, record the exact observed result and save it.',expected:'Reopen shows your own saved observation; other testers retain independent history.'}],expectedBehavior:'Own identity stays scoped and each observation is bound to this published guide and actual tester.',expectedFunction:'Own Profile read and versioned personal execution without granting business permissions.',permissions:['An active assignment to the actual signed-in app user; business access remains unchanged.'],jurisdiction:null,configuration:'Fictional local acceptance setup, not a completed test.',screenKeys:['mySystemTesting']};
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
 const manifest={format:1,root,database,namespace,port:Number(port),candidate,tenantId,fixtureTenants,companyId,otherCompanyId:otherCompany.id,endedCompanyId:endedCompany.id,people,cases,locales,dates,registers:{family,qualifications,emergency},ownEmployments:{current:employeeId,concurrent:concurrent.employmentId,ended:former.employmentId},releasedPayroll,invariants:{} as Awaited<ReturnType<typeof profileTestingInvariant>>,stateDigest:await stateDigest(ids),routes:{profile:`/me?employmentId=${employeeId}`,unsupportedProfile:`/me?employmentId=${concurrent.employmentId}`,personnel:`/admin/personnel/${employeeId}`,library:'/admin/system-testing',team:'/admin/system-testing?tab=team',updates:'/admin/system-testing?tab=updates',personal:'/system-testing',newCase:'/admin/system-testing/new',feedback:'/feedback'},preparedOnly:true,observationsCreated:0,cataloguePreloaded:false,screenshotsCreated:0,sourceBuildArrivalVerified:false};
 manifest.invariants=await profileTestingInvariant(owner.client,manifest);
 frozen();await fs.mkdir(out,{recursive:true});await fs.writeFile(receiptPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('SYSTEM_TESTING16_MANIFEST\n'+JSON.stringify({...manifest,reused:false},null,2));
}
try{await main();}finally{await owner.client.end();await client.end();}
// Keep imported development pools from retaining the process after a successful bounded fixture.
await new Promise<void>(resolve=>process.stdout.write('',()=>resolve()));process.exit(0);
