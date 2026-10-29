import {useEffect,useRef,useState} from 'react';
import {Alert} from 'react-native';
import {router} from 'expo-router';
import {DesignText as Text,useTenantDesign} from './design';
import {useApi} from './api';
import {revokeIntegrityKey,type IntegrityKey} from './integrity-key-recovery';
import {useSession} from './session';
import {authGeneration} from './auth';
import {identityNamespace} from './config';
import {appLocale,t} from './i18n';
import {SignInRequiredError,RequestRejectedError} from './errors';
import {Button,Card,LoadState,Muted,Row,Screen,Title} from './ui';
import {DeviceEnrollment} from './device-enrollment-screen';

export function IntegrityKeys(){
  const {employmentId,signOut}=useSession(),me=useApi('me',{},signOut);
  const selected=employmentId?me.data?.employments.find(item=>item.employmentId===employmentId)?.employmentId:me.data?.employments[0]?.employmentId;
  const key=JSON.stringify([authGeneration(),identityNamespace(),appLocale(),selected]);
  return <Screen back>
    <Title>{t('integrityKeysTitle')}</Title>
    <Muted>{t('integrityKeysHint')}</Muted>
    <LoadState loading={me.loading} error={me.error} hasData={me.data!==null} onRetry={me.reload}/>
    {me.data&&(selected?<KeyInventory key={key} employmentId={selected}/>:<Muted>{t('integrityKeysNoEmployment')}</Muted>)}
  </Screen>;
}
type Action={kind:'busy'|'uncertain'|'confirmed'|'refused';keyId:string};
function KeyInventory({employmentId}:{employmentId:string}){
  const {signOut}=useSession(),{palette}=useTenantDesign();
  const keys=useApi('v2/integrity/keys',{employmentId},signOut);
  const owner=authGeneration(),namespace=identityNamespace(),locale=appLocale();
  const alive=useRef(true),flight=useRef<symbol|null>(null);
  const [action,setAction]=useState<Action|null>(null),[confirmed,setConfirmed]=useState<Record<string,string>>({});
  const current=()=>alive.current&&authGeneration()===owner&&identityNamespace()===namespace&&appLocale()===locale;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;flight.current=null;};},[]);
  useEffect(()=>{
    if(action?.kind!=='uncertain'||keys.loading||keys.error||keys.data?.outcome!=='keys')return;
    const found=keys.data.items.find(key=>key.keyId===action.keyId);
    if(found?.revokedAt){setConfirmed(previous=>({...previous,[found.keyId]:found.revokedAt!}));setAction({kind:'confirmed',keyId:action.keyId});}
  },[action,keys.data,keys.loading,keys.error]);
  async function revoke(key:IntegrityKey){
    if(!current()||flight.current)return;
    const token=Symbol();flight.current=token;setAction({kind:'busy',keyId:key.keyId});
    try{
      const result=await revokeIntegrityKey(employmentId,key);
      if(!current()||flight.current!==token)return;
      if(result.outcome==='revoked'){
        setConfirmed(previous=>({...previous,[key.keyId]:result.key.revokedAt!}));
        setAction({kind:'confirmed',keyId:key.keyId});keys.reload();
      }else setAction({kind:'refused',keyId:key.keyId});
    }catch(error){
      if(!current()||flight.current!==token)return;
      setAction({kind:'uncertain',keyId:key.keyId});
      if(error instanceof SignInRequiredError)void signOut();
    }finally{if(flight.current===token)flight.current=null;}
  }
  function confirm(key:IntegrityKey){
    if(!current()||flight.current||keys.loading||keys.error)return;
    Alert.alert(t('integrityRevoke'),t('integrityRevokeConfirm',{id:key.keyId}),[
      {text:t('cancel'),style:'cancel'},
      {text:t('integrityRevoke'),style:'destructive',onPress:()=>void revoke(key)},
    ]);
  }
  const oldServer=keys.error instanceof RequestRejectedError&&keys.error.status===404;
  return <>
    <DeviceEnrollment employmentId={employmentId} onChanged={keys.reload}/>
    {oldServer?<Muted>{t('integrityKeysOlderServer')}</Muted>:<LoadState loading={keys.loading} error={keys.error} hasData={keys.data!==null} onRetry={keys.reload}/>}
    {keys.data&&keys.data.outcome!=='keys'&&<Muted>{t('integrityKeysUnavailable')}</Muted>}
    {action&&<Text accessibilityRole="alert" style={{color:palette.text,lineHeight:22}}>{t(action.kind==='busy'?'integrityRevoking':action.kind==='confirmed'?'integrityRevoked':action.kind==='uncertain'?'integrityRevokeUncertain':'integrityRevokeRefused',{id:action.keyId})}</Text>}
    {action?.kind==='uncertain'&&<Button title={t('integrityCheckStatus')} kind="quiet" disabled={keys.loading} onPress={keys.reload}/>}
    {keys.data?.outcome==='keys'&&!oldServer&&<>
      <Muted>{t('integrityKeysBounded')}</Muted>
      {!keys.data.items.length&&<Muted>{t('integrityKeysEmpty')}</Muted>}
      {keys.data.items.map(key=>{
        const revokedAt=confirmed[key.keyId]??key.revokedAt;
        return <Card key={key.keyId}>
          <Muted>{t('integrityKeyReference')}</Muted>
          <Text selectable style={{color:palette.text,fontSize:16}}>{key.keyId}</Text>
          <Row label={t('integrityRegisteredAt')} value={new Date(key.createdAt).toLocaleString(appLocale())}/>
          <Row label={t('integrityKeyStatus')} value={t(revokedAt?'integrityKeyRevoked':'integrityKeyRegistered')}/>
          {revokedAt&&<Row label={t('integrityRevokedAt')} value={new Date(revokedAt).toLocaleString(appLocale())}/>}
          {!revokedAt&&<Button title={t('integrityRevoke')} accessibilityLabel={t('integrityRevokeLabel',{id:key.keyId})} kind="quiet" disabled={action?.kind==='busy'||keys.loading||!!keys.error||action?.kind==='uncertain'&&action.keyId!==key.keyId} onPress={()=>confirm(key)}/>}
        </Card>;
      })}
    </>}
  </>;
}
