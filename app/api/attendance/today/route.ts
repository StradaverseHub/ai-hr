import { clockApiSession } from '@/lib/attendance-clock-session';
import { ownClockToday } from '@/packs/attendance/service';
export async function GET(request:Request) {
  const session=await clockApiSession();
  if(!session) return Response.json({error:'authentication'},{status:401});
  const url=new URL(request.url);
  const supplied=['lat','lng','accuracy'].every(k=>url.searchParams.has(k) && url.searchParams.get(k)!.trim()!=='');
  const geo=supplied?{lat:Number(url.searchParams.get('lat')),lng:Number(url.searchParams.get('lng')),accuracy:Number(url.searchParams.get('accuracy'))}:undefined;
  // r430 — the x-clock-device header and deviceToken param are GONE (Web Clocking no longer registers or
  // presents a device).
  return Response.json(await ownClockToday(session,geo),{headers:{'Cache-Control':'private, no-store'}});
}
