'use client';
/** Board 2103041d: PAT Inputs as one editable grid, saved in one batch with a reason (board 60f1fdcd: no second-person
 * confirmation; every save shows the server summary in "Review before saving"). Values are integer cents and basis
 * points; this grid only parses and displays them. Pools are computed by the service, never here. */
import {Fragment,useMemo,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button,Field,inputCls} from '@/components/ui';
import {useUnsavedChangesGuard} from '@/components/ui/unsaved-changes';
import type {RewardConfigSummary} from '@/packs/rewards/config-change-model';
import type {PatInput} from '@/packs/rewards/setup-model';
import {previewPatImportAction,previewPatBatchAction,savePatBatchAction,type PatGridRow} from './actions';
import {ReviewBeforeSavingDialog} from '../review-before-saving';
import {FIELDS,LABEL,DEFAULT,formatPatValue,patRowState,type FieldKey} from './grid-model';

export type PatGridVersion={id:string;revision:number;state:'pending'|'confirmed';inputs:PatInput;createdByName:string|null;confirmedByName:string|null;confirmedAt:string|null;reason:string};
export type PatGridCompany={id:string;name:string;groupId:string;groupName:string;buId:string;buName:string;latestRevision:number;
 active:PatGridVersion|null;draft:PatGridVersion|null;history:PatGridVersion[]};
const allowPatExport=(link:HTMLAnchorElement)=>link.href.includes('/pat-inputs/export');
const money=(cents:number|null)=>cents===null?'—':(cents/100).toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2});
function subtotal(rows:readonly PatInput[]){
 const sum=(key:'targetCents'|'forecastCents'|'actualCents')=>!rows.length||rows.some(r=>r[key]===null)?null:rows.reduce((n,r)=>n+(r[key]??0),0);
 const targetCents=sum('targetCents'),forecastCents=sum('forecastCents'),actualCents=sum('actualCents'),basis=actualCents??forecastCents;
 return{targetCents,forecastCents,actualCents,achievementBp:targetCents&&targetCents>0&&basis!==null?Math.trunc(basis*10000/targetCents):null};
}

export function PatGrid({year,companies}:{year:number;companies:PatGridCompany[]}){
 const t=useTranslations('rewardSetup'),router=useRouter();
 const [edits,setEdits]=useState<Record<string,Partial<Record<FieldKey,string>>>>({});
 const [query,setQuery]=useState(''),[group,setGroup]=useState(''),[bu,setBu]=useState(''),[missingOnly,setMissingOnly]=useState(false);
 const [review,setReview]=useState<{summary:RewardConfigSummary;digest:string;mode:'draft'|'active';rows:PatGridRow[]}|null>(null);
 const [message,setMessage]=useState(''),[error,setError]=useState(''),[pending,start]=useTransition();
 const [importError,setImportError]=useState(''),[importing,startImport]=useTransition();
 // Imported or copied values enter the grid as edits; nothing is saved until the editor reviews them.
 const runImport=(form:FormData)=>startImport(async()=>{const result=await previewPatImportAction({error:''},form);setImportError(result.error);if(!result.rows)return;const copy=!!result.copy;
  setEdits(current=>{const next={...current};for(const row of result.rows!){if(!companies.some(c=>c.id===row.companyId))continue;const keys:FieldKey[]=copy?['targetCents','targetMonthsBp']:[...FIELDS];next[row.companyId]={...next[row.companyId],...Object.fromEntries(keys.map(key=>[key,formatPatValue(key,row.inputs[key])]))};}return next;});
  setMessage(t(copy?'gridCopied':'gridImported'));});
 const [open,setOpen]=useState<string|null>(null),[compare,setCompare]=useState<Record<string,string>>({});
 const base=(c:PatGridCompany)=>c.draft?.inputs??c.active?.inputs??DEFAULT;
 const states=useMemo(()=>new Map(companies.map(c=>[c.id,patRowState(base(c),edits[c.id])])),[companies,edits]);
 const changedCells=[...states.values()].reduce((n,s)=>n+s.changed.length,0),invalidRows=[...states.values()].filter(s=>s.invalid.size).length;
 const dirty=Object.values(edits).some(row=>Object.keys(row).length>0);
 useUnsavedChangesGuard(dirty,t('gridUnsaved'),allowPatExport);
 const groups=[...new Map(companies.map(c=>[c.groupId,c.groupName])).entries()],units=[...new Map(companies.filter(c=>!group||c.groupId===group).map(c=>[c.buId,c.buName])).entries()];
 const visible=companies.filter(c=>{const s=states.get(c.id)!;return(!query||c.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))&&(!group||c.groupId===group)&&(!bu||c.buId===bu)&&(!missingOnly||s.missing.target||s.missing.actual||s.invalid.size>0);});
 const all=[...states.values()],complete=all.filter(s=>!s.missing.target&&!s.missing.actual&&!s.invalid.size).length;
 const setCell=(id:string,key:FieldKey,value:string)=>setEdits(current=>({...current,[id]:{...current[id],[key]:value}}));
 const payload=(mode:'draft'|'active'):PatGridRow[]=>companies.flatMap(c=>{const s=states.get(c.id)!;if(s.invalid.size)return[];return s.changed.length||mode==='active'&&c.draft?[{companyId:c.id,expectedRevision:c.latestRevision,inputs:s.values}]:[];});
 const begin=(mode:'draft'|'active')=>{setError('');setMessage('');if(invalidRows){setError(t('gridFixInvalid',{count:invalidRows}));return;}const rows=payload(mode);if(!rows.length){setMessage(t('gridNoChanges'));return;}
  start(async()=>{const result=await previewPatBatchAction(year,mode,rows);if(result.review)setReview({...result.review,mode,rows});else setError(result.error);});};
 const confirm=(reason:string,digest:string)=>{if(!review)return;start(async()=>{const result=await savePatBatchAction(year,review.mode,review.rows,reason,digest);
  if(result.ok){setReview(null);setEdits({});setMessage(t('gridSaved',{count:result.affected}));router.refresh();}
  else{if(result.review)setReview({...review,...result.review});setError(result.error);}});};
 return<section className="space-y-4">
  <div className="flex flex-wrap items-end gap-3">
   <Field label={t('search')}><input value={query} onChange={e=>setQuery(e.target.value)} className={inputCls}/></Field>
   <Field label={t('group')}><select value={group} onChange={e=>{setGroup(e.target.value);setBu('');}} className={inputCls}><option value="">{t('all')}</option>{groups.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></Field>
   <Field label={t('businessUnit')}><select value={bu} onChange={e=>setBu(e.target.value)} className={inputCls}><option value="">{t('all')}</option>{units.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></Field>
   <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" checked={missingOnly} onChange={e=>setMissingOnly(e.target.checked)}/>{t('gridMissingOnly')}</label>
  </div>
  <div className="flex flex-wrap items-end gap-3">
   <a className="text-sm text-primary underline" href={'/admin/rewards/pat-inputs/export?year='+year}>{t('downloadTemplate')}</a>
   <form action={runImport} className="flex flex-wrap items-end gap-2"><input type="hidden" name="year" value={year}/><Field label={t('import')}><input type="file" accept=".xlsx" name="file" required className={inputCls}/></Field><Button variant="outline" disabled={importing}>{t('previewImport')}</Button></form>
   <form action={runImport}><input type="hidden" name="year" value={year}/><input type="hidden" name="copy" value="1"/><Button variant="outline" disabled={importing}>{t('copyLastYear')}</Button></form>
  </div>
  {importError&&<p role="alert" className="text-sm text-destructive">{importError}</p>}
  <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/95 py-3 backdrop-blur">
   <p role="status" className="text-sm">{t('gridSummary',{complete,total:companies.length,missingActual:all.filter(s=>s.missing.actual).length,missingTarget:all.filter(s=>s.missing.target).length})}</p>
   <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={pending} onClick={()=>begin('draft')}>{t('gridSaveDraft',{count:changedCells})}</Button><Button type="button" disabled={pending} onClick={()=>begin('active')}>{t('gridSaveActive',{count:changedCells})}</Button></div>
  </div>
  {message&&<p role="status" className="text-sm">{message}</p>}{error&&!review&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
   <table className="w-full min-w-[960px] text-sm">
    <thead className="sticky top-0 z-10 bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground"><tr>{['company','target','forecast','actual','achievement','months','status','confirmedBy'].map(k=><th key={k} scope="col" className="px-3 py-2 font-medium">{t(k)}</th>)}</tr></thead>
    <tbody className="divide-y divide-border">{visible.map((c,index)=>{const s=states.get(c.id)!,previous=visible[index-1];const groupRow=!previous||previous.groupId!==c.groupId,buRow=groupRow||previous.buId!==c.buId;
     const unit=companies.filter(o=>o.groupId===c.groupId&&o.buId===c.buId).map(o=>states.get(o.id)!.values),sums=subtotal(unit);
     const flagged=s.invalid.size>0||s.missing.target||s.missing.actual;
     return<Fragment key={c.id}>
      {groupRow&&<tr className="bg-muted/60"><th colSpan={8} scope="rowgroup" className="px-3 py-2 text-left font-semibold">{c.groupName}</th></tr>}
      {buRow&&<tr className="bg-muted/30 font-medium"><th scope="rowgroup" className="px-3 py-2 text-left">{t('gridSubtotal',{name:c.buName})}</th><td className="px-3 py-2 tabular-nums">{money(sums.targetCents)}</td><td className="px-3 py-2 tabular-nums">{money(sums.forecastCents)}</td><td className="px-3 py-2 tabular-nums">{money(sums.actualCents)}</td><td className="px-3 py-2 tabular-nums">{sums.achievementBp===null?'—':(sums.achievementBp/100).toFixed(2)+'%'}</td><td colSpan={3}/></tr>}
      <tr className={flagged?'bg-destructive/5':''}>
       <th scope="row" className="px-3 py-2 text-left font-medium">{c.name}{(c.draft||s.changed.length>0)&&<span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-normal text-primary">{t('gridDraftBadge')}</span>}
        <button type="button" className="block text-xs font-normal text-primary underline" aria-expanded={open===c.id} onClick={()=>setOpen(open===c.id?null:c.id)}>{t('gridHistory')}</button></th>
       {(['targetCents','forecastCents','actualCents'] as const).map(key=><td key={key} className="px-2 py-1"><PatCell label={`${c.name} ${t(LABEL[key])}`} value={edits[c.id]?.[key]??formatPatValue(key,base(c)[key])} changed={s.changed.includes(key)} invalid={s.invalid.has(key)} missing={key!=='forecastCents'&&base(c)[key]===null&&edits[c.id]?.[key]===undefined} onChange={value=>setCell(c.id,key,value)} invalidText={t('gridInvalid')}/></td>)}
       <td className="px-3 py-2 tabular-nums">{s.achievementBp===null?'—':(s.achievementBp/100).toFixed(2)+'%'}</td>
       <td className="px-2 py-1"><PatCell label={`${c.name} ${t('months')}`} value={edits[c.id]?.targetMonthsBp??formatPatValue('targetMonthsBp',base(c).targetMonthsBp)} changed={s.changed.includes('targetMonthsBp')} invalid={s.invalid.has('targetMonthsBp')} onChange={value=>setCell(c.id,'targetMonthsBp',value)} invalidText={t('gridInvalid')}/></td>
       <td className="px-3 py-2">{t(s.status)}{(s.values.actualCents??s.values.forecastCents??0)<0&&<span className="block text-xs text-muted-foreground">{t('lossPool')}</span>}</td>
       <td className="px-3 py-2">{c.active?.confirmedAt?`${c.active.confirmedByName??''} · ${c.active.confirmedAt.slice(0,10)}`:'—'}</td>
      </tr>
      {open===c.id&&<tr><td colSpan={8} className="bg-muted/20 px-3 py-3"><PatHistory company={c} compareId={compare[c.id]??''} onCompare={id=>setCompare(v=>({...v,[c.id]:id}))} onUse={version=>setEdits(current=>({...current,[c.id]:Object.fromEntries(FIELDS.map(key=>[key,formatPatValue(key,version.inputs[key])]))}))}/></td></tr>}
     </Fragment>;})}</tbody>
   </table>
   {!visible.length&&<p className="p-6 text-sm text-muted-foreground">{t('emptyCompanies')}</p>}
  </div>
  <ReviewBeforeSavingDialog open={!!review} summary={review?.summary??null} digest={review?.digest??null} error={review?error:undefined} pending={pending} submitLabel={review?.mode==='active'?t('gridConfirmActive'):t('gridConfirmDraft')} onClose={()=>setReview(null)} onConfirm={confirm}/>
 </section>;
}

function PatCell({label,value,changed,invalid,missing,onChange,invalidText}:{label:string;value:string;changed:boolean;invalid:boolean;missing?:boolean;onChange:(value:string)=>void;invalidText:string}){
 return<><input aria-label={label} inputMode="decimal" value={value} onChange={e=>onChange(e.target.value)} aria-invalid={invalid||undefined}
  className={inputCls+' text-right tabular-nums '+(invalid?'border-destructive ring-1 ring-destructive':changed?'border-primary bg-primary/10':missing?'border-amber-500/60':'')}/>
  {invalid&&<span className="sr-only">{invalidText}</span>}</>;
}

function PatHistory({company,compareId,onCompare,onUse}:{company:PatGridCompany;compareId:string;onCompare:(id:string)=>void;onUse:(version:PatGridVersion)=>void}){
 const t=useTranslations('rewardSetup'),current=company.draft??company.active,other=company.history.find(v=>v.id===compareId);
 if(!company.history.length)return<p className="text-sm text-muted-foreground">{t('gridNoHistory')}</p>;
 return<div className="space-y-3 text-sm">
  <ol className="divide-y divide-border">{company.history.map(v=><li key={v.id} className="flex flex-wrap items-start justify-between gap-3 py-2"><div><p>v{v.revision} · {t(v.state==='confirmed'?'active':'draft')} · {v.createdByName??''}{v.confirmedByName?' · '+v.confirmedByName:''} {v.confirmedAt?.slice(0,10)??''}</p><p className="text-muted-foreground">{v.reason}</p>
   <p className="tabular-nums">{FIELDS.map(key=>`${t(LABEL[key])}: ${formatPatValue(key,v.inputs[key])||'—'}`).join(' · ')}</p></div>
   {v.id!==current?.id&&<Button type="button" variant="outline" onClick={()=>onUse(v)}>{t('gridUseValues')}</Button>}</li>)}</ol>
  <Field label={t('gridCompareWith')}><select value={compareId} onChange={e=>onCompare(e.target.value)} className={inputCls}><option value="">{t('choose')}</option>{company.history.filter(v=>v.id!==current?.id).map(v=><option key={v.id} value={v.id}>v{v.revision}</option>)}</select></Field>
  {other&&current&&<table className="w-full text-sm"><thead className="text-left text-xs uppercase text-muted-foreground"><tr><th className="px-2 py-1"/><th className="px-2 py-1">v{current.revision}</th><th className="px-2 py-1">v{other.revision}</th></tr></thead>
   <tbody>{FIELDS.map(key=><tr key={key} className={current.inputs[key]===other.inputs[key]?'':'bg-accent/30'}><th scope="row" className="px-2 py-1 text-left font-normal">{t(LABEL[key])}</th><td className="px-2 py-1 tabular-nums">{formatPatValue(key,current.inputs[key])||'—'}</td><td className="px-2 py-1 tabular-nums">{formatPatValue(key,other.inputs[key])||'—'}</td></tr>)}</tbody></table>}
 </div>;
}
