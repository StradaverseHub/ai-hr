/** Shared template files use the native immutable V9 byte owner, with module and case purpose checks in SQL. */
import {createHash} from 'node:crypto';
import type {EmailAsset} from '../lib/lifecycle-v9-model';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {AutomationError} from './automation-store';
import {resolveDocumentUpload} from './employee-documents';
import {automationEmailAssetSchema,type AutomationEmailAsset,type AutomationEmailSlot} from '../lib/automation-email-assets';
import {pgSqlState} from '../lib/db-error';

const uploadSchema=z.object({templateId:z.uuid(),module:z.enum(['contract_staff','probation']),revision:z.number().int().positive(),kind:z.enum(['file','image']),name:z.string().min(1).max(180).regex(/^[^\u0000-\u001f\u007f/\\:]+$/u),caseId:z.uuid().optional(),slotId:z.uuid().optional(),prerequisiteId:z.uuid().optional()}).strict();
async function uploadSharedAutomationEmailAsset(ctx:SessionContext,input:z.infer<typeof uploadSchema>&{content:Buffer}):Promise<AutomationEmailAsset>{
 const {content,...raw}=input,parsed=uploadSchema.parse(raw);
 if(parsed.prerequisiteId&&(parsed.module!=='contract_staff'||!parsed.caseId||!parsed.slotId||parsed.kind!=='file'))throw new AutomationError('invalid','Choose a file slot from the waiting Contract email.');
 if(!Buffer.isBuffer(content)||!content.length||content.length>(parsed.kind==='image'?1048576:10485760)||!/\.(pdf|png|jpe?g|gif|webp|docx?|xlsx?|txt|csv)$/i.test(parsed.name))throw new AutomationError('invalid','Choose a supported file of at most 10 MB, or an email image of at most 1 MB.');
 let mimeType:string;
 try{
  if(/\.csv$/i.test(parsed.name)){resolveDocumentUpload('upload.txt',content);mimeType='text/csv';}
  else if(/\.(gif|webp)$/i.test(parsed.name)){mimeType=/\.gif$/i.test(parsed.name)?'image/gif':'image/webp';await (await import('../lib/email-design/assets')).validateEmailRaster(content,mimeType);}
  else mimeType=resolveDocumentUpload(parsed.name,content).mimeType;
  if(parsed.kind==='image')await (await import('../lib/email-design/assets')).validateEmailRaster(content,mimeType);
 }catch{throw new AutomationError('invalid','The file contents do not match a supported type. Choose a readable file or image and try again.');}
 return withScopedLifecycleTenant(ctx,async tx=>{
  try{
   // Selection only: the native owner independently checks this pin and the actual actor.
   await tx.execute(sql`select set_config('app.requested_contract_email_pin',${parsed.prerequisiteId??''},true)`);
   const [row]=await tx.execute<{asset:unknown}>(sql`select app.automation_email_asset_upload(${parsed.templateId}::uuid,${parsed.module},${parsed.revision},${parsed.kind},${parsed.name},${mimeType},decode(${content.toString('base64')},'base64'),${parsed.caseId??null}::uuid,${parsed.slotId??null}) as asset`);
   return automationEmailAssetSchema.parse(row.asset);
  }catch(error){const state=pgSqlState(error);if(state==='42501')throw new AutomationError('forbidden','You cannot upload a file here.');if(state==='40001')throw new AutomationError('conflict','The case or template changed. Reload before uploading.');if(state==='22023')throw new AutomationError('invalid',error instanceof Error?error.message:'Check this upload.');throw error;}
 });
}
async function downloadSharedAutomationEmailAsset(ctx:SessionContext,id:string):Promise<{name:string;mimeType:string;content:Buffer}>{
 z.uuid().parse(id);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{asset:(AutomationEmailAsset&{bytes:string})|null}>(sql`select app.automation_email_asset_read(${id}::uuid) as asset`);
  if(!row?.asset)throw new AutomationError('forbidden','Email file not found or unavailable.');
  return {name:row.asset.name,mimeType:row.asset.mimeType,content:Buffer.from(row.asset.bytes,'base64')};
 });
}
export type AutomationEmailCaseFileSet={templateId:string;templateName:string;revision:number;prerequisiteId?:string;sourcePeriodRevision?:string;preparedAt?:string;slots:(AutomationEmailSlot&{file:AutomationEmailAsset|null})[]};
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

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type AssetRow={id:string;kind:'file'|'image';filename:string;mime_type:string;size:number;content_hash:string;created_at:string;uploaded_by_name:string};
const metadata=(row:AssetRow):EmailAsset=>({id:row.id,kind:row.kind,name:row.filename,mimeType:row.mime_type,size:Number(row.size),contentHash:row.content_hash,at:new Date(row.created_at).toISOString(),by:row.uploaded_by_name});

/** Immutable upload receipts belong to one canonical Probation email, never the V9 configuration. */
async function uploadProbationAutomationEmailAsset(ctx:SessionContext,input:{emailId:string;revision:number;kind:'image'|'file';name:string;content:Buffer}):Promise<EmailAsset>{
  if(!uuid.test(input.emailId)||!Number.isSafeInteger(input.revision)||input.revision<1||!['file','image'].includes(input.kind)||!input.name||input.name.length>180||/[\x00-\x1f\x7f/\\:]/.test(input.name)||!Buffer.isBuffer(input.content)||!input.content.length||input.content.length>(input.kind==='image'?1048576:10485760))throw new AutomationError('invalid','Choose a supported file of at most 10 MB, or an image of at most 1 MB.');
  const content=Buffer.from(input.content);let mimeType:string;
  try {
    if(/\.(gif|webp)$/i.test(input.name)){mimeType=/\.gif$/i.test(input.name)?'image/gif':'image/webp';await(await import('../lib/email-design/assets')).validateEmailRaster(content,mimeType);}
    else if(/\.csv$/i.test(input.name)){resolveDocumentUpload('upload.txt',content);mimeType='text/csv';}
    else mimeType=resolveDocumentUpload(input.name,content).mimeType;
    if(input.kind==='image')await(await import('../lib/email-design/assets')).validateEmailAsset(content,mimeType);
  }catch{throw new AutomationError('invalid','The file contents do not match a supported email file.');}
  return withScopedLifecycleTenant(ctx,async tx=>{
    await tx.execute(sql`select app.access_workforce_write_lock()`);
    const[allowed]=await tx.execute<{ok:boolean}>(sql`select app.automation_can_configure('probation') as ok`);
    if(!allowed?.ok)throw new AutomationError('forbidden','You cannot configure Probation templates.');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('automation-email-template:'||app.current_tenant_id()::text||':'||${input.emailId},0))`);
    const[current]=await tx.execute<{revision:number;module:string;retired:boolean}>(sql`select revision,module,retired from automation_email_template_version where tenant_id=app.current_tenant_id() and template_id=${input.emailId}::uuid order by revision desc limit 1`);
    if(!current||current.module!=='probation'||current.retired)throw new AutomationError('forbidden','Email template unavailable.');
    if(current.revision!==input.revision)throw new AutomationError('conflict','This template changed. Reload before uploading.');
    const hash=createHash('sha256').update(content).digest('hex');
    const[existing]=await tx.execute<AssetRow>(sql`select *,octet_length(content) as size from automation_email_asset where tenant_id=app.current_tenant_id() and template_id=${input.emailId}::uuid and kind=${input.kind} and filename=${input.name} and content_hash=${hash} order by created_at,id limit 1`);
    if(existing)return metadata(existing);
    const[count]=await tx.execute<{n:number}>(sql`select count(*)::int as n from automation_email_asset where tenant_id=app.current_tenant_id() and template_id=${input.emailId}::uuid`);
    if(count.n>=100)throw new AutomationError('invalid','This template has reached its upload limit.');
    const[row]=await tx.execute<AssetRow>(sql`insert into automation_email_asset(tenant_id,template_id,module,kind,filename,mime_type,content,uploaded_by,uploaded_by_name) select app.current_tenant_id(),${input.emailId}::uuid,'probation',${input.kind},${input.name},${mimeType},decode(${content.toString('base64')},'base64'),app.current_user_id(),coalesce(p.full_name,'User') from app_user u left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=app.current_user_id() and u.tenant_id=app.current_tenant_id() returning *,octet_length(content) as size`);
    return metadata(row);
  });
}
function downloadProbationAutomationEmailAsset(ctx:SessionContext,id:string){
  if(!uuid.test(id))throw new AutomationError('invalid','File unavailable.');
  return withScopedLifecycleTenant(ctx,async tx=>{
    const[row]=await tx.execute<{filename:string;mime_type:string;bytes:string}>(sql`select filename,mime_type,encode(content,'base64') as bytes from automation_email_asset where tenant_id=app.current_tenant_id() and id=${id}::uuid`);
    if(!row)return null;
    return{name:row.filename,mimeType:row.mime_type,content:Buffer.from(row.bytes,'base64')};
  });
}

type SharedAutomationAssetUpload=z.infer<typeof uploadSchema>&{content:Buffer};
type ProbationAutomationAssetUpload=Parameters<typeof uploadProbationAutomationEmailAsset>[1];
/** Both immutable stores retain their own authority and receipt protocol. */
export function uploadAutomationEmailAsset(ctx:SessionContext,input:SharedAutomationAssetUpload):Promise<AutomationEmailAsset>;
export function uploadAutomationEmailAsset(ctx:SessionContext,input:ProbationAutomationAssetUpload):Promise<EmailAsset>;
export function uploadAutomationEmailAsset(ctx:SessionContext,input:SharedAutomationAssetUpload|ProbationAutomationAssetUpload){
 return 'emailId' in input?uploadProbationAutomationEmailAsset(ctx,input):uploadSharedAutomationEmailAsset(ctx,input);
}
export async function downloadAutomationEmailAsset(ctx:SessionContext,id:string):Promise<{name:string;mimeType:string;content:Buffer}>{
 const probation=await downloadProbationAutomationEmailAsset(ctx,id);
 return probation??downloadSharedAutomationEmailAsset(ctx,id);
}
