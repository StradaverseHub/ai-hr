'use client';
import Link from 'next/link';
import {contractDisplayState,type ContractCase} from '@/lib/contract-management-model';
import {usePathname} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {runContractCommand,type ContractCommand} from './actions';
export function ContractNavigation({configure=false,templates=false,intake=false}:{configure?:boolean;templates?:boolean;intake?:boolean}){
 const t=useTranslations('contractManagement'),path=usePathname();
 const links=[{href:'/lifecycle/contracts',label:'cases'},...(templates?[{href:'/lifecycle/contracts/templates',label:'templates'}]:[]),...(configure?[{href:'/lifecycle/contracts/settings',label:'settings'}]:[]),...(intake?[{href:'/lifecycle/contracts/intake',label:'intake'}]:[])];
 return <nav className="v9-tabs" aria-label={t('title')}>{links.map(item=><Link className={'v9-button'+(path===item.href?' v9-button-primary':'')} aria-current={path===item.href?'page':undefined} key={item.href} href={item.href}>{t(item.label)}</Link>)}</nav>;
}
export const contractMoney=(cents:string|null|undefined)=>cents==null?'—':new Intl.NumberFormat('en-MY',{style:'currency',currency:'MYR'}).format(Number(cents)/100);
export const contractDay=(day:string|null|undefined)=>day?day.slice(0,10).split('-').reverse().join('/'):'—';
export const dayDistance=(from:string,to:string)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000);
export function useContractCommand(){
 const t=useTranslations('contractManagement'),router=useRouter(),[pending,start]=useTransition(),[error,setError]=useState(''),[status,setStatus]=useState('');
 function run(command:ContractCommand,input:unknown,onDone?:(result:unknown)=>void){start(async()=>{setError('');setStatus('');try{const response=await runContractCommand(command,input);if(!response.ok){setError(['failed','session','invalid'].includes(response.error)?t(response.error):response.error);return;}onDone?.(response.result);if(!command.startsWith('preview')){setStatus(t('saved'));router.refresh();}}catch{setError(t('failed'));}});}
 return{pending,run,error,status,clear:()=>{setError('');setStatus('');},feedback:<>{error&&<p className="v9-error" role="alert">{error}</p>}{status&&<p role="status">{status}</p>}</>};
}

export function contractCaseStatus(record:ContractCase,today:string){return record.state==='handed_off'&&record.effects.manualHandoff?'manual_handoff':contractDisplayState(record,today);}

export function contractTimestamp(value:string){
 const normalized=value.replace(' ','T').replace(/(\.\d{3})\d+/,'$1').replace(/([+-]\d{2})$/,'$1:00');
 const date=new Date(normalized);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Kuala_Lumpur'}).format(date):'—';
}
