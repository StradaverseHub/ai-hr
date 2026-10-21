'use client';
import {useRef,useState,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button,Card,Field,inputCls} from '@/components/ui';
import {rewardTargetKey,removeRewardTargetCompany,type RewardPolicyTarget} from '@/packs/rewards/policy-group-model';
export type SharedRewardSaveResult={ok:true;value:{groupId:string;revision:number}}|{ok:false;code:'invalid'|'changed'|'scope'|'system'};
type Props={actorUserId:string;groupId:string|null;revision:number;name:string;year:number;targets:RewardPolicyTarget[];
 companies:readonly {id:string;name:string}[];units:readonly {id:string;name:string;companyId:string;global:boolean;archived:boolean}[];
 policyFields:ReactNode;saveAction:(form:FormData)=>Promise<SharedRewardSaveResult>};
/** All permissions, compatible pairs and policy content are independently checked by the server owner. */
export function SharedRewardEditor(props:Props){
 return <SharedRewardEditorDraft key={props.actorUserId+':'+(props.groupId??'new')+':'+props.revision+':'+JSON.stringify(props.companies.map(c=>c.id))+':'+JSON.stringify(props.units)} {...props}/>;
}
function SharedRewardEditorDraft({groupId,revision,name:initialName,year,targets:initialTargets,companies,units,policyFields,saveAction}:Props){
 const t=useTranslations('rewards.sharedPolicy'),router=useRouter(),saving=useRef(false);
 const [name,setName]=useState(initialName),[targets,setTargets]=useState(initialTargets),[selectedCompanies,setCompanies]=useState([...new Set(initialTargets.map(row=>row.companyId))]);
 const [query,setQuery]=useState(''),[reviewed,setReviewed]=useState(false),[pending,setPending]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState<null|'invalid'|'changed'|'scope'|'system'>(null);
 const validPair=(p:RewardPolicyTarget)=>companies.some(c=>c.id===p.companyId)&&units.some(u=>u.id===p.businessUnitId&&!u.archived&&(u.companyId===p.companyId||u.global));
 const complete=(targets.length>0||groupId!==null)&&targets.length<=500&&targets.every(validPair)&&selectedCompanies.every(id=>targets.some(row=>row.companyId===id));
 const label=(p:RewardPolicyTarget)=>`${companies.find(c=>c.id===p.companyId)?.name??t('unavailable')} · ${units.find(u=>u.id===p.businessUnitId)?.name??t('unavailable')}`;
 const search=query.trim().toLocaleLowerCase();
 const visible=companies.filter(c=>c.name.toLocaleLowerCase().includes(search)||units.some(u=>(u.global||u.companyId===c.id)&&u.name.toLocaleLowerCase().includes(search)));
 const changed=()=>{setReviewed(false);setError(null);};
 async function save(form:FormData){
  if(saving.current||!reviewed||!complete)return;
  saving.current=true;setPending(true);setError(null);
  try{
   const result=await saveAction(form);
   if(result.ok){setSaved(true);router.push(`/admin/rewards/shared?group=${result.value.groupId}`);router.refresh();}
   else{setReviewed(false);setError(result.code);}
  }catch{setReviewed(false);setError('system');}
  finally{saving.current=false;setPending(false);}
 }
 return <form action={save} className="space-y-6" onChange={changed} onSubmit={event=>{if(!reviewed){event.preventDefault();if(complete)setReviewed(true);}}}>
  <input type="hidden" name="groupId" value={groupId??''}/><input type="hidden" name="revision" value={revision}/><input type="hidden" name="targets" value={JSON.stringify(targets)}/>
  {error&&<div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{t(`errors.${error}`)}{error==='changed'&&<Button type="button" variant="outline" className="ml-3" onClick={()=>router.refresh()}>{t('reload')}</Button>}</div>}
  {saved&&<p role="status" className="text-sm">{t('saved')}</p>}
  <fieldset disabled={pending||saved} className="space-y-6">
   <Card className="space-y-4 p-4 sm:p-6"><h2 className="font-semibold">{groupId?t('edit'):t('create')}</h2><p className="text-sm text-muted-foreground">{t('futureOnly')}</p><p className="text-sm text-muted-foreground">{t('ownershipHelp')}</p>
    <div className="grid gap-4 sm:grid-cols-2"><Field label={t('name')}><input required maxLength={100} name="name" className={inputCls} value={name} onChange={event=>setName(event.target.value)}/></Field><Field label={t('year')}><input required name="year" type="number" min={2000} max={2200} defaultValue={year} className={inputCls}/></Field></div>
    <Field label={t('search')}><input type="search" value={query} onChange={event=>setQuery(event.target.value)} className={inputCls}/></Field>
    <div className="grid gap-3 lg:grid-cols-2">{visible.map(company=>{
     const selected=selectedCompanies.includes(company.id),options=units.filter(unit=>(unit.companyId===company.id||unit.global)&&(!search||company.name.toLocaleLowerCase().includes(search)||unit.name.toLocaleLowerCase().includes(search)));
     return <fieldset key={company.id} className="rounded-md border p-3"><legend className="px-1 text-sm font-medium"><label className="flex items-center gap-2"><input type="checkbox" checked={selected} onChange={event=>{changed();setCompanies(rows=>event.target.checked?[...rows,company.id]:rows.filter(id=>id!==company.id));if(!event.target.checked)setTargets(rows=>removeRewardTargetCompany(rows,company.id));}}/>{company.name}</label></legend>
      {selected&&<div className="space-y-2">{options.map(unit=>{
       const pair={companyId:company.id,businessUnitId:unit.id},key=rewardTargetKey(pair),checked=targets.some(row=>rewardTargetKey(row)===key);
       return <label key={key} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={checked} disabled={unit.archived&&!checked} onChange={event=>{changed();setTargets(rows=>event.target.checked?[...rows,pair]:rows.filter(row=>rewardTargetKey(row)!==key));}}/><span>{unit.name}{unit.global&&<span className="text-xs text-muted-foreground"> · {t('global')}</span>}{unit.archived&&<span className="text-xs text-muted-foreground"> · {t('archived')}</span>}</span></label>;
      })}{!options.length&&<p className="text-sm text-muted-foreground">{t('noMatches')}</p>}</div>}
     </fieldset>;
    })}</div>
    {!visible.length&&<p className="text-sm text-muted-foreground">{t('noMatches')}</p>}
    {groupId&&targets.length===0&&selectedCompanies.length===0&&<p className="text-sm text-muted-foreground">{t('archiveHelp')}</p>}
    {!complete&&selectedCompanies.length>0&&<p className="text-sm text-muted-foreground">{t('selectUnits')}</p>}
    <ul className="space-y-1 text-sm">{targets.map(pair=><li key={rewardTargetKey(pair)}>{label(pair)}{!validPair(pair)&&<Button type="button" variant="outline" className="ml-2" onClick={()=>{changed();setTargets(rows=>rows.filter(row=>rewardTargetKey(row)!==rewardTargetKey(pair)));if(!companies.some(company=>company.id===pair.companyId)&&targets.filter(row=>row.companyId===pair.companyId).length===1)setCompanies(rows=>rows.filter(id=>id!==pair.companyId));}}>{t('removeUnavailable')}</Button>}</li>)}</ul>
   </Card>
   <Card className="space-y-5 p-4 sm:p-6"><h2 className="font-semibold">{t('policy')}</h2>{policyFields}</Card>
   {reviewed&&<Card className="space-y-3 p-4 sm:p-6"><h2 className="font-semibold">{t('review')}</h2><p className="text-sm">{name} · {t('version',{version:revision+1})}</p><p className="text-sm text-muted-foreground">{t('futureOnly')}</p><ul className="list-inside list-disc text-sm">{targets.map(pair=><li key={rewardTargetKey(pair)}>{label(pair)}</li>)}</ul></Card>}
   <div className="flex flex-wrap gap-3"><Button type="submit" disabled={!complete||pending||saved}>{pending?t('saving'):reviewed?(targets.length?t('confirm'):t('archive')):t('preview')}</Button>{reviewed&&<Button type="button" variant="outline" onClick={()=>setReviewed(false)}>{t('back')}</Button>}</div>
  </fieldset>
 </form>;
}
