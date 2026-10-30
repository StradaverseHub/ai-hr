import {lockAccessConfigurationTx} from './access-configuration-lock';
import {assertWorkforceCompanyTx,workforceEmploymentPredicate} from './workforce-access';
/** Bounded canonical Movement rehearsals and per-employee atomic application.
 * Preview intentionally writes only inside a transaction that ALWAYS rolls back. It never dispatches
 * notifications, opens a detached writer transaction, or holds a lock while the user reviews the result.
 */
import {createHash,randomUUID} from 'node:crypto';
import {appendEvent,actorOf} from '../db/events';
import {EMPLOYMENT_TEST_RECORD_EVENT,lockMovementImportReferenceAdmissionTx} from './movement-import-admission';
import {movementImportRulesTx,recheckMovementManagerEvidenceTx,type MovementManagerEvidence} from './movement-import-rules';
import {and,asc,eq,gt,inArray,isNull,lte,ne,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assignment,businessUnit,company,compensation,department,domainEvent,employment,jobGrade,location,person,position,profileOption,reportingLine} from '../db/schema';
import {isAdmin} from '../lib/authz-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {movementRecordLimits} from '../lib/movement-type-csv';
import type {MovementWorkbookType} from '../lib/movement-workbook-layout';
import {MOVEMENT_FORM_IDS,type MovementFormField} from '../lib/movement-form-contract';
import {personnelFormField,personnelFormChoices} from '../lib/personnel-form-contract';
import {personnelImportOptionLookup} from '../lib/personnel-import-lookup';
import {MOVEMENT_IMPORT_LIMITS,parseMovementImport,movementImportCellIssues,movementImportDate,type MovementImportAction,type MovementImportRecord,type MovementImportRow,type MovementImportEmployee,type MovementImportPreview,type MovementImportResult} from '../lib/movement-import-contract';
import {createMovementEventTx,movementCurrentStateTx,applyDueMovementsTx,rehearseMovementSequenceTx,movementLedgerMarkerTx,movementRowsAfterSequenceTx,movementCorrectionBaseTx,editMovementEventTx,reverseMovementForImportTx,MovementClosedPayrollAcknowledgementError,MovementFieldRuleError,MovementNoChangeError,MovementNotCorrectableError,MovementReasonRequiredError,type MovementSequenceCreate,type CreateMovementInput} from './movement';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {allocationCompanyCode,matchAllocationCompany} from './cost-allocation-import';
import {recordImportItemTx} from './import-history';
import {isComparisonKind,movementNeedsEntitlementReprojection} from './movement-kinds';
import {resolveMovementEventTypeTx,activeMovementEventTypeChoicesTx,lockMovementTypeCatalogueTx} from './movement-type';
import {lockEmploymentStatutoryOwnerTx} from './org';
import {deriveEmploymentStatus} from './employment-status';
import {visibleLabelIdsCondition} from './system-labels';
import {reprojectEntitlementForEmployment} from '../packs/leave/service';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** One active type as the workbook and the import see it. 1d58019a Step 2 — with its controls (the reasons a
 * Termination type offers, a comparison type's Field Controls), which the catalogue fingerprint therefore binds. */
const importType=(type:Awaited<ReturnType<typeof activeMovementEventTypeChoicesTx>>[number])=>({code:type.code,label:type.label,behaviour:type.behaviourKind,...('reasons' in type&&type.reasons?{reasons:type.reasons}:{}),...('rules' in type&&type.rules?{rules:type.rules}:{})});
/**
 * 1d58019a Step 2 — a Field Controls refusal as a finite row code naming the field. The import cannot carry
 * files, so a row that changes a field whose document is Required becomes `movement_document_required` and the
 * message tells HR to record that movement on screen.
 */
function fieldRuleError(error:unknown):never{
 if(error instanceof MovementFieldRuleError)throw new Error('movement_'+error.code+':'+error.field);
 throw error;
}
export type MovementImportOption={value:string;label:string;codes?:string[];aliases?:string[];companyId?:string;isTestRecord?:boolean;eligible?:boolean};
export type MovementImportCatalog={types:MovementWorkbookType[];companies:MovementImportOption[];fields:Partial<Record<MovementFormField,MovementImportOption[]>>};
const fieldKinds={orgDivision:true,employmentCategory:true,orgRegion:true,orgBranch:true,orgTeam:true,orgSection:true,orgLine:true,orgBase:true} as const;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertAdmin(ctx:SessionContext){if(!isAdmin(ctx))throw new Error('Only an admin can import movements.');}
function budget(deadline:number){if(Date.now()>deadline)throw new Error('movement_import_timeout');}
async function limits(tx:Tx){await tx.execute(sql`select set_config('lock_timeout',${MOVEMENT_IMPORT_LIMITS.lockMs+'ms'},true),set_config('statement_timeout',${MOVEMENT_IMPORT_LIMITS.statementMs+'ms'},true)`);}
async function assertCompany(tx:Tx,ctx:SessionContext,id:string){
 if(!UUID.test(id))throw new Error('company_not_available');
 await assertWorkforceCompanyTx(tx,ctx,id,'view');
 await assertWorkforceCompanyTx(tx,ctx,id,'maintain');
 const [row]=await tx.select({id:company.id}).from(company).where(and(eq(company.tenantId,ctx.tenantId),eq(company.id,id),sql`app.is_admin_for(${company.id})`)).limit(1);
 if(!row)throw new Error('company_not_available');
}
async function catalogTx(tx:Tx,ctx:SessionContext,companyId:string):Promise<MovementImportCatalog>{
 await assertCompany(tx,ctx,companyId);
 const types=(await activeMovementEventTypeChoicesTx(tx,ctx.tenantId)).map(importType);
 // ac6645ec — the destination of an Entity Transfer may be named by the same Company ID as the row's company.
 const companies=(await tx.select({value:company.id,label:company.legalName,code:company.companyLabel,registration:company.registrationNo}).from(company).where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.is_admin_for(${company.id}) and app.access_workforce_company(${company.id},'workforce.view') and app.access_workforce_company(${company.id},'workforce.maintain')`)).orderBy(asc(company.legalName),asc(company.id)).limit(MOVEMENT_IMPORT_LIMITS.referenceRows+1)).map(({code,registration,...row})=>({...row,codes:[code,registration].filter((v):v is string=>!!v?.trim())}));
 const departments=await tx.select({value:department.id,label:department.label,code:department.name}).from(department).where(and(eq(department.tenantId,ctx.tenantId),isNull(department.archivedAt),visibleLabelIdsCondition(department,'department',[companyId]))).orderBy(asc(department.name),asc(department.id)).limit(MOVEMENT_IMPORT_LIMITS.referenceRows+1);
 const positions=await tx.select({value:position.id,label:position.label,code:position.title}).from(position).where(and(eq(position.tenantId,ctx.tenantId),isNull(position.archivedAt),visibleLabelIdsCondition(position,'position',[companyId]))).orderBy(asc(position.title),asc(position.id)).limit(MOVEMENT_IMPORT_LIMITS.referenceRows+1);
 const units=await tx.select({value:businessUnit.id,label:businessUnit.label,code:businessUnit.code,name:businessUnit.name}).from(businessUnit).where(and(eq(businessUnit.tenantId,ctx.tenantId),isNull(businessUnit.archivedAt),visibleLabelIdsCondition(businessUnit,'business_unit',[companyId]))).orderBy(asc(businessUnit.name),asc(businessUnit.id)).limit(MOVEMENT_IMPORT_LIMITS.referenceRows+1);
 const locations=await tx.select({value:location.id,label:location.name,code:location.code}).from(location).where(and(eq(location.tenantId,ctx.tenantId),eq(location.companyId,companyId),isNull(location.archivedAt))).orderBy(asc(location.name),asc(location.id)).limit(MOVEMENT_IMPORT_LIMITS.referenceRows+1);
 const grades=await tx.select({value:jobGrade.id,label:jobGrade.name,code:jobGrade.code}).from(jobGrade).where(and(eq(jobGrade.tenantId,ctx.tenantId),isNull(jobGrade.archivedAt))).orderBy(asc(jobGrade.code),asc(jobGrade.id)).limit(MOVEMENT_IMPORT_LIMITS.referenceRows+1);
 const managers=await tx.select({value:employment.id,label:employment.employeeCode,name:person.fullName,companyId:employment.companyId,isTestRecord:employment.isTestRecord,hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn,lastWorkingDate:employment.lastWorkingDate,resignationDate:employment.resignationDate,blacklistedAt:employment.blacklistedAt}).from(employment).innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId))).where(and(eq(employment.tenantId,ctx.tenantId),isNull(employment.terminatedOn),workforceEmploymentPredicate(sql`${employment.id}`,'view'))).orderBy(asc(employment.employeeCode),asc(employment.id)).limit(MOVEMENT_IMPORT_LIMITS.referenceRows+1);
 if([companies,departments,positions,units,locations,grades,managers].some(rows=>rows.length>MOVEMENT_IMPORT_LIMITS.referenceRows))throw new Error('movement_reference_catalog_too_large');
 const managerLabels=new Map(companies.map(c=>[c.value,c.label]));
 const fields:MovementImportCatalog['fields']={companyId:companies,departmentId:departments.map(row=>({value:row.value,label:row.label?.trim()||row.code,codes:[row.code]})),positionId:positions.map(row=>({value:row.value,label:row.label?.trim()||row.code,codes:[row.code]})),businessUnitId:units.map(row=>({value:row.value,label:row.label?.trim()||row.code,codes:[row.code],aliases:[row.name]})),locationId:locations.map(row=>({value:row.value,label:row.label,codes:[row.code]})),gradeId:grades.map(row=>({value:row.value,label:row.code+' · '+row.label,codes:[row.code],aliases:[row.label]})),managerEmploymentId:managers.map(row=>({value:row.value,label:(row.label??'')+' · '+row.name,codes:row.label?[row.label]:[],aliases:[row.name,...(managerLabels.has(row.companyId)?[managerLabels.get(row.companyId)+' · '+(row.label??'')+' · '+row.name]:[])].filter(Boolean),companyId:row.companyId,isTestRecord:row.isTestRecord,eligible:row.hiredOn<=todayInKualaLumpur()&&!['resigned','blacklisted'].includes(deriveEmploymentStatus(row,todayInKualaLumpur()))}))};
 const options=await tx.select({category:profileOption.category,value:profileOption.value,label:profileOption.label}).from(profileOption).where(and(eq(profileOption.tenantId,ctx.tenantId),eq(profileOption.isActive,true))).orderBy(asc(profileOption.category),asc(profileOption.sortOrder),asc(profileOption.id)).limit(MOVEMENT_IMPORT_LIMITS.referenceRows+1);
 if(options.length>MOVEMENT_IMPORT_LIMITS.referenceRows)throw new Error('movement_reference_catalog_too_large');
 for(const field of Object.keys(fieldKinds) as (keyof typeof fieldKinds)[]){
  const category=personnelFormField(MOVEMENT_FORM_IDS[field]).allowedValuesOwner?.replace(/^profile_option:/,'');
  fields[field]=options.filter(row=>row.category===category).map(({value,label})=>({value,label}));
 }
 if(Object.values(fields).some(rows=>rows&&rows.length>MOVEMENT_IMPORT_LIMITS.referenceRows))throw new Error('movement_reference_catalog_too_large');
 return {types,companies,fields};
}
export function movementImportCatalog(ctx:SessionContext,companyId:string){assertAdmin(ctx);return withTenant(ctx,async tx=>{await limits(tx);await lockAccessConfigurationTx(tx,ctx.tenantId);return catalogTx(tx,ctx,companyId);});}
function lookup(raw:string,options:MovementImportOption[],field:string):string{
 const choices=personnelImportOptionLookup(options);
 if(choices.isAmbiguous(raw))throw new Error('ambiguous_reference:'+field);
 const value=choices.get(raw);
 if(value===undefined)throw new Error('unknown_reference:'+field);
 return value;
}
async function inputTx(tx:Tx,ctx:SessionContext,record:MovementImportRecord,employmentId:string,currentCompanyId:string){
 const source=await catalogTx(tx,ctx,currentCompanyId);
 const submitted=record.cells.kind??'';const code=lookup(submitted,source.types.map(type=>({value:type.code,label:type.label??type.code})),'event_type');
 const resolved=await resolveMovementEventTypeTx(tx,ctx.tenantId,code);
 if(!resolved?.active)throw new Error('unknown_or_inactive_event_type');
 const issues=movementImportCellIssues(record,resolved.behaviourKind);if(issues.length)throw new Error(issues.join('; '));
 const effectiveDate=record.importVersion===2&&resolved.behaviourKind==='blacklist'?todayInKualaLumpur():movementImportDate(record.cells.effectiveDate!)!;
 const [dates]=await tx.select({hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn,lastWorkingDate:employment.lastWorkingDate,resignationDate:employment.resignationDate}).from(employment).where(eq(employment.id,employmentId)).limit(1);
 if(!dates)throw new Error('employee_not_available');
 if(!['groupJoinDateCorrection','blacklist'].includes(resolved.behaviourKind)&&effectiveDate<dates.hiredOn)throw new Error('event_before_hire');
 const exit=[dates.terminatedOn,dates.lastWorkingDate,dates.resignationDate].filter((date):date is string=>!!date).sort()[0];
 if(exit&&effectiveDate>exit&&(isComparisonKind(resolved.behaviourKind)||['secondment','actingPosition'].includes(resolved.behaviourKind)))throw new Error('event_after_exit');
 if(resolved.behaviourKind==='blacklist'&&effectiveDate!==todayInKualaLumpur())throw new Error('blacklist_date_must_be_today');
 const targetCompanyId=record.cells.companyId?lookup(record.cells.companyId,source.companies,'companyId'):currentCompanyId;
 const catalog=targetCompanyId===currentCompanyId?source:await catalogTx(tx,ctx,targetCompanyId);
 const input:CreateMovementInput={employmentId,kind:resolved.code,effectiveDate};
 for(const [key,raw] of Object.entries(record.cells)){
  const field=key as MovementFormField;if(field==='kind'||field==='effectiveDate'||raw==null)continue;
  if(field==='companyId')input.companyId=targetCompanyId;
  else if(field==='departmentId'||field==='positionId'||field==='businessUnitId'||field==='locationId'||field==='gradeId'||field==='managerEmploymentId')input[field]=lookup(raw,(catalog.fields[field]??[]).map(option=>({...option,aliases:[...(option.aliases??[]),...(source.companies.find(c=>c.value===targetCompanyId)?[option.label,...option.codes??[],...option.aliases??[]].map(alias=>source.companies.find(c=>c.value===targetCompanyId)!.label+' · '+alias):[])]})),field);
  else if(field==='endDate'||field==='resignationDate'||field==='tenderResignationDate'||field==='resignationEffectiveDate')input[field]=movementImportDate(raw)!;
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
 return {input,source,catalog,behaviour:resolved.behaviourKind};
}
async function subjectTx(tx:Tx,ctx:SessionContext,companyId:string,code:string){
 const rows=await tx.select({id:employment.id,name:person.fullName}).from(employment).innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId))).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.companyId,companyId),eq(employment.employeeCode,code),sql`app.is_admin_for(${employment.companyId})`)).limit(2);
 if(rows.length!==1)throw new Error('employee_not_found_in_selected_company');
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
async function fingerprintTx(tx:Tx,ctx:SessionContext,id:string,companyId:string,inputHash:string,selection:number[],records:MovementImportRecord[],deadline:number,references:MovementManagerEvidence[]=[]){
 // Confirmation may exclude other complete employees from the original preview. Bind only this
 // employee's selection; inputHash still binds the entire file and the whole-sequence guard remains.
 const employeeSelection=records.filter(row=>selection.includes(row.row)).map(row=>row.row).sort((a,b)=>a-b);
 const employmentRows=await tx.select().from(employment).where(eq(employment.id,id));
 const emp=employmentRows.map(({isTestRecord:_classification,...facts})=>facts);
 const assignments=await tx.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id)).limit(MOVEMENT_IMPORT_LIMITS.historyRows+1);
 const salaries=await tx.select().from(compensation).where(eq(compensation.employmentId,id)).orderBy(asc(compensation.id)).limit(MOVEMENT_IMPORT_LIMITS.historyRows+1);
 const lines=await tx.select().from(reportingLine).where(or(eq(reportingLine.subordinateEmploymentId,id),eq(reportingLine.managerEmploymentId,id))).orderBy(asc(reportingLine.id)).limit(MOVEMENT_IMPORT_LIMITS.historyRows+1);
 const events=await tx.select({id:domainEvent.id,sequence:domainEvent.sequence,payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.subjectEmploymentId,id),ne(domainEvent.eventType,EMPLOYMENT_TEST_RECORD_EVENT))).orderBy(asc(domainEvent.sequence),asc(domainEvent.id)).limit(MOVEMENT_IMPORT_LIMITS.historyRows+1);
 if([assignments,salaries,lines,events].some(rows=>rows.length>MOVEMENT_IMPORT_LIMITS.historyRows))throw new Error('movement_history_too_large');
 const source=await catalogTx(tx,ctx,companyId);const destinations=new Set([companyId]);
 for(const record of records)if(record.cells.companyId){try{destinations.add(lookup(record.cells.companyId,source.companies,'companyId'));}catch{/* The row validator reports an invalid reference without discarding other rows. */}}
 const catalogs=[];for(const destination of [...destinations].sort()){budget(deadline);const catalogue=destination===companyId?source:await catalogTx(tx,ctx,destination);const stable={...catalogue,fields:{...catalogue.fields,managerEmploymentId:catalogue.fields.managerEmploymentId?.map(({isTestRecord:_classification,...facts})=>facts)}};catalogs.push([destination,digest(stable)]);}
 return digest({tenant:ctx.tenantId,user:ctx.userId??null,inputHash,selection:employeeSelection,emp,assignments,salaries,lines,events,catalogs,references,blacklistDay:records.some(row=>row.importVersion===2&&source.types.find(t=>t.code===row.cells.kind)?.behaviour==='blacklist')?todayInKualaLumpur():null});
}
function message(error:unknown){
 // Drizzle wraps driver errors; its outer message contains SQL and bound values even when only
 // cause carries the PostgreSQL code. Never put that text in a preview or downloadable row report.
 if(error instanceof Error&&error.message.startsWith('movement_sequence_'))return 'change_refused';
 if(!(error instanceof Error)||['code','query','params','cause'].some(key=>key in error)||error.name==='DrizzleQueryError')return 'change_refused';
 return error.message.slice(0,1000);
}
function rowView(record:MovementImportRecord):MovementImportRow{return {row:record.row,employeeCode:record.employeeCode,eventType:record.cells.kind??'',effectiveDate:movementImportDate(record.cells.effectiveDate??'')??record.cells.effectiveDate??'',status:'excluded',errors:[...record.errors],source:record.source,...(record.sourceRows?{sourceRows:record.sourceRows}:{}),...(record.companyCode!==undefined?{companyCode:record.companyCode}:{}),...(record.action?{action:record.action}:{}),...(record.movementId?{movementId:record.movementId}:{})};}
function selectionFor(records:MovementImportRecord[],selection?:number[]){
 if(selection===undefined)return records.map(row=>row.row);
 if(!Array.isArray(selection)||selection.length>MOVEMENT_IMPORT_LIMITS.rows||new Set(selection).size!==selection.length||selection.some(row=>!Number.isSafeInteger(row)||!records.some(record=>record.row===row)))throw new Error('invalid_selection');
 return [...selection].sort((a,b)=>a-b);
}
/** One group per employee OF ONE COMPANY. A legacy single-company record keeps the Employee ID as its key. */
export function movementRecordKey(record:Pick<MovementImportRecord,'employeeCode'|'companyCode'|'companyId'>){
 return record.companyCode===undefined?record.employeeCode:`${record.companyId??'?'+record.companyCode.trim().toUpperCase()}|${record.employeeCode}`;
}
function groupsFor(records:MovementImportRecord[]){const groups=new Map<string,MovementImportRecord[]>();for(const row of records){const key=movementRecordKey(row);groups.set(key,[...(groups.get(key)??[]),row]);}return groups;}
type ImportCompany={id:string;name:string;label:string|null;registration:string|null};
/** Companies the actor may import movements for: live, administered, Workforce view and maintain. */
export async function movementImportCompaniesTx(tx:Tx,ctx:SessionContext):Promise<ImportCompany[]>{
 return tx.select({id:company.id,name:company.legalName,label:company.companyLabel,registration:company.registrationNo}).from(company).where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.is_admin_for(${company.id}) and app.access_workforce_company(${company.id},'workforce.view') and app.access_workforce_company(${company.id},'workforce.maintain')`)).orderBy(asc(company.legalName),asc(company.id)).limit(MOVEMENT_IMPORT_LIMITS.referenceRows+1);
}
/** ac6645ec — Company ID per record, with the cost-allocation matcher (Company Code, registration number or
 * legal name; unknown, ambiguous and not-permitted companies refused). Returns copies; inputs stay intact. */
async function resolveRecordCompanies(ctx:SessionContext,records:MovementImportRecord[]){
 const names=new Map<string,string>();
 if(!records.some(r=>r.companyCode!==undefined))return{records,names};
 const companies=await withTenant(ctx,async tx=>{await limits(tx);return movementImportCompaniesTx(tx,ctx);});
 for(const c of companies)names.set(c.id,`${allocationCompanyCode(c)} · ${c.name}`);
 return{names,records:records.map(record=>{
  if(record.companyCode===undefined)return record;
  const matched=matchAllocationCompany(companies,record.companyCode);
  if('error' in matched)return{...record,companyId:undefined,errors:[...new Set([...record.errors,matched.error==='missing'?'company_required':matched.error==='ambiguous'?'company_ambiguous':'company_unknown'])]};
  return{...record,companyId:matched.company.id};
 })};
}
const pick=(values:Record<string,string|null>|undefined,keys:string[])=>Object.fromEntries(keys.map(key=>[key,values?.[key]??null]));
const CHECKED_REFERENCES=['companyId','departmentId','positionId','businessUnitId','locationId','gradeId','managerEmploymentId'];
const normal=(value:string|null|undefined)=>(value??'').trim().toLowerCase();
/** ac6645ec — Before is what the preparer saw. It must still be the as-of value immediately before this
 * movement (the current record, after any earlier movement of the same employee in the file). */
function checkBefore(record:MovementImportRecord,state:Record<string,string|null>,shown:Record<string,string|null>,catalog:MovementImportCatalog){
 for(const [field,expected]of Object.entries(record.before??{})){
  if(!(field in state)||!expected.trim())continue;
  const raw=state[field],display=shown[field];
  let same:boolean;
  if(raw==null)same=['-','—','none'].includes(normal(expected));
  else if(CHECKED_REFERENCES.includes(field)){
   const options=field==='companyId'?catalog.companies:catalog.fields[field as MovementFormField]??[];
   let resolved:string|undefined;try{resolved=lookup(expected,options,field);}catch{resolved=undefined;}
   same=resolved===raw||normal(expected)===normal(display)||(options.find(o=>o.value===raw)?.codes??[]).some(code=>normal(code)===normal(expected));
  }else if(field==='basicSalary'){const n=Number(expected.replace(/,/g,''));same=Number.isFinite(n)&&Math.round(n*100)===Math.round(Number(raw)*100);}
  else if(/Date$|hiredOn/.test(field))same=movementImportDate(expected)===raw;
  else{const options=catalog.fields[field as MovementFormField];const viaLabel=options?.find(o=>normal(o.label)===normal(expected))?.value;same=normal(expected)===normal(raw)||normal(expected)===normal(display)||viaLabel===raw;}
  if(!same)throw new Error('before_mismatch:'+field);
 }
}
function recordDay(row:MovementImportRecord){return row.importVersion===2&&row.cells.kind==='blacklist'?todayInKualaLumpur():movementImportDate(row.cells.effectiveDate??'')??'9999';}
function sortSequence(rows:MovementImportRecord[]){return [...rows].sort((a,b)=>recordDay(a).localeCompare(recordDay(b))||a.row-b.row);}
/** 646355e5 slice C — an Update or Delete row names an existing movement. */
const isCorrection=(row:MovementImportRecord)=>row.action==='update'||row.action==='delete';
/** One employee's order, identical in preview, commit and history: corrections first in sheet order (they act
 * on movements already recorded), then the new movements in effective-date order. */
function employeeOrder(rows:MovementImportRecord[]){return [...rows.filter(isCorrection).sort((a,b)=>a.row-b.row),...sortSequence(rows.filter(row=>!isCorrection(row)))];}
async function lifecycleTx(tx:Tx,id:string){
 const [row]=await tx.select({hiredOn:employment.hiredOn,joinDate:employment.joinDate,confirmationDate:employment.confirmationDate,extendedConfirmationDate:employment.extendedConfirmationDate,resignationDate:employment.resignationDate,tenderResignationDate:employment.tenderResignationDate,lastWorkingDate:employment.lastWorkingDate,terminatedOn:employment.terminatedOn,blacklistedAt:employment.blacklistedAt}).from(employment).where(eq(employment.id,id)).limit(1);return row??{};
}
type RehearsedRow={view:MovementImportRow;input:CreateMovementInput;changedFields:string[];references:MovementManagerEvidence[];rawAfter:Record<string,string|null>};
function readable(values:Record<string,string|null>,catalog:MovementImportCatalog):Record<string,string|null>{
 return Object.fromEntries(Object.entries(values).map(([key,value])=>{
  const options=key==='companyId'?catalog.companies:catalog.fields[key as MovementFormField];
  const found=options?.find(option=>option.value===value);
  // Equal configured labels must not hide a canonical reference change in Before/Proposed.
  const duplicateLabel=found&&options?.some(option=>option.value!==found.value&&option.label===found.label);
  const shown=found?(duplicateLabel?`${found.label} (${found.codes?.[0]??found.value})`:found.label):UUID.test(value??'')?null:value;
  return [key,shown];
 }));
}
function assertSequence(previous:RehearsedRow[],next:RehearsedRow){
 const sameDay=previous.filter(row=>row.input.effectiveDate===next.input.effectiveDate);
 if(sameDay.some(row=>digest(row.input)===digest(next.input)))throw new Error('duplicate_event_in_sequence');
 if(sameDay.some(row=>row.changedFields.some(field=>next.changedFields.includes(field))))throw new Error('same_date_conflicting_changes');
}
async function applyRowTx(tx:Tx,ctx:SessionContext,record:MovementImportRecord,id:string,rehearsal:boolean,resolvedInput?:CreateMovementInput,create?:MovementSequenceCreate,policy?:RehearsedRow):Promise<RehearsedRow>{
 const before={...await movementCurrentStateTx(tx,id),...await lifecycleTx(tx,id)};
 const prepared=resolvedInput?null:await inputTx(tx,ctx,record,id,before.companyId);
 const resolved=resolvedInput??prepared!.input;
 const behaviour=prepared?.behaviour??(await resolveMovementEventTypeTx(tx,ctx.tenantId,resolved.typeCode??resolved.kind))?.behaviourKind;
 const adapted=policy?{input:resolved,warnings:policy.view.warnings??[],references:policy.references,baselineDate:policy.view.baselineDate}:await movementImportRulesTx(tx,ctx,record,resolved,before,behaviour??'');
 if(policy){await recheckMovementManagerEvidenceTx(tx,ctx,policy.references);if(behaviour==='blacklist'&&resolved.effectiveDate!==todayInKualaLumpur())throw new Error('preview_stale_revalidate');}
 const input=adapted.input;
 const catalogBefore=prepared?.source??await catalogTx(tx,ctx,before.companyId);
 if(record.before&&Object.keys(record.before).length)checkBefore(record,before,readable(before,catalogBefore),catalogBefore);
 const catalogAfter=prepared?.catalog??(input.companyId&&input.companyId!==before.companyId?await catalogTx(tx,ctx,input.companyId):catalogBefore);
 const result=await (create?create(input):createMovementEventTx(tx,ctx,input)).catch(fieldRuleError);
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
 const view:MovementImportRow={...rowView(record),...(record.sourceRows?{sourceRows:record.sourceRows}:{}),...(record.companyCode!==undefined?{companyCode:record.companyCode}:{}),eventType:input.kind,effectiveDate:input.effectiveDate,status:'valid',errors:[],warnings:adapted.warnings,baselineDate:adapted.baselineDate,before:readable(before,catalogBefore),proposed:{...readable(after,catalogAfter),...extra},scheduled,payrollFlaggedPeriods:'payrollFlaggedPeriods' in result&&Array.isArray(result.payrollFlaggedPeriods)?result.payrollFlaggedPeriods:[]};
 return {view,input,changedFields,references:adapted.references,rawAfter:afterValues};
}
async function rehearseSequenceTx(tx:Tx,ctx:SessionContext,records:MovementImportRecord[],id:string,deadline:number){
 return rehearseMovementSequenceTx(tx,ctx,async(rehearsalTx,create)=>{
  const rows:RehearsedRow[]=[];
  for(const record of sortSequence(records)){budget(deadline);const next=await applyRowTx(rehearsalTx,ctx,record,id,true,undefined,create);assertSequence(rows,next);rows.push(next);budget(deadline);}
  return rows;
 });
}
/** 646355e5 slice C — one Update or Delete row as applied: the row view, plus what the attempt records for a
 * revert (the movement's recorded values before the correction, and the movement the Update left). */
type CorrectedRow={view:MovementImportRow;references:MovementManagerEvidence[];changedFields:string[];rawAfter:Record<string,string|null>;action:'update'|'delete';originalId:string;originalKind:string;originalDate:string;original:CreateMovementInput;replacementId:string|null;closedPayrollPeriods:string[]};
/** Correction refusals as finite row codes. The owner's own sentence travels as the detail. */
function correctionError(error:unknown):never{
 if(error instanceof MovementFieldRuleError)fieldRuleError(error);
 if(error instanceof MovementClosedPayrollAcknowledgementError)throw new Error('closed_payroll_acknowledgement_required:'+error.periods.join(', '));
 if(error instanceof MovementNoChangeError)throw new Error('movement_has_no_changes');
 if(error instanceof MovementNotCorrectableError||error instanceof MovementReasonRequiredError)throw new Error('movement_not_correctable:'+error.message);
 throw error;
}
/**
 * 646355e5 slice C — an Update or Delete row. The Movement Event ID resolves ONLY among this employee's own
 * movements (tenant, company and employee are already fixed by subjectTx); a movement is never matched by
 * employee plus date. Update overlays the filled cells on the movement's recorded values (a blank cell keeps
 * the value) and corrects it through editMovementEventTx, the manual Edit's own path. Delete is the import
 * rollback (reverseMovementForImportTx) with the row's reason. Closed payroll is entered only when the
 * import's confirmation box was ticked; preview passes true so the row can name the closed months.
 */
async function applyCorrectionTx(tx:Tx,ctx:SessionContext,record:MovementImportRecord,employmentId:string,companyId:string,acknowledgeClosedPayroll:boolean):Promise<CorrectedRow>{
 if(record.errors.length)throw new Error(record.errors.join('; '));
 const action=record.action as Exclude<MovementImportAction,'create'>,movementId=record.movementId??'',reason=record.reason?.trim()??'';
 if(!movementId)throw new Error('movement_id_required');if(!reason)throw new Error('reason_required');
 const base=await movementCorrectionBaseTx(tx,ctx,employmentId,movementId);
 if(!base){
  // Another employee's movement in the same company is named as such; anything else is simply unknown.
  const [other]=await tx.select({employmentId:domainEvent.subjectEmploymentId}).from(domainEvent).innerJoin(employment,and(eq(employment.id,domainEvent.subjectEmploymentId),eq(employment.tenantId,domainEvent.tenantId))).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.id,movementId),ne(domainEvent.subjectEmploymentId,employmentId),eq(employment.companyId,companyId),sql`app.is_admin_for(${employment.companyId})`)).limit(1);
  throw new Error(other?.employmentId&&await movementCorrectionBaseTx(tx,ctx,other.employmentId,movementId)?'movement_id_other_employee':'movement_id_unknown');
 }
 if(base.kind==='hired')throw new Error('movement_hire_not_supported');
 if(base.reversed)throw new Error('movement_already_rolled_back');
 if(base.status==='superseded')throw new Error('movement_superseded');
 const before={...await movementCurrentStateTx(tx,employmentId),...await lifecycleTx(tx,employmentId)};
 const catalog=await catalogTx(tx,ctx,before.companyId);
 const marker=await movementLedgerMarkerTx(tx,ctx,employmentId);
 let references:MovementManagerEvidence[]=[],kind=base.kind,effectiveDate=base.effectiveDate,behaviour=base.behaviour;
 try{
  if(action==='delete'){
   // Delete names the movement by id; a filled date or type is a check that it is the one HR meant.
   if(record.cells.effectiveDate&&movementImportDate(record.cells.effectiveDate)!==base.effectiveDate)throw new Error('event_mismatch:effectiveDate');
   if(record.cells.kind&&record.cells.kind!==base.kind)throw new Error('event_mismatch:kind');
   await reverseMovementForImportTx(tx,ctx,employmentId,movementId,reason,{acknowledgeClosedPayroll});
  }else{
   if(!base.input)throw new Error('movement_update_not_supported');
   const prepared=await inputTx(tx,ctx,{...record,cells:{...record.cells,kind:record.cells.kind??base.kind,effectiveDate:record.cells.effectiveDate??base.effectiveDate}},employmentId,before.companyId);
   const provided=Object.fromEntries(Object.entries(prepared.input).filter(([,value])=>value!==undefined)) as Partial<CreateMovementInput>;
   // Before, when filled, is the value the movement recorded (what the Employment History download shows).
   if(record.before&&Object.keys(record.before).length){
    const recorded=Object.fromEntries(Object.entries(base.input).filter(([field])=>!['employmentId','kind','effectiveDate','typeCode'].includes(field)).map(([field,value])=>[field,value==null?null:String(value)]));
    checkBefore(record,recorded,readable(recorded,catalog),catalog);
   }
   // Only a superior HR typed is admitted again (test-record and eligibility rules); a kept one is not re-judged.
   references=(await movementImportRulesTx(tx,ctx,{...record,importVersion:undefined},{...provided,employmentId} as CreateMovementInput,before,prepared.behaviour)).references;
   const merged={...base.input,...provided,employmentId,kind:provided.kind??base.kind,effectiveDate:provided.effectiveDate??base.effectiveDate} as CreateMovementInput;
   kind=merged.kind;effectiveDate=merged.effectiveDate;behaviour=prepared.behaviour;
   await editMovementEventTx(tx,ctx,{...merged,movementId,reason,acknowledgeClosedPayroll});
  }
 }catch(error){correctionError(error);}
 if(behaviour&&movementNeedsEntitlementReprojection(behaviour))await reprojectEntitlementForEmployment(ctx,{employmentId,trigger:'movement_recorded',gradeBefore:{gradeId:before.gradeId},...(action==='update'?{changeEffectiveOn:effectiveDate}:{})},tx);
 // The closed months the owner recorded on the reversal(s) this correction appended (replays included).
 const reversals=await tx.select({payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.subjectEmploymentId,employmentId),gt(domainEvent.sequence,marker),eq(domainEvent.eventType,'employment.movement.reversed')));
 const closedPayrollPeriods=[...new Set(reversals.flatMap(row=>{const periods=(row.payload as {closedPayrollPeriods?:unknown}|null)?.closedPayrollPeriods;return Array.isArray(periods)?periods.filter((period):period is string=>typeof period==='string'):[];}))].sort();
 let replacementId:string|null=null;
 if(action==='update'){
  // The corrected movement is the first one the correction recorded; replayed later movements follow it.
  const created=(await movementRowsAfterSequenceTx(tx,ctx,employmentId,marker)).map(row=>row.id);
  if(created.length){const [first]=await tx.select({id:domainEvent.id}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),inArray(domainEvent.id,created))).orderBy(asc(domainEvent.sequence)).limit(1);replacementId=first?.id??null;}
 }
 const after={...await movementCurrentStateTx(tx,employmentId),...await lifecycleTx(tx,employmentId)};
 const afterValues:Record<string,string|null>=after;
 const changedFields=Object.entries(before).filter(([field,value])=>afterValues[field]!==value).map(([field])=>field);
 const catalogAfter=after.companyId!==before.companyId?await catalogTx(tx,ctx,after.companyId):catalog;
 const view:MovementImportRow={...rowView(record),eventType:kind,effectiveDate,status:'valid',errors:[],before:readable(before,catalog),proposed:readable(after,catalogAfter),...(closedPayrollPeriods.length?{closedPayrollPeriods}:{})};
 return {view,references,changedFields,rawAfter:afterValues,action,originalId:movementId,originalKind:base.kind,originalDate:base.effectiveDate,original:base.input??base.recorded,replacementId,closedPayrollPeriods};
}
class PreviewRollback extends Error{constructor(readonly employee:MovementImportEmployee){super('movement_preview_rollback');}}
/** The employee a group of records names: its company (per record, or the legacy single company) and code. */
function employeeFor(key:string,records:MovementImportRecord[],fallbackCompanyId:string|undefined,names:Map<string,string>){
 const first=records[0],perRow=first.companyCode!==undefined,companyId=perRow?first.companyId:fallbackCompanyId;
 const employee:MovementImportEmployee={employeeCode:first.employeeCode,employmentId:null,name:null,rows:employeeOrder(records).map(rowView),fingerprint:null,...(perRow?{key,companyId:companyId??null,companyName:companyId?names.get(companyId)??null:null}:{})};
 return{employee,companyId};
}
export async function previewMovementImport(ctx:SessionContext,p:{companyId?:string;csv:string;selection?:number[];records?:MovementImportRecord[];sourceHash?:string;catalogueHash?:string}):Promise<MovementImportPreview>{
 assertAdmin(ctx);const parsed=p.records?{records:p.records,fileErrors:movementRecordLimits(p.records)}:parseMovementImport(p.csv);const selection=selectionFor(parsed.records,p.selection);const inputHash=digest({companyId:p.companyId,csv:p.csv,records:p.records,sourceHash:p.sourceHash});
 const result:MovementImportPreview={inputHash,selection,fileErrors:parsed.fileErrors,employees:[],excluded:0,valid:0};if(parsed.fileErrors.length)return result;
 const deadline=Date.now()+MOVEMENT_IMPORT_LIMITS.requestMs;
 const {records:resolved,names}=await resolveRecordCompanies(ctx,parsed.records);
 for(const [key,records] of groupsFor(resolved)){
  budget(deadline);const code=records[0].employeeCode,start=employeeFor(key,records,p.companyId,names),companyId=start.companyId;let employee=start.employee;
  if(!companyId){employee={...employee,rows:employee.rows.map(row=>selection.includes(row.row)?{...row,status:'invalid',errors:row.errors.length?row.errors:['company_not_available']}:row)};result.employees.push(employee);continue;}
  try{
   await withTenant(ctx,async tx=>{
    await limits(tx);await lockAccessConfigurationTx(tx,ctx.tenantId);
    const employeeDeadline=Math.min(deadline,Date.now()+MOVEMENT_IMPORT_LIMITS.employeeMs);await lockMovementImportReferenceAdmissionTx(tx,ctx.tenantId);await lockMovementTypeCatalogueTx(tx,ctx.tenantId);await assertCompany(tx,ctx,companyId);if(p.catalogueHash&&digest({version:2,types:(await catalogTx(tx,ctx,companyId)).types})!==p.catalogueHash)throw new Error('workbook_catalogue_changed');
    const subject=await subjectTx(tx,ctx,companyId,code);employee={...employee,employmentId:subject.id,name:subject.name,fingerprint:await fingerprintTx(tx,ctx,subject.id,companyId,inputHash,selection,records,employeeDeadline)};
    const baseFingerprint=employee.fingerprint;const rows:MovementImportRow[]=[];const previous:RehearsedRow[]=[];const corrected:CorrectedRow[]=[];
    for(const record of employeeOrder(records)){
     budget(employeeDeadline);
     if(!selection.includes(record.row)){rows.push(rowView(record));continue;}
     if(isCorrection(record)){
      try{const next=await tx.transaction(rowTx=>applyCorrectionTx(rowTx,ctx,record,subject.id,companyId,true));corrected.push(next);rows.push(next.view);}
      catch(error){rows.push({...rowView(record),status:'invalid',errors:[message(error)]});}
      budget(employeeDeadline);continue;
     }
     try{const next=await tx.transaction(async rowTx=>{const value=await applyRowTx(rowTx,ctx,record,subject.id,true);assertSequence(previous,value);return value;});previous.push(next);rows.push(next.view);}
     catch(error){rows.push({...rowView(record),status:'invalid',errors:[message(error)]});}
     budget(employeeDeadline);
    }
    const invalid=rows.some(row=>row.status==='invalid');
    if(invalid)for(const row of rows)if(row.status==='valid'){row.status='invalid';row.errors.push('employee_sequence_invalid');}
    const references=[...corrected.flatMap(row=>row.references),...previous.flatMap(row=>row.references)];
    employee={...employee,fingerprint:invalid?null:digest({base:baseFingerprint,references})};
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
/** ac6645ec — with `attemptId`, every movement an employee's transaction creates is recorded as an import
 * history item (its movement id, the values before and after) in that SAME transaction. */
export type MovementCommitHistory={attemptId:string};
/** 646355e5 slice C — `acknowledgeClosedPayroll` is the import's confirmation box. Without it, an Update or
 * Delete row behind closed payroll fails its employee with the closed-payroll message. */
export async function commitMovementImport(ctx:SessionContext,p:{companyId?:string;csv:string;selection:number[];inputHash:string;fingerprints:Record<string,string>;acknowledgeExcluded:boolean;records?:MovementImportRecord[];sourceHash?:string;catalogueHash?:string;history?:MovementCommitHistory;acknowledgeClosedPayroll?:boolean}):Promise<MovementImportResult>{
 assertAdmin(ctx);const parsed=p.records?{records:p.records,fileErrors:movementRecordLimits(p.records)}:parseMovementImport(p.csv);if(parsed.fileErrors.length)throw new Error(parsed.fileErrors.join('; '));const selection=selectionFor(parsed.records,p.selection);
 if(!selection.length)throw new Error('select_valid_rows');const inputHash=digest({companyId:p.companyId,csv:p.csv,records:p.records,sourceHash:p.sourceHash});if(inputHash!==p.inputHash)throw new Error('preview_changed');
 if(selection.length!==parsed.records.length&&p.acknowledgeExcluded!==true)throw new Error('confirm_excluded_rows');
 const {records:resolved,names}=await resolveRecordCompanies(ctx,parsed.records);
 for(const records of groupsFor(resolved).values()){const picked=records.filter(r=>selection.includes(r.row)).length;if(picked&&picked!==records.length)throw new Error('whole_employee_selection_required');}
 const result:MovementImportResult={employees:[],imported:0,failed:0,excluded:parsed.records.length-selection.length,byEventType:[],batchId:p.history?.attemptId??randomUUID(),...(p.history?{attemptId:p.history.attemptId}:{})};const deadline=Date.now()+MOVEMENT_IMPORT_LIMITS.requestMs;
 for(const [key,records] of groupsFor(resolved)){
  const code=records[0].employeeCode,start=employeeFor(key,records,p.companyId,names),companyId=start.companyId;
  const chosen=sortSequence(records.filter(row=>selection.includes(row.row)));if(!chosen.length){result.employees.push({...start.employee,rows:records.map(rowView)});continue;}
  let employee:MovementImportEmployee=start.employee;
  try{
   budget(deadline);if(!companyId)throw new Error('company_not_available');
   employee=await withTenant(ctx,async tx=>{
    await limits(tx);await lockAccessConfigurationTx(tx,ctx.tenantId);
    const employeeDeadline=Math.min(deadline,Date.now()+MOVEMENT_IMPORT_LIMITS.employeeMs);await lockMovementImportReferenceAdmissionTx(tx,ctx.tenantId);await lockMovementTypeCatalogueTx(tx,ctx.tenantId);await assertCompany(tx,ctx,companyId);const catalog=await catalogTx(tx,ctx,companyId);if(p.catalogueHash&&digest({version:2,types:catalog.types})!==p.catalogueHash)throw new Error('workbook_catalogue_changed');const subject=await subjectTx(tx,ctx,companyId,code);
    employee={...employee,employmentId:subject.id,name:subject.name};
    const fingerprint=await fingerprintTx(tx,ctx,subject.id,companyId,inputHash,selection,records,employeeDeadline);
    // Corrections act on recorded movements first, under the same lock order the create rehearsal takes.
    const corrections=employeeOrder(records).filter(isCorrection),corrected:CorrectedRow[]=[];
    if(corrections.length){
     await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
     for(const record of corrections){budget(employeeDeadline);corrected.push(await applyCorrectionTx(tx,ctx,record,subject.id,companyId,p.acknowledgeClosedPayroll===true));}
    }
    const settled=corrected.length?await fingerprintTx(tx,ctx,subject.id,companyId,inputHash,selection,records,employeeDeadline):fingerprint;
    const creates=records.filter(row=>!isCorrection(row));
    const rehearsed=await rehearseSequenceTx(tx,ctx,creates,subject.id,employeeDeadline);
    const combined=digest({base:fingerprint,references:[...corrected.flatMap(row=>row.references),...rehearsed.value.flatMap(row=>row.references)]});
    if(!p.fingerprints||p.fingerprints[key]!==combined)throw new Error('preview_stale_revalidate');
    if(await fingerprintTx(tx,ctx,subject.id,companyId,inputHash,selection,records,employeeDeadline)!==settled)throw new Error('preview_stale_revalidate');
    const rows:MovementImportRow[]=corrected.map(row=>({...row.view,status:'imported'})),applied:{record:MovementImportRecord;plan:RehearsedRow;row:RehearsedRow;movementIds:string[]}[]=[];
    for(const record of sortSequence(creates)){
     if(!selection.includes(record.row)){rows.push(rowView(record));continue;}
     budget(employeeDeadline);const plan=rehearsed.value.find(row=>row.view.row===record.row);if(!plan)throw new Error('movement_sequence_changed');
     const marker=p.history?await movementLedgerMarkerTx(tx,ctx,subject.id):0;
     const row=await applyRowTx(tx,ctx,record,subject.id,false,plan.input,rehearsed.replay,plan);rows.push({...plan.view,status:'imported',scheduled:row.view.scheduled,payrollFlaggedPeriods:row.view.payrollFlaggedPeriods});budget(employeeDeadline);
     if(p.history)applied.push({record,plan,row,movementIds:(await movementRowsAfterSequenceTx(tx,ctx,subject.id,marker)).map(created=>created.id)});
    }
    if(p.history){
     const labels=new Map(catalog.types.map(type=>[type.code,type.label??type.code])),label=(code:string)=>labels.get(code)??code;
     // 646355e5 slice C — each Update or Delete is one item: the movement's values before and after, the
     // recorded input a revert re-applies (Update) or re-records (Delete), and the movement the Update left.
     for(const [sequence,row]of corrected.entries()){
      const record=corrections[sequence];
      const shown=[...new Set([...Object.keys(row.view.before??{}),...Object.keys(row.view.proposed??{})])].filter(field=>field!=='companyName'&&row.view.before?.[field]!==row.view.proposed?.[field]);
      const common={employeeCode:code,sourceRows:record.sourceRows??[record.source?.row??record.row],action:row.action,reason:record.reason?.trim()??'',originalMovementId:row.originalId};
      await recordImportItemTx(tx,ctx,{attemptId:p.history.attemptId,companyId,employmentId:subject.id,itemKey:`${record.row}|${row.action}|${row.originalId}`,label:`${code} · ${subject.name} · ${label(row.originalKind)} · ${row.originalDate}`,ordinal:record.row,status:'applied',
       before:{...common,eventType:row.originalKind,eventLabel:label(row.originalKind),effectiveDate:row.originalDate,movementId:row.originalId,values:pick(row.view.before,shown),original:{...row.original}} satisfies MovementImportItemState,
       after:{...common,eventType:row.view.eventType,eventLabel:label(row.view.eventType),effectiveDate:row.view.effectiveDate,movementId:row.action==='update'?row.replacementId:null,sequence,values:pick(row.view.proposed,shown),raw:pick(row.rawAfter,row.changedFields),...(row.closedPayrollPeriods.length?{closedPayrollPeriods:row.closedPayrollPeriods}:{})} satisfies MovementImportItemState});
     }
     for(const [index,{record,plan,row,movementIds}]of applied.entries()){const sequence=corrected.length+index;
      const shown=[...new Set([...Object.keys(plan.view.before??{}),...Object.keys(plan.view.proposed??{})])].filter(field=>field!=='companyName'&&plan.view.before?.[field]!==plan.view.proposed?.[field]);
      const base={employeeCode:code,eventType:plan.input.kind,eventLabel:labels.get(plan.input.kind)??plan.input.kind,effectiveDate:plan.input.effectiveDate,sourceRows:record.sourceRows??[record.source?.row??record.row]};
      for(const movementId of movementIds.length?movementIds:[null])await recordImportItemTx(tx,ctx,{attemptId:p.history.attemptId,companyId,employmentId:subject.id,itemKey:`${record.row}|${movementId??'none'}`,label:`${code} · ${subject.name} · ${base.eventLabel} · ${base.effectiveDate}`,ordinal:record.row,status:'applied',
       before:{...base,movementId,values:pick(plan.view.before,shown)} satisfies MovementImportItemState,
       after:{...base,movementId,sequence,scheduled:row.view.scheduled===true,values:pick(plan.view.proposed,shown),raw:pick(row.rawAfter,row.changedFields)} satisfies MovementImportItemState});
     }
    }
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'movement-import',aggregateId:result.batchId!,eventType:'movement-import.employee.applied',actor:actorOf(ctx),subjectEmploymentId:subject.id,payload:{companyId,eventCount:chosen.length,sourceRows:chosen.map(row=>({key:row.row,sheet:row.source?.sheet??'CSV',row:row.source?.row??row.row})),eventTypes:[...new Set(chosen.map(row=>row.cells.kind).filter(Boolean))],
     ...(corrected.length?{corrections:corrected.map(row=>({action:row.action,movementId:row.originalId,closedPayrollPeriods:row.closedPayrollPeriods})),closedPayrollAcknowledged:p.acknowledgeClosedPayroll===true}:{})}});
    return {...employee,employmentId:subject.id,name:subject.name,rows,fingerprint:combined};
   });
   result.imported+=chosen.length;
  }catch(error){employee={...employee,rows:employee.rows.map(row=>selection.includes(row.row)?{...row,status:'failed',errors:[message(error)]}:row)};result.failed+=chosen.length;}
  result.employees.push(employee);
 }
 const counts=new Map<string,{eventType:string;imported:number;failed:number;excluded:number}>();
 for(const employee of result.employees)for(const row of employee.rows){const count=counts.get(row.eventType)??{eventType:row.eventType,imported:0,failed:0,excluded:0};row.status==='imported'?count.imported++:row.status==='failed'?count.failed++:count.excluded++;counts.set(row.eventType,count);}
 result.byEventType=[...counts.values()].sort((a,b)=>a.eventType.localeCompare(b.eventType));return result;
}
/** What an applied movement item stores (before/after). `raw` holds the state values the movement left for
 * the fields it changed; a revert is blocked while any of them has since been changed again. */
export type MovementImportItemState={employeeCode:string;eventType:string;eventLabel:string;effectiveDate:string;sourceRows:number[];movementId:string|null;values:Record<string,string|null>;sequence?:number;scheduled?:boolean;raw?:Record<string,string|null>;
 /** 646355e5 slice C — present on Update and Delete items only. `movementId` is then the original movement
  * (before) and the movement the Update left (after; null for a Delete). `original` is the recorded input. */
 action?:'update'|'delete';reason?:string;originalMovementId?:string;original?:Record<string,unknown>;closedPayrollPeriods?:string[]};
/** Raw current state for the revert check (the same projection the import compares and writes through). */
export async function movementImportStateTx(tx:Tx,employmentId:string):Promise<Record<string,string|null>>{return{...await movementCurrentStateTx(tx,employmentId),...await lifecycleTx(tx,employmentId)};}

/** ac6645ec — one template for every company the actor may import movements for: the tenant's active types,
 * each company's Company ID (Company Code, else registration number) and its allowed values. */
export async function movementImportTemplateData(ctx:SessionContext){
 assertAdmin(ctx);return withTenant(ctx,async tx=>{
  await limits(tx);await lockAccessConfigurationTx(tx,ctx.tenantId);
  const types=(await activeMovementEventTypeChoicesTx(tx,ctx.tenantId)).map(importType);
  const companies=[];
  for(const c of await movementImportCompaniesTx(tx,ctx))companies.push({companyId:c.id,code:allocationCompanyCode(c),name:c.name,catalog:await catalogTx(tx,ctx,c.id)});
  return{types,companies};
 });
}
/** The tenant's active movement types (the catalogue a template is signed to). */
export async function movementImportTypes(ctx:SessionContext){
 assertAdmin(ctx);return withTenant(ctx,async tx=>{await limits(tx);return (await activeMovementEventTypeChoicesTx(tx,ctx.tenantId)).map(importType);});
}
export type MovementImportFilters={departmentIds?:string[];businessUnitIds?:string[];gradeIds?:string[];locationIds?:string[];probationOnly?:boolean};
/** Server-only download projection. Internal identities never leave this owner in workbook metadata. */
export async function movementImportDownloadData(ctx:SessionContext,p:{companyId:string;typeCode?:string;filters?:MovementImportFilters}){
 assertAdmin(ctx);return withTenant(ctx,async tx=>{
  await limits(tx);await lockAccessConfigurationTx(tx,ctx.tenantId);
  const catalog=await catalogTx(tx,ctx,p.companyId);
  const [selectedCompany]=await tx.select({name:company.legalName}).from(company).where(and(eq(company.id,p.companyId),isNull(company.archivedAt))).limit(1);
  if(!selectedCompany)throw new Error('company_not_available');
  const type=p.typeCode?catalog.types.find(t=>t.code===p.typeCode):undefined;
  if(p.typeCode&&!type)throw new Error('unknown_or_inactive_event_type');
  const destinationCatalogs:Record<string,MovementImportCatalog>={};
  if((type?[type]:catalog.types).some(t=>t.behaviour==='entityTransfer'))for(const destination of catalog.companies)destinationCatalogs[destination.value]=destination.value===p.companyId?catalog:await catalogTx(tx,ctx,destination.value);
  if(!type)return {catalog,companyName:selectedCompany.name,subjects:[],destinationCatalogs};
  const filters=p.filters??{};
  const rules=[['departmentIds','departmentId'],['businessUnitIds','businessUnitId'],['gradeIds','gradeId'],['locationIds','locationId']] as const;
  for(const [key,field]of rules){const values=filters[key];if(values&&(!Array.isArray(values)||values.length>100||values.some(v=>typeof v!=='string'||!catalog.fields[field]?.some(o=>o.value===v))))throw new Error('invalid_filter');}
  if(filters.probationOnly&&!['confirmation','probationExtension'].includes(type.behaviour))throw new Error('invalid_filter');
  const today=todayInKualaLumpur();
  const candidates=await tx.select({emp:employment,name:person.fullName}).from(employment).innerJoin(person,eq(person.id,employment.personId)).leftJoin(assignment,and(eq(assignment.employmentId,employment.id),isNull(assignment.validTo),isNull(assignment.supersededAt))).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.companyId,p.companyId),lte(employment.hiredOn,today),isNull(employment.blacklistedAt),sql`app.is_admin_for(${employment.companyId})`,filters.departmentIds?.length?inArray(assignment.departmentId,filters.departmentIds):undefined,filters.businessUnitIds?.length?inArray(assignment.businessUnitId,filters.businessUnitIds):undefined,filters.gradeIds?.length?inArray(employment.gradeId,filters.gradeIds):undefined,filters.locationIds?.length?inArray(assignment.locationId,filters.locationIds):undefined)).orderBy(asc(employment.employeeCode),asc(employment.id)).limit(MOVEMENT_IMPORT_LIMITS.referenceRows+1);
  if(candidates.length>MOVEMENT_IMPORT_LIMITS.referenceRows)throw new Error('movement_reference_catalog_too_large');
  const employed=candidates.filter(({emp})=>{const status=deriveEmploymentStatus({...emp,finalConfirmationDate:emp.extendedConfirmationDate??emp.confirmationDate},today);return !['resigned','blacklisted'].includes(status)&&(!filters.probationOnly||status==='probation');});
  if(employed.length>MOVEMENT_IMPORT_LIMITS.employees)throw new Error('too_many_employees');
  const subjects=[];for(const {emp,name}of employed){const current=await movementCurrentStateTx(tx,emp.id);const values={...current,joinDate:emp.joinDate,hiredOn:emp.hiredOn,probationEndDate:emp.extendedConfirmationDate??emp.confirmationDate??emp.probationEndDate??emp.provisionalEndOn,blacklistedAt:emp.blacklistedAt};const descendants=await tx.execute<{id:string}>(sql`with recursive downline(id) as (select subordinate_employment_id from reporting_line where tenant_id=${ctx.tenantId} and manager_employment_id=${emp.id} and line_type='administrative' and superseded_at is null and valid_from<=${today} and (valid_to is null or valid_to>${today}) union select l.subordinate_employment_id from reporting_line l join downline d on l.manager_employment_id=d.id where l.tenant_id=${ctx.tenantId} and l.line_type='administrative' and l.superseded_at is null and l.valid_from<=${today} and (l.valid_to is null or l.valid_to>${today})) select id from downline limit ${MOVEMENT_IMPORT_LIMITS.referenceRows+1}`);
   if(descendants.length>MOVEMENT_IMPORT_LIMITS.referenceRows)throw new Error('movement_reference_catalog_too_large');
   subjects.push({employeeCode:emp.employeeCode??'',name,current:readable(values,catalog),managerExclusions:[emp.id,...descendants.map(row=>row.id)]});}
  return {catalog,companyName:selectedCompany.name,subjects,destinationCatalogs};
 });
}
