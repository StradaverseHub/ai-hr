'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {parsePayFormula,printPayFormula,type FormulaProgram} from '@/lib/pay-formula-language';
import {formulaCodeReview,convertReviewedFormulaCode,type FormulaCodeComparison} from '@/lib/pay-formula-code-conversion';
import type {PersonnelFormulaLibraryField} from '@/lib/pay-formula-personnel';
import {BusinessCodeChoices} from './business-code-choices';
import {formulaButton} from './ui-types';

function Conversion({comparison,field,disabled,apply}:{comparison:FormulaCodeComparison;field:PersonnelFormulaLibraryField;disabled:boolean;apply:(comparison:FormulaCodeComparison,value:string)=>void}){
 const t=useTranslations('payFormula.businessCodes'),[picked,setPicked]=useState(''),[reviewed,setReviewed]=useState(false);
 return <div className="space-y-3 rounded-lg border border-border p-3"><p className="break-all text-sm"><code>{comparison.field}</code> = <code>{JSON.stringify(comparison.value)}</code> → <code>{comparison.target}</code></p><BusinessCodeChoices sourceKey={field.key} initial={field.listValues} total={field.codeValuesTotal??field.listValues.length} disabled={disabled||!field.enabled} onChoose={value=>{setPicked(value);setReviewed(false);}}/>{picked&&<><p className="break-all text-sm">{t('selected',{code:picked})}</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={reviewed} disabled={disabled} onChange={event=>setReviewed(event.target.checked)}/>{t('reviewed')}</label><button type="button" className={formulaButton} disabled={disabled||!reviewed} onClick={()=>apply(comparison,picked)}>{t('apply')}</button></>}</div>;
}
export function FormulaCodeReview({source,fields,disabled,onChange}:{source:string;fields:PersonnelFormulaLibraryField[];disabled:boolean;onChange:(program:FormulaProgram)=>void}){
 const t=useTranslations('payFormula.businessCodes');let program:FormulaProgram;try{program=parsePayFormula(source);}catch{return null;}
 const review=formulaCodeReview(program);if(!review.references.length)return null;
 return <section className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"><h3 className="text-sm font-semibold">{t('reviewTitle')}</h3><p className="text-sm">{t('preserved')}</p><p className="break-all text-xs">{review.references.join(', ')}</p><p className="text-xs text-muted-foreground">{t('conversionHelp')}</p>{review.comparisons.map(comparison=>{const field=fields.find(field=>field.key===comparison.target);return field&&field.enabled?<Conversion key={printPayFormula(program)+':'+comparison.line+':'+comparison.column} comparison={comparison} field={field} disabled={disabled} apply={(item,value)=>onChange(convertReviewedFormulaCode(program,item,value))}/>:null;})}</section>;
}
