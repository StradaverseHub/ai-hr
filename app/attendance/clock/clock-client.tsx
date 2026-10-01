'use client';
import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Camera, LogIn, LogOut } from 'lucide-react';
import { Card, Button, inputCls } from '@/components/ui';
import { getStoredDeviceToken,storeDeviceToken,suggestDeviceLabel } from '@/lib/device-token';
import { formatMinutesToHM } from '@/lib/overtime-duration';
import { registerDeviceAction } from './actions';
import { type ShiftOption } from './clock-display';
import type { ownClockToday } from '@/core/attendance-clock-read';
export type PunchEvent = { time:string; direction:'in'|'out' };
type Today=Awaited<ReturnType<typeof ownClockToday>>;
type Geo={lat:number;lng:number;accuracy:number};
const locate=()=>new Promise<Geo>((resolve,reject)=>navigator.geolocation.getCurrentPosition(p=>resolve({lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy}),reject,{enableHighAccuracy:true,timeout:12000,maximumAge:0}));

export function ClockPageClient({initial,shiftName,shiftOptions}:{initial:Today;shiftName:string|null;shiftOptions:ShiftOption[]}) {
  const t=useTranslations('attendance.clock'), locale=useLocale();
  const [today,setToday]=React.useState(initial), [now,setNow]=React.useState<number|null>(null), [synced,setSynced]=React.useState(false);
  const base=React.useRef({server:0,mono:0});
  const refreshSequence=React.useRef(0);
  const [geo,setGeo]=React.useState<Geo|null>(null), [deviceLabel,setDeviceLabel]=React.useState(''), [busy,setBusy]=React.useState(false);
  const [action,setAction]=React.useState<'in'|'out'|null>(null), [camera,setCamera]=React.useState(false), [photo,setPhoto]=React.useState<Blob|null>(null), [photoUrl,setPhotoUrl]=React.useState<string|null>(null);
  const [error,setError]=React.useState(''), [success,setSuccess]=React.useState(''), [shiftIdx,setShiftIdx]=React.useState(-1);
  const video=React.useRef<HTMLVideoElement>(null), stream=React.useRef<MediaStream|null>(null), epoch=React.useRef(0), photoDialog=React.useRef<HTMLDialogElement>(null);
  const [enlarged,setEnlarged]=React.useState<string|null>(null);
  const command=React.useRef<{body:FormData;requestId:string}|null>(null);
  const stop=React.useCallback(()=>{stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;},[]);
  const refresh=React.useCallback(async(nextGeo?:Geo)=>{
    const sequence=++refreshSequence.current;
    const point=nextGeo??geo;
    const params=point?'?'+new URLSearchParams({lat:String(point.lat),lng:String(point.lng),accuracy:String(point.accuracy)}):'';
    const start=performance.now();
    const response=await fetch('/api/attendance/today'+params,{cache:'no-store',headers:{'x-clock-device':getStoredDeviceToken()??''}});
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
    setDeviceLabel(suggestDeviceLabel(navigator.userAgent));
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
  async function confirm(){
    if(!photo||!action||busy)return;setBusy(true);setError('');stop();
    try {
      // Keep the exact request after an uncertain response; retry never changes its proof or intent.
      if(!command.current){const point=await locate();setGeo(point);const value=await refresh(point);if(!value.deviceValid||!value.locationValid)throw new Error(value.deviceValid?'outsideGeofence':'deviceRequired');const requestId=crypto.randomUUID(),body=new FormData();for(const [key,value] of Object.entries({action,requestId,deviceToken:getStoredDeviceToken()??'',...point}))body.set(key,String(value));body.set('photo',photo,'attendance.jpg');command.current={body,requestId};}
      const response=await fetch('/api/attendance/clock',{method:'POST',body:command.current.body});
      const result=await response.json();
      if(!response.ok){command.current=null;throw new Error(result.error??'photoInvalid');}
      const recorded=new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(result.receipt.recordedAt));
      setSuccess(t(action==='in'?'savedIn':'savedOut',{time:recorded}));setPhoto(null);setAction(null);command.current=null;await refresh().catch(()=>{setSynced(false);setError(t('syncFailed'));});
    }catch(error){const code=(error as Error).message;setError(t(['outsideGeofence','deviceRequired','photoInvalid','conflict','correctedDay'].includes(code)?code:'retryFailed'));}finally{setBusy(false);}
  }
  async function register(){setBusy(true);setError('');try{const result=await registerDeviceAction({label:deviceLabel});if(!result.deviceToken){setError(result.error??t('deviceRequired'));return;}storeDeviceToken(result.deviceToken);await refresh();}finally{setBusy(false);}}
  async function retryLocation(){setBusy(true);try{const point=await locate();setGeo(point);await refresh(point);setError('');}catch{setError(t('locationRequired'));}finally{setBusy(false);}}
  const blocked=busy||camera||!!action||!synced||!today.deviceValid||!today.locationValid;
  const time=now==null?'--:--:--':new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now);
  const shown=shiftIdx>=0?shiftOptions[shiftIdx]:null;
  const worked=today.workedSeconds+(today.clockedIn&&now!=null?Math.max(0,Math.floor((now-Date.parse(today.serverNow))/1000)):0);
  const currentIn=today.openSince;
  return <>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-muted-foreground">{t('breadcrumb')}</p><h1 className="text-2xl font-semibold">{t('webTitle')}</h1></div><span className={`rounded-full px-3 py-2 text-sm ${today.deviceValid?'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200':'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200'}`}>{t(today.deviceValid?'deviceRegisteredHint':'deviceRequired')}</span></header>
    {error&&<p role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive">{error}</p>}
    {!today.deviceValid&&<Card className="flex flex-col gap-3 p-4 sm:flex-row"><input className={`${inputCls} min-h-11`} aria-label={t('deviceLabelField')} value={deviceLabel} onChange={e=>setDeviceLabel(e.target.value)} placeholder={t('deviceLabelPlaceholder')}/><Button className="min-h-11" onClick={register} disabled={busy||!deviceLabel.trim()}>{t('registerDevice')}</Button></Card>}
    <div className="grid gap-5 md:grid-cols-2">
      <Card className="space-y-5 p-5"><p>{new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',weekday:'long',day:'2-digit',month:'long',year:'numeric'}).format(new Date(today.date+'T12:00:00+08:00'))}</p><div className="flex flex-wrap items-center justify-between gap-2"><span className={`rounded-full px-3 py-1 text-sm ${today.locationValid?'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200':'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'}`}>{t(today.locationValid?'withinLocation':geo?'outsideLocation':'locationCheckNeeded')}</span><Button className="min-h-11" onClick={retryLocation} disabled={busy}>{t('checkLocation')}</Button></div>
        <div className="rounded-lg bg-muted/50 p-3"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{t('currentShift')}</span><span className="text-sm">{today.clockedIn?'● '+(currentIn?t('clockedInAt',{time:new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(currentIn))}):t('punchIn')):'○ '+t('statusNotClockedIn')}</span></div><p className="mt-1 text-sm">{shown?.name??shiftName??t('noShiftAssigned')} · {shown?.start??today.shift.start??'—'} → {shown?.end??today.shift.end??'—'}</p>{shiftOptions.length>1&&<button className="mt-2 min-h-11 text-sm text-primary" onClick={()=>setShiftIdx(i=>(i+1)%shiftOptions.length)}>{t('switchShift')}</button>}</div>
        <div className="text-center"><p className="text-xs font-semibold tracking-widest text-muted-foreground">{t('serverTimeLabel')}</p><p className="my-2 font-mono text-4xl tabular-nums sm:text-5xl">{time}</p><p className="text-sm">{t('workedToday',{time:formatMinutesToHM(Math.floor(worked/60))})}</p></div>
        <div className="grid grid-cols-2 gap-3"><button disabled={blocked||today.clockedIn} onClick={()=>openCamera('in')} className="flex min-h-14 items-center justify-center gap-2 rounded-lg bg-[#12795A] px-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-[.35]"><LogIn className="shrink-0" size={20}/><span className="min-w-0 break-words">{t('clockIn')}</span></button><button disabled={blocked||!today.clockedIn} onClick={()=>openCamera('out')} className="flex min-h-14 items-center justify-center gap-2 rounded-lg bg-[#B3402A] px-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-[.35]"><LogOut className="shrink-0" size={20}/><span className="min-w-0 break-words">{t('clockOut')}</span></button></div>
        <p role="status" className={`text-sm ${success?'text-emerald-700 dark:text-emerald-300':'text-muted-foreground'}`}>{success||t('photoHelper')}</p>
      </Card>
      <Card className="flex flex-col gap-4 p-5"><h2 className="font-semibold">{t('photoHeading')}</h2><div className="relative flex min-h-72 flex-1 items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-border bg-muted/30">
        {camera?<><video ref={video} autoPlay playsInline muted className="max-h-96 w-full object-contain"/><div className="pointer-events-none absolute h-3/4 w-1/2 rounded-[50%] border-2 border-white/80"/><span className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs text-white">{t('liveFront')}</span></>:photoUrl?<><img src={photoUrl} alt={t('photoReview')} className="max-h-96 w-full object-contain"/><p className="absolute bottom-0 w-full bg-black/70 p-2 text-center text-xs text-white">{today.date} · {time} · {t(today.locationValid?'withinLocation':geo?'outsideLocation':'locationCheckNeeded')}</p></>:<div className="max-w-xs p-5 text-center"><Camera className="mx-auto mb-3 h-10 w-10 text-muted-foreground"/><p className="font-medium">{t('cameraOff')}</p><p className="mt-2 text-sm text-muted-foreground">{t('cameraHint')}</p></div>}
      </div>{camera?<><p className="text-center text-sm">{t('faceGuide')} · {t(action==='in'?'clockIn':'clockOut')}</p><div className="grid grid-cols-2 gap-3"><Button className="min-h-11" onClick={cancel}>{t('cancelPhoto')}</Button><Button className="min-h-11" onClick={capture}>{t('takePhoto')}</Button></div></>:photo?<div className="grid grid-cols-2 gap-3"><Button className="min-h-11" disabled={busy||command.current!=null} onClick={()=>{if(action)void openCamera(action);}}>{t('retakePhoto')}</Button><Button className={`min-h-11 whitespace-normal ${action==='in'?'bg-[#12795A] hover:bg-[#12795A]/90':'bg-[#B3402A] hover:bg-[#B3402A]/90'} text-white`} disabled={busy} onClick={confirm}>{t(action==='in'?'confirmIn':'confirmOut')}</Button><Button className="min-h-11" disabled={busy||command.current!=null} onClick={cancel}>{t('cancelPhoto')}</Button></div>:null}</Card>
    </div>
    <Card className="overflow-hidden"><div className="flex flex-wrap justify-between gap-2 border-b p-4"><h2 className="font-semibold">{t('todayLog')}</h2><Link className="text-sm text-primary" href="/attendance/my-records">{t('viewOverview')}</Link></div>{!today.captures.length&&!today.legacy.length?<p className="p-5 text-sm text-muted-foreground">{t('noPunches')}</p>:<ul className="divide-y">{today.captures.map(c=><li key={c.id} className="grid grid-cols-[48px_1fr] gap-3 p-3 sm:grid-cols-[48px_1fr_1fr_1fr]"><button className="h-12 w-12 overflow-hidden rounded" disabled={!c.photoAvailable} aria-label={t(c.photoAvailable?'openPhoto':'photoUnavailable')} onClick={()=>{setEnlarged(c.id);photoDialog.current?.showModal();}}>{c.photoAvailable?<img src={'/api/attendance/photo/'+c.id+'?thumbnail=1'} alt="" className="h-12 w-12 object-cover"/>:<Camera aria-hidden className="m-auto"/>}</button><span className="self-center text-sm font-medium">{t(c.direction==='in'?'punchIn':'punchOut')} · {new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(c.recordedAt))}</span><span className="col-start-2 text-sm text-muted-foreground sm:col-start-auto">{c.locationName??'—'}</span><span className="col-start-2 text-xs text-muted-foreground sm:col-start-auto">{t(c.photoAvailable?'photoSaved':'photoUnavailable')}</span></li>)}{today.legacy.map((c,i)=><li key={'legacy'+i} className="flex flex-wrap gap-3 p-3 text-sm"><Camera aria-hidden size={18}/><span>{t(c.direction==='in'?'punchIn':'punchOut')} · {c.time}</span><span className="text-muted-foreground">{t('noHistoricalPhoto')}</span></li>)}</ul>}</Card>
    <dialog ref={photoDialog} aria-label={t('photoHeading')} className="max-w-[90vw] rounded-xl bg-background p-4 text-foreground backdrop:bg-black/70"><Button className="min-h-11" onClick={()=>photoDialog.current?.close()}>{t('cancelPhoto')}</Button>{enlarged&&<img src={'/api/attendance/photo/'+enlarged} alt={t('photoHeading')} className="mt-3 max-h-[75vh] max-w-full"/>}</dialog>
  </>;
}
