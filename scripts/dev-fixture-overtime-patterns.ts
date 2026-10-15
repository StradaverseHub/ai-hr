/** Fictional local fcc2ea42 setup only. No activation, assignment, punches, approval, credit or transfer.
 * Run only from the guarded browser coordinator. A second run must produce the identical manifest;
 * after any browser mutation, preserve the database and refuse rather than repairing the journey.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {and,asc,eq,isNull,inArray} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import type {OvertimePattern,OvertimeExpression} from '../lib/overtime-pattern-model';
import type {OvertimeSampleDraft} from '../lib/overtime-pattern-ui';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard';
const root=fileURLToPath(new URL('..',import.meta.url)),out=path.join(root,'scratchpad/board16-overtime-browser');
const database='ai_hr_board16_overtime_browser',namespace='board16overtimebrowser';
const refusal=demoSeedRefusal(process.env);
if(refusal||process.env.NODE_ENV==='production')throw new Error(refusal??'Development only.');
if(process.env.AUTH_PROVIDER&&process.env.AUTH_PROVIDER!=='workos')throw new Error('Local fictional demo authentication only.');
if(process.env.TEST_DB_NAMESPACE!==namespace)throw new Error('Use the assigned overtime browser namespace.');
const urls:Record<string,URL>={};
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']) {
  let url:URL;try{url=new URL(process.env[key]??'');}catch{throw new Error('Valid local database credentials required.');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/'+database)throw new Error('Only the named disposable local overtime database is allowed.');
  urls[key]=url;
}
if(decodeURIComponent(urls.DATABASE_URL.username)!=='ai_hr_app'||urls.DATABASE_URL.username===urls.MIGRATION_DATABASE_URL.username)throw new Error('Require non-owner ai_hr_app and separate migration credentials.');
if(!process.env.OVERTIME_FIXTURE_COORDINATOR_PID||!process.env.OVERTIME_FIXTURE_CANDIDATE)throw new Error('Use the named browser coordinator, not a standalone fixture command.');
if(String(process.ppid)!==process.env.OVERTIME_FIXTURE_COORDINATOR_PID)throw new Error('Fixture parent is not its declared live coordinator.');
const ancestors=new Set<number>();let ancestor=process.ppid;for(let depth=0;ancestor>1&&depth<64;depth++){if(ancestors.has(ancestor))throw new Error('Invalid coordinator ancestry.');ancestors.add(ancestor);ancestor=Number(execFileSync('ps',['-o','ppid=','-p',String(ancestor)],{encoding:'utf8'}).trim());if(!Number.isSafeInteger(ancestor)||ancestor<0)throw new Error('Unproven coordinator ancestry.');}
for(const [directory,expected]of [['locks',namespace+'-browser-a'],['locks',namespace+'-browser-b'],['devdb-locks',namespace+'-browser-db']]){const base=path.join(os.homedir(),'.aihr-gate-state',directory);const held=fsSync.readdirSync(base).filter(name=>name.startsWith('slot.')).some(name=>{try{const lock=path.join(base,name),pid=Number(fsSync.readFileSync(path.join(lock,'pid'),'utf8').trim());if(fsSync.readFileSync(path.join(lock,'name'),'utf8').trim()!==expected||!ancestors.has(pid))return false;process.kill(pid,0);return true;}catch{return false;}});if(!held)throw new Error('Required live coordinator lock missing: '+expected);}
if(execFileSync('git',['-C',root,'status','--porcelain'],{encoding:'utf8'}).trim()||execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==process.env.OVERTIME_FIXTURE_CANDIDATE)throw new Error('Fixture candidate is dirty or changed.');
const {createDb,client}=await import('../db/client');
const s=await import('../db/schema');
const {resolveEntitlementsTx,isModuleEnabled}=await import('../core/entitlements');
const {createCompany,createDepartment}=await import('../core/admin');
const {hireEmployee,setReportingLine}=await import('../core/org');
const {setCompensation}=await import('../core/comp');
const {setRestDay}=await import('../core/roster');
const {setAttendancePolicy,saveOvertimePatternDraft,getOvertimePattern,overtimePatternSetup,saveAttendanceWorkflow,setAttendanceWorkflowEnabled}=await import('../packs/attendance/service');
const {createBatch,createPayComponent}=await import('../packs/payroll/service');
const {setToilPolicy}=await import('../packs/leave/service');
const {provisionTenant}=await import('../db/provision');
const {requirePackFor}=await import('../localization/registry');
const {todayInKualaLumpur}=await import('../lib/hr-date');
const owner=createDb(process.env.MIGRATION_DATABASE_URL!);let tenantId:string=DEMO_TENANT_ID;
const locales=['en','ms','zh','vi','th','ta'] as const;
const primaryName='Overtime16 fictional primary tenant',foreignName='Overtime16 fictional foreign tenant';
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';return JSON.stringify(value)??'null';}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function one<T>(rows:T[],what:string):T|undefined {if(rows.length>1)throw new Error('Ambiguous fictional '+what+'; preserve existing records.');return rows[0];}
async function context(user:{id:string;tenantId:string;personId:string|null}):Promise<SessionContext> {
 const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,user.tenantId),eq(s.roleAssignment.appUserId,user.id))).orderBy(asc(s.roleAssignment.id));
 const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,user.tenantId));
 return {tenantId:user.tenantId,userId:user.id,personId:user.personId,grants,roles:[...new Set(grants.map(grant=>grant.role))],entitlements};
}
async function main() {
 // Actual connected roles, not just URL labels. App role must remain subject to RLS.
 const appProbe=createDb(process.env.DATABASE_URL!);
 try {const [role]=await appProbe.client`select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;if(role?.name!=='ai_hr_app'||role.rolsuper||role.rolbypassrls)throw new Error('Application connection is not the restricted ai_hr_app role.');}
 finally {await appProbe.client.end();}
 const [ownerRole]=await owner.client`select current_user as name`;if(ownerRole?.name!==decodeURIComponent(urls.MIGRATION_DATABASE_URL.username))throw new Error('Migration connection role differs from configured target.');
 const previousText=await fs.readFile(path.join(out,'fixture-manifest.json'),'utf8').catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
 const previous=previousText?JSON.parse(previousText) as {root?:unknown;database?:unknown;namespace?:unknown;date?:unknown;tenantId?:unknown;foreignTenant?:{id?:unknown};patterns?:Record<string,unknown>}:null;
 if(previousText&&(!previous||previous.root!==root||previous.database!==database||previous.namespace!==namespace||typeof previous.date!=='string'||typeof previous.tenantId!=='string'||typeof previous.foreignTenant?.id!=='string'||!previous.patterns))throw new Error('Existing fixture receipt differs from this target; preserve it.');
 const date=todayInKualaLumpur();if(previous&&previous.date!==date)throw new Error('Current-day context journey crossed a KL date boundary. Preserve it; coordinate a fresh disposable target.');
 const tenants=await owner.db.select().from(s.tenant).orderBy(asc(s.tenant.id));
 if(!tenants.some(row=>row.id===tenantId&&row.name==='Demo Group')||tenants.some(row=>row.id!==tenantId&&row.id!==SYSTEM_TENANT_ID&&!(previous?.foreignTenant?.id===row.id&&row.name===foreignName)&&!(previous?.tenantId===row.id&&row.name===primaryName)))throw new Error('Only the seeded demo and receipt-bound fictional foreign tenant are allowed.');
 async function provisionedAdmin(name:string,email:string,expectedId:unknown) {
  let tenant=one(await owner.db.select().from(s.tenant).where(eq(s.tenant.name,name)),name);
  if(!tenant){if(previous)throw new Error('Previously declared tenant missing; no replacement.');const made=await owner.db.transaction(tx=>provisionTenant(tx,{name,adminEmail:email,country:'MY',modules:['attendance','payroll','toil'],baseUrl:'http://127.0.0.1:3210'}));tenant=one(await owner.db.select().from(s.tenant).where(eq(s.tenant.id,made.tenantId)),'created tenant');/* Activation token discarded; no transport runs. */}
  if(!tenant||previous&&tenant.id!==expectedId)throw new Error('Fictional tenant identity changed.');
  const person=one(await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenant.id),eq(s.person.primaryEmail,email))),'provisioned administrator person');
  if(!person)throw new Error('Canonical fictional administrator person missing.');
  const login='ot16-fixture:bootstrap:'+(name===primaryName?'primary':'foreign');
  let user=one(await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenant.id),eq(s.appUser.workosUserId,login))),'fictional bootstrap login');
  if(!user)[user]=await owner.db.insert(s.appUser).values({tenantId:tenant.id,personId:person.id,workosUserId:login,onboardedAt:new Date()}).returning();
  if(user.archivedAt||user.personId!==person.id)throw new Error('Fictional bootstrap login changed.');
  const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
  if(!grants.length)await owner.db.insert(s.roleAssignment).values({tenantId:tenant.id,appUserId:user.id,companyId:null,role:'hr_admin'});
  else if(grants.length!==1||grants[0].role!=='hr_admin'||grants[0].companyId!==null)throw new Error('Fictional bootstrap grants changed.');
  return {tenant,user,person};
 }
 const primary=await provisionedAdmin(primaryName,'ot16-bootstrap@demo.test',previous?.tenantId);tenantId=primary.tenant.id;
 const bootstrap=await context(primary.user);
 for(const module of ['attendance','payroll','toil'])if(!isModuleEnabled(bootstrap,module))throw new Error('Canonical provision did not enable required module: '+module+'. No fixture bypass is permitted.');
 const companies:Record<string,string>={},departments:Record<string,string>={};
 for(const key of ['Main','Foreign','Empty']) {
  let company=one(await owner.db.select().from(s.company).where(and(eq(s.company.tenantId,tenantId),eq(s.company.companyLabel,'OT16-'+key))),key+' company');
  if(!company){if(previous)throw new Error('Previously declared company missing; no replacement.');const made=await createCompany(bootstrap,{legalName:'Overtime16 fictional '+key,companyLabel:'OT16-'+key,country:'MY',currency:'MYR'});company=one(await owner.db.select().from(s.company).where(eq(s.company.id,made.id)),'created company');}
  if(!company||company.archivedAt||company.country!=='MY'||company.currency!=='MYR'||company.legalName!=='Overtime16 fictional '+key)throw new Error('Fictional company changed; preserve it.');companies[key]=company.id;
  let department=one(await owner.db.select().from(s.department).where(and(eq(s.department.companyId,company.id),eq(s.department.name,'Overtime16 '+key+' team'))),key+' department');
  if(!department){if(previous)throw new Error('Previously declared department missing.');const made=await createDepartment(bootstrap,{companyId:company.id,name:'Overtime16 '+key+' team'});department=one(await owner.db.select().from(s.department).where(eq(s.department.id,made.id)),'created department');}
  if(!department||department.archivedAt)throw new Error('Fictional department changed.');departments[key]=department.id;
  const [policy]=await owner.db.select().from(s.attendancePolicy).where(eq(s.attendancePolicy.companyId,company.id));
  if(!previous)await setAttendancePolicy(bootstrap,{companyId:company.id,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7],otApprovalCalculation:'requested'});
  else if(!policy||policy.workStart!=='09:00:00'||policy.workEnd!=='18:00:00'||policy.breakMinutes!==60||policy.otApprovalCalculation!=='requested'||digest(policy.workingDays)!==digest([1,2,3,4,5,6,7]))throw new Error('Fixture Attendance policy changed; no repair.');
 }
 type Principal={personId:string;employmentId:string;employeeCode:string;companyId:string;userId:string;login:string;role:'hr_admin'|'manager'|'employee';tenantId:string};
 const people:Record<string,Principal>={};
 for(const key of ['HR','Manager','Hourly','Fractional','PriceUnknown','ToilFirst','CashFirst','Incomplete','Ineligible','Legacy','ForeignHR','ForeignEmployee','EmptyHR']) {
  const companyKey=key.startsWith('Foreign')?'Foreign':key==='EmptyHR'?'Empty':'Main',employeeCode='OT16-'+key.toUpperCase(),email='ot16-'+key.toLowerCase()+'@demo.test';
  let person=one(await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,email))),key+' person');
  let employment=person?one(await owner.db.select().from(s.employment).where(and(eq(s.employment.personId,person.id),eq(s.employment.employeeCode,employeeCode))),key+' employment'):undefined;
  if(!person){if(previous)throw new Error('Previously declared person missing.');const made=await hireEmployee(bootstrap,{person:{fullName:'Overtime16 '+key,primaryEmail:email},employeeCode,companyId:companies[companyKey],departmentId:departments[companyKey],employmentType:'full_time',hiredOn:date.slice(0,7)+'-01'});person=one(await owner.db.select().from(s.person).where(eq(s.person.id,made.personId)),'created person');employment=one(await owner.db.select().from(s.employment).where(eq(s.employment.id,made.employmentId)),'created employment');}
  if(!person||!employment||employment.companyId!==companies[companyKey]||employment.terminatedOn||person.fullName!=='Overtime16 '+key)throw new Error('Fictional employment changed; no repair.');
  const salary=['PriceUnknown','ToilFirst','CashFirst'].includes(key)?8000:3500;
  const comp=await owner.db.select().from(s.compensation).where(eq(s.compensation.employmentId,employment.id));
  if(!comp.length){if(previous)throw new Error('Previously declared compensation missing.');await setCompensation(bootstrap,{employmentId:employment.id,basicSalary:salary,monthlyAllowance:0,currency:'MYR',effectiveFrom:employment.hiredOn});}
  else if(comp.length!==1||Number(comp[0].basicSalary)!==salary||comp[0].currency!=='MYR')throw new Error('Fictional compensation changed; preserve its history.');
  const login='ot16-fixture:'+key;let user=one(await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,login))),key+' login');
  if(!user)[user]=await owner.db.insert(s.appUser).values({tenantId,personId:person.id,workosUserId:login,onboardedAt:new Date()}).returning();
  if(user.archivedAt||user.personId!==person.id)throw new Error('Fictional login changed.');
  const role=key.endsWith('HR')?'hr_admin' as const:key==='Manager'?'manager' as const:'employee' as const;
  const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
  if(!grants.length)await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:user.id,companyId:employment.companyId,role});
  else if(grants.length!==1||grants[0].companyId!==employment.companyId||grants[0].role!==role)throw new Error('Fictional role grants changed.');
  people[key]={tenantId,personId:person.id,employmentId:employment.id,employeeCode,companyId:employment.companyId,userId:user.id,login,role};
 }
 const hr=await context({id:people.HR.userId,...people.HR}),foreignHr=await context({id:people.ForeignHR.userId,...people.ForeignHR});
 for(const key of ['Hourly','Fractional','PriceUnknown','ToilFirst','CashFirst','Incomplete','Ineligible','Legacy']) {
  const line=one(await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId,people[key].employmentId),eq(s.reportingLine.lineType,'administrative'),isNull(s.reportingLine.supersededAt),isNull(s.reportingLine.validTo))),key+' manager');
  if(!line){if(previous)throw new Error('Previously declared manager line missing.');await setReportingLine(hr,{subordinateEmploymentId:people[key].employmentId,managerEmploymentId:people.Manager.employmentId,lineType:'administrative',validFrom:date.slice(0,7)+'-01'});}else if(line.managerEmploymentId!==people.Manager.employmentId)throw new Error('Fixture manager changed.');
 }
 const workflowEmployees=['Hourly','Fractional','PriceUnknown','ToilFirst','CashFirst','Incomplete','Ineligible','Legacy'].map(key=>people[key].employmentId).sort();
 let workflow=one(await owner.db.select().from(s.attendanceWorkflowTemplate).where(and(eq(s.attendanceWorkflowTemplate.companyId,companies.Main),eq(s.attendanceWorkflowTemplate.code,'OT16_MANAGER'),isNull(s.attendanceWorkflowTemplate.supersededAt))),'approval workflow');
 if(!workflow){if(previous)throw new Error('Previously declared approval workflow missing.');workflow=await saveAttendanceWorkflow(hr,{companyId:companies.Main,routingVersion:2,code:'OT16_MANAGER',name:'Overtime16 direct manager',description:'Fictional local actual approval route',applicationType:'self_overtime',priority:1,criteria:{employeeIds:workflowEmployees},stages:[{name:'Level 1',level:{kind:'direct_manager',employmentId:null,alternates:[]}}],active:true});await setAttendanceWorkflowEnabled(hr,companies.Main,'self_overtime',true);}
 const [workflowSetting]=await owner.db.select().from(s.attendanceWorkflowSetting).where(and(eq(s.attendanceWorkflowSetting.companyId,companies.Main),eq(s.attendanceWorkflowSetting.applicationType,'self_overtime')));
 if(!workflow||!workflow.active||workflow.routingVersion!==2||digest(workflow.criteria)!==digest({employeeIds:workflowEmployees})||!workflowSetting?.enabled)throw new Error('Fixture approval route changed; preserve it.');
 const [toil]=await owner.db.select().from(s.toilPolicy).where(eq(s.toilPolicy.companyId,companies.Main));
 if(!previous)await setToilPolicy(hr,{companyId:companies.Main,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'lapse',allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true});
 else if(!toil?.enabled||toil.autoAccrueOnApproval||toil.accrualBasis!=='hours_worked')throw new Error('Fixture TOIL policy changed; no repair.');
 // A real rest-day owner establishes the controlled TOIL case; no accrual or Attendance row is made.
 for(const key of ['PriceUnknown','ToilFirst','CashFirst']){const [rest]=await owner.db.select().from(s.rosterAssignment).where(and(eq(s.rosterAssignment.employmentId,people[key].employmentId),eq(s.rosterAssignment.shiftDate,date)));
 if(!rest){if(previous)throw new Error('Previously declared rest day missing.');await setRestDay(hr,{employmentId:people[key].employmentId,shiftDate:date,note:'Overtime16 controlled duration/settlement journey'});}else if(!rest.isRestDay)throw new Error('Controlled TOIL rest day changed.');}
 const foreign=await provisionedAdmin(foreignName,'ot16-foreign-tenant@demo.test',previous?.foreignTenant?.id),foreignTenant=foreign.tenant,foreignUser=foreign.user;
 const tenantHr=await context(foreignUser);
 async function overtimeItem(ctx:SessionContext) {
  const pack=requirePackFor('MY'),seed=pack.payComponents.defaults.find(row=>row.code===pack.payComponents.backfillCodes.overtime);if(!seed)throw new Error('Country overtime mapping seed unavailable.');
  let item=one(await owner.db.select().from(s.payComponent).where(and(eq(s.payComponent.tenantId,ctx.tenantId),eq(s.payComponent.code,seed.code))),'OT earning item');
  if(!item){if(previous)throw new Error('Previously declared earning item missing.');const made=await createPayComponent(ctx,seed);item=one(await owner.db.select().from(s.payComponent).where(eq(s.payComponent.id,made.id)),'created earning item');}
  if(!item||item.archivedAt||item.kind!==seed.kind||item.isNonPayable!==seed.isNonPayable||item.includedInEpf!==seed.includedInEpf||item.includedInSocsoEis!==seed.includedInSocsoEis||item.includedInPcb!==seed.includedInPcb||item.includedInHrdfBase!==seed.includedInHrdfBase)throw new Error('Existing OT earning treatment changed; preserve it.');return {id:item.id,code:item.code};
 }
 const earningItem=await overtimeItem(hr),foreignItem=await overtimeItem(tenantHr);
 const yes={id:'eligible',type:'constant' as const,value:true};
 const literal=(id:string,unit:OvertimeExpression['unit'],value:string):OvertimeExpression=>({id,type:'literal',unit,value,...(unit==='money'||unit==='moneyPerHour'?{currency:'MYR'}:{})});
 function definition(kind:'hourly'|'fractional'|'wholeFlat'|'priceUnknown'|'ineligible'):OvertimePattern {
  const amount:OvertimeExpression=kind==='priceUnknown'?{id:'salary_rate',type:'hourlyRate',unit:'moneyPerHour',base:{id:'salary_cap',type:'cap',unit:'money',value:{id:'salary',type:'field',unit:'money',field:'basicSalary'},ceiling:literal('cap','money','4000')},divisorMinutes:literal('divisor','minutes','12480')}:literal('hourly_rate','moneyPerHour','60');
  return {v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'latest',eligibility:kind==='ineligible'?{...yes,value:false}:yes,eligibleMinutes:kind==='hourly'?{id:'eligible_duration',type:'max',unit:'minutes',left:literal('zero','minutes','0'),right:{id:'over_normal',type:'subtract',unit:'minutes',left:{id:'actual',type:'field',unit:'minutes',field:'actualWorkingMinutes'},right:{id:'required',type:'field',unit:'minutes',field:'requiredWorkingMinutes'}}}:literal('configured_minutes','minutes',kind==='wholeFlat'||kind==='priceUnknown'?'60':'60.5'),durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Fictional configured rate',description:'Browser setup only; no result asserted',priority:1,when:{id:'rate_when',type:'constant',value:true},timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:earningItem.id,currency:'MYR'},payment:kind==='fractional'||kind==='wholeFlat'?{method:'flat',basis:'day',chargeId:'day_charge',amount:literal('flat_amount','money','250.125')}:{method:'hourly',rate:amount,multiplier:literal('multiplier','scalar','1.5')}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};
 }
 const patterns:Record<string,{patternId:string;versionId:string;revision:number;definitionSha256:string;routes:Record<string,string>;purpose:string}>={};
 for(const [key,kind,companyKey,purpose] of [
  ['hourly','hourly','Main','Activate and assign Hourly; actual work minus required work; literal hourly rate and multiplier.'],
  ['fractional','fractional','Main','Activate and assign Fractional; independent approved bound >=61; exact60.5 minutes and recorded money rounding.'],
  ['priceUnknown','priceUnknown','Main','Activate and assign PriceUnknown; Manager approval must preserve whole 60-minute duration while salary-private cash pricing refuses; canonical TOIL must use salary-free duration freshness; separate ready-price subjects test both claim orderings.'],
  ['toilFirst','wholeFlat','Main','Ready flat cash and whole 60-minute duration on a rest day: bank canonical TOIL first, then cash must refuse exact source conflict.'],
  ['cashFirst','wholeFlat','Main','Ready flat cash and whole 60-minute duration on a rest day: transfer cash first, then TOIL must refuse exact source conflict.'],
  ['incomplete','hourly','Main','Assign Incomplete, clock in only; actual missing duration must refuse, then complete by actual clock-out.'],
  ['ineligible','ineligible','Main','Known false eligibility must show known zero/ineligible rather than unavailable.'],
  ['foreignCompany','fractional','Foreign','Main HR must not read/edit this foreign-company Draft; ForeignHR may.'],
  ['foreignTenant','fractional','Tenant','Demo principals must not read this other-tenant Draft.'],
 ] as const) {
  const ctx=companyKey==='Foreign'?foreignHr:companyKey==='Tenant'?tenantHr:hr,companyId=companyKey==='Tenant'?(await owner.db.select().from(s.company).where(eq(s.company.tenantId,foreignTenant.id)))[0]?.id:companies[companyKey];if(!companyId)throw new Error('Fictional scope company missing.');
  const def=definition(kind);if(companyKey==='Tenant')def.rates[0].tiers[0].mapping.earningItemId=foreignItem.id;
  const code='OT16_'+key.toUpperCase(),name='Overtime16 '+key,description='Fictional local acceptance case. Browser performs activation and all actual calculations.';
  let pattern=one(await owner.db.select().from(s.overtimePattern).where(and(eq(s.overtimePattern.tenantId,ctx.tenantId),eq(s.overtimePattern.code,code))),key+' pattern');
  if(!pattern){if(previous)throw new Error('Previously declared policy missing; no replacement.');const made=await saveOvertimePatternDraft(ctx,{draft:{code,creationCompanyId:companyId,companyIds:[companyId],name,description,definition:def}});pattern=one(await owner.db.select().from(s.overtimePattern).where(eq(s.overtimePattern.id,made.patternId)),'created pattern');}
  if(!pattern||pattern.archivedAt)throw new Error('Fixture policy changed.');const detail=await getOvertimePattern(ctx,pattern.id),version=detail?.versions[0];
  if(!detail||detail.versions.length!==1||detail.assignments.length||!version||version.activatedAt||version.revision!==1||version.name!==name||version.description!==description||digest(version.definition)!==digest(def)||digest(version.companyIds)!==digest([companyId]))throw new Error('Browser already changed a declared policy; preserve the journey, do not reseed.');
  patterns[key]={patternId:pattern.id,versionId:version.id,revision:version.revision,definitionSha256:digest(def),purpose,routes:Object.fromEntries(locales.map(locale=>[locale,`/admin/attendance/settings/overtime-patterns?pattern=${pattern!.id}&version=${version.id}`]))};
 }
 // No Attendance or financial result is manufactured. Existing browser work must never be reset.
 const used=await owner.db.select({id:s.attendance.id}).from(s.attendance).where(eq(s.attendance.employmentId,people.Fractional.employmentId)).limit(1);if(used.length)throw new Error('A Records journey has started; preserve it rather than claiming a fresh fixture.');
 let batch=one(await owner.db.select().from(s.payrollBatch).where(and(eq(s.payrollBatch.companyId,companies.Main),eq(s.payrollBatch.payPeriod,date.slice(0,7)),eq(s.payrollBatch.runType,'regular'))),'draft Payroll run');
 const batchEmployees=['Hourly','Fractional','Ineligible','ToilFirst','CashFirst'].map(key=>people[key].employmentId);
 if(!batch){if(previous)throw new Error('Previously declared Payroll run missing.');const made=await createBatch(hr,{companyId:companies.Main,payPeriod:date.slice(0,7),scope:{employmentIds:batchEmployees}});batch=one(await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,made.batchId)),'created run');}
 if(!batch||batch.status!=='draft')throw new Error('Payroll journey changed; preserve it.');
 const setup=await overtimePatternSetup(hr,{companyIds:[companies.Main],employeeIds:['Hourly','Fractional','PriceUnknown','ToilFirst','CashFirst','Incomplete','Ineligible','Legacy'].map(key=>people[key].employmentId)});
 const sample:OvertimeSampleDraft={date,currency:{code:'MYR',minorScale:2},sessionGranularity:'dayAggregate',approvalStatus:'approved',approvalMinutes:'61',facts:{companyId:companies.Main,employmentId:people.Hourly.employmentId,actualWorkingMinutes:'541',requiredWorkingMinutes:'480',lateMinutes:'0',basicSalary:'3500',calculationBase:'3500',dayType:'workday'},segments:[{id:'sample_segment',sessionId:'sample_session',date,rawMinutes:'541',dayType:'workday',endDayType:'',clockKnown:false,from:'',to:'',endDayOffset:0}],resources:[]};
 const priceUnknownSample:OvertimeSampleDraft={...sample,facts:{...sample.facts,basicSalary:'',calculationBase:''}};
 const deductionSample:OvertimeSampleDraft={...sample,facts:{...sample.facts,lateMinutes:'15'},resources:[{id:'sample_late',resource:'lateIn',basis:'day',sessionId:'',quantity:'15',unit:'minutes',evidence:'measured'},{id:'sample_break',resource:'postOtBreak',basis:'day',sessionId:'',quantity:'30',unit:'minutes',evidence:'policyCapacity'}]};
 const businessEpoch=digest(await owner.db.select({id:s.domainEvent.id,aggregateId:s.domainEvent.aggregateId,eventType:s.domainEvent.eventType,sequence:s.domainEvent.sequence}).from(s.domainEvent).where(inArray(s.domainEvent.tenantId,[tenantId,foreignTenant.id])).orderBy(asc(s.domainEvent.sequence),asc(s.domainEvent.id)));
 const manifest={businessEpoch,root,database,namespace,port:3210,tenantId,date,month:date.slice(0,7),locales,language:'Routes are unprefixed. Select language in the app; NEXT_LOCALE cookie chooses en/ms/zh/ta/th/vi without changing the route.',companies,departments,people,earningItem,patterns,samples:{base:sample,priceUnknown:priceUnknownSample,deductions:deductionSample},workflow:{id:workflow.id,lineageId:workflow.lineageId,version:workflow.version},batch:{id:batch.id,employmentIds:batchEmployees,status:'draft'},foreignTenant:{id:foreignTenant.id,name:foreignName,userId:foreignUser.id,principalName:foreign.person.fullName,login:foreignUser.workosUserId,companyId:(await owner.db.select().from(s.company).where(eq(s.company.tenantId,foreignTenant.id)))[0]?.id},
  setup:{employeeIds:setup.employees.map(row=>row.id).sort(),earningItemIds:setup.earningItems.map(row=>row.id).sort(),readerLimitations:setup.readerLimitations},
  routes:{workspace:'/admin/attendance/settings/overtime-patterns',new:'/admin/attendance/settings/overtime-patterns?new=1',emptySearch:'/admin/attendance/settings/overtime-patterns?search=OT16_NO_MATCH',daily:'/attendance/daily?date='+date,individual:'/attendance/individual?emp={employmentId}&from='+date+'&to='+date,myRecords:'/attendance/my-records',approval:'/approvals',payroll:'/admin/payroll',credit:'/leave/credit-details'},
  intendedWindows:{complete:{checkIn:'09:00',checkOut:'19:01',requestMinutes:61},incomplete:{checkIn:'09:00',checkOut:null},legacy:{checkIn:'09:00',checkOut:'19:00'}},
  setupOnly:true,outcomes:'UNRUN: browser must make actual saved changes, previews, activation, assignments, punches, approvals, calculation and transfers. Fixture does not assert these outcomes.',
  emptyState:'EmptyHR company has no formula Draft; tenant-wide legacy compatibility can still be listed. No-match search tests the empty list honestly. New editor tests unconfigured controls.',
  limitations:['No SMTP/provider worker is started; no notification delivery is tested.','No sourceUnavailable marker is forged: incomplete clocks are a real refusal; missing/unreadable-source evidence remains a separate owner regression.','Payroll generation may identify further canonical statutory/profile prerequisites. Correct them through actual UI; do not force a successful payslip or call the fixture again.','After browser changes or a KL date rollover, preserve this database; fixture rerun intentionally refuses.']};
 await fs.mkdir(out,{recursive:true});const text=JSON.stringify(manifest,null,2)+'\n';if(previousText&&previousText!==text)throw new Error('Fixture facts/identity manifest drifted; preserve prior receipt.');await fs.writeFile(path.join(out,'fixture-manifest.json'),text);
 await new Promise<void>((resolve,reject)=>process.stdout.write('OVERTIME16_MANIFEST\n'+text,error=>error?reject(error):resolve()));
}
try {await main();}finally {await owner.client.end();await client.end();}
