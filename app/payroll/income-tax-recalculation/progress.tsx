'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import {continueTaxBasisAction,recoverTaxBasisAction} from './actions';

const button='inline-flex items-center justify-center rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const primary=button+' border-primary bg-primary text-primary-foreground hover:bg-primary/90';

/** The server owns heartbeat eligibility, authorization and the next bounded employee group. */
export function TaxBasisProgress({batchId,recoverable,canRecalculate}:{batchId:string;recoverable:boolean;canRecalculate:boolean}){
  const t=useTranslations('payrollTaxBasis'),router=useRouter();
  const [busy,setBusy]=useState(false),[open,setOpen]=useState(false),[error,setError]=useState<string|null>(null);
  async function proceed(kind:'continue'|'recover'){
    if(busy||!canRecalculate||(kind==='recover'&&!recoverable))return;
    setBusy(true);setError(null);
    try{
      const result=kind==='recover'?await recoverTaxBasisAction({batchId}):await continueTaxBasisAction({batchId});
      if(!result.ok){setOpen(false);setError(result.error??t('unexpectedError'));return;}
      setOpen(false);
      if(kind==='recover')router.push('/payroll/income-tax-recalculation?retry='+result.result.id);
      router.refresh();
    }catch{setOpen(false);setError(t('unexpectedError'));}finally{setBusy(false);}
  }
  return <div className="space-y-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <p className="max-w-3xl text-sm text-muted-foreground">{t(recoverable?'interruptedHint':'continueHint')}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className={button} onClick={()=>router.refresh()} disabled={busy}>{t('refresh')}</button>
        {!recoverable&&canRecalculate&&<button type="button" className={primary} onClick={()=>proceed('continue')} disabled={busy}>{t(busy?'processing':'continueAction')}</button>}
        {recoverable&&canRecalculate&&<AlertDialog.Root open={open} onOpenChange={value=>{if(!busy)setOpen(value);}}>
          <AlertDialog.Trigger asChild><button type="button" className={button} disabled={busy}>{t('reviewUnfinished')}</button></AlertDialog.Trigger>
          <AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/45"/><AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-popover p-6 text-popover-foreground shadow-xl">
            <AlertDialog.Title className="text-lg font-semibold">{t('recoverTitle')}</AlertDialog.Title>
            <AlertDialog.Description className="mt-3 text-sm text-muted-foreground">{t('recoverDescription')}</AlertDialog.Description>
            <div className="mt-6 flex flex-wrap justify-end gap-3"><AlertDialog.Cancel asChild><button type="button" className={button} disabled={busy}>{t('cancel')}</button></AlertDialog.Cancel><button type="button" className={primary} disabled={busy} onClick={()=>proceed('recover')}>{t(busy?'processing':'recoverAction')}</button></div>
          </AlertDialog.Content></AlertDialog.Portal>
        </AlertDialog.Root>}
      </div>
    </div>
    {!canRecalculate&&<p className="text-xs text-muted-foreground">{t('readOnly')}</p>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
