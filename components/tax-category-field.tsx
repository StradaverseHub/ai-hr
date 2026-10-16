 'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import {PersonnelField} from '@/components/personnel-field';
import {personnelControl,personnelCarry,personnelFormName,personnelFormLabel,personnelOwnedChoices} from '@/lib/personnel-form-contract';
import {clientPackFor} from '@/localization/registry.client';
export const TAX_CATEGORY_OPTIONS=personnelOwnedChoices('bank_statutory.income_tax_pcb.taxcircumstance','countryPack.taxCircumstanceOptions',clientPackFor('MY')!.payroll.taxCircumstanceOptions!);
type Common={notSetLabel?:string;className?:string;circumstance?:string|null};
export function TaxCategoryNoneOption(){
 const t=useTranslations('people.detail');
 return <option value="none">{t('taxCategoryNone')}</option>;
}
export function TaxCategoryField(props:
 |(Common&{mode:'form';defaultValue?:number|string|null;name?:string;onChange?:(value:string)=>void})
 |(Common&{mode:'controlled';value:string|undefined;onChange:(value:string)=>void})){
 const t=useTranslations('people.detail');
 const mode=props.mode==='controlled'?'draft':'edit';
 const fieldId='bank_statutory.income_tax_pcb.taxcircumstance';
 const label=personnelFormLabel(fieldId,(key,fallback)=>key.startsWith('people.detail.')?t(key.slice(14)):fallback);
 if(props.mode==='form')personnelFormName('bank_statutory.income_tax_pcb.taxcategory',props.name);
 const initial=props.circumstance??String(props.mode==='form'?props.defaultValue??1:props.value??'');
 const [selected,setSelected]=useState(initial);
 const value=props.mode==='controlled'?props.value??'':selected;
 const option=TAX_CATEGORY_OPTIONS.find(x=>x.value===value);
 const numeric=option?.category??(props.mode==='form'?Number(props.defaultValue??1):Number(value)||1);
 const change=(next:string)=>{setSelected(next);props.onChange?.(next)};
 return <PersonnelField fieldId={fieldId} mode={mode} className={props.className}>
  {props.mode==='form'&&<input {...personnelCarry('bank_statutory.income_tax_pcb.taxcategory')} value={numeric}/>}
  <select {...personnelControl(fieldId,mode)} value={value} onChange={e=>change(e.target.value)} className={inputCls} aria-label={label}>
   {props.mode==='controlled'&&<option value="">{props.notSetLabel??''}</option>}
   {!option&&value!==''&&<option value={value}>{t(numeric===3?'taxCategoryLegacy3':numeric===2?'taxCategoryMarriedSpouseNotWorking':'taxCategorySingle')}</option>}
   {TAX_CATEGORY_OPTIONS.map(o=><option key={o.value} value={o.value}>{t(o.key)}</option>)}
  </select>
  {value==='single'||value==='1'?<span className="text-xs text-muted-foreground">{t('taxCategorySingleHint')}</span>:null}
 </PersonnelField>
}
