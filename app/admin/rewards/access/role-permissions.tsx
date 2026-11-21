'use client';
/** Board db14e49c: the Rewards Access role permission grid. Each editable cell is a native select with only the
 * levels the server accepts for it; edits stay on screen (highlighted, "Was: …") until one batch is saved with a
 * reason through "Review before saving". Locked cells explain why. Versions can be compared and restored as edits. */
import {Fragment,useMemo,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Lock} from 'lucide-react';
import {Button,Card,Field,inputCls,tableWrapCls} from '@/components/ui';
import {useUnsavedChangesGuard} from '@/components/ui/unsaved-changes';
import {
 permissionRows,rewardAccessRoles,rewardPermissionCategories,rewardCellKey,rewardCellLock,rewardDefaultLevel,rewardLevelOptions,rewardScopeLabel,effectiveRewardLevel,
 rolePermission,compareRewardPermissionMatrices,rewardLockedOverrides,type RewardAccessRole,type RewardCapability,type RewardLevel,type RewardPermissionChange,type RewardPermissionMatrix,
} from '@/packs/rewards/access-policy-model';
import type {RewardConfigSummary} from '@/packs/rewards/config-change-model';
import {ReviewBeforeSavingDialog} from '../review-before-saving';
import {previewRewardRolePermissionBatchAction,saveRewardRolePermissionBatchAction,decideRewardRolePermissionRequestAction,type RolePermissionActionError} from './policy-actions';

export type RolePermissionVersionView={revision:number;action:'saved'|'reset'|'restored'|'approved';savedAt:string;savedBy:string|null;reason:string;changes:RewardPermissionChange[];matrix:RewardPermissionMatrix;restoredFrom:number|null};
export type RolePermissionRequestView={id:string;changes:RewardPermissionChange[];reason:string;requestedName:string|null;requestedAt:string;status:'pending'|'applied'|'rejected'|'lapsed';decidedName:string|null;decidedAt:string|null;decisionReason:string|null;canDecide:boolean};
export type RolePermissionGridView={matrix:RewardPermissionMatrix;revision:number;heldRoles:RewardAccessRole[];immediate:boolean;proposer:boolean;viewingAs:boolean;versions:RolePermissionVersionView[];requests:RolePermissionRequestView[]};
type Edit={after:RewardLevel};
type Holder={role:string;name:string|null;proxy:boolean};

export function RewardRolePermissions({grid,holders=[]}:{grid:RolePermissionGridView;holders?:Holder[]}){
 const t=useTranslations('rewardAccessPolicy'),g=useTranslations('rewardAccessPolicy.grid'),router=useRouter();
 const canEdit=(grid.immediate||grid.proposer)&&!grid.viewingAs;
 const [edits,setEdits]=useState<Record<string,Edit>>({}),[reason,setReason]=useState(''),[changedOnly,setChangedOnly]=useState(false);
 const [action,setAction]=useState<{kind:'saved'|'reset'|'restored';restoredFrom:number|null}>({kind:'saved',restoredFrom:null});
 const [review,setReview]=useState<{summary:RewardConfigSummary;digest:string;mode:'apply'|'request'}|null>(null);
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[pending,start]=useTransition();
 const [compare,setCompare]=useState<number|null>(null);
 const saved=(role:RewardAccessRole,capability:RewardCapability)=>effectiveRewardLevel(role,capability,grid.matrix[rewardCellKey(role,capability)]);
 const lockOf=(role:RewardAccessRole,capability:RewardCapability)=>rewardCellLock(role,capability)??(grid.heldRoles.includes(role)?'heldRole' as const:null);
 // Net changes: a cell set back to its saved value is no longer a change.
 const changes=useMemo(()=>Object.entries(edits).flatMap(([key,edit])=>{const [role,capability]=key.split(':') as [RewardAccessRole,RewardCapability];const before=saved(role,capability);
  return before===edit.after?[]:[{role,capability,before,after:edit.after}];}),[edits,grid.matrix]);// eslint-disable-line react-hooks/exhaustive-deps
 const dirty=changes.length>0;
 useUnsavedChangesGuard(dirty,g('unsaved'));
 const levelName=(level:string)=>t(`levels.${level}`);
 const cellName=(role:string,capability:string)=>`${t(`roles.${role}`)} · ${t(`permissions.${capability}`)}`;
 const setCell=(role:RewardAccessRole,capability:RewardCapability,after:RewardLevel)=>setEdits(current=>{const key=rewardCellKey(role,capability),next={...current};
  if(after===saved(role,capability))delete next[key];else next[key]={after};return next;});
 const lockedOverrides=rewardLockedOverrides(grid.matrix);
 const rowChanged=(capability:RewardCapability)=>rewardAccessRoles.some(role=>saved(role,capability)!==rewardDefaultLevel(role,capability)||edits[rewardCellKey(role,capability)]);
 const rows=permissionRows.filter(row=>!changedOnly||row.editable&&rowChanged(row.id));
 const errorText=(code:RolePermissionActionError)=>g(`errors.${code}`);
 const discard=()=>{setEdits({});setReason('');setAction({kind:'saved',restoredFrom:null});setError('');};
 const loadEdits=(target:Record<string,RewardLevel>,kind:'reset'|'restored',restoredFrom:number|null)=>{
  const next:Record<string,Edit>={};let skipped=0;
  for(const row of permissionRows){if(!row.editable)continue;for(const role of rewardAccessRoles){const key=rewardCellKey(role,row.id),want=target[key]??rewardDefaultLevel(role,row.id);
   if(want===saved(role,row.id))continue;const lock=lockOf(role,row.id);
   // A locked cell may only go back to its default; a role the editor holds is never changed by them.
   if(lock==='heldRole'||lock&&want!==rewardDefaultLevel(role,row.id)){skipped++;continue;}next[key]={after:want};}}
  setEdits(next);setAction({kind,restoredFrom});setMessage(skipped?g('skipped',{count:skipped}):'');setError('');
 };
 const resetDefaults=()=>{if(window.confirm(g('resetConfirm')))loadEdits({},'reset',null);};
 const payload=(digest?:string,why?:string)=>({baseRevision:grid.revision,changes:changes.map(c=>({role:c.role,capability:c.capability,after:c.after})),reason:why??reason,digest:digest??null,action:action.kind,restoredFrom:action.restoredFrom});
 const begin=()=>{setError('');setMessage('');if(reason.trim().length<10){setError(g('errors.reason'));return;}
  start(async()=>{const result=await previewRewardRolePermissionBatchAction(payload());if(result.ok)setReview({summary:result.summary,digest:result.digest,mode:result.mode});else setError(errorText(result.error));});};
 const confirm=(why:string,digest:string)=>start(async()=>{const result=await saveRewardRolePermissionBatchAction(payload(digest,why));
  if(result.ok){setReview(null);discard();setMessage(result.mode==='applied'?g('saved'):g('requested'));router.refresh();}else setError(errorText(result.error));});
 // The dialog shows the server's summary (its digest is what the save carries) with the cell names in this language.
 const shown=review?{...review.summary,lines:review.summary.lines.map(line=>{const c=changes.find(x=>rewardCellKey(x.role,x.capability)===line.key);return c?{...line,label:cellName(c.role,c.capability),before:levelName(c.before),after:levelName(c.after)}:line;})}:null;
 const holderNames=(role:RewardAccessRole)=>[...new Set(holders.filter(h=>role==='proxy_bg'?h.proxy:h.role===role&&!h.proxy).map(h=>h.name).filter(Boolean))].join(', ');
 const compared=compare===null?null:grid.versions.find(v=>v.revision===compare);
 return<div className="space-y-4 pb-24">
  <div className="flex flex-wrap items-start justify-between gap-3">
   <ul aria-label={g('legend')} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{(['full','step','view','none'] as const).map(level=><li key={level}><span className="font-medium">{levelName(level)}</span> <span className="text-muted-foreground">{g(`legendHelp.${level}`)}</span></li>)}</ul>
   <div className="flex flex-wrap items-center gap-3">
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={changedOnly} onChange={e=>setChangedOnly(e.target.checked)}/>{g('changedOnly')}</label>
    {canEdit&&<Button type="button" variant="outline" disabled={pending} onClick={resetDefaults}>{t('reset')}</Button>}
   </div>
  </div>
  <p className="text-sm text-muted-foreground">{!canEdit?g(grid.viewingAs?'readOnlyViewAs':'readOnly'):grid.immediate?g('appliesNow'):g('needsApproval')}</p>
  {lockedOverrides.length>0&&<p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">{g('lockedOverrides',{count:lockedOverrides.length})}</p>}
  <p className="text-xs text-muted-foreground md:hidden">{t('scrollRoles')}</p>
  <div className={tableWrapCls+' max-h-[70vh] overflow-auto'} role="region" aria-label={t('rolePermissions')} tabIndex={0}>
   <table className="w-full border-separate border-spacing-0 text-sm">
    <thead className="sticky top-0 z-20 bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground"><tr>
     <th scope="col" className="sticky left-0 z-30 bg-muted px-3 py-2 font-medium">{t('permission')}</th>
     {rewardAccessRoles.map(role=><th key={role} scope="col" className="px-2 py-2 font-medium"><span className="block whitespace-nowrap">{t(`roles.${role}`)}</span>{holders.length>0&&<span className="mt-1 block max-w-40 font-normal normal-case text-muted-foreground">{holderNames(role)||'—'}</span>}</th>)}
    </tr></thead>
    <tbody>{rewardPermissionCategories.map(category=>{const inCategory=rows.filter(row=>row.category===category);if(!inCategory.length)return null;return<Fragment key={category}>
     <tr><th colSpan={rewardAccessRoles.length+1} scope="colgroup" className="sticky left-0 bg-muted/60 px-3 py-2 text-left font-semibold">{t(`categories.${category}`)}</th></tr>
     {inCategory.map(row=><tr key={row.id} className="border-t border-border">
      <th scope="row" className="sticky left-0 z-10 border-t border-border bg-card px-3 py-2 text-left font-medium">{t(`permissions.${row.id}`)}</th>
      {rewardAccessRoles.map(role=><td key={role} className="border-t border-border px-2 py-2 text-center">{row.id==='scope'
       ?<span className="text-xs text-muted-foreground">{g(`scopes.${rewardScopeLabel(role)}`)}</span>
       :<Cell role={role} capability={row.id} current={edits[rewardCellKey(role,row.id)]?.after??saved(role,row.id)} before={saved(role,row.id)} lock={lockOf(role,row.id)} canEdit={canEdit&&!pending} onChange={after=>setCell(role,row.id,after)}/>}</td>)}
     </tr>)}
    </Fragment>;})}</tbody>
   </table>
  </div>
  <p className="text-sm text-muted-foreground">{t('stepHelp')}</p>
  {message&&<p role="status" className="text-sm">{message}</p>}
  {error&&!review&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <RolePermissionRequests requests={grid.requests} cellName={cellName} levelName={levelName}/>
  <section className="space-y-3" aria-labelledby="role-permission-history"><h3 id="role-permission-history" className="font-semibold">{g('history')}</h3>
   {grid.versions.length?<ul className="space-y-2">{grid.versions.map(version=><li key={version.revision} className="rounded-md border border-border p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><p><span className="font-medium">{g('version',{revision:version.revision})}</span> · {g(`actions.${version.action}`)} · {version.savedBy??g('unavailable')} · {version.savedAt.slice(0,16)}{version.restoredFrom?` · ${g('restoredFrom',{revision:version.restoredFrom})}`:''}</p>
     <div className="flex gap-2"><Button type="button" variant="outline" aria-expanded={compare===version.revision} onClick={()=>setCompare(compare===version.revision?null:version.revision)}>{g('compare')}</Button>
      {canEdit&&<Button type="button" variant="outline" disabled={pending} onClick={()=>loadEdits(version.matrix,'restored',version.revision)}>{g('restore')}</Button>}</div></div>
    <p className="mt-1 text-muted-foreground">{version.reason}</p>
    {compared?.revision===version.revision&&<CompareTable from={version.matrix} to={grid.matrix} cellName={cellName} levelName={levelName} labels={{cell:g('cell'),from:g('thisVersion'),to:g('current'),same:g('sameAsCurrent')}}/>}
   </li>)}</ul>:<p className="text-sm text-muted-foreground">{g('noHistory')}</p>}
  </section>
  {dirty&&<div role="region" aria-label={g('bar')} className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
   <div className="mx-auto flex max-w-6xl flex-wrap items-end gap-3">
    <p className="min-h-11 py-2 text-sm font-medium">{g('changes',{count:changes.length})}</p>
    <div className="min-w-56 flex-1"><Field label={t('reason')}><input value={reason} onChange={e=>setReason(e.target.value)} required minLength={10} maxLength={2000} className={inputCls}/></Field></div>
    <Button type="button" variant="outline" disabled={pending} onClick={discard}>{g('discard')}</Button>
    <Button type="button" disabled={pending} aria-busy={pending} onClick={begin}>{pending?t('saving'):g('save')}</Button>
   </div>
  </div>}
  <ReviewBeforeSavingDialog open={!!review} summary={shown} digest={review?.digest??null} onClose={()=>setReview(null)} onConfirm={confirm} defaultReason={reason}
   intro={review?.mode==='request'?g('needsApproval'):undefined} submitLabel={review?.mode==='request'?g('sendForApproval'):g('save')} pending={pending} error={error||undefined}/>
 </div>;
}

function Cell({role,capability,current,before,lock,canEdit,onChange}:{role:RewardAccessRole;capability:RewardCapability;current:RewardLevel;before:RewardLevel;lock:ReturnType<typeof rewardCellLock>;canEdit:boolean;onChange:(after:RewardLevel)=>void}){
 const t=useTranslations('rewardAccessPolicy'),g=useTranslations('rewardAccessPolicy.grid');
 const fixed=rolePermission(role,capability),label=`${t(`roles.${role}`)} · ${t(`permissions.${capability}`)}`;
 if(fixed==='never'||fixed==='always'||fixed==='fixed'||lock||!canEdit){
  const shown=fixed==='never'||fixed==='always'||fixed==='fixed'?fixed:current,reason=lock?g(`locks.${lock}`):undefined;
  const breaks=lock&&lock!=='notApplicable'&&lock!=='heldRole'&&current!==rewardDefaultLevel(role,capability)&&fixed!=='never'&&fixed!=='always'&&fixed!=='fixed';
  return<span title={reason} aria-label={reason?`${label}: ${t(`levels.${shown}`)}. ${reason}`:undefined} className={`inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs ${lock?'bg-muted/60 text-muted-foreground':''} ${shown==='never'?'text-destructive':''} ${breaks?'ring-1 ring-amber-500':''}`}>
   {lock&&lock!=='notApplicable'&&<Lock aria-hidden className="size-3"/>}{t(`levels.${shown}`)}{breaks&&<span className="sr-only">{g('breaksLock')}</span>}</span>;
 }
 const changed=current!==before;
 return<select aria-label={label} title={changed?g('was',{level:t(`levels.${before}`)}):undefined} value={current} onChange={e=>onChange(e.target.value as RewardLevel)}
  className={`min-h-9 rounded-md border px-1 text-sm ${changed?'border-primary bg-primary/10 font-medium':'border-transparent hover:border-border'} ${current!==rewardDefaultLevel(role,capability)&&!changed?'underline decoration-dotted':''}`} data-changed={changed||undefined}>
  {rewardLevelOptions(role,capability).map(level=><option key={level} value={level}>{t(`levels.${level}`)}</option>)}
 </select>;
}

function CompareTable({from,to,cellName,levelName,labels}:{from:RewardPermissionMatrix;to:RewardPermissionMatrix;cellName:(role:string,capability:string)=>string;levelName:(level:string)=>string;labels:{cell:string;from:string;to:string;same:string}}){
 const diff=compareRewardPermissionMatrices(from,to);
 if(!diff.length)return<p className="mt-2 text-muted-foreground">{labels.same}</p>;
 return<table className="mt-2 w-full text-sm"><thead className="text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="py-1 font-medium">{labels.cell}</th><th className="py-1 font-medium">{labels.from}</th><th className="py-1 font-medium">{labels.to}</th></tr></thead>
  <tbody>{diff.map(c=><tr key={rewardCellKey(c.role,c.capability)} className="border-t border-border"><th scope="row" className="py-1 text-left font-normal">{cellName(c.role,c.capability)}</th><td className="py-1">{levelName(c.before)}</td><td className="py-1 font-medium">{levelName(c.after)}</td></tr>)}</tbody></table>;
}

function RolePermissionRequests({requests,cellName,levelName}:{requests:RolePermissionRequestView[];cellName:(role:string,capability:string)=>string;levelName:(level:string)=>string}){
 const g=useTranslations('rewardAccessPolicy.grid'),router=useRouter();
 const pending=requests.filter(r=>r.status==='pending'),decided=requests.filter(r=>r.status!=='pending');
 if(!requests.length)return null;
 return<Card className="space-y-3 p-4 sm:p-6"><h3 className="font-semibold">{g('waiting',{count:pending.length})}</h3>
  {pending.map(request=><PendingRequest key={request.id} request={request} cellName={cellName} levelName={levelName} onDone={()=>router.refresh()}/>)}
  {decided.length>0&&<details><summary className="cursor-pointer text-sm font-medium">{g('decided')}</summary><ul className="mt-3 space-y-2 text-sm">{decided.map(r=><li key={r.id}>{g(`statuses.${r.status}`)} · {r.requestedName??g('unavailable')} · {r.decidedName??''} · {r.decidedAt?.slice(0,16)}{r.decisionReason&&<p className="text-muted-foreground">{r.decisionReason}</p>}</li>)}</ul></details>}
 </Card>;
}
function PendingRequest({request,cellName,levelName,onDone}:{request:RolePermissionRequestView;cellName:(role:string,capability:string)=>string;levelName:(level:string)=>string;onDone:()=>void}){
 const g=useTranslations('rewardAccessPolicy.grid'),t=useTranslations('rewardAccessPolicy');
 const [reason,setReason]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,start]=useTransition();
 const decide=(approve:boolean)=>start(async()=>{setError('');const result=await decideRewardRolePermissionRequestAction({requestId:request.id,approve,reason});
  if(result.ok){setMessage(g(`statuses.${result.status}`));onDone();}else setError(g(`errors.${result.error}`));});
 return<details className="rounded-md border p-4" open><summary className="cursor-pointer text-sm font-medium">{g('requestedBy',{name:request.requestedName??g('unavailable'),count:request.changes.length})} · {request.requestedAt.slice(0,16)}</summary>
  <p className="mt-2 text-sm">{t('reason')}: {request.reason}</p>
  <ul className="my-3 space-y-1 text-sm">{request.changes.map(c=><li key={rewardCellKey(c.role,c.capability)}>{cellName(c.role,c.capability)}: {levelName(c.before)} → {levelName(c.after)}</li>)}</ul>
  {request.canDecide?<div className="space-y-3"><Field label={g('decisionReason')}><textarea className={inputCls} maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></Field>
   <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} aria-busy={busy} onClick={()=>decide(true)}>{g('approve')}</Button><Button type="button" variant="outline" disabled={busy||reason.trim().length<10} onClick={()=>decide(false)}>{g('reject')}</Button></div></div>
   :<p className="text-sm text-muted-foreground">{g('needsChecker')}</p>}
  {message&&<p role="status" className="mt-2 text-sm">{message}</p>}
  {error&&<p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
 </details>;
}
