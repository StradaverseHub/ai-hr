import {and,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {company,employment,person,employeeQualification,personEmergencyContact,profileOption} from '../db/schema';
import {PersonnelImportCatalog,normalizePersonnelCatalogRecord} from '../lib/personnel-import-catalog';
import {personnelImportProposedValues,personnelImportFields} from '../lib/personnel-import-contract';
import {normalizeEmployeeCode} from '../lib/employee-code';
import {deriveEmploymentStatus} from './employment-status';
import {publicErrorMessage} from '../lib/public-error';
import {addQualification,updateQualification,validateQualificationInputTx,type QualificationInput} from './qualifications';
import {addEmergencyContact,updateEmergencyContact,validateEmergencyContactInputTx,type EmergencyContactInput} from './emergency-contacts';
import {MAX_PERSONNEL_REGISTER_ROWS,personnelRegisterInput,type PersonnelRegisterKind,type RegisterPreview} from '../lib/personnel-register-import';
import type {ImportRecord} from '../lib/import-schema';
import type {SectionImportPreview,SectionImportResult} from '../lib/import-sections';

/** Explicit subjects allow the full new-employee import to validate rows before IDs exist. */
export type RegisterSubject={employeeCode:string;employeeName:string;companyId:string;employmentId:string|null;personId:string|null;valid:boolean};
type Resolved={subject:RegisterSubject|null;recordId:string;input:Partial<QualificationInput>&Partial<EmergencyContactInput>;preview:RegisterPreview['rows'][number]};
function assertBounds(records:ImportRecord[]) {
  if(records.length>MAX_PERSONNEL_REGISTER_ROWS)throw new Error(`A register import supports at most ${MAX_PERSONNEL_REGISTER_ROWS} rows. Split the file and check each part.`);
  if(Buffer.byteLength(JSON.stringify(records),'utf8')>900000)throw new Error('The register file is too large. Split it and check each part.');
}
async function loadSubjectsTx(tx:Tx,records:ImportRecord[],lock:boolean):Promise<RegisterSubject[]> {
  const codes=[...new Set(records.map(record=>normalizeEmployeeCode(record.employee_code)).filter(Boolean))];
  if(!codes.length)return [];
  const query=tx.select({employmentId:employment.id,personId:employment.personId,companyId:employment.companyId,
    employeeCode:employment.employeeCode,employeeName:person.fullName,archivedAt:company.archivedAt,
    resignationDate:employment.resignationDate,lastWorkingDate:employment.lastWorkingDate,terminatedOn:employment.terminatedOn,blacklistedAt:employment.blacklistedAt})
    .from(employment).innerJoin(person,eq(person.id,employment.personId)).innerJoin(company,eq(company.id,employment.companyId))
    .where(and(inArray(sql`upper(trim(${employment.employeeCode}))`,codes),sql`app.is_admin_for(${employment.companyId})`));
  const rows=lock?await query.for('update'):await query;
  return rows.map(row=>({...row,employeeCode:normalizeEmployeeCode(row.employeeCode),valid:!row.archivedAt && !['resigned','blacklisted'].includes(deriveEmploymentStatus(row))}));
}
/** No writes. Callers must pass the same explicit Tx to all owner validators/readers. */
export async function analyzeRegisterImportTx(tx:Tx,kind:PersonnelRegisterKind,records:ImportRecord[],options?:{subjects:RegisterSubject[];newEmployees?:boolean}) {
  assertBounds(records);
  const subjects=options?.subjects??await loadSubjectsTx(tx,records,false);
  const allowed=options?.newEmployees?new Set((await tx.select({id:company.id}).from(company).where(sql`app.is_admin_for(${company.id}) and ${company.archivedAt} is null`)).map(row=>row.id)):null;
  const byCode=new Map<string,RegisterSubject|null>();
  for(const subject of subjects) {
    const key=normalizeEmployeeCode(subject.employeeCode);
    byCode.set(key,byCode.has(key)?null:subject);
  }
  const catalog=new PersonnelImportCatalog();
  // Active values resolve names; canonical owners separately distinguish never configured from all inactive.
  for(const option of await tx.select({category:profileOption.category,value:profileOption.value,label:profileOption.label}).from(profileOption).where(eq(profileOption.isActive,true)))catalog.addOption(option);
  const resolved:Resolved[]=[];const fileErrors:string[]=[];
  const ids=new Map<string,number>();const promoted=new Map<string,number>();
  for(const [index,raw] of records.entries()) {
    const normalized=normalizePersonnelCatalogRecord(raw,kind,catalog);
    const parsed=personnelRegisterInput(kind,normalized.record);
    const errors=[...normalized.errors,...parsed.errors];
    const subject=byCode.get(parsed.employeeCode)??null;
    if(!subject)errors.push(options?.newEmployees?'Employee ID must name exactly one valid employee row in the Employees sheet.':'Employee ID is unavailable or outside your administered companies.');
    else if(!subject.valid || (allowed && !allowed.has(subject.companyId)))errors.push('This employment or company is inactive. Use an active Personnel record.');
    if(options?.newEmployees && parsed.recordId)errors.push('New-employee register rows must leave Record ID blank.');
    if(parsed.recordId) {
      const prior=ids.get(parsed.recordId);
      if(prior!==undefined) {
        errors.push(`Record ID repeats row ${prior+1}. Keep exactly one row per existing record.`);
        resolved[prior].preview.errors.push(`Record ID repeats row ${index+1}.`);resolved[prior].preview.ok=false;
      } else ids.set(parsed.recordId,index);
    }
    const input=parsed.input as Resolved['input'];
    if(subject && subject.valid && !errors.length)try {
      if(kind==='qualification') {
        let existing:typeof employeeQualification.$inferSelect|undefined;
        if(parsed.recordId) {
          [existing]=await tx.select().from(employeeQualification).where(and(eq(employeeQualification.id,parsed.recordId),eq(employeeQualification.employmentId,subject.employmentId!)));
          if(!existing || existing.archivedAt)throw new Error('Record ID is not a live qualification on this exact employment.');
        }
        await validateQualificationInputTx(tx,input,existing);
      } else {
        let existing:typeof personEmergencyContact.$inferSelect|undefined;
        if(parsed.recordId) {
          [existing]=await tx.select().from(personEmergencyContact).where(and(eq(personEmergencyContact.id,parsed.recordId),eq(personEmergencyContact.personId,subject.personId!)));
          if(!existing || existing.archivedAt)throw new Error('Record ID is not a live emergency contact for this employee’s person.');
        }
        await validateEmergencyContactInputTx(tx,subject.personId,input,existing);
      }
    }catch(error){errors.push(publicErrorMessage(error));}
    // Contact priority is person-scoped even when that person has several employee codes.
    if(subject && (kind==='qualification'?input.isHighest===true:input.priority==='primary')) {
      const key=kind==='qualification'?(subject.employmentId??parsed.employeeCode):(subject.personId??parsed.employeeCode);
      const prior=promoted.get(key);
      if(prior!==undefined) {
        errors.push(`More than one ${kind==='qualification'?'Highest qualification':'Primary contact'} is selected in this file.`);
        resolved[prior].preview.errors.push('Another row in this file selects the same exclusive flag.');resolved[prior].preview.ok=false;
      }else promoted.set(key,index);
    }
    resolved.push({subject,recordId:parsed.recordId,input,preview:{rowNum:index+1,employeeCode:parsed.employeeCode,employeeName:subject?.employeeName??'',recordId:parsed.recordId,
      action:parsed.recordId?'update':'create',ok:errors.length===0,errors,proposed:personnelImportProposedValues(normalized.record,kind)}});
  }
  if(resolved.some(row=>!row.preview.ok))fileErrors.push('Correct all register rows before importing. Nothing from this register file will be written.');
  const preview:RegisterPreview={kind,total:records.length,validCount:resolved.filter(row=>row.preview.ok).length,rows:resolved.map(row=>row.preview),fileErrors};
  return {preview,resolved};
}
export function validateRegisterImport(ctx:SessionContext,kind:PersonnelRegisterKind,records:ImportRecord[],options?:{subjects:RegisterSubject[];newEmployees?:boolean}) {
  assertBounds(records);
  return withTenant(ctx,tx=>analyzeRegisterImportTx(tx,kind,records,options),{readOnlySnapshot:true});
}
/** Caller supplies only freshly created subjects or a freshly authorized/locked section subject. */
export async function writeRegisterRowsTx(tx:Tx,ctx:SessionContext,kind:PersonnelRegisterKind,rows:Resolved[],created?:Map<string,{employmentId:string;personId:string}>) {
  let count=0;
  for(const row of rows) {
    if(!row.preview.ok || !row.subject)throw new Error('Register row was not validated.');
    const target=created?.get(row.preview.employeeCode)??row.subject;
    if(!target.employmentId || !target.personId)throw new Error('Register row has no created employee.');
    // The ID is checked again under the write transaction; archive/ownership races never retarget.
    if(row.recordId) {
      if(kind==='qualification') {
        const [existing]=await tx.select({id:employeeQualification.id,archivedAt:employeeQualification.archivedAt}).from(employeeQualification)
          .where(and(eq(employeeQualification.id,row.recordId),eq(employeeQualification.employmentId,target.employmentId))).for('update');
        if(!existing || existing.archivedAt)throw new Error('Qualification is no longer a live record on this employment.');
        await updateQualification(ctx,{id:row.recordId,...row.input},tx);
      }else {
        const [existing]=await tx.select({id:personEmergencyContact.id,archivedAt:personEmergencyContact.archivedAt}).from(personEmergencyContact)
          .where(and(eq(personEmergencyContact.id,row.recordId),eq(personEmergencyContact.personId,target.personId))).for('update');
        if(!existing || existing.archivedAt)throw new Error('Emergency contact is no longer a live record for this person.');
        await updateEmergencyContact(ctx,{id:row.recordId,...row.input},tx);
      }
    }else if(kind==='qualification')await addQualification(ctx,{employmentId:target.employmentId,...row.input,qualification:row.input.qualification!},tx);
    else await addEmergencyContact(ctx,{personId:target.personId,...row.input,fullName:row.input.fullName!},tx);
    count++;
  }
  return count;
}
export async function validateRegisterSection(ctx:SessionContext,kind:PersonnelRegisterKind,records:ImportRecord[]):Promise<SectionImportPreview> {
  const {preview}=await validateRegisterImport(ctx,kind,records);
  return {section:kind,total:preview.total,updateCount:preview.validCount,skipCount:0,createCount:0,missingColumns:[],fileErrors:preview.fileErrors,
    rows:preview.rows.map(row=>({...row,registerAction:row.action,verdict:'update' as const,warnings:[row.action==='create'?'Blank Record ID: creates a new register record.':'Updates only the supplied fields on this Record ID.'],changes:row.proposed.filter(cell=>!['employee_code','record_id'].includes(cell.column)).map(cell=>cell.column)}))};
}
export async function commitRegisterSection(ctx:SessionContext,kind:PersonnelRegisterKind,records:ImportRecord[]):Promise<SectionImportResult> {
  assertBounds(records);
  let updated=0;let fileErrors:string[]=[];
  try {await withTenant(ctx,async tx=>{
    const subjects=await loadSubjectsTx(tx,records,true);
    const analyzed=await analyzeRegisterImportTx(tx,kind,records,{subjects});
    if(analyzed.preview.fileErrors.length){fileErrors=analyzed.preview.fileErrors;return;}
    updated=await writeRegisterRowsTx(tx,ctx,kind,analyzed.resolved);
  });}catch(error){updated=0;fileErrors=[`No register rows were written. ${publicErrorMessage(error)}`];}
  return {section:kind,updated,skipped:records.length-updated,failed:[],fileErrors,runId:null};
}

/** IDs are obtained from authorized current records, never inferred from array positions or names. */
export function registerRecordsForEmployee(ctx:SessionContext,kind:PersonnelRegisterKind,employeeCode:string):Promise<ImportRecord[]> {
  return withTenant(ctx,async tx=>{
    const subjects=await loadSubjectsTx(tx,[{employee_code:employeeCode}],false);
    if(subjects.length!==1 || !subjects[0].valid)throw new Error('Choose one active Employee ID in your administered companies.');
    const subject=subjects[0];
    const rows=kind==='qualification'
      ? await tx.select().from(employeeQualification).where(and(eq(employeeQualification.employmentId,subject.employmentId!),sql`${employeeQualification.archivedAt} is null`)).orderBy(employeeQualification.id).limit(MAX_PERSONNEL_REGISTER_ROWS+1)
      : await tx.select().from(personEmergencyContact).where(and(eq(personEmergencyContact.personId,subject.personId!),sql`${personEmergencyContact.archivedAt} is null`)).orderBy(personEmergencyContact.id).limit(MAX_PERSONNEL_REGISTER_ROWS+1);
    if(rows.length>MAX_PERSONNEL_REGISTER_ROWS)throw new Error('This register has too many records for one import file. Use the Personnel register to update a smaller selection.');
    return rows.map(row=>{
      const record:ImportRecord={employee_code:subject.employeeCode,record_id:row.id};
      for(const field of personnelImportFields(kind)) {
        const value=(row as unknown as Record<string,unknown>)[field.import.writerField!];
        record[field.import.column!]=value==null?'':String(value);
      }
      return record;
    });
  },{readOnlySnapshot:true});
}
