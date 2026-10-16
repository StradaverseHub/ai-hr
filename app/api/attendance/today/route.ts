import {ownEmploymentSelection,OwnEmploymentSelectionError} from '@/lib/own-employment-selection';
import { clockApiSession } from '@/lib/attendance-clock-session';
import { ownClockToday } from '@/packs/attendance/service';
export async function GET(request:Request) {
  const session=await clockApiSession();
  if(!session) return Response.json({error:'authentication'},{status:401});
  const url=new URL(request.url);
  if([...url.searchParams.keys()].some(key=>!['lat','lng','accuracy','employmentId'].includes(key))||['lat','lng','accuracy','employmentId'].some(key=>url.searchParams.getAll(key).length>1)||(url.searchParams.has('employmentId')&&!ownEmploymentSelection.safeParse(url.searchParams.get('employmentId')).success))return Response.json({error:'invalid'},{status:400});
  const supplied=['lat','lng','accuracy'].every(k=>url.searchParams.has(k) && url.searchParams.get(k)!.trim()!=='');
  const geo=supplied?{lat:Number(url.searchParams.get('lat')),lng:Number(url.searchParams.get('lng')),accuracy:Number(url.searchParams.get('accuracy'))}:undefined;
  // r430 — the x-clock-device header and deviceToken param are GONE (Web Clocking no longer registers or
  // presents a device).
  try{return Response.json(await ownClockToday(session,geo,url.searchParams.get('employmentId')??undefined),{headers:{'Cache-Control':'private, no-store'}});}catch(error){if(error instanceof OwnEmploymentSelectionError)return Response.json({error:'accountChanged'},{status:409,headers:{'Cache-Control':'private, no-store'}});throw error;}
}
