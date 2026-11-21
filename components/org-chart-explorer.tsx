'use client';

import {useEffect,useRef,useState,type FormEvent} from 'react';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {Button,inputCls} from '@/components/ui';
import {decodeOrgWindow,OrgWindowContextChangedError,type OrgWindow,type OrgWindowNode,type OrgWindowRequest} from '@/lib/org-chart-window';

type Crumb={id:string;name:string;parent?:Crumb};
type Navigation={request:OrgWindowRequest;trail?:Crumb};
type History={navigation:Navigation;previous:History|null};
const root:Navigation={request:{view:'roots'}};
const relationKey={administrative:'direct',functional:'functional',project:'project',dotted:'dotted'} as const;

/** Fifty rows at a time, with fresh server authorization on every navigation. No full-tree DOM,
 * graph layout pass, prefetch, response cache or retained pages. Breadcrumbs show navigation history,
 * not an invented single managerial lineage (a person can have several managers).
 */
export function OrgChartExplorer({initial,browserKey}:{initial:OrgWindow;browserKey:string}){
 const t=useTranslations('org');
 const [data,setData]=useState<OrgWindow|null>(initial),[nav,setNav]=useState<Navigation>(root);
 const [history,setHistory]=useState<History|null>(null),[query,setQuery]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState<'retry'|'refresh'|'access'|null>(null);
 const pending=useRef<Navigation>(root),controller=useRef<AbortController|null>(null),sequence=useRef(0);
 const heading=useRef<HTMLHeadingElement>(null);
 const crumbs:Crumb[]=[];let earlier=nav.trail;
 while(earlier&&crumbs.length<8){crumbs.push(earlier);earlier=earlier.parent;}
 crumbs.reverse();
 useEffect(()=>()=>{sequence.current++;controller.current?.abort();},[]);
 async function load(target:Navigation,back=false){
  controller.current?.abort();const abort=new AbortController();controller.current=abort;
  const current=++sequence.current;pending.current=target;setBusy(true);setError(null);
  // A hung transport must leave an explicit retry state; late responses cannot revive it.
  const deadline=setTimeout(()=>{
   if(current!==sequence.current)return;
   sequence.current++;abort.abort();setBusy(false);setError('retry');
  },15000);
  try{
   const params=new URLSearchParams(Object.entries(target.request).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
   const response=await fetch(`/api/org/window?${params}`,{cache:'no-store',credentials:'same-origin',signal:abort.signal});
   if(current!==sequence.current)return;
   if(!response.ok){
    if(response.status===401||response.status===403){setData(null);setHistory(null);setNav(root);setQuery('');setError('access');}
    else setError(response.status===409?'refresh':'retry');
    return;
   }
   const next=decodeOrgWindow(await response.json(),target.request,browserKey);
   if(current!==sequence.current)return;
   setHistory(previous=>back?previous?.previous??null:{navigation:nav,previous});
   setNav(target);setData(next);heading.current?.focus();
  }catch(error){
   if(current===sequence.current&&!abort.signal.aborted){
    if(error instanceof OrgWindowContextChangedError){setData(null);setHistory(null);setNav(root);setQuery('');setError('access');}
    else setError('retry');
   }
  }finally{clearTimeout(deadline);if(current===sequence.current)setBusy(false);}
 }
 function focus(person:OrgWindowNode){
  void load({request:{view:'children',focusId:person.employmentId},trail:{id:person.employmentId,name:person.name,parent:nav.trail}});
 }
 function search(event:FormEvent){event.preventDefault();void load({request:{view:'search',q:query.trim()}});}
 const viewTitle=nav.request.view==='roots'?t('explorer.topLevel'):nav.request.view==='search'?t('explorer.searchResults'):
  nav.request.view==='children'?t('explorer.reports'):nav.request.view==='parents'?t('explorer.managers'):t('explorer.connections');
 return <section data-org-explorer data-org-total-people={data?.totalPeople} data-org-view={data?.view} className="space-y-5">
  <p className="text-sm text-muted-foreground">{t('explorer.hint')}</p>
  <div className="flex flex-wrap items-end gap-3">
   <form onSubmit={search} className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
    <label className="min-w-48 flex-1 text-sm font-medium">{t('searchAria')}
     <input className={`${inputCls} mt-1 w-full`} value={query} maxLength={200} onChange={event=>setQuery(event.target.value)} placeholder={t('searchPlaceholder')}/>
    </label>
    <Button type="submit" className="min-h-11">{t('explorer.search')}</Button>
   </form>
   <Button variant="outline" className="min-h-11" disabled={busy||error==='access'} onClick={()=>void load(root)}>{t('explorer.topLevel')}</Button>
   <Button variant="outline" className="min-h-11" disabled={busy||error==='access'} onClick={()=>{setQuery('');void load({request:{view:'search',q:''}});}}>{t('explorer.allPeople')}</Button>
  </div>
  {crumbs.length>0&&<nav aria-label={t('explorer.history')} className="flex flex-wrap items-center gap-2 text-sm">
   <span className="text-muted-foreground">{t('explorer.history')}:</span>
   {!!earlier&&<span aria-hidden="true">…</span>}
   {crumbs.map((crumb,index)=><Button key={`${crumb.id}-${index}`} variant="link" disabled={busy||error==='access'} onClick={()=>void load({request:{view:'children',focusId:crumb.id},trail:crumb})}>{crumb.name}</Button>)}
  </nav>}
  <div aria-live="polite" role="status" className="text-sm text-muted-foreground">{busy?t('explorer.loading'):data?t('explorer.loaded',{loaded:data.items.length,total:data.totalItems,people:data.totalPeople}):null}</div>
  {error&&<div role="alert" className="space-y-2 rounded-md border p-4">
   <p>{t(error==='access'?'explorer.accessChanged':error==='refresh'?'explorer.changed':'explorer.failed')}</p>
   {error==='access'?<Button onClick={()=>window.location.reload()}>{t('explorer.refresh')}</Button>:<Button disabled={busy} onClick={()=>void load(error==='refresh'?{...pending.current,request:{...pending.current.request,after:undefined}}:pending.current)}>{t('explorer.retry')}</Button>}
  </div>}
  <div aria-busy={busy} className="space-y-4">
   {data?.focus&&<div className="rounded-md border bg-muted/30 p-4">
    <h2 className="font-semibold">{data.focus.name}</h2>
    <p className="text-sm text-muted-foreground">{[data.focus.role,data.focus.department].filter(Boolean).join(' · ')}</p>
    {data.focus.assignmentCount>1&&<p className="text-sm">{t('explorer.multipleAssignments')}</p>}
    <Link className="inline-flex min-h-11 items-center text-sm underline" href={`/personnel/${data.focus.employmentId}?from=org`}>{t('explorer.profile')}</Link>
    <div className="flex flex-wrap gap-2" aria-label={t('explorer.relationships')}>
     {(['children','parents','connections'] as const).map(view=><Button key={view} variant={nav.request.view===view?'secondary':'outline'} aria-pressed={nav.request.view===view} disabled={busy} onClick={()=>void load({...nav,request:{view,focusId:data.focus!.employmentId}})}>{t(`explorer.${view==='children'?'reports':view==='parents'?'managers':'connections'}`)}</Button>)}
    </div>
   </div>}
   <h2 ref={heading} tabIndex={-1} className="font-semibold focus:outline-none">{viewTitle}</h2>
   {data&&<>
    {data.items.length===0?<p className="text-sm text-muted-foreground">{t('noMatch')}</p>:<ul className="divide-y rounded-md border" data-org-window>
     {data.items.map(item=><li key={item.key} className="flex flex-wrap items-center justify-between gap-3 p-3" data-org-item>
      <div className="min-w-0 flex-1">
       {item.node?<><h3 className="break-words font-medium">{item.node.name}</h3><p className="text-sm text-muted-foreground">{[item.node.employeeCode,item.node.role,item.node.department].filter(Boolean).join(' · ')}</p>{item.node.assignmentCount>1&&<p className="text-sm">{t('explorer.multipleAssignments')}</p>}</>:<p className="text-sm text-muted-foreground">{t('explorer.outsideScope')}</p>}
       {item.type&&<p className="text-xs text-muted-foreground">{t(`legend.${relationKey[item.type]}`)} · {t(item.direction==='incoming'?'explorer.incoming':'explorer.outgoing')}</p>}
      </div>
      {item.node&&<Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>focus(item.node!)}>{t('explorer.explore')}</Button>}
     </li>)}
    </ul>}
    <div className="flex justify-between gap-3">
     <Button variant="outline" className="min-h-11" disabled={busy||!history} onClick={()=>void load(history!.navigation,true)}>{t('explorer.back')}</Button>
     <Button variant="outline" className="min-h-11" disabled={busy||!data.nextCursor} onClick={()=>void load({...nav,request:{...nav.request,after:data.nextCursor!}})}>{t('explorer.next')}</Button>
    </div>
   </>}
  </div>
 </section>;
}
