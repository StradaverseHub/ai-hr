'use client';
import {useNricPolicyMessage} from '@/components/nric-policy-message';
import {useTranslations} from 'next-intl';
import {toCsv} from '@/lib/csv';
import type {ImportRunError} from '@/lib/import-schema';
/** The rows that were not saved, as a CSV to correct and upload again (the same report the import box offered,
 * with the same formula-injection guard in toCsv). Generated in the browser from data the page already has. */
export function RunErrorsDownload({errors,columns=[]}:{errors:ImportRunError[];columns?:string[][]}){
 const t=useTranslations('people.import'),h=useTranslations('people.importHistory.errorReport'),nricMessage=useNricPolicyMessage();
 const download=()=>{
  // 1859cce0 — with the Employee ID and, per reason, the column to correct where the run recorded it.
  const csv=toCsv([[t('colRow'),h('colCode'),t('colName'),t('colEmail'),t('colResult')],...errors.map((e,i)=>[e.rowNum,e.employeeCode??'',e.fullName,e.email,
   e.errors.map((message,j)=>columns[i]?.[j]?`${columns[i][j]}: ${nricMessage(message)}`:nricMessage(message)).join('; ')])]);
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));const a=document.createElement('a');a.href=url;a.download='employee-import-errors.csv';a.click();URL.revokeObjectURL(url);
 };
 return <button type="button" onClick={download} className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-sm font-medium transition-colors hover:bg-muted active:scale-[.98]">{t('downloadErrors')}</button>;
}
/** Reasons rendered through the same NRIC policy wording as the download. */
export function RunErrorReasons({errors,columns=[],cancelled=false}:{errors:string[];columns?:string[];cancelled?:boolean}){
 const nricMessage=useNricPolicyMessage();
 return <ul className={`space-y-1 ${cancelled?'text-muted-foreground':'text-destructive'}`}>{errors.map((error,index)=><li key={index}>{columns[index]?<span className="font-medium">{columns[index]}: </span>:null}{nricMessage(error)}</li>)}</ul>;
}
