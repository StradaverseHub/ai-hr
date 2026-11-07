'use client';
import {useRef,useState,useTransition} from 'react';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import {useTranslations} from 'next-intl';
import {useRouter} from 'next/navigation';
import {Button} from '@/components/ui';
import {buildIndividualTxnWorkbook,type IndividualImportCycleReference} from '@/lib/individual-txn-import-workbook';
import type {TxnTemplateReference} from '@/lib/import-template-xlsx';
import type {IndividualImportMethod} from '@/lib/payroll-txn-import-schema';
import {INDIVIDUAL_IMPORT_MAX_BYTES} from '@/lib/individual-import-job';
import {submitIndividualImportAction} from './individual-actions';
export function IndividualImportButtons({reference,cycles}:{reference:TxnTemplateReference;cycles:IndividualImportCycleReference[]}){
 const t=useTranslations('payroll.individualImport'),router=useRouter();
 const [open,setOpen]=useState(false),[method,setMethod]=useState<IndividualImportMethod>('monthly'),[file,setFile]=useState<File|null>(null),[error,setError]=useState(''),[busy,start]=useTransition();
 const operation=useRef<string|null>(null);
 const message=(e:unknown)=>{const key=e instanceof Error?e.message:'';return t.has(key)?t(key as never):t('failed');};
 async function template(which:IndividualImportMethod){setError('');try{const bytes=await buildIndividualTxnWorkbook(which,reference,cycles,t('instructions'));const url=URL.createObjectURL(new Blob([bytes as BlobPart],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));const a=document.createElement('a');a.href=url;a.download=`individual-${which}-transactions.xlsx`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError(message(e));}}
 function submit(){
  if(!file)return;
  start(async()=>{
   setError('');
   try{
    if(!file.name.toLowerCase().endsWith('.xlsx'))throw new Error('invalidFormat');
    if(file.size>INDIVIDUAL_IMPORT_MAX_BYTES)throw new Error('fileTooLarge');
    operation.current??=crypto.randomUUID();
    const form=new FormData();
    form.set('id',operation.current);
    form.set('method',method);
    form.set('file',file);
    const result=await submitIndividualImportAction(form);
    if(!result.ok)throw new Error(result.error);
    setOpen(false);
    router.push(`/payroll/transactions/individual/imports/batches/${result.id}`);
   }catch(e){setError(message(e));}
  });
 }
 return <div className="flex flex-wrap gap-2"><Button type="button" onClick={()=>setOpen(true)}>{t('open')}</Button><Link className="rounded-lg border border-border px-3 py-2 text-sm" href="/payroll/transactions/individual/imports">{t('log')}</Link>
 <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/40"/><Dialog.Content className="fixed inset-x-4 top-[5vh] z-50 mx-auto max-h-[90vh] max-w-5xl overflow-auto rounded-xl border border-border bg-card p-6 shadow-xl"><div className="flex items-center justify-between gap-4"><Dialog.Title className="text-lg font-semibold">{t('open')}</Dialog.Title><Dialog.Close className="rounded border border-border px-3 py-2">{t('close')}</Dialog.Close></div><Dialog.Description className="mt-2 text-sm text-muted-foreground">{t('workflow')}</Dialog.Description>
 <section className="my-5 space-y-4 rounded-xl border border-border p-5"><h2 className="font-semibold">{t('choose')}</h2><label className="block text-sm">{t('method')}<select className="mt-2 block w-full rounded-lg border border-input bg-card p-2" value={method} disabled={busy} onChange={e=>{setMethod(e.target.value as IndividualImportMethod);setError('');operation.current=null;}}><option value="monthly">{t('monthly')}</option><option value="daily">{t('daily')}</option></select></label><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} onClick={()=>template('monthly')}>{t('monthlyTemplate')}</Button><Button type="button" disabled={busy} onClick={()=>template('daily')}>{t('dailyTemplate')}</Button></div><p className="text-sm text-muted-foreground">{t('dailyHint')}</p><input aria-label={t('file')} type="file" accept=".xlsx" disabled={busy} onChange={e=>{setFile(e.target.files?.[0]??null);operation.current=null;setError('');}}/><Button type="button" disabled={busy||!file} onClick={submit}>{busy?t('working'):t('submitWorkbook')}</Button></section>
 {error&&<p role="alert" className="my-4 rounded-lg border border-destructive p-3 text-destructive">{error}</p>}
 </Dialog.Content></Dialog.Portal></Dialog.Root></div>;
}
