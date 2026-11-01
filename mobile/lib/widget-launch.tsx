import {useEffect,useRef} from 'react';
import {AppState} from 'react-native';
import * as Linking from 'expo-linking';
import {router} from 'expo-router';
import {useSession} from './session';
import {identityNamespace} from './config';
import {widgetIntents} from './widget-intent';
import {initializeAttendanceWidgets} from './attendance-widgets';
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
 useEffect(()=>{initializeAttendanceWidgets();},[language]);
 useEffect(()=>{
  mounted.current=true;let live=true;const receive=(url:string)=>{const s=current.current;if(widgetIntents.capture(url,{namespace:s.namespace,employmentId:s.employmentId},Date.now()))deliver();};
  void Linking.getInitialURL().then(url=>{if(live&&url)receive(url);}).catch(()=>{});
  const links=Linking.addEventListener('url',e=>receive(e.url)),state=AppState.addEventListener('change',next=>{if(next==='active')deliver();});
  return()=>{mounted.current=false;live=false;links.remove();state.remove();if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}};
 },[]);
 useEffect(()=>{deliver();},[status,visible,employmentId,namespace]);
 return null;
}
