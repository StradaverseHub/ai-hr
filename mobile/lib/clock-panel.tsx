import { useFocusEffect,router } from 'expo-router';
import { useCallback,useEffect,useRef,useState } from 'react';
import { Alert,AppState,Image,Platform,Pressable,View,Linking } from 'react-native';
import { DesignText as Text } from './design';
import { randomUUID } from 'expo-crypto';
import { apiGet,apiPost,useApi } from './api';
import { assertAuthGeneration,authGeneration } from './auth';
import { capturePhoto,capturePosition,appendAttachment } from './capture';
import { readClockDevice,writeClockDevice,clearClockDevice } from './device-registration';
import { useTenantDesign } from './design';
import { SignInRequiredError,RequestRejectedError,LocationCaptureError,SessionChangedError } from './errors';
import { useJourneyDrafts,removeLocalFile,type ClockDraft } from './journey-drafts';
import { useSession } from './session';
import { SlideConfirm } from './slide-confirm';
import { t,appLocale } from './i18n';
import {openOwnedSignedClock} from './signed-clock';
import type {SignedClockStatus} from './signed-clock-journal';
import {EnrollmentConflict} from './enrollment-journal';
import { useSubmissionRecovery } from './submission-recovery';
import { ClockCommand,ClockPreparation } from '../../lib/mobile-api/contract';
import {SubmissionJournalFull,PendingSubmissionConflict} from './submission-journal';
import { Button,Card,LoadState,Muted,Row } from './ui';
const refusals={corrected_day:'correctedDay',clock_conflict:'clockConflict',location_required:'locationPermission',outside_geofence:'outsideGeofence',photo_required:'photoRequired',photo_invalid:'photoTooLarge',device_required:'registerDevice',mock_location:'mockLocation',integrity_required:'clockIntegrityRequired'} as const;
const locationRefusals={location_required:'locationPermission',invalid_location:'locationInvalid',poor_accuracy:'locationPoorAccuracy',no_assigned_site:'locationNoSite',outside_site:'locationOutsideSite',stale_fix:'locationExpired',future_fix:'locationFuture'} as const;
export function ClockPanel({refreshToken=0}:{refreshToken?:number}={}){
  const {employmentId,status:sessionStatus,signOut}=useSession();
  const clock=useApi('clock',{employmentId:employmentId??undefined},signOut);
  const attempts=useApi('clock-attempts',{employmentId:employmentId??undefined},signOut);
  useFocusEffect(useCallback(()=>{clock.reload();attempts.reload();},[clock.reload,attempts.reload]));
  useEffect(()=>{if(refreshToken){clock.reload();attempts.reload();}},[refreshToken,clock.reload,attempts.reload]);
  const {clock:draft,putClock}=useJourneyDrafts();
  const {palette,design}=useTenantDesign();
  const flight=useRef(false);
  const current=clock.data?.state;
  const action=draft?.action??(current?.clockedIn?'out':'in');
  const identity=clock.data?.employmentId;
  const mounted=useRef(true),session=useRef({employmentId,status:sessionStatus});session.current={employmentId,status:sessionStatus};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [signedStatus,setSignedStatus]=useState<SignedClockStatus|null>(null);
  const [registrationNeeded,setRegistrationNeeded]=useState(false);
  const latestDraft=useRef(draft);latestDraft.current=draft;
  async function signedClock(){
    if(!identity)throw new Error(t('signedClockUnavailable'));
    const selected=identity;
    return openOwnedSignedClock(selected,()=>mounted.current&&session.current.employmentId===selected&&session.current.status==='signedIn');
  }
  function operation(owner:number){
    return {assertCurrent(){assertAuthGeneration(owner);if(!mounted.current||session.current.status!=='signedIn'||session.current.employmentId!==identity||AppState.currentState!=='active')throw new SessionChangedError();}};
  }
  const recovery=useSubmissionRecovery('clock',identity??undefined,({entry,command,file})=>{
    if(entry.stage==='preparation'){
      const saved=ClockPreparation.parse(JSON.parse(command));
      const prior=latestDraft.current;
      if(prior?.requestId===saved.requestId&&prior.action===saved.action&&prior.geo&&prior.phase==='review'){
        putClock({...prior,attemptStartedAt:saved.claimedAt,attemptReceiptTime:entry.attemptReceipt?.receivedAt});return;
      }
      putClock({employmentId:identity??undefined,action:saved.action,requestId:saved.requestId,attemptStartedAt:saved.claimedAt,
        attemptReceiptTime:entry.attemptReceipt?.receivedAt,phase:'idle',message:t('attemptSavedNotSent')});return;
    }
    const parsed=ClockCommand.parse(JSON.parse(command));
    putClock({employmentId:identity??undefined,action:parsed.action,requestId:parsed.requestId,geo:{lat:parsed.lat,lng:parsed.lng,accuracy:parsed.accuracy,sampledAt:parsed.sampledAt,...(entry.integrity?{source:entry.integrity.source}:{})},...(entry.integrity?{clockProtocol:'signed' as const}:{}),deviceToken:parsed.deviceToken,photo:file,phase:'uncertain',message:t('clockUncertain')});
  });
  useEffect(()=>{
    let disposed=false;setSignedStatus(null);setRegistrationNeeded(false);
    if(identity&&recovery.ready)void (async()=>{
      const controller=await signedClock(),value=await controller.status();if(disposed)return;
      setSignedStatus(value);
      if(value.status==='pending'&&!flight.current){
        const prior=latestDraft.current;
        putClock({...((prior?.requestId===value.requestId)?prior:{}),employmentId:identity,action:value.action,requestId:value.requestId,clockProtocol:'signed',phase:'uncertain',message:t('signedClockPending')});
      }
    })().catch(()=>{if(!disposed)setSignedStatus(null);});
    return()=>{disposed=true;};
  },[identity,recovery.ready]);
  const pending=draft?.phase==='preparing'||draft?.phase==='submitting';
  const label=action==='in'?t('clockIn'):t('clockOut');
  function errorMessage(e:unknown){return e instanceof Error?e.message:t('genericError');}
  async function prepare(){
    if(flight.current||!identity||!current||pending||!recovery.ready)return;
    flight.current=true;
    const owner=authGeneration();
    let photo=draft?.photo;
    let next:ClockDraft={employmentId:identity,action,phase:'preparing'};
    putClock(next);
    try{
      const controller=await signedClock(),savedStatus=await controller.status();assertAuthGeneration(owner);setSignedStatus(savedStatus);
      if(savedStatus.status!=='empty'){
        if(savedStatus.status==='pending')putClock({employmentId:identity,action:savedStatus.action,requestId:savedStatus.requestId,clockProtocol:'signed',phase:'uncertain',message:t('signedClockPending')});
        else putClock({...next,phase:'idle',message:t('signedClockOtherPending')});
        return;
      }
      let capabilities;
      try{capabilities=await controller.capabilities();}
      catch(error){if(!(error instanceof RequestRejectedError&&error.status===404))throw error;}
      if(capabilities?.outcome==='capabilities'){
        next={...next,clockProtocol:'signed'};
        try{await controller.key();}catch(error){if(error instanceof EnrollmentConflict)setRegistrationNeeded(true);throw error;}
      }else if(capabilities&&!(capabilities.outcome==='unavailable'&&capabilities.code==='not_configured'))throw new Error(t('signedClockUnavailable'));
      const saved=await recovery.prepareClock(action,randomUUID());assertAuthGeneration(owner);
      next={...next,requestId:saved.requestId,attemptStartedAt:saved.createdAt,attemptReceiptTime:saved.attemptReceipt?.receivedAt};
      if(!putClock(next))return;
      operation(owner).assertCurrent();const geo=await capturePosition(operation(owner).assertCurrent);assertAuthGeneration(owner);
      if(!putClock({...next,geo}))return;
      operation(owner).assertCurrent();const locationAssessment=await apiPost('clock-location',{lat:geo.lat,lng:geo.lng,accuracy:geo.accuracy,sampledAt:geo.sampledAt},{employmentId:identity},operation(owner));assertAuthGeneration(owner);
      if(locationAssessment.outcome!=='pass'&&locationAssessment.outcome!=='not_enforced'){
        removeLocalFile(photo);
        const approximate=geo.permissionAccuracy==='approximate'&&['poor_accuracy','outside_site'].includes(locationAssessment.outcome);
        putClock({...next,phase:'idle',geo,locationAssessment,...(approximate?{locationIssue:'approximate_permission'}:{}),message:t(approximate?'locationApproximate':locationRefusals[locationAssessment.outcome])});return;
      }
      if(current.attendancePhotoSetting==='required'&&!photo){photo=await capturePhoto(operation(owner).assertCurrent)??undefined;assertAuthGeneration(owner);if(!photo)throw new Error(t('photoRequired'));}
      const deviceToken=await readClockDevice(identity);assertAuthGeneration(owner);
      if(!putClock({...next,phase:'review',geo,locationAssessment,photo,deviceToken}))removeLocalFile(photo);
    }catch(e){removeLocalFile(photo);putClock({...next,phase:'idle',message:e instanceof PendingSubmissionConflict?t('attemptReplacementBlocked'):e instanceof EnrollmentConflict?t('signedClockRegistrationRequired'):!next.requestId?t('attemptSaveFailed'):errorMessage(e),...(e instanceof LocationCaptureError?{locationIssue:e.issue}:{})});if(e instanceof SignInRequiredError)void signOut();}
    finally{flight.current=false;}
  }
  async function reportAttempt(){
    if(flight.current||!draft?.requestId||!draft.attemptStartedAt)return;
    flight.current=true;const owner=authGeneration();putClock({...draft,phase:'preparing',message:t('attemptSending')});
    try{const receipt=await recovery.reportAttempt(draft.requestId,operation(owner));assertAuthGeneration(owner);putClock({...draft,attemptReceiptTime:receipt.receivedAt,message:t('attemptReported')},draft.requestId);attempts.reload();}
    catch(e){putClock({...draft,message:t('attemptReportUncertain')},draft.requestId);if(e instanceof SignInRequiredError)void signOut();}
    finally{flight.current=false;}
  }
  async function takePhoto(){
    let captured:ClockDraft['photo'];
    if(flight.current||!draft||pending)return;flight.current=true;const owner=authGeneration();putClock({...draft,phase:'preparing'});
    try{const photo=await capturePhoto(operation(owner).assertCurrent);captured=photo??undefined;assertAuthGeneration(owner);if(photo){if(putClock({...draft,photo},draft.requestId))removeLocalFile(draft.photo);else removeLocalFile(photo);}else putClock(draft,draft.requestId);}
    catch(e){removeLocalFile(captured);putClock({...draft,message:errorMessage(e)},draft.requestId);}finally{flight.current=false;}
  }
  async function register(){
    if(flight.current||!identity||!draft||pending)return;flight.current=true;const owner=authGeneration();putClock({...draft,phase:'preparing'});
    try{const registered=await apiPost('clock-device',{label:`AI HR · ${Platform.OS}`},{employmentId:identity},operation(owner));assertAuthGeneration(owner);
      if(!putClock({...draft,deviceToken:registered.deviceToken,message:undefined},draft.requestId))return;
      await writeClockDevice(identity,registered.deviceToken,()=>assertAuthGeneration(owner));
    }catch(e){putClock({...draft,message:errorMessage(e)},draft.requestId);if(e instanceof SignInRequiredError)void signOut();}finally{flight.current=false;}
  }
  function signedResult(result:SignedClockStatus,saved:ClockDraft){
    setSignedStatus(result);
    if(result.status==='accepted'){
      removeLocalFile(saved.photo);putClock({...saved,photo:undefined,phase:'done',receiptTime:result.receipt.recordedAt,message:undefined},saved.requestId);clock.reload();return true;
    }
    if(result.status==='abandoned'){
      removeLocalFile(saved.photo);putClock({employmentId:identity??undefined,action:saved.action,phase:'idle',message:t('pendingDiscarded')},saved.requestId);clock.reload();return true;
    }
    return false;
  }
  async function submitSigned(saved:ClockDraft,owner:number){
    const controller=await signedClock(),pending=await controller.status();assertAuthGeneration(owner);
    if(pending.status==='other_pending'||pending.status==='pending'&&(pending.requestId!==saved.requestId||pending.action!==saved.action))throw new Error(t('signedClockOtherPending'));
    const observed=await controller.recover(false,saved.requestId);assertAuthGeneration(owner);
    if(signedResult(observed,saved))return;
    if(observed.status==='other_pending')throw new Error(t('signedClockOtherPending'));
    if(!await recovery.hasSignedAttempt(saved.requestId!)){
      if(!saved.geo?.source)throw new Error(t('signedClockSavedUnavailable'));
      const staged=await recovery.stage(JSON.stringify({action:saved.action,requestId:saved.requestId,lat:saved.geo.lat,lng:saved.geo.lng,accuracy:saved.geo.accuracy,sampledAt:saved.geo.sampledAt,deviceToken:saved.deviceToken}),saved.photo,saved.geo.source);
      removeLocalFile(staged.file);assertAuthGeneration(owner);
    }
    await recovery.reportAttempt(saved.requestId!,operation(owner));assertAuthGeneration(owner);attempts.reload();
    await controller.start(saved.requestId!);assertAuthGeneration(owner);
    const result=await controller.advance(saved.requestId);assertAuthGeneration(owner);
    if(!signedResult(result,saved))putClock({...saved,phase:'uncertain',message:t(result.status==='other_pending'?'signedClockOtherPending':'signedClockPending')},saved.requestId);
  }
  async function submit(){
    if(flight.current||!identity||!draft?.requestId||(!draft.geo&&draft.clockProtocol!=='signed')||!current||AppState.currentState!=='active')return;
    if(draft.phase!=='uncertain'&&draft.geo&&Math.abs(Date.now()-draft.geo.sampledAt)>120000){putClock({...draft,phase:'idle',message:t('locationExpired')});return;}
    if(current.deviceRequired&&!draft.deviceToken&&draft.clockProtocol!=='signed')return;
    flight.current=true;const owner=authGeneration();
    let sent=false;
    let reportingAttempt=false;
    let uploadFile:ClockDraft['photo'];
    putClock({...draft,phase:'submitting',message:undefined});
    try{
      if(draft.clockProtocol==='signed'){await submitSigned(draft,owner);return;}
      if(!draft.geo)throw new Error(t('locationInvalid'));
      const staged=await recovery.stage(JSON.stringify({action:draft.action,requestId:draft.requestId,lat:draft.geo.lat,lng:draft.geo.lng,accuracy:draft.geo.accuracy,sampledAt:draft.geo.sampledAt,deviceToken:draft.deviceToken}),draft.photo);assertAuthGeneration(owner);
      uploadFile=staged.file;
      if(!putClock({...draft,photo:staged.file,phase:'submitting'},draft.requestId))return;
      reportingAttempt=true;await recovery.reportAttempt(draft.requestId,operation(owner));assertAuthGeneration(owner);
      attempts.reload();
      const form=new FormData();form.append('command',staged.command);if(staged.file)appendAttachment(form,'photo',staged.file);
      sent=true;const result=await apiPost('clock',form,{employmentId:identity},operation(owner));assertAuthGeneration(owner);
      await recovery.resolve(draft.requestId);assertAuthGeneration(owner);
      if(result.outcome==='accepted'){removeLocalFile(draft.photo);putClock({...draft,photo:undefined,phase:'done',receiptTime:result.receipt.recordedAt});}
      else{if(result.code==='device_required')await clearClockDevice();removeLocalFile(draft.photo);putClock({employmentId:identity,action,phase:'idle',message:t(result.locationReason?locationRefusals[result.locationReason]:refusals[result.code])});}
      clock.reload();
    }catch(e){
      if(draft.clockProtocol==='signed'){
        if(e instanceof EnrollmentConflict)setRegistrationNeeded(true);
        putClock({...draft,phase:'uncertain',message:t(e instanceof EnrollmentConflict?'signedClockRegistrationRequired':'signedClockPending')},draft.requestId);
        if(e instanceof SignInRequiredError)void signOut();return;
      }
      let refused=false;
      if(sent&&e instanceof RequestRejectedError&&[400,403,404,413,415,422].includes(e.status))try{await recovery.resolve(draft.requestId);refused=true;}catch{}
      if(refused){removeLocalFile(draft.photo);putClock({action,phase:'idle',message:t('genericError')},draft.requestId);}
      else putClock({...draft,phase:'uncertain',message:t(sent?'clockUncertain':reportingAttempt?'attemptReportRequired':e instanceof SubmissionJournalFull?'pendingStorageFull':'submissionSaveFailed')},draft.requestId);
      if(e instanceof SignInRequiredError)void signOut();
    }
    finally{removeLocalFile(uploadFile);flight.current=false;}
  }
  async function recover(abandon=false){
    if(flight.current||!identity||!draft?.requestId)return;
    flight.current=true;const owner=authGeneration();
    try{
      if(draft.clockProtocol==='signed'){
        const controller=await signedClock(),status=await controller.status();assertAuthGeneration(owner);
        if(status.status==='pending'&&(status.requestId!==draft.requestId||status.action!==draft.action)||status.status==='other_pending')throw new Error(t('signedClockOtherPending'));
        const observed=await controller.recover(abandon,draft.requestId);assertAuthGeneration(owner);
        if(signedResult(observed,draft))return;
        if(observed.status!=='empty'){putClock({...draft,message:t('signedClockPending')},draft.requestId);return;}
      }
      const result=abandon?await apiPost('submission-abandon',{kind:'clock',requestId:draft.requestId},{employmentId:identity},operation(owner)):await apiGet('submission-receipt',{kind:'clock',requestId:draft.requestId,employmentId:identity});assertAuthGeneration(owner);
      if(result.kind!=='clock'||result.requestId!==draft.requestId||result.receipt&&result.receipt.direction!==draft.action)throw new Error('Unexpected submission receipt');
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
  function cancel(){
    removeLocalFile(draft?.photo);
    if(draft?.phase==='review'&&draft.attemptStartedAt)putClock({employmentId:identity??undefined,action:draft.action,requestId:draft.requestId,
      attemptStartedAt:draft.attemptStartedAt,attemptReceiptTime:draft.attemptReceiptTime,phase:'idle',message:t('attemptSavedNotSent')});
    else putClock(null);
  }
  if(clock.data&&!clock.data.enabled)return <Muted>{t('attendanceOff')}</Muted>;
  return <View style={{gap:16}}>
    <LoadState loading={clock.loading} hasData={current!=null} error={clock.error} onRetry={clock.reload}/>
    {!!recovery.error&&<><Muted>{t('genericError')}</Muted><Button title={t('retry')} onPress={recovery.reload}/></>}
    {registrationNeeded&&<><Muted>{t('signedClockRegistrationRequired')}</Muted><Button title={t('integrityEnrollmentTitle')} onPress={()=>router.push('/integrity-keys')}/></>}
    {signedStatus?.status==='other_pending'&&<Muted>{t('signedClockOtherPending')}</Muted>}
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
        {!!draft?.attemptStartedAt&&!['done','uncertain','submitting'].includes(draft.phase)&&<Card>
          <Text accessibilityRole="header" style={{color:palette.text,fontSize:19,fontWeight:'600'}}>{t('pendingAttempt')}</Text>
          <Muted>{t('attemptTimeClaim')}</Muted>
          <Row label={t('attemptClaimedAt')} value={new Date(draft.attemptStartedAt).toLocaleString(appLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}/>
          <Text selectable style={{color:palette.text}}>{draft.requestId}</Text>
          {draft.attemptReceiptTime?<><Muted>{t('attemptReported')}</Muted><Row label={t('attemptReceivedAt')} value={new Date(draft.attemptReceiptTime).toLocaleString(appLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}/></>:<Button title={t('sendAttemptRecord')} disabled={pending} kind="quiet" onPress={()=>void reportAttempt()}/>}
        </Card>}
        {draft?.phase==='idle'&&<Button title={t('reviewSavedAttempts')} kind="quiet" onPress={()=>router.push('/pending-submissions')}/>}
        {draft?.locationIssue&&['permission_blocked','approximate_permission','services_disabled'].includes(draft.locationIssue)&&<Button title={t('openLocationSettings')} kind="quiet" onPress={()=>{void Linking.openSettings().catch(()=>{});}}/>}
        {draft?.locationAssessment&&<Card>
          {draft.locationAssessment.siteName&&<Row label={t('assignedLocation')} value={draft.locationAssessment.siteName}/>}
          {draft.locationAssessment.distanceM!=null&&<Row label={t('locationDistance')} value={`${Math.round(draft.locationAssessment.distanceM)} m`}/>}
          {draft.locationAssessment.radiusM!=null&&<Row label={t('locationRadius')} value={`${draft.locationAssessment.radiusM} m`}/>}
          {draft.locationAssessment.accuracyM!=null&&<Row label={t('locationAccuracy')} value={`± ${Math.round(draft.locationAssessment.accuracyM)} m`}/>}
          {draft.locationAssessment.maximumAccuracyM!=null&&<Row label={t('locationMaximumAccuracy')} value={`${draft.locationAssessment.maximumAccuracyM} m`}/>}
        </Card>}
        {draft?.geo&&(draft.phase==='review'||draft.phase==='uncertain'||draft.phase==='submitting')&&<Card>
          <Text style={{color:palette.text,fontSize:21,fontWeight:'600'}}>{label}</Text>
          <Row label={t('locationAccuracy')} value={`± ${Math.round(draft.geo.accuracy)} m`}/>
          <Muted>{current.geofencingRequired?t('geofenceRechecked'):t('locationRecorded')}</Muted>
          <Muted>{t('serverTime')}</Muted>
          {draft.photo&&<Image source={{uri:draft.photo.uri}} style={{width:96,height:96,borderRadius:8}} accessibilityLabel={t('attendancePhoto')}/>}
          {current.attendancePhotoSetting==='optional'&&draft.phase==='review'&&<Button title={draft.photo?t('retakePhoto'):t('addPhoto')} kind="quiet" onPress={()=>void takePhoto()}/>}
          {current.deviceRequired&&!draft.deviceToken&&<><Muted>{t('registrationNotice')}</Muted><Button title={t('registerDevice')} onPress={()=>void register()}/></>}
        </Card>}
        {draft?.phase==='uncertain'?<><Muted>{t('retrySameClock')}</Muted><Button title={t('checkReceipt')} onPress={()=>void recover()}/><Button title={t('retrySameClock')} disabled={!recovery.ready} onPress={()=>void submit()}/>
          {draft.clockProtocol==='signed'&&<Button title={t('pendingDiscard')} kind="quiet" onPress={()=>Alert.alert(t('pendingDiscard'),t('pendingDiscardConfirm'),[{text:t('cancel'),style:'cancel'},{text:t('pendingDiscard'),style:'destructive',onPress:()=>void recover(true)}])}/>}
        </>:<SlideConfirm label={pending?t('preparingClock'):draft?.phase==='review'?t('slideRecord',{action:label}):t('slidePrepare',{action:label})} disabled={!current||pending||!recovery.ready||signedStatus?.status==='other_pending'||(draft?.phase==='review'&&current.deviceRequired&&!draft.deviceToken)} onConfirm={()=>void(draft?.phase==='review'?submit():prepare())}/>}
        {draft&&draft.phase==='review'&&<Button title={t('cancel')} kind="quiet" onPress={cancel}/>}
        <Muted>{t('onlineClockOnly')}</Muted>
      </>}
      <View style={{gap:8,marginTop:8}}><Text style={{color:palette.text,fontSize:17,fontWeight:'600'}}>{t('clockHistory')}</Text>
        {current.legacy.map((c,i)=><Row key={`${c.direction}-${c.time}-${i}`} label={c.direction==='in'?t('clockIn'):t('clockOut')} value={c.time.slice(0,5)}/>)}
        {current.captures.map(c=><Row key={c.id} label={c.direction==='in'?t('clockIn'):t('clockOut')} value={new Date(c.recordedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kuala_Lumpur'})}/>)}
        {!current.captures.length&&!current.legacy.length&&<Muted>{t('noClockHistory')}</Muted>}
      </View>
      <View style={{gap:8,marginTop:8}}>
        <Text style={{color:palette.text,fontSize:17,fontWeight:'600'}}>{t('reportedAttempts')}</Text>
        <Muted>{t('reportedAttemptsHint')}</Muted>
        <LoadState loading={attempts.loading} hasData={!!attempts.data} error={attempts.error} onRetry={attempts.reload}/>
        {attempts.data?.items.map(item=><Card key={item.requestId}>
          <Text style={{color:palette.text,fontWeight:'600'}}>{t(item.action==='in'?'clockIn':'clockOut')}</Text>
          <Row label={t('attemptClaimedAt')} value={new Date(item.claimedAt).toLocaleString(appLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}/>
          <Row label={t('attemptReceivedAt')} value={new Date(item.receivedAt).toLocaleString(appLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}/>
          <Text selectable style={{color:palette.text}}>{item.requestId}</Text>
        </Card>)}
        {attempts.data&&!attempts.data.items.length&&<Muted>{t('noReportedAttempts')}</Muted>}
      </View>
    </>}
  </View>;
}
