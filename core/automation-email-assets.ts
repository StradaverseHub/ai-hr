/** Shared template files use the native immutable V9 byte owner, with module and case purpose checks in SQL. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {AutomationError} from './automation-store';
import {resolveDocumentUpload} from './employee-documents';
import {automationEmailAssetSchema,type AutomationEmailAsset,type AutomationEmailSlot} from '../lib/automation-email-assets';
import {pgSqlState} from '../lib/db-error';

const uploadSchema=z.object({templateId:z.uuid(),module:z.enum(['contract_staff','probation']),revision:z.number().int().positive(),kind:z.enum(['file','image']),name:z.string().min(1).max(180).regex(/^[^\u0000-\u001f\u007f/\\:]+$/u),caseId:z.uuid().optional(),slotId:z.uuid().optional()}).strict();
export async function uploadAutomationEmailAsset(ctx:SessionContext,input:z.infer<typeof uploadSchema>&{content:Buffer}):Promise<AutomationEmailAsset>{
 const {content,...raw}=input,parsed=uploadSchema.parse(raw);
 if(!Buffer.isBuffer(content)||!content.length||content.length>(parsed.kind==='image'?1048576:10485760)||!/\.(pdf|png|jpe?g|gif|webp|docx?|xlsx?|txt|csv)$/i.test(parsed.name))throw new AutomationError('invalid','Choose a supported file of at most 10 MB, or an email image of at most 1 MB.');
 let mimeType:string;
 if(/\.csv$/i.test(parsed.name)){resolveDocumentUpload('upload.txt',content);mimeType='text/csv';}
 else if(/\.(gif|webp)$/i.test(parsed.name)){mimeType=/\.gif$/i.test(parsed.name)?'image/gif':'image/webp';await (await import('../lib/email-design/assets')).validateEmailRaster(content,mimeType);}
 else mimeType=resolveDocumentUpload(parsed.name,content).mimeType;
 if(parsed.kind==='image')await (await import('../lib/email-design/assets')).validateEmailRaster(content,mimeType);
 return withScopedLifecycleTenant(ctx,async tx=>{
  try{
   const [row]=await tx.execute<{asset:unknown}>(sql`select app.automation_email_asset_upload(${parsed.templateId}::uuid,${parsed.module},${parsed.revision},${parsed.kind},${parsed.name},${mimeType},decode(${content.toString('base64')},'base64'),${parsed.caseId??null}::uuid,${parsed.slotId??null}) as asset`);
   return automationEmailAssetSchema.parse(row.asset);
  }catch(error){const state=pgSqlState(error);if(state==='42501')throw new AutomationError('forbidden','You cannot upload a file here.');if(state==='40001')throw new AutomationError('conflict','The case or template changed. Reload before uploading.');if(state==='22023')throw new AutomationError('invalid',error instanceof Error?error.message:'Check this upload.');throw error;}
 });
}
export async function downloadAutomationEmailAsset(ctx:SessionContext,id:string):Promise<{name:string;mimeType:string;content:Buffer}>{
 z.uuid().parse(id);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{asset:(AutomationEmailAsset&{bytes:string})|null}>(sql`select app.automation_email_asset_read(${id}::uuid) as asset`);
  if(!row?.asset)throw new AutomationError('forbidden','Email file not found or unavailable.');
  return {name:row.asset.name,mimeType:row.asset.mimeType,content:Buffer.from(row.asset.bytes,'base64')};
 });
}
export type AutomationEmailCaseFileSet={templateId:string;templateName:string;revision:number;slots:(AutomationEmailSlot&{file:AutomationEmailAsset|null})[]};
/** Only email definitions named by actual accepted runs on this case are exposed to its manual operator. */
export async function automationEmailCaseFiles(ctx:SessionContext,caseId:string):Promise<AutomationEmailCaseFileSet[]>{
 z.uuid().parse(caseId);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{files:AutomationEmailCaseFileSet[]}>(sql`select app.automation_email_case_files(${caseId}::uuid) as files`);
  return row?.files??[];
 });
}
export async function automationEmailCaseFilePage(ctx:SessionContext,caseId:string,input:{limit?:number;offset?:number}={}){
 z.uuid().parse(caseId);const page=z.object({limit:z.number().int().min(1).max(50).default(50),offset:z.number().int().min(0).max(100000).default(0)}).strict().parse(input);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{page:{items:AutomationEmailCaseFileSet[];hasMore:boolean;limit:number;offset:number}}>(sql`select app.automation_email_case_files_page(${caseId}::uuid,${page.limit},${page.offset}) as page`);
  return row.page;
 });
}
