'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Field,inputCls} from '@/components/ui';
/** Submit only one salary representation so switching to a percentage cannot keep a hidden salary. */
export function SeniorAwardFields({newBasicCents}:{newBasicCents:number|null}){
 const t=useTranslations('rewards.governance');
 const [mode,setMode]=useState<'salary'|'percent'>(newBasicCents===null?'percent':'salary');
 return <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">{t('chooseAmountInput')}</legend><div className="flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="radio" name="salaryInputMode" checked={mode==='percent'} onChange={()=>setMode('percent')}/>{t('increment')}</label><label className="flex items-center gap-2"><input type="radio" name="salaryInputMode" checked={mode==='salary'} onChange={()=>setMode('salary')}/>{t('newBasic')}</label></div>{mode==='percent'?<Field key="percent" label={t('increment')}><input type="number" name="increment" required min="0" max="1000" step="0.01" className={inputCls}/></Field>:<Field key="salary" label={t('newBasic')}><input type="number" name="newBasic" required min="0" step="0.01" defaultValue={newBasicCents===null?'':newBasicCents/100} className={inputCls}/></Field>}</fieldset>;
}
