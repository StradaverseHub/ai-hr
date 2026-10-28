/** Employee-facing offline clock states (owner design, 2026-10-28) over the offline sync driver (offline-sync.ts). The
 * driver decides every route; this module only reads its views and asks it to act.
 *
 * Default OFF: unless EXPO_PUBLIC_OFFLINE_CLOCKING==='1' (offlineClockingBuild) the hook has no key, so no effect runs, no
 * controller opens, no driver function is called, the mode is 'none', there are no claims, and both components render
 * nothing. With the switch on and the server's offline capabilities off, the driver itself answers `off` and holds no
 * exchange, which renders the same as default OFF.
 *
 * Connectivity shown to the employee follows the driver's own test (no HTTP response): a sync or route answered `offline`,
 * a clock read that failed with NetworkUnavailableError, or a controller opened from the offline anchor (cold start). */
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Alert,Pressable,View} from 'react-native';
import {SymbolView,type SymbolViewProps} from 'expo-symbols';
import {DesignText as Text,useTenantDesign} from './design';
import {assertAuthGeneration,authGeneration} from './auth';
import {config,identityNamespace,offlineClockingBuild} from './config';
import {SessionChangedError,SignInRequiredError,UnavailableError,isNoConnectivity} from './errors';
import {t,appLocale,type MessageKey} from './i18n';
import {openOwnedSignedClock} from './signed-clock';
import {readOfflineAnchor} from './offline-anchor';
import {afterOnlinePunch,beforeOnlinePunch,captureOfflinePunch,keepOfflineSynced,removeUndeliverable,syncOffline,type OfflineClaimView,type OfflineSyncState,type PunchRoute} from './offline-sync';
import type {OfflineExchangeView} from './signed-clock-journal';
import {Muted,colors} from './ui';

/** The build switch, re-exported so screens need no second configuration import. */
export const offlineClocking=offlineClockingBuild;
type Controller=Awaited<ReturnType<typeof openOwnedSignedClock>>;
type Exchange=OfflineExchangeView['exchange'];
type Keyed<T>={key:string;value:T};
/** Status tones. The tenant palette has no semantic colours; these reuse the app's shared warn/danger tokens. */
const tones={success:'#1E7A46',warning:colors.warn,danger:colors.danger} as const;
const time=(at:number)=>new Date(at).toLocaleTimeString(appLocale(),{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kuala_Lumpur'});
const dateTime=(at:number)=>new Date(at).toLocaleString(appLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'});

/** Receipt reasons (OfflineClockReviewReason, request_conflict) and undeliverable codes, as short employee sentences. */
const reasons:Record<string,MessageKey>={
 continuity_unknown:'offlineReasonTime',time_unverifiable:'offlineReasonTime',outside_context_window:'offlineReasonTime',proven_window_too_wide:'offlineReasonTime',
 policy_changed:'offlineReasonSettingsChanged',site_changed:'offlineReasonSettingsChanged',scope_changed:'offlineReasonSettingsChanged',
 attendance_changed:'offlineReasonAttendanceChanged',corrected_day:'offlineReasonAttendanceChanged',
 payroll_locked:'offlineReasonPaySettled',overtime_settled:'offlineReasonPaySettled',
 location_required:'offlineReasonLocation',poor_accuracy:'offlineReasonLocation',outside_geofence:'offlineReasonOutsideSite',
 mock_reported:'offlineReasonLocationSource',simulated_reported:'offlineReasonLocationSource',accessory_reported:'offlineReasonLocationSource',
 photo_required:'offlineReasonPhoto',photo_invalid:'offlineReasonPhoto',device_required:'offlineReasonDevice',review_required:'offlineReasonReview',
 offline_disabled:'offlineReasonDisabled',employment_inactive:'offlineReasonInactive',request_conflict:'offlineReasonDuplicate',issuer_unavailable:'offlineReasonPassCheck',
 key_unavailable:'offlineReasonKey',context_closed:'offlineReasonPassEnded',context_unavailable:'offlineReasonPassEnded',
 binding_conflict:'offlineReasonNotVerified',invalid_proof:'offlineReasonNotVerified',invalid_claim:'offlineReasonNotVerified',bad_request:'offlineReasonNotVerified',
 attachment_mismatch:'offlineReasonPhotoMismatch',earlier_undeliverable:'offlineReasonEarlier',
};
export const offlineReason=(reason:string)=>t(reasons[reason]??'offlineReasonUnknown');
const blocked:Record<string,MessageKey>={closing:'offlineBlockedClosing',other_employment:'offlineBlockedOtherEmployment',needs_attention:'offlineBlockedAttention',offline_unavailable:'offlineUnavailableNow'};
/** beforeOnlinePunch's blocked reason, as the message the clock screen shows. */
export const offlineBlockedMessage=(reason:string)=>t(blocked[reason]??'offlineBlockedPending');
/** What a sync result proves about the connection; null when the driver answered without asking the server. */
function connectionOf(result:OfflineSyncState):'offline'|'online'|null{
 if(result.state==='offline')return 'offline';
 if(result.state==='waiting'||result.state==='off'&&result.reason==='build'||result.state==='blocked'&&result.reason==='other_employment')return null;
 return 'online';
}

export function useOfflineClock({employmentId,connected,paused,isUnlocked,onSignInRequired,onRecorded}:{
 /** The clock read's employment, else the session's; null lets an offline cold start use the anchor's employment. */
 employmentId:string|null;
 /** false: the clock read got no HTTP response; true: it answered; null: no new evidence. */
 connected:boolean|null;
 /** A clock draft is being prepared, reviewed, sent or recovered: no automatic sync or re-arm meanwhile. */
 paused:boolean;
 isUnlocked:(employmentId:string)=>boolean;
 onSignInRequired:()=>void;
 onRecorded?:()=>void;
}){
 const [anchorEmployment,setAnchorEmployment]=useState<string|null>(null);
 const key=offlineClockingBuild?employmentId??anchorEmployment:null;
 const keyRef=useRef(key);keyRef.current=key;
 const live=useRef({isUnlocked,onSignInRequired,onRecorded});live.current={isUnlocked,onSignInRequired,onRecorded};
 const [view,setView]=useState<Keyed<{exchange:Exchange;claims:OfflineClaimView[]}>|null>(null);
 const [sync,setSync]=useState<Keyed<OfflineSyncState>|null>(null);
 const [connection,setConnection]=useState<Keyed<'offline'|'online'>|null>(null);
 const [message,setMessage]=useState<Keyed<MessageKey>|null>(null);
 const [busy,setBusy]=useState(false);
 const opened=useRef<{key:string;promise:Promise<Controller>}|null>(null);
 const queue=useRef<Promise<unknown>>(Promise.resolve());
 const recorded=useRef<{key:string;count:number}|null>(null);
 function serial<T>(task:()=>Promise<T>):Promise<T>{const next=queue.current.then(task,task);queue.current=next.catch(()=>{});return next;}
 function controller(selected:string){
  let entry=opened.current;
  if(!entry||entry.key!==selected){
   const mine={key:selected,promise:openOwnedSignedClock(selected,()=>live.current.isUnlocked(selected))};entry=mine;opened.current=mine;
   mine.promise.catch(()=>{if(opened.current===mine)opened.current=null;});
  }
  return entry.promise;
 }
 function link(selected:string,value:'offline'|'online'|null){if(value&&keyRef.current===selected)setConnection({key:selected,value});}
 function fail(selected:string,error:unknown){
  if(error instanceof SignInRequiredError){live.current.onSignInRequired();return;}
  if(error instanceof SessionChangedError)opened.current=null;
  if(isNoConnectivity(error))link(selected,'offline');
 }
 async function read(selected:string,c:Controller,result?:OfflineSyncState){
  if(!c.offline)return;
  const value=await c.offline.claims();
  if(keyRef.current!==selected)return;
  setView({key:selected,value:{exchange:value.exchange,claims:value.claims}});
  if(result){setSync({key:selected,value:result});link(selected,connectionOf(result));}
  const count=value.claims.filter(claim=>claim.state==='recorded').length,prior=recorded.current;
  recorded.current={key:selected,count};
  if(prior?.key===selected&&count>prior.count)live.current.onRecorded?.();
 }
 const run=(selected:string,manual:boolean)=>serial(async()=>{const c=await controller(selected);const result=await syncOffline(c,{manual});await read(selected,c,result);}).catch(error=>fail(selected,error));

 // Offline cold start: no employment from the clock read, and no HTTP response. The anchor exists only for this
 // session's own exchange (logout deletes it), and openOwnedSignedClock checks it again against this connection.
 useEffect(()=>{
  if(!offlineClockingBuild||employmentId||connected!==false)return;
  let active=true;const owner=authGeneration();
  void readOfflineAnchor(()=>assertAuthGeneration(owner)).then(anchor=>{
   if(active&&anchor&&anchor.namespace===identityNamespace()&&anchor.apiOrigin===config.apiUrl)setAnchorEmployment(anchor.employmentId);
  },()=>{});
  return()=>{active=false;};
 },[employmentId,connected]);
 useEffect(()=>{if(key&&connected!==null)setConnection({key,value:connected?'online':'offline'});},[key,connected]);
 // Read the queue, then sync once (uploads, resends a saved close, or arms), and keep syncing on every foreground.
 useEffect(()=>{
  if(!key||paused)return;
  const selected=key;let active=true,stop=()=>{};
  void serial(async()=>{const c=await controller(selected);if(c.identity.anchored)link(selected,'offline');await read(selected,c);return c;}).then(c=>{
   if(!active)return;
   stop=keepOfflineSynced(c,result=>{if(result instanceof Error)fail(selected,result);else void serial(()=>read(selected,c,result)).catch(error=>fail(selected,error));});
   void run(selected,false);
  },error=>fail(selected,error));
  return()=>{active=false;stop();};
 },[key,paused]);

 const current=view?.key===key?view.value:null,exchange=current?.exchange??null,own=exchange?.own?exchange:null;
 const claims=key?current?.claims??[]:[];
 const live_=own?claims.filter(claim=>claim.contextId===own.contextId):[];
 const waiting=live_.filter(claim=>claim.state==='waiting').length;
 const offlineNow=connection?.key===key&&connection.value==='offline';
 const available=!!own&&own.phase==='context_ready'&&(own.permitsRemaining??0)>0;
 const mode:'none'|'offline'|'sending'=!key?'none':offlineNow&&available?'offline':!offlineNow&&waiting>0?'sending':'none';
 const state=sync?.key===key?sync.value:null;
 let last:OfflineClaimView|undefined;
 for(const claim of live_)if(claim.state!=='not_recorded'&&claim.state!=='undeliverable')last=claim;
 return {
  enabled:!!key,employmentId:key,mode,claims,waiting,
  availableUntil:mode==='offline'?own?.expiresAt??null:null,
  /** The newest own punch of the current exchange (newer than the last server read), if any. */
  clockedIn:last?last.action==='in':undefined,
  since:last?last.state==='recorded'?last.effectiveAt:last.claimedAt:null,
  otherExchange:!!exchange&&!exchange.own,
  retryable:mode==='sending'&&state?.state==='waiting',
  busy,message:message?.key===key?message.value:null,
  /** Owner decision 1 before every online punch; `open` opens the employment that holds the exchange. */
  before():Promise<PunchRoute>{
   if(!key)return Promise.resolve<PunchRoute>({route:'online'});
   const selected=key;
   return serial(async()=>{
    const c=await controller(selected);let route:PunchRoute;
    try{route=await beforeOnlinePunch(c,{open:employment=>openOwnedSignedClock(employment,()=>live.current.isUnlocked(selected))});}
    catch(error){if(isNoConnectivity(error))link(selected,'offline');throw error;}
    if(route.route==='offline'||route.route==='blocked'&&route.reason==='offline_unavailable')link(selected,'offline');
    await read(selected,c).catch(()=>{});return route;
   });
  },
  after(){if(!key)return;const selected=key;void serial(async()=>{const c=await controller(selected);const result=await afterOnlinePunch(c);await read(selected,c,result);}).catch(error=>fail(selected,error));},
  capture(requestId:string){
   if(!key)return Promise.reject(new UnavailableError('Offline clocking is not available.'));
   const selected=key;
   return serial(async()=>{const c=await controller(selected);const result=await captureOfflinePunch(c,requestId);await read(selected,c).catch(()=>{});return result;});
  },
  retry(){if(!key||busy)return;const selected=key;setBusy(true);void run(selected,true).finally(()=>setBusy(false));},
  remove(requestId:string){
   if(!key||busy)return;const selected=key;setBusy(true);setMessage(null);
   void serial(async()=>{const c=await controller(selected);await removeUndeliverable(c,requestId);await read(selected,c);})
    .then(()=>run(selected,false),error=>{fail(selected,error);if(keyRef.current===selected)setMessage({key:selected,value:'genericError'});})
    .finally(()=>setBusy(false));
  },
 };
}
export type OfflineClock=ReturnType<typeof useOfflineClock>;

function Banner({tone,icon,children}:{tone:string;icon:SymbolViewProps['name'];children:ReactNode}){
 const {palette}=useTenantDesign();
 return <View accessible accessibilityRole="alert" accessibilityLiveRegion="polite" style={{flexDirection:'row',gap:12,alignItems:'flex-start',padding:14,borderRadius:12,borderWidth:1,borderColor:tone,backgroundColor:tone+'1F'}}>
  <SymbolView name={icon} tintColor={tone} size={22}/>
  <View style={{flex:1,gap:6}}>{children}</View>
 </View>;
}
/** NO CONNECTION and BACK ONLINE banners. `server` is the last server read, used when no offline punch is newer. */
export function OfflineClockBanner({offline,server}:{offline:OfflineClock;server?:{clockedIn:boolean;openSince:string|null;lastOutAt:string|null}|null}){
 const {palette}=useTenantDesign();
 if(offline.mode==='offline'){
  const opened=server?.openSince?Date.parse(server.openSince):NaN,closed=server?.lastOutAt?Date.parse(server.lastOutAt):NaN;
  const line=offline.since!==null?t(offline.clockedIn?'offlineClockedInSince':'offlineClockedOutAt',{time:time(offline.since)})
   :server?.clockedIn&&Number.isFinite(opened)?t('offlineClockedInSince',{time:time(opened)})
   :server&&!server.clockedIn&&Number.isFinite(closed)?t('offlineClockedOutAt',{time:time(closed)}):null;
  return <Banner tone={tones.warning} icon={{ios:'wifi.slash',android:'wifi_off'}}>
   <Text style={{color:palette.text,lineHeight:22}}>{t('offlineNoConnection')}</Text>
   {line&&<Text style={{color:palette.text,fontWeight:'600'}}>{line}</Text>}
   {offline.availableUntil!==null&&<Muted>{t('offlineAvailableUntil',{time:dateTime(offline.availableUntil)})}</Muted>}
  </Banner>;
 }
 if(offline.mode==='sending')return <View style={{gap:8}}>
  <Banner tone={palette.accent} icon={{ios:'arrow.clockwise',android:'sync'}}>
   <Text style={{color:palette.text,lineHeight:22}}>{offline.waiting===1?t('offlineSendingOne'):t('offlineSending',{n:offline.waiting})}</Text>
   <Muted>{t('offlinePaused')}</Muted>
  </Banner>
  {offline.retryable&&<Pressable accessibilityRole="button" accessibilityState={{disabled:offline.busy}} disabled={offline.busy} onPress={offline.retry} style={{minHeight:44,justifyContent:'center'}}>
   <Text style={{color:palette.accent,fontWeight:'600'}}>{t('offlineRetryNow')}</Text>
  </Pressable>}
 </View>;
 return null;
}
const statuses={recorded:['offlineStatusRecorded',tones.success],waiting:['offlineStatusWaiting',null],held:['offlineStatusHeld',tones.warning],
 not_recorded:['offlineStatusNotRecorded',tones.danger],undeliverable:['offlineStatusUndeliverable',tones.danger]} as const satisfies Record<OfflineClaimView['state'],readonly [MessageKey,string|null]>;
/** SAVED PUNCHES: shown only while the current or recent exchange holds claims for this employment. */
export function SavedOfflinePunches({offline}:{offline:OfflineClock}){
 const {palette}=useTenantDesign();
 if(!offline.claims.length)return null;
 function confirmRemove(requestId:string){
  Alert.alert(t('offlineRemoveTitle'),t('offlineRemoveConfirm'),[
   {text:t('cancel'),style:'cancel'},
   {text:t('offlineRemove'),style:'destructive',onPress:()=>offline.remove(requestId)},
  ]);
 }
 return <View style={{gap:8,marginTop:8}}>
  <Text accessibilityRole="header" style={{color:palette.text,fontSize:17,fontWeight:'600'}}>{t('offlineSavedPunches')}</Text>
  {offline.message&&<Text accessibilityRole="alert" style={{color:palette.text}}>{t(offline.message)}</Text>}
  {offline.claims.map(claim=>{
   const [label,tone]=statuses[claim.state];
   return <View key={claim.requestId} style={{gap:4,paddingVertical:8,borderBottomWidth:1,borderColor:palette.border}}>
    <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'baseline',gap:12}}>
     <Text style={{color:palette.text,fontVariant:['tabular-nums']}}>{`${t(claim.action==='in'?'clockIn':'clockOut')} · ${time(claim.state==='recorded'?claim.effectiveAt:claim.claimedAt)}`}</Text>
     <Text style={{color:tone??palette.muted,fontWeight:'600',textAlign:'right',flexShrink:1}}>{t(label)}</Text>
    </View>
    {(claim.state==='held'||claim.state==='not_recorded'||claim.state==='undeliverable')&&<Muted>{offlineReason(claim.reason)}</Muted>}
    {claim.state==='undeliverable'&&<>
     <Muted>{t('offlineAskHr')}</Muted>
     <Pressable accessibilityRole="button" accessibilityState={{disabled:offline.busy}} disabled={offline.busy} onPress={()=>confirmRemove(claim.requestId)} style={{minHeight:44,justifyContent:'center',alignSelf:'flex-start'}}>
      <Text style={{color:tones.danger,textDecorationLine:'underline'}}>{t('offlineRemove')}</Text>
     </Pressable>
    </>}
   </View>;
  })}
 </View>;
}

/** Saved offline punches of this installed account still waiting to be sent (sign-out note, decision 5). The anchor exists
 * only while an exchange exists and names its employment; claims are read through that employment's own controller. */
export async function queuedOfflinePunches(isUnlocked:()=>boolean):Promise<number>{
 if(!offlineClockingBuild)return 0;
 const owner=authGeneration(),anchor=await readOfflineAnchor(()=>assertAuthGeneration(owner));
 if(!anchor||anchor.namespace!==identityNamespace()||anchor.apiOrigin!==config.apiUrl)return 0;
 const c=await openOwnedSignedClock(anchor.employmentId,isUnlocked);if(!c.offline)return 0;
 const view=await c.offline.claims(),e=view.exchange;
 return e?.own?view.claims.filter(claim=>claim.contextId===e.contextId&&claim.state==='waiting').length:0;
}
/** 0 with the switch off (no call at all), while unknown, or when the read fails: the note is information only. */
export function useQueuedOfflinePunches(isUnlocked:()=>boolean){
 const owner=authGeneration(),key=offlineClockingBuild?JSON.stringify([owner,identityNamespace()]):null;
 const live=useRef(isUnlocked);live.current=isUnlocked;
 const [count,setCount]=useState<Keyed<number>|null>(null);
 useEffect(()=>{
  if(!key)return;
  let active=true;
  void queuedOfflinePunches(()=>active&&live.current()).then(n=>{if(active)setCount({key,value:n});},()=>{});
  return()=>{active=false;};
 },[key]);
 return count?.key===key?count.value:0;
}
