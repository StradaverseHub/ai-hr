/** Local-only c445 Personnel fixture. Canonical owners create business facts; owner inserts login grants only.
 * Must run twice and exit cleanly before browser work. Never seeds, imports uploaded rows, or resets facts.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {and,eq,isNull} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import type {ImportRecord} from '../lib/import-schema';
import {DEMO_TENANT_ID,SYSTEM_TENANT_ID,demoSeedRefusal} from '../db/seed-guard';
const root=fileURLToPath(new URL('..',import.meta.url));
const out=path.join(root,'scratchpad/board15-personnel-registers');
const refusal=demoSeedRefusal(process.env);
if(refusal || process.env.NODE_ENV==='production')throw new Error(refusal??'Development only.');
if(process.env.AUTH_PROVIDER && process.env.AUTH_PROVIDER!=='workos')throw new Error('Local fictional demo authentication only.');
if(process.env.TEST_DB_NAMESPACE!=='board15personnelregisters')throw new Error('Use the assigned Personnel namespace.');
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']) {
  let url:URL;try{url=new URL(process.env[key]??'');}catch{throw new Error('Valid local database credentials are required.');}
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/ai_hr_board15_personnel_browser')throw new Error('Only the named disposable local Personnel database is allowed.');
}
const {createDb}=await import('../db/client');
const s=await import('../db/schema');
const {resolveEntitlementsTx}=await import('../core/entitlements');
const {createCompany,createDepartment}=await import('../core/admin');
const {hireEmployee,updatePerson,setReportingLine,terminateEmployment}=await import('../core/org');
const {createProfileOption,setProfileOptionActive}=await import('../core/profile-options');
const {addDependent}=await import('../core/dependents');
const {addQualification,archiveQualification}=await import('../core/qualifications');
const {addEmergencyContact,archiveEmergencyContact}=await import('../core/emergency-contacts');
const {requirePackFor}=await import('../localization/registry');
const {personnelImportFields,personnelColumnLabel,personnelColumnGuidance,personnelFieldChoices}=await import('../lib/personnel-import-contract');
const {personnelRegisterColumns,PERSONNEL_REGISTER_SHEETS}=await import('../lib/personnel-register-import');
const {sectionTemplateColumns}=await import('../lib/import-sections');
const {employeeTemplate}=await import('../lib/import-template');
const {DEPENDENT_XLSX_COLUMNS,EMPLOYEE_XLSX_SHEETS}=await import('../lib/import-template-xlsx');
const {buildXlsx}=await import('../lib/spreadsheet');
const {toCsv}=await import('../lib/csv');
const owner=createDb(process.env.MIGRATION_DATABASE_URL!),tenantId=DEMO_TENANT_ID;
async function context(user:{id:string;personId:string|null}):Promise<SessionContext> {
  const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
  const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId));
  return {tenantId,userId:user.id,personId:user.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements};
}
async function main() {
  const tenants=await owner.db.select().from(s.tenant);
  if(!tenants.some(row=>row.id===tenantId && row.name==='Demo Group') || tenants.some(row=>row.id!==tenantId && row.id!==SYSTEM_TENANT_ID))throw new Error('Seeded fictional demo tenants only; preserving this database.');
  const [seedAdmin]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,'user_dev_admin'),isNull(s.appUser.archivedAt)));
  if(!seedAdmin)throw new Error('Seed administrator missing.');
  const bootstrap=await context(seedAdmin);
  const companies:Record<string,string>={},departments:Record<string,string>={};
  for(const key of ['Main','Foreign']) {
    let [company]=await owner.db.select().from(s.company).where(and(eq(s.company.tenantId,tenantId),eq(s.company.companyLabel,`PERSONNEL15-${key}`)));
    if(!company){const made=await createCompany(bootstrap,{legalName:`Personnel15 fictional ${key}`,companyLabel:`PERSONNEL15-${key}`,country:'MY',currency:'MYR'});[company]=await owner.db.select().from(s.company).where(eq(s.company.id,made.id));}
    if(company.archivedAt || company.country!=='MY')throw new Error('Existing fictional company changed; preserving it.');
    companies[key]=company.id;
    let [department]=await owner.db.select().from(s.department).where(and(eq(s.department.companyId,company.id),eq(s.department.name,`Personnel15 ${key} team`)));
    if(!department){const made=await createDepartment(bootstrap,{companyId:company.id,name:`Personnel15 ${key} team`});[department]=await owner.db.select().from(s.department).where(eq(s.department.id,made.id));}
    if(department.archivedAt)throw new Error('Existing fictional department archived; preserving it.');departments[key]=department.id;
  }
  const catalog:Record<string,{id:string;category:string;value:string;label:string}>={};
  for(const [key,category,value,label] of [
    ['degree','qualificationLevel','PR15_DEGREE','Personnel15 degree'],['diploma','qualificationLevel','PR15_DIPLOMA','Personnel15 diploma'],
    ['ambiguousA','qualificationLevel','PR15_AMBIG_A','Personnel15 ambiguous qualification'],['ambiguousB','qualificationLevel','PR15_AMBIG_B','Personnel15 ambiguous qualification'],
    ['inactiveQualification','qualificationLevel','PR15_OLD_QUAL','Personnel15 inactive qualification'],
    ['relationship','relationship','PR15_CONTACT','Personnel15 trusted contact'],['inactiveRelationship','relationship','PR15_OLD_REL','Personnel15 inactive contact'],
  ]) {
    let [option]=await owner.db.select().from(s.profileOption).where(and(eq(s.profileOption.tenantId,tenantId),eq(s.profileOption.category,category),eq(s.profileOption.value,value)));
    if(!option){await createProfileOption(bootstrap,{category,value,label});[option]=await owner.db.select().from(s.profileOption).where(and(eq(s.profileOption.tenantId,tenantId),eq(s.profileOption.category,category),eq(s.profileOption.value,value)));}
    if(option.label!==label || (!key.startsWith('inactive')&&!option.isActive))throw new Error('Existing fictional catalogue changed; preserving it.');
    catalog[key]={id:option.id,category,value,label};
  }
  const people:Record<string,{personId:string;employmentId:string;employeeCode:string;companyId:string;userId:string;login:string}>={};
  for(const key of ['HR','Manager','Employee','Other','Inactive','Foreign']) {
    const companyKey=key==='Foreign'?'Foreign':'Main',employeeCode=`PR15-${key.toUpperCase()}`,email=`personnel15-${key.toLowerCase()}@demo.test`;
    let [person]=await owner.db.select().from(s.person).where(and(eq(s.person.tenantId,tenantId),eq(s.person.primaryEmail,email)));
    let [employment]=person?await owner.db.select().from(s.employment).where(and(eq(s.employment.personId,person.id),eq(s.employment.companyId,companies[companyKey]))):[];
    if(!person&&!employment) {
      const made=await hireEmployee(bootstrap,{person:{fullName:`Personnel15 ${key}`,primaryEmail:email,phone:'001234567890'},employeeCode,companyId:companies[companyKey],departmentId:departments[companyKey],employmentType:'full_time',hiredOn:'2025-01-01'});
      [person]=await owner.db.select().from(s.person).where(eq(s.person.id,made.personId));[employment]=await owner.db.select().from(s.employment).where(eq(s.employment.id,made.employmentId));
      const pack=requirePackFor('MY');
      await pack.statutory.set(bootstrap,{personId:person.id,icNumber:null,epfNumber:`000111${['HR','Manager','Employee','Other','Inactive','Foreign'].indexOf(key)+1}`,taxNumber:`000TAX-${key}`,bankName:'Maybank',bankAccountNo:`0001234567${['HR','Manager','Employee','Other','Inactive','Foreign'].indexOf(key)+1}`});
      await updatePerson(bootstrap,{personId:person.id,fullName:person.fullName,primaryEmail:email,phone:'001234567890',homePhone:'000301234567',permanentAddressLine1:'0001 Fictional Lane',permanentPostcode:'00123',permanentCity:'Fictional City',permanentCountry:'Malaysia',correspondenceAddressLine1:'0002 Fictional Lane',correspondencePostcode:'00456',personalEmail:`personnel15-${key.toLowerCase()}-personal@demo.test`,via:'personnel15-fixture'});
    }
    if(!person||!employment||employment.employeeCode!==employeeCode || (key!=='Inactive'&&employment.terminatedOn))throw new Error('Existing fictional employee identity changed; preserving it.');
    const login=`personnel15-fixture:${key}`;
    let [user]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,login)));
    if(!user)[user]=await owner.db.insert(s.appUser).values({tenantId,personId:person.id,workosUserId:login,onboardedAt:new Date()}).returning();
    if(user.archivedAt||user.personId!==person.id)throw new Error('Existing fictional login changed; preserving it.');
    const role=key==='HR'?'hr_admin' as const:key==='Manager'?'manager' as const:'employee' as const;
    const grants=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,user.id));
    if(!grants.length)await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:user.id,companyId:companies[companyKey],role});
    else if(grants.length!==1||grants[0].role!==role||grants[0].companyId!==companies[companyKey])throw new Error('Existing fictional grants changed; preserving them.');
    people[key]={personId:person.id,employmentId:employment.id,employeeCode,companyId:employment.companyId,userId:user.id,login};
  }
  const hr=await context({id:people.HR.userId,personId:people.HR.personId});
  const [line]=await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId,people.Employee.employmentId),eq(s.reportingLine.lineType,'administrative'),isNull(s.reportingLine.validTo),isNull(s.reportingLine.supersededAt)));
  if(!line)await setReportingLine(hr,{subordinateEmploymentId:people.Employee.employmentId,managerEmploymentId:people.Manager.employmentId,lineType:'administrative',validFrom:'2025-01-01'});
  else if(line.managerEmploymentId!==people.Manager.employmentId)throw new Error('Fictional reporting line changed; preserving it.');
  const records={family:[] as string[],qualification:{} as Record<string,string>,emergency:{} as Record<string,string>};
  for(const [name,relationship,dateOfBirth] of [['Personnel15 spouse','spouse','1990-01-02'],['Personnel15 same-name child','child','2015-02-03'],['Personnel15 same-name child','child','2017-04-05']]) {
    let [dependent]=await owner.db.select().from(s.employeeDependent).where(and(eq(s.employeeDependent.personId,people.Employee.personId),eq(s.employeeDependent.fullName,name),eq(s.employeeDependent.relationship,relationship),eq(s.employeeDependent.dateOfBirth,dateOfBirth)));
    if(!dependent){const made=await addDependent(hr,{personId:people.Employee.personId,fullName:name,relationship,dateOfBirth,phone:'0001234567',remarks:'Personnel15 fictional Family register'});[dependent]=await owner.db.select().from(s.employeeDependent).where(eq(s.employeeDependent.id,made.id));}
    if(dependent.archivedAt)throw new Error('Existing fictional Family record archived; preserving it.');records.family.push(dependent.id);
  }
  for(const [key,personKey,qualification,isHighest] of [
    ['degree','Employee',catalog.degree.value,true],['legacy','Employee',catalog.inactiveQualification.value,false],['archived','Employee',catalog.diploma.value,false],['other','Other',catalog.degree.value,false],['foreign','Foreign',catalog.degree.value,false],
  ] as const) {
    const description=`Personnel15 qualification ${key}`;
    let [record]=await owner.db.select().from(s.employeeQualification).where(and(eq(s.employeeQualification.employmentId,people[personKey].employmentId),eq(s.employeeQualification.description,description)));
    if(!record){const made=await addQualification(personKey==='Foreign'?bootstrap:hr,{employmentId:people[personKey].employmentId,qualification,description,institute:'Personnel15 Institute',major:'Fictional studies',fromYm:'2010-03',toYm:'2014-08',graduationDate:'2014-09-01',result:'Initial fixture result',isHighest});[record]=await owner.db.select().from(s.employeeQualification).where(eq(s.employeeQualification.id,made.id));}
    if(key==='archived'&&!record.archivedAt)await archiveQualification(hr,{id:record.id});
    else if(key!=='archived'&&record.archivedAt)throw new Error('Existing fictional qualification archived; preserving it.');records.qualification[key]=record.id;
  }
  for(const [key,personKey,priority,relationship] of [
    ['primary','Employee','primary',catalog.relationship.value],['secondary','Employee','secondary',catalog.inactiveRelationship.value],['archived','Employee','other',catalog.relationship.value],['other','Other','other',catalog.relationship.value],['foreign','Foreign','other',catalog.relationship.value],
  ] as const) {
    const remarks=`Personnel15 contact ${key}`;
    let [record]=await owner.db.select().from(s.personEmergencyContact).where(and(eq(s.personEmergencyContact.personId,people[personKey].personId),eq(s.personEmergencyContact.remarks,remarks)));
    if(!record){const made=await addEmergencyContact(personKey==='Foreign'?bootstrap:hr,{personId:people[personKey].personId,fullName:'Personnel15 same-name contact',relationship,mobilePhone:key==='primary'?'001234567890':'009876543210',homePhone:'000301234567',address:'0003 Fictional Lane',remarks,priority});[record]=await owner.db.select().from(s.personEmergencyContact).where(eq(s.personEmergencyContact.id,made.id));}
    if(key==='archived'&&!record.archivedAt)await archiveEmergencyContact(hr,{id:record.id});
    else if(key!=='archived'&&record.archivedAt)throw new Error('Existing fictional contact archived; preserving it.');records.emergency[key]=record.id;
  }
  for(const key of ['inactiveQualification','inactiveRelationship']) {
    const [option]=await owner.db.select().from(s.profileOption).where(eq(s.profileOption.id,catalog[key].id));
    if(option.isActive)await setProfileOptionActive(bootstrap,{id:option.id,isActive:false});
  }
  const [inactive]=await owner.db.select().from(s.employment).where(eq(s.employment.id,people.Inactive.employmentId));
  if(!inactive.terminatedOn)await terminateEmployment(bootstrap,{employmentId:inactive.id,terminationDate:'2025-12-31',terminationReason:'Personnel15 fictional inactive import refusal'});
  else if(inactive.terminatedOn!=='2025-12-31')throw new Error('Existing fictional inactive lifecycle changed; preserving it.');

  await fs.mkdir(path.join(out,'uploads'),{recursive:true});
  const files:{name:string;purpose:string;sha256?:string}[]=[];
  const messages=JSON.parse(await fs.readFile(path.join(root,'messages/en.json'),'utf8'));
  const resolver=(dictionary:unknown)=>(key:string,fallback:string)=>{let value:unknown=dictionary;for(const part of key.split('.'))value=value&&typeof value==='object'?(value as Record<string,unknown>)[part]:undefined;return typeof value==='string'?value:fallback;};
  const resolve=resolver(messages);
  const saveCsv=async(name:string,purpose:string,sheet:'employee'|'family'|'qualification'|'emergency',columns:string[],rows:ImportRecord[])=>{
    const csv=toCsv([columns.map(column=>personnelColumnLabel(column,sheet,resolve)),...rows.map(row=>columns.map(column=>row[column]??''))]);
    await fs.writeFile(path.join(out,'uploads',name),csv);files.push({name,purpose,sha256:createHash('sha256').update(csv).digest('hex')});
  };
  const code=people.Employee.employeeCode,qid=records.qualification.degree,cid=records.emergency.secondary;
  const cases:[string,string,'qualification'|'emergency',ImportRecord[]][]=[
    ['qualification-create.csv','Blank ID explicitly creates, even with the same qualification value.','qualification',[{employee_code:code,qualification:catalog.degree.value,institute:'Added in browser',from_ym:'2018-02',to_ym:'2020-06',graduation_date:'2020-07-01',is_highest:'false'}]],
    ['qualification-update-blank.csv','Blank institute/month retain; explicit ID updates result.','qualification',[{employee_code:code,record_id:qid,institute:'',from_ym:'',result:'Changed in browser'}]],
    ['qualification-name-option.csv','Unambiguous current label resolves to exact saved code.','qualification',[{employee_code:code,qualification:catalog.diploma.label,is_highest:'false'}]],
    ['qualification-ambiguous-option.csv','Ambiguous active label refuses.','qualification',[{employee_code:code,qualification:catalog.ambiguousA.label}]],
    ['qualification-inactive-option.csv','New inactive catalogue choice refuses.','qualification',[{employee_code:code,qualification:catalog.inactiveQualification.value}]],
    ['qualification-legacy-option.csv','Unchanged inactive stored code re-saves.','qualification',[{employee_code:code,record_id:records.qualification.legacy,qualification:catalog.inactiveQualification.value,result:'Legacy retained in browser'}]],
    ['qualification-other-employment.csv','Visible but wrong employment ID refuses.','qualification',[{employee_code:code,record_id:records.qualification.other,result:'MUST REFUSE'}]],
    ['qualification-foreign-company.csv','Record from unadministered company refuses.','qualification',[{employee_code:code,record_id:records.qualification.foreign,result:'MUST REFUSE'}]],
    ['qualification-archived.csv','Archived Record ID refuses.','qualification',[{employee_code:code,record_id:records.qualification.archived,result:'MUST REFUSE'}]],
    ['qualification-invalid-month.csv','Full date in month field refuses; never truncates.','qualification',[{employee_code:code,record_id:qid,from_ym:'2020-03-01'}]],
    ['qualification-invalid-date.csv','Impossible calendar graduation refuses.','qualification',[{employee_code:code,record_id:qid,graduation_date:'2025-02-30'}]],
    ['qualification-inactive-employee.csv','Inactive employment refuses.','qualification',[{employee_code:people.Inactive.employeeCode,qualification:catalog.degree.value}]],
    ['qualification-malformed-id.csv','Malformed noncanonical Record ID refuses.','qualification',[{employee_code:code,record_id:'row-1',result:'MUST REFUSE'}]],
    ['qualification-mixed-refusal.csv','A valid create plus a wrong-ID row refuse together; no partial register writes.','qualification',[{employee_code:code,qualification:catalog.degree.value,institute:'MUST NOT APPEAR'},{employee_code:code,record_id:records.qualification.other,result:'MUST REFUSE'}]],
    ['qualification-duplicate-id.csv','Duplicate/conflicting IDs refuse whole file.','qualification',[{employee_code:code,record_id:qid,result:'A'},{employee_code:code,record_id:qid,result:'B'}]],
    ['qualification-two-highest.csv','Two explicit Highest selections refuse whole file.','qualification',[{employee_code:code,qualification:catalog.degree.value,is_highest:'true'},{employee_code:code,qualification:catalog.diploma.value,is_highest:'true'}]],
    ['emergency-create.csv','Blank ID creates same-name contact without matching/deduping names.','emergency',[{employee_code:code,full_name:'Personnel15 same-name contact',priority:'other',mobile_phone:'000555123456'}]],
    ['emergency-update-blank.csv','Explicit ID promotes Secondary to Primary, blank mobile retains.','emergency',[{employee_code:code,record_id:cid,priority:'primary',mobile_phone:'',address:'0004 Changed in browser'}]],
    ['emergency-other-person.csv','Wrong person ID refuses.','emergency',[{employee_code:code,record_id:records.emergency.other,remarks:'MUST REFUSE'}]],
    ['emergency-archived.csv','Archived contact refuses.','emergency',[{employee_code:code,record_id:records.emergency.archived,remarks:'MUST REFUSE'}]],
    ['emergency-two-primary.csv','Two explicit Primary contacts refuse.','emergency',[{employee_code:code,full_name:'Primary A',priority:'primary'},{employee_code:code,full_name:'Primary B',priority:'primary'}]],
  ];
  for(const [name,purpose,kind,rows] of cases)await saveCsv(name,purpose,kind,personnelRegisterColumns(kind),rows);
  await saveCsv('qualification-501-rows.csv','Over-limit register input refuses all rows.','qualification',personnelRegisterColumns('qualification'),Array.from({length:501},()=>({employee_code:code,qualification:catalog.degree.value,is_highest:'false'})));
  await saveCsv('emergency-duplicate-header.csv','Duplicate canonical headers refuse before row projection.','emergency',['employee_code','record_id','record_id','full_name'],[{employee_code:code,record_id:cid,full_name:'MUST REFUSE'}]);
  await saveCsv('profile-leading-zero-blank.csv','Phone writes leading zeros; blank name/email/address retain.','employee',sectionTemplateColumns('profile'),[{employee_code:code,phone:'000987654321',full_name:'',email:'',address_line_1:'',postcode:''}]);
  await saveCsv('bank-leading-zero-blank.csv','Bank account leading zeros survive; blank bank name retains.','employee',sectionTemplateColumns('bank_statutory'),[{employee_code:code,bank_name:'',bank_account_no:'000000001234'}]);
  await saveCsv('family-same-name-distinct-dob.csv','Two new same-name children with different DOBs remain separate.','family',[...DEPENDENT_XLSX_COLUMNS],[{employee_code:code,full_name:'Personnel15 browser same-name child',relationship:'child',date_of_birth:'2016-01-01'},{employee_code:code,full_name:'Personnel15 browser same-name child',relationship:'child',date_of_birth:'2018-01-01'}]);
  for(const locale of ['en','ms','zh','ta','th','vi']) {
    const dictionary=JSON.parse(await fs.readFile(path.join(root,'messages',`${locale}.json`),'utf8')),label=resolver(dictionary);
    const employeeCode=`PR15-NEW-${locale.toUpperCase()}`,columns=employeeTemplate.columns.map(column=>column.key);
    const row:ImportRecord={employee_code:employeeCode,full_name:`Personnel15 imported ${locale}`,email:`personnel15-new-${locale}@demo.test`,company:companies.Main,department:'Personnel15 Main team',hired_on:'2025-01-01',employment_type:'full_time',basic_salary:'5000',ic_number:'',phone:'000123456789',bank_name:'Maybank',bank_account_no:'000000009876',postcode:'00123',address_line_1:'0001 Imported Lane'};
    const headers=(sheet:'employee'|'family'|'qualification'|'emergency',keys:string[])=>keys.map(key=>personnelColumnLabel(key,sheet,label));
    const registerSheet=(kind:'qualification'|'emergency',rows:ImportRecord[])=>{const keys=personnelRegisterColumns(kind);return {name:PERSONNEL_REGISTER_SHEETS[kind],rows:[headers(kind,keys),...rows.map(record=>keys.map(key=>record[key]??''))],textColumns:keys.map((_,index)=>index),headerNotes:keys.map(key=>personnelColumnGuidance(key,kind,'create',{required:dictionary.people.import.required,optional:dictionary.people.import.optional,reference:dictionary.people.import.instructionReference,blankRetains:dictionary.people.import.sectionInstructionBlank})),validationLists:personnelImportFields(kind).flatMap(field=>{const values=field.import.catalog?Object.values(catalog).filter(option=>option.category===field.import.catalog&&!option.value.includes('OLD_')).map(option=>option.value):personnelFieldChoices(field).map(choice=>label(choice.labelKey,choice.value));return values.length?[{column:keys.indexOf(field.import.column!),values}]:[];})};};
    const family=[{employee_code:employeeCode,full_name:'Personnel15 imported same-name child',relationship:'child',date_of_birth:'2014-01-01'},{employee_code:employeeCode,full_name:'Personnel15 imported same-name child',relationship:'child',date_of_birth:'2016-01-01'}];
    const bytes=await buildXlsx(headers('employee',columns),[columns.map(key=>row[key]??'')],{sheetName:EMPLOYEE_XLSX_SHEETS.data,textColumns:columns.map((_,index)=>index),extraSheets:[
      {name:EMPLOYEE_XLSX_SHEETS.family,rows:[headers('family',[...DEPENDENT_XLSX_COLUMNS]),...family.map(record=>DEPENDENT_XLSX_COLUMNS.map(key=>(record as ImportRecord)[key]??''))],textColumns:DEPENDENT_XLSX_COLUMNS.map((_,index)=>index)},
      registerSheet('qualification',[{employee_code:employeeCode,qualification:catalog.degree.value,from_ym:'2010-03',to_ym:'2014-08',graduation_date:'2014-09-01',is_highest:'true'},{employee_code:employeeCode,qualification:catalog.diploma.value,is_highest:'false'}]),
      registerSheet('emergency',[{employee_code:employeeCode,full_name:'Imported contact A',priority:'primary',mobile_phone:'001234567890'},{employee_code:employeeCode,full_name:'Imported contact B',priority:'secondary',mobile_phone:'009876543210'}]),
      {name:'Reference',rows:[['Fictional current codes / labels'],...Object.values(catalog).map(option=>[option.category,option.value,option.label])]},
      {name:'Instructions',rows:[[dictionary.people.import.registerInstructions],[dictionary.people.import.registerFullInstructions]]},
    ]});
    const name=`full-new-${locale}.xlsx`;await fs.writeFile(path.join(out,'uploads',name),bytes);files.push({name,purpose:`Actual ${locale} full-workbook journey: create employee, 2 Family, 2 Qualification, 2 Emergency records atomically.`});
  }
  for(const kind of ['qualification','emergency'] as const) {
    const rows=kind==='qualification'?[{employee_code:code,record_id:qid,result:'Excel browser update'}]:[{employee_code:code,record_id:cid,address:'0005 Excel browser update'}];
    const columns=personnelRegisterColumns(kind),name=`${kind}-update.xlsx`;
    await fs.writeFile(path.join(out,'uploads',name),await buildXlsx(columns.map(column=>personnelColumnLabel(column,kind,resolve)),rows.map(record=>columns.map(column=>(record as ImportRecord)[column]??'')),{sheetName:PERSONNEL_REGISTER_SHEETS[kind],textColumns:columns.map((_,index)=>index)}));files.push({name,purpose:'Actual register Excel update/check/apply/reopen journey.'});
  }
  const orphanColumns=employeeTemplate.columns.map(column=>column.key),orphanRow:ImportRecord={...Object.fromEntries(orphanColumns.map(key=>[key,''])),employee_code:'PR15-ORPHAN',full_name:'Personnel15 orphan refusal',email:'personnel15-orphan@demo.test',company:companies.Main,department:'Personnel15 Main team',hired_on:'2025-01-01',basic_salary:'5000'};
  for(const [name,sheetName,registerCode] of [['full-orphan-register.xlsx','Qualifications','ABSENT-EMPLOYEE'],['full-unexpected-table.xlsx','Renamed Qualifications','PR15-ORPHAN']]) {
    await fs.writeFile(path.join(out,'uploads',name),await buildXlsx(orphanColumns.map(column=>personnelColumnLabel(column,'employee',resolve)),[orphanColumns.map(column=>orphanRow[column]??'')],{sheetName:EMPLOYEE_XLSX_SHEETS.data,extraSheets:[{name:sheetName,rows:[personnelRegisterColumns('qualification').map(column=>personnelColumnLabel(column,'qualification',resolve)),personnelRegisterColumns('qualification').map(column=>({employee_code:registerCode,qualification:catalog.degree.value} as ImportRecord)[column]??'')]}]}));files.push({name,purpose:'Whole-file refusal must create no employee or register facts.'});
  }
  files.sort((a,b)=>a.name.localeCompare(b.name));records.family.sort();
  const manifest={root,database:'ai_hr_board15_personnel_browser',namespace:'board15personnelregisters',port:3203,tenantId,companies,departments,catalog,people,records,uploads:path.join(out,'uploads'),files};
  await fs.writeFile(path.join(out,'fixture-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log('PERSONNEL15_MANIFEST\n'+JSON.stringify(manifest,null,2));
  await owner.client.end();
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
