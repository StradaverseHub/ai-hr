'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, ErrorBanner, inputCls, tableWrapCls, thCls, theadCls, tbodyCls } from './ui';
import type { LabelImportMode, LabelImportPreview } from '@/lib/system-label-definition';
import { previewLabelsAction, importLabelsAction } from '@/app/admin/settings/system-labels/import-actions';

export function SystemLabelImport() {
  const t=useTranslations('admin.systemLabels.excel'),router=useRouter();
  const fileInput=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false),[file,setFile]=useState<File|null>(null),[mode,setMode]=useState<LabelImportMode>('add');
  const [preview,setPreview]=useState<LabelImportPreview|null>(null),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false);
  const [summary,setSummary]=useState<{imported:number;updated:number;skipped:number;failed:number}|null>(null),[pending,start]=useTransition();
  const reset=()=>{setPreview(null);setConfirmed(false);setSummary(null);setError('');};
  const form=()=>{const d=new FormData();if(file)d.set('file',file);d.set('mode',mode);return d;};
  const analyse=()=>start(async()=>{reset();const r=await previewLabelsAction(form());if(r.ok)setPreview(r.preview);else setError(r.message);});
  const apply=()=>start(async()=>{
    if(!preview)return;
    const d=form();d.set('token',preview.token);d.set('confirmUpdates',String(confirmed));
    const r=await importLabelsAction(d);
    if(r.ok){setSummary(r.summary);setPreview(null);setFile(null);if(fileInput.current)fileInput.current.value='';router.refresh();}
    else {setError(r.message);setPreview(null);setConfirmed(false);}
  });
  const updates=preview?.rows.some(r=>r.outcome==='update')??false;
  return <section className="space-y-3" data-label-import>
    <div className="flex flex-wrap justify-end gap-2">
      <a href="/admin/settings/system-labels/template" className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium">{t('template')}</a>
      <Button type="button" variant="outline" onClick={()=>setOpen(!open)}>{t('import')}</Button>
    </div>
    {open&&<form method="post" action="/admin/settings/system-labels/errors" encType="multipart/form-data" className="space-y-4 rounded-lg border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm"><span className="block">{t('file')}</span><input ref={fileInput} name="file" aria-label={t('file')} type="file" accept=".xlsx" disabled={pending} className={inputCls} onChange={e=>{reset();setFile(e.target.files?.[0]??null);}}/></label>
        <label className="space-y-1 text-sm"><span className="block">{t('mode')}</span><select name="mode" className={inputCls} value={mode} disabled={pending} onChange={e=>{reset();setMode(e.target.value as LabelImportMode);}}><option value="add">{t('add')}</option><option value="update">{t('update')}</option></select></label>
        <Button type="button" disabled={!file||pending} onClick={analyse}>{pending?t('working'):t('preview')}</Button>
      </div>
      <ErrorBanner message={error}/>
      {summary&&<p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{t('summary',summary)}</p>}
      {preview&&<>
        <div className={`${tableWrapCls} max-h-96 overflow-auto`}><table className="w-full text-sm"><thead className={theadCls}><tr>{['row','result','current','proposed','message'].map(k=><th key={k} className={thCls}>{t(k)}</th>)}</tr></thead>
          <tbody className={tbodyCls}>{preview.rows.map((r,i)=><tr key={i} className={r.outcome==='error'?'bg-destructive/5':''}>
            <td className="px-3 py-2 align-top">{r.sheet} · {r.row}</td><td className="px-3 py-2 align-top">{t(`outcome.${r.outcome}`)}</td>
            {[r.before,r.after].map((v,n)=><td key={n} className="max-w-80 px-3 py-2 align-top"><dl>{v?Object.entries(v).map(([k,value])=><div key={k}><dt className="inline text-xs text-muted-foreground">{k}: </dt><dd className="inline break-words">{value||'—'}</dd></div>):'—'}</dl></td>)}
            <td className="px-3 py-2 align-top">{r.message}</td></tr>)}</tbody></table></div>
        {!preview.valid&&<p className="text-sm text-destructive">{t('fixErrors')}</p>}
        {preview.rows.some(r=>r.outcome==='error')&&<Button type="submit" variant="outline" disabled={pending}>{t('errors')}</Button>}
        {updates&&<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={pending} onChange={e=>setConfirmed(e.target.checked)}/>{t('confirmUpdates')}</label>}
        <Button type="button" disabled={pending||!preview.valid||updates&&!confirmed} onClick={apply}>{t('confirm')}</Button>
      </>}
    </form>}
  </section>;
}
