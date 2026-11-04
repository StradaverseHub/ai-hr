/** AI v2 Phase 1, slice 3 (issue 16b) — an import prepared in chat, for one Confirm.
 *
 * Prepare (in the chat turn, as the caller), only after core/chat-import/kinds.ts decided the kind:
 *  1. the kind must be one this caller may import now (the capability catalogue's own guard), and the company the turn
 *     runs in one the database says they administer (app.is_admin_for);
 *  2. the file's type must be one that kind's own page accepts;
 *  3. the kind's own preview owner runs as the caller (core/chat-import/previews.ts). Payroll history records the
 *     upload as its own attempt, exactly as its page does; the others write nothing;
 *  4. a signed proposal is issued, bound to this login, the company, the file's hash and the preview's digest, and it
 *     expires (lib/chat-import.ts CHAT_IMPORT_TTL_MS).
 * Nothing is imported here. Confirm (core/chat-import/confirm.ts) re-checks everything and commits through the owner's
 * own path, with its checks, history and revert. The model never sees the file: it gets the kind, counts and issue
 * categories (core/chat-import/tool.ts). */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {company} from '../../db/schema';
import {CHAT_IMPORT_ACTION,CHAT_IMPORT_CARD_ISSUES,CHAT_IMPORT_ENTITY,CHAT_IMPORT_TTL_MS,type ChatImportFile} from '../../lib/chat-import';
import type {ChatImportKindInfo} from '../chat-import/kinds';
import {previewChatImport,previewDigest,type ChatImportPreview} from '../chat-import/previews';
import {assertProposalsConfigured,issueProposal,type Proposal} from './proposal';

export {CHAT_IMPORT_ACTION,CHAT_IMPORT_ENTITY};
/** The preview owner each kind's single check names. */
export const CHAT_IMPORT_PREVIEW_OWNERS=Object.freeze({
 employee_records:'core/import.ts#validateEmployeeImport',leave_balances:'core/leave-import.ts#validateLeaveImport',
 payroll_history:'core/payroll-history-revisions.ts#previewPayrollHistoryUpload',attendance_clockings:'core/attendance-clocking-import.ts#validateClockingImport',
} as const);

export type ChatImportPrepared=Readonly<{kind:'proposal';proposal:Proposal;preview:ChatImportPreview;info:ChatImportKindInfo}>
 /** The file is not a type this kind's page accepts. */
 |Readonly<{kind:'wrong_format';info:ChatImportKindInfo}>
 /** The company is not one the caller administers, or the owner refused the caller. */
 |Readonly<{kind:'not_permitted';info:ChatImportKindInfo}>
 /** The owner could not read the file (empty, too large, unreadable). */
 |Readonly<{kind:'unreadable';info:ChatImportKindInfo}>;

/** The company label, only when the database says the caller administers that company. */
async function administeredCompany(ctx:SessionContext,companyId:string):Promise<string|null>{
 if(!/^[0-9a-f-]{36}$/i.test(companyId))return null;
 const [row]=await withTenant(ctx,tx=>tx.select({name:company.legalName,label:company.companyLabel}).from(company)
  .where(and(eq(company.tenantId,ctx.tenantId),eq(company.id,companyId),sql`app.is_admin_for(${company.id}) IS TRUE`)).limit(1));
 if(!row)return null;
 const label=row.label?.trim();return (label?`${label} · ${row.name}`:row.name).slice(0,200);
}

export async function prepareChatImportProposal(ctx:SessionContext,input:Readonly<{info:ChatImportKindInfo;companyId:string;file:ChatImportFile;now?:Date}>):Promise<ChatImportPrepared>{
 const {info,file}=input,now=input.now??new Date();
 if(!ctx.userId||!ctx.personId)return Object.freeze({kind:'not_permitted' as const,info});
 if(!info.formats.includes(file.format))return Object.freeze({kind:'wrong_format' as const,info});
 const companyLabel=await administeredCompany(ctx,input.companyId);
 if(!companyLabel)return Object.freeze({kind:'not_permitted' as const,info});
 assertProposalsConfigured();
 const operationKey=randomUUID();
 let preview:ChatImportPreview;
 try{preview=await previewChatImport(ctx,{kind:info.kind,companyId:input.companyId,file,operationKey});}
 catch(error){
  const message=error instanceof Error?error.message:'';
  return Object.freeze({kind:/access|authori[sz]|permission|module|sign in/i.test(message)?'not_permitted' as const:'unreadable' as const,info});
 }
 if(!preview.total)return Object.freeze({kind:'unreadable' as const,info});
 const created=new Date(now.getTime());
 const proposal=issueProposal({
  what:{action:CHAT_IMPORT_ACTION,contractVersion:1,entity:CHAT_IMPORT_ENTITY,effect:'create',
   selectors:{importKind:info.kind,companyId:input.companyId,sourceHash:preview.sourceHash,...(preview.previewHash?{previewHash:preview.previewHash}:{})},
   reviewedDigest:previewDigest(input.companyId,preview)},
  forWhom:{tenantId:ctx.tenantId,subject:'company',subjectId:input.companyId},
  authority:{kind:'person',tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId},
  checks:[{check:'rows_checked',owner:CHAT_IMPORT_PREVIEW_OWNERS[info.kind],ruleVersion:null,result:preview.attention>0?'needs_review':'pass'}],
  // The payroll history attempt is the owner's own handle; the others take this operation key (the employee import's
  // own once-only upload key).
  review:{route:info.page,href:info.page,reference:preview.attemptId??operationKey},
  import:{kind:info.kind,company:companyLabel,total:preview.total,ready:preview.ready,attention:preview.attention,warned:preview.warned,
   issues:preview.issues.slice(0,CHAT_IMPORT_CARD_ISSUES).map(row=>({...row})),issueCount:preview.issues.length,confirmable:preview.confirmable,
   revertible:info.revertible,replacing:preview.replacing??0,template:info.template,otherCompany:preview.otherCompany},
  createdAt:created.toISOString(),expiresAt:new Date(created.getTime()+CHAT_IMPORT_TTL_MS).toISOString(),
 });
 return Object.freeze({kind:'proposal' as const,proposal,preview,info});
}
