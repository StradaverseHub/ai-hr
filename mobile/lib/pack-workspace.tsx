import {useCallback,useEffect,useRef,useState} from 'react';
import { TextInput, FlatList, View } from 'react-native';
import { InAppAlert as Alert } from './in-app-alert';
import {SafeAreaView} from 'react-native-safe-area-context';
import {router,Redirect,useFocusEffect} from 'expo-router';
import {randomUUID} from 'expo-crypto';
import {PackWorkspaceResult,PackWorkspaceDecisionResult,type PackWorkspaceKind,type PackWorkspaceCommand,type PackAction,type PackValue} from '../../lib/mobile-api/v2/pack-workspaces';
import {useApiV2,apiPostV2,apiDownload,v2Download} from './api';
import {authGeneration,assertAuthGeneration} from './auth';
import {useSession} from './session';
import {SignInRequiredError,RequestRejectedError} from './errors';
import {Atmosphere,DesignText as Text,useTenantDesign} from './design';
import {Screen,Title,Card,Row,Muted,Button,Chip,HeaderBack,LoadState} from './ui';
import {PickerField} from './leave-request-form';
import {ApprovalDocument} from './approval-document';
import {t} from './i18n';
import {requestCopy} from './request-workspace-copy';
/** Dynamic fields describe presentation only. The server reloads the owner workspace before every write. */
export function PackWorkspaceScreen({kind,id}:{kind:PackWorkspaceKind;id:string}){
 const {signOut,status}=useSession(),{palette}=useTenantDesign(),path=`v2/pack-workspaces/${kind}/${id}` as const;
 const [focus,setFocus]=useState<string|undefined>(),[offset,setOffset]=useState(0);
 const read=useApiV2(path,PackWorkspaceResult,{focus,offset:String(offset)},signOut),w=read.data?.outcome==='found'?read.data.workspace:null;
 const [chosen,setChosen]=useState<string|null>(null),[edits,setEdits]=useState<Record<string,PackValue>>({}),[pending,setPending]=useState<{body:PackWorkspaceCommand;uncertain:boolean}|null>(null),[done,setDone]=useState(false),[notice,setNotice]=useState<string|null>(null);
 const live=useRef(true),flight=useRef(false),digest=useRef<string|null>(null);
 useFocusEffect(useCallback(()=>{live.current=true;return()=>{live.current=false;};},[]));
 useEffect(()=>{if(w&&digest.current!==w.expected.digest){digest.current=w.expected.digest;setChosen(null);setEdits({});}},[w?.expected.digest]);
 const action=w?.actions.find(a=>a.id===chosen),value=(key:string,fallback:PackValue)=>Object.prototype.hasOwnProperty.call(edits,key)?edits[key]:fallback;
 function valuesOf(a:PackAction){const values:Record<string,PackValue>=Object.create(null);for(const f of a.fields){let v=value(f.key,f.value);if(f.kind==='number'&&typeof v==='string'&&v.trim()!=='')v=Number(v);if(f.required&&(v===null||v===''||f.kind==='boolean'&&v!==true))return null;if(typeof v==='number'&&!Number.isFinite(v))return null;if(typeof v==='string'&&f.minLength&&v.trim().length<f.minLength)return null;values[f.key]=v;}return values;}
 async function send(body:PackWorkspaceCommand){if(flight.current||!live.current)return;flight.current=true;const generation=authGeneration();setPending({body,uncertain:false});setNotice(null);
  try{const result=await apiPostV2(`${path}/decision`,PackWorkspaceDecisionResult,body);assertAuthGeneration(generation);if(!live.current)return;setPending(null);if(result.outcome==='accepted')setDone(true);else{setNotice(t(result.code==='stale_step'?'approvalRefusalStale':'approvalRefusalOther'));read.reload();}}
  catch(e){if(e instanceof SignInRequiredError){setPending(null);void signOut();}else if(e instanceof RequestRejectedError){setPending(null);setNotice(t('genericError'));read.reload();}else setPending({body,uncertain:true});}finally{flight.current=false;}}
 function confirm(){if(!w||!action||pending)return;const values=valuesOf(action);if(!values){setNotice(t('genericError'));return;}const generation=authGeneration(),body={requestId:randomUUID(),action:action.id,values,expected:w.expected};
  const message=[w.title,action.label,action.consequence].join('\n');
  Alert.alert(t('approvalConfirmTitle'),message,[{text:t('cancel'),style:'cancel'},{text:t('confirmAction'),onPress:()=>{if(live.current&&authGeneration()===generation)void send(body);}}]);}
 function navigate(person:string|undefined,page=offset){setChosen(null);setEdits({});setNotice(null);setFocus(person);setOffset(page);}
 const change=(key:string,next:PackValue)=>setEdits(v=>({...v,[key]:next}));
 if(done)return <Screen back><Text accessibilityRole="alert">{requestCopy().done}</Text><Button title={t('approvalsBack')} onPress={()=>router.replace('/approvals')}/></Screen>;
 // Each review block is virtualized; no facts are hidden by line clamps.
 const form=<View style={{gap:16}}>
  {w?.documents.map(doc=><ApprovalDocument key={doc.id} name={doc.name} onSignInRequired={signOut} open={()=>apiDownload(v2Download(`${path}/document`,10*1024*1024,['application/pdf','image/jpeg','image/png']),{attachment:doc.id})}/>)}
  {w?.actions.map(a=><Chip key={a.id} title={a.label} selected={chosen===a.id} disabled={!!pending} onPress={()=>{setChosen(a.id);setEdits({});}}/>)}
  {action&&<><Muted>{action.consequence}</Muted>{action.fields.map(f=>{
   const v=value(f.key,f.value),disabled=!!pending;
   if(f.kind==='boolean')return <Chip key={f.key} title={`${v===true?'✓ ':''}${f.label}`} selected={v===true} disabled={disabled} onPress={()=>change(f.key,v!==true)}/>;
   if(f.kind==='date')return <PickerField key={f.key} label={f.label} mode="date" value={typeof v==='string'?v:undefined} today={w?.today??'2000-01-01'} disabled={disabled} onChange={next=>change(f.key,next)}/>;
   if(f.kind==='choice')return <Card key={f.key}><Muted>{f.label}</Muted>{f.options?.map(o=><Chip key={o.value} title={o.label} selected={String(v)===o.value} disabled={disabled} onPress={()=>change(f.key,o.value)}/>)}</Card>;
   return <View key={f.key} style={{gap:8}}><Muted>{f.label}</Muted><TextInput accessibilityLabel={f.label} value={v==null?'':String(v)} onChangeText={next=>change(f.key,next)} editable={!disabled} keyboardType={f.kind==='number'?'decimal-pad':'default'} multiline={f.kind==='text'} maxLength={4000} style={[{ fontFamily: 'FieldRegular' }, {color:palette.text,borderWidth:1,borderColor:palette.border,borderRadius:12,padding:12,minHeight:48,fontSize:16}]}/></View>;
  })}{!pending&&<Button title={t('confirmAction')} disabled={!w||read.loading||!!read.error||!valuesOf(action)} onPress={confirm}/>}</>}
  {pending?.uncertain&&<Card><Muted>{t('approvalUncertain')}</Muted><Button title={t('approvalRetry')} onPress={()=>void send(pending.body)}/></Card>}{pending&&!pending.uncertain&&<Muted>{t('approvalSending')}</Muted>}
 </View>;
 if(status!=='signedIn')return <Redirect href="/sign-in"/>;
 return <SafeAreaView edges={[]} style={{flex:1,backgroundColor:palette.bg}}><Atmosphere/>
  <FlatList data={w?.blocks??[]} keyExtractor={b=>b.id} contentContainerStyle={{padding:20,paddingBottom:40,gap:16}} refreshing={read.loading&&!!read.data} onRefresh={read.reload}
   ListHeaderComponent={<View style={{gap:16}}><HeaderBack/><LoadState loading={read.loading} hasData={read.data!=null} error={read.error} onRetry={read.reload}/>{notice&&<Text accessibilityRole="alert">{notice}</Text>}{read.data?.outcome==='refused'&&<Muted>{t('approvalRefusalNotAssigned')}</Muted>}{w&&<Title>{w.title}</Title>}{w?.navigation&&<Card><Muted>{w.navigation.offset+1}–{Math.min(w.navigation.offset+25,w.navigation.total)} / {w.navigation.total}</Muted>{w.navigation.people.map(p=><Chip key={p.id} title={p.name} selected={w.navigation!.focus===p.id} disabled={!!pending} onPress={()=>navigate(p.id)}/>)}{w.navigation.offset>0&&<Button title="Previous people" disabled={!!pending} onPress={()=>navigate(undefined,Math.max(0,offset-25))}/>} {w.navigation.hasMore&&<Button title="Next people" disabled={!!pending} onPress={()=>navigate(undefined,offset+25)}/>}</Card>}</View>}
   renderItem={({item:b})=><Card><Text style={{color:palette.text,fontSize:18,fontWeight:'600'}}>{b.title}</Text>{b.rows.map((r,i)=><Row key={i} label={r.label} value={r.value}/>)}</Card>}
   ListFooterComponent={form}/>
 </SafeAreaView>;
}
