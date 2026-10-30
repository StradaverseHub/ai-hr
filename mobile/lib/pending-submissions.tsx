import {useEffect,useRef,useState} from 'react';
import {Alert} from 'react-native';
import {router} from 'expo-router';
import {DesignText as Text,useTenantDesign} from './design';
import {listOwnedPendingSubmissions,reconcileOwnedPendingSubmission,type PendingSubmissionSummary} from './submission-recovery';
import {SignInRequiredError} from './errors';
import {useSession} from './session';
import {authGeneration} from './auth';
import {identityNamespace} from './config';
import {t,appLocale} from './i18n';
import {useJourneyDrafts,removeLocalFile} from './journey-drafts';
import {Button,Card,LoadState,Muted,Row,Screen,Title} from './ui';
import {useQueuedOfflinePunches} from './offline-clock';
import {releasePushOnExit} from './push-core';

/** Read/reconcile pending intents before a voluntary exit. Forced logout never enters this screen. */
export function PendingSubmissions({intent='review'}:{intent?:'review'|'logout'|'company'}){
  const {signOut,setEmploymentId,employmentId}=useSession(),{palette}=useTenantDesign();
  const drafts=useJourneyDrafts();
  const owner=authGeneration(),namespace=identityNamespace(),key=JSON.stringify([owner,namespace]);
  const current=useRef(key);current.current=key;
  const [inventory,setInventory]=useState<{key:string;items:PendingSubmissionSummary[]|null}>({key,items:null}),[error,setError]=useState<Error|null>(null);
  const items=inventory.key===key?inventory.items:null;
  const [attempt,setAttempt]=useState(0),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true),flight=useRef<symbol|null>(null),exiting=useRef(false);
  function stillCurrent(){return alive.current&&current.current===key&&authGeneration()===owner&&identityNamespace()===namespace;}
  // Saved offline punches stay on this phone across sign-out (the driver keeps them): information, never discardable here.
  const queued=useQueuedOfflinePunches(stillCurrent);
  function setItems(value:PendingSubmissionSummary[]|null|((previous:PendingSubmissionSummary[]|null)=>PendingSubmissionSummary[]|null)){
    if(stillCurrent())setInventory(previous=>stillCurrent()?{key,items:typeof value==='function'?value(previous.key===key?previous.items:null):value}:previous);
  }
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{flight.current=null;exiting.current=false;setBusy(false);setMessage('');},[key]);
  function continueExit(){
    if(!stillCurrent()||exiting.current)return;exiting.current=true;
    // M10/D8: a company change starts revoking this phone's push binding and drops its reminders (bounded, best effort,
    // not awaited: the tokens stay until the company screen applies a new company). Sign-out does it in the session.
    if(intent==='company'){void releasePushOnExit('company',employmentId??null);router.replace('/company');}else void signOut();
  }
  useEffect(()=>{
    let active=true;setItems(null);setError(null);
    void listOwnedPendingSubmissions().then(next=>{
      if(!active||!stillCurrent())return;
      setItems(next.sort((a,b)=>a.createdAt-b.createdAt||a.requestId.localeCompare(b.requestId)));
      if(!next.length&&intent!=='review')continueExit();
    }).catch(e=>{if(active&&stillCurrent()){setError(e instanceof Error?e:new Error());if(e instanceof SignInRequiredError)void signOut();}});
    return()=>{active=false;};
  },[attempt,intent,key]);
  async function reconcile(item:PendingSubmissionSummary,action:'receipt'|'abandon'){
    if(!stillCurrent()||flight.current)return;const token=Symbol();flight.current=token;setBusy(true);setMessage('');
    try{
      const result=await reconcileOwnedPendingSubmission(item,action);
      if(!stillCurrent())return;
      if(result.receipt||result.abandoned){
        if(item.kind==='clock'&&drafts.clock?.employmentId===item.employmentId&&drafts.clock.requestId===item.requestId){removeLocalFile(drafts.clock.photo);drafts.putClock(null,item.requestId);}
        if(item.kind==='leave'&&drafts.leave?.employmentId===item.employmentId&&drafts.leave.command.requestId===item.requestId){removeLocalFile(drafts.leave.document);drafts.putLeave(null,item.requestId);}
        setItems(previous=>previous?.filter(entry=>!(entry.employmentId===item.employmentId&&entry.kind===item.kind&&entry.requestId===item.requestId))??null);
        setMessage(t(result.receipt?'pendingAlreadyRecorded':'pendingDiscarded'));
      }else setMessage(t('pendingUnknown'));
    }catch(e){if(stillCurrent()){setMessage(t('pendingActionFailed'));if(e instanceof SignInRequiredError)void signOut();}}
    finally{if(flight.current===token){flight.current=null;if(stillCurrent())setBusy(false);}}
  }
  function confirmDiscard(item:PendingSubmissionSummary){
    Alert.alert(t('pendingDiscard'),t('pendingDiscardConfirm'),[
      {text:t('cancel'),style:'cancel'},
      {text:t('pendingDiscard'),style:'destructive',onPress:()=>void reconcile(item,'abandon')},
    ]);
  }
  function review(item:PendingSubmissionSummary){
    if(!stillCurrent())return;
    setEmploymentId(item.employmentId);router.replace(item.kind==='clock'?'/':'/leave');
  }
  return <Screen back>
    <Title>{t(intent==='logout'?'pendingBeforeLogout':intent==='company'?'pendingBeforeCompany':'pendingTitle')}</Title>
    <Muted>{t('pendingRetention')}</Muted>
    <LoadState loading={items===null&&!error} error={error} onRetry={()=>setAttempt(value=>value+1)}/>
    {!!error&&<Muted>{t('pendingCountUnavailable')}</Muted>}
    {items!==null&&<Text accessibilityRole="header" style={{color:palette.text,fontSize:19,fontWeight:'600'}}>{t('pendingCount',{n:items.length})}</Text>}
    {!!message&&<Text accessibilityRole="alert" style={{color:palette.text,lineHeight:22}}>{message}</Text>}
    {busy&&<Muted>{t('pendingChecking')}</Muted>}
    {items?.map(item=><Card key={JSON.stringify([item.employmentId,item.kind,item.requestId])}>
      <Text style={{color:palette.text,fontSize:19,fontWeight:'600'}}>{t(item.stage==='preparation'?'pendingAttempt':item.kind==='clock'?'pendingAttendance':'pendingLeave')}</Text>
      {item.stage==='preparation'&&<Muted>{t('attemptSavedNotSent')}</Muted>}
      <Muted>{item.company}</Muted>
      <Row label={t('pendingSaved')} value={new Date(item.createdAt).toLocaleString(appLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}/>
      <Muted>{t('pendingReference')}</Muted><Text selectable style={{color:palette.text}}>{item.requestId}</Text>
      {item.stage!=='preparation'&&<Button title={t('checkReceipt')} disabled={busy} onPress={()=>void reconcile(item,'receipt')}/>}
      <Button title={t('pendingReview')} disabled={busy} kind="quiet" onPress={()=>review(item)}/>
      <Button title={t('pendingDiscard')} disabled={busy} kind="quiet" onPress={()=>confirmDiscard(item)}/>
    </Card>)}
    {intent==='logout'&&queued>0&&<Muted>{t(queued===1?'offlineSignOutNoteOne':'offlineSignOutNote',{n:queued})}</Muted>}
    {intent!=='review'&&<Button title={t(intent==='company'?'pendingKeepCompany':'pendingKeepLogout')} onPress={continueExit}/>}
  </Screen>;
}
