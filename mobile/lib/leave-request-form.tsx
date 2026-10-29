import { useEffect,useRef,useState,type ReactNode } from 'react';
import { AppState,Platform,Pressable,TextInput,View } from 'react-native';
import DateTimePicker,{ DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { DesignText as Text } from './design';
import * as DocumentPicker from 'expo-document-picker';
import { File,Directory,Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { apiGet,apiPost,type LeaveOptionsResponse,type LeaveCommand,type LeaveResponse } from './api';
import { authGeneration,assertAuthGeneration } from './auth';
import { appendAttachment } from './capture';
import { useTenantDesign } from './design';
import { SignInRequiredError,RequestRejectedError } from './errors';
import { LeaveCommand as LeaveCommandSchema } from '../../lib/mobile-api/contract';
import { useSubmissionRecovery } from './submission-recovery';
import {SubmissionJournalFull} from './submission-journal';
import { t,type MessageKey } from './i18n';
import { useJourneyDrafts,removeLocalFile,type LeaveDraft,type LocalAttachment } from './journey-drafts';
import { useSession } from './session';
import { cardFigure } from './home-cards';
import { Button,Card,Chip,HeaderBack,InfoNote,ListRow,Muted,NoteLine,Row,Screen,Title,fmtDays } from './ui';
const durationLabels:Record<LeaveCommand['durationType'],MessageKey>={full_day:'fullDay',half_day_am:'halfAM',half_day_pm:'halfPM',hourly:'hourly'};
const pad=(n:number)=>String(n).padStart(2,'0');
/** A calendar date or clock time is the device's LOCAL wall value the person picked; it never passes through UTC. */
const toPicker=(mode:'date'|'time',value:string|undefined,today:string)=>{
  if(mode==='date'){const [y,m,d]=(value&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:today).split('-').map(Number);return new Date(y,m-1,d);}
  const [h,min]=(value&&/^\d{2}:\d{2}$/.test(value)?value:'09:00').split(':').map(Number);return new Date(2000,0,1,h,min);
};
const fromPicker=(mode:'date'|'time',d:Date)=>mode==='date'?`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`:`${pad(d.getHours())}:${pad(d.getMinutes())}`;
/**
 * D9 — the platform's own date/time control instead of free text. Android opens the system dialog; iOS shows the
 * spinner under the field and commits on Done, so a value is never set by merely looking at it.
 */
export function PickerField({label,mode,value,today,disabled,onChange}:{label:string;mode:'date'|'time';value:string|undefined;today:string;disabled:boolean;onChange:(value:string)=>void}){
  const {palette}=useTenantDesign();const [open,setOpen]=useState<Date|null>(null);
  function show(){
    if(disabled)return;const seed=toPicker(mode,value,today);
    if(Platform.OS==='android')DateTimePickerAndroid.open({value:seed,mode,is24Hour:true,onChange:(event,picked)=>{if(event.type==='set'&&picked)onChange(fromPicker(mode,picked));}});
    else setOpen(open?null:seed);
  }
  return <View style={{gap:6,flex:1}}>
    <Text style={{color:palette.muted,fontSize:14}}>{label}</Text>
    <Button title={value||t('pickerChoose')} accessibilityLabel={label} kind="quiet" disabled={disabled} onPress={show}/>
    {open&&Platform.OS!=='android'&&<>
      <DateTimePicker accessibilityLabel={label} value={open} mode={mode} display="spinner" onChange={(_event,picked)=>{if(picked)setOpen(picked);}}/>
      <Button title={t('pickerDone')} onPress={()=>{onChange(fromPicker(mode,open));setOpen(null);}}/>
    </>}
  </View>;
}
type LeaveCard=LeaveResponse['cards'][number];
/** What the request's day count depends on. The reason, remark and document never change it, so they never re-preview. */
const previewKey=(c:LeaveCommand)=>JSON.stringify([c.leaveTypeId,c.startDate,c.endDate,c.durationType,c.fromTime??null,c.toTime??null]);
const isDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v);
/**
 * The leave request (declutter round). One screen: leave-type chips with each type's balance, one date range, day-part
 * chips, "Add reason or document" (collapsed unless the selected type's server data says a document or remark is
 * required), and a bottom bar with the day count and "Review request".
 *
 * THE APP COUNTS NOTHING. The bar's day count is the server's own leave preview (POST leave-preview, the call Review
 * makes), asked again — debounced — whenever the dates, day part or type change, and shown only for the exact request
 * it was asked for; until it answers the bar says so. The balance beside it is the server's card figure for the type.
 * The preview returns no balance after the request, and the app does not subtract one. Review, consent, submission,
 * the durable journal and receipt recovery are unchanged.
 */
export function LeaveRequestForm({options,today,onSubmitted,notices={},cards=[]}:{options:LeaveOptionsResponse;today:string;onSubmitted:()=>void;notices?:Record<string,{label:string;detail:string|null}>;cards?:readonly LeaveCard[]}){
  const {palette,design}=useTenantDesign();const {signOut}=useSession();
  const {leave:draft,putLeave}=useJourneyDrafts();const flight=useRef(false);
  const recovery=useSubmissionRecovery('leave',options.employmentId??undefined,({command,file})=>{
    putLeave({employmentId:options.employmentId??undefined,command:LeaveCommandSchema.parse(JSON.parse(command)),document:file,phase:'uncertain',message:t('leaveUncertain')});
  });
  const selected=options.items.find(o=>o.id===draft?.command.leaveTypeId);
  const pending=draft?.phase==='submitting'||draft?.phase==='previewing';
  const disabled=pending||draft?.phase==='uncertain';
  const [extrasOpen,setExtrasOpen]=useState(false);
  /** The leave-type list is open (it replaces the form until a type is chosen or the list is closed). */
  const [picking,setPicking]=useState(false);
  /** The server's preview for the request on screen, keyed by what the count depends on. */
  const [live,setLive]=useState<{key:string;days:number|null;failed?:boolean}|null>(null);
  const liveKey=draft?previewKey(draft.command):'';
  const editing=draft?.phase==='edit';
  useEffect(()=>{
    if(!draft||!editing||!options.employmentId)return;
    const c=draft.command,key=previewKey(c);
    if(!c.leaveTypeId||!isDate(c.startDate)||!isDate(c.endDate)||c.startDate>c.endDate||(c.durationType==='hourly'&&(!c.fromTime||!c.toTime)))return;
    let current=true;const owner=authGeneration();
    const timer=setTimeout(()=>{
      apiPost('leave-preview',c,{employmentId:options.employmentId!}).then(
        result=>{if(current&&authGeneration()===owner)setLive({key,days:result.days});},
        e=>{if(!current)return;if(e instanceof SignInRequiredError)void signOut();else setLive({key,days:null,failed:true});});
    },400);
    return ()=>{current=false;clearTimeout(timer);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[liveKey,editing,options.employmentId]);
  /** A new request starts with NO type chosen: the person picks it, so a type is never sent because it happened to be first. */
  function begin(id=''){removeLocalFile(draft?.document);putLeave({employmentId:options.employmentId??undefined,phase:'edit',command:{requestId:randomUUID(),leaveTypeId:id,startDate:today,endDate:today,durationType:'full_day'}});}
  /** Another type keeps the dates; a day part the new type does not offer falls back to full days, and a document
   *  picked under the old type's file rules is discarded. */
  function switchType(id:string){if(!draft||disabled)return;const next=options.items.find(o=>o.id===id);if(!next)return;removeLocalFile(draft.document);putLeave({...draft,phase:'edit',document:undefined,preview:undefined,message:undefined,command:{...draft.command,leaveTypeId:id,...(next.durations.includes(draft.command.durationType)?{}:{durationType:'full_day' as const,endDate:draft.command.endDate,fromTime:undefined,toTime:undefined}),requestId:randomUUID(),overrideConsent:[]}});}
  function edit(patch:Partial<LeaveCommand>){if(!draft||disabled)return;putLeave({...draft,phase:'edit',preview:undefined,message:undefined,command:{...draft.command,...patch,requestId:randomUUID(),overrideConsent:[]}});}
  function checkbox(label:string,value:boolean,change:()=>void){return <Pressable accessibilityRole="checkbox" accessibilityState={{checked:value,disabled:!!disabled}} disabled={disabled} onPress={change} style={{minHeight:48,flexDirection:'row',gap:12,alignItems:'center'}}><View style={{width:24,height:24,borderWidth:1,borderColor:value?palette.accent:palette.border,borderRadius:4,alignItems:'center',justifyContent:'center'}}><Text style={{color:palette.accent}}>{value?'✓':''}</Text></View><Text style={{color:palette.text,flex:1,lineHeight:21}}>{label}</Text></Pressable>;}
  function field(label:string,value:string,change:(value:string)=>void,multiline=false){return <View style={{gap:6,flex:1}}><Text style={{color:palette.muted,fontSize:14}}>{label}</Text><TextInput accessibilityLabel={label} editable={!disabled} value={value} onChangeText={change} multiline={multiline} autoCorrect={multiline} autoCapitalize={multiline?'sentences':'none'} maxLength={multiline?2000:32} placeholderTextColor={palette.muted} style={{color:palette.text,minHeight:48,borderWidth:1,borderColor:palette.border,borderRadius:design.schemaVersion===2?design.composition.layout.radius:design.corners==='soft'?12:4,padding:12,fontSize:16,textAlignVertical:'top'}}/></View>;}
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
    if(!selected){putLeave({...draft,message:t('chooseLeaveTypeFirst')});return;}
    if(!/^\d{4}-\d{2}-\d{2}$/.test(draft.command.startDate)||!/^\d{4}-\d{2}-\d{2}$/.test(draft.command.endDate)||draft.command.startDate>draft.command.endDate){putLeave({...draft,message:t('invalidDates')});return;}
    flight.current=true;const owner=authGeneration();putLeave({...draft,phase:'previewing',message:undefined});
    try{const preview=await apiPost('leave-preview',draft.command,{employmentId:options.employmentId});assertAuthGeneration(owner);putLeave({...draft,phase:'review',preview,message:undefined},draft.command.requestId);}
    catch(e){putLeave({...draft,phase:'edit',message:t('genericError')},draft.command.requestId);if(e instanceof SignInRequiredError)void signOut();}finally{flight.current=false;}
  }
  async function submit(){
    if(!draft||!options.employmentId||flight.current||!recovery.ready||AppState.currentState!=='active')return;flight.current=true;const owner=authGeneration();
    let sent=false;
    let uploadFile:LocalAttachment|undefined;
    putLeave({...draft,phase:'submitting',message:undefined});
    try{
      const staged=await recovery.stage(JSON.stringify(draft.command),draft.document);assertAuthGeneration(owner);
      uploadFile=staged.file;
      if(!putLeave({...draft,document:staged.file,phase:'submitting'},draft.command.requestId))return;
      const form=new FormData();form.append('command',staged.command);if(staged.file)appendAttachment(form,'document',staged.file);
      sent=true;const result=await apiPost('leave-requests',form,{employmentId:options.employmentId});assertAuthGeneration(owner);
      await recovery.resolve(draft.command.requestId);assertAuthGeneration(owner);
      if(result.outcome==='accepted'){removeLocalFile(draft.document);putLeave({...draft,phase:'done',document:undefined,message:result.holidayWarning||result.maternityAllowanceWarning?t('requestWarning'):undefined},draft.command.requestId);onSubmitted();}
      else putLeave({...draft,phase:'edit',message:result.message,command:{...draft.command,requestId:randomUUID(),overrideConsent:[]}},draft.command.requestId);
    }catch(e){
      let refused=false;
      if(e instanceof RequestRejectedError&&[400,403,404,413,415,422].includes(e.status))try{await recovery.resolve(draft.command.requestId);refused=true;}catch{}
      putLeave(refused?{...draft,phase:'edit',message:t('genericError'),command:{...draft.command,requestId:randomUUID(),overrideConsent:[]}}:{...draft,phase:'uncertain',message:t(sent?'leaveUncertain':e instanceof SubmissionJournalFull?'pendingStorageFull':'submissionSaveFailed')},draft.command.requestId);
      if(e instanceof SignInRequiredError)void signOut();
    }finally{removeLocalFile(uploadFile);flight.current=false;}
  }
  async function recover(){
    if(!draft||!options.employmentId||flight.current)return;flight.current=true;const owner=authGeneration();
    try{
      const result=await apiGet('submission-receipt',{kind:'leave',requestId:draft.command.requestId,employmentId:options.employmentId});assertAuthGeneration(owner);
      if(result.kind!=='leave'||result.requestId!==draft.command.requestId)throw new Error('Unexpected submission receipt');
      if(result.kind==='leave'&&result.receipt){
        await recovery.resolve(draft.command.requestId);assertAuthGeneration(owner);
        if(putLeave({...draft,phase:'done',document:undefined,message:result.receipt.holidayWarning||result.receipt.maternityAllowanceWarning?t('requestWarning'):undefined},draft.command.requestId)){
          removeLocalFile(draft.document);onSubmitted();
        }
      }else if(result.abandoned){
        await recovery.resolve(draft.command.requestId);assertAuthGeneration(owner);removeLocalFile(draft.document);
        putLeave({...draft,phase:'edit',document:undefined,message:t('pendingDiscarded'),command:{...draft.command,requestId:randomUUID(),overrideConsent:[]}},draft.command.requestId);
      }else putLeave({...draft,message:t('leaveUncertain')},draft.command.requestId);
    }catch(e){putLeave({...draft,message:t('leaveUncertain')},draft.command.requestId);if(e instanceof SignInRequiredError)void signOut();}
    finally{flight.current=false;}
  }
  const frame=(body:ReactNode,footer?:ReactNode)=><Screen footer={footer}>
    <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12}}>
      <View style={{flexShrink:1}}><Title>{t('requestLeave')}</Title></View>
      {draft&&!picking&&(draft.phase==='edit'||draft.phase==='previewing')&&<Button title={t('cancel')} disabled={!!pending} kind="quiet" onPress={()=>{removeLocalFile(draft.document);putLeave(null);}}/>}
    </View>
    {body}
  </Screen>;
  if(!recovery.ready){const waiting=<View>{!!recovery.error&&<><Muted>{t('genericError')}</Muted><Button title={t('retry')} onPress={recovery.reload}/></>}{!recovery.error&&<Muted>{t('loading')}</Muted>}</View>;return draft?frame(waiting):waiting;}
  if(!draft)return <Button title={t('requestLeave')} disabled={!options.items.length} onPress={()=>begin()}/>;
  if(draft.phase==='done')return frame(<Card><Text accessibilityRole="header" style={{color:palette.text,fontSize:22,fontWeight:'600'}}>{t('requestRecorded')}</Text>{draft.message&&<Muted>{draft.message}</Muted>}<Button title={t('viewHistory')} onPress={()=>putLeave(null)}/></Card>);
  const reviewMode=draft.phase==='review'||draft.phase==='uncertain'||draft.phase==='submitting';
  const missingConsent=draft.preview?.overrides.some(o=>o.needsConsent&&!draft.command.overrideConsent?.includes(o.consentToken));
  const blocked=draft.preview?.overrides.some(o=>o.action==='block'||(o.action==='convert_to_emergency'&&!o.toTypeName));
  const card=cards.find(c=>c.leaveTypeId===draft.command.leaveTypeId);
  const shownLive=live&&live.key===liveKey?live:null;
  // Required by the selected type's own server data: a document (from the first day, or past N days) or a remark.
  const extrasRequired=!!selected&&(selected.requiresDocument||selected.employeeRemarkRequired);
  const extrasShown=extrasOpen||extrasRequired||!!draft.document||!!draft.command.reason||!!draft.command.employeeRemark;
  const dayParts:{d:LeaveCommand['durationType'];key:MessageKey}[]=[{d:'full_day',key:'dayPartFull'},{d:'half_day_am',key:'dayPartFirstHalf'},{d:'half_day_pm',key:'dayPartSecondHalf'},{d:'hourly',key:'hourly'}];
  const header=<>
    {selected?.notice&&<NoteLine text={selected.notice}/>}
    {selected&&notices[selected.id]&&(notices[selected.id].detail?<InfoNote short={notices[selected.id].label} detail={notices[selected.id].detail!}/>:<Muted>{notices[selected.id].label}</Muted>)}
    {draft.message&&<Text accessibilityRole="alert" style={{color:palette.text,lineHeight:23}}>{draft.message}</Text>}
  </>;
  if(reviewMode)return frame(<View style={{gap:16}}>
    <Text style={{color:palette.text,fontSize:21,fontWeight:'600'}}>{selected?.name??t('leaveType')}</Text>
    {header}
    <Row label={t('startDate')} value={draft.command.startDate}/><Row label={t('endDate')} value={draft.command.endDate}/><Row label={t('leaveType')} value={t(durationLabels[draft.command.durationType])}/>
    {draft.command.durationType==='hourly'&&<><Row label={t('fromTime')} value={draft.command.fromTime??'—'}/><Row label={t('toTime')} value={draft.command.toTime??'—'}/></>}
    {/* The server previews an hourly window through the rule submission deducts by; an older server sends null. */}
    {draft.command.durationType==='hourly'&&draft.preview?.days==null?<Muted>{t('hourlyReview')}</Muted>:<Row label={t('deductedDays')} value={fmtDays(draft.preview?.days??null)}/>}
    {!!draft.preview?.unpaidDays&&<Row label={t('unpaidDays')} value={fmtDays(draft.preview.unpaidDays)}/>}
    {draft.document&&<Row label={t('supportingDocument')} value={draft.document.name}/>}
    {draft.command.reason&&<Muted>{draft.command.reason}</Muted>}
    {(draft.preview?.overrides??[]).map(o=><View key={o.consentToken} style={{padding:14,borderWidth:1,borderColor:palette.border,gap:6}}>
      <Muted>{o.action==='convert_to_emergency'&&o.toTypeName?t('convertNotice',{from:o.fromTypeName??selected?.name??'',to:o.toTypeName}):o.action==='split_unpaid'?t('splitNotice',{paid:o.paidDays??0,unpaid:o.unpaidDays??0}):t('ruleBlocked')}</Muted>
      {o.needsConsent&&checkbox(t('agreeRule'),!!draft.command.overrideConsent?.includes(o.consentToken),()=>putLeave({...draft,command:{...draft.command,overrideConsent:draft.command.overrideConsent?.includes(o.consentToken)?draft.command.overrideConsent.filter(c=>c!==o.consentToken):[...(draft.command.overrideConsent??[]),o.consentToken]}}))}
    </View>)}
    <Muted>{t('reviewBeforeSubmit')}</Muted>
    <Button title={pending?t('requesting'):draft.phase==='uncertain'?t('retrySameClock'):t('submitRequest')} disabled={!!pending||!!missingConsent||!!blocked} onPress={()=>void submit()}/>
    {draft.phase==='uncertain'?<Button title={t('checkReceipt')} onPress={()=>void recover()} kind="quiet"/>:<Button title={t('editRequest')} disabled={!!pending} kind="quiet" onPress={()=>putLeave({...draft,phase:'edit',command:{...draft.command,requestId:randomUUID(),overrideConsent:[]}})}/>}
  </View>);
  const bar=<View style={{flexDirection:'row',alignItems:'center',gap:12,paddingHorizontal:16,paddingTop:10,paddingBottom:10,borderTopWidth:1,borderColor:palette.border,backgroundColor:palette.bg}}>
    <View style={{flex:1,gap:2}}>
      <Text accessibilityLiveRegion="polite" style={{color:palette.text,fontSize:16,fontWeight:'600',fontVariant:['tabular-nums']}}>{!draft.command.leaveTypeId?t('chooseLeaveType'):shownLive&&shownLive.days!=null?fmtDays(shownLive.days):shownLive?.failed?t('leaveBarNoCount'):t('leaveBarCounting')}</Text>
      {card&&!card.takenOnly&&<Muted>{t('leaveBarAvailable',{days:fmtDays(cardFigure(card))})}</Muted>}
    </View>
    <Button title={pending?t('loading'):t('reviewRequest')} disabled={!!pending} onPress={()=>void review()}/>
  </View>;
  const figureOf=(id:string)=>{const c=cards.find(x=>x.leaveTypeId===id);return c?fmtDays(cardFigure(c)):null;};
  if(picking)return frame(<View accessibilityRole="radiogroup" accessibilityLabel={t('leaveType')}>
    <HeaderBack onPress={()=>setPicking(false)}/>
    {options.items.map(o=>{const on=o.id===draft.command.leaveTypeId,figure=figureOf(o.id);
      return <Pressable key={o.id} accessibilityRole="radio" accessibilityLabel={[o.name,figure].filter(Boolean).join(', ')} accessibilityState={{selected:on,disabled:!!disabled}} disabled={!!disabled}
        onPress={()=>{if(!on)switchType(o.id);setPicking(false);}} style={{minHeight:48,paddingVertical:10,borderBottomWidth:1,borderColor:palette.border,gap:2}}>
        <View style={{flexDirection:'row',justifyContent:'space-between',gap:12}}><Text style={{color:on?palette.accent:palette.text,fontSize:16,fontWeight:on?'600':'400',flexShrink:1}}>{o.name}</Text>{figure&&<Text style={{color:palette.muted,fontVariant:['tabular-nums']}}>{figure}</Text>}</View>
        {o.notice&&o.notice.length<=80?<Muted>{o.notice}</Muted>:null}
      </Pressable>;})}
  </View>);
  return frame(<View style={{gap:12}}>
    <ListRow label={t('leaveType')} value={selected?[selected.name,figureOf(selected.id)].filter(Boolean).join(' · '):t('chooseLeaveType')} onPress={()=>{if(!disabled)setPicking(true);}}/>
    {header}
    {draft.command.durationType==='full_day'
      ?<View style={{flexDirection:'row',gap:10}}><PickerField label={t('startDate')} mode="date" value={draft.command.startDate} today={today} disabled={!!disabled} onChange={v=>edit({startDate:v,...(v>draft.command.endDate?{endDate:v}:{})})}/><PickerField label={t('endDate')} mode="date" value={draft.command.endDate} today={today} disabled={!!disabled} onChange={v=>edit({endDate:v})}/></View>
      :<PickerField label={t('leaveDate')} mode="date" value={draft.command.startDate} today={today} disabled={!!disabled} onChange={v=>edit({startDate:v,endDate:v})}/>}
    {(selected?.durations.length??0)>1&&<View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{dayParts.filter(p=>selected?.durations.includes(p.d)).map(p=><Chip key={p.d} title={t(p.key)} selected={p.d===draft.command.durationType} disabled={!!disabled} onPress={()=>edit({durationType:p.d,endDate:p.d==='full_day'?draft.command.endDate:draft.command.startDate})}/>)}</View>}
    {draft.command.durationType==='hourly'&&<View style={{flexDirection:'row',gap:10}}><PickerField label={t('fromTime')} mode="time" value={draft.command.fromTime} today={today} disabled={!!disabled} onChange={v=>edit({fromTime:v})}/><PickerField label={t('toTime')} mode="time" value={draft.command.toTime} today={today} disabled={!!disabled} onChange={v=>edit({toTime:v})}/></View>}
    {selected?.emergencySplit&&<><Text style={{color:palette.muted}}>{t('emergencyCategory')}</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{(['illness','personal','other'] as const).map(c=><Chip key={c} title={t(c)} selected={draft.command.reasonCategory===c} disabled={!!disabled} onPress={()=>edit({reasonCategory:c})}/>)}</View>{checkbox(t('unpaidConsent'),!!draft.command.unpaidConsent,()=>edit({unpaidConsent:!draft.command.unpaidConsent}))}</>}
    {selected?.maternity&&<>{field(t('survivingChildren'),draft.command.survivingChildren==null?'':String(draft.command.survivingChildren),v=>edit({survivingChildren:v===''?undefined:Number(v)}))}<PickerField label={t('confinementDate')} mode="date" value={draft.command.confinementDate} today={today} disabled={!!disabled} onChange={v=>edit({confinementDate:v})}/></>}
    {extrasShown?<View style={{gap:8}}>
      <Text style={{color:palette.text,fontSize:16,fontWeight:'600'}}>{t('addReasonOrDocument')}{extrasRequired?` · ${t('required')}`:''}</Text>
      {field(t('reason'),draft.command.reason??'',v=>edit({reason:v}),true)}
      <Text style={{color:palette.muted,fontSize:14}}>{t('supportingDocument')}{selected?.requiresDocument?` · ${selected.mandatoryAfterDays?t('documentAfterDays',{n:selected.mandatoryAfterDays}):t('required')}`:''} · {t('documentLimit',{n:Math.min(selected?.maxDocBytes??10485760,10485760)/1048576})}</Text>
      {draft.document&&<><Muted>{draft.document.name}</Muted><Button title={t('removeDocument')} disabled={!!disabled} kind="quiet" onPress={()=>{removeLocalFile(draft.document);putLeave({...draft,document:undefined,command:{...draft.command,requestId:randomUUID(),overrideConsent:[]}});}}/></>}
      <Button title={t('chooseDocument')} disabled={!!disabled} kind="quiet" onPress={()=>void pickDocument()}/>
      {field(t('employeeRemark')+(selected?.employeeRemarkRequired?` · ${t('required')}`:''),draft.command.employeeRemark??'',v=>edit({employeeRemark:v}),true)}
    </View>:<View style={{flexDirection:'row'}}><Chip title={`+ ${t('addReasonOrDocument')}`} onPress={()=>setExtrasOpen(true)}/></View>}
  </View>,bar);
}
