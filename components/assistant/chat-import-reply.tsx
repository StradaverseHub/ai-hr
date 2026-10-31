'use client';
import {useTranslations} from 'next-intl';
import {btnPrimary,inputCls} from '../ui';
import {IMPORT_TARGETS,type AssistantImportTarget} from '../../lib/assistant-import';
import {parseCsv} from '../../lib/csv';
import type {AssistantImportController} from './use-assistant-import';

/** The existing import review inside the active conversation. It does not submit ordinary chat,
 * execute an import or nominate provider payloads; the native owners remain unchanged. */
export function ChatImportReply({controller}:{controller:AssistantImportController}){
 const t=useTranslations('assistant.fileImport');
 const{source,part,target,busy,error,draft,csv,consent,reviewed,changeTarget,changePart,setConsent,setReviewed,setCsv,canReview,review}=controller;
 const displayed=csv?parseCsv(csv):[],columns=displayed[0]??[],rows=displayed.slice(1),selected=source?.parts[part];
 return <div className="space-y-4 text-sm leading-relaxed">
  {!draft&&!error&&busy===null&&<p>{t('request')}</p>}
  {source&&<>
   <fieldset disabled={busy!==null} className="space-y-3">
    <div className="flex flex-wrap gap-3">
     <label className="block min-w-0 flex-1">{t('target')}<select className={`${inputCls} mt-1 w-full`} value={target} onChange={event=>changeTarget(event.target.value as AssistantImportTarget)}>{IMPORT_TARGETS.map(value=><option key={value} value={value}>{t(value)}</option>)}</select></label>
     {source.parts.length>1&&<label className="block min-w-0 flex-1">{t('sheet')}<select className={`${inputCls} mt-1 w-full`} value={part} onChange={event=>changePart(Number(event.target.value))}>{source.parts.map((item,index)=><option key={index} value={index}>{item.label}</option>)}</select></label>}
    </div>
    {source.parts.length>1&&<p className="text-xs text-muted-foreground">{t('sheetHint')}</p>}
    {selected&&<details><summary className="min-h-8 w-fit cursor-pointer py-1 text-xs underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('source')}</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{selected.text}</pre></details>}
    {!!(selected?.formulas||selected?.errors)&&<p role="status" className="text-xs text-muted-foreground">{t('formulaNotice',{formulas:selected?.formulas??0,errors:selected?.errors??0})}</p>}
    {!draft&&<label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-1"/><span>{t('consent')}</span></label>}
   </fieldset>
  </>}
  {busy&&<p role="status" aria-live="polite" className="text-xs text-muted-foreground">{t(busy==='read'?'reading':'preparing')}</p>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {draft&&<div className="space-y-3">
   <p className="font-medium">{t('draft',{count:rows.length})}</p><p className="text-xs text-muted-foreground">{t('draftHint')}</p>
   <div className="max-h-80 overflow-auto"><table className="w-full text-left text-xs"><thead><tr>{columns.map((column,index)=><th className="whitespace-nowrap border-b border-border p-2 font-medium" key={index}>{column.replace(/_/g,' ')}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{row.map((value,column)=><td key={column} className="max-w-64 border-b border-border p-2 align-top"><span className="block min-w-28 whitespace-pre-wrap break-words">{value||'—'}</span></td>)}</tr>)}</tbody></table></div>
   <details><summary className="min-h-8 w-fit cursor-pointer py-1 text-xs underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('edit')}</summary><label className="mt-2 block text-xs">{t('editHint')}<textarea rows={6} maxLength={180000} className={`${inputCls} mt-1 w-full font-mono text-xs`} value={csv} onChange={event=>setCsv(event.target.value)}/></label></details>
   <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/><span>{t('reviewed')}</span></label>
   <button type="button" className={`${btnPrimary} min-h-11`} disabled={!canReview} onClick={review}>{t('review')}</button>
   <p className="text-xs text-muted-foreground">{t('next')}</p>
  </div>}
 </div>;
}
