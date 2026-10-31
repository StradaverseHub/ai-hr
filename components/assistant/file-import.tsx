'use client';
import type {ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {Paperclip,X} from 'lucide-react';
import {btnPrimary,inputCls} from '@/components/ui';
import {IMPORT_TARGETS,type AssistantImportTarget} from '@/lib/assistant-import';
import {useAssistantImport} from './use-assistant-import';
import {parseCsv} from '@/lib/csv';

/** Draft preparation is never submitted through the chat conversation/action loop. */
export function AssistantFileImport({normalComposer,instruction:providedInstruction,onInstructionChange}:{normalComposer?:ReactNode;instruction?:string;onInstructionChange?:(value:string)=>void}){
 const t=useTranslations('assistant.fileImport');
 const controller=useAssistantImport({instruction:providedInstruction,onInstructionChange});
 const {source,part,target,instruction,busy,error,draft,csv,consent,reviewed,picker,load,prepare,review,discard,changeInstruction,changeTarget,changePart,setConsent,setReviewed,setCsv,canReview}=controller;
 const displayed=csv?parseCsv(csv):[],displayColumns=displayed[0]??[],displayRows=displayed.slice(1);
 return <div className="space-y-3"
  onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}}
  onDrop={event=>{if(!event.dataTransfer.files.length)return;event.preventDefault();void load(Array.from(event.dataTransfer.files));}}>
  {!source&&busy===null&&normalComposer}
  <section aria-label={t('title')} className="space-y-3 rounded-xl border border-border bg-card p-4">
  <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">{t('title')}</h2>
   <button type="button" disabled={busy!==null} className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50" onClick={()=>picker.current?.click()}><Paperclip aria-hidden className="size-4"/>{t('attach')}</button>
   <input ref={picker} type="file" accept=".pdf,.xlsx,.xls,.csv" className="sr-only" aria-label={t('attach')} tabIndex={-1} onChange={event=>void load(Array.from(event.target.files??[]))}/>
  </div>
  <p className="text-xs text-muted-foreground">{t('hint')}</p>
  {source&&<>
   <div className="flex items-center justify-between gap-2"><p className="min-w-0 break-words text-sm">{source.name}</p><button type="button" aria-label={t('discard')} className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary" onClick={discard}><X aria-hidden className="size-4"/></button></div>
   <fieldset disabled={busy!==null} className="space-y-3">
    <label className="block text-sm">{t('target')}<select className={`${inputCls} mt-1 w-full`} value={target} onChange={event=>changeTarget(event.target.value as AssistantImportTarget)}>{IMPORT_TARGETS.map(value=><option key={value} value={value}>{t(value)}</option>)}</select></label>
    {source.parts.length>1&&<label className="block text-sm">{t('sheet')}<select aria-label={t('sheet')} className={`${inputCls} mt-1 w-full`} value={part} onChange={event=>changePart(Number(event.target.value))}>{source.parts.map((item,index)=><option key={index} value={index}>{item.label}</option>)}</select><span className="mt-1 block text-xs text-muted-foreground">{t('sheetHint')}</span></label>}
    <label className="block text-sm">{t('request')}<textarea className={`${inputCls} mt-1 min-h-20 w-full`} rows={2} maxLength={2000} value={instruction} placeholder={t('requestHint')} onChange={event=>changeInstruction(event.target.value)}/></label>
    <details><summary className="cursor-pointer text-sm underline underline-offset-4">{t('source')}</summary><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{source.parts[part].text}</pre></details>
    {!!(source.parts[part].formulas||source.parts[part].errors)&&<p role="status" className="text-xs text-muted-foreground">{t('formulaNotice',{formulas:source.parts[part].formulas??0,errors:source.parts[part].errors??0})}</p>}
    <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-0.5"/><span>{t('consent')}</span></label>
    <button type="button" className={`${btnPrimary} min-h-11`} disabled={!consent||!instruction.trim()} onClick={()=>void prepare()}>{t('prepare')}</button>
   </fieldset>
  </>}
  {busy&&<p role="status" className="text-sm text-muted-foreground">{t(busy==='read'?'reading':'preparing')}</p>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {draft&&<div className="space-y-3 border-t pt-4">
   <h3 className="text-sm font-medium">{t('draft',{count:displayRows.length})}</h3><p className="text-xs text-muted-foreground">{t('draftHint')}</p>
   <div className="max-h-80 overflow-auto rounded-md border"><table className="w-full text-left text-xs"><thead><tr>{displayColumns.map((column,index)=><th className="whitespace-nowrap border-b bg-muted p-2 font-medium" key={index}>{column.replace(/_/g,' ')}</th>)}</tr></thead><tbody>{displayRows.map((row,index)=><tr key={index}>{row.map((value,column)=><td key={column} className="max-w-64 border-b p-2 align-top"><span className="block min-w-28 whitespace-pre-wrap break-words">{value||'—'}</span></td>)}</tr>)}</tbody></table></div>
   <details><summary className="cursor-pointer text-sm underline underline-offset-4">{t('edit')}</summary><label className="mt-2 block text-xs">{t('editHint')}<textarea rows={8} maxLength={180000} className={`${inputCls} mt-1 w-full font-mono text-xs`} value={csv} onChange={event=>setCsv(event.target.value)}/></label></details>
   <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/><span>{t('reviewed')}</span></label>
   <button type="button" className={`${btnPrimary} min-h-11`} disabled={!canReview} onClick={review}>{t('review')}</button>
   <p className="text-xs text-muted-foreground">{t('next')}</p>
  </div>}
 </section></div>;
}
