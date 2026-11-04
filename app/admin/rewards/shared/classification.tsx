'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button,Card,Field,inputCls} from '@/components/ui';
import type {RewardCompanyClassification} from '@/packs/rewards/company-picker';
export function RewardCompanyClassificationPanel({companies,rows,saveAction}:{companies:readonly{id:string;name:string}[];rows:RewardCompanyClassification[];saveAction:(form:FormData)=>Promise<{ok:boolean}>}){
 const t=useTranslations('rewards.companyPicker'),router=useRouter(),[editing,setEditing]=useState(false),[companyId,setCompany]=useState(companies[0]?.id??''),[disposition,setDisposition]=useState<string>(rows.find(row=>row.companyId===companies[0]?.id)?.disposition??'visible'),[pending,setPending]=useState(false),[error,setError]=useState(false);
 const current=rows.find(row=>row.companyId===companyId);
 const canonical=companies.filter(c=>c.id!==companyId&&!rows.some(row=>row.companyId===c.id&&row.disposition!=='visible'));
 async function save(form:FormData){if(pending)return;setPending(true);setError(false);try{const result=await saveAction(form);if(result.ok){setEditing(false);router.refresh();}else setError(true);}catch{setError(true);}finally{setPending(false);}}
 return <Card className="space-y-4 p-4 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t('classificationTitle')}</h2><Button type="button" variant="outline" disabled={pending||!companies.length} onClick={()=>{setEditing(true);setError(false);}}>{t('reviewDesignation')}</Button></div><p className="text-sm text-muted-foreground">{t('classificationHelp')}</p>
  {rows.length?<ul className="divide-y">{rows.map(row=><li key={row.companyId} className="space-y-1 py-2 text-sm"><p className="font-medium">{companies.find(c=>c.id===row.companyId)?.name??t('unavailable')} · {t(row.disposition)}{row.canonicalCompanyId&&<> · {companies.find(c=>c.id===row.canonicalCompanyId)?.name??t('unavailable')}</>}</p><p>{row.reason}</p><p className="text-xs text-muted-foreground">{row.updatedAt}</p></li>)}</ul>:<p className="text-sm text-muted-foreground">{t('noneDesignated')}</p>}
  {editing&&<form action={save} className="space-y-3 rounded-md border p-3"><fieldset disabled={pending} className="space-y-3">
   <Field label={t('company')}><select name="companyId" required className={inputCls} value={companyId} onChange={event=>{setCompany(event.target.value);setDisposition(rows.find(r=>r.companyId===event.target.value)?.disposition??'visible');}}>{companies.map(c=><option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}</select></Field>
   <Field label={t('designation')}><select name="disposition" className={inputCls} value={disposition} onChange={event=>setDisposition(event.target.value)}>{(['visible','test_demo','alias'] as const).map(key=><option key={key} value={key}>{t(key)}</option>)}</select></Field>
   {disposition==='alias'?<Field label={t('canonicalCompany')}><select key={companyId} name="canonicalCompanyId" required defaultValue={current?.canonicalCompanyId??''} className={inputCls}><option value="">{t('chooseCanonical')}</option>{canonical.map(c=><option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}</select></Field>:<input type="hidden" name="canonicalCompanyId" value=""/>}
   <Field label={t('reason')}><textarea key={companyId} name="reason" required minLength={10} maxLength={2000} rows={3} defaultValue="" className={`${inputCls} h-auto py-2`}/></Field>
   <label className="flex items-start gap-2 text-sm"><input name="verified" type="checkbox" required/>{t('verification')}</label>
   {error&&<p role="alert" className="text-sm text-destructive">{t('saveFailed')}</p>}
   <div className="flex gap-2"><Button type="submit" disabled={pending}>{t('confirm')}</Button><Button type="button" variant="outline" disabled={pending} onClick={()=>setEditing(false)}>{t('cancel')}</Button></div>
  </fieldset></form>}
 </Card>;
}
