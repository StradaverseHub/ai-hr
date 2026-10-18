/** Bounded canonical Movement rehearsals and per-employee atomic application.
 * Preview intentionally writes only inside a transaction that ALWAYS rolls back. It never dispatches
 * notifications, opens a detached writer transaction, or holds a lock while the user reviews the result.
 */
import {createHash} from 'node:crypto';
import {and,asc,eq,isNull,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assignment,businessUnit,company,compensation,department,domainEvent,employment,jobGrade,location,movementEventType,person,position,profileOption,reportingLine} from '../db/schema';
import {isAdmin} from '../lib/authz-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {MOVEMENT_FORM_IDS,type MovementFormField} from '../lib/movement-form-contract';
import {personnelFormField,personnelFormChoices} from '../lib/personnel-form-contract';
import {MOVEMENT_IMPORT_LIMITS,parseMovementImport,movementImportCellIssues,movementImportDate,type MovementImportRecord,type MovementImportRow,type MovementImportEmployee,type MovementImportPreview,type MovementImportResult} from '../lib/movement-import-contract';
import {createMovementEventTx,movementCurrentStateTx,applyDueMovementsTx,type CreateMovementInput} from './movement';
import {MOVEMENT_KINDS,movementNeedsEntitlementReprojection} from './movement-kinds';
import {resolveMovementEventTypeTx} from './movement-type';
import {lockEmploymentStatutoryOwnerTx} from './org';
import {lockLabelCriteriaTx,visibleLabelIdsCondition} from './system-labels';
import {reprojectEntitlementForEmployment} from '../packs/leave/service';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type MovementImportOption={value:string;label:string;aliases?:string[]};
export type MovementImportCatalog={types:{code:string;label:string|null;behaviour:string}[];companies:MovementImportOption[];fields:Partial<Record<MovementFormField,MovementImportOption[]>>};
const fieldKinds={orgDivision:true,employmentCategory:true,orgRegion:true,orgBranch:true,orgTeam:true,orgSection:true,orgLine:true,orgBase:true} as const;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertAdmin(ctx:SessionContext){if(!isAdmin(ctx))throw new Error('Only an admin can import movements.');}
function budget(deadline:number){if(Date.now()>deadline)throw new Error('movement_import_timeout');}
async function limits(tx:Tx){await tx.execute(sql`select set_config('lock_timeout',${MOVEMENT_IMPORT_LIMITS.lockMs+'ms'},true),set_config('statement_timeout',${MOVEMENT_IMPORT_LIMITS.statementMs+'ms'},true)`);}
async function assertCompany(tx:Tx,ctx:SessionContext,id:string){
 if(!UUID.test(id))throw new Error('company_not_available');
 const [row]=await tx.select({id:company.id}).from(company).where(and(eq(company.tenantId,ctx.tenantId),eq(company.id,id),sql`app.is_admin_for(${company.id})`)).limit(1);
 if(!row)throw new Error('company_not_available');
}
async function catalogTx(tx:Tx,ctx:SessionContext,companyId:string):Promise<MovementImportCatalog>{
 await assertCompany(tx,ctx,companyId);
 const overlays=await tx.select({code:movementEventType.code}).from(movementEventType).where(eq(movementEventType.tenantId,ctx.tenantId)).orderBy(asc(movementEventType.sortOrder),asc(movementEventType.code)).limit(1001);
 if(overlays.length>1000)throw new Error('movement_catalog_too_large');
 const types:MovementImportCatalog['types']=[];
 for(const code of new Set([...MOVEMENT_KINDS,...overlays.map(row=>row.code)])){
  const resolved=await resolveMovementEventTypeTx(tx,ctx.tenantId,code);if(resolved?.active)types.push({code:resolved.code,label:resolved.label,behaviour:resolved.behaviourKind});
 }
 if(types.length>1000)throw new Error('movement_catalog_too_large');
 const companies=await tx.select({value:company.id,label:company.legalName}).from(company).where(and(eq(company.tenantId,ctx.tenantId),sql`app.is_admin_for(${company.id})`)).orderBy(asc(company.legalName),asc(company.id)).limit(1001);
 const departments=await tx.select({value:department.id,label:department.name}).from(department).where(and(eq(department.tenantId,ctx.tenantId),isNull(department.archivedAt),visibleLabelIdsCondition(department,'department',[companyId]))).orderBy(asc(department.name),asc(department.id)).limit(1001);
 const positions=await tx.select({value:position.id,label:position.title}).from(position).where(and(eq(position.tenantId,ctx.tenantId),isNull(position.archivedAt),visibleLabelIdsCondition(position,'position',[companyId]))).orderBy(asc(position.title),asc(position.id)).limit(1001);
 const units=await tx.select({value:businessUnit.id,label:businessUnit.name}).from(businessUnit).where(and(eq(businessUnit.tenantId,ctx.tenantId),isNull(businessUnit.archivedAt),visibleLabelIdsCondition(businessUnit,'business_unit',[companyId]))).orderBy(asc(businessUnit.name),asc(businessUnit.id)).limit(1001);
 const locations=await tx.select({value:location.id,label:location.name}).from(location).where(and(eq(location.tenantId,ctx.tenantId),eq(location.companyId,companyId),isNull(location.archivedAt))).orderBy(asc(location.name),asc(location.id)).limit(1001);
 const grades=await tx.select({value:jobGrade.id,label:jobGrade.name,code:jobGrade.code}).from(jobGrade).where(and(eq(jobGrade.tenantId,ctx.tenantId),isNull(jobGrade.archivedAt))).orderBy(asc(jobGrade.code),asc(jobGrade.id)).limit(1001);
 const managers=await tx.select({value:employment.id,label:employment.employeeCode,name:person.fullName}).from(employment).innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId))).where(and(eq(employment.tenantId,ctx.tenantId),isNull(employment.terminatedOn))).orderBy(asc(employment.employeeCode),asc(employment.id)).limit(1001);
 if([companies,departments,positions,units,locations,grades,managers].some(rows=>rows.length>1000))throw new Error('movement_reference_catalog_too_large');
 const fields:MovementImportCatalog['fields']={companyId:companies,departmentId:departments,positionId:positions,businessUnitId:units,locationId:locations,gradeId:grades.map(row=>({value:row.value,label:row.code+' · '+row.label,aliases:[row.code,row.label]})),managerEmploymentId:managers.map(row=>({value:row.value,label:(row.label??'')+' · '+row.name,aliases:[row.label??'',row.name].filter(Boolean)}))};
 const options=await tx.select({category:profileOption.category,value:profileOption.value,label:profileOption.label}).from(profileOption).where(and(eq(profileOption.tenantId,ctx.tenantId),eq(profileOption.isActive,true))).orderBy(asc(profileOption.category),asc(profileOption.sortOrder),asc(profileOption.id)).limit(10001);
 if(options.length>10000)throw new Error('movement_reference_catalog_too_large');
 for(const field of Object.keys(fieldKinds) as (keyof typeof fieldKinds)[]){
  const category=personnelFormField(MOVEMENT_FORM_IDS[field]).allowedValuesOwner?.replace(/^profile_option:/,'');
  fields[field]=options.filter(row=>row.category===category).map(({value,label})=>({value,label}));
 }
 if(Object.values(fields).some(rows=>rows&&rows.length>1000))throw new Error('movement_reference_catalog_too_large');
 return {types,companies,fields};
}
export function movementImportCatalog(ctx:SessionContext,companyId:string){assertAdmin(ctx);return withTenant(ctx,async tx=>{await limits(tx);return catalogTx(tx,ctx,companyId);},{readOnlySnapshot:true});}
function lookup(raw:string,options:MovementImportOption[],field:string):string{
 const exact=options.filter(option=>option.value===raw||`${option.value} · ${option.label}`===raw);
 if(exact.length===1)return exact[0].value;
 const named=options.filter(option=>option.label.toLowerCase()===raw.toLowerCase()||option.aliases?.some(alias=>alias.toLowerCase()===raw.toLowerCase()));
 if(named.length!==1)throw new Error(named.length?'ambiguous_reference:'+field:'unknown_reference:'+field);
 return named[0].value;
}
async function inputTx(tx:Tx,ctx:SessionContext,record:MovementImportRecord,employmentId:string,currentCompanyId:string){
 const source=await catalogTx(tx,ctx,currentCompanyId);
 const submitted=record.cells.kind??'';const code=lookup(submitted,source.types.map(type=>({value:type.code,label:type.label??type.code})),'event_type');
 const resolved=await resolveMovementEventTypeTx(tx,ctx.tenantId,code);
 if(!resolved?.active)throw new Error('unknown_or_inactive_event_type');
 const issues=movementImportCellIssues(record,resolved.behaviourKind);if(issues.length)throw new Error(issues.join('; '));
 const effectiveDate=movementImportDate(record.cells.effectiveDate!)!;
 const [dates]=await tx.select({hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn,lastWorkingDate:employment.lastWorkingDate,resignationDate:employment.resignationDate}).from(employment).where(eq(employment.id,employmentId)).limit(1);
 if(!dates)throw new Error('employee_not_available');
 if(resolved.behaviourKind!=='groupJoinDateCorrection'&&effectiveDate<dates.hiredOn)throw new Error('event_before_hire');
 const exit=[dates.terminatedOn,dates.lastWorkingDate,dates.resignationDate].filter((date):date is string=>!!date).sort()[0];
 if(exit&&effectiveDate>exit&&!['blacklist','groupJoinDateCorrection'].includes(resolved.behaviourKind))throw new Error('event_after_exit');
 if(resolved.behaviourKind==='blacklist'&&effectiveDate!==todayInKualaLumpur())throw new Error('blacklist_date_must_be_today');
 const targetCompanyId=record.cells.companyId?lookup(record.cells.companyId,source.companies,'companyId'):currentCompanyId;
 const catalog=targetCompanyId===currentCompanyId?source:await catalogTx(tx,ctx,targetCompanyId);
 const input:CreateMovementInput={employmentId,kind:resolved.code,effectiveDate};
 for(const [key,raw] of Object.entries(record.cells)){
  const field=key as MovementFormField;if(field==='kind'||field==='effectiveDate'||raw==null)continue;
  if(field==='companyId')input.companyId=targetCompanyId;
  else if(field==='departmentId'||field==='positionId'||field==='businessUnitId'||field==='locationId'||field==='gradeId'||field==='managerEmploymentId')input[field]=lookup(raw,catalog.fields[field]??[],field);
  else if(field==='endDate'||field==='resignationDate')input[field]=movementImportDate(raw)!;
  else if(field==='basicSalary'||field==='terminationNoticeDays'){
   if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)||!Number.isFinite(Number(raw)))throw new Error('invalid_number:'+field);
   input[field]=Number(raw);
  }else if(field==='blacklisted'){
   if(!['true','false'].includes(raw.toLowerCase()))throw new Error('invalid_boolean:blacklisted');input.blacklisted=raw.toLowerCase()==='true';
  }else if(field==='employmentType'){
   const allowed=personnelFormChoices(MOVEMENT_FORM_IDS.employmentType).map(choice=>choice.value);
   if(!allowed.includes(raw))throw new Error('invalid_choice:employmentType');input.employmentType=raw as NonNullable<CreateMovementInput['employmentType']>;
  }else if(field in fieldKinds){
   const options=catalog.fields[field]??[];input[field as keyof typeof fieldKinds]=options.length?lookup(raw,options,field):raw;
  }else if(field==='remarks'||field==='currency'||field==='payMode'||field==='paymentTerm'||field==='terminationReasonCode')input[field]=raw;
 }
 return {input,source,catalog};
}
async function subjectTx(tx:Tx,ctx:SessionContext,companyId:string,code:string){
 const rows=await tx.select({id:employment.id,name:person.fullName}).from(employment).innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId))).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.companyId,companyId),eq(employment.employeeCode,code),sql`app.is_admin_for(${employment.companyId})`)).limit(2);
 if(rows.length!==1)throw new Error('employee_not_found_in_selected_company');
 await lockLabelCriteriaTx(tx,ctx.tenantId);
 await lockEmploymentStatutoryOwnerTx(tx,rows[0].id);
 const locked=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,rows[0].id),eq(employment.companyId,companyId))).for('update');
 if(!locked.length)throw new Error('employee_changed');
 const openAssignments=await tx.select({id:assignment.id}).from(assignment).where(and(eq(assignment.employmentId,rows[0].id),isNull(assignment.validTo),isNull(assignment.supersededAt))).limit(2);
 const openComp=await tx.select({id:compensation.id}).from(compensation).where(and(eq(compensation.employmentId,rows[0].id),isNull(compensation.validTo),isNull(compensation.supersededAt))).limit(2);
 const openLines=await tx.select({id:reportingLine.id}).from(reportingLine).where(and(eq(reportingLine.subordinateEmploymentId,rows[0].id),eq(reportingLine.lineType,'administrative'),isNull(reportingLine.validTo),isNull(reportingLine.supersededAt))).limit(2);
 if([openAssignments,openComp,openLines].some(values=>values.length>1))throw new Error('ambiguous_current_records');
 return rows[0];
}
/** Fresh authoritative state, including historical/scheduled events and caller-visible current catalogs.
 * The digest is a stale-preview comparison, never an authorization credential. All writes revalidate. */
async function fingerprintTx(tx:Tx,ctx:SessionContext,id:string,companyId:string,inputHash:string,selection:number[],records:MovementImportRecord[],deadline:number){
 const emp=await tx.select().from(employment).where(eq(employment.id,id));
 const assignments=await tx.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id));
 const salaries=await tx.select().from(compensation).where(eq(compensation.employmentId,id)).orderBy(asc(compensation.id));
 const lines=await tx.select().from(reportingLine).where(or(eq(reportingLine.subordinateEmploymentId,id),eq(reportingLine.managerEmploymentId,id))).orderBy(asc(reportingLine.id));
 const events=await tx.select({id:domainEvent.id,sequence:domainEvent.sequence,payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.subjectEmploymentId,id))).orderBy(asc(domainEvent.sequence),asc(domainEvent.id));
 const source=await catalogTx(tx,ctx,companyId);const destinations=new Set([companyId]);
 for(const record of records)if(record.cells.companyId){try{destinations.add(lookup(record.cells.companyId,source.companies,'companyId'));}catch{/* The row validator reports an invalid reference without discarding other rows. */}}
 const catalogs=[];for(const destination of [...destinations].sort()){budget(deadline);catalogs.push([destination,destination===companyId?source:await catalogTx(tx,ctx,destination)]);}
 return digest({tenant:ctx.tenantId,user:ctx.userId??null,inputHash,selection,emp,assignments,salaries,lines,events,catalogs});
}
function message(error:unknown){return error instanceof Error&&!('code' in error)?error.message:'The change was refused. No changes from this employee were saved.';}
function rowView(record:MovementImportRecord):MovementImportRow{return {row:record.row,employeeCode:record.employeeCode,eventType:record.cells.kind??'',effectiveDate:movementImportDate(record.cells.effectiveDate??'')??record.cells.effectiveDate??'',status:'excluded',errors:[...record.errors]};}
function selectionFor(records:MovementImportRecord[],selection?:number[]){
 if(selection===undefined)return records.map(row=>row.row);
 if(!Array.isArray(selection)||selection.length>MOVEMENT_IMPORT_LIMITS.rows||new Set(selection).size!==selection.length||selection.some(row=>!Number.isSafeInteger(row)||!records.some(record=>record.row===row)))throw new Error('invalid_selection');
 return [...selection].sort((a,b)=>a-b);
}
function groupsFor(records:MovementImportRecord[]){const groups=new Map<string,MovementImportRecord[]>();for(const row of records)groups.set(row.employeeCode,[...(groups.get(row.employeeCode)??[]),row]);return groups;}
function sortSequence(rows:MovementImportRecord[]){return [...rows].sort((a,b)=>(movementImportDate(a.cells.effectiveDate??'')??'9999').localeCompare(movementImportDate(b.cells.effectiveDate??'')??'9999')||a.row-b.row);}
async function lifecycleTx(tx:Tx,id:string){
 const [row]=await tx.select({hiredOn:employment.hiredOn,joinDate:employment.joinDate,confirmationDate:employment.confirmationDate,extendedConfirmationDate:employment.extendedConfirmationDate,tenderResignationDate:employment.tenderResignationDate,lastWorkingDate:employment.lastWorkingDate,terminatedOn:employment.terminatedOn,blacklistedAt:employment.blacklistedAt}).from(employment).where(eq(employment.id,id)).limit(1);return row??{};
}
type RehearsedRow={view:MovementImportRow;input:CreateMovementInput;changedFields:string[]};
function readable(values:Record<string,string|null>,catalog:MovementImportCatalog):Record<string,string|null>{
 return Object.fromEntries(Object.entries(values).map(([key,value])=>{
  const options=key==='companyId'?catalog.companies:catalog.fields[key as MovementFormField];
  const found=options?.find(option=>option.value===value);return [key,found?found.label+' · '+found.value:value];
 }));
}
function assertSequence(previous:RehearsedRow[],next:RehearsedRow){
 const sameDay=previous.filter(row=>row.input.effectiveDate===next.input.effectiveDate);
 if(sameDay.some(row=>digest(row.input)===digest(next.input)))throw new Error('duplicate_event_in_sequence');
 if(sameDay.some(row=>row.changedFields.some(field=>next.changedFields.includes(field))))throw new Error('same_date_conflicting_changes');
}
async function applyRowTx(tx:Tx,ctx:SessionContext,record:MovementImportRecord,id:string,rehearsal:boolean,resolvedInput?:CreateMovementInput):Promise<RehearsedRow>{
 const before={...await movementCurrentStateTx(tx,id),...await lifecycleTx(tx,id)};
 const prepared=resolvedInput?null:await inputTx(tx,ctx,record,id,before.companyId);
 const input=resolvedInput??prepared!.input;
 const catalogBefore=prepared?.source??await catalogTx(tx,ctx,before.companyId);
 const catalogAfter=prepared?.catalog??(input.companyId&&input.companyId!==before.companyId?await catalogTx(tx,ctx,input.companyId):catalogBefore);
 const result=await createMovementEventTx(tx,ctx,input);
 if('changed' in result&&result.changed===false)throw new Error('movement_has_no_changes');
 const scheduled='scheduled' in result&&result.scheduled===true;
 // Advance only the rollback-only rehearsal, through the very same owner the normal sweep uses.
 // The committed pass records the original future intent and never runs this branch.
 if(scheduled&&rehearsal)await applyDueMovementsTx(tx,ctx,id,input.effectiveDate);
 if(movementNeedsEntitlementReprojection(result.behaviourKind))await reprojectEntitlementForEmployment(ctx,{employmentId:id,trigger:scheduled&&rehearsal?'movement_applied':'movement_recorded',gradeBefore:{gradeId:before.gradeId},changeEffectiveOn:input.effectiveDate,...(scheduled&&rehearsal?{asOf:input.effectiveDate}:{})},tx);
 const after={...await movementCurrentStateTx(tx,id),...await lifecycleTx(tx,id)};
 const afterValues:Record<string,string|null>=after;
 const changedFields=Object.entries(before).filter(([key,value])=>afterValues[key]!==value).map(([key])=>key);
 const extra=Object.fromEntries(Object.entries(input).filter(([key])=>!['employmentId','kind','effectiveDate','typeCode'].includes(key)&&!(key in after)).map(([key,value])=>[key,value==null?null:String(value)]));
 const view:MovementImportRow={...rowView(record),eventType:input.kind,status:'valid',errors:[],before:readable(before,catalogBefore),proposed:{...readable(after,catalogAfter),...extra},scheduled,payrollFlaggedPeriods:'payrollFlaggedPeriods' in result&&Array.isArray(result.payrollFlaggedPeriods)?result.payrollFlaggedPeriods:[]};
 return {view,input,changedFields};
}
/** This sentinel is caught only AFTER Drizzle has rolled the complete rehearsal savepoint back. */
class SequenceRollback extends Error{constructor(readonly rows:RehearsedRow[]){super('movement_sequence_rehearsal_rollback');}}
async function rehearseSequenceTx(tx:Tx,ctx:SessionContext,records:MovementImportRecord[],id:string,deadline:number):Promise<RehearsedRow[]>{
 try{
  await tx.transaction(async rehearsalTx=>{
   const rows:RehearsedRow[]=[];
   for(const record of sortSequence(records)){budget(deadline);const next=await applyRowTx(rehearsalTx,ctx,record,id,true);assertSequence(rows,next);rows.push(next);budget(deadline);}
   throw new SequenceRollback(rows);
  });
 }catch(error){if(error instanceof SequenceRollback)return error.rows;throw error;}
 throw new Error('movement_rehearsal_did_not_rollback');
}
class PreviewRollback extends Error{constructor(readonly employee:MovementImportEmployee){super('movement_preview_rollback');}}
export async function previewMovementImport(ctx:SessionContext,p:{companyId:string;csv:string;selection?:number[]}):Promise<MovementImportPreview>{
 assertAdmin(ctx);const parsed=parseMovementImport(p.csv);const selection=selectionFor(parsed.records,p.selection);const inputHash=digest({companyId:p.companyId,csv:p.csv});
 const result:MovementImportPreview={inputHash,selection,fileErrors:parsed.fileErrors,employees:[],excluded:0,valid:0};if(parsed.fileErrors.length)return result;
 const deadline=Date.now()+MOVEMENT_IMPORT_LIMITS.requestMs;
 for(const [code,records] of groupsFor(parsed.records)){
  budget(deadline);let employee:MovementImportEmployee={employeeCode:code,employmentId:null,name:null,rows:sortSequence(records).map(rowView),fingerprint:null};
  try{
   await withTenant(ctx,async tx=>{
    const employeeDeadline=Math.min(deadline,Date.now()+MOVEMENT_IMPORT_LIMITS.employeeMs);await limits(tx);await assertCompany(tx,ctx,p.companyId);
    const subject=await subjectTx(tx,ctx,p.companyId,code);employee={...employee,employmentId:subject.id,name:subject.name,fingerprint:await fingerprintTx(tx,ctx,subject.id,p.companyId,inputHash,selection,records,employeeDeadline)};
    const rows:MovementImportRow[]=[];const previous:RehearsedRow[]=[];
    for(const record of sortSequence(records)){
     budget(employeeDeadline);
     if(!selection.includes(record.row)){rows.push(rowView(record));continue;}
     try{const next=await tx.transaction(async rowTx=>{const value=await applyRowTx(rowTx,ctx,record,subject.id,true);assertSequence(previous,value);return value;});previous.push(next);rows.push(next.view);}
     catch(error){rows.push({...rowView(record),status:'invalid',errors:[message(error)]});}
     budget(employeeDeadline);
    }
    // Throwing is mandatory even after successful rehearsal. withTenant never observes success.
    throw new PreviewRollback({...employee,rows});
   });
  }catch(error){
   if(error instanceof PreviewRollback)employee=error.employee;
   else employee={...employee,fingerprint:null,rows:employee.rows.map(row=>selection.includes(row.row)?{...row,status:'invalid',errors:[message(error)]}:row)};
  }
  result.employees.push(employee);
 }
 for(const employee of result.employees)for(const row of employee.rows)row.status==='valid'?result.valid++:result.excluded++;
 return result;
}
export async function commitMovementImport(ctx:SessionContext,p:{companyId:string;csv:string;selection:number[];inputHash:string;fingerprints:Record<string,string>;acknowledgeExcluded:boolean}):Promise<MovementImportResult>{
 assertAdmin(ctx);const parsed=parseMovementImport(p.csv);if(parsed.fileErrors.length)throw new Error(parsed.fileErrors.join('; '));const selection=selectionFor(parsed.records,p.selection);
 if(!selection.length)throw new Error('select_valid_rows');const inputHash=digest({companyId:p.companyId,csv:p.csv});if(inputHash!==p.inputHash)throw new Error('preview_changed');
 if(selection.length!==parsed.records.length&&p.acknowledgeExcluded!==true)throw new Error('confirm_excluded_rows');
 const result:MovementImportResult={employees:[],imported:0,failed:0,excluded:parsed.records.length-selection.length,byEventType:[]};const deadline=Date.now()+MOVEMENT_IMPORT_LIMITS.requestMs;
 for(const [code,records] of groupsFor(parsed.records)){
  const chosen=sortSequence(records.filter(row=>selection.includes(row.row)));if(!chosen.length){result.employees.push({employeeCode:code,employmentId:null,name:null,rows:records.map(rowView),fingerprint:null});continue;}
  let employee:MovementImportEmployee={employeeCode:code,employmentId:null,name:null,rows:sortSequence(records).map(rowView),fingerprint:null};
  try{
   budget(deadline);
   employee=await withTenant(ctx,async tx=>{
    const employeeDeadline=Math.min(deadline,Date.now()+MOVEMENT_IMPORT_LIMITS.employeeMs);await limits(tx);await assertCompany(tx,ctx,p.companyId);const subject=await subjectTx(tx,ctx,p.companyId,code);
    employee={...employee,employmentId:subject.id,name:subject.name};
    const fingerprint=await fingerprintTx(tx,ctx,subject.id,p.companyId,inputHash,selection,records,employeeDeadline);
    if(!p.fingerprints||p.fingerprints[code]!==fingerprint)throw new Error('preview_stale_revalidate');
    const rehearsed=await rehearseSequenceTx(tx,ctx,chosen,subject.id,employeeDeadline);
    if(await fingerprintTx(tx,ctx,subject.id,p.companyId,inputHash,selection,records,employeeDeadline)!==fingerprint)throw new Error('preview_stale_revalidate');
    const rows:MovementImportRow[]=[];
    for(const record of sortSequence(records)){
     if(!selection.includes(record.row)){rows.push(rowView(record));continue;}
     budget(employeeDeadline);const plan=rehearsed.find(row=>row.view.row===record.row);if(!plan)throw new Error('movement_sequence_changed');
     const row=await applyRowTx(tx,ctx,record,subject.id,false,plan.input);rows.push({...plan.view,status:'imported',scheduled:row.view.scheduled,payrollFlaggedPeriods:row.view.payrollFlaggedPeriods});budget(employeeDeadline);
    }
    return {employeeCode:code,employmentId:subject.id,name:subject.name,rows,fingerprint};
   });
   result.imported+=chosen.length;
  }catch(error){employee={...employee,rows:employee.rows.map(row=>selection.includes(row.row)?{...row,status:'failed',errors:[message(error)]}:row)};result.failed+=chosen.length;}
  result.employees.push(employee);
 }
 const counts=new Map<string,{eventType:string;imported:number;failed:number;excluded:number}>();
 for(const employee of result.employees)for(const row of employee.rows){const count=counts.get(row.eventType)??{eventType:row.eventType,imported:0,failed:0,excluded:0};row.status==='imported'?count.imported++:row.status==='failed'?count.failed++:count.excluded++;counts.set(row.eventType,count);}
 result.byEventType=[...counts.values()].sort((a,b)=>a.eventType.localeCompare(b.eventType));return result;
}
