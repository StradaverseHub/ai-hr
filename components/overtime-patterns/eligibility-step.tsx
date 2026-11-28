'use client';

import {useState,useTransition} from 'react';
import {useLocale,useTranslations} from 'next-intl';
import {Field,inputCls} from '@/components/ui';
import {OVERTIME_ELIGIBILITY_FIELDS,OVERTIME_ELIGIBILITY_GROUPS,type OvertimeEligibilityField,type OvertimePlannedEligibility} from '@/lib/overtime-pattern-eligibility';
import type {OvertimePatternSetup} from '@/packs/attendance/service';
import {overtimeChoicesAction} from '@/app/admin/attendance/settings/overtime-patterns/actions';
import {MultiSelect,type MultiSelectOption} from './multi-select';
import {useOvertimeChoiceText} from './choice-label';

export type OvertimeEmployeeOption={id:string;label:string};

/** Board 4197534a — the plain-language summary of an Eligibility ("OT001 applies to employees of A, B and C whose Job
 * Grade is Executive or Non-Executive and whose Employment Type is Permanent, from 1 Dec 2026"). */
export function useEligibilitySummary(){
  const t=useTranslations('overtimePatterns.eligibilityStep'),tf=useTranslations('overtimePatterns.fields'),locale=useLocale();
  return (p:{code:string;companyNames:string[];planned:OvertimePlannedEligibility;label:(field:OvertimeEligibilityField,id:string)=>string;employees:number})=>{
    const and=new Intl.ListFormat(locale,{type:'conjunction'}),or=new Intl.ListFormat(locale,{type:'disjunction'});
    const companies=p.companyNames.length>3?t('companiesAndMore',{names:p.companyNames.slice(0,3).join(', '),count:p.companyNames.length-3}):and.format(p.companyNames);
    const conditions=OVERTIME_ELIGIBILITY_FIELDS.filter(field=>p.planned.criteria[field]?.length).map(field=>t('conditionPart',{field:tf(field),values:or.format(p.planned.criteria[field]!.map(id=>p.label(field,id)))}));
    const from=p.planned.from?new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(p.planned.from+'T00:00:00Z')):t('noDate');
    return t('summary',{code:p.code||t('thisPattern'),companies:companies||t('noCompanies'),conditions:conditions.length?and.format(conditions):'',hasConditions:conditions.length?'yes':'no',from,employees:p.employees});
  };
}

/** Companies (searchable, "select all my companies", one currency), criteria in two groups, optional named employees,
 * Applies from and priority. Any chosen value within one field matches; every filled field must match. */
export function OvertimeEligibilityStep({setup,companyIds,onCompanies,planned,onPlanned,employeeOptions,onEmployeeOptions,code,disabled}:{setup:OvertimePatternSetup;companyIds:string[];onCompanies:(ids:string[])=>void;planned:OvertimePlannedEligibility;onPlanned:(next:OvertimePlannedEligibility)=>void;employeeOptions:OvertimeEmployeeOption[];onEmployeeOptions:(rows:OvertimeEmployeeOption[])=>void;code:string;disabled:boolean}) {
  const t=useTranslations('overtimePatterns.eligibilityStep'),tf=useTranslations('overtimePatterns.fields'),choiceText=useOvertimeChoiceText();
  const summary=useEligibilitySummary();
  const [pending,startTransition]=useTransition();
  const [searchFailed,setSearchFailed]=useState(false);
  const currency=setup.companies.find(company=>company.id===companyIds[0])?.currency;
  // Once a company is chosen, only companies paying in the same currency are offered (one pattern, one currency).
  const companyOptions:MultiSelectOption[]=setup.companies.filter(company=>!currency||company.currency===currency||companyIds.includes(company.id)).map(company=>({id:company.id,label:company.name}));
  const labels={search:t('search'),any:t('any'),remove:(label:string)=>t('remove',{label}),more:(count:number)=>t('more',{count}),noMatches:t('noMatches')};
  const options=(field:OvertimeEligibilityField):MultiSelectOption[]=>(setup.choices[field]??[]).map(option=>({id:option.id,label:choiceText(field,option)}));
  const label=(field:OvertimeEligibilityField,id:string)=>options(field).find(option=>option.id===id)?.label??id;
  const setCriteria=(field:OvertimeEligibilityField,values:string[])=>{const criteria={...planned.criteria};if(values.length)criteria[field]=values;else delete criteria[field];onPlanned({...planned,criteria});};
  const searchEmployees=(text:string)=>startTransition(async()=>{
    const result=await overtimeChoicesAction({employeeSearch:text,companyIds});
    if(!result.ok){setSearchFailed(true);return;}
    setSearchFailed(false);
    const chosen=employeeOptions.filter(option=>planned.employmentIds.includes(option.id));
    onEmployeeOptions([...new Map([...chosen,...result.value.employees.map(row=>({id:row.id,label:[row.employeeCode,row.name].filter(Boolean).join(' · ')}))].map(row=>[row.id,row])).values()]);
  });
  const sameCurrency=setup.companies.filter(company=>!currency||company.currency===currency);
  return <div className="space-y-5">
    <div className="space-y-1.5">
      <MultiSelect label={t('companies')} options={companyOptions} value={companyIds} onChange={onCompanies} labels={labels} disabled={disabled}/>
      <p className="text-xs text-muted-foreground">{t('companiesHelp')} {!disabled?<button type="button" className="underline" onClick={()=>onCompanies([...new Set([...companyIds,...sameCurrency.map(company=>company.id)])])}>{t('selectAll')}</button>:null}</p>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      {(Object.keys(OVERTIME_ELIGIBILITY_GROUPS) as (keyof typeof OVERTIME_ELIGIBILITY_GROUPS)[]).map(group=><fieldset key={group} className="space-y-3 rounded-xl border border-border p-4">
        <legend className="px-1 font-semibold">{t(`groups.${group}`)}</legend>
        <div className="grid gap-3 sm:grid-cols-2">{OVERTIME_ELIGIBILITY_GROUPS[group].map(field=><MultiSelect key={field} label={tf(field)} options={options(field)} value={planned.criteria[field]??[]} onChange={values=>setCriteria(field,values)} labels={labels} disabled={disabled} chipLimit={4}/>)}</div>
      </fieldset>)}
    </div>
    <div className="grid gap-4 md:grid-cols-3">
      <div><MultiSelect label={t('namedEmployees')} options={employeeOptions} value={planned.employmentIds} onChange={ids=>onPlanned({...planned,employmentIds:ids})} labels={{...labels,search:t('searchEmployees')}} disabled={disabled||!companyIds.length} onSearch={text=>{if(text.trim().length>=2)searchEmployees(text);}}/>{pending?<p className="text-xs text-muted-foreground" role="status">{t('searching')}</p>:null}{searchFailed?<p className="text-xs text-destructive" role="alert">{t('searchFailed')}</p>:null}</div>
      <Field label={t('appliesFrom')}><input type="date" className={inputCls} value={planned.from??''} disabled={disabled} onChange={event=>onPlanned({...planned,from:event.target.value||null})}/></Field>
      <div><Field label={t('priority')}><input type="number" min={0} max={9999} step={1} className={inputCls} value={Number.isFinite(planned.priority)?planned.priority:''} disabled={disabled} onChange={event=>onPlanned({...planned,priority:event.target.value===''?Number.NaN:Number(event.target.value)})}/></Field><p className="mt-1 text-xs text-muted-foreground">{t('priorityHelp')}</p></div>
    </div>
    <p className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm" aria-live="polite"><span className="font-semibold">{t('summaryLabel')}</span> {summary({code,companyNames:companyIds.map(id=>setup.companies.find(company=>company.id===id)?.name??id),planned,label:(field,id)=>label(field,id),employees:planned.employmentIds.length})}</p>
  </div>;
}
