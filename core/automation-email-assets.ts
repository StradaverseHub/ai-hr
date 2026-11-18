import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {AutomationError} from './automation-store';
import {resolveDocumentUpload} from './employee-documents';
import type {EmailAsset} from '../lib/lifecycle-v9-model';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type AssetRow={id:string;kind:'file'|'image';filename:string;mime_type:string;size:number;content_hash:string;created_at:string;uploaded_by_name:string};
const metadata=(row:AssetRow):EmailAsset=>({id:row.id,kind:row.kind,name:row.filename,mimeType:row.mime_type,size:Number(row.size),contentHash:row.content_hash,at:new Date(row.created_at).toISOString(),by:row.uploaded_by_name});

/** Immutable upload receipts belong to one canonical Probation email, never the V9 configuration. */
export async function uploadAutomationEmailAsset(ctx:SessionContext,input:{emailId:string;revision:number;kind:'image'|'file';name:string;content:Buffer}):Promise<EmailAsset>{
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
export function downloadAutomationEmailAsset(ctx:SessionContext,id:string){
  if(!uuid.test(id))throw new AutomationError('invalid','File unavailable.');
  return withScopedLifecycleTenant(ctx,async tx=>{
    const[row]=await tx.execute<{filename:string;mime_type:string;bytes:string}>(sql`select filename,mime_type,encode(content,'base64') as bytes from automation_email_asset where tenant_id=app.current_tenant_id() and id=${id}::uuid`);
    if(!row)throw new AutomationError('forbidden','File unavailable.');
    return{name:row.filename,mimeType:row.mime_type,content:Buffer.from(row.bytes,'base64')};
  });
}
