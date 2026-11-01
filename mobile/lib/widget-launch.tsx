import {useEffect,useRef} from 'react';
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
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null),mounted=useRef(true);
 const current=useRef({status,visible,employmentId,namespace});current.current={status,visible,employmentId,namespace};
 function deliver(){
  if(timer.current!==null)return;
  timer.current=setTimeout(()=>{timer.current=null;const s=current.current;if(!mounted.current||s.status!=='signedIn'||!s.visible||!s.employmentId||AppState.currentState!=='active')return;const action=widgetIntents.take({namespace:s.namespace,employmentId:s.employmentId},Date.now());if(action)router.replace({pathname:'/clock',params:{widgetAction:action,widgetIntent:String(++serial)}});},0);
 }
 // Clear at process start and every identity/language change. Locked background state may retain
 // only the bounded, explicitly timestamped snapshot the owner requested for the Home Screen.
 useEffect(()=>{initializeAttendanceWidgets();},[language,namespace,employmentId]);
 useEffect(()=>{if(status==='signedOut'||status==='loading')initializeAttendanceWidgets();},[status]);
 useEffect(()=>{
  if(status!=='signedIn'||!visible||!employmentId)return;
  let live=true,busy=false;const controller=new AbortController(),owner=authGeneration(),scope=namespace,selected=employmentId;
  const refresh=async()=>{
   if(busy||!live||AppState.currentState!=='active')return;busy=true;
   try{
    const reply=await apiGet('clock',{employmentId:selected},controller.signal),s=current.current;
    if(live&&authGeneration()===owner&&s.namespace===scope&&s.employmentId===selected&&s.status==='signedIn'&&s.visible&&AppState.currentState==='active')updateAttendanceWidgets(projectAttendanceWidget(reply,selected,Date.now()));
   }catch{/* The last confirmed snapshot is dated and expires; an outage never invents a punch. */}
   finally{busy=false;}
  };
  void refresh();const stop=onShiftReminderRefresh(()=>{void refresh();}),poll=setInterval(()=>{void refresh();},60_000);
  return()=>{live=false;controller.abort();stop();clearInterval(poll);};
 },[status,visible,employmentId,namespace,language]);
 useEffect(()=>{
  mounted.current=true;let live=true;const receive=(url:string)=>{const s=current.current;if(widgetIntents.capture(url,{namespace:s.namespace,employmentId:s.employmentId},Date.now()))deliver();};
  void Linking.getInitialURL().then(url=>{if(live&&url)receive(url);}).catch(()=>{});
  const links=Linking.addEventListener('url',e=>receive(e.url)),state=AppState.addEventListener('change',next=>{if(next==='active')deliver();});
  return()=>{mounted.current=false;live=false;links.remove();state.remove();if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}};
 },[]);
 useEffect(()=>{deliver();},[status,visible,employmentId,namespace]);
 return null;
}
