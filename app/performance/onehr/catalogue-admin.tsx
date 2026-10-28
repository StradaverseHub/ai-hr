'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Policy } from '@/packs/performance/onehr/model';
import { architectureHeaders, architectureSheets } from '@/packs/performance/onehr/architecture-model';
import { Button, Card, ErrorBanner, Field, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { assessmentArchitectureAction, assessmentGenerateProfilesAction, onehrCycleAction } from '../onehr-actions';

export const catalogueSections=['import','profiles','routes','generate'] as const;
export type CatalogueSection=typeof catalogueSections[number];
/** D-P1-32 PT-X4: `sections` draws only some of the card's sections (each posts its own action, so they split safely);
 * the cycle page draws all four. `returnTo` is the admin page a profile or route save comes back to. */
export function CatalogueAdmin({cycleId,revision,policy,companies,sections=catalogueSections,returnTo}:{cycleId:string;revision:number;policy:Policy;companies:{id:string;name:string}[];sections?:readonly CatalogueSection[];returnTo?:string}){
 const show=(section:CatalogueSection)=>sections.includes(section);
 const t=useTranslations('onehr.catalogueAdmin'),common=useTranslations('onehr'),imports=useTranslations('onehr.imports'),router=useRouter();
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>(),[selected,setSelected]=useState(policy.profiles[0]?.id??'');
 const [sheets,setSheets]=useState<{Job_Profile:string;Job_Skills:string}>(),[preview,setPreview]=useState<Awaited<ReturnType<typeof assessmentArchitectureAction>>['result']>();
 const [generation,setGeneration]=useState<Awaited<ReturnType<typeof assessmentGenerateProfilesAction>>['result']>();
 const profile=policy.profiles.find(p=>p.id===selected);
 const availableSkills=[...new Map([...policy.profiles.flatMap(p=>p.competencies),...(policy.skills??[])].map(s=>[s.id,s])).values()];
 const fields=<><input type="hidden" name="cycleId" value={cycleId}/><input type="hidden" name="revision" value={revision}/>{returnTo&&<input type="hidden" name="returnTo" value={returnTo}/>}</>;
 async function file(file:File|undefined){
  setSheets(undefined);setPreview(undefined);setError(undefined);if(!file)return;
  if(file.size>10_000_000){setError(imports('tooLarge'));return;}
  setBusy(true);try{
   const decoded=await (await import('@/lib/spreadsheet')).workbookToCsvTexts(await file.arrayBuffer(),architectureSheets,true);
   if(!decoded.extra.Job_Skills)throw Error(t('missingSheet'));
   setSheets({Job_Profile:decoded.extra.Job_Profile??'',Job_Skills:decoded.extra.Job_Skills});
  }catch(e){setError(e instanceof Error?e.message:imports('readError'));}finally{setBusy(false);}
 }
 async function run(apply=false){
  if(!sheets||busy||apply&&(!preview||preview.applied))return;setBusy(true);setError(undefined);
  try{const response=await assessmentArchitectureAction(cycleId,sheets,apply?preview?.token:undefined);if(response.error){setError(response.error);setPreview(undefined);}else{setPreview(response.result);if(response.result?.applied){setGeneration(undefined);router.refresh();}}}catch{setError(imports('readError'));}finally{setBusy(false);}
 }
 async function generate(apply=false){
  if(busy||apply&&(!generation||generation.applied))return;setBusy(true);setError(undefined);
  try{const response=await assessmentGenerateProfilesAction(cycleId,apply?generation?.token:undefined);if(response.error){setError(response.error);setGeneration(undefined);}else{setGeneration(response.result);if(response.result?.applied)router.refresh();}}catch{setError(imports('readError'));}finally{setBusy(false);}
 }
 async function template(){
  setBusy(true);setError(undefined);try{
   const bytes=await (await import('@/lib/spreadsheet')).buildXlsx(architectureHeaders.Job_Profile,[],{sheetName:'Job_Profile',textColumns:[2],extraSheets:[{name:'Job_Skills',rows:[architectureHeaders.Job_Skills],textColumns:[2,7]}]});
   const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));const a=document.createElement('a');a.href=url;a.download='competency-architecture-template.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch{setError(imports('readError'));}finally{setBusy(false);}
 }
 return <Card className="space-y-5 p-5"><h2 className="font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('help')}</p><ErrorBanner message={error}/>
  {show('import')&&<details><summary className="cursor-pointer font-medium">{t('import')}</summary><div className="mt-4 space-y-4"><div className="flex flex-wrap items-end gap-3"><Field label={imports('file')}><input type="file" accept=".xlsx,.xls" disabled={busy} onChange={e=>void file(e.target.files?.[0])}/></Field><Button type="button" variant="secondary" disabled={busy} onClick={()=>void template()}>{imports('template')}</Button><Button type="button" disabled={busy||!sheets} onClick={()=>void run()}>{imports('preview')}</Button></div>
   {preview&&<><p role="status" className="text-sm">{t('importCount',{skills:preview.skills,profiles:preview.profiles,links:preview.links,skipped:preview.skipped})}{preview.applied&&` · ${imports('done')}`}</p>{!preview.applied&&<form onSubmit={e=>{e.preventDefault();void run(true);}}><ConfirmSubmit disabled={busy} description={t('importConfirm')}>{imports('apply')}</ConfirmSubmit></form>}</>}
  </div></details>}
  {show('profiles')&&<details><summary className="cursor-pointer font-medium">{t('profiles')}</summary><div className="mt-4 space-y-4"><Field label={t('profile')}><select value={selected} onChange={e=>setSelected(e.target.value)} className={inputCls}><option value="">{t('newProfile')}</option>{policy.profiles.map(p=><option key={p.id} value={p.id}>{p.department} · {p.jobTitle??p.name} · {p.grade}{p.active===false?` · ${t('inactive')}`:''}</option>)}</select></Field>
   <form key={`${selected}.${revision}`} action={onehrCycleAction} className="space-y-4">{fields}<input type="hidden" name="action" value="catalogue-profile"/><input type="hidden" name="profileId" value={profile?.id??''}/><div className="grid gap-4 sm:grid-cols-2">{(['name','jobTitle','department','grade','sector','track'] as const).map(k=><Field key={k} label={t(k)}><input name={k} required={k==='name'||k==='grade'||k==='jobTitle'&&!profile} defaultValue={profile?.[k]??''} maxLength={k==='grade'?30:300} className={inputCls}/></Field>)}<Field label={common('company')}><select name="companyId" defaultValue={profile?.companyId??''} className={inputCls}><option value="">{common('group')}</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={profile?.active!==false}/>{t('active')}</label></div>
    <fieldset className="max-h-80 space-y-2 overflow-y-auto rounded-md border border-border p-3"><legend className="px-1 text-sm">{t('skills')}</legend>{availableSkills.map(s=><label key={s.id} className="flex items-start gap-2 text-sm"><input type="checkbox" name="skillId" value={s.id} defaultChecked={profile?.competencies.some(c=>c.id===s.id)}/><span>{s.skillTitle??s.text} · {s.skillLevel??''} · {s.principle}</span></label>)}</fieldset><Button type="submit" disabled={busy}>{common('save')}</Button>
   </form></div></details>}
  {show('routes')&&<details><summary className="cursor-pointer font-medium">{t('routes')}</summary><form action={onehrCycleAction} className="mt-4 space-y-4">{fields}<input type="hidden" name="action" value="career-route"/><div className="grid gap-4 sm:grid-cols-3">{(['fromProfileId','toProfileId'] as const).map(k=><Field key={k} label={t(k)}><select required name={k} className={inputCls}><option value="">{common('choose')}</option>{policy.profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {p.grade}</option>)}</select></Field>)}<Field label={t('routeKind')}><select name="kind" className={inputCls}>{['automatic','pinned','hidden'].map(k=><option key={k} value={k}>{t(k)}</option>)}</select></Field></div><Button type="submit" disabled={busy}>{common('save')}</Button><ul className="space-y-2 text-sm">{policy.careerRoutes?.map(r=><li key={`${r.fromProfileId}.${r.toProfileId}`}>{policy.profiles.find(p=>p.id===r.fromProfileId)?.name} → {policy.profiles.find(p=>p.id===r.toProfileId)?.name} · {t(r.kind)}</li>)}</ul></form></details>}
  {show('generate')&&<details><summary className="cursor-pointer font-medium">{t('generate')}</summary><div className="mt-4 space-y-4"><p className="text-sm text-muted-foreground">{t('generateHelp')}</p><Button type="button" disabled={busy} variant="secondary" onClick={()=>void generate()}>{t('previewGeneration')}</Button>
   {generation&&<><div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{[common('employee'),t('profile'),t('status'),t('skills')].map(h=><th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{generation.rows.map(r=><tr key={r.reviewId} className="border-t border-border"><td className="p-2">{r.name}</td><td className="p-2">{r.profile??'—'}</td><td className="p-2">{t(`statuses.${r.status}`)}</td><td className="p-2">{r.count}</td></tr>)}</tbody></table></div>{generation.applied?<p role="status">{t('generationDone')}</p>:generation.rows.some(r=>r.status==='assign')&&<form onSubmit={e=>{e.preventDefault();void generate(true);}}><ConfirmSubmit disabled={busy} description={t('generateConfirm')}>{t('applyGeneration')}</ConfirmSubmit></form>}</>}
  </div></details>}
 </Card>;
}
