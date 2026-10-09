'use client';
import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Camera, LogIn, LogOut } from 'lucide-react';
import { Card, Button } from '@/components/ui';
import { formatMinutesToHM } from '@/lib/overtime-duration';
import type { ownClockToday } from '@/core/attendance-clock-read';
export type PunchEvent = { time:string; direction:'in'|'out' };
type Today=Awaited<ReturnType<typeof ownClockToday>>;
type Geo={lat:number;lng:number;accuracy:number};
const locate=()=>new Promise<Geo>((resolve,reject)=>navigator.geolocation.getCurrentPosition(p=>resolve({lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy}),reject,{enableHighAccuracy:true,timeout:12000,maximumAge:0}));

/**
 * r430 (board item b8ca6efe) — Web Clocking redesigned:
 *  - The Switch link and shiftOptions are GONE. Current Shift is always the read-only value already
 *    resolved server-side (today.shift / shiftName) — nothing on this screen can change it.
 *  - Clock In and Clock Out are both ALWAYS clickable (`blocked` no longer depends on clock state), in any
 *    order; the server (core/attendance.ts) now accepts and stores an out-first day instead of refusing it.
 *  - The registered-device badge, the Register card, and every device-token plumbing (lib/device-token.ts,
 *    registerDeviceAction) are GONE from this screen. components/attendance-clock-button.tsx (the separate
 *    "/me" quick-clock card) is UNTOUCHED and still registers/presents a device there.
 *  - The camera step is now conditional on the employee's own attendancePhotoSetting (read server-side,
 *    never decided by this component): 'required' keeps the old always-open-camera behaviour; 'optional'
 *    shows a small inline Take Photo / Skip Photo choice before opening the camera; 'not_required' submits
 *    directly with no camera UI and the Attendance Photo card is not rendered at all.
 */
export function ClockPageClient({initial,shiftName}:{initial:Today;shiftName:string|null}) {
  const t=useTranslations('attendance.clock'), locale=useLocale();
  const [today,setToday]=React.useState(initial), [now,setNow]=React.useState<number|null>(null), [synced,setSynced]=React.useState(false);
  const base=React.useRef({server:0,mono:0});
  const refreshSequence=React.useRef(0);
  const [geo,setGeo]=React.useState<Geo|null>(null), [busy,setBusy]=React.useState(false);
  const [action,setAction]=React.useState<'in'|'out'|null>(null), [camera,setCamera]=React.useState(false), [photo,setPhoto]=React.useState<Blob|null>(null), [photoUrl,setPhotoUrl]=React.useState<string|null>(null);
  const [error,setError]=React.useState(''), [success,setSuccess]=React.useState('');
  const video=React.useRef<HTMLVideoElement>(null), stream=React.useRef<MediaStream|null>(null), epoch=React.useRef(0), photoDialog=React.useRef<HTMLDialogElement>(null);
  const [enlarged,setEnlarged]=React.useState<string|null>(null);
  const command=React.useRef<{body:FormData;requestId:string}|null>(null);
  const stop=React.useCallback(()=>{stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;},[]);
  const refresh=React.useCallback(async(nextGeo?:Geo)=>{
    const sequence=++refreshSequence.current;
    const point=nextGeo??geo;
    const params=point?'?'+new URLSearchParams({lat:String(point.lat),lng:String(point.lng),accuracy:String(point.accuracy)}):'';
    const start=performance.now();
    const response=await fetch('/api/attendance/today'+params,{cache:'no-store'});
    if(!response.ok) throw new Error('sync');
    const value:Today=await response.json();
    const clockStart=performance.now();
    const clock=await fetch('/api/time',{cache:'no-store'});if(!clock.ok)throw new Error('sync');
    const clockValue=await clock.json(),end=performance.now();
    if(sequence!==refreshSequence.current)return value;
    base.current={server:Date.parse(clockValue.serverNow)+(end-clockStart)/2,mono:end};setNow(base.current.server);setToday(value);setSynced(true);return value;
  },[geo]);
  const refreshRef=React.useRef(refresh);refreshRef.current=refresh;
  React.useEffect(()=>{
    let live=true;
    locate().then(point=>{if(live){setGeo(point);return refreshRef.current(point);}}).catch(()=>{if(live)setError(t('locationRequired'));});
    const sync=()=>{setSynced(false);refreshRef.current().catch(()=>setError(t('syncFailed')));};sync();
    const focus=()=>{if(document.visibilityState==='visible')sync();};
    const hide=()=>{epoch.current++;if(stream.current)setAction(null);stop();setCamera(false);};
    const tick=setInterval(()=>{if(base.current.server)setNow(base.current.server+performance.now()-base.current.mono);},1000);
    const poll=setInterval(sync,60000);
    window.addEventListener('focus',sync);window.addEventListener('online',sync);document.addEventListener('visibilitychange',focus);window.addEventListener('pagehide',hide);
    return()=>{live=false;epoch.current++;stop();clearInterval(tick);clearInterval(poll);window.removeEventListener('focus',sync);window.removeEventListener('online',sync);document.removeEventListener('visibilitychange',focus);window.removeEventListener('pagehide',hide);};
  },[stop,t]);
  React.useEffect(()=>{if(camera&&video.current&&stream.current){video.current.srcObject=stream.current;void video.current.play().catch(()=>{stop();setCamera(false);setAction(null);setError(t('cameraFailed'));});}},[camera,t,stop]);
  React.useEffect(()=>{if(!photo){setPhotoUrl(null);return;}const url=URL.createObjectURL(photo);setPhotoUrl(url);return()=>URL.revokeObjectURL(url);},[photo]);
  async function openCamera(direction:'in'|'out') {
    const version=++epoch.current;setError('');setSuccess('');setBusy(true);setAction(direction);setPhoto(null);command.current=null;
    try {const next=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});if(version!==epoch.current){next.getTracks().forEach(track=>track.stop());return;}stream.current=next;setCamera(true);}catch{setError(t('cameraFailed'));setAction(null);}finally{setBusy(false);}
  }
  function cancel(){epoch.current++;stop();setCamera(false);setPhoto(null);setAction(null);command.current=null;setError('');}
  function capture(){
    const source=video.current;if(!source?.videoWidth||!source.videoHeight){setError(t('cameraFailed'));return;}
    const canvas=document.createElement('canvas'),scale=Math.min(1,640/source.videoWidth);canvas.width=Math.round(source.videoWidth*scale);canvas.height=Math.round(source.videoHeight*scale);
    canvas.getContext('2d')?.drawImage(source,0,0,canvas.width,canvas.height);
    stop();setCamera(false);
    const version=epoch.current;
    canvas.toBlob(blob=>{if(version!==epoch.current)return;if(!blob){setAction(null);setError(t('cameraFailed'));return;}setPhoto(blob);stop();setCamera(false);},'image/jpeg',.8);
  }
  /** r430 — takes the direction explicitly rather than reading `action` state, so the not_required
   *  direct-submit path (setAction + confirm in the same tick) never races a stale closure. The photo
   *  FormData field is set only when one exists — required/optional-with-photo send it, optional-skip and
   *  not_required never do; the SERVER decides whether that is fatal (AttendancePhotoRequiredError), never
   *  this component. */
  async function confirm(direction:'in'|'out'){
    if(busy)return;setBusy(true);setError('');stop();
    try {
      // Keep the exact request after an uncertain response; retry never changes its proof or intent.
      if(!command.current){const point=await locate();setGeo(point);const value=await refresh(point);if(!value.locationValid)throw new Error('outsideGeofence');const requestId=crypto.randomUUID(),body=new FormData();for(const [key,val] of Object.entries({action:direction,requestId,...point}))body.set(key,String(val));if(photo)body.set('photo',photo,'attendance.jpg');command.current={body,requestId};}
      const response=await fetch('/api/attendance/clock',{method:'POST',body:command.current.body});
      const result=await response.json();
      if(!response.ok){command.current=null;throw new Error(result.error??'photoInvalid');}
      const recorded=new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(result.receipt.recordedAt));
      setSuccess(t(direction==='in'?'savedIn':'savedOut',{time:recorded}));setPhoto(null);setAction(null);command.current=null;await refresh().catch(()=>{setSynced(false);setError(t('syncFailed'));});
    }catch(error){const code=(error as Error).message;setError(t(['outsideGeofence','photoInvalid','photoRequired','conflict','correctedDay'].includes(code)?code:'retryFailed'));}finally{setBusy(false);}
  }
  async function retryLocation(){setBusy(true);try{const point=await locate();setGeo(point);await refresh(point);setError('');}catch{setError(t('locationRequired'));}finally{setBusy(false);}}
  /** r430 — Clock In / Clock Out entry point. BOTH buttons are always enabled (see `blocked`) and route to
   *  one of three flows purely from the employee's own attendancePhotoSetting: required opens the camera
   *  immediately (unchanged); optional sets `action` so the inline Take Photo / Skip Photo choice renders;
   *  not_required submits straight away with no camera UI at all. */
  function startClock(direction:'in'|'out'){
    const setting=today.attendancePhotoSetting;
    if(setting==='required'){void openCamera(direction);return;}
    setError('');setSuccess('');setPhoto(null);command.current=null;
    if(setting==='not_required'){void confirm(direction);return;}
    setAction(direction); // optional — camera stays closed until Take Photo is pressed
  }
  // r430 — deviceValid dropped from `blocked` entirely (there is no device to be valid or not); the GPS
  // precondition (!today.locationValid) is unrelated to this ticket and stays. `today.clockedIn` no longer
  // gates either button — both are always clickable, in any order (the reporter's own requirement).
  const blocked=busy||camera||!!action||!synced||!today.locationValid;
  const time=now==null?'--:--:--':new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now);
  const worked=today.workedSeconds+(today.clockedIn&&now!=null?Math.max(0,Math.floor((now-Date.parse(today.serverNow))/1000)):0);
  const currentIn=today.openSince;
  const showPhotoCard=today.attendancePhotoSetting!=='not_required';
  return <>
    <header><p className="text-xs text-muted-foreground">{t('breadcrumb')}</p><h1 className="text-2xl font-semibold">{t('webTitle')}</h1></header>
    {error&&<p role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive">{error}</p>}
    <div className={`grid gap-5 ${showPhotoCard?'md:grid-cols-2':''}`}>
      <Card className="space-y-5 p-5"><p>{new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',weekday:'long',day:'2-digit',month:'long',year:'numeric'}).format(new Date(today.date+'T12:00:00+08:00'))}</p><div className="flex flex-wrap items-center justify-between gap-2"><span className={`rounded-full px-3 py-1 text-sm ${today.locationValid?'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200':'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'}`}>{t(today.locationValid?(today.geofencingRequired?'withinLocation':'locationRecordedNoGeofence'):geo?'outsideLocation':'locationCheckNeeded')}</span><Button className="min-h-11" onClick={retryLocation} disabled={busy}>{t('checkLocation')}</Button></div>
        {/* r430 — the Switch link and its shiftOptions cycling are GONE: this is always the employee's
            actually-assigned shift, read-only. */}
        <div className="rounded-lg bg-muted/50 p-3"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{t('currentShift')}</span><span className="text-sm">{today.clockedIn?'● '+(currentIn?t('clockedInAt',{time:new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(currentIn))}):t('punchIn')):'○ '+t('statusNotClockedIn')}</span></div><p className="mt-1 text-sm">{(today.shift.code===initial.shift.code?shiftName:today.shift.code)??t('noShiftAssigned')} · {today.shift.start??'—'} → {today.shift.end??'—'}</p></div>
        <div className="text-center"><p className="text-xs font-semibold tracking-widest text-muted-foreground">{t('serverTimeLabel')}</p><p className="my-2 font-mono text-4xl tabular-nums sm:text-5xl">{time}</p><p className="text-sm">{t('workedToday',{time:formatMinutesToHM(Math.floor(worked/60))})}</p></div>
        {/* r430 — both buttons are ALWAYS enabled (subject only to the technical `blocked` reasons above):
            clocking out with no clock-in first, or clocking in again after a clock-out, are both allowed
            and saved. There is no greyed-out button and no order to follow. */}
        <div className="grid grid-cols-2 gap-3"><button disabled={blocked} onClick={()=>startClock('in')} className="flex min-h-14 items-center justify-center gap-2 rounded-lg bg-[#12795A] px-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-[.35]"><LogIn className="shrink-0" size={20}/><span className="min-w-0 break-words">{t('clockIn')}</span></button><button disabled={blocked} onClick={()=>startClock('out')} className="flex min-h-14 items-center justify-center gap-2 rounded-lg bg-[#B3402A] px-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-[.35]"><LogOut className="shrink-0" size={20}/><span className="min-w-0 break-words">{t('clockOut')}</span></button></div>
        <p role="status" className={`text-sm ${success?'text-emerald-700 dark:text-emerald-300':'text-muted-foreground'}`}>{success||t('photoHelper')}</p>
      </Card>
      {showPhotoCard&&<Card className="flex flex-col gap-4 p-5"><h2 className="font-semibold">{t('photoHeading')}</h2><div className="relative flex min-h-72 flex-1 items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-border bg-muted/30">
        {camera?<><video ref={video} autoPlay playsInline muted className="max-h-96 w-full object-contain"/><div className="pointer-events-none absolute h-3/4 w-1/2 rounded-[50%] border-2 border-white/80"/><span className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs text-white">{t('liveFront')}</span></>:photoUrl?<><img src={photoUrl} alt={t('photoReview')} className="max-h-96 w-full object-contain"/><p className="absolute bottom-0 w-full bg-black/70 p-2 text-center text-xs text-white">{today.date} · {time} · {t(today.locationValid?(today.geofencingRequired?'withinLocation':'locationRecordedNoGeofence'):geo?'outsideLocation':'locationCheckNeeded')}</p></>:action&&today.attendancePhotoSetting==='optional'?<div className="max-w-xs p-5 text-center"><Camera className="mx-auto mb-3 h-10 w-10 text-muted-foreground"/><p className="font-medium">{t('photoOptionalPrompt')}</p></div>:<div className="max-w-xs p-5 text-center"><Camera className="mx-auto mb-3 h-10 w-10 text-muted-foreground"/><p className="font-medium">{t('cameraOff')}</p><p className="mt-2 text-sm text-muted-foreground">{t('cameraHint')}</p></div>}
      </div>{camera?<><p className="text-center text-sm">{t('faceGuide')} · {t(action==='in'?'clockIn':'clockOut')}</p><div className="grid grid-cols-2 gap-3"><Button className="min-h-11" onClick={cancel}>{t('cancelPhoto')}</Button><Button className="min-h-11" onClick={capture}>{t('takePhoto')}</Button></div></>:photo?<div className="grid grid-cols-2 gap-3"><Button className="min-h-11" disabled={busy||command.current!=null} onClick={()=>{if(action)void openCamera(action);}}>{t('retakePhoto')}</Button><Button className={`min-h-11 whitespace-normal ${action==='in'?'bg-[#12795A] hover:bg-[#12795A]/90':'bg-[#B3402A] hover:bg-[#B3402A]/90'} text-white`} disabled={busy} onClick={()=>{if(action)void confirm(action);}}>{t(action==='in'?'confirmIn':'confirmOut')}</Button><Button className="min-h-11" disabled={busy||command.current!=null} onClick={cancel}>{t('cancelPhoto')}</Button></div>:action&&today.attendancePhotoSetting==='optional'?<div className="grid grid-cols-3 gap-3"><Button className="min-h-11" onClick={cancel}>{t('cancelPhoto')}</Button><Button className="min-h-11" disabled={busy} onClick={()=>{if(action)void openCamera(action);}}>{t('takePhoto')}</Button><Button className="min-h-11 whitespace-normal" disabled={busy} onClick={()=>{if(action)void confirm(action);}}>{t('skipPhoto')}</Button></div>:null}</Card>}
    </div>
    <Card className="overflow-hidden"><div className="flex flex-wrap justify-between gap-2 border-b p-4"><h2 className="font-semibold">{t('todayLog')}</h2><Link className="text-sm text-primary" href="/attendance/my-records">{t('viewOverview')}</Link></div>{!today.captures.length&&!today.legacy.length?<p className="p-5 text-sm text-muted-foreground">{t('noPunches')}</p>:<ul className="divide-y">{today.captures.map(c=><li key={c.id} className="grid grid-cols-[48px_1fr] gap-3 p-3 sm:grid-cols-[48px_1fr_1fr_1fr]"><button className="h-12 w-12 overflow-hidden rounded" disabled={!c.photoAvailable} aria-label={t(c.photoAvailable?'openPhoto':'photoUnavailable')} onClick={()=>{setEnlarged(c.id);photoDialog.current?.showModal();}}>{c.photoAvailable?<img src={'/api/attendance/photo/'+c.id+'?thumbnail=1'} alt="" className="h-12 w-12 object-cover"/>:<Camera aria-hidden className="m-auto"/>}</button><span className="self-center text-sm font-medium">{t(c.direction==='in'?'punchIn':'punchOut')} · {new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(c.recordedAt))}</span><span className="col-start-2 text-sm text-muted-foreground sm:col-start-auto">{c.locationName??t('geofencingNotRequired')}</span><span className="col-start-2 text-xs text-muted-foreground sm:col-start-auto">{t(c.photoAvailable?'photoSaved':'photoUnavailable')}</span></li>)}{today.legacy.map((c,i)=><li key={'legacy'+i} className="flex flex-wrap gap-3 p-3 text-sm"><Camera aria-hidden size={18}/><span>{t(c.direction==='in'?'punchIn':'punchOut')} · {c.time}</span><span className="text-muted-foreground">{t('noHistoricalPhoto')}</span></li>)}</ul>}</Card>
    <dialog ref={photoDialog} aria-label={t('photoHeading')} className="max-w-[90vw] rounded-xl bg-background p-4 text-foreground backdrop:bg-black/70"><Button className="min-h-11" onClick={()=>photoDialog.current?.close()}>{t('cancelPhoto')}</Button>{enlarged&&<img src={'/api/attendance/photo/'+enlarged} alt={t('photoHeading')} className="mt-3 max-h-[75vh] max-w-full"/>}</dialog>
  </>;
}
