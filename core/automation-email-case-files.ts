import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {resolveDocumentUpload} from './employee-documents';
import {AutomationError} from './automation-store';
import {pgSqlState} from '../lib/db-error';
import type {AutomationEmailCaseFileRef} from '../lib/automation-email-ipc';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type ProbationEmailFileChoice={templateId:string;name:string;slots:{id:string;label:string;required:boolean}[];files:AutomationEmailCaseFileRef[]};
export function probationEmailFileChoices(ctx:SessionContext,caseId:string){
 if(!uuid.test(caseId))throw new AutomationError('invalid','Case unavailable.');
 return withScopedLifecycleTenant(ctx,async tx=>{
  const[row]=await tx.execute<{data:ProbationEmailFileChoice[]}>(sql`select app.probation_email_file_choices(${caseId}::uuid) as data`);return row.data;
 });
}
export async function uploadProbationEmailCaseFile(ctx:SessionContext,input:{caseId:string;templateId:string;slotId:string;revision:number;name:string;content:Buffer}){
 if(![input.caseId,input.templateId,input.slotId].every(value=>uuid.test(value))||!Number.isSafeInteger(input.revision)||input.revision<1||!input.name||input.name.length>180||/[\x00-\x1f\x7f/\\:]/.test(input.name)||!Buffer.isBuffer(input.content)||!input.content.length||input.content.length>10485760)throw new AutomationError('invalid','Choose a supported file of at most 10 MB.');
 const content=Buffer.from(input.content);let mime:string;
 try{
  if(/\.(gif|webp)$/i.test(input.name)){mime=/\.gif$/i.test(input.name)?'image/gif':'image/webp';await(await import('../lib/email-design/assets')).validateEmailRaster(content,mime);}
  else if(/\.csv$/i.test(input.name)){resolveDocumentUpload('upload.txt',content);mime='text/csv';}
  else mime=resolveDocumentUpload(input.name,content).mimeType;
 }catch{throw new AutomationError('invalid','The file contents do not match a supported email attachment.');}
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  const[row]=await tx.execute<{id:string}>(sql`select app.probation_email_case_file_write(${input.caseId}::uuid,${input.templateId}::uuid,${input.slotId}::uuid,${input.revision},${input.name},${mime},decode(${content.toString('base64')},'base64')) as id`);return row.id;
 });}catch(error){const state=pgSqlState(error);if(state==='42501')throw new AutomationError('forbidden','Email files unavailable.');if(state==='40001')throw new AutomationError('conflict','The case changed. Reload before uploading.');if(state==='22023')throw new AutomationError('invalid','This email file slot is no longer available.');throw error;}
}
export function downloadProbationEmailCaseFile(ctx:SessionContext,caseId:string,id:string){
 if(!uuid.test(caseId)||!uuid.test(id))throw new AutomationError('invalid','File unavailable.');
 return withScopedLifecycleTenant(ctx,async tx=>{
  const[row]=await tx.execute<{filename:string;mime_type:string;bytes:string}>(sql`select filename,mime_type,encode(content,'base64') as bytes from automation_email_case_file where tenant_id=app.current_tenant_id() and case_id=${caseId}::uuid and id=${id}::uuid`);
  if(!row)throw new AutomationError('forbidden','File unavailable.');return {name:row.filename,mimeType:row.mime_type,content:Buffer.from(row.bytes,'base64')};
 });
}
