import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {employment} from '../db/schema';
import {informationCorrectionOptions,previewInformationCorrection,correctInformationTx,InformationCorrectionError} from './information-correction';
import {createImportAttemptTx,lockImportAttemptTx,importAttemptEventsTx,importAttemptItemsTx,recordImportItemTx,recordImportEventTx,sealImportPlan,ImportHistoryError} from './import-history';
import {parseInformationWorkbook} from '../lib/information-correction-workbook';
import type {InformationChanges,InformationImportPlan,InformationImportResult} from '../lib/information-correction';
import {publicErrorMessage} from '../lib/public-error';
import {pgSqlState} from '../lib/db-error';
export async function previewInformationUpload(ctx:SessionContext,input:{name:string;content:Buffer;operationKey:string}){
 if(!input.name.toLowerCase().endsWith('.xlsx'))throw new InformationCorrectionError('Choose the .xlsx Information-Only Correction template.');
 const rows=parseInformationWorkbook(input.content),options=await informationCorrectionOptions(ctx);
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
   row.preview=await previewInformationCorrection(ctx,{employmentId:matches[0].id,changes,reason:row.values['Correction Reason']!});
  }catch(error){row.errors.push(error instanceof InformationCorrectionError?error.message:publicErrorMessage(error));}
 }
 for(const target of targets.values())if(target.length>1)for(const row of rows)if(target.includes(row.row))row.errors.push('Multiple rows resolve to the same employee.');
 const valid=rows.filter(r=>!r.errors.length&&r.preview?.changed.length).length;
 const plan=sealImportPlan<InformationImportPlan>({version:1,previewHash:'',counts:{total:rows.length,valid,invalid:rows.filter(r=>r.errors.length).length},issues:[],rows});
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
   await withTenant(ctx,async tx=>{
    const held=await lockImportAttemptTx(tx,ctx,input.attemptId,'information_correction');
    const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.import_attempt_access(${held.id}::uuid,'maintain',true) as ok`);
    if(!allowed?.ok||held.createdBy!==ctx.userId)throw new ImportHistoryError('Your permission for this import changed.');
    const prior=(await importAttemptItemsTx(tx,held.id)).find(item=>item.itemKey===String(row.row));
    if(prior){if(prior.status==='failed')throw new ImportHistoryError(prior.errors.join(' '));return;}
    const changes=Object.fromEntries(preview.changed.map(f=>[f,preview.after[f]])) as InformationChanges;
    const saved=await correctInformationTx(tx,ctx,{employmentId:preview.employmentId,changes,reason:preview.reason,fingerprint:preview.fingerprint,method:'excel',batchId:held.id,filename:held.sourceName});
    if(!saved.changed)throw new ImportHistoryError('The employee no longer needs this correction. Review again.');
    await recordImportItemTx(tx,ctx,{attemptId:held.id,companyId:preview.before.companyId!,employmentId:preview.employmentId,itemKey:String(row.row),label:preview.employeeCode+' · '+preview.name,ordinal:row.row,status:'applied',before:{values:preview.beforeLabels,reason:preview.reason},after:{values:preview.afterLabels,reason:preview.reason}});
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
