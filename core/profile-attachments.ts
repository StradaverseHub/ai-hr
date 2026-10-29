import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {profileChangeAttachment} from '../db/schema';
import {personnelField} from '../lib/personnel-field-registry';
import {EssProfileError} from '../lib/personnel-ess-model';
import {PROFILE_ATTACHMENT_MAX_BYTES,PROFILE_ATTACHMENT_MAX_FILES,type ProfileAttachmentInput} from '../lib/profile-attachment';
export function validateProfileAttachments(raw:ProfileAttachmentInput[]){
 if(!Array.isArray(raw)||raw.length>PROFILE_ATTACHMENT_MAX_FILES)throw new EssProfileError('invalid');
 let total=0;
 return raw.map(file=>{
  if(!file||typeof file.fileName!=='string'||!file.fileName.trim()||file.fileName.length>200||/[\\/\u0000-\u001f]/.test(file.fileName)||typeof file.contentBase64!=='string'||file.contentBase64.length>Math.ceil(PROFILE_ATTACHMENT_MAX_BYTES/3)*4||!Array.isArray(file.fieldIds)||!file.fieldIds.length||file.fieldIds.length>128||new Set(file.fieldIds).size!==file.fieldIds.length||file.fieldIds.some(id=>!personnelField(id)?.ess.binding))throw new EssProfileError('invalid');
  const bytes=Buffer.from(file.contentBase64,'base64');total+=bytes.length;
  if(!bytes.length||bytes.length>PROFILE_ATTACHMENT_MAX_BYTES||total>10*1024*1024||bytes.toString('base64')!==file.contentBase64)throw new EssProfileError('invalid');
  const valid=file.mimeType==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':file.mimeType==='image/png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':file.mimeType==='image/jpeg'?bytes.subarray(0,3).toString('hex')==='ffd8ff':false;
  if(!valid)throw new EssProfileError('invalid');
  return {fieldIds:[...file.fieldIds],fileName:file.fileName.trim(),mimeType:file.mimeType,content:bytes};
 });
}
export async function saveProfileAttachmentsTx(tx:Tx,ctx:SessionContext,requestId:string,files:ReturnType<typeof validateProfileAttachments>){
 for(const file of files)await tx.insert(profileChangeAttachment).values({tenantId:ctx.tenantId,requestId,fieldIds:file.fieldIds,fileName:file.fileName,mimeType:file.mimeType,content:file.content,sizeBytes:file.content.length});
}
export function readProfileAttachment(ctx:SessionContext,id:string){return withTenant(ctx,async tx=>{
 if(!/^[0-9a-f-]{36}$/i.test(id))throw new EssProfileError('invalid');
 const [file]=await tx.select({fileName:profileChangeAttachment.fileName,mimeType:profileChangeAttachment.mimeType,content:profileChangeAttachment.content}).from(profileChangeAttachment).where(and(eq(profileChangeAttachment.id,id),eq(profileChangeAttachment.tenantId,ctx.tenantId))).limit(1);
 if(!file)throw new EssProfileError('permission');return file;
});}
export function listProfileAttachments(ctx:SessionContext,requestId:string){return withTenant(ctx,tx=>tx.select({id:profileChangeAttachment.id,fileName:profileChangeAttachment.fileName,fieldIds:profileChangeAttachment.fieldIds}).from(profileChangeAttachment).where(and(eq(profileChangeAttachment.tenantId,ctx.tenantId),eq(profileChangeAttachment.requestId,requestId))).orderBy(profileChangeAttachment.createdAt,profileChangeAttachment.id));}
