'use client';
import {useEffect,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {DraftGuard} from './draft-guard';
import {readPublicationRetirement,retirePublication} from './actions';
export function RetireVersionControl({companyId,kind,versionId,version,blocked,onDirtyChange}:{companyId:string;kind:'form'|'workflow'|'template';versionId:string;version:number;blocked:boolean;onDirtyChange?:(dirty:boolean)=>void}){
 const t=useTranslations('probation'),router=useRouter(),[availability,setAvailability]=useState<{canRetire:boolean;expectedVersion:number}|null>(null),[reason,setReason]=useState(''),[busy,start]=useTransition(),[error,setError]=useState(''),[done,setDone]=useState(false);
 useEffect(()=>{onDirtyChange?.(!!reason.trim());return()=>onDirtyChange?.(false);},[reason,onDirtyChange]);
 const inspect=()=>{if(availability||busy||done)return;setError('');start(async()=>{const result=await readPublicationRetirement({companyId,kind,versionId});if(result.ok)setAvailability(result.result);else setError(result.detail??t('errors.unavailable'));});};
 const retire=()=>{if(!availability?.canRetire||blocked||reason.trim().length<3)return;setError('');start(async()=>{const result=await retirePublication({companyId,kind,versionId,expectedVersion:availability.expectedVersion,reason});if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setReason('');setDone(true);router.refresh();});};
 return <details className="v9-panel v9-stack" onToggle={event=>{if(event.currentTarget.open)inspect();}}><DraftGuard dirty={!!reason.trim()}/><summary onClick={event=>{if(reason.trim()){if(!window.confirm(t('leaveUnsaved'))){event.preventDefault();return;}setReason('');}}}>{t('retire.title',{version})}</summary><p className="v9-muted">{t('retire.help')}</p>
 {error&&<p role="alert" className="v9-notice v9-error">{error}</p>}{done?<p role="status" className="v9-notice">{t('retire.success')}</p>:availability?.canRetire?<><label className="v9-field"><span>{t('reason')}</span><textarea maxLength={5000} value={reason} disabled={busy||blocked} onChange={e=>setReason(e.target.value)}/></label><div className="probation-actions"><button aria-busy={busy} type="button" className="v9-button" disabled={busy||blocked||reason.trim().length<3} onClick={retire}>{t('retire.action')}</button>{reason.trim()&&<button aria-busy={busy} type="button" className="v9-button" disabled={busy} onClick={()=>setReason('')}>{t('signers.discard')}</button>}</div></>:availability?<p>{t('retire.unavailable')}</p>:busy?<p role="status">{t('retire.checking')}</p>:error?<button type="button" className="v9-button" onClick={inspect}>{t('reload')}</button>:null}
 </details>;
}
