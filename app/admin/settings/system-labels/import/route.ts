import { scopedAdmin } from '@/lib/scope';
import { isSameOriginBrowserRequest } from '@/lib/request-origin';
import { readLabelUploadRequest } from '@/lib/system-label-upload';
import { previewLabelsAction,importLabelsAction } from '../import-actions';
/** Streamed upload supports the bounded 5 MB workbook without raising every server-action limit. */
export async function POST(request:Request){
  if(!isSameOriginBrowserRequest(request))return Response.json({ok:false,message:'origin'},{status:403});
  await scopedAdmin();
  const upload=await readLabelUploadRequest(request);
  if(!upload.ok)return Response.json({ok:false,message:upload.error},{status:upload.status});
  const operation=upload.data.get('operation');
  if(operation!=='preview'&&operation!=='apply')return Response.json({ok:false,message:'invalid'},{status:400});
  const result=operation==='preview'?await previewLabelsAction(upload.data):await importLabelsAction(upload.data);
  return Response.json(result,{status:result.ok?200:400,headers:{'Cache-Control':'private, no-store'}});
}
