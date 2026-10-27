'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { requestClockRemovalAction } from './actions';
import { fmtCoord, osmPointHref } from '@/components/attendance-format';
import type { LocationCaptureStatus } from '@/lib/attendance-removal';
import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Camera, LogIn, LogOut } from 'lucide-react';
import { Card, Button } from '@/components/ui';
import { formatMinutesToHM } from '@/lib/overtime-duration';
import {liveClockSeconds} from '@/lib/clock-elapsed';
import type { ownClockToday } from '@/core/attendance-clock-read';
export type PunchEvent = { time:string; direction:'in'|'out' };
type Today=Awaited<ReturnType<typeof ownClockToday>>;
export type ClockingConfirmation={recordedAt:string;direction:'in'|'out'};
type ClockViewProps={initial:Today;shiftName:string|null;employmentId?:string;embedded?:boolean;initialAction?:'in'|'out';
  onSaved?:(receipt:ClockingConfirmation)=>void;onBusyChange?:(busy:boolean)=>void};
type Geo={lat:number;lng:number;accuracy:number};
const locate=(timeout=12000)=>new Promise<Geo>((resolve,reject)=>{
  if (!navigator.geolocation) { reject(new Error('locationUnsupported')); return; }
  navigator.geolocation.getCurrentPosition(p=>resolve({lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy}),e=>reject(new Error(e.code===1?'locationDenied':e.code===3?'locationTimeout':'locationUnavailable')),{enableHighAccuracy:true,timeout,maximumAge:0});
});
function newRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

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
 *    opens the camera immediately and retains Skip Photo; 'not_required' submits
 *    directly with no camera UI and the Attendance Photo card is not rendered at all.
 */
export function ClockPageClient(props:ClockViewProps){
  return <ClockFlow key={props.employmentId??'legacy'} {...props}/>;
}
function ClockFlow({initial,shiftName,employmentId,embedded=false,initialAction,onSaved,onBusyChange}:ClockViewProps) {
  const t=useTranslations('attendance.clock'), locale=useLocale();
  const [today,setToday]=React.useState(initial), [now,setNow]=React.useState<number|null>(null), [synced,setSynced]=React.useState(false);
  const [removing,setRemoving]=React.useState<Today['captures'][number]|null>(null),[removalReason,setRemovalReason]=React.useState(''),[removalError,setRemovalError]=React.useState(''),[removalBusy,setRemovalBusy]=React.useState(false);
  const removalSnapshot=React.useRef({baseline:initial.removalBaseline,clockContext:initial.clockContext});
  const removalCommand=React.useRef<{punchId:string;requestId:string;baseline:string;reason:string;clockContext:string;employmentId?:string}|null>(null),removalFlight=React.useRef(false),removalTrigger=React.useRef<HTMLButtonElement|null>(null);
  async function removeClock(){
    if(!removing?.punchId||removalFlight.current)return;
    removalFlight.current=true;setRemovalBusy(true);setRemovalError('');
    removalCommand.current??={punchId:removing.punchId,requestId:newRequestId(),baseline:removalSnapshot.current.baseline,reason:removalReason,clockContext:removalSnapshot.current.clockContext,...(employmentId!==undefined?{employmentId}:{})};
    try{const result=await requestClockRemovalAction(removalCommand.current);if(!result.ok){removalCommand.current=null;setRemovalError(result.message);return;}removalCommand.current=null;setRemoving(null);setSuccess(t('removalRequested'));await refresh();}
    catch{setRemovalError(t('removalUnconfirmed'));}
    finally{removalFlight.current=false;setRemovalBusy(false);}
  }
  const base=React.useRef({server:0,mono:0});
  const refreshSequence=React.useRef(0);
  const [geo,setGeo]=React.useState<Geo|null>(null), [busy,setBusy]=React.useState(false);
  const [action,setAction]=React.useState<'in'|'out'|null>(null), [camera,setCamera]=React.useState(false), [photo,setPhoto]=React.useState<Blob|null>(null), [photoUrl,setPhotoUrl]=React.useState<string|null>(null);
  const [error,setError]=React.useState(''), [success,setSuccess]=React.useState('');
  const [cameraProblem,setCameraProblem]=React.useState(false);
  const video=React.useRef<HTMLVideoElement>(null), stream=React.useRef<MediaStream|null>(null), epoch=React.useRef(0), photoDialog=React.useRef<HTMLDialogElement>(null);
  const [enlarged,setEnlarged]=React.useState<string|null>(null);
  const command=React.useRef<{body:FormData;requestId:string;direction:'in'|'out'}|null>(null);
  const inFlight=React.useRef(false);
  const [pending,setPending]=React.useState(false);
  const [initialLocationReady,setInitialLocationReady]=React.useState(false),autoStarted=React.useRef(false);
  React.useEffect(()=>{onBusyChange?.(busy||pending);},[busy,pending,onBusyChange]);
  React.useEffect(()=>{if(!pending)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[pending]);
  const stop=React.useCallback(()=>{stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;},[]);
  const refresh=React.useCallback(async(nextGeo?:Geo|null)=>{
    const sequence=++refreshSequence.current;
    const point=nextGeo===undefined?geo:nextGeo;
    const query=new URLSearchParams(point?{lat:String(point.lat),lng:String(point.lng),accuracy:String(point.accuracy)}:{});
    if(employmentId!==undefined)query.set('employmentId',employmentId);
    const params=query.size?'?'+query.toString():'';
    const response=await fetch('/api/attendance/today'+params,{cache:'no-store'});
    if(!response.ok) throw new Error(response.status===401?'authentication':'sync');
    const value:Today=await response.json();
    const clockStart=performance.now();
    const clock=await fetch('/api/time',{cache:'no-store'});if(!clock.ok)throw new Error('sync');
    const clockValue=await clock.json(),end=performance.now();
    if(sequence!==refreshSequence.current)return value;
    base.current={server:Date.parse(clockValue.serverNow)+(end-clockStart)/2,mono:end};setNow(base.current.server);setToday(value);setSynced(true);return value;
  },[geo,employmentId]);
  const refreshRef=React.useRef(refresh);refreshRef.current=refresh;
  const todayRef=React.useRef(today);todayRef.current=today;
  React.useEffect(()=>{
    let live=true;
    locate(embedded&&!todayRef.current.geofencingRequired?2000:12000).then(point=>{if(live){setGeo(point);return refreshRef.current(point);}}).catch(error=>{if(!live)return;if(todayRef.current.geofencingRequired || error.message==='authentication')setError(t(['locationDenied','locationUnavailable','locationTimeout','locationUnsupported','authentication'].includes(error.message)?error.message:'syncFailed'));else{setGeo(null);void refreshRef.current(null).catch(()=>setError(t('syncFailed')));}}).finally(()=>{if(live)setInitialLocationReady(true);});
    const sync=()=>{setSynced(false);refreshRef.current().catch(error=>setError(t(error.message==='authentication'?'authentication':'syncFailed')));};sync();
    const focus=()=>{if(document.visibilityState==='visible')sync();};
    const hide=()=>{epoch.current++;if(stream.current)setAction(null);stop();setCamera(false);};
    const tick=setInterval(()=>{if(base.current.server)setNow(base.current.server+performance.now()-base.current.mono);},1000);
    const poll=setInterval(sync,60000);
    window.addEventListener('focus',sync);window.addEventListener('online',sync);document.addEventListener('visibilitychange',focus);window.addEventListener('pagehide',hide);
    return()=>{live=false;epoch.current++;stop();clearInterval(tick);clearInterval(poll);window.removeEventListener('focus',sync);window.removeEventListener('online',sync);document.removeEventListener('visibilitychange',focus);window.removeEventListener('pagehide',hide);};
  },[stop,t,employmentId,embedded]);
  React.useEffect(()=>{if(camera&&video.current&&stream.current){video.current.srcObject=stream.current;void video.current.play().catch(()=>{stop();setCamera(false);setCameraProblem(true);setError(t('cameraFailed'));});}},[camera,t,stop]);
  React.useEffect(()=>{if(!photo){setPhotoUrl(null);return;}const url=URL.createObjectURL(photo);setPhotoUrl(url);return()=>URL.revokeObjectURL(url);},[photo]);
  async function openCamera(direction:'in'|'out') {
    if(command.current || inFlight.current)return;
    if(!window.isSecureContext){setAction(direction);setCameraProblem(true);setError(t('cameraContext'));return;}
    if(!navigator.mediaDevices?.getUserMedia){setAction(direction);setCameraProblem(true);setError(t('cameraUnavailable'));return;}
    const version=++epoch.current;setCameraProblem(false);setError('');setSuccess('');setBusy(true);setAction(direction);setPhoto(null);command.current=null;
    try {const next=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});if(version!==epoch.current){next.getTracks().forEach(track=>track.stop());return;}stream.current=next;setCamera(true);}catch(error){if(version!==epoch.current)return;setCameraProblem(true);const name=(error as DOMException).name;setError(t(name==='NotAllowedError'?'cameraDenied':name==='NotReadableError'?'cameraBusy':'cameraUnavailable'));}finally{if(version===epoch.current)setBusy(false);}
  }
  function cancel(){if(command.current || inFlight.current)return;epoch.current++;setBusy(false);stop();setCamera(false);setPhoto(null);setAction(null);command.current=null;setCameraProblem(false);setError('');}
  function skipPhoto(){
    if(!action||command.current||inFlight.current)return;
    // Invalidate an unresolved permission prompt; a late stream is stopped by openCamera.
    epoch.current++;stop();setCamera(false);setPhoto(null);setCameraProblem(false);
    void confirm(action);
  }
  function capture(){
    const source=video.current;if(!source?.videoWidth||!source.videoHeight){setCameraProblem(true);setError(t('cameraFailed'));return;}
    const canvas=document.createElement('canvas'),scale=Math.min(1,640/source.videoWidth);canvas.width=Math.round(source.videoWidth*scale);canvas.height=Math.round(source.videoHeight*scale);
    canvas.getContext('2d')?.drawImage(source,0,0,canvas.width,canvas.height);
    stop();setCamera(false);
    const version=epoch.current;
    canvas.toBlob(blob=>{if(version!==epoch.current)return;if(!blob){setCameraProblem(true);setError(t('cameraFailed'));return;}setPhoto(blob);stop();setCamera(false);},'image/jpeg',.8);
  }
  /** r430 — takes the direction explicitly rather than reading `action` state, so the not_required
   *  direct-submit path (setAction + confirm in the same tick) never races a stale closure. The photo
   *  FormData field is set only when one exists — required/optional-with-photo send it, optional-skip and
   *  not_required never do; the SERVER decides whether that is fatal (AttendancePhotoRequiredError), never
   *  this component. */
  async function confirm(direction:'in'|'out'){
    if(inFlight.current)return;
    // Tell an embedding dialog synchronously, before any async command work. It must not close
    // between a command starting and React delivering the busy-state effect.
    onBusyChange?.(true);
    const recovering=command.current!=null;
    inFlight.current=true;setBusy(true);setAction(direction);setError('');stop();
    try {
      let receipt: {recordedAt:string;direction:'in'|'out'} | undefined;
      // A transport failure may follow a committed clocking. Check its own receipt before retrying.
      if(command.current){
        const receiptQuery=new URLSearchParams({requestId:command.current.requestId});
        if(employmentId!==undefined)receiptQuery.set('employmentId',employmentId);
        const check=await fetch('/api/attendance/clock?'+receiptQuery,{cache:'no-store'});
        if(check.status===401)throw new Error('authentication');
        if(check.ok) receipt=(await check.json()).receipt;
        else if(check.status!==404)throw new Error('unconfirmed');
      }
      if(!receipt){
        if(!command.current){
          // Read current policy first. Optional location has a bounded best-effort read and can be
          // explicitly absent; a retained uncertain command never enters this branch or changes bytes.
          let value=await refresh(null),point:Geo|null=null,locationStatus:LocationCaptureStatus='recorded';
          // Home offers a single next action. A stale card must not repeat a clock-in/out that
          // another accepted record has already completed. Receipt recovery above remains first.
          if(embedded&&((direction==='in'&&value.clockedIn)||(direction==='out'&&!value.clockedIn)))throw new Error('conflict');
          try{point=await locate(value.geofencingRequired?12000:2000);}catch(error){if(value.geofencingRequired)throw error;locationStatus=({locationDenied:'denied',locationTimeout:'timeout',locationUnsupported:'unsupported'} as const)[(error as Error).message as 'locationDenied']??'unavailable';}
          setGeo(point);
          if(point)value=await refresh(point);
          if(!value.locationValid)throw new Error('outsideGeofence');
          if(!value.clockContext)throw new Error('sync');
          const requestId=newRequestId(),body=new FormData();
          body.set('clockContext',value.clockContext);body.set('locationStatus',locationStatus);
          if(employmentId!==undefined)body.set('employmentId',employmentId);
          for(const [key,val] of Object.entries({action:direction,requestId,...(point??{})}))body.set(key,String(val));
          if(photo)body.set('photo',photo,'attendance.jpg');
          command.current={body,requestId,direction};setPending(true);
        }
        const response=await fetch('/api/attendance/clock',{method:'POST',body:command.current.body});
        // Non-JSON, 5xx and authentication responses cannot prove that the original command failed.
        if(response.status===401)throw new Error('authentication');
        if(response.status>=500)throw new Error('unconfirmed');
        const result=await response.json();
        if(!response.ok){
          if(result.error==='accountChanged')throw new Error('accountChanged');
          const definite=['integrityRequired','origin','invalid','photoInvalid','photoRequired','outsideGeofence','locationRequired','conflict','correctedDay'];
          if(!definite.includes(result.error))throw new Error('unconfirmed');
          // A refusal of this retry cannot prove an earlier uncertain attempt has finished.
          if(!recovering){command.current=null;setPending(false);}
          throw new Error(result.error);
        }
        receipt=result.receipt;
      }
      if(!receipt?.recordedAt || !['in','out'].includes(receipt.direction))throw new Error('unconfirmed');
      const recorded=new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(receipt.recordedAt));
      setSuccess(t(receipt.direction==='in'?'savedIn':'savedOut',{time:recorded}));
      setPhoto(null);setAction(null);command.current=null;setPending(false);
      await refresh().catch(()=>{setSynced(false);setError(t('syncFailed'));});
      onSaved?.({recordedAt:receipt.recordedAt,direction:receipt.direction});
    }catch(error){
      const code=(error as Error).message;
      if(!command.current && today.attendancePhotoSetting==='not_required')setAction(null);
      const known=['integrityRequired','outsideGeofence','photoInvalid','photoRequired','conflict','correctedDay','locationRequired','locationDenied','locationUnavailable','locationTimeout','locationUnsupported','authentication','accountChanged','origin','invalid','sync'];
      setError(t(code==='sync'?'syncFailed':known.includes(code)?code:'retryFailed'));
    }finally{inFlight.current=false;setBusy(false);}
  }
  async function retryLocation(){setBusy(true);try{const point=await locate();setGeo(point);await refresh(point);setError('');}catch(error){const code=(error as Error).message;if(!todayRef.current.geofencingRequired&&['locationDenied','locationUnavailable','locationTimeout','locationUnsupported'].includes(code)){setGeo(null);try{await refresh(null);setError('');}catch{setError(t('syncFailed'));}}else setError(t(['locationDenied','locationUnavailable','locationTimeout','locationUnsupported','authentication'].includes(code)?code:'syncFailed'));}finally{setBusy(false);}}
  /** r430 — Clock In / Clock Out entry point. BOTH buttons are always enabled (see `blocked`) and route to
   *  one of three flows purely from the employee's own attendancePhotoSetting: required opens the camera
   *  immediately; optional also opens the camera and keeps Skip Photo available;
   *  not_required submits straight away with no camera UI at all. */
  function startClock(direction:'in'|'out'){
    if(command.current || inFlight.current)return;
    const setting=today.attendancePhotoSetting;
    if(setting==='required'||setting==='optional'){void openCamera(direction);return;}
    setError('');setSuccess('');setPhoto(null);command.current=null;
    if(setting==='not_required'){void confirm(direction);return;}
    setAction(direction);
  }
  // r430 — deviceValid dropped from `blocked` entirely (there is no device to be valid or not); the GPS
  // precondition (!today.locationValid) is unrelated to this ticket and stays. `today.clockedIn` no longer
  // gates either button — both are always clickable, in any order (the reporter's own requirement).
  const blocked=!!removing||busy||pending||camera||!!action||!synced||!today.locationValid;
  const startRef=React.useRef(startClock);startRef.current=startClock;
  React.useEffect(()=>{
    if(!initialAction||!synced||!initialLocationReady||blocked||autoStarted.current)return;
    autoStarted.current=true;startRef.current(initialAction);
  },[initialAction,synced,initialLocationReady,blocked]);
  const time=now==null?'--:--:--':new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now);
  const worked=liveClockSeconds(today,now??Date.parse(today.serverNow));
  const currentIn=today.openSince;
  const showPhotoCard=today.attendancePhotoSetting!=='not_required';
  return <>
    {!embedded&&<header><p className="text-xs text-muted-foreground">{t('breadcrumb')}</p><h1 className="text-2xl font-semibold">{t('webTitle')}</h1></header>}
    {pending&&<div className="flex flex-wrap items-center gap-3 rounded-lg border p-3"><p className="text-sm">{t('pendingCommand')}</p><Button disabled={busy} onClick={()=>{if(command.current)void confirm(command.current.direction);}}>{t('checkSubmission')}</Button></div>}
    {(error===t('authentication')||error===t('accountChanged'))&&<Link href="/login" target="_blank" rel="noopener noreferrer" className="text-sm underline">{t('signInAgain')}</Link>}
    {error&&<p role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive">{error}</p>}
    <div className={`grid gap-5 ${showPhotoCard?'md:grid-cols-2':''}`}>
      <Card className="space-y-5 p-5"><p>{new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',weekday:'long',day:'2-digit',month:'long',year:'numeric'}).format(new Date(today.date+'T12:00:00+08:00'))}</p><div className="flex flex-wrap items-center justify-between gap-2"><span className={`rounded-full px-3 py-1 text-sm ${today.locationValid?'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200':'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'}`}>{t(today.locationValid?(today.geofencingRequired?'withinLocation':today.locationAvailable?'locationRecordedNoGeofence':'locationUnavailableAllowed'):geo?'outsideLocation':'locationCheckNeeded')}</span><Button className="min-h-11" onClick={retryLocation} disabled={busy}>{t('checkLocation')}</Button></div>
        {/* r430 — the Switch link and its shiftOptions cycling are GONE: this is always the employee's
            actually-assigned shift, read-only. */}
        <div className="rounded-lg bg-muted/50 p-3"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{t('currentShift')}</span><span className="text-sm">{today.clockedIn?'● '+(currentIn?t('clockedInAt',{time:new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(currentIn))}):t('punchIn')):'○ '+t('statusNotClockedIn')}</span></div><p className="mt-1 text-sm">{(today.shift.code===initial.shift.code?shiftName:today.shift.code)??t('noShiftAssigned')} · {today.shift.start??'—'} → {today.shift.end??'—'}</p></div>
        <div className="text-center"><p className="text-xs font-semibold tracking-widest text-muted-foreground">{t('serverTimeLabel')}</p><p className="my-2 font-mono text-4xl tabular-nums sm:text-5xl">{time}</p><p className="text-sm">{t('elapsedToday',{time:formatMinutesToHM(Math.floor(worked/60))})}</p><p className="mt-1 text-xs text-muted-foreground">{t('elapsedHelp')}</p></div>
        {/* r430 — both buttons are ALWAYS enabled (subject only to the technical `blocked` reasons above):
            clocking out with no clock-in first, or clocking in again after a clock-out, are both allowed
            and saved. There is no greyed-out button and no order to follow. */}
        <div className="grid grid-cols-2 gap-3"><button disabled={blocked} onClick={()=>startClock('in')} className="flex min-h-14 items-center justify-center gap-2 rounded-lg bg-[#12795A] px-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-[.35]"><LogIn className="shrink-0" size={20}/><span className="min-w-0 break-words">{t('clockIn')}</span></button><button disabled={blocked} onClick={()=>startClock('out')} className="flex min-h-14 items-center justify-center gap-2 rounded-lg bg-[#B3402A] px-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-[.35]"><LogOut className="shrink-0" size={20}/><span className="min-w-0 break-words">{t('clockOut')}</span></button></div>
        <p role="status" className={`text-sm ${success?'text-emerald-700 dark:text-emerald-300':'text-muted-foreground'}`}>{success||t(today.attendancePhotoSetting==='required'?'photoHelper':'serverTimeNote')}</p>
      </Card>
      {showPhotoCard&&<Card className="flex flex-col gap-4 p-5"><h2 className="font-semibold">{t('photoHeading')}</h2><div className="relative flex min-h-72 flex-1 items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-border bg-muted/30">
        {camera?<><video ref={video} autoPlay playsInline muted className="max-h-96 w-full object-contain"/><div className="pointer-events-none absolute h-3/4 w-1/2 rounded-[50%] border-2 border-white/80"/><span className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs text-white">{t('liveFront')}</span></>:photoUrl?<><img src={photoUrl} alt={t('photoReview')} className="max-h-96 w-full object-contain"/><p className="absolute bottom-0 w-full bg-black/70 p-2 text-center text-xs text-white">{today.date} · {time} · {t(today.locationValid?(today.geofencingRequired?'withinLocation':today.locationAvailable?'locationRecordedNoGeofence':'locationUnavailableAllowed'):geo?'outsideLocation':'locationCheckNeeded')}</p></>:action&&today.attendancePhotoSetting==='optional'?<div className="max-w-xs p-5 text-center"><Camera className="mx-auto mb-3 h-10 w-10 text-muted-foreground"/><p className="font-medium">{t('photoOptionalPrompt')}</p></div>:<div className="max-w-xs p-5 text-center"><Camera className="mx-auto mb-3 h-10 w-10 text-muted-foreground"/><p className="font-medium">{t('cameraOff')}</p><p className="mt-2 text-sm text-muted-foreground">{t('cameraHint')}</p></div>}
      </div>{camera?<><p className="text-center text-sm">{t('faceGuide')} · {t(action==='in'?'clockIn':'clockOut')}</p><div className="grid grid-cols-2 gap-3"><Button className="min-h-11" onClick={cancel}>{t('cancelPhoto')}</Button><Button className="min-h-11" onClick={capture}>{t('takePhoto')}</Button>{today.attendancePhotoSetting==='optional'&&<Button className="min-h-11 col-span-2" disabled={pending||inFlight.current} onClick={skipPhoto}>{t('skipPhoto')}</Button>}</div></>:photo?<div className="grid grid-cols-2 gap-3"><Button className="min-h-11" disabled={busy||command.current!=null} onClick={()=>{if(action)void openCamera(action);}}>{t('retakePhoto')}</Button><Button className={`min-h-11 whitespace-normal ${action==='in'?'bg-[#12795A] hover:bg-[#12795A]/90':'bg-[#B3402A] hover:bg-[#B3402A]/90'} text-white`} disabled={busy} onClick={()=>{if(action)void confirm(action);}}>{t(action==='in'?'confirmIn':'confirmOut')}</Button><Button className="min-h-11" disabled={busy||command.current!=null} onClick={cancel}>{t('cancelPhoto')}</Button></div>:action&&today.attendancePhotoSetting==='optional'?<div className="grid grid-cols-3 gap-3"><Button className="min-h-11" disabled={pending||inFlight.current} onClick={cancel}>{t('cancelPhoto')}</Button><Button className="min-h-11" disabled={busy||pending} onClick={()=>{if(action)void openCamera(action);}}>{t(cameraProblem?'retryCamera':'takePhoto')}</Button><Button className="min-h-11 whitespace-normal" disabled={pending||inFlight.current} onClick={skipPhoto}>{t('skipPhoto')}</Button></div>:action&&today.attendancePhotoSetting==='required'?<div className="grid grid-cols-2 gap-3"><Button disabled={pending||inFlight.current} onClick={cancel}>{t('cancelPhoto')}</Button><Button disabled={busy||pending} onClick={()=>{if(action)void openCamera(action);}}>{t(cameraProblem?'retryCamera':'takePhoto')}</Button></div>:null}</Card>}
    </div>
    {!embedded&&<Card className="overflow-hidden"><div className="flex flex-wrap justify-between gap-2 border-b p-4"><h2 className="font-semibold">{t('todayLog')}</h2><Link className="text-sm text-primary" href={employmentId?'/attendance/my-records?'+new URLSearchParams({employmentId}):'/attendance/my-records'}>{t('viewOverview')}</Link></div>{!today.captures.length&&!today.legacy.length?<p className="p-5 text-sm text-muted-foreground">{t('noPunches')}</p>:<ul className="divide-y">{today.captures.map(c=><li key={c.id} className="grid grid-cols-[48px_1fr] gap-3 p-3 sm:grid-cols-[48px_1fr_1fr_1fr]"><button className="h-12 w-12 overflow-hidden rounded" disabled={!c.photoAvailable} aria-label={t(c.photoAvailable?'openPhoto':'photoUnavailable')} onClick={()=>{setEnlarged(c.id);photoDialog.current?.showModal();}}>{c.photoAvailable?<img src={'/api/attendance/photo/'+c.id+'?thumbnail=1'} alt="" className="h-12 w-12 object-cover"/>:<Camera aria-hidden className="m-auto"/>}</button><span className="self-center text-sm font-medium">{t(c.direction==='in'?'punchIn':'punchOut')} · {new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(c.recordedAt))}</span><span className="col-start-2 text-sm text-muted-foreground sm:col-start-auto">{c.locationName&&<span className="block">{c.locationName}</span>}{c.lat!=null&&c.lng!=null?<a className="underline" target="_blank" rel="noopener noreferrer" href={osmPointHref(c.lat,c.lng)}>{fmtCoord(c.lat)}, {fmtCoord(c.lng)}{c.accuracyM!=null?` · ±${Math.round(c.accuracyM)} m`:''}</a>:t(`captureLocation.${c.locationStatus&&c.locationStatus!=='recorded'?c.locationStatus:'unknown'}`)}{c.geofencingRequired!=null&&<span className="block text-xs">{t(c.geofencingRequired?'geofenceEnforced':'geofencingNotRequired')}</span>}</span><span className="col-start-2 text-xs text-muted-foreground sm:col-start-auto">{t(c.photoAvailable?'photoSaved':'photoUnavailable')}{c.removalRequested?<span className="mt-2 block">{t('removalRequested')}</span>:c.punchId&&!c.removalBlocked&&<Button type="button" size="sm" variant="outline" className="mt-2 block" disabled={busy||pending||!!action} onClick={e=>{removalTrigger.current=e.currentTarget;removalSnapshot.current={baseline:today.removalBaseline,clockContext:today.clockContext};setRemoving(c);setRemovalReason('');setRemovalError('');removalCommand.current=null;}}>{t('remove')}</Button>}</span></li>)}{today.legacy.map((c,i)=><li key={'legacy'+i} className="flex flex-wrap gap-3 p-3 text-sm"><Camera aria-hidden size={18}/><span>{t(c.direction==='in'?'punchIn':'punchOut')} · {c.time}</span><span className="text-muted-foreground">{t('noHistoricalPhoto')}</span></li>)}</ul>}</Card>}
    <Dialog.Root open={!!removing} onOpenChange={open=>{if(!open&&!removalBusy&&!removalCommand.current)setRemoving(null);}}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content onCloseAutoFocus={e=>{e.preventDefault();removalTrigger.current?.focus();}} onEscapeKeyDown={e=>{if(removalBusy||removalCommand.current)e.preventDefault();}} onInteractOutside={e=>{if(removalBusy||removalCommand.current)e.preventDefault();}} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg"><Dialog.Title className="font-semibold">{t('remove')}</Dialog.Title><Dialog.Description className="mt-2 text-sm text-muted-foreground">{t('removalHelp')}</Dialog.Description>{removing&&<p className="mt-3 text-sm">{removing.date} · {t(removing.direction==='in'?'punchIn':'punchOut')} · {new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',timeStyle:'medium'}).format(new Date(removing.recordedAt))}</p>}<form className="mt-4 space-y-3" onSubmit={e=>{e.preventDefault();void removeClock();}}><label className="block text-sm">{t('removalRemark')}<textarea className="mt-1 w-full rounded-md border border-input bg-background p-2" required maxLength={500} value={removalReason} disabled={removalBusy||!!removalCommand.current} onChange={e=>setRemovalReason(e.target.value)}/></label>{removalError&&<p role="alert" className="text-sm text-destructive">{removalError}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={removalBusy||!!removalCommand.current} onClick={()=>setRemoving(null)}>{t('cancelPhoto')}</Button><Button type="submit" disabled={removalBusy}>{t(removalCommand.current?'checkSubmission':'requestRemoval')}</Button></div></form></Dialog.Content></Dialog.Portal></Dialog.Root>
    <dialog ref={photoDialog} aria-label={t('photoHeading')} className="max-w-[90vw] rounded-xl bg-background p-4 text-foreground backdrop:bg-black/70"><Button className="min-h-11" onClick={()=>photoDialog.current?.close()}>{t('cancelPhoto')}</Button>{enlarged&&<img src={'/api/attendance/photo/'+enlarged} alt={t('photoHeading')} className="mt-3 max-h-[75vh] max-w-full"/>}</dialog>
  </>;
}
