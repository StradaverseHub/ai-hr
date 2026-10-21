import { clockApiSession } from '@/lib/attendance-clock-session';
import { ownClockToday,OwnClockEmploymentUnavailableError } from '@/packs/attendance/service';
export async function GET(request:Request) {
  const session=await clockApiSession();
  if(!session) return Response.json({error:'authentication'},{status:401});
  const url=new URL(request.url);
  if(url.searchParams.getAll('employmentId').length>1||url.searchParams.has('employmentId')&&!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(url.searchParams.get('employmentId')!))return Response.json({error:'invalid'},{status:400});
  const supplied=['lat','lng','accuracy'].every(k=>url.searchParams.has(k) && url.searchParams.get(k)!.trim()!=='');
  const geo=supplied?{lat:Number(url.searchParams.get('lat')),lng:Number(url.searchParams.get('lng')),accuracy:Number(url.searchParams.get('accuracy'))}:undefined;
  // r430 — the x-clock-device header and deviceToken param are GONE (Web Clocking no longer registers or
  // presents a device).
  try{return Response.json(await ownClockToday(session,geo,url.searchParams.get('employmentId')??undefined),{headers:{'Cache-Control':'private, no-store'}});}
  catch(error){if(error instanceof OwnClockEmploymentUnavailableError)return Response.json({error:'accountChanged'},{status:403,headers:{'Cache-Control':'private, no-store'}});throw error;}
}
