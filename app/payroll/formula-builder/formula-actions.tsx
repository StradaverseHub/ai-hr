'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {deleteFormulaAction} from './actions';
import {formulaButton,NO_FORMULA_CAPABILITIES,type FormulaBuilderView} from './ui-types';

export function FormulaActions({formula,disabled=false}:{formula:FormulaBuilderView;disabled?:boolean}){
 const t=useTranslations('payFormula'),router=useRouter();
 const [pending,setPending]=useState(false),[error,setError]=useState(''),[confirming,setConfirming]=useState(false),[reason,setReason]=useState('');
 const caps=formula.capabilities??NO_FORMULA_CAPABILITIES;
 async function remove(){
  if(!confirming||pending||disabled||!caps.delete||!reason.trim())return;
  setPending(true);setError('');
  try{
   const result=await deleteFormulaAction({id:formula.id,reason});
   if(!result.ok){setError(result.error);return;}
   setConfirming(false);router.push('/payroll/formula-builder');router.refresh();
  }finally{setPending(false);}
 }
 return <div className="space-y-2">
  {caps.delete&&<button aria-busy={pending} type="button" className={formulaButton} disabled={disabled||pending} onClick={()=>{setConfirming(true);setError('');}}>{t('delete')}</button>}
  {confirming&&<section role="alertdialog" aria-modal="false" aria-label={t('delete')} className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
   <p className="text-sm">{t('deleteConfirm')}</p>
   <label className="block text-sm">{t('deleteReason')}<input className="mt-1 block w-full rounded-lg border border-input bg-background p-2" value={reason} onChange={event=>setReason(event.target.value)} maxLength={1000}/></label>
   <div className="flex gap-2"><button aria-busy={pending} type="button" className={formulaButton} disabled={disabled||pending||!reason.trim()} onClick={remove}>{pending?t('working'):t('confirm')}</button><button type="button" className={formulaButton} disabled={pending} onClick={()=>setConfirming(false)}>{t('cancel')}</button></div>
  </section>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </div>;
}
