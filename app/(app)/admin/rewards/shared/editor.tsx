'use client';
import Link from 'next/link';
import {useRef,useState,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button,Card,Field,inputCls} from '@/components/ui';
import {rewardTargetKey,type RewardPolicyTarget} from '@/packs/rewards/policy-group-model';
import {RewardPolicyYearContext} from '@/app/(app)/rewards/policy-year-context';
import {RewardCompanyExclusionsPanel} from './exclusions';
import type {RewardCompanyExclusion,RewardPolicyTaken} from '@/packs/rewards/service';
export type SharedRewardSaveResult={ok:true;value:{groupId:string;revision:number}}|{ok:false;code:'invalid'|'changed'|'scope'|'system'|'overlap'|'excluded';conflicts?:RewardPolicyTaken[]};
type Props={actorUserId:string;groupId:string|null;revision:number;name:string;year:number;targets:RewardPolicyTarget[];
 companies:readonly {id:string;name:string;groupId?:string|null;groupName?:string|null;archived?:boolean;excludedYears?:number[]}[];units:readonly {id:string;name:string;companyId:string;global:boolean;archived:boolean}[];
 exclusions?:RewardCompanyExclusion[];exclusionAction?:(form:FormData)=>Promise<{ok:boolean}>;
 memberships?:readonly RewardPolicyTarget[];
 initialTaken?:RewardPolicyTaken[];loadTakenAction?:(year:number)=>Promise<RewardPolicyTaken[]>;canManageUnits?:boolean;
 policyFields:ReactNode;saveAction:(form:FormData)=>Promise<SharedRewardSaveResult>};
/** All permissions, compatible pairs and policy content are independently checked by the server owner. */
export function SharedRewardEditor(props:Props){
 return <SharedRewardEditorDraft key={props.actorUserId+':'+(props.groupId??'new')+':'+props.revision+':'+JSON.stringify(props.companies.map(c=>c.id))+':'+JSON.stringify(props.units)+':'+props.year+':'+JSON.stringify(props.initialTaken)+':'+JSON.stringify(props.memberships)} {...props}/>;
}
function SharedRewardEditorDraft({groupId,revision,name:initialName,year:initialYear,targets:initialTargets,companies,units,memberships=[],initialTaken=[],loadTakenAction,canManageUnits=false,exclusions=[],exclusionAction,policyFields,saveAction}:Props){
 const t=useTranslations('rewards.sharedPolicy'),router=useRouter(),saving=useRef(false);
 const [name,setName]=useState(initialName),[targets,setTargets]=useState(initialTargets);
 const [year,setYear]=useState(initialYear),[taken,setTaken]=useState(initialTaken),[loading,setLoading]=useState(false),[loadFailed,setLoadFailed]=useState(false),[conflicts,setConflicts]=useState<RewardPolicyTaken[]>([]),request=useRef(0);
 const [query,setQuery]=useState(''),[reviewed,setReviewed]=useState(false),[pending,setPending]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState<null|'invalid'|'changed'|'scope'|'system'|'overlap'|'excluded'>(null);
 const unavailable=(p:RewardPolicyTarget)=>taken.find(row=>row.groupId!==groupId&&rewardTargetKey(row)===rewardTargetKey(p));
 const validPair=(p:RewardPolicyTarget)=>companies.some(c=>c.id===p.companyId&&!c.archived&&!c.excludedYears?.includes(year))&&units.some(u=>u.id===p.businessUnitId&&!u.archived&&memberships.some(pair=>pair.companyId===p.companyId&&pair.businessUnitId===u.id))&&!unavailable(p);
 const complete=(targets.length>0||groupId!==null)&&targets.length<=500&&targets.every(validPair)&&!loading&&!loadFailed&&Number.isInteger(year)&&year>=2000&&year<=2200;
 const label=(p:RewardPolicyTarget)=>`${companies.find(c=>c.id===p.companyId)?.name??t('unavailable')} · ${units.find(u=>u.id===p.businessUnitId)?.name??t('unavailable')}`;
 const search=query.trim().toLocaleLowerCase();
 const groups=new Map<string,{name:string;companies:typeof companies[number][]}>();
 for(const company of companies.filter(c=>(!c.archived&&!c.excludedYears?.includes(year))||targets.some(pair=>pair.companyId===c.id))){
  const key=company.groupId??'other',group=groups.get(key)??{name:company.groupName??t('otherCompanies'),companies:[]};
  group.companies.push(company);groups.set(key,group);
 }
 const optionsFor=(companyId:string)=>units.filter(unit=>memberships.some(pair=>pair.companyId===companyId&&pair.businessUnitId===unit.id));
 const availablePairs=(companyId:string)=>optionsFor(companyId).filter(unit=>companies.some(c=>c.id===companyId&&!c.archived&&!c.excludedYears?.includes(year))).filter(unit=>!unit.archived&&!unavailable({companyId,businessUnitId:unit.id})).map(unit=>({companyId,businessUnitId:unit.id}));
 const has=(pair:RewardPolicyTarget)=>targets.some(row=>rewardTargetKey(row)===rewardTargetKey(pair));
 const changed=()=>{setReviewed(false);setError(null);setConflicts([]);};
 function select(pairs:RewardPolicyTarget[],checked:boolean){
  changed();const keys=new Set(pairs.map(rewardTargetKey));
  setTargets(rows=>checked?[...rows,...pairs.filter(pair=>!rows.some(row=>rewardTargetKey(row)===rewardTargetKey(pair)))]:rows.filter(row=>!keys.has(rewardTargetKey(row))));
 }
 async function refreshTaken(nextYear:number){
  const token=++request.current;changed();setYear(nextYear);setLoadFailed(false);
  if(!Number.isInteger(nextYear)||nextYear<2000||nextYear>2200){setLoading(false);return;}
  if(!loadTakenAction)return;
  setLoading(true);
  try{const rows=await loadTakenAction(nextYear);if(token===request.current)setTaken(rows);}
  catch{if(token===request.current)setLoadFailed(true);}
  finally{if(token===request.current)setLoading(false);}
 }
 async function save(form:FormData){
  if(saving.current||!reviewed||!complete)return;
  saving.current=true;setPending(true);setError(null);
  try{
   const result=await saveAction(form);
   if(result.ok){setSaved(true);router.push(`/admin/rewards/shared?group=${result.value.groupId}`);router.refresh();}
   else{setReviewed(false);setError(result.code);setConflicts(result.conflicts??[]);}
  }catch{setReviewed(false);setError('system');}
  finally{saving.current=false;setPending(false);}
 }
 return <><form action={save} className="space-y-6" onChange={changed} onSubmit={event=>{if(!reviewed){event.preventDefault();if(complete)setReviewed(true);}}}>
  <input type="hidden" name="groupId" value={groupId??''}/><input type="hidden" name="revision" value={revision}/><input type="hidden" name="targets" value={JSON.stringify(targets)}/>
  {error&&<div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{t(`errors.${error}`)}{conflicts.length>0&&<ul>{conflicts.map(row=><li key={rewardTargetKey(row)}>{t('conflict',{unit:label(row),name:row.name,year})}</li>)}</ul>}{error==='changed'&&<Button type="button" variant="outline" className="ml-3" onClick={()=>router.refresh()}>{t('reload')}</Button>}</div>}
  {saved&&<p role="status" className="text-sm">{t('saved')}</p>}
  <fieldset disabled={pending||saved} className="space-y-6">
   <Card className="space-y-4 p-4 sm:p-6"><h2 className="font-semibold">{groupId?t('edit'):t('create')}</h2><p className="text-sm text-muted-foreground">{t('futureOnly')}</p><p className="text-sm text-muted-foreground">{t('ownershipHelp')}</p>
    <div className="grid gap-4 sm:grid-cols-2"><Field label={t('name')}><input required maxLength={100} name="name" className={inputCls} value={name} onChange={event=>setName(event.target.value)}/></Field><Field label={t('year')}><input required name="year" type="number" min={2000} max={2200} value={year} onChange={event=>{void refreshTaken(Number(event.target.value));}} className={inputCls}/></Field></div>
    <Field label={t('search')}><input type="search" value={query} onChange={event=>setQuery(event.target.value)} className={inputCls}/></Field>
    <div className="sticky top-0 z-20 space-y-2 rounded-md border border-border bg-card p-3 shadow-sm" aria-label={t('selectedSummary')}><p role="status" className="text-sm font-medium">{t('selectedCount',{companies:new Set(targets.map(row=>row.companyId)).size,units:targets.length})}</p>
     <ul className="max-h-32 space-y-1 overflow-y-auto text-sm">{targets.map(pair=><li key={rewardTargetKey(pair)}>{label(pair)}{!validPair(pair)&&<><span className="ml-2 text-destructive">{t('membershipChanged')}</span><Button type="button" variant="outline" className="ml-2" onClick={()=>{changed();setTargets(rows=>rows.filter(row=>rewardTargetKey(row)!==rewardTargetKey(pair)));}}>{t('removeUnavailable')}</Button></>}</li>)}</ul>
    </div>
    {loading&&<p role="status" className="text-sm text-muted-foreground">{t('loadingTaken')}</p>}
    {loadFailed&&<div role="alert" className="text-sm text-destructive">{t('loadFailed')} <Button type="button" variant="outline" onClick={()=>{void refreshTaken(year);}}>{t('retry')}</Button></div>}
    <fieldset disabled={loading||loadFailed} className="space-y-4">
    {[...groups.entries()].map(([groupKey,group])=>{
     const groupMatches=group.name.toLocaleLowerCase().includes(search),groupPairs=group.companies.flatMap(c=>availablePairs(c.id));
     const visibleUnits=units.filter(unit=>group.companies.some(company=>optionsFor(company.id).some(option=>option.id===unit.id))).filter(unit=>!search||groupMatches||unit.name.toLocaleLowerCase().includes(search)||group.companies.some(company=>company.name.toLocaleLowerCase().includes(search)&&optionsFor(company.id).some(option=>option.id===unit.id)));
     const unassigned=group.companies.filter(company=>!optionsFor(company.id).length&&(!search||groupMatches||company.name.toLocaleLowerCase().includes(search)));
     if(!visibleUnits.length&&!unassigned.length)return null;
     return <section key={groupKey} className="space-y-3 rounded-md border p-3 sm:p-4" aria-label={group.name}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{group.name}</h3><Button type="button" variant="outline" disabled={!groupPairs.length||groupPairs.every(has)} onClick={()=>select(groupPairs,true)}>{t('selectAll')}</Button></div>
      <div className="grid gap-3 lg:grid-cols-2">{visibleUnits.map(unit=>{
       const members=group.companies.filter(company=>optionsFor(company.id).some(option=>option.id===unit.id)),visible=members.filter(company=>!search||groupMatches||unit.name.toLocaleLowerCase().includes(search)||company.name.toLocaleLowerCase().includes(search));
       return <fieldset key={unit.id} className="min-w-0 space-y-2 rounded-md border p-3"><legend className="px-1 text-sm font-medium">{unit.name}</legend>{visible.map(company=>{
        const pair={companyId:company.id,businessUnitId:unit.id},key=rewardTargetKey(pair),checked=has(pair),assignment=unavailable(pair);
        return <label key={key} className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label={[company.name,unit.name,company.archived?t('companyArchived'):null,company.excludedYears?.includes(year)?t('excludedCompany'):null,assignment?t('assignedTo',{name:assignment.name}):null].filter(Boolean).join(' · ')} checked={checked} disabled={(!validPair(pair)||unit.archived)&&!checked} onChange={event=>select([pair],event.target.checked)}/><span>{company.name}{assignment&&<span className="ml-1 text-xs text-muted-foreground">{t('assignedTo',{name:assignment.name})}</span>}</span></label>;
       })}</fieldset>;
      })}</div>
      {unassigned.map(company=><p key={company.id} className="text-sm text-muted-foreground">{company.name} · {t('noMembership')}{canManageUnits&&<> <Link href="/admin/personnel" className="text-primary hover:underline">{t('manageUnits')}</Link></>}</p>)}
     </section>;
    })}
    </fieldset>
    {![...groups.values()].some(group=>group.name.toLocaleLowerCase().includes(search)||group.companies.some(c=>c.name.toLocaleLowerCase().includes(search)||optionsFor(c.id).some(u=>u.name.toLocaleLowerCase().includes(search))))&&<p className="text-sm text-muted-foreground">{t('noMatches')}</p>}
    {groupId&&targets.length===0&&<p className="text-sm text-muted-foreground">{t('archiveHelp')}</p>}

   </Card>
   <Card className="space-y-5 p-4 sm:p-6"><h2 className="font-semibold">{t('policy')}</h2><RewardPolicyYearContext.Provider value={year}>{policyFields}</RewardPolicyYearContext.Provider></Card>
   {reviewed&&<Card className="space-y-3 p-4 sm:p-6"><h2 className="font-semibold">{t('review')}</h2><p className="text-sm">{name} · {t('version',{version:revision+1})}</p><p className="text-sm text-muted-foreground">{t('futureOnly')}</p><ul className="list-inside list-disc text-sm">{targets.map(pair=><li key={rewardTargetKey(pair)}>{label(pair)}</li>)}</ul></Card>}
   <div className="flex flex-wrap gap-3"><Button type="submit" disabled={!complete||pending||saved}>{pending?t('saving'):reviewed?(targets.length?t('confirm'):t('archive')):t('preview')}</Button>{reviewed&&<Button type="button" variant="outline" onClick={()=>setReviewed(false)}>{t('back')}</Button>}</div>
  </fieldset>
 </form>{exclusionAction&&Number.isInteger(year)&&year>=2000&&year<=2200&&<RewardCompanyExclusionsPanel key={year} year={year} companies={companies} rows={exclusions} saveAction={exclusionAction}/>}</>;
}
