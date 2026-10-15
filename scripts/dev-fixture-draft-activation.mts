/** Local-only 467664c3/94b0fd08 fixture. Business facts use canonical owners; owner inserts only fictional logins/grants.
 * Never activates, discards, resets or repairs an existing fixture. Run twice cleanly before browser edits.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {and,asc,eq,isNull,sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import type {EmployeeDraftData} from '../lib/employee-draft-schema';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard';
const root=fileURLToPath(new URL('..',import.meta.url));
const out=path.join(root,'scratchpad/board15-draft-activation');
const refusal=demoSeedRefusal(process.env);
if(refusal||process.env.NODE_ENV==='production')throw new Error(refusal??'Development only.');
if(process.env.AUTH_PROVIDER&&process.env.AUTH_PROVIDER!=='workos')throw new Error('Local fictional demo authentication only.');
if(process.env.TEST_DB_NAMESPACE!=='board15activation')throw new Error('Use the assigned Activation namespace.');
const urls:Record<string,URL>={};
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']) {
  let url:URL;try{url=new URL(process.env[key]??'');}catch{throw new Error('Valid local database credentials are required.');}
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/ai_hr_board15_activation_browser')throw new Error('Only the named disposable local Activation database is allowed.');
  urls[key]=url;
}
if(decodeURIComponent(urls.DATABASE_URL.username)!=='ai_hr_app'||urls.DATABASE_URL.username===urls.MIGRATION_DATABASE_URL.username)throw new Error('Require non-owner ai_hr_app and separate local migration credentials.');
const {createDb}=await import('../db/client');
const s=await import('../db/schema');
const {resolveEntitlementsTx}=await import('../core/entitlements');
const {createCompany,createDepartment}=await import('../core/admin');
const {hireEmployee,setReportingLine}=await import('../core/org');
const {createProfileOption}=await import('../core/profile-options');
const {createConfig}=await import('../core/employee-id-config');
const {createPolicy}=await import('../packs/payroll/service');
const {createEmployeeDraftWithReservedCode,saveEmployeeDraft,getEmployeeDraft}=await import('../core/employee-draft');
const {missingByTab,missingForCreation}=await import('../lib/employee-draft-schema');
const {requirePackFor}=await import('../localization/registry');
const owner=createDb(process.env.MIGRATION_DATABASE_URL!),tenantId=DEMO_TENANT_ID;
const locales=['en','ms','zh','ta','th','vi'] as const;
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function one<T>(rows:T[],what:string):T|undefined {
  if(rows.length>1)throw new Error(`Ambiguous fictional ${what}; preserving existing records.`);
  return rows[0];
}
async function context(user:{id:string;personId:string|null}):Promise<SessionContext> {
  const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id)).orderBy(asc(s.roleAssignment.id));
  const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId));
  return {tenantId,userId:user.id,personId:user.personId,grants,roles:[...new Set(grants.map(grant=>grant.role))],entitlements};
}
async function main() {
  const tenants=await owner.db.select().from(s.tenant).orderBy(asc(s.tenant.id));
  if(!tenants.some(row=>row.id===tenantId&&row.name==='Demo Group')||tenants.some(row=>row.id!==tenantId&&row.id!==SYSTEM_TENANT_ID))throw new Error('Seeded fictional demo tenants only; preserving this database.');
  const seedAdmin=one(await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,'user_dev_admin'),isNull(s.appUser.archivedAt))).orderBy(asc(s.appUser.id)),'seed administrator');
  if(!seedAdmin)throw new Error('Seed administrator missing.');
  const bootstrap=await context(seedAdmin);
  const previousText=await fs.readFile(path.join(out,'fixture-manifest.json'),'utf8').catch(error=>{
    if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
    throw error;
  });
  const previousManifest=previousText?JSON.parse(previousText) as {root?:unknown;database?:unknown;tenantId?:unknown;drafts?:Record<string,unknown>}:null;
  if(previousText!==null&&(!previousManifest||typeof previousManifest!=='object'||Array.isArray(previousManifest)||previousManifest.root!==root||previousManifest.database!=='ai_hr_board15_activation_browser'||previousManifest.tenantId!==tenantId||!previousManifest.drafts||typeof previousManifest.drafts!=='object'||Array.isArray(previousManifest.drafts)))throw new Error('Existing fictional fixture receipt does not match this target; preserve it.');
  const companies:Record<string,string>={},departments:Record<string,string>={},configs:Record<string,{id:string;prefix:string;currentRunningNumber:number}>={};
  for(const key of ['Main','Foreign']) {
    let company=one(await owner.db.select().from(s.company).where(and(eq(s.company.tenantId,tenantId),eq(s.company.companyLabel,`ACTIVATION15-${key}`))).orderBy(asc(s.company.id)),`${key} company`);
    if(!company){const made=await createCompany(bootstrap,{legalName:`Activation15 fictional ${key}`,companyLabel:`ACTIVATION15-${key}`,country:'MY',currency:'MYR'});company=one(await owner.db.select().from(s.company).where(eq(s.company.id,made.id)),'created company');}
    if(!company||company.archivedAt||company.country!=='MY')throw new Error('Existing fictional company changed; preserving it.');
    companies[key]=company.id;
    let department=one(await owner.db.select().from(s.department).where(and(eq(s.department.companyId,company.id),eq(s.department.name,`Activation15 ${key} team`))).orderBy(asc(s.department.id)),`${key} department`);
    if(!department){const made=await createDepartment(bootstrap,{companyId:company.id,name:`Activation15 ${key} team`});department=one(await owner.db.select().from(s.department).where(eq(s.department.id,made.id)),'created department');}
    if(!department||department.archivedAt)throw new Error('Existing fictional department changed; preserving it.');
    departments[key]=department.id;
    const prefix=key==='Main'?'ACT15-G':'ACT15-X';
    let config=one(await owner.db.select().from(s.employeeIdConfig).where(and(eq(s.employeeIdConfig.tenantId,tenantId),eq(s.employeeIdConfig.companyId,company.id))).orderBy(asc(s.employeeIdConfig.id)),`${key} ID setup`);
    if(!config){const made=await createConfig(bootstrap,{companyId:company.id,templateName:`Activation15 ${key} held IDs`,prefix,startNumber:2,numberLength:5,increment:1,allowManualOverride:false,status:'active'});config=one(await owner.db.select().from(s.employeeIdConfig).where(eq(s.employeeIdConfig.id,made.id)),'created ID setup');}
    if(!config||config.status!=='active'||config.prefix!==prefix||config.suffix!==''||config.numberLength!==5||config.startNumber!==2||config.increment!==1||config.allowManualOverride)throw new Error('Existing fictional numbering configuration changed; preserving it.');
    configs[key]={id:config.id,prefix,currentRunningNumber:config.currentRunningNumber};
  }
  let nationality=one(await owner.db.select().from(s.profileOption).where(and(eq(s.profileOption.tenantId,tenantId),eq(s.profileOption.category,'nationality'),eq(s.profileOption.value,'Malaysian'))).orderBy(asc(s.profileOption.id)),'Malaysian nationality');
  if(!nationality){await createProfileOption(bootstrap,{category:'nationality',value:'Malaysian',label:'Malaysian'});nationality=one(await owner.db.select().from(s.profileOption).where(and(eq(s.profileOption.tenantId,tenantId),eq(s.profileOption.category,'nationality'),eq(s.profileOption.value,'Malaysian'))).orderBy(asc(s.profileOption.id)),'created nationality');}
  if(!nationality?.isActive)throw new Error('Required fictional nationality choice is inactive; preserving the catalogue.');

  const people:Record<string,{personId:string;employmentId:string;employeeCode:string;companyId:string;userId:string;login:string;role:string}>={};
  for(const key of ['HR','Manager','Employee','ForeignHR','ForeignEmployee']) {
    const companyKey=key.startsWith('Foreign')?'Foreign':'Main',employeeCode=`ACT15-${key.toUpperCase()}`,email=`activation15-${key.toLowerCase()}@demo.test`;
    let person=one(await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,email))).orderBy(asc(s.person.id)),`${key} person`);
    let employment=person?one(await owner.db.select().from(s.employment).where(and(eq(s.employment.personId,person.id),eq(s.employment.companyId,companies[companyKey]),eq(s.employment.employeeCode,employeeCode))).orderBy(asc(s.employment.id)),`${key} employment`):undefined;
    if(!person){const made=await hireEmployee(bootstrap,{person:{fullName:`Activation15 ${key}`,primaryEmail:email,phone:'001234567890'},employeeCode,companyId:companies[companyKey],departmentId:departments[companyKey],employmentType:'full_time',hiredOn:'2025-01-01'});person=one(await owner.db.select().from(s.person).where(eq(s.person.id,made.personId)),'created person');employment=one(await owner.db.select().from(s.employment).where(eq(s.employment.id,made.employmentId)),'created employment');}
    if(!person||!employment||employment.terminatedOn||employment.employeeCode!==employeeCode||person.fullName!==`Activation15 ${key}`||person.phone!=='001234567890'||employment.hiredOn!=='2025-01-01')throw new Error('Existing fictional principal identity changed; preserving it.');
    const login=`activation15-fixture:${key}`;
    let user=one(await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,login))).orderBy(asc(s.appUser.id)),`${key} login`);
    if(!user)[user]=await owner.db.insert(s.appUser).values({tenantId,personId:person.id,workosUserId:login,onboardedAt:new Date()}).returning();
    if(user.archivedAt||user.personId!==person.id)throw new Error('Existing fictional login changed; preserving it.');
    const role=key==='HR'||key==='ForeignHR'?'hr_admin' as const:key==='Manager'?'manager' as const:'employee' as const;
    const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id)).orderBy(asc(s.roleAssignment.id));
    if(!grants.length)await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:user.id,companyId:companies[companyKey],role});
    else if(grants.length!==1||grants[0].role!==role||grants[0].companyId!==companies[companyKey])throw new Error('Existing fictional grants changed; preserving them.');
    people[key]={personId:person.id,employmentId:employment.id,employeeCode,companyId:employment.companyId,userId:user.id,login,role};
  }
  const hr=await context({id:people.HR.userId,personId:people.HR.personId}),foreignHr=await context({id:people.ForeignHR.userId,personId:people.ForeignHR.personId});
  const line=one(await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId,people.Employee.employmentId),eq(s.reportingLine.lineType,'administrative'),isNull(s.reportingLine.validTo),isNull(s.reportingLine.supersededAt))).orderBy(asc(s.reportingLine.id)),'administrative line');
  if(!line)await setReportingLine(hr,{subordinateEmploymentId:people.Employee.employmentId,managerEmploymentId:people.Manager.employmentId,lineType:'administrative',validFrom:'2025-01-01'});
  else if(line.managerEmploymentId!==people.Manager.employmentId)throw new Error('Existing fictional reporting line changed; preserving it.');
  let policy=one(await owner.db.select().from(s.payrollPolicy).where(and(eq(s.payrollPolicy.tenantId,tenantId),eq(s.payrollPolicy.companyId,companies.Main),eq(s.payrollPolicy.name,'Activation15 stale-policy journey'))).orderBy(asc(s.payrollPolicy.id)),'Payroll policy');
  if(!policy){const made=await createPolicy(hr,{companyId:companies.Main,name:'Activation15 stale-policy journey',policyType:'monthly',status:'active'});policy=one(await owner.db.select().from(s.payrollPolicy).where(eq(s.payrollPolicy.id,made.id)),'created Payroll policy');}
  if(!policy||policy.status!=='active'||policy.policyType!=='monthly')throw new Error('Existing fictional policy changed after the journey; preserving it.');
  const policyId=policy.id;
  const pack=requirePackFor('MY');
  if(!pack.statutory.validateIC('900101010046')||pack.statutory.validateIC('12345'))throw new Error('Fixture IC validation assumptions changed.');
  const icClash=await owner.db.select({id:s.employeeStatutoryMy.id}).from(s.employeeStatutoryMy).where(and(eq(s.employeeStatutoryMy.tenantId,tenantId),eq(s.employeeStatutoryMy.icNumber,'900101010046'))).limit(1);
  if(icClash.length)throw new Error('The fictional activation IC is already used; preserve the database and inspect its journey state.');
  function baseData(key:string,companyKey='Main'):EmployeeDraftData {
    return {profile:{fullName:`Activation15 Draft ${key}`,primaryEmail:`activation15-draft-${key.toLowerCase()}@demo.test`,employeeIdMode:'auto'},
      employment:{companyId:companies[companyKey],departmentId:departments[companyKey],employmentType:'full_time',hiredOn:'2026-03-01'},payroll:{basicSalary:'3500'},family:[]};
  }
  const rich=baseData('Fictional Shaair');
  rich.profile={...rich.profile,fullName:'Activation15 Fictional Shaair',primaryEmail:'activation15-fictional-shaair@demo.test',preferredName:'Fictional Shaair',nationality:'Malaysian',icNumber:'900101010046',dateOfBirth:'1990-01-01',gender:'female',maritalStatus:'married',phone:'001234567890',personalEmail:'activation15-fictional-personal@demo.test',permanentAddressLine1:'0001 Fictional Lane',permanentPostcode:'00120',permanentCity:'Fictional City',sameAsPermanent:'yes'};
  rich.employment={...rich.employment,reportingManagerEmploymentId:people.Manager.employmentId,probationValue:'3',probationUnit:'month',confirmationDate:'2026-06-01'};
  rich.statutory={bankName:'Maybank',bankAccountNo:'000000123456',epfNumber:'000ACT15002',taxNumber:'000ACT15TAX',taxResidency:'resident',epfCitizenship:'citizen',childReliefMode:'auto',subjectToHrdf:'no'};
  rich.payroll={basicSalary:'4500',monthlyAllowance:'125.50',paymentMethod:'bank_transfer',remarks:'Activation15 fictional saved package'};
  rich.family=[{key:'activation15-spouse',fullName:'Activation15 fictional spouse',relationship:'spouse',dateOfBirth:'1989-02-03',gender:'male',marriageStatus:'married',spouseWorking:true,phone:'000987654321',isBeneficiary:true},
    {key:'activation15-child',fullName:'Activation15 fictional child',relationship:'child',dateOfBirth:'2018-04-05',gender:'undisclosed',childTaxRelief:true,childReliefCategory:'under_18',childReliefPercentage:'100',isBeneficiary:false}];
  const blank=baseData('OptionalBlank');
  const cancel=structuredClone(rich);
  cancel.profile={...cancel.profile,fullName:'Activation15 Draft DeleteCancel',primaryEmail:'activation15-draft-deletecancel@demo.test'};
  delete cancel.profile.icNumber;
  const invalid=baseData('InvalidIdentity');invalid.profile={...invalid.profile,nationality:'Malaysian',icNumber:'12345'};
  const missing=baseData('MissingRequired');missing.employment={...missing.employment,departmentId:''};
  const stale=baseData('StalePolicy');stale.payroll={...stale.payroll,payrollPolicyId:policyId};
  const planned:[string,EmployeeDraftData,number,string,string][]=[
    ['valid',rich,6,'Main','Valid saved G00002-shaped MY Draft with its own ACT15-G00002-style held code; save/activate/open/refresh.'],
    ['optionalBlank',blank,4,'Main','All optional profile/statutory/Family groups blank; successful activation creates no statutory row.'],
    ['invalidIdentity',invalid,1,'Main','Malformed supplied IC: server validation identifies Profile/IC; Draft and reservation remain.'],
    ['missingRequired',missing,2,'Main','Missing Department: Job tab identifies the required field; save/reopen retains captured work.'],
    ['stalePolicy',stale,4,'Main','Open this valid Draft, then change its policy to Draft through the app before Activate: safe Payroll validation, no employee.'],
    ...locales.map((locale):[string,EmployeeDraftData,number,string,string]=>[`locale_${locale}`,baseData(`Locale-${locale}`),4,'Main',`Dedicated optional-blank success case for actual ${locale} Activate/open/refresh without recreating a consumed Draft.`]),
    ['deleteCancel',cancel,6,'Main','Delete Record dialog Cancel and Escape keep this Draft, all values and held code.'],
    ['deleteConfirm',baseData('DeleteConfirm'),6,'Main','Dedicated final Main reservation: Confirm removes this fictional Draft once; Cancel must be checked first.'],
    ['foreign',baseData('Foreign','Foreign'),6,'Foreign','Main HR cannot open/activate/delete this foreign-company Draft; Foreign HR can open it.'],
  ];
  const drafts:Record<string,{id:string;employeeCode:string;companyId:string;reservedConfigId:string;reservedNumber:number;currentStep:number;data:EmployeeDraftData;dataSha256:string;missing:ReturnType<typeof missingByTab>;purpose:string;routes:Record<string,string>}>={};
  for(const [key,data,currentStep,companyKey,purpose] of planned) {
    const actor=companyKey==='Main'?hr:foreignHr;
    let draft=one(await owner.db.select().from(s.employeeDraft).where(and(eq(s.employeeDraft.tenantId,tenantId),eq(s.employeeDraft.companyId,companies[companyKey]),sqlDraftEmail(data.profile!.primaryEmail!))).orderBy(asc(s.employeeDraft.id)),`${key} Draft`);
    if(!draft) {
      if(previousManifest?.drafts?.[key])throw new Error('A previously declared fictional Draft is missing or changed; preserve its journey rather than replacing it.');
      const alreadyPerson=await owner.db.select({id:s.person.id}).from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,data.profile!.primaryEmail!))).limit(1);
      if(alreadyPerson.length)throw new Error('A fictional Draft was already activated; preserve it rather than creating a replacement.');
      const made=await createEmployeeDraftWithReservedCode(actor,{companyId:companies[companyKey],fullName:data.profile!.fullName!,primaryEmail:data.profile!.primaryEmail!,employeeIdMode:'auto'});
      await saveEmployeeDraft(actor,{id:made.id,data,currentStep});
      draft=one(await owner.db.select().from(s.employeeDraft).where(eq(s.employeeDraft.id,made.id)),'created Draft');
    }
    if(!draft?.reservedEmployeeCode||!draft.reservedConfigId||draft.reservedConfigId!==configs[companyKey].id||draft.reservedNumber==null||draft.currentStep!==currentStep)throw new Error('Existing fictional Draft/reservation changed; preserving it.');
    const expected={...data,profile:{...data.profile,employeeCode:draft.reservedEmployeeCode},employment:{...data.employment,companyId:companies[companyKey]}};
    if(digest(draft.data)!==digest(expected))throw new Error('Existing fictional captured Draft values changed; preserving them.');
    const visible=await getEmployeeDraft(actor,draft.id);
    if(!visible||visible.reservedEmployeeCode!==draft.reservedEmployeeCode)throw new Error('Canonical scoped Draft reader cannot see its own fictional case.');
    if(digest(visible.data)!==digest(draft.data))throw new Error('Canonical Draft data differs from the exact fictional captured values; preserving them.');
    if(key!=='missingRequired'&&missingForCreation(visible.data).length)throw new Error('Unexpected missing required values in the fictional case.');
    const routes=Object.fromEntries(locales.map(locale=>[locale,`/admin/personnel/new?draft=${draft!.id}`]));
    drafts[key]={id:draft.id,employeeCode:draft.reservedEmployeeCode,companyId:companies[companyKey],reservedConfigId:draft.reservedConfigId,reservedNumber:draft.reservedNumber,currentStep,data:visible.data,dataSha256:digest(visible.data),missing:missingByTab(visible.data),purpose,routes};
  }
  for(const key of ['Main','Foreign']) {
    const [config]=await owner.db.select().from(s.employeeIdConfig).where(eq(s.employeeIdConfig.id,configs[key].id));
    configs[key].currentRunningNumber=config.currentRunningNumber;
  }
  if(drafts.deleteConfirm.reservedNumber!==configs.Main.currentRunningNumber)throw new Error('Delete Confirm must own the Main numbering tip before the browser journey.');
  await fs.mkdir(out,{recursive:true});
  const manifest={root,database:'ai_hr_board15_activation_browser',namespace:'board15activation',port:3204,tenantId,locales,companies,departments,configs,people,drafts,
    catalogue:{nationality:{id:nationality.id,value:nationality.value}},policy:{id:policyId,editRoutes:Object.fromEntries(locales.map(locale=>[locale,`/admin/payroll-policy?edit=${policyId}`]))},
    personnelRoutes:Object.fromEntries(locales.map(locale=>[locale,`/admin/personnel`])),personnelAfterSuccessTemplate:'/admin/personnel/{employmentId}',
    expectedValidation:{invalidIdentity:{code:'profile_invalid',fields:[{tab:'profile',field:'icNumber'}]},missingRequired:{code:'required_fields',fields:[{tab:'job',field:'department'}]},stalePolicyAfterDeactivation:{code:'payroll_invalid',fields:[{tab:'payroll',field:'payrollPolicyId'}]}},
    identitySwitcher:'Use the app demo principal switcher for named Activation15 users; no cookie/script injection is required.',
    systemFailure:'Unexpected late-fault app demonstration is not injected by this fixture; the committed DB regression owns late-fault proof. Parent may coordinate a scoped disposable fault separately.',
    actualG00002:'No production employee or data copied/activated. This structure and code suffix are fictional.'};
  await fs.writeFile(path.join(out,'fixture-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await new Promise<void>((resolve,reject)=>process.stdout.write('ACTIVATION15_MANIFEST\n'+JSON.stringify(manifest,null,2)+'\n',error=>error?reject(error):resolve()));
  await owner.client.end();
}
// JSONB captured email identifies a named fictional Draft only; every write still uses its owner.
function sqlDraftEmail(email:string) {return sql`${s.employeeDraft.data}->'profile'->>'primaryEmail' = ${email}`;}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
