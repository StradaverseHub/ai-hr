import { useFocusEffect } from 'expo-router';
import { useCallback,useEffect,useRef } from 'react';
import { AppState,Image,Platform,Pressable,View } from 'react-native';
import { DesignText as Text } from './design';
import { randomUUID } from 'expo-crypto';
import { apiGet,apiPost,useApi } from './api';
import { assertAuthGeneration,authGeneration } from './auth';
import { capturePhoto,capturePosition,appendAttachment } from './capture';
import { readClockDevice,writeClockDevice,clearClockDevice } from './device-registration';
import { useTenantDesign } from './design';
import { SignInRequiredError,RequestRejectedError } from './errors';
import { useJourneyDrafts,removeLocalFile,type ClockDraft } from './journey-drafts';
import { useSession } from './session';
import { SlideConfirm } from './slide-confirm';
import { t,appLocale } from './i18n';
import { useSubmissionRecovery } from './submission-recovery';
import { ClockCommand } from '../../lib/mobile-api/contract';
import {SubmissionJournalFull} from './submission-journal';
import { Button,Card,LoadState,Muted,Row } from './ui';
const refusals={corrected_day:'correctedDay',clock_conflict:'clockConflict',location_required:'locationPermission',outside_geofence:'outsideGeofence',photo_required:'photoRequired',photo_invalid:'photoTooLarge',device_required:'registerDevice',mock_location:'mockLocation'} as const;
export function ClockPanel({refreshToken=0}:{refreshToken?:number}={}){
  const {employmentId,signOut}=useSession();
  const clock=useApi('clock',{employmentId:employmentId??undefined},signOut);
  useFocusEffect(useCallback(()=>{clock.reload();},[clock.reload]));
  useEffect(()=>{if(refreshToken)clock.reload();},[refreshToken,clock.reload]);
  const {clock:draft,putClock}=useJourneyDrafts();
  const {palette,design}=useTenantDesign();
  const flight=useRef(false);
  const current=clock.data?.state;
  const action=draft?.action??(current?.clockedIn?'out':'in');
  const identity=clock.data?.employmentId;
  const recovery=useSubmissionRecovery('clock',identity??undefined,({command,file})=>{
    const parsed=ClockCommand.parse(JSON.parse(command));
    putClock({employmentId:identity??undefined,action:parsed.action,requestId:parsed.requestId,geo:{lat:parsed.lat,lng:parsed.lng,accuracy:parsed.accuracy,sampledAt:parsed.sampledAt},deviceToken:parsed.deviceToken,photo:file,phase:'uncertain',message:t('clockUncertain')});
  });
  const pending=draft?.phase==='preparing'||draft?.phase==='submitting';
  const label=action==='in'?t('clockIn'):t('clockOut');
  function errorMessage(e:unknown){return e instanceof Error?e.message:t('genericError');}
  async function prepare(){
    if(flight.current||!identity||!current||pending||!recovery.ready)return;
    flight.current=true;
    const owner=authGeneration();
    let photo=draft?.photo;
    const next:ClockDraft={employmentId:identity,action,phase:'preparing'};
    putClock(next);
    try{
      const geo=await capturePosition();assertAuthGeneration(owner);
      if(!putClock({...next,geo}))return;
      if(current.attendancePhotoSetting==='required'&&!photo){photo=await capturePhoto()??undefined;assertAuthGeneration(owner);if(!photo)throw new Error(t('photoRequired'));}
      const deviceToken=await readClockDevice(identity);assertAuthGeneration(owner);
      if(!putClock({...next,phase:'review',geo,photo,deviceToken,requestId:randomUUID()}))removeLocalFile(photo);
    }catch(e){removeLocalFile(photo);putClock({action,phase:'idle',message:errorMessage(e)});if(e instanceof SignInRequiredError)void signOut();}
    finally{flight.current=false;}
  }
  async function takePhoto(){
    let captured:ClockDraft['photo'];
    if(flight.current||!draft||pending)return;flight.current=true;const owner=authGeneration();putClock({...draft,phase:'preparing'});
    try{const photo=await capturePhoto();captured=photo??undefined;assertAuthGeneration(owner);if(photo){if(putClock({...draft,photo},draft.requestId))removeLocalFile(draft.photo);else removeLocalFile(photo);}else putClock(draft,draft.requestId);}
    catch(e){removeLocalFile(captured);putClock({...draft,message:errorMessage(e)},draft.requestId);}finally{flight.current=false;}
  }
  async function register(){
    if(flight.current||!identity||!draft||pending)return;flight.current=true;const owner=authGeneration();putClock({...draft,phase:'preparing'});
    try{const registered=await apiPost('clock-device',{label:`AI HR · ${Platform.OS}`},{employmentId:identity});assertAuthGeneration(owner);
      if(!putClock({...draft,deviceToken:registered.deviceToken,message:undefined},draft.requestId))return;
      await writeClockDevice(identity,registered.deviceToken,()=>assertAuthGeneration(owner));
    }catch(e){putClock({...draft,message:errorMessage(e)},draft.requestId);if(e instanceof SignInRequiredError)void signOut();}finally{flight.current=false;}
  }
  async function submit(){
    if(flight.current||!identity||!draft?.geo||!draft.requestId||!current||AppState.currentState!=='active')return;
    if(draft.phase!=='uncertain'&&Date.now()-draft.geo.sampledAt>120000){putClock({...draft,phase:'idle',message:t('locationExpired')});return;}
    if(current.deviceRequired&&!draft.deviceToken)return;
    flight.current=true;const owner=authGeneration();
    let sent=false;
    let uploadFile:ClockDraft['photo'];
    putClock({...draft,phase:'submitting',message:undefined});
    try{
      const staged=await recovery.stage(JSON.stringify({action:draft.action,requestId:draft.requestId,lat:draft.geo.lat,lng:draft.geo.lng,accuracy:draft.geo.accuracy,sampledAt:draft.geo.sampledAt,deviceToken:draft.deviceToken}),draft.photo);assertAuthGeneration(owner);
      uploadFile=staged.file;
      if(!putClock({...draft,photo:staged.file,phase:'submitting'},draft.requestId))return;
      const form=new FormData();form.append('command',staged.command);if(staged.file)appendAttachment(form,'photo',staged.file);
      sent=true;const result=await apiPost('clock',form,{employmentId:identity});assertAuthGeneration(owner);
      await recovery.resolve(draft.requestId);assertAuthGeneration(owner);
      if(result.outcome==='accepted'){removeLocalFile(draft.photo);putClock({...draft,photo:undefined,phase:'done',receiptTime:result.receipt.recordedAt});}
      else{if(result.code==='device_required')await clearClockDevice();removeLocalFile(draft.photo);putClock({action,phase:'idle',message:t(refusals[result.code])});}
      clock.reload();
    }catch(e){
      let refused=false;
      if(e instanceof RequestRejectedError&&[400,403,404,413,415,422].includes(e.status))try{await recovery.resolve(draft.requestId);refused=true;}catch{}
      if(refused){removeLocalFile(draft.photo);putClock({action,phase:'idle',message:t('genericError')},draft.requestId);}
      else putClock({...draft,phase:'uncertain',message:t(sent?'clockUncertain':e instanceof SubmissionJournalFull?'pendingStorageFull':'submissionSaveFailed')},draft.requestId);
      if(e instanceof SignInRequiredError)void signOut();
    }
    finally{removeLocalFile(uploadFile);flight.current=false;}
  }
  async function recover(){
    if(flight.current||!identity||!draft?.requestId)return;
    flight.current=true;const owner=authGeneration();
    try{
      const result=await apiGet('submission-receipt',{kind:'clock',requestId:draft.requestId,employmentId:identity});assertAuthGeneration(owner);
      if(result.kind!=='clock'||result.requestId!==draft.requestId)throw new Error('Unexpected submission receipt');
      if(result.kind==='clock'&&result.receipt){
        await recovery.resolve(draft.requestId);assertAuthGeneration(owner);
        if(putClock({...draft,photo:undefined,phase:'done',receiptTime:result.receipt.recordedAt,message:undefined},draft.requestId))removeLocalFile(draft.photo);
        clock.reload();
      }else if(result.abandoned){
        await recovery.resolve(draft.requestId);assertAuthGeneration(owner);removeLocalFile(draft.photo);
        putClock({action:draft.action,phase:'idle',message:t('pendingDiscarded')},draft.requestId);
      }else putClock({...draft,message:t('clockUncertain')},draft.requestId);
    }catch(e){putClock({...draft,message:t('clockUncertain')},draft.requestId);if(e instanceof SignInRequiredError)void signOut();}
    finally{flight.current=false;}
  }
  function cancel(){removeLocalFile(draft?.photo);putClock(null);}
  if(clock.data&&!clock.data.enabled)return <Muted>{t('attendanceOff')}</Muted>;
  return <View style={{gap:16}}>
    <LoadState loading={clock.loading} hasData={current!=null} error={clock.error} onRetry={clock.reload}/>
    {!!recovery.error&&<><Muted>{t('genericError')}</Muted><Button title={t('retry')} onPress={recovery.reload}/></>}
    {current&&<>
      <View style={{borderBottomWidth:1,borderColor:palette.border,paddingBottom:18,gap:10}}>
        <Text style={{color:palette.muted,fontSize:14}}>{current.date} · {current.shift.code??t('workday')}</Text>
        <Text style={{color:palette.text,fontSize:32,fontWeight:'700'}}>{current.clockedIn?t('onTheClock'):t('offTheClock')}</Text>
        <View style={{flexDirection:design.clockLayout==='rail'?'column':'row',justifyContent:'space-between',gap:8}}>
          <Muted>{current.shift.start&&current.shift.end?`${current.shift.start.slice(0,5)} → ${current.shift.end.slice(0,5)}`:t('noShift')}</Muted>
          <Text style={{color:palette.accent,fontVariant:['tabular-nums']}}>{t('workedTime',{hours:Math.floor(current.workedSeconds/3600),minutes:Math.floor(current.workedSeconds%3600/60).toString().padStart(2,'0')})}</Text>
        </View>
      </View>
      {draft?.phase==='done'?<Card><Text accessibilityRole="header" style={{color:palette.text,fontSize:22,fontWeight:'700'}}>{t('clockRecorded')}</Text><Muted>{draft.receiptTime?new Date(draft.receiptTime).toLocaleString(appLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}):''}</Muted><Button title={t('backToClock')} onPress={cancel}/></Card>:<>
        {(!draft||draft.phase==='idle')&&<View style={{flexDirection:'row',gap:12}}>{(['in','out'] as const).map(a=><Pressable key={a} accessibilityRole="button" accessibilityState={{selected:a===action}} onPress={()=>putClock({action:a,phase:'idle'})} style={{flex:1,minHeight:48,justifyContent:'center',borderBottomWidth:2,borderColor:a===action?palette.accent:palette.border}}><Text style={{color:a===action?palette.accent:palette.muted,textAlign:'center',fontWeight:'600'}}>{a==='in'?t('clockIn'):t('clockOut')}</Text></Pressable>)}</View>}
        {draft?.message&&<Text accessibilityRole="alert" style={{color:palette.text,lineHeight:22}}>{draft.message}</Text>}
        {draft?.geo&&(draft.phase==='review'||draft.phase==='uncertain'||draft.phase==='submitting')&&<Card>
          <Text style={{color:palette.text,fontSize:21,fontWeight:'600'}}>{label}</Text>
          <Row label={t('locationAccuracy')} value={`± ${Math.round(draft.geo.accuracy)} m`}/>
          <Muted>{current.geofencingRequired?t('geofenceRechecked'):t('locationRecorded')}</Muted>
          <Muted>{t('serverTime')}</Muted>
          {draft.photo&&<Image source={{uri:draft.photo.uri}} style={{width:96,height:96,borderRadius:8}} accessibilityLabel={t('attendancePhoto')}/>}
          {current.attendancePhotoSetting==='optional'&&draft.phase==='review'&&<Button title={draft.photo?t('retakePhoto'):t('addPhoto')} kind="quiet" onPress={()=>void takePhoto()}/>}
          {current.deviceRequired&&!draft.deviceToken&&<><Muted>{t('registrationNotice')}</Muted><Button title={t('registerDevice')} onPress={()=>void register()}/></>}
        </Card>}
        {draft?.phase==='uncertain'?<><Muted>{t('retrySameClock')}</Muted><Button title={t('checkReceipt')} onPress={()=>void recover()}/><Button title={t('retrySameClock')} disabled={!recovery.ready} onPress={()=>void submit()}/></>:<SlideConfirm label={pending?t('preparingClock'):draft?.phase==='review'?t('slideRecord',{action:label}):t('slidePrepare',{action:label})} disabled={!current||pending||!recovery.ready||(draft?.phase==='review'&&current.deviceRequired&&!draft.deviceToken)} onConfirm={()=>void(draft?.phase==='review'?submit():prepare())}/>}
        {draft&&draft.phase==='review'&&<Button title={t('cancel')} kind="quiet" onPress={cancel}/>}
        <Muted>{t('onlineClockOnly')}</Muted>
      </>}
      <View style={{gap:8,marginTop:8}}><Text style={{color:palette.text,fontSize:17,fontWeight:'600'}}>{t('clockHistory')}</Text>
        {current.legacy.map((c,i)=><Row key={`${c.direction}-${c.time}-${i}`} label={c.direction==='in'?t('clockIn'):t('clockOut')} value={c.time.slice(0,5)}/>)}
        {current.captures.map(c=><Row key={c.id} label={c.direction==='in'?t('clockIn'):t('clockOut')} value={new Date(c.recordedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kuala_Lumpur'})}/>)}
        {!current.captures.length&&!current.legacy.length&&<Muted>{t('noClockHistory')}</Muted>}
      </View>
    </>}
  </View>;
}
