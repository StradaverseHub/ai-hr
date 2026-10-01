import { clockApiSession } from '@/lib/attendance-clock-session';
import { clockCapturePhoto } from '@/packs/attendance/service';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  const session=await clockApiSession();
  if(!session) return Response.json({error:'authentication'},{status:401});
  const {id}=await params;
  const photo=await clockCapturePhoto(session,id,new URL(request.url).searchParams.get('thumbnail')==='1');
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Type':'image/jpeg'};
  if(!photo) return new Response(null,{status:404,headers});
  if(!photo.bytes) return new Response(null,{status:410,headers});
  return new Response(new Uint8Array(photo.bytes),{headers});
}
