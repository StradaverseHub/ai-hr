'use client';
import { createContext,useContext,useEffect,useId,useRef,useState,type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { History } from 'lucide-react';
import { AnchoredPanel,useAnchoredPanel,useBelowLg } from '@/components/ui/anchored-panel';
import { pmBands,potentialBands } from '@/packs/performance/onehr/model';
import type { TalentTrailStep } from '@/packs/performance/onehr/talent-trail-model';
const HistoryContext=createContext<{open:string|null;setOpen:(next:(old:string|null)=>string|null)=>void}|null>(null);
export function BandHistoryProvider({children}:{children:ReactNode}){const [open,setOpen]=useState<string|null>(null);return <HistoryContext.Provider value={{open,setOpen}}>{children}</HistoryContext.Provider>;}
export function TalentBandHistory({name,axis,steps,current,source,active=true}:{name:string;axis:'performance'|'potential';steps:TalentTrailStep[];current:string|null;source:string|null;active?:boolean}){
 const t=useTranslations('onehr.talentTrail'),tr=useTranslations('onehr'),list=useTranslations('onehr.talentList'),drawer=useTranslations('components.drawer'),below=useBelowLg(),[ownOpen,setOwnOpen]=useState(false),clicked=useRef(false),id=useId(),group=useContext(HistoryContext);
 const open=group?group.open===id:ownOpen,setOpen=(next:boolean)=>{if(group)group.setOpen(old=>next?id:old===id?null:old);else setOwnOpen(next);};
 const close=()=>{clicked.current=false;setOpen(false);},panel=useAnchoredPanel({open:open&&!below,onClose:close,flipHeight:240});
 useEffect(()=>{if(!active){clicked.current=false;setOpen(false);}},[active]);
 useEffect(()=>{if(!open)clicked.current=false;},[open]);
 const title=list('trailFor',{axis:tr(axis),name}),label=(tier:string)=>tier==='self'?tr('calibrationRoster.self'):tier==='manager'?tr('calibrationRoster.lineManager'):tier==='you'||tier==='reviewer'?t('you'):tier==='default'?t('default'):tr(`tiers.${tier}`);
 const word=(step:TalentTrailStep,index:number)=>{
  if(step.state==='wait')return t(step.tier==='hod'?'departmentWaiting':'unitWaiting');
  if(step.state==='none')return t(step.tier==='self'?'selfWaiting':step.tier==='manager'?axis==='performance'?'managerPerformanceWaiting':'managerPotentialWaiting':'none');
  if(step.tier==='self')return t('own');if(step.tier==='you')return t(step.state==='kept'?'youKept':'yourMove');
  if(['bg','group','final'].includes(step.tier))return t('decided');
  if(step.state==='moved'){const before=steps.slice(0,index).filter(s=>s.band).at(-1)?.band,order:readonly string[]=axis==='performance'?pmBands:potentialBands;if(before&&step.band&&order.includes(before)&&order.includes(step.band))return t(order.indexOf(step.band)>order.indexOf(before)?'higher':'lower');}
  return t(step.state);
 };
 const content=<><ol className="flex flex-wrap items-start gap-x-4 gap-y-3 py-3">{steps.map((step,index)=><li key={`${step.tier}.${index}`} className="relative flex min-w-16 max-w-32 flex-col items-center gap-1 text-center text-xs"><span className="font-medium">{label(step.tier)}</span><b translate="no" className={`min-w-9 rounded border px-2 py-1 ${step.tier==='you'?'border-primary bg-primary/10':'border-border bg-muted/30'}`}>{step.band??'—'}</b><span className="text-[11px] text-muted-foreground">{word(step,index)}</span>{index<steps.length-1&&<span aria-hidden className="absolute -right-3 top-7 text-muted-foreground">→</span>}</li>)}</ol><p className="border-t border-border pt-2 text-xs text-muted-foreground">{source==='default'?t('provisional',{band:current??'—'}):t('onBox',{band:current??'—',source:source?label(source):t('unknown')})}</p></>;
 const button=<button type="button" aria-label={title} aria-expanded={open} aria-describedby={!below&&open?id:undefined} onMouseEnter={event=>{if(!below){panel.anchorTo(event.currentTarget);setOpen(true);}}} onFocus={event=>{if(!below){panel.anchorTo(event.currentTarget);setOpen(true);}}} onMouseLeave={event=>{if(!below&&document.activeElement!==event.currentTarget)close();}} onBlur={()=>{if(!below)close();}} onClick={event=>{if(!below){panel.anchorTo(event.currentTarget);clicked.current=!clicked.current;setOpen(clicked.current);}}} className="flex min-h-11 min-w-11 items-center justify-center text-muted-foreground hover:text-primary"><History size={14}/></button>;
 if(below)return <Dialog.Root open={active&&open} onOpenChange={setOpen}><Dialog.Trigger asChild>{button}</Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/40"/><Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-40 max-h-[80dvh] w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 text-foreground shadow-xl"><Dialog.Title className="font-semibold">{title}</Dialog.Title>{content}<Dialog.Close asChild><button type="button" className="mt-3 min-h-11 text-sm text-primary">{drawer('close')}</button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
 return <>{button}{active&&open&&createPortal(<AnchoredPanel at={panel.at} role="tooltip" id={id} className="pointer-events-none"><p className="text-xs font-semibold">{title}</p>{content}</AnchoredPanel>,document.body)}</>;
}
