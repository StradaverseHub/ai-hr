"use client";
import {useState,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {competencyBand} from '@/packs/performance/onehr/competency-band';
import type {Statement,Policy} from '@/packs/performance/onehr/model';
export function CompetencyBandPreview({statements,selfAnswers,initialAnswers,policy,hasFramework,children}:{statements:Statement[];selfAnswers:Record<string,'yes'|'no'|''>;initialAnswers:Record<string,'yes'|'no'|''>;policy:Pick<Policy,'lowMaxPct'|'midMaxPct'>;hasFramework:boolean;children:ReactNode}){
 const t=useTranslations('onehr'),[answers,setAnswers]=useState(initialAnswers);
 const self=competencyBand(statements,selfAnswers,policy,hasFramework),review=competencyBand(statements,answers,policy,hasFramework);
 return <div className="space-y-4" onChange={event=>{const field=event.target;if(!(field instanceof HTMLSelectElement)||!field.name.startsWith('answer.'))return;const id=field.name.slice(7);if(!statements.some(s=>s.id===id)||!['yes','no',''].includes(field.value))return;const value=field.value as 'yes'|'no'|'';setAnswers(previous=>({...previous,[id]:value}));}}>
  <div className="rounded-lg border border-border p-4"><div className="grid gap-3 sm:grid-cols-2" aria-live="polite"><p className="text-sm">{t('competencyBand.self')}: <b>{self?t(`grid${self}`):'—'}</b></p><p className="text-sm">{t('competencyBand.manager')}: <b>{review?t(`grid${review}`):'—'}</b></p></div><p className="mt-2 text-xs text-muted-foreground">{t('competencyBand.help')}</p></div>
  {children}
 </div>;
}
