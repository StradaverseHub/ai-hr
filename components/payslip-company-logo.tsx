'use client';
import {useState} from 'react';

/** A document mark preserves its aspect ratio; a missing/corrupt mark leaves the legal name intact. */
export function PayslipCompanyLogo({companyId,companyName}:{companyId:string;companyName:string}){
  const [failedCompanyId,setFailedCompanyId]=useState<string|null>(null);
  if(failedCompanyId===companyId)return null;
  // eslint-disable-next-line @next/next/no-img-element -- authenticated existing company-logo endpoint
  return <img src={`/admin/organization/logo/${companyId}`} alt={companyName}
    onError={()=>setFailedCompanyId(companyId)} className="max-h-14 w-auto max-w-24 shrink-0 object-contain"/>;
}
