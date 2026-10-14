'use client';
import {CalibrationFit} from './calibration-fit';
import { useTranslations } from 'next-intl';
import * as Dialog from '@radix-ui/react-dialog';
import { ChartNoAxesCombined } from 'lucide-react';
import type { calibrationDistribution,profitCurveFor } from '@/packs/performance/onehr/calibration-curve-model';
import { profitAchievementText } from '@/packs/performance/onehr/calibration-curve-model';
type Distribution=ReturnType<typeof calibrationDistribution>;
type Profit=ReturnType<typeof profitCurveFor>;
/** Read-only axis spread for the selected unit. Its population is independent of List filters. */
export function CalibrationCurveDialog({axis,unit,distribution,profit,vertical=false,fit}:{fit?:{sessionId:string;companyId:string;disabled:boolean};axis:'performance'|'potential';unit:string;distribution:Distribution;profit?:Profit;vertical?:boolean}){
 const t=useTranslations('onehr.talentCurve'),common=useTranslations('onehr'),drawer=useTranslations('components.drawer'),title=t('title',{axis:common(axis),unit});
 return <Dialog.Root><Dialog.Trigger asChild><button type="button" aria-label={t('show',{axis:common(axis)})} className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded text-xs font-medium text-muted-foreground hover:bg-muted hover:text-primary ${vertical?'[writing-mode:vertical-rl] rotate-180 px-1':'px-3'}`}><ChartNoAxesCombined size={14} aria-hidden/>{common(axis)}<span aria-hidden>→</span></button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/40"/><Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-40 max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 text-foreground shadow-xl">
  <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
  <p className="mt-2 text-sm text-muted-foreground">{t('people',{count:distribution.total})}{axis==='performance'&&profit&&<> · {t(`curves.${profit.key}`)} · {profit.entered?t(profit.source==='bg'?'groupFigure':'figure',{value:profitAchievementText(profit.achievementPct)}):t('unentered')}</>}</p>
  <p className="mt-2 text-xs text-muted-foreground">{t('help')}</p>
  <div className="mt-5 space-y-4" aria-hidden>{distribution.rows.map(row=><div key={row.band} className="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-3"><b translate="no" className="text-xs">{row.band}</b><div className="relative h-5 rounded bg-muted"><div style={{width:`${row.actualPct}%`}} className="h-full rounded bg-primary/70"/>{row.targetPct!=null&&<span style={{left:`${row.targetPct}%`}} className="absolute -top-1 h-7 border-l-2 border-foreground"/>}</div><span className="text-right text-xs tabular-nums">{row.actualPct}%</span></div>)}</div>
  <div className="mt-5 overflow-x-auto"><table className="w-full text-right text-xs tabular-nums"><caption className="sr-only">{title}</caption><thead><tr><th scope="col" className="py-2 text-left">{t('band')}</th>{['actual','expected','gap'].map(key=><th key={key} scope="col" className="px-2 py-2">{t(key)}</th>)}</tr></thead><tbody>{distribution.rows.map(row=><tr key={row.band} className="border-t border-border"><th scope="row" translate="no" className="py-2 text-left">{row.band}</th><td className="px-2 py-2">{row.count} · {row.actualPct}%</td><td className="px-2 py-2">{row.targetCount==null?'—':`${row.targetCount} · ${row.targetPct}%`}</td><td className={`px-2 py-2 ${row.breach?'font-semibold text-amber-700 dark:text-amber-400':''}`}>{row.gap==null?'—':`${row.gap>0?'+':''}${row.gap}`}{row.breach&&<span className="sr-only"> · {t('outside')}</span>}</td></tr>)}</tbody></table></div>
  <p className="mt-3 text-xs text-muted-foreground">{t('tolerance',{count:distribution.tolerance})} · {t('gapHelp')}</p>{!distribution.total&&<p className="mt-3 text-sm text-muted-foreground">{t('empty')}</p>}
  {fit&&<div className="mt-4"><CalibrationFit {...fit} axis={axis}/></div>}
  <Dialog.Close asChild><button type="button" className="mt-4 min-h-11 rounded px-3 text-sm font-medium text-primary hover:bg-muted">{drawer('close')}</button></Dialog.Close>
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
