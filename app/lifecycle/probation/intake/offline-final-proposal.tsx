'use client';
import {useEffect,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {DraftGuard} from '../draft-guard';
type PaperOutcome='confirm'|'extend'|'not_confirm'|'other';
export type PaperProposalInput={evidenceId:string;outcome:PaperOutcome;extensionMonths:3|6|null;reason:string};
export function OfflineFinalProposal({evidence,blocked,onSave,onDirtyChange,mode='proposal'}:{evidence:{id:string;name:string};blocked:boolean;onSave:(value:PaperProposalInput)=>Promise<{ok:boolean;detail?:string}>;onDirtyChange:(dirty:boolean)=>void;mode?:'proposal'|'adjudication'}){
 const t=useTranslations('probation'),router=useRouter(),[outcome,setOutcome]=useState<PaperOutcome|''>(''),[months,setMonths]=useState<3|6|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[saved,setSaved]=useState(false),[busy,start]=useTransition();
 const dirty=!!outcome||!!months||!!reason.trim();
 useEffect(()=>{onDirtyChange(dirty);return()=>onDirtyChange(false);},[dirty,onDirtyChange]);
 const discard=()=>{setOutcome('');setMonths(null);setReason('');setError('');};
 const save=()=>{if(!outcome||blocked||busy||reason.trim().length<3||outcome==='extend'&&!months)return;setError('');start(async()=>{const result=await onSave({evidenceId:evidence.id,outcome,extensionMonths:outcome==='extend'?months:null,reason});if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}discard();setSaved(true);router.refresh();});};
 return <section className="v9-stack"><DraftGuard dirty={dirty}/><h3>{t(mode==='adjudication'?'intake.paperFinalAdjudicate':'intake.paperFinalTitle')}</h3><p className="v9-muted">{t(mode==='adjudication'?'intake.paperFinalAdjudicationHelp':'intake.paperFinalHelp')}</p><p><strong>{t('intake.originalPdf')}:</strong> {evidence.name}</p>
 {error&&<p role="alert" className="v9-notice v9-error">{error}</p>}{saved&&<p role="status" className="v9-notice">{t(mode==='adjudication'?'intake.paperFinalWaiting':'intake.paperFinalRecorded')}</p>}
 <label className="v9-field"><span>{t('outcome')}</span><select value={outcome} disabled={busy||blocked} onChange={e=>{setOutcome(e.target.value as typeof outcome);setMonths(null);setSaved(false);}}><option value="">{t('choose')}</option>{(['confirm','extend','not_confirm','other'] as const).filter(value=>mode==='proposal'||value!=='other').map(value=><option key={value} value={value}>{t('outcomes.'+value)}</option>)}</select></label>
 {outcome==='extend'&&<label className="v9-field"><span>{t('extensionMonths')}</span><select value={months??''} disabled={busy||blocked} onChange={e=>setMonths(e.target.value==='3'?3:e.target.value==='6'?6:null)}><option value="">{t('choose')}</option>{([3,6] as const).map(value=><option key={value} value={value}>{t('planMonths',{months:value})}</option>)}</select></label>}
 <label className="v9-field"><span>{t('reason')}</span><textarea value={reason} maxLength={5000} disabled={busy||blocked} onChange={e=>setReason(e.target.value)}/></label>
 <div className="probation-actions"><button aria-busy={busy} type="button" className="v9-button v9-button-primary" disabled={busy||blocked||!outcome||reason.trim().length<3||outcome==='extend'&&!months} onClick={save}>{t(mode==='adjudication'?'intake.paperFinalResolve':'intake.paperFinalPropose')}</button>{dirty&&<button aria-busy={busy} type="button" className="v9-button" disabled={busy} onClick={discard}>{t('signers.discard')}</button>}</div></section>;
}
