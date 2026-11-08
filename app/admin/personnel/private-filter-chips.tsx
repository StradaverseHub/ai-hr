'use client';
import {useTranslations} from 'next-intl';
import {X} from 'lucide-react';
import {Button} from '@/components/ui';
import type {PersonnelPrivateCriteria} from '@/lib/personnel-list-controls';
import {PrivateCriteriaFields} from './private-filter-fields';
export function PersonnelPrivateFilterChips({criteria,parameters,labels,valueLabels={}}:{valueLabels?:Record<string,Record<string,string>>;criteria:PersonnelPrivateCriteria;parameters:[string,string][];labels:Record<string,string>}){
 const t=useTranslations('people.list.controls');
 const entries=[...(criteria.term?[{field:'term',value:criteria.term,operator:''}]:[]),...criteria.filters];
 return entries.length?<div className="flex flex-wrap gap-2" aria-label={t('privateActive')}>{entries.map(filter=><form key={filter.field} method="post" action="/admin/personnel/search" className="flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/40 py-1 pl-2 text-xs"><PrivateCriteriaFields criteria={criteria}/>{parameters.filter(([key])=>!['q','search','page'].includes(key)).map(([key,value])=><input key={key} type="hidden" name={key} value={value}/>)}<span className="max-w-96 break-words">{labels[filter.field]??filter.field}: {filter.operator&&t(filter.operator as 'contains')} {filter.operator==='blank'||filter.operator==='notBlank'?'':valueLabels[filter.field]?.[filter.value]??filter.value}</span><Button type="submit" guardNavigation={false} variant="ghost" size="sm" name="removeField" value={filter.field} aria-label={t('removeCriterion',{name:labels[filter.field]??filter.field})}><X className="h-3.5 w-3.5"/></Button></form>)}</div>:null;
}
