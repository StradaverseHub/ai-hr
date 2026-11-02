import {useEffect,useRef,useState} from 'react';
import { TextInput, View } from 'react-native';
import { InAppAlert as Alert } from './in-app-alert';
import {router} from 'expo-router';
import {randomUUID} from 'expo-crypto';
import {RequestWorkspaceResult,RequestWorkspaceDecisionResult,type RequestWorkspaceKind,type RequestWorkspaceCommand} from '../../lib/mobile-api/v2/request-workspaces';
import {apiPostV2,useApiV2,apiDownload,v2Download} from './api';
import {authGeneration,assertAuthGeneration} from './auth';
import {useSession} from './session';
import {SignInRequiredError,RequestRejectedError} from './errors';
import {DesignText as Text,useTenantDesign} from './design';
import {Screen,Title,Card,Row,Muted,Button,LoadState} from './ui';
import {ApprovalDocument} from './approval-document';
import {t} from './i18n';
import {requestCopy} from './request-workspace-copy';
export function RequestWorkspaceScreen({kind,id}:{kind:RequestWorkspaceKind;id:string}){
 const {signOut}=useSession(),{palette}=useTenantDesign(),copy=requestCopy(),path=`v2/request-workspaces/${kind}/${id}` as const;
 const detail=useApiV2(path,RequestWorkspaceResult,{},signOut),w=detail.data?.outcome==='found'?detail.data.workspace:null;
 const [reason,setReason]=useState(''),[pending,setPending]=useState<{body:RequestWorkspaceCommand;uncertain:boolean}|null>(null),[done,setDone]=useState(false),[notice,setNotice]=useState<string|null>(null);
 const flight=useRef(false),live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 async function send(body:RequestWorkspaceCommand){if(flight.current||!live.current)return;flight.current=true;const generation=authGeneration();setPending({body,uncertain:false});setNotice(null);
  try{const result=await apiPostV2(`${path}/decision`,RequestWorkspaceDecisionResult,body);assertAuthGeneration(generation);setPending(null);if(result.outcome==='accepted')setDone(true);else{setNotice(t(result.code==='stale_step'?'approvalRefusalStale':'approvalRefusalOther'));detail.reload();}}
  catch(e){if(e instanceof SignInRequiredError){setPending(null);void signOut();}else if(e instanceof RequestRejectedError){setPending(null);setNotice(t('genericError'));detail.reload();}else setPending({body,uncertain:true});}finally{flight.current=false;}
 }
 function confirm(action:RequestWorkspaceCommand['action']){if(!w||pending)return;const generation=authGeneration(),body={requestId:randomUUID(),action,expected:w.expected,...(kind==='profile'&&action==='reject'?{reason:reason.trim()}: {})};
  const message=[w.subject,w.kind==='resignation'?`${copy.lastDay}: ${w.lastWorkingDay}\n${copy.consequence}`:w.kind==='noticeAcknowledgement'?`${copy.version}: ${w.contentVersion}`:'',action==='reject'?reason:''].filter(Boolean).join('\n');
  Alert.alert(t('approvalConfirmTitle'),message,[{text:t('cancel'),style:'cancel'},{text:action==='acknowledge'?copy.acknowledge:t(action==='approve'?'approvalApprove':'approvalReject'),style:action==='reject'||kind==='resignation'&&action==='approve'?'destructive':'default',onPress:()=>{if(live.current&&authGeneration()===generation)void send(body);}}]);
 }
 if(done)return <Screen back><Text accessibilityRole="alert">{copy.done}</Text><Button title={t('approvalsBack')} onPress={()=>router.replace('/approvals')}/></Screen>;
 const online=w&&!detail.error&&!detail.loading;
 return <Screen back onRefresh={detail.reload}>
  <LoadState loading={detail.loading} hasData={detail.data!=null} error={detail.error} onRetry={detail.reload}/>
  {notice&&<Text accessibilityRole="alert">{notice}</Text>}{detail.data?.outcome==='refused'&&<Muted>{t('approvalRefusalNotAssigned')}</Muted>}
  {w&&<>
   <Title>{w.subject}</Title>{w.code&&<Muted>{w.code}</Muted>}
   {w.kind==='profile'&&w.lines.map(line=><Card key={line.key}>{line.record&&<Muted>{line.record}</Muted>}<Text style={{color:palette.text,fontSize:17,fontWeight:'600'}}>{line.label}</Text><Row label={copy.before} value={line.before}/><Row label={copy.after} value={line.after}/></Card>)}
   {w.kind==='resignation'&&<><Card><Row label={copy.lastDay} value={w.lastWorkingDay}/>{w.reason&&<Muted>{w.reason}</Muted>}</Card><Text style={{color:palette.text,lineHeight:24}}>{copy.consequence}</Text></>}
   {w.kind==='noticeAcknowledgement'&&<><Card><Row label={copy.version} value={String(w.contentVersion)}/><Row label={copy.sender} value={w.publishedBy??'—'}/>{w.publishedAt&&<Row label={copy.published} value={w.publishedAt}/>}</Card><Text selectable style={{color:palette.text,fontSize:16,lineHeight:25}}>{w.body}</Text></>}
   {w.documents.map(doc=><ApprovalDocument key={doc.ref} name={doc.name} onSignInRequired={signOut} open={()=>apiDownload(v2Download(`${path}/document`,10*1024*1024,['application/pdf','image/jpeg','image/png']),{attachment:doc.ref})}/>)}
   {w.kind==='profile'&&<><Muted>{t('approvalReason')}</Muted><TextInput accessibilityLabel={t('approvalReason')} value={reason} onChangeText={setReason} maxLength={1000} multiline editable={!pending} style={{color:palette.text,borderWidth:1,borderColor:palette.border,borderRadius:12,minHeight:60,padding:12}}/></>}
   {!pending&&(w.kind==='noticeAcknowledgement'?<Button title={copy.acknowledge} disabled={!online} onPress={()=>confirm('acknowledge')}/>:<View style={{flexDirection:'row',gap:12}}><View style={{flex:1}}><Button title={t('approvalReject')} kind="quiet" disabled={!online||w.kind==='profile'&&!reason.trim()} onPress={()=>confirm('reject')}/></View><View style={{flex:1}}><Button title={t('approvalApprove')} disabled={!online} onPress={()=>confirm('approve')}/></View></View>)}
   {pending?.uncertain&&<Card><Muted>{t('approvalUncertain')}</Muted><Button title={t('approvalRetry')} onPress={()=>void send(pending.body)}/></Card>}{pending&&!pending.uncertain&&<Muted>{t('approvalSending')}</Muted>}
  </>}
 </Screen>;
}
