import { scopedAdmin } from '@/lib/scope';
import { isSameOriginBrowserRequest } from '@/lib/request-origin';
import { previewLabelsAction } from '../import-actions';
import { systemLabelErrorWorkbook } from '@/lib/system-label-workbook';

/** A normal authenticated download also works in browsers that cannot download Blob URLs. */
export async function POST(request: Request) {
  if (!isSameOriginBrowserRequest(request)) return Response.json({error:'origin'},{status:403});
  await scopedAdmin();
  const reader=request.body?.getReader();
  if(!reader||!request.headers.get('content-type')?.startsWith('multipart/form-data')) return Response.json({error:'invalid'},{status:400});
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;
    if(size>1024*1024){await reader.cancel();return Response.json({error:'tooLarge'},{status:413});}chunks.push(chunk.value);}
  let data:FormData;
  try{data=await new Response(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))),{headers:{'Content-Type':request.headers.get('content-type')!}}).formData();}
  catch{return Response.json({error:'invalid'},{status:400});}
  const preview=await previewLabelsAction(data);
  if(!preview.ok)return Response.json({error:preview.message},{status:400});
  return new Response(new Uint8Array(systemLabelErrorWorkbook(preview.preview.rows)),{headers:{
    'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition':'attachment; filename="system-labels-errors.xlsx"',
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
  }});
}
