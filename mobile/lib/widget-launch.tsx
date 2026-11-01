import {useEffect,useRef,useState} from 'react';
import {AppState} from 'react-native';
import * as Linking from 'expo-linking';
import {router} from 'expo-router';
import {useSession} from './session';
import {identityNamespace} from './config';
import {widgetIntents} from './widget-intent';
import {initializeAttendanceWidgets,updateAttendanceWidgets} from './attendance-widgets';
import {apiGet} from './api';
import {authGeneration} from './auth';
import {projectAttendanceWidget} from './widget-snapshot';
import {onShiftReminderRefresh} from './shift-reminder-signal';
import {useDisplayPrefs} from './preferences';
let serial=0;
/** Keeps only a short-lived, non-sensitive direction through sign-in/unlock. Never submits attendance. */
export function WidgetLaunchObserver(){
 const {status,visible,employmentId}=useSession(),namespace=identityNamespace(),{language}=useDisplayPrefs();
 const generation=authGeneration(),scopeKey=JSON.stringify([namespace,generation,employmentId]);
 const epoch=useRef({key:scopeKey,value:0});if(epoch.current.key!==scopeKey)epoch.current={key:scopeKey,value:epoch.current.value+1};
 const [resolved,setResolved]=useState<{key:string;epoch:number;employmentId:string}|null>(null);
 const effectiveEmployment=employmentId??(resolved?.key===scopeKey&&resolved.epoch===epoch.current.value?resolved.employmentId:null);
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null),mounted=useRef(true);
 const current=useRef({status,visible,employmentId:effectiveEmployment,selectedEmploymentId:employmentId,namespace,epoch:epoch.current.value});current.current={status,visible,employmentId:effectiveEmployment,selectedEmploymentId:employmentId,namespace,epoch:epoch.current.value};
 function deliver(){
  if(timer.current!==null)return;
  timer.current=setTimeout(()=>{timer.current=null;const s=current.current;if(!mounted.current||s.status!=='signedIn'||!s.visible||!s.employmentId||AppState.currentState!=='active')return;const action=widgetIntents.take({namespace:s.namespace,employmentId:s.employmentId},Date.now());if(action)router.replace({pathname:'/clock',params:{widgetAction:action,widgetIntent:String(++serial),widgetEmployment:s.employmentId}});},0);
 }
 // Clear at process start and every identity/language change. Locked background state may retain
 // only the bounded, explicitly timestamped snapshot the owner requested for the Home Screen.
 useEffect(()=>{initializeAttendanceWidgets();},[language,namespace,employmentId,generation]);
 useEffect(()=>{if(status==='signedOut'||status==='loading')initializeAttendanceWidgets();},[status]);
 useEffect(()=>{
  if(status!=='signedIn'||!visible)return;
  let live=true,busy=false;const controller=new AbortController(),owner=generation,scope=namespace,selected=employmentId,revision=epoch.current.value;
  const refresh=async()=>{
   if(busy||!live||AppState.currentState!=='active')return;busy=true;
   try{
    const reply=await apiGet('clock',{employmentId:selected??undefined},controller.signal),s=current.current;
    if(live&&authGeneration()===owner&&s.namespace===scope&&s.selectedEmploymentId===selected&&s.epoch===revision&&s.status==='signedIn'&&s.visible&&AppState.currentState==='active'){
     const subject=selected??reply.employmentId;
     if(!subject){updateAttendanceWidgets(null);return;}
     if(!selected&&reply.employmentId)setResolved({key:scopeKey,epoch:revision,employmentId:reply.employmentId});
     updateAttendanceWidgets(projectAttendanceWidget(reply,subject,Date.now()));
    }
   }catch{/* The last confirmed snapshot is dated and expires; an outage never invents a punch. */}
   finally{busy=false;}
  };
  void refresh();const stop=onShiftReminderRefresh(()=>{void refresh();}),poll=setInterval(()=>{void refresh();},60_000);
  return()=>{live=false;controller.abort();stop();clearInterval(poll);};
 },[status,visible,employmentId,namespace,language,generation,scopeKey]);
 useEffect(()=>{
  mounted.current=true;let live=true;const receive=(url:string)=>{const s=current.current;if(widgetIntents.capture(url,{namespace:s.namespace,employmentId:s.employmentId},Date.now()))deliver();};
  void Linking.getInitialURL().then(url=>{if(live&&url)receive(url);}).catch(()=>{});
  const links=Linking.addEventListener('url',e=>receive(e.url)),state=AppState.addEventListener('change',next=>{if(next==='active')deliver();});
  return()=>{mounted.current=false;live=false;links.remove();state.remove();if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}};
 },[]);
 useEffect(()=>{deliver();},[status,visible,effectiveEmployment,namespace]);
 return null;
}
