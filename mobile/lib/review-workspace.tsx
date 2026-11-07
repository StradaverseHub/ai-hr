import {useEffect,useRef,useState} from 'react';
import { TextInput, View } from 'react-native';
import { InAppAlert as Alert } from './in-app-alert';
import {router} from 'expo-router';
import {randomUUID} from 'expo-crypto';
import {ReviewWorkspaceResult,ReviewWorkspaceDecisionResult,REVIEW_TERMINATION_REASONS,ReviewWorkspaceCommand,type ReviewWorkspaceKind} from '../../lib/mobile-api/v2/review-workspaces';
import {apiPostV2,useApiV2} from './api';
import {authGeneration,assertAuthGeneration} from './auth';
import {useSession} from './session';
import {SignInRequiredError,RequestRejectedError} from './errors';
import {DesignText as Text,useTenantDesign} from './design';
import {Screen,Title,Card,Row,Muted,Button,LoadState,Chip} from './ui';
import {t} from './i18n';
import {PickerField} from './leave-request-form';
import {reviewCopy} from './review-workspace-copy';

type Pending={body:ReviewWorkspaceCommand;uncertain:boolean};
/** The recommendation and advisory HR decision are distinct from an approve/reject request. */
export function ReviewWorkspaceScreen({kind,id}:{kind:ReviewWorkspaceKind;id:string}){
 const {signOut}=useSession(),{palette}=useTenantDesign(),copy=reviewCopy();
 const path=`v2/review-workspaces/${kind}/${id}` as const;
 const detail=useApiV2(path,ReviewWorkspaceResult,{},signOut);
 const workspace=detail.data?.outcome==='found'?detail.data.workspace:null;
 const [action,setAction]=useState<ReviewWorkspaceCommand['action']|null>(null),[comments,setComments]=useState(''),[date,setDate]=useState(''),[terminationReason,setTerminationReason]=useState<typeof REVIEW_TERMINATION_REASONS[number]|undefined>();
 const [pending,setPending]=useState<Pending|null>(null),[done,setDone]=useState<'completed'|'pending_hr'|null>(null),[notice,setNotice]=useState<string|null>(null);
 const flight=useRef(false),live=useRef(true);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const actions=kind==='managerReview'?['recommend_confirm','recommend_extend','recommend_terminate'] as const:['confirm','extend','terminate'] as const;
 const online=workspace&&!detail.error&&!detail.loading;
 async function send(body:ReviewWorkspaceCommand){
  if(flight.current||!live.current)return;flight.current=true;const owner=authGeneration();setPending({body,uncertain:false});setNotice(null);
  try{const answer=await apiPostV2(`${path}/decision`,ReviewWorkspaceDecisionResult,body);assertAuthGeneration(owner);
   setPending(null);if(answer.outcome==='accepted')setDone(answer.status);else{setNotice(t('approvalRefusalOther'));detail.reload();}
  }catch(e){if(e instanceof SignInRequiredError){setPending(null);void signOut();}else if(e instanceof RequestRejectedError){setPending(null);setNotice(t('genericError'));detail.reload();}else setPending({body,uncertain:true});}
  finally{flight.current=false;}
 }
 function confirm(){if(!workspace||!action||pending)return;
  const parsed=ReviewWorkspaceCommand.safeParse({requestId:randomUUID(),expected:workspace.expected,action,comments:(kind==='managerReview'||action==='extend')?comments.trim()||undefined:undefined,...(action==='terminate'?{terminationReason}:{}),...(action==='extend'?{extendToDate:date.trim()}: {})});
  if(!parsed.success){setNotice(t('genericError'));return;}
  const generation=authGeneration();
  Alert.alert(t('approvalConfirmTitle'),`${workspace.subject.name}\n${copy[action]}${action==='extend'?` · ${date}`:''}\n${action==='terminate'?terminationReason??'':comments}\n\n${copy.advisory}`,[{text:t('cancel'),style:'cancel'},{text:copy.submit,onPress:()=>{if(live.current&&authGeneration()===generation)void send(parsed.data);}}]);
 }
 const input={color:palette.text,borderColor:palette.border,borderWidth:1,borderRadius:12,padding:12,fontSize:16,minHeight:48};
 if(done)return <Screen back><Text accessibilityRole="alert">{done==='pending_hr'?copy.next:copy.done}</Text><Button title={t('approvalsBack')} onPress={()=>router.replace('/approvals')}/></Screen>;
 return <Screen back onRefresh={detail.reload}>
  <LoadState loading={detail.loading} error={detail.error} hasData={detail.data!=null} onRetry={detail.reload}/>
  {notice&&<Text accessibilityRole="alert">{notice}</Text>}
  {detail.data?.outcome==='refused'&&<Muted>{t('approvalRefusalNotAssigned')}</Muted>}
  {workspace&&<>
   <Title>{workspace.subject.name}</Title>{workspace.subject.code&&<Muted>{workspace.subject.code}</Muted>}<Muted>{t(kind==='managerReview'?'task_managerReview':'task_hrReview')}</Muted>
   <Card><Row label={copy.type} value={workspace.reviewType}/><Row label={t('endDate')} value={workspace.endDate}/><Row label={copy.due} value={workspace.dueDate}/></Card>
   <Muted>{copy.advisory}</Muted>
   {kind==='hrReview'&&<Card><Row label={copy.recommendation} value={workspace.managerRecommendation&&workspace.managerRecommendation in copy?copy[workspace.managerRecommendation as keyof typeof copy]:workspace.managerRecommendation??'—'}/><Row label={copy.managerComments} value={workspace.managerComments??'—'}/></Card>}
   <View style={{gap:10}}>{actions.map(value=><Chip key={value} title={copy[value]} selected={action===value} disabled={!!pending} onPress={()=>{setAction(value);setDate('');setComments('');setTerminationReason(undefined);}}/>)}</View>
   {action==='extend'&&<PickerField label={copy.extension} mode="date" value={date||undefined} today={workspace.endDate} disabled={!!pending} onChange={setDate}/>}
   {action==='terminate'&&<View style={{gap:8}}>{REVIEW_TERMINATION_REASONS.map(reason=><Chip key={reason} title={copy[reason]} selected={terminationReason===reason} disabled={!!pending} onPress={()=>setTerminationReason(reason)}/>)}</View>}
   {(kind==='managerReview'||action==='extend')&&<><Muted>{copy.comments}</Muted><TextInput accessibilityLabel={copy.comments} value={comments} onChangeText={setComments} editable={!pending} multiline maxLength={4000} style={[{ fontFamily: 'FieldRegular' }, [input,{minHeight:96,textAlignVertical:'top'}]]}/></>}
   {!pending&&<Button title={copy.submit} disabled={!online||!action||(action==='terminate'&&!terminationReason)||(action==='extend'&&!/^\d{4}-\d{2}-\d{2}$/.test(date))} onPress={confirm}/>}
   {pending?.uncertain&&<Card><Muted>{t('approvalUncertain')}</Muted><Button title={t('approvalRetry')} onPress={()=>void send(pending.body)}/></Card>}
   {pending&&!pending.uncertain&&<Muted>{t('approvalSending')}</Muted>}
  </>}
 </Screen>;
}
