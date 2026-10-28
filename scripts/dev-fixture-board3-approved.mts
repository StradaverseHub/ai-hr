/** Fictional Board 3 browser prerequisites. Not browser acceptance evidence.
 * Run only inside dev-browser-board3-approved.mjs's three proved locks.
 * No seed/reset/migration here. Business writes use canonical services. Local owner provisioning is
 * limited to login grants, module entitlement and an explicitly historical legacy snapshot.
 */
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {and,eq,isNull} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import type {RewardRole} from '../packs/rewards/model';
import type {ImportRecord} from '../lib/import-schema';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard';
const root=fileURLToPath(new URL('..',import.meta.url));
const out=path.join(root,'scratchpad/board3-jd');
const database='ai_hr_board3_browser',namespace='b3browser';
const refusal=demoSeedRefusal(process.env);
if(refusal||process.env.NODE_ENV==='production')throw new Error(refusal??'Development only.');
if(process.env.AUTH_PROVIDER!=='workos'||process.env.TEST_DB_NAMESPACE!==namespace||process.env.AIHR_BOARD3_FIXTURE!=='true')throw new Error('Use the guarded Board 3 coordinator.');
const urls=['DATABASE_URL','MIGRATION_DATABASE_URL'].map(key=>{
 let url:URL;try{url=new URL(process.env[key]??'');}catch{throw new Error('Valid local database credentials required.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.search||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!==`/${database}`)throw new Error('Named disposable local Board 3 database required.');return url;
});
if(decodeURIComponent(urls[0].username)!=='ai_hr_app'||decodeURIComponent(urls[0].username)===decodeURIComponent(urls[1].username))throw new Error('Separate restricted app and migration roles required.');
function proveLock(directory:string,expected:string){
 for(const entry of syncFs.readdirSync(directory).filter(name=>name.startsWith('slot.'))){try{const dir=path.join(directory,entry),name=syncFs.readFileSync(path.join(dir,'name'),'utf8').trim(),pid=Number(syncFs.readFileSync(path.join(dir,'pid'),'utf8').trim());if(name===expected&&Number.isSafeInteger(pid)&&pid>1){process.kill(pid,0);return;}}catch{}}
 throw new Error('Required live coordinator lock missing: '+expected);
}
const gate=path.join(os.homedir(),'.aihr-gate-state');
proveLock(path.join(gate,'locks'),'board3-approved-browser-a');proveLock(path.join(gate,'locks'),'board3-approved-browser-b');proveLock(path.join(gate,'devdb-locks'),'board3-approved-browser-db');
const {createDb,client:appClient}=await import('../db/client');
const s=await import('../db/schema');
const {resolveEntitlementsTx}=await import('../core/entitlements');
const {createCompany,bulkSaveLabels,createJobGrade}=await import('../core/admin');
const {hireEmployee}=await import('../core/org');
const {setCompensation}=await import('../core/comp'); // Employment spine, intentionally outside payroll pack.
const {createMovementEvent,movementHistory,resignationInformation}=await import('../core/movement');
const {requirePackFor}=await import('../localization/registry');
const {getPeopleGeneral,savePeopleGeneral}=await import('../core/people-general');
const {createProfileOption,listAllProfileOptions}=await import('../core/profile-options');
const {getEmploymentCostAllocations,previewEmploymentCostAllocations,saveEmploymentCostAllocations}=await import('../core/employment-cost-allocations');
const rewards=await import('../packs/rewards/service');
const {emptyFacts,emptyRecommendation}=await import('../packs/rewards/model');
const {saveJobDraft,getJobDocumentPage}=await import('../packs/job-descriptions/service');
const {todayInKualaLumpur}=await import('../lib/hr-date');
const {ALLOCATION_COLUMNS,ALLOCATION_SHEET}=await import('../lib/employment-cost-allocation');
const {employeeTemplate}=await import('../lib/import-template');
const {EMPLOYEE_XLSX_SHEETS}=await import('../lib/import-template-xlsx');
const {buildXlsx}=await import('../lib/spreadsheet');
const {toCsv}=await import('../lib/csv');
const owner=createDb(process.env.MIGRATION_DATABASE_URL!,{max:2}),tenantId=DEMO_TENANT_ID;
const today=todayInKualaLumpur();
function offset(days:number){const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
async function context(user:{id:string;personId:string|null}):Promise<SessionContext>{
 const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
 const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId));
 return{tenantId,userId:user.id,personId:user.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements};
}
async function main(){
 const tenants=await owner.db.select().from(s.tenant);
 if(!tenants.some(t=>t.id===tenantId&&t.name==='Demo Group')||tenants.some(t=>t.id!==tenantId&&t.id!==SYSTEM_TENANT_ID))throw new Error('Seeded fictional demo tenants only; preserving database.');
 const[seedAdmin]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,'user_dev_admin'),isNull(s.appUser.archivedAt)));
 if(!seedAdmin)throw new Error('Seed administrator missing.');
 // Installation provisioning, not a Rewards business outcome; never changes an existing entitlement.
 const[rewardModule]=await owner.db.select().from(s.tenantModule).where(and(eq(s.tenantModule.tenantId,tenantId),eq(s.tenantModule.moduleCode,'rewards'),isNull(s.tenantModule.companyId)));
 if(!rewardModule)await owner.db.insert(s.tenantModule).values({tenantId,moduleCode:'rewards',status:'active'});
 else if(rewardModule.status!=='active'||rewardModule.expiresAt)throw new Error('Existing fixture entitlement changed; preserving it.');
 const bootstrap=await context(seedAdmin);
 // Approved939ffafb: a code selected from a workbook must beat another option's label.
 // Base is a tenant-level catalogue; company Criteria belong to the separate org masters below.
 const profileChoices:Record<string,{id:string;value:string;label:string;isActive:boolean}>={};
 const baseDefinitions=[
  ['sameA','0003901','Shared fictional base',true],
  ['sameB','0003902','Shared fictional base',true],
  ['codeLabelCollision','0003903','0003901',true],
  ['xmlCode','00039&<A>','Fictional XML & base',true],
  ['inactive','0003904','Inactive fictional base',false],
 ] as const;
 let allProfiles=await listAllProfileOptions(bootstrap);
 for(const[key,value,label,isActive]of baseDefinitions){
  let option=allProfiles.base.find(row=>row.value===value);
  if(!option){await createProfileOption(bootstrap,{category:'base',value,label,isActive});allProfiles=await listAllProfileOptions(bootstrap);option=allProfiles.base.find(row=>row.value===value);}
  if(!option||option.label!==label||option.isActive!==isActive)throw new Error('Existing import-reference fixture changed; preserving it.');
  profileChoices[key]={id:option.id,value:option.value,label:option.label,isActive:option.isActive};
 }
 const companies:Record<string,string>={};
 for(const key of ['Main','Foreign']){
  const marker=`B3-FICTION-${key}`;
  let[row]=await owner.db.select().from(s.company).where(and(eq(s.company.tenantId,tenantId),eq(s.company.companyLabel,marker)));
  if(!row){const made=await createCompany(bootstrap,{legalName:`Board3 fictional ${key} company`,companyLabel:marker,country:'MY',currency:'MYR'});[row]=await owner.db.select().from(s.company).where(eq(s.company.id,made.id));}
  if(row.archivedAt||row.country!=='MY')throw new Error('Existing fictional company changed; preserving it.');companies[key]=row.id;
 }
 const masters:Record<string,{id:string;code:string;label:string;companyId:string;kind:string}>={};
 const definitions=[
  ['general','business_unit','B3-GENERAL','General fixture unit','Main'],
  ['unused','business_unit','B3-UNUSED','Unused review fixture','Main'],['used','business_unit','B3-USED','Used review fixture','Main'],['locked','business_unit','B3-LOCKED','Locked review fixture','Main'],
  ['sameA','business_unit','B3-SAME-A','Same configured label','Main'],['sameB','business_unit','B3-SAME-B','Same configured label','Main'],
  ['foreignBu','business_unit','B3-FOREIGN','Foreign fixture label','Foreign'],
  ['department','department','Board3 fictional personnel department','People operations','Main'],['foreignDepartment','department','Board3 fictional foreign department','Foreign department','Foreign'],
  ['position','position','Board3 fictional analyst position','Operations analyst','Main'],
  ['costA','cost_center','B3-COST-A','Shared services','Main'],['costB','cost_center','B3-COST-B','Shared services','Main'],['foreignCost','cost_center','B3-COST-FOREIGN','Foreign restricted cost','Foreign'],
 ] as const;
 for(const[key,kind,code,label,companyKey]of definitions){
  const table=kind==='business_unit'?s.businessUnit:kind==='department'?s.department:kind==='position'?s.position:s.costCenter;
  const codeCondition=kind==='department'?eq(s.department.name,code):kind==='position'?eq(s.position.title,code):kind==='business_unit'?eq(s.businessUnit.code,code):eq(s.costCenter.code,code);
  let[row]=await owner.db.select({id:table.id,label:table.label,archivedAt:table.archivedAt}).from(table).where(and(eq(table.tenantId,tenantId),eq(table.companyId,companies[companyKey]),codeCondition));
  if(!row){const made=await bulkSaveLabels(bootstrap,kind,{creates:[{key,companyId:companies[companyKey],companyIds:[companies[companyKey]],code,name:code,title:code,label}],updates:[]});const id=made.createdIds.find(x=>x.key===key)?.id;if(!id)throw new Error('Canonical label creation returned no identity.');[row]=await owner.db.select({id:table.id,label:table.label,archivedAt:table.archivedAt}).from(table).where(eq(table.id,id));}
  if(row.archivedAt||row.label!==label)throw new Error('Existing fictional label changed; preserving it.');masters[key]={id:row.id,code,label,companyId:companies[companyKey],kind};
 }
 let[grade]=await owner.db.select().from(s.jobGrade).where(and(eq(s.jobGrade.tenantId,tenantId),eq(s.jobGrade.code,'B3_GRADE')));
 if(!grade){const made=await createJobGrade(bootstrap,{code:'B3_GRADE',name:'Board3 fictional grade',rank:3});[grade]=await owner.db.select().from(s.jobGrade).where(eq(s.jobGrade.id,made.id));}
 if(grade.archivedAt)throw new Error('Fixture grade archived; preserving it.');
 type Identity={personId:string;employmentId:string;employeeCode:string;companyId:string;userId:string;login:string};
 const people:Record<string,Identity>={};
 const keys=['HR','Preparer','Reviewer','Approver','DeniedEmployee','Subject','Legacy','NricA','NricB','NricFresh','RewardUnused','RewardUsed','RewardLocked','AccessCandidate','Foreign'] as const;
 for(const key of keys){
  const foreign=key==='Foreign',companyId=companies[foreign?'Foreign':'Main'],employeeCode=`B3-${key.toUpperCase()}`,email=`board3-${key.toLowerCase()}@example.invalid`,login=`board3-fictional:${key}`;
  const bu=key==='RewardUnused'?'unused':key==='RewardUsed'?'used':key==='RewardLocked'?'locked':foreign?'foreignBu':'general';
  let[person]=await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,email)));
  let[employment]=person?await owner.db.select().from(s.employment).where(and(eq(s.employment.personId,person.id),eq(s.employment.companyId,companyId))):[];
  if(!person&&!employment){const made=await hireEmployee(bootstrap,{person:{fullName:`Board3 fictional ${key}`,primaryEmail:email},employeeCode,companyId,departmentId:masters[foreign?'foreignDepartment':'department'].id,businessUnitId:masters[bu].id,positionId:foreign?undefined:masters.position.id,gradeId:grade.id,employmentType:'full_time',hiredOn:offset(-400)});[person]=await owner.db.select().from(s.person).where(eq(s.person.id,made.personId));[employment]=await owner.db.select().from(s.employment).where(eq(s.employment.id,made.employmentId));}
  if(!person||!employment||employment.employeeCode!==employeeCode||employment.terminatedOn)throw new Error('Existing fictional person/lifecycle changed; preserving it.');
  let[user]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,login)));
  if(!user)[user]=await owner.db.insert(s.appUser).values({tenantId,personId:person.id,workosUserId:login,onboardedAt:new Date()}).returning();
  if(user.archivedAt||user.personId!==person.id)throw new Error('Existing fictional login changed; preserving it.');
  const role=['HR','Preparer','Reviewer','Approver'].includes(key)?'hr_admin' as const:'employee' as const;
  const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
  if(!grants.length)await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:user.id,companyId,role});
  else if(grants.length!==1||grants[0].role!==role||grants[0].companyId!==companyId)throw new Error('Existing fixture grants changed; preserving them.');
  people[key]={personId:person.id,employmentId:employment.id,employeeCode,companyId,userId:user.id,login};
  if(key.startsWith('Reward')){const[comp]=await owner.db.select().from(s.compensation).where(and(eq(s.compensation.employmentId,employment.id),isNull(s.compensation.supersededAt)));if(!comp)await setCompensation(bootstrap,{employmentId:employment.id,basicSalary:3000,currency:'MYR',payMode:'monthly',paymentTerm:'monthly',effectiveFrom:employment.hiredOn,remarks:'Fixed fictional salary prerequisite; no payroll batch is created.'});}
 }
 const hr=await context({id:people.HR.userId,personId:people.HR.personId});
 const preparer=await context({id:people.Preparer.userId,personId:people.Preparer.personId});
 // Parent-authorized legacy fixture exception: a pre-owner snapshot, never a synthetic Movement event.
 const[legacy]=await owner.db.select().from(s.employment).where(eq(s.employment.id,people.Legacy.employmentId));
 if(!legacy.tenderResignationDate&&!legacy.resignationDate&&!legacy.lastWorkingDate)await owner.db.update(s.employment).set({tenderResignationDate:offset(-10),resignationDate:offset(39),lastWorkingDate:offset(40)}).where(eq(s.employment.id,legacy.id));
 const legacyInfo=await resignationInformation(hr,people.Legacy.employmentId);
 if(Object.values(legacyInfo).some(x=>x.source.kind!=='legacy'))throw new Error('Legacy fixture changed; preserving it.');
 let history=await movementHistory(hr,people.Subject.employmentId);
 for(const[kind,effectiveDate,tender,resigned,endDate,remarks]of[
  ['resignation',offset(-2),offset(-8),offset(49),offset(50),'Board3 fictional current resignation'],
  ['resignation',offset(15),offset(15),offset(69),offset(70),'Board3 fictional scheduled resignation'],
 ] as const){if(!history.some(x=>x.remarks===remarks)){await createMovementEvent(hr,{employmentId:people.Subject.employmentId,kind,effectiveDate,tenderResignationDate:tender,resignationEffectiveDate:resigned,endDate,remarks});history=await movementHistory(hr,people.Subject.employmentId);}}
 if(!history.some(x=>x.remarks==='Board3 fictional current resignation'&&x.status==='applied')||!history.some(x=>x.remarks==='Board3 fictional scheduled resignation'&&x.status==='pending'))throw new Error('Canonical resignation prerequisite differs from expected current/pending state.');
 const resignation={legacy:legacyInfo,current:await resignationInformation(hr,people.Subject.employmentId),events:history.filter(x=>x.remarks?.startsWith('Board3 fictional ')).map(x=>({id:x.id,kind:x.kind,status:x.status,effectiveDate:x.effectiveDate}))};
 // Existing duplicates are admitted while ON, then preserved when OFF. Fresh blank identity remains for UI.
 const nricKey='000101000001',pack=requirePackFor('MY');
 const nricProfiles=[];for(const key of ['NricA','NricB'])nricProfiles.push(await pack.statutory.get(bootstrap,people[key].personId));
 const present=nricProfiles.map(p=>p?.icNumber?.replace(/[\s-]/g,'')===nricKey);
 let policy=await getPeopleGeneral(bootstrap);
 if(!present.some(Boolean)&&policy.allowDuplicatedNric)throw new Error('Initial policy is not the OFF default; preserving existing configuration.');
 if(!present.every(Boolean)){
  if(!policy.allowDuplicatedNric)policy=await savePeopleGeneral(bootstrap,{...policy,allowDuplicatedNric:true});
  for(let i=0;i<2;i++)if(!present[i])await pack.statutory.setIc(bootstrap,{personId:people[i===0?'NricA':'NricB'].personId,icNumber:nricKey});
  policy=await savePeopleGeneral(bootstrap,{...policy,allowDuplicatedNric:false});
 }
 if(policy.allowDuplicatedNric)throw new Error('NRIC fixture already changed to ON; preserving browser state.');
 const allocations=await getEmploymentCostAllocations(hr,people.Subject.employmentId);
 if(allocations.revision===0){
  for(const[date,rows]of [[offset(-90),[{costCenterId:masters.costA.id,percentage:'50.00'}]],[offset(-14),[{costCenterId:masters.costA.id,percentage:'50.00'},{costCenterId:masters.costB.id,percentage:'25.00'}]]]as const){const current=await getEmploymentCostAllocations(hr,people.Subject.employmentId,date),input={employmentId:people.Subject.employmentId,effectiveDate:date,expectedRevision:current.revision,operation:'replace' as const,rows:[...rows]};const preview=await previewEmploymentCostAllocations(hr,input);await saveEmploymentCostAllocations(hr,input,{digest:preview.digest});}
 }
 const allocationView=await getEmploymentCostAllocations(hr,people.Subject.employmentId);
 if(allocationView.total!==7500||allocationView.history.length!==2)throw new Error('Existing allocation fixture changed; preserving browser state.');
 const reviewIds:Record<string,string>={};
 for(const key of ['unused','used','locked']as const){
  const name=`Board3 fictional ${key} review`;
  let[record]=await owner.db.select({id:s.rewardUnit.id,deletedAt:s.rewardUnit.deletedAt}).from(s.rewardUnit).innerJoin(s.rewardCycle,eq(s.rewardCycle.id,s.rewardUnit.cycleId)).where(and(eq(s.rewardUnit.tenantId,tenantId),eq(s.rewardUnit.businessUnitId,masters[key].id),eq(s.rewardCycle.name,name)));
  if(record?.deletedAt)throw new Error('Fixture review was deleted in browser; preserving its audit history.');
  if(!record){const id=await rewards.createRewardUnit(hr,{name,year:Number(today.slice(0,4)),companyId:companies.Main,businessUnitId:masters[key].id,snapshotDate:today});record={id,deletedAt:null};}
  reviewIds[key]=record.id;
  let config=await rewards.getRewardConfiguration(hr,record.id);
  // Ready-to-edit Access rows; membership provisioning is through the same owner as the UI.
  const memberships:[string,RewardRole][]=[[people.Preparer.userId,'bu'],[people.Reviewer.userId,'bg'],[people.Approver.userId,'ctro'],[people.Reviewer.userId,'ec'],[people.Approver.userId,'payroll']];
  for(const[userId,role]of memberships)if(!config.members.some(m=>m.userId===userId&&m.role===role)){
   await rewards.setRewardMember(hr,record.id,config.unit.revision,userId,role);config=await rewards.getRewardConfiguration(hr,record.id);
  }
  if(key!=='unused'&&config.unit.status==='draft'){
   const unit=await rewards.getRewardUnit(hr,record.id),entry=unit.rows[0];if(!entry)throw new Error('Rewards fixture snapshot missing.');
   if(!entry.facts.reviewed)await rewards.saveRewardEntry(hr,record.id,unit.unit.revision,entry.id,{...emptyRecommendation(),meritBp:0,promotionBp:0,specialBp:0,multiplierBp:0,lumpCents:0,reason:'Fictional prerequisite retained for deletion refusal evidence.'},{...emptyFacts(),reviewed:true,talent:'IMPRO',performance:'UA'});
   if(key==='locked'){const next=await rewards.getRewardConfiguration(hr,record.id);await rewards.decideRewardUnit(preparer,record.id,next.unit.revision,'submit','Fictional locked-review prerequisite; browser acceptance still required.');}
  }
 }
 const reviewStates:Record<string,unknown>={};for(const[key,id]of Object.entries(reviewIds)){const config=await rewards.getRewardConfiguration(hr,id),reason=await rewards.rewardDeletionEligibility(hr,id);if(reason!==(key==='unused'?null:key==='used'?'recommendations':'locked'))throw new Error('Canonical Rewards prerequisite differs from the requested scenario; no browser PASS claimed.');reviewStates[key]={id,status:config.unit.status,revision:config.unit.revision,deletionEligibility:reason};}
 const job=(await getJobDocumentPage(preparer,{q:'B3-JD-DRAFT'})).rows.find(j=>j.job_code==='B3-JD-DRAFT');
 let jobId=job?.id;
 if(!jobId){const made=await saveJobDraft(preparer,{companyId:companies.Main,jobCode:'B3-JD-DRAFT',title:'Board3 fictional operations analyst',owner:'Board3 fictional People operations',org:{businessUnit:masters.general.id,department:masters.department.id,position:masters.position.id,grade:grade.id,employmentType:'full_time'},answers:{},effectiveOn:offset(20),reviewOn:offset(385),reason:'Initial fictional draft; browser must edit, save, reopen, submit, review and approve.',approverId:people.Approver.userId,reviewerIds:[people.Reviewer.userId]});jobId=made.jobId;}
 await fs.mkdir(path.join(out,'uploads'),{recursive:true});
 const files:{name:string;purpose:string}[]=[];
 async function allocationCsv(name:string,rows:ImportRecord[],purpose:string){await fs.writeFile(path.join(out,'uploads',name),toCsv([[...ALLOCATION_COLUMNS],...rows.map(r=>ALLOCATION_COLUMNS.map(k=>r[k]??''))]));files.push({name,purpose});}
 const[mainCompany]=await owner.db.select({legalName:s.company.legalName,label:s.company.companyLabel,registrationNo:s.company.registrationNo}).from(s.company).where(eq(s.company.id,companies.Main));
 // c4055300 — allocation files name the company by its Company Code, never by its internal identifier.
 const allocationRow={company_code:mainCompany.label?.trim()||mainCompany.registrationNo?.trim()||mainCompany.legalName,employee_code:people.Subject.employeeCode,effective_date:today,operation:'replace',cost_center_code:masters.costA.code,percentage:'60.25'};
 await allocationCsv('allocation-valid.csv',[allocationRow,{...allocationRow,cost_center_code:masters.costB.code,percentage:'20.25'}],'UI check/apply/reopen 80.50% total, 19.50% unallocated.');
 await allocationCsv('allocation-over-total.csv',[{...allocationRow,percentage:'75.01'},{...allocationRow,cost_center_code:masters.costB.code,percentage:'25.00'}],'Whole-set refusal; current allocations unchanged.');
 await allocationCsv('allocation-clear.csv',[{...allocationRow,operation:'clear',cost_center_code:'',percentage:''}],'Explicit clear preview/apply; history retained.');
 await allocationCsv('allocation-foreign-reference.csv',[{...allocationRow,cost_center_code:masters.foreignCost.code}],'Unavailable company reference refuses without foreign record details.');
 await allocationCsv('allocation-overprecision.csv',[{...allocationRow,percentage:'33.333'}],'Overprecision refuses rather than rounding.');
 const columns=employeeTemplate.columns.map(c=>c.key);
 for(const[filename,allocations]of [['new-hire-no-allocation.xlsx',null],['new-hire-with-allocation.xlsx','valid'],['new-hire-allocation-refuses.xlsx','invalid'],['new-hire-reference-codes.xlsx',null]]as const){
  const referenceCodes=filename==='new-hire-reference-codes.xlsx';
  const code=referenceCodes?'000B3-CODES':filename==='new-hire-no-allocation.xlsx'?'B3-IMPORT-NONE':filename==='new-hire-with-allocation.xlsx'?'B3-IMPORT-SPLIT':'B3-IMPORT-REFUSE';
  const row:ImportRecord={employee_code:code,full_name:`Board3 fictional imported ${code}`,email:`${code.toLowerCase()}@example.invalid`,company:companies.Main,department:masters.department.code,hired_on:today,employment_type:'full_time',basic_salary:'3000',ic_number:''};
  if(referenceCodes)Object.assign(row,{business_unit:masters.sameA.code,position:masters.position.code,cost_center:masters.costA.code,job_grade:'B3_GRADE',org_base:profileChoices.sameA.value});
  const split=[{...allocationRow,employee_code:code,percentage:allocations==='invalid'?'100.01':'50.00'}];
  await fs.writeFile(path.join(out,'uploads',filename),await buildXlsx(columns,[columns.map(k=>row[k]??'')],{sheetName:EMPLOYEE_XLSX_SHEETS.data,textColumns:columns.map((_,i)=>i),extraSheets:allocations?[{name:ALLOCATION_SHEET,rows:[[...ALLOCATION_COLUMNS],...split.map(r=>ALLOCATION_COLUMNS.map(k=>(r as ImportRecord)[k]??''))]}]:[]}));files.push({name:filename,purpose:referenceCodes?'UI exact-code new hire: duplicate org labels, Base code-versus-label collision, leading-zero employee and Base codes; verify exact stored IDs/values.':allocations==='invalid'?'UI whole new-hire rollback on invalid companion allocation.':allocations?'UI atomic new-hire with valid companion allocation.':'UI new-hire without allocation sheet; no allocation action.'});
 }
 const base='http://127.0.0.1:3160';
 const manifest={fictional:true,evidence:'prerequisites only; all browser outcomes UNVERIFIED',database,namespace,port:3160,tenantId,companies,masters,profileChoices,gradeId:grade.id,people,groupConfigurationUserId:seedAdmin.id,job:{id:jobId,status:'draft',url:`${base}/admin/job-descriptions/${jobId}`},resignation,legacyProvisioning:'One local migration-role pre-owner snapshot on fictional Legacy employee; no Movement history fabricated.',nric:{initialPolicy:'OFF',duplicatePersonIds:[people.NricA.personId,people.NricB.personId],freshPersonId:people.NricFresh.personId,fictionalDuplicateKey:nricKey},allocations:{employmentId:people.Subject.employmentId,revision:allocationView.revision,totalHundredths:allocationView.total,historyIds:allocationView.history.map(h=>h.id)},rewards:reviewStates,urls:{home:base,personnel:`${base}/admin/personnel/${people.Subject.employmentId}`,legacy:`${base}/admin/personnel/${people.Legacy.employmentId}`,jobs:`${base}/admin/job-descriptions`,jobConfiguration:`${base}/admin/job-descriptions/configuration`,rewards:`${base}/admin/rewards`,access:`${base}/admin/rewards/access`,peopleGeneral:`${base}/admin/settings/people-general`,import:`${base}/admin/personnel/import`,systemLabels:`${base}/admin/settings/system-labels`},identitySwitch:'Use the existing native app dev identity switcher with the fictional user IDs. Group settings require the seeded fictional group administrator; company HR must be denied tenant-wide policy configuration.',files};
 await fs.writeFile(path.join(out,'fixture-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log('BOARD3_APPROVED_MANIFEST\n'+JSON.stringify(manifest,null,2));
}
let failed=false,closing:Promise<void>|undefined;
function closePools(){return closing??=(async()=>{try{await owner.client.end({timeout:5});}catch{failed=true;}try{await appClient.end({timeout:5});}catch{failed=true;}})();}
for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>{failed=true;void closePools().finally(()=>process.exit(1));});
try{await main();}catch(error){failed=true;console.error(error instanceof Error?error.message:'Fixture failed; inspect the named log.');}
finally{await closePools();}
// Explicit exit is required: fixture completion cannot leave pools keeping the three locks alive.
process.exit(failed?1:0);
