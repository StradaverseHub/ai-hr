'use client';
import { useState,useTransition,type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button,inputCls } from '@/components/ui';
import { pmBands,potentialBands,talentCategory,talentCell,talentCell9,type PMBand,type PotentialBand } from '@/packs/performance/onehr/model';
import { talentMoveTarget } from '@/packs/performance/onehr/talent-move-model';
import { boardCellKey,type TalentBoxGrid } from '@/packs/performance/onehr/talent-board-model';
import { saveCalibrationBandAction } from '../onehr-actions';
type Person={id:string;name:string;performance:PMBand|null;potential:PotentialBand|null};
/** The one Talent Box move payload, whether the destination came from a drag, the board's menu or this dialog. */
export function talentMovePayload(sessionId:string,revision:number,person:Pick<Person,'id'>,target:{performance:PMBand;potential:PotentialBand},reason:string){
 const form=new FormData();
 for(const [name,value] of Object.entries({sessionId,revision:String(revision),reviewId:person.id,performance:target.performance,potential:target.potential,performanceNote:reason,potentialNote:reason}))form.set(name,value);
 return form;
}
function moveTarget(person:Person,key:string,picked:PMBand|null,grid:TalentBoxGrid){
 if(grid===9)return talentMoveTarget(person,key,picked);
 const [band,potential]=key.split('|');
 return (pmBands as readonly string[]).includes(band)&&(potentialBands as readonly string[]).includes(potential)?{performance:band as PMBand,potential:potential as PotentialBand,choices:[] as PMBand[]}:null;
}
/**
 * A Talent Box move: pick the destination box, optionally give the reason (APR-022: no leader reason is required), save.
 * Uncontrolled it renders its own Move button; the board opens it controlled, with the dropped box preselected.
 */
export function TalentBoxMove({person,sessionId,revision,disabled=false,onMoved,grid=9,open:controlled,onOpenChange,initialKey='',trigger}:{person:Person;sessionId:string;revision:number;disabled?:boolean;onMoved?:()=>void;grid?:TalentBoxGrid;open?:boolean;onOpenChange?:(open:boolean)=>void;initialKey?:string;trigger?:ReactNode|false}){
 const t=useTranslations('onehr.talentMove'),tr=useTranslations('onehr'),router=useRouter(),[own,setOwn]=useState(false),[key,setKey]=useState(initialKey),[picked,setPicked]=useState<PMBand|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,start]=useTransition();
 const open=controlled??own,current=grid===9?talentCell(person):boardCellKey(person,grid),target=moveTarget(person,key,picked,grid);
 function changeOpen(next:boolean){if(busy)return;if(controlled===undefined)setOwn(next);onOpenChange?.(next);if(next){setKey(initialKey);setPicked(null);setReason('');setError('');}}
 const columns=grid===9?(['low','mid','high'] as const):pmBands;
 const columnLabel=(column:string)=>grid===9?tr(`grid${column[0].toUpperCase()+column.slice(1)}`):column;
 const label=(column:string,potential:PotentialBand)=>grid===9?talentCell9(column as 'low'|'mid'|'high',potential):talentCategory(column as PMBand,potential)!;
 return <Dialog.Root open={open} onOpenChange={changeOpen}>{trigger!==false&&<Dialog.Trigger asChild>{trigger??<button type="button" disabled={disabled} aria-label={t('forPerson',{name:person.name})} className="min-h-11 px-2 text-sm text-primary hover:underline disabled:text-muted-foreground disabled:no-underline">{t('move')}</button>}</Dialog.Trigger>}<Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/40"/><Dialog.Content aria-describedby={undefined} onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onPointerDownOutside={event=>{if(busy)event.preventDefault();}} className="fixed left-1/2 top-1/2 z-40 max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 text-foreground shadow-xl">
  <Dialog.Title className="font-semibold">{t('forPerson',{name:person.name})}</Dialog.Title><p className="mt-1 text-xs text-muted-foreground">{t('now',{performance:person.performance??'—',potential:person.potential??'—'})}</p>
  <fieldset disabled={busy} className="mt-4 space-y-4"><div role="group" aria-label={t('destination')} className={`grid gap-1 ${grid===9?'grid-cols-3':'grid-cols-5'}`}>{[...potentialBands].reverse().flatMap(potential=>columns.map(column=>{const value=`${column}|${potential}`,category=label(column,potential);return <button type="button" key={value} disabled={value===current} aria-label={t(value===current?'currentBox':'targetBox',{box:category,performance:columnLabel(column),potential})} aria-pressed={key===value} onClick={()=>{setKey(key===value?'':value);setPicked(null);setError('');}} className={`min-h-16 rounded-md border p-2 text-xs ${key===value?'border-primary bg-primary/10':'border-border'} disabled:bg-muted disabled:text-muted-foreground`}><span className="block font-medium [overflow-wrap:anywhere]">{category}</span><span className="mt-1 block text-[10px] text-muted-foreground">{potential} · {columnLabel(column)}</span></button>;}))}</div>
   <p className="text-center text-xs text-muted-foreground">{t('axes')}</p>
   {target?<div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{tr('performance')} · <b translate="no">{person.performance} → {target.performance}</b></span>{target.choices.length>1&&<div role="group" aria-label={t('band')}>{target.choices.map(band=><button type="button" key={band} aria-pressed={target.performance===band} onClick={()=>setPicked(band)} className="min-h-11 min-w-11 rounded-md border border-border px-3 text-sm aria-pressed:border-primary aria-pressed:bg-primary/10">{band}</button>)}</div>}</div><p className="text-sm">{tr('potential')} · <b translate="no">{person.potential} → {target.potential}</b></p></div>:<p className="text-sm text-muted-foreground">{t('pick')}</p>}
   <label className="block space-y-1 text-sm"><span>{t('reason')}</span><textarea aria-label={t('reason')} maxLength={1000} rows={3} value={reason} onChange={event=>setReason(event.target.value)} className={`${inputCls} min-h-20`}/></label>
  </fieldset>
  {error&&<p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
  <div className="mt-4 flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={()=>changeOpen(false)}>{t('cancel')}</Button><Button type="button" disabled={!target||busy||disabled} onClick={()=>{if(!target)return;const form=talentMovePayload(sessionId,revision,person,target,reason);setError('');start(async()=>{try{const result=await saveCalibrationBandAction(form);if('error' in result){setError(result.error??t('failed'));return;}changeOpen(false);onMoved?.();router.refresh();}catch{setError(t('failed'));}});}}>{busy?t('saving'):t('save')}</Button></div>
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
