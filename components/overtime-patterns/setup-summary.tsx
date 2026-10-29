'use client';
import {useTranslations} from 'next-intl';
import type {OvertimeCondition,OvertimeExpression,OvertimePattern} from '@/lib/overtime-pattern-model';
import {overtimeEligibilityContradiction,overtimeMinutesToClock} from '@/lib/overtime-pattern-guided';
import {useOvertimeChoiceText} from './choice-label';
import type {OvertimeChoices} from './rule-controls';

/** A description only: no input, decision, calculation or editable control lives in Preview. */
export function OvertimeSetupSummary({name,code,description,pattern,choices,onEdit}:{name:string;code:string;description:string;pattern:OvertimePattern;choices:OvertimeChoices;onEdit:(step:'basic'|'rates'|'eligibility')=>void}) {
 const t=useTranslations('overtimePatterns'),choiceText=useOvertimeChoiceText();
 const expression=(value:OvertimeExpression):string=>{
  if(value.type==='literal')return value.value||t('notConfigured');
  if(value.type==='field')return t(`fields.${value.field}`);
  if(value.type==='ref')return t('definition');
  return t(`operations.${value.type}`);
 };
 const condition=(value:OvertimeCondition):string=>{
  if(value.type==='constant')return t(value.value?'always':'never');
  if(value.type==='group')return value.children.length?value.children.map(child=>`(${condition(child)})`).join(` ${t(value.logic==='and'?'guided.and':'guided.or')} `):t('always');
  if(value.type==='selection')return `${t(`fields.${value.field}`)} ${t(`operators.${value.operator}`)} ${value.values.map(id=>{const found=choices[value.field]?.find(item=>item.id===id);return found?choiceText(value.field,found):t('unavailableReference',{id});}).join(', ')||t('notConfigured')}`;
  if(value.type==='null')return `${t(`fields.${value.field}`)} ${t(value.isNull?'isMissing':'isPresent')}`;
  if(value.type==='compare')return `${expression(value.left)} ${t(`operators.${value.operator}`)} ${expression(value.right)}${value.upper?' – '+expression(value.upper):''}`;
  return `${t(value.boundary==='start'?'recordedWorkStart':'recordedWorkEnd')} ${t(`clockOperators.${value.operator}`)} ${Math.floor(value.value.minute/60)}:${String(value.value.minute%60).padStart(2,'0')}`;
 };
 return <div className="space-y-6">
  <section><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{t('guided.general')}</h2><button type="button" className="text-sm text-primary underline underline-offset-4" onClick={()=>onEdit('basic')}>{t('guided.editGeneral')}</button></div><dl className="mt-3 grid gap-4 text-sm sm:grid-cols-3">{[[t('guided.patternName'),name],[t('guided.patternLabel'),code],[t('currency'),pattern.currency.code]].map(([label,value])=><div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-medium">{value||t('notConfigured')}</dd></div>)}</dl>{description?<p className="mt-3 text-sm text-muted-foreground">{description}</p>:null}</section>
  <section><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{t('guided.rates')}</h2><button type="button" className="text-sm text-primary underline underline-offset-4" onClick={()=>onEdit('rates')}>{t('guided.editRates')}</button></div><div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr>{['fromClock','toClock','method','rateValue','rounding','roundInterval'].map(key=><th key={key} className="p-2">{t(`guided.${key}`)}</th>)}</tr></thead><tbody className="divide-y divide-border">{pattern.rates.flatMap(rate=>rate.tiers.map(tier=><tr key={tier.id}><td className="p-2 tabular-nums">{overtimeMinutesToClock(tier.from)}</td><td className="p-2 tabular-nums">{tier.to===null?t('unbounded'):overtimeMinutesToClock(tier.to)}</td><td className="p-2">{t(`methods.${tier.payment.method}`)}</td><td className="p-2">{tier.payment.method==='hourly'?expression(tier.payment.multiplier)+' × '+expression(tier.payment.rate):expression(tier.payment.amount)}</td><td className="p-2">{tier.rounding?t(`rounding.${tier.rounding.mode}`):pattern.durationRounding?t(`rounding.${pattern.durationRounding.mode}`):t('guided.noRounding')}</td><td className="p-2 tabular-nums">{overtimeMinutesToClock(tier.rounding?.step??pattern.durationRounding?.step??null)||'—'}</td></tr>))}</tbody></table></div></section>
  <section><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{t('guided.eligibility')}</h2><button type="button" className="text-sm text-primary underline underline-offset-4" onClick={()=>onEdit('eligibility')}>{t('guided.editEligibility')}</button></div><p className="mt-3 max-w-3xl text-sm">{condition(pattern.eligibility)}</p>{overtimeEligibilityContradiction(pattern.eligibility)?<p role="status" className="mt-3 rounded-lg border border-border p-3 text-sm">{t('guided.contradiction')}</p>:null}<p className="mt-2 text-xs text-muted-foreground">{t('guided.salaryDateHelp')}</p></section>
 </div>;
}
