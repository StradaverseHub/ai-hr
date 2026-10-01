import { clockApiSession } from '@/lib/attendance-clock-session';
import { captureEmployeeClock, ClockConflictError, ClockLocationError } from '@/packs/attendance/service';
import { DeviceNotRegisteredError } from '@/packs/attendance/service';
import { GeolocationRequiredError, OutsideGeofenceError } from '@/packs/attendance/service';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({error:'origin'},{status:403});
  const session = await clockApiSession();
  if(!session) return Response.json({error:'authentication'},{status:401});
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) return Response.json({error:'invalid'},{status:400});
  // Stream-bound the multipart body too: Content-Length alone is not trusted.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({error:'invalid'},{status:400});
  const chunks: Uint8Array[] = []; let size=0;
  for (;;) { const chunk=await reader.read(); if(chunk.done) break; size+=chunk.value.byteLength; if(size>3*1024*1024){await reader.cancel();return Response.json({error:'photoInvalid'},{status:413});} chunks.push(chunk.value); }
  try {
    const data = await new Response(Buffer.concat(chunks.map(c=>Buffer.from(c))),{headers:{'Content-Type':request.headers.get('content-type')!}}).formData();
    const keys=['action','requestId','deviceToken','lat','lng','accuracy','photo'];
    if([...data.keys()].some(k=>!keys.includes(k)) || keys.some(k=>data.getAll(k).length!==1)) throw new Error('Invalid request');
    const photo=data.get('photo');
    if(!(photo instanceof File)) throw new Error('Invalid photo');
    for(const key of ['lat','lng','accuracy']) if(!String(data.get(key)).trim()) throw new Error('Missing location');
    const receipt=await captureEmployeeClock(session,{action:String(data.get('action')) as 'in'|'out',requestId:String(data.get('requestId')),deviceToken:String(data.get('deviceToken')),lat:Number(data.get('lat')),lng:Number(data.get('lng')),accuracy:Number(data.get('accuracy')),photo:Buffer.from(await photo.arrayBuffer()),mime:photo.type});
    return Response.json({receipt},{headers:{'Cache-Control':'private, no-store'}});
  } catch(error) {
    const code=error instanceof ClockConflictError?'conflict':error instanceof DeviceNotRegisteredError?'deviceRequired':error instanceof OutsideGeofenceError?'outsideGeofence':error instanceof GeolocationRequiredError || error instanceof ClockLocationError?'locationRequired':'photoInvalid';
    return Response.json({error:code},{status:error instanceof ClockConflictError?409:400,headers:{'Cache-Control':'private, no-store'}});
  }
}
