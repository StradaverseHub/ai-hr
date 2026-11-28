'use client';
/** Board 0735d1b7 — the By Batch Send Invitation selection, settings and confirmation. The ticks are only the
 * administrator's choice: the server resolves who is invited (core/account-invitation-batch.ts startInvitationBatch),
 * and "Select all" sends no ids at all, only the search, so it always means everyone eligible at that moment. */
import {useMemo,useState} from 'react';
import {useTranslations} from 'next-intl';
import {ActionNavigateForm} from '@/components/action-navigate-form';
import {ActionButton} from '@/components/ui/action-button';
import {btnGhost,btnPrimary,inputCls,tableWrapCls,tbodyCls,theadCls,thCls} from '@/components/ui';
import type {BatchCandidate} from '@/core/account-invitation-batch';
import {startInvitationBatchAction} from './actions';

type Option={value:string;label:string};
export function BatchInviteForm({rows,eligibleCount,eligibleCapped,search,operationKey,roles,companies,languages,defaultLanguage}:{
 rows:BatchCandidate[];eligibleCount:number;eligibleCapped:boolean;search:string;operationKey:string;
 roles:Option[];companies:Option[];languages:Option[];defaultLanguage:string;
}){
 const t=useTranslations('admin.users.batchInvite');
 const [picked,setPicked]=useState<string[]>([]),[all,setAll]=useState(false),[review,setReview]=useState(false);
 const [role,setRole]=useState('employee'),[company,setCompany]=useState('group'),[language,setLanguage]=useState(defaultLanguage);
 const selectable=useMemo(()=>rows.filter(r=>!r.ineligible).map(r=>r.id),[rows]);
 const count=all?eligibleCount:picked.length;
 const pageAll=selectable.length>0&&selectable.every(id=>picked.includes(id));
 const label=(options:Option[],value:string)=>options.find(o=>o.value===value)?.label??value;
 const toggle=(id:string)=>{setAll(false);setReview(false);setPicked(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);};
 return <ActionNavigateForm action={startInvitationBatchAction} className="space-y-4">
  <input type="hidden" name="operationKey" value={operationKey}/>
  <input type="hidden" name="selection" value={all?'all':'ids'}/>
  <input type="hidden" name="search" value={search}/>
  <input type="hidden" name="expectedCount" value={count}/>
  {!all&&picked.map(id=><input key={id} type="hidden" name="personIds" value={id}/>)}
  <div className="flex flex-wrap items-center gap-4 text-sm">
   <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={all} disabled={eligibleCount===0||eligibleCapped}
    onChange={e=>{setAll(e.target.checked);setReview(false);if(e.target.checked)setPicked([]);}}/>{t('selectAll',{count:eligibleCount})}</label>
   <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={!all&&pageAll} disabled={all||selectable.length===0}
    onChange={e=>{setReview(false);setPicked(prev=>e.target.checked?[...new Set([...prev,...selectable])]:prev.filter(id=>!selectable.includes(id)));}}/>{t('selectPage')}</label>
   <span role="status" className="text-muted-foreground">{t('selectedCount',{count})}</span>
  </div>
  {eligibleCapped&&<p className="text-sm text-amber-800 dark:text-amber-300">{t('eligibleCapped',{count:eligibleCount})}</p>}
  <div className={tableWrapCls}><table className="w-full min-w-[640px] text-left text-sm">
   <thead className={theadCls}><tr><th scope="col" className={`${thCls} w-12`}><span className="sr-only">{t('colSelect')}</span></th>
    <th scope="col" className={thCls}>{t('colName')}</th><th scope="col" className={thCls}>{t('colEmployeeId')}</th>
    <th scope="col" className={thCls}>{t('colEmail')}</th><th scope="col" className={thCls}>{t('colStatus')}</th></tr></thead>
   <tbody className={tbodyCls}>{rows.map(r=><tr key={r.id}>
    <td className="px-3 py-2"><input type="checkbox" aria-label={t('selectPerson',{name:r.name})} disabled={all||!!r.ineligible}
     checked={all?!r.ineligible:picked.includes(r.id)} onChange={()=>toggle(r.id)} className="size-4"/></td>
    <td className="px-3 py-2 font-medium">{r.name}</td>
    <td className="px-3 py-2 tabular-nums">{r.employeeCode??'—'}</td>
    <td className="break-all px-3 py-2">{r.email||'—'}</td>
    <td className="px-3 py-2">{r.ineligible?<span className="text-muted-foreground">{t(`ineligible.${r.ineligible}`)}</span>:<span className="text-emerald-700 dark:text-emerald-400">{t('eligible')}</span>}</td>
   </tr>)}</tbody>
  </table></div>
  <fieldset className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-3">
   <legend className="px-1 text-sm font-medium">{t('settings')}</legend>
   <label className="block space-y-1 text-sm"><span className="text-xs font-medium text-muted-foreground">{t('role')}</span>
    <select name="role" value={role} onChange={e=>{setRole(e.target.value);setReview(false);}} className={`${inputCls} min-h-11`}>{roles.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
   <label className="block space-y-1 text-sm"><span className="text-xs font-medium text-muted-foreground">{t('scope')}</span>
    <select name="companyId" value={company} onChange={e=>{setCompany(e.target.value);setReview(false);}} className={`${inputCls} min-h-11`}>{companies.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
   <label className="block space-y-1 text-sm"><span className="text-xs font-medium text-muted-foreground">{t('language')}</span>
    <select name="emailLocale" value={language} onChange={e=>{setLanguage(e.target.value);setReview(false);}} className={`${inputCls} min-h-11`}>{languages.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
  </fieldset>
  {!review?<button type="button" className={`${btnPrimary} min-h-11`} disabled={count===0} onClick={()=>setReview(true)}>{t('review')}</button>
   :<section aria-labelledby="batch-confirm" className="space-y-3 rounded-lg border border-primary/40 bg-muted/30 p-4">
    <h2 id="batch-confirm" className="font-medium">{t('confirmTitle')}</h2>
    <p className="text-sm">{t('confirmBody',{count,role:label(roles,role),scope:label(companies,company),language:label(languages,language)})}</p>
    <p className="text-sm text-muted-foreground">{t('pendingNote')}</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmed" required className="mt-1"/>{t('confirmCheck',{count})}</label>
    <div className="flex flex-wrap gap-2"><ActionButton type="submit" className={`${btnPrimary} min-h-11`}>{t('send',{count})}</ActionButton>
     <button type="button" className={`${btnGhost} min-h-11`} onClick={()=>setReview(false)}>{t('back')}</button></div>
   </section>}
 </ActionNavigateForm>;
}
