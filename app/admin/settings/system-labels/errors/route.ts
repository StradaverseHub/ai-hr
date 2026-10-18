import { scopedAdmin } from '@/lib/scope';
import { isSameOriginBrowserRequest } from '@/lib/request-origin';
import { previewLabelsAction } from '../import-actions';
import { systemLabelErrorWorkbook } from '@/lib/system-label-workbook';
import { readLabelUploadRequest } from '@/lib/system-label-upload';

/** A normal authenticated download also works in browsers that cannot download Blob URLs. */
export async function POST(request: Request) {
  if (!isSameOriginBrowserRequest(request)) return Response.json({error:'origin'},{status:403});
  await scopedAdmin();
  const upload=await readLabelUploadRequest(request);
  if(!upload.ok)return Response.json({error:upload.error},{status:upload.status});
  const data=upload.data;
  const preview=await previewLabelsAction(data);
  if(!preview.ok)return Response.json({error:preview.message},{status:400});
  return new Response(new Uint8Array(systemLabelErrorWorkbook(preview.preview.rows)),{headers:{
    'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition':'attachment; filename="system-labels-errors.xlsx"',
    'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
  }});
}
