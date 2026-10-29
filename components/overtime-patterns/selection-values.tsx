'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Field,inputCls} from '@/components/ui';
import type {OvertimeSelectionField} from '@/lib/overtime-pattern-model';
import type {OvertimeChoice} from './rule-controls';
import {useOvertimeChoiceText} from './choice-label';
/** Filtering changes available choices, never silently removes selected canonical identities. */
export function OvertimeSelectionValues({field,options,selected,onChange}:{field:OvertimeSelectionField;options:OvertimeChoice[];selected:string[];onChange:(ids:string[])=>void}){
 const t=useTranslations('overtimePatterns'),text=useOvertimeChoiceText();
 const [query,setQuery]=useState('');
 const visible=options.filter(option=>selected.includes(option.id)||text(field,option).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 return <div className="space-y-2"><Field label={`${t('search')} · ${t(`fields.${field}`)}`}><input className={inputCls} type="search" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')event.preventDefault();}}/></Field><Field label={t('values')}><select multiple className={`${inputCls} min-h-28`} value={selected} onChange={event=>onChange(Array.from(event.target.selectedOptions,option=>option.value))}>{visible.map(option=><option key={option.id} value={option.id}>{text(field,option)}</option>)}{selected.filter(id=>!options.some(option=>option.id===id)).map(id=><option key={id} value={id}>{t('unavailableReference',{id})}</option>)}</select></Field></div>;
}
