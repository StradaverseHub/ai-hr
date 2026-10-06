'use client';

import {useEffect,useRef,useState} from 'react';
import {useLocale,useTranslations} from 'next-intl';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import type {MyTeamEmployee,MyTeamNavigation,MyTeamNormalizedQuery,MyTeamQuery,MyTeamSnapshot} from '@/lib/my-team-types';
import {serializeMyTeamQuery,stepMyTeamAnchor} from '@/lib/my-team-query';
import {MyTeamGrid} from './grid';
import {EmployeePanel} from './employee-panel';
import {dateText,STATUS_CLASSES,type MyTeamTranslate} from './presentation';

// r392 (33930be9): the Today tiles and the Needs your attention panel were removed at the reporter's request;
// leave is decided in Approval Items. The page is the grid and its side panel.
export type MyTeamProps={snapshot:MyTeamSnapshot;query:MyTeamQuery;navigation:MyTeamNavigation;periodDataHref:string;exportHref:string};
const layers=['roster','attendance','leave'] as const;
/** Layers only change presentation; the fetched projection already contains all three sources. */
function dataKey(query:MyTeamQuery){return serializeMyTeamQuery({...query,layers:undefined,companyIds:query.companyIds?.slice().sort()}).toString();}
function linkWithQuery(href:string,query:MyTeamQuery,format?:string){const params=serializeMyTeamQuery(query);if(format)params.set('format',format);return `${href}?${params}`;}

export function MyTeam(props:MyTeamProps){
 const locale=useLocale();const translate=useTranslations('myTeam');const t:MyTeamTranslate=(key,values)=>translate(key,values);
 const [snapshot,setSnapshot]=useState(props.snapshot);const [navigation,setNavigation]=useState(props.navigation);
 const [query,setQuery]=useState<MyTeamNormalizedQuery>(props.snapshot.query);const [search,setSearch]=useState(props.snapshot.query.search);
 const [loading,setLoading]=useState(false);const [error,setError]=useState<string|null>(null);
 const [selected,setSelected]=useState<{employmentId:string;date:string}|null>(null);
 const loadedKey=useRef(dataKey(props.snapshot.query));const epoch=useRef(0);const key=dataKey(query);
 const incomingSnapshot=useRef(props.snapshot);
 useEffect(()=>{
  if(incomingSnapshot.current===props.snapshot)return;incomingSnapshot.current=props.snapshot;epoch.current++;
  loadedKey.current=dataKey(props.snapshot.query);setSnapshot(props.snapshot);setNavigation(props.navigation);setQuery(props.snapshot.query);setSearch(props.snapshot.query.search);setLoading(false);setSelected(null);setError(null);
 },[props.snapshot,props.navigation]);
 const fresh=key===loadedKey.current&&!loading;const employee=selected?snapshot.employees.find(item=>item.employmentId===selected.employmentId):undefined;
 useEffect(()=>{
  if(key===loadedKey.current)return;
  const controller=new AbortController();const request=++epoch.current;setLoading(true);setError(null);setSelected(null);
  fetch(linkWithQuery(props.periodDataHref,query),{signal:controller.signal,credentials:'same-origin',cache:'no-store'}).then(async response=>{
   if(!response.ok)throw new Error('failed');return response.json() as Promise<{snapshot:MyTeamSnapshot;navigation:MyTeamNavigation}>;
  }).then(result=>{
   if(controller.signal.aborted||request!==epoch.current)return;
   loadedKey.current=key;setSnapshot(result.snapshot);setNavigation(result.navigation);
   // Keep local layer switches made while this request was in flight.
   setQuery(current=>({...result.snapshot.query,layers:current.layers}));setLoading(false);
  }).catch(()=>{if(!controller.signal.aborted&&request===epoch.current){setLoading(false);setError(t('error_failed'));}});
  return()=>controller.abort();
  // Layers are local presentation state, and never trigger another period request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key,props.periodDataHref]);
 useEffect(()=>{window.history.replaceState(null,'',`${window.location.pathname}?${serializeMyTeamQuery(query)}`);},[query]);
 function update(next:Partial<MyTeamNormalizedQuery>){setSelected(null);setError(null);setQuery(current=>({...current,...next}));}
 function open(employee:MyTeamEmployee,date:string){setSelected({employmentId:employee.employmentId,date});}
 const exportDisabled=!fresh;
 return <div className="space-y-5">
  <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold tracking-tight">{t('title')}</h1><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('subtitle')}</p></div><div className="flex flex-wrap gap-2">
  {(['csv','xlsx'] as const).map(format=>exportDisabled?<Button key={format} size="sm" variant="outline" disabled>{t(format==='csv'?'exportCsv':'exportExcel')}</Button>:<Button key={format} asChild size="sm" variant="outline"><a href={linkWithQuery(props.exportHref,query,format)}>{t(format==='csv'?'exportCsv':'exportExcel')}</a></Button>)}
  {fresh&&navigation.roster.href?<Button asChild size="sm" variant="outline"><a href={navigation.roster.href}>{t(navigation.roster.label==='edit'?'editRoster':'viewRoster')}</a></Button>:<Button size="sm" variant="outline" disabled>{t(navigation.roster.label==='edit'?'editRoster':'viewRoster')}</Button>}
  </div></header>
  <div className="flex flex-wrap items-center gap-3 text-xs"><label className="flex items-center gap-2">{t('scope')}<select value={query.scope} onChange={event=>update({scope:event.target.value as MyTeamQuery['scope'],departmentId:undefined})} className="h-8 rounded-md border border-input bg-background px-2"><option value="direct">{t('direct')}</option><option value="all">{t('all')}</option>{snapshot.scope.canChooseDepartment&&<option value="department">{t('department')}</option>}</select></label>
  {query.scope==='department'&&snapshot.scope.canChooseDepartment&&<label className="flex items-center gap-2">{t('department')}<select value={query.departmentId??''} onChange={event=>update({departmentId:event.target.value||undefined})} className="h-8 max-w-64 rounded-md border border-input bg-background px-2"><option value="">{t('chooseDepartment')}</option>{snapshot.scope.departments.map(department=><option key={department.id} value={department.id}>{department.name}{snapshot.scope.companies.length>1?` · ${snapshot.scope.companies.find(company=>company.id===department.companyId)?.name??''}`:''}</option>)}</select></label>}
  </div>
  {error&&<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}
  <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-2"><div className="inline-flex rounded-md border border-input p-0.5">{(['week','month'] as const).map(view=><button key={view} type="button" aria-pressed={query.view===view} onClick={()=>update({view})} className={`rounded px-3 py-1.5 text-xs ${query.view===view?'bg-primary text-primary-foreground':'text-muted-foreground hover:bg-muted'}`}>{t(view)}</button>)}</div><Button size="sm" variant="outline" aria-label={t('previous')} onClick={()=>update({anchorDate:stepMyTeamAnchor(query,-1)})}>‹</Button><span className="text-xs font-medium">{query.view==='month'?dateText(query.anchorDate,locale,{month:'long',year:'numeric'}):fresh?`${dateText(snapshot.period.from,locale,{weekday:'short',day:'numeric',month:'short'})}–${dateText(snapshot.period.to,locale,{weekday:'short',day:'numeric',month:'short',year:'numeric'})}`:t('loading')}</span><Button size="sm" variant="outline" aria-label={t('next')} onClick={()=>update({anchorDate:stepMyTeamAnchor(query,1)})}>›</Button><Button size="sm" variant="ghost" onClick={()=>update({anchorDate:snapshot.today})}>{t('today')}</Button></div><form onSubmit={event=>{event.preventDefault();update({search:search.trim()});}} className="w-full sm:w-64"><Input aria-label={t('search')} placeholder={t('search')} value={search} maxLength={100} onChange={event=>setSearch(event.target.value)}/></form></div>
  <div className="flex flex-wrap items-center justify-between gap-3 text-[10px]"><fieldset className="flex gap-3"><legend className="sr-only">{t('show')}</legend><span aria-hidden className="text-muted-foreground">{t('show')}</span>{layers.map(layer=><label key={layer} className="flex items-center gap-1.5"><input type="checkbox" checked={query.layers[layer]} onChange={event=>update({layers:{...query.layers,[layer]:event.target.checked}})}/>{t(layer)}</label>)}</fieldset><div className="flex flex-wrap gap-2">{(['present','late','absent','approved_leave','off','upcoming'] as const).map(status=><span key={status} className={`rounded-full px-2 py-1 ${STATUS_CLASSES[status]}`}>{t(`status_${status}`)}</span>)}<span className="rounded-full border border-dashed border-violet-400 px-2 py-1 text-violet-700 dark:text-violet-300">{t('status_pending_leave')}</span></div></div>
  {layers.filter(source=>snapshot.availability[source]==='unavailable').map(source=><p key={source} className="text-xs text-muted-foreground">{t('sourceUnavailable',{source:t(source)})}</p>)}
  {!fresh?<p role="status" className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">{error?t('error_failed'):t('loading')}</p>:snapshot.gridEmploymentIds.length?<MyTeamGrid snapshot={snapshot} query={query} locale={locale} t={t} onOpen={open}/>:<div className="rounded-lg border border-border p-8 text-center"><p className="text-sm text-muted-foreground">{t('empty')}</p><Button className="mt-3" size="sm" variant="outline" onClick={()=>{setSearch('');update({search:''});}}>{t('wholeTeam')}</Button></div>}
  </section>
  {fresh&&selected&&employee&&<EmployeePanel key={`${employee.employmentId}:${employee.weeks.find(week=>week.from<=selected.date&&week.to>=selected.date)?.from??selected.date}`} employee={employee} selectedDate={selected.date} snapshot={snapshot} navigation={navigation} locale={locale} t={t} onClose={()=>setSelected(null)}/>}
 </div>;
}
