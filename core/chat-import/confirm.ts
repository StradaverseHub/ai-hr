/** AI v2 Phase 1, slice 3 (issue 16b) — Confirm on an import prepared in chat.
 *
 * Acts only on the person's explicit Confirm (`confirm: true`), under their own login, in this order:
 *  1. the signed proposal must verify for THIS caller (signature, expiry, tenant, login and person) and be a chat import
 *     for a company, so a tampered, expired or someone else's card is refused before anything is read;
 *  2. the kind must still be one the caller may import (core/chat-import/kinds.ts) and the company one they administer;
 *  3. the file posted back must be the one prepared: its hash must equal the sealed one (the payroll history attempt is
 *     already held by its owner, so no file travels for it);
 *  4. a Confirm already made for this card is replayed, never committed again: the first Confirm claims the card with a
 *     domain event whose id is the proposal's own id (a second insert of that id is refused by the database), and records
 *     its outcome under an id derived from it;
 *  5. otherwise the kind's preview runs again as the caller and must still match what the card showed;
 *  6. the import owner's own commit path runs, with its own checks, history and revert:
 *     - employee records: core/employee-import-upload.ts commitEmployeeImportUpload (Import History, kind employee_full,
 *       with this card's operation key, which the owner itself admits once);
 *     - leave balances: commitLeaveImport, which re-checks every row and skips one already imported;
 *     - payroll history: confirmPayrollHistoryUpload on the owner's own attempt and plan hash (once only by its own index),
 *       importing only the new records when some would replace earlier history (the replacement is decided on its page);
 *     - attendance clockings: commitClockingImport with the built-in template, which logs the run.
 * Errors are bounded to a refusal code; no source detail, cell value or SQL escapes. No model. */
import {createHash} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {domainEvent} from '../../db/schema';
import {actorOf,appendEvent} from '../../db/events';
import {parseCsvRecords} from '../../lib/csv';
import {BUILTIN_MAPPING_ID} from '../../lib/clocking-file';
import {CHAT_IMPORT_ACTION,CHAT_IMPORT_ENTITY,chatImportFileInput,isChatImportKind,type ChatImportFile,type ChatImportKind} from '../../lib/chat-import';
import {verifyProposal,type Proposal,type ProposalRefusal} from '../proposals/proposal';
import {commitEmployeeImportUpload,employeeImportUploadInput} from '../employee-import-upload';
import {commitLeaveImport} from '../../packs/leave/service';
import {confirmPayrollHistoryUpload} from '../../packs/payroll/service';
import {commitClockingImport} from '../../packs/attendance/service';
import {chatImportKindsFor} from './kinds';
import {previewChatImport,previewDigest,sourceHashOf,historySourceName} from './previews';

export type ChatImportRefusal=ProposalRefusal|'wrong_action'|'not_confirmed'|'not_permitted'|'file_changed'|'changed'|'not_confirmable'|'in_progress'|'unavailable';
export type ChatImportConfirmResult=Readonly<{kind:'imported';importKind:ChatImportKind;imported:number;notImported:number;
 /** The owner's own history of this import, where its revert is, when it keeps one. */
 historyHref:string|null;revertible:boolean;
 /** This card had already been confirmed: its first outcome, not a second import. */
 replayed:boolean}>
 |Readonly<{kind:'refused';reason:ChatImportRefusal}>;

const refused=(reason:ChatImportRefusal):ChatImportConfirmResult=>Object.freeze({kind:'refused' as const,reason});
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
/** A stable event id derived from the proposal id, for the outcome of its one Confirm. */
export function outcomeEventId(proposalId:string):string{
 const hex=createHash('sha256').update('teras:chat-import:outcome\n'+proposalId).digest('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-${((parseInt(hex[16],16)&3)|8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
type Outcome=Readonly<{importKind:ChatImportKind;imported:number;notImported:number;historyHref:string|null;revertible:boolean}>;
const AGGREGATE='chat-import';

type Failed=Readonly<{failed:ChatImportRefusal}>;
async function recordedOutcome(ctx:SessionContext,proposalId:string):Promise<Outcome|Failed|'claimed'|null>{
 return withTenant(ctx,async tx=>{
  const rows=await tx.select({id:domainEvent.id,payload:domainEvent.payload}).from(domainEvent)
   .where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,AGGREGATE),eq(domainEvent.aggregateId,proposalId)));
  const done=rows.find(row=>row.id===outcomeEventId(proposalId));
  if(done){const value=done.payload as (Partial<Outcome>&{failed?:unknown})|null;
   if(value&&typeof value.failed==='string')return Object.freeze({failed:value.failed as ChatImportRefusal});
   if(value&&isChatImportKind(value.importKind)&&typeof value.imported==='number'&&typeof value.notImported==='number')
    return Object.freeze({importKind:value.importKind,imported:value.imported,notImported:value.notImported,historyHref:typeof value.historyHref==='string'?value.historyHref:null,revertible:value.revertible===true});}
  return rows.some(row=>row.id===proposalId)?'claimed':null;
 });
}
/** The once-only claim: the database refuses a second event with this card's id. */
async function claim(ctx:SessionContext,proposal:Proposal):Promise<boolean>{
 const {id,what}=proposal.body;
 try{await withTenant(ctx,tx=>appendEvent(tx,{id,tenantId:ctx.tenantId,aggregateType:AGGREGATE,aggregateId:id,eventType:'chat-import.confirm-claimed',actor:actorOf(ctx),
  payload:{importKind:what.selectors.importKind,companyId:what.selectors.companyId,sourceHash:what.selectors.sourceHash}}));return true;}
 catch{return false;}
}
async function record(ctx:SessionContext,proposal:Proposal,outcome:Outcome|(Failed&{importKind:ChatImportKind})):Promise<void>{
 const id=proposal.body.id;
 try{await withTenant(ctx,tx=>appendEvent(tx,{id:outcomeEventId(id),tenantId:ctx.tenantId,aggregateType:AGGREGATE,aggregateId:id,eventType:'chat-import.confirmed',actor:actorOf(ctx),payload:{...outcome}}));}
 catch(error){console.error('[chat import] outcome not recorded',error instanceof Error?error.name:typeof error);}
}

async function commit(ctx:SessionContext,proposal:Proposal,kind:ChatImportKind,file:ChatImportFile|null):Promise<Outcome|ChatImportRefusal>{
 const body=proposal.body,companyId=body.forWhom.subjectId,summary=body.import!;
 if(kind==='payroll_history'){
  const result=await confirmPayrollHistoryUpload(ctx,{attemptId:body.review.reference,previewHash:body.what.selectors.previewHash??'',confirmReplacement:false,
   skipReplacements:summary.replacing>0,acknowledgeWarnings:false});
  return {importKind:kind,imported:summary.ready,notImported:summary.total-summary.ready,historyHref:'/payroll/history-import/logs/'+result.attemptId,revertible:true};
 }
 if(!file)return 'file_changed';
 if(kind==='leave_balances'){
  const result=await commitLeaveImport(ctx,{records:parseCsvRecords(file.text).records,source:{kind:'file',name:file.name,format:file.format==='txt'?'csv':file.format}});
  return {importKind:kind,imported:result.imported,notImported:result.totalRows-result.imported,historyHref:null,revertible:false};
 }
 if(kind==='employee_records'){
  const result=await commitEmployeeImportUpload(ctx,employeeImportUploadInput({companyId,csv:file.text,fileName:file.name}),
   {name:historySourceName(file.name),content:Buffer.from(file.text,'utf8'),operationKey:body.review.reference});
  const attemptId=(result as {attemptId?:unknown}).attemptId;
  return {importKind:kind,imported:result.imported,notImported:summary.total-result.imported,
   historyHref:typeof attemptId==='string'?'/admin/personnel/import/history/'+attemptId:'/admin/personnel/import/history',revertible:true};
 }
 const result=await commitClockingImport(ctx,{mappingId:BUILTIN_MAPPING_ID,text:file.text,fileName:file.name,fileBytes:Buffer.byteLength(file.text,'utf8')});
 return {importKind:kind,imported:result.imported,notImported:result.counts.total-result.imported,historyHref:result.runId?'/attendance/import/logs/'+result.runId:null,revertible:false};
}

export async function confirmChatImport(supplied:SessionContext,input:Readonly<{proposal:unknown;confirm:unknown;file?:unknown}>,now:Date=new Date()):Promise<ChatImportConfirmResult>{
 const ctx=capture(supplied);
 if(input.confirm!==true)return refused('not_confirmed');
 try{
  const verified=verifyProposal(input.proposal,ctx,now);
  if(!verified.ok)return refused(verified.reason);
  const proposal=verified.proposal,body=proposal.body,kind=body.what.selectors.importKind;
  if(body.what.action!==CHAT_IMPORT_ACTION||body.what.entity!==CHAT_IMPORT_ENTITY||body.what.contractVersion!==1||body.forWhom.subject!=='company'
   ||!isChatImportKind(kind)||!body.import||body.import.kind!==kind||body.what.selectors.companyId!==body.forWhom.subjectId)return refused('wrong_action');
  const info=(await chatImportKindsFor(ctx)).find(row=>row.kind===kind);
  if(!info||body.review.route!==info.page)return refused('not_permitted');
  // Payroll history's upload is its own attempt; every other kind's file comes back with Confirm and must be the same.
  const file=kind==='payroll_history'?null:chatImportFileInput(input.file);
  if(kind!=='payroll_history'&&(!file||sourceHashOf(file.text)!==body.what.selectors.sourceHash))return refused('file_changed');
  const prior=await recordedOutcome(ctx,body.id);
  if(prior==='claimed')return refused('in_progress');
  if(prior&&'failed' in prior)return refused(prior.failed);
  if(prior)return Object.freeze({kind:'imported' as const,...prior,replayed:true});
  if(!body.import.confirmable)return refused('not_confirmable');
  if(kind!=='payroll_history'){
   // What the person saw must still hold: the same rows ready, the same rows needing attention.
   const again=await previewChatImport(ctx,{kind,companyId:body.forWhom.subjectId,file:file!,operationKey:body.review.reference});
   if(previewDigest(body.forWhom.subjectId,again)!==body.what.reviewedDigest)return refused('changed');
  }
  if(!await claim(ctx,proposal)){
   const raced=await recordedOutcome(ctx,body.id);
   if(raced&&raced!=='claimed')return 'failed' in raced?refused(raced.failed):Object.freeze({kind:'imported' as const,...raced,replayed:true});
   return refused('in_progress');
  }
  let outcome:Outcome|ChatImportRefusal;
  try{outcome=await commit(ctx,proposal,kind,file);}
  catch(error){const message=error instanceof Error?error.message:'';outcome=/access|authori[sz]|permission/i.test(message)?'not_permitted':/changed|validate a new/i.test(message)?'changed':'unavailable';}
  // A Confirm the owner refused stays refused for this card: the person fixes the rows or attaches the file again.
  if(typeof outcome==='string'){await record(ctx,proposal,{importKind:kind,failed:outcome});return refused(outcome);}
  await record(ctx,proposal,outcome);
  return Object.freeze({kind:'imported' as const,...outcome,replayed:false});
 }catch{return refused('unavailable');}
}
