'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {ClientTabs,type PersonnelTabKey} from '@/components/personnel-tabs';
import {Button,Card,inputCls} from '@/components/ui';
import {essVisibleFields} from '@/lib/personnel-ess-contract';
import {personnelFieldLabel} from '@/lib/personnel-field-label';
import {personnelFieldChoices} from '@/lib/personnel-import-contract';
import {ESS_PROFILE_TABS,type EssScalar,type EssRegisterChange,type EssProfileProposal} from '@/lib/personnel-ess-model';
import {clientPackFor} from '@/localization/registry.client';
import {ENTITLEMENT_STATUS_LABEL_KEY,type EntitlementStatus} from '@/lib/entitlement-status';
import {movementKindLabel} from '@/lib/movement-kind-label';
import {formatDmy} from '@/lib/date-display';
import type {EssWorkspace,EssRecord} from '@/core/profile-edit';
import type {EssReadRecord,readOwnProfileFacts} from '@/core/profile-view';
import type {ProfileProposalLine} from '@/lib/profile-proposal-display';
import {saveMyProfileEditAction,readMyProfileMovementAction} from './profile-edit-actions';
const rowIdentity=(row:EssRecord|NewRecord)=>row.id??('clientId' in row?row.clientId:'');
const keys:PersonnelTabKey[]=['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification','others'];
const sectionKeys:Record<string,string>={
 'Personal details':'personalDetails','Identity and passport':'passportInfoTitle','Contact and permanent address':'contactAddressTitle','Correspondence address':'correspondenceAddressTitle','Emergency contact':'emergencyTitle',
 'Family and dependents':'family.title','Organisation assignment':'employmentInfo.title','Additional organisation labels':'employmentInfo.title','Employment dates and service':'employmentInfo.title','Direct superior and history':'directSuperiorTitle',
 'Event information':'tabs.careerMovement','Before Changes and After Changes':'tabs.careerMovement','Holiday calendar and schedule':'holidayCalendarCardTitle','Clocking and attendance photo':'tabs.attendance','Work location and shift arrangement':'shiftTypeTitle',
 'Bank Information':'bankCardTitle','EPF contribution':'epfContribTitle','SOCSO, EIS and Others Statutory':'socsoEisCardTitle','Income Tax (PCB)':'incomeTaxPcbSection','Basic Salary and salary history':'compensation','Payment method and payroll policy':'paymentMethod',
 'Pay items':'payComponentsTitle','CP38 Deduction':'cp38Title','Zakat summary':'zakatSummaryTitle','Grade and benefit scheme':'gradeCardTitle','Leave balance and breakdown':'tabs.leave','Employee documents':'tabs.documents','Academic and professional qualifications':'tabs.qualification','Leave requests':'tabs.others',
};
type History={id:string;status:string;createdAt:string;decisionReason:string|null;lines:ProfileProposalLine[]};
type NewRecord={kind:EssRegisterChange['kind'];id:null;clientId:string;values:Record<string,EssScalar>;baselines:Record<string,string>;primary:false};
export function ProfileEditor({workspace,facts,extraPanels,history,defaultTab='profile'}:{workspace:EssWorkspace;facts:Awaited<ReturnType<typeof readOwnProfileFacts>>;extraPanels:Partial<Record<PersonnelTabKey,ReactNode>>;history:History[];defaultTab?:PersonnelTabKey}){
 const t=useTranslations('essProfile'),labels=useTranslations(),router=useRouter();
 const [editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[changes,setChanges]=useState<Record<string,EssScalar>>({}),[newRows,setNewRows]=useState<NewRecord[]>([]),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
 const [comparisons,setComparisons]=useState<Record<string,EssReadRecord[]>>({}),[historyBusy,setHistoryBusy]=useState<string|null>(null);
 const pending=useRef(false),requestButton=useRef<HTMLButtonElement>(null);
 const editable=new Set(workspace.editable),primaryEditable=new Set(workspace.legacyPrimaryEditable);
 const fields=essVisibleFields(),values={...facts.values,...workspace.values},dirty=Object.keys(changes).length>0||newRows.length>0;
 const translate=(key:string,fallback:string)=>labels.has(key)?labels(key):fallback;
 const serviceText=(value:{years:number;months:number;days:number})=>[...(value.years>0?[labels('people.detail.employmentInfo.yearsUnit',{count:value.years})]:[]),...(value.years>0||value.months>0?[labels('people.detail.employmentInfo.monthsUnit',{count:value.months})]:[]),labels('people.detail.employmentInfo.daysUnit',{count:value.days})].join(' ');
 for(const field of fields.filter(field=>field.owner==='employment')){if(['groupService','yearOfService'].includes(field.ownerField))values[field.id]=serviceText(facts.service.group);if(field.ownerField==='companyService')values[field.id]=serviceText(facts.service.company);}
 const fieldLabel=(id:string)=>{const field=fields.find(field=>field.id===id);return field?personnelFieldLabel(field,translate):t('unavailable');};
 const canEdit=(id:string,row?:EssRecord|NewRecord)=>editing&&(editable.has(id)||Boolean(row?.primary&&primaryEditable.has(id)))&&Boolean(workspace.statutoryAvailable||!fields.find(field=>field.id===id)?.ess.binding||['person','compliance','dependent','qualification','emergency'].includes(fields.find(field=>field.id===id)!.ess.binding!.owner));
 useEffect(()=>{
  if(!editing||!dirty)return;
  const before=(event:BeforeUnloadEvent)=>{event.preventDefault();};
  const leave=(event:MouseEvent)=>{const target=event.target instanceof Element?event.target.closest('a[href]'):null;if(!target||target.hasAttribute('download')||target.hasAttribute('data-unsaved-guard-ignore'))return;const href=target.getAttribute('href');if(!href||href.startsWith('#'))return;if(!window.confirm(t('leaveUnsaved'))){event.preventDefault();event.stopImmediatePropagation();}};
  const submit=(event:SubmitEvent)=>{if(!window.confirm(t('leaveUnsaved'))){event.preventDefault();event.stopImmediatePropagation();}};
  window.addEventListener('beforeunload',before);document.addEventListener('click',leave,true);document.addEventListener('submit',submit,true);
  return()=>{window.removeEventListener('beforeunload',before);document.removeEventListener('click',leave,true);document.removeEventListener('submit',submit,true);};
 },[editing,dirty,t]);
 function cancel(){if(pending.current)return;setChanges({});setNewRows([]);setEditing(false);setError(null);requestAnimationFrame(()=>requestButton.current?.focus());}
 function update(key:string,value:EssScalar,original:EssScalar|undefined){setChanges(previous=>{const next={...previous};if((value??null)===(original??null))delete next[key];else next[key]=value;return next;});}
 async function save(){
  if(pending.current)return;
  const proposal:EssProfileProposal={v:2,fields:[],registers:[]};
  for(const field of fields){if(Object.hasOwn(changes,field.id))proposal.fields.push({fieldId:field.id,before:workspace.baselines[field.id]??null,value:changes[field.id]});}
  for(const row of [...workspace.registers,...newRows]){
   const identity=rowIdentity(row);const selected=fields.flatMap(field=>{const key=`${row.kind}:${identity}:${field.id}`;return Object.hasOwn(changes,key)?[{fieldId:field.id,before:row.baselines[field.id]??null,value:changes[key]}]:[];});
   if(selected.length)proposal.registers.push({kind:row.kind,id:row.id,clientId:rowIdentity(row),fields:selected});
  }
  if(!proposal.fields.length&&!proposal.registers.length){cancel();return;}
  pending.current=true;setBusy(true);setError(null);setNotice(null);
  try{
   const result=await saveMyProfileEditAction({employmentId:workspace.employmentId,proposal});
   if(!result.ok){setError(t(`error.${result.code}`)+(result.fieldIds.length?' '+result.fieldIds.map(fieldLabel).join(', '):'')+('reference' in result&&result.reference?' '+t('reference',{reference:result.reference}):''));return;}
   setChanges({});setNewRows([]);setEditing(false);setNotice(t('saved',{saved:result.value.saved.length,waiting:result.value.waiting.length}));router.refresh();requestAnimationFrame(()=>requestButton.current?.focus());
  }catch{setError(t('error.system'));}finally{pending.current=false;setBusy(false);}
 }
 function control(field:typeof fields[number],source:Record<string,EssScalar>,row?:EssRecord|NewRecord){
  const original=source[field.id],key=row?`${row.kind}:${rowIdentity(row)}:${field.id}`:field.id,touched=Object.hasOwn(changes,key),value=touched?changes[key]:original;
  const allowed=canEdit(field.id,row),mask=Boolean(field.ess.masked&&!touched&&value);
  const countryPack=clientPackFor(workspace.country);
  const choiceOptions=field.owner==='bank'&&field.ownerField==='bankName'?(countryPack?.bankNames??[]).map(value=>({value,label:value})):field.allowedValuesOwner==='countryPack.taxCircumstanceOptions'?(countryPack?.payroll.taxCircumstanceOptions??[]).map(choice=>({value:choice.value,label:labels(`people.detail.${choice.key}`)})):facts.choices[field.id]??personnelFieldChoices(field).map(choice=>({value:choice.value,label:translate(choice.labelKey,choice.value)}));
  const displayValue=value===undefined?t('unavailable'):value===null||value===''?t('notRecorded'):choiceOptions.find(option=>option.value===String(value))?.label??(field.owner==='zakat'&&field.ownerField==='status'?labels(value==='active'?'people.detail.zakatSummaryActive':'people.detail.zakatSummaryInactive'):field.owner==='zakat'&&field.ownerField==='method'?value==null?t('notRecorded'):labels(value==='fixed'?'people.detail.zakatSummaryMethodFixed':'people.detail.zakatSummaryMethodPercent'):field.owner==='employmentStatus'?translate(`people.employeeStatus.${value}`,t('unavailable')):field.owner==='movement'&&field.ownerField==='kind'?movementKindLabel(String(value),undefined,key=>translate(`people.detail.${key}`,t('unavailable'))):field.owner==='movement'&&field.ownerField==='status'?translate(`people.detail.movement.status.${value}`,t('unavailable')):field.owner==='leaveRequest'&&field.ownerField==='status'?translate(`people.detail.leaveStatus.${value}`,t('unavailable')):field.owner==='leaveBalance'&&field.ownerField==='entitlementStatus'&&Object.hasOwn(ENTITLEMENT_STATUS_LABEL_KEY,String(value))?translate(`me.leaveBalanceTable.${ENTITLEMENT_STATUS_LABEL_KEY[value as EntitlementStatus]}`,t('unavailable')):typeof value==='boolean'?labels(value?'people.import.registerYes':'people.import.registerNo'):field.type==='date'?formatDmy(String(value)):String(value));
  const inputId=`ess-${key.replace(/[^a-zA-Z0-9_-]/g,'-')}`;
  const pendingLines=history.filter(request=>request.status==='pending').flatMap(request=>request.lines).filter(line=>line.fieldId===field.id&&(!row||line.key.startsWith(`${row.kind}:${rowIdentity(row)}:`)));
  return <div key={field.id} className="flex flex-col gap-1.5"><label htmlFor={allowed?inputId:undefined} className="text-xs font-medium text-muted-foreground">{personnelFieldLabel(field,translate)}</label>
   {allowed?<div className="space-y-1">
    {field.type==='boolean'?<select id={inputId} aria-label={fieldLabel(field.id)} aria-required={Boolean(field.form?.required?.record)} disabled={busy} value={value==null?'':String(value)} onChange={event=>update(key,event.target.value===''?null:event.target.value==='true',original)} className={inputCls}><option value="">{t('notRecorded')}</option><option value="true">{labels('people.import.registerYes')}</option><option value="false">{labels('people.import.registerNo')}</option></select>
    :field.type==='choice'?<select id={inputId} aria-label={fieldLabel(field.id)} aria-required={Boolean(field.form?.required?.record)} disabled={busy} value={value==null?'':String(value)} onChange={event=>update(key,event.target.value||null,original)} className={inputCls}><option value="">{t('notRecorded')}</option>{value!=null&&!choiceOptions.some(option=>option.value===String(value))&&<option value={String(value)}>{String(value)} · {t('recordedValue')}</option>}{choiceOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>
    :<input id={inputId} aria-label={fieldLabel(field.id)} aria-required={Boolean(field.form?.required?.record)} disabled={busy} type={field.type==='date'?(field.unit==='month'?'month':'date'):field.type==='number'||field.type==='currency'?'number':field.form?.widget==='email'?'email':'text'} min={field.form?.min} max={field.form?.max} step={field.form?.step??(field.type==='number'?'any':undefined)} value={mask?'':value==null?'':String(value)} placeholder={mask?String(original):undefined} onChange={event=>update(key,event.target.value===''?null:field.type==='number'||field.type==='currency'?Number(event.target.value):event.target.value,original)} className={inputCls}/>}
    <div className="flex gap-3 text-xs"><button type="button" disabled={busy} onClick={()=>update(key,null,original)} className="text-primary underline">{t('clear')}</button>{touched&&<button type="button" disabled={busy} onClick={()=>setChanges(previous=>{const next={...previous};delete next[key];return next;})} className="text-primary underline">{t('undo')}</button>}</div>
   </div>:<p className="min-h-9 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm break-words">{displayValue}</p>}
   {pendingLines.map(line=><p key={line.key} className="text-xs text-amber-800 dark:text-amber-300">{t('pendingValue',{value:line.value})}</p>)}
  </div>;
 }
 async function loadHistory(movementId:string){if(historyBusy)return;setHistoryBusy(movementId);try{const result=await readMyProfileMovementAction({employmentId:workspace.employmentId,movementId});if(result.ok)setComparisons(previous=>({...previous,[movementId]:result.records}));else setError(t(`error.${result.code}`));}catch{setError(t('error.system'));}finally{setHistoryBusy(null);}}
 function add(kind:EssRegisterChange['kind']){const clientId=crypto.randomUUID();setNewRows(previous=>[...previous,{kind,id:null,clientId,values:{},baselines:{},primary:false}]);}
 const panels=Object.fromEntries(keys.map((key,index)=>{
  const tab=ESS_PROFILE_TABS[index],tabFields=fields.filter(field=>field.tab===tab&&field.grain==='single'&&field.ownerField!=='photo'&&!['dependent','qualification','emergencyContact'].includes(field.owner));
  const sections=[...new Set(tabFields.map(field=>field.section))];
  const registers=([...workspace.registers,...newRows]).filter(row=>key==='family'?row.kind==='dependent':key==='qualification'?row.kind==='qualification':key==='profile'?row.kind==='emergency':false);
  const kind=key==='family'?'dependent':key==='qualification'?'qualification':key==='profile'?'emergency':null;
  return [key,<div key={key} className="space-y-4">
   {sections.map(section=><Card key={section} className="p-4 sm:p-5"><h2 className="mb-4 font-semibold">{labels(`people.detail.${sectionKeys[section]??`tabs.${key}`}`)}</h2><div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{tabFields.filter(field=>field.section===section&&(!extraPanels[key]||!['compensation','document'].includes(field.owner))).map(field=>control(field,values))}</div></Card>)}
   {kind&&<Card className="p-4 sm:p-5"><div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-semibold">{t(`register.${kind}`)}</h2>{editing&&fields.some(field=>field.ess.binding?.owner===kind&&editable.has(field.id))&&fields.filter(field=>field.ess.binding?.owner===kind&&field.form?.required?.record).every(field=>editable.has(field.id))&&<Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>add(kind)}>{t('addRecord')}</Button>}</div>
    {!registers.length&&<p className="text-sm text-muted-foreground">{t('noRecords')}</p>}
    <div className="space-y-5">{registers.map(row=><section key={rowIdentity(row)} className="rounded-md border border-border p-3"><div className="mb-3 flex justify-between gap-3 text-xs text-muted-foreground"><span>{row.id?row.primary?t('primaryRecord'):t('existingRecord'):t('newRecord')}</span>{row.id===null&&<button type="button" disabled={busy} onClick={()=>{setNewRows(previous=>previous.filter(item=>item.clientId!==('clientId' in row?row.clientId:'')));setChanges(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>!key.startsWith(`${row.kind}:${('clientId' in row?row.clientId:'')}:`))));}} className="text-primary underline">{t('removeNew')}</button>}</div><div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{fields.filter(field=>field.owner===(row.kind==='emergency'?'emergencyContact':row.kind)).map(field=>control(field,row.values,row))}</div></section>)}</div>
   </Card>}
   {workspace.addressReview&&key==='profile'&&<Card className="p-4"><h2 className="font-semibold">{t('legacyAddressTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('legacyAddressHelp')}</p><p className="mt-3 whitespace-pre-line text-sm">{Object.values(workspace.legacyAddress).filter(Boolean).join('\n')}</p></Card>}
   {facts.records.filter(row=>row.tab===tab).map(row=><Card key={row.key} className="p-4"><h2 className="mb-3 font-semibold">{labels(`people.detail.${sectionKeys[row.section]??`tabs.${key}`}`)}</h2><div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{fields.filter(field=>Object.hasOwn(row.values,field.id)).map(field=>control(field,row.values))}</div>{row.detailId&&<div className="mt-4"><Button type="button" size="sm" variant="outline" disabled={historyBusy!==null} onClick={()=>loadHistory(row.detailId!)}>{historyBusy===row.detailId?t('loadingHistory'):t('viewChanges')}</Button>{comparisons[row.detailId]?.map(comparison=><section key={comparison.key} className="mt-4 rounded-md border border-border p-3"><h3 className="mb-3 font-medium">{labels(`people.detail.movement.detail.${comparison.context==='before'?'beforeChanges':'afterChanges'}`)} · {formatDmy(comparison.date)}</h3><div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{fields.filter(field=>Object.hasOwn(comparison.values,field.id)).map(field=>control(field,comparison.values))}</div></section>)}</div>}</Card>)}
   {extraPanels[key]}
   {key==='others'&&<Card className="p-4"><h2 className="font-semibold">{t('requestHistory')}</h2>{!history.length&&<p className="mt-3 text-sm text-muted-foreground">{t('noRecords')}</p>}<ul className="mt-3 divide-y divide-border">{history.map(request=><li key={request.id} className="py-3 text-sm"><p className="font-medium">{t(`status.${request.status}`)} · {formatDmy(request.createdAt)}</p>{request.lines.map(line=><p key={line.key} className="mt-1">{line.label}: {line.value}</p>)}{request.decisionReason&&<p className="mt-2 text-muted-foreground">{request.decisionReason}</p>}</li>)}</ul></Card>}
  </div>];
 }));
 return <div className="space-y-4">
  <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{editing?t('editHelp'):t('viewHelp')}</p><div className="flex gap-2">{editing?<><Button type="button" variant="outline" disabled={busy} onClick={cancel}>{t('cancel')}</Button><Button type="button" disabled={busy} onClick={save}>{busy?t('saving'):t('save')}</Button></>:<Button ref={requestButton} type="button" disabled={!workspace.editable.length&&!workspace.legacyPrimaryEditable.length} onClick={()=>{setEditing(true);setNotice(null);}}>{t('requestEdit')}</Button>}</div></div>
  {error&&<p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">{error}</p>}{notice&&<p role="status" className="rounded-md border border-emerald-300 p-3 text-sm">{notice}</p>}
  <ClientTabs<PersonnelTabKey> tabs={keys.map(key=>({key,label:labels(`people.detail.tabs.${key}`)}))} panels={panels} emptyLabel={t('noRecords')} defaultTab={defaultTab} ariaLabel={labels('me.title')} monolithTxt/>
 </div>;
}
