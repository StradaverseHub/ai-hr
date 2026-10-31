'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useLocale,useTranslations} from 'next-intl';
import {Button,Card,Field,inputCls} from '@/components/ui';
import type {RewardCompanyExclusion} from '@/packs/rewards/service';
export function RewardCompanyExclusionsPanel({year,companies,rows,saveAction}:{year:number;companies:readonly{id:string;name:string;archived?:boolean}[];rows:RewardCompanyExclusion[];saveAction:(form:FormData)=>Promise<{ok:boolean}>}){
 const t=useTranslations('rewards.sharedGovernance'),locale=useLocale(),router=useRouter(),[mode,setMode]=useState<string|null>(null),[pending,setPending]=useState(false),[error,setError]=useState(false);
 const active=rows.filter(row=>row.year===year&&!row.endedAt),ending=active.find(row=>row.id===mode);
 const available=companies.filter(c=>!c.archived&&!active.some(row=>row.companyId===c.id));
 async function save(form:FormData){if(pending)return;setPending(true);setError(false);try{const result=await saveAction(form);if(result.ok){setMode(null);router.refresh();}else setError(true);}catch{setError(true);}finally{setPending(false);}}
 return <Card className="space-y-4 p-4 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t('excludedFor',{year})}</h2><Button type="button" variant="outline" disabled={pending||!available.length} onClick={()=>{setMode('new');setError(false);}}>{t('excludeCompany')}</Button></div>
  <p className="text-sm text-muted-foreground">{t('exclusionHelp')}</p>
  {active.length?<ul className="divide-y">{active.map(row=><li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm"><div><p className="font-medium">{row.company}</p><p>{row.reason}</p><p className="text-xs text-muted-foreground">{row.createdBy??t('unknownActor')} · {new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(row.createdAt))}</p></div><Button type="button" variant="outline" disabled={pending} onClick={()=>{setMode(row.id);setError(false);}}>{t('bringBack')}</Button></li>)}</ul>:<p className="text-sm text-muted-foreground">{t('noneExcluded')}</p>}
  {mode&&<form key={`${year}:${mode}`} action={save} className="space-y-3 rounded-md border p-3"><input type="hidden" name="year" value={year}/><input type="hidden" name="endId" value={ending?.id??''}/>
   {ending?<><input type="hidden" name="companyId" value={ending.companyId}/><p className="text-sm font-medium">{t('bringBackCompany',{name:ending.company})}</p></>:<Field label={t('company')}><select name="companyId" required className={inputCls}>{available.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
   <Field label={t('reason')}><textarea name="reason" required minLength={10} maxLength={2000} rows={3} className={`${inputCls} h-auto py-2`}/></Field>
   {error&&<p role="alert" className="text-sm text-destructive">{t('saveFailed')}</p>}
   <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending}>{t(ending?'confirmBringBack':'confirmExclusion')}</Button><Button type="button" variant="outline" disabled={pending} onClick={()=>setMode(null)}>{t('cancel')}</Button></div>
  </form>}
 </Card>;
}
