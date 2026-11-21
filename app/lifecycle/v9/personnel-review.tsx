'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import Link from 'next/link';
import type {Case,PMChange} from '@/lib/lifecycle-v9-model';
import type {LifecycleV9Command as Command} from '@/packs/lifecycle/service';
import {onboardingTimestamp} from '@/lib/onboarding-format';
const sensitiveKeys=new Set(['icNo','employee.icNo','passportNo','employee.passportNo','bankAcc','bankAccount','taxNo','epfNo','socsoNo','spIc','spTax']);
type AttributionLabels={recordedBy:string;recordedWhen:string;notRecorded:string};
export function PersonnelReview({c,busy,writableKeys,command,labels}:{c:Case;busy:boolean;writableKeys:string[];command:(command:Command)=>void;labels?:AttributionLabels}){
 const ids=[...new Set(c.pmChanges.map(change=>change.documentId))];return <>{ids.map(id=><ReviewGroup key={id} c={c} documentId={id} busy={busy} writableKeys={writableKeys} command={command} labels={labels}/>)}</>;
}
function mask(value:string){if(!value)return '';if(value.startsWith('['))return value;const compact=value.replace(/\s/g,'');return compact.length<=4?'••••':`•••• ${compact.slice(-4)}`;}
function ReviewGroup({c,documentId,busy,writableKeys,command,labels}:{c:Case;documentId:string;busy:boolean;writableKeys:string[];command:(command:Command)=>void;labels?:AttributionLabels}){
 const t=useTranslations('personnelCompletion');
 const document=c.documents.find(document=>document.id===documentId),changes=c.pmChanges.filter(change=>change.documentId===documentId);
 const[excluded,setExcluded]=useState<string[]>([]),[revealed,setRevealed]=useState<string[]>([]);
 const pending=changes.filter(change=>change.status==='proposed'||change.status==='conflict'),selected=pending.filter(change=>writableKeys.includes(change.field)&&!excluded.includes(change.id));
 const field=(change:PMChange)=>document?.fields.find(field=>field.pmKey===change.field);
 const sensitive=(change:PMChange)=>field(change)?.sensitive||sensitiveKeys.has(change.field);
 const disabled=busy||c.state!=='submitted';
 return <section className="v9-panel v9-stack"><h2>{t('pmTitle')}</h2><p className="v9-muted">{t('pmHelp',{document:document?.name??t('submittedForm')})}</p><div className="v9-table-scroll"><table className="v9-table"><thead><tr><th>{t('push')}</th><th>{t('field')}</th><th>{t('previous')}</th><th>{t('proposed')}</th><th>{t('status')}</th><th>{labels?.recordedBy??t('recordedBy')}</th><th>{labels?.recordedWhen??t('recordedWhen')}</th></tr></thead><tbody>{changes.map(change=>{
  const label=field(change)?.label??change.field,hidden=sensitive(change)&&!revealed.includes(change.id),active=pending.includes(change),supported=writableKeys.includes(change.field),provenance=change.provenance?.kind==='missing-personnel'?change.provenance:null;
  return <tr key={change.id}><td><input type="checkbox" aria-label={t('pushField',{field:label})} checked={active&&supported&&!excluded.includes(change.id)} disabled={disabled||!active||!supported} onChange={event=>setExcluded(ids=>event.target.checked?ids.filter(id=>id!==change.id):[...ids,change.id])}/></td><td>{label}{!supported&&<p><Link className="v9-link" href={`/admin/personnel/${c.facts.employmentId}`}>{t('reviewMapping')}</Link></p>}</td><td>{change.before.trim()?hidden?mask(change.before):change.before:t('notInPm')}</td><td>{hidden?mask(change.after):change.after||'—'}{sensitive(change)&&<button className="v9-link" style={{marginLeft:8}} type="button" aria-label={t(hidden?'show':'hide',{field:label})} onClick={()=>setRevealed(ids=>hidden?[...ids,change.id]:ids.filter(id=>id!==change.id))}>{t(hidden?'show':'hide',{field:label})}</button>}</td><td>{t('statuses.'+change.status)}</td><td>{provenance?.by.name??labels?.notRecorded??t('notRecorded')}</td><td>{provenance?onboardingTimestamp(provenance.at):labels?.notRecorded??t('notRecorded')}</td></tr>;
 })}</tbody></table></div>{pending.length>0&&<div className="v9-actions"><button type="button" className="v9-button v9-button-primary" disabled={disabled||!selected.length} onClick={()=>command({type:'pmPushSelected',ids:selected.map(change=>change.id)})}>{t('pushSelected',{count:selected.length})}</button><button type="button" className="v9-button" disabled={disabled} onClick={()=>command({type:'pmKeep',ids:pending.map(change=>change.id)})}>{t('keepOnCase')}</button></div>}</section>;
}
