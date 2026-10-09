import { clockApiSession } from '@/lib/attendance-clock-session';
import { captureEmployeeClock, ClockConflictError, CorrectedClockConflictError, ClockLocationError, AttendancePhotoRequiredError } from '@/packs/attendance/service';
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
    // r430 — deviceToken is GONE from the contract entirely (the client no longer sends one); 'photo' is
    // now OPTIONAL (0 or 1) — whether one is required is decided server-side from the employee's own
    // attendance_photo_setting (core/attendance-clock.ts), never from whether the client sent one.
    const keys=['action','requestId','lat','lng','accuracy','photo'];
    if([...data.keys()].some(k=>!keys.includes(k))) throw new Error('Invalid request');
    for (const k of keys) { const n=data.getAll(k).length; if (k==='photo' ? n>1 : n!==1) throw new Error('Invalid request'); }
    const photoField=data.get('photo');
    const photo = photoField instanceof File ? photoField : null;
    for(const key of ['lat','lng','accuracy']) if(!String(data.get(key)).trim()) throw new Error('Missing location');
    const receipt=await captureEmployeeClock(session,{action:String(data.get('action')) as 'in'|'out',requestId:String(data.get('requestId')),lat:Number(data.get('lat')),lng:Number(data.get('lng')),accuracy:Number(data.get('accuracy')),photo:photo?Buffer.from(await photo.arrayBuffer()):undefined,mime:photo?photo.type:undefined});
    return Response.json({receipt},{headers:{'Cache-Control':'private, no-store'}});
  } catch(error) {
    const code=error instanceof CorrectedClockConflictError?'correctedDay':error instanceof ClockConflictError?'conflict':error instanceof AttendancePhotoRequiredError?'photoRequired':error instanceof OutsideGeofenceError?'outsideGeofence':error instanceof GeolocationRequiredError || error instanceof ClockLocationError?'locationRequired':'photoInvalid';
    return Response.json({error:code},{status:error instanceof ClockConflictError?409:400,headers:{'Cache-Control':'private, no-store'}});
  }
}
