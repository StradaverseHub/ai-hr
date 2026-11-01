import {useEffect,useRef,useState} from 'react';
import {AppState,Image,View,useWindowDimensions,type ViewProps} from 'react-native';
import {requireNativeView} from 'expo';
import type {ProtectedDocument} from './protected-document';
import type {MobileRefusal} from '../../lib/mobile-api/v2/common';
import {authGeneration} from './auth';
import {SignInRequiredError} from './errors';
import {Button,Muted} from './ui';
import {appLocale,t} from './i18n';

type PDFProps=ViewProps&{uri:string;page:number;onDocumentLoad:(e:{nativeEvent:{pages:number}})=>void;onDocumentError:()=>void};
const PDF=requireNativeView<PDFProps>('AihrDocuments');
const words={en:['View','Close','Previous page','Next page','Page'],ms:['Lihat','Tutup','Halaman sebelumnya','Halaman seterusnya','Halaman'],zh:['查看','关闭','上一页','下一页','页'],ta:['காட்டு','மூடு','முந்தைய பக்கம்','அடுத்த பக்கம்','பக்கம்'],th:['ดู','ปิด','หน้าก่อนหน้า','หน้าถัดไป','หน้า'],vi:['Xem','Đóng','Trang trước','Trang tiếp','Trang']};
/** Only a bearer-authorized download may supply a protected temporary document. No remote PDF or export path. */
export function ApprovalDocument({name,open,onSignInRequired}:{name:string;open:()=>Promise<{outcome:'file';document:ProtectedDocument}|MobileRefusal>;onSignInRequired:()=>void}){
 const [state,setState]=useState<'closed'|'loading'|'open'|'error'>('closed'),[doc,setDoc]=useState<ProtectedDocument|null>(null),[page,setPage]=useState(0),[pages,setPages]=useState(0);
 const live=useRef(true),visible=useRef(AppState.currentState==='active'),held=useRef<ProtectedDocument|null>(null),flight=useRef(false),epoch=useRef(0);
 const size=useWindowDimensions(),copy=words[appLocale()];
 function close(){epoch.current++;held.current?.delete();held.current=null;setDoc(null);setState('closed');setPage(0);setPages(0);}
 useEffect(()=>{live.current=true;const sub=AppState.addEventListener('change',next=>{visible.current=next==='active';if(!visible.current)close();});return()=>{live.current=false;epoch.current++;sub.remove();held.current?.delete();held.current=null;};},[]);
 async function show(){if(flight.current||!visible.current)return;flight.current=true;const owner=authGeneration(),ticket=++epoch.current;setState('loading');
  try{const result=await open();if(result.outcome!=='file'){if(live.current&&ticket===epoch.current)setState('error');return;}
   if(!live.current||!visible.current||owner!==authGeneration()||ticket!==epoch.current){result.document.delete();return;}
   held.current?.delete();held.current=result.document;setDoc(result.document);setPage(0);setPages(0);setState('open');
  }catch(e){if(e instanceof SignInRequiredError)onSignInRequired();if(live.current&&ticket===epoch.current)setState('error');}finally{flight.current=false;}}
 return <View style={{gap:10}}>
  <Muted>{name}</Muted>
  {state==='open'&&doc?<>
   {doc.mimeType==='application/pdf'?<>
    <PDF key={doc.uri} uri={doc.uri} page={page} accessibilityLabel={`${name} · ${copy[4]} ${page+1}`} onDocumentLoad={e=>setPages(e.nativeEvent.pages)} onDocumentError={()=>{held.current?.delete();held.current=null;setDoc(null);setState('error');}} style={{width:'100%',height:Math.max(260,Math.min(650,size.height*.65))}}/>
    {pages>0&&<><Muted>{`${copy[4]} ${page+1} / ${pages}`}</Muted><View style={{flexDirection:'row',gap:10}}><View style={{flex:1}}><Button title={copy[2]} disabled={page===0} onPress={()=>setPage(p=>p-1)}/></View><View style={{flex:1}}><Button title={copy[3]} disabled={page>=pages-1} onPress={()=>setPage(p=>p+1)}/></View></View></>}
   </>:<Image accessibilityLabel={name} source={{uri:doc.uri}} resizeMode="contain" style={{width:'100%',height:Math.max(260,Math.min(650,size.height*.65))}}/>}
   <Button title={copy[1]} kind="quiet" onPress={close}/>
  </>:<Button title={state==='loading'?t('loading'):copy[0]} accessibilityLabel={`${copy[0]}: ${name}`} kind="quiet" disabled={state==='loading'} onPress={()=>void show()}/>}
  {state==='error'&&<Muted>{t('genericError')}</Muted>}
 </View>;
}
