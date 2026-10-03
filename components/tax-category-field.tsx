 'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Field,inputCls} from '@/components/ui';
import {clientPackFor} from '@/localization/registry.client';
export const TAX_CATEGORY_OPTIONS=clientPackFor('MY')!.payroll.taxCircumstanceOptions!;
type Common={notSetLabel?:string;className?:string;circumstance?:string|null};
export function TaxCategoryNoneOption(){
 const t=useTranslations('people.detail');
 return <option value="none">{t('taxCategoryNone')}</option>;
}
export function TaxCategoryField(props:
 |(Common&{mode:'form';defaultValue?:number|string|null;name?:string;onChange?:(value:string)=>void})
 |(Common&{mode:'controlled';value:string|undefined;onChange:(value:string)=>void})){
 const t=useTranslations('people.detail');
 const initial=props.circumstance??String(props.mode==='form'?props.defaultValue??1:props.value??'');
 const [selected,setSelected]=useState(initial);
 const value=props.mode==='controlled'?props.value??'':selected;
 const option=TAX_CATEGORY_OPTIONS.find(x=>x.value===value);
 const numeric=option?.category??(props.mode==='form'?Number(props.defaultValue??1):Number(value)||1);
 const change=(next:string)=>{setSelected(next);props.onChange?.(next)};
 return <Field label={t('taxCategoryLabel')} className={props.className}>
  {props.mode==='form'&&<input type="hidden" name={props.name??'taxCategory'} value={numeric}/>}
  <select name={props.mode==='form'?'taxCircumstance':undefined} value={value} onChange={e=>change(e.target.value)} className={inputCls} aria-label={t('taxCategoryLabel')}>
   {props.mode==='controlled'&&<option value="">{props.notSetLabel??''}</option>}
   {!option&&value!==''&&<option value={value}>{t(numeric===3?'taxCategoryLegacy3':numeric===2?'taxCategoryMarriedSpouseNotWorking':'taxCategorySingle')}</option>}
   {TAX_CATEGORY_OPTIONS.map(o=><option key={o.value} value={o.value}>{t(o.key)}</option>)}
  </select>
  {value==='single'||value==='1'?<span className="text-xs text-muted-foreground">{t('taxCategorySingleHint')}</span>:null}
 </Field>
}
