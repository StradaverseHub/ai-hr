'use client';
import {useEffect,useState} from 'react';
import {useTranslations} from 'next-intl';
import Link from 'next/link';
import {checkRegistrationReadiness} from './registration-warning-action';
export function CompanyRegistrationWarning({companyIds,payPeriod,employmentIds,payrollCycleId}:{companyIds:string[];payPeriod:string;employmentIds?:string[];payrollCycleId?:string}){
 const t=useTranslations('payroll.process'),[result,setResult]=useState<{employees:number;companies:number;href:string}|null>(null),[failed,setFailed]=useState(false);
 const key=JSON.stringify([[...companyIds].sort(),payPeriod,employmentIds?[...employmentIds].sort():null,payrollCycleId]);
 useEffect(()=>{let live=true;setResult(null);setFailed(false);checkRegistrationReadiness({companyIds,payPeriod,...(employmentIds?{employmentIds}:{}),...(payrollCycleId?{payrollCycleId}:{})}).then(r=>{if(live)setResult(r);}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;};},[key]);
 if(failed)return <p role="alert" className="rounded-md border border-border p-3 text-sm">{t('registrationCheckFailed')}</p>;
 if(!result?.employees)return null;
 return <div role="status" className="rounded-md border border-border p-3 text-sm"><p>{t('registrationWarning',{count:result.employees})}</p><Link href={result.href} className="mt-1 inline-block text-primary underline underline-offset-2">{t('registrationOpenCompanies')}</Link></div>;
}
