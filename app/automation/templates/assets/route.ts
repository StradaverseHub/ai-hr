import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {uploadAutomationEmailAsset,AutomationError} from '@/packs/automation/service';
import {noticeUploadSameOrigin,readNoticeUploadRequest,NoticeUploadRequestError} from '@/lib/notice-upload-request';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const reply=(body:unknown,status:number)=>Response.json(body,{status,headers});
export async function POST(request:Request){
 if(!noticeUploadSameOrigin(request))return reply({error:'Upload unavailable.'},403);
 try{
  const ctx=await requireScopedLifecycleModule(),data=await readNoticeUploadRequest(request,10*1048576);
  const one=(key:string)=>{const values=data.getAll(key);return values.length===1?values[0]:null;};
  const file=one('file'),templateId=one('templateId'),module=one('module'),revision=one('revision'),kind=one('kind'),caseId=one('caseId'),slotId=one('slotId'),prerequisiteId=one('prerequisiteId');
  if(!(file instanceof File)||typeof templateId!=='string'||!['contract_staff','probation'].includes(String(module))||typeof revision!=='string'||!/^[1-9]\d*$/.test(revision)||!['file','image'].includes(String(kind)))return reply({error:'Choose a file and a saved template.'},400);
  if(data.getAll('prerequisiteId').length>1||(data.has('prerequisiteId')&&typeof prerequisiteId!=='string'))return reply({error:'Choose one waiting email version.'},400);
  const asset=await uploadAutomationEmailAsset(ctx,{templateId,module:module as 'contract_staff'|'probation',revision:Number(revision),kind:kind as 'file'|'image',name:file.name,content:Buffer.from(await file.arrayBuffer()),...(typeof caseId==='string'?{caseId}:{}),...(typeof slotId==='string'?{slotId}:{}),...(typeof prerequisiteId==='string'?{prerequisiteId}:{})});
  return reply({asset},201);
 }catch(error){
  if(error instanceof NoticeUploadRequestError)return reply({error:error.reason==='tooLarge'?'Use a file of at most 10 MB; email images can be up to 1 MB.':'Invalid upload.'},error.status);
  return reply({error:error instanceof AutomationError?error.message:'The file could not be uploaded. Reload and try again.'},error instanceof AutomationError&&error.code==='forbidden'?403:409);
 }
}
