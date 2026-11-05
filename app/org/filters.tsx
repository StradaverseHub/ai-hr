'use client';
import {useEffect,useState} from 'react';
import {useTranslations} from 'next-intl';
import type {OrgChartFilter} from '@/lib/org-chart-model';
type Option={companyId:string;company:string;businessUnitId:string|null;businessUnit:string|null;departmentId:string|null;department:string|null};
export function OrgChartFilters({filter,options,restore}: {filter:OrgChartFilter;options:Option[];restore:boolean}){
 const t=useTranslations('org');const [company,setCompany]=useState(filter.companyId??'');const [unit,setUnit]=useState(filter.businessUnitId??'');
 useEffect(()=>{if(restore){const saved=sessionStorage.getItem('org-chart-filters');if(saved)location.replace('/org?'+saved);}},[restore]);
 const companies=[...new Map(options.map(o=>[o.companyId,o.company])).entries()];
 const scoped=options.filter(o=>!company||o.companyId===company);const units=[...new Map(scoped.filter(o=>o.businessUnitId).map(o=>[o.businessUnitId!,o.businessUnit!])).entries()];
 const departments=[...new Map(scoped.filter(o=>o.departmentId&&(!unit||o.businessUnitId===unit)).map(o=>[o.departmentId!,o.department!])).entries()];
 const select='mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm';
 return <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={e=>sessionStorage.setItem('org-chart-filters',new URLSearchParams(new FormData(e.currentTarget) as never).toString())}>
  <label className="text-xs">{t('filters.company')}<select name="companyId" value={company} className={select} onChange={e=>{setCompany(e.target.value);setUnit('');}}><option value="">{t('filters.all')}</option>{companies.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
  <label className="text-xs">{t('filters.businessUnit')}<select name="businessUnitId" value={unit} className={select} onChange={e=>setUnit(e.target.value)}><option value="">{t('filters.all')}</option>{units.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
  <label className="text-xs">{t('filters.department')}<select key={`${company}:${unit}`} name="departmentId" defaultValue={filter.departmentId??''} className={select}><option value="">{t('filters.all')}</option>{departments.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
  <label className="text-xs">{t('filters.employmentType')}<select name="employmentType" defaultValue={filter.employmentType??''} className={select}><option value="">{t('filters.all')}</option>{['full_time','part_time','contract','intern'].map(type=><option key={type} value={type}>{t(`types.${type}`)}</option>)}</select></label>
  <label className="text-xs">{t('filters.status')}<select name="status" defaultValue={filter.status??'all'} className={select}>{['all','active','probation','notice'].map(status=><option key={status} value={status}>{t(`statuses.${status}`)}</option>)}</select></label>
  <label className="text-xs">{t('filters.asOf')}<input type="date" name="asOf" defaultValue={filter.asOf} className={select} required/></label>
  <div className="flex items-end gap-2"><button className="h-9 rounded-lg bg-primary px-4 text-sm text-primary-foreground">{t('filters.apply')}</button><a href="/org?reset=1" onClick={()=>sessionStorage.removeItem('org-chart-filters')} className="rounded-lg border px-4 py-2 text-sm">{t('filters.reset')}</a></div>
 </form>;
}
