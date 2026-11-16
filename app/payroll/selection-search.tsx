'use client';
import {useEffect,useState,useTransition} from 'react';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
import {useTranslations} from 'next-intl';

/** Search is navigation, never a financial form submit. One explicit request searches the complete native population. */
export function PayrollSelectionSearch({query,placeholder}:{query:string;placeholder:string}){
 const [value,setValue]=useState(query),[pending,startTransition]=useTransition();
 const router=useRouter(),pathname=usePathname(),params=useSearchParams(),t=useTranslations('common');
 useEffect(()=>setValue(query),[query]);
 const search=()=>{const next=new URLSearchParams(params.toString());
  if(value.trim())next.set('q',value.trim());else next.delete('q');
  next.delete('page');next.delete('newPage');
  startTransition(()=>router.replace(pathname+(next.size?'?'+next.toString():''),{scroll:false}));
 };
 return <div className="flex flex-wrap items-center gap-2" aria-busy={pending}>
  <input type="search" value={value} onChange={e=>setValue(e.target.value)} aria-label={placeholder} placeholder={placeholder}
   onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();search();}}}
   className="w-full max-w-xs rounded-lg border border-border bg-background px-3 py-1.5 text-sm"/>
  <button type="button" onClick={search} disabled={pending} className="rounded-lg border border-border px-3 py-1.5 text-sm">{pending?t('loading'):t('search')}</button>
 </div>;
}
