import {useEffect,useRef,useState} from 'react';
import {Alert,Platform} from 'react-native';
import {DesignText as Text} from './design';
import {useApi} from './api';
import {useSession} from './session';
import {authGeneration} from './auth';
import {identityNamespace} from './config';
import {appLocale,t} from './i18n';
import {SignInRequiredError,RequestRejectedError} from './errors';
import {openOwnedDeviceEnrollment} from './device-enrollment';
import type {DeviceEnrollmentController,DeviceEnrollmentStatus} from './device-enrollment-contract';
import {Button,Card,LoadState,Muted,SectionLabel} from './ui';

export function DeviceEnrollment({employmentId,onChanged}:{employmentId:string;onChanged:()=>void}){
 const platform=Platform.OS;
 return platform==='ios'||platform==='android'?<EnrollmentPanel employmentId={employmentId} platform={platform} onChanged={onChanged}/>:<Muted>{t('integrityEnrollmentUnsupported')}</Muted>;
}
type Local={controller:DeviceEnrollmentController;status:DeviceEnrollmentStatus};
type Action='start'|'advance'|'receipt'|'replace'|'revoke';
function EnrollmentPanel({employmentId,platform,onChanged}:{employmentId:string;platform:'ios'|'android';onChanged:()=>void}){
 const session=useSession(),sessionRef=useRef(session);sessionRef.current=session;
 const capabilities=useApi(platform==='ios'?'v2/integrity/ios/capabilities':'v2/integrity/android/capabilities',{employmentId},session.signOut);
 const owner=authGeneration(),namespace=identityNamespace(),locale=appLocale();
 const identity=JSON.stringify([owner,namespace,locale,employmentId,platform,session.status,session.visible]);
 const lineage=useRef({identity,revision:0});
 if(lineage.current.identity!==identity)lineage.current={identity,revision:lineage.current.revision+1};
 const scope=JSON.stringify([identity,lineage.current.revision]);
 const rendered=useRef(scope);rendered.current=scope;
 const alive=useRef(false),flight=useRef<symbol|null>(null);
 const [record,setRecord]=useState<{scope:string;loading:boolean;local:Local|null;failed:boolean}>({scope,loading:true,local:null,failed:false});
 const [feedback,setFeedback]=useState<{scope:string;kind:'busy'|'uncertain'}|null>(null);
 const view=record.scope===scope?record:{scope,loading:true,local:null,failed:false};
 const current=()=>alive.current&&rendered.current===scope&&authGeneration()===owner&&identityNamespace()===namespace&&appLocale()===locale&&
  sessionRef.current.status==='signedIn'&&sessionRef.current.visible;
 const enabled=capabilities.data?.outcome==='capabilities'&&capabilities.data.platform===platform&&capabilities.data.features.includes('key_enrollment')&&!capabilities.loading&&!capabilities.error;
 const live=useRef({view,enabled});live.current={view,enabled};
 async function initialize(){
  if(!current()||flight.current)return;
  const token=Symbol();flight.current=token;setRecord(previous=>({scope,loading:true,local:previous.scope===scope?previous.local:null,failed:false}));
  try{
   const controller=await openOwnedDeviceEnrollment(employmentId,current),status=await controller.status();
   if(current()&&flight.current===token)setRecord({scope,loading:false,local:{controller,status},failed:false});
  }catch(error){
   if(current()&&flight.current===token){setRecord(previous=>({...previous,scope,loading:false,failed:true}));if(error instanceof SignInRequiredError)void sessionRef.current.signOut();}
  }finally{if(flight.current===token)flight.current=null;}
 }
 useEffect(()=>{
  alive.current=true;flight.current=null;void initialize();
  return()=>{alive.current=false;flight.current=null;};
 },[scope]);
 async function run(action:Action){
  const latest=live.current,local=latest.view.local;if(!current()||flight.current||!local||latest.view.failed||latest.view.loading)return;
  if((action==='start'||action==='advance'||action==='replace')&&(!latest.enabled||!local.controller.supported))return;
  if(action==='start'&&local.status.status!=='empty'||action==='advance'&&(local.status.status!=='pending'||local.status.employmentId!==employmentId)||
   action==='replace'&&(local.status.status!=='stored_key'||!local.status.revoked||!!local.status.reason)||action==='revoke'&&local.status.status!=='revocation_pending')return;
  const token=Symbol();flight.current=token;setFeedback({scope,kind:'busy'});
  try{
   let status:DeviceEnrollmentStatus;
   if(action==='receipt')status=await local.controller.reconcile();
   else if(action==='revoke')status=await local.controller.revoke();
   else if(action==='advance')status=await local.controller.advance();
   else{
    if(action==='replace'&&!local.controller.replace)return;
    status=action==='replace'?await local.controller.replace!():await local.controller.begin();
    if(status.status==='pending')status=await local.controller.advance();
   }
   if(!current()||flight.current!==token)return;
   setRecord({scope,loading:false,local:{controller:local.controller,status},failed:false});setFeedback(null);
   if(status.status==='stored_key')onChanged();
  }catch(error){
   if(!current()||flight.current!==token)return;
   // A failed reply can follow a committed intent/proof/receipt. Read the actual pointer; never
   // replace it with an empty state, auto-repeat a command or show raw SDK/storage errors.
   try{
    const status=await local.controller.status();
    if(current()&&flight.current===token)setRecord({scope,loading:false,local:{controller:local.controller,status},failed:false});
   }catch{if(current()&&flight.current===token)setRecord(previous=>({...previous,failed:true}));}
   if(current()&&flight.current===token){setFeedback({scope,kind:'uncertain'});if(error instanceof SignInRequiredError)void sessionRef.current.signOut();}
  }finally{if(flight.current===token)flight.current=null;}
 }
 function confirm(action:'start'|'advance'|'replace'|'revoke'){
  if(!current()||flight.current)return;
  const revoke=action==='revoke',key=view.local?.status;
  Alert.alert(t(revoke?'integrityRevoke':'integrityEnrollmentConfirmTitle'),
   revoke?t('integrityRevokeConfirm',{id:key&&'keyId' in key?key.keyId:''}):t(action==='replace'?'integrityEnrollmentReplaceConfirm':'integrityEnrollmentConfirm'),[
    {text:t('cancel'),style:'cancel'},
    {text:t(revoke?'integrityRevoke':action==='replace'?'integrityEnrollmentReplace':action==='advance'?'integrityEnrollmentContinue':'integrityEnrollmentStart'),style:revoke?'destructive':'default',onPress:()=>void run(action)},
   ]);
 }
 const busy=feedback?.scope===scope&&feedback.kind==='busy',uncertain=feedback?.scope===scope&&feedback.kind==='uncertain';
 const local=view.local,status=local?.status,disabled=busy||view.loading||view.failed;
 const previous=status?.status==='pending'&&status.employmentId!==employmentId;
 if(session.status!=='signedIn'||!session.visible)return null;
 return <Card>
  <SectionLabel>{t('integrityEnrollmentTitle')}</SectionLabel>
  <Muted>{t('integrityEnrollmentHint')}</Muted>
  {capabilities.error instanceof RequestRejectedError&&capabilities.error.status===404?<Muted>{t('integrityEnrollmentOlderServer')}</Muted>:
   <LoadState loading={capabilities.loading} error={capabilities.error} hasData={capabilities.data!==null} onRetry={capabilities.reload}/>}
  {capabilities.data?.outcome==='unavailable'&&<Muted>{t(capabilities.data.code==='not_configured'?'integrityEnrollmentNotConfigured':'integrityEnrollmentUnavailable')}</Muted>}
  {capabilities.data?.outcome==='refused'&&<Muted>{t('integrityEnrollmentUnavailable')}</Muted>}
  {view.loading&&<Muted>{t('loading')}</Muted>}
  {view.failed&&<><Text accessibilityRole="alert">{t('integrityEnrollmentStorageUnavailable')}</Text><Button title={t('retry')} kind="quiet" disabled={busy||view.loading} onPress={()=>void initialize()}/></>}
  {local&&!local.controller.supported&&<Muted>{t('integrityEnrollmentUnsupported')}</Muted>}
  {status&&<Muted>{t(status.status==='empty'?'integrityEnrollmentEmpty':status.status==='pending'?'integrityEnrollmentPending':status.status==='revocation_pending'?'integrityEnrollmentRevocationPending':status.revoked?'integrityEnrollmentRevoked':'integrityEnrollmentSaved')}</Muted>}
  {status&&'reason' in status&&status.reason&&<Muted>{t('integrityEnrollmentAttention')}</Muted>}
  {previous&&<Muted>{t('integrityEnrollmentPreviousEmployment')}</Muted>}
  {busy&&<Text accessibilityRole="alert">{t('integrityEnrollmentBusy')}</Text>}
  {uncertain&&<Text accessibilityRole="alert">{t('integrityEnrollmentUncertain')}</Text>}
  {status?.status==='empty'&&enabled&&local?.controller.supported&&<Button title={t('integrityEnrollmentStart')} disabled={disabled} onPress={()=>confirm('start')}/>}
  {status&&status.status!=='empty'&&<Button title={t('integrityCheckStatus')} kind="quiet" disabled={disabled} onPress={()=>void run('receipt')}/>}
  {status?.status==='pending'&&!previous&&enabled&&local?.controller.supported&&<Button title={t('integrityEnrollmentContinue')} disabled={disabled} onPress={()=>confirm('advance')}/>}
  {status?.status==='revocation_pending'&&<Button title={t('integrityEnrollmentRetryRevoke')} kind="quiet" disabled={disabled} onPress={()=>confirm('revoke')}/>}
  {status?.status==='stored_key'&&status.revoked&&!status.reason&&enabled&&local?.controller.supported&&local.controller.replace&&<Button title={t('integrityEnrollmentReplace')} disabled={disabled} onPress={()=>confirm('replace')}/>}
 </Card>;
}
