import { useRef } from 'react';
import { Pressable,Text,TextInput,View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File,Directory,Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { apiPost,type LeaveOptionsResponse,type LeaveCommand } from './api';
import { authGeneration,assertAuthGeneration } from './auth';
import { appendAttachment } from './capture';
import { useTenantDesign } from './design';
import { SignInRequiredError,RequestRejectedError } from './errors';
import { t,type MessageKey } from './i18n';
import { useJourneyDrafts,removeLocalFile,type LeaveDraft,type LocalAttachment } from './journey-drafts';
import { useSession } from './session';
import { Button,Card,Muted,Row,fmtDays } from './ui';
const durationLabels:Record<LeaveCommand['durationType'],MessageKey>={full_day:'fullDay',half_day_am:'halfAM',half_day_pm:'halfPM',hourly:'hourly'};
export function LeaveRequestForm({options,today,onSubmitted}:{options:LeaveOptionsResponse;today:string;onSubmitted:()=>void}){
  const {palette,design}=useTenantDesign();const {signOut}=useSession();
  const {leave:draft,putLeave}=useJourneyDrafts();const flight=useRef(false);
  const selected=options.items.find(o=>o.id===draft?.command.leaveTypeId);
  const pending=draft?.phase==='submitting'||draft?.phase==='previewing';
  const disabled=pending||draft?.phase==='uncertain';
  function begin(id:string){removeLocalFile(draft?.document);putLeave({phase:'edit',command:{requestId:randomUUID(),leaveTypeId:id,startDate:today,endDate:today,durationType:'full_day'}});}
  function edit(patch:Partial<LeaveCommand>){if(!draft||disabled)return;putLeave({...draft,phase:'edit',preview:undefined,message:undefined,command:{...draft.command,...patch,requestId:randomUUID(),overrideConsent:[]}});}
  function checkbox(label:string,value:boolean,change:()=>void){return <Pressable accessibilityRole="checkbox" accessibilityState={{checked:value,disabled:!!disabled}} disabled={disabled} onPress={change} style={{minHeight:48,flexDirection:'row',gap:12,alignItems:'center'}}><View style={{width:24,height:24,borderWidth:1,borderColor:value?palette.accent:palette.border,borderRadius:4,alignItems:'center',justifyContent:'center'}}><Text style={{color:palette.accent}}>{value?'✓':''}</Text></View><Text style={{color:palette.text,flex:1,lineHeight:21}}>{label}</Text></Pressable>;}
  function field(label:string,value:string,change:(value:string)=>void,multiline=false){return <View style={{gap:6,flex:1}}><Text style={{color:palette.muted,fontSize:14}}>{label}</Text><TextInput accessibilityLabel={label} editable={!disabled} value={value} onChangeText={change} multiline={multiline} autoCorrect={multiline} autoCapitalize={multiline?'sentences':'none'} maxLength={multiline?2000:32} placeholderTextColor={palette.muted} style={{color:palette.text,minHeight:48,borderWidth:1,borderColor:palette.border,borderRadius:design.corners==='soft'?12:4,padding:12,fontSize:16,textAlignVertical:'top'}}/></View>;}
  async function pickDocument(){
    if(!draft||!selected||flight.current)return;flight.current=true;const owner=authGeneration();let source:File|undefined;
    try{const result=await DocumentPicker.getDocumentAsync({copyToCacheDirectory:true,multiple:false,type:selected.allowedMimeTypes.length?selected.allowedMimeTypes:['application/pdf','image/jpeg','image/png']});
      if(result.canceled)return;
      const picked=result.assets[0];source=new File(picked.uri);assertAuthGeneration(owner);
      const size=source.size;const mime=picked.mimeType??'application/octet-stream';
      if(!size||size>Math.min(selected.maxDocBytes,10*1024*1024)||picked.name.length>200||(selected.allowedMimeTypes.length&&!selected.allowedMimeTypes.includes(mime))){if(source.exists)source.delete();throw new Error(t('invalidDocument'));}
      const directory=new Directory(Paths.cache,'aihr-journeys');if(!directory.exists)directory.create({intermediates:true});
      const cached=new File(directory,randomUUID());source.copy(cached);if(source.exists)source.delete();
      const document:LocalAttachment={uri:cached.uri,name:picked.name,mimeType:mime,size};
      if(putLeave({...draft,document},draft.command.requestId))removeLocalFile(draft.document);else removeLocalFile(document);
    }catch(e){putLeave({...draft,message:e instanceof Error?e.message:t('genericError')},draft.command.requestId);if(e instanceof SignInRequiredError)void signOut();}
    finally{try{if(source?.exists)source.delete();}catch{}flight.current=false;}
  }
  async function review(){
    if(!draft||!options.employmentId||flight.current)return;
    if(!selected||!/^\d{4}-\d{2}-\d{2}$/.test(draft.command.startDate)||!/^\d{4}-\d{2}-\d{2}$/.test(draft.command.endDate)||draft.command.startDate>draft.command.endDate){putLeave({...draft,message:t('invalidDates')});return;}
    flight.current=true;const owner=authGeneration();putLeave({...draft,phase:'previewing',message:undefined});
    try{const preview=await apiPost('leave-preview',draft.command,{employmentId:options.employmentId});assertAuthGeneration(owner);putLeave({...draft,phase:'review',preview,message:undefined},draft.command.requestId);}
    catch(e){putLeave({...draft,phase:'edit',message:t('genericError')},draft.command.requestId);if(e instanceof SignInRequiredError)void signOut();}finally{flight.current=false;}
  }
  async function submit(){
    if(!draft||!options.employmentId||flight.current)return;flight.current=true;const owner=authGeneration();
    putLeave({...draft,phase:'submitting',message:undefined});const form=new FormData();form.append('command',JSON.stringify(draft.command));if(draft.document)appendAttachment(form,'document',draft.document);
    try{const result=await apiPost('leave-requests',form,{employmentId:options.employmentId});assertAuthGeneration(owner);
      if(result.outcome==='accepted'){removeLocalFile(draft.document);putLeave({...draft,phase:'done',document:undefined,message:result.holidayWarning||result.maternityAllowanceWarning?t('requestWarning'):undefined},draft.command.requestId);onSubmitted();}
      else putLeave({...draft,phase:'edit',message:result.message,command:{...draft.command,requestId:randomUUID(),overrideConsent:[]}},draft.command.requestId);
    }catch(e){putLeave(e instanceof RequestRejectedError?{...draft,phase:'edit',message:t('genericError'),command:{...draft.command,requestId:randomUUID(),overrideConsent:[]}}:{...draft,phase:'uncertain',message:t('leaveUncertain')},draft.command.requestId);if(e instanceof SignInRequiredError)void signOut();}finally{flight.current=false;}
  }
  if(!draft)return <View style={{gap:10}}><Text style={{color:palette.text,fontSize:21,fontWeight:'600'}}>{t('requestLeave')}</Text>{options.items.map(o=><Button key={o.id} title={o.name} kind="quiet" onPress={()=>begin(o.id)}/>)}</View>;
  if(draft.phase==='done')return <Card><Text accessibilityRole="header" style={{color:palette.text,fontSize:22,fontWeight:'600'}}>{t('requestRecorded')}</Text>{draft.message&&<Muted>{draft.message}</Muted>}<Button title={t('viewHistory')} onPress={()=>putLeave(null)}/></Card>;
  const reviewMode=draft.phase==='review'||draft.phase==='uncertain'||draft.phase==='submitting';
  const missingConsent=draft.preview?.overrides.some(o=>o.needsConsent&&!draft.command.overrideConsent?.includes(o.consentToken));
  const blocked=draft.preview?.overrides.some(o=>o.action==='block'||(o.action==='convert_to_emergency'&&!o.toTypeName));
  return <View style={{gap:16}}>
    <Text style={{color:palette.text,fontSize:23,fontWeight:'600'}}>{selected?.name??t('leaveType')}</Text>
    {selected?.notice&&<Muted>{selected.notice}</Muted>}
    {draft.message&&<Text accessibilityRole="alert" style={{color:palette.text,lineHeight:23}}>{draft.message}</Text>}
    {reviewMode?<>
      <Row label={t('startDate')} value={draft.command.startDate}/><Row label={t('endDate')} value={draft.command.endDate}/><Row label={t('leaveType')} value={t(durationLabels[draft.command.durationType])}/>
      {draft.command.durationType==='hourly'?<><Row label={t('fromTime')} value={draft.command.fromTime??'—'}/><Row label={t('toTime')} value={draft.command.toTime??'—'}/><Muted>{t('hourlyReview')}</Muted></>:<Row label={t('deductedDays')} value={fmtDays(draft.preview?.days??null)}/>}
      {!!draft.preview?.unpaidDays&&<Row label={t('unpaidDays')} value={fmtDays(draft.preview.unpaidDays)}/>}
      {draft.document&&<Row label={t('supportingDocument')} value={draft.document.name}/>}
      {draft.command.reason&&<Muted>{draft.command.reason}</Muted>}
      {(draft.preview?.overrides??[]).map(o=><View key={o.consentToken} style={{padding:14,borderWidth:1,borderColor:palette.border,gap:6}}>
        <Muted>{o.action==='convert_to_emergency'&&o.toTypeName?t('convertNotice',{from:o.fromTypeName??selected?.name??'',to:o.toTypeName}):o.action==='split_unpaid'?t('splitNotice',{paid:o.paidDays??0,unpaid:o.unpaidDays??0}):t('ruleBlocked')}</Muted>
        {o.needsConsent&&checkbox(t('agreeRule'),!!draft.command.overrideConsent?.includes(o.consentToken),()=>putLeave({...draft,command:{...draft.command,overrideConsent:draft.command.overrideConsent?.includes(o.consentToken)?draft.command.overrideConsent.filter(c=>c!==o.consentToken):[...(draft.command.overrideConsent??[]),o.consentToken]}}))}
      </View>)}
      <Muted>{t('reviewBeforeSubmit')}</Muted>
      <Button title={pending?t('requesting'):draft.phase==='uncertain'?t('retrySameClock'):t('submitRequest')} disabled={!!pending||!!missingConsent||!!blocked} onPress={()=>void submit()}/>
      {draft.phase==='uncertain'?<Button title={t('checkReceipt')} onPress={onSubmitted} kind="quiet"/>:<Button title={t('editRequest')} disabled={!!pending} kind="quiet" onPress={()=>putLeave({...draft,phase:'edit',command:{...draft.command,requestId:randomUUID(),overrideConsent:[]}})}/>}
    </>:<>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{selected?.durations.map(d=><Button key={d} title={t(durationLabels[d])} kind={d===draft.command.durationType?'primary':'quiet'} disabled={!!disabled} onPress={()=>edit({durationType:d,endDate:d==='full_day'?draft.command.endDate:draft.command.startDate})}/>)}</View>
      {field(t('startDate'),draft.command.startDate,v=>edit({startDate:v,...(draft.command.durationType!=='full_day'?{endDate:v}:{})}))}
      {draft.command.durationType==='full_day'&&field(t('endDate'),draft.command.endDate,v=>edit({endDate:v}))}
      {draft.command.durationType==='hourly'&&<View style={{flexDirection:'row',gap:10}}>{field(t('fromTime'),draft.command.fromTime??'',v=>edit({fromTime:v}))}{field(t('toTime'),draft.command.toTime??'',v=>edit({toTime:v}))}</View>}
      {field(t('reason'),draft.command.reason??'',v=>edit({reason:v}),true)}
      {selected?.emergencySplit&&<><Text style={{color:palette.muted}}>{t('emergencyCategory')}</Text><View style={{gap:6}}>{(['illness','personal','other'] as const).map(c=><Button key={c} title={t(c)} kind={draft.command.reasonCategory===c?'primary':'quiet'} disabled={!!disabled} onPress={()=>edit({reasonCategory:c})}/>)}</View>{checkbox(t('unpaidConsent'),!!draft.command.unpaidConsent,()=>edit({unpaidConsent:!draft.command.unpaidConsent}))}</>}
      {selected?.maternity&&<>{field(t('survivingChildren'),draft.command.survivingChildren==null?'':String(draft.command.survivingChildren),v=>edit({survivingChildren:v===''?undefined:Number(v)}))}{field(t('confinementDate'),draft.command.confinementDate??'',v=>edit({confinementDate:v||undefined}))}</>}
      {<View style={{gap:8}}><Text style={{color:palette.text,fontSize:16,fontWeight:'600'}}>{t('supportingDocument')}{selected?.requiresDocument?` · ${selected.mandatoryAfterDays?t('documentAfterDays',{n:selected.mandatoryAfterDays}):t('required')}`:''}</Text><Muted>{t('documentLimit',{n:Math.min(selected?.maxDocBytes??10485760,10485760)/1048576})}</Muted>{draft.document&&<><Muted>{draft.document.name}</Muted><Button title={t('removeDocument')} disabled={!!disabled} kind="quiet" onPress={()=>{removeLocalFile(draft.document);putLeave({...draft,document:undefined,command:{...draft.command,requestId:randomUUID(),overrideConsent:[]}});}}/></>}<Button title={t('chooseDocument')} disabled={!!disabled} kind="quiet" onPress={()=>void pickDocument()}/>{field(t('employeeRemark')+(selected?.employeeRemarkRequired?` · ${t('required')}`:''),draft.command.employeeRemark??'',v=>edit({employeeRemark:v}),true)}</View>}
      <Button title={pending?t('loading'):t('reviewRequest')} disabled={!!pending} onPress={()=>void review()}/>
      <Button title={t('cancel')} disabled={!!pending} kind="quiet" onPress={()=>{removeLocalFile(draft.document);putLeave(null);}}/>
    </>}
  </View>;
}
