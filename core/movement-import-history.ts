/**
 * ac6645ec (ADR-0152, ADR-0153) — Movement import on the shared import history: every upload is an attempt
 * with its original file, every movement an employee's transaction created is an item, and a whole import
 * can be reverted once, all or nothing, through the Movement owner's own rollback.
 */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {createImportAttemptTx,importAttemptEventsTx,importAttemptItemsTx,lockImportAttemptTx,recordImportEventTx,recordImportFailure,recordImportItemTx,sealImportPlan,ImportHistoryError,type ImportAttemptItemRow,type ImportRevertHandler} from './import-history';
import {commitMovementImport,previewMovementImport,movementImportTypes,movementImportStateTx,type MovementImportItemState} from './movement-import';
import {movementLedgerMarkerTx,movementReversalBlockerTx,reverseMovementForImportTx} from './movement';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {readMovementSource,movementWorkbookCatalogue} from '../lib/movement-workbook.server';
import {movementImportIssueText} from '../lib/movement-import-issues';
import {movementEmployeeKey,type MovementImportPreview,type MovementImportResult} from '../lib/movement-import-contract';
import {movementImportFieldLabel} from '../lib/movement-import-issues';
import {personnelImportLabelResolvers} from '../lib/personnel-import-labels.server';
import type {ImportPlanBase} from '../lib/import-history';
import type {PersonnelLabelResolver} from '../lib/personnel-import-contract';
import {createHash} from 'node:crypto';

/** The sealed plan of a movement attempt. Fingerprints stay server-side; the browser sends only its choice. */
export type MovementImportPlan=ImportPlanBase&{kind:'movement';inputHash:string;sourceHash:string;catalogueHash:string;fingerprints:Record<string,string>;
 employees:{key:string;employeeCode:string;companyId:string|null;name:string|null;rows:number[];valid:boolean;errors:string[]}[]};
const sha=(content:Buffer)=>createHash('sha256').update(content).digest('hex');
type Words={resolve:PersonnelLabelResolver};
async function sourceRecords(ctx:SessionContext,name:string,content:Buffer,words:Words){
 const types=await movementImportTypes(ctx);
 const parsed=await readMovementSource(name,content,{tenantId:ctx.tenantId,types,resolve:words.resolve});
 return{...parsed,catalogueHash:movementWorkbookCatalogue({types}),sourceHash:sha(content)};
}
/** Checks an uploaded file and records it as an import attempt with the original bytes. Nothing is saved. */
export async function previewMovementUpload(ctx:SessionContext,input:{name:string;content:Buffer;operationKey?:string}&Words):Promise<{attemptId:string;previewHash:string;preview:MovementImportPreview}>{
 const source=await sourceRecords(ctx,input.name,input.content,input);
 let preview:MovementImportPreview={inputHash:'',selection:[],fileErrors:source.fileErrors,employees:[],excluded:0,valid:0};
 if(!source.fileErrors.length)preview=await previewMovementImport(ctx,{csv:'',records:source.records,sourceHash:source.sourceHash,catalogueHash:source.catalogueHash});
 const describe=(errors:readonly string[])=>movementImportIssueText(errors,input.resolve);
 const employees=preview.employees.map(e=>{const errors=e.rows.flatMap(r=>r.errors);return{key:movementEmployeeKey(e),employeeCode:e.employeeCode,companyId:e.companyId??null,name:e.name,rows:e.rows.map(r=>r.row),valid:!!e.fingerprint&&e.rows.every(r=>r.status==='valid'),errors:errors.length?[describe(errors)]:[]};});
 const movements=preview.employees.reduce((n,e)=>n+e.rows.length,0),valid=employees.filter(e=>e.valid).reduce((n,e)=>n+e.rows.length,0);
 const plan=sealImportPlan<MovementImportPlan>({version:1,kind:'movement',inputHash:preview.inputHash,sourceHash:source.sourceHash,catalogueHash:source.catalogueHash,fingerprints:Object.fromEntries(preview.employees.filter(e=>e.fingerprint).map(e=>[movementEmployeeKey(e),e.fingerprint!])),employees,
  counts:{total:movements,valid,invalid:movements-valid},issues:source.fileErrors.map(code=>({rowNum:1,reason:describe([code])})),previewHash:''});
 const companyIds=[...new Set(employees.map(e=>e.companyId).filter((id):id is string=>!!id))];
 const created=await withTenant(ctx,tx=>createImportAttemptTx(tx,ctx,{kind:'movement',sourceName:input.name,content:input.content,companyIds,plan,operationKey:input.operationKey}));
 return{attemptId:created.attemptId,previewHash:created.plan.previewHash,preview};
}
export type MovementUploadResult=MovementImportResult&{attemptId:string;alreadyCommitted:boolean};
/**
 * Saves the employees chosen from a checked attempt. The ORIGINAL file is re-read from the attempt (the
 * browser cannot swap it), the reviewed plan's fingerprints must still hold for each employee, and each
 * employee is saved in its own transaction together with its history items.
 */
export async function confirmMovementUpload(ctx:SessionContext,input:{attemptId:string;previewHash:string;employees:string[];acknowledgeExcluded:boolean}&Words):Promise<MovementUploadResult>{
 type Held={plan:MovementImportPlan;content:Buffer;name:string};
 let prepared:Held|{already:MovementUploadResult};
 try{
  prepared=await withTenant(ctx,async(tx):Promise<Held|{already:MovementUploadResult}>=>{
   const source=await lockImportAttemptTx(tx,ctx,input.attemptId,'movement'),plan=source.plan as unknown as MovementImportPlan,events=await importAttemptEventsTx(tx,source.id);
   if(events.some(e=>e.kind==='reverted'))throw new ImportHistoryError('This import was reverted. Upload the file again to import it.');
   const confirmed=events.find(e=>e.kind==='confirmed');
   if(confirmed)return{already:{attemptId:source.id,alreadyCommitted:true,employees:[],imported:Number(confirmed.detail.succeeded??0),failed:Number(confirmed.detail.failed??0),excluded:0,byEventType:[]}};
   if((await importAttemptItemsTx(tx,source.id)).length)throw new ImportHistoryError('This import is already being saved.');
   if(input.previewHash!==plan.previewHash||plan.issues.length||!plan.counts.valid)throw new ImportHistoryError('Correct the file and upload it again before saving.');
   const[covers]=await tx.execute<{ok:boolean}>(sql`select app.import_attempt_access(${source.id}::uuid,'maintain',true) as ok`);
   if(!covers?.ok)throw new ImportHistoryError('Your permission for a company in this file has changed. Upload the file again.');
   return{plan,content:source.sourceContent,name:source.sourceName};
  });
 }catch(error){await recordImportFailure(ctx,input.attemptId,'movement','failed',error);throw error;}
 if('already' in prepared)return prepared.already;
 const source=await sourceRecords(ctx,prepared.name,prepared.content,input);
 const plan=prepared.plan;
 if(source.fileErrors.length||source.sourceHash!==plan.sourceHash){const error=new ImportHistoryError('The file can no longer be read in the current layout. Upload it again.');await recordImportFailure(ctx,input.attemptId,'movement','failed',error);throw error;}
 const chosen=new Set(input.employees),selected=plan.employees.filter(e=>chosen.has(e.key));
 if(input.employees.some(key=>!plan.employees.some(e=>e.key===key&&e.valid))||!selected.length)throw new ImportHistoryError('Choose at least one employee whose movements were checked without errors.');
 let result:MovementImportResult;
 try{
  result=await commitMovementImport(ctx,{csv:'',records:source.records,sourceHash:source.sourceHash,catalogueHash:source.catalogueHash,inputHash:plan.inputHash,fingerprints:plan.fingerprints,selection:selected.flatMap(e=>e.rows),acknowledgeExcluded:input.acknowledgeExcluded,history:{attemptId:input.attemptId}});
 }catch(error){
  const known=error instanceof Error&&/^[a-z_]+$/.test(error.message)?new ImportHistoryError(movementImportIssueText(error.message,input.resolve)):error;
  await recordImportFailure(ctx,input.attemptId,'movement','failed',known);throw known;
 }
 const describe=(errors:readonly string[])=>movementImportIssueText(errors,input.resolve);
 const invalid=plan.employees.filter(e=>!e.valid);
 let failed=result.failed+invalid.reduce((n,e)=>n+e.rows.length,0);
 try{
  await withTenant(ctx,async tx=>{
   await lockImportAttemptTx(tx,ctx,input.attemptId,'movement');
   // Employees whose transaction failed, then those the check already refused: one failed item each.
   for(const employee of result.employees){const failedRows=employee.rows.filter(r=>r.status==='failed');if(!failedRows.length||!employee.companyId)continue;
    await recordImportItemTx(tx,ctx,{attemptId:input.attemptId,companyId:employee.companyId,employmentId:employee.employmentId,itemKey:`failed|${movementEmployeeKey(employee)}`,label:`${employee.employeeCode}${employee.name?' · '+employee.name:''}`,ordinal:Math.min(...failedRows.map(r=>r.row)),status:'failed',errors:[describe(failedRows.flatMap(r=>r.errors))]});}
   for(const employee of invalid)if(employee.companyId)await recordImportItemTx(tx,ctx,{attemptId:input.attemptId,companyId:employee.companyId,employmentId:null,itemKey:`invalid|${employee.key}`,label:`${employee.employeeCode}${employee.name?' · '+employee.name:''}`,ordinal:Math.min(...employee.rows),status:'failed',errors:employee.errors});
   await recordImportEventTx(tx,ctx,{attemptId:input.attemptId,kind:'confirmed',importKind:'movement',detail:{succeeded:result.imported,failed}});
  });
 }catch(error){
  if(String((error as {message?:string})?.message??'').includes('import_attempt_confirm_once_uq'))return{...result,attemptId:input.attemptId,alreadyCommitted:true};
  throw error;
 }
 return{...result,attemptId:input.attemptId,alreadyCommitted:false};
}

const itemState=(value:unknown)=>value as MovementImportItemState;
/** Blockers are stored with the revert's audit detail in the base language, like the other import kinds. */
const fieldCaption=(field:string)=>movementImportFieldLabel(field,personnelImportLabelResolvers[0]);
/** Writer locks precede the attempt row lock in revert, the same order as the Movement rollback. */
async function lockMovementWritersTx(tx:Tx,ctx:SessionContext){await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);}
/**
 * Revert: all or nothing. Each movement must pass the Movement owner's own rollback guards (reversible type,
 * not superseded, not already reversed, no closed payroll period), and every field it changed must still
 * hold the value this import left (a later movement or edit blocks it). Movements are rolled back newest
 * first through the owner's rollback, with the revert reason; they stay in Employment History, reversed.
 */
export const movementRevertHandler:ImportRevertHandler={
 kind:'movement',
 lock:(tx,ctx)=>lockMovementWritersTx(tx,ctx),
 async inspect(tx,ctx,items){
  const byEmployment=new Map<string,ImportAttemptItemRow[]>();
  for(const i of items){const list=byEmployment.get(i.employmentId??'')??[];list.push(i);byEmployment.set(i.employmentId??'',list);}
  const out:{itemId:string;blockers:string[];restore:unknown}[]=[],fingerprint:Record<string,number>={};
  for(const [employmentId,list]of byEmployment){
   const[access]=employmentId?await tx.execute<{ok:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,'workforce.maintain') as ok`):[{ok:false}];
   const state=access?.ok?await movementImportStateTx(tx,employmentId):{};
   if(access?.ok)fingerprint[employmentId]=await movementLedgerMarkerTx(tx,ctx,employmentId);
   // The newest import movement that changed a field is the one whose value must still be in place.
   const newest=new Map<string,ImportAttemptItemRow>();
   for(const i of [...list].sort((a,b)=>(itemState(a.after).sequence??0)-(itemState(b.after).sequence??0)))for(const field of Object.keys(itemState(i.after).raw??{}))newest.set(field,i);
   for(const i of list){
    const after=itemState(i.after),before=itemState(i.before),blockers:string[]=[];
    if(!access?.ok)blockers.push('You no longer have permission to maintain this employee.');
    else if(!after.movementId)blockers.push('This movement left no Employment History entry to roll back.');
    else{
     const reason=await movementReversalBlockerTx(tx,ctx,employmentId,after.movementId);if(reason)blockers.push(reason);
     for(const [field,value]of Object.entries(after.raw??{}))if(newest.get(field)?.id===i.id&&(state[field]??null)!==(value??null))blockers.push(`${fieldCaption(field)} has been changed since this import (for example by a later movement), so this movement cannot be rolled back without overwriting that change.`);
    }
    // The shared revert control lists `fields`: the values each changed field goes back to.
    out.push({itemId:i.id,blockers:[...new Set(blockers)],restore:{movementId:after.movementId,fields:Object.entries(before.values??{}).map(([field,value])=>({field:fieldCaption(field),value:value??'—'}))}});
   }
  }
  return{items:out,fingerprint};
 },
 async apply(tx,ctx,items,options){
  const reason=options?.reason??'';let reversed=0;
  for(const i of [...items].sort((a,b)=>(a.employmentId??'').localeCompare(b.employmentId??'')||(itemState(b.after).sequence??0)-(itemState(a.after).sequence??0)||b.ordinal-a.ordinal)){
   const after=itemState(i.after);if(!after.movementId||!i.employmentId)throw new ImportHistoryError('This import cannot be reverted.');
   await reverseMovementForImportTx(tx,ctx,i.employmentId,after.movementId,reason);reversed++;
  }
  return{movements:reversed};
 },
};
