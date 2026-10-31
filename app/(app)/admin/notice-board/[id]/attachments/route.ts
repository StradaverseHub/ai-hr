import {getSession} from '@/lib/session';
import {addNoticeAttachment,noticeAttachmentUploadState,NoticeAttachmentError,NOTICE_ATTACHMENT_MAX_BYTES} from '@/core/notice';
import {noticeUploadSameOrigin,readNoticeUploadRequest,NoticeUploadRequestError} from '@/lib/notice-upload-request';
const response=(body:unknown,status:number)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
/** Upload immutable, private bytes first. The Notice editor selects their IDs on its explicit CAS save. */
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 if(!noticeUploadSameOrigin(request))return response({error:'unavailable'},403);
 const ctx=await getSession(),{id}=await params;
 if(!await noticeAttachmentUploadState(ctx,id))return response({error:'unavailable'},404);
 try{
  const data=await readNoticeUploadRequest(request,NOTICE_ATTACHMENT_MAX_BYTES);
  const one=(name:string)=>{const values=data.getAll(name);return values.length===1?values[0]:null;};
  const file=one('file'),uploadKey=one('uploadKey'),version=one('contentVersion');
  if(!(file instanceof File)||typeof uploadKey!=='string'||typeof version!=='string'||!/^\d+$/.test(version))return response({error:'file'},400);
  if(!file.size||file.size>NOTICE_ATTACHMENT_MAX_BYTES)return response({error:'tooLarge'},413);
  const result=await addNoticeAttachment(ctx,id,Number(version),{uploadKey,fileName:file.name,content:Buffer.from(await file.arrayBuffer())},{attach:false});
  return response(result,201);
 }catch(error){
  if(error instanceof NoticeUploadRequestError)return response({error:error.reason},error.status);
  if(error instanceof NoticeAttachmentError)return response({error:error.reason},error.reason==='unavailable'?404:error.reason==='file'?400:409);
  return response({error:'failed'},500);
 }
}
