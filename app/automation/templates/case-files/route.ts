import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {uploadProbationEmailCaseFile} from '@/packs/automation/service';
import {noticeUploadSameOrigin,readNoticeUploadRequest,NoticeUploadRequestError} from '@/lib/notice-upload-request';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export async function POST(request:Request){
 if(!noticeUploadSameOrigin(request))return Response.json({error:'Upload unavailable.'},{status:403,headers});
 try{
  const ctx=await requireScopedLifecycleModule(),data=await readNoticeUploadRequest(request,10*1048576);
  const one=(name:string)=>{const values=data.getAll(name);return values.length===1?values[0]:null;};
  const file=one('file'),caseId=one('caseId'),templateId=one('templateId'),slotId=one('slotId'),revision=one('revision');
  if(!(file instanceof File)||typeof caseId!=='string'||typeof templateId!=='string'||typeof slotId!=='string'||typeof revision!=='string'||!/^\d+$/.test(revision))return Response.json({error:'Choose a case and email file slot.'},{status:400,headers});
  const id=await uploadProbationEmailCaseFile(ctx,{caseId,templateId,slotId,revision:Number(revision),name:file.name,content:Buffer.from(await file.arrayBuffer())});
  return Response.json({id},{status:201,headers});
 }catch(error){
  if(error instanceof NoticeUploadRequestError)return Response.json({error:'Choose a supported file of at most 10 MB.'},{status:error.status,headers});
  return Response.json({error:error instanceof Error&&error.name==='AutomationError'?error.message:'The file could not be uploaded.'},{status:409,headers});
 }
}
