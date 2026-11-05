'use client';
import {useEffect,useState} from 'react';
import {useTranslations} from 'next-intl';
import {derivedOrganisationAction} from '@/app/admin/personnel/derived-organisation-actions';
import type {DerivedOrganisationDisplay} from '@/core/derived-organisation-display';
export function useDerivedOrganisation(input:{companyId?:string;employmentId?:string;asOf?:string}){
 const key=JSON.stringify([input.companyId,input.employmentId,input.asOf]);
 const [result,setResult]=useState<{key:string;data?:DerivedOrganisationDisplay;failed?:boolean}|null>(null);
 useEffect(()=>{let active=true;if(!input.companyId&&!input.employmentId)return;void derivedOrganisationAction(input).then(data=>{if(active)setResult({key,data});}).catch(()=>{if(active)setResult({key,failed:true});});return()=>{active=false;};},[key,input.companyId,input.employmentId,input.asOf]);
 return {data:result?.key===key?result.data:undefined,failed:result?.key===key&&result.failed,loading:result?.key!==key};
}
export function DerivedOrganisationFields({state}:{state:ReturnType<typeof useDerivedOrganisation>}){
 const t=useTranslations('derivedOrganisation'),data=state.data;
 if(state.failed)return <p role="alert" className="col-span-full text-sm text-destructive">{t('unavailable')}</p>;
 if(!data)return <p role="status" className="col-span-full text-sm text-muted-foreground">{t('loading')}</p>;
 if(data.status==='legacy'&&!data.managed)return <p className="col-span-full text-sm text-muted-foreground">{t('preparation')}</p>;
 const values=[[t('businessUnit'),data.businessUnitName??data.businessUnitId??t(data.status==='pending'?'pending':'missingBusinessUnit')],[t('parentCompany'),data.parentCompanyName??data.parentCompanyId??t(data.status==='ready'?'topLevel':'pending')],[t('businessGroup'),data.businessGroupName??data.businessGroupId??t('pending')]];
 return <section aria-label={t('title')} className="col-span-full min-w-0 rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{t('derived')}</p><dl className="mt-2 grid gap-3 sm:grid-cols-3">{values.map(([label,value])=><div className="min-w-0" key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words text-sm">{value}</dd></div>)}</dl><p className="mt-2 break-all text-xs text-muted-foreground">{t('reference',{date:data.asOf,version:data.mappingVersionId??t('pending')})}</p>{data.status==='legacy'&&data.managed&&<p className="mt-2 text-sm text-muted-foreground">{t('historical')}</p>}{data.status==='pending'&&<p role="status" className="mt-2 text-sm text-amber-700 dark:text-amber-300">{t('groupingHint')}</p>}</section>;
}
/** Server pages can carry their legacy control as children without moving its form owner. */
export function DerivedOrganisationControl({companyId,employmentId,asOf,children}:{companyId?:string;employmentId?:string;asOf?:string;children?:React.ReactNode}){
 const state=useDerivedOrganisation({companyId,employmentId,asOf});
 return <><DerivedOrganisationFields state={state}/>{state.data?.status==='legacy'&&!state.data.managed?children:null}</>;
}
