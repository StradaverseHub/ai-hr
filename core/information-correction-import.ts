import {organisationImportWarningsTx} from './derived-organisation-display';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {employment,company} from '../db/schema';
import {workforceEmploymentPredicate} from './workforce-access';
import {allocationCompanyCode} from './cost-allocation-import';
import {informationCorrectionOptions,previewInformationCorrection,correctInformationTx,informationChangesUseOwners,InformationCorrectionError} from './information-correction';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {createImportAttemptTx,lockImportAttemptTx,importAttemptEventsTx,importAttemptItemsTx,recordImportItemTx,recordImportEventTx,sealImportPlan,ImportHistoryError,type ImportAttemptDetail} from './import-history';
import {parseInformationWorkbookVersioned} from '../lib/information-correction-workbook';
import {INFORMATION_FIELD_CAPTIONS,INFORMATION_LABEL_FIELDS,type InformationChanges,type InformationField,type InformationHeader,type InformationImportPlan,type InformationImportResult,type InformationLogRow} from '../lib/information-correction';
import {publicErrorMessage} from '../lib/public-error';
import {pgSqlState} from '../lib/db-error';
export async function previewInformationUpload(ctx:SessionContext,input:{name:string;content:Buffer;operationKey:string}){
 if(!input.name.toLowerCase().endsWith('.xlsx'))throw new InformationCorrectionError('Choose the .xlsx Information-Only Correction template.');
 const {version,rows}=parseInformationWorkbookVersioned(input.content),options=await informationCorrectionOptions(ctx);
 const companyIds=new Set<string>(),targets=new Map<string,number[]>();
 for(const row of rows){
  const companies=options.companies.filter(c=>c.code.toUpperCase()===row.companyCode.toUpperCase());
  if(companies.length!==1){row.errors.push('Company Code is unknown, ambiguous or outside your permission.');continue;}
  const co=companies[0];companyIds.add(co.id);
  if(row.errors.length)continue;
  try{
   const matches=await withTenant(ctx,tx=>tx.select({id:employment.id}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.companyId,co.id),eq(employment.employeeCode,row.employeeCode))).limit(2));
   if(matches.length!==1)throw new InformationCorrectionError('Employee ID is unknown or ambiguous within the existing company.');
   targets.set(matches[0].id,[...(targets.get(matches[0].id)??[]),row.row]);
   const changes:InformationChanges={};
   if(row.values['New Company Code']){const dest=options.companies.filter(c=>c.code.toUpperCase()===row.values['New Company Code']!.toUpperCase());if(dest.length!==1)throw new InformationCorrectionError('New Company Code is unknown, ambiguous or outside your permission.');changes.companyId=dest[0].id;companyIds.add(dest[0].id);}
   if(row.values['Job Grade']){const grades=options.grades.filter(g=>g.code===row.values['Job Grade']);if(grades.length!==1)throw new InformationCorrectionError('Job Grade is not an active system code.');changes.gradeId=grades[0].id;}
   if(row.values['Group Join Date'])changes.hiredOn=row.values['Group Join Date'];
   if(row.values['Join Date'])changes.joinDate=row.values['Join Date'];
   if(row.values['Employment Type'])changes.employmentType=row.values['Employment Type'];
   if(row.values['Contract End Date'])changes.contractEndDate=row.values['Contract End Date'];
   if(row.values['Internship End Date'])changes.internshipEndDate=row.values['Internship End Date'];
   if(version===2)await extendedChanges(ctx,options,row.values,changes.companyId??co.id,changes);
   row.preview=await previewInformationCorrection(ctx,{employmentId:matches[0].id,changes,reason:row.values['Correction Reason']!},{extended:true});
   row.warnings=(await withTenant(ctx,tx=>organisationImportWarningsTx(tx,ctx,{companyId:row.preview!.after.companyId!,asOf:row.preview!.effectiveOn,...row.ignoredOrganisation}))).warnings;
  }catch(error){row.errors.push(error instanceof InformationCorrectionError?error.message:publicErrorMessage(error));}
 }
 for(const target of targets.values())if(target.length>1)for(const row of rows)if(target.includes(row.row))row.errors.push('Multiple rows resolve to the same employee.');
 const valid=rows.filter(r=>!r.errors.length&&r.preview?.changed.length).length;
 const plan=sealImportPlan<InformationImportPlan>({version:1,templateVersion:version,previewHash:'',counts:{total:rows.length,valid,invalid:rows.filter(r=>r.errors.length).length},issues:[],rows});
 let created;
 try{created=await withTenant(ctx,tx=>createImportAttemptTx(tx,ctx,{kind:'information_correction',sourceName:input.name,content:input.content,companyIds:[...companyIds],plan,operationKey:input.operationKey}));}
 catch(error){const safe=publicErrorMessage({name:'PostgresError',code:pgSqlState(error),message:'Information correction upload could not be recorded.'});throw new InformationCorrectionError(safe);}
 // An operation-key retry returns the stored plan, never a fresh preview with the old attempt ID.
 return {attemptId:created.attemptId,plan:created.plan};
}
export async function confirmInformationUpload(ctx:SessionContext,input:{attemptId:string;previewHash:string}):Promise<InformationImportResult>{
 const load=()=>withTenant(ctx,async tx=>{
  const attempt=await lockImportAttemptTx(tx,ctx,input.attemptId,'information_correction');
  const [access]=await tx.execute<{ok:boolean}>(sql`select app.import_attempt_access(${attempt.id}::uuid,'maintain',true) as ok`);
  if(!access?.ok||attempt.createdBy!==ctx.userId)throw new ImportHistoryError('Your permission for this import changed. Upload the file again.');
  const plan=attempt.plan as unknown as InformationImportPlan;
  if(plan.previewHash!==input.previewHash)throw new ImportHistoryError('The reviewed import changed. Upload the file again.');
  return {attempt,plan};
 });
 const {attempt,plan}=await load();
 const results:InformationImportResult['rows']=[];
 for(const row of plan.rows){
  if(row.errors.length||!row.preview){results.push({row:row.row,status:'failed',errors:row.errors});continue;}
  if(!row.preview.changed.length){results.push({row:row.row,status:'unchanged',errors:[]});continue;}
  const preview=row.preview;
  try{
   const ownerChanges=Object.fromEntries(preview.changed.map(f=>[f,preview.after[f]])) as InformationChanges;
   await withTenant(ctx,async tx=>{
    // Owner configuration locks before the attempt row, the same order as every other owner-writing import.
    if(informationChangesUseOwners(ownerChanges)){await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);}
    const held=await lockImportAttemptTx(tx,ctx,input.attemptId,'information_correction');
    const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.import_attempt_access(${held.id}::uuid,'maintain',true) as ok`);
    if(!allowed?.ok||held.createdBy!==ctx.userId)throw new ImportHistoryError('Your permission for this import changed.');
    const prior=(await importAttemptItemsTx(tx,held.id)).find(item=>item.itemKey===String(row.row));
    if(prior){if(prior.status==='failed')throw new ImportHistoryError(prior.errors.join(' '));return;}
    const changes=Object.fromEntries(preview.changed.map(f=>[f,preview.after[f]])) as InformationChanges;
    const saved=await correctInformationTx(tx,ctx,{employmentId:preview.employmentId,changes,reason:preview.reason,fingerprint:preview.fingerprint,method:'excel',batchId:held.id,filename:held.sourceName});
    if(!saved.changed)throw new ImportHistoryError('The employee no longer needs this correction. Review again.');
    await recordImportItemTx(tx,ctx,{attemptId:held.id,companyId:preview.before.companyId!,employmentId:preview.employmentId,itemKey:String(row.row),label:preview.employeeCode+' · '+preview.name,ordinal:row.row,status:'applied',before:{values:changedLabels(preview.beforeLabels,preview.changed),reason:preview.reason},after:{values:changedLabels(preview.afterLabels,preview.changed),reason:preview.reason,organisationWarnings:row.warnings??[]}});
   });
   results.push({row:row.row,status:'applied',errors:[]});
  }catch(error){
   const message=publicErrorMessage(error);results.push({row:row.row,status:'failed',errors:[message]});
   await withTenant(ctx,async tx=>{await lockImportAttemptTx(tx,ctx,attempt.id,'information_correction');const prior=(await importAttemptItemsTx(tx,attempt.id)).find(item=>item.itemKey===String(row.row));if(!prior)await recordImportItemTx(tx,ctx,{attemptId:attempt.id,companyId:preview.before.companyId!,employmentId:preview.employmentId,itemKey:String(row.row),label:preview.employeeCode,ordinal:row.row,status:'failed',errors:[message]});});
  }
 }
 const result:InformationImportResult={attemptId:attempt.id,succeeded:results.filter(r=>r.status==='applied').length,failed:results.filter(r=>r.status==='failed').length,unchanged:results.filter(r=>r.status==='unchanged').length,rows:results};
 await withTenant(ctx,async tx=>{await lockImportAttemptTx(tx,ctx,attempt.id,'information_correction');const events=await importAttemptEventsTx(tx,attempt.id);if(!events.some(e=>e.kind==='confirmed'))await recordImportEventTx(tx,ctx,{attemptId:attempt.id,kind:'confirmed',importKind:'information_correction',detail:{succeeded:result.succeeded,failed:result.failed,unchanged:result.unchanged,rows:result.rows}});});
 return result;
}

/** The values an item records: the changed fields only, so a 26-field preimage does not crowd the log. */
function changedLabels(values:Record<string,string|null>,changed:readonly string[]){return Object.fromEntries(changed.map(field=>[field,values[field]??null]));}
const ORGANISATION_COLUMNS=[['Business Unit','business_unit','businessUnitId','Business Units'],['Department','department','departmentId','Departments'],['Position','position','positionId','Positions']] as const;
const LABEL_COLUMNS=INFORMATION_LABEL_FIELDS.map(field=>[INFORMATION_FIELD_CAPTIONS[field],field] as const);
const PLAIN_COLUMNS=(['probationValue','probationUnit','extendedProbationValue','extendedProbationUnit','confirmationDate','noticeBeforeConfirmationValue','noticeBeforeConfirmationUnit','noticeAfterConfirmationValue','noticeAfterConfirmationUnit'] as const).map(field=>[INFORMATION_FIELD_CAPTIONS[field],field] as const);
/** ccd3a65c — version 2 cells resolved against the resulting company's options. Labels, periods and dates are
 * passed as typed; the correction command validates them and names the column. */
async function extendedChanges(ctx:SessionContext,options:Awaited<ReturnType<typeof informationCorrectionOptions>>,values:Partial<Record<InformationHeader,string>>,companyId:string,changes:InformationChanges){
 for(const [header,kind,field,sheet] of ORGANISATION_COLUMNS){
  const value=values[header];if(!value)continue;
  const found=options.organisation.filter(row=>row.companyId===companyId&&row.kind===kind&&row.code.toUpperCase()===value.toUpperCase());
  if(found.length!==1)throw new InformationCorrectionError(`${header}: "${value}" is not an option for this company. Check the ${sheet} reference sheet.`);
  changes[field]=found[0].id;
 }
 for(const [header,field] of [...LABEL_COLUMNS,...PLAIN_COLUMNS]){const value=values[header];if(value)changes[field]=value;}
 const superior=values['Direct Superior'];
 if(superior){
  // View-scoped: a superior the user cannot view reads exactly like an unknown Employee ID.
  const managers=await withTenant(ctx,tx=>tx.select({id:employment.id}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.companyId,companyId),eq(employment.employeeCode,superior),workforceEmploymentPredicate(sql`${employment.id}`,'view'))).limit(2));
  if(managers.length!==1)throw new InformationCorrectionError('Direct Superior: the Employee ID is unknown in this company or not visible to you.');
  changes.managerEmploymentId=managers[0].id;
 }
}
type ConfirmedRow={row:number;status:'applied'|'failed'|'unchanged';errors:string[]};
/**
 * ccd3a65c — the Import Log of an Information-Only Correction file: every row of the file, saved or not.
 * Rows refused at the check never became items, so they come from the sealed plan. A row is shown only when
 * the viewer can view its company (or is the person who uploaded the file and saw it at the check).
 */
export async function informationImportLog(ctx:SessionContext,item:ImportAttemptDetail):Promise<InformationLogRow[]>{
 if(item.kind!=='information_correction')return[];
 const plan=item.plan as unknown as InformationImportPlan;
 const viewable=await withTenant(ctx,tx=>tx.select({id:company.id,label:company.companyLabel,registration:company.registrationNo,name:company.legalName}).from(company).where(and(eq(company.tenantId,ctx.tenantId),sql`app.access_workforce_company(${company.id},'workforce.view')`)));
 const ids=new Set(viewable.map(c=>c.id)),codes=new Set(viewable.map(c=>allocationCompanyCode(c).toUpperCase()));
 const own=!!ctx.userId&&item.createdBy===ctx.userId;
 const confirmed=item.events.find(event=>event.kind==='confirmed'),outcome=new Map<number,ConfirmedRow>();
 for(const row of (Array.isArray(confirmed?.detail.rows)?confirmed!.detail.rows as ConfirmedRow[]:[]))outcome.set(row.row,row);
 return (plan.rows??[]).filter(row=>own||(row.preview?ids.has(row.preview.before.companyId!)&&ids.has(row.preview.after.companyId!):codes.has(row.companyCode.toUpperCase()))).map(row=>{
  const result=outcome.get(row.row),preview=row.preview;
  const changes=(preview?.changed??[]).map(field=>({field:field as InformationField,before:preview!.beforeLabels[field as InformationField]??null,after:preview!.afterLabels[field as InformationField]??null}));
  const status:InformationLogRow['result']=result?(result.status==='applied'?'saved':result.status==='unchanged'?'unchanged':'not_saved'):row.errors.length?'not_saved':preview&&!preview.changed.length?'unchanged':'not_confirmed';
  return {row:row.row,employeeCode:row.employeeCode,name:preview?.name??(row.values['Employee Name']||null),result:status,changes,reason:preview?.reason??row.values['Correction Reason']??null,errors:result?.errors.length?result.errors:row.errors};
 });
}
