'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, ErrorBanner, Field, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { assessmentCompanyKpiAction } from '../onehr-actions';

type Result=NonNullable<Awaited<ReturnType<typeof assessmentCompanyKpiAction>>['result']>;
export function CompanyKpiFill({cycleId,companies,names}:{cycleId:string;companies:{id:string;name:string}[];names:string[]}){
 const t=useTranslations('onehr.companyKpi'),router=useRouter();
 const [input,setInput]=useState({companyId:'',title:'',actual:'',note:''}),[result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
 function change(key:keyof typeof input,value:string){setInput({...input,[key]:value});setResult(null);setError(undefined);}
 async function run(apply:boolean){
  if(busy||!input.title||!input.actual||!Number.isFinite(Number(input.actual))||apply&&(!result||result.applied))return;
  setBusy(true);setError(undefined);
  try{
   const response=await assessmentCompanyKpiAction(cycleId,{...input,companyId:input.companyId||null,actual:Number(input.actual)},apply?result!.token:undefined);
   if(response.error){setError(response.error);setResult(null);}else if(response.result){setResult(response.result);if(response.result.applied)router.refresh();}
  }catch{setError(t('failed'));}finally{setBusy(false);}
 }
 return <Card className="space-y-4 p-5"><h2 className="font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('help')}</p><ErrorBanner message={error}/>
  <form onSubmit={e=>{e.preventDefault();void run(false);}} className="space-y-4"><fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2"><Field label={t('scope')}><select className={inputCls} value={input.companyId} onChange={e=>change('companyId',e.target.value)}><option value="">{t('all')}</option>{companies.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></Field><Field label={t('kpi')}><select required className={inputCls} value={input.title} onChange={e=>change('title',e.target.value)}><option value="">{t('choose')}</option>{names.map(n=><option key={n}>{n}</option>)}</select></Field><Field label={t('actual')}><input required type="number" step="any" className={inputCls} value={input.actual} onChange={e=>change('actual',e.target.value)}/></Field><Field label={t('note')}><textarea maxLength={4000} className={inputCls} value={input.note} onChange={e=>change('note',e.target.value)}/></Field></fieldset><Button type="submit" disabled={busy}>{t('preview')}</Button></form>
  {result&&<><div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">{t('employee')}</th><th className="p-2">{t('action')}</th><th className="p-2">{t('reason')}</th></tr></thead><tbody>{result.preview.map(r=><tr key={`${r.reviewId}.${r.kpiId}`} className="border-t border-border"><td className="p-2">{r.employee}</td><td className="p-2">{t(r.action)}</td><td className="p-2">{r.reason}</td></tr>)}</tbody></table></div>{result.applied?<p role="status">{t('applied')}</p>:result.preview.some(r=>r.action==='fill')&&<form onSubmit={e=>{e.preventDefault();void run(true);}}><ConfirmSubmit variant="default" title={t('apply')} description={t('confirm')} disabled={busy}>{t('apply')}</ConfirmSubmit></form>}</>}
 </Card>;
}
