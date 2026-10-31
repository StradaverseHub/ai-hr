import { getSession } from '@/lib/session';
import { getTestingScreenshot } from '@/core/system-testing';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}) {
  const ctx=await getSession(),{id}=await params,shot=await getTestingScreenshot(ctx,id);
  if(!shot)return new Response(null,{status:404});
  const fileName=encodeURIComponent(shot.fileName).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  return new Response(new Uint8Array(shot.content),{headers:{'content-type':shot.mimeType,'content-disposition':`attachment; filename*=UTF-8''${fileName}`,'content-length':String(shot.content.length),'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
}
